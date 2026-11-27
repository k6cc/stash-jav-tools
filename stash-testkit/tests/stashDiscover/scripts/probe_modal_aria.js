// 弹窗无障碍：场景详情/演员详情/忽略记录/确认框的 role、aria-label、Esc 关闭
// 用法：python stash-testkit/page_eval.py probe_modal_aria.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  var s = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var q = function (x) { return document.querySelector(x); };
  var out = {};
  // 1) 场景详情弹窗
  var card = q(".ssd-scene-card");
  out.cards = document.querySelectorAll(".ssd-scene-card").length;
  if (card) {
    card.click();
    await s(2200);
    var m = q(".ssd-modal");
    out.scene = m ? {
      role: m.getAttribute("role"),
      ariaModal: m.getAttribute("aria-modal"),
      label: m.getAttribute("aria-label"),
      close: (q(".ssd-modal-close") || { getAttribute: function () { return null; } }).getAttribute("aria-label"),
    } : null;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await s(700);
    out.sceneClosed = !q(".ssd-modal");
  }
  // 2) 演员详情弹窗
  var mini = q(".ssd-dp-mini");
  if (mini) {
    mini.click();
    await s(2200);
    var pm = q(".ssd-dp-modal");
    out.perf = pm ? {
      role: pm.getAttribute("role"),
      ariaModal: pm.getAttribute("aria-modal"),
      label: pm.getAttribute("aria-label"),
      close: (q(".ssd-dp-modal-close") || { getAttribute: function () { return null; } }).getAttribute("aria-label"),
    } : null;
    var cb = q(".ssd-dp-modal-close");
    if (cb) { cb.click(); await s(600); }
    out.perfClosed = !q(".ssd-dp-modal");
  } else out.perf = "no mini";
  return JSON.stringify(out);
})();
