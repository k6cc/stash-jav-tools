// K1「标签筛选」验收探针（2026-11-26）：演员页「发现」tab 的标签面板。
// 验：面板列出标签与条数 / 点一下＝必须有（列表＝该标签条数）/ 再点＝排除（总数−该标签）/
//     再点＝不限（回到总数）/ 两个标签 OR ≥ max、AND ≤ min / 「清除」回到总数 /
//     面板搜索框按名字过滤（IME 之外的普通输入）/ 徽章数与规则数一致。
// 跑法（直接 --path /performers/43 会被 SPA 弹回首页，必须 pushState）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_tag_filter.js)" \
//     --path / --settle 5 --timeout 180
// 只点 UI、不改数据；结束时清掉规则（不写偏好）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stage: "start" };
  const PERF = "/performers/43"; // AIKA：46 部待发现、标签够多
  const q = (s, r) => (r || document).querySelector(s);
  const cards = () => document.querySelectorAll(".ssd-card-grid .scene-card, .ssd-scene-card").length;
  // 计数行有两种口径：不带筛选时「共 N 个」，带筛选时「匹配 N / M」。
  // 取「当前列表里有多少条」＝ 匹配的那个数（没有筛选时就是 共 N）
  const total = () => {
    const t = Array.from(document.querySelectorAll(".ssd-count-info"))
      .map((x) => x.textContent || "").join(" | ");
    const m = t.match(/匹配\s*([\d,]+)\s*\/\s*([\d,]+)/)
      || t.match(/([\d,]+)\s*matched\s*\/\s*([\d,]+)\s*found/i)
      || t.match(/共\s*([\d,]+)/)
      || t.match(/([\d,]+)\s*(个|total|found)/i);
    return m ? Number(m[1].replace(/,/g, "")) : -1;
  };
  const rowsInfo = () =>
    Array.from(document.querySelectorAll(".ssd-tagf-row")).map((r) => ({
      name: ((r.querySelector(".ssd-tagf-name") || {}).textContent || "").trim(),
      n: Number((((r.querySelector(".ssd-tagf-cnt") || {}).textContent || "0").match(/\d+/) || [0])[0]),
    }));
  const rowOf = (name) =>
    Array.from(document.querySelectorAll(".ssd-tagf-row")).find(
      (r) => ((r.querySelector(".ssd-tagf-name") || {}).textContent || "").trim() === name
    );
  const stable = async (want, ms) => {
    // 点完要等重绘 + 计数更新，直接读会读到中间态
    for (let i = 0; i < (ms || 20); i++) {
      await sleep(250);
      if (want()) return true;
    }
    return false;
  };

  try {
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

    out.stage = "open-panel";
    out.base = total();
    q(".ssd-tagf-btn").click();
    await sleep(900);
    const rows = rowsInfo();
    out.panel = {
      rows: rows.length,
      first3: rows.slice(0, 3),
      // 面板里每个标签的条数都得 ≤ 总数（计数口径取自「已拉到的场景」）
      overBase: rows.filter((r) => r.n > out.base).length,
    };
    if (!rows.length || !rows[0].n) throw new Error("no tagged rows");
    const A = rows.filter((r) => r.n > 0 && r.n < out.base)[0] || rows[0];
    const B = rows.filter((r) => r.name !== A.name && r.n > 0)[0];

    out.stage = "inc";
    rowOf(A.name).click();
    await stable(() => total() === A.n);
    out.inc = { name: A.name, n: A.n, total: total(), cards: cards(), badge: !!q(".ssd-tagf-btn .ssd-tagf-n") };
    out.stage = "exc";
    rowOf(A.name).click();
    await stable(() => total() === out.base - A.n || total() !== A.n);
    out.exc = { total: total(), expect: out.base - A.n, cards: cards() };

    out.stage = "off";
    rowOf(A.name).click();
    await stable(() => total() === out.base);
    out.off = { total: total(), cards: cards() };

    out.stage = "or-and";
    rowOf(A.name).click();
    await sleep(500);
    rowOf(B.name).click();
    await stable(() => total() > 0);
    out.or = { a: A.n, b: B.n, total: total(), max: Math.max(A.n, B.n) };
    const all = q(".ssd-tagf-mode input");
    if (all) {
      all.checked = true;
      all.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(900);
    }
    out.and = { total: total(), min: Math.min(A.n, B.n) };

    out.stage = "panel-search";
    const inp = q(".ssd-tagf-q");
    inp.value = A.name.slice(0, 2);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(600);
    out.search = {
      rows: rowsInfo().length,
      allMatch: rowsInfo().every((r) => r.name.toLowerCase().indexOf(A.name.slice(0, 2).toLowerCase()) >= 0),
    };
    inp.value = "";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);

    out.stage = "clear";
    const clear = q(".ssd-tagf-clear");
    if (clear) clear.click();
    await stable(() => total() === out.base);
    out.cleared = { total: total(), cards: cards(), badges: document.querySelectorAll(".ssd-tagf-n").length };
    // 判定：必须有＝该标签条数；排除＝总数−该标签；不限＝回到总数；OR ≥ max；AND ≤ min
    out.ok =
      out.inc.total === A.n &&
      out.exc.total === out.base - A.n &&
      out.off.total === out.base &&
      out.or.total >= Math.max(A.n, B.n) &&
      out.and.total <= Math.min(A.n, B.n) &&
      out.cleared.total === out.base;
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    // 清理：把规则清空（面板里「清除」按钮，没有就直接点已选中的行还原）
    try {
      const clear = q(".ssd-tagf-clear");
      if (clear && !clear.hidden) clear.click();
    } catch (_) {}
  }
  return JSON.stringify(out);
})()

