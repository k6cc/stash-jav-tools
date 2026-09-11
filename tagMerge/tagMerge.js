/**
 * tagMerge
 *
 * 读取插件目录下的映射库 tag_merge_map.json（经 /plugin/tagMerge/assets/ 提供），
 * 扫描库内 tags，按归一化名称匹配出可合并分组，在面板中预览后执行合并。
 * 与 v1.x Python 任务版逻辑一致：归一化精确匹配、防链式、幂等、
 * 源 tag 合并后名称补写进目标别名（数据不丢失，仍可按原名搜索）。
 */
(function () {
  "use strict";

  if (window.__tgmLoaded) return;
  window.__tgmLoaded = true;

  var PLUGIN_VERSION = "2.5.0";
  var MAP_BASE = "/plugin/tagMerge/assets/";
  console.log("[tgm] tagMerge v" + PLUGIN_VERSION + " loaded");

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
      console.warn("[tgm] i18n bridge failed:", e);
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

  var Q_TAGS = "query { findTags(filter: {per_page: -1}) { count tags { id name scene_count scene_marker_count gallery_count image_count performer_count group_count studio_count aliases } } }";
  var Q_TAG_ALIASES = "query($id: ID!) { findTag(id: $id) { aliases } }";
  var M_TAG_CREATE = "mutation($i: TagCreateInput!) { tagCreate(input: $i) { id name } }";
  var M_TAGS_MERGE = "mutation($i: TagsMergeInput!) { tagsMerge(input: $i) { id name aliases } }";
  var M_TAG_UPDATE = "mutation($i: TagUpdateInput!) { tagUpdate(input: $i) { id } }";

  // ==================== State ====================

  var _state = {
    mapping: null,        // [{target, sources}]（文档顺序）
    mapStats: null,       // {groups, names} 映射库规模
    mapError: null,       // 映射库加载失败信息
    scanning: false,
    abortFlag: false,
    tagCount: 0,
    groups: null,         // 预览分组
    merged: {},           // key -> true
    failed: {},           // key -> true
    emptied: {},         // key -> true（源已被先前合并消耗）
    ignored: {},         // id -> true（本会话被用户忽略的源 tag，重新扫描重置，不持久化）
    ignoredGroups: {},   // key -> true（本会话被用户忽略的整组，折叠显示，重新扫描重置）
    merging: false,
    mergeProgress: null,  // {current,total}
    activeTab: "groups",
    log: [],
    editor: null,         // 映射编辑器（见 createEditorState）
  };

  function createEditorState(list, meta) {
    var eid = 0;
    return {
      loaded: true, loading: false, error: null,
      meta: meta || {},      // _ 开头的说明键，导出时原样带回
      items: list.map(function (m) {
        return { id: "e" + (eid++), target: m.target, sources: m.sources.slice(), ignored: !!m.ignored, editing: false, draftTarget: "", draftSources: "" };
      }),
      search: "",
      conflictOnly: false,       // 冲突筛选开关：列表只显示含冲突源的条目
      ignoredOnly: false,        // 忽略筛选开关：列表只显示已忽略条目（与冲突筛选互斥）
      dirty: false,
      saving: false,
      saveMsg: null,             // {text, ok} 导出结果提示（数秒淡出）
      seq: eid,
    };
  }

  // 本次扫描会话内被合并消耗的源 tag id（跨组共享，防止同一 tag 并入两个目标）
  var _consumed = {};

  function setState(updates) {
    for (var k in updates) _state[k] = updates[k];
    render();
  }

  function addLog(msg) {
    _state.log.push(msg);
    appendLogDOM(msg);
  }

  // 自动滚动到底部经 rAF 合并：一帧内追加 N 条日志只读一次 scrollHeight，
  // 避免「合并全部」时每条日志都强制布局（Forced reflow）
  var _logScrollQueued = false;

  function appendLogDOM(msg) {
    var logBox = document.querySelector(".tgm-log");
    if (!logBox) return;
    logBox.appendChild(el("div", null, msg));
    if (_logScrollQueued) return;
    _logScrollQueued = true;
    requestAnimationFrame(function () {
      _logScrollQueued = false;
      var box = document.querySelector(".tgm-log");
      if (box) box.scrollTop = box.scrollHeight;
    });
  }

  function updateProgressDOM(current, total, title) {
    var bar = document.querySelector(".tgm-progress-bar");
    var titleEl = document.querySelector(".tgm-progress-title");
    if (bar) {
      var pct = total ? Math.round((current / total) * 100) : 0;
      bar.style.width = pct + "%";
      bar.textContent = current + " / " + total;
    }
    if (titleEl && title != null) titleEl.textContent = title;
  }

  function pendingGroups() {
    return (_state.groups || []).filter(function (g) {
      if (_state.merged[g.key] || _state.failed[g.key] || _state.emptied[g.key]) return false;
      if (_state.ignoredGroups[g.key]) return false;
      return effectiveSources(g).length > 0;
    });
  }

  // ==================== 归一化 ====================

  // 与映射库生成规则一致：全角→半角（NFKC）、小写、去空白与分隔符
  var SEP_RE = /[\s\u3000·、，,。/\-—_・]+/g;

  function normalize(s) {
    return String(s || "").normalize("NFKC").toLowerCase().replace(SEP_RE, "");
  }

  // ==================== 映射库 ====================

  // 解析 {目标: [源...]} 对象：返回条目列表、源名计数、_ 开头的元数据键（导出时原样带回）
  // _ 键按值类型区分：数组 = 被忽略的映射（目标名去掉 _ 前缀，可在面板恢复），字符串 = 说明键
  // keyOrder 为可选的顶层键序数组 — JS 对象遍历（for...in / Object.keys）会把整数键（如 "69"）
  // 强制排在最前、无视插入序，必须显式传入文本键序才能保持文件顺序；缺省时回退对象遍历序
  function parseMapObject(data, keyOrder) {
    var keys;
    if (Array.isArray(keyOrder)) {
      var seen = {};
      keys = [];
      keyOrder.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(data, k) && !seen[k]) { seen[k] = true; keys.push(k); }
      });
      Object.keys(data).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; keys.push(k); }
      });
    } else {
      keys = Object.keys(data);
    }
    var list = [];
    var names = 0;
    var ignored = 0;
    var meta = {};
    keys.forEach(function (target) {
      if (target.charAt(0) === "_") {
        if (Array.isArray(data[target])) {
          // _ 前缀 + 数组值 = 被忽略的映射（扫描跳过，面板「已忽略」筛选可恢复）
          var cleanedIgn = data[target].filter(function (s) {
            return typeof s === "string" && s.trim();
          });
          if (cleanedIgn.length) {
            ignored++;
            list.push({ target: target.slice(1), sources: cleanedIgn, ignored: true });
          } else {
            meta[target] = data[target]; // 空数组/无效源：留在 meta 原样带回，防丢
          }
        } else {
          meta[target] = data[target]; // 字符串值 = 说明键
        }
        return;
      }
      var sources = data[target];
      if (!Array.isArray(sources)) return;
      var cleaned = sources.filter(function (s) {
        return typeof s === "string" && s.trim();
      });
      if (cleaned.length) {
        names += cleaned.length;
        list.push({ target: target, sources: cleaned });
      }
    });
    return { list: list, names: names, meta: meta, ignored: ignored };
  }

  // 加载映射：按优先级链读取插件目录的映射表（经 /plugin/ 资源路由，绕过缓存）。
  // tag_merge_map_<lang>.custom.json → tag_merge_map.custom.json
  // → tag_merge_map_<lang>.json → tag_merge_map.json（404 顺延下一候选，其余错误中断）
  function loadMapping() {
    return fetchMapFile();
  }

  function fetchMapFile() {
    var lang = (_intlLocale || "").replace("-", "_");
    var cands = [];
    // 优先级：用户自定义（语言）→ 用户自定义（通用）→ 发行版（语言）→ 发行版默认
    if (lang) cands.push(MAP_BASE + "tag_merge_map_" + lang + ".custom.json");
    cands.push(MAP_BASE + "tag_merge_map.custom.json");
    if (lang) cands.push(MAP_BASE + "tag_merge_map_" + lang + ".json");
    cands.push(MAP_BASE + "tag_merge_map.json");

    var i = 0;
    function attempt() {
      if (i >= cands.length) throw new Error("HTTP 404 (no mapping file)");
      var url = cands[i++];
      return fetch(url + "?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) {
          if (r.status === 404) return attempt();  // 该候选不存在 → 下一优先文件
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        })
        .then(function (text) {
          // JSON.parse 后的对象遍历（for...in / Object.keys）会把整数键（如 "69"）
          // 强制前置、无视文件顺序 — 从响应文本提取顶层键序传给 parseMapObject
          var order = [];
          var re = /^  "((?:[^"\\]|\\.)+)":/gm;
          var m;
          while ((m = re.exec(text)) !== null) order.push(m[1]);
          var parsed = parseMapObject(JSON.parse(text), order);
          return { list: parsed.list, names: parsed.names, meta: parsed.meta, source: url };
        });
    }
    return attempt();
  }

  // ==================== 扫描 ====================

  async function handleScan() {
    setState({
      scanning: true, abortFlag: false, groups: null, tagCount: 0,
      log: [], merged: {}, failed: {}, emptied: {}, ignored: {}, ignoredGroups: {},
      mapError: null, mapping: null, mapStats: null,
    });
    _consumed = {};
    addLog(tc("正在读取映射库...", "Loading mapping..."));

    var map;
    try {
      map = await loadMapping();
    } catch (e) {
      _state.mapError = e.message || String(e);
      addLog(tc("映射库读取失败", "Mapping load failed") + ": " + _state.mapError);
      setState({ scanning: false });
      return;
    }
    if (_state.abortFlag) {
      addLog(tc("用户中止扫描", "Scan aborted by user"));
      setState({ scanning: false });
      return;
    }
    var activeMap = map.list.filter(function (m) { return !m.ignored; });
    _state.mapping = activeMap;
    _state.mapStats = { groups: activeMap.length, names: map.names };
    addLog(tc("映射库 " + activeMap.length + " 组 / " + map.names + " 个源名（" + map.source + "）"
        + (map.ignored ? "，已忽略 " + map.ignored + " 组" : ""),
      activeMap.length + " mapping groups / " + map.names + " source names (" + map.source + ")"
        + (map.ignored ? ", " + map.ignored + " ignored" : "")));
    render();

    try {
      addLog(tc("正在获取库内 tags...", "Fetching tags..."));
      var tags = (await callGQL(Q_TAGS)).findTags;
      if (_state.abortFlag) {
        addLog(tc("用户中止扫描", "Scan aborted by user"));
        setState({ scanning: false });
        return;
      }
      var tagList = tags.tags || [];
      var groups = buildGroups(tagList, map.list);

      addLog(tc("共 " + tagList.length + " 个 tag，匹配 " + groups.length + " 组可合并",
        tagList.length + " tags, " + groups.length + " mergeable groups"));
      addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
      setState({
        groups: groups,
        scanning: false,
        tagCount: tagList.length,
      });
    } catch (e) {
      addLog(tc("扫描错误", "Scan error") + ": " + (e.message || String(e)));
      setState({ scanning: false });
    }
  }

  // 从 GraphQL Tag 提取引用计数（合并时这些引用随源 tag 转移到目标）
  function tagCounts(t) {
    return {
      scene: t.scene_count || 0,
      marker: t.scene_marker_count || 0,
      gallery: t.gallery_count || 0,
      image: t.image_count || 0,
      performer: t.performer_count || 0,
      group: t.group_count || 0,
      studio: t.studio_count || 0,
      alias: (t.aliases || []).length,
    };
  }

  // 计数徽章：仅显示非零项（场景/标记/图库/图片/演员/群组/工作室/别名）
  function appendCountBadges(container, counts) {
    if (!counts) return;
    var defs = [
      ["scene", tc("场景 ", "Scenes ")],
      ["marker", tc("标记 ", "Markers ")],
      ["gallery", tc("图库 ", "Galleries ")],
      ["image", tc("图片 ", "Images ")],
      ["performer", tc("演员 ", "Performers ")],
      ["group", tc("群组 ", "Groups ")],
      ["studio", tc("工作室 ", "Studios ")],
      ["alias", tc("别名 ", "Aliases ")],
    ];
    defs.forEach(function (d) {
      var n = counts[d[0]];
      if (n) container.appendChild(el("span", "tgm-badge tgm-badge-count", d[1] + n));
    });
  }

  // 预览分组（与 Python 版 merge_tags 的解析阶段一致）：
  // 精确名索引 + 归一化名索引；源名归一化精确匹配；目标自身变体并入；
  // 防链式：源名是其他组的目标名时跳过
  function buildGroups(tags, mapping) {
    var exact = {};       // 精确名 -> tag
    var normGroups = {};  // 归一化名 -> [tag]
    tags.forEach(function (t) {
      if (!exact[t.name]) exact[t.name] = t;
      var n = normalize(t.name);
      (normGroups[n] = normGroups[n] || []).push(t);
    });

    var targetNames = {};  // 精确目标名集合
    var targetNorms = {};  // 归一化目标名集合
    mapping.forEach(function (m) {
      targetNames[m.target] = true;
      targetNorms[normalize(m.target)] = true;
    });

    var groups = [];
    mapping.forEach(function (m) {
      var ownTn = normalize(m.target);
      var dest = exact[m.target] || null;

      var srcTags = [];
      var seenIds = {};
      var unmatched = 0;
      var chainSkipped = 0;

      function addCandidate(t) {
        if (dest && String(t.id) === String(dest.id)) return;
        if (seenIds[t.id]) return;
        seenIds[t.id] = true;
        srcTags.push(t);
      }

      m.sources.forEach(function (s) {
        if (s === m.target) return;
        // 防链式：源名（精确或归一化）是其他组的目标名时不作为源；
        // 与本组目标归一化相同的源（如 3P·4P vs 3P/4P）是目标自身的写法变体，正常并入
        if (targetNames[s] || (targetNorms[normalize(s)] && normalize(s) !== ownTn)) {
          chainSkipped++;
          return;
        }
        var cands = normGroups[normalize(s)] || [];
        if (!cands.length) {
          // 不存在：可能已合并过或已改名，静默跳过（保证幂等）
          unmatched++;
          return;
        }
        cands.forEach(addCandidate);
      });

      // 目标自身的归一化变体（未列入源列表的库内 tag，如大小写/全角/分隔符差异）
      (normGroups[ownTn] || []).forEach(addCandidate);

      if (!srcTags.length) return; // 无有效源：不显示

      var listedNorms = {};
      m.sources.forEach(function (s) { listedNorms[normalize(s)] = true; });

      groups.push({
        key: "g" + groups.length,
        target: m.target,
        destId: dest ? String(dest.id) : null,
        destExisted: !!dest,
        destCounts: dest ? tagCounts(dest) : null,
        created: false,
        sources: srcTags.map(function (t) {
          return {
            id: String(t.id),
            name: t.name,
            counts: tagCounts(t),
            variant: !listedNorms[normalize(t.name)], // 未列入映射、按目标变体匹配
          };
        }),
        unmatched: unmatched,
        chainSkipped: chainSkipped,
      });
    });

    // 源数降序，同数按目标名排序
    groups.sort(function (a, b) {
      var d = b.sources.length - a.sources.length;
      if (d !== 0) return d;
      return String(a.target).localeCompare(String(b.target));
    });
    return groups;
  }

  // 有效源：排除本会话被用户忽略、已被先前合并消耗的源 tag
  function effectiveSources(g) {
    return g.sources.filter(function (s) {
      if (_state.ignored[s.id]) return false;
      if (_consumed[s.id]) return false;
      if (g.destId && s.id === g.destId) return false;
      return true;
    });
  }

  // ==================== 合并 ====================

  // 执行单组合并（与 Python 版执行阶段一致）：
  // 目标不存在时新建 → tagsMerge → 源名补写进目标别名（大小写不敏感去重）
  async function runGroup(g) {
    var sources = effectiveSources(g);
    if (!sources.length) {
      _state.emptied[g.key] = true;
      return { emptied: true };
    }

    var destId = g.destId;
    var created = false;
    if (!destId) {
      var res = await callGQL(M_TAG_CREATE, { i: { name: g.target } });
      if (!res || !res.tagCreate) throw new Error("tagCreate failed");
      destId = String(res.tagCreate.id);
      g.destId = destId;
      g.destExisted = true;
      g.created = true;
      created = true;
    }

    var merged = await callGQL(M_TAGS_MERGE, {
      i: { source: sources.map(function (s) { return s.id; }), destination: destId },
    });
    sources.forEach(function (s) { _consumed[s.id] = true; });

    var m = (merged && merged.tagsMerge) || null;
    var destName = (m && m.name) || g.target;
    var aliases = (m && m.aliases) || null;
    if (aliases === null) {
      var d = await callGQL(Q_TAG_ALIASES, { id: destId });
      aliases = (d.findTag && d.findTag.aliases) || [];
    }

    var want = aliases.slice();
    var have = {};
    aliases.forEach(function (a) { have[a.toLowerCase()] = true; });
    var destLower = destName.toLowerCase();
    sources.forEach(function (s) {
      if (s.name.toLowerCase() === destLower || have[s.name.toLowerCase()]) return;
      have[s.name.toLowerCase()] = true;
      want.push(s.name);
    });
    if (want.length !== aliases.length) {
      await callGQL(M_TAG_UPDATE, { i: { id: destId, aliases: want } });
    }

    return { destName: destName, sources: sources, created: created };
  }

  function handleMergeGroup(g) {
    var sources = effectiveSources(g);
    if (!sources.length) {
      alert(tc("该组已无有效源（源已被忽略或被先前的合并消耗）", "This group has no effective sources (ignored or consumed by earlier merges)"));
      _state.emptied[g.key] = true;
      render();
      return;
    }
    if (!confirm(tc(
      "将 " + sources.length + " 个源 tag 合并到「" + g.target + "」？源 tag 将被删除。"
        + (g.destId ? "" : "\n目标 tag 不存在，将自动新建。"),
      "Merge " + sources.length + " source tag(s) into \"" + g.target + "\"? Source tags will be deleted."
        + (g.destId ? "" : "\nThe target tag does not exist and will be created.")))) return;

    runGroup(g).then(function (r) {
      if (r.emptied) {
        addLog(tc("无有效源", "No effective sources") + ": " + g.target);
      } else {
        _state.merged[g.key] = true;
        delete _state.failed[g.key];
        addLog(g.target + tc(" ← 合并 ", " ← merged ") + r.sources.length
          + tc(" 个源", " sources") + ": " + r.sources.map(function (s) { return s.name; }).join("、"));
      }
      render();
    }).catch(function (e) {
      _state.failed[g.key] = true;
      addLog(tc("合并失败", "Merge failed") + ": " + g.target + " — " + (e.message || String(e)));
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
    pending.forEach(function (g) { reduce += effectiveSources(g).length; });
    var createCount = pending.filter(function (g) { return !g.destId; }).length;
    if (!confirm(tc(
      "确认批量合并 " + pending.length + " 组？将删除 " + reduce + " 个源 tag。"
        + (createCount ? "其中 " + createCount + " 组的目标 tag 不存在，将自动新建。" : ""),
      "Merge " + pending.length + " groups? " + reduce + " source tags will be deleted."
        + (createCount ? " " + createCount + " target tag(s) do not exist and will be created." : "")))) return;

    _state.merging = true;
    _state.activeTab = "log";
    _state.mergeProgress = { current: 0, total: pending.length };
    render();

    var ok = 0, fail = 0, created = 0, mergedTags = 0, emptied = 0;
    for (var i = 0; i < pending.length; i++) {
      var g = pending[i];
      updateProgressDOM(i, pending.length, g.target);
      try {
        var r = await runGroup(g);
        if (r.emptied) {
          emptied++;
          addLog("[" + (i + 1) + "/" + pending.length + "] " + g.target + " "
            + tc("无有效源（已被先前合并消耗）", "no effective sources"));
        } else {
          ok++;
          mergedTags += r.sources.length;
          if (r.created) created++;
          _state.merged[g.key] = true;
          delete _state.failed[g.key];
          addLog("[" + (i + 1) + "/" + pending.length + "] " + g.target + " ← "
            + r.sources.length + tc(" 个源", " sources") + ": "
            + r.sources.map(function (s) { return s.name; }).join("、"));
        }
      } catch (e) {
        fail++;
        _state.failed[g.key] = true;
        addLog("[" + (i + 1) + "/" + pending.length + "] " + g.target + " "
          + tc("失败", "FAIL") + ": " + (e.message || String(e)));
      }
    }

    updateProgressDOM(pending.length, pending.length, "");
    addLog(tc("=== 合并完成: ", "=== Merge complete: ") + ok + tc(" 成功 / ", " OK / ") + fail
      + tc(" 失败 / ", " failed / ") + emptied + tc(" 无有效源，新建目标 ", " emptied, created ")
      + created + tc(" 个，共合并 ", ", merged ") + mergedTags + tc(" 个源 tag ===", " source tags ==="));
    if (fail === 0 && emptied > 0) {
      addLog(tc("提示：部分组源已被先前合并消耗，如需刷新预览请重新扫描",
        "Note: some groups' sources were consumed by earlier merges; rescan to refresh"));
    }
    _state.merging = false;
    _state.mergeProgress = null;
    render();
  }

  // ==================== Render ====================

  function render() {
    var root = document.getElementById("tgm-panel-root");
    if (!root) return;
    var scrollTop = root.scrollTop;
    root.innerHTML = "";
    root.appendChild(buildPanel());
    // scrollTop=0（面板刚打开/未滚动）时跳过写入：对刚重建的大面板写 scrollTop
    // 会强制浏览器同步计算整棵子树布局（Forced reflow）
    if (scrollTop > 0) root.scrollTop = scrollTop;
  }

  function el(tag, className, children, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (var k in attrs) {
        if (k === "onclick") node.onclick = attrs[k];
        else if (k === "disabled") node.disabled = attrs[k];
        else if (k === "title") node.title = attrs[k];
        else if (k === "value") node.value = attrs[k] == null ? "" : attrs[k];
        else if (k === "oninput") node.addEventListener("input", attrs[k]);
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

  function buildStat(num, label, color) {
    return el("div", "tgm-stat", [
      el("div", "tgm-stat-num", String(num), { style: "color:" + color }),
      el("div", "tgm-stat-label", label),
    ]);
  }

  function buildPanel() {
    var frag = document.createDocumentFragment();

    // Header
    var closeBtn = document.createElement("button");
    closeBtn.className = "tgm-close-btn";
    closeBtn.type = "button";
    closeBtn.setAttribute("data-tgm-action", "close");
    closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    frag.appendChild(el("div", "tgm-header", [
      el("h2", "tgm-title", [
        tc("Tag 合并", "Tag Merge"),
        el("span", "tgm-version", "v" + PLUGIN_VERSION),
      ]),
      el("div", "tgm-header-actions", [
        _state.groups && pendingGroups().length === 0
          ? el("span", "tgm-btn-state", tc("无待合并", "Nothing to Merge"))
          : el("button", "tgm-btn tgm-btn-primary", tc("合并全部", "Merge All"), {
              onclick: handleMergeAll,
              disabled: _state.merging || _state.scanning || !_state.groups,
            }),
        closeBtn,
      ]),
    ]));

    // 映射库加载失败警告
    if (_state.mapError) {
      frag.appendChild(el("div", "tgm-warn",
        tc("映射库读取失败（" + _state.mapError + "）— 请确认 tag_merge_map.json 与插件在同一目录，且 Stash 版本 ≥ v0.30（/plugin 资源路由）",
           "Failed to load mapping (" + _state.mapError + ") — make sure tag_merge_map.json sits next to the plugin yml and Stash is ≥ v0.30 (/plugin assets route)")));
    }

    // 扫描区
    var mapStats = _state.mapStats;
    frag.appendChild(el("div", "tgm-config", [
      el("div", "tgm-config-status", _state.tagCount
        ? tc("映射库 " + mapStats.groups + " 组 / " + mapStats.names
              + " 个源名 · 库内 " + _state.tagCount + " 个 tags",
             mapStats.groups + " mapping groups / " + mapStats.names
              + " source names · " + _state.tagCount + " tags in library")
        : tc("读取映射库，扫描库内 tags，按归一化名称匹配，预览将要合并的分组",
             "Load the mapping, scan library tags, and preview mergeable groups by normalized names")),
      el("div", "tgm-actions", [
        _state.scanning
          ? el("button", "tgm-btn tgm-btn-danger", tc("中止", "Abort"), {
              onclick: function () { _state.abortFlag = true; },
            })
          : el("button", "tgm-btn tgm-btn-primary", tc("开始扫描", "Start Scan"), {
              onclick: function () { handleScan(); },
              disabled: _state.merging || !!_state.mapError,
            }),
      ]),
    ]));

    // 进度
    if (_state.mergeProgress) {
      var prog = _state.mergeProgress;
      var pct = prog.total ? Math.round((prog.current / prog.total) * 100) : 0;
      frag.appendChild(el("div", "tgm-progress", [
        el("div", "tgm-progress-bar", prog.current + " / " + prog.total, { style: "width:" + pct + "%" }),
        el("div", "tgm-progress-title", prog.title || ""),
      ]));
    }

    // 统计（仅扫描出结果时显示）
    if (_state.groups) {
      var involved = 0, reducible = 0, mergedCount = 0;
      _state.groups.forEach(function (g) {
        involved += g.sources.length;
        if (!_state.merged[g.key] && !_state.failed[g.key] && !_state.emptied[g.key]
            && !_state.ignoredGroups[g.key]) {
          reducible += effectiveSources(g).length;
        }
        if (_state.merged[g.key]) mergedCount++;
      });
      frag.appendChild(el("div", "tgm-stats", [
        buildStat(pendingGroups().length, tc("待合并组", "Pending Groups"), "#ffa94d"),
        buildStat(reducible, tc("可减少 tag", "Tags Reducible"), "#69db7c"),
        buildStat(mergedCount, tc("已合并组", "Merged Groups"), "#74c0fc"),
        buildStat(involved, tc("涉及 tag", "Tags Involved"), "#ced4da"),
      ]));
    }

    // Tabs（始终显示 — 映射编辑不依赖扫描，参考 JavStashLinker）
    var tabs = [
      { id: "groups", label: _state.groups ? tc("分组", "Groups") + " (" + _state.groups.length + ")" : tc("分组", "Groups") },
      { id: "map", label: tc("查看映射", "Mapping") },
      { id: "log", label: tc("日志", "Log") },
    ];
    var tabContainer = el("div", "tgm-tabs");
    tabs.forEach(function (t) {
      tabContainer.appendChild(el("div", "tgm-tab" + (_state.activeTab === t.id ? " tgm-tab-active" : ""), t.label, {
        onclick: function () {
          setState({ activeTab: t.id });
          if (t.id === "map") ensureEditorLoaded();
        },
      }));
    });
    frag.appendChild(tabContainer);

    // Tab 内容
    var content = el("div", "tgm-content");
    if (_state.activeTab === "map") {
      content.appendChild(buildEditorTab());
    } else if (_state.activeTab === "log") {
      if (_state.log.length === 0) {
        content.appendChild(el("div", "tgm-empty", tc("暂无日志", "No logs yet")));
      } else {
        var logBox = el("div", "tgm-log");
        _state.log.forEach(function (line) { logBox.appendChild(el("div", null, line)); });
        content.appendChild(logBox);
      }
    } else {
      // 分组 tab
      if (!_state.groups) {
        content.appendChild(el("div", "tgm-empty",
          _state.scanning ? tc("扫描进行中...", "Scanning...")
            : tc("尚未扫描 — 点击上方「开始扫描」，或在「查看映射」中维护映射表",
               "Not scanned yet — click Start Scan above, or maintain the mapping in the Mapping tab")));
      } else if (_state.groups.length === 0) {
        content.appendChild(el("div", "tgm-empty",
          tc("未发现可合并的 tags（源已合并或不在库中）", "No mergeable tags found (already merged or not in library)")));
      } else {
        content.appendChild(buildChunkedList(_state.groups, buildGroupCard));
      }
    }
    frag.appendChild(content);

    return frag;
  }

  function buildGroupCard(g) {
    var isMerged = !!_state.merged[g.key];
    var isFailed = !!_state.failed[g.key];
    var isEmptied = !!_state.emptied[g.key];
    var isGroupIgnored = !!_state.ignoredGroups[g.key];
    var eff = effectiveSources(g);

    // 组头徽章（引用计数/状态）：始终留在组头行；窄屏换行时右对齐
    var headerBadges = el("div", "tgm-card-badges");
    // 组操作按钮（合并/忽略/恢复）：宽屏组头右侧、窄屏组底部右下角（CSS grid 控制）
    var cardActions = el("div", "tgm-card-actions");
    // 目标 tag 的引用计数徽章；已合并/已忽略后不显示（合并后计数已变；忽略后折叠仅留状态）
    if (!isMerged && !isGroupIgnored) appendCountBadges(headerBadges, g.destCounts);
    if (isMerged) {
      headerBadges.appendChild(el("span", "tgm-badge tgm-badge-done", tc("已合并", "Merged")));
    } else if (isGroupIgnored) {
      // 折叠态：状态徽章与「恢复」同容器，任意屏宽都同行
      cardActions.appendChild(el("span", "tgm-badge tgm-badge-state", tc("已忽略", "Ignored")));
      cardActions.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("恢复", "Undo"), {
        onclick: function () { delete _state.ignoredGroups[g.key]; render(); },
        disabled: _state.merging || _state.scanning,
        title: tc("恢复该组的合并资格", "Restore this group for merging"),
      }));
    } else if (isEmptied || eff.length === 0) {
      headerBadges.appendChild(el("span", "tgm-badge tgm-badge-state", tc("无有效源", "No Sources"), {
        title: tc("源已被忽略或合并消耗", "Sources ignored or consumed by merges"),
      }));
    } else {
      if (isFailed) headerBadges.appendChild(el("span", "tgm-badge tgm-badge-fail", tc("失败", "Failed")));
      cardActions.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("合并", "Merge"), {
        onclick: function () { handleMergeGroup(g); },
        disabled: _state.merging || _state.scanning,
        title: tc("将该组源 tag 合并进目标", "Merge this group's source tags into the target"),
      }));
      cardActions.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("忽略组", "Ignore Group"), {
        onclick: function () { _state.ignoredGroups[g.key] = true; render(); },
        disabled: _state.merging || _state.scanning,
        title: tc("忽略该组", "Ignore this group"),
      }));
    }

    // 源计数：已合并=实际并入数（被消耗的源），已忽略=总数，其余=有效源数
    var srcCount = isMerged
      ? g.sources.filter(function (s) { return _consumed[s.id]; }).length
      : (isGroupIgnored ? g.sources.length : eff.length);

    var card = el("div", "tgm-group"
      + (isMerged || isGroupIgnored || isEmptied || eff.length === 0 ? " tgm-group-done" : "")
      + (isGroupIgnored ? " tgm-group-ignored" : ""));
    card.appendChild(el("div", "tgm-group-header", [
      el("div", "tgm-shared-name", [
        el("span", "tgm-target-name", g.target),
        !g.destId ? el("span", "tgm-badge tgm-badge-new", tc("新建", "New"), {
          title: tc("目标不存在，合并时新建", "Target does not exist; created on merge"),
        }) : null,
        el("span", "tgm-member-count", tc(" · " + srcCount + " 个源", " · " + srcCount + " sources")),
      ]),
      headerBadges,
    ]));

    // 合并完成后折叠：仅显示组头（目标名 · 源计数 + 状态徽章）
    if (isMerged) return card;
    // 忽略后折叠：组头 + 操作按钮（恢复）
    if (isGroupIgnored) { card.appendChild(cardActions); return card; }

    var list = el("div", "tgm-src-list");

    // 源行
    g.sources.forEach(function (s) {
      var isIgnored = !!_state.ignored[s.id];
      var row = el("div", "tgm-src-row" + (isIgnored ? " tgm-row-ignored" : (_consumed[s.id] ? " tgm-row-consumed" : "")));
      row.appendChild(el("div", "tgm-src-name", [
        el("span", "tgm-src-text", s.name, {
          title: s.name,
        }),
        s.variant ? el("span", "tgm-badge tgm-badge-count", tc("变体", "Variant"), {
          title: tc("未列入映射，按归一化变体匹配", "Not in the mapping; matched as a normalized variant"),
        }) : null,
      ]));
      var badges = el("div", "tgm-src-badges");
      appendCountBadges(badges, s.counts);
      badges.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", isIgnored ? tc("恢复", "Undo") : tc("忽略", "Ignore"), {
        onclick: function () {
          if (_state.ignored[s.id]) delete _state.ignored[s.id];
          else _state.ignored[s.id] = true;
          render();
        },
        disabled: _state.merging || _state.scanning,
        title: tc("忽略该源", "Ignore this source"),
      }));
      row.appendChild(badges);
      list.appendChild(row);
    });
    card.appendChild(list);

    // 未匹配/防链式提示（暗色小字）
    var notes = [];
    if (g.unmatched) {
      notes.push(tc("未匹配 " + g.unmatched + " 个源名（已合并过或不在库中）",
        g.unmatched + " source names unmatched (already merged or not in library)"));
    }
    if (g.chainSkipped) {
      notes.push(tc("跳过 " + g.chainSkipped + " 个源名（与其他组目标重名，防链式）",
        g.chainSkipped + " source names skipped (other groups' targets, chain prevention)"));
    }
    if (notes.length) {
      card.appendChild(el("div", "tgm-group-notes", notes.join(" · ")));
    }

    // 操作按钮置于组尾：宽屏经 grid 上移至组头右侧，窄屏留在组底部右下角
    if (cardActions.childNodes.length) card.appendChild(cardActions);

    return card;
  }

  // ==================== 映射编辑器 ====================

  // 首次进入「查看映射」tab 时加载插件目录 JSON
  function ensureEditorLoaded() {
    if (_state.editor) return;
    _state.editor = { loaded: false, loading: true, error: null, meta: {}, items: [], search: "", dirty: false, saving: false, saveMsg: null, seq: 0 };
    render();
    loadMapping().then(function (map) {
      if (!_state.editor) return;
      _state.editor = createEditorState(map.list, map.meta);
      invalidateDupIndex();
      render();
    }).catch(function (e) {
      if (!_state.editor) return;
      _state.editor.loading = false;
      _state.editor.error = e.message || String(e);
      render();
    });
  }

  // 归一化键 -> 条目列表：用于重复检测。
  // 索引按 items 缓存（items 变化时失效），编辑态每次 oninput 只对比 draft，不全表重算
  var _dupIndex = null;

  function invalidateDupIndex() {
    _dupIndex = null;
  }

  function getDupIndex() {
    if (_dupIndex) return _dupIndex;
    var targets = {};
    var sources = {};
    (_state.editor ? _state.editor.items : []).forEach(function (it) {
      if (it.ignored) return; // 已忽略条目不参与重复/冲突检测（扫描也不含它们）
      var tn = normalize(it.target);
      if (tn) (targets[tn] = targets[tn] || []).push(it);
      it.sources.forEach(function (s) {
        var sn = normalize(s);
        if (sn) (sources[sn] = sources[sn] || []).push(it);
      });
    });
    _dupIndex = { targets: targets, sources: sources };
    return _dupIndex;
  }

  // 编辑态实时校验：返回 {target, sources, errors: [{msg, hard}]}；重复仅提示不阻断
  function validateDraft(item) {
    var idx = getDupIndex();
    var target = String(item.draftTarget || "").trim();
    var sources = String(item.draftSources || "").split("\n")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    var errors = [];

    if (!target) {
      errors.push({ msg: tc("目标名为空", "Target name is empty"), hard: true });
    } else {
      var tn = normalize(target);
      if (tn.charAt(0) === "_") {
        errors.push({ msg: tc("目标名不能以 _ 开头（会被忽略）", "Target must not start with _ (ignored)"), hard: true });
      }
      var dupT = [];
      (idx.targets[tn] || []).forEach(function (other) {
        if (other !== item && dupT.indexOf(other.target) < 0) dupT.push(other.target);
      });
      if (dupT.length) {
        errors.push({ msg: tc("目标与「" + dupT.join("」「") + "」重复（归一化后相同）",
          "Target duplicates \"" + dupT.join("\", \"") + "\" after normalization"), hard: false });
      }
    }

    if (!sources.length) {
      errors.push({ msg: tc("源名为空（至少一个）", "Sources are empty (at least one)"), hard: true });
    } else {
      var seen = {};
      var dupInGroup = [];
      var dupOther = {};
      var dupTarget = {};
      sources.forEach(function (s) {
        var sn = normalize(s);
        if (seen[sn]) {
          if (dupInGroup.indexOf(s) < 0) dupInGroup.push(s);
          return;
        }
        seen[sn] = true;
        (idx.sources[sn] || []).forEach(function (other) {
          if (other === item) return;
          if (dupOther[s] == null) {
            var orig = other.sources.filter(function (os) { return normalize(os) === sn; })[0];
            dupOther[s] = orig || s;
          }
        });
        (idx.targets[sn] || []).forEach(function (other) {
          if (other !== item && dupTarget[s] == null) dupTarget[s] = other.target;
        });
      });
      if (dupInGroup.length) {
        errors.push({ msg: tc("组内源重复: " + dupInGroup.join("、"), "Duplicated within group: " + dupInGroup.join(", ")), hard: false });
      }
      var otherKeys = Object.keys(dupOther);
      if (otherKeys.length) {
        errors.push({ msg: tc("源与其他条目重复: " + otherKeys.map(function (k) { return k + "↔" + dupOther[k]; }).join("、"),
          "Sources duplicated elsewhere: " + otherKeys.join(", ")), hard: false });
      }
      var targetKeys = Object.keys(dupTarget);
      if (targetKeys.length) {
        errors.push({ msg: tc("源与其他目标重复: " + targetKeys.map(function (k) { return k + "↔" + dupTarget[k]; }).join("、"),
          "Sources duplicate other targets: " + targetKeys.join(", ")), hard: false });
      }
    }

    return { target: target, sources: sources, errors: errors };
  }

  function buildEditorTab() {
    var ed = _state.editor;
    var wrap = el("div", "tgm-editor");

    if (!ed) return wrap;

    // 加载中 / 失败
    if (!ed.loaded) {
      wrap.appendChild(el("div", "tgm-empty",
        ed.loading ? tc("映射表加载中...", "Loading mapping...") : tc("加载失败: ", "Load failed: ") + (ed.error || "")));
      return wrap;
    }

    // 黄框提示：数据文件在服务器端，导出后放入插件目录即优先加载
    wrap.appendChild(el("div", "tgm-warn",
      tc("编辑后点击「导出文件」下载自定义映射表，放入插件目录即优先加载——升级插件不覆盖",
        "After editing, click Export File to download the custom mapping — drop it into the plugin folder; it loads first and survives plugin updates")));

    // 工具栏：左搜索框，右（添加 + 导出文件）
    var searchInput = el("input", "tgm-search-input", null, {
      type: "text",
      value: ed.search,
      placeholder: tc("搜索目标名或源名", "Search target or source names"),
      oninput: function (e) {
        ed.search = e.target.value;
        clearBtn.hidden = !e.target.value;
        renderEditorList();
      },
    });
    // 输入框内右对齐的清除按钮：实心可点击，仅有内容时显示（hidden 属性，见 CSS 注释）
    // （工具栏不随输入重建以保持焦点，用 hidden 切换显隐）
    var clearBtn = el("button", "tgm-search-clear", "×", {
      type: "button",
      title: tc("清空搜索", "Clear search"),
      onclick: function () {
        ed.search = "";
        searchInput.value = "";
        clearBtn.hidden = true;
        renderEditorList();
        searchInput.focus();
      },
    });
    clearBtn.hidden = !ed.search;
    var searchWrap = el("div", "tgm-search-wrap", [searchInput, clearBtn]);
    var toolbarBtns = [
      el("button", "tgm-btn tgm-btn-muted", tc("添加", "Add"), {
        onclick: handleEditorAdd,
        disabled: ed.saving,
      }),
      hasAnyConflict() ? el("button", "tgm-btn tgm-btn-warn" + (ed.conflictOnly ? " tgm-btn-warn-on" : ""), tc("冲突项", "Conflicts"), {
        onclick: function () {
          ed.conflictOnly = !ed.conflictOnly;
          if (ed.conflictOnly) {
            ed.search = ""; // 进入筛选时清空搜索
            ed.ignoredOnly = false; // 与「已忽略」筛选互斥
          }
          render();
        },
        title: tc(ed.conflictOnly ? "退出冲突筛选" : "筛选显示含冲突源的条目",
          ed.conflictOnly ? "Exit conflict filter" : "Show only entries with conflict sources"),
      }) : null,
      // 已忽略筛选：常驻显示（无已忽略条目也不隐藏），保留恢复入口的可发现性
      el("button", "tgm-btn tgm-btn-warn" + (ed.ignoredOnly ? " tgm-btn-warn-on" : ""), tc("已忽略", "Ignored"), {
        onclick: function () {
          ed.ignoredOnly = !ed.ignoredOnly;
          if (ed.ignoredOnly) {
            ed.search = ""; // 进入筛选时清空搜索
            ed.conflictOnly = false; // 与「冲突项」筛选互斥
          }
          render();
        },
        title: tc(ed.ignoredOnly ? "退出忽略筛选" : "筛选显示已忽略的条目",
          ed.ignoredOnly ? "Exit ignored filter" : "Show only ignored entries"),
      }),
      el("button", "tgm-btn tgm-btn-primary", ed.saving ? tc("导出中...", "Exporting...") : tc("导出文件", "Export File"), {
        onclick: handleEditorExport,
        disabled: ed.saving,
        title: tc("下载完整映射表 JSON", "Download the full mapping JSON"),
      }),
    ].filter(Boolean);
    wrap.appendChild(el("div", "tgm-editor-toolbar", [
      searchWrap,
      el("div", "tgm-editor-toolbar-actions", toolbarBtns),
    ]));

    // 状态行：未导出修改（黄）/ 导出结果（成功绿、失败红）
    if (ed.dirty || ed.saveMsg) {
      var statusEl = el("div", "tgm-editor-status");
      if (ed.dirty) {
        statusEl.appendChild(el("span", "tgm-editor-status-dirty", tc("● 已编辑未导出", "● Edited, not yet exported")));
      }
      if (ed.dirty && ed.saveMsg) statusEl.appendChild(document.createTextNode(" · "));
      if (ed.saveMsg) {
        statusEl.appendChild(el("span", ed.saveMsg.ok ? "tgm-editor-status-ok" : "tgm-editor-status-err", ed.saveMsg.text));
      }
      wrap.appendChild(statusEl);
    }

    // 列表（局部更新锚点；构建时直接传入容器，搜索输入时从 DOM 查找）
    var listEl = el("div", "tgm-editor-list");
    wrap.appendChild(listEl);
    renderEditorList(listEl);

    return wrap;
  }

  // 只重建列表区域（搜索输入时保持输入框焦点，避免全量 render）
  function renderEditorList(listEl) {
    if (!listEl) listEl = document.querySelector("#tgm-panel-root .tgm-editor-list");
    if (!listEl) return;
    var ed = _state.editor;
    listEl.innerHTML = "";

    if (!ed.items.length) {
      listEl.appendChild(el("div", "tgm-empty",
        tc("映射表为空 — 点击「添加」新建，或「导出文件」保存空表", "Mapping is empty — click Add to create, or Export File to persist the empty table")));
      return;
    }

    // 冲突已全部清理时自动退出筛选（点击「清理」后条目即时移出，清完回归全列表）；
    // 「已忽略」筛选不自动退出 — 按钮常驻，空列表显示提示文案，手动点击退出
    // （自动退出会让空态下点击进入后标志位被重置，按钮呈现激活态却永远无法切回）
    if (ed.conflictOnly && !hasAnyConflict()) ed.conflictOnly = false;

    var q = ed.search.trim().toLowerCase();
    // 视图基底：忽略筛选只看已忽略条目，其余视图（全部/冲突）不含已忽略
    var base = ed.ignoredOnly
      ? ed.items.filter(function (it) { return it.ignored; })
      : ed.items.filter(function (it) { return !it.ignored; });
    var filtered = q
      ? base.filter(function (it) {
          if (it.target.toLowerCase().indexOf(q) >= 0) return true;
          return it.sources.some(function (s) { return s.toLowerCase().indexOf(q) >= 0; });
        })
      : base;
    if (ed.conflictOnly) {
      filtered = filtered.filter(function (it) { return getConflictSources(it); });
    }

    if (!filtered.length) {
      listEl.appendChild(el("div", "tgm-empty",
        q ? tc("无匹配结果", "No matches")
          : ed.conflictOnly ? tc("无冲突项", "No conflicts")
          : ed.ignoredOnly ? tc("无已忽略条目", "No ignored entries")
          : tc("所有条目均已忽略 — 通过「已忽略」筛选恢复", "All entries are ignored — restore them via the Ignored filter")));
      return;
    }

    if (ed.ignoredOnly) {
      listEl.appendChild(el("div", "tgm-conflict-hint",
        tc("● 已忽略筛选: " + filtered.length + " 个条目",
          "● Ignored filter: " + filtered.length + " entries")));
    } else if (ed.conflictOnly) {
      listEl.appendChild(el("div", "tgm-conflict-hint",
        tc("● 冲突筛选: " + filtered.length + " 个条目",
          "● Conflict filter: " + filtered.length + " entries")));
    }

    listEl.appendChild(buildChunkedList(filtered, buildEditorItem));
  }

  function buildEditorItem(item) {
    if (item.ignored) return buildEditorIgnoredItem(item); // 已忽略条目：只读卡片（状态徽章 + 恢复）
    return item.editing ? buildEditorItemEdit(item) : buildEditorItemView(item);
  }

  // 条目的冲突源名集合（源名 -> true）：组内归一化重复 + 跨条目重复 + 源与其他条目目标重名
  // （与本组目标归一化相同的源是目标自身的写法变体，扫描时正常并入，不算冲突）
  // 返回 null 表示无冲突
  function getConflictSources(item) {
    var idx = getDupIndex();
    var conflicts = null;
    var seenInItem = {};
    item.sources.forEach(function (s) {
      var sn = normalize(s);
      if (!sn) return;
      if (seenInItem[sn]) { // 组内：本条目里已出现过归一化相同的源
        conflicts = conflicts || {};
        conflicts[s] = true;
        return;
      }
      seenInItem[sn] = s;
      if (idx.sources[sn] && idx.sources[sn].some(function (o) { return o !== item; })) {
        conflicts = conflicts || {};
        conflicts[s] = true;
        return;
      }
      if (idx.targets[sn] && idx.targets[sn].some(function (o) { return o !== item; })) {
        // 源名与其他条目目标重名：扫描时会被防链式规则跳过，死数据
        conflicts = conflicts || {};
        conflicts[s] = true;
      }
    });
    return conflicts;
  }

  // 编辑器是否存在任何冲突（工具栏「冲突项」按钮的显隐依据；已忽略条目不参与）
  function hasAnyConflict() {
    var items = _state.editor ? _state.editor.items : [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].ignored) continue;
      if (getConflictSources(items[i])) return true;
    }
    return false;
  }

  // 清理单条目的冲突源：删除组内归一化重复（保留首个）、跨条目重复（本条目让出）
  // 与其他条目目标重名的源，只动 item.sources，不触碰其他条目 — 手动编辑出冲突时的一键兜底
  function handleEditorClean(item) {
    var idx = getDupIndex();
    var seen = {};
    var kept = [];
    var removed = 0;
    item.sources.forEach(function (s) {
      var sn = normalize(s);
      if (!sn) { kept.push(s); return; }
      if (seen[sn]) { removed++; return; } // 组内重复：保留首个
      if (idx.sources[sn] && idx.sources[sn].some(function (o) { return o !== item; })) {
        removed++; return; // 跨条目重复：本条目让出
      }
      if (idx.targets[sn] && idx.targets[sn].some(function (o) { return o !== item; })) {
        removed++; return; // 源与其他条目目标重名：防链式死数据，直接移除
      }
      seen[sn] = s;
      kept.push(s);
    });
    if (!removed) return;
    item.sources = kept;
    var ed = _state.editor;
    ed.dirty = true;
    invalidateDupIndex();
    addLog(tc("清理冲突: 「" + item.target + "」移除 " + removed + " 个冲突源",
      "Cleaned conflicts: removed " + removed + " conflict source(s) from \"" + item.target + "\""));
    render();
  }

  // 列表态：目标名 + 源徽章（冲突源标黄）+ 重复提示 + 清理/编辑/删除
  function buildEditorItemView(item) {
    var ed = _state.editor;
    var idx = getDupIndex();
    var conflicts = getConflictSources(item);

    var card = el("div", "tgm-edit-item");
    card.setAttribute("data-item-id", item.id);

    var actionBtns = [];
    if (conflicts) {
      actionBtns.push(el("button", "tgm-btn tgm-btn-sm tgm-btn-warn", tc("清理", "Clean"), {
        onclick: function () { handleEditorClean(item); },
        disabled: ed.saving,
        title: tc("移除本条目的冲突源", "Remove this entry's conflict sources"),
      }));
    }
    actionBtns.push(el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("编辑", "Edit"), {
      onclick: function () {
        item.editing = true;
        item.draftTarget = item.target;
        item.draftSources = item.sources.join("\n");
        render();
      },
      disabled: ed.saving,
    }));
    actionBtns.push(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("忽略", "Ignore"), {
      onclick: function () { handleEditorIgnore(item); },
      disabled: ed.saving,
      title: tc("忽略该映射", "Ignore this mapping"),
    }));
    actionBtns.push(el("button", "tgm-btn tgm-btn-sm tgm-btn-danger", tc("删除", "Delete"), {
      onclick: function () { handleEditorRemove(item); },
      disabled: ed.saving,
    }));

    // 头部：目标名 + 右组（徽章+按钮绑成整组）— 放不下时右组整体换行到下方右对齐，不挤压目标名
    card.appendChild(el("div", "tgm-edit-item-head", [
      el("span", "tgm-edit-item-target", item.target, { title: item.target }),
      el("div", "tgm-edit-item-side", [
        el("span", "tgm-badge tgm-badge-count", tc(item.sources.length + " 源", item.sources.length + " sources")),
        el("div", "tgm-card-actions", actionBtns),
      ]),
    ]));

    var srcWrap = el("div", "tgm-edit-item-sources");
    item.sources.forEach(function (s) {
      srcWrap.appendChild(el("span", conflicts && conflicts[s] ? "tgm-edit-src tgm-edit-src-conflict" : "tgm-edit-src", s, { title: s }));
    });
    card.appendChild(srcWrap);

    // 重复提示（红字）：目标重复 / 组内源重复 / 跨条目源重复 / 源与其他条目目标重名
    // （与本组目标归一化相同的源是目标自身写法变体，扫描时正常并入，不提示）
    var dups = [];
    var tn = normalize(item.target);
    if (tn && idx.targets[tn].length > 1) {
      var others = idx.targets[tn].filter(function (it) { return it !== item; })
        .map(function (it) { return it.target; });
      dups.push(tc("目标与「" + others.join("」「") + "」重复", "Target duplicates \"" + others.join("\", \"") + "\""));
    }
    var dupInGroup = [];
    var dupCross = [];
    var dupOtherTarget = [];
    item.sources.forEach(function (s) {
      var sn = normalize(s);
      if (!sn) return;
      var owners = idx.sources[sn];
      if (owners && owners.length >= 2) {
        if (owners.filter(function (o) { return o === item; }).length > 1) dupInGroup.push(s);
        if (owners.some(function (o) { return o !== item; })) dupCross.push(s);
      }
      var targetOwners = idx.targets[sn];
      if (targetOwners && targetOwners.some(function (o) { return o !== item; })) dupOtherTarget.push(s);
    });
    if (dupInGroup.length) {
      dups.push(tc("组内源重复: " + dupInGroup.join("、"),
        "Duplicated within group: " + dupInGroup.join(", ")));
    }
    if (dupCross.length) {
      var crossOwners = {};
      dupCross.forEach(function (s) {
        idx.sources[normalize(s)].forEach(function (o) {
          if (o !== item) crossOwners[o.target] = true;
        });
      });
      dups.push(tc("源与其他条目重复: " + dupCross.join("、") + " → " + Object.keys(crossOwners).join("、"),
        "Sources duplicated across entries: " + dupCross.join(", ") + " -> " + Object.keys(crossOwners).join(", ")));
    }
    if (dupOtherTarget.length) {
      var dupTargetOwners = {};
      dupOtherTarget.forEach(function (s) {
        idx.targets[normalize(s)].forEach(function (o) {
          if (o !== item) dupTargetOwners[o.target] = true;
        });
      });
      dups.push(tc("源与其他目标重复: " + dupOtherTarget.join("、") + " → " + Object.keys(dupTargetOwners).join("、"),
        "Sources duplicate other targets: " + dupOtherTarget.join(", ") + " -> " + Object.keys(dupTargetOwners).join(", ")));
    }
    if (dups.length) {
      card.appendChild(el("div", "tgm-edit-item-dup", dups.join(" · ")));
    }

    return card;
  }

  // 已忽略条目：只读卡片 — 目标名 + N 源徽章 + 透明框「已忽略」状态徽章 + 「恢复」按钮
  function buildEditorIgnoredItem(item) {
    var ed = _state.editor;
    var card = el("div", "tgm-edit-item");
    card.setAttribute("data-item-id", item.id);

    // 头部结构与列表态一致：目标名 + 右组（徽章+状态+恢复），放不下时右组整体换行
    card.appendChild(el("div", "tgm-edit-item-head", [
      el("span", "tgm-edit-item-target", item.target, { title: item.target }),
      el("div", "tgm-edit-item-side", [
        el("span", "tgm-badge tgm-badge-count", tc(item.sources.length + " 源", item.sources.length + " sources")),
        el("span", "tgm-badge tgm-badge-state", tc("已忽略", "Ignored")),
        el("div", "tgm-card-actions", [
          el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("恢复", "Restore"), {
            onclick: function () { handleEditorRestore(item); },
            disabled: ed.saving,
            title: tc("恢复该映射", "Restore this mapping"),
          }),
        ]),
      ]),
    ]));

    var srcWrap = el("div", "tgm-edit-item-sources");
    item.sources.forEach(function (s) {
      srcWrap.appendChild(el("span", "tgm-edit-src", s, { title: s }));
    });
    card.appendChild(srcWrap);

    return card;
  }

  // 编辑态：目标输入 + 源 textarea + 实时校验 + 保存/撤销
  function buildEditorItemEdit(item) {
    var ed = _state.editor;
    var card = el("div", "tgm-edit-item tgm-edit-item-active");

    var targetInput;
    var sourcesTa;
    var errEl = el("div", "tgm-edit-errors");

    function refreshValidation() {
      var v = validateDraft(item);
      var msgs = v.errors.map(function (e) { return e.msg; });
      errEl.textContent = msgs.length ? msgs.join(" · ") : "";
      targetInput.className = "tgm-edit-input" + (msgs.length ? " tgm-edit-input-err" : "");
      sourcesTa.className = "tgm-edit-textarea" + (msgs.length ? " tgm-edit-input-err" : "");
    }

    targetInput = el("input", "tgm-edit-input", null, {
      type: "text",
      value: item.draftTarget,
      placeholder: tc("目标 tag 名（合并后的规范名）", "Target tag name (canonical name after merge)"),
      oninput: function (e) { item.draftTarget = e.target.value; refreshValidation(); },
    });
    card.appendChild(el("div", "tgm-edit-field", [
      el("label", "tgm-edit-label", tc("目标", "Target")),
      targetInput,
    ]));

    sourcesTa = el("textarea", "tgm-edit-textarea", null, {
      rows: Math.min(8, Math.max(3, String(item.draftSources || "").split("\n").length)),
      value: item.draftSources,
      placeholder: tc("源名，每行一个", "Source names, one per line"),
      oninput: function (e) { item.draftSources = e.target.value; refreshValidation(); },
    });
    card.appendChild(el("div", "tgm-edit-field", [
      el("label", "tgm-edit-label", tc("源（每行一个）", "Sources (one per line)")),
      sourcesTa,
    ]));

    card.appendChild(errEl);

    card.appendChild(el("div", "tgm-edit-item-head", [
      el("div", "tgm-card-actions", [
        el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("保存", "Save"), {
          onclick: function () { handleEditorApply(item); },
          disabled: ed.saving,
        }),
        el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("撤销", "Revert"), {
          onclick: function () { handleEditorCancel(item); },
          disabled: ed.saving,
        }),
      ]),
    ]));

    refreshValidation();
    return card;
  }

  // 单条保存：应用到本地列表（标 dirty），重复仅警告
  function handleEditorApply(item) {
    var ed = _state.editor;
    var v = validateDraft(item);
    var hard = v.errors.filter(function (e) { return e.hard; })
      .map(function (e) { return e.msg; });
    if (hard.length) {
      alert(hard.join("\n"));
      return;
    }
    var soft = v.errors.map(function (e) { return e.msg; });
    if (soft.length) {
      if (!confirm(tc("存在重复项，仍要保存该条映射吗？\n\n" + soft.join("\n"),
          "Duplicates found. Save this entry anyway?\n\n" + soft.join("\n")))) return;
    }
    item.target = v.target;
    item.sources = v.sources;
    item.editing = false;
    ed.dirty = true;
    invalidateDupIndex();
    render();
  }

  // 撤销编辑：新空条目（从未保存过）直接移除
  function handleEditorCancel(item) {
    var ed = _state.editor;
    if (!item.target && !item.sources.length) {
      var idx = ed.items.indexOf(item);
      if (idx >= 0) ed.items.splice(idx, 1);
    }
    item.editing = false;
    render();
  }

  function handleEditorRemove(item) {
    var ed = _state.editor;
    if (!confirm(tc("删除映射「" + item.target + "」（" + item.sources.length
        + " 个源）？仅从映射表移除，不影响库内 tag。",
        "Delete mapping \"" + item.target + "\" (" + item.sources.length
        + " sources)? Removes it from the mapping only; library tags are untouched."))) return;
    var idx = ed.items.indexOf(item);
    if (idx >= 0) ed.items.splice(idx, 1);
    ed.dirty = true;
    invalidateDupIndex();
    render();
  }

  // 忽略映射：条目标记 ignored，扫描跳过、导出为 _ 前缀键 — 可恢复，无需确认
  function handleEditorIgnore(item) {
    var ed = _state.editor;
    var key = "_" + item.target;
    if (Object.prototype.hasOwnProperty.call(ed.meta, key)) {
      alert(tc("忽略键「" + key + "」与说明键冲突 — 请先删除或重命名该说明键",
        "Ignore key \"" + key + "\" collides with a description key — remove or rename it first"));
      return;
    }
    item.ignored = true;
    ed.dirty = true;
    invalidateDupIndex();
    addLog(tc("映射编辑器: 忽略「" + item.target + "」", "Mapping editor: ignored \"" + item.target + "\""));
    render();
  }

  // 恢复映射：重新参与扫描分组与冲突/重复检测
  function handleEditorRestore(item) {
    var ed = _state.editor;
    item.ignored = false;
    ed.dirty = true;
    invalidateDupIndex();
    addLog(tc("映射编辑器: 恢复「" + item.target + "」", "Mapping editor: restored \"" + item.target + "\""));
    render();
  }

  function handleEditorAdd() {
    var ed = _state.editor;
    ed.search = "";
    ed.conflictOnly = false; // 新条目无冲突，退出筛选避免被过滤隐藏
    ed.ignoredOnly = false; // 新条目未被忽略，退出忽略筛选
    var searchEl = document.querySelector("#tgm-panel-root .tgm-search-input");
    if (searchEl) searchEl.value = "";
    ed.items.unshift({
      id: "e" + (ed.seq++),
      target: "", sources: [],
      editing: true, draftTarget: "", draftSources: "",
    });
    invalidateDupIndex();
    render();
  }

  // 导出文件：组装完整 JSON（含 _ 开头说明键）下载为 tag_merge_map.json，
  // 由用户手动替换插件目录中的同名文件 — 纯 UI 插件无法直接写服务器文件
  function handleEditorExport() {
    var ed = _state.editor;
    var editingCount = ed.items.filter(function (it) { return it.editing; }).length;
    if (editingCount) {
      alert(tc("有 " + editingCount + " 条映射正在编辑中 — 请先逐条「保存」或「撤销」",
        editingCount + " entr(ies) are being edited — save or revert them first"));
      return;
    }

    var pairs = [];
    var byKey = {};
    for (var mk in ed.meta) {
      if (Object.prototype.hasOwnProperty.call(ed.meta, mk)) { pairs.push([mk, ed.meta[mk]]); byKey[mk] = true; }
    }
    var count = 0;
    ed.items.forEach(function (it) {
      var t = it.target.trim();
      if (!t || !it.sources.length) return;
      count++;
      var key = it.ignored ? "_" + t : t; // 已忽略条目导出为 _ 前缀键（扫描跳过）
      if (byKey[key]) {
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i][0] === key) { pairs[i][1] = it.sources.slice(); break; }
        }
      } else {
        byKey[key] = true;
        pairs.push([key, it.sources.slice()]);
      }
    });
    if (!count && ed.items.length) {
      if (!confirm(tc("所有映射都为空 — 导出空表后扫描将匹配不到任何分组，继续？",
          "All entries are empty — exporting an empty table means scans match nothing. Continue?"))) return;
    }

    // 保序拼装：JSON.stringify 会把纯数字键（如 "69"）强制排到对象最前，破坏文件键序；
    // 数组值（映射源）单行书写（与 README 示例一致），一条映射一行，便于阅读与检索；
    // 字符串值（_ 说明键）原样序列化
    var blob = new Blob([pairs.length ? "{\n" + pairs.map(function (p) {
      return "  " + JSON.stringify(p[0]) + ": " + (Array.isArray(p[1])
        ? "[" + p[1].map(function (s) { return JSON.stringify(s); }).join(", ") + "]"
        : JSON.stringify(p[1]));
    }).join(",\n") + "\n}" : "{}"], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    var lang = (_intlLocale || "").replace("-", "_");
    a.download = "tag_merge_map" + (lang ? "_" + lang : "") + ".custom.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    var ignoredCnt = ed.items.filter(function (it) { return it.ignored; }).length;
    ed.dirty = false;
    ed.saveMsg = { ok: true, text: tc("已导出 " + count + " 组映射"
        + (ignoredCnt ? "（含 " + ignoredCnt + " 组已忽略）" : "")
        + " — 放入插件目录即优先加载，升级插件不覆盖",
      "Exported " + count + " mappings"
        + (ignoredCnt ? " (" + ignoredCnt + " ignored)" : "")
        + " — drop into the plugin folder; it loads first and survives updates") };
    addLog(tc("映射编辑器: 导出 " + count + " 组映射", "Mapping editor: exported " + count + " mappings"));
    render();
    setTimeout(function () {
      if (_state.editor && _state.editor.saveMsg) {
        _state.editor.saveMsg = null;
        render();
      }
    }, 5000);
  }

  // ==================== 分块渲染 ====================

  var CHUNK_SIZE = 50;

  function buildChunkedList(items, buildCardFn) {
    var container = el("div", "tgm-chunked");
    var sentinel = el("div", "tgm-sentinel", tc("加载中...", "Loading..."));
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
    var container = document.getElementById("tgm-panel-container");
    if (container) container.remove();
  }

  function openPanel() {
    var existing = document.getElementById("tgm-panel-container");
    if (existing) {
      existing.style.display = "flex";
      render();
      return;
    }

    var container = document.createElement("div");
    container.id = "tgm-panel-container";
    container.className = "tgm-panel-container";

    container.addEventListener("click", function (e) {
      var target = e.target;
      while (target && target !== container) {
        if (target.getAttribute && target.getAttribute("data-tgm-action") === "close") {
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
    panel.id = "tgm-panel-root";
    panel.className = "tgm-panel-root";

    container.appendChild(panel);
    document.body.appendChild(container);

    render();
  }

  // ==================== Nav Button（与 performerMerge 相同注入位置） ====================

  function setupNavButton() {
    injectNavButton();
    setupRefractTile();
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
    if (document.querySelector(".tgm-nav-btn")) return;

    // 导航栏右侧按钮区（与 performerMerge 同位置）
    var nav = document.querySelector(".navbar-buttons.flex-row.ml-auto.order-xl-2.navbar-nav")
           || document.querySelector(".navbar-buttons.navbar-nav")
           || document.querySelector(".navbar-nav.ml-auto");
    if (!nav) {
      nav = document.querySelector(".navbar-nav") || document.querySelector("nav ul.nav");
    }
    if (!nav) return;

    var container = document.createElement("div");
    container.className = "mr-2 tgm-nav-btn";
    container.innerHTML =
      '<a href="javascript:void(0)">' +
      '<button type="button" class="btn btn-primary tgm-nav-btn-icon" title="Tag Merge" style="display:inline-flex;align-items:center;justify-content:center;padding:5px 8px;">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/>' +
      '<path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/>' +
      '<circle cx="6.5" cy="9.5" r=".5" fill="currentColor"/>' +
      '</svg>' +
      '</button>' +
      '</a>';
    container.querySelector("button").addEventListener("click", function () {
      openPanel();
    });

    nav.appendChild(container);
    injectRefractTile();
  }

  // ==================== Refract 主题移动端适配 ====================
  // Refract 在移动端隐藏原生导航，改用自建底部 dock + 抽屉（.refract-mobile-drawer）。
  // 抽屉只镜像真实路由 a[href]（排除 javascript: 伪链接）或主题硬编码白名单按钮，
  // 本插件按钮两者都不满足，因此按主题 action tile 结构自注入代理 tile：
  // 抽屉/底部 dock 的点击逻辑会按 data-action-selector 把点击转发给源按钮，
  // Settings → Interface → Refract → Mobile dock 的候选采集也会自动收录本 tile。

  function setupRefractTile() {
    if (window.__tgmRefractTileInit) return;
    window.__tgmRefractTileInit = true;
    var timer = null;
    // 抽屉是 body 直接子元素：childList（非 subtree）捕捉其创建/销毁
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(injectRefractTile, 200);
    }).observe(document.body, { childList: true });
    injectRefractTile();
  }

  function injectRefractTile() {
    var drawer = document.querySelector(".refract-mobile-drawer");
    if (!drawer) return;
    if (!drawer.__tgmTileObs) {
      drawer.__tgmTileObs = true;
      // 抽屉内 tile 被移除（源按钮暂时不在时主题 reconcile 会清除）后自动补注
      new MutationObserver(function () {
        clearTimeout(drawer.__tgmTileTimer);
        drawer.__tgmTileTimer = setTimeout(injectRefractTile, 200);
      }).observe(drawer, { childList: true });
    }
    if (drawer.querySelector('.refract-drawer-tile[data-action="tgm"]')) return;
    if (!document.querySelector(".tgm-nav-btn-icon")) return;

    var tile = document.createElement("a");
    tile.className = "refract-drawer-tile";
    tile.setAttribute("href", "#");
    tile.setAttribute("data-action", "tgm");
    tile.setAttribute("data-action-tile", "1");
    tile.setAttribute("data-action-selector", ".tgm-nav-btn-icon");
    tile.setAttribute("aria-label", "Tag Merge");
    tile.setAttribute("title", "Tag Merge");
    var icon = document.createElement("span");
    icon.className = "refract-drawer-tile-icon";
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19"/>' +
      '<path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z"/>' +
      '<circle cx="6.5" cy="9.5" r=".5" fill="currentColor"/>' +
      '</svg>';
    tile.appendChild(icon);
    drawer.appendChild(tile);
  }

  // ==================== Init ====================

  function init() {
    setupNavButton();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
