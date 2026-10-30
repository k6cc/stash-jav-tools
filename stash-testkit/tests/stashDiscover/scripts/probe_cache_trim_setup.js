// 准备：把 trending 缓存人为裁到 10 条（totalSeen 保持原值），模拟「预算砍条数」
(() => {
  let key = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (/^SSD:dp:[^:]+:trending\.v\d+$/.test(k)) { key = k; break; }
  }
  if (!key) return JSON.stringify({ err: 'no trending cache key' });
  const raw = localStorage.getItem(key);
  const e = JSON.parse(raw);
  const keep = Math.min(10, (e.scenes || []).length);
  e.scenes = (e.scenes || []).slice(0, keep);
  e.totalSeen = Math.max(e.totalSeen || 0, 30);
  e.fetchedAt = Date.now();   // 保证 fresh 命中，别触发 SWR 把测试数据冲掉
  localStorage.setItem(key, JSON.stringify(e));
  return JSON.stringify({ key, kept: e.scenes.length, totalSeen: e.totalSeen, bytes: localStorage.getItem(key).length });
})()
