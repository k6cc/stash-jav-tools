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
  var PLUGIN_VERSION = "2.6.4";
  // DOM event fired after a discover-page scene is saved to the library;
  // discover.js listens and drops the card from its results
  var SCENE_SAVED_EVENT = "ssd:scene-saved";

  // Brand display names for known stash-box hosts (simplified badges)
  var BRAND_MAP = {
    "javstash.org": "JAVStash",
    "stashdb.org": "StashDB",
    "theporndb.net": "TPDB",
    "pmvstash.org": "PMVStash",
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
        React.useEffect(function () {
          var v = intl.locale || "";
          if (v !== _intlLocale) {
            _intlLocale = v;
            // Static/early-rendered UI (e.g. the discover nav item renders
            // before this effect fills the locale) re-renders on this event.
            // setTimeout(0): sibling effects attach their listeners in tree
            // order AFTER this one runs — dispatching synchronously here
            // would fire before any listener exists.
            try { setTimeout(function () { window.dispatchEvent(new CustomEvent("ssd:locale-changed")); }, 0); } catch (_) {}
          }
        });
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

  // ─── 429 限流：退避重试 + 按源节流 ───────────────────────────────────────
  // 源被限流时回 429 + Retry-After。以前这档被归进 blocked（「请求被拒绝」），
  // 既不重试也不说明原因，整批数据就这么丢了。
  // 只重试 429：超时已经烧掉 15s 预算，再叠一次就会撞反代的 60s 硬切断
  //（见 README「注意事项」），而 429 是秒回的，不占超时预算。
  var BOX_MAX_RETRIES = 2;          // 最多重试 2 次 = 单次调用最多 3 个请求
  var BOX_BACKOFF_BASE = 2000;      // 源没给 Retry-After 时：2s、4s
  var RETRY_AFTER_CAP = 15000;      // 源要求的等待再长也不等，直接报错让用户手动重试
  var BOX_RETRY_BUDGET = 45000;     // 单次调用总预算（含等待），到点即放弃
  var BOX_PENALTY_MS = 5 * 60 * 1000;  // 被限流后该源降速持续多久
  var BOX_PENALTY_DELAY = 1000;     // 降速期间的请求间隔

  // Retry-After 有两种格式：秒数，或 HTTP-date。解析不出返回 null。
  function parseRetryAfter(v) {
    if (!v) return null;
    var s = String(v).trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 1000;
    var t = Date.parse(s);
    if (isNaN(t)) return null;
    return Math.max(0, t - Date.now());
  }

  function sleepMs(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function boxHostOf(endpoint) {
    try { return new URL(endpoint).host; } catch (e) { return String(endpoint || ""); }
  }

  // 按源排队：同一 source 的请求串行，且被限流过的那段时间里彼此间隔 1s。
  // 默认零延迟 —— 没被打过就完全不付代价，首屏耗时不受影响。
  // 注意与 _boxRateLimiter(3, 300) 的分工：那个是常驻的「3 并发 + 300ms」全局频率，
  // 这里只在被 429 打过之后额外加间隔，两者叠加取更慢的那个，不重复做事。
  var _boxGate = {};

  function boxGateTake(endpoint) {
    var g = _boxGate[endpoint] || (_boxGate[endpoint] = { lastAt: 0, penalizeUntil: 0 });
    var now = Date.now();
    // 间隔挂在「上一次发起时间」上：平时 gap=0 → 永远不用等；惩罚期才排队
    var gap = now < g.penalizeUntil ? BOX_PENALTY_DELAY : 0;
    var wait = Math.max(0, g.lastAt + gap - now);
    g.lastAt = now + wait;
    return wait;
  }

  function boxPenalize(endpoint) {
    var g = _boxGate[endpoint] || (_boxGate[endpoint] = { lastAt: 0, penalizeUntil: 0 });
    g.penalizeUntil = Date.now() + BOX_PENALTY_MS;
  }

  // 重试判定：返回要等的毫秒数，null = 现在放弃。只认 ratelimit。
  function retryWaitFor(err, ctx) {
    if (!err || err.ssdKind !== "ratelimit") return null;
    if (ctx.attempt >= BOX_MAX_RETRIES) return null;
    var now = Date.now();
    if (now >= ctx.deadline) return null;
    var ra = err.retryAfterMs;
    // 源要求的等待超过上限：报错让用户自己决定，别把请求挂在这里
    if (ra != null && ra > RETRY_AFTER_CAP) return null;
    var want = (ra != null ? ra : BOX_BACKOFF_BASE * Math.pow(2, ctx.attempt));
    var wait = Math.min(want, RETRY_AFTER_CAP);
    if (now + wait >= ctx.deadline) return null;
    return wait;
  }

  var BOX_ERR_TEXT = {
    timeout: ["请求超时", "Timed out"],
    network: ["无法连接", "Unreachable"],
    auth: ["鉴权失败", "Auth failed"],
    ratelimit: ["源正在限流", "Rate limited"],
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

  // ─── Base URL (sub-path deployments) ─────────────────────────────────────
  // Stash served behind a reverse proxy with X-Forwarded-Prefix runs under a
  // sub-path (e.g. https://host/stash/) and rewrites <base href> to that
  // prefix. Root-absolute internal URLs ("/graphql", "/settings", "/plugins/…")
  // ignore <base href> and would hit the domain root, so every internal URL
  // goes through this helper. Absolute and data/blob URLs pass through.
  function appUrl(path) {
    var p = String(path == null ? "" : path);
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(p) ||
      p.indexOf("data:") === 0 || p.indexOf("blob:") === 0) return p;
    try {
      var base = document.baseURI || (location.origin + "/");
      if (base.charAt(base.length - 1) !== "/") base += "/";
      return new URL(p.replace(/^\/+/, ""), base).toString();
    } catch (_) {
      return p;
    }
  }

  // ─── GraphQL helpers ─────────────────────────────────────────────────────

  function callGQL(query, variables) {
    var payload = { query: query };
    if (variables) payload.variables = variables;
    return fetch(appUrl("/graphql"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.errors) throw new Error(JSON.stringify(data.errors));
        return data.data;
      });
  }

  function callBoxGQL(endpoint, apiKey, query, variables, timeoutMs, _ctx) {
    var ctx = _ctx || { attempt: 0, deadline: Date.now() + BOX_RETRY_BUDGET };
    var payload = { query: query };
    if (variables) payload.variables = variables;
    var headers = { "Content-Type": "application/json" };
    if (apiKey) headers["ApiKey"] = apiKey;

    // 单次尝试：排队 → 请求 → 错误分类
    function once() {
      var wait = boxGateTake(endpoint);
      var start = wait > 0 ? sleepMs(wait) : Promise.resolve();
      return start.then(function () {
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
            if (r.status === 429) {
              // 429 的 body 通常是 Cloudflare 的 HTML，走不到 json() 解析
              boxPenalize(endpoint);
              var e429 = ssdError("ratelimit", "HTTP 429");
              e429.retryAfterMs = parseRetryAfter(
                (r.headers && r.headers.get) ? r.headers.get("Retry-After") : null);
              throw e429;
            }
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
      });
    }

    // 只有 ratelimit 会回到 loop 重试（见 retryWaitFor）
    function loop() {
      return once().catch(function (e) {
        var wait = retryWaitFor(e, ctx);
        if (wait == null) {
          // 重试过才把次数写进明细，便于日志和用户判断是不是没缓过来
          if (e && e.ssdKind === "ratelimit" && ctx.attempt > 0) {
            e.message = (e.message || "HTTP 429") + ", retried " + ctx.attempt + "x";
          }
          throw e;
        }
        ctx.attempt++;
        console.warn("[ssd] 429 " + boxHostOf(endpoint) + " retry " + ctx.attempt +
          "/" + BOX_MAX_RETRIES + " in " + wait + "ms");
        return sleepMs(wait).then(loop);
      });
    }

    return loop();
  }

  // ─── ThePornDB REST adapter ──────────────────────────────────────────────
  // TPDB 的 stash-box 列表接口（queryScenes / queryStudios）服务端故障：
  // HTTP 200 但 scenes 恒为 null（论坛反馈的 "TPDB API error"）。单条查询
  // findScene / findPerformer / findStudio 正常。场景列表因此改走它公开的
  // REST API；返回里的 site.uuid 与 stash-box 的 studio id 一致。
  var TPDB_RE = /theporndb\.net/i;
  // 批量取片整体翻页上限（每页最多 100 条 → 500 部）。
  // 批量后请求数与演员数无关（一次查询覆盖全部），所以上限不是按人算的；
  // 无限回看窗口也不会全量回溯，UI 需要把这个截断说明白（用户 2026-10-26）。
  var TPDB_MAX_PAGES_BATCH = 5;
  // 批量翻页的时间预算：翻满上限页数可能要十几秒，发现页首屏等不了那么久。
  // 超预算即停，按截断处理（有提示）。
  var TPDB_BATCH_BUDGET_MS = 8000;
  // 解析失败的 id 也缓存一段时间，否则每次进发现页都重打一轮 404。
  var TPDB_BAD_TTL_MS = 7 * 24 * 3600 * 1000;
  var _tpdbLastPage = {};

  // stash-box 给的是 parent uuid，而 REST 批量过滤只认整数 id（键必须是数字）。
  // 整数 id 永久稳定，转换结果落 localStorage，之后 0 次请求。
  // 值形如 { id: 411467, p: 1 }；p=0 表示这条是站点级记录，不能用于查询。
  var TPDB_ID_CACHE_KEY = "ssd.tpdb.intIds";
  var _tpdbIdMap = null;

  function tpdbIdMap() {
    if (_tpdbIdMap) return _tpdbIdMap;
    try {
      _tpdbIdMap = JSON.parse(localStorage.getItem(TPDB_ID_CACHE_KEY) || "{}") || {};
    } catch (e) { _tpdbIdMap = {}; }
    return _tpdbIdMap;
  }

  function tpdbIdRemember(uuid, intId, isParent) {
    var m = tpdbIdMap();
    m[uuid] = { id: intId, p: isParent ? 1 : 0 };
    try { localStorage.setItem(TPDB_ID_CACHE_KEY, JSON.stringify(m)); } catch (e) { /* 配额满不影响查询 */ }
  }

  // 解析失败（源里已删除/合并、站点级记录）也记一笔，7 天内不再重试。
  function tpdbIdRememberBad(uuid) {
    var m = tpdbIdMap();
    m[uuid] = { bad: 1, t: Date.now() };
    try { localStorage.setItem(TPDB_ID_CACHE_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  function isTPDBBox(box) {
    return !!box && TPDB_RE.test(String(box.endpoint || ""));
  }

  // The discover page builds its own source object with camelCase apiKey,
  // while configuration.general.stashBoxes exposes api_key — accept both.
  function boxKey(box) {
    if (!box) return "";
    return box.api_key != null ? box.api_key : (box.apiKey || "");
  }

  // TPDB 所有 REST 调用共用一个节流键（源只有一个）
  var TPDB_GATE_KEY = "https://api.theporndb.net";

  function tpdbGet(box, path, timeoutMs, isRetry, _ctx) {
    var ctx = _ctx || { attempt: 0, deadline: Date.now() + BOX_RETRY_BUDGET };

    function once() {
      var wait = boxGateTake(TPDB_GATE_KEY);
      var start = wait > 0 ? sleepMs(wait) : Promise.resolve();
      return start.then(function () {
        var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
        var timedOut = false;
        var timer = setTimeout(function () {
          timedOut = true;
          if (controller) controller.abort();
        }, timeoutMs || BOX_TIMEOUT_MS);
        var headers = { "Accept": "application/json" };
        if (boxKey(box)) headers["Authorization"] = "Bearer " + boxKey(box);
        return fetch("https://api.theporndb.net" + path, {
          headers: headers,
          signal: controller ? controller.signal : undefined,
        }).catch(function (e) {
          clearTimeout(timer);
          if (timedOut || (e && e.name === "AbortError")) throw ssdError("timeout", "timeout");
          throw ssdError("network", (e && e.message) || "network error");
        }).then(function (r) {
          if (!r.ok) {
            if (r.status === 429) {
              boxPenalize(TPDB_GATE_KEY);
              var e429 = ssdError("ratelimit", "HTTP 429");
              e429.retryAfterMs = parseRetryAfter(
                (r.headers && r.headers.get) ? r.headers.get("Retry-After") : null);
              throw e429;
            }
            // 401 偶尔是瞬时鉴权失败，重发一次就恢复；连着重试仍 401 基本是 key 配错源
            // 或没权限（403 直接不重试）。只兜一次，不做退避重试链。
            if (r.status === 401 && !isRetry) {
              clearTimeout(timer);
              return new Promise(function (res) { setTimeout(res, 600); }).then(function () {
                return tpdbGet(box, path, timeoutMs, true, ctx);
              });
            }
            var httpErr = ssdError((r.status === 401 || r.status === 403) ? "auth" : "blocked", "HTTP " + r.status);
            // 调用方要区分「记录不存在」(404) 和「网络/鉴权失败」，前者才值得记坏缓存
            httpErr.status = r.status;
            throw httpErr;
          }
          return r.json().catch(function () { throw ssdError("parse", "non-JSON response"); });
        }).then(function (data) {
          clearTimeout(timer);
          return data;
        }).catch(function (e) {
          clearTimeout(timer);
          if (e && e.ssdKind) throw e;
          throw ssdError("unknown", (e && e.message) || String(e));
        });
      });
    }

    function loop() {
      return once().catch(function (e) {
        var waitMs = retryWaitFor(e, ctx);
        if (waitMs == null) {
          if (e && e.ssdKind === "ratelimit" && ctx.attempt > 0) {
            e.message = (e.message || "HTTP 429") + ", retried " + ctx.attempt + "x";
          }
          throw e;
        }
        ctx.attempt++;
        console.warn("[ssd] 429 " + boxHostOf(TPDB_GATE_KEY) + " retry " + ctx.attempt +
          "/" + BOX_MAX_RETRIES + " in " + waitMs + "ms");
        return sleepMs(waitMs).then(loop);
      });
    }

    return loop();
  }

  // 单条解析 uuid → 整数 id。
  // performer 用 `_id`，且必须是 parent 记录：站点级 uuid 打单条直接
  // 404 `performer not found`，论坛那位的三块总览一起红就是被这种 id 拖死的。
  // studio 用 `/sites/{uuid}` 返回的整数 `id`（它没有 `_id`）。
  // 任何失败都只跳过这一个 id，不向上抛。
  function tpdbResolveId(box, kind, uuid, timeoutMs) {
    var key = String(uuid || "").trim();
    if (!key) return Promise.resolve(null);
    var hit = tpdbIdMap()[key];
    if (hit) {
      if (hit.id) return Promise.resolve(hit.p ? hit.id : null);
      if (hit.bad && Date.now() - hit.t < TPDB_BAD_TTL_MS) return Promise.resolve(null);
    }
    var path = (kind === "studio" ? "/sites/" : "/performers/") + encodeURIComponent(key);
    return tpdbGet(box, path, timeoutMs).then(function (j) {
      var d = (j && j.data) || j || {};
      if (kind === "studio") {
        var sid = d.id != null ? d.id : null;
        if (sid != null) tpdbIdRemember(key, sid, true); else tpdbIdRememberBad(key);
        return sid;
      }
      var id = d._id != null ? d._id : null;
      var parent = d.is_parent !== false;
      if (id != null && parent) { tpdbIdRemember(key, id, true); return id; }
      tpdbIdRememberBad(key);
      return null;
    }).catch(function (e) {
      // 只有「源里确实没有这条记录」(404) 才记坏、7 天不再试。
      // 网络抖动/超时/401 记坏会让这个演员连着 7 天查不出东西——本地网络波动
      // 不该被当成数据缺失（远程办公常见）。
      if (e && e.status === 404) tpdbIdRememberBad(key);
      return null;
    });
  }

  // 名字回退：stash-box 给的是站点级记录（`is_parent:false`，打 /performers/{uuid}
  // 直接 404 `performer not found`）或编号已被删/合并时，用本地演员名在源里找同名的
  // parent 记录。旧实现遇到这种只会进 skipped，整个演员 0 条、且看不出原因。
  // 只取「名字完全一致」的 parent，不做模糊匹配——同名不同人在 TPDB 很常见
  //（Emma Reed 有 6 条同名记录，片量 59/1/105/2/71/0）。
  var _tpdbNameCache = {};

  function tpdbNameLookup(box, name, timeoutMs) {
    var q = String(name || "").trim();
    if (!q) return Promise.resolve(null);
    var ck = box.endpoint + "|" + q.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_tpdbNameCache, ck)) {
      return Promise.resolve(_tpdbNameCache[ck]);
    }
    return tpdbGet(box, "/performers?q=" + encodeURIComponent(q) + "&per_page=10", timeoutMs)
      .then(function (j) {
        var rows = asArr(j && j.data);
        var lower = q.toLowerCase();
        var hit = null;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          if (!r || r._id == null || r.is_parent === false) continue;
          if (String(r.name || "").trim().toLowerCase() !== lower) continue;
          hit = r._id;
          break;
        }
        _tpdbNameCache[ck] = hit;
        if (hit != null && typeof _state !== "undefined" && _state && _state.boxByName) {
          _state.boxByName[box.endpoint] = true;
        }
        return hit;
      })
      .catch(function (e) {
        if (e && e.status === 404) _tpdbNameCache[ck] = null;
        return null;
      });
  }

  // 演员 uuid → 整数 id，失败再按名字找一次。
  function tpdbResolvePerformer(box, uuid, nameHint, timeoutMs) {
    return tpdbResolveId(box, "performer", uuid, timeoutMs).then(function (id) {
      if (id != null) return id;
      if (!nameHint) return null;
      return tpdbNameLookup(box, nameHint, timeoutMs);
    });
  }

  // 一批 uuid → { ids: [整数], skipped: [uuid], byId: {整数: uuid} }，并发 4。
  // byId 用于「按工作室查询」时把召回的场景归回被查的那个工作室（见 tpdbSinceScenes）。
  function tpdbResolveIds(box, kind, uuids, timeoutMs) {
    var ids = [], skipped = [], byId = {}, idx = 0;
    function wave() {
      if (idx >= uuids.length) return { ids: ids, skipped: skipped, byId: byId };
      var chunk = uuids.slice(idx, idx + 4);
      idx += 4;
      return Promise.all(chunk.map(function (u) {
        return tpdbResolveId(box, kind, u, timeoutMs);
      })).then(function (res) {
        res.forEach(function (id, i) {
          if (id != null) { ids.push(id); byId[id] = chunk[i]; }
          else skipped.push(chunk[i]);
        });
        return wave();
      });
    }
    return Promise.resolve().then(wave);
  }

  // 站点维度的唯一正确路径：site_id（整型，单值）+ site_operation。
  // 为什么不能沿用 sites[<id>]：那个键精确匹配「站点自身」这一层。Stash 里的工作室常常是
  // 父站点（ManyVids / Vixen Media Group / Reality Kings），它自身 0 条，场景全挂在
  // 子站点上 → 用 sites[] 永远查到空（论坛反馈"工作室场景拉不出来"）。
  // Site/Parent = 本站点 + 直接子站点：父站点能拿到子站点全部，子站点（如 Tushy 689 条）
  // 仍只返回自己，不会串到同 network 的兄弟品牌。
  // 代价：site_operation 不认批量键（同时给 sites[] 会返回 0 条），只能一个站点一个请求。
  function tpdbSitePath(intId, perPage, page, since) {
    var q = "/scenes?site_id=" + intId + "&site_operation=Site%2FParent" +
      "&per_page=" + perPage + "&page=" + page + "&orderBy=recently_released";
    if (since) q += "&date=" + encodeURIComponent(since) + "&date_operation=%3E";
    return q;
  }

  // 批量取场景的唯一路径：performers[整数]=x（deepObject）。
  // 值只是占位，服务端只认键；多个键按 OR 合并，total 直接相加。
  // date 与 orderBy 可以同时给，实测都生效。
  // 站点不走这里（见 tpdbSitePath）：站点按层级查只能单值。
  function tpdbBatchPath(kind, intIds, perPage, page, since) {
    var key = kind === "studio" ? "sites" : "performers";
    var q = "/scenes?" + intIds.map(function (id) {
      return key + "[" + id + "]=x";
    }).join("&") + "&per_page=" + perPage + "&page=" + page + "&orderBy=recently_released";
    if (since) q += "&date=" + encodeURIComponent(since) + "&date_operation=%3E";
    return q;
  }

  // 演员：一条批量 URL 覆盖全部；站点：每个站点一条（site_operation 只认单值）
  function tpdbPagePaths(kind, intIds, perPage, page, since) {
    if (kind === "studio") {
      return intIds.map(function (id) { return tpdbSitePath(id, perPage, page, since); });
    }
    return [tpdbBatchPath(kind, intIds, perPage, page, since)];
  }

  // TPDB 的 background / background_back 是对象 {full,large,medium,small}，
  // 直接塞进 images 会得到 [object Object]（2026-10-26 修正）
  function tpdbImgUrl(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    return v.full || v.large || v.medium || v.small || "";
  }

  // TPDB 偶尔会给出非数组字段（错误包体、字段改名），直接 .map 会抛
  // TypeError → 前端只能显示 "Unknown error"（论坛反馈发现页报未知错误）
  function asArr(v) {
    return Array.isArray(v) ? v : [];
  }

  function tpdbScene(raw) {
    if (!raw) return null;
    var site = raw.site || null;
    var imgs = [];
    // 顺序即封面回退顺序。TPDB 自家 CDN 在前，抓来的外站直链在后：
    // 实测 26 个外站域名里 13 个下载失败（ods.manyvids.com 404、cruel-handjobs 断连），
    // 而 cdn.theporndb.net 与 thumb.theporndb.net 26/26 可用。横版 background 优先
    // （Stash 封面是横版位），竖版 poster 次之，外站 image 只作最后兜底。
    [tpdbImgUrl(raw.background), raw.poster, raw.image,
      tpdbImgUrl(raw.background_back), raw.back_image, raw.poster_image].forEach(function (u) {
      if (u && !imgs.some(function (x) { return x.url === u; })) imgs.push({ url: u });
    });
    var urls = [];
    if (raw.url) urls.push({ url: raw.url, site: { name: (site && site.name) || "" } });
    asArr(raw.links).forEach(function (l) {
      var u = typeof l === "string" ? l : (l && l.url);
      if (u && !urls.some(function (x) { return x.url === u; })) {
        urls.push({ url: u, site: { name: (site && site.name) || "" } });
      }
    });
    return {
      id: raw.id,
      title: raw.title || "",
      code: raw.sku || raw.external_id || "",
      details: raw.description || "",
      release_date: raw.date || "",
      duration: raw.duration || 0,
      urls: urls,
      studio: site ? {
        id: site.uuid || (site.id != null ? String(site.id) : ""),
        name: site.name || "",
      } : null,
      performers: asArr(raw.performers).map(function (p) {
        // 场景内演员是站点级记录；stash-box 的演员 id 是站点无关的 parent id
        var par = p.parent || null;
        var img = p.image || p.thumbnail || p.face ||
          (par && (par.image || par.thumbnail || par.face)) || "";
        return {
          as: p.name || (par && par.name) || "",
          performer: {
            id: (par && par.id) || p.id || "",
            name: p.name || (par && par.name) || "",
            images: img ? [{ url: img }] : [],
          },
        };
      }),
      tags: asArr(raw.tags).map(function (t) {
        return { id: t.uuid || (t.id != null ? String(t.id) : ""), name: t.name || "" };
      }),
      images: imgs,
    };
  }

  function tpdbResult(j, reverse) {
    var scenes = asArr(j && j.data).map(tpdbScene).filter(Boolean);
    if (reverse) scenes.reverse();
    var meta = (j && j.meta) || {};
    return {
      count: meta.total || scenes.length,
      scenes: scenes,
      hasMore: (meta.current_page || 1) < (meta.last_page || 1),
    };
  }

  // 按工作室查询时把场景归回被查的工作室（见 tpdbSinceScenes 的同一处理由）。
  function tpdbStampStudio(res, uuid) {
    if (!res || !res.scenes || !uuid) return res;
    res.scenes.forEach(function (s) { if (s.studio) s.studio.id = uuid; });
    return res;
  }

  // 单个演员/站点的分页。
  // 演员 DESC：先用 uuid 打 `/performers/{uuid}/scenes` 子资源 —— parent uuid 实测可用，
  //   吃 per_page/page/orderBy、字段与 /scenes 一致，省掉一次 uuid→整数的解析请求。
  //   站点级记录/已删记录这里 404，再回退解析 parent（编号失败则按名字找）。
  // 站点与 ASC：仍走「解析成整数 + 干净的单键 /scenes」，site_operation 只认整数 site_id，
  //   ASC 的页号镜像也要先知道 last_page，预打一次子资源等于白花。
  function tpdbIdPage(box, kind, id, pageNum, perPage, dir, timeoutMs, nameHint) {
    var asc = String(dir).toUpperCase() === "ASC";
    var key = box.endpoint + "|" + kind + "|" + id;

    if (kind === "performer" && !asc) {
      var directPath = "/performers/" + encodeURIComponent(id) +
        "/scenes?per_page=" + perPage + "&page=" + pageNum + "&orderBy=recently_released";
      return tpdbGet(box, directPath, timeoutMs).then(function (j) {
        _tpdbLastPage[key] = (j && j.meta && j.meta.last_page) || 1;
        return tpdbResult(j, false);
      }, function (e) {
        if (!e || e.status !== 404) throw e;   // 网络/鉴权错误照旧上抛
        return null;                           // 站点级或已合并记录 → 回退
      }).then(function (direct) {
        if (direct) return direct;
        return tpdbResolvePerformer(box, id, nameHint, timeoutMs).then(function (intId) {
          if (intId == null) {
            return { count: 0, scenes: [], hasMore: false, skipped: [String(id)] };
          }
          return tpdbGet(box, tpdbBatchPath("performer", [intId], perPage, pageNum, ""), timeoutMs)
            .then(function (j) {
              _tpdbLastPage[key] = (j && j.meta && j.meta.last_page) || 1;
              return tpdbResult(j, false);
            });
        });
      });
    }

    return tpdbResolveId(box, kind, id, timeoutMs).then(function (intId) {
      if (intId == null) {
        return { count: 0, scenes: [], hasMore: false, skipped: [String(id)] };
      }
      function get(p) {
        // 单站点走 site_id + site_operation，单演员走 performers[] 单键
        return tpdbGet(box, tpdbPagePaths(kind, [intId], perPage, p, "")[0], timeoutMs);
      }
      var ownerStudio = kind === "studio" ? id : "";
      if (!asc) {
        // 接口固定按日期倒序
        return get(pageNum).then(function (j) {
          _tpdbLastPage[key] = (j && j.meta && j.meta.last_page) || 1;
          return tpdbStampStudio(tpdbResult(j, false), ownerStudio);
        });
      }
      // ASC：REST 排序参数被忽略 → 页号镜像 + 页内倒序
      var cached = _tpdbLastPage[key];
      var ready = cached ? Promise.resolve(cached) : get(1).then(function (j) {
        _tpdbLastPage[key] = (j && j.meta && j.meta.last_page) || 1;
        return _tpdbLastPage[key];
      });
      return ready.then(function (last) {
        var target = Math.max(1, last - pageNum + 1);
        return get(target).then(function (j) { return tpdbStampStudio(tpdbResult(j, true), ownerStudio); });
      });
    });
  }

  // 一批演员/站点的新片：一次批量请求覆盖所有人（多键 OR），不再逐个发子资源请求。
  // 15 个演员从「几十个请求」降到 1–2 个；被源删掉/合并的 id 只进 skipped。
  // 单演员时（发现页只有当前演员）额外允许名字回退，救回站点级编号那种必 404 的情况。
  function tpdbSinceScenes(box, kind, ids, since, perPage, timeoutMs, nameHint) {
    var resolving = (kind === "performer" && ids.length === 1 && nameHint)
      ? tpdbResolvePerformer(box, ids[0], nameHint, timeoutMs).then(function (id) {
        return id != null
          ? { ids: [id], skipped: [] }
          : { ids: [], skipped: [String(ids[0])] };
      })
      : tpdbResolveIds(box, kind, ids, timeoutMs);
    return resolving.then(function (r) {
      if (!r.ids.length) {
        return { count: 0, scenes: [], hasMore: false, truncated: false, skipped: r.skipped };
      }
      var out = [], seen = {}, truncated = false, startedAt = Date.now();
      function step(p) {
        // 结果按日期倒序；碰到早于 since 的场景即可停止翻页。
        // 站点维度这里是 N 条 URL 并发（演员维度只有 1 条），单个站点失败不影响其他站点。
        return Promise.all(tpdbPagePaths(kind, r.ids, perPage, p, since).map(function (u) {
          return tpdbGet(box, u, timeoutMs).then(function (j) {
            return j;
          }, function () { return null; });
        })).then(function (pages) {
          var reachedOld = false, got = 0, maxLast = 1;
          pages.forEach(function (j, idx) {
            if (!j) return;
            // 工作室查询的第一层返回的是子站点（site_operation=Site/Parent 会带出
            // 全部子站点的片），场景的 site 字段指向子站点。总览按场景的 studio 分组，
            // 不归位就会把 500 条片拆成几百个「工作室」——顺手把每工作室上限也一起冲垮。
            var owner = (kind === "studio" && r.byId) ? r.byId[r.ids[idx]] : "";
            var rows = asArr(j.data);
            got += rows.length;
            rows.forEach(function (raw) {
              var s = tpdbScene(raw);
              if (!s) return;
              if (since && !(s.release_date && s.release_date > since)) { reachedOld = true; return; }
              if (seen[s.id]) return;
              seen[s.id] = true;
              if (owner && s.studio) s.studio = { id: owner, name: s.studio.name };
              out.push(s);
            });
            var last = (j.meta && j.meta.last_page) || 1;
            if (last > maxLast) maxLast = last;
          });
          if (!reachedOld && got && p < maxLast) {
            // 到页数上限但源还有更早场景 → 记录截断，UI 只在真截断时提示（用户 2026-10-26）
            if (p >= TPDB_MAX_PAGES_BATCH) { truncated = true; return; }
            // 时间预算用完也停：首屏不能为了翻页等二十秒
            if (Date.now() - startedAt > TPDB_BATCH_BUDGET_MS) { truncated = true; return; }
            return step(p + 1);
          }
        });
      }
      return step(1).then(function () {
        out.sort(function (a, b) {
          return String(b.release_date || "").localeCompare(String(a.release_date || ""));
        });
        return { count: out.length, scenes: out, hasMore: false, truncated: truncated, skipped: r.skipped };
      });
    });
  }

  function tpdbGlobalPage(box, pageNum, perPage, timeoutMs) {
    // TPDB 官方 REST 用 orderBy（小写枚举）；无热度榜，统一按最新入库
    var q = "/scenes?per_page=" + perPage + "&page=" + pageNum + "&orderBy=recently_created";
    return tpdbGet(box, q, timeoutMs).then(function (j) { return tpdbResult(j, false); });
  }

  function filterIds(filter) {
    if (!filter) return [];
    var v = filter.value;
    if (Array.isArray(v)) return v.filter(Boolean).map(String);
    if (typeof v === "string" && v) return [v];
    return [];
  }

  // stash-box SceneQueryInput 同构入参；TPDB 走 REST，其余源走 GraphQL
  function callBoxSceneList(box, input, timeoutMs) {
    if (!isTPDBBox(box)) {
      return callBoxGQL(
        box.endpoint, boxKey(box),
        "query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{" + BOX_SCENE_FIELDS + "}}}",
        { input: input }, timeoutMs
      ).then(function (d) { return (d && d.queryScenes) || null; });
    }
    var inp = input || {};
    var pageNum = inp.page || 1;
    var perPage = Math.min(100, inp.per_page || 100);
    var dir = String(inp.direction || "DESC").toUpperCase();
    var since = inp.date && inp.date.value ? String(inp.date.value) : "";
    var perf = filterIds(inp.performers);
    var stud = filterIds(inp.studios);
    // 编号解析不出来时按名字找同名的 parent 记录，名字取当前正在看的演员
    //（发现页和总览的查询都是围绕它发的）
    var nameHint = (typeof _state !== "undefined" && _state && _state.performerName) || "";
    if (since && (perf.length || stud.length)) {
      return tpdbSinceScenes(box, perf.length ? "performer" : "studio",
        perf.length ? perf : stud, since, perPage, timeoutMs, nameHint);
    }
    if (perf.length === 1) return tpdbIdPage(box, "performer", perf[0], pageNum, perPage, dir, timeoutMs, nameHint);
    if (stud.length === 1) return tpdbIdPage(box, "studio", stud[0], pageNum, perPage, dir, timeoutMs, nameHint);
    if (!since && (perf.length || stud.length)) {
      // 窗口不限（0 天）：按 id 逐个取，避免退化成全站页 + 客户端过滤
      return tpdbSinceScenes(box, perf.length ? "performer" : "studio",
        perf.length ? perf : stud, "", perPage, timeoutMs, nameHint);
    }
    return tpdbGlobalPage(box, pageNum, perPage, timeoutMs);
  }

  // TPDB 演员列表（queryPerformers 返回的 gender/images 全空，改走 REST）
  function callBoxPerformerList(box, input, timeoutMs) {
    if (!isTPDBBox(box)) {
      return callBoxGQL(
        box.endpoint, boxKey(box),
        "query($input:PerformerQueryInput!){queryPerformers(input:$input){count performers{id name gender birth_date images{url} scene_count}}}",
        { input: input }, timeoutMs
      ).then(function (d) { return (d && d.queryPerformers) || null; });
    }
    var inp = input || {};
    var perPage = Math.min(100, inp.per_page || 24);
    var q = "/performers?per_page=" + perPage + "&page=" + (inp.page || 1);
    if (inp.q) q += "&q=" + encodeURIComponent(inp.q);
    return tpdbGet(box, q, timeoutMs).then(function (j) {
      var rows = ((j && j.data) || []).map(function (p) {
        var ex = p.extras || p.extra || {};
        var g = String(ex.gender || "").toUpperCase();
        var img = p.image || p.thumbnail || p.face || "";
        return {
          id: p.id,
          name: p.name || "",
          gender: g === "FEMALE" ? "FEMALE" : (g === "MALE" ? "MALE" : null),
          birth_date: ex.birthday || null,
          images: img ? [{ url: img }] : [],
          scene_count: 0,
        };
      });
      return { count: (j && j.meta && j.meta.total) || rows.length, performers: rows };
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
    entityType: "performer",  // "performer" | "studio"（P7 工作室 tab 复用同一条渲染管线）
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
    boxTruncated: {},          // endpoint -> true when TPDB hit its page cap
    boxSkipped: {},            // endpoint -> 被源删掉/合并、无法解析整数 id 的条目数
    boxByName: {},             // endpoint -> true when the ID failed and we matched by name
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
    // 临时查看已忽略（用户 2026-10-30）：只改这一屏看不看，不动忽略记录。
    // 与「不限时间（本次）」同口径 —— 都是 session 内的观看辅助，换人/刷新即复位
    showIgnored: false,
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

  function getStudioIdFromUrl() {
    var m = window.location.pathname.match(/\/studios?\/(\d+)/);
    if (m) return m[1];
    m = window.location.hash.match(/\/studios?\/(\d+)/);
    return m ? m[1] : null;
  }

  function isStudioPage() {
    return /\/studios?\/\d+/.test(window.location.pathname + window.location.hash);
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

  // P7 工作室 tab：字段结构与演员一致（name + stash_ids），下游 stashIdMap 构建共用
  function loadLocalStudio(studioId) {
    return callGQL(
      "query($id:ID!){findStudio(id:$id){id name stash_ids{endpoint stash_id}}}",
      { id: studioId }
    ).then(function (data) { return data.findStudio; });
  }

  // 按过滤条件收集本地场景键（endpoint:stash_id + code），演员/工作室共用：
  // 演员传 {performers:{value:[id],...}}，工作室传 {studios:{value:[id],...}}
  function loadLocalSceneKeys(sceneFilter) {
    var keys = {};
    var page = 1, perPage = 200;

    function fetchPage() {
      return callGQL(
        "query($f:FindFilterType!,$sf:SceneFilterType!){findScenes(filter:$f,scene_filter:$sf){count scenes{id code stash_ids{endpoint stash_id}}}}",
        {
          f: { page: page, per_page: perPage },
          sf: sceneFilter
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
    "performers { as performer { id name images { url } } } " +
    "tags { id name } " +
    "images { url }";

  // Fetch ONE page from a stash-box (lazy loading — never pulls all 1000+ scenes).
  // Page size is dynamic (_state.boxPageSize, 20–100): starts at the box maximum
  // (stash-box clamps per_page to 100 in getPagination) and adapts to the observed
  // missing density — shrinks to the expected need when density is high, regrows
  // toward the max when it is low or the remaining need increases.
  function fetchBoxPage(box, stashId, pageNum) {
    var boxPerPage = _state.boxPageSize;
    var input = Object.assign(
      // P7：工作室 tab 按 studios INCLUDES 查（stash-box 层级匹配含母厂牌）
      _state.entityType === "studio"
        ? { studios: { value: [stashId], modifier: "INCLUDES" } }
        : { performers: { value: [stashId], modifier: "INCLUDES" } },
      {
        sort: "DATE",
        direction: _state.sortDir,
        page: pageNum,
        per_page: boxPerPage,
      }
    );
    return _boxRateLimiter.submit(function () {
      // TPDB 的 queryScenes 恒返回空（服务端故障），内部自动改走 REST
      return callBoxSceneList(box, input);
    }).then(function (result) {
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
        hasMore: result.hasMore != null ? result.hasMore : result.scenes.length >= boxPerPage,
        truncated: !!result.truncated,
        skipped: result.skipped || [],
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
        if (result.truncated) _state.boxTruncated[b.endpoint] = true;
        if (result.skipped && result.skipped.length) {
          // 累加：多页各自的跳过名单不重复
          var prev = _state.boxSkipped[b.endpoint] || [];
          result.skipped.forEach(function (u) {
            if (prev.indexOf(u) < 0) prev.push(u);
          });
          _state.boxSkipped[b.endpoint] = prev;
        }
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
        box.endpoint, boxKey(box),
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

  function isSceneOwned(item, keys) {
    var sc = item.scene;
    var owned = keys || _state.localSceneKeys;
    var epKey = item.endpoint.toLowerCase() + ":" + String(sc.id).toLowerCase();
    if (owned[epKey]) return true;
    if (sc.code) {
      var codeKey = "code:" + String(sc.code).trim().toLowerCase();
      if (owned[codeKey]) return true;
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
    _state.boxTruncated = {};
    _state.boxSkipped = {};
    _state.boxByName = {};
    _state.boxPageSize = 100;
    _state.boxFetchedTotal = 0;
    _state.boxTotalCount = 0;
    _state.droppedByWindow = 0;
    _state.preferredFallback = false;
    _state.preferredBoxLabel = "";
    _state.showIgnored = false;
    _state.allLoaded = false;
    _state.loadingPage = false;
    // 换人 / 重扫：上一页的选择集与条目都不再有意义（key 对不上，留着只会
    // 让「已选 N」显示成一个永远清不掉的幽灵数）
    _tabSel.on = false;
    _tabSel.keys = {};
    _tabSel.items = [];
    _tabSel.prog = "";
    renderTabContent();

    var isStudio = _state.entityType === "studio";
    return Promise.all([
      isStudio ? loadLocalStudio(performerId) : loadLocalPerformer(performerId),
      loadLocalSceneKeys(isStudio
        ? { studios: { value: [performerId], modifier: "INCLUDES" } }
        : { performers: { value: [performerId], modifier: "INCLUDES" } }),
      getStashBoxes(),
      getPluginSettings(),
    ]).then(function (results) {
      var performer = results[0]; // 演员或工作室实体（name + stash_ids 结构一致）
      var localKeys = results[1];
      var boxes = results[2];
      var settings = results[3];

      if (!performer) throw ssdError("fatal", isStudio
        ? tc("未找到工作室", "Studio not found")
        : tc("未找到演员", "Performer not found"));

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
        throw ssdError("no-ids", isStudio
          ? tc("该工作室未关联任何 stash-box ID，请先在工作室编辑页添加 stash_id",
            "This studio has no stash-box IDs. Add a stash_id in the studio edit page first.")
          : tc("该演员未关联任何 stash-box ID，请先在演员编辑页添加 stash_id",
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
    _state.boxTruncated = {};
    _state.boxSkipped = {};
    _state.boxByName = {};
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
    return buildLocalPerformerIndex(endpoint).then(function (idx) { return idx.byStashId; });
  }

  // ─── 本地演员索引 + 建档四步判定（§4.5）────────────────────────────────
  // 一次 findPerformers(per_page:-1) 建三张表，零额外请求：
  //   byStashId 同源 id → 记录；byName 归一化主名 → [记录]；byAlias 归一化别名 → [记录]
  // 注意必须是「未裁剪」的全量：discover.js 的 loadLinkedPerformers 返回时只留带
  // 当前源 id 的演员，而第 2/3 步要认的恰恰是没有同源 id 的那类 —— 用那个建索引
  // 等于索引里全是第 1 步就该命中的，永远走不到主名/别名。
  var _perfIndexCache = {};          // endpoint → 索引（60s 内复用）
  var PERF_INDEX_TTL = 60 * 1000;

  // 归一化搬 tagMerge 的 normalize：NFKC（全角→半角）+ 小写 + 剔分隔符。
  // 现有的 normalizedName 只做 NFC + 去空白，认不出「ＡＩＫＡ」「Aika-Honda」。
  function normName(s) {
    var t = String(s == null ? "" : s);
    try { t = t.normalize("NFKC"); } catch (_) {}
    return t.toLowerCase().replace(/[\s·、，,。/\-—_・]+/g, "");
  }

  // 源名「三上悠亜 (Yua Mikami)」→ 括号内外各试一次（先外后内），纯字符串处理
  function nameVariants(name) {
    var out = [];
    var n = String(name || "").trim();
    if (!n) return out;
    out.push(n);
    var m = /^(.*?)\s*[（(]([^()（）]+)[)）]\s*$/.exec(n);
    if (m) {
      if (m[1] && m[1].trim()) out.push(m[1].trim());
      if (m[2] && m[2].trim()) out.push(m[2].trim());
    }
    return out;
  }

  function pushUniq(arr, item) {
    for (var i = 0; i < arr.length; i++) if (arr[i].id === item.id) return;
    arr.push(item);
  }

  function buildLocalPerformerIndex(endpoint) {
    var ep = String(endpoint || "").toLowerCase();
    var c = _perfIndexCache[ep];
    if (c && Date.now() - c.at < PERF_INDEX_TTL) return Promise.resolve(c);
    return callGQL(
      "query{findPerformers(filter:{per_page:-1}){performers{id name image_path alias_list stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var idx = { byStashId: {}, byName: {}, byAlias: {}, at: Date.now() };
      (((data || {}).findPerformers || {}).performers || []).forEach(function (p) {
        if (!p || !p.id) return;
        var rec = { id: p.id, name: p.name, image_path: p.image_path,
                    stash_ids: p.stash_ids || [], aliases: p.alias_list || [] };
        (p.stash_ids || []).forEach(function (sid) {
          if (sid && sid.stash_id && String(sid.endpoint || "").toLowerCase() === ep) {
            idx.byStashId[String(sid.stash_id).toLowerCase()] = rec;
          }
        });
        var nk = normName(p.name);
        if (nk) { (idx.byName[nk] = idx.byName[nk] || []); pushUniq(idx.byName[nk], rec); }
        // 实测有别名是一整串逗号拼接（"An Mitsumi, Fujii Ranran, 蜜美杏, …"），
        // 不拆等于只认第一个名字
        (p.alias_list || []).forEach(function (a) {
          String(a || "").split(/[,、;\/]/).forEach(function (part) {
            var k = normName(part);
            if (k) { (idx.byAlias[k] = idx.byAlias[k] || []); pushUniq(idx.byAlias[k], rec); }
          });
        });
      });
      _perfIndexCache[ep] = idx;
      return idx;
    });
  }

  function indexRemember(idx, rec, endpoint, stashId) {
    if (!idx || !rec) return;
    idx.byStashId[String(stashId).toLowerCase()] = rec;
    var nk = normName(rec.name);
    if (nk) { (idx.byName[nk] = idx.byName[nk] || []); pushUniq(idx.byName[nk], rec); }
  }

  // 同源 id 打架才算「不同人」：stash_ids 本来就是多源数组，身上同时挂 stashdb
  // 和 favdb 的 id 是正常状态，不能拿「已有别的源 id」当不同人的证据
  function sameSourceConflict(rec, ep, stashId) {
    return (rec.stash_ids || []).some(function (sid) {
      return sid && sid.stash_id &&
        String(sid.endpoint || "").toLowerCase() === ep &&
        String(sid.stash_id) !== String(stashId);
    });
  }

  // 只做判定、不写库（弹窗里要显示「关联 M 位已有 · 新建 N 位」）
  function planPerformer(endpoint, boxPerf, idx) {
    var ep = String(endpoint || "").toLowerCase();
    var sid = String(boxPerf.id || "");
    var hit = idx.byStashId[sid.toLowerCase()];
    if (hit) return { boxId: sid, name: boxPerf.name, how: "id", rec: hit };

    var byName = [];
    nameVariants(boxPerf.name).forEach(function (n) {
      (idx.byName[normName(n)] || []).forEach(function (r) { pushUniq(byName, r); });
    });
    var okName = byName.filter(function (r) { return !sameSourceConflict(r, ep, sid); });
    if (okName.length === 1) return { boxId: sid, name: boxPerf.name, how: "name", rec: okName[0] };
    if (okName.length > 1) return { boxId: sid, name: boxPerf.name, how: "ambiguous", rec: null };

    var variants = [];
    nameVariants(boxPerf.name).concat(boxPerf.aliases || []).forEach(function (n) {
      var k = normName(n);
      if (k && variants.indexOf(k) === -1) variants.push(k);
    });
    var byAlias = [];
    variants.forEach(function (k) {
      (idx.byAlias[k] || []).forEach(function (r) { pushUniq(byAlias, r); });
    });
    var okAlias = byAlias.filter(function (r) { return !sameSourceConflict(r, ep, sid); });
    if (okAlias.length === 1) return { boxId: sid, name: boxPerf.name, how: "alias", rec: okAlias[0] };
    return { boxId: sid, name: boxPerf.name, how: "new", rec: null };
  }

  function planPerformers(endpoint, list) {
    return buildLocalPerformerIndex(endpoint).then(function (idx) {
      var plan = [], seen = {};
      (list || []).forEach(function (p) {
        if (!p || !p.id) return;
        var sid = String(p.id).toLowerCase();
        if (seen[sid]) return;
        seen[sid] = 1;
        plan.push(planPerformer(endpoint, p, idx));
      });
      return { idx: idx, plan: plan };
    });
  }

  // 执行判定结果：先补 id（performerUpdate 的 stash_ids 是整体替换，必须
  // 「原有数组 + 新条目」合并，否则会把该演员其他源的 id 全冲掉），再建新档
  // mode: "all"（默认，找不到就新建）/ "existing"（只关联库里已有的，不新建）
  function executePerformerPlan(endpoint, idx, plan, memo, mode) {
    var ep = String(endpoint || "").toLowerCase();
    var allowCreate = mode !== "existing";
    var out = { ids: [], linked: 0, created: 0, ambiguous: 0, failed: 0, skipped: 0 };

    function linkOne(it) {
      var rec = it.rec;
      var merged = mergeStashIds(rec.stash_ids, endpoint, it.boxId);
      return callGQL(
        "mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}",
        { input: { id: rec.id, stash_ids: merged } }
      ).then(function () {
        rec.stash_ids = merged;
        indexRemember(idx, rec, endpoint, it.boxId);
        if (memo) memo[ep + ":" + String(it.boxId).toLowerCase()] = rec.id;
        out.ids.push(rec.id);
        out.linked++;
      });
    }

    function createOne(it) {
      var nm = it.name || tc("未知演员", "Unknown");
      var input = { name: nm, stash_ids: [{ endpoint: endpoint, stash_id: String(it.boxId) }] };
      return callGQL(
        "mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}",
        { input: input }
      ).then(function (d) {
        var id = d && d.performerCreate && d.performerCreate.id;
        if (!id) { out.failed++; return; }
        indexRemember(idx, { id: id, name: nm, stash_ids: input.stash_ids, aliases: [] }, endpoint, it.boxId);
        if (memo) memo[ep + ":" + String(it.boxId).toLowerCase()] = id;
        out.ids.push(id);
        out.created++;
        if (it.how === "ambiguous") out.ambiguous++;
      });
    }

    // 串行：同一演员并发建档会建出两条
    var chain = Promise.resolve();
    plan.forEach(function (it) {
      chain = chain.then(function () {
        // 本页内已经建过/关联过（批量入库同一演员会连着出现多次）
        var mk = ep + ":" + String(it.boxId).toLowerCase();
        if (memo && memo[mk]) { out.ids.push(memo[mk]); return; }
        if (it.how === "id") { out.ids.push(it.rec.id); return; }
        if (it.how === "name" || it.how === "alias") {
          return linkOne(it).catch(function (e) {
            console.warn("[SSD] link performer failed, falling back to create:", e && e.message);
            if (!allowCreate) { out.skipped++; return; }
            return createOne({ boxId: it.boxId, name: it.name, how: "new" }).catch(function () { out.failed++; });
          });
        }
        // 「只关联已有」：判不出来是谁的一律跳过，绝不新建
        if (!allowCreate) { out.skipped++; return; }
        return createOne(it).catch(function () { out.failed++; });
      });
    });
    return chain.then(function () { return out; });
  }

  // 本地工作室索引：一次拉全量，byStashId 认源编号、byName 认名字。
  // 入库弹窗要在「不写库」的前提下算出「已匹配 / 将新建」，逐个 q= 查做不到
  // （命中未知就没得研判），全量索引一次请求即可，和标签侧同一套结构。
  var _studioIndex = null;
  function loadStudioIndex() {
    if (_studioIndex) return Promise.resolve(_studioIndex);
    return callGQL(
      "query{findStudios(filter:{per_page:-1}){studios{id name stash_ids{endpoint stash_id}}}}"
    ).then(function (d) {
      var idx = { byStashId: {}, byName: {} };
      ((((d || {}).findStudios || {}).studios) || []).forEach(function (s) {
        if (!s || !s.id) return;
        (s.stash_ids || []).forEach(function (sid) {
          if (sid && sid.stash_id && sid.endpoint) {
            idx.byStashId[String(sid.endpoint).toLowerCase() + ":" +
              String(sid.stash_id).toLowerCase()] = s.id;
          }
        });
        if (s.name) idx.byName[String(s.name).toLowerCase()] = s.id;
      });
      _studioIndex = idx;
      return idx;
    }).catch(function () { return { byStashId: {}, byName: {} }; });
  }

  // ─── Tab injection ────────────────────────────────────────────────────────

  var _tabInjected = false;
  var _tabPerformerId = null;

  function ensureTabInjected() {
    var studioPage = isStudioPage();
    if (!isPerformerPage() && !studioPage) return;
    var pid = studioPage ? getStudioIdFromUrl() : getPerformerIdFromUrl();
    if (!pid) return;
    _state.entityType = studioPage ? "studio" : "performer";

    var nav = document.querySelector(".performer-tabs .nav-tabs")
      || document.querySelector(".performer-page .nav-tabs")
      || document.querySelector(".studio-tabs .nav-tabs")
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

    // 发现页 §8.1「发现 Tab」按钮跳转：sessionStorage 标记 → 自动激活 tab
    try {
      if (sessionStorage.getItem("SSD:dp:openTab") === String(pid)) {
        sessionStorage.removeItem("SSD:dp:openTab");
        setTimeout(activateTab, 60);
      }
    } catch (_) {}
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

  // Close any open sort dropdown (outside click / Escape) — covers both the
  // performer tab pane and the discover page
  function closeSortDropdowns() {
    document.querySelectorAll(
      ".ssd-tab-pane .sort-by-select.show, .ssd-dp-page .sort-by-select.show"
    ).forEach(function (g) {
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
      if (e.target.closest && e.target.closest(".ssd-tab-pane .sort-by-select, .ssd-dp-page .sort-by-select")) return;
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

  // 「临时查看已忽略（本次）」：同 setWindowRelaxed，是观看辅助 —— 不写忽略记录、
  // 不改库，只把这一屏的隐藏效果暂时关掉（用户 2026-10-30）。
  // 不重扫源站：卡片本来就在 cachedMissing 里，只是被过滤器挡住了。
  function setIgnoredShown(on) {
    _state.showIgnored = !!on;
    _state.currentPage = 1;
    renderTabContent();
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
    "ignored-hidden": ["场景都已被忽略", "All scenes are ignored"],
    fatal: ["加载失败", "Loading failed"],
  };

  function panelTitle(vs) {
    if (vs === "empty") {
      if (_state.droppedByWindow > 0) {
        return tc("当前时间窗口内没有剩余场景", "Nothing left inside the time window");
      }
      return tc("源上没有待发现的场景", "Nothing left to discover on the source");
    }
    // 搜索还在生效时，抬头说「都被忽略」不准确 —— 挡住结果的是搜索，不是忽略
    if (vs === "ignored-hidden" && (_state.searchQuery || "").trim()) {
      return tc("没有匹配的场景", "No matching scenes");
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
      setBtn.onclick = function () { window.open(appUrl("/settings"), "_blank", "noopener,noreferrer"); };
      actions.appendChild(setBtn);

    } else if (vs === "no-box") {
      body.appendChild(panelDesc(tc(
        "本插件从已配置的 stash-box 读取场景。请在 设置 → 元数据提供者 中添加至少一个实例，然后重试。",
        "Scenes are read from configured stash-boxes. Add at least one in Settings → Metadata Providers, then retry.")));
      var retryBtn2 = makePanelBtn(tc("重试", "Retry"), "primary");
      retryBtn2.onclick = retryLoad;
      actions.appendChild(retryBtn2);
      var setBtn2 = makePanelBtn(tc("打开设置", "Open settings"), "secondary");
      setBtn2.onclick = function () { window.open(appUrl("/settings"), "_blank", "noopener,noreferrer"); };
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
        var entZh = _state.entityType === "studio" ? "该工作室" : "该演员";
        var entEn = _state.entityType === "studio" ? "studio" : "performer";
        lines.push(tc("首选源 " + _state.preferredBoxLabel + " 没有" + entZh + "的编号，已改查其他有编号的源。",
          "The preferred source " + _state.preferredBoxLabel + " has no ID for this " + entEn + ", so the other sources that do were queried."));
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

    } else if (vs === "ignored-hidden") {
      // 已发现的片全被忽略：直说，并且给「临时查看」入口。忽略记录不动 ——
      // 看只是想确认「忽略的是哪部」，不是要收回忽略（用户 2026-10-30）
      var ignN = hiddenIgnoredCount();
      var hasQuery = (_state.searchQuery || "").trim().length > 0;
      body.appendChild(panelDesc(hasQuery
        ? tc("当前搜索没有匹配的场景；另有 " + ignN + " 个已发现的场景被忽略了。",
             "No scene matches the search; " + ignN + " discovered scene(s) are ignored.")
        : tc("已发现的 " + ignN + " 个场景都被忽略了。",
             "All " + ignN + " discovered scene(s) are ignored.")));
      var showIgnBtn = makePanelBtn(hasQuery
        ? tc("清除搜索并查看已忽略", "Clear search & show ignored")
        : tc("查看已忽略的场景", "Show ignored scenes"), "primary");
      showIgnBtn.title = tc("临时显示已忽略的场景，不改忽略记录",
        "Temporarily show ignored scenes; the ignore list stays untouched");
      showIgnBtn.onclick = function () {
        // 搜索还挡着的话一并清掉，否则点了还是空屏
        if (hasQuery) _state.searchQuery = "";
        setIgnoredShown(true);
      };
      actions.appendChild(showIgnBtn);
      if (findEntryVisible("ignored-hidden")) actions.appendChild(findEntryBtn("lg", "info"));

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
    if (_state.findOpen && (vs === "no-ids" || vs === "empty" || vs === "no-match" || vs === "ignored-hidden")) {
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
    // 数值字段源里可能是 "168cm" 这种，直接写会让整个 mutation 被拒（§4.2）
    var hcm = numOrUndef(p.height);
    if (hcm !== undefined && need(localPerf.height_cm, hcm)) d.height_cm = hcm;
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
    if (_state.entityType === "studio") return false; // "在源上查找"为演员专属功能（P7 工作室 tab 隐藏）
    var multi = (_state.allBoxes || []).length > 1;
    if (vs === "no-ids") return true;
    if (vs === "empty") return multi || _state.preferredFallback;
    if (vs === "no-match" || vs === "content" || vs === "ignored-hidden") return _state.preferredFallback;
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
    // has one (faded grey); box not linked at all = plain box label (grey)
    var right = document.createElement("div");
    right.className = "ssd-find-right";
    var localId = localStashIdForBox(r);
    if (localId && localId.toLowerCase() === String(r.candidate.id).toLowerCase()) {
      right.appendChild(makeChip(tc("已关联 " + r.boxName, "Linked · " + r.boxName), "ok"));
    } else if (localId) {
      right.appendChild(makeChip(tc("已有 " + r.boxName, "Has ID · " + r.boxName), "dim"));
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
    linkBtn.title = tc("替换该源编号，其余字段与别名补齐（不改名）",
      "Replace this source's ID; fill the rest (name untouched)");
    linkBtn.disabled = busy;
    linkBtn.onclick = function (e) {
      e.stopPropagation();
      runFindAction(r, "link", linkBtn);
    };
    actions.appendChild(linkBtn);

    var owBtn = makePanelBtn(tc("覆盖", "Overwrite"), "accent", "md");
    owBtn.title = tc("以源为准覆盖本地，本地独有不删除",
      "Overwrite from the source; local-only values kept");
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

  // ─── 两处「忽略」按钮共用的外观（用户 2026-10-30）───────────────────────
  // 场景详情弹窗一直用旧版 .ssd-ban-btn（描边 + 图文字同色），与演员详情弹层
  // 的实心按钮不是一套；改成一个工厂：
  //   实心底 + 深红禁止图标 → 二次点击整颗转红、图标与文字转白（.danger）
  // 视觉定义只此一份（.ssd-dp-btn solid ssd-dp-banbtn），两处都走这里，
  // 不会再各自漂色。onConfirm 在第二次点击时触发，4 秒无操作自动复位。
  var BAN_SVG = '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true">' +
    '<path d="M367.2 412.5L99.5 144.8C77.1 176.1 64 214.5 64 256c0 106 86 192 192 192c41.5 0 79.9-13.1 111.2-35.5zm45.3-45.3C434.9 335.9 448 297.5 448 256c0-106-86-192-192-192c-41.5 0-79.9 13.1-111.2 35.5L412.5 367.2zM0 256a256 256 0 1 1 512 0A256 256 0 1 1 0 256z"/>' +
    "</svg>";
  function ssdBanButton(o) {
    var label = o.label || tc("忽略", "Ignore");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ssd-dp-btn solid ssd-dp-banbtn";
    btn.innerHTML = '<span class="ssd-dp-banico">' + BAN_SVG + "</span><span>" + label + "</span>";
    if (o.title) btn.title = o.title;
    if (o.aria) btn.setAttribute("aria-label", o.aria);
    function disarm() {
      clearTimeout(btn._armT);
      btn.removeAttribute("data-armed");
      btn.classList.remove("danger");
      var lab = btn.querySelector("span:last-child");
      if (lab) lab.textContent = label;
    }
    btn.addEventListener("click", function () {
      if (btn.getAttribute("data-armed") !== "1") {
        btn.setAttribute("data-armed", "1");
        btn.classList.add("danger");
        var lab = btn.querySelector("span:last-child");
        if (lab) lab.textContent = tc("确认忽略？", "Confirm?");
        clearTimeout(btn._armT);
        btn._armT = setTimeout(function () { if (btn.isConnected) disarm(); }, 4000);
        return;
      }
      disarm();
      if (typeof o.onConfirm === "function") o.onConfirm();
    });
    return btn;
  }

  // ─── 场景详情弹窗的动作按钮（用户 2026-10-30）────────────────────────────
  // 原来这三颗用旧版 .ssd-btn 三件套（4px 圆角 + text-shadow + 写死的 --ssd-*
  // 色），跟「演员详情弹层」「已忽略管理」不是一套。现在统一走 .ssd-dp-btn：
  // primary 实心（加入库）/ 描边（在源站打开）/ tonal 淡底（搜索资源），
  // 忽略仍是 solid 中性实心（见上方 ssdBanButton）——四颗各自可分辨，
  // 又都是同一套圆角、字号、间距与主题 token。
  // 文案单独一层 span：状态切换（准备中… / 搜索中…）只改字，不会把图标抹掉。
  var ACT_ADD_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var ACT_FIND_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
    '<path d="M16.5 16.5L21 21"/></svg>';

  function ssdActButton(o) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ssd-dp-btn" + (o.tone ? " " + o.tone : "");
    if (o.icon) btn.innerHTML = '<span class="ssd-dp-bico">' + o.icon + "</span>";
    var tx = document.createElement("span");
    tx.className = "ssd-dp-btxt";
    tx.setAttribute("data-ssd-lbl", "");
    tx.textContent = o.label;
    btn.appendChild(tx);
    // trailing 图标（源站按钮的外链箭头）不随文案变化，单独一层
    if (o.trail) {
      var tr = document.createElement("span");
      tr.className = "ssd-dp-bico ssd-dp-bico-trail";
      tr.innerHTML = o.trail;
      btn.appendChild(tr);
    }
    if (o.title) btn.title = o.title;
    if (typeof o.on === "function") btn.onclick = o.on;
    return btn;
  }

  // 只改文案层；没有该层（老按钮 / 别处传进来的节点）时退回整颗改字
  function setActLabel(btn, txt) {
    if (!btn) return;
    var t = btn.querySelector("[data-ssd-lbl]");
    if (t) t.textContent = txt;
    else btn.textContent = txt;
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
          ? tc("已覆盖：以源为准写入字段 " + filled + " 项，本地独有保留，正在重新查询…",
            "Overwritten — " + filled + " field(s) written from the source. Re-querying…")
          : tc("已关联：编号已写入，补齐字段 " + filled + " 项，正在重新查询…",
            "Linked — ID written, " + filled + " field(s) filled. Re-querying…"),
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

  // §6.3 / Q6：这位演员自己被忽略 → 整个 tab 换成占位 + 恢复按钮。
  // 光过滤结果会变成「一进 tab 就是空的」，用户不知道是没片还是被自己忽略了。
  function ignoredPerformerHit(stashIds) {
    if (!SSD.dpIgnore) return null;
    var recs = SSD.dpIgnore.performers();
    for (var i = 0; i < (stashIds || []).length; i++) {
      var sid = stashIds[i] || {};
      var k = SSD.dpIgnore.key(sid.endpoint, sid.stash_id);
      if (recs[k]) return { key: k, rec: recs[k], endpoint: sid.endpoint, stashId: sid.stash_id };
    }
    return null;
  }

  function buildIgnoredPerformerPane(hit) {
    var panel = document.createElement("div");
    panel.className = "ssd-panel ssd-panel--warn";
    var head = document.createElement("div");
    head.className = "ssd-panel-head";
    head.appendChild(panelIcon("warn"));
    var title = document.createElement("div");
    title.className = "ssd-panel-title";
    title.textContent = tc("这位演员已在发现页被忽略", "This performer is ignored on Discover");
    head.appendChild(title);
    panel.appendChild(head);

    var body = document.createElement("div");
    body.className = "ssd-panel-body";
    body.appendChild(panelDesc(tc(
      "忽略后「最新 / 关注 / 工作室」都不再查询这位演员，本页也不再出结果。点「恢复显示」立即生效。",
      "Ignored performers are excluded from Discover queries and listings. Restore to bring them back immediately.")));
    panel.appendChild(body);

    var actions = document.createElement("div");
    actions.className = "ssd-actions";
    var btn = makePanelBtn(tc("恢复显示", "Restore"), "primary");
    btn.onclick = function () {
      var r = SSD.dpIgnore.remove("performers", hit.key);
      if (!r.ok) {
        dpToast(tc("恢复失败：浏览器存储写不进去", "Restore failed: storage rejected the write"), { duration: 6000 });
        return;
      }
      try { window.dispatchEvent(new CustomEvent("ssd:ignore-changed")); } catch (_) {}
      _state.cachedMissing = [];
      _state.allLoaded = false;
      _state.currentPage = 1;
      loadAndRender(_state.perPage);
    };
    actions.appendChild(btn);
    panel.appendChild(actions);
    return panel;
  }

  // ─── 演员页「发现」tab 的多选（§P6）────────────────────────────────────
  // 交互骨架与发现页一致（勾选圈 / 全选本页 / 忽略 / 入库），但这一页是 Stash
  // 原生卡片网格，样式作用域不同，所以状态与 DOM 是独立一套；底层共用
  // dpIgnore 存储与 planSceneImport/submitSceneImport。
  var _tabSel = { on: false, keys: {}, items: [], busy: false, prog: "" };

  var SSD_ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';

  // 复选框两态（用户 2026-10-30）：全选用 空盒 / 盒+勾 表示开没开。
  // 多选入口不用勾选框（那会把「进多选」读成「已经全选」），改用「三行带勾」——
  // 它指的是批量操作这个能力，与全选那套是两种语言，不会混淆。
  // 图标共用 24 格 viewBox + 15px 显示尺寸，× 与全选视觉等大（之前 ×
  // 是文字 &times;，字号撑不出 15px，看起来比全选小一圈）。
  var SSD_ICON_BOX =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="3.5"/></svg>';
  var SSD_ICON_BOX_ON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="3.5"/><path d="M7.5 12.3l3.2 3.2 5.8-6.4"/></svg>';
  // 多选用「框里一支笔」的编辑图标（用户 2026-10-30）：框 = 要操作的这一屏卡片，
  // 笔 = 在上面做编辑。既不会像勾选框那样把「进多选」读成「已经全选」，也不会像
  // 「三行带勾」那样跟旁边的列表视图撞脸。发现页 I.selToggle 同款路径。
  var SSD_ICON_EDIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12.5 3H5.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-6.5"/>' +
    '<path d="M17.6 3.6l2.8 2.8L11.6 15l-3.7.9.9-3.7z"/></svg>';
  var SSD_ICON_X =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l15 15M19.5 4.5l-15 15"/></svg>';

  function tabSelKey(item) {
    var ep = item.endpoint || (item.box && item.box.endpoint) || "";
    return String(ep).toLowerCase() + ":" +
      String((item.scene && item.scene.id) || "").toLowerCase();
  }
  function tabSelHas(item) { return !!_tabSel.keys[tabSelKey(item)]; }

  // 当前页可选项：从 DOM 反查（同一套 __ssdItem），与用户看到的完全一致
  function tabSelPageItems() {
    var pane = document.querySelector(".ssd-tab-pane");
    var out = [];
    if (!pane) return out;
    pane.querySelectorAll(".ssd-scene-card, .ssd-scene-table tbody tr").forEach(function (n) {
      if (n.__ssdItem) out.push(n.__ssdItem);
    });
    return out;
  }

  function tabSelCount() {
    var n = _tabSel.items.length;
    var pageN = tabSelPageItems().length;
    var pane = document.querySelector(".ssd-tab-pane");
    var cnt = pane && pane.querySelector(".ssd-tabsel-count");
    if (cnt) {
      // Stash 原生多选就只给一个数字，不要「已选 N 部 · 本页 M 部」这类文案
      if (_tabSel.busy) cnt.textContent = _tabSel.prog || "…";
      else cnt.textContent = String(n);
      cnt.title = tc("已选 " + n + " 部 · 本页 " + pageN + " 部", n + " selected · " + pageN + " on page");
    }
    var ign = pane && pane.querySelector(".ssd-tabsel-ignore");
    var imp = pane && pane.querySelector(".ssd-tabsel-import");
    if (ign) ign.disabled = !n || _tabSel.busy;
    if (imp) imp.disabled = !n || _tabSel.busy;
    var all = pane && pane.querySelector(".ssd-tabsel-all");
    if (all) {
      var allOn = pageN > 0 && n >= pageN;
      all.classList.toggle("on", allOn);
      // 复选框图案自己就是状态显示：本页全选后填成「已勾选」，否则空盒
      all.innerHTML = allOn ? SSD_ICON_BOX_ON : SSD_ICON_BOX;
      all.title = allOn ? tc("取消全选", "Deselect this page") : tc("全选本页", "Select this page");
    }
  }
  function tabSelProg(t) {
    _tabSel.prog = t;
    tabSelCount();
  }

  // 就地打标记（不重绘：勾选一下就把 40 张卡重建一遍，滚动位置会跳）
  function tabSelPaint() {
    var pane = document.querySelector(".ssd-tab-pane");
    if (!pane) return;
    pane.querySelectorAll(".ssd-scene-card, .ssd-scene-table tbody tr").forEach(function (host) {
      var it = host.__ssdItem;
      if (!it) return;
      var on = tabSelHas(it);
      host.classList.toggle("is-sel", on);
      var box = host.querySelector(".ssd-dp-selbox");
      if (!box) {
        box = document.createElement("span");
        box.className = "ssd-dp-selbox";
        // 列表模式挂在封面格里（整行没有可定位的封面容器）
        var cell = host.tagName === "TR" ? host.querySelector("td") : host;
        if (cell) cell.appendChild(box);
      }
      box.innerHTML = on ? SSD_ICON_CHECK : "";
    });
    tabSelCount();
  }

  function tabSelToggle(item) {
    if (!item) return;
    var k = tabSelKey(item);
    if (_tabSel.keys[k]) {
      delete _tabSel.keys[k];
      _tabSel.items = _tabSel.items.filter(function (x) { return tabSelKey(x) !== k; });
    } else {
      _tabSel.keys[k] = 1;
      _tabSel.items.push(item);
    }
    tabSelPaint();
  }

  function tabSelAll() {
    var page = tabSelPageItems();
    if (!page.length) return;
    var allOn = page.every(tabSelHas);
    var keep = _tabSel.items.filter(function (it) { return page.indexOf(it) === -1; });
    _tabSel.items = keep.slice();
    _tabSel.keys = {};
    keep.forEach(function (it) { _tabSel.keys[tabSelKey(it)] = 1; });
    if (!allOn) {
      page.forEach(function (it) {
        _tabSel.keys[tabSelKey(it)] = 1;
        _tabSel.items.push(it);
      });
    }
    tabSelPaint();
  }

  function tabSelEnter() {
    if (_tabSel.busy || _tabSel.on) return;
    _tabSel.on = true;
    _tabSel.keys = {};
    _tabSel.items = [];
    _tabSel.prog = "";
    bindTabSelEsc();
    renderTabContent();
  }
  // Esc 退出（§8）：弹窗开着时让给弹窗，否则一次 Esc 关两样东西
  var _tabEscBound = false;
  function bindTabSelEsc() {
    if (_tabEscBound) return;
    _tabEscBound = true;
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !_tabSel.on || _tabSel.busy) return;
      if (document.querySelector(".ssd-modal")) return;
      tabSelExit();
    });
  }
  function tabSelExit() {
    if (!_tabSel.on || _tabSel.busy) return;
    _tabSel.on = false;
    _tabSel.keys = {};
    _tabSel.items = [];
    _tabSel.prog = "";
    renderTabContent();
  }

  // 批量忽略：只写忽略记录，**不从 cachedMissing 摘掉**（用户 2026-10-30）。
  // 卡片由 getFilteredMissing 的过滤器隐藏；摘掉的话「临时查看已忽略」就再也
  // 拿不回来 —— 而这条记录本身还躺在忽略库里，两处状态就对不上。
  function tabSelIgnore() {
    if (_tabSel.busy) return;
    var items = _tabSel.items.slice();
    if (!items.length) return;
    var keys = [], dropped = 0, failed = 0, already = 0;
    items.forEach(function (item) {
      // 已在忽略列表里的跳过（用户 2026-10-30）：重复忽略本身是幂等的 —— 不写重复键、
      // 不改原记录的 at。真正的坑在撤销：keys 里若混进早就被忽略的场景，一次撤销会把
      // 更早那次的决策一起删掉。跳过它，撤销就只回滚本次新增。
      if (isItemIgnored(item)) { already++; return; }
      var r = SSD.dpIgnore.ignoreScene(item);
      if (r && r.ok) {
        keys.push(r.key);
        dropped += r.dropped || 0;
      } else failed++;
    });
    _tabSel.on = false;
    _tabSel.keys = {};
    _tabSel.items = [];
    renderTabContent();
    if (!keys.length) {
      if (already) {
        SSD.toast(tc("选中的 " + already + " 部都已在忽略列表里，无需重复忽略",
                     "Selected " + already + " scenes are already ignored"), { duration: 4000 });
        return;
      }
      showModalNotice(tc("忽略失败：浏览器存储写不进去（可能已满）",
        "Ignore failed: browser storage rejected the write"), "error");
      return;
    }
    var msg = tc("已忽略 " + keys.length + " 部场景", keys.length + " scenes ignored") +
      (failed ? tc(" · " + failed + " 部失败", " · " + failed + " failed") : "") +
      (already ? tc(" · " + already + " 部已在列表，跳过", " · " + already + " already ignored, skipped") : "");
    if (dropped) msg += tc(" · 超出上限，淘汰最旧 " + dropped + " 条",
                           " · cap reached, dropped " + dropped + " oldest");
    SSD.toast(msg, {
      actionText: tc("撤销", "Undo"),
      duration: 6000,
      onAction: function () {
        keys.forEach(function (k) { SSD.dpIgnore.remove("scenes", k); });
        // 撤销后原地重扫一次，条数才对得上（记录已不在，重扫会重新捞回来）。
        // 必须真的调 loadMissingScenes：只清 cachedMissing 再 render 的话，这一屏
        // 会一直空着等用户手动刷新（2026-10-30 实测）。
        loadMissingScenes();
      },
    });
  }

  // 批量入库：串行 + 150ms 间隔，吃设置里的字段默认值（与发现页同一套）
  function tabSelImport() {
    if (_tabSel.busy) return;
    var items = _tabSel.items.slice();
    if (!items.length) return;
    _tabSel.busy = true;
    tabSelProg(tc("准备中…", "Preparing…"));
    var total = items.length, at = 0, ok = 0, skip = 0, lastErr = "";
    var failed = [], codeSet = {};

    callGQL("query{findScenes(filter:{per_page:-1}){scenes{code}}}").then(function (d) {
      (((d || {}).findScenes || {}).scenes || []).forEach(function (s) {
        if (s.code) codeSet[String(s.code).trim().toLowerCase()] = 1;
      });
    }).catch(function () {}).then(next);

    function next() {
      if (at >= total) return finish();
      var item = items[at++];
      var sc = item.scene || {};
      tabSelProg(tc(at + "/" + total + " 入库中…", at + "/" + total + " importing…"));
      var ck = sc.code ? String(sc.code).trim().toLowerCase() : "";
      if (ck && codeSet[ck]) { skip++; return tick(); }
      planSceneImport(item, sc).then(function (draft) {
        return submitSceneImport(draft, pickFromPrefs(draft));
      }).then(function () {
        ok++;
        var i = _state.cachedMissing.indexOf(item);
        if (i !== -1) _state.cachedMissing.splice(i, 1);
        tick();
      }).catch(function (e) {
        lastErr = (e && e.message) || String(e);
        console.warn("[SSD] tab batch import failed:", sc.id, e);
        failed.push(item);
        tick();
      });
    }
    function tick() { setTimeout(next, 150); }
    function finish() {
      _tabSel.busy = false;
      _tabSel.prog = "";
      // 失败项留在选择集里，原地重试
      _tabSel.on = failed.length > 0;
      _tabSel.items = failed.slice();
      _tabSel.keys = {};
      failed.forEach(function (it) { _tabSel.keys[tabSelKey(it)] = 1; });
      renderTabContent();
      SSD.toast("", {
        html: importSummaryHtml(ok, skip, failed.length),
        title: failed.length && lastErr ? lastErr : "",
        duration: 6000,
      });
    }
  }

  // 多选操作组：并进原生筛选栏（.filtered-list-toolbar），不再另起一行。
  // 按钮一律用原生 .btn 类 —— 颜色/高度/hover/圆角全部跟 Stash 自己的工具栏
  // 按钮一致，插件不再另造一套深色胶囊（用户 2026-10-29）。
  function buildTabSelbar() {
    var bar = document.createElement("div");
    bar.className = "ssd-tabsel";
    // 「退出 / 数量 / 全选」是同一个连体控件：包进原生 .btn-group 才有那圈
    // 大外框（bootstrap 的 `> .btn:not(:first-child){margin-left:-1px}` 把边框
    // 叠成一条，首尾各留一半圆角）。三个各自带圆角就是三个独立按钮（用户
    // 2026-10-30）。数量格是 span，挂 .btn 才吃得到同一套边框/底色。
    var core = document.createElement("div");
    core.className = "btn-group";
    core.setAttribute("role", "group");
    var x = document.createElement("button");
    x.type = "button";
    x.className = "btn btn-secondary ssd-tabsel-x";
    x.innerHTML = SSD_ICON_X;
    x.title = tc("退出多选（Esc）", "Exit selection (Esc)");
    x.onclick = tabSelExit;
    core.appendChild(x);

    var cnt = document.createElement("span");
    cnt.className = "btn btn-secondary ssd-tabsel-count";
    cnt.setAttribute("aria-live", "polite");
    core.appendChild(cnt);

    var all = document.createElement("button");
    all.type = "button";
    all.className = "btn btn-secondary ssd-tabsel-all";
    all.innerHTML = SSD_ICON_BOX;
    all.title = tc("全选本页", "Select this page");
    all.onclick = tabSelAll;
    core.appendChild(all);
    bar.appendChild(core);

    var ign = document.createElement("button");
    ign.type = "button";
    ign.className = "btn btn-secondary ssd-tabsel-ignore";
    ign.textContent = tc("忽略", "Ignore");
    ign.onclick = tabSelIgnore;
    bar.appendChild(ign);

    var imp = document.createElement("button");
    imp.type = "button";
    imp.className = "btn btn-primary ssd-tabsel-import";
    imp.textContent = tc("入库", "Add");
    imp.onclick = tabSelImport;
    bar.appendChild(imp);
    return bar;
  }

  // 卡片/表格行 → 条目。捕获阶段拦：卡片自身的 card.onclick = openModal
  // 走冒泡，这里 stopPropagation 之后弹窗不会开
  function bindTabSel(host) {
    host.addEventListener("click", function (e) {
      if (!_tabSel.on) return;
      var t = e.target;
      if (!t || !t.closest) return;
      var node = t.closest(".ssd-scene-card") || t.closest(".ssd-scene-table tbody tr");
      if (!node || !node.__ssdItem) return;
      e.preventDefault();
      e.stopPropagation();
      tabSelToggle(node.__ssdItem);
    }, true);
  }

  function renderTabContent() {
    // Drop any orphaned hover popovers from a previous render
    document.querySelectorAll(".popover.hover-popover-content").forEach(function (p) { p.remove(); });

    var pane = document.querySelector(".ssd-tab-pane");
    if (!pane) return;
    pane.innerHTML = "";
    // 选择态的作用域类：卡片定位、行高亮、分页隐藏都挂在这上面
    pane.classList.toggle("is-selecting", !!_tabSel.on);

    var ignHit = ignoredPerformerHit(_state.performerStashIds);
    if (ignHit) {
      pane.appendChild(buildIgnoredPerformerPane(ignHit));
      return;
    }

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

    // 多选入口（§P6）：只在有卡片可选的 content / no-match 态出现。
    // 位置在「每页 N 个」右侧、刷新左侧（用户 2026-10-30）—— 它和每页数量
    // 同属「影响这一屏怎么展示」，刷新是会打断浏览的动作，排在最外侧。
    if (showToolbar) {
      var selBtn = document.createElement("button");
      selBtn.type = "button";
      selBtn.className = "btn btn-secondary ssd-tabsel-btn" + (_tabSel.on ? " active" : "");
      selBtn.innerHTML = SSD_ICON_EDIT;
      selBtn.title = tc("多选", "Select");
      selBtn.setAttribute("aria-label", tc("多选", "Select"));
      selBtn.onclick = function () {
        if (_tabSel.on) tabSelExit(); else tabSelEnter();
      };
      toolbar.appendChild(selBtn);
    }

    // Refresh — plugin-specific (re-query stash-box)
    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "btn btn-secondary ssd-tab-refresh";
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
        // 每个网格把自己的档位记在 data-zoom 上（供窗口 resize 逐网格重排），
        // 而 layoutCardGrid 优先读它而不是 _state.zoom —— 拖动时不同步写回，
        // 重排就永远按渲染时那一档算，滑块看起来毫无反应（用户 2026-10-28 反馈）。
        pane.querySelectorAll(".ssd-card-grid").forEach(function (g) {
          g.setAttribute("data-zoom", String(_state.zoom));
        });
        layoutCardGrid();
      };
      zoomWrap.appendChild(zoomInput);
      toolbar.appendChild(zoomWrap);
    }

    // 多选态：工具栏原地变身（用户 2026-10-29）—— 不另起一行操作区，就是把
    // 搜索框那一段换成按钮组，形态与发现页一致。隐藏哪些控件见 CSS
    // .filtered-list-toolbar.is-selecting。
    if (showToolbar && _tabSel.on) {
      toolbar.classList.add("is-selecting");
      // 顺序与发现页一致：操作组在前，视图切换垫后
      toolbar.insertBefore(buildTabSelbar(), displayGroup);
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
      // 一条都不剩时分清「搜索没命中」和「都忽略了」：后者给一个临时查看入口，
      // 而不是让用户对着「清除搜索」白点（用户 2026-10-30）
      var ignHidden = _state.showIgnored ? 0 : hiddenIgnoredCount();
      pane.appendChild(buildStatePanel(ignHidden > 0 ? "ignored-hidden" : "no-match"));
      return;
    }

    // One meta row above the cards, always in this order: "time window relaxed"
    // chip → its restore button → preferred-source fallback chip → inline lookup
    // entry. Only the parts that apply are rendered. The four are grouped in
    // pairs so a very narrow viewport wraps between them instead of overflowing.
    if (_state.windowRelaxed || _state.preferredFallback || _state.showIgnored) {
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

      // 已经忽略的片重新出现在列表里：必须明说，否则「我明明忽略过的片怎么还在」
      if (_state.showIgnored) {
        winGroup.appendChild(makeChip(tc("已忽略：临时显示 · 本次", "Ignored: shown · this session"), "muted"));
        var hideIgnBtn = makePanelBtn(tc("恢复隐藏", "Hide again"), "secondary", "sm");
        hideIgnBtn.onclick = function () { setIgnoredShown(false); };
        winGroup.appendChild(hideIgnBtn);
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
        var ignShown = _state.showIgnored ? hiddenIgnoredCount() : 0;
        countInfo.textContent = tc(
          "第 " + _state.currentPage + " / " + totalPages + " 页 · 共 " + filtered.length + " 个"
            + (ignShown ? "（含 " + ignShown + " 个已忽略）" : ""),
          "Page " + _state.currentPage + " of " + totalPages + " · " + filtered.length + " total"
            + (ignShown ? " (" + ignShown + " ignored)" : ""));
      }
    } else {
      // Not all box pages fetched yet — results load on demand while paging
      countInfo.textContent = tc("第 " + _state.currentPage + " 页 · 已发现 " + filtered.length + " 个（翻页加载更多）",
        "Page " + _state.currentPage + " · " + filtered.length + " found (more load as you page)");
    }
    pane.appendChild(countInfo);

    // TPDB 走批量查询，整体最多 TPDB_MAX_PAGES_BATCH 页：
    // 只有源确实还有更早场景、被页数上限截断时才提示（用户 2026-10-26）
    var truncatedBox = _state.queryBoxes.filter(function (b) { return _state.boxTruncated[b.endpoint]; })[0];
    if (truncatedBox) {
      var capInfo = document.createElement("div");
      capInfo.className = "ssd-count-info ssd-count-line text-muted";
      var capCount = TPDB_MAX_PAGES_BATCH * 100;
      capInfo.textContent = tc("当前源最多回溯 " + capCount + " 部，已达上限。",
        "This source is limited to " + capCount + " scenes; this list reached that limit.");
      pane.appendChild(capInfo);
    }

    // 源里已不存在（被删/合并）或只给了站点级 id 的条目：跳过而不是整块报错
    var skippedBox = _state.queryBoxes.filter(function (b) { return _state.boxSkipped[b.endpoint]; })[0];
    if (skippedBox) {
      var skipInfo = document.createElement("div");
      skipInfo.className = "ssd-count-info ssd-count-line text-muted";
      var skipCount = (_state.boxSkipped[skippedBox.endpoint] || []).length;
      skipInfo.textContent = tc("已跳过 " + skipCount + " 项：当前源查不到对应记录。",
        skipCount + " skipped: this source has no matching record.");
      pane.appendChild(skipInfo);
    }

    // 编号在源里解析不出来（站点级记录/已被删或合并），改用同名 parent 记录查到的东西
    var nameBox = _state.queryBoxes.filter(function (b) { return _state.boxByName[b.endpoint]; })[0];
    if (nameBox) {
      var nameInfo = document.createElement("div");
      nameInfo.className = "ssd-count-info ssd-count-line text-muted";
      nameInfo.textContent = tc("编号在源上查不到，已按名字匹配同名演员的记录。",
        "ID not found on this source; matched a same-name performer instead.");
      pane.appendChild(nameInfo);
    }

    // 多选操作组已经并进筛选栏（见 toolbar 组装处），这里不再单独插一行

    if (_state.displayMode === "list") {
      var tbl = buildSceneTable(pageItems);
      var trows = tbl.querySelectorAll("tbody tr");
      for (var ri = 0; ri < trows.length && ri < pageItems.length; ri++) {
        trows[ri].__ssdItem = pageItems[ri];
      }
      pane.appendChild(tbl);
      bindTabSel(tbl);
      if (_tabSel.on) tabSelPaint();
    } else {
      var grid = document.createElement("div");
      grid.className = "ssd-card-grid";
      grid.setAttribute("data-zoom", String(_state.zoom));
      pageItems.forEach(function (item, idx) {
        var card = buildSceneCard(item, start + idx);
        card.__ssdItem = item;
        grid.appendChild(card);
      });
      pane.appendChild(grid);
      layoutCardGrid();
      bindTabSel(grid);
      if (_tabSel.on) tabSelPaint();
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

  function isItemIgnored(item) {
    if (!SSD.dpIgnore) return false;
    var ep = item.endpoint || (item.box && item.box.endpoint);
    return SSD.dpIgnore.isSceneIgnored(ep, item.scene && item.scene.id);
  }

  // 已发现但被忽略条数：给「全被忽略」的空态面板与提示条用
  function hiddenIgnoredCount() {
    if (!SSD.dpIgnore) return 0;
    return _state.cachedMissing.filter(isItemIgnored).length;
  }

  function getFilteredMissing() {
    var q = (_state.searchQuery || "").trim().toLowerCase();
    // 已忽略（§5.1 第 3 处）：这个 tab 原先只拿已读做角标统计、并不隐藏场景，
    // 忽略要单独过滤一次 —— 分页、搜索、计数都走这个函数，一处收口全生效。
    // 「临时查看已忽略」打开时跳过这段：卡片留着，封面挂「已忽略」徽章。
    var base = _state.cachedMissing;
    if (!_state.showIgnored) {
      base = base.filter(function (item) { return !isItemIgnored(item); });
    }
    if (!q) return base;
    return base.filter(function (item) {
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

  // Layout every rendered card grid (performer tab + discover page). Each
  // grid records its own zoom in data-zoom at render time, so one call —
  // including from the window resize handler — relayouts them all.
  function layoutCardGrid() {
    document.querySelectorAll(".ssd-card-grid").forEach(function (grid) {
      var cards = grid.querySelectorAll(".scene-card");
      // CSS grid 容器（发现页模块、窄屏演员弹窗）由网格轨道决定列宽：
      // 清掉可能残留的 inline width 后跳过（用户 2026-10-27）
      if (getComputedStyle(grid).display === "grid") {
        for (var k = 0; k < cards.length; k++) cards[k].style.width = "";
        return;
      }
      // 窄屏原生 Stash 卡片是单列全宽（实测 ≤576：容器宽 − 10px），旧公式
      // 多减了 30px。只对演员/工作室详情 tab 生效；发现页网格是 CSS grid
      // 已在上面跳过，演员弹窗 481–576 仍走公式（用户 2026-10-27）
      var narrowNative = window.innerWidth <= 576 &&
        !grid.closest(".ssd-dp-page") && !grid.closest(".ssd-dp-modal-scenes");
      var zoom = parseInt(grid.getAttribute("data-zoom"), 10);
      if (isNaN(zoom)) zoom = _state.zoom;
      var cardW;
      if (narrowNative) {
        cardW = Math.max(120, grid.clientWidth - 10);
      } else {
        var maxUsable = Math.max(120, grid.clientWidth - 30);
        var cols = Math.max(1, Math.ceil(maxUsable / ZOOM_WIDTHS[zoom]));
        cardW = maxUsable / cols - 10;
      }
      for (var i = 0; i < cards.length; i++) {
        cards[i].style.width = cardW + "px";
      }
    });
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

  // 封面候选依次回退：TPDB 的外站直链常因防盗链 403，失败后换下一张
  //（images 里随后是 TPDB 自托管的 poster / background）

  // 动图候选（外站 gif / webp）：直接塞进 src 时，网络失败要等浏览器
  // 超时才触发 onerror，期间封面是空的（先黑屏再恢复静态图）。
  // 方案 A+B（用户 2026-10-26）：静态图先行 + 首图后台探测；失败写入
  // sessionStorage 负缓存，切页重建卡片时不再重复等待。
  // 2026-10-26 补：TPDB 首图多为外站普通 jpg（manyvids / phncdn /
  // iwantclips），不是动图但同样会失败空白 → 判定从「动图」扩到
  // 「与后备图不同域」；next() 也跳过负缓存命中的候选，不再每次重试。
  var IMG_FAIL_KEY = "SSD:imgfail.v1";
  var IMG_FAIL_TTL = 12 * 3600 * 1000;
  // 失败 10 分钟后允许后台重探一次：网络抖动 / 并发过高造成的「假失败」
  // 不会把外站封面钉死 12 小时（用户 2026-10-26 实测 30 张里 24 张误判）
  var IMG_FAIL_RETRY = 10 * 60 * 1000;

  function animUrl(u) {
    return /\.gif(?:$|[?#])/i.test(u) || /\.webp(?:$|[?#])/i.test(u);
  }
  function hostOf(u) {
    try { return new URL(u, location.href).host; } catch (_) { return ""; }
  }
  // 首图需要「先显示静态后备」：动图，或与后备图不同域（外站直链）
  function riskyFirst(list) {
    if (!list || list.length < 2) return false;
    var h = hostOf(list[0]);
    return animUrl(list[0]) || (h && h !== hostOf(list[1]));
  }
  function imgFailMap() {
    try {
      var o = JSON.parse(sessionStorage.getItem(IMG_FAIL_KEY) || "{}");
      return (o && typeof o === "object") ? o : {};
    } catch (_) { return {}; }
  }
  function imgFailed(u) {
    var o = imgFailMap(), ts = o[u];
    if (!ts) return false;
    if (Date.now() - ts > IMG_FAIL_TTL) {
      delete o[u];
      try { sessionStorage.setItem(IMG_FAIL_KEY, JSON.stringify(o)); } catch (_) {}
      return false;
    }
    return true;
  }
  function markImgFailed(u) {
    if (!u) return;
    var o = imgFailMap();
    o[u] = Date.now();
    try { sessionStorage.setItem(IMG_FAIL_KEY, JSON.stringify(o)); } catch (_) {}
  }
  // 负缓存里仍有效的失败时间戳（0 = 没有 / 已过期）
  function imgFailTs(u) {
    var ts = imgFailMap()[u];
    return ts && Date.now() - ts <= IMG_FAIL_TTL ? ts : 0;
  }
  function clearImgFail(u) {
    var o = imgFailMap();
    if (!u || !(u in o)) return;
    delete o[u];
    try { sessionStorage.setItem(IMG_FAIL_KEY, JSON.stringify(o)); } catch (_) {}
  }
  // 清空整张负缓存（刷新按钮）：用户主动刷新就是想重来一遍，
  // 网络恢复 / 换节点后不该再被上一次的失败记录挡住（用户 2026-10-31）
  function clearAllImgFail() {
    try { sessionStorage.removeItem(IMG_FAIL_KEY); } catch (_) {}
  }

  function setCoverImage(img, images) {
    var list = (images || []).map(function (i) { return i && i.url; })
      .filter(function (u) { return typeof u === "string" && u; });

    // 需要「静态先行」的首图：动图，或与后备图不同域（外站直链）。
    // TPDB 的 images[0] 常是 manyvids / phncdn 等外站 jpg，防盗链失败
    // 前同样会空一段；不同域即视为需要探测（StashDB 首图与后备同域）。
    var risky = riskyFirst(list) ? list[0] : "";
    var rest = list.slice(risky ? 1 : 0);
    // 10 分钟内确认失败 → 直接静态图；更早的失败仍先静态，但后台重探一次
    var riskTs = risky ? imgFailTs(risky) : 0;
    if (riskTs && Date.now() - riskTs < IMG_FAIL_RETRY) risky = "";

    var idx = 0, curSrc = "", fallbackSrc = "";
    // 负缓存整张读一次：每次重建卡片会进来一次，循环里再逐条解析就白花 JSON.parse
    var failMap = imgFailMap(), now = Date.now();
    function next() {
      // 10 分钟内确认失败的候选跳过（抖动期不反复重演空白）；更早的失败仍试一次。
      // 原来这里只看 12h TTL，一次网络波动就把封面钉死到会话结束 ——
      // 详情弹窗那边一直是 10 分钟窗口（probeModalGallery），两边语义现在对齐
      //（用户 2026-10-31：换节点后弹窗能显示、列表一直空）。
      while (idx < rest.length) {
        var ts = failMap[rest[idx]];
        if (ts && now - ts < IMG_FAIL_RETRY) { idx++; continue; }
        break;
      }
      if (idx >= rest.length) { img.style.visibility = "hidden"; return; }
      curSrc = rest[idx++];
      fallbackSrc = curSrc;
      img.style.visibility = "visible";
      img.src = curSrc;
    }
    img.onerror = function () {
      markImgFailed(curSrc);
      next();
    };
    next();

    if (!risky) return;
    // 超时（慢图）不算失败：保留静态图，不写负缓存（用户 2026-10-26）
    probeUrl(risky, 15000).then(function (st) {
      if (st === "error") { markImgFailed(risky); return; }
      if (st !== "ok") return;
      clearImgFail(risky); // 重探成功，解除负缓存
      img.onerror = function () {
        markImgFailed(risky);
        if (fallbackSrc) {
          img.onerror = function () { img.style.visibility = "hidden"; };
          img.src = fallbackSrc;
        } else {
          img.style.visibility = "hidden";
        }
      };
      img.style.visibility = "visible";
      img.src = risky;
    });
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
      setCoverImage(img, item.images);
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
    // 列表模式同款标记：行里没有封面角标的位置，文字尾巴上补一个（同上，只在
    // 「临时查看已忽略」时出现）
    if (_state.showIgnored && isItemIgnored(item)) {
      var ignTag = document.createElement("span");
      ignTag.className = "ssd-row-ignored";
      ignTag.textContent = tc("已忽略", "Ignored");
      titleTd.appendChild(ignTag);
    }
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

  // ctx (optional): view state override for the discover page —
  // { zoom, queryBoxes, localPerformerMaps }. Defaults to the performer tab's.
  function buildSceneCard(item, idx, ctx) {
    var st = ctx || _state;
    var sc = item.scene;

    // Native Stash grid-card structure (themes apply automatically):
    //   .scene-card.grid-card.card > .video-section (.scene-card-preview +
    //   .studio-overlay + .scene-specs-overlay) + .card-section (title/date/desc)
    var card = document.createElement("div");
    card.className = "scene-card zoom-" + st.zoom + " grid-card card ssd-scene-card";

    var videoSection = document.createElement("div");
    videoSection.className = "video-section thumbnail-section";

    var preview = document.createElement("div");
    preview.className = "scene-card-preview";

    if (item.images.length > 0) {
      var img = document.createElement("img");
      img.className = "scene-card-preview-image";
      img.loading = "lazy";
      img.alt = sc.title || sc.code || "";
      setCoverImage(img, item.images);
      preview.appendChild(img);
    }

    // Box source pill — bottom-left corner (native has no fixed content there),
    // only meaningful with multiple stash-boxes.
    // 挂在 .thumbnail-section 而不是 .scene-card-preview：sfwswitch（社区「NSFW 模糊」
    // 插件）给 preview 整体上 blur(30px)，角标在这种子树里会跟着糊掉、字看不清
    // （用户 2026-10-28「库内徽章很不明显」的成因之一）。角标是文字信息，
    // 留在模糊层外更合理。
    if (st.queryBoxes.length > 1) {
      var boxBadge = document.createElement("span");
      boxBadge.className = "ssd-overlay-box";
      boxBadge.textContent = item.boxName;
      videoSection.appendChild(boxBadge);
    }

    // 「已忽略」角标：只在「临时查看已忽略」打开时出现。这些片平时被过滤器挡住，
    // 既然放出来了就得标明白 —— 否则用户以为忽略没生效（用户 2026-10-30）。
    // 插在「预告」之前：CSS 用相邻选择器把它后面的预告角标压下一行，两者不重叠。
    var shownIgnored = !!(st.showIgnored && isItemIgnored(item));
    if (shownIgnored) {
      var ignBadge = document.createElement("span");
      ignBadge.className = "ssd-overlay-ignored";
      ignBadge.textContent = tc("已忽略", "Ignored");
      videoSection.appendChild(ignBadge);
    }

    // Preview pill for future-dated scenes — top-left corner
    if (sc.release_date && sc.release_date > localDateStr(new Date())) {
      var prevBadge = document.createElement("span");
      prevBadge.className = "ssd-overlay-preview";
      prevBadge.textContent = tc("预告", "Preview");
      videoSection.appendChild(prevBadge);
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
    // 行数由插件 CSS 控制（默认 2 行，发现页窄屏 1 行）——inline style 无法被
    // 媒体查询覆盖，只能靠 !important，故迁到样式表（用户 2026-10-27）
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
          return buildPerformerPopoverContent(performers, item.endpoint, st.localPerformerMaps);
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

  function buildPerformerPopoverContent(performers, endpoint, localMaps) {
    var frag = document.createDocumentFragment();
    var localMap = (localMaps || _state.localPerformerMaps || {})[(endpoint || "").toLowerCase()] || {};

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
      img.src = appUrl("/performer/" + lp.id + "/image");
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
  var _modalBackId = 0;   // 返回键垫层 id（modalBack.hold 的返回值）
  var _carouselIdx = 0;
  var _modalImages = []; // current open modal's image URL list (cover + DMM shots)
  var _modalGalleryDone = false;
  var _modalListProbed = null;  // Promise<list 中实际可加载的 URL>
  var _modalKeep = [];          // 探测通过的列表图（动图优先）
  var _modalExtra = [];         // 详情图 + DMM 截图
  var _searchPage = 1;
  var _searchPerPage = 20;
  var _searchResults = [];
  var _searchLow = [];          // 标题匹配度低、默认折叠的结果

  function openModal(item) {
    _state.modal = item;
    _state.modalDetail = null;
    _state.modalLoading = true;
    hidePerformerCard();
    _carouselIdx = 0;
    var list = (item.images || []).map(function (i) { return i && i.url; })
      .filter(function (u) { return typeof u === "string" && u; });
    _modalGalleryDone = false;
    _modalKeep = [];
    _modalExtra = [];
    _searchPage = 1;
    _searchResults = [];
    _searchLow = [];
    // 外站直链可能被防盗链拒绝或只是很慢：弹层先显示静态后备图，
    // 再逐张后台探测、加载成功才补进轮播（用户 2026-10-26：打开不能先空白）
    var initial = list[0] || "";
    if (riskyFirst(list)) initial = list[1];
    _modalImages = initial ? [initial] : [];
    _modalKeep = _modalImages.slice();
    buildModal(item);

    var addKeep = function (u) {
      if (_modalKeep.indexOf(u) >= 0) return;
      _modalKeep = list.filter(function (x) { return x === u || _modalKeep.indexOf(x) >= 0; });
      recomputeModalImages();
    };
    var probes = list.map(function (u) {
      if (u === initial) return Promise.resolve();
      // 10 分钟内确认失败的直接跳过；更早的失败仍重探（可能只是当时抖动）
      var ts = imgFailTs(u);
      if (ts && Date.now() - ts < IMG_FAIL_RETRY) return Promise.resolve();
      return probeUrl(u, 15000).then(function (st) {
        if (st === "ok") {
          clearImgFail(u);
          if (_state.modal === item) addKeep(u);
        } else if (st === "error") {
          markImgFailed(u);
        }
        // timeout：只是慢，不写负缓存，下次打开再试
      });
    });
    // 4 秒后放行详情图合并（慢图探测继续在后台跑，成功后再补进轮播）
    _modalListProbed = Promise.race([
      Promise.all(probes),
      new Promise(function (r) { setTimeout(r, 4000); }),
    ]);

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
    // 把自己压的那条 history 记录退掉（返回键关的这次会跳过，见 modalBack）
    if (_modalBackId) { modalBack.release(_modalBackId); _modalBackId = 0; }
    _state.modal = null;
    _state.modalDetail = null;
    _state.modalLoading = false;
  }

  function buildModal(item) {
    if (_modalEl) closeModal();   // 走 closeModal 而不是直接 remove：旧的 history 垫层要一起退掉

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

    // 内容装进内层滚动容器：关闭按钮悬浮在弹窗右上角，不随内容滚动
    // （与演员弹窗 .ssd-dp-modal-body 同构 — 用户 2026-10-27）
    var body = document.createElement("div");
    body.className = "ssd-modal-body";
    modal.appendChild(body);

    // Section 1: Carousel (cover + screenshots)
    var carouselSection = document.createElement("div");
    carouselSection.className = "ssd-modal-section";
    carouselSection.style.padding = "0";
    carouselSection.appendChild(buildCarousel(_modalImages, item.scene));
    body.appendChild(carouselSection);

    // Section 2: Action buttons
    var actionSection = document.createElement("div");
    actionSection.className = "ssd-modal-section";
    var btnRow = document.createElement("div");
    btnRow.className = "ssd-modal-acts";

    var saveBtn = ssdActButton({
      tone: "primary",
      icon: ACT_ADD_SVG,
      label: tc("加入库", "Add to Library"),
      title: tc("预览字段后写入本地库", "Preview fields, then add to the library"),
      on: function () { handleSaveScene(item, saveBtn); },
    });
    btnRow.appendChild(saveBtn);

    var openBtn = ssdActButton({
      label: brandNameForEndpoint(item.endpoint),
      trail: FIND_EXT_SVG,
      title: tc("在源站打开这条场景", "Open this scene on the source"),
      on: function () { handleOpenInBox(item); },
    });
    openBtn.setAttribute("data-ssd-open-btn", "");
    btnRow.appendChild(openBtn);

    var searchBtn = ssdActButton({
      tone: "tonal",
      icon: ACT_FIND_SVG,
      label: tc("搜索资源", "Search Resources"),
      title: tc("用番号/标题在 Jackett 里搜资源", "Search Jackett by code/title"),
      on: function () { handleSearchResources(item, searchBtn); },
    });
    btnRow.appendChild(searchBtn);

    // 忽略（§C8）：主按钮区最右，二次点击确认。图标 + 文字并存 —— 三个大按钮
    // 旁边一个纯图标认不出来；arm 态把文字换成「确认忽略？」才不至于误按。
    // 外观与「演员详情弹层」的忽略按钮同源（用户 2026-10-30）。
    var banBtn = ssdBanButton({
      label: tc("忽略", "Ignore"),
      title: tc("从发现页忽略这条（设置 → 已忽略管理 可恢复）", "Ignore this scene (restore under Settings → Ignored)"),
      aria: tc("忽略这条场景", "Ignore this scene"),
      onConfirm: function () { toggleIgnoreScene(item); },
    });
    btnRow.appendChild(banBtn);

    actionSection.appendChild(btnRow);
    body.appendChild(actionSection);

    // Section 3: Details (placeholder — filled by updateModalDetail)
    var details = document.createElement("div");
    details.className = "ssd-modal-section";
    details.setAttribute("data-ssd-details", "");
    renderDetailsInto(details, item.scene, item);
    body.appendChild(details);

    // Section 4: Search results
    var searchSection = document.createElement("div");
    searchSection.className = "ssd-modal-section";
    searchSection.setAttribute("data-ssd-search", "");
    body.appendChild(searchSection);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    _modalEl = overlay;
    // 返回键＝关闭（论坛 p0rnb0x 2026-10-29）：手机上没有 Esc，右上角 × 太小
    _modalBackId = modalBack.hold(closeModal);

    updateOpenButtonLabel(item);

    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onEsc); }
    });
  }

  function updateOpenButtonLabel(item) {
    var btn = document.querySelector("[data-ssd-open-btn]");
    if (!btn) return;
    // 只换文案层：外链图标是单独一层 span，不会被 textContent 抹掉
    setActLabel(btn, brandNameForEndpoint(item.endpoint));
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

  // 探测图片可加载性：resolve "ok" | "error" | "timeout"。
  // 超时不等于失败——外站动图/大图可能只是慢（用户 2026-10-26）；
  // 只有 onerror 才是真失败，才写入负缓存。
  function probeUrl(url, timeoutMs) {
    return new Promise(function (resolve) {
      if (!url) return resolve("error");
      var im = new Image();
      var done = false;
      var t = setTimeout(function () {
        if (done) return;
        done = true;
        im.onload = im.onerror = null;
        resolve("timeout");
      }, timeoutMs || 15000);
      im.onload = function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve("ok");
      };
      im.onerror = function () {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve("error");
      };
      im.src = url;
    });
  }

  // 列表图（动图优先）+ 详情图 + DMM 截图，统一去重排序后重挂轮播
  function recomputeModalImages() {
    if (!_state.modal) return;
    var merged = dedupeUrls(_modalKeep.concat(_modalExtra));
    if (!merged.length) return;
    if (merged.join("|") === _modalImages.join("|")) return;
    _modalImages = merged;
    remountCarousel();
  }

  function probeModalGallery(detail, item) {
    if (_modalGalleryDone) return;
    _modalGalleryDone = true;

    // 已确认加载失败的外站图不进轮播，避免左右切换时出现空白（用户 2026-10-26）
    var boxUrls = (detail.images || []).map(function (i) { return i.url; })
      .filter(function (u) { return u && !imgFailed(u); });
    _modalExtra = dedupeUrls(_modalExtra.concat(boxUrls));

    var sc = detail.scene || {};
    var contentId = null;
    (sc.urls || []).forEach(function (u) {
      if (!contentId && u.url) contentId = contentIdFromR18Url(u.url);
    });
    if (!contentId) contentId = deriveContentId(sc.code);

    var flush = function () {
      (_modalListProbed || Promise.resolve()).then(function () { recomputeModalImages(); });
    };

    // Progressive merge (enumeration path reports each shot as found)
    var onImage = function (url) {
      _modalExtra = dedupeUrls(_modalExtra.concat([url]));
      flush();
    };

    if (!contentId) { flush(); return; } // non-DMM scene: covers are all we have

    probeDmmGallery(contentId, onImage).then(function (galleryUrls) {
      _modalExtra = dedupeUrls(_modalExtra.concat(galleryUrls || []));
      flush();
    }).catch(function (e) {
      console.warn("[SSD] DMM gallery probe failed:", e);
      flush();
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
    var imgSrc = lp ? appUrl("/performer/" + lp.id + "/image")
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
        item.endpoint, boxKey(item.box),
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

  // ─── Action: ignore one scene (§C8 / §5.2) ───────────────────────────────

  function toggleIgnoreScene(item) {
    if (!SSD.dpIgnore) return;   // 进退业务逻辑：二次确认交给 ssdBanButton
    // 已在忽略列表里（「临时查看已忽略」下点开卡片才会走到）：重复忽略是幂等的，
    // 但撤销会把更早那次决策一起删掉，所以这里直接不动作（用户 2026-10-30）
    if (isItemIgnored(item)) {
      closeModal();
      SSD.toast(tc("已在忽略列表里", "Already in the ignore list"), { duration: 4000 });
      return;
    }
    var r = SSD.dpIgnore.ignoreScene(item);
    var sc = item.scene || {};
    var name = sc.title || sc.code || String(sc.id);
    if (!r.ok) {
      // 写失败必须说出来（§3.2）：不能让 UI 显示"已忽略"而实际没落库
      showModalNotice(tc("忽略失败：浏览器存储写不进去（可能已满）",
                         "Ignore failed: browser storage rejected the write"), "error");
      SSD.toast(tc("忽略失败：记录只保留在本次会话", "Ignore failed: kept in memory only"),
        { duration: 6000 });
      return;
    }

    closeModal();
    if (item._dp) {
      // 发现页：卡片由页面重绘（filterPipeline 会再跑一遍）
      try { window.dispatchEvent(new CustomEvent("ssd:ignore-changed")); } catch (_) {}
    } else {
      // 演员页发现 tab：卡片留着，靠 getFilteredMissing 的过滤器隐藏 —— 这样
      // 「临时查看已忽略」还能把它拿回来（用户 2026-10-30）
      renderTabContent();
    }

    var msg = tc("已忽略「" + name + "」", "Ignored: " + name);
    if (r.dropped) {
      msg += tc(" · 超出上限，淘汰最旧 " + r.dropped + " 条",
                " · cap reached, dropped " + r.dropped + " oldest");
    }
    SSD.toast(msg, {
      actionText: tc("撤销", "Undo"),
      onAction: function () {
        SSD.dpIgnore.remove("scenes", r.key);
        try { window.dispatchEvent(new CustomEvent("ssd:ignore-changed")); } catch (_) {}
        if (!item._dp) renderTabContent();
      },
    });
  }

  // ─── Action: Add to Library (map performers/studio by stash_id) ──────────

  // ─── Action: Add to Library（§4 入库弹窗）─────────────────────────────────
  // 流程改成三段：本地索引算草稿（零写入）→ 弹窗预览（可勾可改）→ 确认才提交。
  // 原先是「二次确认 → 直接 sceneCreate」，用户看不到将要写进去什么，源里空着
  // 的字段也会被静默跳过。演员页发现 tab 与发现页弹窗共用这一个入口。
  // 批量入库没法逐条弹窗，直接吃 dpImport 的默认值（批次7）。

  var _perfCreateMemo = {};   // "endpoint:stashId" → 本地 id（同一演员不重复建档）

  function scenePerfList(sc) {
    var out = [];
    (sc.performers || []).forEach(function (p) {
      var pf = p && p.performer;
      if (pf && pf.id) out.push({ id: pf.id, name: pf.name || "", images: pf.images || [] });
    });
    return out;
  }

  function sceneUrlParts(item, sc) {
    var src = [];
    (sc.urls || []).forEach(function (u) {
      var s = typeof u === "string" ? u : (u && u.url) || "";
      if (s) src.push(s);
    });
    return { web: boxSceneUrl(item.endpoint, sc.id), src: src };
  }

  function sceneCoverCandidates(item, sc) {
    return (item.images && item.images.length ? item.images : (sc.images || []))
      .map(function (im) { return (im && im.url) || ""; })
      .filter(Boolean)
      .slice(0, 3);
  }

  // 只算、不写：演员走四步判定的「判定」半边，标签/工作室查本地索引
  function planSceneImport(item, sc) {
    var endpoint = item.endpoint;
    var list = scenePerfList(sc);
    return Promise.all([
      list.length ? planPerformers(endpoint, list) : Promise.resolve({ idx: null, plan: [] }),
      loadTagIndex(),
      loadStudioIndex(),
    ]).then(function (res) {
      var perf = res[0] || { idx: null, plan: [] };
      var tagIdx = res[1] || {};
      var studioIdx = res[2] || { byStashId: {}, byName: {} };

      var linked = 0, toCreate = 0, ambiguous = 0;
      (perf.plan || []).forEach(function (p) {
        if (p.how === "id" || p.how === "name" || p.how === "alias") linked++;
        else { toCreate++; if (p.how === "ambiguous") ambiguous++; }
      });

      var tHit = [], tNew = [];
      (sc.tags || []).forEach(function (t) {
        var nm = String((t && t.name) || "").trim();
        if (!nm) return;
        var id = tagIdx[nm.toLowerCase()];
        if (id) {
          if (!tHit.some(function (x) { return x.id === id; })) tHit.push({ name: nm, id: id });
        } else if (tNew.indexOf(nm) < 0) tNew.push(nm);
      });

      var studio = null;
      var sn = String((sc.studio && sc.studio.name) || "").trim();
      if (sc.studio && (sc.studio.id || sn)) {
        var sid = sc.studio.id
          ? studioIdx.byStashId[String(endpoint).toLowerCase() + ":" +
              String(sc.studio.id).toLowerCase()]
          : null;
        var bid = sid || (sn ? studioIdx.byName[sn.toLowerCase()] : null) || null;
        studio = { id: bid, name: sn, stashId: sc.studio.id || "", create: !bid };
      }

      return {
        item: item, endpoint: endpoint, scene: sc,
        perf: { idx: perf.idx, plan: perf.plan || [], linked: linked,
                create: toCreate, ambiguous: ambiguous },
        tags: { hit: tHit, create: tNew },
        studio: studio,
        urls: sceneUrlParts(item, sc),
        covers: sceneCoverCandidates(item, sc),
      };
    });
  }

  function handleSaveScene(item, btn) {
    var sc = _state.modalDetail ? _state.modalDetail.scene : item.scene;
    // 只记住文案层，图标留着（按钮已换成 ssd-dp-btn：图标 + 文案两层）
    var lbl = btn.querySelector("[data-ssd-lbl]");
    var label = lbl ? lbl.textContent : btn.textContent;
    btn.disabled = true;
    setActLabel(btn, tc("准备中…", "Preparing…"));
    planSceneImport(item, sc).then(function (draft) {
      if (btn.isConnected) { btn.disabled = false; setActLabel(btn, label); }
      openSceneImportDialog(draft, btn);
    }).catch(function (e) {
      console.error("[SSD] import plan failed:", e);
      if (btn.isConnected) { btn.disabled = false; setActLabel(btn, label); }
      showModalNotice(tc("读取本地库失败：", "Could not read the library: ") +
        (e && e.message ? e.message : String(e)), "error");
    });
  }

  // ── 入库弹窗（场景）──────────────────────────────────────────────────────

  var _impEl = null;
  var _impBackId = 0;   // 返回键垫层 id（导入预览弹窗）

  function closeImportDialog() {
    if (_impEl && _impEl.parentNode) _impEl.parentNode.removeChild(_impEl);
    _impEl = null;
    if (_impBackId) { modalBack.release(_impBackId); _impBackId = 0; }
  }

  // 一行 = 勾选框 + 字段名 + 值控件。locked 行置顶灰显（必要字段，不可取消）
  function impRow(opts) {
    var row = document.createElement("div");
    row.className = "ssd-imp-row" + (opts.locked ? " is-locked" : "");
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "ssd-imp-cb";
    cb.checked = opts.checked !== false;
    cb.disabled = !!opts.locked;
    if (opts.locked) cb.title = tc("必要字段，不可取消", "Required field");
    row.appendChild(cb);
    var nm = document.createElement("span");
    nm.className = "ssd-imp-name";
    nm.textContent = opts.label;
    row.appendChild(nm);
    var val = document.createElement("div");
    val.className = "ssd-imp-val";
    if (opts.node) val.appendChild(opts.node);
    else val.textContent = opts.value == null ? "" : String(opts.value);
    row.appendChild(val);
    if (!opts.locked) row.classList.toggle("is-off", !cb.checked);
    cb.addEventListener("change", function () { row.classList.toggle("is-off", !cb.checked); });
    // 整行可点（用户 2026-10-29）：勾选框只有 13px，值那一列很长，非要点准框
    // 才能取消太别扭。行内有输入框/下拉/文本框的放过 —— 想改字时点进去是改字，
    // 不该顺手把这一项关掉。
    if (!opts.locked) {
      row.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || t === cb) return;
        if (t.closest && t.closest("input, select, textarea, button, a, label")) return;
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    return { row: row, cb: cb, val: val };
  }

  function impSelect(options, value) {
    var sel = document.createElement("select");
    sel.className = "ssd-imp-select";
    options.forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = value;
    return sel;
  }

  function openSceneImportDialog(draft, btn) {
    closeImportDialog();
    var prefs = dpImport.scene();
    var sc = draft.scene;
    var getters = {};

    var overlay = document.createElement("div");
    overlay.className = "ssd-imp-overlay";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeImportDialog();
    });
    var panel = document.createElement("div");
    panel.className = "ssd-imp";
    overlay.appendChild(panel);

    var head = document.createElement("div");
    head.className = "ssd-imp-head";
    var h = document.createElement("div");
    h.className = "ssd-imp-title";
    h.textContent = tc("入库预览", "Import preview");
    head.appendChild(h);
    var sub = document.createElement("div");
    sub.className = "ssd-imp-sub";
    sub.textContent = brandNameForEndpoint(draft.endpoint) + " · " +
      (sc.title || sc.code || String(sc.id));
    head.appendChild(sub);
    var x = document.createElement("button");
    x.type = "button";
    x.className = "ssd-imp-close";
    x.innerHTML = "&times;";
    x.title = tc("关闭", "Close");
    x.addEventListener("click", closeImportDialog);
    head.appendChild(x);
    panel.appendChild(head);

    var body = document.createElement("div");
    body.className = "ssd-imp-body";
    panel.appendChild(body);

    // 必要字段：置顶、灰显、勾着且不可取消
    var req = document.createElement("div");
    req.className = "ssd-imp-req";
    req.appendChild(impRow({
      label: tc("番号", "Code"),
      value: sc.code || tc("（源里没有）", "(none on source)"),
      locked: true,
    }).row);
    req.appendChild(impRow({
      label: tc("源编号", "Source ID"),
      value: brandNameForEndpoint(draft.endpoint) + " : " + String(sc.id),
      locked: true,
    }).row);
    body.appendChild(req);

    var list = document.createElement("div");
    list.className = "ssd-imp-list";
    body.appendChild(list);

    function textRow(key, label, value, multiline) {
      var node;
      if (multiline) {
        node = document.createElement("textarea");
        node.rows = 3;
      } else {
        node = document.createElement("input");
        node.type = "text";
      }
      node.className = "ssd-imp-input";
      node.value = value || "";
      if (!value) node.placeholder = tc("空", "empty");
      var r = impRow({ label: label, checked: prefs[key], node: node });
      // 手动改值 → 自动勾上（改了内容却忘了勾等于白改）
      node.addEventListener("input", function () {
        if (!r.cb.checked) { r.cb.checked = true; r.row.classList.remove("is-off"); }
      });
      list.appendChild(r.row);
      getters[key] = function () { return r.cb.checked ? String(node.value || "") : ""; };
      return r;
    }

    textRow("title", tc("标题", "Title"), sc.title);
    textRow("date", tc("日期", "Date"), sc.release_date);
    textRow("details", tc("简介", "Details"), sc.details, true);
    textRow("director", tc("导演", "Director"), sc.director);

    // urls 拆两行（Q16）：网页链接默认勾，源站链接默认也勾
    var webRow = impRow({
      label: tc("网页链接", "Web link"),
      checked: prefs.urlsWeb,
      value: draft.urls.web || "",
    });
    list.appendChild(webRow.row);
    var srcRow = impRow({
      label: tc("源站链接", "Source links"),
      checked: prefs.urlsSrc,
      value: draft.urls.src.length
        ? tc(draft.urls.src.length + " 条 · " + urlHost(draft.urls.src[0]),
             draft.urls.src.length + " link(s) · " + urlHost(draft.urls.src[0]))
        : tc("源里没有", "none on source"),
    });
    list.appendChild(srcRow.row);

    // 演员：只显示数字，不做开关（Q19：建档无条件，新建 N 位是纯信息）
    var perfCb = impRow({
      label: tc("演员", "Performers"),
      // 默认值是三态字符串了；"none" 才是关（字符串全为真值，直接当布尔会永远是勾上的）
      checked: prefs.performers !== "none" && prefs.performers !== false,
      value: draft.perf.plan.length
        ? tc("关联 " + draft.perf.linked + " 位已有 · 新建 " + draft.perf.create + " 位",
             draft.perf.linked + " linked · " + draft.perf.create + " new")
        : tc("源里没有", "none on source"),
    });
    list.appendChild(perfCb.row);
    if (draft.perf.ambiguous) {
      var amb = document.createElement("div");
      amb.className = "ssd-imp-note";
      amb.textContent = tc(
        "其中 " + draft.perf.ambiguous + " 位库里有重名但无法确定是不是同一人，按新建处理（事后可在演员页合并）",
        draft.perf.ambiguous + " with a same-name local record could not be confirmed — created as new; merge later if needed");
      list.appendChild(amb);
    }

    // 标签三态（C7，默认全写）
    var tagHint = document.createElement("span");
    tagHint.className = "ssd-imp-hint";
    function refreshTagHint() {
      var v = tagSel.value;
      tagHint.textContent = tc(
        "匹配 " + draft.tags.hit.length + " 个已有" +
          (v === "all" ? " · 将新建 " + draft.tags.create.length + " 个" : "") +
          (v === "existing" ? " · 新建的 " + draft.tags.create.length + " 个不写" : "") +
          (v === "none" ? " · 全部不写" : ""),
        draft.tags.hit.length + " matched" +
          (v === "all" ? " · " + draft.tags.create.length + " to create" : "") +
          (v === "existing" ? " · " + draft.tags.create.length + " skipped" : "") +
          (v === "none" ? " · none written" : ""));
      // 三态选「不写」时把勾选框同步掉，两个控件不能各说一套
      if (tagRow) {
        tagRow.cb.checked = v !== "none";
        tagRow.row.classList.toggle("is-off", !tagRow.cb.checked);
      }
    }
    var tagSel = impSelect([
      ["all", tc("全写（含新建）", "Write all (create new)")],
      ["existing", tc("只关联已有", "Link existing only")],
      ["none", tc("不写标签", "No tags")],
    ], prefs.tags);
    var tagWrap = document.createElement("div");
    tagWrap.className = "ssd-imp-inline";
    tagWrap.appendChild(tagSel);
    tagWrap.appendChild(tagHint);
    tagSel.addEventListener("change", refreshTagHint);
    var tagRow = impRow({
      label: tc("标签", "Tags"),
      checked: prefs.tags !== "none",
      node: tagWrap,
    });
    list.appendChild(tagRow.row);
    refreshTagHint();

    // 工作室三态
    var stHint = document.createElement("span");
    stHint.className = "ssd-imp-hint";
    function refreshStudioHint() {
      var v = stSel.value;
      if (!draft.studio) {
        stHint.textContent = tc("源里没有", "none on source");
      } else if (v === "none") {
        stHint.textContent = tc("不写工作室", "no studio");
      } else if (draft.studio.id) {
        stHint.textContent = tc("已匹配「" + draft.studio.name + "」",
                                "matched " + draft.studio.name);
      } else {
        stHint.textContent = v === "all"
          ? tc("将新建「" + draft.studio.name + "」", "will create " + draft.studio.name)
          : tc("本地没有，跳过", "not in library — skipped");
      }
      if (stRow) {
        stRow.cb.checked = !!draft.studio && v !== "none";
        stRow.row.classList.toggle("is-off", !stRow.cb.checked);
      }
    }
    var stSel = impSelect([
      ["all", tc("全写（含新建）", "Write all (create new)")],
      ["existing", tc("只关联已有", "Link existing only")],
      ["none", tc("不写工作室", "No studio")],
    ], prefs.studio);
    stSel.disabled = !draft.studio;
    var stWrap = document.createElement("div");
    stWrap.className = "ssd-imp-inline";
    stWrap.appendChild(stSel);
    stWrap.appendChild(stHint);
    stSel.addEventListener("change", refreshStudioHint);
    var stRow = impRow({
      label: tc("工作室", "Studio"),
      checked: !!draft.studio && prefs.studio !== "none",
      node: stWrap,
    });
    stRow.cb.disabled = !draft.studio;
    list.appendChild(stRow.row);
    refreshStudioHint();

    // 封面：单独补，失败只丢封面（不塞进 sceneCreate 的原因见旧注释）
    var coverRow = impRow({
      label: tc("封面", "Cover"),
      checked: prefs.cover,
      value: draft.covers.length
        ? tc(draft.covers.length + " 个候选，失败只丢封面",
             draft.covers.length + " candidate(s), cover only on failure")
        : tc("没有候选图", "no candidate"),
    });
    list.appendChild(coverRow.row);

    var foot = document.createElement("div");
    foot.className = "ssd-imp-foot";
    var err = document.createElement("div");
    err.className = "ssd-imp-err";
    foot.appendChild(err);
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ssd-btn ssd-btn-secondary";
    cancel.textContent = tc("取消", "Cancel");
    cancel.addEventListener("click", closeImportDialog);
    foot.appendChild(cancel);
    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ssd-btn ssd-btn-primary";
    ok.textContent = tc("确认入库", "Add to library");
    foot.appendChild(ok);
    panel.appendChild(foot);

    var busy = false;
    ok.addEventListener("click", function () {
      if (busy) return;
      busy = true;
      ok.disabled = true;
      cancel.disabled = true;
      err.textContent = "";
      ok.textContent = tc("入库中…", "Adding…");
      var pick = {
        title: getters.title ? getters.title() : "",
        date: getters.date ? getters.date() : "",
        details: getters.details ? getters.details() : "",
        director: getters.director ? getters.director() : "",
        urlsWeb: webRow.cb.checked,
        urlsSrc: srcRow.cb.checked,
        performers: perfCb.cb.checked,
        // 勾掉勾选框与选「不写」等价
        tags: tagRow.cb.checked ? tagSel.value : "none",
        studio: stRow.cb.checked ? stSel.value : "none",
        cover: coverRow.cb.checked,
      };
      submitSceneImport(draft, pick, function (t) { ok.textContent = t; })
        .then(function (created) {
          closeImportDialog();
          afterSceneImported(draft.item, btn, created);
        })
        .catch(function (e) {
          console.error("[SSD] save failed:", e);
          busy = false;
          ok.disabled = false;
          cancel.disabled = false;
          ok.textContent = tc("确认入库", "Add to library");
          err.textContent = tc("入库失败：", "Import failed: ") + (e && e.message ? e.message : String(e));
        });
    });

    document.body.appendChild(overlay);
    _impEl = overlay;
    _impBackId = modalBack.hold(closeImportDialog);   // 返回键＝关闭（移动端没有 Esc）
    document.addEventListener("keydown", function onEscImp(e) {
      if (!_impEl) { document.removeEventListener("keydown", onEscImp); return; }
      if (e.key === "Escape" && !busy) { closeImportDialog(); document.removeEventListener("keydown", onEscImp); }
    });
  }

  // 提交：演员建档在前（场景要引用它们的 id），标签/工作室按三态，最后 sceneCreate
  function submitSceneImport(draft, pick, onProgress) {
    var endpoint = draft.endpoint;
    var sc = draft.scene;

    var perfMode = pick.performers === "existing" ? "existing"
      : (pick.performers && pick.performers !== "none") ? "all" : "none";
    var perfP = (perfMode !== "none" && draft.perf.plan.length)
      ? executePerformerPlan(endpoint, draft.perf.idx, draft.perf.plan, _perfCreateMemo, perfMode)
      : Promise.resolve({ ids: [], linked: 0, created: 0, ambiguous: 0, failed: 0 });

    var studioP = Promise.resolve(null);
    if (pick.studio !== "none" && draft.studio) {
      if (draft.studio.id) studioP = Promise.resolve(draft.studio.id);
      else if (pick.studio === "all") {
        studioP = findOrCreateStudio(draft.studio.name, draft.studio.stashId, endpoint);
      }
    }

    var tagP = Promise.resolve([]);
    if (pick.tags !== "none") {
      var jobs = draft.tags.hit.map(function (t) { return Promise.resolve(t.id); });
      if (pick.tags === "all") {
        draft.tags.create.forEach(function (n) { jobs.push(findOrCreateTag(n)); });
      }
      tagP = Promise.all(jobs).then(function (ids) {
        return ids.filter(function (id, i) { return !!id && ids.indexOf(id) === i; });
      });
    }

    return Promise.all([perfP, studioP, tagP]).then(function (r) {
      var perf = r[0] || { ids: [] };
      if (onProgress) onProgress(tc("写入场景…", "Creating scene…"));
      var ids = (perf.ids || []).slice();
      // 演员页：stash_id 映射漏了也要保住当前页归属；发现页条目没有「当前演员」
      if (!draft.item._dp && _state.performerId && ids.indexOf(_state.performerId) === -1) {
        ids.push(_state.performerId);
      }

      var urls = [];
      if (pick.urlsWeb && draft.urls.web) urls.push(draft.urls.web);
      if (pick.urlsSrc) urls = urls.concat(draft.urls.src);

      var input = {
        code: sc.code || undefined,
        urls: urls,
        performer_ids: ids,
        tag_ids: r[2] || [],
        // stash_ids is accepted by SceneCreateInput — no second update round-trip
        stash_ids: [{ endpoint: endpoint, stash_id: String(sc.id) }],
      };
      if (pick.title) input.title = pick.title;
      if (pick.date) input.date = pick.date;
      if (pick.details) input.details = pick.details;
      if (r[1]) input.studio_id = r[1];
      if (pick.director) input.director = pick.director;

      // 封面不塞进 sceneCreate：Stash 会同步下载外链图，TPDB 的 CDN 连不上时
      // 整条入库直接失败（实测 "processing cover image: ... EOF"）。场景先落地，
      // 封面单独补，失败只丢封面 —— 候选链逐个试，外站直链各有防盗链规则。
      var coverList = pick.cover ? draft.covers : [];

      return callGQL(
        "mutation($input:SceneCreateInput!){sceneCreate(input:$input){id title code}}",
        { input: input }
      ).then(function (data) {
        var created = data && data.sceneCreate;
        if (!created || !created.id) throw new Error(tc("创建返回空结果", "Create returned empty result"));
        function tryCover(i) {
          if (i >= coverList.length) return created;
          return callGQL(
            "mutation($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}",
            { input: { id: created.id, cover_image: coverList[i] } }
          ).catch(function (e) {
            console.warn("[SSD] cover not set (candidate " + (i + 1) + "):", (e && e.message) || e);
            return tryCover(i + 1);
          });
        }
        return tryCover(0);
      });
    }).then(function (created) {
      // 手动入库成功 → 该场景的忽略记录没意义了（§3 最后一条）
      if (SSD.dpIgnore && SSD.dpIgnore.isSceneIgnored(endpoint, sc.id)) {
        SSD.dpIgnore.remove("scenes", SSD.dpIgnore.key(endpoint, sc.id));
        try { window.dispatchEvent(new CustomEvent("ssd:ignore-changed")); } catch (_) {}
      }
      return created;
    });
  }

  // 批量入库（§9）不逐条弹窗，勾选直接吃设置里的默认值（Q15：弹窗里的临时
  // 勾选不写回，所以这里读到的就是用户在设置页配的那一份）。
  // 语义与弹窗里的 pick 完全对齐：不勾的文本字段给空串 —— submitSceneImport
  // 用真值判断是否写进 input，空串等于不写。
  function pickFromPrefs(draft) {
    var p = dpImport.scene();
    var sc = draft.scene || {};
    // 演员三态（用户 2026-10-29）：字符串原样透传，老值布尔也兼容
    var perfMode = p.performers === "existing" ? "existing"
      : (p.performers === false || p.performers === "none") ? "none" : "all";
    return {
      title: p.title ? (sc.title || "") : "",
      date: p.date ? (sc.release_date || "") : "",
      details: p.details ? (sc.details || "") : "",
      director: p.director ? (sc.director || "") : "",
      urlsWeb: !!p.urlsWeb,
      urlsSrc: !!p.urlsSrc,
      performers: perfMode,
      tags: p.tags,
      studio: p.studio,
      cover: !!p.cover,
    };
  }

  function afterSceneImported(item, btn, created) {
    if (!created || !created.id) return;
    if (btn && btn.isConnected) {
      btn.textContent = tc("已加入 ✓", "Added ✓");
      btn.classList.add("ssd-btn-success");
    }
    if (item._dp) {
      // Discover page owns this item — let it drop the card and re-render
      // bubbles 必须开：发现页那两处监听挂在 window 上，document 上派发的
      // 非冒泡事件根本传不过去（表现为「入库成功但卡片还挂着」）
      document.dispatchEvent(new CustomEvent(SCENE_SAVED_EVENT, { detail: { item: item }, bubbles: true }));
    } else {
      var idx = _state.cachedMissing.indexOf(item);
      if (idx !== -1) _state.cachedMissing.splice(idx, 1);
      setTimeout(function () { if (_modalEl) renderTabContent(); }, 1500);
    }
  }


  // ─── 演员入库弹窗（§4.1 第二条路径 / §4.2 演员）─────────────────────────
  // 原按钮只提交 name + image + stash_id 三个字段，源上有的其余值全丢。
  // 改成：按 stashId 回源拉全字段（§4.4：Stash 的 scraper 层按 id 抓不可用，
  // 只能走 raw box GraphQL）→ 弹窗里只渲染「源里非空」的项 → 确认才写。
  // 只有 name + stash_ids 的新档案本来就是这样（C1b），其余字段是这次补的。

  var BOX_PERF_DETAIL_QUERY =
    "query($id:ID!){findPerformer(id:$id){id name disambiguation aliases deleted " +
    "gender country birth_date death_date urls{url} images{url} height cup_size band_size " +
    "waist_size hip_size career_start_year career_end_year ethnicity hair_color eye_color " +
    "tattoos{location description} piercings{location description}}}";

  // 详情只拉一次、两处共用（用户 2026-10-30）：演员弹层以前拉子集（性别/年龄/
  // 别名/国籍/头像 ≈2.2KB），点「加入库」再拉全字段（≈4.3KB）——重复了一整份
  // name/aliases/images/gender/country/birth_date，且第二次要等一个往返。
  // 改成一律走全字段 + 内存缓存：入库预览变成零请求即时出，重开同一个演员也不再拉。
  // TTL 10 分钟——源上的档案不会在这段时间里改到你正在看的那一笔上。
  var BOX_PERF_DETAIL_TTL_MS = 10 * 60 * 1000;
  var BOX_PERF_DETAIL_MAX = 64;              // 条目上限，防反复浏览把内存撑起来
  var _boxPerfDetail = Object.create(null);  // "endpoint|stashId" → {at, p}
  var _boxPerfInflight = Object.create(null);

  function boxPerfCacheTrim() {
    var keys = Object.keys(_boxPerfDetail);
    if (keys.length <= BOX_PERF_DETAIL_MAX) return;
    keys.sort(function (a, b) { return (_boxPerfDetail[a].at || 0) - (_boxPerfDetail[b].at || 0); });
    keys.slice(0, keys.length - BOX_PERF_DETAIL_MAX).forEach(function (k) { delete _boxPerfDetail[k]; });
  }

  // 失败一律降级为 null（不写缓存）：调用方原本就有各自的兜底——弹层不显示这几行
  // 标签，入库弹窗退成「只有名字 + 源编号」的最小档案。
  function boxPerfDetail(endpoint, apiKey, stashId, timeoutMs) {
    var key = String(endpoint || "") + "|" + String(stashId || "");
    var hit = _boxPerfDetail[key];
    if (hit && Date.now() - hit.at < BOX_PERF_DETAIL_TTL_MS) return Promise.resolve(hit.p);
    if (_boxPerfInflight[key]) return _boxPerfInflight[key];
    var id = key.slice(key.indexOf("|") + 1);
    var p = callBoxGQL(endpoint, apiKey, BOX_PERF_DETAIL_QUERY, { id: id }, timeoutMs || 12000)
      .then(function (r) {
        var pf = (r && r.findPerformer) || null;
        if (pf) { _boxPerfDetail[key] = { at: Date.now(), p: pf }; boxPerfCacheTrim(); }
        return pf;
      })
      .catch(function (e) {
        console.warn("[SSD] performer detail failed:", (e && e.message) || e);
        return null;
      });
    // 并发的第二次调用共用同一条在途请求（弹层刚开就点「加入库」时很常见）。
    // p 已在上面 catch 过，永远不会拒绝 → 派生出来的这条也不会，无需再兜。
    _boxPerfInflight[key] = p.then(function (pf) {
      delete _boxPerfInflight[key];
      return pf;
    });
    return _boxPerfInflight[key];
  }

  var PERF_FIELD_LABELS = {
    gender: ["性别", "Gender"],
    birthdate: ["生日", "Birthdate"],
    death_date: ["逝世", "Death date"],
    country: ["国籍", "Country"],
    ethnicity: ["族裔", "Ethnicity"],
    hair_color: ["发色", "Hair"],
    eye_color: ["瞳色", "Eyes"],
    height_cm: ["身高", "Height"],
    measurements: ["三围", "Measurements"],
    career_length: ["从业期", "Career"],
    tattoos: ["纹身", "Tattoos"],
    piercings: ["穿孔", "Piercings"],
    aliases: ["别名", "Aliases"],
    urls: ["链接", "Links"],
  };

  function numOrUndef(v) {
    if (v === undefined || v === null || v === "") return undefined;
    // height 这类字段源里可能是 "160cm" 或空串 —— 直接写会变 NaN，整个
    // performerCreate 被拒（§4.2 的 Number.isFinite 守卫）
    var n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : undefined;
  }

  // 源侧别名常是「An Mitsumi, Fujii Ranran, 蜜美杏」这种逗号拼接的一整串
  function perfAliases(p) {
    var out = [];
    (p.aliases || []).forEach(function (a) {
      String(a || "").split(/[,、;\/]/).forEach(function (s) {
        s = s.trim();
        if (s) out.push(s);
      });
    });
    return dedupeStrings(out);
  }

  // 源演员 → 可写入的一组值（不管开关，先算全；渲染和提交共用同一份）
  function perfFieldValues(p) {
    return {
      // gender 在 Stash 侧是 GenderEnum（FEMALE 这种枚举名），写库必须原值；
      // 显示时再转成「女 / Female」（perfValueText 里处理）
      gender: p.gender || "",
      birthdate: p.birth_date || "",
      death_date: p.death_date || "",
      country: p.country || "",
      ethnicity: emptyVal(p.ethnicity) ? "" : enumToDisplay(p.ethnicity),
      hair_color: emptyVal(p.hair_color) ? "" : enumToDisplay(p.hair_color),
      eye_color: emptyVal(p.eye_color) ? "" : enumToDisplay(p.eye_color),
      height_cm: numOrUndef(p.height),
      measurements: boxMeasurements(p),
      career_length: boxCareer(p),
      tattoos: modsToString(p.tattoos),
      piercings: modsToString(p.piercings),
      aliases: perfAliases(p),
      urls: boxUrls(p),
    };
  }

  function perfValueText(k, v) {
    if (Array.isArray(v)) {
      if (!v.length) return "";
      return k === "urls" ? v.map(urlHost).join(" · ") : v.join(" · ");
    }
    // gender 存的是 GenderEnum 枚举名，直接显示「FEMALE」不好看
    if (k === "gender" && v) return genderText(v) || String(v);
    if (v === undefined || v === null || v === "") return "";
    if (k === "height_cm") return v + " cm";
    return String(v);
  }

  function perfHasValue(k, v) {
    return Array.isArray(v) ? v.length > 0 : !(v === undefined || v === null || v === "");
  }

  var PERF_SCALAR_KEYS = ["gender", "birthdate", "death_date", "country", "ethnicity",
                          "hair_color", "eye_color", "height_cm", "measurements",
                          "career_length", "tattoos", "piercings"];

  function perfCreateInputFrom(vals, on, opts) {
    var input = {
      name: String(opts.name || "").trim() || tc("未知演员", "Unknown"),
      stash_ids: [{ endpoint: opts.endpoint, stash_id: String(opts.stashId) }],
    };
    PERF_SCALAR_KEYS.forEach(function (k) {
      if (!on[k]) return;
      var v = vals[k];
      if (v === undefined || v === null || v === "") return;
      input[k] = v;
    });
    if (on.aliases && vals.aliases.length) input.alias_list = vals.aliases;
    if (on.urls && vals.urls.length) input.urls = vals.urls;
    if (on.image && opts.image) input.image = opts.image;
    return input;
  }

  // 头像 → base64 data URL。跨域取不到（无 CORS 头）时返回 null，流程继续、
  // 只是不带图。只在「Stash 自己拉不动这张图」时才用：外站图常常只放浏览器。
  function urlToDataUrl(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result || "")); };
          fr.onerror = function () { reject(new Error("read failed")); };
          fr.readAsDataURL(blob);
        });
      })
      .catch(function (e) {
        console.warn("[SSD] avatar download skipped:", (e && e.message) || e);
        return null;
      });
  }

  // 头像同样是外链下载，失败会让整个 performerCreate 报错 → 依次降级：
  // 直链交给 Stash 拉 → 浏览器转 data URL 再试 → 无图建档
  function createPerformerWithFallback(input) {
    function create(img) {
      var inp = {};
      Object.keys(input).forEach(function (k) { inp[k] = input[k]; });
      if (img) inp.image = img;
      else delete inp.image;
      return callGQL(
        "mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}",
        { input: inp }
      ).then(function (d) { return (d.performerCreate || {}).id || null; });
    }
    var img = input.image;
    if (!img) return create("");
    return create(img).catch(function (e1) {
      // 只有「图拉不下来」这一类才值得降级；其他错误重试也是白搭，还会把
      // 真实原因盖成一句「创建返回空结果」
      var msg = String((e1 && e1.message) || e1);
      if (!/image|avatar|download|HTTP|EOF|lookup|timeout/i.test(msg)) throw e1;
      return urlToDataUrl(img).then(function (dataUrl) {
        return create(dataUrl || "");
      }).catch(function (e2) { throw e2 || e1; });
    });
  }

  function invalidatePerfIndex(endpoint) {
    if (endpoint) delete _perfIndexCache[String(endpoint).toLowerCase()];
    else _perfIndexCache = {};
  }

  // 批量加入库（演员）—— 多选时用（用户 2026-10-29）。不弹预览、不拉源站详情：
  // 卡片上只有 name / image / stash_id，够建一条最小档案；字段可以事后用
  // 「艺术家补全」再刷。已有同源编号的算「跳过」，不重复建。
  // list: [{endpoint, stashId, name, image}]
  function batchAddPerformers(list, onProgress) {
    var out = { ok: 0, exist: 0, failed: 0, failedIdx: [], lastErr: "" };
    var arr = (list || []).filter(function (p) { return p && p.stashId; });
    if (!arr.length) return Promise.resolve(out);
    var ep = String(arr[0].endpoint || "").toLowerCase();
    return buildLocalPerformerIndex(ep).then(function (idx) {
      var chain = Promise.resolve();
      arr.forEach(function (p, i) {
        chain = chain.then(function () {
          if (onProgress) onProgress(i + 1, arr.length);
          var sid = String(p.stashId).toLowerCase();
          if (idx.byStashId[sid]) { out.exist++; return null; }
          return createPerformerWithFallback({
            name: p.name || tc("未知演员", "Unknown"),
            stash_ids: [{ endpoint: p.endpoint, stash_id: String(p.stashId) }],
            image: p.image || "",
          }).then(function (id) {
            if (!id) { out.failed++; out.failedIdx.push(i); return; }
            out.ok++;
            indexRemember(idx, { id: id, name: p.name, stash_ids: [{ endpoint: p.endpoint, stash_id: String(p.stashId) }], aliases: [] }, p.endpoint, p.stashId);
          }).catch(function (e) {
            out.failed++;
            out.failedIdx.push(i);
            out.lastErr = (e && e.message) || String(e);
          });
        }).then(function () {
          // 串行 + 间隔：并发建档会把 Stash 的 SQLite 锁到写超时
          return new Promise(function (r) { setTimeout(r, 120); });
        });
      });
      return chain.then(function () {
        invalidatePerfIndex(ep);
        return out;
      });
    }).catch(function (e) {
      out.failed = arr.length;
      out.failedIdx = arr.map(function (_, i) { return i; });
      out.lastErr = (e && e.message) || String(e);
      return out;
    });
  }

  // opts: { endpoint, apiKey, stashId, name, image, onDone(createdId, mode) }
  function openPerformerImportDialog(opts) {
    closeImportDialog();
    var endpoint = opts.endpoint;
    var stashId = String(opts.stashId || "");
    var prefs = dpImport.performer();

    var overlay = document.createElement("div");
    overlay.className = "ssd-imp-overlay";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeImportDialog();
    });
    var panel = document.createElement("div");
    panel.className = "ssd-imp ssd-imp-sm";
    overlay.appendChild(panel);

    var head = document.createElement("div");
    head.className = "ssd-imp-head";
    var h = document.createElement("div");
    h.className = "ssd-imp-title";
    h.textContent = tc("演员入库预览", "Performer import");
    head.appendChild(h);
    var sub = document.createElement("div");
    sub.className = "ssd-imp-sub";
    sub.textContent = brandNameForEndpoint(endpoint) + " · " + (opts.name || stashId);
    head.appendChild(sub);
    var x = document.createElement("button");
    x.type = "button";
    x.className = "ssd-imp-close";
    x.innerHTML = "&times;";
    x.title = tc("关闭", "Close");
    x.addEventListener("click", closeImportDialog);
    head.appendChild(x);
    panel.appendChild(head);

    var body = document.createElement("div");
    body.className = "ssd-imp-body";
    panel.appendChild(body);

    var foot = document.createElement("div");
    foot.className = "ssd-imp-foot";
    var err = document.createElement("div");
    err.className = "ssd-imp-err";
    foot.appendChild(err);
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ssd-btn ssd-btn-secondary";
    cancel.textContent = tc("取消", "Cancel");
    cancel.addEventListener("click", closeImportDialog);
    foot.appendChild(cancel);
    var ok = document.createElement("button");
    ok.type = "button";
    ok.className = "ssd-btn ssd-btn-primary";
    ok.textContent = tc("确认入库", "Add to library");
    ok.disabled = true;
    foot.appendChild(ok);
    panel.appendChild(foot);

    // 详情先拉、再判定：第 3 步（别名）要用源侧的 aliases。
    // 演员弹层开过的话这里走缓存（10 分钟内零请求、不出现读取提示）。
    body.appendChild(panelNote(tc("正在从源上读取字段…", "Reading fields from the source…"), true, false));

    boxPerfDetail(endpoint, opts.apiKey, stashId, 12000)
      .then(function (p) {
        if (!_impEl) return;
        var full = p || { id: stashId, name: opts.name || "" };
        var vals = perfFieldValues(full);
        var imgUrl = opts.image || ((full.images && full.images[0] && full.images[0].url) || "");
        return planPerformers(endpoint, [{
          id: stashId, name: full.name || opts.name || "", aliases: full.aliases || [],
        }]).then(function (res) {
          if (!_impEl) return;
          render(full, vals, imgUrl, (res.plan && res.plan[0]) || { how: "new" });
        });
      })
      .catch(function (e) {
        if (!_impEl) return;
        body.innerHTML = "";
        body.appendChild(panelNote(tc("读取失败：", "Read failed: ") +
          (e && e.message ? e.message : String(e)), false, true));
      });

    function render(p, vals, imgUrl, plan) {
      body.innerHTML = "";

      var state = document.createElement("div");
      state.className = "ssd-imp-state";
      var mode = plan.how;
      if (mode === "id") {
        state.textContent = tc("已在库中：「" + (plan.rec && plan.rec.name || p.name) + "」，无需重复入库",
                              "Already in library: " + (plan.rec && plan.rec.name || p.name));
        state.classList.add("is-ok");
      } else if (mode === "name" || mode === "alias") {
        state.textContent = tc(
          "将关联到本地已有档案「" + (plan.rec && plan.rec.name || "") + "」：只补源编号与空字段，本地已有值不覆盖",
          "Will link to the existing record “" + (plan.rec && plan.rec.name || "") +
            "”: adds the source ID and fills blank fields only");
        state.classList.add("is-link");
      } else {
        state.textContent = plan.how === "ambiguous"
          ? tc("库里有重名但无法确定是不是同一人，将新建一条档案（事后可合并）",
              "Same-name records exist but cannot be confirmed — a new record will be created")
          : tc("将新建一条演员档案", "A new performer record will be created");
      }
      body.appendChild(state);

      if (mode === "id") {
        if (opts.onDone) opts.onDone(plan.rec.id, "exists");
        ok.remove();
        cancel.textContent = tc("关闭", "Close");
        return;
      }

      // 必要字段置顶（与场景弹窗同构）
      var req = document.createElement("div");
      req.className = "ssd-imp-req";
      req.appendChild(impRow({
        label: tc("名字 / 源编号", "Name / Source ID"),
        value: (p.name || opts.name || "") + " ; " +
          brandNameForEndpoint(endpoint) + " : " + stashId,
        locked: true,
      }).row);
      body.appendChild(req);

      var list = document.createElement("div");
      list.className = "ssd-imp-list";
      body.appendChild(list);
      var on = {};

      var keys = PERF_SCALAR_KEYS.concat(["aliases", "urls"]);
      var shown = 0;
      keys.forEach(function (k) {
        var v = vals[k];
        if (!perfHasValue(k, v)) return;   // §4.4：只渲染源里非空的项
        shown++;
        var r = impRow({
          label: tc(PERF_FIELD_LABELS[k][0], PERF_FIELD_LABELS[k][1]),
          checked: prefs[k],
          value: perfValueText(k, v),
        });
        list.appendChild(r.row);
        on[k] = r;
      });
      if (imgUrl) {
        shown++;
        var imgRow = impRow({
          label: tc("头像", "Image"),
          checked: prefs.image,
          value: urlHost(imgUrl),
        });
        list.appendChild(imgRow.row);
        on.image = imgRow;
      }
      if (!shown) {
        var none = document.createElement("div");
        none.className = "ssd-imp-note";
        none.textContent = tc("源上除名字外没有可写字段（TPDB 常见）",
          "The source has no writable fields besides the name (common on TPDB)");
        list.appendChild(none);
      }

      ok.disabled = false;
      var busy = false;
      ok.addEventListener("click", function () {
        if (busy) return;
        busy = true;
        ok.disabled = true;
        cancel.disabled = true;
        err.textContent = "";
        ok.textContent = tc("写入中…", "Writing…");
        var picked = {};
        Object.keys(on).forEach(function (k) { picked[k] = on[k].cb.checked; });

        var work;
        if (mode === "name" || mode === "alias") {
          work = loadLocalPerformerFull(plan.rec.id).then(function (local) {
            local = local || {};
            var input = {
              id: plan.rec.id,
              // performerUpdate 的 stash_ids 是整体替换 → 必须合并，否则这个
              // 演员身上其他源的 id 会被冲掉（§4.5 第 2/3 步）
              stash_ids: mergeStashIds(local.stash_ids, endpoint, stashId),
            };
            var fill = buildPerfDetailInput(local, p, false);
            Object.keys(fill).forEach(function (k) { if (picked[k]) input[k] = fill[k]; });
            if (picked.aliases && vals.aliases.length) {
              input.alias_list = dedupeStrings((local.alias_list || []).concat(vals.aliases));
            }
            if (picked.urls && vals.urls.length) {
              input.urls = dedupeStrings((local.urls || []).concat(vals.urls));
            }
            if (picked.image && imgUrl && !hasCustomImage(local)) input.image = imgUrl;
            return callGQL(PERF_UPDATE_MUTATION, { input: input });
          }).then(function () { return plan.rec.id; });
        } else {
          work = createPerformerWithFallback(perfCreateInputFrom(vals, picked, {
            endpoint: endpoint, stashId: stashId, name: p.name || opts.name, image: imgUrl,
          })).then(function (id) {
            if (!id) throw new Error(tc("创建返回空结果", "Create returned empty result"));
            return id;
          });
        }

        work.then(function (id) {
          invalidatePerfIndex(endpoint);
          closeImportDialog();
          if (opts.onDone) opts.onDone(id, mode === "name" || mode === "alias" ? "link" : "create");
        }).catch(function (e) {
          console.error("[SSD] performer import failed:", e);
          busy = false;
          ok.disabled = false;
          cancel.disabled = false;
          ok.textContent = tc("确认入库", "Add to library");
          err.textContent = tc("入库失败：", "Import failed: ") +
            (e && e.message ? e.message : String(e));
        });
      });
    }

    document.body.appendChild(overlay);
    _impEl = overlay;
    _impBackId = modalBack.hold(closeImportDialog);   // 返回键＝关闭（移动端没有 Esc）
    document.addEventListener("keydown", function onEscPerf(e) {
      if (!_impEl) { document.removeEventListener("keydown", onEscPerf); return; }
      if (e.key === "Escape") { closeImportDialog(); document.removeEventListener("keydown", onEscPerf); }
    });
  }

  function findOrCreateStudio(name, stashId, endpoint) {
    var nm = String(name || "").trim();
    if (!nm) return Promise.resolve(null);
    return loadStudioIndex().then(function (idx) {
      // 先认源编号：同一工作室在不同源里的显示名可能不同（大小写/后缀），
      // 只按名字认会漏；编号命中就是同一条，名字以本地为准
      if (stashId && endpoint) {
        var byId = idx.byStashId[String(endpoint).toLowerCase() + ":" + String(stashId).toLowerCase()];
        if (byId) return byId;
      }
      var byName = idx.byName[nm.toLowerCase()];
      if (byName) return byName;
      // 新建时带上源编号，否则这条工作室在库里永远认不出源（下次只能靠名字撞）
      var input = { name: nm };
      if (stashId && endpoint) input.stash_ids = [{ endpoint: endpoint, stash_id: String(stashId) }];
      return callGQL(
        "mutation($input:StudioCreateInput!){studioCreate(input:$input){id}}",
        { input: input }
      ).then(function (d) {
        var id = d && d.studioCreate ? d.studioCreate.id : null;
        // 回写索引：批量入库时同一工作室会被连着的几条片段命中，不回写就会
        // 反复建同名工作室
        if (id) {
          idx.byName[nm.toLowerCase()] = id;
          if (stashId && endpoint) {
            idx.byStashId[String(endpoint).toLowerCase() + ":" + String(stashId).toLowerCase()] = id;
          }
        }
        return id;
      }).catch(function () { return null; });
    });
  }

  // 本地标签的 name / alias → id 索引。
  // 不能每个标签单独 findTags + tagCreate：本地库把英文名挂成中文标签的别名
  // （「金发」的别名含 Blonde Hair (Female)），逐个建会被
  // `name 'X' is used as alias for 'Y'` 拒掉，实测 10 个标签丢 8 个。
  // 一次拉全量，按 name 与别名双向匹配。
  var _tagIndex = null;

  function loadTagIndex() {
    if (_tagIndex) return Promise.resolve(_tagIndex);
    return callGQL("query{findTags(filter:{per_page:-1}){tags{id name aliases}}}")
      .then(function (d) {
        var idx = {};
        (((d || {}).findTags || {}).tags || []).forEach(function (t) {
          if (t && t.name) idx[String(t.name).toLowerCase()] = t.id;
          (t && t.aliases || []).forEach(function (a) {
            if (a) idx[String(a).toLowerCase()] = t.id;
          });
        });
        _tagIndex = idx;
        return idx;
      })
      .catch(function () { return null; });
  }

  function findOrCreateTag(name) {
    var key = String(name || "").trim().toLowerCase();
    if (!key) return Promise.resolve(null);
    return loadTagIndex().then(function (idx) {
      if (idx && idx[key]) return idx[key];
      // 建不出来（名字被别人挂成别名 / 返回 null）时按名字回查一次再认。
      // 索引是入库前一次性拉的，后台扫描期间新增的标签/别名查不到，建又会被
      // 「name 'X' is used as alias for 'Y'」拒掉，不回查就会丢标签。
      function requery() {
        return callGQL(
          "query($f:FindFilterType!){findTags(filter:$f){tags{id name aliases}}}",
          { f: { q: name, per_page: 5 } }
        ).then(function (d) {
          var tags = ((d || {}).findTags || {}).tags || [];
          for (var i = 0; i < tags.length; i++) {
            var t = tags[i] || {};
            var hit = String(t.name || "").toLowerCase() === key ||
              (t.aliases || []).some(function (a) { return a && String(a).toLowerCase() === key; });
            if (hit) {
              if (idx) idx[key] = t.id;
              return t.id;
            }
          }
          return null;
        }).catch(function () { return null; });
      }
      return callGQL(
        "mutation($input:TagCreateInput!){tagCreate(input:$input){id}}",
        { input: { name: name } }
      ).then(function (d) {
        var id = d.tagCreate ? d.tagCreate.id : null;
        if (id && idx) idx[key] = id;
        return id || requery();
      }).catch(requery);
    }).catch(function () { return null; });
  }

  // ─── Action: Open in box ─────────────────────────────────────────────────

  function handleOpenInBox(item) {
    var url = boxSceneUrl(item.endpoint, item.scene.id);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // ─── Action: Search Resources (Jackett via Python backend) ────────────────

  // 番号形态判定：只有真的像番号才拿 code 当搜索词。
  // stash-box 的 code 不保证是番号 —— TPDB 场景的 code 来自 external_id，
  // 实测形如 "japanhdv.com-6097"（站点域名 + 站点内 ID），拿它搜 Jackett
  // 只会得到无关结果（论坛反馈：「有 ID 时结果完全不相关，没有 ID 时反而准确」）。
  function looksLikeCode(v) {
    var s = String(v || "").trim();
    if (!s || s.length > 24) return false;
    if (/[\s.]/.test(s)) return false;                       // 空格或域名点 = 不是番号
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false;   // uuid
    if (/^\d{6}[-_]\d{2,4}$/.test(s)) return true;            // 051424_001 类无码番号
    if (!/\d/.test(s)) return false;                          // 无数字 = slug / 标题
    // SSIS-001 / T28-123 / FC2-PPV-1234567 / 1pondo-123456
    return /^[A-Za-z0-9]{2,12}[-_](?:\d{2,7}|[A-Za-z]{2,4}[-_]\d{1,7})$/.test(s);
  }

  // 搜索词：番号形 code 优先（JAV 场景标题是日文长句，搜不出结果），
  // 否则一律用标题 —— western 场景本来就没有番号。
  function searchQueryFor(sc) {
    var code = String((sc && sc.code) || "").trim();
    var title = String((sc && sc.title) || "").trim();
    if (code && looksLikeCode(code)) return code;
    return title || code;
  }

  function handleSearchResources(item, btn) {
    var sc = _state.modalDetail ? _state.modalDetail.scene : item.scene;
    var defaultQuery = searchQueryFor(sc);
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
    goBtn.className = "ssd-dp-btn primary";
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

  // 滚动容器是 .ssd-modal-body，不是 .ssd-modal（后者 overflow:hidden，
  // scrollHeight 恒等于 clientHeight，滚它等于没滚）。
  function modalBody() {
    return document.querySelector(".ssd-modal .ssd-modal-body");
  }

  // Smooth-scroll the modal to its bottom so the search status/results are
  // visible (the search section sits at the end of the modal).
  function scrollModalToBottom() {
    var body = modalBody();
    if (!body) return;
    try { body.scrollTo({ top: body.scrollHeight, behavior: "smooth" }); }
    catch (e) { body.scrollTop = body.scrollHeight; }
  }

  // 结果渲染出来比那行「搜索中…」高一个数量级，滚动位置却还停在旧底部，
  // 视口会落在列表中间。这里把结果抬头对齐到可视区顶部。
  function scrollResultsToTop(section) {
    var body = modalBody();
    if (!body || !section) return;
    var anchor = section.querySelector(".ssd-search-header") || section;
    var delta = anchor.getBoundingClientRect().top - body.getBoundingClientRect().top;
    var top = body.scrollTop + delta - 8;
    try { body.scrollTo({ top: top, behavior: "smooth" }); }
    catch (e) { body.scrollTop = top; }
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
    setActLabel(btn, tc("搜索中...", "Searching..."));
    var loading = document.createElement("div");
    loading.className = "ssd-search-loading";
    loading.textContent = tc("正在通过 Jackett 搜索: ", "Searching via Jackett: ") + query;
    results.appendChild(loading);
    scrollModalToBottom();

    runPluginOp({ mode: "search", query: query }).then(function (result) {
      btn.disabled = false;
      setActLabel(btn, tc("搜索资源", "Search Resources"));
      // 结果渲染完由 renderSearchPage 统一把抬头对齐到可视区（见 scrollResultsToTop）
      // 排序要用实际下发的搜索词；后端老版本没回 query 时用本次的兜底
      var payload = result || {};
      if (!payload.query) payload.query = query;
      renderSearchResults(results, payload);
    }).catch(function (e) {
      console.error("[SSD] search error:", e);
      btn.disabled = false;
      setActLabel(btn, tc("搜索资源", "Search Resources"));
      results.innerHTML = "";
      var err = document.createElement("div");
      err.className = "ssd-search-error";
      err.textContent = tc("搜索失败: ", "Search failed: ") + (e.message || String(e));
      results.appendChild(err);
    });
  }

  // ─── 结果通道：runPluginOperation ────────────────────────────────────────
  // 插件 stdout 输出一条 {"output": ...}，Stash 把它原样当作这个 mutation 的
  // 返回值。通道要会话，没有 query{logs} 的 30 条窗口，也没有 64KB 单行截断，
  // 同步返回，不需要轮询 job。
  // （也试过写文件走 assets 静态路由，但那个目录匿名可列可读，搜索结果会公开。）
  // 代价是请求会挂住整个 Jackett 搜索时长，最长到后端 jackettTimeout。
  function runPluginOp(args) {
    return callGQL(
      "mutation($id:ID!,$a:Map!){runPluginOperation(plugin_id:$id,args:$a)}",
      { id: PLUGIN_ID, a: args || {} }
    ).then(function (r) { return r && r.runPluginOperation; })
      .catch(function (e) { throw new Error(gqlErrorMessage(e)); });
  }

  // callGQL 把 GraphQL errors 数组整个 JSON.stringify 后抛出，直接显示会是一坨
  // `[{"message":"..."}]`。插件 operation 的错误本来就是一句话，取出来即用。
  function gqlErrorMessage(e) {
    var raw = String((e && e.message) || e || "");
    var msg = raw;
    try {
      var arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length && arr[0] && arr[0].message) msg = arr[0].message;
    } catch (_) { /* 不是 JSON，原样返回 */ }
    return humanizePluginError(msg);
  }

  // 后端跑不起来时 Stash 抛的是 Go 的原始 exec 报错（`error running plugin:
  // exec: "python": executable file not found in $PATH`）。官方 Docker 镜像不带
  // python3，用户看到这行只能猜。这里翻成能照做的说法，其余错误原样透出。
  function humanizePluginError(msg) {
    var s = String(msg || "");
    if (/executable file not found|no such file or directory/i.test(s) && /python/i.test(s)) {
      return tc(
        "插件后端没启动：系统里找不到 Python 3。官方 Docker 镜像不含 python3，需要在容器里装（apk add python3 / apt-get install python3），见 README「Docker / Linux 部署」",
        "Plugin backend did not start: no Python 3 found. The official Docker image ships without python3 — install it inside the container (apk add python3 / apt-get install python3)."
      );
    }
    if (/^error running plugin: exit status \d+/.test(s) || /exit status \d+/.test(s)) {
      return tc(
        "插件后端执行出错，具体原因在 Stash 日志里（搜索 stashDiscover 的 stderr）",
        "Plugin backend exited with an error — see the plugin stderr in the Stash log"
      ) + "：" + s;
    }
    return s;
  }

  // ── 搜索结果按标题匹配度排序（用户 2026-10-30 / 论坛反馈）──────────────
  // Jackett 的 q 是自由文本，索引器普遍按词 OR 匹配；TPDB 没有番号可用，只能
  // 把整条英文标题扔过去，于是只沾一个词的条目也全量返回 —— 用户看到的就是
  // 「亚洲结果异常多」。这里在本地算「标题命中了 query 的百分之多少的词」重排，
  // 低匹配的收进折叠区。纯字符串计算、不发请求，对任何索引器都成立；也想改
  // BRAND_MAP 顺序来调优是不可能的，那张表只做 host → 显示名的映射。
  var SEARCH_STOPWORDS = {
    the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, in: 1, on: 1, at: 1, to: 1,
    for: 1, with: 1, by: 1, from: 1, is: 1, it: 1, as: 1, be: 1, vol: 1,
    part: 1, full: 1,
  };

  // 用显式字符范围而不是 \p{L}：后者要 u 标志，老浏览器在**解析期**就抛
  // SyntaxError，整个插件脚本连加载都过不去。
  function normSearchText(s) {
    return String(s || "").toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function searchQueryTokens(q) {
    var parts = normSearchText(q).split(" ");
    return parts.filter(function (w) { return w.length >= 2 && !SEARCH_STOPWORDS[w]; });
  }

  // 整串命中直接满分：番号搜索（SSIS-001）走这条，标题里带着编号就算对得上。
  function titleMatchScore(qNorm, qTokens, title) {
    var t = normSearchText(title);
    if (!t) return 0;
    if (qNorm && t.indexOf(qNorm) !== -1) return 1;
    if (!qTokens.length) return 0;
    var hit = 0;
    for (var i = 0; i < qTokens.length; i++) {
      if (t.indexOf(qTokens[i]) !== -1) hit++;
    }
    return hit / qTokens.length;
  }

  function rankSearchResults(list, query) {
    var qNorm = normSearchText(query);
    var qTokens = searchQueryTokens(query);
    var scored = (list || []).map(function (res, i) {
      return { res: res, i: i, score: titleMatchScore(qNorm, qTokens, res && res.title) };
    });
    // 一条都没命中，说明词表对不上（例如中文整句标题）——排序和折叠都失效，
    // 原样返回，别假装筛过
    var anyHit = scored.some(function (s) { return s.score > 0; });
    if (!anyHit) return { primary: (list || []).slice(), low: [] };

    // 同分保持后端原顺序（Array#sort 稳定），免得每次刷新结果跳来跳去
    scored.sort(function (a, b) { return (b.score - a.score) || (a.i - b.i); });

    var fold = scored.length >= 8; // 结果本来就少就别藏，藏了像「没搜到」
    var primary = [];
    var low = [];
    scored.forEach(function (s) {
      if (fold && s.score < 0.5) low.push(s.res); else primary.push(s.res);
    });
    // 主列表至少留 3 条（且不少于总数的两成）：只剩 1 条全命中时全折叠，
    // 用户会以为搜索坏了。补进来的是低匹配里分数最高的那几条。
    var minPrimary = Math.max(3, Math.ceil(scored.length * 0.2));
    while (primary.length < minPrimary && low.length) primary.push(low.shift());
    return { primary: primary, low: low };
  }

  function renderSearchResults(section, result) {
    section.innerHTML = "";
    var raw = result.results || [];
    var ranked = rankSearchResults(raw, result.query || "");
    _searchResults = ranked.primary;
    _searchLow = ranked.low;
    _searchPage = 1;

    var header = document.createElement("div");
    header.className = "ssd-search-header";
    header.textContent = tc("搜索结果 (", "Search Results (") + (result.count || 0) + ")";
    section.appendChild(header);

    // 后端只下发前 SEARCH_RESULT_LIMIT 条：抬头报总数、列表却更短时说清楚，
    // 否则就是"日志说 230 条，插件里只有几条"（论坛反馈）
    if (result.truncated) {
      var shown = raw.length;
      var hint = document.createElement("div");
      hint.className = "ssd-search-truncated";
      hint.textContent = tc(
        "共 " + (result.count || 0) + " 条，仅显示前 " + shown + " 条，加番号或关键词可缩小范围",
        (result.count || 0) + " results — showing the first " + shown +
          ", refine the query to narrow it down");
      section.appendChild(hint);
    }

    if (_searchResults.length === 0) {
      var empty = document.createElement("div");
      empty.className = "ssd-search-empty";
      empty.textContent = tc("未找到资源", "No resources found");
      section.appendChild(empty);
      return;
    }

    // 低匹配结果不删只折叠：用户可能是拿标题里没写的一个词在搜，全藏起来
    // 就变成「明明日志有 200 条，插件里只有 3 条」
    if (_searchLow.length) {
      var lowBar = document.createElement("div");
      lowBar.className = "ssd-search-truncated ssd-search-lowmatch";
      lowBar.appendChild(document.createTextNode(
        tc("另有 " + _searchLow.length + " 条标题匹配度低的结果（已按匹配度排序）",
          "Plus " + _searchLow.length + " results with a weak title match (sorted by match)")));
      var lowBtn = document.createElement("button");
      lowBtn.type = "button";
      lowBtn.className = "ssd-dp-btn ghost sm";
      lowBtn.textContent = tc("显示", "Show");
      lowBtn.onclick = function () {
        _searchResults = _searchResults.concat(_searchLow);
        _searchLow = [];
        _searchPage = 1;
        lowBar.remove();
        renderSearchPage(section);
      };
      lowBar.appendChild(lowBtn);
      section.appendChild(lowBar);
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
      prevBtn.className = "ssd-dp-btn ghost sm";
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
      nextBtn.className = "ssd-dp-btn ghost sm";
      nextBtn.textContent = tc("下一页", "Next") + " →";
      nextBtn.disabled = _searchPage >= totalPages;
      nextBtn.onclick = function () {
        _searchPage++;
        renderSearchPage(section);
      };
      pager.appendChild(nextBtn);

      section.appendChild(pager);
    }

    scrollResultsToTop(section);
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
    // 来源索引器（Jackett 聚合结果里的出处）。后端老版本没有 indexer，
    // 退回 tracker 属性；两者都没有就不留空壳节点。
    var srcName = res.indexer || res.tracker || "";
    if (srcName) {
      var src = document.createElement("span");
      src.className = "ssd-search-item-indexer";
      src.textContent = srcName;
      src.title = srcName;
      meta.appendChild(src);
    }
    var metaParts = [];
    if (res.size_human) metaParts.push(res.size_human);
    if (res.seeders >= 0) metaParts.push(tc("种子", "S") + ": " + res.seeders);
    if (res.leechers >= 0) metaParts.push(tc("下载", "L") + ": " + res.leechers);
    meta.appendChild(document.createTextNode(metaParts.join(" · ")));
    info.appendChild(meta);
    row.appendChild(info);

    var actions = document.createElement("div");
    actions.className = "ssd-search-item-actions";

    if (res.magnet) {
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "ssd-dp-btn ghost sm";
      copyBtn.textContent = tc("复制磁力", "Copy Magnet");
      copyBtn.onclick = function () {
        navigator.clipboard.writeText(res.magnet).then(function () {
          copyBtn.textContent = tc("已复制 ✓", "Copied ✓");
          copyBtn.classList.add("ok");
          setTimeout(function () {
            copyBtn.textContent = tc("复制磁力", "Copy Magnet");
            copyBtn.classList.remove("ok");
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
      openLinkBtn.className = "ssd-dp-btn ghost sm";
      openLinkBtn.textContent = tc("打开链接", "Open Link");
      actions.appendChild(openLinkBtn);
    }

    if (res.magnet) {
      var pushBtn = document.createElement("button");
      pushBtn.type = "button";
      pushBtn.className = "ssd-dp-btn tonal sm";
      pushBtn.textContent = tc("推送下载", "Push to DL");
      pushBtn.onclick = function () {
        pushBtn.disabled = true;
        pushBtn.textContent = tc("推送中...", "Pushing...");
        runPluginOp({ mode: "push_download", magnet: res.magnet }).then(function () {
          pushBtn.textContent = tc("已推送 ✓", "Pushed ✓");
          pushBtn.classList.add("ok");
          setTimeout(function () {
            pushBtn.disabled = false;
            pushBtn.textContent = tc("推送下载", "Push to DL");
            pushBtn.classList.remove("ok");
          }, 2500);
        }).catch(function (e) {
          pushBtn.disabled = false;
          pushBtn.textContent = tc("推送失败", "Failed");
          pushBtn.classList.add("err");
          showModalNotice(tc("推送失败: ", "Push failed: ") + (e.message || String(e)), "error");
          setTimeout(function () {
            pushBtn.textContent = tc("推送下载", "Push to DL");
            pushBtn.classList.remove("err");
          }, 3000);
        });
      };
      actions.appendChild(pushBtn);
    }

    row.appendChild(actions);
    return row;
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
      if (!isPerformerPage() && !isStudioPage()) { _tabInjected = false; _tabPerformerId = null; return; }
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
    _state.entityType = "performer";
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
    if (!isPerformerPage() && !isStudioPage()) {
      _tabInjected = false; _tabPerformerId = null;
      resetPerformerState();
      return;
    }
    var pid = isStudioPage() ? getStudioIdFromUrl() : getPerformerIdFromUrl();
    if (pid && pid !== _state.performerId) {
      resetPerformerState();
      _state.performerId = pid;
      _tabInjected = false;
    }
    setTimeout(ensureTabInjected, 300);
    setTimeout(ensureTabInjected, 800);
  }

  // ─── Shared API for the discover-page module ─────────────────────────────
  // discover.js (the "发现" nav page) is a SEPARATE file loaded on demand via
  // the enableDiscoverPage setting — see maybeLoadDiscover below. Everything
  // it needs from this closure is exported here once; when the switch is off
  // the module never loads and this object is simply never read.
  // ─── 忽略记录（§3）：全局键 SSD:dp:ignore.v1 ────────────────────────────
  // 必须是全局键（不带 host 前缀）：cacheInvalidate(host) 在刷新按钮 / 切源时
  // 删的是 "SSD:dp:<host>:" 前缀的全部键，带 host 前缀的记录一点刷新就没了。
  // 结构：{ scenes: { "endpoint:sceneId": 快照 }, performers: { "endpoint:stashId": 快照 },
  //         trimmed: 累计淘汰条数 }
  // 快照不是可选的：只存 id 的话管理页显示不出「288 条是什么」，反查 box 又慢、
  // 已下架的还查不到。卡片上现成有，忽略时顺手带上。
  var DP_IGNORE_KEY = "SSD:dp:ignore.v1";
  var IGNORE_MAX_PER_KIND = 3000;  // 场景 / 演员各自条数上限
  var IGNORE_MAX_CHARS = 1000000;  // 整包字符预算（配额约 5.24M，留足余量）
  var IGNORE_SNAPSHOT_P = 4;       // 场景快照只留前 4 位演员名（管理页搜索用）
  var _ignoreMemo = null;

  function ignoreKey(endpoint, id) {
    return String(endpoint || "").toLowerCase() + ":" + String(id || "").toLowerCase();
  }

  // 快照字段长度上限（用户 2026-10-30 第九轮审计）：存进来的是「管理页显示 + 搜索」
  // 用的短文本，卡片上本来就会省略号截断，多出来的只有配额成本。URL 不截 ——
  // 截断等于断链，而且卡片 onerror 兜不住「半个 URL」。
  var IGN_TEXT_CAP = { title: 200, studio: 80, code: 40, date: 20, name: 120, alias: 60 };
  function ignClip(v, n) {
    var s = String(v == null ? "" : v).trim();
    return s.length > n ? s.slice(0, n) : s;
  }
  function ignClipList(arr, n, cap) {
    if (!arr || !arr.length) return null;
    return arr.slice(0, n).map(function (x) { return ignClip(x, cap); })
      .filter(function (x) { return !!x; });
  }

  // 一次 JSON.parse 转成两个普通对象（键即 Map 键），filterPipeline / 导航轮询 /
  // 演员页 tab 共用同一份内存副本 —— 不做每场景一次 localStorage.getItem（原 T2）
  function ignoreStore() {
    if (_ignoreMemo) return _ignoreMemo;
    var st = { scenes: {}, performers: {}, trimmed: 0 };
    try {
      var raw = localStorage.getItem(DP_IGNORE_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === "object") {
        if (o.scenes && typeof o.scenes === "object") st.scenes = o.scenes;
        if (o.performers && typeof o.performers === "object") st.performers = o.performers;
        if (typeof o.trimmed === "number" && o.trimmed > 0) st.trimmed = o.trimmed;
      }
    } catch (e) {
      // 坏 JSON：先按空记录跑（不让一条坏数据把忽略功能整体搞挂），
      // 下次写入时整体覆盖
      console.warn("[SSD] ignore store unreadable:", (e && e.message) || e);
    }
    _ignoreMemo = st;
    return st;
  }

  function ignorePayload(st, extraDropped) {
    return JSON.stringify({
      scenes: st.scenes, performers: st.performers,
      trimmed: (st.trimmed || 0) + (extraDropped || 0),
    });
  }

  // 硬上限（§3.2）：条数 + 整包字符。不按时间过期 —— 老片在窗口调大后会
  // 「复活」，而且将来导出时数据已经不完整。超限只淘汰最旧的，并把累计淘汰
  // 条数写进 store.trimmed，管理页显性提示，不做静默衰减。
  function ignoreTrim(st) {
    var dropped = 0;
    ["scenes", "performers"].forEach(function (kind) {
      var bag = st[kind];
      var keys = Object.keys(bag);
      if (keys.length <= IGNORE_MAX_PER_KIND) return;
      keys.sort(function (a, b) { return (bag[a].at || 0) - (bag[b].at || 0); });
      for (var i = 0; i < keys.length - IGNORE_MAX_PER_KIND; i++) {
        delete bag[keys[i]];
        dropped++;
      }
    });
    var payload = ignorePayload(st, dropped);
    // 字符预算：两头一起按 at 最旧逐个淘汰，直到进预算
    while (payload.length > IGNORE_MAX_CHARS) {
      var kind = null, k = null, at = Infinity;
      ["scenes", "performers"].forEach(function (kd) {
        var bag = st[kd];
        Object.keys(bag).forEach(function (kk) {
          var v = bag[kk] && bag[kk].at || 0;
          if (v < at) { at = v; kind = kd; k = kk; }
        });
      });
      if (!kind) break;
      delete st[kind][k];
      dropped++;
      payload = ignorePayload(st, dropped);
    }
    st.trimmed = (st.trimmed || 0) + dropped;
    return { payload: payload, dropped: dropped };
  }

  // 写失败不能静默（§3.2）：缓存写失败只是下次重拉，忽略记录写失败等于
  // 丢失用户决策 —— 内存副本保留，调用方负责 toast 出来
  function ignoreWrite() {
    var st = ignoreStore();
    var r = ignoreTrim(st);
    try {
      localStorage.setItem(DP_IGNORE_KEY, r.payload);
      return { ok: true, dropped: r.dropped };
    } catch (e) {
      return { ok: false, dropped: r.dropped, error: (e && e.name) || String(e) };
    }
  }

  function ignoreScene(item) {
    var sc = (item && item.scene) || {};
    var ep = String((item && item.endpoint) || "").toLowerCase();
    if (!ep || !sc.id) return { ok: false, error: "no key" };
    var st = ignoreStore();
    var k = ignoreKey(ep, sc.id);
    if (!st.scenes[k]) {
      var imgs = (item.images && item.images.length ? item.images : (sc.images || []));
      var names = [];
      (sc.performers || []).forEach(function (p) {
        var pf = p && p.performer;
        if (pf && pf.name && names.length < IGNORE_SNAPSHOT_P) names.push(pf.name);
      });
      st.scenes[k] = {
        at: Date.now(),
        title: ignClip(sc.title, IGN_TEXT_CAP.title),
        date: ignClip(sc.release_date, IGN_TEXT_CAP.date),
        code: ignClip(sc.code, IGN_TEXT_CAP.code),
        cover: (imgs[0] && imgs[0].url) || "",
        studio: ignClip(sc.studio && sc.studio.name, IGN_TEXT_CAP.studio),
        p: names.map(function (nm) { return ignClip(nm, IGN_TEXT_CAP.alias); })
          .filter(function (nm) { return !!nm; }),
      };
    }
    var r = ignoreWrite();
    r.key = k;
    return r;
  }

  function ignorePerformer(o) {
    o = o || {};
    var ep = String(o.endpoint || "").toLowerCase();
    if (!ep || !o.stashId) return { ok: false, error: "no key" };
    var st = ignoreStore();
    var k = ignoreKey(ep, o.stashId);
    if (!st.performers[k]) {
      var snap = { at: Date.now(), name: ignClip(o.name, IGN_TEXT_CAP.name), image: o.image || "" };
      // 别名只在不额外请求时带（管理页搜索用，约 +10 字符/条）
      var als = ignClipList(o.aliases, 12, IGN_TEXT_CAP.alias);
      if (als && als.length) snap.alias_list = als;
      // 管理页卡片要显示国旗/年龄/性别（用户 2026-10-29）。这三个字段本来就在
      // stash-box 的 performer 对象里，忽略时顺手存下，约 +20 字符/条；不存的话
      // 管理页只能再发一次请求，而「零请求」正是这一页的立身之本。
      if (o.country) snap.country = String(o.country).slice(0, 4);
      if (o.birthdate) snap.birthdate = String(o.birthdate).slice(0, 10);
      if (o.gender) snap.gender = String(o.gender).slice(0, 24);
      st.performers[k] = snap;
    }
    var r = ignoreWrite();
    r.key = k;
    return r;
  }

  // ─── 快照补全：把「国籍 / 生日 / 性别 / 别名」补进已有记录 ─────────────────
  // 为什么需要：忽略的入口有三处，手上有多少字段取决于那一处的数据来源。
  //   · 发现页批量忽略：演员对象来自 scene.performers，只有 id/name/图
  //   · 演员页 tab 忽略：同上
  //   · 演员弹窗忽略：box findPerformer 的结果（字段齐）
  // 于是同一份「已忽略管理」里，一半卡片有国旗/年龄，一半只剩一个名字
  // （用户 2026-10-30 反馈）。这里在打开管理页时按需补一次 box findPerformer，
  // 补过的键记在内存里不重复请求；只在真的缺字段时才发，条数也封顶。
  var _ignEnrichTried = {};

  function boxForEndpoint(boxes, ep) {
    var e = String(ep || "").trim().toLowerCase();
    if (!e) return null;
    for (var i = 0; i < (boxes || []).length; i++) {
      var b = boxes[i] || {};
      var full = String(b.endpoint || "").toLowerCase();
      if (!full) continue;
      if (full === e) return b;
      // 忽略键里存的 endpoint 可能是完整 URL，也可能是短名（"stashdb" /
      // "javstash"）—— 比主机名，互相包含即算命中
      var host = full.replace(/^[a-z]+:\/\//, "").split("/")[0];
      if (host && (host === e || host.indexOf(e) !== -1 || e.indexOf(host) !== -1)) return b;
      if (String(b.name || "").toLowerCase() === e) return b;
    }
    return null;
  }

  function backfillIgnoredPerformers(limit) {
    var st = ignoreStore();
    var todo = Object.keys(st.performers || {}).filter(function (k) {
      if (_ignEnrichTried[k]) return false;
      var v = st.performers[k] || {};
      return !v.country && !v.birthdate && !v.gender;
    });
    if (!todo.length) return Promise.resolve(0);
    todo = todo.slice(0, limit || 12);
    todo.forEach(function (k) { _ignEnrichTried[k] = 1; });
    return getStashBoxes().then(function (boxes) {
      var n = 0;
      var chain = Promise.resolve();
      todo.forEach(function (k) {
        chain = chain.then(function () {
          // 键是 "endpoint:stashId"，而 endpoint 可能是 "https://stashdb.org/graphql"
          // —— 里面自带冒号，split(":") 会把 "https" 当成 endpoint（第一版就这么
          // 错的，补全一条都没成）。从最后一个冒号切。
          var cut = String(k).lastIndexOf(":");
          var box = cut > 0 ? boxForEndpoint(boxes, String(k).slice(0, cut)) : null;
          var id = cut > 0 ? String(k).slice(cut + 1) : "";
          if (!box || !id) return;
          return callBoxGQL(box.endpoint, boxKey(box),
            "query($id:ID!){findPerformer(id:$id){id gender birth_date country aliases}}",
            { id: id }, BOX_TIMEOUT_MS).then(function (r) {
              var pf = r && r.findPerformer;
              if (!pf) return;
              var cur = ignoreStore().performers[k];
              if (!cur) return;                       // 期间被恢复了
              if (cur.country || cur.birthdate || cur.gender) return; // 已有，不覆盖
              var wrote = false;
              if (pf.country) { cur.country = String(pf.country).slice(0, 4); wrote = true; }
              if (pf.birth_date) { cur.birthdate = String(pf.birth_date).slice(0, 10); wrote = true; }
              if (pf.gender) { cur.gender = String(pf.gender).slice(0, 24); wrote = true; }
              if (!(cur.alias_list && cur.alias_list.length) && pf.aliases && pf.aliases.length) {
                cur.alias_list = pf.aliases.slice(0, 12);
                wrote = true;
              }
              if (!wrote) return;
              ignoreWrite();
              n++;
            }).catch(function () { /* 单条失败不影响其它条 */ });
        });
      });
      return chain.then(function () {
        // 一次性通知，避免每补一条就重绘一次管理页
        if (n > 0) {
          try { window.dispatchEvent(new CustomEvent("ssd:ign-enriched", { detail: n })); } catch (_) {}
        }
        return n;
      });
    }).catch(function () { return 0; });
  }

  function ignoreRemove(kind, key) {
    var st = ignoreStore();
    var bag = st[kind === "performers" ? "performers" : "scenes"];
    if (!bag[key]) return { ok: true, removed: 0 };
    delete bag[key];
    return ignoreWrite();
  }

  function ignoreRestoreAll(kind) {
    var st = ignoreStore();
    var bag = st[kind === "performers" ? "performers" : "scenes"];
    var n = Object.keys(bag).length;
    st[kind === "performers" ? "performers" : "scenes"] = {};
    var r = ignoreWrite();
    r.removed = n;
    return r;
  }

  var dpIgnore = {
    key: ignoreKey,
    store: ignoreStore,
    scenes: function () { return ignoreStore().scenes; },
    performers: function () { return ignoreStore().performers; },
    isSceneIgnored: function (endpoint, sceneId) {
      return !!ignoreStore().scenes[ignoreKey(endpoint, sceneId)];
    },
    isPerformerIgnored: function (endpoint, stashId) {
      return !!ignoreStore().performers[ignoreKey(endpoint, stashId)];
    },
    ignoreScene: ignoreScene,
    ignorePerformer: ignorePerformer,
    remove: ignoreRemove,
    restoreAll: ignoreRestoreAll,
    trimmed: function () { return ignoreStore().trimmed || 0; },
    count: function () {
      var st = ignoreStore();
      return { scenes: Object.keys(st.scenes).length, performers: Object.keys(st.performers).length };
    },
    // 管理页打开时按需补全演员快照（国籍/生日/性别/别名）
    backfillPerformers: backfillIgnoredPerformers,
    // ↓ 导出文件 = 快照结构定稿（用户 2026-10-30 审计，v1）：
    //   version     结构版本，当前 1；导入端只按 v1 字段重建，更高版本照读并提示
    //   exportedAt  导出时间（ISO），仅供人看，导入不读
    //   trimmed     导出时已累计淘汰的条数，仅供人看，导入不读
    //   scenes      键 "endpoint:sceneId" → { at, title, date, code, cover, studio, p[] }
    //   performers  键 "endpoint:stashId"  → { at, name, image, alias_list[], country, birthdate, gender }
    exportJSON: function () {
      var st = ignoreStore();
      return JSON.stringify({
        version: 1, exportedAt: new Date().toISOString(),
        trimmed: st.trimmed || 0, scenes: st.scenes, performers: st.performers,
      }, null, 2);
    },
    // 导入（用户 2026-10-29）：导出的反操作。只补本地没有的键 —— 已有的记录
    // 带着用户当初忽略的时间，覆盖会打乱「按忽略时间排序」，也不该让一次导入
    // 把当前决策悄悄改掉。脏字段一律不透传，只按快照结构重建。
    importJSON: function (text) {
      var o;
      try { o = JSON.parse(String(text || "")); }
      catch (e) { return { ok: false, error: "JSON 解析失败", added: 0, skipped: 0, invalid: 0, fileVersion: 0 }; }
      if (!o || typeof o !== "object") return { ok: false, error: "不是忽略记录文件", added: 0, skipped: 0, invalid: 0, fileVersion: 0 };
      var st = ignoreStore();
      var added = 0, skipped = 0, invalid = 0;
      // 版本握手（用户 2026-10-30 审计定稿）：v1 = 当前结构，字段见 exportJSON。
      // 更高版本不拒绝也不猜 —— 只按已知字段重建（多余字段本来就不透传），
      // 把版本号带回去让管理页提示一句「文件比插件新」。
      var fileVersion = Number(o.version) || 1;
      ["scenes", "performers"].forEach(function (kind) {
        var src = o[kind];
        if (!src || typeof src !== "object") return;
        Object.keys(src).forEach(function (k) {
          if (k.indexOf(":") < 1) { invalid++; return; }   // 键必须是 endpoint:id
          if (st[kind][k]) { skipped++; return; }
          var v = src[k];
          if (!v || typeof v !== "object") { invalid++; return; }
          // 只按快照结构重建：文件里多出来的字段一律不透传
          var rec = { at: Number(v.at) || 0 };
          if (kind === "scenes") {
            rec.title = ignClip(v.title, IGN_TEXT_CAP.title);
            rec.code = ignClip(v.code, IGN_TEXT_CAP.code);
            rec.date = ignClip(v.date, IGN_TEXT_CAP.date);
            rec.studio = ignClip(v.studio, IGN_TEXT_CAP.studio);
            rec.cover = String(v.cover || "");
            rec.p = Array.isArray(v.p)
              ? v.p.slice(0, IGNORE_SNAPSHOT_P).map(function (x) { return ignClip(x, IGN_TEXT_CAP.alias); })
                  .filter(function (x) { return !!x; })
              : [];
          } else {
            rec.name = ignClip(v.name, IGN_TEXT_CAP.name);
            rec.image = String(v.image || "");
            var als = ignClipList(v.alias_list, 12, IGN_TEXT_CAP.alias);
            if (als && als.length) rec.alias_list = als;
            // 卡片用的零开销标签，导入时一并带过来（老文件没有这些字段，跳过）
            if (v.country) rec.country = String(v.country).slice(0, 4);
            if (v.birthdate) rec.birthdate = String(v.birthdate).slice(0, 10);
            if (v.gender) rec.gender = String(v.gender).slice(0, 24);
          }
          st[kind][k] = rec;
          added++;
        });
      });
      var w = ignoreWrite();
      return { ok: w.ok, added: added, skipped: skipped, invalid: invalid,
               fileVersion: fileVersion, dropped: w.dropped || 0,
               error: w.ok ? "" : "浏览器存储写不进去（可能已满）" };
    },
    // 存储被外部改动（另一个页面 / 手动清过）后重新读盘
    reload: function () { _ignoreMemo = null; return ignoreStore(); },
  };

  // ─── 入库字段开关（§C6）：全局键 SSD:dp:import.v1 ─────────────────────────
  // 全局键的理由同忽略记录：带 host 前缀的键会被 cacheInvalidate 一刷新清空，
  // 而这是用户手动配的默认值，不该跟着缓存走。
  // 只存「默认值」—— 弹窗里临时改的勾选不写回设置（Q15），否则一次勾错就变成
  // 永久默认，用户找不到原因。
  var DP_IMPORT_KEY = "SSD:dp:import.v1";
  // performers 不在这个布尔列表里：它改成三态（全写 / 只关联已有 / 不写），
  // 与 tags、studio 同一套存储（用户 2026-10-29）。
  var IMPORT_SCENE_KEYS = ["title", "date", "details", "director", "cover",
                           "urlsWeb", "urlsSrc"];
  // 12 个可映射字段 + aliases + urls + image（演员 tags 不做 —— 这几个源本来
  // 就没有演员标签，写进去必然是空，C1）
  var IMPORT_PERF_KEYS = ["gender", "birthdate", "death_date", "country", "ethnicity",
                          "hair_color", "eye_color", "height_cm", "measurements",
                          "career_length", "tattoos", "piercings", "aliases", "urls", "image"];
  var _importMemo = null;

  function importDefaults() {
    var scene = {}, perf = {};
    IMPORT_SCENE_KEYS.forEach(function (k) { scene[k] = true; });
    scene.tags = "all";      // 三态：all / existing / none
    scene.studio = "all";
    // 演员三态（用户 2026-10-29）：原来只有「写/不写」，想「只关联库里已有的、
    // 不要新建」时只能整段跳过 —— 而重名误建正是最常被抱怨的那点
    scene.performers = "all";
    IMPORT_PERF_KEYS.forEach(function (k) { perf[k] = true; });
    return { scene: scene, performer: perf };
  }

  function importStore() {
    if (_importMemo) return _importMemo;
    var st = importDefaults();
    try {
      var raw = localStorage.getItem(DP_IMPORT_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === "object") {
        IMPORT_SCENE_KEYS.forEach(function (k) {
          if (o.scene && typeof o.scene[k] === "boolean") st.scene[k] = o.scene[k];
        });
        ["tags", "studio"].forEach(function (k) {
          var v = o.scene && o.scene[k];
          if (v === "all" || v === "existing" || v === "none") st.scene[k] = v;
        });
        // 老版本 performers 是布尔：true → 全写，false → 不写（迁移一次即可）
        var pv = o.scene && o.scene.performers;
        if (pv === true) st.scene.performers = "all";
        else if (pv === false) st.scene.performers = "none";
        else if (pv === "all" || pv === "existing" || pv === "none") st.scene.performers = pv;
        IMPORT_PERF_KEYS.forEach(function (k) {
          if (o.performer && typeof o.performer[k] === "boolean") st.performer[k] = o.performer[k];
        });
      }
    } catch (e) {
      console.warn("[SSD] import prefs unreadable:", (e && e.message) || e);
    }
    _importMemo = st;
    return st;
  }

  function importWrite() {
    try {
      localStorage.setItem(DP_IMPORT_KEY, JSON.stringify(importStore()));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.name) || String(e) };
    }
  }

  var dpImport = {
    defaults: importDefaults,
    scene: function () { return importStore().scene; },
    performer: function () { return importStore().performer; },
    sceneKeys: IMPORT_SCENE_KEYS,
    perfKeys: IMPORT_PERF_KEYS,
    get: function () { return importStore(); },
    // kind = "scene" | "performer"；patch 为 {字段: true/false/三态值}
    set: function (kind, patch) {
      var bag = importStore()[kind === "performer" ? "performer" : "scene"];
      Object.keys(patch || {}).forEach(function (k) { bag[k] = patch[k]; });
      return importWrite();
    },
    reset: function (kind) {
      var d = importDefaults();
      if (kind === "performer") importStore().performer = d.performer;
      else importStore().scene = d.scene;
      return importWrite();
    },
    reload: function () { _importMemo = null; return importStore(); },
  };

  // ─── 轻量 toast（§5.2 撤销）─────────────────────────────────────────────
  // 只有一处用途也要有：忽略是"一按就消失"的操作，没有撤销入口等于误触即丢。
  var _toastEl = null, _toastTimer = 0;
  function dpToast(text, opts) {
    opts = opts || {};
    try {
      if (_toastEl) { _toastEl.remove(); _toastEl = null; }
      clearTimeout(_toastTimer);
      var t = document.createElement("div");
      t.className = "ssd-toast";
      var span = document.createElement("span");
      span.className = "ssd-toast-text";
      // 汇总类提示只需要三个符号，用 innerHTML 才能上色；其余一律 textContent
      // （用户输入 / 源站标题都可能带尖括号，不拼进 HTML）
      if (opts.html) span.innerHTML = opts.html;
      else span.textContent = text;
      t.appendChild(span);
      function close() {
        clearTimeout(_toastTimer);
        if (_toastEl === t) _toastEl = null;
        if (t.isConnected) t.remove();
      }
      if (opts.title) span.title = opts.title;
      if (opts.actionText && typeof opts.onAction === "function") {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "ssd-toast-act";
        b.textContent = opts.actionText;
        b.onclick = function () { close(); opts.onAction(); };
        t.appendChild(b);
      }
      document.body.appendChild(t);
      _toastEl = t;
      requestAnimationFrame(function () { if (t.isConnected) t.classList.add("show"); });
      _toastTimer = setTimeout(close, opts.duration || 4000);
      return close;
    } catch (_) { return function () {}; }
  }

  // 入库汇总：三个圆形符号 + 数字（用户 2026-10-29）。原来拼的是
  // 「成功 10 · 跳过 1 · 失败 1 · 新建演员 8 位」，一句话四个数字，读完还得
  // 自己判断要不要重试；现在一眼看颜色就知道，失败项本来就留在选择集里。
  // 三项都显示（含 0）：固定宽度，绝不因为「这次没有失败」而变短变长。
  function importSummaryHtml(ok, skip, failed) {
    function cell(cls, mark, n) {
      return '<span class="ssd-sum ' + cls + '"><i>' + mark + "</i>" + (n || 0) + "</span>";
    }
    return '<span class="ssd-sums">' +
      cell("ok", "✓", ok) + cell("skip", "!", skip) + cell("err", "✕", failed) +
      "</span>";
  }

  // ─── 返回键先关弹窗（论坛 p0rnb0x 2026-10-29 反馈）───────────────────────
  // 手机上按系统返回键时，Stash 的路由会把整个插件页退掉 —— 弹窗还开在上面就
  // 直接跳回进入插件页之前的页面，用户得重新找一遍入口。这里加一层垫片：
  //   打开弹窗 → 压一条**同 URL** 的 history 记录；
  //   返回键 → 退掉的是我们这条（pathname 没变，路由其实没动），在 popstate 里
  //            关掉最上层弹窗，页面留在原地；
  //   自己按 × 关 → 把这条记录 back 掉，否则用户以后要多按一次返回键才走得掉。
  // 只在能 pushState 成功时才登记（压不进去就退化成「只能用 × 关」，
  // 绝不劫持返回键）。
  var _backLayers = [];
  var _backSeq = 0;
  var _backEcho = 0;   // 我们自己发起 history.back() 时预期收到几次 popstate

  var modalBack = {
    hold: function (closeFn) {
      var layer = { id: ++_backSeq, close: closeFn, byBack: false };
      try {
        history.pushState({ ssdBack: layer.id }, "", location.href);
      } catch (e) {
        return 0;
      }
      _backLayers.push(layer);
      return layer.id;
    },
    // 弹窗在原地重建（如入库字段弹窗「全选」）时复用同一条垫层，但 close 是新的
    // 闭包 —— 不换掉的话返回键会去调已经拆掉的旧 overlay，表现成「垫层被吃掉、
    // 弹窗还开着」。rebind 只换回调，不动 history，所以不会多压一条记录。
    rebind: function (id, closeFn) {
      if (!id) return false;
      for (var k = _backLayers.length - 1; k >= 0; k--) {
        if (_backLayers[k].id === id) { _backLayers[k].close = closeFn; return true; }
      }
      return false;
    },
    release: function (id) {
      if (!id) return;
      var i = -1;
      for (var k = _backLayers.length - 1; k >= 0; k--) {
        if (_backLayers[k].id === id) { i = k; break; }
      }
      if (i === -1) return;
      var layer = _backLayers[i];
      _backLayers.splice(i, 1);
      if (layer.byBack) return;      // 这条已经被返回键退掉了
      _backEcho++;
      try { history.back(); } catch (e) { _backEcho--; }
    },
  };

  window.addEventListener("popstate", function () {
    if (_backEcho > 0) { _backEcho--; return; }
    if (!_backLayers.length) return;   // 不是我们压的条目 → 正常退页
    var layer = _backLayers[_backLayers.length - 1];
    layer.byBack = true;
    try { if (layer.close) layer.close(); } catch (e) { console.error("[SSD] close on back:", e); }
    var idx = _backLayers.indexOf(layer);
    if (idx !== -1) _backLayers.splice(idx, 1);   // close 没走 release 时的兜底
  });

  window.SSD = {
    version: PLUGIN_VERSION,
    // GraphQL
    callGQL: callGQL,
    // internal URL builder (respects sub-path deployments — see appUrl)
    appUrl: appUrl,
    callBoxGQL: callBoxGQL,
    // box 演员详情：弹层与入库共用一次请求（见 BOX_PERF_DETAIL_QUERY 处注释）
    boxPerfDetail: boxPerfDetail,
    // 两处「忽略」按钮共用的外观（场景详情弹窗 / 演员详情弹层）
    banButton: ssdBanButton,
    // TPDB REST fallback（列表接口故障）
    callBoxSceneList: callBoxSceneList,
    callBoxPerformerList: callBoxPerformerList,
    isTPDBBox: isTPDBBox,
    TPDB_MAX_PAGES_BATCH: TPDB_MAX_PAGES_BATCH,
    boxRateLimiter: _boxRateLimiter,
    // config
    getStashBoxes: getStashBoxes,
    getPluginSettings: getPluginSettings,
    // i18n / dates
    tc: tc,
    isZh: isZh,
    localDateStr: localDateStr,
    recentCutoffDate: recentCutoffDate,
    previewCutoffDate: previewCutoffDate,
    // boxes
    brandNameForEndpoint: brandNameForEndpoint,
    boxSceneUrl: boxSceneUrl,
    boxWebBase: boxWebBase,
    BOX_SCENE_FIELDS: BOX_SCENE_FIELDS,
    BOX_TIMEOUT_MS: BOX_TIMEOUT_MS,
    boxErrText: boxErrText,
    // rendering (buildSceneCard/isSceneOwned accept a ctx/keys override)
    buildSceneCard: buildSceneCard,
    buildSceneTable: buildSceneTable,
    layoutCardGrid: layoutCardGrid,
    openModal: openModal,
    isSceneOwned: isSceneOwned,
    // UI atoms
    makeChip: makeChip,
    makePanelBtn: makePanelBtn,
    panelIcon: panelIcon,
    panelDesc: panelDesc,
    panelNote: panelNote,
    buildSourceRow: buildSourceRow,
    // events
    SCENE_SAVED_EVENT: SCENE_SAVED_EVENT,
    // 图片失败负缓存（发现页刷新按钮清空：换节点 / 网络恢复后封面要能回来）
    clearAllImgFail: clearAllImgFail,
    // ignore records (§3) + undo toast
    dpIgnore: dpIgnore,
    toast: dpToast,
    // 批量入库结束的汇总（三个符号 + 数字），发现页与演员页 tab 共用
    importSummary: importSummaryHtml,
    // 入库字段开关（§C6）默认值 + 演员入库弹窗（discover.js 的演员弹层用）
    dpImport: dpImport,
    openImportPerformer: openPerformerImportDialog,
    // 演员批量入库（多选「入库」时用，不弹预览 —— 用户 2026-10-29）
    batchAddPerformers: batchAddPerformers,
    // 场景入库弹窗的提交半边（批次7 批量入库复用，不吃弹窗）
    planSceneImport: planSceneImport,
    submitSceneImport: submitSceneImport,
    pickFromPrefs: pickFromPrefs,
    // 贴顶环境（顶栏高度 / 页面底色）：发现页挂载时再量一次，防止插件脚本
    // 早于 Stash 顶栏就绪时量到 0
    syncStickyEnv: syncStickyEnv,
    // 搜索结果排序/折叠（纯本地计算，导出只为实测与回归）
    rankSearchResults: rankSearchResults,
    renderSearchResults: renderSearchResults,
    // follow polling (force = bypass the 6h throttle; used after favorites import)
    pollFollowed: dpPollFollowed,
    // 返回键先关弹窗（discover.js 的四个弹窗复用同一套垫片）
    modalBack: modalBack,
  };

  // ─── Discover nav entry + route shell (synchronous top-level registration) ─
  // The nav button and the /plugins/stashDiscover route MUST be registered in
  // the same wave as every other plugin's patches (synchronously at plugin-
  // script load, before React's first render — the pattern LockdownI18n and
  // stash-curator use). discover.js loads one settings-fetch later and would
  // lose that race intermittently, so the MAIN JS owns the registration and a
  // lightweight React shell; discover.js only supplies the page component via
  // window.SSD.discoverMount + the "ssd:discover-ready" event.
  // The enableDiscoverPage yml setting is cached in localStorage so this
  // synchronous decision matches the last known state; maybeLoadDiscover's
  // async fetch refreshes the cache and corrects within one load.
  var DISCOVER_CACHE_KEY = "SSD:discoverOn";

  function discoverCachedOn() {
    try { return localStorage.getItem(DISCOVER_CACHE_KEY) !== "0"; } catch (_) { return true; }
  }

  // ─── Follow polling (§6.4) ─────────────────────────────────────────────────
  // Opening Stash (any page) triggers one lightweight check, throttled to one
  // per 6h across sessions (poll.v1). It queries ONLY followed performers
  // (follow.v1, grouped one query per endpoint), counts unread new scenes with
  // the same performer×scene semantics as the discover page, then writes the
  // badge cache (unread.v1) and fires "ssd:unread-changed". The discover
  // page's full pipeline stays the source of truth — opening it re-syncs the
  // badge at zero extra cost. The poll deliberately skips library-ownership
  // filtering (heavy); the page corrects the number on next open.
  var DP_FOLLOW_KEY = "SSD:dp:follow.v1";
  var DP_READ_KEY = "SSD:dp:read.v1";
  var DP_POLL_KEY = "SSD:dp:poll.v1";
  var DP_UNREAD_KEY = "SSD:dp:unread.v1";
  var DP_NOTIFY_KEY = "SSD:dp:notify"; // "0" = muted (P6 settings UI writes it)
  var DP_PREFS_KEY = "SSD:dp:prefs"; // discover page prefs (active source lives here)
  var DP_POLL_MIN_MS = 6 * 3600 * 1000;

  function dpCachedUnread() {
    try {
      var o = JSON.parse(localStorage.getItem(DP_UNREAD_KEY) || "null");
      return (o && typeof o.n === "number") ? o.n : 0;
    } catch (_) { return 0; }
  }

  function dpWriteUnread(n) {
    try { localStorage.setItem(DP_UNREAD_KEY, JSON.stringify({ n: n, at: Date.now() })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("ssd:unread-changed", { detail: n })); } catch (_) {}
  }

  function notifyMuted() {
    try { return localStorage.getItem(DP_NOTIFY_KEY) === "0"; } catch (_) { return false; }
  }

  function dpPollFollowed(force) {
    var proceed = false;
    try {
      if (!discoverCachedOn()) return Promise.resolve(0);
      if (notifyMuted()) return Promise.resolve(0); // §6.4: muted → skip poll, hide badge
      var last = 0;
      try { last = ((JSON.parse(localStorage.getItem(DP_POLL_KEY) || "null") || {}).lastAt) || 0; } catch (_) {}
      proceed = force || !last || Date.now() - last >= DP_POLL_MIN_MS;
    } catch (_) {}
    if (!proceed) return Promise.resolve(dpCachedUnread());

    var follow = {};
    try { follow = JSON.parse(localStorage.getItem(DP_FOLLOW_KEY) || "{}") || {}; } catch (_) {}
    var list = (follow && follow.performers) || {};
    var ids = Object.keys(list);
    var stamp = function (n) {
      try { localStorage.setItem(DP_POLL_KEY, JSON.stringify({ lastAt: Date.now() })); } catch (_) {}
      dpWriteUnread(n);
      return n;
    };
    if (!ids.length) return Promise.resolve(stamp(0));

    return Promise.all([getStashBoxes(), getPluginSettings()]).then(function (res) {
      var boxes = res[0] || [];
      var settings = res[1] || {};
      // 角标属于发现页：窗口取发现页设置（SSD:dp:prefs），与发现页关注列表同口径；
      // 演员详情 tab 的长窗仍由插件设置 recentDays 驱动（用户 2026-10-26）。
      var prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(DP_PREFS_KEY) || "null") || {}; } catch (_) {}
      var recentDays = parseInt(prefs.recentDays, 10);
      if (isNaN(recentDays) || recentDays < 0) recentDays = 30; // 发现页默认短窗
      var cutoff = recentDays > 0 ? localDateStr(new Date(Date.now() - recentDays * 86400000)) : null;

      // 关注页是单源口径（只显示当前数据源的新作，用户 2026-10-25 第七轮），
      // 角标同样只统计当前数据源，避免「角标有未读、关注页却全是暂无新作品」。
      var wanted = String(prefs.source || "");
      if (!wanted) wanted = String(settings.preferredBox || "");
      wanted = wanted.toLowerCase();
      var byEndpoint = {};
      ids.forEach(function (k) {
        var f = list[k] || {};
        var ep = String(f.endpoint || "").toLowerCase();
        if (!ep) return;
        (byEndpoint[ep] = byEndpoint[ep] || []).push(String(f.stashId || k));
      });
      var boxByEp = {};
      boxes.forEach(function (b) {
        if (wanted && String(b.name).toLowerCase() !== wanted && String(b.endpoint).toLowerCase() !== wanted) return;
        boxByEp[String(b.endpoint).toLowerCase()] = b;
      });
      if (!Object.keys(boxByEp).length) boxes.forEach(function (b) { boxByEp[String(b.endpoint).toLowerCase()] = b; });

      // One query per endpoint, first 100 scenes — a light channel; the page's
      // full pipeline paginates properly and corrects the badge.
      return Promise.all(Object.keys(byEndpoint).map(function (ep) {
        var box = boxByEp[ep];
        if (!box) return Promise.resolve(null);
        return _boxRateLimiter.submit(function () {
          var input = {
            performers: { value: byEndpoint[ep], modifier: "INCLUDES" },
            sort: "DATE", direction: "DESC",
            page: 1, per_page: 100,
          };
          // 0 = 不限：不带日期过滤
          if (cutoff) input.date = { value: cutoff, modifier: "GREATER_THAN" };
          return callBoxSceneList(box, input);
        }).then(function (qs) {
          return { ep: ep, ids: byEndpoint[ep], scenes: (qs && qs.scenes) || [] };
        }).catch(function () { return null; }); // a failed box keeps its cached count next round
      }));
    }).then(function (results) {
      var marks = {};
      try { marks = ((JSON.parse(localStorage.getItem(DP_READ_KEY) || "null") || {}).marks) || {}; } catch (_) {}
      // 「预告也计入提醒」（默认关，用户 2026-10-27 语义反转）：关闭时预告场景
      // 不计入导航角标。旧 key skipPreviewNotify 兼容读 —— discover.js 挂载时
      // 会把旧值迁移成 notifyPreviewScenes，但本函数可能在它之前就跑。
      var skipPrev = true;
      try {
        var pf = JSON.parse(localStorage.getItem(DP_PREFS_KEY) || "null") || {};
        var prevNotify = pf.notifyPreviewScenes === true ||
          (pf.notifyPreviewScenes === undefined && pf.skipPreviewNotify === false);
        skipPrev = !prevNotify;
      } catch (_) {}
      var today = localDateStr(new Date());
      // 忽略记录（§5.1 第 2 处）：页面看不见了但红点还在数 = 最典型的"忽略了还提醒"
      var ignScenes = {}, ignPerfs = {};
      try {
        ignScenes = SSD.dpIgnore.scenes();
        ignPerfs = SSD.dpIgnore.performers();
      } catch (_) {}
      var n = 0;
      (results || []).forEach(function (r) {
        if (!r) return;
        var set = {};
        r.ids.forEach(function (id) { set[String(id)] = true; });
        (r.scenes || []).forEach(function (sc) {
          if (skipPrev && sc.release_date && sc.release_date > today) return;
          var sceneKey = r.ep + ":" + String(sc.id || "").toLowerCase();
          if (ignScenes[sceneKey]) return;
          if (marks[sceneKey]) return;
          ((sc.performers || [])).forEach(function (pf2) {
            var pid = pf2 && pf2.performer && pf2.performer.id;
            if (!pid || !set[String(pid)]) return;
            if (ignPerfs[r.ep + ":" + String(pid).toLowerCase()]) return;
            n++;
          });
        });
      });
      return stamp(n);
    }).catch(function (e) {
      console.warn("[SSD] follow poll failed:", e);
      return dpCachedUnread();
    });
  }

  (function registerDiscoverEntry() {
    if (!discoverCachedOn()) return;
    var Api = window.PluginApi;
    if (!Api || !Api.register || typeof Api.register.route !== "function" || !Api.React) return;
    var React = Api.React;
    var Nav = Api.libraries.Bootstrap.Nav;
    var NavLink = Api.libraries.ReactRouterDOM.NavLink;
    var FontAwesomeIcon = Api.libraries.ReactFontAwesome.FontAwesomeIcon;
    var FAS = Api.libraries.FontAwesomeSolid || {};

    // ── 原生「菜单项目」开关（用户 2026-10-30，照 binge 的做法）──────────────
    // Stash 的 MainNavbar 只渲染 interface.menuItems 里列出的**内置**项，插件项
    // 永远不会被它自己渲染。要做到「和内置项一样能被勾选」，必须两件事：
    //   1) patch CheckboxGroup，把 stashDiscover 塞进 groupId="menu-items"
    //      的 items —— 设置页于是出现一个和「短片 / 演员 / 标签」同款的原生开关；
    //   2) patch MainNavBar.MenuItems，自己读 menuItems 决定渲不渲染。
    // 用户视角和原生完全一致：勾掉只隐藏入口，直链 /plugins/stashDiscover 照样
    // 能打开（路由始终注册）。enableDiscoverPage 仍是「彻底停用」的总闸，优先
    // 级更高 —— 它在上面就 return 了，整个入口连注册都不会发生。
    var NAV_ID = "stashDiscover";
    // 首次 seed 完成后、Stash 的 configuration 查询还没刷新时的过渡位
    var forceNav = false;

    // CheckboxGroup 的 headingID 走 Stash 自己的 intl，插件 id 不在它的词典里，
    // 会原样回落到传入的字符串 —— 所以直接传当前语言的标签，中英各一份。
    function navHeading() { return tc("发现", "Discover"); }

    try {
      Api.patch.before("CheckboxGroup", function (props) {
        // 这段在 Stash 自己的 render 里跑，抛异常会把整个 UI 换成错误页，
        // 而且设置页跟着消失、无从恢复 → 出什么事都原样返回。
        try {
          if (!props || props.groupId !== "menu-items" || !Array.isArray(props.items)) return [props];
          var has = props.items.some(function (it) { return it && it.id === NAV_ID; });
          if (has) return [props];
          return [Object.assign({}, props, {
            items: props.items.concat([{ id: NAV_ID, headingID: navHeading() }]),
          })];
        } catch (e) {
          console.warn("[SSD] menu-items patch failed:", e);
          return [props];
        }
      });
    } catch (e) {
      console.warn("[SSD] CheckboxGroup patch unavailable:", e);
    }

    // 首次安装 seed 一次：新装的 Stash 不会把一个未知 id 放进 menuItems，不
    // seed 的话升级完入口直接消失，用户只会当成坏了。用插件配置里的 navSeeded
    // 记住「已经 seed 过」——之后再没勾上就是用户主动取消的，尊重它。
    //
    // 两个坑（binge 踩过，我们照抄）：
    //  · configurePlugin 是**整体替换** map 而不是合并，所以必须把读回来的
    //    配置整体带上；否则写一个 navSeeded 就把 jackettApiKey 之类全删了。
    //  · 这段在插件脚本加载时跑，不在 render 里 —— 用普通 fetch，别用 GQL hook。
    function seedNavOnce() {
      callGQL("query{configuration{interface{menuItems}plugins}}").then(function (data) {
        var cfg = (data && data.configuration) || {};
        var items = ((cfg.interface || {}).menuItems) || [];
        if (items.indexOf(NAV_ID) !== -1) return null;      // 已经在菜单里
        var mine = ((cfg.plugins || {})[NAV_ID]) || {};
        if (mine.navSeeded) return null;                    // 用户主动取消过
        return callGQL(
          "mutation($items:[String!]){configureInterface(input:{menuItems:$items}){menuItems}}",
          { items: items.concat([NAV_ID]) }
        ).then(function () {
          return callGQL(
            "mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
            { id: NAV_ID, input: Object.assign({}, mine, { navSeeded: true }) }
          );
        }).then(function () { forceNav = true; });
      }).catch(function (e) {
        // 非致命：最坏情况入口不显示，用户还能在设置里手动勾上
        console.warn("[SSD] nav seed failed:", e);
      });
    }

    try { seedNavOnce(); } catch (e) { console.warn("[SSD] nav seed skipped:", e); }

    // 入口是否显示：以 Stash 的 menuItems 为准（和内置项同一判据）。读不到
    // 配置时一律当「显示」—— 绝不让入口因为一次读取失败而静默消失。
    // 注意 hook 必须在 try 之外按稳定顺序调用：它是在 Stash 自己的 render 帧里
    // 跑的，调用与否变了就是 hook 数量变化，直接崩。
    function navEnabled() {
      var hook = Api.GQL && Api.GQL.useConfigurationQuery;
      if (typeof hook !== "function") return true;   // 老版本没有这个 hook
      var data;
      try { data = hook().data; } catch (e) { return true; }
      var items = data && data.configuration && data.configuration.interface &&
        data.configuration.interface.menuItems;
      if (!items) return true;                        // 配置还没到手
      return items.indexOf(NAV_ID) !== -1 || forceNav;
    }

    // faSatelliteDish inline fallback, path from FA6 solid/satellite-dish.svg
    var SATELLITE_SVG =
      '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" style="width:1em;height:1em;display:inline-block;vertical-align:-0.125em">' +
      '<path d="M192 32c0-17.7 14.3-32 32-32C383.1 0 512 128.9 512 288c0 17.7-14.3 32-32 32s-32-14.3-32-32C448 164.3 347.7 64 224 64c-17.7 0-32-14.3-32-32zM60.6 220.6L164.7 324.7l28.4-28.4c-.7-2.6-1.1-5.4-1.1-8.3c0-17.7 14.3-32 32-32s32 14.3 32 32s-14.3 32-32 32c-2.9 0-5.6-.4-8.3-1.1l-28.4 28.4L291.4 451.4c14.5 14.5 11.8 38.8-7.3 46.3C260.5 506.9 234.9 512 208 512C93.1 512 0 418.9 0 304c0-26.9 5.1-52.5 14.4-76.1c7.5-19 31.8-21.8 46.3-7.3zM224 96c106 0 192 86 192 192c0 17.7-14.3 32-32 32s-32-14.3-32-32c0-70.7-57.3-128-128-128c-17.7 0-32-14.3-32-32s14.3-32 32-32z"/></svg>';

    var _navUnread = dpCachedUnread(); // §10: restore the badge from the poll cache on hard refresh

    function navIcon(className) {
      if (FAS.faSatelliteDish) {
        return React.createElement(FontAwesomeIcon, { icon: FAS.faSatelliteDish, className: className });
      }
      return React.createElement("span", {
        className: "fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0",
        dangerouslySetInnerHTML: { __html: SATELLITE_SVG },
      });
    }

    // Nav item with unread badge; hides itself on "ssd:discover-disabled"
    // (stale localStorage cache said on, settings fetch corrected to off);
    // re-renders on "ssd:locale-changed" (first paint may precede locale init)
    // and "ssd:notify-changed" (§6.4 mute toggle hides the badge instantly).
    function DiscoverNavItem() {
      var s = React.useState(_navUnread);
      var lc = React.useState(0); // bump to re-render after locale/mute init
      React.useEffect(function () {
        var h = function (e) { _navUnread = (e && e.detail) || 0; s[1](_navUnread); };
        var off = function () { s[1](-1); };
        var loc = function () { lc[1](function (v) { return v + 1; }); }; // functional bump: the closure's lc[0] goes stale after the first fire
        window.addEventListener("ssd:unread-changed", h);
        window.addEventListener("ssd:discover-disabled", off);
        window.addEventListener("ssd:locale-changed", loc);
        window.addEventListener("ssd:notify-changed", loc);
        return function () {
          window.removeEventListener("ssd:unread-changed", h);
          window.removeEventListener("ssd:discover-disabled", off);
          window.removeEventListener("ssd:locale-changed", loc);
          window.removeEventListener("ssd:notify-changed", loc);
        };
      }, []);
      var unread = s[0];
      if (unread < 0) return null; // disabled mid-session
      var muted = notifyMuted();
      var showBadge = unread > 0 && !muted;
      var to = "/plugins/stashDiscover" + (showBadge ? "?view=follow" : "");
      return React.createElement(
        Nav.Link,
        { as: "div", eventKey: "/plugins/stashDiscover", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
        React.createElement(
          NavLink,
          {
            exact: true,
            to: to,
            activeClassName: "active",
            className: "btn minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center ssd-nav-item",
          },
          navIcon("fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0"),
          React.createElement("span", null, tc("发现", "Discover")),
          showBadge
            ? React.createElement("span", { className: "ssd-nav-badge" }, unread > 99 ? "99+" : String(unread))
            : null
        )
      );
    }

    // Route shell: renders the real page from window.SSD.discoverMount once
    // discover.js signals ready; loading dots before that; a note if the
    // setting turned out to be off. Readiness has TWO channels: the
    // "ssd:discover-ready" event (fast path) and a direct flag poll (safety
    // net) — React runs passive effects after commit, so on a hard refresh
    // the event can fire in that gap, before the listener attaches, and the
    // shell would wait forever. The poll also degrades to an error + retry
    // if the module never arrives (~30s) and keeps watching, so a retry
    // that lands still flips the page.
    function DiscoverRouteShell() {
      var s = React.useState(SSD.discoverMount ? 1 : 0);
      var att = React.useState(0); // retry counter: re-arms the poll
      React.useEffect(function () {
        var ready = function () { s[1](SSD.discoverMount ? 1 : 0); };
        var off = function () { s[1](-1); };
        window.addEventListener("ssd:discover-ready", ready);
        window.addEventListener("ssd:discover-disabled", off);
        var ticks = 0;
        var poll = setInterval(function () {
          if (SSD.discoverMount) { s[1](1); return; }
          // 30s（150 × 200ms）才判定失败。原来是 20s：TPDB 五十多批的场景下
          // Stash 本身很吃紧，discover.js 动态注入超过 20s 才 ready 是常事，
          // 于是停在「模块加载失败」，用户刷新一次就好了（论坛反馈 2026-10-29）。
          // 只等这一次，不做「30s 后再等 60s」的二次加长。
          if (++ticks > 150) s[1](function (v) { return v === -1 ? v : -2; }); // never downgrade the "disabled" note
        }, 200);
        return function () {
          clearInterval(poll);
          window.removeEventListener("ssd:discover-ready", ready);
          window.removeEventListener("ssd:discover-disabled", off);
        };
      }, [att[0]]);
      var st = s[0];
      if (st < 0) {
        if (st === -2 && !SSD.discoverMount) {
          var retry = function () { s[1](0); att[1](function (v) { return v + 1; }); injectDiscoverScript(true); };
          return React.createElement(
            "div",
            { className: "ssd-dp-page" },
            React.createElement(
              "div",
              { className: "ssd-dp-state" },
              tc("发现页模块 30 秒内没有加载完成，重试通常就好了。", "The Discover page module did not load within 30 seconds — retrying usually fixes it."),
              React.createElement("button", { className: "ssd-dp-retry", onClick: retry }, tc("重试", "Retry"))
            )
          );
        }
        return React.createElement(
          "div",
          { className: "ssd-dp-page" },
          React.createElement("div", { className: "ssd-dp-state" }, tc("发现页已在设置中关闭，刷新浏览器后入口不再显示。", "The Discover page is disabled in settings; the entry disappears after a browser refresh."))
        );
      }
      if (st === 0 || !SSD.discoverMount) {
        return React.createElement(
          "div",
          { className: "ssd-dp-page" },
          React.createElement("div", {
            className: "ssd-dp-state",
            dangerouslySetInnerHTML: {
              __html: '<span class="ssd-dp-loading-dots"><i></i><i></i><i></i></span>',
            },
          })
        );
      }
      return React.createElement(SSD.discoverMount);
    }

    try {
      // before-hook 合并进 props.children（binge 的做法）：after-hook 只能改已经
      // 渲染出来的结果，遇到同样在 after 上重建 children 的插件会互相覆盖。
      // 这个回调跑在 Stash 顶层 error boundary 之下，抛异常 = 整站白屏，
      // 所以内部全部 try/catch，任何失败都原样返回。
      Api.patch.before("MainNavBar.MenuItems", function (props) {
        try {
          if (!props) return [props];
          if (!navEnabled()) return [props];
          var children = React.Children.toArray(props.children);
          var has = children.some(function (c) { return c && c.type === DiscoverNavItem; });
          if (has) return [props];
          children.push(React.createElement(DiscoverNavItem, { key: "ssd-discover" }));
          return [Object.assign({}, props, { children: children })];
        } catch (e) {
          console.warn("[SSD] nav patch failed:", e);
          return [props];
        }
      });
      Api.register.route("/plugins/stashDiscover", DiscoverRouteShell);
    } catch (e) {
      console.warn("[SSD] discover entry registration failed:", e);
    }
  })();

  // ─── Discover page: switch-gated dynamic load ────────────────────────────
  // discover.js is injected ONLY when the enableDiscoverPage setting is on, so
  // a disabled install pays nothing for it: no script parse, no page code, no
  // queries. The nav entry + route shell above are registered synchronously
  // from the localStorage cache (fast path); the async settings fetch below
  // refreshes the cache and corrects within one load. URL note: Stash only
  // serves plugin files declared in yml ui.* — discover.js goes through the
  // ui.assets root mapping at /plugin/{id}/assets/discover.js with the
  // correct JS MIME type (tagMerge/oStats precedent).
  var _discoverInjected = false;

  function injectDiscoverScript(force) {
    if (_discoverInjected && !force) return;
    _discoverInjected = true;
    var s = document.createElement("script");
    // assets 端点不带缓存头（/javascript、/css 端点是 no-cache+ETag，每次刷新
    // 都会 revalidate），无版本参数的 URL 会被浏览器启发式缓存——插件更新后
    // 用户看到的还是旧 discover.js（2026-10-25 实测踩坑）。时间戳参数强制
    // 每次文档加载都拉新，与 ui.* 文件的 no-cache 语义对齐。
    s.src = appUrl("/plugin/" + PLUGIN_ID + "/assets/discover.js?t=" + Date.now());
    s.onerror = function () {
      console.warn("[SSD] discover.js failed to load — check the plugin directory");
    };
    document.head.appendChild(s);
  }

  function maybeLoadDiscover() {
    var cachedOn = discoverCachedOn();
    if (cachedOn) injectDiscoverScript(); // immediate: lands in the early script wave
    getPluginSettings().then(function (settings) {
      var on = settings && settings.enableDiscoverPage;
      // Stash only records plugin settings the user has touched: a fresh
      // install (or a never-touched switch) has no entry at all, and the yml
      // default is true — treat missing as ON, matching "On by default".
      if (on === undefined || on === null) on = true;
      if (on === "true") on = true;   // defensive: some Stash versions map booleans to strings
      if (on === "false") on = false;
      try { localStorage.setItem(DISCOVER_CACHE_KEY, on ? "1" : "0"); } catch (_) {}
      if (on) {
        if (!cachedOn) injectDiscoverScript(); // cache was stale-off; entry shows after next reload
      } else if (cachedOn) {
        // cache said on but the switch is off: hide the already-registered
        // entry now; next load skips registration entirely.
        window.dispatchEvent(new CustomEvent("ssd:discover-disabled"));
      }
    }).catch(function (e) {
      console.warn("[SSD] discover setting check failed:", e);
    });
  }

  // ─── 贴顶所需的环境值（§P6 / 用户 2026-10-29）────────────────────────────
  // 桌面端 Stash 顶栏是 position:fixed、z-index 1030，贴在屏幕顶部（实测
  // 48.75px）——sticky 用 top:0 会被它整个盖住，所以要把它的高度写进
  // --ssd-stick-top。
  //
  // 但移动端这个 fixed 顶栏贴在屏幕**底部**（390×844 实测：top 759 / 高 85，
  // 底部导航条），顶部根本没有遮挡物，算上它就是凭空空出一大截（用户
  // 2026-10-30「移动端会距离顶部空出一节」）。所以判据不是「fixed 就加」，
  // 而是「fixed 且在屏幕顶部」才加 —— 用 rect.top 判断，横竖屏 / 旋转 / 缩放
  // 都自动跟着变，不需要写媒体查询。
  //
  // 底色不在这里管：原生 `.filtered-list-toolbar` 自带 background-color，按主题
  // 编译进 CSS（Dark rgb(32,43,51) / Light 另一份同值产物），盖上去反而会在切
  // 主题后停在旧色（用户 2026-10-30 指出）。
  function syncStickyEnv() {
    var nav = document.querySelector("nav.top-nav") || document.querySelector("nav.navbar");
    if (!nav) return;
    var r = nav.getBoundingClientRect();
    // 高度 0 = 脚本比 SPA 先就绪，还没布局。这时不要写，免得把上次量到的
    // 真实值盖成 0。
    if (!r.height) return;
    var pinnedTop = getComputedStyle(nav).position !== "static" && r.top <= 8;
    document.documentElement.style.setProperty(
      "--ssd-stick-top", (pinnedTop ? Math.round(r.height) : 0) + "px");
  }

  function initPlugin() {
    console.log("[SSD] stashDiscover v" + PLUGIN_VERSION + " loaded");
    syncStickyEnv();
    // 顶栏是 SPA 挂载的，首次可能还不在 DOM 里 → 隔几拍再量两次
    [400, 1200, 3000].forEach(function (t) { setTimeout(syncStickyEnv, t); });
    setupObservers();
    var _resizeTimer = null;
    window.addEventListener("resize", function () {
      syncStickyEnv();
      clearTimeout(_resizeTimer);
      _resizeTimer = setTimeout(layoutCardGrid, 150);
    });
    // 横竖屏切换时 Stash 把导航栏从底部挪到顶部（或反过来），resize 不一定
    // 每次都跟着来，单独再量一次
    window.addEventListener("orientationchange", function () {
      setTimeout(syncStickyEnv, 250);
    });
    if (isPerformerPage()) {
      setTimeout(ensureTabInjected, 300);
      setTimeout(ensureTabInjected, 1000);
    }
    maybeLoadDiscover();
    dpPollFollowed(); // §6.4: follow-up check on Stash open, 6h-throttled inside
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlugin);
  } else {
    initPlugin();
  }
})();
