// 演员详情「一次请求 + 缓存」回归（2026-10-30）：
// 弹层看过详情后，点「加入库」应当零 box 请求、预览即时出。
// 直接调 SSD 的两个入口验证（不依赖 UI 里能点到哪位演员）。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var cfg = await SSD.callGQL("query{configuration{general{stashBoxes{name endpoint api_key}}}}");
  var bs = (cfg.configuration.general.stashBoxes || []);
  var pickId = { stashdb: "573e7c3e-799c-4a3a-b948-32b5b18c16f1", javstash: "7ec0cb70-9667-4388-98d9-3c19bfe571f3" };
  var b = bs.filter(function (x) { return pickId[x.name] && /^https?:/.test(x.endpoint || ""); })[0];
  if (!b) return JSON.stringify({ err: "no box with known id" });
  var id = pickId[b.name];

  var host = b.endpoint.split("/")[2];
  var since = function (mark) {
    return performance.getEntriesByType("sectionresource").slice(mark);
  };
  function boxCount(from) {
    return performance.getEntriesByType("resource").slice(from).filter(function (e) {
      return e.name.indexOf(host) >= 0 && e.initiatorType !== "img" && e.initiatorType !== "link";
    }).length;
  }

  var out = { box: b.name, host: host };
  var m0 = performance.getEntriesByType("resource").length;
  var t0 = performance.now();
  var pf = await SSD.boxPerfDetail(b.endpoint, b.api_key, id, 20000);
  out.popup = { ms: Math.round(performance.now() - t0), boxReq: boxCount(m0), has: !!pf,
                fields: pf ? Object.keys(pf).length : 0 };

  // 第二次同类调用必须命中缓存（等价于「加入库」打开时用的那一次）
  var m1 = performance.getEntriesByType("resource").length;
  var t1 = performance.now();
  await SSD.boxPerfDetail(b.endpoint, b.api_key, id, 20000);
  out.cached = { ms: Math.round(performance.now() - t1), boxReq: boxCount(m1) };

  // 真实走一遍入库弹窗
  var m2 = performance.getEntriesByType("resource").length;
  var t2 = performance.now();
  var trace = [];
  var ow = window.onerror;
  window.onerror = function (e) { trace.push(String(e)); };
  SSD.openImportPerformer({
    endpoint: b.endpoint, apiKey: b.api_key, stashId: id,
    name: (pf && pf.name) || "cache-test", image: "",
    onDone: function (res) { out.done = res; },
  });
  await sleep(4000);
  out.import = {
    ms: Math.round(performance.now() - t2), boxReq: boxCount(m2),
    open: !!document.querySelector(".ssd-imp-overlay"),
    state: (document.querySelector(".ssd-imp-state") || {}).textContent || "",
    rows: [].slice.call(document.querySelectorAll(".ssd-imp-req .ssd-imp-row, .ssd-imp-body .ssd-imp-row")).
      map(function (r) { return (r.textContent || "").trim().slice(0, 18); }).slice(0, 8),
  };
  if (trace.length) out.errors = trace;
  window.onerror = ow;
  var x = document.querySelector(".ssd-imp-close");
  if (x) x.click();
  await sleep(300);
  return JSON.stringify(out);
})()
