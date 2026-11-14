// 请求分布探针：按「查询签名」聚合 fetch 的次数 / 字节 / 耗时（v2.8.0）
//
// 用途：诊断「同一个查询是不是被打了很多枪」「哪个查询最贵」。
// 典型结论样例：一次刷新里 configuration{plugins} 打了 5 次、每次 24KB —— 那就是缺并发去重。
//
// 跑法：--path /plugins/stashDiscover（或 /），settle 建议 1~3
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat .../probe_req_dist.js)" \
//     --path /plugins/stashDiscover --settle 1 --timeout 120
// 脚本会先装 fetch 钩子、再点一次页面刷新按钮（.ssd-dp-refresh），采 12s。
// 要测冷加载：清掉 SSD:dp:<host>:*.v* 后重进页面，再跑本脚本并忽略那次刷新点击
// （页面刚加载时按钮可能还没出现，此时窗口内采到的就是冷加载请求）。
(async function () {
  var SECONDS = 12;
  var realFetch = window.fetch;
  var rows = {}, order = [];

  function sigOf(url, opt) {
    var body = opt && opt.body;
    if (typeof body !== "string") return "GET " + String(url).replace(location.origin, "").slice(0, 80);
    var q = "", vars = null;
    try {
      var o = JSON.parse(body);
      // 查询压成一行再截断：注释与换行会把同一个查询拆成多个签名
      q = String(o.query || "").replace(/\s+/g, " ").slice(0, 90);
      vars = o.variables || null;
    } catch (_) { q = String(body).slice(0, 90); }
    var hint = "";
    if (vars) {
      var first = vars.in || vars.input || vars.filter || vars;
      if (first && typeof first === "object") {
        if (first.page != null) hint = " page=" + first.page;
        else if (first.per_page != null) hint = " per=" + first.per_page;
      }
      if (vars.id) hint += " id";
    }
    return q + hint;
  }

  window.fetch = function (url, opt) {
    var u = typeof url === "string" ? url : (url && url.url) || "";
    var key = sigOf(u, opt);
    var t0 = performance.now();
    var p = realFetch.apply(this, arguments);
    p.then(function (r) {
      // clone 后读字节，避免动到调用方的 body
      return r.clone().text().then(function (txt) { return { r: r, n: txt.length }; },
        function () { return { r: r, n: 0 }; });
    }).then(function (o) {
      var rec = rows[key] || (rows[key] = { n: 0, bytes: 0, ms: [], status: {} });
      if (rec.n === 0) order.push(key);
      rec.n++;
      rec.bytes += o.n;
      rec.ms.push(Math.round(performance.now() - t0));
      rec.status[o.r.status] = (rec.status[o.r.status] || 0) + 1;
    }).catch(function () {});
    return p;
  };

  await new Promise(function (r) { setTimeout(r, 300); });
  // 页面自带数据缓存时窗口内可能一个请求都没有（探针会返回全 0）——
  // 自动点一次刷新按钮，测的正是「用户点刷新」这一轮
  var btn = document.querySelector(".ssd-dp-refresh");
  if (btn) btn.click();

  await new Promise(function (r) { setTimeout(r, SECONDS * 1000); });
  window.fetch = realFetch;

  var total = 0, totalBytes = 0;
  var list = order.map(function (k) {
    var rec = rows[k];
    var ms = rec.ms.slice().sort(function (a, b) { return a - b; });
    total += rec.n;
    totalBytes += rec.bytes;
    return {
      q: k,
      n: rec.n,
      bytes: rec.bytes,
      p50ms: ms[Math.floor(ms.length / 2)] || 0,
      maxMs: ms[ms.length - 1] || 0,
      status: rec.status,
    };
  }).sort(function (a, b) { return b.n - a.n || b.bytes - a.bytes; });

  // 只留最贵的几条，避免输出过长；完整分布看 byBytes
  return JSON.stringify({
    windowSec: SECONDS,
    totalRequests: total,
    totalBytes: totalBytes,
    byCount: list.slice(0, 8),
    byBytes: list.slice().sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 5),
  });
})()
