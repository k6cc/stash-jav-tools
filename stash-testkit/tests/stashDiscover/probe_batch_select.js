// 批次7（§8 / §13.3）验收探针：发现页多选 + 批量忽略。
// 只读断言，不写库：忽略写的是 localStorage，测完立刻撤销并核对条数回到原值。
// 批量入库会真建场景，探针里不执行（单独手工测，见 NOTES）。
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_batch_select.js)" \
//     --path /plugins/stashDiscover --settle 5
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const cnt = () => document.querySelector(".ssd-dp-selcount")?.textContent || "";
  const bar = () => document.querySelector(".ssd-dp-toolbar");
  const cards = () => [...document.querySelectorAll(".ssd-dp-content .scene-card")];
  const ignBefore = SSD.dpIgnore.count().scenes;

  try {
    // ── 1. 进入多选：搜索框/更多收掉，selbar 出来，headrow 整行隐藏 ──
    const latestTab = [...document.querySelectorAll(".ssd-dp-tab")].find((x) => x.dataset.view === "latest");
    latestTab.click();
    await sleep(2500);
    // 视图模式是持久化偏好：上一轮跑成列表模式的话这里没有 .scene-card，
    // 先强制切回网格再往下测（第 5 步才主动切列表）
    const gridBtn = document.querySelectorAll(".ssd-dp-viewtoggle button")[0];
    if (gridBtn && !gridBtn.classList.contains("on")) {
      gridBtn.click();
      await sleep(1200);
    }
    document.querySelector(".ssd-dp-selbtn").click();
    await sleep(400);
    out.enter = {
      on: bar().classList.contains("is-selecting"),
      selbar: getComputedStyle(document.querySelector(".ssd-dp-selbar")).display,
      search: getComputedStyle(bar().querySelector('input[type="search"]')).display,
      headrow: (() => {
        const h = document.querySelector(".ssd-dp-headrow");
        return h ? getComputedStyle(h).display : "absent";
      })(),
      sticky: getComputedStyle(bar()).position,
      boxes: document.querySelectorAll(".ssd-dp-selbox").length,
      cards: cards().length,
      count: cnt(),
    };

    // ── 2. 点选 / 取消 / 不打开弹窗 ──
    const list = cards();
    list[0].click();
    await sleep(200);
    const s1 = { count: cnt(), isel: document.querySelectorAll(".scene-card.is-sel").length, modal: !!document.querySelector(".ssd-modal") };
    list[1].click();
    await sleep(200);
    const s2 = { count: cnt(), isel: document.querySelectorAll(".scene-card.is-sel").length };
    list[0].click();
    await sleep(200);
    const s3 = { count: cnt(), isel: document.querySelectorAll(".scene-card.is-sel").length };
    out.pick = { one: s1, two: s2, backToOne: s3 };

    // ── 3. 全选 / 取消全选（同时验「已选按钮」的 on 态）──
    const allBtn = document.querySelectorAll(".ssd-dp-selicon")[1];
    allBtn.click();
    await sleep(200);
    const a1 = { count: cnt(), isel: document.querySelectorAll(".scene-card.is-sel").length, on: allBtn.classList.contains("on") };
    allBtn.click();
    await sleep(200);
    const a2 = { count: cnt(), isel: document.querySelectorAll(".scene-card.is-sel").length, on: allBtn.classList.contains("on") };
    out.all = { all: a1, none: a2 };

    // ── 4. 批量忽略 + 撤销 ──
    list[0].click();
    list[1].click();
    await sleep(200);
    // 按文案取按钮：.ssd-dp-selact 有三个（关注 / 忽略 / 入库），querySelector 拿到的是「关注」，
    // 而它只对"选中的演员"生效 —— 只选了场景时是 disabled，点下去毫无反应，探针会假绿。
    const ignBtn = [...document.querySelectorAll(".ssd-dp-selact")].find((b) => /忽略|Ignore/.test(b.textContent));
    ignBtn.click();
    await sleep(900);
    const toast = document.querySelector(".ssd-toast");
    const ignAfter = SSD.dpIgnore.count().scenes;
    out.ignore = {
      before: ignBefore,
      after: ignAfter,
      cardsGone: list.length - cards().length,
      exited: !bar().classList.contains("is-selecting"),
      toast: toast ? toast.textContent.slice(0, 40) : "",
    };
    toast?.querySelector(".ssd-toast-act")?.click();
    await sleep(800);
    out.ignore.restored = SSD.dpIgnore.count().scenes;
    out.ignore.cardsBack = cards().length;

    // ── 5. 列表模式：行高亮 + 封面格的勾选圈 ──
    document.querySelector(".ssd-dp-selbtn").click();
    await sleep(300);
    document.querySelectorAll(".ssd-dp-viewtoggle button")[1].click();
    await sleep(1200);
    const rows = [...document.querySelectorAll(".ssd-scene-table tbody tr")];
    if (rows.length) {
      rows[0].click();
      await sleep(200);
      out.list = {
        rows: rows.length,
        isel: document.querySelectorAll(".ssd-scene-table tr.is-sel").length,
        boxes: document.querySelectorAll(".ssd-scene-table .ssd-dp-selbox").length,
        // 切视图后选择集要还在（选择态跨渲染保持）
        count: cnt(),
      };
    } else {
      out.list = { rows: 0 };
    }

    // ── 6. 退出：类与勾选圈全部清干净，搜索框回来 ──
    document.querySelector(".ssd-dp-selicon").click();
    await sleep(300);
    out.exit = {
      on: bar().classList.contains("is-selecting"),
      boxes: document.querySelectorAll(".ssd-dp-selbox").length,
      search: getComputedStyle(bar().querySelector('input[type="search"]')).display,
      cards: cards().length,
    };
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    // 兜底：无论哪步炸了都别把忽略记录留在库里
    if (SSD.dpIgnore.count().scenes !== ignBefore) {
      SSD.dpIgnore.restoreAll("scenes");
      out.cleanup = SSD.dpIgnore.count().scenes;
    }
  }
  return out;
})();
