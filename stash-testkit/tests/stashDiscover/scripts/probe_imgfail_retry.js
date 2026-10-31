// probe_imgfail_retry.js — 图片失败负缓存（SSD:imgfail.v1）的「跳过窗口」回归
//
// 背景：列表卡片封面走 setCoverImage → next() 逐个试候选，失败写 sessionStorage 负缓存。
// 曾经这里按 12h TTL 无条件跳过，一次网络波动就把封面钉死到会话结束（详情弹窗那边
// 一直是 10 分钟窗口，两边语义不一致）。2026-10-31 用户实测：换节点后弹窗有图、列表一直空。
//
// 跑法：
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval \
//     "$(cat testkit/.../scripts/probe_imgfail_retry.js)" --path /plugins/stashDiscover --timeout 90
//
// 会写 sessionStorage 吗：会，但跑完还原原值（KEY 是标签页级，不影响别的标签）。
(async () => {
  const KEY = "SSD:imgfail.v1";
  const MIN = 60 * 1000;
  // 1x1 gif，加载必成功；用它当「候选图」，只看 next() 的决策不看网络
  const A = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  const out = { verdict: [] };
  const bak = sessionStorage.getItem(KEY);

  const seed = (url, ageMs) => {
    const o = {};
    o[url] = Date.now() - ageMs;
    sessionStorage.setItem(KEY, JSON.stringify(o));
  };
  const cardImg = (urls) => {
    const item = { scene: { id: "probe-imgfail", title: "probe" }, images: urls.map((u) => ({ url: u })) };
    const ctx = { zoom: 1, queryBoxes: [], showIgnored: false };
    const card = SSD.buildSceneCard(item, 0, ctx);
    return card.querySelector("img");
  };
  const check = (name, pass, detail) => out.verdict.push({ name, pass, detail });

  try {
    out.hasApi = typeof SSD.clearAllImgFail === "function";
    check("导出 clearAllImgFail", out.hasApi);
    if (!out.hasApi) throw new Error("SSD.clearAllImgFail missing");

    // ① 1 分钟前失败 → 跳过（抖动期不重演空白）
    seed(A, 1 * MIN);
    let img = cardImg([A]);
    out.recent = { vis: img.style.visibility, src: img.getAttribute("src") };
    check("1 分钟内失败被跳过", img.style.visibility === "hidden" && !img.getAttribute("src"), out.recent);

    // ② 11 分钟前失败 → 重试（换节点 / 网络恢复后自己能回来）
    seed(A, 11 * MIN);
    img = cardImg([A]);
    out.old = { vis: img.style.visibility, srcMatch: img.getAttribute("src") === A };
    check("超过 10 分钟自动重试", img.style.visibility === "visible" && img.getAttribute("src") === A, out.old);

    // ③ 13 小时前失败 → 已过 12h TTL，等同于没失败过
    seed(A, 13 * 60 * MIN);
    img = cardImg([A]);
    out.expired = { vis: img.style.visibility, srcMatch: img.getAttribute("src") === A };
    check("超过 12h 视为未失败", img.style.visibility === "visible" && img.getAttribute("src") === A, out.expired);

    // ④ clearAllImgFail 清空整张负缓存（刷新按钮用）
    seed(A, 1 * MIN);
    const before = !!sessionStorage.getItem(KEY);
    SSD.clearAllImgFail();
    out.clearAll = { before, after: sessionStorage.getItem(KEY) };
    check("clearAllImgFail 清空", before && !sessionStorage.getItem(KEY), out.clearAll);
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  } finally {
    if (bak === null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, bak);
    out.restored = sessionStorage.getItem(KEY) === bak;
  }

  out.allPass = !out.fatal && out.verdict.every((v) => v.pass) && out.restored;
  return JSON.stringify(out, null, 1);
})()
