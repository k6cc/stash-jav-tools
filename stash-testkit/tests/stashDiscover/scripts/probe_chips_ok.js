// 正常态页头：chips 文案/计数/tip 与各模块副标题（F3-F5 对照基线）
// 用法：python stash-testkit/page_eval.py probe_chips_ok.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function(){
  var s=function(ms){return new Promise(function(r){setTimeout(r,ms)});};
  var q=function(x){return document.querySelector(x)};
  var t=0; while(t<45000 && !q(".ssd-dp-chips b")){await s(1500);t+=1500;}
  var chips=q(".ssd-dp-chips"), up=q(".ssd-dp-updated");
  return JSON.stringify({t:t,chips:chips?chips.textContent.replace(/\s+/g," ").trim():null,
    updated:up?up.textContent.trim():null, tip:chips?chips.getAttribute("title"):null,
    secs:[].map.call(document.querySelectorAll(".ssd-dp-sec-count"),function(e){return e.textContent.trim().slice(0,50)}).slice(0,6)});
})()
