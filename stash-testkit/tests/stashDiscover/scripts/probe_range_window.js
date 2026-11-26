// K2「发行时间范围」验收探针（2026-11-26）：演员页「发现」tab 的工具栏范围下拉。
// 验：默认窗口条数 / 近一周变少 / 不限时间变多 / 恢复默认回原值 /
//     「自某日起」日期框可改、改完条数跟着变 / 切到「热度」时方向键禁用且 title 说明
//     只有「最多人匹配」在前 / 切回「日期」方向键恢复。
// 跑法（直接 --path /performers/43 会被 SPA 弹回首页，必须 pushState）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_range_window.js)" \
//     --path / --settle 5 --timeout 220
// 只点 UI、不改数据；结束时把范围与排序还原（会话内状态，不写偏好）。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { stage: "start" };
  const PERF = "/performers/43";
  const q = (s, r) => (r || document).querySelector(s);
  const total = () => {
    const t = Array.from(document.querySelectorAll(".ssd-count-info"))
      .map((x) => x.textContent || "").join(" | ");
    const m =
      t.match(/匹配\s*([\d,]+)\s*\/\s*([\d,]+)/) ||
      t.match(/([\d,]+)\s*matched\s*\/\s*([\d,]+)\s*found/i) ||
      t.match(/共\s*([\d,]+)/) ||
      t.match(/([\d,]+)\s*(个|total|found)/i);
    return m ? Number(m[1].replace(/,/g, "")) : -1;
  };
  const waitCount = async (want, steps) => {
    for (let i = 0; i < (steps || 40); i++) {
      await sleep(400);
      if (want(total())) return true;
    }
    return false;
  };
  const rangeSel = () => q(".ssd-range select");
  // 工具栏会整块重建：每次现取，取不到就等（切换范围后短暂会处于加载态）
  const setRange = async (key) => {
    for (let i = 0; i < 25; i++) {
      const s = rangeSel();
      if (s) {
        s.value = key;
        s.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      await sleep(300);
    }
    return false;
  };
  const dirBtn = () =>
    Array.from(document.querySelectorAll(".ssd-tab-toolbar button, .ssd-tab-pane button"))
      .find((b) => /降序|升序|Ascending|Descending|最多人匹配/i.test(b.title || ""));

  try {
    await sleep(2500);
    const nav = q('a[href="/performers"]');
    if (nav) nav.click();
    await sleep(2500);
    window.history.pushState({}, "", PERF);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await sleep(3000);
    q(".ssd-nav-link").click();
    for (let i = 0; i < 30; i++) {
      await sleep(900);
      if (q(".ssd-tab-pane .ssd-scene-card")) break;
    }
    if (!q(".ssd-tab-pane")) throw new Error("no pane");

    out.stage = "api";
    // 纯函数口径：日期补偿只在一处（dayBefore = cutoff 前一天）
    out.api = {
      days: SSD.range.days,
      minDate: SSD.range.minDate,
      dayBefore: SSD.range.dayBefore("2026-11-26"),
      defaultSince: SSD.range.defaultSince(),
      recentCut: SSD.range.recentCut(),
    };

    out.stage = "default";
    out.default = { range: rangeSel().value, total: total() };

    out.stage = "7d";
    await setRange("7");
    await waitCount((n) => n > 0 && n !== out.default.total, 40);
    out.week = { total: total(), range: rangeSel().value };

    out.stage = "all";
    await setRange("all");
    // 不限时间会懒加载，只要比默认多即可
    await waitCount((n) => n > out.default.total, 60);
    out.all = { total: total() };

    out.stage = "back";
    await setRange("");
    await waitCount((n) => n === out.default.total, 60);
    out.back = { total: total() };

    out.stage = "since";
    await setRange("since");
    let d = null;
    for (let i = 0; i < 25; i++) {
      d = q(".ssd-range-date") || q(".ssd-range input[type=date]");
      if (d) break;
      await sleep(400);
    }
    out.since = { hasDate: !!d, value: d ? d.value : "", min: d ? d.min : "" };
    if (d) {
      d.value = "2026-11-20";
      d.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(700); // 700ms 去抖之后才发请求
      await waitCount((n) => n > 0 && n !== out.default.total, 50);
      out.sinceChanged = { total: total() };
    }

    out.stage = "popularity";
    if (!(await setRange(""))) {
      out.skippedPopularity = "工具栏里没有范围下拉";
      throw new Error("no range select for sort test");
    }
    await sleep(1200);
    const toggle = q(".sort-by-select .dropdown-toggle");
    out.hasSortToggle = !!toggle;
    if (!toggle) throw new Error("no sort toggle");
    toggle.click();
    await sleep(300);
    const popItem = Array.from(document.querySelectorAll(".sort-by-select .dropdown-item"))
      .find((a) => /热度|Popularity/.test(a.textContent || ""));
    out.hasPopItem = !!popItem;
    if (popItem) {
      popItem.click();
      await sleep(1600);
      const db = dirBtn();
      out.pop = { dir: db ? db.title : "", disabled: db ? db.disabled : null };
      // 切回日期：方向键恢复
      q(".sort-by-select .dropdown-toggle").click();
      await sleep(300);
      Array.from(document.querySelectorAll(".sort-by-select .dropdown-item"))
        .find((a) => /日期|Date/.test(a.textContent || "")).click();
      await sleep(1400);
      const db2 = dirBtn();
      out.dateAgain = { dir: db2 ? db2.title : "", disabled: db2 ? db2.disabled : null };
    }
    out.ok = out.week.total > 0 && out.week.total <= out.default.total && out.all.total >= out.default.total;
  } catch (e) {
    out.error = String((e && e.message) || e) + " @" + (out.stage || "pre");
  } finally {
    try {
      if (rangeSel()) await setRange("");
    } catch (_) {}
  }
    return JSON.stringify(out);
})()

