// 验收：返回键关闭弹窗（论坛 26 楼 p0rnb0x 2026-10-29，移动端没有 × 顺手）
//
// 机制：弹窗打开时 modalBack.hold() 用 pushState 压一条**同 URL** 的记录，
// 返回键退的是这条（pathname 不变 → Stash 路由认为没动，卡片 DOM 不重建），
// popstate 里关最上层弹窗；按 × 关闭时 release() 再把这条吃掉，
// 否则用户以后得多按一次返回键才离得开页面。
//
// 断言三件事：① pathname 全程不变 ② 开窗时 history.state.ssdBack > 0
// ③ 关窗后 state 回到 null（垫层没残留）
//
// 跑法（需登录态，脚本会自己判断有没有垫层再按返回键，不会真退页）：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval --path /plugins/stashDiscover --settle 5 \
//     "$(cat E:/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_back_key.js)"
//
// 覆盖 7 个弹窗；缺数据的段会跳过并在结果里标 no-data。
// D/E 要先造忽略记录：先跑 seed_ign_test.js。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var byText = function (sel, txt) {
    return [].slice.call(document.querySelectorAll(sel)).filter(function (e) {
      return (e.textContent || "").indexOf(txt) !== -1;
    })[0];
  };
  var st = function () {
    var s = history.state;
    return s && s.ssdBack ? "layer:" + s.ssdBack : "null";
  };
  // 只在真有我们的垫层时才按返回键 —— 否则会把整个插件页退掉
  var back = async function () {
    var s = history.state;
    if (!s || !s.ssdBack) return "no-layer";
    history.back();
    await sleep(1000);
    return "ok";
  };
  var out = {};
  var path0 = location.pathname;

  // A) 场景详情：返回键关闭
  var card = document.querySelector(".ssd-card-grid .card");
  if (card) {
    card.click();
    await sleep(1000);
    out.sceneBack = { opened: !!document.querySelector(".ssd-modal-overlay"), stateOpen: st() };
    out.sceneBack.back = await back();
    out.sceneBack.closed = !document.querySelector(".ssd-modal-overlay");
    out.sceneBack.stateAfter = st();
    out.sceneBack.pathKept = location.pathname === path0;
  } else out.sceneBack = "no-data";

  // B) 场景详情：× 关闭 → 不留垫层（再按返回键应当直接退页，这里只查 state）
  var card2 = document.querySelector(".ssd-card-grid .card");
  if (card2) {
    card2.click();
    await sleep(1000);
    var x = document.querySelector(".ssd-modal-close");
    if (x) x.click();
    await sleep(1000);
    out.sceneX = {
      closed: !document.querySelector(".ssd-modal-overlay"),
      stateAfter: st(),
      cards: document.querySelectorAll(".card").length,
    };
  } else out.sceneX = "no-data";

  // C) 演员弹层（「发现演员」视图的迷你卡；总览的卡点进去是演员过滤视图，不是弹层）
  var perfTab = byText(".ssd-dp-tab", "发现演员");
  if (perfTab) {
    perfTab.click();
    await sleep(2500);
  }
  var mini = document.querySelector(".ssd-dp-mini");
  if (mini) {
    mini.click();
    await sleep(1300);
    out.perfModal = { opened: !!document.querySelector(".ssd-dp-modal-overlay"), stateOpen: st() };
    out.perfModal.back = await back();
    out.perfModal.closed = !document.querySelector(".ssd-dp-modal-overlay");
    out.perfModal.stateAfter = st();
  } else out.perfModal = "no-data";

  // D/E) 已忽略管理：详情弹窗 + 还原全部确认
  var setTab = document.querySelector(".ssd-dp-tab.set");
  if (setTab) {
    setTab.click();
    await sleep(600);
    var ignBtn = byText(".ssd-dp-btn", "已忽略管理");
    if (ignBtn) {
      ignBtn.click();
      await sleep(900);
      var igCard = document.querySelector(".ssd-dp-igcard");
      if (igCard) {
        igCard.click();
        await sleep(800);
        var cardsBefore = document.querySelectorAll(".ssd-dp-igcard").length;
        out.ignDetail = { opened: !!document.querySelector(".ssd-dp-modal-overlay"), stateOpen: st() };
        out.ignDetail.back = await back();
        out.ignDetail.closed = !document.querySelector(".ssd-dp-modal-overlay");
        out.ignDetail.cardsIntact = document.querySelectorAll(".ssd-dp-igcard").length === cardsBefore;
        out.ignDetail.stateAfter = st();
      } else out.ignDetail = "no-data";

      var allBtn = byText(".ssd-dp-btn", "还原全部");
      if (allBtn) {
        allBtn.click();
        await sleep(800);
        out.ignConfirm = { opened: !!document.querySelector(".ssd-dp-modal-overlay"), stateOpen: st() };
        out.ignConfirm.back = await back();
        out.ignConfirm.closed = !document.querySelector(".ssd-dp-modal-overlay");
        out.ignConfirm.cardsIntact = document.querySelectorAll(".ssd-dp-igcard").length > 0;
        out.ignConfirm.stateAfter = st();
      } else out.ignConfirm = "no-data";
      // 回设置页：顶栏 tab 常驻，比找「返回」按钮稳
      var setTab2 = document.querySelector(".ssd-dp-tab.set");
      if (setTab2) setTab2.click();
      await sleep(800);
    }

    // F) 入库字段弹窗（设置页「场景」）
    var fBtn = byText(".ssd-dp-btn", "场景");
    if (fBtn) {
      fBtn.click();
      await sleep(800);
      out.impFields = { opened: !!document.querySelector(".ssd-dp-modal-overlay"), stateOpen: st() };
      // 点一次「全选」确认重建没压第二条垫层（旧实现 close+reopen 会压两条）
      var all = byText(".ssd-dp-btn", "全选");
      if (all) { all.click(); await sleep(700); }
      out.impFields.stateAfterRebuild = st();
      out.impFields.back = await back();
      out.impFields.closed = !document.querySelector(".ssd-dp-modal-overlay");
      out.impFields.stateAfter = st();
    } else out.impFields = "no-data";
  } else out.impFields = "no-data";

  // G) 嵌套：场景详情 → 加入库预览 → 两次返回（预览确认前不写库）
  var dTab = byText(".ssd-dp-tab", "最新") || byText(".ssd-dp-tab", "总览");
  if (dTab) {
    dTab.click();
    await sleep(2000);
    var c3 = document.querySelector(".ssd-card-grid .card");
    if (c3) {
      c3.click();
      await sleep(1200);
      var saveBtn = [].slice.call(document.querySelectorAll(".ssd-modal .ssd-modal-acts > *")).filter(function (b) {
        return (b.textContent || "").indexOf("加入库") !== -1;
      })[0];
      if (saveBtn) {
        out.nested = { layer1: st() };
        saveBtn.click();
        await sleep(3500);
        out.nested.layer2 = st();
        out.nested.impOpen = !!document.querySelector(".ssd-imp-overlay");
        out.nested.back1 = await back();
        out.nested.impClosed = !document.querySelector(".ssd-imp-overlay");
        out.nested.sceneStillOpen = !!document.querySelector(".ssd-modal-overlay");
        out.nested.back2 = await back();
        out.nested.sceneClosed = !document.querySelector(".ssd-modal-overlay");
        out.nested.stateAfter = st();
        out.nested.pathKept = location.pathname === path0;
      } else {
        // 没按钮就关掉，别留一个开着的弹窗给后续脚本
        var xc = document.querySelector(".ssd-modal-close");
        if (xc) xc.click();
        out.nested = "no-save-btn";
      }
    } else out.nested = "no-data";
  } else out.nested = "no-data";

  return JSON.stringify(out);
})()
