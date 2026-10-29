// 测量当前页面 localStorage 占用与配额上限，并列出可删的版本孤儿。
//
// 用法（在页面上下文执行，结果是一段 JSON）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_localstorage.js)" \
//     --path /plugins/stashDiscover --settle 3
//
// 口径说明：
// - 字符数按 UTF-16 code unit 计（即 key.length + value.length），与浏览器配额同一口径
// - 配额探测会临时写入递增长度的字符串再删掉，不影响既有键；QuotaExceeded 是预期结果
// - 孤儿判定只针对 cacheKey() 产出的场景缓存：SSD:dp:<host>:{newScenes|trending|studios}.v<N>。
//   别的键虽然也以 .v1 结尾（local / follow / unread / poll / trendingPerf），但那是独立
//   存储的版本号、不随 CACHE_FMT 变，不能当孤儿删。
(() => {
  const CURRENT = 3; // 与 discover.js 的 CACHE_FMT / cacheKey 版本号保持一致
  const PREFIX = "SSD:dp:";
  const CACHE_FAMILIES = "newScenes|trending|studios";
  const CACHE_RE = new RegExp("^SSD:dp:[^:]+:(" + CACHE_FAMILIES + ")\\.v(\\d+)$");

  let total = 0;
  const rows = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = localStorage.getItem(k) || "";
    total += k.length + v.length;
    rows.push({ k: k, chars: v.length });
  }
  rows.sort((a, b) => b.chars - a.chars);

  const byPrefix = {};
  rows.forEach(r => {
    const p = r.k.split(":")[0] || "(no-colon)";
    byPrefix[p] = (byPrefix[p] || 0) + r.chars + r.k.length;
  });

  const orphans = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k.indexOf(PREFIX) !== 0) continue;
    const m = k.match(CACHE_RE);
    if (m && Number(m[2]) !== CURRENT) {
      orphans.push({ k: k, chars: (localStorage.getItem(k) || "").length });
    }
  }
  const orphanChars = orphans.reduce((s, o) => s + o.chars + o.k.length, 0);

  // 配额上限：递增写入探测（写失败即 QuotaExceeded），写后立即删除
  const quota = [];
  for (const n of [1000000, 2000000, 3000000, 4000000, 5000000]) {
    const key = "__ssd_quota_probe__";
    try {
      localStorage.setItem(key, "x".repeat(n));
      quota.push({ n: n, ok: true });
    } catch (e) {
      quota.push({ n: n, ok: false, err: (e && e.name) || String(e) });
    }
    localStorage.removeItem(key);
  }

  return JSON.stringify({
    keys: rows.length,
    totalChars: total,
    byPrefix: byPrefix,
    orphans: orphans,
    orphanChars: orphanChars,
    quota: quota,
    top: rows.slice(0, 12),
  }, null, 1);
})()
