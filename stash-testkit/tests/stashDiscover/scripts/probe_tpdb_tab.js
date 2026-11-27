// 源切换：TPDB 下 trending tab 文案/悬停说明，切回后复原
// 用法：python stash-testkit/page_eval.py probe_tpdb_tab.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (x) => Array.from(document.querySelectorAll(x));
  const tabEl = () => qa(".ssd-dp-tab").find((t) => /data-view/.test(t.outerHTML) && t.dataset && t.dataset.view === "trending");
  const snap = (tag) => {
    const t = tabEl();
    if (!t) return { tag: tag, err: "no trending tab" };
    const sp = t.querySelector("span");
    return { tag: tag, label: sp ? sp.textContent.trim() : null, title: t.getAttribute("title") };
  };
  const srcSel = qa("select").find((s2) => Array.from(s2.options).some((o) => o.value === "theporndb"));
  if (!srcSel) return JSON.stringify({ err: "no source select" });
  const orig = srcSel.value;
  const out = { orig: orig, before: snap("javastash"), steps: [] };

  // 切到 TPDB
  srcSel.value = "theporndb";
  srcSel.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 25; i++) {
    await s(800);
    const st = snap("tpdb@" + (i * 0.8).toFixed(1) + "s");
    if (st.label && st.label !== out.before.label) { out.steps.push(st); break; }
    if (i === 24) out.steps.push(st);
  }
  await s(1500);
  out.onTPDB = snap("tpdb-final");

  // 切回 javastash
  srcSel.value = orig;
  srcSel.dispatchEvent(new Event("change", { bubbles: true }));
  for (let i = 0; i < 25; i++) {
    await s(800);
    const st = snap("back@" + (i * 0.8).toFixed(1) + "s");
    if (st.label && st.label !== out.onTPDB.label) { out.steps.push(st); break; }
    if (i === 24) out.steps.push(st);
  }
  await s(1500);
  out.after = snap("back-final");
  out.prefs = localStorage.getItem("SSD:dp:prefs");
  return JSON.stringify(out);
})();
