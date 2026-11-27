// 断源态：点刷新后抓页头、状态行、各模块 state 文案（F3/F4/F5 断言）
// 用法：python stash-testkit/page_eval.py probe_break_ui.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function(){
  var s=function(ms){return new Promise(function(r){setTimeout(r,ms)});};
  var q=function(x){return document.querySelector(x)};
  var t=0; while(t<40000 && !q(".ssd-dp-refresh")){await s(1500);t+=1500;}
  var rb=q(".ssd-dp-refresh"); if(!rb) return JSON.stringify({err:"no refresh"});
  rb.click();
  await s(30000);
  var up=q(".ssd-dp-updated"), chips=q(".ssd-dp-chips");
  var secs=[].map.call(document.querySelectorAll(".ssd-dp-sec"),function(sec){
    var ttl=sec.querySelector(".ssd-dp-sec-title"), c=sec.querySelector(".ssd-dp-sec-count");
    var st=sec.querySelector(".ssd-dp-state");
    return ((ttl?ttl.textContent.trim():"?")+" | "+(c?c.textContent.trim():"-")+" | "+(st?st.textContent.replace(/\s+/g," ").trim().slice(0,60):"")).slice(0,110);
  });
  return JSON.stringify({updated:up?up.textContent.trim():null, chips:chips?chips.textContent.replace(/\s+/g," ").trim():null,
    chipTip:(chips&&chips.querySelector("b"))?chips.querySelector("b").parentNode.getAttribute("title"):null,
    secs:secs.slice(0,6)});
})()
