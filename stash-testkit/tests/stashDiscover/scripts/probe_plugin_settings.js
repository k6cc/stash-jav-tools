// probe_plugin_settings.js — 设置项类型与旧 NUMBER 脏值回归
//
// 背景：`recentDays` / `jackettTimeout` 原来是 NUMBER，Stash 会把「没填」存成 0。
// 设置页因此永远显示一个 0（看着像「已设为 0」），后端还会把 Jackett 超时压到
// 下限 10 秒。2026-10-31 改成 STRING（同 previewDays，可留空），并在插件加载时
// 一次性删掉旧 NUMBER 留下的 0。
//
// 跑法：
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval \
//     "$(cat .../probe_plugin_settings.js)" --path / --timeout 90
//
// 只读，不写任何数据。
(async () => {
  const out = { verdict: [] };
  const check = (name, pass, detail) => out.verdict.push({ name, pass, detail });
  try {
    const d = await SSD.callGQL(
      "query{plugins{id settings{name type}} configuration{plugins}}"
    );
    const me = (d.plugins || []).find((p) => p.id === "stashDiscover") || {};
    const types = {};
    (me.settings || []).forEach((s) => { types[s.name] = s.type; });

    out.types = {
      recentDays: types.recentDays,
      jackettTimeout: types.jackettTimeout,
      previewDays: types.previewDays,
    };
    check("recentDays 是 STRING（可留空）", types.recentDays === "STRING", types.recentDays);
    check("jackettTimeout 是 STRING（可留空）", types.jackettTimeout === "STRING", types.jackettTimeout);

    const cfg = ((d.configuration || {}).plugins || {}).stashDiscover || {};
    out.legacy = {
      recentDays: cfg.recentDays,
      jackettTimeout: cfg.jackettTimeout,
      rdType: typeof cfg.recentDays,
      jtType: typeof cfg.jackettTimeout,
    };
    // JSON number 的 0 只可能来自旧 NUMBER 类型；字符串 "0" 是用户手填的（有语义）
    const bad = ["recentDays", "jackettTimeout"].filter(
      (k) => typeof cfg[k] === "number" && cfg[k] === 0
    );
    check("配置里没有旧 NUMBER 留下的 0", bad.length === 0, bad);

    // ── 用户手填 "0" 的语义（STRING 类型下存的是字符串，不会被迁移删掉）──
    // 语义：recentDays 0 = 不限；previewDays -1 = 隐藏 / 0 = 不限；jackettTimeout 0 = 默认
    const rc = SSD.recentCutoffDate, pc = SSD.previewCutoffDate;
    out.zero = {
      recent0: rc(0), recent30: rc(30), recentNeg: rc(-1),
      preview0: pc(0), previewM1: pc(-1), preview7: pc(7),
      // 演员 tab 走 parseInt(settings.recentDays)：字符串 "0" 必须是 0 而不是 NaN→180
      parseInt0: parseInt("0", 10),
      parseIntEmpty: String(parseInt("", 10)),
    };
    check("recentDays 填 0 → 不限（无截止日期）", rc(0) === null, out.zero.recent0);
    check("recentDays 填 -1 也按不限兜底", rc(-1) === null, out.zero.recentNeg);
    check("recentDays 填 30 → 生成截止日期", typeof rc(30) === "string" && rc(30).length === 10, out.zero.recent30);
    check("previewDays 填 0 → 不限", pc(0) === null, out.zero.preview0);    check("previewDays 填 -1 → 截止到今天（隐藏全部）", typeof pc(-1) === "string" && pc(-1) < pc(7), out.zero.previewM1);
    check("previewDays 填 7 → 今天+7", typeof pc(7) === "string" && pc(7) > pc(-1), out.zero.preview7);
    check('字符串 "0" 被 parseInt 成 0（不是 NaN→默认 180）', parseInt("0", 10) === 0, out.zero.parseInt0);
    check("留空才走默认（parseInt('') 是 NaN）", isNaN(parseInt("", 10)), out.zero.parseIntEmpty);
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  }
  out.allPass = !out.fatal && out.verdict.every((v) => v.pass);
  return JSON.stringify(out, null, 1);
})()
