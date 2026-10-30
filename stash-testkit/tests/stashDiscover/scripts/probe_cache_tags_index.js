// tags 索引化 + 3 图 + totalSeen 的往返验证（走真实 cacheWrite / cacheRead 路径）
(async () => {
  const out = {};
  const findKey = () => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/^SSD:dp:[^:]+:trending\.v\d+$/.test(k)) return k;
    }
    return null;
  };

  // ── 1. 强制拉一次 trending → 内部走 cacheWrite ──
  out.stage = 'fetch';
  const t1 = await SSD.dp.getTrendingData({ force: true });
  out.fetchedItems = (t1.items || []).length;
  out.fetchTrim = t1.cacheTrim;

  const key = findKey();
  if (!key) return JSON.stringify({ err: 'no trending cache key' });
  const raw = localStorage.getItem(key);
  const e = JSON.parse(raw);
  const sc0 = e.scenes[0] || {};
  out.payload = {
    fmt: e.fmt,
    totalSeen: e.totalSeen,
    scenes: e.scenes.length,
    tagDictIsArray: Array.isArray(e.tagDict),
    tagDictLen: (e.tagDict || []).length,
    tagDictSample: (e.tagDict || []).slice(0, 3),
    tagsElemType: Array.isArray(sc0.tags) && sc0.tags.length ? typeof sc0.tags[0] : 'empty',
    tagsSample: (sc0.tags || []).slice(0, 4),
    imagesPerScene: (sc0.images || []).length,
    bytes: raw.length,
  };

  // ── 2. 再读一次（fresh 命中）→ hydrate 后必须是 [{name}] ──
  out.stage = 'hydrate';
  const t2 = await SSD.dp.getTrendingData();
  const it = (t2.items || [])[0] || {};
  const sc = it.scene || {};
  const tagOk = Array.isArray(sc.tags) && sc.tags.every((x) => x && typeof x.name === 'string');
  const dictTags = sc0.tags || [];
  const dict = e.tagDict || [];
  // 逐位比对：还原出来的名字必须和写进去的下标对得上
  const match = tagOk && sc.tags.length === dictTags.length &&
    sc.tags.every((t, i) => t.name === dict[dictTags[i]]);
  out.hydrated = {
    fromCache: t2.fromCache,
    tagOk, namesMatchDict: !!match,
    firstTag: (sc.tags[0] || {}).name || null,
    tagCount: (sc.tags || []).length,
    performerShapeOk: !!(sc.performers && sc.performers[0] && typeof sc.performers[0].performer === 'object'),
    tagDictLeaked: Object.prototype.hasOwnProperty.call(sc, 'tagDict'),
  };

  // ── 3. 老格式兼容：把条目改回 tags=[{name}]、删掉 tagDict，再读 ──
  out.stage = 'legacy';
  const legacy = JSON.parse(raw);
  legacy.scenes.forEach((s) => {
    if (Array.isArray(s.tags)) s.tags = s.tags.map((i) => ({ name: legacy.tagDict[i] }));
  });
  delete legacy.tagDict;
  delete legacy.totalSeen;
  const legacyStr = JSON.stringify(legacy);
  out.legacyBytes = legacyStr.length;
  out.newBytes = raw.length;
  out.savedBytes = legacyStr.length - raw.length;
  out.savedPct = (100 * (1 - raw.length / legacyStr.length)).toFixed(1) + '%';
  localStorage.setItem(key, legacyStr);
  let legacyOut = {};
  try {
    const t3 = await SSD.dp.getTrendingData();
    const s3 = ((t3.items || [])[0] || {}).scene || {};
    legacyOut = {
      fromCache: t3.fromCache,
      tagOk: Array.isArray(s3.tags) && s3.tags.every((x) => x && typeof x.name === 'string'),
      firstTag: (s3.tags[0] || {}).name || null,
      trimIsNull: !t3.cacheTrim,
    };
  } catch (err) {
    legacyOut = { threw: String((err && err.message) || err).slice(0, 160) };
  }
  out.legacy = legacyOut;

  // ── 4. 复原成新格式（别把测试数据留在用户缓存里）──
  localStorage.setItem(key, raw);
  const check = JSON.parse(localStorage.getItem(key));
  out.restored = { tagDictIsArray: Array.isArray(check.tagDict), bytes: localStorage.getItem(key).length };
  return JSON.stringify(out, null, 1);
})()
