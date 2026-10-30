// 「已忽略场景 → 多选模式再次忽略」安全性探针（用户 2026-10-30）：
//   A 幂等：重复忽略不写重复键、不改原记录 at、payload 字节数不变
//   B 不崩：window.onerror / unhandledrejection 计数为 0
//   C 只回滚本次新增：撤销不能把更早的忽略记录一起删掉
// 用例：先忽略 3 部（旧的）→ 开「查看已忽略」→ 全选 8 部再忽略（应只新增 5 部）
//      → 点撤销 → 应只剩最初那 3 部，且键集合与最初完全一致
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_reignore.js)" \
//     --path / --settle 5 --timeout 180
// 会真的写忽略记录，结束时按前后差集删掉（不碰用户原有记录）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errs: [] };
  window.addEventListener("error", (e) => out.errs.push("error: " + (e.message || "")));
  window.addEventListener("unhandledrejection", (e) => out.errs.push("reject: " + (e.reason && e.reason.message || e.reason)));
  const PERF = "/performers/34"; // Rei Kamiki：8 部待发现
  const q = (s) => document.querySelector(s);
  const btnByText = (re, root) =>
    Array.from((root || document).querySelectorAll("button")).find((b) => re.test(b.textContent || ""));
  const keysOf = () => Object.keys(SSD.dpIgnore.scenes()).sort();
  const raw = () => {
    try { const s = localStorage.getItem("SSD:dp:ignore.v1"); JSON.parse(s); return { ok: true, len: s.length }; }
    catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  };
  const toastText = () => ((q(".ssd-toast") || q(".Toast") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);

  const keysBefore = keysOf();
  try {
    await sleep(2500);
    const nav = q('a[href="/performers"]');
    if (nav) nav.click();
    await sleep(2500);
    window.history.pushState({}, "", PERF);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(3000);
    q(".ssd-nav-link").click();
    for (let i = 0; i < 25; i++) {
      await sleep(900);
      if (q(".ssd-tab-pane .ssd-scene-card")) break;
    }
    const pane = q(".ssd-tab-pane");
    if (!pane) throw new Error("no pane");
    const total = pane.querySelectorAll(".ssd-scene-card").length;
    out.total = total;

    // ── 1. 全选忽略 8 部 → 空态面板出现「查看已忽略」入口 ──
    out.stage = "ignore-all";
    q(".ssd-tabsel-btn").click();
    await sleep(600);
    q(".ssd-tabsel-all").click();
    await sleep(300);
    q(".ssd-tabsel-ignore").click();
    await sleep(1500);
    const all8 = keysOf().filter((k) => keysBefore.indexOf(k) < 0).sort();

    // ── 2. 打开「查看已忽略」→ 8 张卡都回来 ──
    out.stage = "show";
    btnByText(/查看已忽略|Show ignored/).click();
    await sleep(1200);
    out.shown = { cards: pane.querySelectorAll(".ssd-scene-card").length,
                  badges: pane.querySelectorAll(".ssd-overlay-ignored").length };

    // ── 3. 摘掉 3 条记录当「未忽略的」，留 5 条当「更早的忽略」（撤销后必须还在）──
    //    卡片仍在（showIgnored 下 cachedMissing 全给），所以 8 张卡照样能全选
    out.stage = "split";
    const old5 = all8.slice(0, 5).sort();
    const fresh3 = all8.slice(5);
    fresh3.forEach((k) => SSD.dpIgnore.remove("scenes", k));
    await sleep(300);
    const atOldBefore = JSON.stringify(old5.map((k) => SSD.dpIgnore.scenes()[k].at));
    out.split = { oldCount: old5.length, removed: fresh3.length, storeCount: SSD.dpIgnore.count().scenes };

    // ── 4. 全选 8 部（含 5 部已忽略）再点忽略 → 应当只新增 3 部 ──
    out.stage = "re-ignore";
    q(".ssd-tabsel-btn").click();
    await sleep(600);
    q(".ssd-tabsel-all").click();
    await sleep(400);
    q(".ssd-tabsel-ignore").click();
    await sleep(1600);
    const afterRe = keysOf().filter((k) => keysBefore.indexOf(k) < 0).sort();
    out.reignore = {
      toast: toastText(),
      cards: pane.querySelectorAll(".ssd-scene-card").length,
      badges: pane.querySelectorAll(".ssd-overlay-ignored").length,
      newTotal: afterRe.length,
      oldAtKept: JSON.stringify(old5.map((k) => SSD.dpIgnore.scenes()[k].at)) === atOldBefore,
      storeCount: SSD.dpIgnore.count().scenes,
      raw: raw(),
    };

    // ── 5. 撤销 → 只回滚本次新增的 3 部，更早那 5 部必须还在 ──
    out.stage = "undo";
    const undo = Array.from(document.querySelectorAll("button, a, span"))
      .find((b) => /^撤销$|^Undo$/.test((b.textContent || "").trim()));
    if (undo) {
      undo.click();
      await sleep(2200);
      const left = keysOf().filter((k) => keysBefore.indexOf(k) < 0).sort();
      out.undo = { clicked: true, leftCount: left.length,
                   equalsOld5: JSON.stringify(left) === JSON.stringify(old5),
                   cards: pane.querySelectorAll(".ssd-scene-card").length,
                   badges: pane.querySelectorAll(".ssd-overlay-ignored").length };
    } else out.undo = { clicked: false, note: "no undo button" };

    // 撤销后会整页重扫，卡片要等它回来
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (pane.querySelectorAll(".ssd-scene-card").length >= 8) break;
    }
    out.afterUndo = { cards: pane.querySelectorAll(".ssd-scene-card").length,
                      badges: pane.querySelectorAll(".ssd-overlay-ignored").length };

    // ── 6. 全选 8 部再忽略一次（此时 0 部已忽略）→ 应当新增 8 部 ──
    out.stage = "third-pass";
    q(".ssd-tabsel-btn").click();
    await sleep(600);
    q(".ssd-tabsel-all").click();
    await sleep(400);
    q(".ssd-tabsel-ignore").click();
    await sleep(1600);
    out.third = { toast: toastText(), storeCount: SSD.dpIgnore.count().scenes };
    // ── 7. 紧接着再来一次（8 部全已忽略）→ 应提示「都已在忽略列表里」而不是报存储失败 ──
    out.stage = "all-ignored";
    btnByText(/查看已忽略|Show ignored/).click();   // 回到可全选的 8 张卡
    await sleep(1200);
    q(".ssd-tabsel-btn").click();
    await sleep(600);
    q(".ssd-tabsel-all").click();
    await sleep(400);
    q(".ssd-tabsel-ignore").click();
    await sleep(1600);
    out.allIgnored = { toast: toastText(), storeCount: SSD.dpIgnore.count().scenes,
                       noErrorModal: !/写不进去|rejected/.test(document.body.textContent || "") };
    out.rawFinal = raw();
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    const now = keysOf();
    out.leftover = now.filter((k) => keysBefore.indexOf(k) < 0).length;
    now.filter((k) => keysBefore.indexOf(k) < 0).forEach((k) => SSD.dpIgnore.remove("scenes", k));
    out.cleanedTo = SSD.dpIgnore.count().scenes;
  }
  return JSON.stringify(out);
})()
