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

  var PLUGIN_VERSION = "1.5.5";

  var STASHDB_ENDPOINT = "https://stashdb.org/graphql";
  var JAVSTASH_ENDPOINT = "https://javstash.org/graphql";
  var JAVSTASH_WEB = "https://javstash.org";

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
  var _imgRateLimiter = createRateLimiter(2, 300);  // Image fills: 2 concurrent, 300ms spacing (each mutation triggers a server-side javstash.org download)

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
        "query($filter: FindFilterType!) { findScenes(filter: $filter) { count scenes { id title code performers { id name alias_list urls image_path stash_ids { endpoint stash_id } gender birthdate death_date country ethnicity hair_color eye_color height_cm measurements career_length tattoos piercings } stash_ids { endpoint stash_id } } } }",
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
      "query($id: ID!) { findScene(id: $id) { id title code performers { as performer { id name disambiguation aliases urls { url } images { url } gender birth_date death_date height cup_size band_size waist_size hip_size hair_color eye_color ethnicity country career_start_year career_end_year tattoos { location description } piercings { location description } } } } }",
      { id: sceneId }
    ).then(function (data) { return data.findScene; });
  }

  function searchJavstashPerformers(endpoint, apiKey, term) {
    return callJavstashGQL(endpoint, apiKey,
      "query($term: String!) { searchPerformer(term: $term) { id name disambiguation aliases deleted urls { url } birth_date death_date career_start_year career_end_year height cup_size band_size waist_size hip_size gender hair_color eye_color ethnicity country tattoos { location description } piercings { location description } images { url } } }",
      { term: term }
    ).then(function (data) { return data.searchPerformer || []; });
  }

  function fetchAllLocalPerformers() {
    var PAGE_SIZE = 1000;
    var all = [];
    var page = 1;
    function fetchPage() {
      return callGQL(
        "query($filter: FindFilterType!) { findPerformers(filter: $filter) { count performers { id name disambiguation alias_list birthdate death_date urls height_cm measurements country ethnicity hair_color eye_color career_length tattoos piercings gender image_path stash_ids { endpoint stash_id } } } }",
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

  function updatePerformer(id, stashIds, aliasArray, urls, details) {
    var input = { id: id, stash_ids: stashIds, alias_list: aliasArray };
    if (urls) input.urls = urls;
    if (details) {
      Object.keys(details).forEach(function (k) { input[k] = details[k]; });
    }
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

  // ==================== Name Similarity ====================

  // Iterative Levenshtein DP (two rolling rows); names are short so O(n*m) is fine.
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[b.length];
  }

  // Loose normalization for similarity: NFC lowercase, drop parentheticals and
  // punctuation, collapse whitespace. Spaces are KEPT so latin word order can
  // be handled by token sorting ("Yui Hatano" vs "Hatano Yui").
  function normalizeNameLoose(name) {
    if (!name) return "";
    var s = name.normalize("NFC").toLowerCase().trim();
    s = s.replace(/[（(].*?[)）]/g, "");
    s = s.replace(/[・·.,'"’`\-–—_]/g, " ");
    return s.replace(/\s+/g, " ").trim();
  }

  // Similarity in [0,1]: max of direct ratio (spaces stripped) and
  // token-sorted ratio (word order insensitive). Both compare full strings.
  function nameSimilarity(a, b) {
    var la = normalizeNameLoose(a);
    var lb = normalizeNameLoose(b);
    if (!la || !lb) return 0;
    var sa = la.replace(/ /g, "");
    var sb = lb.replace(/ /g, "");
    if (!sa || !sb) return 0;
    if (sa === sb) return 1;
    var direct = 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length);
    var ta = la.split(" ").sort().join("");
    var tb = lb.split(" ").sort().join("");
    if (ta === tb) return 1;
    var sorted = 1 - levenshtein(ta, tb) / Math.max(ta.length, tb.length);
    return Math.max(direct, sorted);
  }

  // Best similarity across main name + aliases on BOTH sides, so
  // "Moe Amatsuka" (local main) vs "天使もえ" alias list still scores.
  function performerNameSimilarity(localPerf, jsPerf) {
    var locals = [localPerf.name].concat(parseAliasList(localPerf.alias_list));
    var jss = [jsPerf.name].concat(jsPerf.aliases || []);
    var best = 0;
    for (var i = 0; i < locals.length; i++) {
      if (!locals[i]) continue;
      for (var j = 0; j < jss.length; j++) {
        if (!jss[j]) continue;
        var s = nameSimilarity(locals[i], jss[j]);
        if (s > best) best = s;
      }
    }
    return best;
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
  // opts.fuzzy — Autofill-style rating: name similarity only, evidence signals
  // (URL/stashdb/birthday) are ignored. sim>=0.9 -> high, 0.7-0.9 -> medium.
  // Confidence rules (evidence mode, agreed):
  //   stashdb UUID cross-ref equal           -> high (hard evidence)
  //   URL intersection >= 2                  -> high (1 may be a studio site)
  //   >=3 names exact-matched                -> high
  //   exactly 2 local names, both matched,
  //     at least one long (norm >=3 chars)   -> high (short-name collision guard)
  //   name match + full birthdate equal      -> high
  //   sim >= 0.9 + full birthdate equal      -> high (fuzzy name, hard bday)
  //   name match + birth year equal          -> medium
  //   sim >= 0.9 (exact-ish name, no other evidence) -> medium (review)
  //   sim 0.7-0.9 (latin variant/word order) -> medium (review)
  //   2 of >=3 names matched                 -> medium
  //   deleted performer capped at medium
  function evaluateCandidate(localPerf, jsPerf, terms, opts) {
    var fuzzy = !!(opts && opts.fuzzy);
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

    var sim = performerNameSimilarity(localPerf, jsPerf);

    var v = votes.length;
    var total = terms.length;

    var confidence = null;
    if (fuzzy) {
      // Pure name-similarity rating (Autofill architecture): evidence ignored.
      if (sim >= 0.9) confidence = "high";
      else if (sim >= 0.7) confidence = "medium";
    } else {
      if (stashdbMatch) confidence = "high";
      else if (urlIntersect >= 2) confidence = "high";
      else if (v >= 3) confidence = "high";
      else if (total === 2 && v === 2 && hasLongVote) confidence = "high";
      else if (v >= 1 && bdayFull) confidence = "high";
      else if (sim >= 0.9 && bdayFull) confidence = "high";
      else if (v >= 1 && bdayYear) confidence = "medium";
      else if (sim >= 0.9) confidence = "medium";
      else if (sim >= 0.7) confidence = "medium";
      else if (v === 2) confidence = "medium";
    }
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
      sim: Math.round(sim * 100) / 100,
    };
  }

  // ==================== Apply ====================

  var _appliedPerformers = {}; // track local performer IDs already applied

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

  // Build performer detail fields to fill: only fields the local performer lacks.
  // Existing values are never overwritten; aliases/urls stay incremental elsewhere.
  function buildPerfDetails(localPerf, jsPerf) {
    function empty(v) { return v === undefined || v === null || v === ""; }
    var d = {};
    if (empty(localPerf.gender) && !empty(jsPerf.gender)) d.gender = jsPerf.gender;
    if (empty(localPerf.birthdate) && !empty(jsPerf.birth_date)) d.birthdate = jsPerf.birth_date;
    if (empty(localPerf.death_date) && !empty(jsPerf.death_date)) d.death_date = jsPerf.death_date;
    if (empty(localPerf.country) && !empty(jsPerf.country)) d.country = jsPerf.country;
    if (empty(localPerf.ethnicity) && !empty(jsPerf.ethnicity)) d.ethnicity = enumToDisplay(jsPerf.ethnicity);
    if (empty(localPerf.hair_color) && !empty(jsPerf.hair_color)) d.hair_color = enumToDisplay(jsPerf.hair_color);
    if (empty(localPerf.eye_color) && !empty(jsPerf.eye_color)) d.eye_color = enumToDisplay(jsPerf.eye_color);
    if (empty(localPerf.height_cm) && !empty(jsPerf.height)) d.height_cm = jsPerf.height;
    if (empty(localPerf.measurements) && (!empty(jsPerf.band_size) || !empty(jsPerf.cup_size) || !empty(jsPerf.waist_size) || !empty(jsPerf.hip_size))) {
      var parts = [];
      var bust = (jsPerf.band_size || "") + (jsPerf.cup_size || "");
      if (bust) parts.push(bust);
      if (!empty(jsPerf.waist_size)) parts.push(jsPerf.waist_size);
      if (!empty(jsPerf.hip_size)) parts.push(jsPerf.hip_size);
      if (parts.length) d.measurements = parts.join("-");
    }
    if (empty(localPerf.career_length) && (!empty(jsPerf.career_start_year) || !empty(jsPerf.career_end_year))) {
      if (!empty(jsPerf.career_start_year) && !empty(jsPerf.career_end_year)) {
        d.career_length = jsPerf.career_start_year + " - " + jsPerf.career_end_year;
      } else {
        d.career_length = String(jsPerf.career_start_year || jsPerf.career_end_year);
      }
    }
    if (empty(localPerf.tattoos) && jsPerf.tattoos && jsPerf.tattoos.length) d.tattoos = modsToString(jsPerf.tattoos);
    if (empty(localPerf.piercings) && jsPerf.piercings && jsPerf.piercings.length) d.piercings = modsToString(jsPerf.piercings);
    return d;
  }

  // Log which detail fields were filled, labels follow current locale
  function logPerfDetailsFilled(name, details) {
    var keys = Object.keys(details);
    if (!keys.length) return;
    var labels = {
      gender: tc("性别", "Gender"),
      birthdate: tc("生日", "Birthdate"),
      death_date: tc("卒日", "Death date"),
      country: tc("国家", "Country"),
      ethnicity: tc("人种", "Ethnicity"),
      hair_color: tc("发色", "Hair color"),
      eye_color: tc("瞳色", "Eye color"),
      height_cm: tc("身高", "Height"),
      measurements: tc("三围", "Measurements"),
      career_length: tc("生涯", "Career"),
      tattoos: tc("纹身", "Tattoos"),
      piercings: tc("穿孔", "Piercings"),
    };
    var sep = _intlLocale.indexOf("zh") === 0 ? "、" : ", ";
    var list = keys.map(function (k) { return labels[k] || k; }).join(sep);
    addLog(tc("已补充演员信息（", "Filled performer info (") + list + tc("）：", "): ") + name);
  }

  // Stash-box cross links (stashdb.org / theporndb.net performer URLs) never merge into
  // local urls. Only URLs whose host is exactly one of those sites (www. allowed) count —
  // UUID-form links convert to stash_ids for the matching endpoint, ThePornDB slug links
  // (unresolvable by their API) are dropped. Everything else, including URLs merely
  // embedding such a link in a query param or on a lookalike domain, is left alone.
  var _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var _CROSS_SITE_RE = /^https?:\/\/([^\/?#]+)\/performers\/([^\/?#]+)/i;
  var _CROSS_SITE_HOSTS = {
    "stashdb.org": "stashdb.org",
    "www.stashdb.org": "stashdb.org",
    "theporndb.net": "theporndb.net",
    "www.theporndb.net": "theporndb.net",
  };

  function crossSitePerformerRef(urlStr) {
    var m = (urlStr || "").match(_CROSS_SITE_RE);
    if (!m) return null;
    var site = _CROSS_SITE_HOSTS[m[1].toLowerCase()];
    if (!site) return null;
    return {
      endpoint: "https://" + site + "/graphql",
      id: _UUID_RE.test(m[2]) ? m[2] : null,
    };
  }

  function endpointDisplayName(ep) {
    if (ep.indexOf("stashdb.org") !== -1) return "StashDB";
    if (ep.indexOf("theporndb.net") !== -1) return "ThePornDB";
    return ep;
  }

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

    // Merge URLs (dedup); stash-box cross links (stashdb/theporndb) become stash_ids
    var existingUrls = localPerformer.urls || [];
    var newUrls = existingUrls.slice();
    var haveEndpoints = {};
    newStashIds.forEach(function (s) { haveEndpoints[s.endpoint] = true; });
    var crossAdded = [];
    (jsPerf.urls || []).forEach(function (u) {
      var urlStr = typeof u === "string" ? u : (u && u.url) || "";
      if (!urlStr) return;
      var ref = crossSitePerformerRef(urlStr);
      if (ref) {
        if (ref.id && !haveEndpoints[ref.endpoint]) {
          newStashIds.push({ endpoint: ref.endpoint, stash_id: ref.id });
          haveEndpoints[ref.endpoint] = true;
          crossAdded.push(ref.endpoint);
        }
        return;
      }
      if (newUrls.indexOf(urlStr) === -1) newUrls.push(urlStr);
    });
    var urlsChanged = newUrls.length !== existingUrls.length;

    _appliedPerformers[localPerformerId] = true;

    var details = buildPerfDetails(localPerformer, jsPerf);

    return _localRateLimiter.submit(function () {
      return updatePerformer(localPerformerId, newStashIds, existingAliases, urlsChanged ? newUrls : null, details);
    }).then(function () {
      logPerfDetailsFilled(localPerformer.name, details);
      crossAdded.forEach(function (ep) {
        addLog(tc("已通过链接补齐 stash_id（", "Filled stash_id from link (") + endpointDisplayName(ep) + tc("）：", "): ") + localPerformer.name);
      });
      // Fill the performer image in the background once the main update lands —
      // covers single apply, batch apply-all, and manual search alike.
      applyPerformerImageAsync(localPerformer, jsPerf);
    });
  }

  // Background image fill for every apply path (single apply, batch apply-all, manual search):
  // pass the JAVStash image URL straight to performerUpdate — Stash downloads it server-side
  // (no browser CSP/base64 involved). Skipped when the local performer already has a custom
  // image (image_path carries "default=true" when it does not). Queued through a dedicated
  // rate limiter so batch applies never hammer javstash.org; the UI never waits on it.
  function applyPerformerImageAsync(localPerf, jsPerf) {
    var ip = localPerf.image_path || "";
    if (ip && ip.indexOf("default=true") === -1) return;
    var imgs = jsPerf.images || [];
    var imgUrl = "";
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i] && imgs[i].url) { imgUrl = imgs[i].url; break; }
    }
    if (!imgUrl) {
      addLog(tc("JAVStash 演员无图片，跳过补图: ", "JAVStash performer has no image, skipped: ") + localPerf.name);
      return;
    }
    _imgRateLimiter.submit(function () {
      return callGQL(
        "mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }",
        { input: { id: localPerf.id, image: imgUrl } }
      );
    }).then(function () {
      localPerf.image_path = "/performer/" + localPerf.id + "/image";
      addLog(tc("已设置演员图片: ", "Performer image set: ") + localPerf.name);
    }).catch(function (e) {
      addLog(tc("设置演员图片失败: ", "Failed to set performer image: ") + localPerf.name + " — " + (e.message || e));
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
    searchMatches: null,   // engine B results
    searchOpts: { aliasSearch: true, fuzzy: false },
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
      fpComplete: { scenes: null, loading: false, running: false, done: false },
    },
  };

  function setState(updates, throttle) {
    for (var k in updates) _state[k] = updates[k];
    if (throttle) requestRender();
    else { if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; } render(); }
  }

  // ==================== Scan ====================

  // Engine B: name search on JAVStash for local performers that engine A
  // (scene back-fill) left unmatched. Runs after the scene phase with the
  // checkbox options snapshotted at scan start:
  //   opts.aliasSearch — main name + aliases, all candidates, early stop on high
  //                      vs main name only, first result only (faster, narrower)
  //   opts.fuzzy       — Autofill-style rating (name similarity only)
  async function runSearchEngine(config, opts) {
    var performers = await fetchAllLocalPerformers();
    var aMatched = {};
    (_state.results || []).forEach(function (r) {
      r.matches.forEach(function (m) { aMatched[m.localPerformer.id] = true; });
    });
    var targets = performers.filter(function (p) {
      if ((p.stash_ids || []).some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; })) return false;
      return !aMatched[p.id];
    });

    if (targets.length === 0) {
      addLog(tc("没有需要搜索匹配的未绑定演员", "No unlinked performers left for search matching"));
      setState({ searchMatches: [] });
      return;
    }

    addLog(tc("搜索引擎：", "Search engine: ") + targets.length +
      tc(" 名未绑定演员（", " unlinked performers (") +
      (opts.aliasSearch ? tc("别名搜索", "alias search") : tc("仅主名搜索", "main-name only")) +
      (opts.fuzzy ? tc("，模糊匹配", ", fuzzy matching") : "") + "）");

    setState({ scanProgress: { current: 0, total: targets.length, title: "" } });

    var matches = [];
    var processed = 0;

    for (var i = 0; i < targets.length; i++) {
      if (_state.abortFlag) break;
      var local = targets[i];
      processed++;
      updateProgressDOM(processed, targets.length, local.name);

      var allTerms = buildSearchTerms(local);
      var terms = opts.aliasSearch ? allTerms : allTerms.filter(function (t) { return t.isMain; });
      var candMap = {};
      var best = null;

      for (var t = 0; t < terms.length; t++) {
        if (_state.abortFlag) break;
        var term = terms[t];
        var list = [];
        try {
          list = await _jsRateLimiter.submit(function () {
            return searchJavstashPerformers(config.javstashEndpoint, config.javstashApiKey, term.raw);
          });
        } catch (e) {
          addLogBatch(tc("搜索失败", "Search failed") + " [" + term.raw + "]: " + e.message);
          continue;
        }
        if (opts.aliasSearch) {
          list.forEach(function (p) { if (!candMap[p.id]) candMap[p.id] = p; });
        } else {
          // Main-name fast path: only the rank-1 result is worth checking —
          // JAVStash sorts exact hits first, so deeper results add noise.
          if (list.length > 0) candMap[list[0].id] = list[0];
        }

        best = evalBestCandidate(local, candMap, allTerms, opts);
        if (opts.aliasSearch && best && best.evidence.confidence === "high") break; // early stop
      }

      best = best || evalBestCandidate(local, candMap, allTerms, opts);
      if (best && best.evidence.confidence) {
        matches.push({
          key: local.id + "|" + best.jsPerf.id,
          localPerformer: local,
          jsPerf: best.jsPerf,
          confidence: best.evidence.confidence,
          evidence: best.evidence,
        });
        addLogBatch("[" + processed + "/" + targets.length + "] " + local.name +
          " → " + best.jsPerf.name + " (" + best.evidence.confidence + ", " +
          tc("相似度", "sim") + " " + best.evidence.sim + ")");
      }

      if (processed % 10 === 0) {
        var start = _state.log.length - 10;
        if (start >= 0) {
          for (var k = start; k < _state.log.length; k++) appendLogDOM(_state.log[k]);
        }
      }
    }

    _state.log.forEach(function (line) { appendLogDOM(line); });

    if (_state.abortFlag) {
      addLog(tc("用户中止扫描：已处理 " + processed + "/" + targets.length + "，保留 " + matches.length + " 条匹配",
                "Scan aborted: processed " + processed + "/" + targets.length + ", kept " + matches.length + " matches"));
    } else {
      var high = matches.filter(function (m) { return m.confidence === "high"; }).length;
      var med = matches.filter(function (m) { return m.confidence === "medium"; }).length;
      addLog(tc("=== 搜索引擎完成: ", "=== Search engine done: ") + targets.length +
        tc(" 名演员 — 高可信 ", " performers — high ") + high +
        tc("，待审核 ", ", review ") + med +
        tc("，未命中 ", ", no hit ") + (targets.length - high - med) + " ===");
    }

    setState({ searchMatches: matches });
  }

  // Best non-null candidate from candMap under the current rating options.
  function evalBestCandidate(local, candMap, terms, opts) {
    var best = null;
    for (var id in candMap) {
      var ev = evaluateCandidate(local, candMap[id], terms, opts);
      if (!ev.confidence) continue;
      if (!best || evidenceBetter(ev, best.evidence)) best = { jsPerf: candMap[id], evidence: ev };
    }
    return best;
  }

  // Ranking for "better evidence": confidence first, then hard signals.
  function evidenceBetter(a, b) {
    var rank = { high: 0, medium: 1 };
    var ra = a.confidence !== null ? rank[a.confidence] : 2;
    var rb = b.confidence !== null ? rank[b.confidence] : 2;
    if (ra !== rb) return ra < rb;
    if (a.stashdbMatch !== b.stashdbMatch) return a.stashdbMatch;
    if (a.voteCount !== b.voteCount) return a.voteCount > b.voteCount;
    if (a.urlIntersect !== b.urlIntersect) return a.urlIntersect > b.urlIntersect;
    return (a.sim || 0) > (b.sim || 0);
  }

  async function handleScan() {
    var config = await getStashBoxConfig();
    if (!config.javstashApiKey) {
      alert(tc("未找到 JAVStash 配置，请在 设置 → 元数据提供者 中添加 JAVStash stash-box 实例",
               "JAVStash not configured. Add it in Settings → Metadata Providers first."));
      return;
    }
    // Snapshot checkbox options at scan start — mid-scan changes have no effect.
    var opts = { aliasSearch: _state.searchOpts.aliasSearch, fuzzy: _state.searchOpts.fuzzy };
    setState({ scanning: true, abortFlag: false, results: null, searchMatches: null, emptyReason: "", log: [], dismissed: {}, manualSelected: {}, applied: {}, applyDone: false });
    _appliedPerformers = {};
    addLog(tc("正在获取含 JAVStash ID 的场景（跳过已全部匹配的）...", "Fetching scenes with JAVStash IDs (skipping fully matched)..."));

    try {
      var scenes = await getScenesWithJavstashId();
      addLog(tc("找到 " + scenes.length + " 个场景", "Found " + scenes.length + " scenes"));
      var results = [];
      var processed = 0;
      var aborted = false;

      if (scenes.length > 0) {
        // Initial progress render
        setState({ scanProgress: { current: 0, total: scenes.length, title: "" } });

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
      } else {
        addLog(tc("没有含 JAVStash ID 的未匹配场景，跳过场景引擎", "No unmatched scenes with JAVStash IDs — skipping scene engine"));
      }

      if (aborted || _state.abortFlag) {
        addLog(tc("用户中止扫描", "Scan aborted by user"));
      }

      // Flush remaining logs
      _state.log.forEach(function (line) { appendLogDOM(line); });

      setState({ results: results });

      // Engine B: search-match performers the scene engine left unmatched.
      if (!_state.abortFlag) {
        await runSearchEngine(config, opts);
      }

      var searchMatches = _state.searchMatches || [];
      if (results.length === 0 && searchMatches.length === 0) {
        _state.emptyReason = scenes.length === 0
          ? tc("所有含 JAVStash ID 的场景已全部匹配完成，且没有需要搜索的未绑定演员",
               "All scenes with JAVStash IDs are fully matched and no unlinked performers remain to search")
          : tc("本次扫描没有产生新匹配", "This scan produced no new matches");
      }

      setState({ scanProgress: null, scanning: false });
      if (_state.abortFlag) {
        addLog(tc("=== 扫描中止（已完成结果已保留）===", "=== Scan aborted (results kept) ==="));
      } else {
        addLog(tc("=== 扫描完成 ===", "=== Scan complete ==="));
      }
    } catch (e) {
      addLog(tc("扫描错误", "Scan error") + ": " + e.message);
      setState({
        scanning: false,
        scanProgress: null,
        results: [],
        searchMatches: [],
        emptyReason: tc("扫描未完成，详见下方日志", "Scan did not finish — see log below"),
      });
    }
  }

  function handleApply() {
    var rawItems = [];
    var conflict = computeConflicts();

    // Collect high-confidence matches only (not dismissed, not conflicting)
    getAllMatches().forEach(function (m) {
      if (!m.dismissed && m.confidence === "high" && !conflict[m.key]) {
        rawItems.push({ localPerformer: m.localPerformer, jsPerf: m.javstashPerformer, key: m.key });
      }
    });

    // Collect engine B search matches (high only)
    getAllSearchMatches().forEach(function (sm) {
      if (!sm.dismissed && sm.confidence === "high" && !conflict[sm.key]) {
        rawItems.push({ localPerformer: sm.localPerformer, jsPerf: sm.jsPerf, key: sm.key });
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

  // ==================== Fingerprint Completion (单演员场景指纹补全) ====================

  // Local scenes with exactly one performer whose performer is not yet linked
  // to JAVStash and that carry at least one file fingerprint. Each entry maps
  // the scene to its local performer and fingerprint list.
  function fetchCompletableScenes() {
    var PAGE_SIZE = 1000;
    var all = [];
    var page = 1;

    function fetchPage() {
      return callGQL(
        "query($filter: FindFilterType!) { findScenes(filter: $filter, scene_filter: { performer_count: { value: 1, modifier: EQUALS } }) { count scenes { id title files { fingerprints { type value } } performers { id name disambiguation alias_list birthdate death_date urls height_cm measurements country ethnicity hair_color eye_color career_length tattoos piercings gender image_path stash_ids { endpoint stash_id } } } } }",
        { filter: { per_page: PAGE_SIZE, page: page, sort: "path" } }
      ).then(function (data) {
        var result = data.findScenes;
        result.scenes.forEach(function (s) {
          var fps = [];
          var seen = {};
          (s.files || []).forEach(function (f) {
            (f.fingerprints || []).forEach(function (fp) {
              if (!fp || !fp.value || !fp.type) return;
              var k = fp.type.toUpperCase() + ":" + fp.value;
              if (seen[k]) return;
              seen[k] = true;
              fps.push({ hash: fp.value, algorithm: fp.type.toUpperCase() });
            });
          });
          if (fps.length === 0) return;
          var p = (s.performers || [])[0];
          if (!p) return;
          var linked = (p.stash_ids || []).some(function (sid) { return sid.endpoint === JAVSTASH_ENDPOINT; });
          if (linked) return;
          all.push({ sceneId: s.id, sceneTitle: s.title || "", local: p, fps: fps });
        });
        if (page * PAGE_SIZE < result.count) {
          page++;
          return fetchPage();
        }
        return all;
      });
    }

    return fetchPage();
  }

  function ensureFpScenes() {
    var fp = _state.manualTab.fpComplete;
    if (fp.scenes !== null || fp.loading || fp.running) return;
    setManualTab({ fpComplete: { scenes: fp.scenes, loading: true, running: false, done: fp.done } });
    fetchCompletableScenes().then(function (scenes) {
      setManualTab({ fpComplete: { scenes: scenes, loading: false, running: false, done: fp.done } });
    }).catch(function (e) {
      addLog(tc("加载单演员场景失败", "Failed to load single-performer scenes") + ": " + e.message);
      setManualTab({ fpComplete: { scenes: [], loading: false, running: false, done: fp.done } });
    });
  }

  // Search JAVStash by a scene's fingerprints. Resolves to:
  //   { status: "hit",       scene, jsPerf } — remote scene with exactly one performer
  //   { status: "ambiguous", scene }         — matched but remote scene has multiple performers
  //   { status: "none" }                     — no fingerprint match
  function fingerprintSearchPerformer(endpoint, apiKey, fps) {
    return _jsRateLimiter.submit(function () {
      return callJavstashGQL(endpoint, apiKey,
        "query($fingerprints: [[FingerprintQueryInput!]!]!) { findScenesBySceneFingerprints(fingerprints: $fingerprints) { id title release_date performers { as performer { id name disambiguation aliases urls { url } images { url } gender birth_date death_date height cup_size band_size waist_size hip_size hair_color eye_color ethnicity country career_start_year career_end_year tattoos { location description } piercings { location description } } } } }",
        { fingerprints: [fps] }
      );
    }).then(function (data) {
      var groups = data.findScenesBySceneFingerprints || [];
      var matches = groups[0] || [];
      var ambiguous = null;
      for (var i = 0; i < matches.length; i++) {
        var perfs = (matches[i].performers || []).map(function (pa) { return pa.performer; });
        if (perfs.length === 1 && perfs[0]) return { status: "hit", scene: matches[i], jsPerf: perfs[0] };
        if (!ambiguous) ambiguous = matches[i];
      }
      return ambiguous ? { status: "ambiguous", scene: ambiguous } : { status: "none" };
    });
  }

  function updateFpStatusDOM(text) {
    var node = document.querySelector("[data-jsm-fpstatus]");
    if (node) node.textContent = text;
  }

  // 补全单演员: fingerprint-search JAVStash for every completable single-performer
  // scene and apply the matched remote performer to the local one. Scenes with
  // no fingerprint result are skipped, as are ambiguous multi-performer hits.
  function handleCompletePerformers() {
    var fp = _state.manualTab.fpComplete;
    if (fp.running || !fp.scenes || fp.scenes.length === 0) return;

    getStashBoxConfig().then(function (config) {
      if (!config.javstashApiKey) {
        alert(tc("未找到 JAVStash 配置，请在 设置 → 元数据提供者 中添加 JAVStash stash-box 实例",
                 "JAVStash not configured. Add it in Settings → Metadata Providers first."));
        return;
      }

      var scenes = fp.scenes;
      setManualTab({ fpComplete: { scenes: scenes, loading: false, running: true, done: false } });
      addLog(tc("=== 指纹补全开始: ", "=== Fingerprint completion start: ") + scenes.length +
        tc(" 个单演员场景 ===", " single-performer scenes ==="));

      var applied = 0, noResult = 0, skipped = 0, already = 0, failed = 0;
      var okNames = [], failNames = [];
      var i = 0;

      function step() {
        if (i >= scenes.length) return Promise.resolve();
        var item = scenes[i];
        i++;

        // The performer may have been linked by an earlier scene in this run.
        if ((item.local.stash_ids || []).some(function (s) { return s.endpoint === JAVSTASH_ENDPOINT; })) {
          already++;
          updateFpStatusDOM(tc("补全中 ", "Completing ") + i + "/" + scenes.length +
            tc("（已补全 ", " (") + applied + tc("）", ")"));
          return step();
        }

        updateFpStatusDOM(tc("补全中 ", "Completing ") + i + "/" + scenes.length +
          tc("（已补全 ", " (") + applied + tc("）", ")"));

        return fingerprintSearchPerformer(config.javstashEndpoint, config.javstashApiKey, item.fps)
          .then(function (res) {
            if (res.status === "none") {
              noResult++;
              addLog(tc("指纹未命中（JAVStash 无该指纹的场景）: ", "Fingerprint no result (no scene with this fingerprint on JAVStash): ") +
                item.local.name + (item.sceneTitle ? " [" + item.sceneTitle + "]" : ""));
              return null;
            }
            if (res.status === "ambiguous") {
              skipped++;
              addLog(tc("指纹命中多演员场景，跳过: ", "Fingerprint matched a multi-performer scene, skipped: ") +
                item.local.name + (res.scene.title ? " [" + res.scene.title + "]" : ""));
              return null;
            }
            addLog(tc("指纹命中: ", "Fingerprint hit: ") + item.local.name + " → " + res.jsPerf.name +
              (res.scene.title ? " [" + res.scene.title + "]" : ""));
            return applyMatchCached(item.local, res.jsPerf).then(function () {
              applied++;
              okNames.push(item.local.name);
              item.local.stash_ids = (item.local.stash_ids || [])
                .concat([{ endpoint: JAVSTASH_ENDPOINT, stash_id: res.jsPerf.id }]);
              // Mark the manual row as applied without a full re-render.
              _state.manualTab.search[item.local.id] = Object.assign(
                {}, _state.manualTab.search[item.local.id],
                { appliedJsId: res.jsPerf.id, searching: false });
              return null;
            });
          })
          .catch(function (e) {
            failed++;
            failNames.push(item.local.name);
            addLog(tc("补全失败", "Completion failed") + " " + item.local.name +
              " [" + (item.sceneTitle || item.sceneId) + "]: " + (e.message || e));
            return null;
          })
          .then(step);
      }

      return step().then(function () {
        // Drop scenes whose performer is now linked; keep the rest countable.
        var remaining = _state.manualTab.fpComplete.scenes.filter(function (s) {
          return !(s.local.stash_ids || []).some(function (sid) { return sid.endpoint === JAVSTASH_ENDPOINT; });
        });
        addLog(tc("=== 指纹补全完成: 补全 ", "=== Fingerprint completion done: applied ") + applied +
          (okNames.length ? "（" + okNames.join("、") + "）" : "") +
          tc("，未命中 ", ", no result ") + noResult +
          tc("，多演员跳过 ", ", multi-performer skipped ") + skipped +
          tc("，已绑定 ", ", already linked ") + already +
          tc("，失败 ", ", failed ") + failed +
          (failNames.length ? "（" + failNames.join("、") + "）" : "") + " ===");
        setManualTab({ fpComplete: { scenes: remaining, loading: false, running: false, done: true } });
      }).catch(function (e) {
        // Unexpected abort — still finalize so the button greys out (done no matter what).
        addLog(tc("指纹补全异常终止: ", "Fingerprint completion aborted: ") + (e.message || e));
        setManualTab({ fpComplete: {
          scenes: _state.manualTab.fpComplete.scenes,
          loading: false, running: false, done: true } });
      });
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

  function handleRestorePerformer(local) {
    var ignored = {};
    for (var k in _state.manualTab.ignoredIds) ignored[k] = true;
    delete ignored[local.id];
    setManualTab({ ignoredIds: ignored });
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

  function getAllSearchMatches() {
    var list = _state.searchMatches;
    if (!list) return [];
    return list.map(function (sm) {
      return {
        key: sm.key,
        localPerformer: sm.localPerformer,
        jsPerf: sm.jsPerf,
        confidence: sm.confidence,
        evidence: sm.evidence,
        dismissed: !!_state.dismissed[sm.key],
      };
    });
  }

  // A JAVStash performer high-matched to more than one DISTINCT local performer
  // (across both engines) is a conflict: badge + excluded from apply-all.
  // Dismissing one side resolves the conflict dynamically.
  function computeConflicts() {
    var map = {};
    function add(key, jsId, localId) {
      if (!map[jsId]) map[jsId] = { locals: {}, keys: [] };
      map[jsId].locals[localId] = true;
      map[jsId].keys.push(key);
    }
    getAllMatches().forEach(function (m) {
      if (m.confidence === "high" && !m.dismissed) add(m.key, m.javstashPerformer.id, m.localPerformer.id);
    });
    getAllSearchMatches().forEach(function (sm) {
      if (sm.confidence === "high" && !sm.dismissed) add(sm.key, sm.jsPerf.id, sm.localPerformer.id);
    });
    var out = {};
    for (var jsId in map) {
      if (Object.keys(map[jsId].locals).length >= 2) {
        map[jsId].keys.forEach(function (k) { out[k] = true; });
      }
    }
    return out;
  }

  function hasApplicableMatches() {
    if (Object.keys(_state.manualSelected).length) return true;
    var conflict = computeConflicts();
    if (getAllMatches().some(function (m) { return m.confidence === "high" && !m.dismissed && !conflict[m.key]; })) return true;
    return getAllSearchMatches().some(function (sm) { return sm.confidence === "high" && !sm.dismissed && !conflict[sm.key]; });
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

  var _rendering = false;
  var _rerenderRequested = false;

  function render() {
    // 渲染期间禁止重入：buildPanel 内的副作用（如手动 tab 触发 ensureManualList /
    // ensureFpScenes）若同步 setState → render，内层已重建 root，外层仍会把旧 frag
    // 追加进来，造成同一 root 内多份面板堆叠（真实大库加载慢时可见数秒）。
    if (_rendering) { _rerenderRequested = true; return; }
    _rendering = true;
    var root = document.getElementById("jsm-panel-root");
    if (!root) { _rendering = false; return; }
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
    _rendering = false;
    if (_rerenderRequested) {
      _rerenderRequested = false;
      requestRender();
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

  // 圆角长条滑块开关 — 滑块在文字左侧；点击切换（滑块+文字整块可点）；
  // 滑块靠右 = 开启，开启时滑轨显示主题色。
  function buildToggle(label, checked, tooltip, onchange, warn) {
    var on = !!checked;
    var toggle = el("div", "jsm-toggle" + (warn ? " jsm-toggle-warn" : "") + (on ? " on" : ""), [
      el("span", "jsm-toggle-track", [el("span", "jsm-toggle-knob")]),
      el("span", "jsm-toggle-label", label),
    ]);
    if (tooltip) toggle.title = tooltip;
    if (_state.scanning) {
      toggle.classList.add("jsm-toggle-disabled");
    } else {
      toggle.onclick = function () {
        on = !on;
        toggle.classList.toggle("on", on);
        onchange(on);
      };
    }
    return toggle;
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
      el("h2", "jsm-title", [
        "JavStashLinker",
        el("span", "jsm-version", "v" + PLUGIN_VERSION),
      ]),
      el("div", "jsm-header-actions", [
        el("button", "jsm-btn jsm-btn-primary" + (_state.applying ? " jsm-btn-disabled" : ""), tc("应用全部", "Apply All"), {
          onclick: handleApply,
          disabled: _state.applying || !hasApplicableMatches(),
          title: tc("仅应用 high 置信度（冲突组除外）", "Apply high-confidence matches only (conflicts excluded)"),
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
        buildToggle(tc("别名搜索", "Alias Search"), _state.searchOpts.aliasSearch,
          tc("搜索时使用主名+全部别名；取消后仅搜索主名并只核对第一个结果",
             "Search main name + all aliases; unchecked searches only the main name and checks only the first result"),
          function (checked) { setState({ searchOpts: Object.assign({}, _state.searchOpts, { aliasSearch: checked }) }); }),
        buildToggle(tc("模糊匹配", "Fuzzy Match"), _state.searchOpts.fuzzy,
          tc("勾选后仅按名称相似度评级（≥0.9 自动应用），不再参考 URL/StashDB/生日证据",
             "When checked, rating uses name similarity only (>=0.9 auto-applied); URL/StashDB/birthday evidence is ignored"),
          function (checked) { setState({ searchOpts: Object.assign({}, _state.searchOpts, { fuzzy: checked }) }); },
          true),
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
    var hasResults = _state.results !== null;
    var conflictMap = hasResults ? computeConflicts() : {};
    var searchAll = hasResults ? getAllSearchMatches() : [];
    // 列表含已忽略项（收窄行）与冲突项（冲突徽章，见 buildMatchCard/buildSearchMatchCard）；
    // 「应用全部」与数据大屏计数另行排除。
    var autoMatches = hasResults
      ? getAllMatches().filter(function (m) { return m.confidence === "high"; })
      : [];
    var autoSearch = searchAll.filter(function (sm) { return sm.confidence === "high"; });
    var reviewMatches = hasResults ? getAllMatches().filter(function (m) { return m.confidence === "medium"; }) : [];
    var reviewSearch = searchAll.filter(function (sm) { return sm.confidence === "medium"; });
    var unmatched = hasResults ? getAllUnmatched() : [];
    var hasResultItems = hasResults && (_state.results.length > 0 || searchAll.length > 0);

    if (hasResultItems) {
      // 数据大屏计数排除已忽略项；页签计数按惯例保留总数（不受忽略影响）。
      var activeCount = function (arr, conflicts) {
        return arr.filter(function (x) {
          return !x.dismissed && (conflicts ? !!conflictMap[x.key] : !conflictMap[x.key]);
        }).length;
      };
      var autoCount = activeCount(autoMatches) + activeCount(autoSearch);
      var reviewCount = activeCount(reviewMatches) + activeCount(reviewSearch);
      var conflictCount = activeCount(autoMatches, true) + activeCount(autoSearch, true);
      var dismissedCount = autoMatches.length + autoSearch.length + reviewMatches.length + reviewSearch.length
        - autoCount - reviewCount - conflictCount;
      frag.appendChild(el("div", "jsm-stats", [
        buildStat(autoCount, tc("自动匹配", "Auto Matched"), "#37b24d"),
        buildStat(reviewCount, tc("待审核", "Needs Review"), "#f59f00"),
        buildStat(conflictCount, tc("冲突", "Conflicts"), "#ffa94d"),
        buildStat(dismissedCount, tc("已忽略", "Dismissed"), "#868e96"),
      ]));
    }

    // Tabs (always visible — manual search works without scanning)
    var tabs = [
      { id: "auto", label: tc("自动匹配", "Auto Matched") + " (" + (autoMatches.length + autoSearch.length) + ")" },
      { id: "review", label: tc("待审核", "Needs Review") + " (" + (reviewMatches.length + reviewSearch.length) + ")" },
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
    } else if (_state.activeTab === "unmatched") {
      if (!hasResults) {
        content.appendChild(el("div", "jsm-empty",
          _state.scanning ? tc("扫描进行中...", "Scanning...")
            : tc("尚未扫描 — 点击上方「开始扫描」，或使用「手动搜索」", "Not scanned yet — click Start Scan above, or use Manual Search")));
      } else if (unmatched.length === 0) {
        content.appendChild(el("div", "jsm-empty", tc("没有未匹配演员", "No unmatched performers")));
      } else {
        content.appendChild(buildChunkedList(unmatched, buildUnmatchedCard));
      }
    } else {
      // Auto / review tabs: engine A cards + "Search Matches" section for engine B
      var isAuto = _state.activeTab === "auto";
      var sceneItems = isAuto ? autoMatches : reviewMatches;
      var searchItems = isAuto ? autoSearch : reviewSearch;
      if (!hasResults) {
        content.appendChild(el("div", "jsm-empty",
          _state.scanning ? tc("扫描进行中...", "Scanning...")
            : tc("尚未扫描 — 点击上方「开始扫描」，或使用「手动搜索」", "Not scanned yet — click Start Scan above, or use Manual Search")));
      } else if (sceneItems.length === 0 && searchItems.length === 0) {
        content.appendChild(el("div", "jsm-empty",
          _state.emptyReason ||
          (isAuto ? tc("没有自动匹配", "No auto matches") : tc("没有待审核匹配", "No review matches"))));
      } else {
        if (sceneItems.length > 0) {
          content.appendChild(buildChunkedList(sceneItems, buildMatchCard));
        }
        if (searchItems.length > 0) {
          content.appendChild(el("div", "jsm-section-label", tc("搜索匹配", "Search Matches")));
          content.appendChild(buildChunkedList(searchItems, buildSearchMatchCard));
        }
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

  // JAVStash performer name link — opens the performer page on javstash.org in
  // a new browser tab (used for match verification).
  function buildJsPerfLink(jsPerf) {
    var text = jsPerf.name + (jsPerf.disambiguation ? " (" + jsPerf.disambiguation + ")" : "");
    return el("a", "jsm-link", text, {
      href: JAVSTASH_WEB + "/performers/" + jsPerf.id,
      target: "_blank",
      rel: "noopener noreferrer",
    });
  }

  // SPA 导航 — pushState + 合成 popstate 让 Stash 的 react-router 切换页面，
  // 不触发整页刷新（回退/前进按钮仍可用）。
  function navigateStash(href) {
    try {
      var state = { key: Math.random().toString(36).slice(2, 8), state: null };
      window.history.pushState(state, "", href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: state }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // 给 <a> 挂 SPA 导航：左键单击关面板并原地跳转；修饰键/中键走浏览器默认行为。
  function attachSpaNav(node, href) {
    node.onclick = function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      closePanel();
      if (!navigateStash(href)) window.location.href = href;
    };
    return node;
  }

  // 本地演员名链接 — 当前标签页打开 Stash 演员详情页（SPA 路由，不整页刷新）。
  function buildStashPerfLink(name, localId) {
    var href = "/performers/" + localId;
    return attachSpaNav(el("a", "jsm-link", name, { href: href }), href);
  }

  // "查看" button on match cards — solid orange; opens the local performer's
  // Stash detail page in the current tab via SPA navigation.
  function buildViewLink(localPerformer) {
    var href = "/performers/" + localPerformer.id;
    return attachSpaNav(
      el("a", "jsm-btn jsm-btn-sm jsm-btn-view", tc("查看", "View"), { href: href }),
      href);
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

    // 忽略后收窄为一行（纯文本主名 + 已忽略徽章 + 恢复按钮）。
    if (isDismissed && !isApplied) {
      return buildDismissedMatchCard(m.key, m.sceneTitle, m.javstashPerformer.name, m.localPerformer.name);
    }

    var info = el("div", "jsm-card-info", [
      el("div", "jsm-scene-title", m.sceneTitle),
      el("div", "jsm-card-name", [
        buildJsPerfLink(m.javstashPerformer),
        document.createTextNode(" → "),
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

    var children = [info, badge, methodBadge, buildViewLink(m.localPerformer)];
    if (computeConflicts()[m.key]) {
      children.push(el("span", "jsm-badge jsm-badge-conflict", tc("冲突", "conflict"), {
        title: tc("同一 JAVStash 演员被多个本地演员高可信命中，已退出「应用全部」",
                 "This JAVStash performer is high-matched to multiple local performers — excluded from Apply All"),
      }));
    }
    children.push(rightSide);

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : "") + (isDismissed ? " jsm-card-dismissed" : ""), children);
  }

  // 已忽略的匹配 — 收窄为一行：主名纯文本（不可点击），尾部「已忽略」徽章 + 「恢复」按钮。
  // 不显示证据描述/置信度徽章/查看/忽略按钮。
  function buildDismissedMatchCard(key, sceneTitle, jsName, localName) {
    return el("div", "jsm-card jsm-card-dismissed jsm-card-narrow", [
      el("div", "jsm-card-info", [
        sceneTitle ? el("div", "jsm-scene-title", sceneTitle) : null,
        el("div", "jsm-card-name", jsName + " → " + localName),
      ]),
      el("span", "jsm-badge jsm-badge-dismissed", tc("已忽略", "Dismissed")),
      el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("恢复", "Restore"), {
        onclick: function () {
          var d = Object.assign({}, _state.dismissed);
          delete d[key];
          setState({ dismissed: d });
        },
      }),
    ]);
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

  function buildManualTab() {
    var mt = _state.manualTab;
    var wrap = el("div", "jsm-manual");

    // 单演员场景数据（补全按钮依据），首次进入异步加载并缓存。
    // setTimeout 延迟到本次渲染完成后触发，避免渲染期间同步 setState → render 重入。
    if (mt.fpComplete.scenes === null && !mt.fpComplete.loading) setTimeout(ensureFpScenes, 0);

    // 列表筛选（状态行与列表渲染共用）。
    var filter = (mt.listFilter || "").trim().toLowerCase();
    var filtered = null;
    if (mt.list !== null && !mt.listLoading) {
      filtered = filter
        ? mt.list.filter(function (p) {
            if ((p.name || "").toLowerCase().indexOf(filter) !== -1) return true;
            return parseAliasList(p.alias_list).some(function (a) {
              return a.toLowerCase().indexOf(filter) !== -1;
            });
          })
        : mt.list;
    }

    // 紧凑提示区（参照 performerMerge 别名修复页）：状态文案合并一行 + 左对齐补全按钮。
    var fp = mt.fpComplete;
    var parts = [];
    if (filtered === null) {
      parts.push(tc("演员列表加载中...", "Loading performers..."));
    } else if (filter) {
      parts.push(tc("匹配 " + filtered.length + " / " + mt.list.length + " 个",
                    filtered.length + " / " + mt.list.length + " performers"));
    } else {
      parts.push(tc("未绑定演员 " + filtered.length + " 个", filtered.length + " unlinked performers"));
    }
    if (fp.running) {
      parts = [tc("补全中 0/" + fp.scenes.length, "Completing 0/" + fp.scenes.length)];
    } else if (fp.done) {
      parts.push(fp.scenes.length > 0
        ? tc("已完成补全，" + fp.scenes.length + "个未命中",
             "Completed, " + fp.scenes.length + " not matched")
        : tc("已完成补全", "Completed"));
    } else if (fp.scenes !== null && fp.scenes.length > 0) {
      parts.push(fp.scenes.length + tc("个单演员场景可补全",
                                       fp.scenes.length + " single-performer scenes can be completed"));
    }
    var ignoredCount = filtered === null
      ? 0
      : mt.list.filter(function (p) { return mt.ignoredIds[p.id]; }).length;
    var statusText = parts.join(" · ");
    if (ignoredCount > 0) {
      statusText += tc("（已忽略 " + ignoredCount + " 个）", " (" + ignoredCount + " ignored)");
    }

    // 补全按钮（一次性）：可补全 / 补全中 / 已补全（灰、不可点）；无可补全时不渲染。
    var fpBtn = null;
    if (fp.scenes !== null && (fp.scenes.length > 0 || fp.done)) {
      if (fp.running) {
        fpBtn = el("button", "jsm-btn jsm-btn-state", tc("补全中...", "Completing..."), {
          disabled: true,
        });
      } else if (fp.done) {
        fpBtn = el("button", "jsm-btn jsm-btn-state", tc("已补全", "Completed"), {
          disabled: true,
        });
      } else {
        fpBtn = el("button", "jsm-btn jsm-btn-primary", tc("补全单演员", "Complete Single-Performer"), {
          title: tc("用单演员场景指纹搜索 JAVStash", "Fingerprint-search JAVStash with single-performer scenes"),
          onclick: function () { handleCompletePerformers(); },
        });
      }
    }

    var statusEl = el("div", "jsm-config-status", statusText);
    if (fp.running) statusEl.setAttribute("data-jsm-fpstatus", "");
    var compactKids = [statusEl];
    if (fpBtn) compactKids.push(el("div", "jsm-actions", [fpBtn]));
    wrap.appendChild(el("div", "jsm-config jsm-config-compact", compactKids));

    var input = el("input", "jsm-input jsm-manual-query", null, {
      type: "text",
      value: mt.listFilter,
      placeholder: tc("筛选演员（名称/别名）", "Filter performers (name/alias)"),
      oninput: function (e) {
        if (e.isComposing) return;
        if (e.target.value !== _state.manualTab.listFilter) setManualTab({ listFilter: e.target.value });
      },
    });
    input.addEventListener("compositionend", function () {
      if (input.value !== _state.manualTab.listFilter) setManualTab({ listFilter: input.value });
    });
    var inputWrap = el("div", "jsm-input-wrap", [input]);
    if ((mt.listFilter || "").length > 0) {
      inputWrap.appendChild(el("button", "jsm-input-clear", "×", {
        title: tc("清除筛选", "Clear filter"),
        onclick: function () {
          setManualTab({ listFilter: "" });
          var inp = document.querySelector(".jsm-manual-query");
          if (inp) inp.focus();
        },
      }));
    }
    wrap.appendChild(el("div", "jsm-manual-searchrow", [inputWrap]));

    if (mt.listLoading || mt.list === null) {
      if (mt.list === null) setTimeout(ensureManualList, 0);
      wrap.appendChild(el("div", "jsm-empty", tc("加载演员列表中...", "Loading performers...")));
      return wrap;
    }

    if (filtered.length === 0) {
      wrap.appendChild(el("div", "jsm-empty",
        mt.list.length === 0
          ? tc("没有未绑定 JAVStash 的演员", "No performers without JAVStash ID")
          : tc("无匹配演员", "No matching performers")));
      return wrap;
    }

    wrap.appendChild(buildChunkedList(filtered, buildManualRow));
    return wrap;
  }

  // 已忽略的演员 — 收窄为一行主名高度，尾部「已忽略」徽章 + 「恢复」按钮；主名纯文本不可点击。
  function buildManualIgnoredRow(p) {
    return el("div", "jsm-mgroup jsm-mgroup-ignored", [
      el("div", "jsm-mgroup-head", [
        el("div", "jsm-card-info", [
          el("div", "jsm-card-name", p.name),
        ]),
        el("div", "jsm-mgroup-actions", [
          el("span", "jsm-badge jsm-badge-dismissed", tc("已忽略", "Dismissed")),
          el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("恢复", "Restore"), {
            onclick: function () { handleRestorePerformer(p); },
          }),
        ]),
      ]),
    ]);
  }

  function buildManualRow(p) {
    if (_state.manualTab.ignoredIds[p.id]) return buildManualIgnoredRow(p);
    var s = _state.manualTab.search[p.id];
    var group = el("div", "jsm-mgroup");

    var aliases = parseAliasList(p.alias_list);
    var head = el("div", "jsm-mgroup-head", [
      el("div", "jsm-card-info", [
        el("div", "jsm-card-name", [buildStashPerfLink(p.name, p.id)]),
        aliases.length ? el("div", "jsm-card-sub", aliases.join(", ")) : null,
      ]),
      (function () {
        // 搜索/忽略按钮组 — 与主名/别名放不下时整组换行到下一行。
        var actions = el("div", "jsm-mgroup-actions");
        if (s && s.appliedJsId) {
          actions.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
        } else if (s && s.searching) {
          actions.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-state", tc("搜索中...", "Searching..."), { disabled: true }));
        } else {
          actions.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("搜索", "Search"), {
            onclick: function () { handleRowSearch(p); },
          }));
        }
        actions.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-ignore", tc("忽略", "Ignore"), {
          title: tc("忽略该演员", "Ignore this performer"),
          onclick: function () { handleIgnorePerformer(p); },
        }));
        return actions;
      })(),
    ]);
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

  // Evidence detail line shared by manual candidate cards and search match
  // cards: votes, birthday, height, URL intersection, StashDB, similarity.
  function buildEvidenceSub(local, jsPerf, ev) {
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

    return el("div", "jsm-card-sub", [
      el("span", null, tc("命中 ", "votes ") + ev.voteCount + "/" + ev.totalNames + (voteNames ? ": " + voteNames : "") + " · "),
      el("span", bdayClass, bdayText + " · "),
      el("span", hClass, hText + " · "),
      el("span", null, tc("URL交集 ", "URL ") + ev.urlIntersect + " · "),
      el("span", ev.stashdbMatch ? "jsm-ev-ok" : null, tc("StashDB ", "StashDB ") + (ev.stashdbMatch ? "✓" : "✗")),
      el("span", null, " · " + tc("相似度 ", "sim ") + (ev.sim || 0)),
    ]);
  }

  function buildManualCandidateCard(c, local, showMore) {
    var jsPerf = c.jsPerf;
    var ev = c.evidence;
    var s = _state.manualTab.search[local.id];
    var isApplied = !!(s && s.appliedJsId === jsPerf.id);

    var sub = buildEvidenceSub(local, jsPerf, ev);

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
        el("div", "jsm-card-name", [
          buildJsPerfLink(jsPerf),
          jsPerf.deleted ? document.createTextNode("  [" + tc("已删除", "deleted") + "]") : null,
        ]),
        sub,
      ]),
      badge,
      right,
    ]);
  }

  // Engine B match card: JAVStash performer -> local performer, evidence detail
  // line, and a conflict badge when the same JAVStash performer is
  // high-matched to multiple local performers.
  function buildSearchMatchCard(sm) {
    var jsPerf = sm.jsPerf;
    var isApplied = _state.applied[sm.key];
    var isDismissed = sm.dismissed;
    var isConflict = !!computeConflicts()[sm.key];

    // 忽略后收窄为一行（纯文本主名 + 已忽略徽章 + 恢复按钮）。
    if (isDismissed && !isApplied) {
      return buildDismissedMatchCard(sm.key, null, jsPerf.name, sm.localPerformer.name);
    }

    var info = el("div", "jsm-card-info", [
      el("div", "jsm-card-name", [
        buildJsPerfLink(jsPerf),
        jsPerf.deleted ? document.createTextNode("  [" + tc("已删除", "deleted") + "]") : null,
        document.createTextNode(" → "),
        (function () {
          var span = document.createElement("span");
          span.style.color = "#37b24d";
          span.textContent = sm.localPerformer.name;
          return span;
        })(),
      ]),
      buildEvidenceSub(sm.localPerformer, jsPerf, sm.evidence),
    ]);

    var rightSide = el("div", "jsm-card-actions");
    if (isApplied) {
      rightSide.appendChild(el("span", "jsm-badge jsm-badge-applied", tc("已应用", "Applied")));
    } else if (isDismissed) {
      rightSide.appendChild(el("span", "jsm-badge jsm-badge-dismissed", tc("已忽略", "Dismissed")));
      rightSide.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-primary", tc("恢复", "Restore"), {
        onclick: function () {
          var d = Object.assign({}, _state.dismissed);
          delete d[sm.key];
          setState({ dismissed: d });
        },
      }));
    } else {
      rightSide.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-success", tc("应用", "Apply"), {
        onclick: function () { applySingle(sm.key, sm.localPerformer, sm.jsPerf); },
      }));
    }
    if (!isApplied) {
      rightSide.appendChild(el("button", "jsm-btn jsm-btn-sm jsm-btn-ignore", tc("忽略", "Dismiss"), {
        onclick: function () {
          var d = Object.assign({}, _state.dismissed);
          d[sm.key] = true;
          setState({ dismissed: d });
        },
      }));
    }

    var children = [
      info,
      el("span", "jsm-badge " + (sm.confidence === "high" ? "jsm-badge-high" : "jsm-badge-medium"), sm.confidence),
      buildViewLink(sm.localPerformer),
    ];
    if (isConflict) {
      children.push(el("span", "jsm-badge jsm-badge-conflict", tc("冲突", "conflict"), {
        title: tc("同一 JAVStash 演员被多个本地演员高可信命中，已退出「应用全部」",
                 "This JAVStash performer is high-matched to multiple local performers — excluded from Apply All"),
      }));
    }
    children.push(rightSide);

    return el("div", "jsm-card" + (isApplied ? " jsm-card-applied" : "") + (isDismissed ? " jsm-card-dismissed" : ""), children);
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
    setupRefractTile();
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
    injectRefractTile();
  }

  // ==================== Refract 主题移动端适配 ====================
  // Refract 在移动端隐藏原生导航，改用自建底部 dock + 抽屉（.refract-mobile-drawer）。
  // 抽屉只镜像真实路由 a[href]（排除 javascript: 伪链接）或主题硬编码白名单按钮，
  // 本插件按钮两者都不满足，因此按主题 action tile 结构自注入代理 tile：
  // 抽屉/底部 dock 的点击逻辑会按 data-action-selector 把点击转发给源按钮，
  // Settings → Interface → Refract → Mobile dock 的候选采集也会自动收录本 tile。

  function setupRefractTile() {
    if (window.__jsmRefractTileInit) return;
    window.__jsmRefractTileInit = true;
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
    if (!drawer.__jsmTileObs) {
      drawer.__jsmTileObs = true;
      // 抽屉内 tile 被移除（源按钮暂时不在时主题 reconcile 会清除）后自动补注
      new MutationObserver(function () {
        clearTimeout(drawer.__jsmTileTimer);
        drawer.__jsmTileTimer = setTimeout(injectRefractTile, 200);
      }).observe(drawer, { childList: true });
    }
    if (drawer.querySelector('.refract-drawer-tile[data-action="jsm"]')) return;
    if (!document.querySelector(".jsm-nav-btn-icon")) return;

    var tile = document.createElement("a");
    tile.className = "refract-drawer-tile";
    tile.setAttribute("href", "#");
    tile.setAttribute("data-action", "jsm");
    tile.setAttribute("data-action-tile", "1");
    tile.setAttribute("data-action-selector", ".jsm-nav-btn-icon");
    tile.setAttribute("aria-label", "JavStashLinker");
    tile.setAttribute("title", "JavStashLinker");
    var icon = document.createElement("span");
    icon.className = "refract-drawer-tile-icon";
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
      '</svg>';
    tile.appendChild(icon);
    drawer.appendChild(tile);
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
