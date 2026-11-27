// 连点两次刷新，验证状态行不误报失败
// 用法：python stash-testkit/page_eval.py probe_status_twice.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function(){
  var s=function(ms){return new Promise(function(r){setTimeout(r,ms)});};
  var q=function(x){return document.querySelector(x)};
  var t=0; while(t<40000 && !q(".ssd-dp-refresh")){await s(1500);t+=1500;}
  q(".ssd-dp-refresh").click(); await s(20000);
  var up1=q(".ssd-dp-updated")?q(".ssd-dp-updated").textContent.trim():null;
  q(".ssd-dp-refresh").click(); await s(20000);
  return JSON.stringify({first:up1, second:q(".ssd-dp-updated")?q(".ssd-dp-updated").textContent.trim():null});
})()
