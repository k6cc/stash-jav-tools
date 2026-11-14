// 总览「骨架占位 + 模块局部刷新」回归（v2.8.0）
//
// 验什么：
//   1. 骨架态与落地态每个模块高度一致（不许跳）
//   2. 数据落地过程中页头元素身份不变（= 没有整页重建）
//   3. 整页高度全程不抖（docMin/docMax 差值）
//
// 跑法（同一目录下跑两次同样的命令）：
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat .../probe_overview_placeholder.js)" \
//     --path /plugins/stashDiscover --settle 1 --timeout 200
//   第一次返回 stage=cleaned（清了场景缓存，骨架还没机会出现）→ 直接重跑；
//   第二次在冷加载窗口里注入，采到骨架 → 等落地 → 输出对比。
//
// 为什么不能一条命令做完：骨架只在「无缓存 + 全新挂载」时出现，而 eval 注入前页面
// 已经导航过一次并且可能已落地。iframe 方案试过，Stash 前端在 iframe 里会被判跨域
// （127.0.0.1 与 localhost 不是同源），contentDocument 一律 SecurityError。
(async function () {
  var SCENE_CACHE = /^SSD:dp:.+:(newScenes|trending|studios)\.v\d+$/;
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  for (var w = 0; w < 200 && !document.querySelector(".ssd-dp-page"); w++) await sleep(100);
  var page = document.querySelector(".ssd-dp-page");
  if (!page) return JSON.stringify({ err: "没进发现页（.ssd-dp-page 不存在）" });

  var skelNow = !!document.querySelector(".ssd-dp-sec .is-skel");
  if (!skelNow) {
    var killed = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (SCENE_CACHE.test(k)) killed.push(k);
    }
    killed.forEach(function (k) { localStorage.removeItem(k); });
    return JSON.stringify({
      stage: "cleaned",
      killed: killed.length,
      hint: "缓存已清，重跑同一条命令即可采到骨架态",
    });
  }

  // ── 骨架期：打标记后开始采样 ────────────────────────────────────────
  var head = document.querySelector(".ssd-dp-head");
  var tagN = 0;
  Array.prototype.forEach.call(document.querySelectorAll(".ssd-dp-sec"), function (s) {
    s.setAttribute("data-probe-id", "p" + (tagN++));
  });

  function snap() {
    var secs = Array.prototype.map.call(document.querySelectorAll(".ssd-dp-sec"), function (s) {
      return {
        mod: s.getAttribute("data-mod") || "?",
        h: Math.round(s.getBoundingClientRect().height),
        skel: !!s.querySelector(".is-skel"),
      };
    });
    return {
      docH: Math.round(document.documentElement.scrollHeight),
      secs: secs,
      anySkel: secs.some(function (x) { return x.skel; }),
    };
  }

  var first = snap(), last = null, docMin = 1e9, docMax = 0, waits = 0;
  var deadline = performance.now() + 90000;
  while (performance.now() < deadline) {
    var s = snap();
    last = s;
    if (s.docH > 0) { docMin = Math.min(docMin, s.docH); docMax = Math.max(docMax, s.docH); }
    // 落地判据：没有骨架，且每块都有高度（避免彩排期的空盒）
    if (!s.anySkel && s.secs.length && !s.secs.some(function (x) { return x.h === 0; })) break;
    waits++;
    await sleep(250);
  }

  var headNow = document.querySelector(".ssd-dp-head");
  var prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("SSD:dp:prefs") || "{}"); } catch (_) {}
  function byMod(s) {
    var o = {};
    ((s && s.secs) || []).forEach(function (x) { o[x.mod] = x.h; });
    return o;
  }
  var a = byMod(first), b = byMod(last), diff = {};
  Object.keys(b).forEach(function (m) { if (a[m] != null) diff[m] = b[m] - a[m]; });

  return JSON.stringify({
    stage: "ok",
    csize: prefs.csize != null ? prefs.csize : 1,
    skel: a,
    final: b,
    diff: diff,
    worstDiff: Object.keys(diff).reduce(function (m, k) { return Math.max(m, Math.abs(diff[k])); }, 0),
    docMin: docMin === 1e9 ? null : docMin,
    docMax: docMax || null,
    docDelta: docMax ? docMax - docMin : null,
    headKept: !!headNow && headNow === head && headNow.isConnected, // true = 没有整页重建
    secTagsKept: Array.prototype.every.call(document.querySelectorAll(".ssd-dp-sec"), function (s) {
      return s.hasAttribute("data-probe-id");
    }),                                                            // false = 模块被替换过（局部刷新做了事）
    samples: waits,
  });
})()
