// 搜索结果：点击后滚动到底 + 渲染后抬头对齐 + 每条带索引器名
// 用法：stash_dev.py eval --path /plugins/stashDiscover "$(cat ...)" --vsize 1000x700
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const out = {};

  const m0 = q(".ssd-modal");
  if (m0) { const x = m0.querySelector(".ssd-modal-close"); if (x) x.click(); await sleep(400); }

  const card = q(".ssd-card-grid .card");
  if (!card) return "no card";
  card.click();
  await sleep(1800);

  const body = q(".ssd-modal .ssd-modal-body");
  out.modalIsScrollable = q(".ssd-modal").scrollHeight - q(".ssd-modal").clientHeight;

  q(".ssd-modal-acts").children[2].click();   // 搜索资源
  await sleep(400);
  q("[data-ssd-search-input]").value = "SSIS-001";

  const beforeTop = body.scrollTop;
  q("[data-ssd-search-bar] .ssd-dp-btn").click();

  await sleep(450);
  out.onClick = {
    top: Math.round(body.scrollTop),
    max: Math.round(body.scrollHeight - body.clientHeight),
  };

  for (let i = 0; i < 25; i++) { await sleep(800); if (q(".ssd-search-item")) break; }
  await sleep(1200);   // 等 smooth 滚动收尾

  const head = q(".ssd-search-header");
  const hb = head.getBoundingClientRect();
  const bb = body.getBoundingClientRect();
  out.afterRender = {
    top: Math.round(body.scrollTop),
    max: Math.round(body.scrollHeight - body.clientHeight),
    headerOffset: Math.round(hb.top - bb.top),
  };

  const rows = [].slice.call(document.querySelectorAll(".ssd-search-item")).slice(0, 5);
  out.pills = document.querySelectorAll(".ssd-search-item-indexer").length;
  out.rowsWithoutIndexer = [].slice.call(document.querySelectorAll(".ssd-search-item"))
    .filter((e) => !e.querySelector(".ssd-search-item-indexer")).length;
  out.sample = rows.map((e) => ({
    indexer: (e.querySelector(".ssd-search-item-indexer") || {}).textContent || null,
    meta: e.querySelector(".ssd-search-item-meta").textContent,
  }));
  out.beforeTop = Math.round(beforeTop);

  const pill = q(".ssd-search-item-indexer");
  if (pill) {
    const cs = getComputedStyle(pill);
    const mb = pill.getBoundingClientRect();
    out.pill = {
      color: cs.color, bg: cs.backgroundColor, border: cs.borderColor,
      fs: cs.fontSize, h: Math.round(mb.height), radius: cs.borderRadius,
      gap: getComputedStyle(pill.parentNode).gap,
    };
  }

  // 翻页也应对齐抬头
  const next = [].slice.call(document.querySelectorAll(".ssd-search-pager button")).pop();
  if (next) { next.click(); await sleep(900); }
  out.afterPage = {
    page: (q(".ssd-count-info") || {}).textContent,
    headerOffset: Math.round(q(".ssd-search-header").getBoundingClientRect().top -
      body.getBoundingClientRect().top),
  };

  const x = q(".ssd-modal-close"); if (x) x.click();
  return JSON.stringify(out);
})()
