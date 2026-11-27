// 发现页 UI：主 tab 分行、工具栏几何、三视口适配（C3 组）
// 用法：python stash-testkit/page_eval.py probe_discover_ui.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (x, r) => (r || document).querySelector(x);
  const qa = (x, r) => Array.from((r || document).querySelectorAll(x));
  const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  const page = () => q(".ssd-dp-page");
  const tab = (n) => qa(".ssd-dp-tab", page()).find((t) => t.textContent.trim() === n);

  const out = { vw: innerWidth, docW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };

  // 主 tab 分行
  const tabs = qa(".ssd-dp-tab", page()).map((t) => ({ n: t.textContent.trim(), y: Math.round(t.getBoundingClientRect().top), r: R(t) }));
  const rows = {};
  tabs.forEach((t) => { (rows[t.y] = rows[t.y] || []).push(t.n); });
  out.tabRows = rows;

  // 工具栏（列表视图）
  tab("Latest").click(); await s(2500);
  const bar = q(".ssd-dp-page .ssd-dp-toolbar") || q(".ssd-dp-page .ssd-tb");
  out.bar = bar ? R(bar) : null;
  const kids = bar ? qa(":scope > *", bar).map((e) => ({ cls: (e.className || "").toString().slice(0, 24), r: R(e) })) : [];
  out.barKids = kids;
  out.barRows = Array.from(new Set(kids.map((k) => k.r[1])));

  // 分页按钮
  const pgs = qa(".ssd-dp-page .ssd-dp-pg button, .ssd-dp-page .ssd-dp-pg a, .ssd-dp-page .ssd-dp-pager button");
  out.pg = pgs.slice(0, 3).map(R);

  // 标签按钮
  const tb = q(".ssd-dp-page .ssd-dp-tagbtn");
  out.tagBtn = tb ? { r: R(tb), shadow: getComputedStyle(tb).boxShadow.slice(0, 40) } : null;

  // 日期控件（Trending › Popular + since）
  tab("Trending").click(); await s(2000);
  const pop = qa(".ssd-dp-tab", page()).filter((t) => t.textContent.trim() === "Popular");
  if (pop.length) pop[0].click();
  for (let i = 0; i < 30; i++) { await s(600); if (q(".ssd-range-dp .ssd-range-sel")) break; }
  const sel = q(".ssd-range-dp .ssd-range-sel");
  out.selArrow = sel ? getComputedStyle(sel).backgroundSize + " @ " + getComputedStyle(sel).backgroundPosition : null;
  if (sel) { sel.value = "since"; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  for (let i = 0; i < 20; i++) { await s(600); if (q(".ssd-range-dp .ssd-range-date")) break; }
  await s(800);
  const grp = q(".ssd-range-dp .ssd-range-since");
  const open = q(".ssd-range-dp .ssd-range-open");
  const date = q(".ssd-range-dp .ssd-range-date");
  const calb = q(".ssd-range-dp .ssd-range-cal");
  const svg = q(".ssd-range-dp .ssd-range-open svg");
  out.dateGroup = grp ? {
    group: R(grp),
    open: open ? R(open) : null,
    date: date ? R(date) : null,
    cal: calb ? R(calb) : null,
    svgW: svg ? Math.round(svg.getBoundingClientRect().width * 10) / 10 : null,
    svgH: svg ? Math.round(svg.getBoundingClientRect().height * 10) / 10 : null
  } : null;

  // 打开日历：卡片在视口内
  if (calb) { calb.click(); await s(900); }
  const pop2 = q(".ssd-range-cal-pop");
  out.cal = pop2 ? { r: R(pop2), inViewport: pop2.getBoundingClientRect().right <= innerWidth + 1 } : null;

  return JSON.stringify(out);
})();
