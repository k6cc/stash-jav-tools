// 移动端贴顶诊断（用户 2026-10-30 第 2 条：移动端多选态贴顶会空出一节）
// 量：Stash 顶栏的 position/height、sticky 元素的 top/实际位置、滚动后的间隙
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_mobile_stick.js)" \
//     --path / --settle 5 --vsize 390x844 --timeout 200
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { vw: innerWidth };
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), l: Math.round(b.left), w: Math.round(b.width) }; };
  try {
    // ── A) 演员页「发现」tab ──
    window.history.pushState({}, "", "/performers/34");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(4000);
    const nav = document.querySelector("nav.top-nav") || document.querySelector("nav.navbar");
    const navCS = nav ? getComputedStyle(nav) : null;
    out.nav = { cls: nav ? nav.className : null, rect: rect(nav), pos: navCS && navCS.position, z: navCS && navCS.zIndex, overflow: navCS && navCS.overflow };
    out.stickVar = getComputedStyle(document.documentElement).getPropertyValue("--ssd-stick-top").trim();
    const navLink = document.querySelector(".ssd-nav-link");
    if (navLink) navLink.click();
    await sleep(8000);
    const pane = document.querySelector(".ssd-tab-pane");
    const selBtn = pane && pane.querySelector(".ssd-tabsel-btn");
    if (selBtn) selBtn.click();
    await sleep(900);
    const bar = pane && pane.querySelector(".filtered-list-toolbar");
    out.tabSel = { pos: bar && getComputedStyle(bar).position, top: bar && getComputedStyle(bar).top, rect0: rect(bar), h: bar && Math.round(bar.getBoundingClientRect().height) };
    document.scrollingElement.scrollTop = 800;
    await sleep(400);
    out.tabSel.scrolled = { rect: rect(bar), navRect: rect(nav), gap: bar && nav ? Math.round(bar.getBoundingClientRect().top - nav.getBoundingClientRect().bottom) : null };
    document.scrollingElement.scrollTop = 0;

    // ── B) 发现页多选 ──
    window.history.pushState({}, "", "/plugins/stashDiscover?view=overview");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(9000);
    const page = document.querySelector(".ssd-dp-page");
    const sb = page && page.querySelector(".ssd-dp-selbtn");
    if (sb) sb.click();
    await sleep(700);
    const tbar = page && page.querySelector(".ssd-dp-toolbar");
    out.dpSel = {
      pos: tbar && getComputedStyle(tbar).position,
      top: tbar && getComputedStyle(tbar).top,
      rect0: rect(tbar),
      h: tbar && Math.round(tbar.getBoundingClientRect().height),
    };
    // 多选态里各控件的位置（移动端重叠诊断）
    const selbar = page && page.querySelector(".ssd-dp-selbar");
    const tools = page && page.querySelector(".ssd-dp-tools");
    const view = page && page.querySelector(".ssd-dp-viewtoggle");
    const kids = selbar ? Array.from(selbar.children).map((n) => ({ cls: (n.className || "").slice(0, 28), rect: rect(n) })) : [];
    out.dpSel.layout = {
      selbar: rect(selbar), tools: rect(tools), view: rect(view),
      toolsPos: tools && getComputedStyle(tools).position,
      selbarW: selbar && Math.round(selbar.getBoundingClientRect().width),
      kids,
      barW: tbar && Math.round(tbar.getBoundingClientRect().width),
    };
    // 各按钮高度是否一致
    out.dpSel.heights = {};
    ["ssd-dp-selicon", "ssd-dp-selact", "ssd-dp-selbtn", "ssd-dp-viewtoggle button", "ssd-dp-toolbar select"].forEach((q) => {
      const el = page && page.querySelector("." + q.replace(/ /g, "."));
      out.dpSel.heights[q] = el ? { h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) } : null;
    });
    // 重叠：任意两个直接子元素矩形相交？
    const ov = [];
    const barRect = tbar ? tbar.getBoundingClientRect() : null;
    const all = tbar ? Array.from(tbar.querySelectorAll(":scope > .ssd-dp-selbar > *, :scope > .ssd-dp-tools > *")) : [];
    const rs = all.map((n) => ({ cls: (n.className || n.tagName).slice(0, 24), r: n.getBoundingClientRect() })).filter((x) => x.r.width > 0);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i].r, b = rs[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
        ov.push(rs[i].cls + " × " + rs[j].cls);
      }
    }
    out.dpSel.overlaps = ov;
    document.scrollingElement.scrollTop = 900;
    await sleep(400);
    out.dpSel.scrolled = { rect: rect(tbar), navRect: rect(nav), gap: tbar && nav ? Math.round(tbar.getBoundingClientRect().top - nav.getBoundingClientRect().bottom) : null };
  } catch (e) {
    out.error = String((e && e.stack) || e);
  }
  return JSON.stringify(out, null, 1);
})()
