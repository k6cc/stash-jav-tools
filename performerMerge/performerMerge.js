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
    targets: {},          // groupKey -> 目标演员 id
    merged: {},           // groupKey -> true
    failed: {},           // groupKey -> true
    merging: false,
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

  function appendLogDOM(msg) {
    var logBox = document.querySelector(".pdm-log");
    if (logBox) {
      logBox.appendChild(el("div", null, msg));
      logBox.scrollTop = logBox.scrollHeight;
    }
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

  // 并查集：共享任一名称键或 stash_id 的演员连成一组（传递闭合）
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

    var keyOwners = {}; // 键（名称 norm 或 "sid:endpoint|stash_id"）-> [演员索引]
    performers.forEach(function (p, i) {
      perfKeys(p).forEach(function (k) {
        if (!keyOwners[k.norm]) keyOwners[k.norm] = [];
        keyOwners[k.norm].push(i);
      });
      // stash_id 信号：同 endpoint + 同 stash_id = 同一外部实体，
      // 比名字更硬的证据（可命中名字完全不同的同人，如罗马音 vs 日文名）
      (p.stash_ids || []).forEach(function (sid) {
        if (!sid.endpoint || !sid.stash_id) return;
        var k = "sid:" + sid.endpoint + "|" + sid.stash_id;
        if (!keyOwners[k]) keyOwners[k] = [];
        keyOwners[k].push(i);
      });
    });
    for (var norm in keyOwners) {
      var owners = keyOwners[norm];
      for (var j = 1; j < owners.length; j++) union(owners[0], owners[j]);
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

      // 组内共享名称（被 ≥2 个成员使用的键），显示名优先取真实演员名
      var keyCount = {};
      var keyDisplay = {};
      var sidCount = {};
      members.forEach(function (p) {
        perfKeys(p).forEach(function (k) {
          keyCount[k.norm] = (keyCount[k.norm] || 0) + 1;
          if (!keyDisplay[k.norm] || (k.isName && !keyDisplay[k.norm].isName)) keyDisplay[k.norm] = k;
        });
        (p.stash_ids || []).forEach(function (sid) {
          if (!sid.endpoint || !sid.stash_id) return;
          var k = sid.endpoint + "|" + sid.stash_id;
          sidCount[k] = (sidCount[k] || 0) + 1;
        });
      });
      var shared = [];
      var sharedNorms = {};
      for (var nk in keyCount) {
        if (keyCount[nk] >= 2) {
          shared.push(keyDisplay[nk].display);
          sharedNorms[nk] = true;
        }
      }
      // 组内共享 stash_id（被 ≥2 个成员使用）
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

  async function handleScan() {
    setState({
      scanning: true, abortFlag: false, groups: null, performerCount: 0,
      log: [], merged: {}, failed: {}, targets: {}, scanProgress: { current: 0, total: 0, title: "" },
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

      addLog(tc("发现 " + groups.length + " 组重名演员", "Found " + groups.length + " duplicate groups"));
      addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
      setState({ groups: groups, scanning: false, scanProgress: null });
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

  // ==================== Render ====================

  function render() {
    var root = document.getElementById("pdm-panel-root");
    if (!root) return;
    var scrollContainer = document.getElementById("pdm-panel-container");
    var scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    root.innerHTML = "";
    root.appendChild(buildPanel());
    if (scrollContainer) scrollContainer.scrollTop = scrollTop;
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

  function endpointShort(endpoint) {
    return String(endpoint || "").replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
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
      el("h2", "pdm-title", tc("演员合并", "Performer Merge")),
      el("div", "pdm-header-actions", [
        el("button", "pdm-btn pdm-btn-primary", tc("合并全部", "Merge All"), {
          onclick: handleMergeAll,
          disabled: _state.merging || _state.scanning || pendingGroups().length === 0,
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
          : el("button", "pdm-btn pdm-btn-primary", tc("开始扫描", "Start Scan"), { onclick: handleScan }),
      ]),
    ]));

    // 进度
    var prog = _state.mergeProgress || _state.scanProgress;
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

      var tabs = [
        { id: "groups", label: tc("重名分组", "Duplicate Groups") + " (" + _state.groups.length + ")" },
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
        disabled: _state.merging || _state.versionOk === false,
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

  function buildPerfRow(g, p, isTarget) {
    var aliases = parseAliasList(p.alias_list);
    var hoverParts = ["ID: " + p.id];
    if (aliases.length) hoverParts.push(tc("别名", "Aliases") + ": " + aliases.join(", "));
    if (p.created_at) hoverParts.push(tc("创建", "Created") + ": " + String(p.created_at).slice(0, 10));
    // 匹配原因：该演员与组内其他成员共享的名称键（悬停查看，便于核对分组是否合理）
    if (g.sharedNorms) {
      var matched = perfKeys(p).filter(function (k) { return g.sharedNorms[k.norm]; })
        .map(function (k) { return k.display; });
      if (matched.length) hoverParts.push(tc("组内重名", "Matched") + ": " + matched.join(", "));
    }
    if (g.sharedSidKeys) {
      var sidMatched = (p.stash_ids || []).filter(function (s) { return g.sharedSidKeys[s.endpoint + "|" + s.stash_id]; })
        .map(function (s) { return endpointShort(s.endpoint) + ": " + s.stash_id; });
      if (sidMatched.length) hoverParts.push(tc("同 stash_id", "Same stash_id") + ": " + sidMatched.join(", "));
    }

    var row = el("label", "pdm-perf-row" + (isTarget ? " pdm-row-target" : ""), null, {
      "data-pid": String(p.id),
      title: hoverParts.join(" | "),
    });

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
