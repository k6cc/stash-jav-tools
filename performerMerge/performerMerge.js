/**
 * performerMerge
 *
 * 遍历库内所有演员（名字 + 别名），按归一化名称分组找出重名演员，
 * 每组选择一个目标演员，其余演员通过 performerMerge 合并进去。
 * 合并规则：名字/图片始终保留目标演员的；源演员名字+别名原样并入目标别名
 * （不做归一化，仅精确去重）；其余字段按 Stash 官方合并对话框逻辑合并。
 * 需要 Stash v0.31.0+（performerMerge mutation）。
 */

(function () {
  "use strict";

  if (window.__pdmLoaded) return;
  window.__pdmLoaded = true;

  var MIN_VERSION = [0, 31, 0];
  var PLUGIN_VERSION = "1.2.0";
  console.log("[pdm] performerMerge v" + PLUGIN_VERSION + " loaded");

  // ==================== i18n ====================

  var _intlLocale = "";
  function tc(zh, en) {
    if (_intlLocale.indexOf("zh") === 0) return zh;
    return en;
  }

  (function initIntlBridge() {
    try {
      var api = window.PluginApi;
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return;
      var React = api.React;
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl();
        React.useEffect(function () {
          _intlLocale = intl.locale || "";
        });
        return null;
      }
      api.patch.before("App", function (props) {
        return [{
          children: React.createElement(React.Fragment, null,
            React.createElement(IntlBridge),
            props.children)
        }];
      });
    } catch (e) {
      console.warn("[PDM] i18n bridge failed:", e);
    }
  })();

  // ==================== GraphQL ====================

  function callGQL(query, variables) {
    var payload = { query: query };
    if (variables) payload.variables = variables;
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.errors) throw new Error(JSON.stringify(data.errors));
        return data.data;
      });
  }

  // ==================== State ====================

  var _state = {
    version: "",
    versionOk: null,      // null=未知 true/false=检查结果
    scanning: false,
    abortFlag: false,
    scanProgress: null,   // {current,total,title}
    mergeProgress: null,  // {current,total}
    performerCount: 0,
    groups: null,
    shortNames: null,     // 共享短名键列表（短名清理页）
    performers: null,     // 扫描得到的完整演员列表（清理时按 id 取用）
    targets: {},          // groupKey -> 目标演员 id
    merged: {},           // groupKey -> true
    failed: {},           // groupKey -> true
    merging: false,
    cleaning: false,
    cleanProgress: null,  // {current,total}
    activeTab: "groups",
    log: [],
  };

  function setState(updates) {
    for (var k in updates) _state[k] = updates[k];
    render();
  }

  function addLog(msg) {
    _state.log.push(msg);
    appendLogDOM(msg);
  }

  // 自动滚动到底部经 rAF 合并：一帧内追加 N 条日志只读一次 scrollHeight，
  // 避免「合并全部/清理全部」时每条日志都强制布局（Forced reflow）
  var _logScrollQueued = false;

  function appendLogDOM(msg) {
    var logBox = document.querySelector(".pdm-log");
    if (!logBox) return;
    logBox.appendChild(el("div", null, msg));
    if (_logScrollQueued) return;
    _logScrollQueued = true;
    requestAnimationFrame(function () {
      _logScrollQueued = false;
      var box = document.querySelector(".pdm-log");
      if (box) box.scrollTop = box.scrollHeight;
    });
  }

  function updateProgressDOM(current, total, title) {
    var bar = document.querySelector(".pdm-progress-bar");
    var titleEl = document.querySelector(".pdm-progress-title");
    if (bar) {
      var pct = total ? Math.round((current / total) * 100) : 0;
      bar.style.width = pct + "%";
      bar.textContent = current + " / " + total;
    }
    if (titleEl && title != null) titleEl.textContent = title;
  }

  function pendingGroups() {
    return (_state.groups || []).filter(function (g) {
      return !_state.merged[g.key] && !_state.failed[g.key];
    });
  }

  // ==================== 归一化 / 分组 ====================

  function normalizeName(name) {
    if (!name) return "";
    var s = String(name).normalize("NFC").toLowerCase().trim();
    // 全角括号统一为半角（数据源混用），其余保留
    s = s.replace(/（/g, "(").replace(/）/g, ")");
    s = s.replace(/\s+/g, "");
    // 注意：不剥离 "(2)" 消歧后缀 — 该后缀语义是「同名不同人」，
    // 剥离会把不同演员并成一组（曾产生 169 人大组误报）
    return s;
  }

  function parseAliasList(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(function (s) { return String(s).trim(); }).filter(Boolean);
    return String(val).split(/[\n,]/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // 演员贡献的所有名称键：名字（isName=true）+ 别名
  function perfKeys(p) {
    var out = [];
    var seen = {};
    function push(raw, isName) {
      if (!raw) return;
      var norm = normalizeName(raw);
      if (!norm || seen[norm]) return;
      seen[norm] = true;
      out.push({ norm: norm, display: raw, isName: isName });
    }
    push(p.name, true);
    parseAliasList(p.alias_list).forEach(function (a) { push(a, false); });
    return out;
  }

  // 单词短名判定：仅由半角/全角罗马字、数字、假名（含半角片假名与长音符「ー」）构成，
  // 无空格、无汉字、无任何符号（「・」「-」等都会排除）。
  // 例：Ai / あい / Ayaka / ゆずき / SAORI；非短名：Iroha Suzumura（含空格）、兒玉七海（含汉字）
  var SHORT_NAME_RE = /^[0-9A-Za-z\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A\u3041-\u309F\u30A1-\u30FA\u30FC\uFF66-\uFF9F]+$/;

  function isShortName(raw) {
    return SHORT_NAME_RE.test(String(raw || "").trim());
  }

  // 共享短名：归一化键被 ≥2 个演员持有（名字+别名都计数，与分组 fanout 口径一致），
  // 且别名原始串为单词短名 → 这些别名条目是清理候选。主名永不删除；
  // 全部持有者都经主名贡献的键不会出现在结果中（无别名可删）。
  function findSharedShortNames(performers) {
    var fanout = {};
    performers.forEach(function (p) {
      var seen = {};
      perfKeys(p).forEach(function (k) {
        if (seen[k.norm]) return;
        seen[k.norm] = true;
        fanout[k.norm] = (fanout[k.norm] || 0) + 1;
      });
    });
    var byNorm = {};
    performers.forEach(function (p) {
      parseAliasList(p.alias_list).forEach(function (a) {
        var norm = normalizeName(a);
        if (!norm || (fanout[norm] || 0) < 2 || !isShortName(a)) return;
        if (!byNorm[norm]) byNorm[norm] = { raws: {}, holders: {} };
        byNorm[norm].raws[a] = true;
        var h = byNorm[norm].holders[p.id];
        if (!h) h = byNorm[norm].holders[p.id] = { id: p.id, name: p.name, raws: [] };
        if (h.raws.indexOf(a) === -1) h.raws.push(a);
      });
    });
    var out = [];
    for (var norm in byNorm) {
      var holders = [];
      for (var hid in byNorm[norm].holders) holders.push(byNorm[norm].holders[hid]);
      if (!holders.length) continue;
      holders.sort(function (a, b) { return Number(a.id) - Number(b.id); });
      var raws = [];
      for (var r in byNorm[norm].raws) raws.push(r);
      raws.sort();
      out.push({ norm: norm, raws: raws, holders: holders });
    }
    out.sort(function (a, b) { return b.holders.length - a.holders.length; });
    return out;
  }

  // 同 endpoint stash_id 冲突：两人在同一 endpoint 都有 id 且不同。
  // 策展库（stashdb 等）一人一条目，同 endpoint 不同 id = 不同的人，
  // 用于阻断「碰巧共享罕见别名」的假阳性名字匹配。
  function idConflict(a, b) {
    var am = {};
    (a.stash_ids || []).forEach(function (s) {
      if (s.endpoint && s.stash_id) am[s.endpoint] = s.stash_id;
    });
    var conflict = false;
    (b.stash_ids || []).forEach(function (s) {
      if (s.endpoint && s.stash_id && am[s.endpoint] && am[s.endpoint] !== s.stash_id) conflict = true;
    });
    return conflict;
  }

  // 并查集分组，信号分两级：
  // 1. stash_id：同 endpoint + 同 stash_id = 同一外部实体（硬证据，无条件连组）
  // 2. 名字键（name + alias）：仅当全局恰好 2 人共享（fanout≤2，排除「Ai」「AYAKA」类
  //    常见短名被几十人共享导致的超大组），且两人无同 endpoint stash_id 冲突时连组
  function buildGroups(performers) {
    var n = performers.length;
    var parent = [];
    for (var i = 0; i < n; i++) parent.push(i);
    function find(i) {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a, b) {
      var ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    // 全局 fanout 统计：每个名字键被多少个不同演员持有
    var nameFanout = {};
    performers.forEach(function (p) {
      var seen = {};
      perfKeys(p).forEach(function (k) {
        if (seen[k.norm]) return;
        seen[k.norm] = true;
        nameFanout[k.norm] = (nameFanout[k.norm] || 0) + 1;
      });
    });

    var keyOwners = {}; // 键（保留的名字键或 "sid:endpoint|stash_id"）-> [演员索引]
    performers.forEach(function (p, i) {
      perfKeys(p).forEach(function (k) {
        if ((nameFanout[k.norm] || 0) > 2) return; // 常见名抑制
        if (!keyOwners[k.norm]) keyOwners[k.norm] = [];
        keyOwners[k.norm].push(i);
      });
      (p.stash_ids || []).forEach(function (sid) {
        if (!sid.endpoint || !sid.stash_id) return;
        var k = "sid:" + sid.endpoint + "|" + sid.stash_id;
        if (!keyOwners[k]) keyOwners[k] = [];
        keyOwners[k].push(i);
      });
    });

    // 连边；名字键（fanout≤2 → 至多 2 人）需通过冲突检测才生效
    var nameEdges = {}; // norm -> true（实际生效的名字连接，用于组内展示）
    for (var norm in keyOwners) {
      var owners = keyOwners[norm];
      if (norm.indexOf("sid:") === 0) {
        for (var j = 1; j < owners.length; j++) union(owners[0], owners[j]);
      } else if (owners.length === 2
        && !idConflict(performers[owners[0]], performers[owners[1]])) {
        union(owners[0], owners[1]);
        nameEdges[norm] = true;
      }
    }

    var rootMembers = {};
    for (var i2 = 0; i2 < n; i2++) {
      var r = find(i2);
      if (!rootMembers[r]) rootMembers[r] = [];
      rootMembers[r].push(i2);
    }

    var groups = [];
    for (var root in rootMembers) {
      var idxs = rootMembers[root];
      if (idxs.length < 2) continue;
      var members = idxs.map(function (i) { return performers[i]; });
      members.sort(function (a, b) { return Number(a.id) - Number(b.id); });

      // 组内生效的共享名字键（显示名优先取真实演员名）
      var keyDisplay = {};
      var shared = [];
      var sharedNorms = {};
      members.forEach(function (p) {
        perfKeys(p).forEach(function (k) {
          if (!nameEdges[k.norm]) return;
          if (!keyDisplay[k.norm] || (k.isName && !keyDisplay[k.norm].isName)) keyDisplay[k.norm] = k;
          sharedNorms[k.norm] = true;
        });
      });
      for (var nk in sharedNorms) shared.push(keyDisplay[nk].display);
      // 组内共享 stash_id（被 ≥2 个成员使用）
      var sidCount = {};
      members.forEach(function (p) {
        (p.stash_ids || []).forEach(function (sid) {
          if (!sid.endpoint || !sid.stash_id) return;
          var k = sid.endpoint + "|" + sid.stash_id;
          sidCount[k] = (sidCount[k] || 0) + 1;
        });
      });
      var sharedStashIds = [];
      var sharedSidKeys = {};
      for (var sk in sidCount) {
        if (sidCount[sk] >= 2) {
          sharedSidKeys[sk] = true;
          var bar = sk.indexOf("|");
          sharedStashIds.push({ endpoint: sk.slice(0, bar), stash_id: sk.slice(bar + 1) });
        }
      }

      groups.push({
        key: "g" + root, members: members,
        sharedNames: shared, sharedNorms: sharedNorms,
        sharedStashIds: sharedStashIds, sharedSidKeys: sharedSidKeys,
      });
    }

    // 组内人数降序，同人数按首个共享名（无共享名取首成员名）排序
    groups.sort(function (a, b) {
      var d = b.members.length - a.members.length;
      if (d !== 0) return d;
      var an = String(a.sharedNames[0] || (a.members[0] && a.members[0].name) || "");
      var bn = String(b.sharedNames[0] || (b.members[0] && b.members[0].name) || "");
      return an.localeCompare(bn);
    });
    return groups;
  }

  // 默认目标：场景最多 → stash_id 最多 → 创建最早
  function pickDefaultTarget(members) {
    var best = null;
    members.forEach(function (p) {
      if (!best) { best = p; return; }
      var ps = p.scene_count || 0, bs = best.scene_count || 0;
      if (ps !== bs) { if (ps > bs) best = p; return; }
      var pz = (p.stash_ids || []).length, bz = (best.stash_ids || []).length;
      if (pz !== bz) { if (pz > bz) best = p; return; }
      if (String(p.created_at || "") < String(best.created_at || "")) best = p;
    });
    return best;
  }

  // ==================== 扫描 ====================

  var PERF_FIELDS = "id name disambiguation alias_list urls gender birthdate death_date ethnicity country eye_color height_cm weight measurements fake_tits penis_length circumcised career_start career_end tattoos piercings details hair_color favorite rating100 tags { id } stash_ids { endpoint stash_id } custom_fields scene_count image_count gallery_count created_at";

  async function handleScan(keepLog) {
    setState({
      scanning: true, abortFlag: false, groups: null, shortNames: null, performerCount: 0,
      log: keepLog ? _state.log : [], merged: {}, failed: {}, targets: {}, scanProgress: { current: 0, total: 0, title: "" },
    });
    addLog(tc("正在获取演员列表...", "Fetching performers..."));

    try {
      var performers = await fetchAllPerformers();
      if (_state.abortFlag) {
        addLog(tc("用户中止扫描", "Scan aborted by user"));
        setState({ scanning: false, scanProgress: null });
        return;
      }
      addLog(tc("共 " + performers.length + " 个演员，正在分组...", performers.length + " performers, grouping..."));

      var groups = buildGroups(performers);
      groups.forEach(function (g) {
        _state.targets[g.key] = String(pickDefaultTarget(g.members).id);
      });
      var shortNames = findSharedShortNames(performers);

      addLog(tc("发现 " + groups.length + " 组重名演员", "Found " + groups.length + " duplicate groups"));
      if (shortNames.length) {
        var snDel = 0, snPerf = {};
        shortNames.forEach(function (sn) {
          sn.holders.forEach(function (h) { snPerf[h.id] = true; snDel += h.raws.length; });
        });
        addLog(tc("发现 " + shortNames.length + " 个共享短名键（" + Object.keys(snPerf).length
          + " 个演员、" + snDel + " 条别名），详见「短名清理」页",
          shortNames.length + " shared short-name keys (" + Object.keys(snPerf).length
          + " performers, " + snDel + " aliases), see the Short Names tab"));
      }
      addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
      setState({
        groups: groups, shortNames: shortNames, performers: performers,
        scanning: false, scanProgress: null, performerCount: performers.length,
      });
    } catch (e) {
      addLog(tc("扫描错误", "Scan error") + ": " + e.message);
      setState({ scanning: false, scanProgress: null });
    }
  }

  function fetchAllPerformers() {
    var PAGE_SIZE = 1000;
    var all = [];
    var page = 1;

    function fetchPage() {
      if (_state.abortFlag) return Promise.resolve(all);
      return callGQL(
        "query($filter: FindFilterType!) { findPerformers(filter: $filter) { count performers { " + PERF_FIELDS + " } } }",
        { filter: { per_page: PAGE_SIZE, page: page, sort: "id" } }
      ).then(function (data) {
        var res = data.findPerformers;
        all = all.concat(res.performers);
        updateProgressDOM(all.length, res.count, "");
        if (page * PAGE_SIZE < res.count) {
          page++;
          return fetchPage();
        }
        return all;
      });
    }
    return fetchPage();
  }

  // ==================== 合并 ====================

  var M_MERGE = "mutation($input: PerformerMergeInput!) { performerMerge(input: $input) { id name } }";

  // 计算 values（合并规则）：
  // 声明规则 — 名字/图片始终保留目标演员自己的（不传 name/image，目标字段不变）；
  // 源演员的名字+别名全部原样写入目标别名：不做任何归一化（NFC/小写/去空格/去括号
  // 后缀均不使用），仅按字符串精确去重，另排除与目标名完全相同的条目（与名字重复
  // 无信息量，且后端后续编辑该演员时会报 DuplicateAliasError）。
  // 其余字段对齐官方合并对话框默认值：
  // 消歧/单值字段：目标为空时取第一个非空源值；stash_id/URL/标签：并集
  // （stash_id 同 endpoint 目标优先）；自定义字段：目标未定义时取第一个有值源；
  // 收藏/评分：官方合并不处理，保留目标自己的值。
  // 注：后端 merge 路径不做别名校验，原样写入不会导致合并失败；但若结果中存在
  // 仅大小写不同的别名（或与名字仅大小写不同的别名），后续在官方 UI 编辑别名时
  // 会被校验拒绝，需手动清理。
  function buildMergeValues(dest, sources) {
    var values = { id: dest.id };
    var changed = false;

    // 别名：目标别名 + 源演员名 + 源别名（原样保留，仅精确去重，排除与目标名完全相同者）
    var destAliases = parseAliasList(dest.alias_list);
    var aliases = [];
    var seen = {};
    var destName = String(dest.name || "");
    function pushAlias(raw) {
      if (!raw) return;
      var s = String(raw).trim();
      if (!s || seen[s] || s === destName) return;
      seen[s] = true;
      aliases.push(s);
    }
    destAliases.forEach(pushAlias);
    sources.forEach(function (s) {
      pushAlias(s.name);
      parseAliasList(s.alias_list).forEach(pushAlias);
    });
    if (JSON.stringify(aliases) !== JSON.stringify(destAliases)) {
      values.alias_list = aliases;
      changed = true;
    }

    // stash_ids：并集，同 endpoint 目标优先
    var destStash = dest.stash_ids || [];
    var stashIds = destStash.map(function (s) { return { endpoint: s.endpoint, stash_id: s.stash_id }; });
    var endpoints = {};
    stashIds.forEach(function (s) { endpoints[s.endpoint] = true; });
    sources.forEach(function (s) {
      (s.stash_ids || []).forEach(function (sid) {
        if (!endpoints[sid.endpoint]) {
          endpoints[sid.endpoint] = true;
          stashIds.push({ endpoint: sid.endpoint, stash_id: sid.stash_id });
        }
      });
    });
    if (stashIds.length !== destStash.length) { values.stash_ids = stashIds; changed = true; }

    // 标签：并集（后端 Merge 亦会转移标签关联，传并集与官方对话框合并值一致）
    var destTags = (dest.tags || []).map(function (t) { return t.id; });
    var tagIds = destTags.slice();
    var tagSeen = {};
    tagIds.forEach(function (t) { tagSeen[t] = true; });
    sources.forEach(function (s) {
      (s.tags || []).forEach(function (t) {
        if (!tagSeen[t.id]) { tagSeen[t.id] = true; tagIds.push(t.id); }
      });
    });
    if (tagIds.length !== destTags.length) { values.tag_ids = tagIds; changed = true; }

    // URL：并集
    var destUrls = dest.urls || [];
    var urls = destUrls.slice();
    var urlSeen = {};
    urls.forEach(function (u) { urlSeen[u] = true; });
    sources.forEach(function (s) {
      (s.urls || []).forEach(function (u) {
        if (!urlSeen[u]) { urlSeen[u] = true; urls.push(u); }
      });
    });
    if (urls.length !== destUrls.length) { values.urls = urls; changed = true; }

    // 单值字段：目标为空时取第一个非空源值（官方逻辑，含消歧）
    var stringFields = ["disambiguation", "gender", "birthdate", "death_date", "ethnicity", "country", "eye_color",
      "measurements", "fake_tits", "circumcised", "career_start", "career_end",
      "tattoos", "piercings", "details", "hair_color"];
    stringFields.forEach(function (f) {
      if (dest[f]) return;
      for (var i = 0; i < sources.length; i++) {
        if (sources[i][f]) { values[f] = sources[i][f]; changed = true; return; }
      }
    });
    var numFields = ["height_cm", "weight", "penis_length"];
    numFields.forEach(function (f) {
      if (dest[f] != null) return;
      for (var i = 0; i < sources.length; i++) {
        if (sources[i][f] != null) { values[f] = sources[i][f]; changed = true; return; }
      }
    });

    // 自定义字段：目标已有字段保留，缺失字段取第一个有值源（官方逻辑，空值跳过）
    var destCF = dest.custom_fields || {};
    var cfPartial = {};
    sources.forEach(function (s) {
      var cf = s.custom_fields;
      if (!cf) return;
      for (var k in cf) {
        if (destCF[k] !== undefined || k in cfPartial) continue;
        if (!cf[k]) continue;
        cfPartial[k] = cf[k];
      }
    });
    if (Object.keys(cfPartial).length) {
      values.custom_fields = { partial: cfPartial };
      changed = true;
    }

    return changed ? values : null;
  }

  function groupTarget(group) {
    var tid = _state.targets[group.key];
    var dest = null;
    group.members.forEach(function (m) {
      if (String(m.id) === String(tid)) dest = m;
    });
    return dest || group.members[0];
  }

  function mergeOne(group) {
    var dest = groupTarget(group);
    var sources = group.members.filter(function (m) { return String(m.id) !== String(dest.id); });
    if (!dest || sources.length === 0) {
      return Promise.reject(new Error(tc("无效的目标选择", "Invalid target selection")));
    }
    var input = {
      source: sources.map(function (s) { return s.id; }),
      destination: dest.id,
    };
    var values = buildMergeValues(dest, sources);
    if (values) input.values = values;
    return callGQL(M_MERGE, { input: input }).then(function () {
      return { dest: dest, sources: sources };
    });
  }

  function mergeErrMsg(e) {
    var msg = e.message || String(e);
    if (/Cannot query field|Unknown field|unknown field|Schema does not/i.test(msg)) {
      return msg + " (" + tc("需要 Stash v0.31.0+", "requires Stash v0.31.0+") + ")";
    }
    return msg;
  }

  // 共享 stash_id 的短标签（组头部/日志兜底显示用）
  function stashIdLabel(sid) {
    if (!sid || !sid.endpoint) return "";
    return endpointShort(sid.endpoint) + ": " + String(sid.stash_id).slice(0, 8);
  }

  function groupLabel(g) {
    var name = g.sharedNames[0]
      || stashIdLabel(g.sharedStashIds && g.sharedStashIds[0])
      || (g.members[0] && g.members[0].name) || "?";
    return name + " (" + g.members.length + ")";
  }

  function handleMergeGroup(group) {
    var dest = groupTarget(group);
    var srcCount = group.members.length - 1;
    if (!confirm(tc(
      "将 " + srcCount + " 个演员合并到「" + dest.name + "」？\n\n合并后：名字与图片保留目标的；源演员的名字+别名原样并入目标别名（仅去重）；其余字段按官方规则合并。源演员将被删除，其场景/图库/图片/标签转移到目标。",
      "Merge " + srcCount + " performer(s) into \"" + dest.name + "\"?\n\nAfter merge: the target's name and image are kept; source names+aliases go into the target's aliases; other fields follow the official merge rules. Sources will be deleted and their scenes/galleries/images/tags moved to the target."))) return;

    mergeOne(group).then(function () {
      _state.merged[group.key] = true;
      delete _state.failed[group.key];
      addLog(tc("已合并", "Merged") + ": " + groupLabel(group) + " → " + dest.name);
      render();
    }).catch(function (e) {
      _state.failed[group.key] = true;
      addLog(tc("合并失败", "Merge failed") + ": " + groupLabel(group) + " — " + mergeErrMsg(e));
      render();
    });
  }

  async function handleMergeAll() {
    var pending = pendingGroups();
    if (pending.length === 0) {
      alert(tc("没有待合并的分组", "No pending groups to merge"));
      return;
    }
    var reduce = 0;
    pending.forEach(function (g) { reduce += g.members.length - 1; });
    if (!confirm(tc(
      "确认批量合并 " + pending.length + " 组重名演员？将删除 " + reduce + " 个重复演员，其内容转移到各自目标。",
      "Merge " + pending.length + " duplicate groups? " + reduce + " duplicate performers will be deleted, their content moved to the targets."))) return;

    _state.merging = true;
    _state.activeTab = "log";
    _state.mergeProgress = { current: 0, total: pending.length };
    render();

    var ok = 0, fail = 0;
    for (var i = 0; i < pending.length; i++) {
      var g = pending[i];
      updateProgressDOM(i, pending.length, groupLabel(g));
      try {
        var r = await mergeOne(g);
        ok++;
        _state.merged[g.key] = true;
        delete _state.failed[g.key];
        addLog("[" + (i + 1) + "/" + pending.length + "] " + groupLabel(g) + " → " + r.dest.name + " " + tc("成功", "OK"));
      } catch (e) {
        fail++;
        _state.failed[g.key] = true;
        addLog("[" + (i + 1) + "/" + pending.length + "] " + groupLabel(g) + " " + tc("失败", "FAIL") + ": " + mergeErrMsg(e));
      }
    }

    updateProgressDOM(pending.length, pending.length, "");
    addLog(tc("=== 合并完成: ", "=== Merge complete: ") + ok + tc(" 成功, ", " OK, ") + fail + tc(" 失败", " failed") + " ===");
    _state.merging = false;
    _state.mergeProgress = null;
    render();
  }

  // ==================== 短名清理 ====================

  var M_UPDATE = "mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }";

  function perfById(id) {
    var list = _state.performers || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  // 逐个演员提交过滤后的 alias_list（整表替换）：
  // 仅移除共享短名条目，其余别名保持原顺序原样保留；主名不在 alias_list 中，永不受影响。
  // 个别演员提交失败（如剩余别名中存在历史遗留的仅大小写重复，后端校验拒绝）只记日志跳过，不中断批量。
  // snList：要清理的短名键列表 —「清理全部」传全部，单卡「清理」只传该键。
  // 完成后不自动重扫（内存数据已就地更新，卡片直接收缩变灰）；分组页数据是清理前快照，需手动重扫。
  async function handleCleanShortNames(snList) {
    var shortNames = ((snList && snList.length) ? snList : (_state.shortNames || []))
      .filter(function (sn) { return !sn.cleaned; });
    if (!shortNames.length || _state.cleaning || _state.merging || _state.scanning) return;

    var byPerf = {}; // id -> { norms: {归一化键:true} }
    var totalDel = 0;
    shortNames.forEach(function (sn) {
      sn.holders.forEach(function (h) {
        if (!byPerf[h.id]) byPerf[h.id] = { norms: {} };
        byPerf[h.id].norms[sn.norm] = true;
        totalDel += h.raws.length;
      });
    });
    var ids = Object.keys(byPerf);
    if (!ids.length) return;

    var pendingTotal = (_state.shortNames || []).filter(function (sn) { return !sn.cleaned; }).length;
    var allKeys = shortNames.length === pendingTotal;
    if (!confirm(allKeys
      ? tc(
          "删除 " + totalDel + " 条被 ≥2 人共享的单词短名别名（涉及 " + ids.length + " 个演员）？\n\n仅删除别名条目，主名与其余别名不受影响。完成后卡片收缩变灰，不自动重新扫描。",
          "Delete " + totalDel + " single-word short-name aliases shared by 2+ performers (" + ids.length + " performers)?\n\nOnly alias entries are removed; names and other aliases are untouched. Cards collapse afterwards; no automatic rescan.")
      : tc(
          "删除短名「" + shortNames[0].raws.join(" / ") + "」的 " + totalDel + " 条别名（涉及 " + ids.length + " 个演员）？\n\n仅删除别名条目，主名与其余别名不受影响。完成后卡片收缩变灰，不自动重新扫描。",
          "Delete " + totalDel + " aliases of the short name \"" + shortNames[0].raws.join(" / ") + "\" (" + ids.length + " performers)?\n\nOnly alias entries are removed; names and other aliases are untouched. Cards collapse afterwards; no automatic rescan."))) return;

    _state.cleaning = true;
    _state.cleanProgress = { current: 0, total: ids.length };
    render();

    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      var p = perfById(ids[i]);
      var orig = p ? parseAliasList(p.alias_list) : [];
      var removeNorms = byPerf[ids[i]].norms;
      // 双重判定删除：归一化键命中共享短名清单 且 原始串本身是单词短名。
      // 第二个条件保证含空格/汉字/符号的变体（如 "A I"，归一化后同为 "ai"）永不误删。
      var kept = orig.filter(function (a) {
        return !(isShortName(a) && removeNorms[normalizeName(a)]);
      });
      if (!p || kept.length === orig.length) continue;
      updateProgressDOM(i, ids.length, p.name);
      try {
        await callGQL(M_UPDATE, { input: { id: p.id, alias_list: kept } });
        p.alias_list = kept; // 就地更新内存数据，卡片上的其他别名立即反映清理结果
        ok++;
      } catch (e) {
        fail++;
        addLog("[" + (i + 1) + "/" + ids.length + "] " + p.name + " " + tc("清理失败", "clean failed") + ": " + mergeErrMsg(e));
      }
    }

    // 全部持有者已无该短名 → 标记 cleaned（卡片收缩变灰保留）；任一持有者仍持有（失败/跳过）则保留可重试
    var cleanedNorms = {};
    shortNames.forEach(function (sn) { cleanedNorms[sn.norm] = true; });
    (_state.shortNames || []).forEach(function (sn) {
      if (!cleanedNorms[sn.norm]) return;
      var stillHeld = sn.holders.some(function (h) {
        var p = perfById(h.id);
        return !p || parseAliasList(p.alias_list).some(function (a) {
          return isShortName(a) && normalizeName(a) === sn.norm;
        });
      });
      if (!stillHeld) sn.cleaned = true;
    });

    var namesLabel = shortNames.length === 1
      ? shortNames[0].raws.join(" / ")
      : shortNames.slice(0, 5).map(function (sn) { return sn.raws[0]; }).join(", ")
        + tc(" 等 " + shortNames.length + " 键", " + " + (shortNames.length - 5) + " more");
    updateProgressDOM(ids.length, ids.length, "");
    addLog(tc("=== 短名清理完成（", "=== Short-name cleanup (") + namesLabel + "): "
      + ok + tc(" 成功, ", " OK, ") + fail + tc(" 失败", " failed") + " ===");
    if (fail === 0 && shortNames.length === pendingTotal) {
      addLog(tc("提示：重名分组为清理前快照，纯短名分组需重新扫描后消失", "Note: duplicate groups are a pre-clean snapshot; rescan to refresh"));
    }
    _state.cleaning = false;
    _state.cleanProgress = null;
    render();
  }

  // ==================== Render ====================

  function render() {
    hideTip();
    var root = document.getElementById("pdm-panel-root");
    if (!root) return;
    var scrollTop = root.scrollTop;
    root.innerHTML = "";
    root.appendChild(buildPanel());
    // scrollTop=0（面板刚打开/未滚动）时跳过写入：对刚重建的大面板写 scrollTop
    // 会强制浏览器同步计算整棵子树布局（~40ms Forced reflow），仅控制台告警无害但完全可免
    if (scrollTop > 0) root.scrollTop = scrollTop;
  }

  function el(tag, className, children, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (var k in attrs) {
        if (k === "onclick") node.onclick = attrs[k];
        else if (k === "onchange") node.onchange = attrs[k];
        else if (k === "type") node.type = attrs[k];
        else if (k === "value") node.value = attrs[k];
        else if (k === "placeholder") node.placeholder = attrs[k];
        else if (k === "disabled") node.disabled = attrs[k];
        else if (k === "checked") node.checked = attrs[k];
        else if (k === "title") node.title = attrs[k];
        else if (k === "style") node.setAttribute("style", attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      if (typeof children === "string") node.textContent = children;
      else if (Array.isArray(children)) children.forEach(function (c) {
        if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
      else if (typeof children === "object") node.appendChild(children);
    }
    return node;
  }

  // 已知 Stash-box 端点的品牌名（host 小写匹配）；未知端点回退 host
  var ENDPOINT_NAMES = {
    "theporndb.net": "ThePornDB",
    "stashdb.org": "StashDB",
    "javstash.org": "JAVStash",
  };

  function endpointShort(endpoint) {
    var host = String(endpoint || "").replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
    var branded = ENDPOINT_NAMES[host.toLowerCase()];
    return branded || host;
  }

  function buildStat(num, label, color) {
    return el("div", "pdm-stat", [
      el("div", "pdm-stat-num", String(num), { style: "color:" + color }),
      el("div", "pdm-stat-label", label),
    ]);
  }

  function buildPanel() {
    var frag = document.createDocumentFragment();

    // Header
    var closeBtn = document.createElement("button");
    closeBtn.className = "pdm-close-btn";
    closeBtn.type = "button";
    closeBtn.setAttribute("data-pdm-action", "close");
    closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    frag.appendChild(el("div", "pdm-header", [
      el("h2", "pdm-title", [
        tc("演员合并", "Performer Merge"),
        el("span", "pdm-version", "v" + PLUGIN_VERSION),
      ]),
      el("div", "pdm-header-actions", [
        _state.groups && pendingGroups().length === 0
          ? el("span", "pdm-btn-state", tc("无待合并", "Nothing to Merge"), { title: "" })
          : el("button", "pdm-btn pdm-btn-primary", tc("合并全部", "Merge All"), {
              onclick: handleMergeAll,
              disabled: _state.merging || _state.scanning || _state.cleaning || !_state.groups,
            }),
        closeBtn,
      ]),
    ]));

    // 版本警告
    if (_state.versionOk === false) {
      frag.appendChild(el("div", "pdm-warn",
        tc("当前 Stash 版本 " + _state.version + " 过低，合并需要 v0.31.0+（缺少 performerMerge）",
           "Stash " + _state.version + " is too old; merging requires v0.31.0+ (performerMerge missing)")));
    }

    // 扫描区
    frag.appendChild(el("div", "pdm-config", [
      el("div", "pdm-config-status", _state.performerCount
        ? tc("库内共 " + _state.performerCount + " 个演员", _state.performerCount + " performers in library")
        : tc("扫描全部演员，按名字+别名归一化分组，找出重名演员", "Scan all performers and group duplicates by name/alias")),
      el("div", "pdm-actions", [
        _state.scanning
          ? el("button", "pdm-btn pdm-btn-danger", tc("中止", "Abort"), {
              onclick: function () { _state.abortFlag = true; },
            })
          : el("button", "pdm-btn pdm-btn-primary", tc("开始扫描", "Start Scan"), {
              onclick: function () { handleScan(); },
              disabled: _state.cleaning || _state.merging,
            }),
      ]),
    ]));

    // 进度
    var prog = _state.mergeProgress || _state.cleanProgress || _state.scanProgress;
    if (prog) {
      var pct = prog.total ? Math.round((prog.current / prog.total) * 100) : 0;
      frag.appendChild(el("div", "pdm-progress", [
        el("div", "pdm-progress-bar", prog.current + " / " + prog.total, { style: "width:" + pct + "%" }),
        el("div", "pdm-progress-title", prog.title || ""),
      ]));
    }

    // 统计 + 分组列表
    if (_state.groups) {
      var involved = 0, reducible = 0, mergedCount = 0;
      _state.groups.forEach(function (g) {
        involved += g.members.length;
        reducible += g.members.length - 1;
        if (_state.merged[g.key]) mergedCount++;
      });
      frag.appendChild(el("div", "pdm-stats", [
        buildStat(pendingGroups().length, tc("待合并组", "Pending Groups"), "#ffa94d"),
        buildStat(reducible, tc("可减少演员", "Performers Reducible"), "#339af0"),
        buildStat(mergedCount, tc("已合并组", "Merged Groups"), "#51cf66"),
        buildStat(involved, tc("涉及演员", "Performers Involved"), "#ced4da"),
      ]));

      // 短名清理页扫描后常显：计数为未清理键数（已清理卡片收缩变灰，不计入），0 = 无待清理
      var snCount = _state.shortNames
        ? _state.shortNames.filter(function (sn) { return !sn.cleaned; }).length
        : 0;
      var tabs = [
        { id: "groups", label: tc("重名分组", "Duplicate Groups") + " (" + _state.groups.length + ")" },
        { id: "cleanup", label: tc("短名清理", "Short Names") + " (" + snCount + ")" },
        { id: "log", label: tc("日志", "Log") },
      ];
      var tabContainer = el("div", "pdm-tabs");
      tabs.forEach(function (t) {
        tabContainer.appendChild(el("div", "pdm-tab" + (_state.activeTab === t.id ? " pdm-tab-active" : ""), t.label, {
          onclick: function () { setState({ activeTab: t.id }); },
        }));
      });
      frag.appendChild(tabContainer);

      var content = el("div", "pdm-content");
      if (_state.activeTab === "groups") {
        if (_state.groups.length === 0) {
          content.appendChild(el("div", "pdm-empty", tc("未发现重名演员", "No duplicate performers found")));
        } else {
          content.appendChild(buildChunkedList(_state.groups, buildGroupCard));
        }
      } else if (_state.activeTab === "cleanup") {
        content.appendChild(buildCleanupTab());
      } else {
        var logBox = el("div", "pdm-log");
        _state.log.forEach(function (line) { logBox.appendChild(el("div", null, line)); });
        content.appendChild(logBox);
      }
      frag.appendChild(content);
    }

    return frag;
  }

  function buildGroupCard(g) {
    var isMerged = !!_state.merged[g.key];
    var isFailed = !!_state.failed[g.key];
    var targetId = _state.targets[g.key];

    var names = g.sharedNames.slice(0, 2).join(" / ");
    if (g.sharedNames.length > 2) names += " +" + (g.sharedNames.length - 2);
    if (!names && g.sharedStashIds && g.sharedStashIds.length) {
      // 无共享名称：按 stash_id 匹配的组（名字不同但同外部实体）
      names = g.sharedStashIds.slice(0, 2).map(stashIdLabel).join(" / ");
    }
    if (!names) names = (g.members[0] && g.members[0].name) || "";

    var headerRight = el("div", "pdm-card-actions");
    if (isMerged) {
      headerRight.appendChild(el("span", "pdm-badge pdm-badge-done", tc("已合并", "Merged")));
    } else {
      if (isFailed) headerRight.appendChild(el("span", "pdm-badge pdm-badge-fail", tc("失败", "Failed")));
      headerRight.appendChild(el("button", "pdm-btn pdm-btn-sm pdm-btn-merge", tc("合并", "Merge"), {
        onclick: function () { handleMergeGroup(g); },
        disabled: _state.merging || _state.cleaning || _state.versionOk === false,
        title: tc("将其他演员合并到选中目标", "Merge the others into the selected target"),
      }));
    }

    var card = el("div", "pdm-group" + (isMerged ? " pdm-group-done" : ""));
    var nameCell = el("div", "pdm-shared-name", [
      names,
      el("span", "pdm-member-count", tc(" · " + g.members.length + " 个演员", " · " + g.members.length + " performers")),
    ]);
    // 仅按 stash_id 匹配的组（名字不同）显示徽章，提示匹配依据
    if (!g.sharedNames.length && g.sharedStashIds && g.sharedStashIds.length) {
      nameCell.appendChild(el("span", "pdm-badge pdm-badge-stash", tc("stash_id 匹配", "stash_id match"), {
        title: tc("名字不同但共享 stash_id（同一外部实体）", "Different names but share stash_id (same external entity)"),
      }));
    }
    card.appendChild(el("div", "pdm-group-header", [nameCell, headerRight]));

    var list = el("div", "pdm-perf-list");
    g.members.forEach(function (p) {
      list.appendChild(buildPerfRow(g, p, String(p.id) === String(targetId)));
    });
    card.appendChild(list);

    return card;
  }

  // ==================== 短名清理页 ====================

  function buildCleanupTab() {
    var shortNames = _state.shortNames || [];
    var pending = shortNames.filter(function (sn) { return !sn.cleaned; });
    var frag = document.createDocumentFragment();

    var perfIds = {};
    var totalDel = 0;
    pending.forEach(function (sn) {
      sn.holders.forEach(function (h) { perfIds[h.id] = true; totalDel += h.raws.length; });
    });

    var cleanedCount = shortNames.length - pending.length;
    var statusText = pending.length
      ? tc("共 " + pending.length + " 个单词短名被 ≥2 人共享 · 涉及 " + Object.keys(perfIds).length
          + " 个演员 · 可删除 " + totalDel + " 条别名",
          pending.length + " single-word short names shared by 2+ performers · "
          + Object.keys(perfIds).length + " performers · " + totalDel + " aliases removable")
      : (cleanedCount
          ? tc("全部 " + cleanedCount + " 个共享短名已清理完成 — 重名分组为清理前快照，重新扫描后纯短名分组消失",
              "All " + cleanedCount + " shared short names cleaned — duplicate groups are a pre-clean snapshot; rescan to refresh")
          : tc("未发现共享短名", "No shared short names"));
    frag.appendChild(el("div", "pdm-config", [
      el("div", "pdm-config-status", statusText),
      el("div", "pdm-actions", [
        pending.length
          ? el("button", "pdm-btn pdm-btn-clean", tc("清理全部", "Clean All"), {
              onclick: function () { handleCleanShortNames(_state.shortNames.slice()); },
              disabled: _state.cleaning || _state.merging || _state.scanning,
              title: tc("仅删除别名条目，主名与含空格/汉字的全名别名不受影响；完成后卡片收缩变灰，不自动重新扫描",
                "Only alias entries are removed; names and aliases containing spaces/CJK characters are untouched. Cards collapse afterwards; no automatic rescan."),
            })
          : el("span", "pdm-btn-state", tc("已全部清理", "All Cleaned")),
      ]),
    ]));

    if (shortNames.length) {
      frag.appendChild(buildChunkedList(shortNames, buildShortNameCard));
    } else {
      frag.appendChild(el("div", "pdm-empty", tc("未发现共享短名", "No shared short names")));
    }
    return frag;
  }

  function buildShortNameCard(sn) {
    var isCleaned = !!sn.cleaned;
    var card = el("div", "pdm-group" + (isCleaned ? " pdm-group-done" : ""));
    card.appendChild(el("div", "pdm-group-header", [
      el("div", "pdm-shared-name", [
        sn.raws.join(" / "),
        el("span", "pdm-member-count", tc(" · " + sn.holders.length + " 人持有", " · held by " + sn.holders.length)),
      ]),
      isCleaned
        ? el("span", "pdm-badge pdm-badge-done", tc("已清理", "Cleaned"))
        : el("div", "pdm-card-actions", [
            el("button", "pdm-btn pdm-btn-sm pdm-btn-clean", tc("清理", "Clean"), {
              onclick: function () { handleCleanShortNames([sn]); },
              disabled: _state.cleaning || _state.merging || _state.scanning,
              title: tc("仅删除该短名的别名条目，主名与含空格/汉字的全名别名不受影响；完成后卡片收缩变灰，不自动重新扫描",
                "Only this short name's alias entries are removed; names and aliases containing spaces/CJK characters are untouched. The card collapses afterwards; no automatic rescan."),
            }),
          ]),
    ]));
    if (isCleaned) return card; // 已清理：收缩为仅头部
    var list = el("div", "pdm-perf-list");
    sn.holders.forEach(function (h) {
      // 其他别名 = 该演员完整别名中除当前短名原始串之外的条目（就地内存数据，清理后即正确）
      var rawSet = {};
      h.raws.forEach(function (r) { rawSet[r] = true; });
      var others = (function () {
        var p = perfById(h.id);
        var all = p ? parseAliasList(p.alias_list) : [];
        var out = [];
        all.forEach(function (a) { if (!rawSet[a]) out.push(a); });
        return out;
      })();
      list.appendChild(el("div", "pdm-sn-owner", [
        el("div", "pdm-sn-owner-main", [
          el("span", "pdm-sn-owner-name", h.name),
          el("span", "pdm-sn-owner-raws", h.raws.join(", ")),
          el("span", "pdm-badge pdm-badge-count", "#" + h.id),
        ]),
        others.length
          ? el("div", "pdm-sn-owner-others", tc("其他别名", "Others") + ": " + others.join(", "))
          : null,
      ]));
    });
    card.appendChild(list);
    return card;
  }

  // ==================== 演员行悬浮提示（自定义 tooltip：条目分行 + 标签加粗） ====================

  // 原生 title 属性无法加粗，改为共享 DOM 节点的自定义 tooltip；
  // 跟随光标，靠近屏幕右/下边缘时自动翻转到光标左侧/上方。
  var _tipEl = null;
  var _tipW = 0, _tipH = 0; // tooltip 尺寸缓存：showTip 时测量一次，mousemove 复用，避免每帧读 offsetWidth/Height 强制布局
  var _hasHover = window.matchMedia && !window.matchMedia("(hover: none)").matches;

  function showTip(rows, x, y) {
    if (!_tipEl) {
      _tipEl = el("div", "pdm-tooltip");
      document.body.appendChild(_tipEl);
    }
    _tipEl.textContent = "";
    rows.forEach(function (r) {
      _tipEl.appendChild(el("div", "pdm-tip-row", [
        el("span", "pdm-tip-label", r.label),
        el("span", "pdm-tip-value", r.value),
      ]));
    });
    _tipEl.classList.add("pdm-tip-show");
    _tipW = _tipEl.offsetWidth;
    _tipH = _tipEl.offsetHeight;
    moveTip(x, y);
  }

  function moveTip(x, y) {
    if (!_tipEl || !_tipEl.classList.contains("pdm-tip-show")) return;
    var pad = 8, gap = 14;
    var w = _tipW, h = _tipH;
    var left = x + gap, top = y + gap + 4;
    if (left + w > window.innerWidth - pad) left = x - w - gap;
    if (left < pad) left = pad;
    if (top + h > window.innerHeight - pad) top = y - h - gap;
    if (top < pad) top = pad;
    _tipEl.style.left = left + "px";
    _tipEl.style.top = top + "px";
  }

  function hideTip() {
    if (_tipEl) _tipEl.classList.remove("pdm-tip-show");
  }

  function buildPerfRow(g, p, isTarget) {
    var aliases = parseAliasList(p.alias_list);
    // 悬浮提示条目：ID / 别名 / 创建 / 组内重名 / 同 stash_id（匹配原因，便于核对分组是否合理）
    var tipRows = [{ label: "ID", value: String(p.id) }];
    if (aliases.length) tipRows.push({ label: tc("别名", "Aliases"), value: aliases.join(", ") });
    if (p.created_at) tipRows.push({ label: tc("创建", "Created"), value: String(p.created_at).slice(0, 10) });
    if (g.sharedNorms) {
      var matched = perfKeys(p).filter(function (k) { return g.sharedNorms[k.norm]; })
        .map(function (k) { return k.display; });
      if (matched.length) tipRows.push({ label: tc("组内重名", "Matched"), value: matched.join(", ") });
    }
    if (g.sharedSidKeys) {
      var sidMatched = (p.stash_ids || []).filter(function (s) { return g.sharedSidKeys[s.endpoint + "|" + s.stash_id]; })
        .map(function (s) { return endpointShort(s.endpoint) + ": " + s.stash_id; });
      if (sidMatched.length) tipRows.push({ label: tc("同 stash_id", "Same stash_id"), value: sidMatched.join(", ") });
    }

    var row = el("label", "pdm-perf-row" + (isTarget ? " pdm-row-target" : ""), null, {
      "data-pid": String(p.id),
    });
    if (_hasHover) {
      row.addEventListener("mouseenter", function (e) { showTip(tipRows, e.clientX, e.clientY); });
      row.addEventListener("mousemove", function (e) { moveTip(e.clientX, e.clientY); });
      row.addEventListener("mouseleave", hideTip);
    }

    var radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "pdm-target-" + g.key;
    radio.checked = isTarget;
    radio.disabled = !!_state.merged[g.key];
    radio.className = "pdm-radio";
    radio.addEventListener("change", function () {
      if (!radio.checked) return;
      _state.targets[g.key] = String(p.id);
      // 就地更新行高亮与「目标」徽章，避免整页重渲染丢失滚动位置
      var card = row.closest(".pdm-group");
      if (card) {
        card.querySelectorAll(".pdm-perf-row").forEach(function (r) {
          var isSel = r.getAttribute("data-pid") === String(p.id);
          r.classList.toggle("pdm-row-target", isSel);
          var badge = r.querySelector(".pdm-badge-target");
          if (isSel && !badge) {
            var nameEl = r.querySelector(".pdm-perf-name");
            if (nameEl) nameEl.appendChild(el("span", "pdm-badge pdm-badge-target", tc("目标", "Target")));
          } else if (!isSel && badge) {
            badge.remove();
          }
        });
      }
    });
    row.appendChild(radio);

    row.appendChild(el("div", "pdm-perf-info", [
      el("div", "pdm-perf-name", [
        p.name,
        p.disambiguation ? el("span", "pdm-perf-disamb", " (" + p.disambiguation + ")") : null,
        isTarget ? el("span", "pdm-badge pdm-badge-target", tc("目标", "Target")) : null,
      ]),
    ]));

    var badges = el("div", "pdm-perf-badges");
    badges.appendChild(el("span", "pdm-badge pdm-badge-count", tc("场景 ", "Scenes ") + (p.scene_count || 0)));
    if (p.gallery_count) badges.appendChild(el("span", "pdm-badge pdm-badge-count", tc("图库 ", "Gals ") + p.gallery_count));
    if (p.image_count) badges.appendChild(el("span", "pdm-badge pdm-badge-count", tc("图片 ", "Imgs ") + p.image_count));
    if (aliases.length) badges.appendChild(el("span", "pdm-badge pdm-badge-count", tc("别名 ", "Aliases ") + aliases.length));
    (p.stash_ids || []).forEach(function (sid) {
      badges.appendChild(el("span", "pdm-badge pdm-badge-stash", endpointShort(sid.endpoint), {
        title: sid.endpoint + " · " + sid.stash_id,
      }));
    });
    if (p.favorite) badges.appendChild(el("span", "pdm-badge pdm-badge-fav", "♥"));
    if (p.rating100) badges.appendChild(el("span", "pdm-badge pdm-badge-fav", "★" + (Math.round(p.rating100 / 20 * 10) / 10)));
    row.appendChild(badges);

    return row;
  }

  // ==================== 分块渲染（虚拟滚动） ====================

  var CHUNK_SIZE = 50;

  function buildChunkedList(items, buildCardFn) {
    var container = el("div", "pdm-chunked");
    var sentinel = el("div", "pdm-sentinel", tc("加载中...", "Loading..."));
    var rendered = 0;

    container.appendChild(sentinel);

    function renderChunk() {
      var end = Math.min(rendered + CHUNK_SIZE, items.length);
      for (var i = rendered; i < end; i++) {
        container.insertBefore(buildCardFn(items[i]), sentinel);
      }
      rendered = end;
      if (rendered >= items.length) sentinel.remove();
    }

    renderChunk();

    if (rendered < items.length) {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && rendered < items.length) renderChunk();
      }, { rootMargin: "300px" });
      observer.observe(sentinel);
    }

    return container;
  }

  // ==================== Panel ====================

  function closePanel() {
    hideTip();
    var container = document.getElementById("pdm-panel-container");
    if (container) container.remove();
  }

  function openPanel() {
    var existing = document.getElementById("pdm-panel-container");
    if (existing) {
      existing.style.display = "flex";
      render();
      return;
    }

    var container = document.createElement("div");
    container.id = "pdm-panel-container";
    container.className = "pdm-panel-container";

    container.addEventListener("click", function (e) {
      var target = e.target;
      while (target && target !== container) {
        if (target.getAttribute && target.getAttribute("data-pdm-action") === "close") {
          e.preventDefault();
          e.stopPropagation();
          closePanel();
          return;
        }
        target = target.parentElement;
      }
      if (e.target === container) closePanel();
    });

    var panel = document.createElement("div");
    panel.id = "pdm-panel-root";
    panel.className = "pdm-panel-root";

    container.appendChild(panel);
    document.body.appendChild(container);

    render();
  }

  // ==================== Nav Button（与 JavStashLinker 相同注入位置） ====================

  function setupNavButton() {
    injectNavButton();
    // SPA 导航后重新注入
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(injectNavButton, 200);
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(injectNavButton, 200);
    };
    window.addEventListener("popstate", function () {
      setTimeout(injectNavButton, 200);
    });

    // MutationObserver 兜底
    var target = document.querySelector(".main-content") || document.querySelector("#root") || document.body;
    if (target) {
      var timer = null;
      new MutationObserver(function () {
        clearTimeout(timer);
        timer = setTimeout(injectNavButton, 300);
      }).observe(target, { childList: true, subtree: true });
    }
  }

  function injectNavButton() {
    if (document.querySelector(".pdm-nav-btn")) return;

    // 导航栏右侧按钮区（与 RandomButton 同位置）
    var nav = document.querySelector(".navbar-buttons.flex-row.ml-auto.order-xl-2.navbar-nav")
           || document.querySelector(".navbar-buttons.navbar-nav")
           || document.querySelector(".navbar-nav.ml-auto");
    if (!nav) {
      nav = document.querySelector(".navbar-nav") || document.querySelector("nav ul.nav");
    }
    if (!nav) return;

    var container = document.createElement("div");
    container.className = "mr-2 pdm-nav-btn";
    container.innerHTML =
      '<a href="javascript:void(0)">' +
      '<button type="button" class="btn btn-primary pdm-nav-btn-icon" title="Performer Merge" style="display:inline-flex;align-items:center;justify-content:center;padding:5px 8px;">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="18" cy="18" r="3"/>' +
      '<circle cx="6" cy="6" r="3"/>' +
      '<path d="M6 21V9a9 9 0 0 0 9 9"/>' +
      '</svg>' +
      '</button>' +
      '</a>';
    container.querySelector("button").addEventListener("click", function () {
      openPanel();
    });

    nav.appendChild(container);
  }

  // ==================== 版本检查 ====================

  function parseVersion(v) {
    var m = String(v || "").match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function cmpVersion(a, b) {
    for (var i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function checkVersion() {
    callGQL("query { version { version } }").then(function (data) {
      var v = (data.version && data.version.version) || "";
      _state.version = v;
      var parsed = parseVersion(v);
      _state.versionOk = parsed ? cmpVersion(parsed, MIN_VERSION) >= 0 : null;
      render();
    }).catch(function () {
      _state.versionOk = null;
      render();
    });
  }

  // ==================== Init ====================

  function init() {
    setupNavButton();
    checkVersion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
