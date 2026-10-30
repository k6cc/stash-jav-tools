// 「临时查看已忽略」（用户 2026-10-30）验收探针：演员页「发现」tab 的片全被忽略后，
// 空态面板给出查看入口，打开后卡片带「已忽略」徽章、能一键恢复隐藏。
// 跑法（直接 --path /performers/34 会被 SPA 弹回首页，必须 pushState）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_ignored_show.js)" \
//     --path / --settle 5 --timeout 120
// 会真的写忽略记录，结束时按前后差集删掉（不碰用户原有记录）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const PERF = "/performers/34"; // Rei Kamiki：8 部待发现
  const q = (s) => document.querySelector(s);
  // 只按文案找按钮：面板里按钮不多，按位置取容易点到别的
  const btnByText = (re, root) =>
    Array.from((root || document).querySelectorAll("button")).find((b) => re.test(b.textContent || ""));

  const keysBefore = Object.keys(SSD.dpIgnore.scenes());
  try {
    await sleep(2500);
    const nav = q('a[href="/performers"]');
    if (nav) nav.click();
    await sleep(2500);
    window.history.pushState({}, "", PERF);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(3000);
    q(".ssd-nav-link").click();
    for (let i = 0; i < 25; i++) {
      await sleep(900);
      if (q(".ssd-tab-pane .ssd-scene-card")) break;
    }
    const pane = q(".ssd-tab-pane");
    if (!pane) throw new Error("no pane");

    // ── 1. 全选忽略 → 空态面板 ──
    const total = pane.querySelectorAll(".ssd-scene-card").length;
    out.stage = "ignore-all";
    q(".ssd-tabsel-btn").click();
    await sleep(600);
    q(".ssd-tabsel-all").click();
    await sleep(300);
    q(".ssd-tabsel-ignore").click();
    await sleep(1400);
    const panelTitle = (q(".ssd-panel-title, .ssd-state-title") || {}).textContent || "";
    out.allIgnored = {
      total: total,
      cards: pane.querySelectorAll(".ssd-scene-card").length,
      title: panelTitle,
      desc: ((q(".ssd-panel-desc") || {}).textContent || "").trim().slice(0, 60),
      hasBtn: !!btnByText(/查看已忽略|Show ignored/),
      // 关键回归：忽略记录不能把卡片从 cachedMissing 里摘掉，否则再也拿不回来
      stored: SSD.dpIgnore.count().scenes,
    };

    // ── 2. 打开查看 → 卡片回来、每张都有「已忽略」徽章 ──
    out.stage = "show";
    btnByText(/查看已忽略|Show ignored/).click();
    await sleep(1200);
    const cards = pane.querySelectorAll(".ssd-scene-card");
    out.shown = {
      cards: cards.length,
      badges: pane.querySelectorAll(".ssd-overlay-ignored").length,
      selboxes: pane.querySelectorAll(".ssd-dp-selbox").length,
      chip: ((q(".ssd-window-row") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
      count: ((q(".ssd-count-info") || {}).textContent || "").slice(0, 40),
    };

    // ── 3. 恢复隐藏 → 回到空态 ──
    out.stage = "hide";
    const hide = Array.from(document.querySelectorAll(".ssd-window-row button"))
      .find((b) => /恢复隐藏|Hide again/.test(b.textContent || ""));
    if (hide) hide.click();
    await sleep(900);
    out.hidden = {
      cards: pane.querySelectorAll(".ssd-scene-card").length,
      title: (q(".ssd-panel-title, .ssd-state-title") || {}).textContent || "",
      chipGone: !q(".ssd-window-row"),
    };
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    // 清理：只删本次新增的忽略记录
    Object.keys(SSD.dpIgnore.scenes())
      .filter((k) => keysBefore.indexOf(k) < 0)
      .forEach((k) => SSD.dpIgnore.remove("scenes", k));
    out.cleaned = SSD.dpIgnore.count().scenes;
  }
  return JSON.stringify(out);
})()
