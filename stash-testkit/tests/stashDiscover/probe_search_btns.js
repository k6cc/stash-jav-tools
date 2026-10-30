// 搜索结果行内按钮（2026-10-30）：从旧 .ssd-btn 迁到 .ssd-dp-btn 后验外观。
// 走 SSD.renderSearchResults() 灌假数据 —— Jackett 没配也能验样式。
// 覆盖：复制磁力（ghost）/ 推送下载（tonal）/ 打开链接（ghost）/ 分页（ghost）
//       / 低匹配折叠条的「显示」（ghost）+ 成功态 ok 是不是绿实心白字。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function snap(el) {
    var c = getComputedStyle(el);
    return {
      cls: el.className,
      text: (el.textContent || "").trim(),
      bg: c.backgroundColor,
      color: c.color,
      radius: c.borderRadius,
      font: c.fontSize,
      h: Math.round(el.getBoundingClientRect().height),
    };
  }
  var card = document.querySelector(".ssd-card-grid .card");
  if (!card) return JSON.stringify({ err: "no scene card" });
  card.click();
  await sleep(1800);

  var sec = document.querySelector("[data-ssd-search]");
  if (!sec) { var x0 = document.querySelector(".ssd-modal-close"); if (x0) x0.click(); return JSON.stringify({ err: "no search section" }); }

  var items = [];
  for (var i = 0; i < 25; i++) {
    items.push({
      title: "JUVR-304 sample " + i + (i === 1 ? " 1080p" : ""),
      size_human: (1 + i) + " GB",
      seeders: i, leechers: 1, indexer: "idx-" + i,
      // 留一条纯 link（无 magnet）走「打开链接」分支
      magnet: i === 2 ? undefined : "magnet:?xt=urn:btih:" + i,
      link: i === 2 ? "https://example.com/x" : undefined,
    });
  }
  SSD.renderSearchResults(sec, { query: "JUVR-304", count: 25, results: items });
  await sleep(200);

  var out = {};
  out.itemBtn = [].slice.call(sec.querySelectorAll(".ssd-search-item-actions > *")).slice(0, 2).map(snap);
  out.pager = [].slice.call(sec.querySelectorAll(".ssd-search-pager > *")).map(function (e) {
    return e.tagName === "BUTTON" ? snap(e) : (e.className + " | " + e.textContent);
  });
  out.lowBtn = [].slice.call(sec.querySelectorAll(".ssd-search-lowmatch > button")).map(snap);

  // 成功/失败态：临时加类读色，读完还原（不真的走推送）
  var push = [].slice.call(sec.querySelectorAll(".ssd-search-item-actions > button")).pop();
  if (push) {
    // 按钮有 0.15s transition：加完类必须等过渡走完再读，否则读到的是旧色
    push.classList.add("ok");
    await sleep(260);
    out.pushOk = snap(push);
    push.classList.remove("ok");
    push.classList.add("err");
    await sleep(260);
    out.pushErr = snap(push);
    push.classList.remove("err");
  }
  out.oldStyleLeft = sec.querySelectorAll(".ssd-btn").length;

  var x = document.querySelector(".ssd-modal-close");
  if (x) x.click();
  return JSON.stringify(out);
})()
