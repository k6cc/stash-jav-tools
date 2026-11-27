// 断源还原后的对照采集（与 probe_break_ui.js 配对）
// 用法：python stash-testkit/page_eval.py probe_after_restore.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function(){
  var s=function(ms){return new Promise(function(r){setTimeout(r,ms)});};
  var q=function(x){return document.querySelector(x)};
  var t=0; while(t<45000 && !q(".ssd-dp-chips b")){await s(1500);t+=1500;}
  var chips=q(".ssd-dp-chips"), up=q(".ssd-dp-updated");
  var secs=[].map.call(document.querySelectorAll(".ssd-dp-sec-count"),function(e){return e.textContent.trim().slice(0,40)}).slice(0,5);
  return JSON.stringify({t:t,chips:chips?chips.textContent.replace(/\s+/g," ").trim():null,
    updated:up?up.textContent.trim():null, tip:(chips&&chips.querySelector("b"))?chips.querySelector("b").parentNode.getAttribute("title"):null, secs:secs});
})()
