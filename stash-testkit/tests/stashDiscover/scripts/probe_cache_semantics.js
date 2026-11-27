// 缓存语义：刷新期间旧数据常驻、换范围后的取数路径（C6 组 #22-#25）
// 用法：python stash-testkit/page_eval.py probe_cache_semantics.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (x, r) => (r || document).querySelector(x);
  const qa = (x, r) => Array.from((r || document).querySelectorAll(x));
  const page = () => q(".ssd-dp-page") || document.body;
  const tab = (name) => qa(".ssd-dp-tab").find((t) => t.textContent.trim() === name);
  const cards = () => qa(".scene-card", page());
  const title = () => (cards().length ? (cards()[0].innerText || "").replace(/\s+/g, " ").slice(0, 28) : "");
  const sel = () => q(".ssd-range-dp .ssd-range-sel");
  async function setRange(v) { const e = sel(); e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); }
  async function settle(ms) { for (let i = 0; i < 40; i++) { await s(500); if (cards().length && !q(".ssd-dp-grid.is-skel", page())) break; } await s(ms || 1000); }

  const prefs0 = localStorage.getItem("SSD:dp:prefs");
  tab("Trending").click(); await s(1500);
  const pop = qa(".ssd-dp-tab").find((t) => /Popular|累计/.test(t.textContent));
  if (pop && !pop.classList.contains("is-active")) pop.click();
  await settle(1200);

  const opts = qa("option", sel()).map((o) => o.value + "=" + o.textContent.trim());

  window.__f = 0;
  const of = window.fetch;
  window.fetch = function () { window.__f++; return of.apply(this, arguments); };

  // 1) Past week
  await setRange("7"); await settle(1500);
  const wk = { f: window.__f, n: cards().length, first: title(), val: sel().value, prefs: localStorage.getItem("SSD:dp:prefs") };

  // 2) Past week → Since（Phase 20 口径：落在窗口起点、不重查）
  const f0 = window.__f;
  await setRange("since"); await s(1400);
  const sn = { f: window.__f - f0, n: cards().length, first: title(), val: sel().value, date: (q(".ssd-range-dp .ssd-range-date") || {}).value || null, prefs: localStorage.getItem("SSD:dp:prefs") };
  await settle(1500);
  const sn2 = { n: cards().length, first: title(), fTotal: window.__f };

  // 3) 手改日期 → 必须重查
  const f1 = window.__f;
  const dt = q(".ssd-range-dp .ssd-range-date");
  let dateA = null, dateB = null;
  if (dt && dt.offsetParent) {
    dateB = dt.value;
    const d = new Date(Date.now() - 60 * 86400000);
    dateA = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    dt.value = dateA; dt.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await settle(2000);
  const ch = { f: window.__f - f1, n: cards().length, first: title(), from: dateB, to: dateA, prefs: localStorage.getItem("SSD:dp:prefs") };

  window.fetch = of;
  if (localStorage.getItem("SSD:dp:prefs") !== prefs0) {
    if (prefs0 === null) localStorage.removeItem("SSD:dp:prefs"); else localStorage.setItem("SSD:dp:prefs", prefs0);
  }
  return JSON.stringify({ opts: opts, week: wk, since: sn, sinceAfter: sn2, dateChange: ch, restored: localStorage.getItem("SSD:dp:prefs") === prefs0 });
})();
