// 「缓存不完整」标记：切到热门 → chip 出现 → 点它 → 重拉后消失
// 需先跑 probe_cache_trim_setup.js 把缓存裁小
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = {};

  for (let i = 0; i < 24; i++) { if (q('.ssd-dp-tab')) break; await sleep(500); }

  const tabs = Array.from(document.querySelectorAll('.ssd-dp-tab'));
  const hot = tabs.find((t) => /^(热门|Trending)$/.test(t.textContent.trim()));
  if (!hot) return JSON.stringify({ err: 'no trending tab', tabs: tabs.map((t) => t.textContent.trim()) });
  hot.click();

  for (let i = 0; i < 30; i++) {
    await sleep(600);
    if (q('.ssd-dp-cachetrim') || q('.ssd-card-grid .ssd-scene-card')) break;
  }
  await sleep(800);

  const chip = q('.ssd-dp-cachetrim');
  out.before = {
    chipFound: !!chip,
    text: chip ? chip.textContent.trim() : null,
    title: chip ? chip.title : null,
    cards: document.querySelectorAll(".ssd-scene-card").length,
    count: (q('.ssd-dp-pcount') || {}).textContent || null,
  };

  if (!chip) return JSON.stringify(out, null, 1);

  // 点 chip → doRefresh：清该源缓存 + 重拉（trending 只有一页，很快）
  out.stage = 'click';
  chip.click();
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const stillChip = q('.ssd-dp-cachetrim');
    const cards = document.querySelectorAll('.ssd-scene-card').length;
    const pcount = (q('.ssd-dp-pcount') || {}).textContent || '';
    if (!stillChip && (cards > 0 || /共 \d+ 部/.test(pcount))) break;
  }
  out.after = {
    chipGone: !q('.ssd-dp-cachetrim'),
    cards: document.querySelectorAll('.ssd-scene-card').length,
    count: (q('.ssd-dp-pcount') || {}).textContent || null,
    stateText: (q('.ssd-state-title, .ssd-dp-state') || {}).textContent || null,
  };

  let key = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/^SSD:dp:[^:]+:trending\.v\d+$/.test(k)) { key = k; break; }
  }
  if (key) {
    const e = JSON.parse(localStorage.getItem(key));
    out.store = {
      n: (e.scenes || []).length,
      seen: e.totalSeen,
      trimmed: typeof e.totalSeen === 'number' && e.totalSeen > (e.scenes || []).length,
      tagDictIsArray: Array.isArray(e.tagDict),
      bytes: localStorage.getItem(key).length,
    };
  }
  return JSON.stringify(out, null, 1);
})()
