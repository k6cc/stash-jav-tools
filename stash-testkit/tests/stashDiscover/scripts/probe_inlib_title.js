// K7「按标题认在库中」纯函数探针（2026-11-26）。不写库、不点 UI，只喂用例给
// SSD.titleMatch —— 判定规则回归就在这一处。
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_inlib_title.js)" \
//     --path /plugins/stashDiscover --settle 4 --timeout 60
(async () => {
  const out = { stage: "start" };
  const M = window.SSD && window.SSD.titleMatch;
  if (!M) return JSON.stringify({ error: "SSD.titleMatch missing（插件未加载？）" });

  // 只比标题：how(源标题, 本地标题, [演员名...])
  const how = (a, b, names) => M.how(a, b, names || []);
  out.stage = "how";
  out.cases = {
    exact: how("Foo Bar Baz", "foo-bar baz!"),                    // 归一化后相同
    nameStrip: how("Foo Bar Jane Doe", "Foo Bar", ["Jane Doe"]),  // 去掉演员名后相同
    nearWord: how("Foo Bar Baz 完全版", "Foo Bar Baz"),            // 多一个词 → near
    nearOverlap: how("Foo Bar Baz Qux", "Foo Bar Baz Zap"),        // 词重合 3/4 → near
    digitGuard: how("Foo Bar Baz 2", "Foo Bar Baz"),               // 数字词不同 → 不算
    digitGuardEpisode: how("Foo Bar E10", "Foo Bar E11"),          // 同上
    weakNameOnly: how("Jane Doe", "Jane Doe", ["Jane Doe"]),       // 纯演员名 → weak
    weakMismatch: how("Jane Doe", "Other Title", ["Jane Doe"]),    // 一边空一边非空 → 不算
    tooShort: how("Foo", "Foo Bar"),                               // 包含但太短 → 不算
    empty: how("", "Foo Bar"),
  };

  // 连日期/时长一起判：byTitle(源场景, 本地场景数组) → 命中那条或 null
  const byTitle = (sc, local) => M.byTitle(sc, local);
  out.stage = "byTitle";
  const src = (title, extra) =>
    Object.assign({ id: "s1", title: title, release_date: "2026-10-27", duration: 0, performers: [{ performer: { name: "Jane Doe" } }] }, extra || {});
  const local = (id, title, date, duration) => ({ id: id, title: title, date: date, duration: duration || 0 });
  const exactHit = byTitle(src("Foo Bar Baz"), [local("101", "Foo Bar Baz", "2020-01-01")]);
  const nearNoDate = byTitle(src("Foo Bar Baz 完全版"), [local("102", "Foo Bar Baz", "2020-01-01")]);
  const nearWithDate = byTitle(src("Foo Bar Baz 完全版"), [local("103", "Foo Bar Baz", "2026-10-20")]);
  const nearWithDur = byTitle(src("Foo Bar Baz 完全版", { duration: 7200 }), [local("104", "Foo Bar Baz", "2020-01-01", 7260)]);
  const digitNo = byTitle(src("Foo Bar Baz 2"), [local("105", "Foo Bar Baz", "2026-10-27")]);
  const weakNoDurNoDate = byTitle(src("Jane Doe"), [local("106", "Jane Doe", "2020-01-01", 0)]);
  out.byTitle = {
    exactHit: exactHit && exactHit.id,
    nearNoDate: nearNoDate && nearNoDate.id,      // 差 6 年又没时长 → null
    nearWithDate: nearWithDate && nearWithDate.id,
    nearWithDur: nearWithDur && nearWithDur.id,
    digitNo: digitNo && digitNo.id,
    weakNoDurNoDate: weakNoDurNoDate && weakNoDurNoDate.id,
  };

  out.ok =
    out.cases.exact === "exact" &&
    out.cases.nameStrip === "exact" &&
    out.cases.nearWord === "near" &&
    out.cases.nearOverlap === "near" &&
    out.cases.digitGuard === "" &&
    out.cases.digitGuardEpisode === "" &&
    out.cases.weakNameOnly === "weak" &&
    out.cases.weakMismatch === "" &&
    out.cases.tooShort === "" &&
    out.byTitle.exactHit === "101" &&
    out.byTitle.nearNoDate === null &&
    out.byTitle.nearWithDate === "103" &&
    out.byTitle.nearWithDur === "104" &&
    out.byTitle.digitNo === null &&
    out.byTitle.weakNoDurNoDate === null;
  return JSON.stringify(out);
})()
