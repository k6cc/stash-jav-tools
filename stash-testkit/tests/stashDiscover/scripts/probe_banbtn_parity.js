// 忽略按钮外观回归（2026-10-30）：场景详情弹窗 vs 演员弹必须同一副样子。
// 两处的按钮现在都由 SSD.banButton() 生成（类名/图标/ arm 态都同源），
// 但场景弹窗挂在 body 上、不在 .ssd-dp-page 里 —— 本探针专治「token 拿不到」：
// 在两种容器里各造一颗，比对 idle / armed 的配色与尺寸。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function snap(el) {
    var c = getComputedStyle(el);
    var ico = el.querySelector(".ssd-dp-banico");
    var svg = el.querySelector("svg");
    return {
      bg: c.backgroundColor,
      color: c.color,
      border: c.borderColor,
      h: Math.round(el.getBoundingClientRect().height),
      icoColor: ico ? getComputedStyle(ico).color : (svg ? getComputedStyle(svg).color : "-"),
      label: (el.textContent || "").trim(),
    };
  }
  var out = { hasFactory: typeof SSD.banButton === "function" };

  var card = document.querySelector(".ssd-card-grid .card");
  if (!card) { out.err = "no scene card"; return JSON.stringify(out); }
  card.click();
  await sleep(1600);

  var ban = document.querySelector(".ssd-modal .ssd-dp-banbtn");
  if (!ban) {
    out.err = "no ban button";
    out.row = [].slice.call(document.querySelectorAll(".ssd-modal-acts > *")).map(function (x) {
      return x.className + " | " + (x.textContent || "").trim();
    });
    return JSON.stringify(out);
  }

  // 同一颗放演 pace 页：比较 token 是否在两种容器里一致
  var probe = SSD.banButton({ label: "忽略" });
  var host = document.querySelector(".ssd-dp-page") || document.body;
  host.appendChild(probe);

  out.idle = { sceneModal: snap(ban), perfPage: snap(probe) };
  out.rowHeights = [].slice.call(document.querySelectorAll(".ssd-modal-acts > *")).map(function (x) {
    return Math.round(x.getBoundingClientRect().height);
  });

  // token 缺失兜底：把关键变量置 invalid（对应「发现页硬开关关闭 →
  // discover.js 不注入 → 页面上没有 --sx-*」的真实场景）。idle 与 armed 都要验。
  ["--sx-ui3", "--sx-hi", "--sx-re", "--sx-re-d"].forEach(function (v) {
    ban.style.setProperty(v, "initial");
    probe.style.setProperty(v, "initial");
  });
  await sleep(200);
  out.noTokenIdle = { sceneModal: snap(ban), perfPage: snap(probe) };

  // armed：模拟二次确认那一下；只按一次，不会真的忽略
  ban.click();
  probe.click();
  await sleep(250);
  out.noTokenArmed = { sceneModal: snap(ban), perfPage: snap(probe) };

  probe.remove();
  if (typeof ban._armT === "number") clearTimeout(ban._armT);
  var x = document.querySelector(".ssd-modal-close");
  if (x) x.click();
  return JSON.stringify(out);
})()
