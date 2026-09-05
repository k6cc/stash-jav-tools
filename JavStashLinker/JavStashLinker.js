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

  // ==================== Rate Limiter (240/min = 4/s) ====================

  function createRateLimiter(maxConcurrent, minIntervalMs) {
    var queue = [];
    var active = 0;
    var lastDispatch = 0;

    function tryDispatch() {
      if (queue.length === 0 || active >= maxConcurrent) return;
      var now = Date.now();
      var wait = Math.max(0, lastDispatch + minIntervalMs - now);
      if (wait > 0) {
        setTimeout(tryDispatch, wait);
        return;
      }
      var task = queue.shift();
      active++;
      lastDispatch = Date.now();
      task.fn().then(function (r) {
        active--;
        task.resolve(r);
        tryDispatch();
      }).catch(function (e) {
        active--;
        task.reject(e);
        tryDispatch();
      });
    }

    return {
      submit: function (fn) {
        return new Promise(function (resolve, reject) {
          queue.push({ fn: fn, resolve: resolve, reject: reject });
          tryDispatch();
        });
      },
      pending: function () { return queue.length + active; },
    };
  }

  var _jsRateLimiter = createRateLimiter(4, 250);   // JAVStash: 4 concurrent, 250ms spacing
  var _localRateLimiter = createRateLimiter(5, 0);   // Local Stash: 5 concurrent, no spacing

  // ==================== Render Throttle ====================

  var _renderTimer = null;

  function requestRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(function () {
      _renderTimer = null;
      render();
    }, 200);
  }

  function updateProgressDOM(current, total, title) {
    var bar = document.querySelector(".jsm-progress-bar");
    var titleEl = document.querySelector(".jsm-progress-title");
    if (bar) {
      var pct = Math.round((current / total) * 100);
      bar.style.width = pct + "%";
      bar.textContent = current + " / " + total;
    }
    if (titleEl) titleEl.textContent = title;
  }

  function appendLogDOM(msg) {
    var logBox = document.querySelector(".jsm-log");
    if (logBox) {
      var line = el("div", null, msg);
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // ==================== Data Queries ====================

  function getScenesWithJavstashId() {
    var PAGE_SIZE = 1000;
    var allScenes = [];
    var page = 1;

    function fetchPage() {
      return callGQL(
        "query($filter: FindFilterType!) { findScenes(filter: $filter) { count scenes { id title code performers { id name alias_list urls stash_ids { endpoint stash_id } } stash_ids { endpoint stash_id } } } }",
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

  function searchJavstashPerformers(endpoint, apiKey, term) {
    return callJavstashGQL(endpoint, apiKey,
      "query($term: String!) { searchPerformer(term: $term) { id name disambiguation aliases deleted urls { url } birth_date career_start_year height } }",
      { term: term }
    ).then(function (data) { return data.searchPerformer || []; });
  }

  function fetchAllLocalPerformers() {
    var PAGE_SIZE = 1000;
    var all = [];
    var page = 1;
    function fetchPage() {
      return callGQL(
        "query($filter: FindFilterType!) { findPerformers(filter: $filter) { count performers { id name disambiguation alias_list birthdate urls height_cm stash_ids { endpoint stash_id } } } }",
        { filter: { per_page: PAGE_SIZE, page: page, sort: "name" } }
      ).then(function (data) {
        var result = data.findPerformers;
        all = all.concat(result.performers || []);
        if (page * PAGE_SIZE < result.count) {
          page++;
          return fetchPage();
        }
        return all;
      });
    }
    return fetchPage();
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

  // ==================== Manual Search Matching ====================

  // Build search terms from local performer: main name + aliases, dedup by
  // normalized form, main first, capped at 15 terms (rate-limit friendly)
  function buildSearchTerms(localPerf) {
    var seen = {};
    var terms = [];
    function add(raw, isMain) {
      var norm = normalizeName(raw);
      if (!norm || seen[norm]) return;
      seen[norm] = true;
      terms.push({ raw: String(raw).trim(), norm: norm, isMain: !!isMain });
    }
    add(localPerf.name, true);
    parseAliasList(localPerf.alias_list).forEach(function (a) { add(a, false); });
    if (terms.length > 15) terms = terms.slice(0, 15);
    return terms;
  }

  // Evaluate a JAVStash candidate against a local performer.
  // Confidence rules (agreed):
  //   stashdb UUID cross-ref equal           -> high (hard evidence)
  //   URL intersection >= 2                  -> high (1 may be a studio site)
  //   >=3 names exact-matched                -> high
  //   exactly 2 local names, both matched,
  //     at least one long (norm >=3 chars)   -> high (short-name collision guard)
  //   name match + full birthdate equal      -> high
  //   name match + birth year equal          -> medium
  //   2 of >=3 names matched                 -> medium
  //   deleted performer capped at medium
  function evaluateCandidate(localPerf, jsPerf, terms) {
    var jsNames = {};
    jsNames[normalizeName(jsPerf.name)] = true;
    (jsPerf.aliases || []).forEach(function (a) { jsNames[normalizeName(a)] = true; });
    delete jsNames[""];

    var votes = terms.filter(function (t) { return jsNames[t.norm]; });
    var hasLongVote = votes.some(function (v) { return v.norm.length >= 3; });

    var localStashdbId = null;
    (localPerf.stash_ids || []).forEach(function (sid) {
      if (sid.endpoint && sid.endpoint.indexOf("stashdb.org") !== -1) localStashdbId = sid.stash_id;
    });
    var jsStashdbIds = [];
    (jsPerf.urls || []).forEach(function (u) {
      var urlStr = typeof u === "string" ? u : (u && u.url) || "";
      var m = urlStr.match(/stashdb\.org\/performers\/([0-9a-fA-F-]{36})/);
      if (m) jsStashdbIds.push(m[1].toLowerCase());
    });
    var stashdbMatch = !!(localStashdbId && jsStashdbIds.indexOf(String(localStashdbId).toLowerCase()) !== -1);

    var localUrls = localPerf.urls || [];
    var jsUrls = [];
    (jsPerf.urls || []).forEach(function (u) {
      var urlStr = typeof u === "string" ? u : (u && u.url) || "";
      if (urlStr) jsUrls.push(urlStr);
    });
    var urlIntersect = jsUrls.filter(function (u) { return localUrls.indexOf(u) !== -1; }).length;

    var lb = localPerf.birthdate || "";
    var jb = jsPerf.birth_date || "";
    var bdayFull = !!(lb && jb && lb === jb);
    var bdayYear = !!(lb && jb && lb.slice(0, 4) === jb.slice(0, 4));

    var v = votes.length;
    var total = terms.length;
    var confidence = null;
    if (stashdbMatch) confidence = "high";
    else if (urlIntersect >= 2) confidence = "high";
    else if (v >= 3) confidence = "high";
    else if (total === 2 && v === 2 && hasLongVote) confidence = "high";
    else if (v >= 1 && bdayFull) confidence = "high";
    else if (v >= 1 && bdayYear) confidence = "medium";
    else if (v === 2) confidence = "medium";
    if (jsPerf.deleted && confidence === "high") confidence = "medium";

    return {
      confidence: confidence,
      votes: votes,
      voteCount: v,
      totalNames: total,
      stashdbMatch: stashdbMatch,
      urlIntersect: urlIntersect,
      bdayFull: bdayFull,
      bdayYear: bdayYear,
    };
  }

  // ==================== Apply ====================

  var _appliedPerformers = {}; // track local performer IDs already applied

  // Use cached performer data from scan (stash_ids, alias_list, urls)
  function applyMatchCached(localPerformer, jsPerf) {
    var localPerformerId = localPerformer.id;
    if (_appliedPerformers[localPerformerId]) {
      return Promise.resolve();
    }

    var existingStashIds = localPerformer.stash_ids || [];
    var newStashIds = existingStashIds.slice();
    if (!newStashIds.some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; })) {
      newStashIds.push({ endpoint: JAVSTASH_ENDPOINT, stash_id: jsPerf.id });
    }

    var existingAliases = parseAliasList(localPerformer.alias_list);
    if (jsPerf.name && existingAliases.indexOf(jsPerf.name) === -1) {
      existingAliases.push(jsPerf.name);
    }
    (jsPerf.aliases || []).forEach(function (a) {
      if (a && existingAliases.indexOf(a) === -1) existingAliases.push(a);
    });

    // Merge URLs (dedup)
    var existingUrls = localPerformer.urls || [];
    var newUrls = existingUrls.slice();
    (jsPerf.urls || []).forEach(function (u) {
      var urlStr = typeof u === "string" ? u : (u && u.url) || "";
      if (urlStr && newUrls.indexOf(urlStr) === -1) newUrls.push(urlStr);
    });
    var urlsChanged = newUrls.length !== existingUrls.length;

    _appliedPerformers[localPerformerId] = true;

    return _localRateLimiter.submit(function () {
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
    emptyReason: "",
    activeTab: "auto",
    applying: false,
    log: [],
    manualSelected: {},
    dismissed: {},
    applied: {},
    appliedCount: 0,
    applyDone: false,
    manualTab: {
      list: null,
      listLoading: false,
      listFilter: "",
      search: {},
      ignoredIds: {},
    },
  };

  function setState(updates, throttle) {
    for (var k in updates) _state[k] = updates[k];
    if (throttle) requestRender();
    else { if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; } render(); }
  }

  // ==================== Scan ====================

  async function handleScan() {
    var config = await getStashBoxConfig();
    if (!config.javstashApiKey) {
      alert(tc("未找到 JAVStash 配置，请在 设置 → 元数据提供者 中添加 JAVStash stash-box 实例",
               "JAVStash not configured. Add it in Settings → Metadata Providers first."));
      return;
    }
    setState({ scanning: true, abortFlag: false, results: null, emptyReason: "", log: [], dismissed: {}, manualSelected: {}, applied: {}, applyDone: false });
    _appliedPerformers = {};
    addLog(tc("正在获取含 JAVStash ID 的场景（跳过已全部匹配的）...", "Fetching scenes with JAVStash IDs (skipping fully matched)..."));

    try {
      var scenes = await getScenesWithJavstashId();
      addLog(tc("找到 " + scenes.length + " 个场景", "Found " + scenes.length + " scenes"));
      if (scenes.length === 0) {
        setState({
          scanning: false,
          results: [],
          emptyReason: tc("没有需要扫描的场景 — 含 JAVStash ID 的场景已全部匹配完成",
                          "Nothing to scan — all scenes with JAVStash IDs are already fully matched"),
        });
        return;
      }

      // Initial progress render
      setState({ scanProgress: { current: 0, total: scenes.length, title: "" } });

      var results = [];
      var processed = 0;
      var aborted = false;

      // Submit all scenes to rate limiter (4 concurrent, 250ms spacing)
      var promises = scenes.map(function (scene, idx) {
        var javstashId = null;
        for (var j = 0; j < (scene.stash_ids || []).length; j++) {
          if (scene.stash_ids[j].endpoint === JAVSTASH_ENDPOINT) {
            javstashId = scene.stash_ids[j].stash_id;
            break;
          }
        }
        if (!javstashId) return Promise.resolve(null);

        return _jsRateLimiter.submit(function () {
          if (_state.abortFlag || aborted) return Promise.resolve(null);
          return getJavstashScene(config.javstashEndpoint, config.javstashApiKey, javstashId);
        }).then(function (jsScene) {
          if (_state.abortFlag) { aborted = true; return null; }
          if (!jsScene) {
            addLogBatch("[" + (processed + 1) + "/" + scenes.length + "] " + tc("未找到", "Not found") + ": " + (scene.title || scene.id));
            return null;
          }
          var result = matchScene(scene, jsScene);
          results.push(result);
          var high = result.matches.filter(function (m) { return m.confidence === "high"; }).length;
          var med = result.matches.filter(function (m) { return m.confidence === "medium"; }).length;
          var unc = result.unmatchedJavstash.length;
          if (high + med + unc > 0) {
            addLogBatch("[" + (processed + 1) + "/" + scenes.length + "] " + (scene.title || scene.id) +
              " — " + tc("高", "High") + ":" + high + " " + tc("中", "Med") + ":" + med + " " + tc("未匹配", "Unmatched") + ":" + unc);
          }
          return result;
        }).catch(function (e) {
          addLogBatch("[" + (processed + 1) + "/" + scenes.length + "] " + tc("错误", "Error") + ": " + e.message);
          return null;
        }).then(function (r) {
          processed++;
          // Throttled DOM update (no full render)
          updateProgressDOM(processed, scenes.length, scene.title || scene.id);
          if (processed % 10 === 0) {
            // Flush batched logs to DOM every 10 scenes
            var start = _state.log.length - 10;
            if (start >= 0) {
              for (var k = start; k < _state.log.length; k++) appendLogDOM(_state.log[k]);
            }
          }
          return r;
        });
      });

      await Promise.all(promises);

      if (aborted || _state.abortFlag) {
        addLog(tc("用户中止扫描", "Scan aborted by user"));
      }

      // Flush remaining logs
      _state.log.forEach(function (line) { appendLogDOM(line); });

      setState({ scanProgress: null, results: results, scanning: false });
      addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
    } catch (e) {
      addLog(tc("扫描错误", "Scan error") + ": " + e.message);
      setState({
        scanning: false,
        scanProgress: null,
        results: [],
        emptyReason: tc("扫描未完成，详见下方日志", "Scan did not finish — see log below"),
      });
    }
  }

  function handleApply() {
    var rawItems = [];

    // Collect high-confidence matches only (not dismissed)
    getAllMatches().forEach(function (m) {
      if (!m.dismissed && m.confidence === "high") {
        rawItems.push({ localPerformer: m.localPerformer, jsPerf: m.javstashPerformer, key: m.key });
      }
    });

    // Collect manual matches
    getAllUnmatched().forEach(function (u) {
      var localId = _state.manualSelected[u.key];
      if (localId) {
        var lp = u.unmatchedLocal.find(function (p) { return p.id === localId; });
        if (lp) {
          rawItems.push({ localPerformer: lp, jsPerf: u.javstashPerformer, key: u.key });
        }
      }
    });

    if (rawItems.length === 0) {
      alert(tc("没有可应用的匹配", "No matches to apply"));
      return;
    }

    // Deduplicate by local performer ID (multiple scenes may match same performer)
    var seen = {};
    var toApply = [];
    var keyMap = {};  // localPerformerId -> array of match keys
    for (var i = 0; i < rawItems.length; i++) {
      var item = rawItems[i];
      var pid = item.localPerformer.id;
      if (!seen[pid]) {
        seen[pid] = true;
        toApply.push(item);
        keyMap[pid] = [item.key];
      } else {
        keyMap[pid].push(item.key);
      }
    }

    if (!confirm(tc("确认应用 " + toApply.length + " 个演员？将更新演员 stash_id 和别名。",
                    "Apply " + toApply.length + " performers? This will update performer stash_ids and aliases."))) return;

    // Set state WITHOUT triggering full render — just update progress DOM directly
    _state.applying = true;
    _state.log = [];
    _state.applyDone = false;
    _state.scanProgress = { current: 0, total: toApply.length, title: "" };
    renderApplyProgress();

    var applied = 0;
    var errors = 0;
    var done = 0;
    var total = toApply.length;
    var APPLY_BATCH = 50;  // submit in batches to avoid blocking main thread
    var batchIdx = 0;
    var _logFlushTimer = null;
    var _logPending = 0;  // number of lines not yet flushed to DOM

    function appendLogLine(msg) {
      _state.log.push(msg);
      _logPending++;
      // Batch DOM writes via rAF to avoid layout thrashing
      if (!_logFlushTimer) {
        _logFlushTimer = requestAnimationFrame(function () {
          _logFlushTimer = null;
          var logBox = document.querySelector(".jsm-log");
          if (!logBox || _logPending === 0) return;
          var frag = document.createDocumentFragment();
          var totalLines = _state.log.length;
          var startIdx = totalLines - _logPending;
          for (var i = startIdx; i < totalLines; i++) {
            frag.appendChild(el("div", null, _state.log[i]));
          }
          logBox.appendChild(frag);
          logBox.scrollTop = logBox.scrollHeight;
          _logPending = 0;
        });
      }
    }

    function processBatch() {
      var end = Math.min(batchIdx + APPLY_BATCH, toApply.length);
      for (var i = batchIdx; i < end; i++) {
        (function (m) {
          applyMatchCached(m.localPerformer, m.jsPerf).then(function () {
            applied++;
            // Mark all match keys for this performer as applied
            var keys = keyMap[m.localPerformer.id] || [m.key];
            var a = Object.assign({}, _state.applied);
            for (var k = 0; k < keys.length; k++) a[keys[k]] = true;
            _state.applied = a;
            appendLogLine("[" + (done + 1) + "/" + total + "] " + m.jsPerf.name + " " + tc("成功", "OK"));
          }).catch(function (e) {
            errors++;
            appendLogLine("[" + (done + 1) + "/" + total + "] " + m.jsPerf.name + " " + tc("失败", "FAIL") + ": " + (e.message || e));
          }).then(function () {
            done++;
            updateProgressDOM(done, total, m.jsPerf.name);
            if (done >= total) {
              finishApply();
            }
          });
        })(toApply[i]);
      }
      batchIdx = end;
      if (batchIdx < toApply.length) {
        setTimeout(processBatch, 0);  // yield to main thread
      }
    }

    function finishApply() {
      // Ensure all pending log lines are flushed
      if (_logFlushTimer) {
        cancelAnimationFrame(_logFlushTimer);
        _logFlushTimer = null;
      }
      var logBox = document.querySelector(".jsm-log");
      if (logBox && _logPending > 0) {
        var totalLines = _state.log.length;
        var startIdx = totalLines - _logPending;
        for (var j = startIdx; j < totalLines; j++) {
          logBox.appendChild(el("div", null, _state.log[j]));
        }
        logBox.scrollTop = logBox.scrollHeight;
        _logPending = 0;
      }
      appendLogLine(tc("=== 应用完成: ", "=== Apply complete: ") + applied + tc(" 成功, ", " OK, ") + errors + tc(" 失败", " failed") + " ===");
      // Final flush
      if (_logFlushTimer) { cancelAnimationFrame(_logFlushTimer); _logFlushTimer = null; }
      setState({ applying: false, applyDone: true, appliedCount: applied, scanProgress: null });
    }

    processBatch();
  }

  // Lightweight apply start: replace tab content with log view, NO full render (no card rebuild)
  function renderApplyProgress() {
    var content = document.querySelector(".jsm-content");
    if (content) {
      content.innerHTML = "";
      var logEl = el("div", "jsm-log");
      logEl.style.minHeight = "300px";
      content.appendChild(logEl);
    }
    // Reset progress bar (already exists in DOM from previous render)
    updateProgressDOM(0, _state.scanProgress.total, "");
  }

  // ==================== Manual Search ====================

  function setManualTab(changes) {
    setState({ manualTab: Object.assign({}, _state.manualTab, changes) });
  }

  function setSearchState(localId, changes) {
    var search = Object.assign({}, _state.manualTab.search);
    search[localId] = Object.assign({}, search[localId], changes);
    setManualTab({ search: search });
  }

  function updateManualStatusDOM(localId, text) {
    var node = document.querySelector('[data-jsm-mstatus="' + localId + '"]');
    if (node) node.textContent = text;
  }

  function ensureManualList() {
    var mt = _state.manualTab;
    if (mt.list !== null || mt.listLoading) return;
    setManualTab({ listLoading: true });
    fetchAllLocalPerformers().then(function (performers) {
      var unlinked = performers.filter(function (p) {
        return !(p.stash_ids || []).some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; });
      });
      setManualTab({ listLoading: false, list: unlinked });
    }).catch(function (e) {
      addLog(tc("加载演员列表失败", "Failed to load performer list") + ": " + e.message);
      setManualTab({ listLoading: false, list: [] });
    });
  }

  function hasHighCandidate(local, candMap, terms) {
    for (var id in candMap) {
      if (evaluateCandidate(local, candMap[id], terms).confidence === "high") return true;
    }
    return false;
  }

  // Sequential term search; stops early on a high-confidence hit when
  // earlyStop is set. candMap/termsDone are seeded from existing search state.
  function runManualTermSearch(local, terms, earlyStop) {
    var localId = local.id;
    var st = _state.manualTab.search[localId] || {};
    var candMap = Object.assign({}, st.candMap);
    var idx = st.termsDone || 0;
    var continued = Object.keys(candMap).length > 0;

    return getStashBoxConfig().then(function (config) {
      function step() {
        if (idx >= terms.length) return null;
        var term = terms[idx];
        function advance() {
          idx++;
          var cur = _state.manualTab.search[localId];
          if (cur) cur.termsDone = idx;
          updateManualStatusDOM(localId,
            (continued
              ? tc("继续搜索 JAVStash 中... ", "Searching more... ")
              : tc("搜索 JAVStash 中... ", "Searching JAVStash... ")) +
            idx + "/" + terms.length);
        }
        return _jsRateLimiter.submit(function () {
          return searchJavstashPerformers(config.javstashEndpoint, config.javstashApiKey, term.raw);
        }).then(function (list) {
          list.forEach(function (p) { if (!candMap[p.id]) candMap[p.id] = p; });
          advance();
          if (earlyStop && hasHighCandidate(local, candMap, terms)) return "early";
          return step();
        }).catch(function (e) {
          addLog(tc("搜索失败", "Search failed") + " [" + term.raw + "]: " + e.message);
          advance();
          return step();
        });
      }
      return step();
    }).then(function (result) {
      setSearchState(localId, {
        searching: false,
        candMap: candMap,
        termsDone: idx,
        termsTotal: terms.length,
        earlyStop: result === "early",
      });
      addLog(tc("手动搜索: ", "Manual search: ") + local.name + " — " +
        tc("候选 " + Object.keys(candMap).length + " 个", Object.keys(candMap).length + " candidates") +
        (result === "early" ? tc("（第 " + idx + " 词命中高可信度，停止）", " (high hit at term " + idx + ")") : ""));
    });
  }

  function handleRowSearch(local) {
    var existing = _state.manualTab.search[local.id];
    if (existing && existing.searching) return;
    var linked = (local.stash_ids || []).some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; });
    if (linked) return;
    var terms = buildSearchTerms(local);
    if (terms.length === 0) return;
    getStashBoxConfig().then(function (config) {
      if (!config.javstashApiKey) {
        alert(tc("未找到 JAVStash 配置，请在 设置 → 元数据提供者 中添加 JAVStash stash-box 实例",
                 "JAVStash not configured. Add it in Settings → Metadata Providers first."));
        return;
      }
      setSearchState(local.id, {
        searching: true, candMap: {}, termsDone: 0, termsTotal: terms.length,
        earlyStop: false, full: false, appliedJsId: null,
      });
      return runManualTermSearch(local, terms, true);
    });
  }

  function handleMore(local) {
    var s = _state.manualTab.search[local.id];
    if (!s || s.searching) return;
    var terms = buildSearchTerms(local);
    if ((s.termsDone || 0) >= terms.length) {
      setSearchState(local.id, { full: true });
      return;
    }
    setSearchState(local.id, { searching: true, full: false });
    runManualTermSearch(local, terms, false).then(function () {
      setSearchState(local.id, { full: true });
    });
  }

  function handleCollapseSearch(local) {
    var search = Object.assign({}, _state.manualTab.search);
    delete search[local.id];
    setManualTab({ search: search });
  }

  function handleIgnorePerformer(local) {
    var ignored = {};
    for (var k in _state.manualTab.ignoredIds) ignored[k] = true;
    ignored[local.id] = true;
    var search = Object.assign({}, _state.manualTab.search);
    delete search[local.id];
    setManualTab({ ignoredIds: ignored, search: search });
  }

  function handleApplyManual(local, jsPerf) {
    addLog(tc("手动应用: ", "Manual apply: ") + jsPerf.name + " → " + local.name);
    applyMatchCached(local, jsPerf).then(function () {
      addLog("  OK");
      local.stash_ids = (local.stash_ids || []).concat([{ endpoint: JAVSTASH_ENDPOINT, stash_id: jsPerf.id }]);
      setSearchState(local.id, { appliedJsId: jsPerf.id, searching: false });
    }).catch(function (e) {
      addLog("  " + tc("错误", "ERROR") + ": " + (e.message || e));
      alert(tc("应用失败", "Apply failed") + ": " + (e.message || e));
    });
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
    appendLogDOM(msg);
    if (!_state.scanning && !_state.applying) requestRender();
  }

  function addLogBatch(msg) {
    _state.log.push(msg);
  }

  // ==================== Chunked List (virtual scroll) ====================

  var CHUNK_SIZE = 50;

  function buildChunkedList(items, buildCardFn) {
    var container = el("div", "jsm-chunked");
    var sentinel = el("div", "jsm-sentinel", tc("加载中...", "Loading..."));
    var rendered = 0;

    container.appendChild(sentinel);

    function renderChunk() {
      var end = Math.min(rendered + CHUNK_SIZE, items.length);
      for (var i = rendered; i < end; i++) {
        container.insertBefore(buildCardFn(items[i]), sentinel);
      }
      rendered = end;
      if (rendered >= items.length) {
        sentinel.remove();
      }
    }

    renderChunk();

    if (rendered < items.length) {
      var observer = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && rendered < items.length) {
          renderChunk();
        }
      }, { rootMargin: "300px" });
      observer.observe(sentinel);
    }

    return container;
  }

  // ==================== Render ====================

  function render() {
    var root = document.getElementById("jsm-panel-root");
    if (!root) return;
    var active = document.activeElement;
    var restoreInput = null;
    if (active && active.classList && active.classList.contains("jsm-manual-query")) {
      restoreInput = { pos: active.selectionStart };
    }
    root.innerHTML = "";
    root.appendChild(buildPanel());
    if (restoreInput) {
      var input = root.querySelector(".jsm-manual-query");
      if (input) {
        input.focus();
        try { input.setSelectionRange(restoreInput.pos, restoreInput.pos); } catch (e) {}
      }
    }
  }

  function el(tag, className, children, attrs) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (var k in attrs) {
        if (k === "onclick") node.onclick = attrs[k];
        else if (k === "onchange") node.onchange = attrs[k];
        else if (k === "oninput") node.oninput = attrs[k];
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

    // Stats (only when a scan produced results)
    var hasResults = !!_state.results;
    var hasResultItems = hasResults && _state.results.length > 0;
    var autoMatches = hasResultItems ? getAllMatches().filter(function (m) { return m.confidence === "high" && !m.dismissed; }) : [];
    var reviewMatches = hasResultItems ? getAllMatches().filter(function (m) { return m.confidence === "medium"; }) : [];
    var unmatched = hasResultItems ? getAllUnmatched() : [];

    if (hasResultItems) {
      var manualCount = Object.keys(_state.manualSelected).length;
      frag.appendChild(el("div", "jsm-stats", [
        buildStat(autoMatches.length, tc("自动匹配", "Auto Matched"), "#37b24d"),
        buildStat(reviewMatches.length, tc("待审核", "Needs Review"), "#f59f00"),
        buildStat(unmatched.length, tc("未匹配", "Unmatched"), "#f03e3e"),
        buildStat(manualCount, tc("手动选择", "Manual Selected"), "#339af0"),
      ]));
    }

    // Tabs (always visible — manual search works without scanning)
    var tabs = [
      { id: "auto", label: tc("自动匹配", "Auto Matched") + " (" + autoMatches.length + ")" },
      { id: "review", label: tc("待审核", "Needs Review") + " (" + reviewMatches.length + ")" },
      { id: "unmatched", label: tc("未匹配", "Unmatched") + " (" + unmatched.length + ")" },
      { id: "manual", label: tc("手动搜索", "Manual Search") },
      { id: "log", label: tc("日志", "Log") },
    ];
    var tabContainer = el("div", "jsm-tabs");
    tabs.forEach(function (t) {
      var tab = el("div", "jsm-tab" + (_state.activeTab === t.id ? " jsm-tab-active" : ""), t.label, {
          onclick: function () {
            setState({ activeTab: t.id });
            if (t.id === "manual") ensureManualList();
          },
        });
      tabContainer.appendChild(tab);
    });
    frag.appendChild(tabContainer);

    // Tab content
    var content = el("div", "jsm-content");
    if (_state.activeTab === "manual") {
      content.appendChild(buildManualTab());
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
    } else {
      // Result tabs (auto / review / unmatched)
      var items = _state.activeTab === "auto" ? autoMatches
        : _state.activeTab === "review" ? reviewMatches
        : unmatched;
      if (!hasResults) {
        content.appendChild(el("div", "jsm-empty",
          _state.scanning ? tc("扫描进行中...", "Scanning...")
            : tc("尚未扫描 — 点击上方「开始扫描」，或使用「手动搜索」", "Not scanned yet — click Start Scan above, or use Manual Search")));
      } else if (_state.results.length === 0) {
        content.appendChild(el("div", "jsm-empty",
          _state.emptyReason || tc("没有结果", "No results")));
      } else if (items.length === 0) {
        var emptyText = _state.activeTab === "auto" ? tc("没有自动匹配", "No auto matches")
          : _state.activeTab === "review" ? tc("没有待审核匹配", "No review matches")
          : tc("没有未匹配演员", "No unmatched performers");
        content.appendChild(el("div", "jsm-empty", emptyText));
      } else {
        content.appendChild(buildChunkedList(items, _state.activeTab === "unmatched" ? buildUnmatchedCard : buildMatchCard));
      }
    }
    frag.appendChild(content);

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
          applySingle(m.key, m.localPerformer, m.javstashPerformer);
        },
      }));
    }

    if (!isApplied) {
      var dismissBtn = el("button", "jsm-btn jsm-btn-sm jsm-btn-ignore", tc("忽略", "Dismiss"), {
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

  function applySingle(key, localPerformer, jsPerf) {
    addLog(tc("应用: ", "Applying: ") + jsPerf.name + "...");
    applyMatchCached(localPerformer, jsPerf).then(function () {
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
        var selectedPerf = u.unmatchedLocal.find(function (p) { return p.id === selected; });
        right.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-success", tc("应用", "Apply"), {
          onclick: function () {
            if (selectedPerf) applySingle(u.key, selectedPerf, jsPerf);
          },
        }));
      }
    }

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : ""), [info, badge, right]);
  }

  // ==================== Manual Search UI ====================

  var _manualFilterTimer = null;

  function buildManualTab() {
    var mt = _state.manualTab;
    var wrap = el("div", "jsm-manual");

    var input = el("input", "jsm-input jsm-manual-query", null, {
      type: "text",
      value: mt.listFilter,
      placeholder: tc("筛选演员（名称/别名）", "Filter performers (name/alias)"),
      oninput: function (e) {
        if (e.isComposing) return;
        clearTimeout(_manualFilterTimer);
        var v = e.target.value;
        _manualFilterTimer = setTimeout(function () { setManualTab({ listFilter: v }); }, 250);
      },
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.isComposing) {
        clearTimeout(_manualFilterTimer);
        setManualTab({ listFilter: input.value });
      }
    });
    wrap.appendChild(el("div", "jsm-manual-searchrow", [input]));

    if (mt.listLoading) {
      wrap.appendChild(el("div", "jsm-empty", tc("加载演员列表中...", "Loading performers...")));
      return wrap;
    }
    if (mt.list === null) {
      ensureManualList();
      wrap.appendChild(el("div", "jsm-empty", tc("加载演员列表中...", "Loading performers...")));
      return wrap;
    }

    var filter = (mt.listFilter || "").trim().toLowerCase();
    var visible = mt.list.filter(function (p) { return !mt.ignoredIds[p.id]; });
    var filtered = filter
      ? visible.filter(function (p) {
          if ((p.name || "").toLowerCase().indexOf(filter) !== -1) return true;
          return parseAliasList(p.alias_list).some(function (a) {
            return a.toLowerCase().indexOf(filter) !== -1;
          });
        })
      : visible;

    if (filtered.length === 0) {
      wrap.appendChild(el("div", "jsm-empty",
        visible.length === 0
          ? tc("没有未绑定 JAVStash 的演员", "No performers without JAVStash ID")
          : tc("无匹配演员", "No matching performers")));
      return wrap;
    }

    var ignoredCount = mt.list.length - visible.length;
    var countText = filtered.length === visible.length
      ? tc("未绑定演员 " + filtered.length + " 个", filtered.length + " unlinked performers")
      : tc("匹配 " + filtered.length + " / " + visible.length + " 个",
           filtered.length + " / " + visible.length + " performers");
    if (ignoredCount > 0) {
      countText += tc("（已忽略 " + ignoredCount + " 个）", " (" + ignoredCount + " ignored)");
    }
    wrap.appendChild(el("div", "jsm-manual-status", countText));
    wrap.appendChild(buildChunkedList(filtered, buildManualRow));
    return wrap;
  }

  function buildManualRow(p) {
    var s = _state.manualTab.search[p.id];
    var group = el("div", "jsm-mgroup");

    var aliases = parseAliasList(p.alias_list);
    var head = el("div", "jsm-mgroup-head", [
      el("div", "jsm-card-info", [
        el("div", "jsm-card-name", p.name),
        aliases.length ? el("div", "jsm-card-sub", aliases.join(", ")) : null,
      ]),
    ]);
    if (s && s.appliedJsId) {
      head.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
    } else if (s && s.searching) {
      head.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-state", tc("搜索中...", "Searching..."), { disabled: true }));
    } else {
      head.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("搜索", "Search"), {
        onclick: function () { handleRowSearch(p); },
      }));
    }
    head.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-ignore", tc("忽略", "Ignore"), {
      title: tc("本轮忽略该演员", "Ignore this performer for this session"),
      onclick: function () { handleIgnorePerformer(p); },
    }));
    group.appendChild(head);

    if (s && !s.appliedJsId && (s.searching || s.candMap)) {
      var body = el("div", "jsm-mgroup-body");
      if (s.searching) {
        var hasPrior = s.candMap && Object.keys(s.candMap).length > 0;
        body.appendChild(el("div", "jsm-manual-status",
          (hasPrior
            ? tc("继续搜索 JAVStash 中... ", "Searching more... ")
            : tc("搜索 JAVStash 中... ", "Searching JAVStash... ")) +
          (s.termsDone || 0) + "/" + (s.termsTotal || 0),
          { "data-jsm-mstatus": p.id }));
        if (hasPrior) {
          body.appendChild(buildManualResults(p, s, true));
        }
      } else {
        body.appendChild(buildManualResults(p, s, false));
      }
      group.appendChild(body);
    }
    return group;
  }

  function buildStatusRow(local, text) {
    return el("div", "jsm-manual-statusrow", [
      el("span", "jsm-status-text", text),
      el("span", "jsm-collapse-arrow", "▲", {
        title: tc("收起搜索结果", "Collapse search results"),
        onclick: function () { handleCollapseSearch(local); },
      }),
    ]);
  }

  function buildManualResults(local, s, searching) {
    var frag = document.createDocumentFragment();
    var terms = buildSearchTerms(local);
    var evaluated = [];
    for (var id in s.candMap) {
      evaluated.push({ jsPerf: s.candMap[id], evidence: evaluateCandidate(local, s.candMap[id], terms) });
    }
    var rank = { high: 0, medium: 1 };
    evaluated.sort(function (a, b) {
      var ra = a.evidence.confidence !== null ? rank[a.evidence.confidence] : 2;
      var rb = b.evidence.confidence !== null ? rank[b.evidence.confidence] : 2;
      if (ra !== rb) return ra - rb;
      if (a.evidence.stashdbMatch !== b.evidence.stashdbMatch) return a.evidence.stashdbMatch ? -1 : 1;
      if (b.evidence.voteCount !== a.evidence.voteCount) return b.evidence.voteCount - a.evidence.voteCount;
      return b.evidence.urlIntersect - a.evidence.urlIntersect;
    });

    var high = evaluated.filter(function (c) { return c.evidence.confidence === "high"; });
    var others = evaluated.filter(function (c) { return c.evidence.confidence !== "high"; });

    if (!searching) {
      if (evaluated.length === 0) {
        frag.appendChild(buildStatusRow(local,
          tc("JAVStash 未找到候选演员", "No candidates found on JAVStash")));
      } else if (s.earlyStop) {
        frag.appendChild(buildStatusRow(local,
          tc("第 " + s.termsDone + "/" + s.termsTotal + " 词命中高可信度，已停止搜索",
             "High-confidence hit at term " + s.termsDone + "/" + s.termsTotal + ", search stopped")));
      } else {
        frag.appendChild(buildStatusRow(local,
          tc("已搜索全部 " + s.termsTotal + " 词", "Searched all " + s.termsTotal + " terms")));
      }
    }

    high.forEach(function (c) {
      frag.appendChild(buildManualCandidateCard(c, local, !s.full && !searching));
    });

    if (searching) return frag;

    if (s.full) {
      others.forEach(function (c) {
        frag.appendChild(buildManualCandidateCard(c, local, false));
      });
    } else if (high.length === 0 && evaluated.length > 0) {
      frag.appendChild(el("div", "jsm-manual-hint-row", [
        el("span", "jsm-manual-hint-text", tc("未找到高可信度候选", "No high-confidence candidates")),
        el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("更多", "More"), {
          onclick: function () { handleMore(local); },
        }),
      ]));
    }
    return frag;
  }

  function buildManualCandidateCard(c, local, showMore) {
    var jsPerf = c.jsPerf;
    var ev = c.evidence;
    var s = _state.manualTab.search[local.id];
    var isApplied = !!(s && s.appliedJsId === jsPerf.id);

    var voteNames = ev.votes.map(function (v) { return v.raw; }).join(", ");

    var bdayText, bdayClass;
    if (!local.birthdate || !jsPerf.birth_date) {
      bdayText = tc("生日 —", "bday —");
      bdayClass = null;
    } else if (ev.bdayFull) {
      bdayText = tc("生日 ✓ ", "bday ✓ ") + local.birthdate;
      bdayClass = "jsm-ev-ok";
    } else if (ev.bdayYear) {
      bdayText = tc("生日 △ ", "bday △ ") + local.birthdate + " / " + jsPerf.birth_date;
      bdayClass = "jsm-ev-mid";
    } else {
      bdayText = tc("生日 ✗ ", "bday ✗ ") + local.birthdate + " / " + jsPerf.birth_date;
      bdayClass = "jsm-ev-bad";
    }

    var hText, hClass;
    if (!local.height_cm || !jsPerf.height) {
      hText = tc("身高 —", "height —");
      hClass = null;
    } else if (local.height_cm === jsPerf.height) {
      hText = tc("身高 ✓ ", "height ✓ ") + local.height_cm;
      hClass = "jsm-ev-ok";
    } else {
      hText = tc("身高 ✗ ", "height ✗ ") + local.height_cm + " / " + jsPerf.height;
      hClass = "jsm-ev-bad";
    }

    var sub = el("div", "jsm-card-sub", [
      el("span", null, tc("命中 ", "votes ") + ev.voteCount + "/" + ev.totalNames + (voteNames ? ": " + voteNames : "") + " · "),
      el("span", bdayClass, bdayText + " · "),
      el("span", hClass, hText + " · "),
      el("span", null, tc("URL交集 ", "URL ") + ev.urlIntersect + " · "),
      el("span", ev.stashdbMatch ? "jsm-ev-ok" : null, tc("StashDB ", "StashDB ") + (ev.stashdbMatch ? "✓" : "✗")),
    ]);

    var nameText = jsPerf.name + (jsPerf.disambiguation ? " (" + jsPerf.disambiguation + ")" : "");
    if (jsPerf.deleted) nameText += "  [" + tc("已删除", "deleted") + "]";

    var badge = ev.confidence
      ? el("span", "jsm-badge " + (ev.confidence === "high" ? "jsm-badge-high" : "jsm-badge-medium"), ev.confidence)
      : el("span", "jsm-badge jsm-badge-method", tc("手动", "manual"));

    var right = el("div", "jsm-card-actions");
    if (isApplied) {
      right.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
    } else {
      right.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-success", tc("应用", "Apply"), {
        onclick: function () { handleApplyManual(local, jsPerf); },
      }));
      if (showMore) {
        right.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("更多", "More"), {
          onclick: function () { handleMore(local); },
        }));
      }
    }

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : ""), [
      el("div", "jsm-card-info", [
        el("div", "jsm-card-name", nameText),
        sub,
      ]),
      badge,
      right,
    ]);
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
