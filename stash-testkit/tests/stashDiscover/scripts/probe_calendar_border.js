// 日历卡：几何(212x209/表头56/日格24/箭头32)+表头与月下拉边线配色；同时可作为 C4 组回归
// 用法：python stash-testkit/page_eval.py probe_calendar.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (x, r) => (r || document).querySelector(x);
  const qa = (x, r) => Array.from((r || document).querySelectorAll(x));
  const log = [];
  const tab = qa(".ssd-dp-tab").find((t) => t.textContent.trim() === "Trending");
  if (tab) tab.click();
  await s(2500);
  const btn = q(".ssd-range-dp .ssd-range-cal");
  if (!btn) return JSON.stringify({ err: "no cal button", log });
  btn.click();
  for (let i = 0; i < 20; i++) { await s(400); if (q(".ssd-range-cal-pop")) break; }
  const cal = q(".ssd-range-cal-pop");
  if (!cal) return JSON.stringify({ err: "no pop", log });
  await s(600);
  const cr = cal.getBoundingClientRect();
  const hd = q(".react-datepicker__header", cal);
  const hcs = getComputedStyle(hd);
  const hdr = hd.getBoundingClientRect();
  const day = q(".react-datepicker__day:not(.react-datepicker__day--outside-month)", cal);
  const dr = day.getBoundingClientRect();
  const selDay = q(".react-datepicker__day--selected", cal);
  const nav = q(".react-datepicker__navigation", cal).getBoundingClientRect();
  let dd = null;
  const mv = q(".react-datepicker__month-read-view", cal);
  if (mv) {
    mv.click();
    await s(500);
    const el = q(".react-datepicker__month-dropdown", cal);
    if (!el) log.push("no month dropdown");
    else {
      const cs = getComputedStyle(el);
      dd = { border: cs.borderTopWidth + " " + cs.borderTopColor, bg: cs.backgroundColor };
      mv.click();
      await s(300);
    }
  }
  const bsBorder = getComputedStyle(document.documentElement).getPropertyValue("--bs-border-color").trim();
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  return JSON.stringify({
    card: [Math.round(cr.width), Math.round(cr.height)],
    header: Math.round(hdr.height),
    day: [Math.round(dr.width), Math.round(dr.height)],
    nav: [Math.round(nav.width), Math.round(nav.height)],
    selDayBg: selDay ? getComputedStyle(selDay).backgroundColor : null,
    headerBorder: hcs.borderBottomWidth + " " + hcs.borderBottomColor,
    headerBg: hcs.backgroundColor,
    dd,
    bsBorderColorVar: bsBorder || null,
    bodyBg,
    log,
  });
})();
