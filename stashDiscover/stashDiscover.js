/**
 * stashDiscover
 *
 * Adds a "Missing Scenes" tab to Stash performer pages. Discovers scenes
 * from configured stash-box instances that are NOT in the local library.
 *
 * stash-box GraphQL API:
 *   - queryScenes(input:{performers:{value:[id],modifier:INCLUDES},sort:DATE,direction:DESC})
 *   - scenes carry images[{url}] (covers + screenshots, flat array)
 *   - findScene(id) for full detail (director, production_date, urls.site, ...)
 *   - web URL = new URL(endpoint).origin + "/scenes/" + id
 *
 * Release windows:
 *   - recentDays: 0=unlimited, N=only scenes released within last N days
 *   - previewDays: -1=hide all future, 0=unlimited, N=only future within N days
 */

(function () {
  "use strict";

  if (window.__ssdLoaded) return;
  window.__ssdLoaded = true;

  var PLUGIN_ID = "stashDiscover";
  var PLUGIN_VERSION = "2.0.0";
  var TASK_SEARCH = "Search Resources";
  var TASK_PUSH = "Push to Downloader";
  var RESULT_MARKER = "[SSD_RESULT]";
  var ERROR_MARKER = "[SSD_ERROR]";

  // Brand display names for known stash-box hosts (simplified badges)
  var BRAND_MAP = {
    "javstash.org": "JAVStash",
    "stashdb.org": "StashDB",
    "theporndb.net": "TPDB",
  };

  // ─── i18n ────────────────────────────────────────────────────────────────

  var _intlLocale = "";

  (function initIntlBridge() {
    try {
      var api = window.PluginApi;
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return;
      var React = api.React;
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl();
        React.useEffect(function () { _intlLocale = intl.locale || ""; });
        return null;
      }
      api.patch.before("App", function (props) {
        return [{ children: React.createElement(React.Fragment, null,
          React.createElement(IntlBridge), props.children) }];
      });
    } catch (e) {
      console.warn("[SSD] i18n bridge unavailable:", e);
    }
  })();

  function isZh() {
    return !!(_intlLocale && /^zh/i.test(_intlLocale));
  }

  function tc(zh, en) {
    return isZh() ? zh : en;
  }

  // ─── Box request failures (kind → status label) ──────────────────────────

  // A hung box request must never leave the tab spinning (the "looks frozen"
  // forum report) — every call is aborted after this timeout.
  var BOX_TIMEOUT_MS = 15000;

  var BOX_ERR_TEXT = {
    timeout: ["请求超时", "Timed out"],
    network: ["无法连接", "Unreachable"],
    auth: ["鉴权失败", "Auth failed"],
    blocked: ["请求被拒绝", "Rejected"],
    graphql: ["接口报错", "API error"],
    parse: ["响应异常", "Bad response"],
    unknown: ["未知错误", "Unknown error"],
  };

  function boxErrText(kind, zh) {
    var pair = BOX_ERR_TEXT[kind] || BOX_ERR_TEXT.unknown;
    return zh ? pair[0] : pair[1];
  }

  // Error carrying a kind so the caller can classify failures (box vs config)
  function ssdError(kind, message) {
    var e = new Error(message || "");
    e.ssdKind = kind;
    return e;
  }

  // ─── GraphQL helpers ─────────────────────────────────────────────────────

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

  function callBoxGQL(endpoint, apiKey, query, variables, timeoutMs) {
    var payload = { query: query };
    if (variables) payload.variables = variables;
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers["ApiKey"] = apiKey;

    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, timeoutMs || BOX_TIMEOUT_MS);
    function done() { clearTimeout(timer); }

    function fetchError(e) {
      if (timedOut || (e && e.name === "AbortError")) return ssdError("timeout", "timeout");
      return ssdError("network", (e && e.message) || "network error");
    }

    return fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller ? controller.signal : undefined,
    }).catch(function (e) {
      throw fetchError(e);
    }).then(function (r) {
      if (!r.ok) {
        var kind = (r.status === 401 || r.status === 403) ? "auth" : "blocked";
        throw ssdError(kind, "HTTP " + r.status);
      }
      return r.json().catch(function (e) {
        if (timedOut || (e && e.name === "AbortError")) throw ssdError("timeout", "timeout");
        throw ssdError("parse", "non-JSON response");
      });
    }).then(function (data) {
      done();
      if (data && data.errors) throw ssdError("graphql", JSON.stringify(data.errors));
      return data.data;
    }).catch(function (e) {
      done();
      if (e && e.ssdKind) throw e;
      throw ssdError("unknown", (e && e.message) || String(e));
    });
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  var _boxConfig = null;

  function getStashBoxes() {
    if (_boxConfig) return Promise.resolve(_boxConfig);
    return callGQL("query { configuration { general { stashBoxes { name endpoint api_key } } } }")
      .then(function (data) {
        var boxes = (((data.configuration || {}).general || {}).stashBoxes) || [];
        _boxConfig = boxes.filter(function (b) { return b && b.endpoint; });
        return _boxConfig;
      });
  }

  function getPluginSettings() {
    // configuration.plugins 是 PluginConfigMap（JSON 对象，key=插件ID，value=设置），不带 subfields
    return callGQL("query{configuration{plugins}}")
      .then(function (data) {
        var plugins = (data.configuration || {}).plugins || {};
        return plugins[PLUGIN_ID] || {};
      });
  }

  // ─── Rate limiter (box queries) ──────────────────────────────────────────

  function createRateLimiter(maxConcurrent, minIntervalMs) {
    var queue = [], active = 0, lastDispatch = 0;
    function tryDispatch() {
      if (queue.length === 0 || active >= maxConcurrent) return;
      var now = Date.now();
      var wait = Math.max(0, lastDispatch + minIntervalMs - now);
      if (wait > 0) { setTimeout(tryDispatch, wait); return; }
      var task = queue.shift();
      active++; lastDispatch = Date.now();
      task.fn().then(function (r) { active--; task.resolve(r); tryDispatch(); })
        .catch(function (e) { active--; task.reject(e); tryDispatch(); });
    }
    return {
      submit: function (fn) {
        return new Promise(function (resolve, reject) {
          queue.push({ fn: fn, resolve: resolve, reject: reject });
          tryDispatch();
        });
      }
    };
  }

  var _boxRateLimiter = createRateLimiter(3, 300);

  // ─── Date helpers (local calendar date, not UTC) ────────────────────────

  function localDateStr(d) {
    var y = d.getFullYear();
    var m = pad(d.getMonth() + 1);
    var day = pad(d.getDate());
    return y + "-" + m + "-" + day;
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }

  // recentDays: 0=unlimited, N=cutoff = today - N days. Scenes older than cutoff excluded.
  function recentCutoffDate(recentDays) {
    if (!recentDays || recentDays <= 0) return null;
    return localDateStr(new Date(Date.now() - recentDays * 86400000));
  }

  // previewDays: -1=hide all future (cutoff=today), 0=unlimited(null), N=cutoff=today+N days
  function previewCutoffDate(previewDays) {
    if (previewDays === 0 || previewDays == null) return null;
    if (previewDays === -1) return localDateStr(new Date());
    return localDateStr(new Date(Date.now() + previewDays * 86400000));
  }

  // ─── State ────────────────────────────────────────────────────────────────

  var _state = {
    performerId: null,
    performerName: "",
    localStashIds: {},
    localSceneKeys: {},
    loading: false,
    loadError: "",
    // ── fallback state panel ──
    viewState: "",             // "" | loading | content | empty | net-fail | no-ids | no-box | fatal | no-match
    errorKind: "",             // fatal | no-box | no-ids (message lives in loadError)
    loadInitiated: false,      // a load already ran for this performer (no silent re-scan on tab re-entry)
    allBoxes: [],              // every configured stash-box (incl. ones the performer has no ID for)
    performerStashIds: [],     // local performer's stash_ids [{endpoint, stash_id}]
    boxFailed: {},             // endpoint -> failed this round (retried on the next load)
    boxStatus: {},             // endpoint -> { ok:bool, kind:string }
    boxFetched: {},            // endpoint -> scenes fetched this round (loading panel rows)
    droppedByWindow: 0,        // scenes dropped by the recent/preview window this round
    windowRelaxed: false,      // "unlimited time range (this session)"
    preferredFallback: false,  // preferred box had no ID → queried the others instead
    preferredBoxLabel: "",     // brand/raw name of the preferred box (notice text)
    cfgRecentDays: 180,        // configured values = restore target
    cfgPreviewDays: 7,
    findOpen: false,           // "find on source" block expanded
    findState: "idle",         // idle | loading | done | empty | fail
    findResults: [],           // [{box, boxName, candidate}]
    findTerm: "",
    findFailures: [],          // [{name, kind}]
    findMessage: "",           // result/notice line shown inside the block
    findExpandedKey: "",       // accordion: row key of the one expanded result
    findImageIdx: 0,           // image index of the expanded result (last viewed = selected)
    findBusyKey: "",           // row key with an in-flight link/overwrite write
    findRowMsg: {},            // row key -> {kind, text} (per-row action feedback)
    editWatching: false,       // waiting for the native edit panel to add a stash_id
    editWatchMissing: false,   // native edit button not found — guidance only
    _editTimer: null,
    modal: null,
    modalDetail: null,
    modalLoading: false,
    // pagination
    perPage: 40,
    currentPage: 1,
    sortDir: "DESC",           // DESC | ASC (pushed to box query as sort:DATE)
    zoom: 1,                   // card size 0-3 (native SceneCardGrid zoomWidths)
    displayMode: "grid",       // grid | list — seeded from localStorage below
    refocusSearch: false,      // restore search-input focus after re-render
    searchCaret: null,         // caret offset to restore with focus
    recentDays: 180,
    previewDays: 7,
    queryBoxes: [],            // [{name,endpoint,api_key}]
    boxStashIds: {},           // endpoint -> box performer stash_id
    boxCursors: {},            // endpoint -> next page to fetch (1-based)
    boxExhausted: {},          // endpoint -> true
    boxPageSize: 100,          // dynamic per-page for box queries (adjusted by missing density)
    boxFetchedTotal: 0,        // scenes fetched from boxes so far (density denominator)
    boxTotalCount: 0,          // sum of box count fields (approx, includes owned)
    cachedMissing: [],         // fetched + deduped + window-filtered missing scenes
    allLoaded: false,          // all box pages exhausted
    loadingPage: false,        // currently fetching more pages
    searchQuery: "",           // client-side filter text
    localPerformerMaps: {},    // endpoint(lower) -> box performer id(lower) -> {id,name,image_path}
  };

  // Persisted display mode (grid | list) — survives tab re-entry
  try {
    if (localStorage.getItem("ssdDisplayMode") === "list") _state.displayMode = "list";
  } catch (e) { /* localStorage unavailable — stay grid */ }

  // ─── URL / page detection ─────────────────────────────────────────────────

  function getPerformerIdFromUrl() {
    var m = window.location.pathname.match(/\/performers?\/(\d+)/);
    if (m) return m[1];
    m = window.location.hash.match(/\/performers?\/(\d+)/);
    return m ? m[1] : null;
  }

  function isPerformerPage() {
    return /\/performers?\/\d+/.test(window.location.pathname + window.location.hash);
  }

  // ─── Box web URL (origin from GraphQL endpoint) ──────────────────────────

  function boxWebBase(endpoint) {
    try {
      return new URL(endpoint).origin;
    } catch (e) {
      return endpoint.replace(/\/graphql\/?$/, "").replace(/\/+$/, "");
    }
  }

  function boxSceneUrl(endpoint, sceneId) {
    return boxWebBase(endpoint) + "/scenes/" + sceneId;
  }

  // Brand name for a stash-box endpoint (e.g. https://javstash.org/graphql →
  // "JAVStash"). Falls back to `fallback` (box config name) or the host.
  function brandNameForEndpoint(endpoint, fallback) {
    var host = "";
    try { host = new URL(endpoint).host; } catch (e) { host = String(endpoint || ""); }
    return BRAND_MAP[host] || fallback || host;
  }

  // ─── Data loading ─────────────────────────────────────────────────────────

  var PERFORMER_FIELDS = "id name stash_ids { endpoint stash_id }";

  function loadLocalPerformer(performerId) {
    return callGQL(
      "query($id:ID!){findPerformer(id:$id){" + PERFORMER_FIELDS + "}}",
      { id: performerId }
    ).then(function (data) { return data.findPerformer; });
  }

  function loadLocalSceneKeys(performerId) {
    var keys = {};
    var page = 1, perPage = 200;

    function fetchPage() {
      return callGQL(
        "query($f:FindFilterType!,$sf:SceneFilterType!){findScenes(filter:$f,scene_filter:$sf){count scenes{id code stash_ids{endpoint stash_id}}}}",
        {
          f: { page: page, per_page: perPage },
          sf: { performers: { value: [performerId], modifier: "INCLUDES" } }
        }
      ).then(function (data) {
        var result = data.findScenes;
        (result.scenes || []).forEach(function (s) {
          (s.stash_ids || []).forEach(function (sid) {
            if (sid.endpoint && sid.stash_id) {
              keys[sid.endpoint.toLowerCase() + ":" + String(sid.stash_id).toLowerCase()] = true;
            }
          });
          if (s.code) {
            keys["code:" + String(s.code).trim().toLowerCase()] = true;
          }
        });
        if (page * perPage < result.count) {
          page++;
          return fetchPage();
        }
        return keys;
      });
    }
    return fetchPage();
  }

  // stash-box scene fields — flat images[] array
  var BOX_SCENE_FIELDS =
    "id title code details release_date duration " +
    "urls { url site { name } } " +
    "studio { id name } " +
    "performers { as performer { id name } } " +
    "tags { id name } " +
    "images { url }";

  // Fetch ONE page from a stash-box (lazy loading — never pulls all 1000+ scenes).
  // Page size is dynamic (_state.boxPageSize, 20–100): starts at the box maximum
  // (stash-box clamps per_page to 100 in getPagination) and adapts to the observed
  // missing density — shrinks to the expected need when density is high, regrows
  // toward the max when it is low or the remaining need increases.
  function fetchBoxPage(box, stashId, pageNum) {
    var boxPerPage = _state.boxPageSize;
    return _boxRateLimiter.submit(function () {
      return callBoxGQL(
        box.endpoint, box.api_key,
        "query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{" + BOX_SCENE_FIELDS + "}}}",
        {
          input: {
            performers: { value: [stashId], modifier: "INCLUDES" },
            sort: "DATE",
            direction: _state.sortDir,
            page: pageNum,
            per_page: boxPerPage,
          }
        }
      );
    }).then(function (data) {
      var result = data && data.queryScenes;
      if (!result || !result.scenes) return { scenes: [], count: 0, hasMore: false };
      var items = result.scenes.map(function (sc) {
        return {
          box: box,
          boxName: brandNameForEndpoint(box.endpoint, box.name || box.endpoint),
          endpoint: box.endpoint,
          scene: sc,
          images: (sc.images || []).map(function (img) { return { url: img.url, type: "image" }; }),
        };
      });
      return {
        scenes: items,
        count: result.count || 0,
        hasMore: result.scenes.length >= boxPerPage,
      };
    });
  }

  // Re-sort the local cache by release_date in the current direction
  function sortCachedMissing() {
    _state.cachedMissing.sort(function (a, b) {
      var da = a.scene.release_date || "";
      var db = b.scene.release_date || "";
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return _state.sortDir === "ASC" ? da.localeCompare(db) : db.localeCompare(da);
    });
  }

  // True when the boundary date on a fetched box page already lies outside
  // the recent/preview window — box pages arrive date-sorted in the fetch
  // direction, so every later page would be outside the window too; paging
  // on would only waste requests.
  function boxPageOutOfWindow(scenes) {
    var recentCut = recentCutoffDate(_state.recentDays);
    var previewCut = previewCutoffDate(_state.previewDays);
    for (var i = scenes.length - 1; i >= 0; i--) {
      var rd = scenes[i].scene.release_date;
      if (!rd) continue;
      if (_state.sortDir === "ASC") return !!previewCut && rd > previewCut;
      return !!recentCut && rd < recentCut;
    }
    return false;
  }

  // Fetch more box pages until cachedMissing covers up to `needed` items, or all boxes exhausted.
  // Returns the (possibly extended) cachedMissing array.
  function ensureMissingLoaded(needed) {
    if (_state.allLoaded || _state.cachedMissing.length >= needed) {
      return Promise.resolve(_state.cachedMissing);
    }
    if (_state.loadingPage) {
      // wait for in-flight load, then retry
      return new Promise(function (resolve) {
        var check = setInterval(function () {
          if (!_state.loadingPage) {
            clearInterval(check);
            resolve(ensureMissingLoaded(needed));
          }
        }, 100);
      });
    }
    _state.loadingPage = true;

    // A source that failed this round pauses too — otherwise a dead box would
    // be retried on every recursive call.  The next load (retry button / window
    // change / tab re-entry) clears the flag and queries it again.
    var activeBoxes = _state.queryBoxes.filter(function (b) {
      return !_state.boxExhausted[b.endpoint] && !_state.boxFailed[b.endpoint];
    });

    if (activeBoxes.length === 0) {
      _state.allLoaded = true;
      _state.loadingPage = false;
      return Promise.resolve(_state.cachedMissing);
    }

    // Fetch one page from each non-exhausted box in parallel
    return Promise.all(activeBoxes.map(function (b) {
      var sid = _state.boxStashIds[b.endpoint];
      var pageNum = _state.boxCursors[b.endpoint] || 1;
      return fetchBoxPage(b, sid, pageNum).then(function (result) {
        _state.boxCursors[b.endpoint] = pageNum + 1;
        delete _state.boxFailed[b.endpoint];
        _state.boxStatus[b.endpoint] = { ok: true };
        _state.boxFetched[b.endpoint] = (_state.boxFetched[b.endpoint] || 0) + result.scenes.length;
        if (!result.hasMore) _state.boxExhausted[b.endpoint] = true;
        // Window early-stop: the page's boundary date crossed the window,
        // every later page is outside it as well
        else if (boxPageOutOfWindow(result.scenes)) _state.boxExhausted[b.endpoint] = true;
        if (result.count && !_state.boxTotalCount) _state.boxTotalCount = result.count;
        return result.scenes;
      }).catch(function (e) {
        var kind = (e && e.ssdKind) || "unknown";
        console.warn("[SSD] Box page failed for", b.name, kind, (e && e.message) || "");
        // Record the failure for the state panel instead of silently showing
        // an empty tab ("looks frozen" if the performer has no linked DB)
        _state.boxFailed[b.endpoint] = true;
        _state.boxStatus[b.endpoint] = { ok: false, kind: kind };
        return [];
      });
    })).then(function (pageResults) {
      var newItems = [];
      pageResults.forEach(function (list) { newItems = newItems.concat(list); });

      // Filter owned + window. Scenes dropped by the window are counted so the
      // empty panel can offer "unlimited time range (this session)" instead of
      // pretending there is nothing left on the source.
      var recentCut = recentCutoffDate(_state.recentDays);
      var previewCut = previewCutoffDate(_state.previewDays);
      var droppedNow = 0;
      var filtered = newItems.filter(function (item) {
        if (isSceneOwned(item)) return false;
        var rd = item.scene.release_date;
        if (!rd) return true;
        if (recentCut && rd < recentCut) { droppedNow++; return false; }
        if (previewCut && rd > previewCut) { droppedNow++; return false; }
        return true;
      });
      _state.droppedByWindow += droppedNow;

      // Dedup by code (merge with existing cache)
      var seenCodes = {};
      _state.cachedMissing.forEach(function (item) {
        var c = (item.scene.code || "").trim().toLowerCase();
        if (c) seenCodes[c] = true;
      });
      filtered.forEach(function (item) {
        var c = (item.scene.code || "").trim().toLowerCase();
        if (c) {
          if (seenCodes[c]) return;
          seenCodes[c] = true;
        }
        _state.cachedMissing.push(item);
      });

      // Re-sort cache by release_date (current direction)
      sortCachedMissing();

      // Adapt the box page size to the missing density (cachedMissing / fetched):
      // - low density (mostly owned/filtered out) → grow toward the box max so
      //   each round still yields enough missing scenes
      // - high density → size the page to the expected need; also regrows after
      //   a previous shrink once the remaining need increases again
      _state.boxFetchedTotal += newItems.length;
      var density = _state.cachedMissing.length / Math.max(1, _state.boxFetchedTotal);
      var remaining = needed - _state.cachedMissing.length;
      if (density <= 0.25) {
        _state.boxPageSize = Math.min(100, _state.boxPageSize * 2);
      } else {
        var target = Math.max(20, Math.min(100, Math.ceil(remaining / density)));
        if (target > _state.boxPageSize) {
          _state.boxPageSize = Math.min(target, _state.boxPageSize * 2);
        } else if (target < _state.boxPageSize) {
          _state.boxPageSize = target;
        }
      }

      var anyActive = _state.queryBoxes.some(function (b) {
        return !_state.boxExhausted[b.endpoint] && !_state.boxFailed[b.endpoint];
      });
      if (!anyActive) _state.allLoaded = true;

      _state.loadingPage = false;

      if (_state.cachedMissing.length < needed && !_state.allLoaded) {
        return ensureMissingLoaded(needed);
      }
      return _state.cachedMissing;
    });
  }

  // Full scene detail for modal (findScene)
  var BOX_SCENE_DETAIL_FIELDS =
    "id title details release_date production_date code director duration " +
    "urls { url site { name } } " +
    "studio { id name } " +
    "performers { as performer { id name gender images { url } } } " +
    "tags { id name } " +
    "images { url }";

  function fetchBoxSceneDetail(box, sceneId) {
    return _boxRateLimiter.submit(function () {
      return callBoxGQL(
        box.endpoint, box.api_key,
        "query($id:ID!){findScene(id:$id){" + BOX_SCENE_DETAIL_FIELDS + "}}",
        { id: sceneId }
      );
    }).then(function (data) {
      var sc = data && data.findScene;
      if (!sc) return null;
      return {
        scene: sc,
        images: (sc.images || []).map(function (img) { return { url: img.url, type: "image" }; }),
      };
    });
  }

  function isSceneOwned(item) {
    var sc = item.scene;
    var epKey = item.endpoint.toLowerCase() + ":" + String(sc.id).toLowerCase();
    if (_state.localSceneKeys[epKey]) return true;
    if (sc.code) {
      var codeKey = "code:" + String(sc.code).trim().toLowerCase();
      if (_state.localSceneKeys[codeKey]) return true;
    }
    return false;
  }

  function loadMissingScenes() {
    var performerId = _state.performerId;
    if (!performerId) return Promise.resolve();

    _state.loading = true;
    _state.loadInitiated = true;
    _state.viewState = "loading";
    _state.loadError = "";
    _state.errorKind = "";
    _state.currentPage = 1;
    _state.cachedMissing = [];
    _state.boxCursors = {};
    _state.boxExhausted = {};
    _state.boxFailed = {};
    _state.boxStatus = {};
    _state.boxFetched = {};
    _state.boxPageSize = 100;
    _state.boxFetchedTotal = 0;
    _state.boxTotalCount = 0;
    _state.droppedByWindow = 0;
    _state.preferredFallback = false;
    _state.preferredBoxLabel = "";
    _state.allLoaded = false;
    _state.loadingPage = false;
    renderTabContent();

    return Promise.all([
      loadLocalPerformer(performerId),
      loadLocalSceneKeys(performerId),
      getStashBoxes(),
      getPluginSettings(),
    ]).then(function (results) {
      var performer = results[0];
      var localKeys = results[1];
      var boxes = results[2];
      var settings = results[3];

      if (!performer) throw ssdError("fatal", tc("未找到演员", "Performer not found"));

      _state.performerName = performer.name || "";
      _state.localSceneKeys = localKeys;
      _state.performerStashIds = performer.stash_ids || [];
      _state.allBoxes = boxes;

      var stashIdMap = {};
      (performer.stash_ids || []).forEach(function (sid) {
        if (sid.endpoint && sid.stash_id) {
          stashIdMap[sid.endpoint.toLowerCase()] = sid.stash_id;
        }
      });
      _state.localStashIds = stashIdMap;

      if (boxes.length === 0) {
        throw ssdError("no-box", tc("未配置 stash-box 实例，请在 设置 → 元数据提供者 中添加",
          "No stash-box configured. Add one in Settings → Metadata Providers."));
      }

      var preferred = (settings.preferredBox || "").trim().toLowerCase();
      var queryBoxes = boxes.filter(function (b) {
        var ep = b.endpoint.toLowerCase();
        if (!stashIdMap[ep]) return false;
        if (preferred && ep.indexOf(preferred) === -1) return false;
        return true;
      });
      if (queryBoxes.length === 0 && preferred) {
        // Preferred source has no ID for this performer → fall back to every
        // source that does. Flag it so the UI can say so; a silent fallback
        // reads as "the Preferred box setting does nothing".
        var fallback = boxes.filter(function (b) { return !!stashIdMap[b.endpoint.toLowerCase()]; });
        if (fallback.length > 0) {
          queryBoxes = fallback;
          _state.preferredFallback = true;
          var preferredBox = boxes.filter(function (b) {
            return b.endpoint.toLowerCase().indexOf(preferred) !== -1;
          })[0];
          _state.preferredBoxLabel = preferredBox ? sourceLabel(preferredBox) : (settings.preferredBox || "");
        }
      }
      if (queryBoxes.length === 0) {
        throw ssdError("no-ids", tc("该演员未关联任何 stash-box ID，请先在演员编辑页添加 stash_id",
          "This performer has no stash-box IDs. Add a stash_id in the performer edit page first."));
      }

      var recentDays = parseInt(settings.recentDays, 10);
      if (isNaN(recentDays)) recentDays = 180;
      var previewDays = parseInt(settings.previewDays, 10);
      if (isNaN(previewDays)) previewDays = 7;

      // Configured window = restore target. "Unlimited (this session)" lifts it
      // for the current view only — the settings are never written from here.
      _state.cfgRecentDays = recentDays;
      _state.cfgPreviewDays = previewDays;
      if (_state.windowRelaxed) { recentDays = 0; previewDays = 0; }

      _state.recentDays = recentDays;
      _state.previewDays = previewDays;
      _state.queryBoxes = queryBoxes;

      var boxStashIds = {};
      queryBoxes.forEach(function (b) {
        boxStashIds[b.endpoint] = stashIdMap[b.endpoint.toLowerCase()];
      });
      _state.boxStashIds = boxStashIds;

      // Re-render now that the sources are known: the first loading frame is
      // drawn before the box list is resolved, so it would have no source rows
      renderTabContent();

      // Local performer maps (box performer id → local performer) for card badges
      _state.localPerformerMaps = {};
      var mapPromises = queryBoxes.map(function (b) {
        return buildLocalPerformerStashIdMap(b.endpoint).then(function (m) {
          _state.localPerformerMaps[b.endpoint.toLowerCase()] = m;
        }).catch(function (e) {
          console.warn("[SSD] local performer map failed for", b.name, e.message);
        });
      });

      // Lazy-load first page only
      return Promise.all(mapPromises).then(function () {
        return ensureMissingLoaded(_state.perPage);
      }).then(function () {
        _state.loading = false;
        _state.viewState = computeResultViewState();
        renderTabContent();
      });
    }).catch(function (e) {
      console.error("[SSD] load error:", e);
      _state.loading = false;
      _state.loadError = e.message || String(e);
      _state.errorKind = (e && e.ssdKind) || "";
      _state.viewState = _state.errorKind || "fatal";
      renderTabContent();
    });
  }

  // Change page (fetches more if needed)
  function goToPage(pageNum) {
    var isSearching = (_state.searchQuery || "").trim().length > 0;
    if (isSearching) {
      // Search mode: only paginate over already-loaded filtered results
      var filtered = getFilteredMissing();
      var maxPage = Math.max(1, Math.ceil(filtered.length / _state.perPage));
      if (pageNum < 1) pageNum = 1;
      if (pageNum > maxPage) pageNum = maxPage;
      _state.currentPage = pageNum;
      renderTabContent();
      return;
    }
    var maxPage = Math.max(1, Math.ceil(_state.cachedMissing.length / _state.perPage));
    if (_state.allLoaded) {
      if (pageNum < 1) pageNum = 1;
      if (pageNum > maxPage) pageNum = maxPage;
    } else {
      if (pageNum < 1) pageNum = 1;
    }
    _state.currentPage = pageNum;
    loadAndRender(pageNum * _state.perPage);
  }

  // Render the current page from the local cache immediately (when the cache
  // already covers the page start), then top up to `needed` in the background
  // with an incremental refresh when more scenes arrive. Falls back to a
  // spinner when the page start is beyond the known results.
  function loadAndRender(needed) {
    var known = getFilteredMissing().length;
    var start = (_state.currentPage - 1) * _state.perPage;
    if (known > start) {
      renderTabContent();
      if (_state.allLoaded || known >= needed) return;
      var before = _state.cachedMissing.length;
      ensureMissingLoaded(needed).then(function () {
        if (_state.cachedMissing.length > before) renderTabContent();
      });
      return;
    }
    _state.loading = true;
    _state.viewState = "loading";
    renderTabContent();
    ensureMissingLoaded(needed).then(function () {
      _state.loading = false;
      _state.viewState = computeResultViewState();
      renderTabContent();
    });
  }

  // Change per-page (resets to page 1, keeps cache)
  function changePerPage(newPerPage) {
    _state.perPage = newPerPage;
    _state.currentPage = 1;
    loadAndRender(newPerPage);
  }

  // Change sort direction.
  // Small fully-loaded result sets (<= perPage) are re-sorted from the local
  // cache without re-querying; otherwise the box query is re-run with a
  // loading spinner while the cards are hidden.
  function changeSort(dir) {
    if (_state.sortDir === dir) return;
    _state.sortDir = dir;
    sortCachedMissing();
    _state.currentPage = 1;

    if (_state.allLoaded && _state.cachedMissing.length <= _state.perPage) {
      renderTabContent();
      return;
    }

    _state.cachedMissing = [];
    _state.boxCursors = {};
    _state.boxExhausted = {};
    _state.boxFailed = {};
    _state.boxStatus = {};
    _state.boxFetched = {};
    _state.boxPageSize = 100;
    _state.boxFetchedTotal = 0;
    _state.boxTotalCount = 0;
    _state.droppedByWindow = 0;
    _state.allLoaded = false;
    _state.loading = true;
    _state.viewState = "loading";
    renderTabContent();

    ensureMissingLoaded(_state.perPage).then(function () {
      _state.loading = false;
      _state.viewState = computeResultViewState();
      renderTabContent();
    }).catch(function (e) {
      console.error("[SSD] re-sort query failed:", e);
      _state.loading = false;
      _state.loadError = e.message || String(e);
      _state.errorKind = (e && e.ssdKind) || "";
      _state.viewState = _state.errorKind || "fatal";
      renderTabContent();
    });
  }

  // ─── Local performer/studio mapping by stash_id ──────────────────────────

  function buildLocalPerformerStashIdMap(endpoint) {
    return callGQL(
      "query{findPerformers(filter:{per_page:-1}){performers{id name image_path stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var map = {};
      var performers = ((data.findPerformers || {}).performers) || [];
      performers.forEach(function (p) {
        (p.stash_ids || []).forEach(function (sid) {
          if (sid.endpoint && sid.endpoint.toLowerCase() === endpoint.toLowerCase() && sid.stash_id) {
            map[String(sid.stash_id).toLowerCase()] = { id: p.id, name: p.name, image_path: p.image_path };
          }
        });
      });
      return map;
    });
  }

  function findLocalStudioByStashId(endpoint, stashId) {
    return callGQL(
      "query{findStudios(filter:{per_page:-1}){studios{id stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var studios = ((data.findStudios || {}).studios) || [];
      for (var i = 0; i < studios.length; i++) {
        var s = studios[i];
        for (var j = 0; j < (s.stash_ids || []).length; j++) {
          var sid = s.stash_ids[j];
          if (sid.endpoint && sid.endpoint.toLowerCase() === endpoint.toLowerCase() &&
              sid.stash_id && String(sid.stash_id).toLowerCase() === String(stashId).toLowerCase()) {
            return s.id;
          }
        }
      }
      return null;
    });
  }

  // ─── Tab injection ────────────────────────────────────────────────────────

  var _tabInjected = false;
  var _tabPerformerId = null;

  function ensureTabInjected() {
    if (!isPerformerPage()) return;
    var pid = getPerformerIdFromUrl();
    if (!pid) return;

    var nav = document.querySelector(".performer-tabs .nav-tabs")
      || document.querySelector(".performer-page .nav-tabs")
      || document.querySelector(".main-content .nav-tabs")
      || document.querySelector(".nav-tabs");
    if (!nav) return;

    if (_tabInjected && _tabPerformerId === pid && document.querySelector(".ssd-tab")) return;

    var oldTab = document.querySelector(".ssd-tab");
    if (oldTab) oldTab.remove();
    var oldPane = document.querySelector(".ssd-tab-pane");
    if (oldPane) oldPane.remove();

    var tabItem = document.createElement("li");
    tabItem.className = "nav-item ssd-tab";
    var tabLink = document.createElement("a");
    tabLink.className = "nav-link ssd-nav-link";
    tabLink.href = "javascript:void(0)";
    tabLink.setAttribute("role", "tab");
    tabLink.textContent = tc("发现", "Discover");
    tabLink.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      activateTab();
    };
    tabItem.appendChild(tabLink);
    nav.appendChild(tabItem);

    var tabContent = document.querySelector(".tab-content")
      || nav.closest(".performer-tabs")
      || nav.parentElement;
    if (tabContent && !tabContent.classList.contains("tab-content")) {
      var existing = document.querySelector(".tab-content");
      if (existing) tabContent = existing;
    }

    var pane = document.createElement("div");
    pane.className = "tab-pane ssd-tab-pane";
    pane.style.display = "none";
    if (tabContent) tabContent.appendChild(pane);
    else nav.parentElement.appendChild(pane);

    _tabInjected = true;
    _tabPerformerId = pid;
    _state.performerId = pid;

    bindSortDropdownDismiss();

    if (!nav._ssdWatchBound) {
      nav._ssdWatchBound = true;
      nav.addEventListener("click", function (e) {
        var link = e.target.closest(".nav-link");
        if (link && !link.classList.contains("ssd-nav-link")) {
          deactivateTab();
          // React skips re-rendering when the clicked native tab already
          // matches the current route, so restore the recorded native
          // tab/pane ourselves to keep the first click working.
          if (link === _ssdPrevLink) {
            link.classList.add("active");
            link.setAttribute("aria-selected", "true");
            if (_ssdPrevPane) _ssdPrevPane.classList.add("active", "show");
          }
          _ssdPrevLink = null;
          _ssdPrevPane = null;
        }
      }, true);
    }

    renderTabContent();
  }

  var _ssdPrevLink = null;
  var _ssdPrevPane = null;

  function activateTab() {
    var tabLink = document.querySelector(".ssd-nav-link");
    var pane = document.querySelector(".ssd-tab-pane");
    if (!tabLink || !pane) return;

    // Remember the native tab/pane React currently shows so a later click on
    // the same native tab can restore them verbatim (React won't re-render).
    _ssdPrevLink = document.querySelector(".nav-tabs .nav-link.active");
    if (_ssdPrevLink === tabLink) _ssdPrevLink = null;
    _ssdPrevPane = document.querySelector(".tab-content .tab-pane.active");
    if (_ssdPrevPane === pane) _ssdPrevPane = null;

    document.querySelectorAll(".nav-tabs .nav-link.active").forEach(function (el) {
      if (!el.classList.contains("ssd-nav-link")) {
        el.classList.remove("active");
        el.setAttribute("aria-selected", "false");
      }
    });
    document.querySelectorAll(".tab-content .tab-pane.active").forEach(function (el) {
      if (!el.classList.contains("ssd-tab-pane")) el.classList.remove("active", "show");
    });

    tabLink.classList.add("active");
    tabLink.setAttribute("aria-selected", "true");
    pane.classList.add("active", "show");
    pane.style.display = "";

    // Load once per performer. Error/empty states carry their own retry button —
    // silently re-scanning on every tab click would just repeat the same query.
    if (!_state.loading && !_state.loadInitiated) {
      loadMissingScenes();
    }
  }

  function deactivateTab() {
    var tabLink = document.querySelector(".ssd-nav-link");
    var pane = document.querySelector(".ssd-tab-pane");
    if (tabLink) {
      tabLink.classList.remove("active");
      tabLink.setAttribute("aria-selected", "false");
    }
    if (pane) {
      pane.classList.remove("active", "show");
      pane.style.display = "none";
    }
  }

  // Close any open sort dropdown (outside click / Escape)
  function closeSortDropdowns() {
    document.querySelectorAll(".ssd-tab-pane .sort-by-select.show").forEach(function (g) {
      g.classList.remove("show");
      var m = g.querySelector(".dropdown-menu");
      if (m) m.classList.remove("show");
      var t = g.querySelector(".dropdown-toggle");
      if (t) t.setAttribute("aria-expanded", "false");
    });
  }

  var _sortDismissBound = false;
  function bindSortDropdownDismiss() {
    if (_sortDismissBound) return;
    _sortDismissBound = true;
    document.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".ssd-tab-pane .sort-by-select")) return;
      closeSortDropdowns();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeSortDropdowns();
    });
  }

  // ─── Fallback state panel ─────────────────────────────────────────────────
  // Every non-content state (scanning / unreachable source / performer without a
  // linked stash-box ID / nothing left to discover) renders as one panel instead
  // of bare text, so the tab never just looks frozen.  Convention: solid buttons
  // are actions, outlined chips are status.

  var ICON_WARN = "M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480L40 480c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24l0 112c0 13.3 10.7 24 24 24s24-10.7 24-24l0-112c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z";
  var ICON_INFO = "M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336l24 0 0-64-24 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l48 0c13.3 0 24 10.7 24 24l0 88 8 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z";
  var ICON_DANGER = "M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24l0 112c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-112c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z";

  // Result of a finished load: cards, a dead-source panel or a genuine empty run
  function computeResultViewState() {
    if (_state.cachedMissing.length > 0) return "content";
    var boxes = _state.queryBoxes || [];
    if (boxes.length > 0) {
      var allFailed = boxes.every(function (b) {
        var st = _state.boxStatus[b.endpoint];
        return st && !st.ok;
      });
      if (allFailed) return "net-fail";
    }
    return "empty";
  }

  function resolveViewState() {
    if (_state.viewState) return _state.viewState;
    return _state.loadInitiated ? "empty" : "idle";
  }

  // Sources that failed in the current round (name + failure kind)
  function failedSources() {
    var out = [];
    (_state.queryBoxes || []).forEach(function (b) {
      var st = _state.boxStatus[b.endpoint];
      if (st && !st.ok) {
        out.push({ name: sourceLabel(b), kind: st.kind });
      }
    });
    return out;
  }

  function sourceLabel(box) {
    return brandNameForEndpoint(box.endpoint, box.name || box.endpoint);
  }

  function makeChip(text, kind) {
    var el = document.createElement("span");
    el.className = "ssd-chip" + (kind ? " ssd-chip--" + kind : "");
    el.textContent = text;
    return el;
  }

  function makePanelBtn(label, kind, size) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "ssd-btn " + (size === "sm" ? "ssd-btn-sm" : (size === "md" ? "ssd-btn-md" : "ssd-btn-lg"))
      + " ssd-btn-" + (kind || "secondary");
    b.textContent = label;
    return b;
  }

  // "Unlimited time range (this session)" — a viewing aid, never a setting write
  function setWindowRelaxed(on) {
    _state.windowRelaxed = !!on;
    loadMissingScenes();
  }

  function retryLoad() {
    loadMissingScenes();
  }

  function openBoxPerformer(box) {
    var sid = _state.boxStashIds[box.endpoint];
    if (!sid) return;
    window.open(boxWebBase(box.endpoint) + "/performers/" + sid, "_blank", "noopener,noreferrer");
  }

  function panelVariant(vs) {
    if (vs === "loading" || vs === "idle") return "loading";
    if (vs === "net-fail" || vs === "no-box" || vs === "no-ids") return "warn";
    if (vs === "fatal") return "danger";
    return "neutral";
  }

  var PANEL_TITLES = {
    loading: ["正在扫描源…", "Scanning sources…"],
    "net-fail": ["无法访问 stash-box", "Can't reach the stash-box"],
    "no-box": ["未配置 stash-box", "No stash-box configured"],
    "no-ids": ["该演员未关联 stash-box ID", "This performer has no stash-box ID"],
    "no-match": ["没有匹配的场景", "No matching scenes"],
    fatal: ["加载失败", "Loading failed"],
  };

  function panelTitle(vs) {
    if (vs === "empty") {
      if (_state.droppedByWindow > 0) {
        return tc("当前时间窗口内没有剩余场景", "Nothing left inside the time window");
      }
      return tc("源上没有待发现的场景", "Nothing left to discover on the source");
    }
    var pair = PANEL_TITLES[vs] || PANEL_TITLES.loading;
    return isZh() ? pair[0] : pair[1];
  }

  function panelIcon(kind) {
    var path = kind === "warn" ? ICON_WARN : (kind === "danger" ? ICON_DANGER : ICON_INFO);
    var span = document.createElement("span");
    span.className = "ssd-panel-icon ssd-panel-icon--" + kind;
    span.innerHTML = '<svg viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" d="'
      + path + '"></path></svg>';
    return span;
  }

  function panelDesc(text) {
    var el = document.createElement("div");
    el.className = "ssd-panel-desc";
    el.textContent = text;
    return el;
  }

  function panelNote(text, withSpinner, isError) {
    var el = document.createElement("div");
    el.className = "ssd-find-note" + (isError ? " ssd-find-note--error" : "");
    if (withSpinner) {
      var sp = document.createElement("div");
      sp.className = "ssd-spinner ssd-spinner-sm";
      el.appendChild(sp);
    }
    var t = document.createElement("span");
    t.textContent = text;
    el.appendChild(t);
    return el;
  }

  // One row per source: dot + name + status text
  function buildSourceRow(name, dotKind, statusText, statusWarn) {
    var row = document.createElement("div");
    row.className = "ssd-src-row";
    var dot = document.createElement("span");
    dot.className = "ssd-src-dot ssd-src-dot--" + dotKind;
    var nm = document.createElement("span");
    nm.className = "ssd-src-name";
    nm.textContent = name;
    var st = document.createElement("span");
    st.className = "ssd-src-status" + (statusWarn ? " ssd-src-status--warn" : "");
    st.textContent = statusText;
    row.appendChild(dot);
    row.appendChild(nm);
    row.appendChild(st);
    return row;
  }

  // Scanning panel body: indeterminate bar + per-source progress rows
  function buildScanProgress() {
    var frag = document.createDocumentFragment();
    var bar = document.createElement("div");
    bar.className = "ssd-progress";
    bar.appendChild(document.createElement("i"));
    frag.appendChild(bar);

    var boxes = _state.queryBoxes || [];
    if (boxes.length) {
      var list = document.createElement("div");
      list.className = "ssd-src-list";
      boxes.forEach(function (b) {
        var st = _state.boxStatus[b.endpoint];
        var fetched = _state.boxFetched[b.endpoint] || 0;
        list.appendChild(buildSourceRow(
          sourceLabel(b),
          (st && !st.ok) ? "warn" : (st && st.ok ? "ok" : "pending"),
          (st && !st.ok)
            ? tc("失败 · ", "Failed · ") + boxErrText(st.kind, isZh())
            : (st && st.ok)
              ? tc("已获取 " + fetched + " 条", fetched + " fetched")
              : tc("正在查询…", "Querying…"),
          !!(st && !st.ok)
        ));
      });
      frag.appendChild(list);
    }
    return frag;
  }

  function buildStatePanel(vs) {
    var panel = document.createElement("div");
    panel.className = "ssd-panel ssd-panel--" + panelVariant(vs);

    var head = document.createElement("div");
    head.className = "ssd-panel-head";
    if (vs === "loading" || vs === "idle") {
      var sp = document.createElement("div");
      sp.className = "ssd-spinner ssd-spinner-sm";
      head.appendChild(sp);
    } else {
      head.appendChild(panelIcon(vs === "fatal" ? "danger" : (panelVariant(vs) === "warn" ? "warn" : "info")));
    }
    var title = document.createElement("div");
    title.className = "ssd-panel-title";
    title.textContent = panelTitle(vs);
    head.appendChild(title);
    panel.appendChild(head);

    var body = document.createElement("div");
    body.className = "ssd-panel-body";
    panel.appendChild(body);

    var actions = document.createElement("div");
    actions.className = "ssd-actions";

    if (vs === "loading" || vs === "idle") {
      body.appendChild(buildScanProgress());

    } else if (vs === "net-fail") {
      body.appendChild(panelDesc(tc(
        "网络请求失败，没有取到任何场景。检查网络或代理后重试。",
        "The request failed and no scenes could be fetched. Check your connection or proxy, then retry.")));
      var failed = failedSources();
      if (failed.length) {
        var list = document.createElement("div");
        list.className = "ssd-src-list";
        failed.forEach(function (f) {
          list.appendChild(buildSourceRow(f.name, "warn", boxErrText(f.kind, isZh()), true));
        });
        body.appendChild(list);
      }
      var retryBtn = makePanelBtn(tc("重试", "Retry"), "primary");
      retryBtn.onclick = retryLoad;
      actions.appendChild(retryBtn);
      var setBtn = makePanelBtn(tc("打开设置", "Open settings"), "secondary");
      setBtn.onclick = function () { window.open("/settings", "_blank", "noopener,noreferrer"); };
      actions.appendChild(setBtn);

    } else if (vs === "no-box") {
      body.appendChild(panelDesc(tc(
        "本插件从已配置的 stash-box 读取场景。请在 设置 → 元数据提供者 中添加至少一个实例，然后重试。",
        "Scenes are read from configured stash-boxes. Add at least one in Settings → Metadata Providers, then retry.")));
      var retryBtn2 = makePanelBtn(tc("重试", "Retry"), "primary");
      retryBtn2.onclick = retryLoad;
      actions.appendChild(retryBtn2);
      var setBtn2 = makePanelBtn(tc("打开设置", "Open settings"), "secondary");
      setBtn2.onclick = function () { window.open("/settings", "_blank", "noopener,noreferrer"); };
      actions.appendChild(setBtn2);

    } else if (vs === "no-ids") {
      body.appendChild(panelDesc(tc(
        "本插件按 stash-box 编号查询场景。在演员编辑面板的「Stash IDs」区点「添加Stash编号」，为下列源各填入一个编号；写入后会自动重新查询。",
        "Scenes are queried by stash-box ID. Open the performer edit panel, click \"Add Stash ID\" in the \"Stash IDs\" section and fill in one ID for each source below — the tab re-queries automatically once it is saved.")));
      var boxList = document.createElement("div");
      boxList.className = "ssd-src-list";
      (_state.allBoxes || []).forEach(function (b) {
        boxList.appendChild(buildSourceRow(sourceLabel(b), "warn", tc("未关联", "Not linked"), true));
      });
      if (boxList.children.length) body.appendChild(boxList);
      if (_state.editWatching) {
        body.appendChild(panelNote(tc("已打开编辑面板，正在等待编号写入…",
          "Edit panel opened — waiting for an ID to be saved…"), true, false));
      }
      if (_state.editWatchMissing) {
        body.appendChild(panelNote(tc("没找到编辑按钮，请手动点开页面右上角的编辑（铅笔）图标。",
          "Edit button not found — open the edit (pencil) icon at the top right manually."), false, true));
      }

      var findBtn = findEntryBtn("lg", "primary");
      actions.appendChild(findBtn);

      var editBtn = makePanelBtn(tc("打开编辑面板", "Open edit panel"), "secondary");
      editBtn.onclick = openPerformerEditor;
      actions.appendChild(editBtn);

      var retryBtn3 = makePanelBtn(tc("重试", "Retry"), "secondary");
      retryBtn3.onclick = retryLoad;
      actions.appendChild(retryBtn3);

    } else if (vs === "empty") {
      var dropped = _state.droppedByWindow;
      var failedN = failedSources();
      var lines = [];
      if (dropped > 0) {
        lines.push(tc(dropped + " 个场景被时间窗口过滤掉了。",
          dropped + " scene(s) were filtered out by the time window."));
      } else {
        lines.push(tc("该演员在源上的场景都已在本库中。",
          "Every scene this performer has on the sources is already in your library."));
      }
      if (failedN.length) {
        lines.push(tc("部分源查询失败，结果可能不完整。",
          "Some sources failed — the result may be incomplete."));
      }
      if (_state.preferredFallback) {
        lines.push(tc("首选源 " + _state.preferredBoxLabel + " 没有该演员的编号，已改查其他有编号的源。",
          "The preferred source " + _state.preferredBoxLabel + " has no ID for this performer, so the other sources that do were queried."));
      }
      body.appendChild(panelDesc(lines.join(" ")));
      if (failedN.length) {
        var list2 = document.createElement("div");
        list2.className = "ssd-src-list";
        failedN.forEach(function (f) {
          list2.appendChild(buildSourceRow(f.name, "warn", boxErrText(f.kind, isZh()), true));
        });
        body.appendChild(list2);
      }

      (_state.queryBoxes || []).forEach(function (b, i) {
        var viewBtn = appendExtIcon(makePanelBtn(sourceLabel(b),
          (dropped > 0 || i > 0) ? "secondary" : "primary"));
        viewBtn.title = tc("在源上打开该演员页面", "Open this performer on the source");
        viewBtn.onclick = (function (box) { return function () { openBoxPerformer(box); }; })(b);
        actions.appendChild(viewBtn);
      });
      if (dropped > 0) {
        var relaxBtn = makePanelBtn(tc("不限时间（本次）", "Unlimited time (this session)"), "primary");
        relaxBtn.title = tc("临时放开近期/预告时间窗口", "Temporarily lift the recent/preview window");
        relaxBtn.onclick = function () { setWindowRelaxed(true); };
        actions.appendChild(relaxBtn);
      }
      var retryBtn4 = makePanelBtn(tc("重试", "Retry"), "secondary");
      retryBtn4.onclick = retryLoad;
      actions.appendChild(retryBtn4);
      if (findEntryVisible("empty")) actions.appendChild(findEntryBtn("lg", "info"));

    } else if (vs === "no-match") {
      var found = _state.cachedMissing.length;
      body.appendChild(panelDesc(tc("清除搜索可查看已发现的全部场景（共 " + found + " 个）。",
        "Clear the search to see all " + found + " discovered scene(s).")));
      var clearBtn = makePanelBtn(tc("清除搜索", "Clear search"), "primary");
      clearBtn.onclick = function () {
        _state.searchQuery = "";
        _state.currentPage = 1;
        renderTabContent();
      };
      actions.appendChild(clearBtn);
      if (findEntryVisible("no-match")) actions.appendChild(findEntryBtn("lg", "info"));

    } else {
      // fatal
      body.appendChild(panelDesc(_state.loadError || tc("未知错误", "Unknown error")));
      var retryBtn5 = makePanelBtn(tc("重试", "Retry"), "primary");
      retryBtn5.onclick = retryLoad;
      actions.appendChild(retryBtn5);
    }

    if (actions.children.length) panel.appendChild(actions);
    // The inline lookup expands inside any panel that offers its entry button
    if (_state.findOpen && (vs === "no-ids" || vs === "empty" || vs === "no-match")) {
      panel.appendChild(buildFindBlock());
    }
    return panel;
  }

  // ─── "Look them up on the source" (inline block) ──────────────────────────
  // Searches every configured box by performer name so an unlinked performer can
  // be linked without leaving the page.  Expanding inline (no popup layer) keeps
  // it consistent with the rest of the panel system.

  var SEARCH_PERFORMER_QUERY =
    "query($term:String!){searchPerformer(term:$term){id name disambiguation aliases deleted " +
    "gender country birth_date death_date urls{url} images{url} height cup_size band_size waist_size hip_size " +
    "career_start_year career_end_year ethnicity hair_color eye_color tattoos{location description} " +
    "piercings{location description} scene_count}}";

  // Local performer fields the link/overwrite actions compare and merge against
  var LOCAL_PERF_FIELDS = PERFORMER_FIELDS +
    " alias_list urls image_path gender country birthdate death_date height_cm measurements" +
    " career_length ethnicity hair_color eye_color tattoos piercings";

  var PERF_UPDATE_MUTATION = "mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}";

  function normalizedName(s) {
    return String(s || "").normalize("NFC").toLowerCase().replace(/\s+/g, "");
  }

  function loadLocalPerformerFull(id) {
    return callGQL("query($id:ID!){findPerformer(id:$id){" + LOCAL_PERF_FIELDS + "}}", { id: id })
      .then(function (data) { return data.findPerformer; });
  }

  // ── Field mapping (mirrors JavStashLinker: box performer → PerformerUpdateInput) ──

  function emptyVal(v) { return v === undefined || v === null || v === ""; }

  // Stash-box enum value (e.g. MIDDLE_EASTERN) -> Stash display string (e.g. Middle Eastern)
  function enumToDisplay(v) {
    return String(v).toLowerCase().replace(/(^|_)([a-z])/g, function (_, p, c) {
      return (p ? " " : "") + c.toUpperCase();
    });
  }

  // stash-box body modifications [{location, description}] -> Stash free-text string
  function modsToString(list) {
    return (list || []).map(function (t) {
      return t.location + (t.description ? ": " + t.description : "");
    }).join("; ");
  }

  var GENDER_TEXT = {
    FEMALE: ["女", "Female"],
    MALE: ["男", "Male"],
    TRANSGENDER_MALE: ["跨性别男", "Trans male"],
    TRANSGENDER_FEMALE: ["跨性别女", "Trans female"],
    INTERSEX: ["间性", "Intersex"],
    NON_BINARY: ["非二元", "Non-binary"],
  };

  function genderText(v) {
    var pair = GENDER_TEXT[String(v || "").toUpperCase()];
    return pair ? (isZh() ? pair[0] : pair[1]) : "";
  }

  function boxUrls(p) {
    var out = [];
    (p.urls || []).forEach(function (u) {
      var s = typeof u === "string" ? u : (u && u.url) || "";
      if (s) out.push(s);
    });
    return out;
  }

  function urlHost(u) {
    try { return new URL(u).host.replace(/^www\./i, ""); } catch (e) { return String(u || ""); }
  }

  // Case-insensitive trim/dedupe — keeps the first spelling seen
  function dedupeStrings(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (v) {
      var s = (v === undefined || v === null) ? "" : String(v).trim();
      if (!s) return;
      var k = s.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push(s);
    });
    return out;
  }

  function boxMeasurements(p) {
    var parts = [];
    var bust = String(p.band_size || "") + String(p.cup_size || "");
    if (bust) parts.push(bust);
    if (!emptyVal(p.waist_size)) parts.push(p.waist_size);
    if (!emptyVal(p.hip_size)) parts.push(p.hip_size);
    return parts.join("-");
  }

  function boxCareer(p) {
    var s = p.career_start_year, e = p.career_end_year;
    if (!emptyVal(s) && !emptyVal(e)) return s + " - " + e;
    if (!emptyVal(s) || !emptyVal(e)) return String(s || e);
    return "";
  }

  // Local performer has a custom image unless image_path carries "default=true"
  function hasCustomImage(localPerf) {
    var ip = (localPerf && localPerf.image_path) || "";
    return !!ip && ip.indexOf("default=true") === -1;
  }

  function mergeStashIds(existing, endpoint, newId) {
    var ep = String(endpoint || "").toLowerCase();
    var out = [];
    var replaced = false;
    (existing || []).forEach(function (s) {
      if (!s || !s.endpoint) return;
      if (String(s.endpoint).toLowerCase() === ep) {
        out.push({ endpoint: s.endpoint, stash_id: newId });
        replaced = true;
      } else {
        out.push({ endpoint: s.endpoint, stash_id: s.stash_id });
      }
    });
    if (!replaced) out.push({ endpoint: endpoint, stash_id: newId });
    return out;
  }

  // Box performer → detail fields. overwrite=false fills blanks only (identical
  // values never written); overwrite=true lets any box value replace the local one
  // (local-only fields are never cleared — they are simply not part of the input).
  function buildPerfDetailInput(localPerf, p, overwrite) {
    function need(localVal, jsVal) {
      return !emptyVal(jsVal) && (overwrite || emptyVal(localVal)) && jsVal !== localVal;
    }
    var d = {};
    if (need(localPerf.gender, p.gender)) d.gender = p.gender;
    if (need(localPerf.birthdate, p.birth_date)) d.birthdate = p.birth_date;
    if (need(localPerf.death_date, p.death_date)) d.death_date = p.death_date;
    if (need(localPerf.country, p.country)) d.country = p.country;
    var eth = !emptyVal(p.ethnicity) ? enumToDisplay(p.ethnicity) : undefined;
    if (need(localPerf.ethnicity, eth)) d.ethnicity = eth;
    var hair = !emptyVal(p.hair_color) ? enumToDisplay(p.hair_color) : undefined;
    if (need(localPerf.hair_color, hair)) d.hair_color = hair;
    var eye = !emptyVal(p.eye_color) ? enumToDisplay(p.eye_color) : undefined;
    if (need(localPerf.eye_color, eye)) d.eye_color = eye;
    if (need(localPerf.height_cm, p.height)) d.height_cm = p.height;
    var ms = boxMeasurements(p);
    if (ms && (overwrite || emptyVal(localPerf.measurements)) && ms !== localPerf.measurements) {
      d.measurements = ms;
    }
    var cl = boxCareer(p);
    if (cl && (overwrite || emptyVal(localPerf.career_length)) && cl !== localPerf.career_length) {
      d.career_length = cl;
    }
    if (p.tattoos && p.tattoos.length) {
      var tv = modsToString(p.tattoos);
      if ((overwrite || emptyVal(localPerf.tattoos)) && tv !== localPerf.tattoos) d.tattoos = tv;
    }
    if (p.piercings && p.piercings.length) {
      var pv = modsToString(p.piercings);
      if ((overwrite || emptyVal(localPerf.piercings)) && pv !== localPerf.piercings) d.piercings = pv;
    }
    return d;
  }

  // Entry button for the inline lookup — shared by the no-ids panel, the
  // empty/no-match panels and the content-state fallback row.
  function findEntryBtn(size, kind) {
    var btn = makePanelBtn(tc("在源上查找 TA", "Look them up on the source"), kind || "primary", size || "lg");
    btn.title = tc("按名字在各源搜索该演员", "Search this performer by name on the sources");
    btn.onclick = function () {
      _state.findOpen = !_state.findOpen;
      if (!_state.findOpen) {
        _state.findState = "idle";
        _state.findMessage = "";
        _state.findExpandedKey = "";
      }
      renderTabContent();
    };
    return btn;
  }

  // Where the entry button is offered. "Single vs multi source" counts the
  // configured boxes (_state.allBoxes) — the Preferred-box restriction is not
  // a source limit, so it never turns a multi-source setup into a single one.
  function findEntryVisible(vs) {
    var multi = (_state.allBoxes || []).length > 1;
    if (vs === "no-ids") return true;
    if (vs === "empty") return multi || _state.preferredFallback;
    if (vs === "no-match" || vs === "content") return _state.preferredFallback;
    return false;
  }

  function buildFindBlock() {
    var wrap = document.createElement("div");
    wrap.className = "ssd-find";

    var row = document.createElement("div");
    row.className = "ssd-find-row";

    var input = document.createElement("input");
    input.type = "text";
    input.className = "clearable-text-field form-control";
    input.placeholder = tc("演员名", "Performer name");
    input.value = _state.findTerm || _state.performerName || "";

    function submit() {
      var term = (input.value || "").trim();
      if (!term) { input.focus(); return; }
      _state.findTerm = term;
      _state.findState = "loading";
      _state.findMessage = "";
      renderTabContent();
      runFindPerformer(term);
    }

    var goBtn = makePanelBtn(tc("查找", "Search"), "primary", "sm");
    goBtn.onclick = submit;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    row.appendChild(input);
    row.appendChild(goBtn);
    wrap.appendChild(row);

    if (_state.findState === "loading") {
      wrap.appendChild(panelNote(tc("正在各源搜索…", "Searching the sources…"), true, false));
    } else if (_state.findState === "fail") {
      wrap.appendChild(panelNote(tc("搜索失败：", "Search failed: ") + (_state.findMessage || ""), false, true));
    } else if (_state.findState === "empty") {
      wrap.appendChild(panelNote(tc("在源上没找到同名演员。可换一个名字或别名再试，也可以手动在编辑面板里填编号。",
        "No performer with that name on the sources. Try another name or alias, or fill the ID in the edit panel yourself."), false, false));
    } else if (_state.findResults.length) {
      var list = document.createElement("div");
      list.className = "ssd-find-list";
      _state.findResults.forEach(function (r) { list.appendChild(buildFindRow(r)); });
      wrap.appendChild(list);
    }
    return wrap;
  }

  // Accordion key: one expanded result at a time
  function findRowKey(r) {
    return String(r.box.endpoint).toLowerCase() + ":" + String(r.candidate.id);
  }

  // Currently viewed image of the expanded result — "last viewed = selected"
  function selectedImageUrl(r) {
    var imgs = r.candidate.images || [];
    if (!imgs.length) return "";
    var i = (_state.findExpandedKey === findRowKey(r)) ? (_state.findImageIdx || 0) : 0;
    if (i < 0 || i >= imgs.length) i = 0;
    return imgs[i] ? (imgs[i].url || "") : "";
  }

  var FIND_CARET_SVG =
    '<svg viewBox="0 0 320 512" aria-hidden="true"><path fill="currentColor" d="' +
    'M140.3 376.8c12.6 10.2 31.1 9.5 42.8-2.2l128-128c9.2-9.2 11.9-22.9 6.9-34.9S301.4 192 288.5 192' +
    'l-256 0c-12.9 0-24.6 7.8-29.6 19.8S.7 237.5 9.9 246.6l128 128 2.4 2.2z"></path></svg>';

  // "Opens on the source" glyph — the classic external-link mark (box + arrow
  // leaving the top-right corner) instead of a bare ↗ text character.
  var FIND_EXT_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>' +
    '<polyline points="15 3 21 3 21 9"></polyline>' +
    '<line x1="10" y1="14" x2="21" y2="3"></line></svg>';

  // Append the external-link glyph after a button's label
  function appendExtIcon(btn) {
    var ic = document.createElement("span");
    ic.className = "ssd-btn-icon";
    ic.innerHTML = FIND_EXT_SVG;
    btn.appendChild(ic);
    return btn;
  }

  function makeCountryFlag(cc, cls) {
    var img = document.createElement("img");
    img.className = cls || "ssd-find-flag";
    img.src = "https://flagcdn.com/w40/" + cc.toLowerCase() + ".png";
    img.alt = cc;
    img.onerror = function () { img.replaceWith(document.createTextNode(cc)); };
    return img;
  }

  function countryCodeOf(v) {
    var s = String(v || "").toUpperCase().replace(/[^A-Z]/g, "");
    return s.length === 2 ? s : "";
  }

  // ISO-2 → localized region name (reuses the browser's own translations)
  function regionName(cc) {
    try {
      if (typeof Intl !== "undefined" && Intl.DisplayNames) {
        return new Intl.DisplayNames([isZh() ? "zh-CN" : "en"], { type: "region" }).of(cc) || cc;
      }
    } catch (e) { /* unsupported — fall back to the code */ }
    return cc;
  }

  // Small outlined badge for overflow counts (+N) and numeric values
  function makeFindBadge(text) {
    var el = document.createElement("span");
    el.className = "ssd-find-badge";
    el.textContent = text;
    return el;
  }

  // Local performer's stash_id for a given box ("" when not linked to that box)
  function localStashIdForBox(r) {
    var hit = (_state.performerStashIds || []).filter(function (sid) {
      return sid.endpoint && r.box.endpoint
        && String(sid.endpoint).toLowerCase() === String(r.box.endpoint).toLowerCase();
    })[0];
    return hit ? String(hit.stash_id || "") : "";
  }

  // Collapsed row: thumb + name + aliases/gender/flag, source badge, caret.
  // Clicking anywhere on the row toggles the inline detail (accordion).
  function buildFindRow(r) {
    var key = findRowKey(r);
    var expanded = _state.findExpandedKey === key;
    var item = document.createElement("div");
    item.className = "ssd-find-item" + (expanded ? " is-open" : "");

    var main = document.createElement("div");
    main.className = "ssd-find-main";
    main.setAttribute("role", "button");
    main.setAttribute("aria-expanded", expanded ? "true" : "false");

    var imgs = r.candidate.images || [];
    var thumbUrl = imgs.length && imgs[0] ? imgs[0].url : "";
    if (thumbUrl) {
      var img = document.createElement("img");
      img.className = "ssd-find-avatar";
      img.src = thumbUrl;
      img.alt = "";
      img.loading = "lazy";
      main.appendChild(img);
    } else {
      var ph = document.createElement("div");
      ph.className = "ssd-find-avatar ssd-find-avatar--empty";
      ph.textContent = String(r.candidate.name || "?").slice(0, 1).toUpperCase();
      main.appendChild(ph);
    }

    var info = document.createElement("div");
    info.className = "ssd-find-info";
    // Name line: name · flag · gender · age. Only the name is bold/full size;
    // the metadata behind it is small (same size as the alias line) and
    // vertically centred on the name.
    var name = document.createElement("div");
    name.className = "ssd-find-name";
    var nameMain = document.createElement("span");
    nameMain.className = "ssd-find-name-main";
    nameMain.textContent = r.candidate.name || "";
    name.appendChild(nameMain);
    var meta = document.createElement("span");
    meta.className = "ssd-find-meta";
    var cc = countryCodeOf(r.candidate.country);
    if (cc) {
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(makeCountryFlag(cc));
    }
    var gender = genderText(r.candidate.gender);
    if (gender) meta.appendChild(document.createTextNode(" · " + gender));
    var age = birthDateToAge(r.candidate.birth_date);
    if (age) meta.appendChild(document.createTextNode(" · " + tc(age + " 岁", age + "yo")));
    if (meta.childNodes.length) name.appendChild(meta);
    info.appendChild(name);

    // Aliases only, with the hidden count as an outlined badge
    var aliases = r.candidate.aliases || [];
    if (aliases.length) {
      var sub = document.createElement("div");
      sub.className = "ssd-find-sub";
      sub.appendChild(document.createTextNode(aliases.slice(0, 3).join(" / ")));
      if (aliases.length > 3) {
        sub.appendChild(document.createTextNode(" "));
        sub.appendChild(makeFindBadge("+" + (aliases.length - 3)));
      }
      info.appendChild(sub);
    }
    main.appendChild(info);

    // Source badge: same ID = linked (green); same box but another ID = already
    // has one (grey); box not linked at all = plain box label (grey)
    var right = document.createElement("div");
    right.className = "ssd-find-right";
    var localId = localStashIdForBox(r);
    if (localId && localId.toLowerCase() === String(r.candidate.id).toLowerCase()) {
      right.appendChild(makeChip(tc("已关联 " + r.boxName, "Linked · " + r.boxName), "ok"));
    } else if (localId) {
      right.appendChild(makeChip(tc("已有 " + r.boxName, "Has ID · " + r.boxName), "muted"));
    } else {
      right.appendChild(makeChip(r.boxName, "muted"));
    }
    main.appendChild(right);

    var caret = document.createElement("span");
    caret.className = "ssd-find-caret";
    caret.innerHTML = FIND_CARET_SVG;
    main.appendChild(caret);

    main.onclick = function () {
      _state.findExpandedKey = expanded ? "" : key;
      _state.findImageIdx = 0;
      renderTabContent();
    };
    item.appendChild(main);

    if (expanded) item.appendChild(buildFindDetail(r, key));
    return item;
  }

  function findField(label, valueNode) {
    var row = document.createElement("div");
    row.className = "ssd-find-field";
    var l = document.createElement("span");
    l.className = "ssd-find-field-label";
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(valueNode);
    return row;
  }

  function findFieldText(label, text) {
    var v = document.createElement("span");
    v.className = "ssd-find-field-value";
    v.textContent = text;
    return findField(label, v);
  }

  // Expanded detail: big photo viewer (arrows outside, lazy) + fields + actions
  function buildFindDetail(r, key) {
    var p = r.candidate;
    var detail = document.createElement("div");
    detail.className = "ssd-find-detail";

    // ── Photo column ──
    var imgs = (p.images || []).filter(function (i) { return i && i.url; });
    var idx = _state.findImageIdx || 0;
    if (idx < 0 || idx >= imgs.length) idx = 0;

    var photo = document.createElement("div");
    photo.className = "ssd-find-photo";

    var frame = document.createElement("div");
    frame.className = "ssd-find-photo-frame";
    var photoImg = null;
    if (imgs.length) {
      photoImg = document.createElement("img");
      photoImg.className = "ssd-find-photo-img";
      photoImg.alt = "";
      photoImg.src = imgs[idx].url;
      frame.appendChild(photoImg);
    } else {
      var empty = document.createElement("div");
      empty.className = "ssd-find-photo-empty";
      empty.textContent = tc("源无图片", "No image on the source");
      frame.appendChild(empty);
    }

    var counter = document.createElement("span");
    counter.className = "ssd-find-photo-count";
    counter.textContent = imgs.length ? (idx + 1) + " / " + imgs.length : "";
    frame.appendChild(counter);

    var navs = [];
    function navBtn(dir) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "ssd-find-photo-nav";
      b.textContent = dir < 0 ? "\u2039" : "\u203a";
      b.title = dir < 0 ? tc("上一张", "Previous") : tc("下一张", "Next");
      b.disabled = (dir < 0 ? idx <= 0 : idx >= imgs.length - 1);
      b.onclick = function (e) {
        e.stopPropagation();
        var next = idx + dir;
        if (next < 0 || next >= imgs.length) return;
        idx = next;
        _state.findImageIdx = idx;
        if (photoImg) photoImg.src = imgs[idx].url;
        counter.textContent = (idx + 1) + " / " + imgs.length;
        navs.forEach(function (nb) {
          nb.disabled = (nb._ssdDir < 0) ? idx <= 0 : idx >= imgs.length - 1;
        });
      };
      b._ssdDir = dir;
      navs.push(b);
      return b;
    }

    if (imgs.length > 1) photo.appendChild(navBtn(-1));
    photo.appendChild(frame);
    if (imgs.length > 1) photo.appendChild(navBtn(1));
    detail.appendChild(photo);

    // ── Fields column ──
    var col = document.createElement("div");
    col.className = "ssd-find-detail-col";

    var fields = document.createElement("div");
    fields.className = "ssd-find-fields";

    var gender = genderText(p.gender);
    if (gender) fields.appendChild(findFieldText(tc("性别", "Gender"), gender));

    var cc = countryCodeOf(p.country);
    if (cc) {
      var cv = document.createElement("span");
      cv.className = "ssd-find-field-value";
      cv.appendChild(makeCountryFlag(cc));
      cv.appendChild(document.createTextNode(regionName(cc)));
      fields.appendChild(findField(tc("国籍", "Country"), cv));
    } else if (!emptyVal(p.country)) {
      fields.appendChild(findFieldText(tc("国籍", "Country"), String(p.country)));
    }

    if (!emptyVal(p.birth_date)) fields.appendChild(findFieldText(tc("生日", "Birthdate"), p.birth_date));
    if (!emptyVal(p.height)) fields.appendChild(findFieldText(tc("身高", "Height"), p.height + " cm"));
    var ms = boxMeasurements(p);
    if (ms) fields.appendChild(findFieldText(tc("三围", "Measurements"), ms));
    var cl = boxCareer(p);
    if (cl) fields.appendChild(findFieldText(tc("生涯", "Career"), cl));
    if ((p.aliases || []).length) {
      fields.appendChild(findFieldText(tc("别名", "Aliases"), (p.aliases || []).join(" / ")));
    }
    if (!emptyVal(p.disambiguation)) {
      fields.appendChild(findFieldText(tc("消歧说明", "Disambiguation"), p.disambiguation));
    }

    var urls = boxUrls(p);
    if (urls.length) {
      var uv = document.createElement("span");
      uv.className = "ssd-find-field-value ssd-find-links";
      urls.slice(0, 3).forEach(function (u) {
        var a = document.createElement("a");
        a.className = "ssd-find-link";
        a.href = u;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = urlHost(u);
        a.title = u;
        a.onclick = function (e) { e.stopPropagation(); };
        uv.appendChild(a);
      });
      if (urls.length > 3) {
        uv.appendChild(makeFindBadge("+" + (urls.length - 3)));
      }
      fields.appendChild(findField(tc("外部链接", "External links"), uv));
    }

    if (!emptyVal(p.scene_count)) {
      var scv = document.createElement("span");
      scv.className = "ssd-find-field-value";
      scv.appendChild(makeFindBadge(String(p.scene_count)));
      fields.appendChild(findField(tc("源参演数", "Scenes on source"), scv));
    }

    col.appendChild(fields);

    // ── Row feedback (after an action) ──
    var msg = _state.findRowMsg[key];
    if (msg) {
      var mEl = document.createElement("div");
      mEl.className = "ssd-find-rowmsg" + (msg.kind === "error" ? " ssd-find-rowmsg--error" : "");
      mEl.textContent = msg.text;
      col.appendChild(mEl);
    }

    // ── Actions: source link / Link (append) / Overwrite (replace) ──
    var actions = document.createElement("div");
    actions.className = "ssd-find-actions";
    var busy = _state.findBusyKey === key;

    var openBtn = appendExtIcon(makePanelBtn(r.boxName, "secondary", "md"));
    openBtn.title = tc("在源上打开该演员页面", "Open this performer on the source");
    openBtn.disabled = busy;
    openBtn.onclick = function (e) {
      e.stopPropagation();
      window.open(boxWebBase(r.box.endpoint) + "/performers/" + p.id, "_blank", "noopener,noreferrer");
    };
    actions.appendChild(openBtn);

    var linkBtn = makePanelBtn(tc("关联", "Link"), "primary", "md");
    linkBtn.title = tc("写好编号，并把本地空缺的字段和别名补上（不改名、不覆盖已有值）",
      "Write the ID and fill the local blanks (aliases/fields) without overwriting existing values");
    linkBtn.disabled = busy;
    linkBtn.onclick = function (e) {
      e.stopPropagation();
      runFindAction(r, "link", linkBtn);
    };
    actions.appendChild(linkBtn);

    var owBtn = makePanelBtn(tc("覆盖", "Overwrite"), "accent", "md");
    owBtn.title = tc("以源为准覆盖本地别名、图片与字段（本地独有的信息不会删除）",
      "Replace local aliases, image and fields with the source (local-only values are kept)");
    owBtn.disabled = busy;
    owBtn.onclick = function (e) {
      e.stopPropagation();
      armConfirm(owBtn, tc("覆盖", "Overwrite"), tc("确认覆盖？", "Confirm overwrite?"), function () {
        runFindAction(r, "overwrite", owBtn);
      });
    };
    actions.appendChild(owBtn);

    if (busy) {
      var spin = document.createElement("div");
      spin.className = "ssd-spinner ssd-spinner-sm";
      actions.appendChild(spin);
    }

    col.appendChild(actions);
    detail.appendChild(col);
    return detail;
  }

  // Red two-step confirm (same pattern as the scene "Add to Library" button)
  function armConfirm(btn, labelIdle, labelArmed, run) {
    if (btn.getAttribute("data-ssd-armed") !== "1") {
      btn.setAttribute("data-ssd-armed", "1");
      btn.classList.add("ssd-btn-danger");
      btn.textContent = labelArmed;
      clearTimeout(btn._ssdArmTimer);
      btn._ssdArmTimer = setTimeout(function () {
        if (!btn.isConnected) return;
        btn.removeAttribute("data-ssd-armed");
        btn.classList.remove("ssd-btn-danger");
        btn.textContent = labelIdle;
      }, 4000);
      return;
    }
    clearTimeout(btn._ssdArmTimer);
    btn.removeAttribute("data-ssd-armed");
    btn.classList.remove("ssd-btn-danger");
    run();
  }

  // ─── Actions: Link (append) / Overwrite (source wins) ─────────────────────

  function runFindAction(r, mode, btn) {
    var key = findRowKey(r);
    if (_state.findBusyKey) return;
    _state.findBusyKey = key;
    delete _state.findRowMsg[key];
    btn.disabled = true;
    btn.textContent = tc("写入中…", "Writing…");

    var p = r.candidate;
    loadLocalPerformerFull(_state.performerId).then(function (local) {
      if (!local) throw new Error(tc("未找到演员", "Performer not found"));

      var input = { id: _state.performerId };
      input.stash_ids = mergeStashIds(local.stash_ids, r.box.endpoint, p.id);

      if (mode === "overwrite") {
        // Source is authoritative: aliases replaced wholesale, urls replaced,
        // image replaced (unless the source has none)
        input.alias_list = dedupeStrings([p.name].concat(p.aliases || []));
        input.urls = boxUrls(p);
        var selOw = selectedImageUrl(r);
        if (selOw) input.image = selOw;
      } else {
        // Append-only: aliases/urls merged and deduped, blank fields filled,
        // image only when the local performer has none
        input.alias_list = dedupeStrings((local.alias_list || []).concat([p.name]).concat(p.aliases || []));
        input.urls = dedupeStrings((local.urls || []).concat(boxUrls(p)));
        if (!hasCustomImage(local)) {
          var sel = selectedImageUrl(r);
          if (sel) input.image = sel;
        }
      }

      var details = buildPerfDetailInput(local, p, mode === "overwrite");
      Object.keys(details).forEach(function (k) { input[k] = details[k]; });

      return callGQL(PERF_UPDATE_MUTATION, { input: input }).then(function () {
        return { local: local, details: details };
      });
    }).then(function (res) {
      // Optimistic local update so the row badge flips to "linked" right away
      _state.performerStashIds = mergeStashIds(_state.performerStashIds, r.box.endpoint, p.id);
      _state.findBusyKey = "";
      var filled = Object.keys(res.details).length;
      _state.findRowMsg[key] = {
        kind: "ok",
        text: mode === "overwrite"
          ? tc("已覆盖：别名/图片/链接以源为准，补充字段 " + filled + " 项，正在重新查询…",
            "Overwritten from the source — " + filled + " field(s) written. Re-querying…")
          : tc("已关联：补充字段 " + filled + " 项（不改名、不覆盖已有值），正在重新查询…",
            "Linked — " + filled + " blank field(s) filled (name and existing values untouched). Re-querying…"),
      };
      renderTabContent();
      setTimeout(loadMissingScenes, 900);
    }).catch(function (e) {
      _state.findBusyKey = "";
      _state.findRowMsg[key] = {
        kind: "error",
        text: tc("写入失败：", "Write failed: ") + (e && e.message ? e.message : String(e)),
      };
      renderTabContent();
    });
  }

  function runFindPerformer(term) {
    var boxes = (_state.allBoxes && _state.allBoxes.length) ? _state.allBoxes : _state.queryBoxes;
    boxes = (boxes || []).filter(function (b) { return b && b.endpoint; });
    if (boxes.length === 0) {
      _state.findState = "fail";
      _state.findMessage = tc("没有可查询的源", "no source to search");
      renderTabContent();
      return;
    }

    var results = [];
    var failures = [];
    var jobs = boxes.map(function (b) {
      return _boxRateLimiter.submit(function () {
        return callBoxGQL(b.endpoint, b.api_key, SEARCH_PERFORMER_QUERY, { term: term }, 12000);
      }).then(function (data) {
        var list = (data && data.searchPerformer) || [];
        list.forEach(function (p) {
          if (!p || p.deleted) return;
          results.push({ box: b, boxName: sourceLabel(b), candidate: p });
        });
      }).catch(function (e) {
        failures.push({ name: sourceLabel(b), kind: (e && e.ssdKind) || "unknown" });
      });
    });

    Promise.all(jobs).then(function () {
      var norm = normalizedName(term);
      results.sort(function (a, b) {
        var ra = normalizedName(a.candidate.name) === norm ? 0 : 1;
        var rb = normalizedName(b.candidate.name) === norm ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return String(a.candidate.name || "").localeCompare(String(b.candidate.name || ""));
      });
      _state.findResults = results;
      _state.findFailures = failures;
      if (results.length) {
        _state.findState = "done";
      } else if (failures.length === boxes.length) {
        _state.findState = "fail";
        _state.findMessage = failures.map(function (f) {
          return f.name + " " + boxErrText(f.kind, isZh());
        }).join(isZh() ? "；" : "; ");
      } else {
        _state.findState = "empty";
      }
      renderTabContent();
    });
  }

  // ─── "Open edit panel" + watch for a newly written stash-box ID ───────────
  // The plugin already sits on the performer page, so the manual path is the
  // native edit overlay itself: open it and poll until an ID shows up, then
  // re-query on our own instead of asking the user to come back and refresh.

  function openPerformerEditor() {
    // Native detail-header edit button (class "edit" is stable across locales)
    var btn = document.querySelector(".detail-header button.edit")
      || document.querySelector("button.edit.btn-primary")
      || document.querySelector("a[href$='/edit']");
    if (!btn) {
      _state.editWatchMissing = true;
      renderTabContent();
      return;
    }
    _state.editWatchMissing = false;
    btn.click();
    _state.editWatching = true;
    startEditWatch();
    renderTabContent();
  }

  function startEditWatch() {
    stopEditWatch();
    var ticks = 0;
    var seenOpen = false;
    // The edit overlay replaces the whole detail view, so the pane is unmounted
    // while it is up; poll the performer instead and re-query once an ID lands.
    _state._editTimer = setInterval(function () {
      ticks++;
      if (ticks > 90 || !_state.performerId || !isPerformerPage()) {
        stopEditWatch();
        _state.editWatching = false;
        if (isPerformerPage()) renderTabContent();
        return;
      }
      var editing = !!document.querySelector(".detail-header.edit")
        || !!document.querySelector(".modal.show");
      if (editing) seenOpen = true;
      loadLocalPerformer(_state.performerId).then(function (p) {
        if (p) {
          _state.performerStashIds = p.stash_ids || [];
          var linked = (_state.allBoxes || []).some(function (b) {
            return (_state.performerStashIds || []).some(function (sid) {
              return sid.endpoint && sid.stash_id && sid.endpoint.toLowerCase() === b.endpoint.toLowerCase();
            });
          });
          if (linked) {
            stopEditWatch();
            _state.editWatching = false;
            loadMissingScenes();
            return;
          }
        }
        // Overlay closed without an ID → stop instead of nagging for 3 minutes
        if (seenOpen && !editing) {
          stopEditWatch();
          _state.editWatching = false;
          renderTabContent();
        }
      }).catch(function () { /* transient — keep polling */ });
    }, 2000);
  }

  function stopEditWatch() {
    if (_state._editTimer) {
      clearInterval(_state._editTimer);
      _state._editTimer = null;
    }
  }

  // ─── Scene rendering (grid / list) ───────────────────────────────────────

  function renderTabContent() {
    // Drop any orphaned hover popovers from a previous render
    document.querySelectorAll(".popover.hover-popover-content").forEach(function (p) { p.remove(); });

    var pane = document.querySelector(".ssd-tab-pane");
    if (!pane) return;
    pane.innerHTML = "";

    // The filter toolbar only means something when there are cards to filter or
    // lay out; the fallback panels carry their own actions instead
    var panelState = resolveViewState();
    var showToolbar = panelState === "content" || panelState === "no-match";

    // ── Filter toolbar (1:1 Stash native .filtered-list-toolbar) ──
    var toolbar = document.createElement("div");
    toolbar.setAttribute("role", "toolbar");
    toolbar.className = "filtered-list-toolbar btn-toolbar";

    // Search — native .clearable-input-group (clear button appears when text present)
    var searchGroup = document.createElement("div");
    searchGroup.className = "clearable-input-group search-term-input";

    var searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "clearable-text-field form-control";
    searchInput.placeholder = tc("搜索…", "Search…");
    searchInput.value = _state.searchQuery || "";
    var _searchTimer = null;
    // IME safety: skip input events during composition (Chinese/Japanese typing),
    // commit once on compositionend; selection is restored after re-render below.
    searchInput.oninput = function (e) {
      if (e && e.isComposing) return;
      clearTimeout(_searchTimer);
      var val = this.value;
      _state.searchCaret = this.selectionStart;
      _searchTimer = setTimeout(function () {
        _state.searchQuery = val;
        _state.currentPage = 1;
        _state.refocusSearch = true;
        renderTabContent();
      }, 250);
    };
    searchInput.addEventListener("compositionend", function () {
      clearTimeout(_searchTimer);
      _state.searchCaret = searchInput.selectionStart;
      _state.searchQuery = searchInput.value;
      _state.currentPage = 1;
      _state.refocusSearch = true;
      renderTabContent();
    });
    searchGroup.appendChild(searchInput);

    if ((_state.searchQuery || "").length > 0) {
      var clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "clearable-text-field-clear btn btn-secondary";
      clearBtn.title = tc("清除", "Clear");
      clearBtn.innerHTML = "&times;";
      clearBtn.onclick = function () {
        clearTimeout(_searchTimer);
        _state.searchQuery = "";
        _state.currentPage = 1;
        _state.refocusSearch = true;
        renderTabContent();
      };
      searchGroup.appendChild(clearBtn);
    }
    toolbar.appendChild(searchGroup);

    // Sort — date only: toggle opens a dropdown (single item), caret button flips direction
    var sortGroup = document.createElement("div");
    sortGroup.setAttribute("role", "group");
    sortGroup.className = "sort-by-select dropdown btn-group";

    var sortPrep = document.createElement("div");
    sortPrep.className = "input-group-prepend";
    var sortToggle = document.createElement("button");
    sortToggle.type = "button";
    sortToggle.className = "dropdown-toggle btn btn-secondary";
    sortToggle.title = tc("排序字段：日期", "Sort field: date");
    sortToggle.setAttribute("aria-haspopup", "true");
    sortToggle.setAttribute("aria-expanded", "false");
    sortToggle.textContent = tc("日期", "Date");
    sortToggle.onclick = function () {
      var open = sortGroup.classList.toggle("show");
      sortMenu.classList.toggle("show", open);
      sortToggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    sortPrep.appendChild(sortToggle);
    sortGroup.appendChild(sortPrep);

    var sortMenu = document.createElement("div");
    sortMenu.className = "dropdown-menu";
    var dateItem = document.createElement("a");
    dateItem.href = "javascript:void(0)";
    dateItem.className = "dropdown-item active";
    dateItem.setAttribute("role", "button");
    dateItem.textContent = tc("日期", "Date");
    dateItem.onclick = function () {
      sortGroup.classList.remove("show");
      sortMenu.classList.remove("show");
      sortToggle.setAttribute("aria-expanded", "false");
    };
    sortMenu.appendChild(dateItem);
    sortGroup.appendChild(sortMenu);

    var isDesc = _state.sortDir !== "ASC";
    var dirBtn = document.createElement("button");
    dirBtn.type = "button";
    dirBtn.className = "btn btn-secondary";
    dirBtn.title = isDesc ? tc("降序", "Descending") : tc("升序", "Ascending");
    dirBtn.innerHTML =
      '<svg data-prefix="fas" data-icon="caret-down" class="svg-inline--fa fa-caret-down fa-icon" role="img" viewBox="0 0 320 512" aria-hidden="true"' +
      (isDesc ? "" : ' style="transform:rotate(180deg)"') +
      '><path fill="currentColor" d="M140.3 376.8c12.6 10.2 31.1 9.5 42.8-2.2l128-128c9.2-9.2 11.9-22.9 6.9-34.9S301.4 192 288.5 192l-256 0c-12.9 0-24.6 7.8-29.6 19.8S.7 237.5 9.9 246.6l128 128 2.4 2.2z"></path></svg>';
    dirBtn.onclick = function () { changeSort(isDesc ? "ASC" : "DESC"); };
    sortGroup.appendChild(dirBtn);
    toolbar.appendChild(sortGroup);

    // Per-page — native .page-size-selector
    var ppWrap = document.createElement("div");
    ppWrap.className = "page-size-selector";
    var ppSel = document.createElement("select");
    ppSel.className = "btn-secondary form-control";
    [20, 40, 80].forEach(function (n) {
      var opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      if (_state.perPage === n) opt.selected = true;
      ppSel.appendChild(opt);
    });
    ppSel.onchange = function () { changePerPage(parseInt(this.value, 10)); };
    ppWrap.appendChild(ppSel);
    toolbar.appendChild(ppWrap);

    // Refresh — plugin-specific (re-query stash-box)
    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "btn btn-secondary";
    refreshBtn.textContent = tc("刷新", "Refresh");
    refreshBtn.title = tc("重新查询 stash-box", "Re-query stash-box");
    refreshBtn.onclick = function () {
      _state.searchQuery = "";
      loadMissingScenes();
    };
    toolbar.appendChild(refreshBtn);

    // Display mode — native grid/list toggle (same btn-group + icons as the
    // scenes page toolbar); persisted in localStorage
    var displayGroup = document.createElement("div");
    displayGroup.setAttribute("role", "group");
    displayGroup.className = "btn-group";

    var switchDisplayMode = function (mode) {
      if (_state.displayMode === mode) return;
      _state.displayMode = mode;
      try { localStorage.setItem("ssdDisplayMode", mode); } catch (e) {}
      renderTabContent();
    };

    var gridModeBtn = document.createElement("button");
    gridModeBtn.type = "button";
    gridModeBtn.className = "btn btn-secondary" + (_state.displayMode === "grid" ? " active" : "");
    gridModeBtn.title = tc("网格显示", "Grid view");
    gridModeBtn.innerHTML =
      '<svg data-prefix="fas" data-icon="table-cells-large" class="svg-inline--fa fa-table-cells-large fa-icon" role="img" viewBox="0 0 448 512" aria-hidden="true"><path fill="currentColor" d="M384 96l-128 0 0 128 128 0 0-128zm64 128l0 192c0 35.3-28.7 64-64 64L64 480c-35.3 0-64-28.7-64-64L0 96C0 60.7 28.7 32 64 32l320 0c35.3 0 64 28.7 64 64l0 128zM64 288l0 128 128 0 0-128-128 0zm128-64l0-128-128 0 0 128 128 0zm64 64l0 128 128 0 0-128-128 0z"></path></svg>';
    gridModeBtn.onclick = function () { switchDisplayMode("grid"); };

    var listModeBtn = document.createElement("button");
    listModeBtn.type = "button";
    listModeBtn.className = "btn btn-secondary" + (_state.displayMode === "list" ? " active" : "");
    listModeBtn.title = tc("列表显示", "List view");
    listModeBtn.innerHTML =
      '<svg data-prefix="fas" data-icon="list" class="svg-inline--fa fa-list fa-icon" role="img" viewBox="0 0 512 512" aria-hidden="true"><path fill="currentColor" d="M40 48C26.7 48 16 58.7 16 72l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24L40 48zM192 64c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L192 64zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zm0 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l288 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-288 0zM16 232l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0c-13.3 0-24 10.7-24 24zM40 368c-13.3 0-24 10.7-24 24l0 48c0 13.3 10.7 24 24 24l48 0c13.3 0 24-10.7 24-24l0-48c0-13.3-10.7-24-24-24l-48 0z"></path></svg>';
    listModeBtn.onclick = function () { switchDisplayMode("list"); };

    displayGroup.appendChild(gridModeBtn);
    displayGroup.appendChild(listModeBtn);
    toolbar.appendChild(displayGroup);

    // Card size — native zoom slider (0-3); grid only, list rows are fixed
    if (_state.displayMode !== "list") {
      var zoomWrap = document.createElement("div");
      zoomWrap.className = "zoom-slider-container";
      var zoomInput = document.createElement("input");
      zoomInput.type = "range";
      zoomInput.className = "zoom-slider form-control-range";
      zoomInput.min = "0";
      zoomInput.max = "3";
      zoomInput.value = String(_state.zoom);
      zoomInput.title = tc("卡片大小", "Card size");
      zoomInput.oninput = function () {
        _state.zoom = parseInt(this.value, 10) || 0;
        layoutCardGrid();
      };
      zoomWrap.appendChild(zoomInput);
      toolbar.appendChild(zoomWrap);
    }

    if (showToolbar) pane.appendChild(toolbar);

    if (showToolbar && _state.refocusSearch) {
      _state.refocusSearch = false;
      // Restore caret position (focus() alone jumps the caret to the end)
      var caret = _state.searchCaret;
      searchInput.focus();
      if (typeof caret === "number" && caret >= 0 && caret <= searchInput.value.length) {
        try { searchInput.setSelectionRange(caret, caret); } catch (err) { /* type=search etc. */ }
      }
    }

    // ── Non-content states → a single panel instead of bare text ──
    // (scanning / unreachable source / performer without an ID / empty run / fatal)
    var vs = panelState;
    if (vs !== "content") {
      pane.appendChild(buildStatePanel(vs));
      return;
    }

    // The search filtered the discovered cache down to nothing → the no-match
    // panel. This has to be decided before the meta row / inline lookup block
    // are appended, otherwise they stay behind above the panel (and the lookup
    // block would be rendered a second time inside the panel).
    var filtered = getFilteredMissing();
    if (filtered.length === 0) {
      pane.appendChild(buildStatePanel("no-match"));
      return;
    }

    // One meta row above the cards, always in this order: "time window relaxed"
    // chip → its restore button → preferred-source fallback chip → inline lookup
    // entry. Only the parts that apply are rendered. The four are grouped in
    // pairs so a very narrow viewport wraps between them instead of overflowing.
    if (_state.windowRelaxed || _state.preferredFallback) {
      var metaRow = document.createElement("div");
      metaRow.className = "ssd-window-row";

      var winGroup = document.createElement("div");
      winGroup.className = "ssd-window-group";
      var fallbackGroup = document.createElement("div");
      fallbackGroup.className = "ssd-window-group";

      if (_state.windowRelaxed) {
        winGroup.appendChild(makeChip(tc("时间窗口：不限 · 本次", "Time window: unlimited · this session"), "muted"));
        var restoreBtn = makePanelBtn(tc("恢复默认 (" + _state.cfgRecentDays + "/" + _state.cfgPreviewDays + ")",
          "Restore default (" + _state.cfgRecentDays + "/" + _state.cfgPreviewDays + ")"), "secondary", "sm");
        restoreBtn.onclick = function () { setWindowRelaxed(false); };
        winGroup.appendChild(restoreBtn);
      }

      // Preferred source had no ID → the others were queried. Say so; a silent
      // fallback reads as "the Preferred box setting does nothing".
      if (_state.preferredFallback) {
        var fbChip = makeChip(tc(_state.preferredBoxLabel + " 无编号 · 已改查其他源",
          _state.preferredBoxLabel + " has no ID · queried other sources"), "muted");
        fbChip.title = tc("该演员在首选源没有编号，插件改为查询其他有编号的源。可在 设置 → 插件 → stashDiscover 中调整「首选源」。",
          "This performer has no ID on the preferred source, so the other sources that do have one were queried. Change it in Settings → Plugins → stashDiscover.");
        fallbackGroup.appendChild(fbChip);
        if (findEntryVisible("content")) fallbackGroup.appendChild(findEntryBtn("sm", "secondary"));
      }

      if (winGroup.children.length) metaRow.appendChild(winGroup);
      if (fallbackGroup.children.length) metaRow.appendChild(fallbackGroup);
      pane.appendChild(metaRow);

      // Only the content state renders the block here; the panels (no-ids /
      // empty / no-match) render their own copy inside the panel body.
      if (_state.findOpen) pane.appendChild(buildFindBlock());
    }

    // Partial failure: cards are shown, but name the source that is missing
    var partialFail = failedSources();
    if (partialFail.length) {
      var noticeBar = document.createElement("div");
      noticeBar.className = "ssd-notice-bar";
      var noticeText = document.createElement("span");
      noticeText.className = "ssd-notice-text";
      noticeText.textContent = tc(
        partialFail.map(function (f) { return f.name + " 查询失败（" + boxErrText(f.kind, true) + "）"; }).join("；")
          + " · 结果可能不完整",
        partialFail.map(function (f) { return f.name + " failed (" + boxErrText(f.kind, false) + ")"; }).join("; ")
          + " — the result may be incomplete");
      noticeBar.appendChild(noticeText);
      var noticeRetry = makePanelBtn(tc("重试", "Retry"), "secondary", "sm");
      noticeRetry.onclick = retryLoad;
      noticeBar.appendChild(noticeRetry);
      pane.appendChild(noticeBar);
    }

    // Current page slice (filtered by search query if active)
    var start = (_state.currentPage - 1) * _state.perPage;
    var pageItems = filtered.slice(start, start + _state.perPage);

    if (pageItems.length === 0 && filtered.length > 0) {
      // Search filtered out current page — reset to page 1
      _state.currentPage = 1;
      start = 0;
      pageItems = filtered.slice(0, _state.perPage);
    }

    var isSearching = (_state.searchQuery || "").trim().length > 0;
    // Pages the local cache already covers — always known, even mid-lazy-load
    var knownPages = Math.max(1, Math.ceil(filtered.length / _state.perPage));
    var totalPages = isSearching || _state.allLoaded
      ? knownPages
      : Math.max(knownPages, _state.currentPage + 1);

    // ── Result count — between the filter toolbar and the cards ──
    var countInfo = document.createElement("div");
    countInfo.className = "ssd-count-info ssd-count-line text-muted";
    if (_state.allLoaded || isSearching) {
      if (isSearching) {
        // Search filters the already-discovered cache — show matched vs discovered
        countInfo.textContent = tc("第 " + _state.currentPage + " / " + totalPages + " 页 · 匹配 " + filtered.length + " / " + _state.cachedMissing.length + " 个",
          "Page " + _state.currentPage + " of " + totalPages + " · " + filtered.length + " matched / " + _state.cachedMissing.length + " found");
      } else {
        countInfo.textContent = tc("第 " + _state.currentPage + " / " + totalPages + " 页 · 共 " + filtered.length + " 个",
          "Page " + _state.currentPage + " of " + totalPages + " · " + filtered.length + " total");
      }
    } else {
      // Not all box pages fetched yet — results load on demand while paging
      countInfo.textContent = tc("第 " + _state.currentPage + " 页 · 已发现 " + filtered.length + " 个（翻页加载更多）",
        "Page " + _state.currentPage + " · " + filtered.length + " found (more load as you page)");
    }
    pane.appendChild(countInfo);

    if (_state.displayMode === "list") {
      pane.appendChild(buildSceneTable(pageItems));
    } else {
      var grid = document.createElement("div");
      grid.className = "ssd-card-grid";
      pageItems.forEach(function (item, idx) {
        grid.appendChild(buildSceneCard(item, start + idx));
      });
      pane.appendChild(grid);
      layoutCardGrid();
    }

    // ── Pagination controls (native .pagination.btn-group: arrows + page numbers) ──
    var pager = document.createElement("div");
    pager.className = "ssd-pager";

    var pg = document.createElement("div");
    pg.setAttribute("role", "group");
    pg.className = "pagination btn-group";

    var prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "btn btn-secondary";
    prevBtn.title = tc("上一页", "Previous");
    prevBtn.innerHTML = "&lt;";
    prevBtn.disabled = _state.currentPage <= 1 || _state.loadingPage;
    prevBtn.onclick = function () { goToPage(_state.currentPage - 1); };
    pg.appendChild(prevBtn);

    // Page numbers: show every page the local cache already covers; while
    // lazy-loading, the > arrow keeps fetching further pages on demand
    var startPage = Math.max(1, _state.currentPage - 2);
    var endPage = Math.min(knownPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
    for (var pn = startPage; pn <= endPage; pn++) {
      pg.appendChild(makePageButton(pn, pn === _state.currentPage));
    }

    var canNext = isSearching
      ? _state.currentPage < knownPages
      : (_state.allLoaded ? _state.currentPage < knownPages : true);
    var nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn btn-secondary";
    nextBtn.title = tc("下一页", "Next");
    nextBtn.innerHTML = "&gt;";
    nextBtn.disabled = !canNext || _state.loadingPage;
    nextBtn.onclick = function () { goToPage(_state.currentPage + 1); };
    pg.appendChild(nextBtn);

    pager.appendChild(pg);
    pane.appendChild(pager);
  }

  function makePageButton(pageNum, isActive) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "page-count btn btn-secondary" + (isActive ? " active" : "");
    b.textContent = String(pageNum);
    b.onclick = function () { goToPage(pageNum); };
    return b;
  }

  function getFilteredMissing() {
    var q = (_state.searchQuery || "").trim().toLowerCase();
    if (!q) return _state.cachedMissing;
    return _state.cachedMissing.filter(function (item) {
      var sc = item.scene || {};
      var haystack = [
        sc.title, sc.code, sc.details,
        sc.studio && sc.studio.name,
        sc.director,
        (sc.performers || []).map(function (p) {
          return p.performer && p.performer.name;
        }).join(" "),
        (sc.tags || []).map(function (t) { return t.name; }).join(" "),
        item.boxName,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.indexOf(q) !== -1;
    });
  }

  // Native SceneCardGrid zoom formula:
  //   maxUsable = containerWidth - 30
  //   cols      = ceil(maxUsable / zoomWidths[zoom])
  //   cardWidth = maxUsable / cols - 10   (cards carry 5px margins → 10px gap)
  var ZOOM_WIDTHS = [280, 340, 480, 640];

  function layoutCardGrid() {
    var grid = document.querySelector(".ssd-card-grid");
    if (!grid) return;
    var maxUsable = Math.max(120, grid.clientWidth - 30);
    var cols = Math.max(1, Math.ceil(maxUsable / ZOOM_WIDTHS[_state.zoom]));
    var cardW = maxUsable / cols - 10;
    var cards = grid.querySelectorAll(".scene-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.width = cardW + "px";
    }
  }

  // ── List view — 1:1 native .table-list.scene-table (scene list table) ──
  // Structure captured from the native scenes page list mode; themes apply
  // automatically via native class names. No select-col (no bulk operations).
  function buildSceneTable(pageItems) {
    var wrap = document.createElement("div");
    wrap.className = "table-list scene-table ssd-scene-table";

    var table = document.createElement("table");
    table.className = "table table-striped table-bordered";

    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    [
      ["cover_image", tc("封面图片", "Cover")],
      ["title", tc("标题", "Title")],
      ["date", tc("日期", "Date")],
      ["scene_code", tc("工作室代码", "Studio Code")],
      ["duration", tc("时长", "Duration")],
      ["studio", tc("工作室", "Studio")],
      ["performers", tc("演员", "Performers")],
      ["tags", tc("标签", "Tags")],
    ].forEach(function (col) {
      var th = document.createElement("th");
      th.className = col[0] + "-head";
      th.textContent = col[1];
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    var borderRow = document.createElement("tr");
    var borderTh = document.createElement("th");
    borderTh.className = "border-row";
    borderTh.colSpan = 100;
    borderRow.appendChild(borderTh);
    thead.appendChild(borderRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    pageItems.forEach(function (item) {
      tbody.appendChild(buildSceneRow(item));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
  }

  function buildSceneRow(item) {
    var sc = item.scene;
    var tr = document.createElement("tr");

    // Cover — click opens the same detail modal as grid cards
    var coverTd = document.createElement("td");
    coverTd.className = "cover_image-data";
    var coverLink = document.createElement("a");
    coverLink.href = "javascript:void(0)";
    coverLink.onclick = function () { openModal(item); };
    if (item.images.length > 0) {
      var img = document.createElement("img");
      img.loading = "lazy";
      img.className = "image-thumbnail";
      img.alt = sc.title || sc.code || "";
      img.src = item.images[0].url;
      img.onerror = function () { this.style.visibility = "hidden"; };
      coverLink.appendChild(img);
    }
    coverTd.appendChild(coverLink);
    tr.appendChild(coverTd);

    // Title — opens the stash-box scene page in a new tab (does NOT open the modal)
    var titleTd = document.createElement("td");
    titleTd.className = "title-data";
    var titleLink = document.createElement("a");
    titleLink.href = boxSceneUrl(item.endpoint, sc.id);
    titleLink.target = "_blank";
    titleLink.rel = "noopener noreferrer";
    titleLink.title = sc.title || sc.code || "";
    var titleSpan = document.createElement("span");
    titleSpan.className = "ellips-data";
    titleSpan.textContent = sc.title || sc.code || tc("无标题", "Untitled");
    titleLink.appendChild(titleSpan);
    titleTd.appendChild(titleLink);
    tr.appendChild(titleTd);

    // Date / studio code / duration — plain cells
    var dateTd = document.createElement("td");
    dateTd.className = "date-data";
    dateTd.textContent = sc.release_date || "";
    tr.appendChild(dateTd);

    var codeTd = document.createElement("td");
    codeTd.className = "scene_code-data";
    codeTd.textContent = sc.code || "";
    tr.appendChild(codeTd);

    var durTd = document.createElement("td");
    durTd.className = "duration-data";
    durTd.textContent = sc.duration ? formatDuration(sc.duration) : "";
    tr.appendChild(durTd);

    // Studio — plain ellips-data (plugin rows have no filter-target pages)
    var studioTd = document.createElement("td");
    studioTd.className = "studio-data";
    if (sc.studio && sc.studio.name) {
      var studioSpan = document.createElement("span");
      studioSpan.className = "ellips-data";
      studioSpan.textContent = sc.studio.name;
      studioTd.appendChild(studioSpan);
    }
    tr.appendChild(studioTd);

    // Performers — native comma-list, plain <li><span> (no filter links)
    var perfTd = document.createElement("td");
    perfTd.className = "performers-data";
    var perfUl = document.createElement("ul");
    perfUl.className = "comma-list overflowable";
    (sc.performers || []).forEach(function (p) {
      var name = (p && p.performer && p.performer.name) || "";
      if (!name) return;
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.textContent = name;
      li.appendChild(span);
      perfUl.appendChild(li);
    });
    perfTd.appendChild(perfUl);
    tr.appendChild(perfTd);

    // Tags — same comma-list structure
    var tagTd = document.createElement("td");
    tagTd.className = "tags-data";
    var tagUl = document.createElement("ul");
    tagUl.className = "comma-list overflowable";
    (sc.tags || []).forEach(function (t) {
      var name = (t && t.name) || "";
      if (!name) return;
      var li = document.createElement("li");
      var span = document.createElement("span");
      span.textContent = name;
      li.appendChild(span);
      tagUl.appendChild(li);
    });
    tagTd.appendChild(tagUl);
    tr.appendChild(tagTd);

    return tr;
  }

  function buildSceneCard(item, idx) {
    var sc = item.scene;

    // Native Stash grid-card structure (themes apply automatically):
    //   .scene-card.grid-card.card > .video-section (.scene-card-preview +
    //   .studio-overlay + .scene-specs-overlay) + .card-section (title/date/desc)
    var card = document.createElement("div");
    card.className = "scene-card zoom-" + _state.zoom + " grid-card card ssd-scene-card";

    var videoSection = document.createElement("div");
    videoSection.className = "video-section thumbnail-section";

    var preview = document.createElement("div");
    preview.className = "scene-card-preview";

    if (item.images.length > 0) {
      var img = document.createElement("img");
      img.className = "scene-card-preview-image";
      img.loading = "lazy";
      img.src = item.images[0].url;
      img.alt = sc.title || sc.code || "";
      img.onerror = function () { this.style.visibility = "hidden"; };
      preview.appendChild(img);
    }

    // Box source pill — bottom-left corner (native has no fixed content there),
    // only meaningful with multiple stash-boxes
    if (_state.queryBoxes.length > 1) {
      var boxBadge = document.createElement("span");
      boxBadge.className = "ssd-overlay-box";
      boxBadge.textContent = item.boxName;
      preview.appendChild(boxBadge);
    }

    // Preview pill for future-dated scenes — top-left corner
    if (sc.release_date && sc.release_date > localDateStr(new Date())) {
      var prevBadge = document.createElement("span");
      prevBadge.className = "ssd-overlay-preview";
      prevBadge.textContent = tc("预告", "Preview");
      preview.appendChild(prevBadge);
    }

    videoSection.appendChild(preview);

    // Studio name — top-right (native .studio-overlay)
    if (sc.studio && sc.studio.name) {
      var studioEl = document.createElement("div");
      studioEl.className = "studio-overlay";
      var studioLink = document.createElement("a");
      studioLink.href = "javascript:void(0)";
      studioLink.textContent = sc.studio.name;
      studioEl.appendChild(studioLink);
      videoSection.appendChild(studioEl);
    }

    // Duration — bottom-right (native .scene-specs-overlay)
    if (sc.duration) {
      var specs = document.createElement("div");
      specs.className = "scene-specs-overlay";
      var dur = document.createElement("span");
      dur.className = "overlay-duration";
      dur.textContent = formatDuration(sc.duration);
      specs.appendChild(dur);
      videoSection.appendChild(specs);
    }

    card.appendChild(videoSection);

    // Below cover: title / date / intro (native .card-section layout)
    var cardSection = document.createElement("div");
    cardSection.className = "card-section";

    var title = document.createElement("h5");
    title.className = "card-section-title flex-aligned";
    var titleText = document.createElement("div");
    titleText.className = "TruncatedText";
    titleText.style.setProperty("-webkit-line-clamp", "2");
    titleText.textContent = sc.title || sc.code || tc("无标题", "Untitled");
    title.appendChild(titleText);
    cardSection.appendChild(title);

    var details = document.createElement("div");
    details.className = "scene-card__details";

    if (sc.release_date) {
      var date = document.createElement("span");
      date.className = "scene-card__date";
      date.textContent = sc.release_date;
      details.appendChild(date);
    }

    if (sc.details) {
      var desc = document.createElement("div");
      desc.className = "TruncatedText scene-card__description";
      desc.style.setProperty("-webkit-line-clamp", "3");
      desc.textContent = sc.details;
      details.appendChild(desc);
    }

    cardSection.appendChild(details);

    // Native-style popover badges below the text: tag count + performer count
    var performers = (sc.performers || []).map(function (p) { return p.performer; }).filter(Boolean);
    var tags = (sc.tags || []).filter(Boolean);
    if (performers.length > 0 || tags.length > 0) {
      cardSection.appendChild(document.createElement("hr"));

      var popovers = document.createElement("div");
      popovers.setAttribute("role", "group");
      popovers.className = "card-popovers btn-group";

      if (tags.length > 0) {
        var tagCount = document.createElement("div");
        tagCount.className = "tag-count";
        var tagBtn = document.createElement("button");
        tagBtn.type = "button";
        tagBtn.className = "minimal btn btn-primary";
        tagBtn.title = tc("标签", "Tags");
        tagBtn.innerHTML = SSD_ICON_TAG + "<span>" + tags.length + "</span>";
        attachHoverPopover(tagBtn, function () { return buildTagPopoverContent(tags); });
        tagCount.appendChild(tagBtn);
        popovers.appendChild(tagCount);
      }

      if (performers.length > 0) {
        var perfCount = document.createElement("div");
        perfCount.className = "performer-count";
        var perfBtn = document.createElement("button");
        perfBtn.type = "button";
        perfBtn.className = "minimal btn btn-primary";
        perfBtn.title = tc("演员", "Performers");
        perfBtn.innerHTML = SSD_ICON_USER + "<span>" + performers.length + "</span>";
        attachHoverPopover(perfBtn, function () {
          return buildPerformerPopoverContent(performers, item.endpoint);
        });
        perfCount.appendChild(perfBtn);
        popovers.appendChild(perfCount);
      }

      cardSection.appendChild(popovers);
    }

    card.appendChild(cardSection);

    card.onclick = function () { openModal(item); };
    return card;
  }

  // ─── Hover popovers on card badges (mimics native .hover-popover-content) ──

  var SSD_ICON_TAG =
    '<svg data-prefix="fas" data-icon="tag" class="svg-inline--fa fa-tag fa-icon" role="img" viewBox="0 0 512 512" aria-hidden="true">' +
    '<path fill="currentColor" d="M32.5 96l0 149.5c0 17 6.7 33.3 18.7 45.3l192 192c25 25 65.5 25 90.5 0L483.2 333.3c25-25 25-65.5 0-90.5l-192-192C279.2 38.7 263 32 246 32L96.5 32c-35.3 0-64 28.7-64 64zm112 16a32 32 0 1 1 0 64 32 32 0 1 1 0-64z"></path></svg>';
  var SSD_ICON_USER =
    '<svg data-prefix="fas" data-icon="user" class="svg-inline--fa fa-user fa-icon" role="img" viewBox="0 0 448 512" aria-hidden="true">' +
    '<path fill="currentColor" d="M224 248a120 120 0 1 0 0-240 120 120 0 1 0 0 240zm-29.7 56C95.8 304 16 383.8 16 482.3 16 498.7 29.3 512 45.7 512l356.6 0c16.4 0 29.7-13.3 29.7-29.7 0-98.5-79.8-178.3-178.3-178.3l-59.4 0z"></path></svg>';

  // Show a hover-only popover under `el`; `buildContent()` returns a Node.
  // The popover is hoverable (mouse can rest on it without hiding) but fully
  // inert — clicks are swallowed so the scene modal never opens.
  function attachHoverPopover(el, buildContent) {
    var pop = null;
    var hideTimer = null;

    function show() {
      clearTimeout(hideTimer);
      if (pop && pop.parentNode) return;
      pop = document.createElement("div");
      pop.className = "popover hover-popover-content bs-popover-bottom show";
      pop.setAttribute("role", "tooltip");
      // Hoverable so the popover stays visible while the mouse is on it,
      // but no interaction is possible (display-only, never clickable)
      pop.style.pointerEvents = "auto";
      pop.style.cursor = "default";
      var arrow = document.createElement("div");
      arrow.className = "arrow";
      // Bootstrap's .arrow has no `left` and `margin: 0 .5rem` → it sits on
      // the left edge; center it on the popover's top edge instead
      arrow.style.left = "50%";
      arrow.style.margin = "0";
      arrow.style.transform = "translateX(-50%)";
      pop.appendChild(arrow);
      // Native hover popovers wrap content in .popover-body (padding, themed text)
      var body = document.createElement("div");
      body.className = "popover-body";
      body.appendChild(buildContent());
      pop.appendChild(body);
      document.body.appendChild(pop);

      var r = el.getBoundingClientRect();
      var pw = pop.offsetWidth;
      var left = r.left + r.width / 2 - pw / 2 + window.scrollX;
      left = Math.max(8, Math.min(left,
        window.scrollX + document.documentElement.clientWidth - pw - 8));
      pop.style.left = left + "px";
      pop.style.top = (r.bottom + window.scrollY + 6) + "px";

      // Keep the popover open while the mouse rests on it; the 150ms grace
      // period in hide() covers the badge → popover crossing
      pop.addEventListener("mouseenter", function () { clearTimeout(hideTimer); });
      pop.addEventListener("mouseleave", hide);
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
    }

    function hide() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
        pop = null;
      }, 150);
    }

    el.addEventListener("mouseenter", show);
    el.addEventListener("mouseleave", hide);
    // Badge clicks must not open the scene modal
    el.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  function buildTagPopoverContent(tags) {
    var frag = document.createDocumentFragment();
    tags.forEach(function (t) {
      var span = document.createElement("span");
      span.className = "tag-item tag-link badge badge-secondary";
      span.textContent = t.name || "";
      frag.appendChild(span);
    });
    return frag;
  }

  function buildPerformerPopoverContent(performers, endpoint) {
    var frag = document.createDocumentFragment();
    var localMap = (_state.localPerformerMaps || {})[(endpoint || "").toLowerCase()] || {};

    var local = [];
    var remote = [];
    performers.forEach(function (p) {
      var lp = localMap[String(p.id).toLowerCase()];
      if (lp) local.push({ p: p, lp: lp });
      else remote.push(p);
    });

    function localRow(p, lp) {
      var row = document.createElement("div");
      row.className = "performer-tag-container row";
      var imgWrap = document.createElement("div");
      imgWrap.className = "performer-tag col m-auto zoom-2";
      var img = document.createElement("img");
      img.className = "image-thumbnail";
      img.alt = p.name || "";
      img.src = "/performer/" + lp.id + "/image";
      imgWrap.appendChild(img);
      row.appendChild(imgWrap);
      var name = document.createElement("span");
      name.className = "tag-item tag-link d-block badge badge-secondary";
      name.textContent = p.name || "";
      row.appendChild(name);
      return row;
    }

    function remoteRow(p) {
      var name = document.createElement("span");
      // No d-block: names flow side by side like the native tag popover badges
      name.className = "tag-item tag-link badge badge-secondary";
      name.textContent = p.name || "";
      return name;
    }

    // Local performers first (avatar + name), then non-local (name only)
    local.forEach(function (x) { frag.appendChild(localRow(x.p, x.lp)); });
    remote.forEach(function (p) { frag.appendChild(remoteRow(p)); });
    return frag;
  }

  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return "";
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
    return m + ":" + pad(s);
  }

  // ─── Modal ────────────────────────────────────────────────────────────────

  var _modalEl = null;
  var _carouselIdx = 0;
  var _modalImages = []; // current open modal's image URL list (cover + DMM shots)
  var _modalGalleryDone = false;
  var _searchPage = 1;
  var _searchPerPage = 20;
  var _searchResults = [];

  function openModal(item) {
    _state.modal = item;
    _state.modalDetail = null;
    _state.modalLoading = true;
    hidePerformerCard();
    _carouselIdx = 0;
    _modalImages = (item.images || []).map(function (i) { return i.url; });
    _modalGalleryDone = false;
    _searchPage = 1;
    _searchResults = [];
    buildModal(item);

    // Fetch full detail in background
    fetchBoxSceneDetail(item.box, item.scene.id).then(function (detail) {
      if (detail) {
        _state.modalDetail = detail;
        _state.modalLoading = false;
        updateModalDetail(detail);
        // Then probe DMM for screenshots (box images only carry the cover)
        probeModalGallery(detail, item);
      } else {
        _state.modalLoading = false;
      }
    }).catch(function (e) {
      console.warn("[SSD] scene detail fetch failed:", e);
      _state.modalLoading = false;
    });
  }

  function closeModal() {
    hidePerformerCard();
    if (_modalEl) { _modalEl.remove(); _modalEl = null; }
    _state.modal = null;
    _state.modalDetail = null;
    _state.modalLoading = false;
  }

  function buildModal(item) {
    if (_modalEl) _modalEl.remove();

    var overlay = document.createElement("div");
    overlay.className = "ssd-modal-overlay";
    overlay.onclick = function (e) { if (e.target === overlay) closeModal(); };

    var modal = document.createElement("div");
    modal.className = "ssd-modal";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "ssd-modal-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.onclick = closeModal;
    modal.appendChild(closeBtn);

    // Section 1: Carousel (cover + screenshots)
    var carouselSection = document.createElement("div");
    carouselSection.className = "ssd-modal-section";
    carouselSection.style.padding = "0";
    carouselSection.appendChild(buildCarousel(_modalImages, item.scene));
    modal.appendChild(carouselSection);

    // Section 2: Action buttons
    var actionSection = document.createElement("div");
    actionSection.className = "ssd-modal-section";
    var btnRow = document.createElement("div");
    btnRow.className = "ssd-action-row";

    var saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ssd-btn ssd-btn-primary ssd-btn-lg";
    saveBtn.textContent = tc("加入库", "Add to Library");
    saveBtn.onclick = function () { handleSaveScene(item, saveBtn); };
    btnRow.appendChild(saveBtn);

    var openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "ssd-btn ssd-btn-secondary ssd-btn-lg";
    openBtn.textContent = brandNameForEndpoint(item.endpoint);
    appendExtIcon(openBtn);
    openBtn.setAttribute("data-ssd-open-btn", "");
    openBtn.onclick = function () { handleOpenInBox(item); };
    btnRow.appendChild(openBtn);

    var searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "ssd-btn ssd-btn-accent ssd-btn-lg";
    searchBtn.textContent = tc("搜索资源", "Search Resources");
    searchBtn.onclick = function () { handleSearchResources(item, searchBtn); };
    btnRow.appendChild(searchBtn);

    actionSection.appendChild(btnRow);
    modal.appendChild(actionSection);

    // Section 3: Details (placeholder — filled by updateModalDetail)
    var details = document.createElement("div");
    details.className = "ssd-modal-section";
    details.setAttribute("data-ssd-details", "");
    renderDetailsInto(details, item.scene, item);
    modal.appendChild(details);

    // Section 4: Search results
    var searchSection = document.createElement("div");
    searchSection.className = "ssd-modal-section";
    searchSection.setAttribute("data-ssd-search", "");
    modal.appendChild(searchSection);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    _modalEl = overlay;

    updateOpenButtonLabel(item);

    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onEsc); }
    });
  }

  function updateOpenButtonLabel(item) {
    var btn = document.querySelector("[data-ssd-open-btn]");
    if (!btn) return;
    var brand = brandNameForEndpoint(item.endpoint);
    // textContent wipes any children, so the trailing glyph has to be rebuilt
    // every time the label changes (otherwise the icon is silently dropped)
    btn.textContent = brand;
    appendExtIcon(btn);
  }

  // ─── DMM gallery screenshot probing ──────────────────────────────────────
  // stash-box scenes only carry the cover in images[]; screenshots live on the
  // DMM CDN. contentId comes from the r18.dev URL in scene.urls (only reliable
  // source — some labels can't be derived from the code).
  var DMM_GALLERY_BASE = "https://awsimgsrc.dmm.com/dig/digital/video";
  var R18_JSON_BASE = "https://r18.dev/videos/vod/movies/detail/-/combined";
  var DMM_MAX_IMAGES = 60;
  var DMM_PROBE_BATCH = 6;
  var DMM_CONFIRM_BATCH = 3;
  var _dmmGalleryCache = {}; // contentId -> Promise<string[]>

  function contentIdFromR18Url(url) {
    var m = String(url || "").match(
      /r18\.dev\/videos\/vod\/movies\/detail\/-\/id=([A-Za-z0-9]+)/
    );
    return m ? m[1] : null;
  }

  function deriveContentId(code) {
    if (!code) return null;
    var m = String(code).trim().match(/^([A-Za-z]{2,10})-(\d{2,6})$/);
    if (!m) return null;
    return padDmmContentId(m[1] + m[2]);
  }

  // DMM content ids zero-pad the numeric part to 5 digits ("OFJE-614" →
  // "ofje00614"). r18.dev ids drop that padding, and an unpadded id makes every
  // CDN shot number resolve to DMM's 90px "no image" placeholder.
  function padDmmContentId(id) {
    var m = String(id || "").match(/^([A-Za-z]+)(\d+)$/);
    return m ? m[1].toLowerCase() + m[2].padStart(5, "0") : String(id || "");
  }

  function dmmGalleryUrl(contentId, n) {
    return DMM_GALLERY_BASE + "/" + contentId + "/" + contentId + "jp-" + n + ".jpg";
  }

  // r18's gallery entries point at "<host>/<dir>/<cid>(jp)?-<n>.jpg" — the real
  // full-size shots are always "<host>/<dir>/<cid>jp-<n>.jpg" beside them, while
  // the id r18 was queried with is not reliable (r18 drops the CDN's zero
  // padding: "ofje614" resolves every shot to DMM's 90px placeholder). So rebuild
  // each shot from the entry's own directory + content id + number, which keeps
  // the host/path right for every service and always carries the padding.
  // Returns "" when the entry carries no shot name to work from.
  function dmmShotUrl(entry) {
    var u = String((entry && (entry.image_full || entry.image_thumb)) || "");
    var m = u.match(/^(.*\/)(.+?)(?:jp)?-(\d+)\.jpg(\?.*)?$/i);
    if (!m) return "";
    return m[1] + m[2] + "jp-" + m[3] + ".jpg" + (m[4] || "");
  }

  // Primary: r18.dev JSON returns gallery[] in one request (CORS *).
  function fetchDmmGalleryJson(contentId) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    return fetch(R18_JSON_BASE + "=" + contentId + "/json",
      ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) { if (!res.ok) return null; return res.json(); })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        var gallery = data && data.gallery;
        if (!Array.isArray(gallery) || gallery.length === 0) return null;
        var urls = [];
        for (var i = 0; i < gallery.length; i++) {
          var shot = dmmShotUrl(gallery[i]);
          if (shot) urls.push(shot);
        }
        // Nothing derivable → let the enumeration fallback probe the CDN instead
        return urls.length ? urls : null;
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }

  // Single-image probe via Image(); DMM returns a 90px placeholder with HTTP 200
  // for missing numbers, so filter by natural dimensions (real shots ≥300px).
  function probeDmmImage(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return; done = true;
        img.src = ""; resolve(false);
      }, 10000);
      img.onload = function () {
        if (done) return; done = true;
        clearTimeout(timer);
        resolve(img.naturalWidth >= 300 && img.naturalHeight >= 200);
      };
      img.onerror = function () {
        if (done) return; done = true;
        clearTimeout(timer); resolve(false);
      };
      img.src = url;
    });
  }

  // Fallback: enumerate {id}jp-N.jpg in adaptive batches.
  function probeDmmByEnumeration(contentId, onImage) {
    var found = [];
    var n = 1;
    var batch = DMM_PROBE_BATCH;
    function step() {
      if (n > DMM_MAX_IMAGES) return Promise.resolve(found);
      var nums = [];
      for (var k = 0; k < batch && n + k <= DMM_MAX_IMAGES; k++) nums.push(n + k);
      return Promise.all(nums.map(function (num) {
        return probeDmmImage(dmmGalleryUrl(contentId, num)).then(function (ok) {
          return { num: num, ok: ok };
        });
      })).then(function (results) {
        var anyOk = false, anyMiss = false;
        results.forEach(function (r) {
          if (r.ok) {
            anyOk = true;
            var u = dmmGalleryUrl(contentId, r.num);
            found.push(u);
            if (onImage) onImage(u);
          } else {
            anyMiss = true;
          }
        });
        if (!anyOk) return found;
        batch = anyMiss ? DMM_CONFIRM_BATCH : DMM_PROBE_BATCH;
        n += nums.length;
        return step();
      });
    }
    return step();
  }

  // Two-channel probe with session cache.
  function probeDmmGallery(contentId, onImage) {
    if (_dmmGalleryCache[contentId]) return _dmmGalleryCache[contentId];
    // The enumeration fallback hits the CDN path directly, which keeps the zero
    // padding r18 dropped. It size-filters every candidate, so a wrong padding
    // guess can only lose shots — it can never add placeholder slides.
    var dmmId = padDmmContentId(contentId);
    var p = fetchDmmGalleryJson(contentId).then(function (viaJson) {
      if (viaJson && viaJson.length) return viaJson;
      return probeDmmByEnumeration(dmmId, onImage);
    });
    _dmmGalleryCache[contentId] = p;
    return p;
  }

  // images: array of URL strings (lazy-loaded, only the current one is fetched)
  function buildCarousel(images, sc) {
    var carousel = document.createElement("div");
    carousel.className = "ssd-carousel";
    carousel.setAttribute("data-ssd-carousel", "");

    if (images.length > 0) {
      if (_carouselIdx >= images.length) _carouselIdx = 0;
      var startIdx = _carouselIdx;
      var hero = document.createElement("div");
      hero.className = "ssd-carousel-hero";
      hero.setAttribute("data-ssd-carousel-hero", "");
      // Lazy: only load current image; honor current index so
      // progressive gallery remounts don't snap the viewer back to the cover.
      hero.style.backgroundImage = "url('" + images[startIdx] + "')";

      // Always show nav buttons (disabled when only 1 image); gallery probe may add more
      var prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "ssd-carousel-nav ssd-carousel-prev";
      prevBtn.innerHTML = "&#10094;";
      prevBtn.disabled = images.length <= 1;
      prevBtn.onclick = function (e) {
        e.stopPropagation();
        if (images.length <= 1) return;
        _carouselIdx = (_carouselIdx - 1 + images.length) % images.length;
        updateCarouselImage(images);
      };
      hero.appendChild(prevBtn);

      var nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "ssd-carousel-nav ssd-carousel-next";
      nextBtn.innerHTML = "&#10095;";
      nextBtn.disabled = images.length <= 1;
      nextBtn.onclick = function (e) {
        e.stopPropagation();
        if (images.length <= 1) return;
        _carouselIdx = (_carouselIdx + 1) % images.length;
        updateCarouselImage(images);
      };
      hero.appendChild(nextBtn);

      var counter = document.createElement("span");
      counter.className = "ssd-carousel-counter";
      counter.setAttribute("data-ssd-counter", "");
      counter.textContent = (startIdx + 1) + " / " + images.length;
      hero.appendChild(counter);

      carousel.appendChild(hero);
    } else {
      var noImg = document.createElement("div");
      noImg.className = "ssd-carousel-hero-empty";
      noImg.textContent = tc("无封面图片", "No cover image");
      carousel.appendChild(noImg);
    }
    return carousel;
  }

  function updateCarouselImage(images) {
    var hero = document.querySelector("[data-ssd-carousel-hero]");
    if (hero && images[_carouselIdx]) {
      // Load image on demand — browser fetches only when backgroundImage is set
      hero.style.backgroundImage = "url('" + images[_carouselIdx] + "')";
    }
    var counter = document.querySelector("[data-ssd-counter]");
    if (counter) counter.textContent = (_carouselIdx + 1) + " / " + images.length;
  }

  // Replace the mounted carousel with one built from _modalImages, preserving
  // the viewed index (clamped). Used after detail load and gallery probing.
  function remountCarousel() {
    var oldCarousel = document.querySelector("[data-ssd-carousel]");
    if (!oldCarousel) return;
    if (_carouselIdx >= _modalImages.length) _carouselIdx = 0;
    var fresh = buildCarousel(_modalImages, _state.modal && _state.modal.scene);
    oldCarousel.parentNode.replaceChild(fresh, oldCarousel);
  }

  // After detail loads, probe DMM for screenshots and merge into the carousel.
  function probeModalGallery(detail, item) {
    if (_modalGalleryDone) return;
    _modalGalleryDone = true;

    // Seed with box detail images (cover)
    var boxUrls = (detail.images || []).map(function (i) { return i.url; }).filter(Boolean);
    if (boxUrls.length) {
      _modalImages = dedupeUrls(boxUrls);
      remountCarousel();
    }

    var sc = detail.scene || {};
    var contentId = null;
    (sc.urls || []).forEach(function (u) {
      if (!contentId && u.url) contentId = contentIdFromR18Url(u.url);
    });
    if (!contentId) contentId = deriveContentId(sc.code);
    if (!contentId) return; // non-DMM scene: box cover is all we have

    // Progressive merge (enumeration path reports each shot as found)
    var onImage = function (url) {
      if (!_state.modal) return; // modal closed
      if (_modalImages.indexOf(url) === -1) {
        _modalImages.push(url);
        remountCarousel();
      }
    };

    probeDmmGallery(contentId, onImage).then(function (galleryUrls) {
      if (!_state.modal) return;
      var merged = dedupeUrls(_modalImages.concat(galleryUrls || []));
      var changed = merged.length !== _modalImages.length;
      _modalImages = merged;
      if (changed) remountCarousel();
    }).catch(function (e) {
      console.warn("[SSD] DMM gallery probe failed:", e);
    });
  }

  function dedupeUrls(urls) {
    var seen = {};
    var out = [];
    urls.forEach(function (u) {
      if (u && !seen[u]) { seen[u] = 1; out.push(u); }
    });
    return out;
  }

  function updateModalDetail(detail) {
    var details = document.querySelector("[data-ssd-details]");
    if (!details || !_state.modal) return;
    renderDetailsInto(details, detail.scene, _state.modal);
    // Carousel (cover + DMM screenshots) is handled by probeModalGallery().
  }

  function renderDetailsInto(container, sc, item) {
    container.innerHTML = "";

    // Title
    if (sc.title || sc.code) {
      var dTitle = document.createElement("h3");
      dTitle.className = "ssd-modal-title";
      dTitle.textContent = sc.title || sc.code;
      container.appendChild(dTitle);
    }

    // Meta grid
    var metaGrid = document.createElement("div");
    metaGrid.className = "ssd-meta-grid";
    if (sc.code) {
      var codeItem = buildMetaItem(tc("番号", "Code"), sc.code);
      codeItem.className += " ssd-code-copyable";
      // Click the whole item to copy; a brief text color change is the only
      // feedback — no toast text, no animation
      codeItem.addEventListener("click", function () {
        var flashCopied = function () {
          codeItem.classList.add("ssd-copied");
          clearTimeout(codeItem._copyT);
          codeItem._copyT = setTimeout(function () {
            codeItem.classList.remove("ssd-copied");
          }, 800);
        };
        var fallbackCopy = function () {
          var ta = document.createElement("textarea");
          ta.value = sc.code;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          flashCopied();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(sc.code).then(flashCopied, fallbackCopy);
        } else {
          fallbackCopy();
        }
      });
      metaGrid.appendChild(codeItem);
    }
    if (sc.release_date) metaGrid.appendChild(buildMetaItem(tc("发行日期", "Release Date"), sc.release_date));
    if (sc.production_date) metaGrid.appendChild(buildMetaItem(tc("制作日期", "Production Date"), sc.production_date));
    if (sc.duration) metaGrid.appendChild(buildMetaItem(tc("时长", "Duration"), formatDuration(sc.duration)));
    if (sc.director) metaGrid.appendChild(buildMetaItem(tc("导演", "Director"), sc.director));
    if (sc.studio && sc.studio.name) metaGrid.appendChild(buildMetaItem(tc("工作室", "Studio"), sc.studio.name));
    metaGrid.appendChild(buildMetaItem(tc("来源", "Source"), item.boxName));
    container.appendChild(metaGrid);

    // Performers as pills (click → floating avatar card → stash-box page)
    if (sc.performers && sc.performers.length > 0) {
      var perfRow = document.createElement("div");
      perfRow.className = "ssd-detail-row";
      var perfLabel = document.createElement("span");
      perfLabel.className = "ssd-detail-label";
      perfLabel.textContent = tc("演员", "Performers");
      perfRow.appendChild(perfLabel);
      var perfPills = document.createElement("div");
      perfPills.className = "ssd-pill-row";
      sc.performers.forEach(function (p) {
        var pf = p.performer;
        if (!pf || !pf.name) return;
        // Clickable → solid button (interactive = solid; transparent is
        // reserved for non-clickable badges like the tags below)
        var pill = document.createElement("button");
        pill.type = "button";
        pill.className = "ssd-btn ssd-btn-sm ssd-btn-info ssd-pill-performer";
        pill.title = pf.name;
        var pillText = document.createElement("span");
        pillText.className = "ssd-pill-text";
        pillText.textContent = pf.name;
        pill.appendChild(pillText);
        pill.addEventListener("click", function (e) {
          e.stopPropagation();
          showPerformerCard(pill, item, pf);
        });
        perfPills.appendChild(pill);
      });
      perfRow.appendChild(perfPills);
      container.appendChild(perfRow);
    }

    // Tags as pills
    if (sc.tags && sc.tags.length > 0) {
      var tagRow = document.createElement("div");
      tagRow.className = "ssd-detail-row";
      var tagLabel = document.createElement("span");
      tagLabel.className = "ssd-detail-label";
      tagLabel.textContent = tc("标签", "Tags");
      tagRow.appendChild(tagLabel);
      var tagPills = document.createElement("div");
      tagPills.className = "ssd-pill-row";
      sc.tags.forEach(function (t) {
        if (!t.name) return;
        var pill = document.createElement("span");
        pill.className = "ssd-pill";
        pill.textContent = t.name;
        tagPills.appendChild(pill);
      });
      tagRow.appendChild(tagPills);
      container.appendChild(tagRow);
    }

    // Synopsis — full display, no inner scroll (modal body scrolls)
    if (sc.details) {
      var synopsis = document.createElement("div");
      synopsis.className = "ssd-detail-row";
      var synLabel = document.createElement("span");
      synLabel.className = "ssd-detail-label";
      synLabel.textContent = tc("简介", "Synopsis");
      synopsis.appendChild(synLabel);
      var synText = document.createElement("div");
      synText.className = "ssd-synopsis-text";
      synText.textContent = sc.details;
      synopsis.appendChild(synText);
      container.appendChild(synopsis);
    }

    // URLs
    if (sc.urls && sc.urls.length > 0) {
      var urlRow = document.createElement("div");
      urlRow.className = "ssd-detail-row";
      var urlLabel = document.createElement("span");
      urlLabel.className = "ssd-detail-label";
      urlLabel.textContent = tc("链接", "URLs");
      urlRow.appendChild(urlLabel);
      var urlWrap = document.createElement("div");
      urlWrap.style.marginTop = "4px";
      sc.urls.forEach(function (u) {
        if (!u.url) return;
        var a = document.createElement("a");
        a.href = u.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "ssd-detail-link";
        a.textContent = (u.site && u.site.name) ? u.site.name : u.url;
        a.title = u.url;
        urlWrap.appendChild(a);
      });
      urlRow.appendChild(urlWrap);
      container.appendChild(urlRow);
    }
  }

  function buildMetaItem(label, value) {
    var item = document.createElement("div");
    item.className = "ssd-meta-item";
    var l = document.createElement("div");
    l.className = "ssd-meta-label";
    l.textContent = label;
    var v = document.createElement("div");
    v.className = "ssd-meta-value";
    v.textContent = value;
    item.appendChild(l);
    item.appendChild(v);
    return item;
  }

  // ─── Floating performer avatar card ──────────────────────────────────────
  // Click a performer pill → avatar card pops above it. Click the card → open
  // the stash-box performer page; click anywhere else (or scroll) → dismiss.

  var _performerCardEl = null;

  function hidePerformerCard() {
    if (_performerCardEl) { _performerCardEl.remove(); _performerCardEl = null; }
    document.removeEventListener("click", hidePerformerCard);
    var modalEl = document.querySelector(".ssd-modal");
    if (modalEl) modalEl.removeEventListener("scroll", hidePerformerCard);
  }

  function showPerformerCard(pill, item, performer) {
    if (!pill.isConnected) return;
    // Toggle: clicking the pill of a mounted card closes it
    if (_performerCardEl && _performerCardEl._ssdPill === pill) { hidePerformerCard(); return; }
    hidePerformerCard();

    // Local performer avatar when mapped (fast, internal); box image otherwise
    var localMap = (_state.localPerformerMaps || {})[(item.endpoint || "").toLowerCase()] || {};
    var lp = localMap[String(performer.id).toLowerCase()];
    var imgSrc = lp ? ("/performer/" + lp.id + "/image")
      : (((performer.images || [])[0] || {}).url || "");

    // Mount immediately with a fixed-size portrait skeleton (instant feedback);
    // the avatar loads inside the fixed 80x120 frame, so the card size never
    // changes and the mount position is always correct.
    mountPerformerCard(pill, item, performer, lp, imgSrc);
  }

  function mountPerformerCard(pill, item, performer, lp, imgSrc) {
    var boxPerformerUrl = boxWebBase(item.endpoint) + "/performers/" + performer.id;

    var card = document.createElement("div");
    card.className = "ssd-performer-card";
    card.title = tc("在新标签页打开演员页", "Open performer page in a new tab");
    card._ssdPill = pill;
    card.addEventListener("click", function (e) {
      e.stopPropagation();
      window.open(boxPerformerUrl, "_blank", "noopener,noreferrer");
      hidePerformerCard();
    });

    // Avatar with corner overlays: age bottom-left, country flag bottom-right
    var wrap = document.createElement("div");
    wrap.className = "ssd-perf-avatar-wrap";
    if (imgSrc) {
      var img = document.createElement("img");
      img.className = "ssd-perf-avatar";
      img.alt = "";
      wrap.classList.add("is-loading");
      img.onload = img.onerror = function () { wrap.classList.remove("is-loading"); };
      img.src = imgSrc;
      wrap.appendChild(img);
    }
    var ageEl = document.createElement("span");
    ageEl.className = "ssd-perf-badge ssd-perf-age";
    ageEl.style.display = "none";
    wrap.appendChild(ageEl);
    var flagEl = document.createElement("span");
    flagEl.className = "ssd-perf-badge ssd-perf-flag";
    flagEl.style.display = "none";
    wrap.appendChild(flagEl);
    card.appendChild(wrap);

    document.body.appendChild(card);
    // Position above the pill, centered; flip below when there is no room
    var r = pill.getBoundingClientRect();
    var cw = card.offsetWidth, ch = card.offsetHeight;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - cw / 2, window.innerWidth - cw - 8));
    var top = r.top - ch - 8;
    if (top < 8) top = r.bottom + 8;
    // Keep the card inside the viewport even when the pill sits near the
    // bottom edge (flipped-below placement would overflow)
    if (top + ch > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ch - 8);
    card.style.left = left + "px";
    card.style.top = top + "px";

    _performerCardEl = card;
    // Dismiss on outside click / modal scroll (the card is fixed-positioned
    // and would drift if the modal scrolls under it)
    document.addEventListener("click", hidePerformerCard);
    var modalEl = document.querySelector(".ssd-modal");
    if (modalEl) modalEl.addEventListener("scroll", hidePerformerCard);

    // Age + country are fetched on demand (async, backfilled when ready)
    fetchPerformerAgeCountry(item, performer, lp).then(function (info) {
      if (_performerCardEl !== card || !info) return; // card closed/replaced meanwhile
      if (info.age) {
        ageEl.textContent = tc(info.age + " 岁", info.age + "yo");
        ageEl.style.display = "";
      }
      var cc = String(info.country || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
      if (cc) {
        flagEl.style.display = "";
        var flagImg = document.createElement("img");
        flagImg.src = "https://flagcdn.com/w40/" + cc.toLowerCase() + ".png";
        flagImg.alt = cc;
        flagImg.onerror = function () {
          // Network/CSP fallback: show the country code text instead
          flagEl.textContent = cc;
          flagImg.remove();
        };
        flagEl.appendChild(flagImg);
      }
    });
  }

  function fetchPerformerAgeCountry(item, performer, lp) {
    var fallback = { age: "", country: "" };
    if (lp) {
      // Local performer stores birthdate/country (no direct age field)
      return callGQL(
        "query($id:ID!){findPerformer(id:$id){id birthdate country}}",
        { id: lp.id }
      ).then(function (d) {
        var p = (d && d.findPerformer) || {};
        return { age: birthDateToAge(p.birthdate), country: p.country || "" };
      }).catch(function () { return fallback; });
    }
    // Box performer: derive age from birth_date
    return _boxRateLimiter.submit(function () {
      return callBoxGQL(
        item.endpoint, item.box.api_key,
        "query($id:ID!){findPerformer(id:$id){id birth_date country}}",
        { id: performer.id }
      );
    }).then(function (d) {
      var p = (d && d.findPerformer) || {};
      return { age: birthDateToAge(p.birth_date), country: p.country || "" };
    }).catch(function () { return fallback; });
  }

  function birthDateToAge(birthDate) {
    if (!birthDate) return "";
    var b = new Date(birthDate);
    if (isNaN(b.getTime())) return "";
    var now = new Date();
    var age = now.getFullYear() - b.getFullYear();
    var m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age >= 0 && age < 130 ? String(age) : "";
  }

  // ─── Action: Add to Library (map performers/studio by stash_id) ──────────

  function handleSaveScene(item, btn) {
    // Two-step confirm to prevent misclicks: first click arms the button,
    // second click within 4s executes; otherwise it reverts.
    if (btn.getAttribute("data-ssd-armed") !== "1") {
      btn.setAttribute("data-ssd-armed", "1");
      btn.classList.add("ssd-btn-danger");
      btn.textContent = tc("确认加入库？", "Confirm add?");
      clearTimeout(btn._ssdArmTimer);
      btn._ssdArmTimer = setTimeout(function () {
        if (!btn.isConnected) return;
        btn.removeAttribute("data-ssd-armed");
        btn.classList.remove("ssd-btn-danger");
        btn.textContent = tc("加入库", "Add to Library");
      }, 4000);
      return;
    }
    clearTimeout(btn._ssdArmTimer);
    btn.removeAttribute("data-ssd-armed");
    btn.classList.remove("ssd-btn-danger");

    var sc = _state.modalDetail ? _state.modalDetail.scene : item.scene;
    btn.disabled = true;
    btn.textContent = tc("加入中...", "Adding...");

    var endpoint = item.endpoint;

    // Map all performers from box to local IDs by stash_id
    var perfMapPromise = buildLocalPerformerStashIdMap(endpoint).then(function (map) {
      var ids = [];
      (sc.performers || []).forEach(function (p) {
        if (p.performer && p.performer.id) {
          var localP = map[String(p.performer.id).toLowerCase()];
          if (localP) ids.push(localP.id);
        }
      });
      // Ensure current performer is included even if stash_id mapping misses
      if (ids.indexOf(_state.performerId) === -1) ids.push(_state.performerId);
      return ids;
    });

    // Map studio by stash_id
    var studioPromise = Promise.resolve(null);
    if (sc.studio && sc.studio.id) {
      studioPromise = findLocalStudioByStashId(endpoint, sc.studio.id).then(function (id) {
        if (id) return id;
        // Fallback: find or create by name
        return findOrCreateStudio(sc.studio.name);
      });
    } else if (sc.studio && sc.studio.name) {
      studioPromise = findOrCreateStudio(sc.studio.name);
    }

    // Find or create tags
    var tagIdsPromise = Promise.resolve([]);
    if (sc.tags && sc.tags.length > 0) {
      tagIdsPromise = Promise.all(sc.tags.map(function (t) {
        return findOrCreateTag(t.name);
      })).then(function (ids) { return ids.filter(Boolean); });
    }

    Promise.all([perfMapPromise, studioPromise, tagIdsPromise]).then(function (results) {
      var performerIds = results[0];
      var studioId = results[1];
      var tagIds = results[2];

      var boxWebUrl = boxSceneUrl(endpoint, sc.id);
      // SceneCreateInput.urls is a string array (no URLInput objects)
      var urls = [boxWebUrl];
      (sc.urls || []).forEach(function (u) { if (u.url) urls.push(u.url); });

      var input = {
        title: sc.title || undefined,
        code: sc.code || undefined,
        details: sc.details || undefined,
        date: sc.release_date || undefined,
        urls: urls,
        performer_ids: performerIds,
        tag_ids: tagIds,
        // stash_ids is accepted by SceneCreateInput — no
        // second sceneUpdate round-trip needed
        stash_ids: [{ endpoint: endpoint, stash_id: String(sc.id) }],
      };
      if (studioId) input.studio_id = studioId;
      if (sc.director) input.director = sc.director;

      var coverUrl = (item.images[0] || {}).url || "";
      if (coverUrl) input.cover_image = coverUrl;

      return callGQL(
        "mutation($input:SceneCreateInput!){sceneCreate(input:$input){id title code}}",
        { input: input }
      ).then(function (data) {
        var created = data && data.sceneCreate;
        if (!created || !created.id) throw new Error(tc("创建返回空结果", "Create returned empty result"));
        return created;
      });
    }).then(function (created) {
      if (created && created.id) {
        btn.textContent = tc("已加入 ✓", "Added ✓");
        btn.classList.add("ssd-btn-success");
        var idx = _state.cachedMissing.indexOf(item);
        if (idx !== -1) _state.cachedMissing.splice(idx, 1);
        setTimeout(function () { if (_modalEl) renderTabContent(); }, 1500);
      }
    }).catch(function (e) {
      console.error("[SSD] save failed:", e);
      btn.disabled = false;
      btn.textContent = tc("加入失败", "Add failed");
      btn.classList.add("ssd-btn-danger");
      showModalNotice(tc("加入失败: ", "Add failed: ") + (e.message || String(e)), "error");
      setTimeout(function () {
        btn.textContent = tc("加入库", "Add to Library");
        btn.classList.remove("ssd-btn-danger");
      }, 3000);
    });
  }

  function findOrCreateStudio(name) {
    return callGQL(
      "query($f:FindFilterType!){findStudios(filter:$f){studios{id name}}}",
      { f: { q: name, per_page: 5 } }
    ).then(function (data) {
      var studios = ((data.findStudios || {}).studios) || [];
      for (var i = 0; i < studios.length; i++) {
        if (studios[i].name.toLowerCase() === name.toLowerCase()) return studios[i].id;
      }
      return callGQL(
        "mutation($input:StudioCreateInput!){studioCreate(input:$input){id}}",
        { input: { name: name } }
      ).then(function (d) { return d.studioCreate ? d.studioCreate.id : null; });
    }).catch(function () { return null; });
  }

  function findOrCreateTag(name) {
    return callGQL(
      "query($f:FindFilterType!){findTags(filter:$f){tags{id name}}}",
      { f: { q: name, per_page: 5 } }
    ).then(function (data) {
      var tags = ((data.findTags || {}).tags) || [];
      for (var i = 0; i < tags.length; i++) {
        if (tags[i].name.toLowerCase() === name.toLowerCase()) return tags[i].id;
      }
      return callGQL(
        "mutation($input:TagCreateInput!){tagCreate(input:$input){id}}",
        { input: { name: name } }
      ).then(function (d) { return d.tagCreate ? d.tagCreate.id : null; });
    }).catch(function () { return null; });
  }

  // ─── Action: Open in box ─────────────────────────────────────────────────

  function handleOpenInBox(item) {
    var url = boxSceneUrl(item.endpoint, item.scene.id);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ─── Action: Search Resources (Jackett via Python backend) ────────────────

  // Default query: code for JAV scenes, title for western ones (auto-fallback).
  // An editable search bar is mounted above the results so the query can be
  // corrected per scene (long titles, custom keywords, ...).
  function handleSearchResources(item, btn) {
    var sc = _state.modalDetail ? _state.modalDetail.scene : item.scene;
    var defaultQuery = sc.code || sc.title || "";
    if (!defaultQuery) {
      showModalNotice(tc("无法构建搜索词（无番号或标题）", "Cannot build search query (no code or title)"), "error");
      return;
    }

    var section = document.querySelector("[data-ssd-search]");
    if (!section) return;

    ensureSearchBar(section, item, btn, defaultQuery);

    // Second invocation uses the bar's current text (may be user-edited)
    var input = section.querySelector("[data-ssd-search-input]");
    var query = (input ? input.value : defaultQuery).trim() || defaultQuery;
    doSearchResources(section, item, btn, query);
  }

  function ensureSearchBar(section, item, btn, defaultQuery) {
    if (section.querySelector("[data-ssd-search-bar]")) return;

    var bar = document.createElement("div");
    bar.className = "ssd-search-bar";
    bar.setAttribute("data-ssd-search-bar", "");

    var group = document.createElement("div");
    group.className = "clearable-input-group search-term-input";

    var input = document.createElement("input");
    input.type = "text";
    input.className = "clearable-text-field form-control";
    input.setAttribute("data-ssd-search-input", "");
    input.value = defaultQuery;
    input.placeholder = tc("番号 / 标题", "Code / title");
    group.appendChild(input);

    var goBtn = document.createElement("button");
    goBtn.type = "button";
    goBtn.className = "ssd-btn ssd-btn-accent ssd-btn-sm";
    goBtn.textContent = tc("搜索", "Search");

    function submit() {
      var q = input.value.trim();
      if (!q) { input.focus(); return; }
      doSearchResources(section, item, btn, q);
    }

    goBtn.onclick = submit;
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    bar.appendChild(group);
    bar.appendChild(goBtn);
    section.appendChild(bar);
  }

  // Smooth-scroll the modal to its bottom so the search status/results are
  // visible (the search section sits at the end of the modal).
  function scrollModalToBottom() {
    var modalEl = document.querySelector(".ssd-modal");
    if (!modalEl) return;
    try { modalEl.scrollTo({ top: modalEl.scrollHeight, behavior: "smooth" }); }
    catch (e) { modalEl.scrollTop = modalEl.scrollHeight; }
  }

  function doSearchResources(section, item, btn, query) {
    if (!query) return;

    var results = section.querySelector("[data-ssd-search-results]");
    if (!results) {
      results = document.createElement("div");
      results.setAttribute("data-ssd-search-results", "");
      section.appendChild(results);
    }
    results.innerHTML = "";

    btn.disabled = true;
    btn.textContent = tc("搜索中...", "Searching...");
    var loading = document.createElement("div");
    loading.className = "ssd-search-loading";
    loading.textContent = tc("正在通过 Jackett 搜索: ", "Searching via Jackett: ") + query;
    results.appendChild(loading);
    scrollModalToBottom();

    runPluginTask(TASK_SEARCH, [
      { key: "mode", value: { str: "search" } },
      { key: "query", value: { str: query } },
    ]).then(function (jobId) {
      if (!jobId) throw new Error(tc("任务提交失败", "Task submission failed"));
      return pollJob(jobId);
    }).then(function () {
      return fetchSearchResult();
    }).then(function (result) {
      btn.disabled = false;
      btn.textContent = tc("搜索资源", "Search Resources");
      // No re-scroll: results render in place of the loading line, so the
      // viewport already shows the result header and first entries
      renderSearchResults(results, result);
    }).catch(function (e) {
      console.error("[SSD] search error:", e);
      btn.disabled = false;
      btn.textContent = tc("搜索资源", "Search Resources");
      results.innerHTML = "";
      var err = document.createElement("div");
      err.className = "ssd-search-error";
      err.textContent = tc("搜索失败: ", "Search failed: ") + (e.message || String(e));
      results.appendChild(err);
    });
  }

  function runPluginTask(taskName, args) {
    return callGQL(
      "mutation($id:ID!,$t:String!,$a:[PluginArgInput!]){runPluginTask(plugin_id:$id,task_name:$t,args:$a)}",
      { id: PLUGIN_ID, t: taskName, a: args }
    ).then(function (r) { return (r && r.runPluginTask) || null; });
  }

  function pollJob(jobId) {
    var startTime = Date.now();
    var timeout = 60000;
    return new Promise(function (resolve, reject) {
      function tick() {
        callGQL("query($i:FindJobInput!){findJob(input:$i){id status}}", { i: { id: jobId } })
          .then(function (r) {
            var job = r && r.findJob;
            if (!job) { reject(new Error("Job not found")); return; }
            if (job.status === "FINISHED" || job.status === "FAILED" || job.status === "CANCELLED") {
              resolve(job.status); return;
            }
            if (Date.now() - startTime > timeout) { reject(new Error(tc("搜索超时", "Search timed out"))); return; }
            setTimeout(tick, 1500);
          }).catch(function (e) { reject(e); });
      }
      tick();
    });
  }

  function fetchSearchResult() {
    return callGQL("query{logs{level message}}", {}).then(function (r) {
      var logs = (r && r.logs) || [];
      // Stash logs are newest-first: the first marker found is the latest run's
      for (var i = 0; i < logs.length; i++) {
        var msg = (logs[i] || {}).message || "";
        var errIdx = msg.indexOf(ERROR_MARKER);
        if (errIdx !== -1) throw new Error(msg.substring(errIdx + ERROR_MARKER.length).trim());
        var resultIdx = msg.indexOf(RESULT_MARKER);
        if (resultIdx !== -1) {
          var jsonStr = msg.substring(resultIdx + RESULT_MARKER.length).trim();
          try { return JSON.parse(jsonStr); } catch (e) { console.warn("[SSD] result parse failed:", e); }
        }
      }
      return { count: 0, results: [] };
    });
  }

  function renderSearchResults(section, result) {
    section.innerHTML = "";
    _searchResults = result.results || [];
    _searchPage = 1;

    var header = document.createElement("div");
    header.className = "ssd-search-header";
    header.textContent = tc("搜索结果 (", "Search Results (") + (result.count || 0) + ")";
    section.appendChild(header);

    if (_searchResults.length === 0) {
      var empty = document.createElement("div");
      empty.className = "ssd-search-empty";
      empty.textContent = tc("未找到资源", "No resources found");
      section.appendChild(empty);
      return;
    }

    renderSearchPage(section);
  }

  function renderSearchPage(section) {
    // Remove existing list + pager (keep header)
    var oldList = section.querySelector(".ssd-search-list");
    if (oldList) oldList.remove();
    var oldPager = section.querySelector(".ssd-search-pager");
    if (oldPager) oldPager.remove();

    var start = (_searchPage - 1) * _searchPerPage;
    var pageItems = _searchResults.slice(start, start + _searchPerPage);

    var list = document.createElement("div");
    list.className = "ssd-search-list";
    pageItems.forEach(function (res) { list.appendChild(buildSearchResultItem(res)); });
    section.appendChild(list);

    // Pagination controls
    var totalPages = Math.ceil(_searchResults.length / _searchPerPage);
    if (totalPages > 1) {
      var pager = document.createElement("div");
      pager.className = "ssd-search-pager";

      var prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.className = "ssd-btn ssd-btn-secondary ssd-btn-sm";
      prevBtn.textContent = "← " + tc("上一页", "Prev");
      prevBtn.disabled = _searchPage <= 1;
      prevBtn.onclick = function () {
        _searchPage--;
        renderSearchPage(section);
      };
      pager.appendChild(prevBtn);

      var pageInfo = document.createElement("span");
      pageInfo.className = "ssd-count-info";
      pageInfo.textContent = tc("第 " + _searchPage + " / " + totalPages + " 页",
        "Page " + _searchPage + " of " + totalPages);
      pager.appendChild(pageInfo);

      var nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.className = "ssd-btn ssd-btn-secondary ssd-btn-sm";
      nextBtn.textContent = tc("下一页", "Next") + " →";
      nextBtn.disabled = _searchPage >= totalPages;
      nextBtn.onclick = function () {
        _searchPage++;
        renderSearchPage(section);
      };
      pager.appendChild(nextBtn);

      section.appendChild(pager);
    }
  }

  function buildSearchResultItem(res) {
    var row = document.createElement("div");
    row.className = "ssd-search-item";

    var info = document.createElement("div");
    info.className = "ssd-search-item-info";
    var title = document.createElement("div");
    title.className = "ssd-search-item-title";
    title.textContent = res.title || tc("无标题", "Untitled");
    title.title = res.title || "";
    info.appendChild(title);
    var meta = document.createElement("div");
    meta.className = "ssd-search-item-meta";
    var metaParts = [];
    if (res.size_human) metaParts.push(res.size_human);
    if (res.seeders >= 0) metaParts.push(tc("种子", "S") + ": " + res.seeders);
    if (res.leechers >= 0) metaParts.push(tc("下载", "L") + ": " + res.leechers);
    if (res.tracker) metaParts.push(res.tracker);
    meta.textContent = metaParts.join(" · ");
    info.appendChild(meta);
    row.appendChild(info);

    var actions = document.createElement("div");
    actions.className = "ssd-search-item-actions";

    if (res.magnet) {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "ssd-btn ssd-btn-secondary ssd-btn-sm";
      copyBtn.textContent = tc("复制磁力", "Copy Magnet");
      copyBtn.onclick = function () {
        navigator.clipboard.writeText(res.magnet).then(function () {
          copyBtn.textContent = tc("已复制 ✓", "Copied ✓");
          copyBtn.classList.add("ssd-btn-success");
          setTimeout(function () {
            copyBtn.textContent = tc("复制磁力", "Copy Magnet");
            copyBtn.classList.remove("ssd-btn-success");
          }, 2000);
        }).catch(function () {
          var ta = document.createElement("textarea");
          ta.value = res.magnet;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          copyBtn.textContent = tc("已复制 ✓", "Copied ✓");
          setTimeout(function () { copyBtn.textContent = tc("复制磁力", "Copy Magnet"); }, 2000);
        });
      };
      actions.appendChild(copyBtn);
    } else if (res.link) {
      var openLinkBtn = document.createElement("a");
      openLinkBtn.href = res.link;
      openLinkBtn.target = "_blank";
      openLinkBtn.rel = "noopener noreferrer";
      openLinkBtn.className = "ssd-btn ssd-btn-secondary ssd-btn-sm";
      openLinkBtn.textContent = tc("打开链接", "Open Link");
      actions.appendChild(openLinkBtn);
    }

    if (res.magnet) {
      var pushBtn = document.createElement("button");
      pushBtn.type = "button";
      pushBtn.className = "ssd-btn ssd-btn-accent ssd-btn-sm";
      pushBtn.textContent = tc("推送下载", "Push to DL");
      pushBtn.onclick = function () {
        pushBtn.disabled = true;
        pushBtn.textContent = tc("推送中...", "Pushing...");
        runPluginTask(TASK_PUSH, [
          { key: "mode", value: { str: "push_download" } },
          { key: "magnet", value: { str: res.magnet } },
        ]).then(function (jobId) {
          if (!jobId) throw new Error("Task submission failed");
          return pollJob(jobId);
        }).then(function () { return fetchPushResult(); })
        .then(function () {
          pushBtn.textContent = tc("已推送 ✓", "Pushed ✓");
          pushBtn.classList.add("ssd-btn-success");
          setTimeout(function () {
            pushBtn.disabled = false;
            pushBtn.textContent = tc("推送下载", "Push to DL");
            pushBtn.classList.remove("ssd-btn-success");
          }, 2500);
        }).catch(function (e) {
          pushBtn.disabled = false;
          pushBtn.textContent = tc("推送失败", "Failed");
          pushBtn.classList.add("ssd-btn-danger");
          showModalNotice(tc("推送失败: ", "Push failed: ") + (e.message || String(e)), "error");
          setTimeout(function () {
            pushBtn.textContent = tc("推送下载", "Push to DL");
            pushBtn.classList.remove("ssd-btn-danger");
          }, 3000);
        });
      };
      actions.appendChild(pushBtn);
    }

    row.appendChild(actions);
    return row;
  }

  function fetchPushResult() {
    return callGQL("query{logs{level message}}", {}).then(function (r) {
      var logs = (r && r.logs) || [];
      // Stash logs are newest-first (see fetchSearchResult)
      for (var i = 0; i < logs.length; i++) {
        var msg = (logs[i] || {}).message || "";
        if (msg.indexOf(ERROR_MARKER) !== -1) {
          throw new Error(msg.substring(msg.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim());
        }
        if (msg.indexOf(RESULT_MARKER) !== -1) return true;
      }
      return true;
    });
  }

  function showModalNotice(text, type) {
    var host = document.querySelector("[data-ssd-search-results]")
      || document.querySelector("[data-ssd-search]");
    if (!host) return;
    var notice = document.createElement("div");
    notice.className = "ssd-notice ssd-notice-" + (type || "info");
    notice.textContent = text;
    host.insertBefore(notice, host.firstChild);
    setTimeout(function () { notice.remove(); }, 5000);
  }

  // ─── Observers / init ─────────────────────────────────────────────────────

  var _observerTimer = null;

  function setupObservers() {
    var target = document.querySelector(".main-content") || document.querySelector("#root") || document.body;
    var observer = new MutationObserver(function () {
      if (!isPerformerPage()) { _tabInjected = false; _tabPerformerId = null; return; }
      clearTimeout(_observerTimer);
      _observerTimer = setTimeout(ensureTabInjected, 200);
    });
    observer.observe(target, { childList: true, subtree: true });

    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () { origPush.apply(this, arguments); onUrlChange(); };
    history.replaceState = function () { origReplace.apply(this, arguments); onUrlChange(); };
    window.addEventListener("popstate", onUrlChange);
  }

  // Drop everything tied to the previous performer (including the edit-panel poll
  // and the one-off "unlimited time" flag), so a new performer starts clean.
  function resetPerformerState() {
    stopEditWatch();
    _state.performerId = null;
    _state.cachedMissing = [];
    _state.loadError = "";
    _state.errorKind = "";
    _state.viewState = "";
    _state.loadInitiated = false;
    _state.boxStatus = {};
    _state.boxFailed = {};
    _state.boxFetched = {};
    _state.droppedByWindow = 0;
    _state.windowRelaxed = false;
    _state.preferredFallback = false;
    _state.preferredBoxLabel = "";
    _state.queryBoxes = [];
    _state.allBoxes = [];
    _state.performerStashIds = [];
    _state.editWatching = false;
    _state.editWatchMissing = false;
    _state.findOpen = false;
    _state.findState = "idle";
    _state.findResults = [];
    _state.findFailures = [];
    _state.findMessage = "";
    _state.findTerm = "";
    _state.findExpandedKey = "";
    _state.findImageIdx = 0;
    _state.findBusyKey = "";
    _state.findRowMsg = {};
    // Dropped too, otherwise the lookup input would pre-fill with the previous
    // performer's name until the new one finishes loading
    _state.performerName = "";
    _state.searchQuery = "";
  }

  function onUrlChange() {
    if (!isPerformerPage()) {
      _tabInjected = false; _tabPerformerId = null;
      resetPerformerState();
      return;
    }
    var pid = getPerformerIdFromUrl();
    if (pid && pid !== _state.performerId) {
      resetPerformerState();
      _state.performerId = pid;
      _tabInjected = false;
    }
    setTimeout(ensureTabInjected, 300);
    setTimeout(ensureTabInjected, 800);
  }

  function initPlugin() {
    console.log("[SSD] stashDiscover v" + PLUGIN_VERSION + " loaded");
    setupObservers();
    var _resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(layoutCardGrid, 150);
    });
    if (isPerformerPage()) {
      setTimeout(ensureTabInjected, 300);
      setTimeout(ensureTabInjected, 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlugin);
  } else {
    initPlugin();
  }
})();
