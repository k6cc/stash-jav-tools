// 单次刷新后的状态行文案（F4：不再出现 updated just now + 失败并列）
// 用法：python stash-testkit/page_eval.py probe_status_refresh.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function(){
  var s=function(ms){return new Promise(function(r){setTimeout(r,ms)});};
  var q=function(x){return document.querySelector(x)};
  var t=0; while(t<40000 && !q(".ssd-dp-refresh")){await s(1500);t+=1500;}
  q(".ssd-dp-refresh").click();
  await s(22000);
  var up=q(".ssd-dp-updated"), chips=q(".ssd-dp-chips");
  return JSON.stringify({updated:up?up.textContent.trim():null, chips:chips?chips.textContent.replace(/\s+/g," ").trim():null});
})()
