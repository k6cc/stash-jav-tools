// 场景详情弹窗按钮区（2026-10-30）：三颗主按钮从旧 .ssd-btn 迁到 .ssd-dp-btn，
// 与「演员详情弹层」「已忽略管理」同源。本探针验四件事：
//   1) 四颗按钮的分类与配色（primary / 描边 / tonal / solid-ban）
//   2) 图标层独立于文案层：状态切换（准备中…）不会把图标抹掉
//   3) 换语言/换品牌名后 trail 图标仍在（updateOpenButtonLabel 只改文案层）
//   4) 与演员弹层「＋ 加入库」的圆角/字号/高度是否同一套（跨容器一致性）
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function snap(el) {
    var c = getComputedStyle(el);
    return {
      cls: el.className,
      text: (el.textContent || "").trim(),
      bg: c.backgroundColor,
      color: c.color,
      border: c.borderColor,
      radius: c.borderRadius,
      font: c.fontSize,
      h: Math.round(el.getBoundingClientRect().height),
      icons: el.querySelectorAll("svg").length,
      trail: !!el.querySelector(".ssd-dp-bico-trail"),
    };
  }
  var out = {};
  var card = document.querySelector(".ssd-card-grid .card");
  if (!card) return JSON.stringify({ err: "no scene card" });
  card.click();
  await sleep(1800);

  var acts = document.querySelector(".ssd-modal .ssd-modal-acts");
  if (!acts) return JSON.stringify({ err: "no .ssd-modal-acts" });
  var btns = [].slice.call(acts.children);
  out.count = btns.length;
  out.buttons = btns.map(snap);
  out.oldClassLeft = document.querySelectorAll(".ssd-modal .ssd-btn").length;

  // 状态切换：加入库 → 准备中… 时图标必须还在
  var save = btns[0];
  save.click();
  await sleep(500);
  out.preparing = snap(save);
  var imp = document.querySelector(".ssd-imp-close");
  if (imp) imp.click();
  await sleep(300);
  out.afterClose = snap(save);

  // 换语言（模拟品牌名重写）：trail 图标不能丢
  var open = acts.querySelector("[data-ssd-open-btn]");
  if (open) {
    open.querySelector("[data-ssd-lbl]").textContent = "Some Brand";
    out.openAfterRename = snap(open);
  }

  // 与演员弹层的「＋ 加入库」比同一套尺寸（演员弹层在发现页，需切页）
  out.sceneSave = { radius: out.buttons[0].radius, font: out.buttons[0].font, h: out.buttons[0].h };

  var x = document.querySelector(".ssd-modal-close");
  if (x) x.click();
  out.errors = 0;
  return JSON.stringify(out);
})()
