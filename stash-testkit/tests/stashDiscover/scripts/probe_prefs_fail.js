// 注入 QuotaExceededError 测偏好写失败：一次性 toast + 第二次不弹 + prefs 未被污染
// 用法：python stash-testkit/page_eval.py probe_prefs_fail.js --path /plugins/stashDiscover --vsize 1400x900 --settle 9
(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (x) => Array.from(document.querySelectorAll(x));
  const SEL = "[class*='toast'], .ssd-toast, [role='alert'], [role='status']";
  const toasts = () => qa(SEL).filter((e) => /Setting not saved|设置未能保存/.test(e.innerText || ""));
  const sortSel = qa("select").find((s2) => Array.from(s2.options).some((o) => o.value === "hot"));
  if (!sortSel) return JSON.stringify({ err: "no sort select" });
  const orig = sortSel.value;
  const origSetItem = Storage.prototype.setItem;
  const stub = function () { throw new Error("QuotaExceededError(fake)"); };
  const out = { orig: orig, steps: [] };

  // 第一次
  Storage.prototype.setItem = stub;
  sortSel.value = "date-desc"; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await s(900);
  let hit = toasts();
  out.steps.push({ phase: "first", count: hit.length, text: (hit[0] ? hit[0].innerText.replace(/\s+/g, " ").trim() : null), tag: (hit[0] ? hit[0].className : null) });
  // 清掉首条，避免干扰第二次
  hit.forEach((e) => e.remove());
  Storage.prototype.setItem = origSetItem;
  await s(400);
  sortSel.value = orig; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await s(800);
  out.afterRestore = toasts().length;

  // 第二次（同一次会话内，一次性提示应不再出现）
  Storage.prototype.setItem = stub;
  sortSel.value = "date-desc"; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await s(1200);
  const hit2 = toasts();
  out.steps.push({ phase: "second", count: hit2.length, text: (hit2[0] ? hit2[0].innerText.replace(/\s+/g, " ").trim() : null) });
  Storage.prototype.setItem = origSetItem;
  await s(300);
  sortSel.value = orig; sortSel.dispatchEvent(new Event("change", { bubbles: true }));
  await s(500);
  out.finalSort = sortSel.value;
  out.prefs = localStorage.getItem("SSD:dp:prefs");
  return JSON.stringify(out);
})();
