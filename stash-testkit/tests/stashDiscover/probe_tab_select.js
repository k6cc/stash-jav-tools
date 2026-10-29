// 批次7（§P6）验收探针：演员页「发现」tab 的多选 + 批量忽略。
// 只读断言，不写库（忽略测完还原）。批量入库会真建场景，不在探针里跑。
// 跑法（注意：直接 --path /performers/34 会被 SPA 重定向回首页，必须 pushState）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_tab_select.js)" \
//     --path / --settle 5 --timeout 90
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const PERF = "/performers/34"; // Rei Kamiki：stashdb + javstash 都有编号
  const ignBefore = SSD.dpIgnore.count().scenes;
  let pane = null;
  try {
    window.history.pushState({}, "", PERF);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(2500);
    document.querySelector(".ssd-nav-link").click();
    await sleep(7000);
    pane = document.querySelector(".ssd-tab-pane");
    if (!pane) throw new Error("no pane");

    // ── 1. 入口按钮存在，进入后 selbar 出来、搜索/分页收掉 ──
    const btn = pane.querySelector(".ssd-tabsel-btn");
    const n0 = pane.querySelectorAll(".ssd-scene-card").length;
    btn.click();
    await sleep(800);
    const bar = pane.querySelector(".ssd-tabsel");
    out.enter = {
      cards: n0,
      barOn: bar && bar.classList.contains("is-on"),
      boxes: pane.querySelectorAll(".ssd-dp-selbox").length,
      search: (() => {
        const s = pane.querySelector(".search-term-input");
        return s ? getComputedStyle(s).display : "absent";
      })(),
      pager: (() => {
        const p = pane.querySelector(".ssd-pager");
        return p ? getComputedStyle(p).display : "absent";
      })(),
      count: pane.querySelector(".ssd-tabsel-count").textContent,
    };

    // ── 2. 点选 / 取消 / 不开弹窗；勾选圈尺寸要正常（踩过：类名写成
    //      .ssd-selbox → 没有 CSS → SVG 撑爆整张卡）──
    const cards = () => [...pane.querySelectorAll(".ssd-scene-card")];
    cards()[0].click();
    await sleep(200);
    const box = cards()[0].querySelector(".ssd-dp-selbox");
    const s1 = {
      count: pane.querySelector(".ssd-tabsel-count").textContent,
      isel: pane.querySelectorAll(".scene-card.is-sel").length,
      modal: !!document.querySelector(".ssd-modal"),
      boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
    };
    cards()[1].click();
    await sleep(200);
    const s2 = { count: pane.querySelector(".ssd-tabsel-count").textContent, isel: pane.querySelectorAll(".scene-card.is-sel").length };
    cards()[0].click();
    await sleep(200);
    const s3 = { count: pane.querySelector(".ssd-tabsel-count").textContent, isel: pane.querySelectorAll(".scene-card.is-sel").length };
    out.pick = { one: s1, two: s2, backToOne: s3 };

    // ── 3. 全选 ──
    pane.querySelector(".ssd-tabsel-all").click();
    await sleep(200);
    out.all = { count: pane.querySelector(".ssd-tabsel-count").textContent, isel: pane.querySelectorAll(".scene-card.is-sel").length };
    pane.querySelector(".ssd-tabsel-all").click();
    await sleep(200);

    // ── 4. 批量忽略 + 撤销（cachedMissing 要一并摘掉，这一页不走 filterPipeline）──
    cards()[0].click();
    cards()[1].click();
    await sleep(200);
    pane.querySelector(".ssd-tabsel-ignore").click();
    await sleep(1000);
    const toast = document.querySelector(".ssd-toast");
    out.ignore = {
      before: ignBefore,
      after: SSD.dpIgnore.count().scenes,
      cardsGone: n0 - pane.querySelectorAll(".ssd-scene-card").length,
      exited: !pane.classList.contains("is-selecting"),
      toast: toast ? toast.textContent.slice(0, 40) : "",
    };
    toast?.querySelector(".ssd-toast-act")?.click();
    await sleep(800);
    out.ignore.restored = SSD.dpIgnore.count().scenes;

    // ── 5. Esc 退出 ──
    pane.querySelector(".ssd-tabsel-btn").click();
    await sleep(600);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(500);
    out.esc = {
      selecting: pane.classList.contains("is-selecting"),
      boxes: pane.querySelectorAll(".ssd-dp-selbox").length,
    };
  } catch (e) {
    out.error = String((e && e.message) || e);
  } finally {
    if (SSD.dpIgnore.count().scenes !== ignBefore) {
      SSD.dpIgnore.restoreAll("scenes");
      out.cleanup = SSD.dpIgnore.count().scenes;
    }
  }
  return out;
})();
