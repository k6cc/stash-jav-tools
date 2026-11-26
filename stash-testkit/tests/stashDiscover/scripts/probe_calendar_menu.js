/* probe_calendar_menu.js
 * 验「自某日起」自绘日历卡：整套已改成 Stash 原生 react-datepicker 的结构与类名（Phase 13）。
 * 用法：python stash_dev.py eval (Get-Content -Raw probe_calendar_menu.js) --path "/" --vsize 1440x900 --settle 6
 * 只读：只打开卡片、点下拉、切月/切年、Esc，不点「确定」。
 */
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (x, r) => (r || document).querySelector(x);
  const qa = (x, r) => Array.from((r || document).querySelectorAll(x));
  const ok = [];
  const need = (name, cond) => ok.push((cond ? "ok:" : "FAIL:") + name);

  window.history.pushState({}, "", "/performers/43");
  dispatchEvent(new PopStateEvent("popstate"));
  await s(3200);
  q(".ssd-nav-link").click();
  for (let i = 0; i < 30; i++) {
    await s(900);
    if (q(".ssd-tab-pane .ssd-range-sel")) break;
  }
  const sel = q(".ssd-range-sel");
  sel.value = "since";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  await s(500);
  const btn = q(".ssd-range-since .ssd-range-cal");
  btn.click();
  await s(600);
  const cal = q(".ssd-range-cal-pop");
  need("卡片打开", !!cal);
  need("按原生类名渲染(div.react-datepicker)", !!cal && cal.classList.contains("react-datepicker"));
  need("卡片宽 212", Math.round(cal.getBoundingClientRect().width) === 212);
  need("日历按钮按下态", btn.classList.contains("on"));
  need("绝对定位(没被 .react-datepicker 的 relative 顶掉)", getComputedStyle(cal).position === "absolute");

  const cr = cal.getBoundingClientRect();
  const head = q(".react-datepicker__header", cal);
  const hr = head.getBoundingClientRect();
  need("头部 56 高", Math.round(hr.height) === 56);
  const dd = q(".react-datepicker__header__dropdown", cal).getBoundingClientRect();
  need("月份+年份居中(±2px)", Math.abs((dd.left + dd.right) / 2 - (cr.left + cr.right) / 2) <= 2);
  need("表头 6px 起(上下留白不长)", Math.round(dd.top - cr.top) === 6);

  const mRv = q(".react-datepicker__month-read-view", cal);
  const yRv = q(".react-datepicker__year-read-view", cal);
  need("月份/年份是原生 read-view", !!mRv && !!yRv);
  need("读值 13.216px/700", mRv && getComputedStyle(mRv).fontSize === "13.216px" && getComputedStyle(mRv).fontWeight === "700");

  const prev = q(".react-datepicker__navigation--previous", cal);
  const next = q(".react-datepicker__navigation--next", cal);
  const pr = prev.getBoundingClientRect();
  const nr = next.getBoundingClientRect();
  need("翻月按钮 32×32 贴两侧", Math.round(pr.width) === 32 && Math.round(cr.left + 3 - pr.left) === 0);
  need("右箭头也贴边", Math.round(nr.width) === 32 && Math.round(nr.right - (cr.right - 3)) === 0);
  const pb = getComputedStyle(q(".react-datepicker__navigation-icon", prev), "::before");
  need("箭头本体 9×9/2.67px", pb.width === "9px" && parseFloat(pb.borderTopWidth) > 2.5);

  const wd = qa(".react-datepicker__day-name", cal).map((e) => e.textContent);
  need("星期缩写同原生 Su..Sa", wd.join(",") === "Su,Mo,Tu,We,Th,Fr,Sa");
  const dn = q(".react-datepicker__day-name", cal).getBoundingClientRect();
  need("星期格 24×24", Math.round(dn.width) === 24 && Math.round(dn.height) === 24);
  const day = q(".react-datepicker__day:not(.react-datepicker__day--outside-month)", cal).getBoundingClientRect();
  need("日格 24×24", Math.round(day.width) === 24 && Math.round(day.height) === 24);
  const selDay = q(".react-datepicker__day--selected", cal);
  need("选中日走原生 --selected", !!selDay);
  need("选中色 rgb(33,107,165)", selDay && getComputedStyle(selDay).backgroundColor === "rgb(33, 107, 165)");

  // 月份下拉
  mRv.click();
  await s(400);
  const mm = q(".ssd-range-cal-menu");
  need("月份菜单弹出", !!mm);
  need("菜单用原生 __month-dropdown", !!mm && mm.classList.contains("react-datepicker__month-dropdown"));
  need("月份 12 项", mm && mm.children.length === 12);
  need("选项用原生 __month-option", !!mm && mm.children[0].classList.contains("react-datepicker__month-option"));
  need("菜单底色吃主题 rgb(32,43,51)", !!mm && getComputedStyle(mm).backgroundColor === "rgb(32, 43, 51)");
  need("当前项带 ✓ span", !!mm && !!q(".react-datepicker__month-option--selected", mm));
  const mr = mm.getBoundingClientRect();
  need("菜单不越出卡片", mr.left >= cr.left - 1 && mr.right <= cr.right + 1);

  const feb = Array.from(mm.children).find((c) => /February|2 月/.test(c.textContent));
  feb && feb.click();
  await s(600);
  // 切月会整卡重建，旧的 cal 引用已失效，重新取
  const cal2 = q(".ssd-range-cal-pop");
  need("切月后菜单自动关", !q(".ssd-range-cal-menu"));
  need("切月后读值变 February", !!cal2 && /February/.test(q(".react-datepicker__month-read-view", cal2).textContent));
  need("February 渲染 28 个本月格", !!cal2 && qa(".react-datepicker__day:not(.react-datepicker__day--outside-month)", cal2).length === 28);

  // 年份下拉
  q(".react-datepicker__year-read-view", cal2).click();
  await s(400);
  const ym = q(".ssd-range-cal-menu");
  need("年份菜单弹出(原生 __year-dropdown)", !!ym && ym.classList.contains("react-datepicker__year-dropdown"));
  const n = ym ? ym.children.length : 0;
  need("年份项 > 100", n > 100);
  need("年份末项=1900", ym && ym.children[n - 1].textContent.trim() === "1900");
  const y2025 = ym && Array.from(ym.children).find((c) => c.textContent.trim() === "2025");
  y2025 && y2025.click();
  await s(600);
  const cal3 = q(".ssd-range-cal-pop");
  need("切年生效", !!cal3 && /2025/.test(q(".react-datepicker__year-read-view", cal3).textContent));

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await s(300);
  need("Esc 关卡片", !q(".ssd-range-cal-pop"));
  need("关卡片后按钮回常态", !btn.classList.contains("on"));

  return JSON.stringify({ ok: ok.every((x) => x.indexOf("ok:") === 0), detail: ok });
})();
