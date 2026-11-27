// node 单测（不经浏览器）：tagMissingText 中英两分支。用法 node test_tag_missing.js zh|en
// F1 语言分支单测：把 tagMissingText 的字符串分支原样搬出来跑两种语言
var _state = {
  boxTagMissing: { "https://stashdb.org/graphql": ["中出", "巨乳"], "https://javastash.org/graphql": ["Narrative"] },
  queryBoxes: [
    { endpoint: "https://stashdb.org/graphql", name: "stashdb.org" },
    { endpoint: "https://javastash.org/graphql", name: "javstash" },
  ],
};
function sourceLabel(b) { return b.name === "stashdb.org" ? "StashDB" : b.name; }
function isZh() { return process.argv[2] === "zh"; }
function tagMissingText(zh) {
  var names = [];
  Object.keys(_state.boxTagMissing || {}).forEach(function (ep) {
    var b = (_state.queryBoxes || []).filter(function (x) { return x.endpoint === ep; })[0];
    var label = b ? sourceLabel(b) : ep;
    var tags = _state.boxTagMissing[ep] || [];
    if (!tags.length) return;
    names.push(zh ? label + " 缺少标签「" + tags.join("、") + "」· 已跳过"
      : label + " has no tag " + tags.join(", ") + " · skipped");
  });
  return names.join(isZh() ? "；" : "; ");
}
console.log(tagMissingText(isZh()));
