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

  var PLUGIN_VERSION = "2.0.2";
  var MAP_URL = "/plugin/tagMerge/assets/tag_merge_map.json";
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
        return { id: "e" + (eid++), target: m.target, sources: m.sources.slice(), editing: false, draftTarget: "", draftSources: "" };
      }),
      search: "",
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
    var meta = {};
    keys.forEach(function (target) {
      if (target.charAt(0) === "_") {
        meta[target] = data[target];
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
    return { list: list, names: names, meta: meta };
  }

  // 加载映射：读取插件目录的 tag_merge_map.json（经 /plugin/ 资源路由，绕过缓存）
  function loadMapping() {
    return fetchMapFile();
  }

  function fetchMapFile() {
    return fetch(MAP_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
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
        return { list: parsed.list, names: parsed.names, meta: parsed.meta };
      });
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
    _state.mapping = map.list;
    _state.mapStats = { groups: map.list.length, names: map.names };
    addLog(tc("映射库 " + map.list.length + " 组 / " + map.names + " 个源名（tag_merge_map.json）",
      map.list.length + " mapping groups / " + map.names + " source names (tag_merge_map.json)"));
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
      "将 " + sources.length + " 个源 tag 合并到「" + g.target + "」？\n\n合并后：源 tag 删除，其场景/标记/图库/图片引用转移到目标，源名补写进目标别名（仍可搜索）。"
        + (g.destId ? "" : "\n目标 tag 不存在，将自动新建。"),
      "Merge " + sources.length + " source tag(s) into \"" + g.target + "\"?\n\nAfter merge: sources are deleted, their scene/marker/gallery/image references move to the target, source names are kept as aliases (still searchable)."
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
      "确认批量合并 " + pending.length + " 组？将删除 " + reduce + " 个源 tag，引用转移到各自目标，源名保留为别名。"
        + (createCount ? "其中 " + createCount + " 组的目标 tag 不存在，将自动新建。" : ""),
      "Merge " + pending.length + " groups? " + reduce + " source tags will be deleted, references moved to targets, source names kept as aliases."
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

    var headerRight = el("div", "tgm-card-actions");
    // 目标 tag 的引用计数徽章（合并按钮前）；已合并后不显示（合并后计数已变，避免误导）
    if (!isMerged) appendCountBadges(headerRight, g.destCounts);
    if (isMerged) {
      headerRight.appendChild(el("span", "tgm-badge tgm-badge-done", tc("已合并", "Merged")));
    } else if (isGroupIgnored) {
      headerRight.appendChild(el("span", "tgm-badge tgm-badge-state", tc("已忽略", "Ignored")));
      headerRight.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("恢复", "Undo"), {
        onclick: function () { delete _state.ignoredGroups[g.key]; render(); },
        disabled: _state.merging || _state.scanning,
        title: tc("恢复该组的合并资格（仅本次会话）", "Restore this group for merging (current session only)"),
      }));
    } else if (isEmptied || eff.length === 0) {
      headerRight.appendChild(el("span", "tgm-badge tgm-badge-state", tc("无有效源", "No Sources"), {
        title: tc("源已被忽略或被先前的合并消耗", "Sources ignored or consumed by earlier merges"),
      }));
    } else {
      if (isFailed) headerRight.appendChild(el("span", "tgm-badge tgm-badge-fail", tc("失败", "Failed")));
      headerRight.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("合并", "Merge"), {
        onclick: function () { handleMergeGroup(g); },
        disabled: _state.merging || _state.scanning,
        title: tc("将该组源 tag 合并进目标", "Merge this group's source tags into the target"),
      }));
      headerRight.appendChild(el("button", "tgm-btn tgm-btn-sm tgm-btn-muted", tc("忽略", "Ignore"), {
        onclick: function () { _state.ignoredGroups[g.key] = true; render(); },
        disabled: _state.merging || _state.scanning,
        title: tc("折叠该组并从「合并全部」中排除（仅本次会话，重新扫描重置）", "Collapse this group and exclude it from Merge All (current session only; rescan resets)"),
      }));
    }

    // 源计数：已合并=实际并入数（被消耗的源），已忽略=总数，其余=有效源数
    var srcCount = isMerged
      ? g.sources.filter(function (s) { return _consumed[s.id]; }).length
      : (isGroupIgnored ? g.sources.length : eff.length);

    var card = el("div", "tgm-group" + (isMerged || isGroupIgnored || isEmptied || eff.length === 0 ? " tgm-group-done" : ""));
    card.appendChild(el("div", "tgm-group-header", [
      el("div", "tgm-shared-name", [
        el("span", "tgm-target-name", g.target),
        !g.destId ? el("span", "tgm-badge tgm-badge-new", tc("新建", "New"), {
          title: tc("目标 tag 不存在，合并时自动新建", "Target tag does not exist; it will be created on merge"),
        }) : null,
        el("span", "tgm-member-count", tc(" · " + srcCount + " 个源", " · " + srcCount + " sources")),
      ]),
      headerRight,
    ]));

    // 合并完成/忽略后折叠：仅显示组头（目标名 · 源计数 + 状态徽章）
    if (isMerged || isGroupIgnored) return card;

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
          title: tc("未列入映射，按目标名的归一化变体匹配", "Not listed in the mapping; matched as a normalized variant of the target name"),
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
        title: tc("本次会话内不合并该源（不写入任何数据，重新扫描后重置）", "Skip this source for the current session only (nothing is persisted; rescan resets it)"),
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
      });
      if (dupInGroup.length) {
        errors.push({ msg: tc("组内源重复: " + dupInGroup.join("、"), "Duplicated within group: " + dupInGroup.join(", ")), hard: false });
      }
      var otherKeys = Object.keys(dupOther);
      if (otherKeys.length) {
        errors.push({ msg: tc("源与其他条目重复: " + otherKeys.map(function (k) { return k + "↔" + dupOther[k]; }).join("、"),
          "Sources duplicated elsewhere: " + otherKeys.join(", ")), hard: false });
      }
      if (normalize(target) && sources.some(function (s) { return normalize(s) === normalize(target); })) {
        errors.push({ msg: tc("源名与目标名重复（防链式规则会跳过它）", "A source equals the target (chain prevention will skip it)"), hard: false });
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

    // 黄框提示：数据文件在服务器端，需导出后手动替换
    wrap.appendChild(el("div", "tgm-warn",
      tc("编辑后点击「导出文件」下载 tag_merge_map.json，手动替换插件目录中的同名文件，替换后重新扫描生效",
        "After editing, click Export File to download tag_merge_map.json, manually replace the file in the plugin folder, then rescan")));

    // 工具栏：左搜索框，右（添加 + 导出文件）
    var searchInput = el("input", "tgm-search-input", null, {
      type: "text",
      value: ed.search,
      placeholder: tc("搜索目标名或源名", "Search target or source names"),
      oninput: function (e) {
        ed.search = e.target.value;
        renderEditorList();
      },
    });
    wrap.appendChild(el("div", "tgm-editor-toolbar", [
      searchInput,
      el("div", "tgm-editor-toolbar-actions", [
        el("button", "tgm-btn tgm-btn-muted", tc("添加", "Add"), {
          onclick: handleEditorAdd,
          disabled: ed.saving,
        }),
        el("button", "tgm-btn tgm-btn-primary", ed.saving ? tc("导出中...", "Exporting...") : tc("导出文件", "Export File"), {
          onclick: handleEditorExport,
          disabled: ed.saving,
          title: tc("下载完整映射表 JSON — 手动替换插件目录中的 tag_merge_map.json",
            "Download the full mapping JSON — manually replace tag_merge_map.json in the plugin folder"),
        }),
      ]),
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

    var q = ed.search.trim().toLowerCase();
    var filtered = q
      ? ed.items.filter(function (it) {
          if (it.target.toLowerCase().indexOf(q) >= 0) return true;
          return it.sources.some(function (s) { return s.toLowerCase().indexOf(q) >= 0; });
        })
      : ed.items;

    if (!filtered.length) {
      listEl.appendChild(el("div", "tgm-empty", tc("无匹配结果", "No matches")));
      return;
    }

    listEl.appendChild(buildChunkedList(filtered, buildEditorItem));
  }

  function buildEditorItem(item) {
    return item.editing ? buildEditorItemEdit(item) : buildEditorItemView(item);
  }

  // 列表态：目标名 + 源徽章 + 重复提示 + 编辑/删除
  function buildEditorItemView(item) {
    var ed = _state.editor;
    var idx = getDupIndex();

    var card = el("div", "tgm-edit-item");

    var actions = el("div", "tgm-card-actions", [
      el("button", "tgm-btn tgm-btn-sm tgm-btn-primary", tc("编辑", "Edit"), {
        onclick: function () {
          item.editing = true;
          item.draftTarget = item.target;
          item.draftSources = item.sources.join("\n");
          render();
        },
        disabled: ed.saving,
      }),
      el("button", "tgm-btn tgm-btn-sm tgm-btn-danger", tc("删除", "Delete"), {
        onclick: function () { handleEditorRemove(item); },
        disabled: ed.saving,
      }),
    ]);

    card.appendChild(el("div", "tgm-edit-item-head", [
      el("span", "tgm-edit-item-target", item.target, { title: item.target }),
      el("span", "tgm-badge tgm-badge-count", tc(item.sources.length + " 源", item.sources.length + " sources")),
      actions,
    ]));

    var srcWrap = el("div", "tgm-edit-item-sources");
    item.sources.forEach(function (s) {
      srcWrap.appendChild(el("span", "tgm-edit-src", s, { title: s }));
    });
    card.appendChild(srcWrap);

    // 重复提示（红字）：目标重复 / 源重复
    var dups = [];
    var tn = normalize(item.target);
    if (tn && idx.targets[tn].length > 1) {
      var others = idx.targets[tn].filter(function (it) { return it !== item; })
        .map(function (it) { return it.target; });
      dups.push(tc("目标与「" + others.join("」「") + "」重复", "Target duplicates \"" + others.join("\", \"") + "\""));
    }
    var dupSrcs = [];
    item.sources.forEach(function (s) {
      var sn = normalize(s);
      if (sn && idx.sources[sn].length > 1) dupSrcs.push(s);
    });
    if (dupSrcs.length) {
      dups.push(tc("源重复: " + dupSrcs.join("、"), "Duplicated sources: " + dupSrcs.join(", ")));
    }
    if (dups.length) {
      card.appendChild(el("div", "tgm-edit-item-dup", dups.join(" · ")));
    }

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

  function handleEditorAdd() {
    var ed = _state.editor;
    ed.search = "";
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
      if (byKey[t]) {
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i][0] === t) { pairs[i][1] = it.sources.slice(); break; }
        }
      } else {
        byKey[t] = true;
        pairs.push([t, it.sources.slice()]);
      }
    });
    if (!count && ed.items.length) {
      if (!confirm(tc("所有映射都为空 — 导出空表后扫描将匹配不到任何分组，继续？",
          "All entries are empty — exporting an empty table means scans match nothing. Continue?"))) return;
    }

    // 保序拼装：JSON.stringify 会把纯数字键（如 "69"）强制排到对象最前，破坏文件键序
    var blob = new Blob([pairs.length ? "{\n" + pairs.map(function (p) {
      return "  " + JSON.stringify(p[0]) + ": " + JSON.stringify(p[1], null, 2).split("\n").join("\n  ");
    }).join(",\n") + "\n}" : "{}"], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "tag_merge_map.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    ed.dirty = false;
    ed.saveMsg = { ok: true, text: tc("已导出 " + count + " 组映射 — 请替换插件目录中的 tag_merge_map.json",
      "Exported " + count + " mappings — replace tag_merge_map.json in the plugin folder") };
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
