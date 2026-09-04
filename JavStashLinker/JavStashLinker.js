/**
 * JavStashLinker
 *
 * Matching priority:
 *   1. Single performer scene auto-associate (high)
 *   2. Name/alias cross match (medium)
 *   3. Manual selection (unmatched)
 */

(function () {
  "use strict";

  if (window.__jsmLoaded) return;
  window.__jsmLoaded = true;

  var STASHDB_ENDPOINT = "https://stashdb.org/graphql";
  var JAVSTASH_ENDPOINT = "https://javstash.org/graphql";

  var _stashBoxConfig = null;

  function getStashBoxConfig() {
    if (_stashBoxConfig) return Promise.resolve(_stashBoxConfig);
    return callGQL(
      "query { configuration { general { stashBoxes { name endpoint api_key } } } }"
    ).then(function (data) {
      var boxes = (data.configuration &&
        data.configuration.general &&
        data.configuration.general.stashBoxes) || [];
      var jsBox = null;
      var stashdbBox = null;
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        if (b.endpoint && b.endpoint.indexOf("javstash.org") !== -1) jsBox = b;
        if (b.endpoint && b.endpoint.indexOf("stashdb.org") !== -1) stashdbBox = b;
      }
      _stashBoxConfig = {
        javstashEndpoint: jsBox ? jsBox.endpoint : JAVSTASH_ENDPOINT,
        javstashApiKey: jsBox ? jsBox.api_key : "",
        stashdbEndpoint: stashdbBox ? stashdbBox.endpoint : STASHDB_ENDPOINT,
      };
      return _stashBoxConfig;
    });
  }

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
      console.warn("[JSM] i18n bridge failed:", e);
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

  function callJavstashGQL(endpoint, apiKey, query, variables) {
    var payload = { query: query };
    if (variables) payload.variables = variables;
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers["ApiKey"] = apiKey;
    return fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.errors) throw new Error(JSON.stringify(data.errors));
        return data.data;
      });
  }

  // ==================== Data Queries ====================

  function getScenesWithJavstashId() {
    var PAGE_SIZE = 1000;
    var allScenes = [];
    var page = 1;

    function fetchPage() {
      return callGQL(
        "query($filter: FindFilterType!) { findScenes(filter: $filter) { count scenes { id title code performers { id name alias_list stash_ids { endpoint stash_id } } stash_ids { endpoint stash_id } } } }",
        { filter: { per_page: PAGE_SIZE, page: page, sort: "path" } }
      ).then(function (data) {
        var result = data.findScenes;
        var scenes = result.scenes;
        var totalCount = result.count;

        scenes.forEach(function (s) {
          var hasJavstash = (s.stash_ids || []).some(function (sid) {
            return sid.endpoint === JAVSTASH_ENDPOINT;
          });
          if (!hasJavstash) return;
          var performers = s.performers || [];
          if (performers.length === 0) return;
          var allHaveJavstash = performers.every(function (p) {
            return (p.stash_ids || []).some(function (sid) { return sid.endpoint === JAVSTASH_ENDPOINT; });
          });
          if (!allHaveJavstash) allScenes.push(s);
        });

        if (page * PAGE_SIZE < totalCount) {
          page++;
          return fetchPage();
        }
        return allScenes;
      });
    }

    return fetchPage();
  }

  function getJavstashScene(endpoint, apiKey, sceneId) {
    return callJavstashGQL(endpoint, apiKey,
      "query($id: ID!) { findScene(id: $id) { id title code performers { as performer { id name disambiguation aliases urls { url } } } } }",
      { id: sceneId }
    ).then(function (data) { return data.findScene; });
  }

  function getPerformer(id) {
    return callGQL(
      "query($id: ID!) { findPerformer(id: $id) { id name alias_list urls stash_ids { endpoint stash_id } } }",
      { id: id }
    ).then(function (data) { return data.findPerformer; });
  }

  function updatePerformer(id, stashIds, aliasArray, urls) {
    var input = { id: id, stash_ids: stashIds, alias_list: aliasArray };
    if (urls) input.urls = urls;
    return callGQL(
      "mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }",
      { input: input }
    );
  }

  function parseAliasList(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val.map(function (s) { return String(s).trim(); }).filter(function (s) { return s; });
    return String(val).split(/[\n,]/).map(function (s) { return s.trim(); }).filter(function (s) { return s; });
  }

  function buildAliasList(arr) {
    return (arr || []).join("\n");
  }

  // ==================== Matching Engine ====================

  function normalizeName(name) {
    if (!name) return "";
    var s = name.normalize("NFC").toLowerCase().trim();
    s = s.replace(/\s+/g, "");
    s = s.replace(/[（(].*?[)）]/g, ""); // remove parenthetical disambiguators
    return s;
  }

  function normalizeCode(code) {
    if (!code) return "";
    return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // Extract code from local scene: prefer code field, fallback to title prefix
  function getLocalSceneCode(localScene) {
    // 1. Direct code field (studio code = 番号)
    if (localScene.code) return normalizeCode(localScene.code);
    // 2. Title prefix: "番号 标题..." — extract leading alphanumeric token
    var title = localScene.title || "";
    var m = title.match(/^([A-Za-z]+[\-_\s]?\d+)/);
    if (m) return normalizeCode(m[1]);
    return "";
  }

  function matchScene(localScene, javstashScene) {
    var localPerformers = localScene.performers || [];
    var jsPerformers = (javstashScene.performers || [])
      .map(function (ap) { return ap.performer; })
      .filter(function (p) { return p; });

    var matches = [];
    var matchedLocal = {};
    var matchedJs = {};

    // Check if scene is confirmed by code (local code/title-prefix = javstash code)
    var localCode = getLocalSceneCode(localScene);
    var jsCode = normalizeCode(javstashScene.code || "");
    var sceneConfirmed = localCode && jsCode && localCode === jsCode;

    // Skip local performers that already have JAVStash stash_id
    // and mark the corresponding JAVStash performers as matched too
    localPerformers.forEach(function (lp) {
      (lp.stash_ids || []).forEach(function (sid) {
        if (sid.endpoint === JAVSTASH_ENDPOINT) {
          matchedLocal[lp.id] = true;
          jsPerformers.forEach(function (jp) {
            if (jp.id === sid.stash_id) {
              matchedJs[jp.id] = true;
            }
          });
        }
      });
    });

    // 1. Single performer auto-associate
    var unmatchedJs = jsPerformers.filter(function (p) { return !matchedJs[p.id]; });
    var unmatchedLocal = localPerformers.filter(function (p) { return !matchedLocal[p.id]; });

    if (unmatchedJs.length === 1 && unmatchedLocal.length === 1) {
      matches.push({
        javstashPerformer: unmatchedJs[0], localPerformer: unmatchedLocal[0],
        confidence: "high", method: sceneConfirmed ? "code_single" : "single_performer",
      });
      matchedLocal[unmatchedLocal[0].id] = true;
      matchedJs[unmatchedJs[0].id] = true;
    }

    // 2. Name/alias cross match (high confidence if scene confirmed by code)
    jsPerformers.forEach(function (jsPerf) {
      if (matchedJs[jsPerf.id]) return;
      var jsNames = {};
      jsNames[normalizeName(jsPerf.name)] = true;
      (jsPerf.aliases || []).forEach(function (a) { jsNames[normalizeName(a)] = true; });
      delete jsNames[""];

      localPerformers.forEach(function (lp) {
        if (matchedLocal[lp.id] || matchedJs[jsPerf.id]) return;
        var localNames = {};
        localNames[normalizeName(lp.name)] = true;
        parseAliasList(lp.alias_list).forEach(function (a) { localNames[normalizeName(a)] = true; });
        delete localNames[""];

        var hit = false;
        for (var n in jsNames) { if (localNames[n]) { hit = true; break; } }
        if (hit) {
          matches.push({
            javstashPerformer: jsPerf, localPerformer: lp,
            confidence: sceneConfirmed ? "high" : "medium",
            method: "name_alias",
          });
          matchedLocal[lp.id] = true;
          matchedJs[jsPerf.id] = true;
        }
      });
    });

    // 4. Unmatched
    var finalUnmatchedJs = jsPerformers.filter(function (p) { return !matchedJs[p.id]; });
    var finalUnmatchedLocal = localPerformers.filter(function (p) { return !matchedLocal[p.id]; });

    return {
      sceneId: localScene.id,
      sceneTitle: localScene.title || "",
      matches: matches,
      unmatchedJavstash: finalUnmatchedJs,
      unmatchedLocal: finalUnmatchedLocal,
    };
  }

  // ==================== Apply ====================

  var _appliedPerformers = {}; // track local performer IDs already applied

  function applyMatch(localPerformerId, jsPerf) {
    // Skip if already applied this performer in this session
    if (_appliedPerformers[localPerformerId]) {
      return Promise.resolve();
    }

    return getPerformer(localPerformerId).then(function (perf) {
      if (!perf) throw new Error("Performer not found: " + localPerformerId);

      var existingStashIds = perf.stash_ids || [];
      var newStashIds = existingStashIds.slice();
      if (!newStashIds.some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; })) {
        newStashIds.push({ endpoint: JAVSTASH_ENDPOINT, stash_id: jsPerf.id });
      }

      var existingAliases = parseAliasList(perf.alias_list);
      if (jsPerf.name && existingAliases.indexOf(jsPerf.name) === -1) {
        existingAliases.push(jsPerf.name);
      }
      (jsPerf.aliases || []).forEach(function (a) {
        if (a && existingAliases.indexOf(a) === -1) existingAliases.push(a);
      });

      // Merge URLs (dedup) — jsPerf.urls is [{url: "..."}], local perf.urls is ["..."]
      var existingUrls = perf.urls || [];
      var newUrls = existingUrls.slice();
      (jsPerf.urls || []).forEach(function (u) {
        var urlStr = typeof u === "string" ? u : (u && u.url) || "";
        if (urlStr && newUrls.indexOf(urlStr) === -1) newUrls.push(urlStr);
      });
      var urlsChanged = newUrls.length !== existingUrls.length;

      _appliedPerformers[localPerformerId] = true;

      return updatePerformer(localPerformerId, newStashIds, existingAliases, urlsChanged ? newUrls : null);
    });
  }

  // ==================== State ====================

  var _state = {
    javstashEndpoint: JAVSTASH_ENDPOINT,
    javstashApiKey: "",
    stashdbEndpoint: STASHDB_ENDPOINT,
    configLoaded: false,
    scanning: false,
    abortFlag: false,
    scanProgress: null,
    results: null,
    activeTab: "auto",
    applying: false,
    log: [],
    manualSelected: {},
    dismissed: {},
    applied: {},
    appliedCount: 0,
    applyDone: false,
  };

  function setState(updates) {
    for (var k in updates) _state[k] = updates[k];
    render();
  }

  // ==================== Scan ====================

  async function handleScan() {
    var config = await getStashBoxConfig();
    if (!config.javstashApiKey) {
      alert(tc("未找到 JAVStash 配置，请在 设置 → 元数据提供者 中添加 JAVStash stash-box 实例",
               "JAVStash not configured. Add it in Settings → Metadata Providers first."));
      return;
    }
    setState({ scanning: true, abortFlag: false, results: null, log: [], dismissed: {}, manualSelected: {}, applied: {}, applyDone: false });
    _appliedPerformers = {};
    addLog(tc("正在获取含 JAVStash ID 的场景（跳过已全部匹配的）...", "Fetching scenes with JAVStash IDs (skipping fully matched)..."));

    try {
      var scenes = await getScenesWithJavstashId();
      addLog(tc("找到 " + scenes.length + " 个场景", "Found " + scenes.length + " scenes"));

      var results = [];
      for (var i = 0; i < scenes.length; i++) {
        if (_state.abortFlag) {
          addLog(tc("用户中止扫描", "Scan aborted by user"));
          break;
        }

        var scene = scenes[i];
        setState({ scanProgress: { current: i + 1, total: scenes.length, title: scene.title || scene.id } });

        var javstashId = null;
        for (var j = 0; j < (scene.stash_ids || []).length; j++) {
          if (scene.stash_ids[j].endpoint === JAVSTASH_ENDPOINT) {
            javstashId = scene.stash_ids[j].stash_id;
            break;
          }
        }
        if (!javstashId) continue;

        try {
          var jsScene = await getJavstashScene(config.javstashEndpoint, config.javstashApiKey, javstashId);
          if (!jsScene) {
            addLog("[" + (i + 1) + "/" + scenes.length + "] " + tc("未找到", "Not found") + ": " + (scene.title || scene.id));
            continue;
          }
          var result = matchScene(scene, jsScene);
          results.push(result);
          var high = result.matches.filter(function (m) { return m.confidence === "high"; }).length;
          var med = result.matches.filter(function (m) { return m.confidence === "medium"; }).length;
          var unc = result.unmatchedJavstash.length;
          if (high + med + unc > 0) {
            addLog("[" + (i + 1) + "/" + scenes.length + "] " + (scene.title || scene.id) +
              " — " + tc("高", "High") + ":" + high + " " + tc("中", "Med") + ":" + med + " " + tc("未匹配", "Unmatched") + ":" + unc);
          }
        } catch (e) {
          addLog("[" + (i + 1) + "/" + scenes.length + "] " + tc("错误", "Error") + ": " + e.message);
        }

        await new Promise(function (r) { setTimeout(r, 100); });
      }

      setState({ scanProgress: null, results: results, scanning: false });
      addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
    } catch (e) {
      addLog(tc("扫描错误", "Scan error") + ": " + e.message);
      setState({ scanning: false, scanProgress: null });
    }
  }

  function handleApply() {
    var toApply = [];

    // Collect high-confidence matches only (not dismissed)
    getAllMatches().forEach(function (m) {
      if (!m.dismissed && m.confidence === "high") {
        toApply.push({ localPerformerId: m.localPerformer.id, jsPerf: m.javstashPerformer, key: m.key });
      }
    });

    // Collect manual matches
    getAllUnmatched().forEach(function (u) {
      var localId = _state.manualSelected[u.key];
      if (localId) {
        toApply.push({ localPerformerId: localId, jsPerf: u.javstashPerformer, key: u.key });
      }
    });

    if (toApply.length === 0) {
      alert(tc("没有可应用的匹配", "No matches to apply"));
      return;
    }

    if (!confirm(tc("确认应用 " + toApply.length + " 个匹配？将更新演员 stash_id 和别名。",
                    "Apply " + toApply.length + " matches? This will update performer stash_ids and aliases."))) return;

    setState({ applying: true, log: [], applyDone: false });

    var i = 0;
    var applied = 0;
    var errors = 0;

    function applyNext() {
      if (i >= toApply.length) {
        addLog(tc("=== 应用完成: ", "=== Apply complete: ") + applied + tc(" 成功, ", " applied, ") + errors + tc(" 错误", " errors") + " ===");
        setState({ applying: false, applyDone: true, appliedCount: applied });
        return;
      }

      var m = toApply[i];
      addLog("[" + (i + 1) + "/" + toApply.length + "] " + m.jsPerf.name + "...");

      applyMatch(m.localPerformerId, m.jsPerf).then(function () {
        applied++;
        addLog("  OK");
        var a = Object.assign({}, _state.applied);
        a[m.key] = true;
        setState({ applied: a });
      }).catch(function (e) {
        errors++;
        addLog("  " + tc("错误", "ERROR") + ": " + (e.message || e));
      }).then(function () {
        i++;
        setTimeout(applyNext, 50);
      });
    }

    applyNext();
  }

  // ==================== Derived Data ====================

  function getAllMatches() {
    if (!_state.results) return [];
    var all = [];
    _state.results.forEach(function (r) {
      r.matches.forEach(function (m) {
        var key = r.sceneId + "|" + m.javstashPerformer.id;
        all.push({
          key: key,
          sceneId: r.sceneId,
          sceneTitle: r.sceneTitle,
          javstashPerformer: m.javstashPerformer,
          localPerformer: m.localPerformer,
          confidence: m.confidence,
          method: m.method,
          dismissed: !!_state.dismissed[key],
        });
      });
    });
    return all;
  }

  function getAllUnmatched() {
    if (!_state.results) return [];
    var all = [];
    _state.results.forEach(function (r) {
      r.unmatchedJavstash.forEach(function (jp) {
        all.push({
          key: r.sceneId + "|" + jp.id,
          sceneId: r.sceneId,
          sceneTitle: r.sceneTitle,
          javstashPerformer: jp,
          unmatchedLocal: r.unmatchedLocal,
        });
      });
    });
    return all;
  }

  function addLog(msg) {
    _state.log.push(msg);
    render();
  }

  // ==================== Render ====================

  function render() {
    var root = document.getElementById("jsm-panel-root");
    if (!root) return;
    root.innerHTML = "";
    root.appendChild(buildPanel());
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

  function buildPanel() {
    var frag = document.createDocumentFragment();

    // Header
    var closeBtn = document.createElement("button");
    closeBtn.className = "jsm-close-btn";
    closeBtn.type = "button";
    closeBtn.setAttribute("data-jsm-action", "close");
    closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

    frag.appendChild(el("div", "jsm-header", [
      el("h2", "jsm-title", "JavStashLinker"),
      el("div", "jsm-header-actions", [
        el("button", "jsm-btn jsm-btn-primary" + (_state.applying ? " jsm-btn-disabled" : ""), tc("应用全部", "Apply All"), {
          onclick: handleApply,
          disabled: _state.applying || (!getAllMatches().some(function (m) { return !m.dismissed && m.confidence === "high"; }) && !Object.keys(_state.manualSelected).length),
          title: tc("只会应用 high 置信度", "Only high-confidence matches will be applied"),
        }),
        closeBtn,
      ]),
    ]));

    // Config status
    var configStatus = _state.configLoaded
      ? (_state.javstashApiKey
        ? tc("JAVStash: 已连接 (", "JAVStash: Connected (") + _state.javstashEndpoint + ")"
        : tc("JAVStash: 未配置，请在 设置 → 元数据提供者 中添加", "JAVStash: Not configured. Add it in Settings → Metadata Providers."))
      : tc("正在加载配置...", "Loading config...");
    frag.appendChild(el("div", "jsm-config", [
      el("div", "jsm-config-status", configStatus),
      el("div", "jsm-actions", [
        _state.scanning
          ? el("button", "jsm-btn jsm-btn-danger", tc("中止扫描", "Abort Scan"), { onclick: function () { _state.abortFlag = true; } })
          : el("button", "jsm-btn jsm-btn-primary", tc("开始扫描", "Start Scan"), {
              onclick: handleScan,
              disabled: !!_state.scanning || !_state.javstashApiKey,
            }),
      ]),
    ]));

    // Progress
    if (_state.scanProgress) {
      var pct = Math.round((_state.scanProgress.current / _state.scanProgress.total) * 100);
      frag.appendChild(el("div", "jsm-progress", [
        el("div", "jsm-progress-bar", _state.scanProgress.current + " / " + _state.scanProgress.total, {
          style: "width:" + pct + "%",
        }),
        el("div", "jsm-progress-title", _state.scanProgress.title),
      ]));
    }

    // Apply success banner
    if (_state.applyDone && !_state.applying) {
      var banner = el("div", "jsm-success-banner",
        tc("应用完成！成功 " + _state.appliedCount + " 个匹配", "Apply complete! " + _state.appliedCount + " matches applied successfully"));
      frag.appendChild(banner);
    }

    // Stats
    if (_state.results) {
      var autoMatches = getAllMatches().filter(function (m) { return m.confidence === "high" && !m.dismissed; });
      var reviewMatches = getAllMatches().filter(function (m) { return m.confidence === "medium"; });
      var unmatched = getAllUnmatched();
      var manualCount = Object.keys(_state.manualSelected).length;

      frag.appendChild(el("div", "jsm-stats", [
        buildStat(autoMatches.length, tc("自动匹配", "Auto Matched"), "#37b24d"),
        buildStat(reviewMatches.length, tc("待审核", "Needs Review"), "#f59f00"),
        buildStat(unmatched.length, tc("未匹配", "Unmatched"), "#f03e3e"),
        buildStat(manualCount, tc("手动选择", "Manual Selected"), "#339af0"),
      ]));

      // Tabs
      var tabs = [
        { id: "auto", label: tc("自动匹配", "Auto Matched") + " (" + autoMatches.length + ")" },
        { id: "review", label: tc("待审核", "Needs Review") + " (" + reviewMatches.length + ")" },
        { id: "unmatched", label: tc("未匹配", "Unmatched") + " (" + unmatched.length + ")" },
        { id: "log", label: tc("日志", "Log") },
      ];
      var tabContainer = el("div", "jsm-tabs");
      tabs.forEach(function (t) {
        var tab = el("div", "jsm-tab" + (_state.activeTab === t.id ? " jsm-tab-active" : ""), t.label, {
          onclick: function () { setState({ activeTab: t.id }); },
        });
        tabContainer.appendChild(tab);
      });
      frag.appendChild(tabContainer);

      // Tab content
      var content = el("div", "jsm-content");
      if (_state.activeTab === "auto") {
        if (autoMatches.length === 0) {
          content.appendChild(el("div", "jsm-empty", tc("没有自动匹配", "No auto matches")));
        } else {
          autoMatches.forEach(function (m) { content.appendChild(buildMatchCard(m)); });
        }
      } else if (_state.activeTab === "review") {
        if (reviewMatches.length === 0) {
          content.appendChild(el("div", "jsm-empty", tc("没有待审核匹配", "No review matches")));
        } else {
          reviewMatches.forEach(function (m) { content.appendChild(buildMatchCard(m)); });
        }
      } else if (_state.activeTab === "unmatched") {
        if (unmatched.length === 0) {
          content.appendChild(el("div", "jsm-empty", tc("没有未匹配演员", "No unmatched performers")));
        } else {
          unmatched.forEach(function (u) { content.appendChild(buildUnmatchedCard(u)); });
        }
      } else if (_state.activeTab === "log") {
        if (_state.log.length === 0) {
          content.appendChild(el("div", "jsm-empty", tc("暂无日志", "No logs yet")));
        } else {
          var logBox = el("div", "jsm-log");
          _state.log.forEach(function (line) {
            logBox.appendChild(el("div", null, line));
          });
          content.appendChild(logBox);
        }
      }
      frag.appendChild(content);
    }

    // Apply log (during applying)
    if (_state.applying) {
      var applyLog = el("div", "jsm-log");
      _state.log.forEach(function (line) {
        applyLog.appendChild(el("div", null, line));
      });
      frag.appendChild(applyLog);
    }

    return frag;
  }

  function buildStat(num, label, color) {
    return el("div", "jsm-stat", [
      el("div", "jsm-stat-num", String(num), { style: "color:" + color }),
      el("div", "jsm-stat-label", label),
    ]);
  }

  function buildMatchCard(m) {
    var confidenceClass = m.confidence === "high" ? "jsm-badge-high" : "jsm-badge-medium";
    var methodLabel = {
      single_performer: tc("单演员", "single performer"),
      code_single: tc("番号+单演员", "code+single"),
      name_alias: tc("名字/别名", "name/alias"),
    }[m.method] || m.method;

    var isApplied = _state.applied[m.key];
    var isDismissed = m.dismissed;

    var info = el("div", "jsm-card-info", [
      el("div", "jsm-scene-title", m.sceneTitle),
      el("div", "jsm-card-name", [
        document.createTextNode(m.javstashPerformer.name +
          (m.javstashPerformer.disambiguation ? " (" + m.javstashPerformer.disambiguation + ")" : "") +
          " → "),
        (function () {
          var span = document.createElement("span");
          span.style.color = "#37b24d";
          span.textContent = m.localPerformer.name;
          return span;
        })(),
      ]),
      el("div", "jsm-card-sub",
        "JAVStash: " + m.javstashPerformer.id +
        ((m.javstashPerformer.aliases || []).length > 0 ? " | " + tc("别名", "Aliases") + ": " + m.javstashPerformer.aliases.join(", ") : "") +
        ((m.javstashPerformer.urls || []).length > 0 ? " | " + tc("链接", "URLs") + ": " + m.javstashPerformer.urls.length : "")),
    ]);

    var badge = el("span", "jsm-badge " + confidenceClass, m.confidence);
    var methodBadge = el("span", "jsm-badge jsm-badge-method", methodLabel);

    var rightSide = el("div", "jsm-card-actions");

    if (isApplied) {
      rightSide.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
    } else if (isDismissed) {
      rightSide.appendChild(el("span", "jsm-badge jsm-badge-dismissed", tc("已忽略", "Dismissed")));
      var restoreBtn = el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("恢复", "Restore"), {
        onclick: function () {
          var d = Object.assign({}, _state.dismissed);
          delete d[m.key];
          setState({ dismissed: d });
        },
      });
      rightSide.appendChild(restoreBtn);
    } else {
      rightSide.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-success", tc("应用", "Apply"), {
        onclick: function () {
          applySingle(m.key, m.localPerformer.id, m.javstashPerformer);
        },
      }));
    }

    if (!isApplied) {
      var dismissBtn = el("button", "jsm-btn jsm-btn-sm jsm-btn-danger", tc("忽略", "Dismiss"), {
        onclick: function () {
          var d = Object.assign({}, _state.dismissed);
          d[m.key] = true;
          setState({ dismissed: d });
        },
      });
      rightSide.appendChild(dismissBtn);
    }

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : "") + (isDismissed ? " jsm-card-dismissed" : ""), [info, badge, methodBadge, rightSide]);
  }

  function applySingle(key, localPerformerId, jsPerf) {
    addLog(tc("应用: ", "Applying: ") + jsPerf.name + "...");
    applyMatch(localPerformerId, jsPerf).then(function () {
      addLog("  OK");
      var a = Object.assign({}, _state.applied);
      a[key] = true;
      setState({ applied: a, appliedCount: (_state.appliedCount || 0) + 1 });
    }).catch(function (e) {
      addLog("  " + tc("错误", "ERROR") + ": " + (e.message || e));
    });
  }

  function buildUnmatchedCard(u) {
    var jsPerf = u.javstashPerformer;
    var selected = _state.manualSelected[u.key] || "";
    var isApplied = _state.applied[u.key];

    var info = el("div", "jsm-card-info", [
      el("div", "jsm-scene-title", u.sceneTitle),
      el("div", "jsm-card-name", jsPerf.name + (jsPerf.disambiguation ? " (" + jsPerf.disambiguation + ")" : "")),
      el("div", "jsm-card-sub",
        "JAVStash ID: " + jsPerf.id +
        ((jsPerf.aliases || []).length > 0 ? " | " + tc("别名", "Aliases") + ": " + jsPerf.aliases.join(", ") : "")),
    ]);

    var badge = el("span", "jsm-badge jsm-badge-manual", tc("手动", "manual"));

    var right = el("div", "jsm-card-actions");

    if (isApplied) {
      right.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
    } else if (u.unmatchedLocal.length === 0) {
      right.appendChild(el("span", null, tc("本场景无未匹配本地演员", "No unmatched local performers"), { style: "color:#f03e3e;font-size:12px;" }));
    } else {
      var select = el("select", "jsm-select");
      var opt = document.createElement("option");
      opt.value = "";
      opt.textContent = tc("-- 选择本地演员 --", "-- Select local performer --");
      select.appendChild(opt);
      u.unmatchedLocal.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.id;
        var aliases = parseAliasList(p.alias_list);
        o.textContent = p.name + (aliases.length ? " (" + aliases.join(", ") + ")" : "");
        if (selected === p.id) o.selected = true;
        select.appendChild(o);
      });
      select.onchange = function (e) {
        var ms = Object.assign({}, _state.manualSelected);
        if (e.target.value) ms[u.key] = e.target.value;
        else delete ms[u.key];
        setState({ manualSelected: ms });
      };
      right.appendChild(select);

      if (selected) {
        right.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-success", tc("应用", "Apply"), {
          onclick: function () {
            applySingle(u.key, selected, jsPerf);
          },
        }));
      }
    }

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : ""), [info, badge, right]);
  }

  // ==================== Panel ====================

  function closePanel() {
    var container = document.getElementById("jsm-panel-container");
    if (container) container.remove();
  }

  function openPanel() {
    var existing = document.getElementById("jsm-panel-container");
    if (existing) {
      existing.style.display = "flex";
      render();
      return;
    }

    var container = document.createElement("div");
    container.id = "jsm-panel-container";
    container.className = "jsm-panel-container";

    container.addEventListener("click", function (e) {
      // Close button
      var target = e.target;
      while (target && target !== container) {
        if (target.getAttribute && target.getAttribute("data-jsm-action") === "close") {
          e.preventDefault();
          e.stopPropagation();
          closePanel();
          return;
        }
        target = target.parentElement;
      }
      // Click on background
      if (e.target === container) closePanel();
    });

    var panel = document.createElement("div");
    panel.id = "jsm-panel-root";
    panel.className = "jsm-panel-root";

    container.appendChild(panel);
    document.body.appendChild(container);

    render();
  }

  // ==================== Nav Button (DOM injection) ====================

  function setupNavButton() {
    injectNavButton();
    // Re-inject on navigation (SPA)
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

    // MutationObserver as fallback
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
    if (document.querySelector(".jsm-nav-btn")) return;

    // Try the right-side navbar buttons area first (same as RandomButton)
    var nav = document.querySelector(".navbar-buttons.flex-row.ml-auto.order-xl-2.navbar-nav")
           || document.querySelector(".navbar-buttons.navbar-nav")
           || document.querySelector(".navbar-nav.ml-auto");
    if (!nav) {
      // Fallback: left-side nav
      nav = document.querySelector(".navbar-nav") || document.querySelector("nav ul.nav");
    }
    if (!nav) return;

    var container = document.createElement("div");
    container.className = "mr-2 jsm-nav-btn";
    container.innerHTML =
      '<a href="javascript:void(0)">' +
      '<button type="button" class="btn btn-primary jsm-nav-btn-icon" title="JavStashLinker" style="display:inline-flex;align-items:center;justify-content:center;padding:5px 8px;">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
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

    getStashBoxConfig().then(function (config) {
      _state.javstashEndpoint = config.javstashEndpoint;
      _state.javstashApiKey = config.javstashApiKey;
      _state.stashdbEndpoint = config.stashdbEndpoint;
      _state.configLoaded = true;
      render();
    }).catch(function (e) {
      console.warn("[JSM] Failed to load stash-box config:", e);
      _state.configLoaded = true;
      render();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
