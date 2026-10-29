// 回归：忽略快照字段 + 导出结构 + 导入握手（结构已定稿，v1 不再改）
//
// 快照字段（见 README「忽略记录」表）：场景 at/title/date/code/cover/studio/p，
// 演员 at/name/image/alias_list/country/birthdate/gender —— 每个都必须有读取点，
// 加字段前先想清楚"管理页哪一行会用它"，否则只是配额。
//
// 断言：
//   1) 超长文本被 IGN_TEXT_CAP 截断（title 200 / studio 80 / code 40 / date 20 /
//      name 120 / alias 60），URL 不截（截断即断链）
//   2) 场景 / 演员记录的键集合恒定 —— 导出文件结构可预期
//   3) 导出顶层 = {version, exportedAt, trimmed, scenes, performers}
//   4) 重复导入 → 全部 skipped；清空后导入 → 全部 added
//   5) 脏文件（坏键 / 值非对象）→ 计入 invalid 而不是静默丢弃；
//      version > 1 → fileVersion 回报；多余字段不透传
//
// 跑法（**会临时清空忽略记录，跑完自动还原原值**）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval --path /plugins/stashDiscover --settle 5 \
//     "$(cat E:/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_ign_export.js)"
(async function () {
  var D = SSD.dpIgnore;
  var KEY = "SSD:dp:ignore.v1";
  var backup = localStorage.getItem(KEY);   // 收尾要原样写回，别洗掉用户的真实记录
  var out = {};
  D.restoreAll("scenes");
  D.restoreAll("performers");
  D.reload();

  var long = function (n) { return new Array(n + 1).join("长"); };
  D.ignoreScene({
    endpoint: "https://stashdb.org/graphql",
    images: [{ url: "https://img.example/cover.jpg" }],
    scene: {
      id: "audit1", title: long(300), release_date: "2024-03-01", code: "ZZZ-999",
      studio: { name: new Array(120).join("S") },
      performers: [{ performer: { name: "演员甲" } }, { performer: { name: "演员乙" } }],
    },
  });
  D.ignorePerformer({
    endpoint: "https://stashdb.org/graphql", stashId: "pf-audit",
    name: new Array(200).join("N"), image: "https://img.example/a.jpg",
    aliases: ["别名1", "别名2", "别名3"], country: "JP", birthdate: "1999-04-05", gender: "FEMALE",
  });

  var st = D.store();
  var sc = st.scenes["https://stashdb.org/graphql:audit1"] || {};
  var pf = st.performers["https://stashdb.org/graphql:pf-audit"] || {};
  out.clip = {
    titleLen: (sc.title || "").length, studioLen: (sc.studio || "").length,
    nameLen: (pf.name || "").length,
    sceneKeys: Object.keys(sc).sort(), perfKeys: Object.keys(pf).sort(),
  };

  var txt = D.exportJSON();
  var o = JSON.parse(txt);
  out.export = { keys: Object.keys(o), bytes: txt.length };

  var imp1 = D.importJSON(txt);
  out.reimport = { added: imp1.added, skipped: imp1.skipped, invalid: imp1.invalid, ver: imp1.fileVersion };

  D.restoreAll("scenes");
  D.restoreAll("performers");
  D.reload();
  var imp2 = D.importJSON(txt);
  out.fresh = { added: imp2.added, skipped: imp2.skipped, ver: imp2.fileVersion, count: D.count() };

  var dirty = JSON.stringify({
    version: 9, exportedAt: "2030-01-01T00:00:00Z", trimmed: 7,
    scenes: {
      "no-colon-key": { at: 1, title: "x" },
      "https://stashdb.org/graphql:ok1": {
        at: 5, title: "正常", code: "A-1", date: "2024-01-01",
        studio: "S", cover: "", p: ["P1"], evil: "should-drop",
      },
      "https://stashdb.org/graphql:bad1": "not-an-object",
    },
    performers: {},
  });
  var imp3 = D.importJSON(dirty);
  var got = D.scenes()["https://stashdb.org/graphql:ok1"];
  out.dirty = {
    added: imp3.added, skipped: imp3.skipped, invalid: imp3.invalid, ver: imp3.fileVersion,
    keys: got ? Object.keys(got).sort() : null,      // 不该出现 evil
  };

  // 收尾：还原跑之前的真实记录
  try {
    if (backup) localStorage.setItem(KEY, backup);
    else localStorage.removeItem(KEY);
  } catch (e) { /* 配额满也不影响结论 */ }
  D.reload();
  out.restored = true;
  return JSON.stringify(out);
})()
