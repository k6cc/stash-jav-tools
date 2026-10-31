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
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  }
  out.allPass = !out.fatal && out.verdict.every((v) => v.pass);
  return JSON.stringify(out, null, 1);
})()
