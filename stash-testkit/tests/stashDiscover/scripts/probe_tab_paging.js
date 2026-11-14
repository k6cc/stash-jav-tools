// 演员页「发现」tab 的分页终止判据（v2.8.0）
//
// 验什么：点「下一页」时会不会「提前判到底」或「永远停不下来」。
//   normal — 真实语义（每页回满、count 正确）：第 2 页通常由本地缓存覆盖，0 新请求
//   clamp  — 源把 per_page 压到 20、count=5000：第 2 页应真发请求并继续出卡（改前停在 40）
//   ignore — 源无视 page、每页回同一批、count=0：靠整页重复检测停住。只有当第 2 页
//            需要真发请求时才测得到（首屏已缓存该页时脚本会给 hint 说明没测到）
//
// 切换模式：localStorage.setItem("SSD:probe.tabMode", "clamp") 后重跑；不设则用 MODE 默认值。
// 跑法见 SCRIPTS.md（--path /）。跑完记得删掉这个键。
(async function () {
  if (!window.SSD) return JSON.stringify({ err: "window.SSD missing" });
  var MODE = localStorage.getItem("SSD:probe.tabMode") || "normal"; // normal|clamp|ignore
  var log = [];

  // ── 1. 取 box 配置，再挑一位「关联了这些 box」的演员 ─────────────────
  // 关联记录的 endpoint 有短名（"javstash"）和完整 URL 两种历史形态，tab 只认完整
  // URL —— 挑短名的演员会一直停在「该演员未关联 stash-box ID」，测不出分页。
  var bs = [];
  try {
    var c1 = await SSD.callGQL("query{configuration{general{stashBoxes{name endpoint api_key}}}}");
    bs = ((c1.configuration || {}).general || {}).stashBoxes || [];
  } catch (_) {
    var c2 = await SSD.callGQL("query{configuration{stashBoxes{name endpoint api_key}}}");
    bs = ((c2.configuration || {}).stashBoxes) || [];
  }
  var endpoints = bs.map(function (b) { return b.endpoint; }).filter(Boolean);
  if (!endpoints.length) return JSON.stringify({ err: "没有配置 stash-box" });

  var pr = await SSD.callGQL("{findPerformers(filter:{per_page:40}){performers{id name stash_ids{endpoint stash_id}}}}");
  var performers = ((pr.findPerformers || {}).performers) || [];
  var perf = performers.filter(function (p) {
    return (p.stash_ids || []).some(function (s) { return endpoints.indexOf(s.endpoint) >= 0; });
  })[0];
  if (!perf) return JSON.stringify({ err: "没有关联到已配置 box 的演员" });

  // ── 2. 拦 box 的 queryScenes，其余请求透传 ──────────────────────────
  var realFetch = window.fetch, reqs = [], pages = [];
  window.fetch = function (url, opt) {
    var u = typeof url === "string" ? url : (url && url.url) || "";
    var hit = endpoints.some(function (ep) { return u.indexOf(ep) === 0; });
    if (!hit || !opt || !opt.body) return realFetch.apply(this, arguments);
    var body = null;
    try { body = JSON.parse(opt.body); } catch (_) { return realFetch.apply(this, arguments); }
    var q = body.query || "";
    if (q.indexOf("queryScenes") < 0) return realFetch.apply(this, arguments);

    // 变量名是 input（query($input:SceneQueryInput!)），不是 in —— 读错会让
    // 每次请求都被记成 page=1，看起来像「插件从来不翻页」
    var inp = (body.variables || {}).input || (body.variables || {}).in || {};
    var page = inp.page || 1, per = inp.per_page || 100;
    var n = MODE === "clamp" ? Math.min(20, per) : per;
    var scenes = [];
    for (var i = 0; i < n; i++) {
      // ignore 模式每页给同一批 id；其余按页偏移，模拟真实分页
      var idx = MODE === "ignore" ? i : (page - 1) * per + i;
      scenes.push({
        id: "probe-" + idx, title: "PROBE " + idx, date: "2025-01-01",
        images: [], studio: null, performers: [],
      });
    }
    var count = MODE === "ignore" ? 0 : 5000;
    reqs.push({ page: page, per: per, got: n, mode: MODE });
    if (pages.indexOf(page) < 0) pages.push(page);
    var payload = JSON.stringify({ data: { queryScenes: { count: count, scenes: scenes } } });
    return Promise.resolve(new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } }));
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  try {
    // ── 3. 进演员页 → 点「发现」tab ──────────────────────────────────
    history.pushState({}, "", "/performers/" + perf.id);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    for (var w = 0; w < 100 && !document.querySelector(".ssd-nav-link"); w++) await sleep(100);

    var link = document.querySelector(".ssd-nav-link");
    if (!link) return JSON.stringify({ err: "注入的 tab 没出现", performer: perf.name });
    link.click();

    var pane = null;
    for (var w2 = 0; w2 < 120; w2++) {
      pane = document.querySelector(".ssd-tab-pane");
      if (pane && pane.querySelectorAll(".scene-card").length) break;
      await sleep(100);
    }
    if (!pane) return JSON.stringify({ err: "tab 面板没出现", performer: perf.name });

    // ── 4. 首屏稳定 → 连点「下一页」看终止判据 ──────────────────────────
    function sig() {
      var cards = pane.querySelectorAll(".scene-card").length;
      var foot = (pane.querySelector(".ssd-count-info") || {}).textContent || "";
      return cards + "|" + reqs.length + "|" + foot;
    }
    async function settle(limitMs) {
      var last = "", stable = 0, t = performance.now();
      while (performance.now() - t < limitMs) {
        var s = sig();
        if (s === last) stable++; else stable = 0;
        last = s;
        if (stable >= 4) return;
        await sleep(300);
      }
    }
    async function nextBtn() {
      return Array.prototype.filter.call(pane.querySelectorAll("button"), function (b) {
        return /下一页|Next/.test(b.getAttribute("title") || "");
      })[0];
    }

    var t0 = performance.now();
    await settle(20000);
    var steps = [{
      page: 1, requests: reqs.length, cards: pane.querySelectorAll(".scene-card").length,
      footer: (pane.querySelector(".ssd-count-info") || {}).textContent.trim(),
    }];

    for (var k = 0; k < 5; k++) {
      var btn = await nextBtn();
      if (!btn || btn.disabled) break;
      btn.click();
      await settle(12000);
      steps.push({
        page: k + 2, requests: reqs.length, cards: pane.querySelectorAll(".scene-card").length,
        footer: (pane.querySelector(".ssd-count-info") || {}).textContent.trim(),
      });
      if (reqs.length === steps[steps.length - 2].requests &&
          steps[steps.length - 1].cards === steps[steps.length - 2].cards) break; // 点了没动静 = 到底
    }

    var footEl = pane.querySelector(".ssd-count-info");
    if (!reqs.length) {
      log.push({
        err: "tab 一条 box 请求都没发",
        performer: perf.name + " (" + perf.id + ")",
        paneText: (pane.innerText || "").slice(0, 120),
      });
    } else log.push({
      stage: "ok",
      mode: MODE,
      performer: perf.name,
      requests: reqs.length,
      pages: pages,
      perPageAsked: reqs.length ? reqs[0].per : null,
      gotPerPage: reqs.length ? reqs[0].got : null,
      cards: pane.querySelectorAll(".scene-card").length,
      footer: footEl ? footEl.textContent.trim() : "",
      // 页数上限的提示是第二行 ssd-count-info，文本固定含「已达上限」
      truncated: Array.prototype.some.call(pane.querySelectorAll(".ssd-count-info"), function (n) {
        return /已达上限|reached that limit/.test(n.textContent || "");
      }),
      steps: steps,
      // 每条 box 请求的 page / per_page / 实回条数 —— 看清插件是靠换 page 还是加 per_page 翻页
      detail: reqs.slice(0, 8),
      // 点了下一页却没发新请求 = 本地缓存已覆盖该页，重复检测这类场景测不到
      hint: (steps.length > 1 && steps[steps.length - 1].requests === steps[0].requests)
        ? "第 2 页命中本地缓存，未触发新请求；要验整页重复检测请换一位已发现列表为空的演员"
        : undefined,
      ms: Math.round(performance.now() - t0),
    });
  } finally {
    window.fetch = realFetch;
  }
  return JSON.stringify(log[0] || { err: "no sample" });
})()
