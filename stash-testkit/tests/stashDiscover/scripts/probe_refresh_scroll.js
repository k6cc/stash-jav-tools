// 刷新时的滚动位置探针：点一次页头刷新，每 200ms 采 scrollTop / scrollHeight，
// 只在变化时打点。用来抓「滚在底部，刷新后 / 加载完一分钟后自己跳回顶部」。
// 用法：stash_dev.py eval "$(cat …)" --path /plugins/stashDiscover --settle 4 --timeout 240
// 判据：正常 = 只有 "pre" 一行（位置不再变）；异常 = 出现 y 变小的行，且 scrollHeight 可能没变。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sc = () => document.scrollingElement || document.documentElement;
  const out = [];
  let ly = -1, lh = -1, t0 = 0;
  const sample = (tag) => {
    const y = Math.round(sc().scrollTop), h = sc().scrollHeight;
    if (y !== ly || h !== lh) {
      out.push({ stage: "sample", at: tag || Math.round((Date.now() - t0) / 1000) + "s", y: y, h: h });
      ly = y; lh = h;
    }
  };
  const mods = () => document.querySelectorAll(".ssd-dp-sec[data-mod]").length;
  await sleep(2500);
  if (!mods()) return JSON.stringify({ stage: "no-modules" });
  window.scrollTo(0, sc().scrollHeight);
  await sleep(600);
  sample("pre");
  const y0 = Math.round(sc().scrollTop);
  const btn = document.querySelector(".ssd-dp-refresh");
  if (!btn) return JSON.stringify({ stage: "no-refresh-button", y: y0 });
  t0 = Date.now();
  btn.click();
  while (Date.now() - t0 < 100000) { await sleep(200); sample(); }
  return JSON.stringify({
    stage: "done", startY: y0, endY: Math.round(sc().scrollTop),
    modules: mods(), trace: out,
  });
})()
