// 批次5（§7 / §7.1）验收探针：已忽略管理页 —— 搜索 / 切换 / 分页 / 恢复 / 还原全部 / 淘汰提示 / 渲染耗时。
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_ignored_page.js)" \
//     --path "/plugins/stashDiscover?view=ignored" --settle 5
// 会自动还原 ignore.v1。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IG = "SSD:dp:ignore.v1";
  const bk = localStorage.getItem(IG);
  const back = (v) => `\u0000${v}`;
  const out = {};
  try {
    // 造 40 部场景 + 5 位演员（含全角 / 分隔符写法，验归一化）
    const scenes = {}, performers = {};
    const names = ["ＡＩＫＡ", "Aika-Honda", "三上悠亜", "Yua Mikami"];
    for (let i = 0; i < 40; i++) {
      scenes["https://stashdb.org/graphql:seed-" + i] = {
        at: 1700000000000 + i * 1000,
        title: "Seed Scene " + i + " " + (i === 7 ? "ＡＩＫＡ" : ""),
        code: "SEED-" + i,
        date: "2026-01-" + String((i % 28) + 1).padStart(2, "0"),
        cover: "", studio: i % 2 ? "SOD Create" : "Moodyz",
        p: i === 7 ? ["Aika-Honda"] : ["演员" + (i % 5)],
      };
    }
    for (let i = 0; i < 5; i++) {
      performers["https://stashdb.org/graphql:pseed-" + i] = {
        at: 1700000000000 + i * 1000, name: names[i % names.length],
        image: "", alias_list: i === 0 ? ["Aika Honda", "AIKA"] : [],
      };
    }
    localStorage.setItem(IG, JSON.stringify({ scenes, performers, trimmed: 12 }));
    SSD.dpIgnore.reload();
    window.dispatchEvent(new CustomEvent("ssd:ignore-changed"));
    await sleep(400);

    out.headerCount = (document.querySelector(".ssd-dp-igncount") || {}).textContent;
    out.cards = document.querySelectorAll(".ssd-dp-igcard").length;
    out.trimNotice = (document.querySelector(".ssd-dp-igntrim") || {}).textContent;
    out.pagerBtns = document.querySelectorAll(".ssd-dp-pager .ssd-dp-pg").length;
    out.tabs = Array.from(document.querySelectorAll(".ssd-dp-igntabs .ssd-dp-tab")).map((b) => b.textContent);

    // 搜索：全角 ＡＩＫＡ vs 快照里的 Aika-Honda（NFKC + 剔分隔符）
    const input = document.querySelector(".ssd-dp-ignsearch input");
    input.value = "aika honda";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(350);
    out.searchHits = document.querySelectorAll(".ssd-dp-igcard").length;
    out.searchCountText = (document.querySelector(".ssd-dp-igncount") || {}).textContent;

    // 切到演员 tab：保留搜索词、重置页码
    document.querySelectorAll(".ssd-dp-igntabs .ssd-dp-tab")[1].click();
    await sleep(200);
    out.perfSearchValue = document.querySelector(".ssd-dp-ignsearch input").value;
    out.perfCards = document.querySelectorAll(".ssd-dp-igperf").length;

    // 清空搜索 → 5 位演员
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(350);
    out.perfCardsAll = document.querySelectorAll(".ssd-dp-igperf").length;

    // 单条恢复
    const rbtn = document.querySelector(".ssd-dp-igperf .ssd-dp-btn");
    if (rbtn) { rbtn.click(); await sleep(300); }
    out.perfAfterRestore = document.querySelectorAll(".ssd-dp-igperf").length;

    // 还原全部（演员组）→ 弹窗确认
    const allBtn = Array.from(document.querySelectorAll(".ssd-dp-igntools .ssd-dp-btn"))[0];
    allBtn.click();
    await sleep(250);
    const modal = document.querySelector(".ssd-dp-modal.ssd-dp-igmodal");
    out.confirmModal = !!modal;
    out.confirmText = modal ? modal.textContent.slice(0, 60) : null;
    const yes = modal && modal.querySelector(".ssd-dp-btn.primary");
    if (yes) { yes.click(); await sleep(300); }
    out.perfAfterRestoreAll = document.querySelectorAll(".ssd-dp-igperf").length;
    out.emptyStateText = (document.querySelector(".ssd-dp-state") || {}).textContent;

    // 渲染耗时（T4）：3,000 条 + 无搜索，切 tab 触发整页重建
    const big = {};
    for (let i = 0; i < 3000; i++) {
      big["https://stashdb.org/graphql:big-" + i] = {
        at: 1700000000000 + i, title: "Big Scene " + i, code: "BIG-" + i,
        date: "2026-02-01", cover: "", studio: "Studio " + (i % 30), p: ["Actor " + (i % 50)],
      };
    }
    localStorage.setItem(IG, JSON.stringify({ scenes: big, performers: {}, trimmed: 0 }));
    SSD.dpIgnore.reload();
    window.dispatchEvent(new CustomEvent("ssd:ignore-changed"));
    await sleep(400);
    const t0 = performance.now();
    document.querySelectorAll(".ssd-dp-igntabs .ssd-dp-tab")[1].click();
    const t1 = performance.now();
    document.querySelectorAll(".ssd-dp-igntabs .ssd-dp-tab")[0].click();
    const t2 = performance.now();
    out.render3000SwitchAway = Math.round(t1 - t0);
    out.render3000Back = Math.round(t2 - t1);
    out.render3000Cards = document.querySelectorAll(".ssd-dp-igcard").length;
    // 搜索命中最慢路径：扫 3000 条
    input.value = "big scene 2999";
    const t3 = performance.now();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    out.search3000InputToPaint = Math.round(performance.now() - t3);
    out.search3000Hits = document.querySelectorAll(".ssd-dp-igcard").length;
  } finally {
    if (bk === null) localStorage.removeItem(IG); else localStorage.setItem(IG, bk);
    SSD.dpIgnore.reload();
    window.dispatchEvent(new CustomEvent("ssd:ignore-changed"));
  }
  return JSON.stringify(out);
})()
