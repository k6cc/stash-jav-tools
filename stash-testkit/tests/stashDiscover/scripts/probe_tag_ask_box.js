// K4「带标签问源站」验收探针（2026-11-26）：演员页「发现」tab。
// 验：开关开 + 选一个「必须有」的标签 → 源站请求体里出现 tags（INCLUDES）；
//     源上没这个标签时该源被跳过并给提示；开关关 → 完全不发带 tags 的请求（默认关）。
// 跑法（直接 --path /performers/43 会被 SPA 弹回首页，必须 pushState）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_tag_ask_box.js)" \
//     --path / --settle 5 --timeout 200
// 会临时改 SSD:dp:prefs 的 askTags（跑完还原），会真发几次源站查询。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stage: "start" };
  const PERF = "/performers/43";
  const q = (s, r) => (r || document).querySelector(s);
  const PREF = "SSD:dp:prefs";
  const readPref = () => {
    try { return JSON.parse(localStorage.getItem(PREF) || "{}") || {}; } catch (_) { return {}; }
  };
  const writePref = (p) => localStorage.setItem(PREF, JSON.stringify(p));
  const prefBefore = localStorage.getItem(PREF);

  // 抓 fetch：只记带 tags / searchTag 的请求体
  const seen = [];
  const of = window.fetch;
  window.fetch = function (u, o) {
    try {
      const b = o && o.body;
      if (typeof b === "string" && (b.indexOf('"tags"') >= 0 || b.indexOf("searchTag") >= 0)) {
        const i = b.indexOf('"tags"');
        seen.push({
          kind: b.indexOf("searchTag") >= 0 ? "searchTag" : "queryScenes",
          tags: i >= 0 ? b.slice(i, i + 160).replace(/\s+/g, " ") : "",
        });
      }
    } catch (_) {}
    return of.apply(this, arguments);
  };
  const clearSeen = () => { seen.length = 0; };
  // 等到出现「标签已交给源站筛选」或超时
  const waitChip = async (ms) => {
    for (let i = 0; i < Math.ceil(ms / 500); i++) {
      await sleep(500);
      if (q(".ssd-window-row") && /标签已交给源站筛选|Tags asked/.test((q(".ssd-window-row") || {}).innerText || "")) return true;
    }
    return false;
  };

  try {
    const p0 = readPref();
    p0.tagButton = true;
    p0.askTags = true;
    writePref(p0);

    await sleep(2500);
    const nav = q('a[href="/performers"]');
    if (nav) nav.click();
    await sleep(2500);
    window.history.pushState({}, "", PERF);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(3000);
    q(".ssd-nav-link").click();
    for (let i = 0; i < 30; i++) {
      await sleep(900);
      if (q(".ssd-tab-pane .ssd-scene-card")) break;
    }
    if (!q(".ssd-tab-pane")) throw new Error("no pane");

    // 先把窗口放到「不限时间」：全拉完的窗口按设计不会再问源站，探针就永远看不到 tags
    out.stage = "range-all";
    try { SSD.range.set("all"); } catch (_) {}
    for (let i = 0; i < 40; i++) {
      await sleep(600);
      if (q(".ssd-tagf-btn") && /共\s*\d+/.test(((q(".ssd-count-info") || {}).textContent || ""))) break;
    }

    out.stage = "pick-tag";
    clearSeen();
    q(".ssd-tagf-btn").click();
    await sleep(800);
    const rows = Array.from(document.querySelectorAll(".ssd-tagf-row"))
      .map((r) => ({
        el: r,
        name: ((r.querySelector(".ssd-tagf-name") || {}).textContent || "").trim(),
        n: Number((((r.querySelector(".ssd-tagf-cnt") || {}).textContent || "0").match(/\d+/) || [0])[0]),
      }))
      .filter((r) => r.name && r.n > 0);
    if (!rows.length) throw new Error("no tag row");
    const picked = rows[0];
    out.picked = { name: picked.name, n: picked.n };
    picked.el.click();

    out.stage = "ask";
    const asked = await waitChip(14000);
    await sleep(3000);
    out.asked = {
      chip: asked,
      chipText: ((q(".ssd-window-row") || {}).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      skipText: Array.from(document.querySelectorAll(".ssd-window-row span"))
        .map((s) => s.textContent || "")
        .filter((t) => /缺少标签|has no tag/.test(t)).slice(0, 2),
    };
    out.requests = seen.slice(0, 4);
    out.hasIncludes = seen.some((s) => /modifier.*INCLUDES/.test(s.tags) || /INCLUDES/.test(s.tags));

    out.stage = "off";
    // 关掉开关 + 清规则：不带标签的问法不应再出现 tags
    const p1 = readPref();
    p1.askTags = false;
    writePref(p1);
    window.dispatchEvent(new CustomEvent("ssd:asktags-changed"));
    await sleep(1200);
    const clear = q(".ssd-tagf-clear");
    if (clear) clear.click();
    await sleep(1500);
    clearSeen();
    if (q(".ssd-tagf-btn")) {
      q(".ssd-tagf-btn").click();
      await sleep(600);
      const again = Array.from(document.querySelectorAll(".ssd-tagf-row"))
        .map((r) => ({ el: r, name: ((r.querySelector(".ssd-tagf-name") || {}).textContent || "").trim() }))
        .filter((r) => r.name === picked.name)[0];
      if (again) again.el.click();
    }
    await sleep(9000);
    out.off = { requests: seen.length, chipGone: !(q(".ssd-window-row") && /标签已交给源站筛选/.test((q(".ssd-window-row") || {}).innerText || "")) };
    out.ok = asked && out.hasIncludes && out.off.requests === 0;
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    // 还原：fetch 与偏好；规则清掉
    window.fetch = of;
    try {
      if (prefBefore == null) localStorage.removeItem(PREF);
      else localStorage.setItem(PREF, prefBefore);
    } catch (_) {}
    try {
      const clear = q(".ssd-tagf-clear");
      if (clear && !clear.hidden) clear.click();
    } catch (_) {}
    try { SSD.range.set(""); } catch (_) {}
  }
  return JSON.stringify(out);
})()
