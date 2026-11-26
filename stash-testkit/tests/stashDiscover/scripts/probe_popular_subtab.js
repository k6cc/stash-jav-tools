// K3「累计热度」子 tab 验收探针（2026-11-26）：发现页 › 热门。
// 验：子 tab 行有两个 / 点「累计热度」后条数=per_page 上限、排序锁 hot 且禁用、
//     范围下拉存在且默认 all / 缓存键写了 popular 且 tag 里的 cutoff 与数据一致 /
//     范围改 7 会重查并写新 tag / 切回「近期热门」排序还原成 date-desc 且可用、
//     范围控件消失。
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_popular_subtab.js)" \
//     --path '/plugins/stashDiscover?view=trending' --settle 6 --timeout 200
// 会写 popular 缓存（LLM 之后照常用得到），不写偏好（子 tab 状态在会话里，最后切回
// 「近期热门」并把范围还原成默认）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stage: "start" };
  const q = (s, r) => (r || document).querySelector(s);
  const subs = () => Array.from(document.querySelectorAll(".ssd-dp-subtabs .ssd-dp-tab"));
  const subByText = (re) => subs().find((b) => re.test(b.textContent || ""));
  const head = () => ((q(".ssd-dp-headrow") || {}).innerText || "").replace(/\s+/g, " ").trim();
  const sortVal = () => (q(".ssd-dp-tools select") || {}).value;
  const sortBtn = () => (q(".ssd-dp-tools select") || {});
  const popCaches = () => {
    const arr = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/:popular\./.test(k)) continue;
      let e = {};
      try { e = JSON.parse(localStorage.getItem(k)) || {}; } catch (_) {}
      const d = (e.scenes || []).map((s) => s.release_date).filter(Boolean).sort();
      arr.push({ key: k, tag: e.sinceIsoDate, n: (e.scenes || []).length, min: d[0], max: d[d.length - 1] });
    }
    return arr;
  };
  const waitHead = async (re, steps) => {
    for (let i = 0; i < (steps || 40); i++) {
      await sleep(500);
      if (re.test(head())) return true;
    }
    return false;
  };

  try {
    for (let i = 0; i < 16; i++) {
      await sleep(1200);
      if (!q(".ssd-dp-loading")) break;
    }
    out.stage = "subs";
    out.subs = subs().map((b) => (b.textContent || "").trim());
    if (subs().length !== 2) throw new Error("subtab row missing: " + out.subs.join("/"));

    out.stage = "popular";
    subByText(/累计热度|Popular/).click();
    await waitHead(/共\s*\d+/, 50);
    out.pop = {
      head: head().slice(0, 40),
      sort: sortVal(),
      disabled: !!sortBtn().disabled,
      title: sortBtn().title || "",
      hasRange: !!q(".ssd-range-dp"),
      rangeVal: (q(".ssd-range-dp select") || {}).value,
      cards: document.querySelectorAll(".ssd-dp-card, .ssd-scene-card").length,
    };
    out.caches = popCaches();

    out.stage = "range7";
    const rs = q(".ssd-range-dp select");
    out.hasRangeSel = !!rs;
    if (rs) {
      rs.value = "7";
      rs.dispatchEvent(new Event("change", { bubbles: true }));
      await waitHead(/共\s*\d+/, 50);
      await sleep(1200);
      out.range7 = { head: head().slice(0, 40), caches: popCaches() };
    }

    out.stage = "back";
    if (q(".ssd-range-dp select")) {
      q(".ssd-range-dp select").value = "all";
      q(".ssd-range-dp select").dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(1500);
    }
    subByText(/近期热门|Recent/).click();
    await sleep(1500);
    out.backToTrending = {
      subs: subs().map((b) => (b.textContent || "").trim()),
      hasRange: !!q(".ssd-range-dp"),
      sort: sortVal(),
      disabled: !!sortBtn().disabled,
      title: sortBtn().title || "",
      head: head().slice(0, 40),
    };
    out.ok =
      out.pop.sort === "hot" &&
      out.pop.disabled === true &&
      out.pop.hasRange === true &&
      out.pop.rangeVal === "all" &&
      out.backToTrending.sort === "date-desc" &&
      out.backToTrending.disabled === false &&
      out.backToTrending.hasRange === false;
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    try {
      const t = subByText(/近期热门|Recent/);
      if (t) t.click();
    } catch (_) {}
  }
  return JSON.stringify(out);
})()
