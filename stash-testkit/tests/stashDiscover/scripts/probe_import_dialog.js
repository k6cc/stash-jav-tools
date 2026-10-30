// 批次6（§4）验收探针：入库弹窗（场景 / 演员）+ 字段开关持久化。
// 只读断言，不写库：场景弹窗只打开不确认；演员弹窗只测「已在库中 / 将新建」两态，
// 都不点确认。import.v1 的改动会还原。
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_import_dialog.js)" \
//     --path /plugins/stashDiscover --settle 5
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const IMP = "SSD:dp:import.v1";
  const bkImport = localStorage.getItem(IMP);
  const closeImp = () => document.querySelector(".ssd-imp-close")?.click();
  try {
    // ── 1. 字段开关：写 → 读回 → 恢复默认 ──
    SSD.dpImport.set("scene", { director: false, tags: "existing" });
    SSD.dpImport.reload();
    const s1 = SSD.dpImport.scene();
    out.prefs = { director: s1.director, tags: s1.tags, key: IMP };
    SSD.dpImport.reset("scene");
    out.prefsReset = SSD.dpImport.scene().tags;

    // ── 2. 场景弹窗结构 ──
    const card = document.querySelector(".ssd-dp-page .ssd-scene-card");
    if (!card) throw new Error("没有场景卡，先让发现页有数据");
    card.click();
    await sleep(3000);
    const save = [...document.querySelectorAll(".ssd-modal .ssd-modal-acts > *")]
      .find((b) => /加入库|Add to Library/.test(b.textContent));
    if (!save) throw new Error("场景弹窗里没有「加入库」按钮");
    save.click();
    await sleep(3000);
    const imp = document.querySelector(".ssd-imp");
    if (!imp) throw new Error("入库弹窗没打开");
    const reqRows = imp.querySelectorAll(".ssd-imp-req .ssd-imp-row");
    const locked = [...imp.querySelectorAll(".ssd-imp-cb")].filter((c) => c.disabled);
    const selects = imp.querySelectorAll(".ssd-imp-select");
    const inputs = [...imp.querySelectorAll(".ssd-imp-input")].map((i) => i.value);
    out.scene = {
      reqRows: reqRows.length,
      lockedCb: locked.length,
      // 标题/日期/简介/导演 4 个可编辑 + 标签/工作室 2 个三态
      textInputs: inputs.length,
      selects: selects.length,
      urlRows: [...imp.querySelectorAll(".ssd-imp-name")].filter((n) =>
        /网页链接|Web link|源站链接|Source links/.test(n.textContent)).length,
      performerRow: [...imp.querySelectorAll(".ssd-imp-name")]
        .find((n) => /^演员$|^Performers$/.test(n.textContent))
        ?.nextElementSibling?.textContent || "",
      tagHint: [...imp.querySelectorAll(".ssd-imp-hint")].map((h) => h.textContent),
      buttons: [...imp.querySelectorAll(".ssd-imp-foot .ssd-btn")].map((b) => b.textContent),
      title: inputs[0],
    };
    // 三态联动：选「不写」→ 勾选框必须同步取消
    const tagSel = imp.querySelectorAll(".ssd-imp-select")[0];
    if (tagSel) {
      tagSel.value = "none";
      tagSel.dispatchEvent(new Event("change"));
      const tagCb = tagSel.closest(".ssd-imp-row").querySelector(".ssd-imp-cb");
      out.scene.tagNoneSync = tagCb.checked === false;
    }
    closeImp();
    await sleep(300);

    // ── 3. 演员弹窗：已在库中 ──
    const boxes = await SSD.getStashBoxes();
    const box = boxes.find((b) => /stashdb/i.test(b.endpoint)) || boxes[0];
    const local = await SSD.callGQL(
      "query{findPerformers(filter:{per_page:-1}){performers{id name stash_ids{endpoint stash_id}}}}");
    const withId = local.findPerformers.performers.find((p) =>
      (p.stash_ids || []).some((s) => String(s.endpoint).toLowerCase() === String(box.endpoint).toLowerCase()));
    if (withId) {
      const sid = withId.stash_ids.find(
        (s) => String(s.endpoint).toLowerCase() === String(box.endpoint).toLowerCase()).stash_id;
      let got = null;
      SSD.openImportPerformer({
        endpoint: box.endpoint, apiKey: box.api_key, stashId: sid, name: withId.name, image: "",
        onDone: (id, mode) => { got = { id, mode }; },
      });
      await sleep(3500);
      const p = document.querySelector(".ssd-imp");
      out.perfExists = {
        banner: p?.querySelector(".ssd-imp-state")?.textContent || "",
        ok: !!p?.querySelector(".ssd-imp-state.is-ok"),
        foot: [...(p?.querySelectorAll(".ssd-imp-foot .ssd-btn") || [])].map((b) => b.textContent),
        onDone: got,
      };
      closeImp();
      await sleep(300);
    } else {
      out.perfExists = "本地没有带 stash_id 的演员，跳过";
    }

    // ── 4. 演员弹窗：将新建（动态非空行） ──
    const list = await SSD.callBoxSceneList(
      { name: box.name, endpoint: box.endpoint, api_key: box.api_key },
      { per_page: 12, sort: "DATE", direction: "DESC" }, 15000);
    const known = {};
    local.findPerformers.performers.forEach((p) =>
      (p.stash_ids || []).forEach((s) =>
        (known[String(s.endpoint).toLowerCase() + ":" + String(s.stash_id).toLowerCase()] = 1)));
    let cand = null;
    ((list && list.scenes) || []).forEach((sc) => (sc.performers || []).forEach((p) => {
      const pf = p.performer || p;
      if (!cand && pf && pf.id && !known[String(box.endpoint).toLowerCase() + ":" + String(pf.id).toLowerCase()]) {
        cand = { id: pf.id, name: pf.name };
      }
    }));
    if (cand) {
      SSD.openImportPerformer({
        endpoint: box.endpoint, apiKey: box.api_key, stashId: cand.id, name: cand.name, image: "",
      });
      await sleep(4000);
      const p = document.querySelector(".ssd-imp");
      out.perfNew = {
        who: cand.name,
        banner: p?.querySelector(".ssd-imp-state")?.textContent || "",
        // 动态行：只应有非空项
        rows: [...(p?.querySelectorAll(".ssd-imp-list .ssd-imp-name") || [])].map((n) => n.textContent),
        hasEmptyValueText: [...(p?.querySelectorAll(".ssd-imp-list .ssd-imp-val") || [])]
          .some((v) => !v.textContent.trim()),
      };
      closeImp();
    } else {
      out.perfNew = "源上前 12 部片的演员都已在库，跳过";
    }
  } catch (e) {
    out.error = (e && e.message) || String(e);
  } finally {
    closeImp();
    if (bkImport === null) localStorage.removeItem(IMP);
    else localStorage.setItem(IMP, bkImport);
    SSD.dpImport.reload();
  }
  return out;
})()
