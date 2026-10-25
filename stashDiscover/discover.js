/* ──────────────────────────────────────────────────────────────────────────
 * stashDiscover — discover.js（"发现"导航页内容模块）
 * 加载条件：主 JS 的 maybeLoadDiscover() 按 enableDiscoverPage 设置 +
 * localStorage 缓存注入本文件；开关关闭时本文件完全不进浏览器（§1）。
 * 职责边界：导航按钮与 /plugins/stashDiscover 路由壳由主 JS 顶层同步注册
 * （可靠时序波次）；本文件只提供页面组件（window.SSD.discoverMount +
 * "ssd:discover-ready" 事件）与页内全部内容渲染。
 * 依赖：window.SSD（主 JS 导出的共享命名空间，见 stashDiscover.js 尾部）。
 * 设计规范：discover-page-design.md（唯一事实源）。
 * 实施进度：PROGRESS.md（断点续传）。
 * 主题跟随：suiteTheme() 从页面采样派生 --sx-* token（移植自 LockdownI18n
 * 共享实现），换任何主题自动跟随；Flexoki 主题插件启用时用其精确值。
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var SSD = window.SSD;
  if (!SSD) {
    console.warn("[SSD] discover.js: window.SSD missing — main plugin JS must load first");
    return;
  }
  if (!window.PluginApi || !window.PluginApi.React) {
    console.warn("[SSD] discover.js: PluginApi/React unavailable on this Stash — page module skipped");
    return;
  }
  var tc = SSD.tc;

  // ═══ Theme tokens (suiteTheme) ═══════════════════════════════════════════
  // 颜色取自 Stash 当前展示的任何主题：无主题时从页面（背景/卡片/文本/静音文
  // 本/主按钮）按 WCAG 对比度推算，面板自然融入 Stash 深色、浅色或自定义
  // CSS；Flexoki 主题插件启用时直接用其精确值。语义色（红=危险、绿=成功、
  // 黄=提醒、蓝=链接/信息）保留 Flexoki 色相并明暗适配：形状 3:1、文本 4.5:1。
  //   T = suiteTheme({ id, scope, extra })  scope: 插件根选择器
  //   T.start()   写入 scope { --sx-*: ... }，主题变化时重写
  //   T.t         当前 token（#RRGGBB）
  //   T.mode      "flexoki" | "dark" | "light"
  //   T.on(fn)    主题变化回调
  function suiteTheme(o) {
    o = o || {};
    const FLEX = {
      bg: "#100F0F", bg2: "#1C1B1A", ui: "#282726", ui2: "#343331", ui3: "#403E3C", raise: "#2D2C2A", edge: "#48463F",
      line: "#0D0C0C", line2: "#0B0A0A", deep: "#000000", slab: "#232120",
      tx3: "#575653", tx2b: "#6F6E69", tx2: "#878580", tx1b: "#B7B5AC", tx: "#CECDC3", hi: "#E6E4D9", grey: "#9F9D96",
      paper: "#FFFCF0", on: "#100F0F", acc: "#DA702C", "acc-tx": "#100F0F",
    };
    // 每个色相: [base 400, pressed 600, text 300, tint 200, deep 700]
    const HUES = {
      re: ["#D14D41", "#AF3029", "#E8705F", "#F89A8A", "#942822"], or: ["#DA702C", "#BC5215", "#EC8B49", "#F9AE77", "#9D4310"],
      ye: ["#D0A215", "#AD8301", "#DFB431", "#ECCB60", "#8E6B01"], gr: ["#879A39", "#66800B", "#A9BA5A", "#BEC97E", "#536907"],
      cy: ["#3AA99F", "#24837B", "#5ABDAC", "#87D3C3", "#1C6C66"], bl: ["#4385BE", "#205EA6", "#66A0C8", "#92BFDB", "#1A4F8C"],
      pu: ["#8B7EC8", "#5E409D", "#A699D0", "#C4B9E0", "#4F3685"], ma: ["#CE5D97", "#A02F6F", "#E47DA8", "#F4A4C2", "#87285E"],
    };
    Object.keys(HUES).forEach((h) => { const v = HUES[h]; FLEX[h] = v[0]; FLEX[h + "-d"] = v[1]; FLEX[h + "-tx"] = v[2]; FLEX[h + "-l"] = v[3]; });
    const STASH = { bg: "#202B33", surface: "#30404D", text: "#F5F8FA", muted: "#BFCCD6", primary: "#137CBD" };
    const SHADOW = (k) => {
      const a = (x) => "rgba(0,0,0," + +(x * k).toFixed(3) + ")";
      return { sh: "0 1px 0 " + a(0.7) + ", 0 12px 24px -10px " + a(0.65), float: "0 1px 0 " + a(0.7) + ", 0 20px 50px -12px " + a(0.75),
               well: "inset 0 2px 5px " + a(0.5) };
    };

    function parse(s) {
      if (Array.isArray(s)) return s;
      s = String(s || "").trim().toLowerCase();
      if (s === "transparent") return [0, 0, 0, 0];
      let m = /^#([0-9a-f]{3,8})$/.exec(s);
      if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16);
        return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
      }
      m = /^rgba?\(([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean);
        if (p.length < 3) return null;
        const ch = (v) => (/%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v));
        const al = p[3] === undefined ? 1 : /%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
        const out = [ch(p[0]), ch(p[1]), ch(p[2]), al];
        return out.some((x) => isNaN(x)) ? null : out;
      }
      m = /^color\(srgb\s+([^)]*)\)$/.exec(s);
      if (m) {
        const p = m[1].split(/[\s/]+/).filter(Boolean).map(parseFloat);
        return p.length >= 3 && !p.some(isNaN) ? [p[0] * 255, p[1] * 255, p[2] * 255, p[3] === undefined ? 1 : p[3]] : null;
      }
      return null;
    }
    const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
    const hex = (c) => { c = parse(c); return c ? "#" + c.slice(0, 3).map((x) => clamp(x).toString(16).padStart(2, "0")).join("").toUpperCase() : null; };
    const over = (c, base) => { c = parse(c); base = parse(base); const a = c[3]; return [0, 1, 2].map((i) => c[i] * a + base[i] * (1 - a)).concat(1); };
    const mix = (a, b, w) => { a = parse(a); b = parse(b); return hex([0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * w)); };
    function lum(c) {
      c = parse(c);
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    function fit(c, against, ratio, dark) {
      const to = dark ? "#FFFFFF" : "#000000", worst = (x) => Math.min.apply(null, against.map((b) => contrast(x, b)));
      let out = hex(c);
      for (let i = 1; i <= 25 && worst(out) < ratio; i++) out = mix(c, to, i * 0.04);
      return out;
    }

    function derive(s) {
      s = s || {};
      const pick = (v, d) => { const c = parse(v); return c && c[3] > 0 ? c : parse(d); };
      const bg = hex(over(pick(s.bg, STASH.bg), "#000000"));
      let tx = hex(over(pick(s.text, STASH.text), bg));
      const dark = lum(bg) < lum(tx) || (lum(bg) < 0.18 && contrast(bg, tx) < 3);
      if (contrast(tx, bg) < 4.5) tx = dark ? "#F5F8FA" : "#1C2127";
      let ui = hex(over(pick(s.surface, parse(s.bg) ? bg : STASH.surface), bg));
      if (contrast(ui, bg) < 1.04 || contrast(ui, bg) > 3 || (dark ? lum(ui) < lum(bg) : false)) ui = mix(bg, tx, dark ? 0.07 : 0.035);
      if (!dark && contrast(ui, bg) < 1.04) ui = bg;
      const t = { bg, ui, tx };
      t.bg2 = dark ? mix(bg, ui, 0.5) : mix(ui, tx, 0.04);
      t.ui2 = mix(ui, tx, dark ? 0.075 : 0.06);
      t.ui3 = mix(ui, tx, dark ? 0.145 : 0.13);
      const bd = parse(s.border);
      if (bd && bd[3] > 0) { const b = hex(over(bd, ui)), r = contrast(b, ui); if (r > 1.1 && r < 3) t.ui3 = b; }
      t.raise = dark ? mix(ui, tx, 0.03) : mix(ui, "#FFFFFF", 0.5);
      t.edge = dark ? mix(ui, tx, 0.19) : mix(ui, "#FFFFFF", 0.7);
      t.line = dark ? mix(bg, "#000000", 0.19) : mix(ui, tx, 0.2);
      t.line2 = dark ? mix(bg, "#000000", 0.31) : mix(ui, tx, 0.22);
      t.deep = dark ? "#000000" : mix(ui, tx, 0.25);
      t.slab = dark ? mix(bg, tx, 0.07) : mix(bg, tx, 0.1);
      t.hi = mix(tx, dark ? "#FFFFFF" : "#000000", 0.45);
      t.tx1b = mix(tx, ui, 0.14);
      const mu = parse(s.muted);
      let tx2 = mix(tx, ui, 0.43);
      if (mu && mu[3] > 0) { const m = hex(over(mu, ui)); if (contrast(m, ui) < contrast(tx, ui) * 0.92) tx2 = m; }
      t.tx2 = fit(tx2, [ui, bg], 4.5, dark);
      t.tx2b = mix(tx, ui, 0.57);
      t.tx3 = mix(tx, ui, 0.66);
      t.grey = fit(mix(tx, ui, 0.3), [ui, bg], 4.5, dark);
      t.paper = FLEX.paper;
      t.on = dark ? mix(bg, "#000000", 0.4) : "#FFFFFF";
      Object.keys(HUES).forEach((h) => {
        const v = HUES[h];
        t[h] = fit(dark ? v[0] : v[1], [ui, bg], 3, dark);
        t[h + "-d"] = dark ? v[1] : mix(t[h], "#000000", 0.2);
        t[h + "-tx"] = fit(dark ? v[2] : v[1], [ui, bg], 4.5, dark);
        t[h + "-l"] = fit(dark ? v[3] : v[4], [ui, bg], 4.5, dark);
      });
      const pr = parse(s.primary);
      t.acc = pr && pr[3] > 0 ? fit(hex(over(pr, ui)), [ui], 3, dark) : t.or;
      // 采样主色过暗（黑色系主题）→ 退回橙色，避免「加入库」等主按钮变黑（用户 2026-10-25）
      if (lum(t.acc) < 0.09) t.acc = t.or;
      t["acc-tx"] = contrast(t.acc, "#FFFFFF") >= contrast(t.acc, t.on) ? "#FFFFFF" : t.on;
      return t;
    }

    function tokensCss(t, mode, scope) {
      const k = mode === "light" ? 0.3 : 1, sh = SHADOW(k);
      const lines = Object.keys(t).map((n) => "--sx-" + n + ": " + t[n] + ";");
      lines.push("--sx-k: " + k + ";", "--sx-sh: " + sh.sh + ";", "--sx-float: " + sh.float + ";", "--sx-well: " + sh.well + ";",
                 "--sx-scheme: " + (mode === "light" ? "light" : "dark") + ";");
      return (scope || ":root") + " {\n  " + lines.join("\n  ") + "\n}";
    }

    const T = { t: Object.assign({}, FLEX), mode: "flexoki", FLEX, HUES, STASH, parse, hex, over, mix, lum, contrast, fit, derive, tokensCss };
    const subs = [];
    let el = null, timer = 0, started = false, css = "";
    T.on = (fn) => { subs.push(fn); return T; };

    function flexokiOn() {
      try { return !!getComputedStyle(document.documentElement).getPropertyValue("--fx-bg").trim(); } catch (_) { return false; }
    }
    function sample() {
      const out = {};
      const cs = (e) => getComputedStyle(e);
      const b = document.body, h = document.documentElement;
      const hb = parse(cs(h).backgroundColor), bb = b ? parse(cs(b).backgroundColor) : null;
      let page = hb && hb[3] > 0 ? over(hb, STASH.bg) : null;
      if (bb && bb[3] > 0) page = over(bb, page || STASH.bg);
      if (page) out.bg = page;
      if (b) out.text = cs(b).color;
      if (!b) return out;
      const box = document.createElement("div");
      box.setAttribute("aria-hidden", "true");
      box.style.cssText = "position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none";
      box.innerHTML = '<div class="card"><span class="text-muted">x</span><button type="button" class="btn btn-primary">x</button></div>';
      b.appendChild(box);
      try {
        const card = box.firstChild, c = cs(card);
        out.surface = c.backgroundColor;
        if (parseFloat(c.borderTopWidth) > 0) out.border = c.borderTopColor;
        out.muted = cs(card.firstChild).color;
        out.primary = cs(card.lastChild).backgroundColor;
        if (c.color) out.text = c.color;
      } finally { box.remove(); }
      return out;
    }
    function compute() {
      if (flexokiOn()) {
        const t = Object.assign({}, FLEX);
        try {
          const a = parse(getComputedStyle(document.documentElement).getPropertyValue("--fx-acc").trim());
          if (a) t.acc = hex(a);
        } catch (_) {}
        return { t, mode: "flexoki" };
      }
      const t = derive(sample());
      return { t, mode: lum(t.bg) < lum(t.tx) ? "dark" : "light" };
    }
    function apply() {
      timer = 0;
      let r;
      try { r = compute(); } catch (e) { return; }
      const next = tokensCss(r.t, r.mode, o.scope) + (o.extra ? "\n" + o.extra({ t: r.t, mode: r.mode, mix, fit, contrast }) : "");
      T.t = r.t; T.mode = r.mode;
      if (next === css && el && el.isConnected) return;
      css = next;
      if (!el || !el.isConnected) {
        el = document.getElementById((o.id || "suite") + "-sx") || document.createElement("style");
        el.id = (o.id || "suite") + "-sx";
        document.head.appendChild(el);
      }
      el.textContent = css;
      subs.forEach((fn) => { try { fn(T); } catch (_) {} });
    }
    const soon = () => { if (!timer) timer = setTimeout(apply, 120); };
    T.refresh = apply;
    T.start = () => {
      if (started) return T;
      started = true;
      apply();
      try {
        const watchLink = (n) => { if (n && n.tagName === "LINK") n.addEventListener("load", soon, { once: true }); };
        const mo = new MutationObserver((list) => {
          for (const m of list) {
            if (m.target === el || (el && el.contains(m.target))) continue;
            if (m.addedNodes) m.addedNodes.forEach(watchLink);
            soon();
          }
        });
        mo.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "media", "href", "rel"] });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme", "data-fx-accent"] });
        if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-bs-theme"] });
        document.querySelectorAll('link[rel~="stylesheet"]').forEach((n) => { if (!n.sheet) watchLink(n); });
        const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (mq && mq.addEventListener) mq.addEventListener("change", soon);
      } catch (_) {}
      return T;
    };
    return T;
  }

  // 发现页所有自绘元素都在 .ssd-dp-page 下；导航按钮与角标在 MainNavBar 里
  // （P1 注入），主题 token 通过 scope 覆盖到两处。
  var THEME = suiteTheme({
    id: "ssd-dp",
    scope: ".ssd-dp-page, .ssd-nav-item, .ssd-dp-modal",
  });

  // ═══ P2: 数据管线（设计文档 §4/§5，binge 已验证模式）═════════════════════
  var BOX_TIMEOUT = SSD.BOX_TIMEOUT_MS || 25000;
  var PERFORMER_BATCH = 100;      // §4.1 演员分批
  var BATCH_CONCURRENCY = 3;      // binge 实测：3 宽并发对源友好且冷加载快
  var BOX_PAGE_SIZE = 1000;       // 实测源不封顶 per_page；count 制终止兼容偷降源的盒
  var BOX_MAX_PAGES = 50;
  var TRENDING_PER_PAGE = 30;     // §5 热门榜
  var STUDIO_PAGE_SIZE = 100;     // §4.6 工作室管线
  // 显示上限（设置页可改；分组/详情内不受限 — 用户 2026-10-25 第七轮）
  function capPerActor() { return Math.max(1, toNum(dpPrefs().capPerActor, 2)); }
  function capPerStudio() { return Math.max(1, toNum(dpPrefs().capPerStudio, 2)); }
  var CACHE_TTL_MS = 12 * 3600 * 1000;        // §4.4 12h 新鲜期
  var CACHE_STALE_MAX_MS = 7 * 24 * 3600 * 1000; // SWR 陈旧兜底 7d
  var TRENDING_PERF_CACHE_TTL_MS = 6 * 3600 * 1000;
  var CACHE_SCENES_CAP = 1500;    // localStorage 体积护栏（按 release_date 新者保留）
  var LS_PREFIX = "SSD:dp:";

  // ── 2.0 设置与数据源（§3.6/§4.5）──────────────────────────────────────────
  // yml 设置（服务端）负责低频项；localStorage 偏好（P6 弹窗写）负责其余。
  function dpPrefs() {
    try {
      var raw = localStorage.getItem(LS_PREFIX + "prefs");
      var p = raw ? JSON.parse(raw) : null;
      return (p && typeof p === "object") ? p : {};
    } catch (_) { return {}; }
  }

  function toNum(v, dflt) {
    var n = parseInt(v, 10);
    return isNaN(n) ? dflt : n;
  }

  // 活动数据源：localStorage 持久化值（若仍有效）→ yml preferredBox → 第一个
  function resolveSource(boxes, ymlSettings) {
    var prefs = dpPrefs();
    var wanted = prefs.source || (ymlSettings && ymlSettings.preferredBox) || "";
    var pick = null;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (wanted && (b.name === wanted || b.endpoint === wanted)) { pick = b; break; }
    }
    if (!pick) pick = boxes[0] || null;
    return pick ? { name: pick.name, endpoint: pick.endpoint, apiKey: pick.api_key || "", host: hostOf(pick.endpoint) } : null;
  }

  function hostOf(endpoint) {
    try { return new URL(endpoint).host; } catch (_) { return String(endpoint || ""); }
  }

  // ── 2.6 会话级本地查询 memo（refresh / SCENE_SAVED_EVENT 时失效）─────────
  var _memo = { linked: {}, owned: null, studios: null };

  function invalidateLocalMemos() {
    _memo = { linked: {}, owned: null, studios: null };
  }

  // 库内演员（当前源有 stash_id 关联）→ [{localId, stashId, name, image, favorite}]
  function loadLinkedPerformers(endpoint) {
    if (_memo.linked[endpoint]) return _memo.linked[endpoint];
    var p = SSD.callGQL(
      "query{findPerformers(filter:{per_page:-1}){performers{id name favorite image_path stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var out = [];
      var perfs = (((data || {}).findPerformers || {}).performers) || [];
      perfs.forEach(function (p2) {
        var ids = p2.stash_ids || [];
        for (var i = 0; i < ids.length; i++) {
          if (ids[i].endpoint === endpoint && ids[i].stash_id) {
            out.push({
              localId: String(p2.id), stashId: String(ids[i].stash_id),
              name: p2.name || "", image: p2.image_path || null, favorite: !!p2.favorite,
            });
            break;
          }
        }
      });
      return out;
    });
    _memo.linked[endpoint] = p;
    p.catch(function () { if (_memo.linked[endpoint] === p) _memo.linked[endpoint] = null; });
    return p;
  }

  // 全库已拥有键（§4.3 双键）：stash_id_endpoint NOT_NULL 一次性扫（binge 实测：
  // 131k 场景库 2.64MB/1.19s，不加过滤反而 4.47MB/12s）
  function loadOwnedKeys() {
    if (_memo.owned) return _memo.owned;
    var p = SSD.callGQL(
      "query{findScenes(scene_filter:{stash_id_endpoint:{modifier:NOT_NULL}},filter:{per_page:-1}){scenes{code stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var keys = {};
      var scenes = (((data || {}).findScenes || {}).scenes) || [];
      scenes.forEach(function (s) {
        (s.stash_ids || []).forEach(function (sid) {
          if (sid.endpoint && sid.stash_id) {
            keys[String(sid.endpoint).toLowerCase() + ":" + String(sid.stash_id).toLowerCase()] = true;
          }
        });
        if (s.code) keys["code:" + String(s.code).trim().toLowerCase()] = true;
      });
      return keys;
    });
    _memo.owned = p;
    p.catch(function () { if (_memo.owned === p) _memo.owned = null; });
    return p;
  }

  // 收藏(❤)工作室（§4.6）→ [{localId, name, image, stashId}]（仅当前源有关联的）
  function loadFavoriteStudios(endpoint) {
    if (_memo.studios) return _memo.studios;
    var p = SSD.callGQL(
      "query{findStudios(studio_filter:{favorite:true},filter:{per_page:-1}){studios{id name image_path stash_ids{endpoint stash_id}}}}"
    ).then(function (data) {
      var out = [];
      var studs = (((data || {}).findStudios || {}).studios) || [];
      studs.forEach(function (st) {
        var ids = st.stash_ids || [];
        for (var i = 0; i < ids.length; i++) {
          if (ids[i].endpoint === endpoint && ids[i].stash_id) {
            out.push({
              localId: String(st.id), stashId: String(ids[i].stash_id),
              name: st.name || "", image: st.image_path || null,
            });
            break;
          }
        }
      });
      return out;
    });
    _memo.studios = p;
    p.catch(function () { if (_memo.studios === p) _memo.studios = null; });
    return p;
  }

  // ── 2.1/2.4/2.5 stash-box 查询（经 SSD 限流器，3 并发 300ms 间隔）────────
  // box 场景条目：{endpoint, boxName, scene, images}（buildSceneCard 同构）
  function shapeBoxItem(box, rawScene) {
    return {
      endpoint: box.endpoint,
      boxName: box.name,
      // 主 JS openModal/handleSaveScene/handleSearchResources 需要 box
      // （api_key 供 fetchBoxSceneDetail 与演员年龄查询），_dp 标记让
      // handleSaveScene 走"发现页条目"分支（不回退到当前演员页上下文）。
      box: { name: box.name, endpoint: box.endpoint, api_key: box.apiKey || "" },
      _dp: true,
      scene: rawScene,
      images: rawScene && rawScene.images ? rawScene.images : [],
    };
  }

  // 一批演员（≤100）的新场景：date GREATER_THAN + performers INCLUDES，懒分页。
  // null = 该批失败（调用方不得把部分结果当全量缓存）；[] = 确实没有。
  function fetchScenesBatch(box, performerStashIds, sinceIsoDate) {
    var out = [];
    var page = 1;
    function one() {
      return SSD.boxRateLimiter.submit(function () {
        return SSD.callBoxGQL(
          box.endpoint, box.apiKey,
          "query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{" + SSD.BOX_SCENE_FIELDS + "}}}",
          {
            input: {
              date: { value: sinceIsoDate, modifier: "GREATER_THAN" },
              performers: { value: performerStashIds, modifier: "INCLUDES" },
              sort: "DATE", direction: "DESC",
              page: page, per_page: BOX_PAGE_SIZE,
            },
          },
          BOX_TIMEOUT
        );
      });
    }
    function next(data) {
      var qs = (data && data.queryScenes) || null;
      if (!qs || !qs.scenes) return null; // 无应答 ≠ 空结果（binge 教训）
      qs.scenes.forEach(function (s) { out.push(s); });
      // count 制终止（防源把 per_page 偷降到 100 时截断）
      if (qs.count != null && out.length >= qs.count) return out;
      if (qs.scenes.length === 0) return out;
      page++;
      return one().then(next);
    }
    return one().then(next);
  }

  // 全量演员新场景：100/批 × 3 宽并发；任一批失败 → 整体 null（不缓存部分）。
  // 会话内 in-flight 去重（binge 模式）。
  var _newScenesFlight = null;

  function fetchNewScenesForPerformers(box, performerStashIds, sinceIsoDate) {
    if (!performerStashIds.length) return Promise.resolve([]);
    var key = box.host + "|" + sinceIsoDate + "|" + performerStashIds.length;
    if (_newScenesFlight && _newScenesFlight.key === key) return _newScenesFlight.value;
    var p = (function () {
      var batches = [];
      for (var i = 0; i < performerStashIds.length; i += PERFORMER_BATCH) {
        batches.push(performerStashIds.slice(i, i + PERFORMER_BATCH));
      }
      var merged = [];
      var idx = 0;
      function runWave() {
        if (idx >= batches.length) return merged;
        var wave = [];
        for (var w = 0; w < BATCH_CONCURRENCY && idx < batches.length; w++) wave.push(batches[idx++]);
        return Promise.all(wave.map(function (b) { return fetchScenesBatch(box, b, sinceIsoDate); })).then(function (results) {
          for (var r = 0; r < results.length; r++) {
            if (results[r] == null) return null; // 部分失败 → 整体 null
            merged = merged.concat(results[r]);
          }
          return runWave();
        });
      }
      return runWave().then(function (all) {
        if (all == null) return null;
        // 按 id 去重（一个场景含两名库内演员会出现在两批里）
        var seen = {}, dedup = [];
        all.forEach(function (s) {
          if (!s || seen[s.id]) return;
          seen[s.id] = true; dedup.push(s);
        });
        return dedup;
      });
    })();
    _newScenesFlight = { key: key, value: p };
    p["finally"](function () { if (_newScenesFlight && _newScenesFlight.value === p) _newScenesFlight = null; });
    return p;
  }

  // §5 热门榜：TRENDING 全站原样（不过滤库内演员、无日期窗），30 条
  function fetchTrendingScenes(box) {
    return SSD.boxRateLimiter.submit(function () {
      return SSD.callBoxGQL(
        box.endpoint, box.apiKey,
        "query($input:SceneQueryInput!){queryScenes(input:$input){scenes{" + SSD.BOX_SCENE_FIELDS + "}}}",
        { input: { sort: "TRENDING", direction: "DESC", page: 1, per_page: TRENDING_PER_PAGE } },
        BOX_TIMEOUT
      );
    }).then(function (data) {
      var scenes = (((data || {}).queryScenes || {}).scenes) || null;
      return scenes; // null = 失败
    });
  }

  // §4.6 工作室新发布：收藏工作室单查询 studios INCLUDES + date 窗，懒分页
  function fetchStudioScenes(box, studioStashIds, sinceIsoDate) {
    var out = [];
    var page = 1;
    function one() {
      return SSD.boxRateLimiter.submit(function () {
        return SSD.callBoxGQL(
          box.endpoint, box.apiKey,
          "query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{" + SSD.BOX_SCENE_FIELDS + "}}}",
          {
            input: {
              date: { value: sinceIsoDate, modifier: "GREATER_THAN" },
              studios: { value: studioStashIds, modifier: "INCLUDES" },
              sort: "DATE", direction: "DESC",
              page: page, per_page: STUDIO_PAGE_SIZE,
            },
          },
          BOX_TIMEOUT
        );
      });
    }
    function next(data) {
      var qs = (data && data.queryScenes) || null;
      if (!qs || !qs.scenes) return null;
      qs.scenes.forEach(function (s) { out.push(s); });
      if (qs.count != null && out.length >= qs.count) return out;
      if (qs.scenes.length === 0) return out;
      page++;
      return one().then(next);
    }
    return one().then(next);
  }

  // §3.5 发现演员·热门演员榜（复用 binge getTrendingStashDBPerformers）：
  // 宽页不带 gender（实测 1.5s vs 6-19s）→ 本地过滤 → 不足 12 才按性别逐查（20s）
  function fetchTrendingPerformers(box, perPage, genders) {
    perPage = perPage || 24;
    var allowed = {};
    (genders && genders.length ? genders : ["FEMALE"]).forEach(function (g) { allowed[g] = true; });
    function shape(rows) {
      return rows.map(function (r) {
        return {
          stashId: r.id, name: r.name, gender: r.gender || null,
          birthDate: r.birth_date || null, sceneCount: r.scene_count || 0,
          image: (r.images && r.images[0] && r.images[0].url) || null,
        };
      });
    }
    function interleave(buckets) {
      var seen = {}, merged = [], maxLen = 0;
      buckets.forEach(function (b) { maxLen = Math.max(maxLen, b.length); });
      for (var i = 0; i < maxLen && merged.length < perPage; i++) {
        for (var j = 0; j < buckets.length && merged.length < perPage; j++) {
          var row = buckets[j][i];
          if (!row || seen[row.id]) continue;
          seen[row.id] = true; merged.push(row);
        }
      }
      return shape(merged);
    }
    var wideQuery = "query($input:PerformerQueryInput!){queryPerformers(input:$input){performers{id name gender birth_date images{url} scene_count}}}";
    return SSD.boxRateLimiter.submit(function () {
      return SSD.callBoxGQL(box.endpoint, box.apiKey, wideQuery,
        { input: { sort: "LAST_SCENE", direction: "DESC", page: 1, per_page: Math.max(perPage * 3, 90) } },
        BOX_TIMEOUT);
    }).then(function (data) {
      var rows = ((((data || {}).queryPerformers) || {}).performers) || [];
      var kept = rows.filter(function (r) { return r.gender && allowed[r.gender]; });
      if (kept.length >= Math.min(perPage, 12)) {
        // 按 gender 分桶轮转交错（binge：避免排头全是多数性别）
        var buckets = [];
        Object.keys(allowed).forEach(function (g) { buckets.push(kept.filter(function (r) { return r.gender === g; })); });
        return { performers: interleave(buckets), degraded: false };
      }
      // 降级：按性别逐查（20s 超时兜底）
      return Promise.all(Object.keys(allowed).map(function (g) {
        return SSD.boxRateLimiter.submit(function () {
          return SSD.callBoxGQL(box.endpoint, box.apiKey, wideQuery,
            { input: { gender: g, sort: "LAST_SCENE", direction: "DESC", page: 1, per_page: perPage } },
            20000);
        }).then(function (d) {
          return ((((d || {}).queryPerformers) || {}).performers) || [];
        }).catch(function () { return []; });
      })).then(function (perGender) { return { performers: interleave(perGender), degraded: true }; });
    });
  }

  // ── 2.3 SWR 缓存（localStorage，按源 host + 窗口参数分键）────────────────
  // .v2（2026-10-25）：场景数据 performers 增 images 字段，旧缓存无共同出演头像
  function cacheKey(host, family) { return LS_PREFIX + host + ":" + family + ".v2"; }

  function cacheRead(host, family, wantSince) {
    try {
      var raw = localStorage.getItem(cacheKey(host, family));
      if (!raw) return null;
      var e = JSON.parse(raw);
      if (!e || typeof e !== "object" || !Array.isArray(e.scenes)) return null;
      if (wantSince && e.sinceIsoDate !== wantSince) return null;
      var age = Date.now() - (e.fetchedAt || 0);
      if (age < 0 || age > CACHE_TTL_MS) return null;
      return e;
    } catch (_) { return null; }
  }

  // SWR 陈旧读：忽略 since/TTL，只卡 7d 上限——给"先进缓存立刻可看"路径
  function cacheReadStale(host, family) {
    try {
      var raw = localStorage.getItem(cacheKey(host, family));
      if (!raw) return null;
      var e = JSON.parse(raw);
      if (!e || typeof e !== "object" || !Array.isArray(e.scenes)) return null;
      var age = Date.now() - (e.fetchedAt || 0);
      if (age < 0 || age > CACHE_STALE_MAX_MS) return null;
      return e;
    } catch (_) { return null; }
  }

  function cacheWrite(host, family, sinceIsoDate, scenes) {
    try {
      var store = scenes;
      if (store.length > CACHE_SCENES_CAP) {
        store = store.slice().sort(function (a, b) {
          return String(b.release_date || "").localeCompare(String(a.release_date || ""));
        }).slice(0, CACHE_SCENES_CAP);
      }
      localStorage.setItem(cacheKey(host, family), JSON.stringify({
        sinceIsoDate: sinceIsoDate || null, fetchedAt: Date.now(), scenes: store,
      }));
      // 清同家族旧版本 key（防版本升级孤儿条目占配额）
      var keep = cacheKey(host, family), stale = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX + host + ":" + family + ".") === 0 && k !== keep) stale.push(k);
      }
      stale.forEach(function (k) { localStorage.removeItem(k); });
    } catch (_) { /* 配额等：忽略 */ }
  }

  // 刷新按钮/切源后强制拉新：清当前源全部发现页缓存
  function cacheInvalidate(host) {
    try {
      var stale = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX + host + ":") === 0) stale.push(k);
      }
      stale.forEach(function (k) { localStorage.removeItem(k); });
    } catch (_) {}
    invalidateLocalMemos();
  }

  // ── 2.2 筛选管线（§4.3 双键排除 + code 跨源去重 + 每人上限）─────────────
  function filterPipeline(rawScenes, box, ownedKeys, linked) {
    var linkedByStashId = {};
    linked.forEach(function (p) { linkedByStashId[p.stashId] = p; });
    var today = SSD.localDateStr(new Date());
    var seenCode = {}, latest = [], preview = [];
    var byActor = {}; // localId → {performer, items, newest}

    rawScenes.forEach(function (sc) {
      if (!sc) return;
      var epKey = box.endpoint.toLowerCase() + ":" + String(sc.id).toLowerCase();
      if (ownedKeys[epKey]) return;                       // 已拥有：stash_id 键
      if (sc.code) {
        var ck = "code:" + String(sc.code).trim().toLowerCase();
        if (ownedKeys[ck]) return;                        // 已拥有：code 键
        if (seenCode[ck]) return;                         // code 跨源去重
        seenCode[ck] = true;
      }
      var item = shapeBoxItem(box, sc);
      var isFuture = sc.release_date && sc.release_date > today;
      if (isFuture) preview.push(item); else latest.push(item);
      // 演员分组统计（cap 前的真实计数，§3.2 模块 1 的 "N 部新作品"）
      var perfs = (sc.performers || []);
      for (var i = 0; i < perfs.length; i++) {
        var pf = perfs[i] && perfs[i].performer;
        if (!pf) continue;
        var lp = linkedByStashId[String(pf.id)];
        if (!lp) continue;
        var g = byActor[lp.localId];
        if (!g) g = byActor[lp.localId] = { performer: lp, items: [], newest: "" };
        g.items.push(item);
        if (sc.release_date && sc.release_date > g.newest) g.newest = sc.release_date;
      }
    });

    latest.sort(function (a, b) { return String(b.scene.release_date || "").localeCompare(String(a.scene.release_date || "")); });
    preview.sort(function (a, b) { return String(a.scene.release_date || "").localeCompare(String(b.scene.release_date || "")); });

    // 每人上限 2（§4.3：总览模块 + 最新钻取保留；热门不受限）
    function capByActor(list) {
      var n = {};
      return list.filter(function (it) {
        var keep = false;
        var perfs = (it.scene.performers || []);
        var matched = false;
        for (var i = 0; i < perfs.length; i++) {
          var pf = perfs[i] && perfs[i].performer;
          if (!pf) continue;
          var lp = linkedByStashId[String(pf.id)];
          if (!lp) continue;
          matched = true;
          if ((n[lp.localId] || 0) < capPerActor()) keep = true;
        }
        if (!matched) return true; // 无库内演员匹配（理论少见）不丢
        if (keep) {
          for (var j = 0; j < perfs.length; j++) {
            var pf2 = perfs[j] && perfs[j].performer;
            if (!pf2) continue;
            var lp2 = linkedByStashId[String(pf2.id)];
            if (lp2) n[lp2.localId] = (n[lp2.localId] || 0) + 1;
          }
        }
        return keep;
      });
    }

    var actorsWithNew = [];
    Object.keys(byActor).forEach(function (lid) {
      var g = byActor[lid];
      g.items.sort(function (a, b) { return String(b.scene.release_date || "").localeCompare(String(a.scene.release_date || "")); });
      actorsWithNew.push(g);
    });
    actorsWithNew.sort(function (a, b) {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      return String(b.newest).localeCompare(String(a.newest));
    });

    return { latest: capByActor(latest), preview: capByActor(preview), actorsWithNew: actorsWithNew };
  }

  // ── 聚合入口（P3/P4 消费；暴露到 SSD.dp 供控制台验证）────────────────────
  // resolveBase(): 源 + 窗口参数（yml recentDays/previewDays）
  function resolveBase() {
    return Promise.all([SSD.getStashBoxes(), SSD.getPluginSettings()]).then(function (r) {
      var boxes = (r[0] || []).filter(function (b) { return b && b.endpoint; });
      var yml = r[1] || {};
      var src = resolveSource(boxes, yml);
      if (!src) throw { ssdKind: "no-box", message: "no stash-box configured" };
      var recentDays = toNum(yml.recentDays, 30);
      var since = recentDays > 0 ? SSD.recentCutoffDate(recentDays) : null;
      var previewDays = toNum(yml.previewDays, 7);
      var previewCutoff = SSD.previewCutoffDate(previewDays);
      return { boxes: boxes, yml: yml, source: src, since: since, previewCutoff: previewCutoff, recentDays: recentDays, previewDays: previewDays };
    });
  }

  // linked + ownedKeys 不随场景缓存轮转：单独 key、无 TTL（本地查询，便宜且稳定）。
  // 读路径：缓存命中 → 否则会话 memo → 否则现场查。
  function cacheWriteLinkedOwned(host, linked, ownedKeys) {
    try {
      localStorage.setItem(LS_PREFIX + host + ":local.v1", JSON.stringify({ fetchedAt: Date.now(), linked: linked, ownedKeys: ownedKeys }));
    } catch (_) {}
  }

  function loadLinkedOwned(host, endpoint) {
    try {
      var raw = localStorage.getItem(LS_PREFIX + host + ":local.v1");
      if (raw) {
        var e = JSON.parse(raw);
        if (e && Array.isArray(e.linked) && e.ownedKeys && typeof e.ownedKeys === "object") {
          return Promise.resolve({ linked: e.linked, ownedKeys: e.ownedKeys });
        }
      }
    } catch (_) {}
    return Promise.all([loadLinkedPerformers(endpoint), loadOwnedKeys()]).then(function (r) {
      cacheWriteLinkedOwned(host, r[0], r[1]);
      return { linked: r[0], ownedKeys: r[1] };
    });
  }

  // 演员侧全量：SWR（stale 先出 + 后台刷新）→ 12h fresh 命中直接用
  function getDiscoverData(opts) {
    opts = opts || {};
    return resolveBase().then(function (base) {
      var host = base.source.host;
      if (!opts.force) {
        var fresh = cacheRead(host, "newScenes", base.since);
        if (fresh) {
          return loadLinkedOwned(host, base.source.endpoint).then(function (lo) {
            return buildResult(base, { scenes: fresh.scenes, fetchedAt: fresh.fetchedAt, linked: lo.linked, ownedKeys: lo.ownedKeys }, "fresh");
          });
        }
      }
      // SWR：陈旧缓存立刻出，后台静默刷新（不等待）
      if (!opts.force && !opts.noStale) {
        var stale = cacheReadStale(host, "newScenes");
        if (stale) {
          refreshDiscover(base, opts);
          return loadLinkedOwned(host, base.source.endpoint).then(function (lo) {
            return buildResult(base, { scenes: stale.scenes, fetchedAt: stale.fetchedAt, linked: lo.linked, ownedKeys: lo.ownedKeys }, "stale");
          });
        }
      }
      return refreshDiscover(base, opts);
    });
  }

  function buildResult(base, entry, fromCache) {
    var linked = entry.linked || [];
    var filtered = filterPipeline(entry.scenes || [], base.source, entry.ownedKeys || {}, linked);
    return {
      source: base.source, boxes: base.boxes,
      since: base.since, previewCutoff: base.previewCutoff,
      recentDays: base.recentDays, previewDays: base.previewDays,
      fetchedAt: entry.fetchedAt, fromCache: fromCache,
      linkedCount: linked.length,
      // linked 一并暴露：发现演员"共同出演"排除在库演员（§3.5）、关注视图
      // 头像渲染、场景卡 popover 的本地演员映射（§8.1）都依赖完整列表。
      linked: linked,
      latest: filtered.latest, preview: filtered.preview, actorsWithNew: filtered.actorsWithNew,
    };
  }

  function refreshDiscover(base, opts) {
    var host = base.source.host;
    var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: host };
    // 先取库内演员（分批查询的输入依赖它），再并行取 owned keys + box 场景
    return loadLinkedPerformers(base.source.endpoint).then(function (linked) {
      var ids = linked.map(function (p) { return p.stashId; });
      return Promise.all([loadOwnedKeys(), fetchNewScenesForPerformers(box, ids, base.since)]).then(function (r) {
        var ownedKeys = r[0], scenes = r[1];
        if (scenes == null) throw { ssdKind: "box", message: "partial fetch failure" };
        cacheWrite(host, "newScenes", base.since, scenes);
        cacheWriteLinkedOwned(host, linked, ownedKeys);
        return buildResult(base, { sinceIsoDate: base.since, fetchedAt: Date.now(), scenes: scenes, linked: linked, ownedKeys: ownedKeys }, "network");
      });
    });
  }

  // §5 热门榜（TRENDING 原样 + 库内演员角标标记）
  function getTrendingData(opts) {
    opts = opts || {};
    return resolveBase().then(function (base) {
      var host = base.source.host;
      if (!opts.force) {
        var fresh = cacheRead(host, "trending", null);
        if (fresh) return buildTrending(base, fresh, "fresh");
      }
      var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: host };
      return fetchTrendingScenes(box).then(function (scenes) {
        if (scenes == null) throw { ssdKind: "box", message: "trending fetch failed" };
        cacheWrite(host, "trending", null, scenes);
        return buildTrending(base, { fetchedAt: Date.now(), scenes: scenes }, "network");
      });
    });
  }

  function buildTrending(base, entry, fromCache) {
    var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: base.source.host };
    var linkedSet = {};
    var linkedPromise = loadLinkedPerformers(base.source.endpoint);
    return linkedPromise.then(function (linked) {
      linked.forEach(function (p) { linkedSet[p.stashId] = true; });
      var items = (entry.scenes || []).map(function (sc) {
        var item = shapeBoxItem(box, sc);
        var hasLocal = false;
        var perfs = sc.performers || [];
        for (var i = 0; i < perfs.length; i++) {
          var pf = perfs[i] && perfs[i].performer;
          if (pf && linkedSet[String(pf.id)]) { hasLocal = true; break; }
        }
        item.hasLocalPerformer = hasLocal; // §5 角标标记
        return item;
      });
      return { source: base.source, fetchedAt: entry.fetchedAt, fromCache: fromCache, items: items };
    });
  }

  // §4.6 工作室管线
  function getStudioData(opts) {
    opts = opts || {};
    return resolveBase().then(function (base) {
      var host = base.source.host;
      if (!opts.force) {
        var fresh = cacheRead(host, "studios", base.since);
        if (fresh) return buildStudio(base, fresh, "fresh");
      }
      var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: host };
      return Promise.all([loadFavoriteStudios(base.source.endpoint), loadOwnedKeys()]).then(function (r) {
        var studios = r[0], ownedKeys = r[1];
        if (!studios.length) {
          var emptyEntry = { sinceIsoDate: base.since, fetchedAt: Date.now(), scenes: [] };
          cacheWrite(host, "studios", base.since, []);
          return buildStudio(base, emptyEntry, "network");
        }
        var ids = studios.map(function (s) { return s.stashId; });
        return fetchStudioScenes(box, ids, base.since).then(function (scenes) {
          if (scenes == null) throw { ssdKind: "box", message: "studio fetch failed" };
          cacheWrite(host, "studios", base.since, scenes);
          return buildStudio(base, { sinceIsoDate: base.since, fetchedAt: Date.now(), scenes: scenes, ownedKeys: ownedKeys, studios: studios }, "network");
        });
      });
    });
  }

  function buildStudio(base, entry, fromCache) {
    var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: base.source.host };
    var studioByStashId = {};
    return Promise.all([loadFavoriteStudios(base.source.endpoint), loadOwnedKeys()]).then(function (r) {
      var studios = r[0], ownedKeys = r[1] || entry.ownedKeys || {};
      // stash_id 大小写两端不保证一致（stash_ids 端点数据 vs 场景 studio.id），
      // 键统一小写防止 localId/image 丢失
      studios.forEach(function (s) { studioByStashId[String(s.stashId).toLowerCase()] = s; });
      var today = SSD.localDateStr(new Date());
      var seenCode = {}, items = [], byStudio = {};
      (entry.scenes || []).forEach(function (sc) {
        if (!sc || !sc.studio) return;
        var epKey = box.endpoint.toLowerCase() + ":" + String(sc.id).toLowerCase();
        if (ownedKeys[epKey]) return;
        if (sc.code) {
          var ck = "code:" + String(sc.code).trim().toLowerCase();
          if (ownedKeys[ck] || seenCode[ck]) return;
          seenCode[ck] = true;
        }
        var item = shapeBoxItem(box, sc);
        items.push(item);
        var stId = String(sc.studio.id);
        var g = byStudio[stId];
        if (!g) g = byStudio[stId] = { studio: studioByStashId[stId.toLowerCase()] || { name: sc.studio.name, stashId: stId }, items: [], newest: "" };
        g.items.push(item);
        if (sc.release_date && sc.release_date > g.newest) g.newest = sc.release_date;
      });
      items.sort(function (a, b) { return String(b.scene.release_date || "").localeCompare(String(a.scene.release_date || "")); });
      var groups = [];
      Object.keys(byStudio).forEach(function (k) {
        var g = byStudio[k];
        g.items.sort(function (a, b) { return String(b.scene.release_date || "").localeCompare(String(a.scene.release_date || "")); });
        groups.push(g);
      });
      groups.sort(function (a, b) {
        if (b.items.length !== a.items.length) return b.items.length - a.items.length;
        return String(b.newest).localeCompare(String(a.newest));
      });
      // §4.6 每工作室上限 2（总览模块 + 钻取均保留；分组计数不受限）
      var n = {};
      var capped = items.filter(function (it) {
        var stId2 = it.scene.studio ? String(it.scene.studio.id) : "";
        if (!stId2) return true;
        if ((n[stId2] || 0) >= capPerStudio()) return false;
        n[stId2] = (n[stId2] || 0) + 1;
        return true;
      });
      return {
        source: base.source, fetchedAt: entry.fetchedAt, fromCache: fromCache,
        studioCount: studios.length, items: capped, groups: groups,
      };
    });
  }

  // 发现演员·热门演员榜（§3.5 子源 2；共同出演子源在 P4 由 latest 数据派生）
  function getTrendingPerformers(opts) {
    opts = opts || {};
    return resolveBase().then(function (base) {
      var host = base.source.host;
      var prefs = dpPrefs();
      var genders = prefs.genderFilter && prefs.genderFilter.length ? prefs.genderFilter : ["FEMALE", "TRANSGENDER_FEMALE"];
      if (!opts.force) {
        try {
          var raw = localStorage.getItem(LS_PREFIX + host + ":trendingPerf.v1");
          if (raw) {
            var e = JSON.parse(raw);
            if (e && Date.now() - (e.fetchedAt || 0) < TRENDING_PERF_CACHE_TTL_MS && Array.isArray(e.performers)) {
              return { source: base.source, fromCache: "fresh", performers: e.performers };
            }
          }
        } catch (_) {}
      }
      var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: host };
      return fetchTrendingPerformers(box, opts.perPage || 24, genders).then(function (r) {
        try {
          localStorage.setItem(LS_PREFIX + host + ":trendingPerf.v1", JSON.stringify({ fetchedAt: Date.now(), performers: r.performers }));
        } catch (_) {}
        return { source: base.source, fromCache: "network", performers: r.performers, degraded: r.degraded };
      });
    });
  }

  // 刷新入口（刷新按钮）：清缓存 + 重拉（P4 接线）。
  // 本地 memo（linked/owned/收藏工作室）一并失效——会话内收藏了新工作室、
  // 或库变动后点刷新，工作室模块才不会继续读到旧 memo（空收藏）。
  function refreshAll() {
    return resolveBase().then(function (base) {
      cacheInvalidate(base.source.host);
      invalidateLocalMemos();
      return base;
    });
  }

  // P2 验证 + P3/P4 消费出口（控制台可调用 SSD.dp.*）
  SSD.dp = {
    getDiscoverData: getDiscoverData,
    getTrendingData: getTrendingData,
    getStudioData: getStudioData,
    getTrendingPerformers: getTrendingPerformers,
    refreshAll: refreshAll,
    invalidateLocalMemos: invalidateLocalMemos,
    prefs: dpPrefs,
  };

  // 加入库事件 → 本地 memo 失效（缓存里场景仍含已拥有项，但 filterPipeline
  // 用的是新鲜 ownedKeys，下次 buildResult 会正确排除；场景缓存 12h 自然轮转）
  window.addEventListener(SSD.SCENE_SAVED_EVENT, invalidateLocalMemos);


  // ═══ 页面状态 + 关注/已读 store + 视图机（设计文档 §3/§6/§8）════════════
  var _dp = {
    view: "overview", // overview|follow|latest|trending|preview|performers|studios|settings|perfFilter|studioFilter
    d: {},            // 数据集缓存: latest(=getDiscoverData) trending studios trendingPerf
    err: {},          // 数据集错误（重试可清）
    loading: {},      // 数据集加载中标记
    fetchedAt: 0,     // 数据集最新 fetchedAt（页头相对时间）
    search: "", page: 1,
    boxes: [],        // 已配置 stash-box（数据源下拉）
    refreshing: false,
    followOpenKey: null, // 关注分组展开态（会话级；单一 key = 手风琴，最多展开一位）
    perfGroup: null,  // 演员过滤视图：actorsWithNew 分组引用
    studioGroup: null, // 工作室过滤视图：studio 分组引用
    refs: {},         // chrome 元素引用（head/tabs/toolbar/content）
  };

  function dpSetPrefs(patch) {
    try {
      var p = dpPrefs();
      Object.keys(patch || {}).forEach(function (k) { p[k] = patch[k]; });
      localStorage.setItem(LS_PREFIX + "prefs", JSON.stringify(p));
    } catch (_) {}
  }

  // ── 关注 store（§6.1 轻量订阅，localStorage；P5 补轮询/收藏导入）────────
  var FOLLOW_KEY = "SSD:dp:follow.v1";
  var READ_KEY = "SSD:dp:read.v1";
  var READ_TTL_MS = 7 * 24 * 3600 * 1000; // §6.4 已读 7 天过期

  function followStore() {
    try {
      var raw = localStorage.getItem(FOLLOW_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === "object" && o.performers) ? o : { performers: {} };
    } catch (_) { return { performers: {} }; }
  }
  function followList() {
    var out = [], m = followStore().performers;
    Object.keys(m).forEach(function (k) { out.push(m[k]); });
    out.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    return out;
  }
  function followHas(stashId) { return !!followStore().performers[String(stashId)]; }
  function followToggle(meta) {
    var st = followStore(), k = String(meta.stashId);
    if (st.performers[k]) delete st.performers[k];
    else st.performers[k] = {
      stashId: k, endpoint: meta.endpoint || "", name: meta.name || "",
      image: meta.image || null, localId: meta.localId || null, addedAt: Date.now(),
    };
    try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(st)); } catch (_) {}
    return !!st.performers[k];
  }

  // ── 已读 store（§6.4 场景级：点开/加入库即消）────────────────────────────
  function readStore() {
    try {
      var raw = localStorage.getItem(READ_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === "object" && o.marks) ? o : { marks: {} };
    } catch (_) { return { marks: {} }; }
  }
  function sceneKey(endpoint, sceneId) { return String(endpoint).toLowerCase() + ":" + String(sceneId).toLowerCase(); }
  function readIs(endpoint, sceneId) { return !!readStore().marks[sceneKey(endpoint, sceneId)]; }
  function readMark(endpoint, sceneId) {
    var st = readStore(), now = Date.now();
    st.marks[sceneKey(endpoint, sceneId)] = now;
    // 顺手清 7 天过期（§6.4 兜底）
    Object.keys(st.marks).forEach(function (k) { if (now - st.marks[k] > READ_TTL_MS) delete st.marks[k]; });
    try { localStorage.setItem(READ_KEY, JSON.stringify(st)); } catch (_) {}
  }
  function readMarkAll(pairs) {
    pairs.forEach(function (p) { readMark(p[0], p[1]); });
  }

  // 未读数（关注演员的新场景 − 已读）→ "ssd:unread-changed"（§10：导航角标
  // 与本页 follow tab 红点都监听该事件；P5 轮询复用同一事件流）
  function computeUnread() {
    var d = _dp.d.latest;
    if (!d) return 0;
    var m = followStore().performers;
    if (!Object.keys(m).length) return 0;
    var n = 0;
    (d.actorsWithNew || []).forEach(function (g) {
      if (!m[String(g.performer.stashId)]) return;
      g.items.forEach(function (it) { if (!readIs(it.endpoint, it.scene.id)) n++; });
    });
    return n;
  }
  function emitUnread() {
    var n = computeUnread();
    // 持久化轮询同款缓存（unread.v1）：主 JS 导航角标硬刷新后用它恢复初值
    try { localStorage.setItem("SSD:dp:unread.v1", JSON.stringify({ n: n, at: Date.now() })); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent("ssd:unread-changed", { detail: n })); } catch (_) {}
  }

  // §6.2 收藏(❤)一键导入：库内 favorite 演员 → 关注列表。
  // 关注页是单源口径（只显示当前数据源的新作），导入同样只取**当前数据源**的
  // stash_id 关联，避免导入别源演员后关注页永远「回看期内暂无新作品」
  // （用户 2026-10-25 第七轮确认）。
  // 已关注的跳过（保留原 addedAt）。返回 {imported, skipped, noId}。
  function importFavoritesFromLibrary() {
    return resolveBase().then(function (base) {
      var srcEp = String(base.source.endpoint).toLowerCase();
      return SSD.callGQL(
        "query{findPerformers(performer_filter:{filter_favorites:true},filter:{per_page:-1}){performers{id name image_path stash_ids{endpoint stash_id}}}}"
      ).then(function (data) {
        var perfs = (((data || {}).findPerformers || {}).performers) || [];
        var st = followStore();
        var imported = 0, skipped = 0, noId = 0;
        perfs.forEach(function (pf) {
          var ids = pf.stash_ids || [];
          var hit = null;
          for (var i = 0; i < ids.length; i++) {
            if (ids[i].stash_id && String(ids[i].endpoint).toLowerCase() === srcEp) { hit = ids[i]; break; }
          }
          if (!hit) { noId++; return; }
          var k = String(hit.stash_id);
          if (st.performers[k]) { skipped++; return; }
          st.performers[k] = {
            stashId: k, endpoint: hit.endpoint, name: pf.name || "",
            image: pf.image_path || null, localId: String(pf.id), addedAt: Date.now(),
          };
          imported++;
        });
        try { localStorage.setItem(FOLLOW_KEY, JSON.stringify(st)); } catch (_) {}
        return { imported: imported, skipped: skipped, noId: noId };
      });
    });
  }

  // 导入按钮（关注视图 followbar 与空状态共用工厂）
  function makeImportButton() {
    var btn = el("button", "ssd-dp-btn ghost", I.heartFill + "<span>" + tc("从收藏导入", "Import ❤ favorites") + "</span>");
    btn.type = "button";
    btn.addEventListener("click", function () {
      btn.disabled = true;
      btn.classList.add("loading");
      importFavoritesFromLibrary().then(function (r) {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (r.imported > 0) {
          // 导入的演员立即进入轮询：强制检查一次，绕过 6h 节流
          // （否则刚导入后角标/未读要等下一个 6h 窗口 — 用户 2026-10-25 第七轮）
          if (SSD.pollFollowed) SSD.pollFollowed(true);
          emitUnread(); render(); return;
        }
        btn.classList.add("ok");
        btn.title = tc("库内收藏均已关注，或未关联当前数据源", "Favorites already followed, or not linked to the current source");
        setTimeout(function () { btn.classList.remove("ok"); }, 1200);
      }).catch(function () {
        btn.disabled = false;
        btn.classList.remove("loading");
        btn.classList.add("err");
        setTimeout(function () { btn.classList.remove("err"); }, 1200);
      });
    });
    return btn;
  }

  // ── 图标（原型 prototype/index.html 同款 SVG）────────────────────────────
  function sv(p, fill) {
    return '<svg viewBox="0 0 24 24" fill="' + (fill || "none") + '" stroke="currentColor" stroke-width="' +
      (fill === "currentColor" ? "0" : "2") + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>";
  }
  var I = {
    overview: sv('<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
    follow: sv('<path d="M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 22.5 7.5 21 11c-2 4.5-9 9-9 9z"/>'),
    latest: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
    trending: sv('<path d="M12 3s5 4 5 9a5 5 0 0 1-10 0c0-2 1-3.5 2-5 .5 1.5 1.5 2 2.5 2C11 7 11 5 12 3z"/>'),
    preview: sv('<path d="M8 5v14l11-7z"/>'),
    performers: sv('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.8 1.2 2 2 3.5 2s2.7-.8 3.5-2"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
    studios: sv('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    settings: sv('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>'),
    star: sv('<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8z"/>', "currentColor"),
    ext: sv('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    refresh: sv('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>'),
    grid: sv('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    list: sv('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
    heartFill: sv('<path d="M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 22.5 7.5 21 11c-2 4.5-9 9-9 9z"/>', "currentColor"),
    check: sv('<path d="M20 6L9 17l-5-5"/>'),
  };

  // ── 通用小件 ─────────────────────────────────────────────────────────────
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function relTime(ts) {
    if (!ts) return "";
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return tc("刚刚更新", "updated just now");
    var m = Math.floor(s / 60);
    if (m < 60) return tc(m + " 分钟前更新", "updated " + m + " min ago");
    var h = Math.floor(m / 60);
    if (h < 24) return tc(h + " 小时前更新", "updated " + h + " h ago");
    return tc(Math.floor(h / 24) + " 天前更新", "updated " + Math.floor(h / 24) + " d ago");
  }
  // 字母头像（stash-box 场景数据不带演员头像时的兜底；原型 avatar() 同款）
  function letterAvatar(name) {
    var P = [["#1a2a3a", "#2d4a66"], ["#2a1a2e", "#533558"], ["#122a24", "#2c5546"],
             ["#301a1a", "#663535"], ["#1f1a2e", "#3f3566"], ["#2e2a14", "#5c5330"]];
    var h = 0, s = String(name || "?");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var p = P[h % P.length], ch = s.trim().charAt(0) || "?";
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
      '<defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + p[1] + '"/><stop offset="1" stop-color="' + p[0] + '"/></linearGradient></defs>' +
      '<rect width="96" height="96" fill="url(#a)"/>' +
      '<circle cx="48" cy="38" r="17" fill="#fff" fill-opacity=".55"/>' +
      '<path d="M18 88c4-19 14-28 30-28s26 9 30 28z" fill="#fff" fill-opacity=".55"/>' +
      '<text x="48" y="58" font-family="Segoe UI,sans-serif" font-size="28" font-weight="700" fill="#fff" fill-opacity=".9" text-anchor="middle">' +
      ch.replace(/[<>&]/g, "") + "</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function daysUntilText(dstr) {
    var d1 = new Date(dstr + "T00:00:00"), d0 = new Date(SSD.localDateStr(new Date()) + "T00:00:00");
    var n = Math.round((d1 - d0) / 86400000);
    if (isNaN(n) || n <= 0) return tc("今天上映", "out today");
    return tc(n + " 天后上映", "in " + n + " days");
  }
  function itemHaystack(it) {
    var sc = it.scene || {};
    return [sc.title, sc.code, sc.details, sc.studio && sc.studio.name,
      (sc.performers || []).map(function (p) { return p.performer && p.performer.name; }).join(" "),
      it.boxName].filter(Boolean).join(" ").toLowerCase();
  }
  function filterItems(list) {
    var q = _dp.search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (it) { return itemHaystack(it).indexOf(q) !== -1; });
  }
  function sortItems(list, sort) {
    var out = list.slice();
    if (sort === "date-asc") {
      out.sort(function (a, b) { return String(a.scene.release_date || "").localeCompare(String(b.scene.release_date || "")); });
    } else if (sort === "title") {
      out.sort(function (a, b) {
        var ta = a.scene.title || a.scene.code || "", tb = b.scene.title || b.scene.code || "";
        return ta.localeCompare(tb);
      });
    } else if (sort === "hot") {
      // 原榜顺序（热门钻取的默认）：保持传入顺序
    } else {
      out.sort(function (a, b) { return String(b.scene.release_date || "").localeCompare(String(a.scene.release_date || "")); });
    }
    return out;
  }
  function colsOf(min, half) {
    var w = _dp.refs.content ? _dp.refs.content.clientWidth : 1200;
    // duo（热门∥预告）并排时每列只有半宽（减去 1.1rem 列间距）
    if (half) w = Math.max(0, (w - 17) / 2);
    return Math.max(1, Math.floor(w / (min || 240)));
  }
  // 渲染后按真实列数截断：数第一行卡数 C，只保留 n 行（对窗口宽度/缩放/卡宽
  // 变化免疫——colsOf 只是预过滤上限，行数最终以实际布局为准）
  function trimRows(grid, n) {
    if (!grid || !grid.children.length) return;
    var kids = Array.prototype.slice.call(grid.children);
    var top0 = kids[0].offsetTop;
    var cols = 0;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetTop === top0) cols++; else break;
    }
    if (cols < 1) cols = 1;
    var keep = cols * n;
    if (kids.length > keep) kids.slice(keep).forEach(function (k) { k.remove(); });
  }
  function stateBox(kind, msg, retryFn) {
    var b = el("div", "ssd-dp-state");
    if (kind === "loading") {
      b.innerHTML = '<span class="ssd-dp-loading-dots"><i></i><i></i><i></i></span><div>' +
        (msg || tc("加载中…", "Loading…")) + "</div>";
    } else if (kind === "error") {
      b.innerHTML = (msg || tc("加载失败", "Load failed")) + "";
      var r = el("button", "ssd-dp-retry", tc("重试", "Retry"));
      r.type = "button";
      r.onclick = function () { if (retryFn) retryFn(); };
      b.appendChild(r);
    } else {
      b.innerHTML = msg || tc("暂无内容", "Nothing here yet");
    }
    return b;
  }

  // ── 数据编排（渐进加载：每个数据集到达即重渲染）──────────────────────────
  var DATASETS = {
    latest: function (o) { return getDiscoverData(o); },
    trending: function (o) { return getTrendingData(o); },
    studios: function (o) { return getStudioData(o); },
    trendingPerf: function (o) { return getTrendingPerformers(o); },
  };
  function viewDataKeys(view) {
    switch (view) {
      case "overview": return ["latest", "trending", "studios", "trendingPerf"];
      case "latest": case "preview": case "follow": return ["latest"];
      case "trending": return ["trending"];
      case "studios": return ["studios"];
      case "performers": return ["latest", "trendingPerf"];
      case "perfFilter": return ["latest"];
      case "studioFilter": return ["studios"];
      default: return [];
    }
  }
  function ensureData(keys, force) {
    keys.forEach(function (k) {
      if (!DATASETS[k]) return;
      if (_dp.d[k] && !force) return;
      if (_dp.loading[k]) return;
      if (_dp.err[k] && !force) return; // 出错后等用户重试，不自动循环
      _dp.loading[k] = true; _dp.err[k] = null;
      DATASETS[k]({ force: !!force }).then(function (r) {
        _dp.d[k] = r; _dp.loading[k] = false;
        _dp.fetchedAt = Math.max(_dp.fetchedAt, r.fetchedAt || 0);
        if (k === "latest") { _dp.boxes = r.boxes || []; syncSourceSelect(); }
        emitUnread();
        render();
      }).catch(function (e) {
        _dp.loading[k] = false; _dp.err[k] = e;
        render();
      });
    });
  }
  function pollSettled(keys, cb) {
    var t = setInterval(function () {
      var busy = keys.some(function (k) { return _dp.loading[k]; });
      if (!busy) { clearInterval(t); cb(); }
    }, 150);
    setTimeout(function () { clearInterval(t); cb(); }, 60000); // 兜底
  }
  function errText(e) {
    if (!e) return tc("未知错误", "Unknown error");
    if (e.ssdKind === "no-box") return tc("未配置 stash-box，请先在 Stash 设置中添加", "No stash-box configured — add one in Stash settings first");
    return SSD.boxErrText ? (SSD.boxErrText(e) || e.message || String(e)) : (e.message || String(e));
  }

  // ── 场景卡（SSD.buildSceneCard 原生结构 1:1 + 发现页徽标装饰）────────────
  function localPerfMaps() {
    var d = _dp.d.latest, m = {};
    if (d && d.linked && d.source) {
      var map = {};
      d.linked.forEach(function (p) { map[String(p.stashId).toLowerCase()] = { id: p.localId, name: p.name, image_path: p.image }; });
      m[String(d.source.endpoint).toLowerCase()] = map;
    }
    return m;
  }
  function cardCtx() {
    // queryBoxes 传空：发现页按源查询（单源目标），封面左下角不显示源名徽标
    // （buildSceneCard 仅在多源上下文渲染该徽标）— 用户 2026-10-25
    return { zoom: 0, queryBoxes: [], localPerformerMaps: localPerfMaps() };
  }
  // decorateCard：预告"X 天后上映"绿标（替换 buildSceneCard 的黄色彩点）、
  // 热门榜"库内"小角标（§5）、关注未读红框（§3.4）
  function decorateCard(card, item, opts) {
    opts = opts || {};
    var sc = item.scene || {};
    var previewEl = card.querySelector(".scene-card-preview");
    if (previewEl) {
      if (opts.days) {
        var old = previewEl.querySelector(".ssd-overlay-preview");
        if (old) old.remove();
        if (sc.release_date && sc.release_date > SSD.localDateStr(new Date())) {
          previewEl.appendChild(el("span", "ssd-overlay-days", daysUntilText(sc.release_date)));
        }
      }
      if (item.hasLocalPerformer) {
        previewEl.appendChild(el("span", "ssd-overlay-inlib", tc("库内", "In library")));
      }
    }
    if (opts.unread && !readIs(item.endpoint, sc.id)) {
      card.classList.add("ssd-card-new");
      card.addEventListener("click", function () {
        readMark(item.endpoint, sc.id);
        emitUnread();
        if (_dp.view === "follow") render();
      });
    }
    return card;
  }
  function sceneGrid(items, opts) {
    opts = opts || {};
    if (_dp.mode === "list" && opts.allowList) return SSD.buildSceneTable(items);
    var grid = el("div", "ssd-card-grid");
    grid.setAttribute("data-zoom", "0");
    var ctx = cardCtx();
    items.forEach(function (it, i) {
      grid.appendChild(decorateCard(SSD.buildSceneCard(it, i, ctx), it, opts));
    });
    return grid;
  }

  // ── 迷你演员卡（§3.2 模块 1/6）───────────────────────────────────────────
  function miniPerfCard(o) {
    var c = el("div", "ssd-dp-mini");
    var img = document.createElement("img");
    img.loading = "lazy";
    img.alt = o.name || "";
    img.src = o.image || letterAvatar(o.name);
    img.onerror = function () { this.src = letterAvatar(o.name); };
    c.appendChild(img);
    var tx = el("div", null);
    tx.style.minWidth = "0";
    tx.appendChild(el("div", "ssd-dp-mini-name", o.name || tc("未知演员", "Unknown")));
    if (o.sub) tx.appendChild(el("div", "ssd-dp-mini-sub", o.sub));
    c.appendChild(tx);
    if (o.badge) {
      var b = el("span", "ssd-dp-mini-badge" + (o.badgeKind ? " " + o.badgeKind : ""), o.badge);
      c.appendChild(b);
    }
    if (o.heart) {
      c.appendChild(el("span", "ssd-mini-heart", I.heartFill));
    }
    if (o.onClick) c.addEventListener("click", function (e) { o.onClick(e, c); });
    return c;
  }

  // ── 模块段（§3.2）────────────────────────────────────────────────────────
  function sec(parent, o) {
    var s = el("section", "ssd-dp-sec");
    var h = el("div", "ssd-dp-sec-head");
    h.appendChild(el("h2", "ssd-dp-sec-title", (o.icon || "") + "<span>" + o.title + "</span>"));
    if (o.count) h.appendChild(el("span", "ssd-dp-sec-count", o.count));
    if (o.more) {
      var m = el("button", "ssd-dp-sec-more", tc("查看更多 →", "More →"));
      m.type = "button";
      m.addEventListener("click", o.more);
      h.appendChild(m);
    }
    s.appendChild(h);
    parent.appendChild(s);
    return s;
  }
  function secBody(s, kind, msg, retry) {
    if (kind) { s.appendChild(stateBox(kind, msg, retry)); return null; }
    var b = el("div");
    s.appendChild(b);
    return b;
  }

  // ── 总览 6 模块（§3.2 默认顺序；§3.7 排序/开关/行数由 prefs 驱动）─────────
  var MODULE_DEFS = [
    { id: "actors", zh: "有新发布的演员", en: "Performers with releases" },
    { id: "latest", zh: "最新发布", en: "Latest" },
    { id: "trending", zh: "热门", en: "Trending" },
    { id: "preview", zh: "即将发布", en: "Upcoming" },
    { id: "studios", zh: "工作室新发布", en: "Studio releases" },
    { id: "performers", zh: "发现演员", en: "Discover performers" },
  ];
  var DEFAULT_ROWS = { actors: 1, latest: 2, trending: 1, preview: 1, studios: 1, performers: 1 };

  // prefs.order 防御性归一：补缺失模块、滤未知 id（§3.7 上移/下移写入）
  function moduleOrder() {
    var prefs = dpPrefs();
    var order = (prefs.order && Array.isArray(prefs.order)) ? prefs.order.slice() : [];
    MODULE_DEFS.forEach(function (m) { if (order.indexOf(m.id) < 0) order.push(m.id); });
    var known = {};
    MODULE_DEFS.forEach(function (m) { known[m.id] = true; });
    return order.filter(function (id) { return known[id]; });
  }
  function moduleShown(id) {
    var mods = dpPrefs().modules;
    return !(mods && mods[id] === false);
  }
  function overviewRows() {
    var prefs = dpPrefs();
    var rows = {};
    Object.keys(DEFAULT_ROWS).forEach(function (k) { rows[k] = DEFAULT_ROWS[k]; });
    if (prefs.rows && typeof prefs.rows === "object") {
      Object.keys(rows).forEach(function (k) {
        var n = parseInt(prefs.rows[k], 10);
        if (n >= 1 && n <= 3) rows[k] = n;
      });
    }
    return rows;
  }
  function moveModule(id, dir) {
    var order = moduleOrder();
    var i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    var t = order[i]; order[i] = order[j]; order[j] = t;
    dpSetPrefs({ order: order });
    render();
  }

  function renderOverview(c) {
    var rows = overviewRows();
    var order = moduleOrder().filter(moduleShown);
    var i = 0;
    while (i < order.length) {
      var id = order[i], nxt = order[i + 1];
      // 热门∥即将发布相邻时并排（duo），被排序拆开则各自全宽。
      // duo 先入文档再渲染模块——trimRows 需要真实布局才能数列数
      if ((id === "trending" && nxt === "preview") || (id === "preview" && nxt === "trending")) {
        var duo = el("div", "ssd-dp-duo");
        c.appendChild(duo);
        renderModule(id, duo, rows);
        renderModule(nxt, duo, rows);
        i += 2;
      } else {
        renderModule(id, c, rows);
        i++;
      }
    }
    if (!order.length) c.appendChild(stateBox("empty",
      tc("所有模块已隐藏，可在设置中重新开启。", "All modules are hidden — re-enable them in Settings.")));
  }

  function renderModule(id, parent, rows) {
    var d = _dp.d.latest, t = _dp.d.trending, st = _dp.d.studios, tp = _dp.d.trendingPerf;

    if (id === "actors") {
      // 模块：有新发布的演员（迷你卡，点击 → 演员过滤视图 §8.1）
      var s1 = sec(parent, {
        icon: I.star, title: tc("有新发布的演员", "Performers with releases"),
        count: d ? tc((d.actorsWithNew || []).length + " 位演员 · " + (d.actorsWithNew || []).reduce(function (n, g) { return n + g.items.length; }, 0) +
          " 部新作品 · 回看 " + d.recentDays + " 天",
          (d.actorsWithNew || []).length + " performers · lookback " + d.recentDays + "d") : "",
        // 查看更多 → 发现演员页「本地有更新」tab（用户 2026-10-25）
        more: function () { dpSetPrefs({ perfSrc: "local" }); switchView("performers"); },
      });
      if (!d) secBody(s1, _dp.err.latest ? "error" : "loading", _dp.err.latest ? errText(_dp.err.latest) : null, retryLatest);
      else if (!(d.actorsWithNew || []).length) secBody(s1, null).appendChild(stateBox("empty", tc("回看期内没有新作品", "No new releases in the lookback window")));
      else {
        var g1 = el("div", "ssd-dp-grid mini");
        d.actorsWithNew.slice(0, rows.actors * 12).forEach(function (grp) {
          g1.appendChild(miniPerfCard({
            name: grp.performer.name,
            image: grp.performer.image,
            sub: tc("最新 " + (grp.newest || "—"), "newest " + (grp.newest || "—")),
            badge: tc(grp.items.length + " 部新作品", grp.items.length + " new"),
            heart: followHas(grp.performer.stashId),
            onClick: function () { _dp.perfGroup = grp; switchView("perfFilter"); },
          }));
        });
        s1.appendChild(g1);
        trimRows(g1, rows.actors);
      }
      return;
    }
    if (id === "latest") {
      // 模块：最新发布（原生场景卡，每人 cap 2）
      var s2 = sec(parent, {
        icon: I.latest, title: tc("最新发布", "Latest"),
        count: d ? tc((d.latest || []).length + " 部未拥有 · 每人最多 2 部", (d.latest || []).length + " unowned · max 2 per performer") : "",
        more: function () { switchView("latest"); },
      });
      if (!d) secBody(s2, _dp.err.latest ? "error" : "loading", null, retryLatest);
      else if (!(d.latest || []).length) secBody(s2, null).appendChild(stateBox("empty", tc("暂无未拥有新场景", "No unowned new scenes")));
      else {
        var g2 = sceneGrid(d.latest.slice(0, rows.latest * colsOf(240) + rows.latest));
        g2.classList.add("ssd-dp-grid");
        s2.appendChild(g2);
        trimRows(g2, rows.latest);
      }
      return;
    }
    if (id === "trending") {
      var s3 = sec(parent, {
        icon: I.trending, title: tc("热门", "Trending"),
        count: t ? tc(SSD.brandNameForEndpoint(t.source.endpoint, t.source.name) + " 全站榜 · 不限库内", "Site-wide · not library-filtered") : "",
        more: function () { switchView("trending"); },
      });
      if (!t) secBody(s3, _dp.err.trending ? "error" : "loading", null, function () { retryDataset("trending"); });
      else if (!(t.items || []).length) secBody(s3, null).appendChild(stateBox("empty", tc("榜单暂无内容", "Empty list")));
      else {
        var g3 = sceneGrid(t.items.slice(0, rows.trending * colsOf(240, true) + rows.trending), { inlib: true });
        g3.classList.add("ssd-dp-grid");
        s3.appendChild(g3);
        trimRows(g3, rows.trending);
      }
      return;
    }
    if (id === "preview") {
      var s4 = sec(parent, {
        icon: I.preview, title: tc("即将发布", "Upcoming"),
        count: d ? tc("未来 " + d.previewDays + " 天 · " + (d.preview || []).length + " 部", "next " + d.previewDays + "d · " + (d.preview || []).length) : "",
        // 查看更多 → 最新视图「预告」子 tab（预告分页并入最新 — 用户 2026-10-25）
        more: function () { dpSetPrefs({ latestSub: "preview" }); switchView("latest"); },
      });
      if (!d) secBody(s4, _dp.err.latest ? "error" : "loading", null, retryLatest);
      else if (!(d.preview || []).length) secBody(s4, null).appendChild(stateBox("empty", tc("近期没有待发布场景", "No upcoming scenes")));
      else {
        var g4 = sceneGrid(d.preview.slice(0, rows.preview * colsOf(240, true) + rows.preview), { days: true });
        g4.classList.add("ssd-dp-grid");
        s4.appendChild(g4);
        trimRows(g4, rows.preview);
      }
      return;
    }
    if (id === "studios") {
      // 模块：工作室新发布（收藏工作室，cap 2/工作室）
      var s5 = sec(parent, {
        icon: I.studios, title: tc("工作室新发布", "Studio releases"),
        count: st ? tc((st.studioCount || 0) + " 个收藏工作室 · 每工作室最多 2 部", (st.studioCount || 0) + " favorites · max 2 per studio") : "",
        more: function () { switchView("studios"); },
      });
      if (!st) secBody(s5, _dp.err.studios ? "error" : "loading", null, function () { retryDataset("studios"); });
      else if (!(st.items || []).length) secBody(s5, null).appendChild(stateBox("empty", tc("收藏的工作室暂无新作品", "No new releases from favorite studios")));
      else {
        var g5 = sceneGrid(st.items.slice(0, rows.studios * colsOf(240) + rows.studios));
        g5.classList.add("ssd-dp-grid");
        s5.appendChild(g5);
        trimRows(g5, rows.studios);
      }
      return;
    }
    if (id === "performers") {
      // 模块：发现演员（共同出演 ∥ 热门榜）
      var s6 = sec(parent, {
        icon: I.performers, title: tc("发现演员", "Discover performers"),
        count: tc("不在库 · 共同出演 / 热门榜", "Not in library · co-starred / trending"),
        more: function () { switchView("performers"); },
      });
      if (!d || !tp) secBody(s6, "loading", null);
      else {
        var g6 = el("div", "ssd-dp-grid mini");
        buildCoStars().slice(0, rows.performers * 12).forEach(function (cs) {
          g6.appendChild(miniPerfCard({
            name: cs.meta.name,
            image: cs.meta.image,
            sub: tc("共同出演 ×" + cs.scenes, "co-starred ×" + cs.scenes),
            badge: tc("共同出演", "Co-star"), badgeKind: "co",
            onClick: function () { openPerfModal({ src: "co", stashId: cs.meta.stashId, name: cs.meta.name, image: cs.meta.image, scenes: cs.scenes, items: cs.items }); },
          }));
        });
        trendingPerfMinis({ limit: Math.max(0, rows.performers * 12 - g6.children.length) }).forEach(function (pm) { g6.appendChild(pm); });
        if (!g6.children.length) s6.appendChild(stateBox("empty", tc("暂无可发现的演员", "No performers to discover")));
        else { s6.appendChild(g6); trimRows(g6, rows.performers); }
      }
      return;
    }
  }

  function retryLatest() { retryDataset("latest"); }
  function retryDataset(k) {
    _dp.err[k] = null;
    ensureData([k], true);
  }

  // 共同出演派生（§3.5 子源 1：actorsWithNew 全量分组提取不在库 co-star）
  function buildCoStars() {
    var d = _dp.d.latest;
    if (!d || !d.linked) return [];
    var lib = {};
    d.linked.forEach(function (p) { lib[String(p.stashId)] = true; });
    var counts = {}, meta = {};
    (d.actorsWithNew || []).forEach(function (g) {
      g.items.forEach(function (it) {
        ((it.scene && it.scene.performers) || []).forEach(function (pp) {
          var pf = pp && pp.performer;
          if (!pf || lib[String(pf.id)]) return;
          var pid = String(pf.id);
          // 头像随场景数据带上（共同出演迷你卡与弹窗即时显示 — 用户 2026-10-25）
          if (!meta[pid]) meta[pid] = { stashId: pid, name: pf.name || "", image: (pf.images && pf.images[0] && pf.images[0].url) || "" };
          if (!counts[pid]) counts[pid] = { n: 0, items: [] };
          counts[pid].n++;
          if (counts[pid].items.length < 12) counts[pid].items.push(it);
        });
      });
    });
    return Object.keys(counts).map(function (k) {
      return { meta: meta[k], scenes: counts[k].n, items: counts[k].items };
    }).sort(function (a, b) { return b.scenes - a.scenes; }).slice(0, 12);
  }
  // 热门演员榜迷你卡（§3.5 子源 2；过滤已在库 §3.5）
  function trendingPerfMinis(o) {
    var d = _dp.d.latest, tp = _dp.d.trendingPerf;
    if (!tp || !d) return [];
    var lib = {};
    (d.linked || []).forEach(function (p) { lib[String(p.stashId)] = true; });
    var out = [], rank = 0;
    (tp.performers || []).forEach(function (pf) {
      if (lib[String(pf.stashId)]) return;
      rank++;
      if (o && o.limit != null && out.length >= o.limit) return;
      if (o && o.limit != null && rank > o.limit * 3) return;
      out.push(miniPerfCard({
        name: pf.name,
        image: pf.image,
        sub: tc((pf.sceneCount || 0) + " 部作品 · 最近有新作", (pf.sceneCount || 0) + " scenes"),
        badge: tc("热门榜 #" + rank, "Trending #" + rank), badgeKind: "hot",
        onClick: function () { openPerfModal({ src: "hot", stashId: pf.stashId, name: pf.name, image: pf.image, sceneCount: pf.sceneCount, rank: rank }); },
      }));
    });
    return out;
  }

  // ── 钻取视图（§3.3：面包屑 + 分页 + 筛选）───────────────────────────────
  // preview 不再是独立页 tab，并入 latest 视图的「预告」子 tab（用户 2026-10-25）；
  // DRILL.preview 保留为 latest+previewSub 时的配置。
  var DRILL = {
    latest: { title: tc("最新发布", "Latest"), key: "latest", items: function (d) { return d.latest || []; }, sort: "date-desc" },
    preview: { title: tc("预告", "Upcoming"), key: "latest", items: function (d) { return d.preview || []; }, sort: "date-asc", days: true },
    trending: { title: tc("热门", "Trending"), key: "trending", items: function (t) { return t.items || []; }, sort: "hot", inlib: true },
    studios: { title: tc("工作室新发布", "Studio releases"), key: "studios", items: function (st) { return st.items || []; }, sort: "date-desc" },
  };
  function latestSub() {
    return dpPrefs().latestSub === "preview" ? "preview" : "new";
  }
  function renderDrill(c, view) {
    var cfg = DRILL[view];
    // latest 视图内嵌「已发布 | 预告」子 tab
    var sub = view === "latest" ? latestSub() : "";
    if (view === "latest" && sub === "preview") cfg = DRILL.preview;
    var ds = _dp.d[cfg.key];
    if (!ds) {
      if (_dp.err[cfg.key]) { c.appendChild(stateBox("error", errText(_dp.err[cfg.key]), function () { retryDataset(cfg.key); })); return; }
      c.appendChild(stateBox("loading"));
      return;
    }
    // 子 tab：已发布 | 预告（预告分页并入最新 — 用户 2026-10-25）
    // 「返回总览」已移除（用户 2026-10-25 第七轮）
    if (view === "latest") {
      var subRow = el("div", "ssd-dp-tabs ssd-dp-subtabs");
      [["new", tc("已发布 · " + (ds.latest || []).length, "Released · " + (ds.latest || []).length)],
       ["preview", tc("预告 · " + (ds.preview || []).length, "Upcoming · " + (ds.preview || []).length)]].forEach(function (pair) {
        var b = el("button", "ssd-dp-tab" + (sub === pair[0] ? " on" : ""), pair[1]);
        b.type = "button";
        b.addEventListener("click", function () {
          dpSetPrefs({ latestSub: pair[0] });
          _dp.page = 1;
          render();
        });
        subRow.appendChild(b);
      });
      c.appendChild(subRow);
    }

    // 工作室钻取：按工作室分组入口条（§8.2 studioFilter 视图的进入点）
    if (view === "studios" && ds.groups && ds.groups.length) {
      var strip = el("div", "ssd-dp-grpstrip");
      ds.groups.forEach(function (gg) {
        var ch = el("button", "ssd-dp-grpchip",
          (gg.studio && gg.studio.name || "?") + " · " + gg.items.length);
        ch.type = "button";
        ch.addEventListener("click", function () { _dp.studioGroup = gg; switchView("studioFilter"); });
        strip.appendChild(ch);
      });
      c.appendChild(strip);
    }

    var prefs = dpPrefs();
    var sort = _dp.sort || cfg.sort;
    var perPage = toNum(prefs.perPage, 24);
    var all = sortItems(filterItems(cfg.items(ds)), sort);
    var totalPages = Math.max(1, Math.ceil(all.length / perPage));
    if (_dp.page > totalPages) _dp.page = 1;
    var start = (_dp.page - 1) * perPage;
    var pageItems = all.slice(start, start + perPage);

    c.appendChild(pagerBar(view, all.length, totalPages, perPage, true));
    if (!all.length) {
      // 工作室钻取无任何收藏工作室 → 提示 + 跳转 Stash 原生工作室列表
      // （用户 2026-10-25 第四轮；有关注但无新发布仍走通用空态）
      if (view === "studios" && !ds.studioCount) {
        var noFav = stateBox("empty",
          tc("还没有收藏的工作室。在 Stash 中收藏（♥）工作室后，其新作品会出现在这里。",
             "No favorited studios yet. Favorite (♥) studios in Stash and their new releases will show up here."));
        var goStash = el("button", "ssd-dp-btn primary", tc("去 Stash 查看", "Open Stash studios"));
        goStash.type = "button";
        goStash.addEventListener("click", function () { window.location.assign("/studios"); });
        noFav.appendChild(goStash);
        c.appendChild(noFav);
      } else {
        c.appendChild(stateBox("empty", _dp.search ? tc("没有匹配的场景", "No matching scenes") : tc("暂无内容", "Nothing here yet")));
      }
    } else {
      c.appendChild(sceneGrid(pageItems, { days: cfg.days, allowList: true }));
    }
    c.appendChild(pagerBar(view, all.length, totalPages, perPage, false));
    SSD.layoutCardGrid();
  }
  function pagerBar(view, total, totalPages, perPage, top) {
    var bar = el("div", "ssd-dp-pagerow");
    var info = el("span", "ssd-dp-pcount",
      tc("第 " + _dp.page + " / " + totalPages + " 页 · 共 " + total + " 部 · 每页 " + perPage,
         "Page " + _dp.page + " / " + totalPages + " · " + total + " items"));
    if (!top) bar.appendChild(info);
    if (totalPages > 1) {
      var pg = el("div", "ssd-dp-pager");
      var prev = el("button", "ssd-dp-pg", "‹");
      prev.type = "button";
      prev.disabled = _dp.page <= 1;
      prev.addEventListener("click", function () { _dp.page--; render(); });
      pg.appendChild(prev);
      var s = Math.max(1, _dp.page - 2), e = Math.min(totalPages, s + 4);
      if (e - s < 4) s = Math.max(1, e - 4);
      for (var p = s; p <= e; p++) {
        (function (pn) {
          var b = el("button", "ssd-dp-pg" + (pn === _dp.page ? " on" : ""), String(pn));
          b.type = "button";
          b.addEventListener("click", function () { _dp.page = pn; render(); });
          pg.appendChild(b);
        })(p);
      }
      var next = el("button", "ssd-dp-pg", "›");
      next.type = "button";
      next.disabled = _dp.page >= totalPages;
      next.addEventListener("click", function () { _dp.page++; render(); });
      pg.appendChild(next);
      bar.appendChild(pg);
    }
    if (top) bar.appendChild(info);
    return bar;
  }

  // ── 发现演员视图（§3.5 双源 + 本地有更新 — 用户 2026-10-25）───────────────
  function renderPerformers(c) {
    var d = _dp.d.latest, tp = _dp.d.trendingPerf;
    var prefs = dpPrefs();
    var src = ["local", "co", "hot"].indexOf(prefs.perfSrc) >= 0 ? prefs.perfSrc : "co";

    // 子切换（本地有更新 | 共同出演 | 热门榜）
    var sub = el("div", "ssd-dp-tabs ssd-dp-subtabs");
    [["local", tc("本地有更新", "Local updates")], ["co", tc("共同出演", "Co-starred")], ["hot", tc("热门演员榜", "Trending performers")]].forEach(function (pair) {
      var b = el("button", "ssd-dp-tab" + (src === pair[0] ? " on" : ""), pair[1]);
      b.type = "button";
      b.addEventListener("click", function () {
        dpSetPrefs({ perfSrc: pair[0] });
        render();
      });
      sub.appendChild(b);
    });
    c.appendChild(sub);

    if (!d) {
      if (_dp.err.latest) { c.appendChild(stateBox("error", errText(_dp.err.latest), retryLatest)); return; }
      c.appendChild(stateBox("loading"));
      return;
    }
    if (src === "hot" && !tp) {
      if (_dp.err.trendingPerf) { c.appendChild(stateBox("error", errText(_dp.err.trendingPerf), function () { retryDataset("trendingPerf"); })); return; }
      c.appendChild(stateBox("loading"));
      return;
    }
    var q = _dp.search.trim().toLowerCase();
    var grid = el("div", "ssd-dp-grid mini");
    var emptyMsg = tc("暂无可发现的演员", "No performers to discover");
    if (src === "local") {
      // 本地所有有更新的演员（搜索可过滤，点击 → 演员过滤视图）
      emptyMsg = tc("回看期内没有新作品", "No new releases in the lookback window");
      (d.actorsWithNew || []).forEach(function (grp) {
        var nm = grp.performer.name || "";
        if (q && nm.toLowerCase().indexOf(q) === -1) return;
        grid.appendChild(miniPerfCard({
          name: nm,
          image: grp.performer.image,
          sub: tc("最新 " + (grp.newest || "—"), "newest " + (grp.newest || "—")),
          badge: tc(grp.items.length + " 部新作品", grp.items.length + " new"),
          heart: followHas(grp.performer.stashId),
          onClick: function () { _dp.perfGroup = grp; switchView("perfFilter"); },
        }));
      });
    } else if (src === "co") {
      buildCoStars().forEach(function (cs) {
        if (q && cs.meta.name.toLowerCase().indexOf(q) === -1) return;
        grid.appendChild(miniPerfCard({
          name: cs.meta.name,
          image: cs.meta.image,
          sub: tc("共同出演 ×" + cs.scenes, "co-starred ×" + cs.scenes),
          badge: tc("共同出演", "Co-star"), badgeKind: "co",
          onClick: function () { openPerfModal({ src: "co", stashId: cs.meta.stashId, name: cs.meta.name, image: cs.meta.image, scenes: cs.scenes, items: cs.items }); },
        }));
      });
    } else {
      trendingPerfMinis().forEach(function (pm) { grid.appendChild(pm); });
    }
    if (!grid.children.length) c.appendChild(stateBox("empty", emptyMsg));
    else c.appendChild(grid);
  }

  // ── 演员详情弹层（§3.5 详情 + 入库 + 在源打开 + 相关场景）───────────────
  var _dpModal = null;
  function closePerfModal() {
    if (_dpModal) { _dpModal.remove(); _dpModal = null; }
  }
  function openPerfModal(p) {
    closePerfModal();
    var d = _dp.d.latest;
    if (!d) return;
    var endpoint = d.source.endpoint;
    var apiKey = d.source.apiKey;

    var overlay = el("div", "ssd-dp-modal-overlay");
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closePerfModal(); });
    var m = el("div", "ssd-dp-modal");
    var close = el("button", "ssd-dp-modal-close", "&times;");
    close.type = "button";
    close.addEventListener("click", closePerfModal);
    m.appendChild(close);
    // 内容装进内层滚动容器：close 悬浮在 modal 右上角不随内容滚动
    // （用户 2026-10-25 第五轮：弹窗内容一滚关闭按钮就消失）
    var body = el("div", "ssd-dp-modal-body");
    m.appendChild(body);

    // 头部：共享演员详情模块（与演员过滤视图同构 — 用户 2026-10-25）
    // 统计行走详情区 info 列（第四轮：不放按钮区下面）
    var statText = p.src === "co"
      ? tc("共同出演 ×" + (p.scenes || 0), "Co-starred ×" + (p.scenes || 0))
      : tc("热门榜 #" + (p.rank || "?") + " · " + (p.sceneCount || 0) + " 部作品", "Trending #" + (p.rank || "?") + " · " + (p.sceneCount || 0) + " scenes");
    var h = buildPerfHead({ name: p.name, image: p.image, stashId: p.stashId, endpoint: endpoint, modal: true, stat: statText });
    body.appendChild(h.head);

    // 按钮区：加入库（performerCreate + stash_ids 回链）
    var acts = el("div", "ssd-dp-pfactions");
    var addBtn = el("button", "ssd-dp-btn primary", tc("＋ 加入库", "＋ Add to library"));
    addBtn.type = "button";
    function markAdded() {
      addBtn.disabled = true;
      addBtn.textContent = tc("已加入 ✓", "Added ✓");
      addBtn.classList.remove("err");
      addBtn.classList.add("ok");
    }
    function markFailed() {
      addBtn.disabled = false;
      addBtn.textContent = tc("加入失败，重试", "Failed — retry");
      addBtn.classList.remove("ok");
      addBtn.classList.add("err");
    }
    addBtn.addEventListener("click", function () {
      if (addBtn.disabled) return;
      addBtn.disabled = true;
      addBtn.textContent = tc("加入中…", "Adding…");
      SSD.callGQL(
        "mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}",
        { input: { name: p.name, stash_ids: [{ endpoint: endpoint, stash_id: String(p.stashId) }] } }
      ).then(function (r) {
        var created = r && r.performerCreate;
        if (!created || !created.id) throw new Error(tc("创建返回空结果", "empty result"));
        markAdded();
        invalidateLocalMemos();
        _dp.d.latest = null; _dp.d.studios = null;
        setTimeout(function () { ensureData(["latest", "studios"]); }, 400);
      }).catch(function (e) {
        console.error("[SSD] performerCreate failed:", e);
        // 失败先复查本地库：stash_id 已存在（此前加入过）→ 显示已加入而非报错
        // （用户 2026-10-25 第五轮：重复加入报"加入失败"）
        invalidateLocalMemos();
        loadLinkedPerformers(endpoint).then(function (linked) {
          var already = linked.some(function (lp) { return String(lp.stashId) === String(p.stashId); });
          if (already) { markAdded(); invalidateLocalMemos(); _dp.d.latest = null; _dp.d.studios = null; return; }
          markFailed();
        }).catch(function () { markFailed(); });
      });
    });
    // 预检：该 stash_id 已在本地库 → 直接显示已加入，避免重复创建报错
    // （用户 2026-10-25 第五轮：加入后重开弹窗仍显示"加入库"）
    loadLinkedPerformers(endpoint).then(function (linked) {
      if (!addBtn.isConnected || addBtn.disabled) return;
      var already = linked.some(function (lp) { return String(lp.stashId) === String(p.stashId); });
      if (already) markAdded();
    }).catch(function () {});
    acts.appendChild(addBtn);
    // 源按钮：外链图标（与详情区右上角一致，弃 ↗ 文字箭头 — 用户 2026-10-25 第五轮）
    var boxBtn = el("a", "ssd-dp-btn", SSD.brandNameForEndpoint(endpoint) + I.ext);
    boxBtn.href = SSD.boxWebBase(endpoint) + "/performers/" + p.stashId;
    boxBtn.target = "_blank";
    boxBtn.rel = "noopener noreferrer";
    acts.appendChild(boxBtn);
    body.appendChild(acts);

    // 相关场景
    var sc = el("div", "ssd-dp-modal-scenes");
    sc.appendChild(el("h4", "ssd-dp-pfsect", tc("相关场景", "Related scenes")));
    var scBody = el("div");
    sc.appendChild(scBody);
    body.appendChild(sc);

    overlay.appendChild(m);
    document.body.appendChild(overlay);
    _dpModal = overlay;
    document.addEventListener("keydown", function onEsc(e) {
      if (e.key === "Escape") { closePerfModal(); document.removeEventListener("keydown", onEsc); }
    });

    // 演员详情补全（性别/年龄/别名/国籍/头像）：box findPerformer
    SSD.callBoxGQL(endpoint, apiKey,
      "query($id:ID!){findPerformer(id:$id){id name gender birth_date country aliases images{url}}}",
      { id: p.stashId }, BOX_TIMEOUT).then(function (r) {
        if (!_dpModal) return;
        fillPerfDetail(h, r && r.findPerformer);
      }).catch(function () {});

    // 场景区填充：共同出演源 = 共演场景；热门源 = 懒加载近期场景（§3.5）
    if (p.src === "co" && p.items && p.items.length) {
      scBody.appendChild(sceneGrid(p.items.slice(0, 6)));
      SSD.layoutCardGrid();
    } else {
      scBody.appendChild(stateBox("loading"));
      var input = { performers: { value: [p.stashId], modifier: "INCLUDES" }, sort: "DATE", direction: "DESC", per_page: 6 };
      SSD.callBoxGQL(endpoint, apiKey,
        "query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{" + SSD.BOX_SCENE_FIELDS + "}}}",
        { input: input }, BOX_TIMEOUT).then(function (r) {
          if (!_dpModal) return;
          scBody.innerHTML = "";
          var scenes = (r && r.queryScenes && r.queryScenes.scenes) || [];
          if (!scenes.length) { scBody.appendChild(stateBox("empty", tc("暂无场景", "No scenes"))); return; }
          var box2 = { name: d.source.name, endpoint: endpoint, apiKey: apiKey };
          scBody.appendChild(sceneGrid(scenes.map(function (s2) { return shapeBoxItem(box2, s2); })));
          SSD.layoutCardGrid();
        }).catch(function () {
          if (!_dpModal) return;
          scBody.innerHTML = "";
          scBody.appendChild(stateBox("empty", tc("场景加载失败", "Failed to load scenes")));
        });
    }
  }
  function genderLabel(g) {
    var M = {
      FEMALE: tc("女", "Female"), MALE: tc("男", "Male"),
      TRANSGENDER_FEMALE: tc("跨性别女性", "Trans female"),
      TRANSGENDER_MALE: tc("跨性别男性", "Trans male"),
      INTERSEX: tc("间性", "Intersex"), NON_BINARY: tc("非二元", "Non-binary"),
    };
    return M[g] || g;
  }
  function ageFromBirth(birthDate) {
    var b = new Date(birthDate);
    if (isNaN(b.getTime())) return null;
    var now = new Date(), age = now.getFullYear() - b.getFullYear();
    var m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
    return age >= 0 && age < 130 ? age : null;
  }

  // ── 共享演员详情模块（演员过滤视图 + 发现演员弹层同构 — 用户 2026-10-25）──
  // 结构：头像（左下角国旗徽标）｜名称 / 别名（名称正下方）/ 性别·年龄 / 统计行｜右上外链。
  // 统计行（p.stat）放 info 列最后一行 = 详情区内部最下面（用户 2026-10-25 第四轮）。
  function buildPerfHead(p) {
    var head = el("div", "ssd-dp-pfhead" + (p.modal ? " ssd-dp-modal-head" : ""));
    var av = el("div", "ssd-dp-pfav");
    var img = document.createElement("img");
    img.className = "ssd-dp-pfavatar";
    img.alt = p.name || "";
    img.src = p.image || letterAvatar(p.name);
    img.onerror = function () { this.src = letterAvatar(p.name); };
    av.appendChild(img);
    var flag = el("span", "ssd-dp-pfflag");
    flag.style.display = "none";
    av.appendChild(flag);
    head.appendChild(av);
    var info = el("div", "ssd-dp-pfinfo");
    info.appendChild(el("div", "ssd-dp-pfname", p.name || tc("未知演员", "Unknown")));
    var aliasLine = el("div", "ssd-dp-pfmeta ssd-dp-pfalias");
    info.appendChild(aliasLine);
    var genderLine = el("div", "ssd-dp-pfmeta ssd-dp-pfgender");
    info.appendChild(genderLine);
    var statLine = el("div", "ssd-dp-pfmeta ssd-dp-pfstat");
    if (p.stat) statLine.textContent = p.stat;
    info.appendChild(statLine);
    head.appendChild(info);
    var ext = el("a", "ssd-dp-extbtn", I.ext);
    ext.href = SSD.boxWebBase(p.endpoint) + "/performers/" + p.stashId;
    ext.target = "_blank";
    ext.rel = "noopener noreferrer";
    ext.title = tc("在 stash-box 打开", "Open on stash-box");
    head.appendChild(ext);
    return { head: head, avatar: img, flag: flag, aliasLine: aliasLine, genderLine: genderLine, statLine: statLine, info: info };
  }

  // 详情补全：性别/年龄 → genderLine，别名 → 名称下方，国籍 → 头像国旗徽标，
  // box 头像 URL → 头像。pf 兼容本地（birthdate/alias_list）与 box（birth_date/aliases）。
  function fillPerfDetail(h, pf) {
    if (!pf) return;
    var bits = [];
    if (pf.gender) bits.push(genderLabel(pf.gender));
    var bd = pf.birth_date || pf.birthdate;
    if (bd) {
      var age = ageFromBirth(bd);
      if (age) bits.push(tc(age + " 岁", age + " y/o"));
    }
    if (bits.length) h.genderLine.textContent = bits.join(" · ");
    var al = pf.alias_list || pf.aliases;
    if (al && al.length) h.aliasLine.textContent = tc("别名：", "Aliases: ") + al.join(" / ");
    if (pf.images && pf.images[0] && pf.images[0].url) h.avatar.src = pf.images[0].url;
    var iso = countryIso(pf.country);
    if (iso) {
      // 国旗缩小为 flagcdn 图，与场景二级弹窗演员 popup 同一实现
      // （w40 图片 + onerror 文本兜底 — 用户 2026-10-25 第四轮）
      h.flag.title = String(pf.country);
      h.flag.textContent = "";
      var flagImg = document.createElement("img");
      flagImg.src = "https://flagcdn.com/w40/" + iso.toLowerCase() + ".png";
      flagImg.alt = iso;
      flagImg.onerror = function () {
        h.flag.textContent = iso;
        flagImg.remove();
      };
      h.flag.appendChild(flagImg);
      h.flag.style.display = "";
    }
  }

  // 国籍 → ISO 3166-1 alpha-2（本地库存 ISO 码；部分源存全名 → 兜底表）
  function countryIso(c) {
    if (!c) return "";
    var s = String(c).trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(s)) return s;
    var NAMES = {
      JAPAN: "JP", "SOUTH KOREA": "KR", KOREA: "KR", CHINA: "CN", TAIWAN: "TW", "HONG KONG": "HK",
      "UNITED STATES": "US", USA: "US", "UNITED KINGDOM": "GB", UK: "GB", ENGLAND: "GB",
      FRANCE: "FR", GERMANY: "DE", ITALY: "IT", SPAIN: "ES", RUSSIA: "RU", "CZECH REPUBLIC": "CZ",
      THAILAND: "TH", VIETNAM: "VN", INDONESIA: "ID", INDIA: "IN", PHILIPPINES: "PH",
      MALAYSIA: "MY", SINGAPORE: "SG", CANADA: "CA", AUSTRALIA: "AU", BRAZIL: "BR", MEXICO: "MX",
      NETHERLANDS: "NL", POLAND: "PL", SWEDEN: "SE", UKRAINE: "UA", "NEW ZEALAND": "NZ",
    };
    return NAMES[s] || "";
  }

  // ── 演员过滤视图（§8.1：上半演员详情 + 下半场景卡）───────────────────────
  function renderPerfFilter(c) {
    var g = _dp.perfGroup;
    var d = _dp.d.latest;
    if (!g || !d) { c.appendChild(stateBox("empty", tc("请从「有新发布的演员」或「关注」进入", "Open from a performer card"))); return; }
    var pf = g.performer;
    var endpoint = d.source.endpoint;

    // 头部：共享演员详情模块（与发现演员弹层同构 — 用户 2026-10-25）
    // 统计行走详情区 info 列（第四轮：不放按钮区下面）
    var h = buildPerfHead({ name: pf.name, image: pf.image, stashId: pf.stashId, endpoint: endpoint,
      stat: tc(g.items.length + " 部新作品 · 最新 " + (g.newest || "—"),
        g.items.length + " new · newest " + (g.newest || "—")) });
    c.appendChild(h.head);

    // 按钮区（§8.1：关注 ♥ / 发现 tab / 主页 / stash-box）
    var acts = el("div", "ssd-dp-pfactions");
    var heartBtn = el("button", "ssd-dp-btn" + (followHas(pf.stashId) ? " loved" : ""),
      (followHas(pf.stashId) ? "♥ " + tc("已关注", "Following") : "♡ " + tc("关注", "Follow")));
    heartBtn.type = "button";
    heartBtn.addEventListener("click", function () {
      var on = followToggle({ stashId: pf.stashId, endpoint: endpoint, name: pf.name, image: pf.image, localId: pf.localId });
      heartBtn.className = "ssd-dp-btn" + (on ? " loved" : "");
      heartBtn.textContent = on ? "♥ " + tc("已关注", "Following") : "♡ " + tc("关注", "Follow");
      emitUnread();
    });
    acts.appendChild(heartBtn);
    var tabBtn = el("button", "ssd-dp-btn", tc("发现 Tab", "Discover tab"));
    tabBtn.type = "button";
    tabBtn.title = tc("去该演员页的「发现」标签", "Open this performer's Discover tab");
    tabBtn.addEventListener("click", function () {
      try { sessionStorage.setItem("SSD:dp:openTab", String(pf.localId)); } catch (_) {}
      window.location.assign("/performers/" + pf.localId);
    });
    acts.appendChild(tabBtn);
    var homeBtn = el("button", "ssd-dp-btn", tc("主页", "Profile"));
    homeBtn.type = "button";
    homeBtn.addEventListener("click", function () { window.location.assign("/performers/" + pf.localId); });
    acts.appendChild(homeBtn);
    // stash-box 打开按钮已移除（详情区右上外链图标承担）— 用户 2026-10-25
    c.appendChild(acts);

    // 本地演员详情补全（性别/年龄/别名/国籍国旗）
    SSD.callGQL("query($id:ID!){findPerformer(id:$id){id gender birthdate country alias_list}}", { id: pf.localId }).then(function (r) {
      fillPerfDetail(h, r && r.findPerformer);
    }).catch(function () {});

    // 下半：场景卡（分组内不受 cap 限制）
    c.appendChild(sceneGrid(filterItems(g.items)));
    SSD.layoutCardGrid();
  }

  // ── 工作室过滤视图（§8.2：与演员过滤视图同构）────────────────────────────
  function renderStudioFilter(c) {
    var g = _dp.studioGroup;
    var st = _dp.d.studios;
    if (!g || !st) { c.appendChild(stateBox("empty", tc("请从「工作室」视图进入", "Open from a studio card"))); return; }
    var endpoint = st.source.endpoint;
    var studio = g.studio || {};

    var head = el("div", "ssd-dp-pfhead ssd-dp-pfhead--studio");
    var img = document.createElement("img");
    img.className = "ssd-dp-pfavatar ssd-dp-pfavatar--studio";
    img.alt = studio.name || "";
    img.src = studio.image || letterAvatar(studio.name);
    img.onerror = function () { this.src = letterAvatar(studio.name); };
    head.appendChild(img);
    var info = el("div", "ssd-dp-pfinfo");
    info.appendChild(el("div", "ssd-dp-pfname", studio.name || ""));
    var meta = el("div", "ssd-dp-pfmeta");
    meta.textContent = tc(g.items.length + " 部新作品 · 最新 " + (g.newest || "—") + " · 已收藏",
      g.items.length + " new · newest " + (g.newest || "—") + " · favorited");
    info.appendChild(meta);
    head.appendChild(info);
    var ext = el("a", "ssd-dp-extbtn", I.ext);
    ext.href = SSD.boxWebBase(endpoint) + "/studios/" + studio.stashId;
    ext.target = "_blank";
    ext.rel = "noopener noreferrer";
    ext.title = tc("在 stash-box 打开", "Open on stash-box");
    head.appendChild(ext);
    c.appendChild(head);

    var acts = el("div", "ssd-dp-pfactions");
    if (studio.localId) {
      var homeBtn = el("button", "ssd-dp-btn", tc("工作室主页", "Studio page"));
      homeBtn.type = "button";
      homeBtn.addEventListener("click", function () { window.location.assign("/studios/" + studio.localId); });
      acts.appendChild(homeBtn);
    }
    var boxBtn = el("a", "ssd-dp-btn", SSD.brandNameForEndpoint(endpoint) + I.ext);
    boxBtn.href = SSD.boxWebBase(endpoint) + "/studios/" + studio.stashId;
    boxBtn.target = "_blank";
    boxBtn.rel = "noopener noreferrer";
    acts.appendChild(boxBtn);
    c.appendChild(acts);

    c.appendChild(sceneGrid(filterItems(g.items)));
    SSD.layoutCardGrid();
  }

  // ── 关注视图（§3.4：分组 + 未读标记 + 全部已读 + 空状态；P5 补数据层）──
  function renderFollow(c) {
    var d = _dp.d.latest;
    var allFollow = followList();
    if (!d) {
      if (_dp.err.latest) { c.appendChild(stateBox("error", errText(_dp.err.latest), retryLatest)); return; }
      c.appendChild(stateBox("loading"));
      return;
    }
    // 单源口径（用户 2026-10-25 第七轮）：只列当前数据源的关注演员，
    // 别源演员不在此页显示「回看期内暂无新作品」，切源后自然出现。
    var srcEp = String(d.source.endpoint).toLowerCase();
    var fl = allFollow.filter(function (f) { return String(f.endpoint || "").toLowerCase() === srcEp; });
    if (!fl.length) {
      var empty = stateBox("empty",
        allFollow.length
          ? tc("当前数据源下还没有关注的演员。切换数据源，或从收藏导入当前源的演员。",
               "No followed performers on the current source. Switch the source, or import its favorites.")
          : tc("还没有关注的演员。在演员卡上点 ♥ 即可关注，或从库内收藏一键导入。",
               "Not following anyone yet. Tap ♥ on a performer card, or import your ❤ favorites in one tap."));
      empty.appendChild(makeImportButton());
      c.appendChild(empty);
      return;
    }

    var groups = d.actorsWithNew || [];
    var byStash = {};
    groups.forEach(function (g) { byStash[String(g.performer.stashId)] = g; });

    // 顶部：全部已读（§3.4）
    var allPairs = [], unreadTotal = 0;
    fl.forEach(function (f) {
      var g = byStash[String(f.stashId)];
      if (!g) return;
      g.items.forEach(function (it) {
        allPairs.push([it.endpoint, it.scene.id]);
        if (!readIs(it.endpoint, it.scene.id)) unreadTotal++;
      });
    });
    var bar = el("div", "ssd-dp-followbar");
    bar.appendChild(el("span", "ssd-dp-pcount",
      tc(fl.length + " 位关注 · " + unreadTotal + " 部未读", fl.length + " followed · " + unreadTotal + " unread")));
    bar.appendChild(makeImportButton()); // §6.2 增量导入（已关注的自动跳过）
    if (unreadTotal > 0) {
      var allBtn = el("button", "ssd-dp-btn primary", I.check + "<span>" + tc("全部已读", "Mark all read") + "</span>");
      allBtn.type = "button";
      allBtn.addEventListener("click", function () {
        readMarkAll(allPairs);
        emitUnread();
        render();
      });
      bar.appendChild(allBtn);
    }
    c.appendChild(bar);

    fl.forEach(function (f) {
      var g = byStash[String(f.stashId)];
      var grp = el("div", "ssd-dp-fgrp");
      var head = el("div", "ssd-dp-fgrp-head");
      var img = document.createElement("img");
      img.loading = "lazy";
      img.alt = f.name || "";
      img.src = f.image || g && g.performer.image || letterAvatar(f.name);
      img.onerror = function () { this.src = letterAvatar(f.name); };
      head.appendChild(img);
      var info = el("div", "ssd-dp-fgrp-info");
      info.appendChild(el("div", "ssd-dp-mini-name", f.name || tc("未知演员", "Unknown")));
      var unread = 0;
      if (g) g.items.forEach(function (it) { if (!readIs(it.endpoint, it.scene.id)) unread++; });
      var sub = el("div", "ssd-dp-mini-sub");
      sub.textContent = !g ? tc("回看期内暂无新作品", "No new releases in the lookback window")
        : tc(g.items.length + " 部新作品 · " + (unread ? unread + " 部未读" : "已读"),
             g.items.length + " new · " + (unread ? unread + " unread" : "all read"));
      if (g && unread) sub.classList.add("has-unread");
      info.appendChild(sub);
      head.appendChild(info);

      var rightBox = el("div", "ssd-dp-fgrp-acts");
      var isOpen = !!g && _dp.followOpenKey === String(f.stashId);
      var toggleRow = function () {
        if (!g) return;
        _dp.followOpenKey = isOpen ? null : String(f.stashId);
        render();
      };
      if (g) {
        var caret = el("button", "ssd-dp-btn ghost", isOpen ? "▾" : "▸");
        caret.type = "button";
        caret.title = tc("展开 / 收起", "Expand / collapse");
        caret.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleRow();
        });
        rightBox.appendChild(caret);
      }
      var goBtn = el("button", "ssd-dp-btn ghost", tc("详情", "Details"));
      goBtn.type = "button";
      goBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (g) { _dp.perfGroup = g; switchView("perfFilter"); }
        else if (f.localId) window.location.assign("/performers/" + f.localId);
      });
      rightBox.appendChild(goBtn);
      var unfBtn = el("button", "ssd-dp-btn ghost danger", "♥");
      unfBtn.type = "button";
      unfBtn.title = tc("取消关注", "Unfollow");
      unfBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        followToggle(f);
        emitUnread();
        render();
      });
      rightBox.appendChild(unfBtn);
      head.appendChild(rightBox);
      // 整行点击 = 展开/收起（详情、取消关注按钮已 stopPropagation）
      if (g) {
        head.classList.add("is-toggle");
        head.addEventListener("click", toggleRow);
      }
      grp.appendChild(head);

      // 分组体：手风琴，最多展开一位（默认全部收起 — 用户 2026-10-25 第七轮）
      var expanded = isOpen;
      if (g && expanded) {
        var body = el("div", "ssd-dp-fgrp-body");
        body.appendChild(sceneGrid(g.items, { unread: true }));
        grp.appendChild(body);
      }
      c.appendChild(grp);
    });
    SSD.layoutCardGrid();
  }

  // ── 设置视图（§3.7：全部即时生效，localStorage 持久化）────────────────────
  function renderSettings(c) {
    var prefs = dpPrefs();
    var wrap = el("div", "ssd-dp-settings");

    // ── 通用 ──
    wrap.appendChild(el("h3", "ssd-dp-set-h", tc("通用", "General")));
    var secG = el("div", "ssd-dp-set-box");

    // 查询源（§4.5：与工具栏下拉同一持久化值；单源时也展示当前值）
    var rowS = el("div", "ssd-dp-setrow");
    rowS.appendChild(el("span", "ssd-dp-setname", tc("查询源", "Data source")));
    var srcSel = document.createElement("select");
    srcSel.className = "ssd-dp-setsel";
    (_dp.boxes || []).forEach(function (b) {
      var op = document.createElement("option");
      op.value = b.name;
      op.textContent = SSD.brandNameForEndpoint(b.endpoint, b.name);
      srcSel.appendChild(op);
    });
    var dNow = _dp.d.latest;
    // 回显：数据就绪用实际源；未就绪（切换后重载中/失败）回显持久化选择，
    // 避免误导性地跳回下拉第一项
    if (dNow && dNow.source && dNow.source.name) srcSel.value = dNow.source.name;
    else if (prefs.source) srcSel.value = prefs.source;
    srcSel.addEventListener("change", function () {
      dpSetPrefs({ source: srcSel.value });
      _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0; _dp.page = 1;
      // 角标按当前数据源统计（单源口径），切源后立即重算一次
      if (SSD.pollFollowed) SSD.pollFollowed(true);
      ensureData(viewDataKeys(_dp.view));
      render();
    });
    rowS.appendChild(srcSel);
    secG.appendChild(rowS);

    // 通知开关（独立 key SSD:dp:notify，主 JS 轮询与导航角标读取；§6.4）
    var rowN = el("div", "ssd-dp-setrow");
    var labN = el("label", "ssd-dp-settoggle");
    var cbN = document.createElement("input");
    cbN.type = "checkbox";
    try { cbN.checked = localStorage.getItem("SSD:dp:notify") !== "0"; } catch (_) { cbN.checked = true; }
    cbN.addEventListener("change", function () {
      try { localStorage.setItem("SSD:dp:notify", cbN.checked ? "1" : "0"); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent("ssd:notify-changed")); } catch (_) {}
    });
    labN.appendChild(cbN);
    labN.appendChild(el("span", null, tc("关注的演员新发布提醒（导航角标）", "New-release alerts for followed performers (nav badge)")));
    rowN.appendChild(labN);
    secG.appendChild(rowN);

    // 从收藏导入（§6.2；P5 工厂复用）
    var rowI = el("div", "ssd-dp-setrow");
    rowI.appendChild(makeImportButton());
    secG.appendChild(rowI);
    wrap.appendChild(secG);

    // ── 显示上限（平铺列表：每位演员 / 每个工作室）— 用户 2026-10-25 第七轮 ──
    wrap.appendChild(el("h3", "ssd-dp-set-h", tc("显示上限", "Display limits")));
    var secC = el("div", "ssd-dp-set-box");
    [
      ["capPerActor", tc("每位演员最多场景", "Max scenes per performer"), capPerActor()],
      ["capPerStudio", tc("每个工作室最多场景", "Max scenes per studio"), capPerStudio()],
    ].forEach(function (def) {
      var row = el("div", "ssd-dp-setrow");
      row.appendChild(el("span", "ssd-dp-setname", def[1]));
      var sel = document.createElement("select");
      sel.className = "ssd-dp-setsel";
      for (var i = 1; i <= 10; i++) {
        var op = document.createElement("option");
        op.value = String(i);
        op.textContent = String(i);
        sel.appendChild(op);
      }
      sel.value = String(def[2]);
      sel.addEventListener("change", function () {
        var patch = {};
        patch[def[0]] = parseInt(sel.value, 10);
        dpSetPrefs(patch);
        // 上限在管线计算期生效 → 清结果、用现有场景缓存重算
        _dp.d.latest = null; _dp.d.studios = null;
        _dp.err.latest = null; _dp.err.studios = null;
        ensureData(["latest", "studios"]);
        render();
      });
      row.appendChild(sel);
      secC.appendChild(row);
    });
    wrap.appendChild(secC);

    // ── 总览模块（开关 / 行数 1-3 / 上移下移）──
    wrap.appendChild(el("h3", "ssd-dp-set-h", tc("总览模块", "Overview modules")));
    var secM = el("div", "ssd-dp-set-box");
    var order = moduleOrder();
    var curRows = overviewRows();
    MODULE_DEFS.forEach(function (m) {
      var row = el("div", "ssd-dp-setrow");
      var lab = el("label", "ssd-dp-settoggle");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = moduleShown(m.id);
      cb.addEventListener("change", function () {
        var mods = dpPrefs().modules || {};
        mods[m.id] = cb.checked;
        dpSetPrefs({ modules: mods });
        render();
      });
      lab.appendChild(cb);
      lab.appendChild(el("span", null, tc(m.zh, m.en)));
      row.appendChild(lab);

      var ctl = el("div", "ssd-dp-setctl");
      ctl.appendChild(el("span", "ssd-dp-tool-label", tc("行数", "Rows")));
      var rs = document.createElement("select");
      rs.className = "ssd-dp-setsel";
      [1, 2, 3].forEach(function (n) {
        var op = document.createElement("option");
        op.value = String(n);
        op.textContent = String(n);
        rs.appendChild(op);
      });
      rs.value = String(curRows[m.id] || 1);
      rs.addEventListener("change", function () {
        var rw = dpPrefs().rows || {};
        rw[m.id] = parseInt(rs.value, 10);
        dpSetPrefs({ rows: rw });
        render();
      });
      ctl.appendChild(rs);

      var idx = order.indexOf(m.id);
      var up = el("button", "ssd-dp-btn ghost sm", "↑");
      var dn = el("button", "ssd-dp-btn ghost sm", "↓");
      up.type = "button"; dn.type = "button";
      up.title = tc("上移", "Move up"); dn.title = tc("下移", "Move down");
      up.disabled = idx <= 0;
      dn.disabled = idx < 0 || idx >= order.length - 1;
      up.addEventListener("click", function () { moveModule(m.id, -1); });
      dn.addEventListener("click", function () { moveModule(m.id, 1); });
      ctl.appendChild(up);
      ctl.appendChild(dn);
      row.appendChild(ctl);
      secM.appendChild(row);
    });
    wrap.appendChild(secM);

    // 恢复默认（清 prefs：order/modules/rows/source/perPage/sort/mode 全回默认；
    // notify 是独立 key，保留用户选择）
    var reset = el("button", "ssd-dp-btn ghost", tc("恢复默认布局", "Reset to defaults"));
    reset.type = "button";
    reset.addEventListener("click", function () {
      try { localStorage.removeItem(LS_PREFIX + "prefs"); } catch (_) {}
      _dp.sort = "date-desc"; _dp.page = 1;
      _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0;
      if (_dp.refs.sort) _dp.refs.sort.value = "date-desc";
      if (_dp.refs.perPage) _dp.refs.perPage.value = "24";
      ensureData(viewDataKeys(_dp.view));
      render();
    });
    wrap.appendChild(reset);

    c.appendChild(wrap);
  }

  // ═══ P1: 页面组件（导航 patch 与路由注册由主 JS 顶层同步完成）═════════════
  var React = window.PluginApi.React;

  var VIEWS = [
    { id: "overview", icon: I.overview, zh: "总览", en: "Overview" },
    { id: "follow", icon: I.follow, zh: "关注", en: "Following" },
    { id: "latest", icon: I.latest, zh: "最新", en: "Latest" },
    { id: "trending", icon: I.trending, zh: "热门", en: "Trending" },
    // preview 不再是独立页 tab：并入「最新」视图的预告子 tab（用户 2026-10-25）
    { id: "performers", icon: I.performers, zh: "发现演员", en: "Performers" },
    { id: "studios", icon: I.studios, zh: "工作室", en: "Studios" },
  ];

  // ── 角标状态（§10：P5 轮询发 "ssd:unread-changed" 事件驱动）──
  var _unread = 0;

  // ── 页面组件（React 壳 + ref 挂载 vanilla 渲染，curator 同款模式）────────
  function DiscoverPage() {
    var ref = React.useRef(null);
    React.useEffect(function () {
      if (ref.current) mountPage(ref.current);
      return function () { if (ref.current) ref.current.innerHTML = ""; };
    }, []);
    return React.createElement("div", { ref: ref, className: "ssd-dp-page" });
  }

  // 交给主 JS 路由壳渲染 + 通知（壳在等待本组件时显示加载点）
  SSD.discoverMount = DiscoverPage;
  try { window.dispatchEvent(new CustomEvent("ssd:discover-ready")); } catch (_) {}

  // ═══ 页面挂载 + 渲染机（chrome 一次构建；内容区按状态重建）════════════════
  function mountPage(root) {
    root.innerHTML = "";
    var refs = _dp.refs;

    // 初始状态：持久化偏好回填（先于工具栏构建，保证 select 初值正确）
    var prefs = dpPrefs();
    if (prefs.sort) _dp.sort = prefs.sort;
    if (prefs.mode === "list" || prefs.mode === "grid") _dp.mode = prefs.mode;

    // ── 页头行（§3.1.1）：标题 + meta chips + 刷新 + 相对时间 ──
    var head = el("div", "ssd-dp-head");
    head.appendChild(el("h2", "ssd-dp-title",
      '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M192 32c0-17.7 14.3-32 32-32C383.1 0 512 128.9 512 288c0 17.7-14.3 32-32 32s-32-14.3-32-32C448 164.3 347.7 64 224 64c-17.7 0-32-14.3-32-32zM60.6 220.6L164.7 324.7l28.4-28.4c-.7-2.6-1.1-5.4-1.1-8.3c0-17.7 14.3-32 32-32s32 14.3 32 32s-14.3 32-32 32c-2.9 0-5.6-.4-8.3-1.1l-28.4 28.4L291.4 451.4c14.5 14.5 11.8 38.8-7.3 46.3C260.5 506.9 234.9 512 208 512C93.1 512 0 418.9 0 304c0-26.9 5.1-52.5 14.4-76.1c7.5-19 31.8-21.8 46.3-7.3zM224 96c106 0 192 86 192 192c0 17.7-14.3 32-32 32s-32-14.3-32-32c0-70.7-57.3-128-128-128c-17.7 0-32-14.3-32-32s14.3-32 32-32z"/></svg>' +
      "<span>" + tc("发现", "Discover") + "</span>"));
    refs.chips = el("span");
    head.appendChild(refs.chips);
    refs.refresh = el("button", "ssd-dp-refresh", I.refresh + "<span>" + tc("刷新", "Refresh") + "</span>");
    refs.refresh.type = "button";
    refs.refresh.addEventListener("click", doRefresh);
    head.appendChild(refs.refresh);
    refs.updated = el("span", "ssd-dp-updated");
    head.appendChild(refs.updated);
    root.appendChild(head);

    // ── 滑动开关组（§3.1.2）：7 模块 + 右侧独立设置 ──
    refs.tabs = el("div", "ssd-dp-tabs");
    VIEWS.forEach(function (v) {
      var b = el("button", "ssd-dp-tab" + (_dp.view === v.id ? " on" : ""), v.icon + "<span>" + tc(v.zh, v.en) + "</span>");
      b.type = "button";
      b.dataset.view = v.id;
      b.addEventListener("click", function () { switchView(v.id); });
      refs.tabs.appendChild(b);
    });
    var setBtn = el("button", "ssd-dp-tab set", I.settings + "<span>" + tc("设置", "Settings") + "</span>");
    setBtn.type = "button";
    setBtn.dataset.view = "settings";
    setBtn.addEventListener("click", function () { switchView("settings"); });
    refs.tabs.appendChild(setBtn);
    root.appendChild(refs.tabs);

    // ── 筛选行（§3.1.3 贯穿所有视图；搜索框限宽 + 居中 — 用户 2026-10-23 确认）──
    // 布局：grid 三列（左空 | 搜索框居中 | 控件组靠右），见 stashDiscover.css
    var bar = el("div", "ssd-dp-toolbar");
    refs.search = document.createElement("input");
    refs.search.type = "search";
    refs.search.className = "grow";
    refs.search.placeholder = tc("搜索场景 / 演员 / 工作室…", "Search scenes / performers / studios…");
    refs.search.value = _dp.search;
    var debounceT = 0;
    refs.search.addEventListener("input", function () {
      clearTimeout(debounceT);
      debounceT = setTimeout(function () {
        _dp.search = refs.search.value;
        _dp.page = 1;
        render();
      }, 250);
    });
    bar.appendChild(refs.search);

    var tools = el("div", "ssd-dp-tools");
    tools.appendChild(el("span", "ssd-dp-tool-label", tc("排序", "Sort")));
    refs.sort = document.createElement("select");
    [["date-desc", tc("发布日期 ↓", "Date ↓")], ["date-asc", tc("发布日期 ↑", "Date ↑")],
     ["title", tc("标题 A-Z", "Title A-Z")], ["hot", tc("原榜顺序", "List order")]].forEach(function (o) {
      var op = document.createElement("option");
      op.value = o[0];
      op.textContent = o[1];
      refs.sort.appendChild(op);
    });
    refs.sort.value = _dp.sort || "date-desc";
    refs.sort.addEventListener("change", function () {
      _dp.sort = refs.sort.value;
      _dp.page = 1;
      dpSetPrefs({ sort: _dp.sort });
      render();
    });
    tools.appendChild(refs.sort);

    tools.appendChild(el("span", "ssd-dp-tool-label", tc("每页", "Per page")));
    refs.perPage = document.createElement("select");
    [24, 48, 96].forEach(function (n) {
      var op = document.createElement("option");
      op.value = String(n);
      op.textContent = String(n);
      refs.perPage.appendChild(op);
    });
    refs.perPage.value = String(toNum(dpPrefs().perPage, 24));
    refs.perPage.addEventListener("change", function () {
      dpSetPrefs({ perPage: parseInt(refs.perPage.value, 10) });
      _dp.page = 1;
      render();
    });
    tools.appendChild(refs.perPage);

    var vt = el("div", "ssd-dp-viewtoggle");
    var gBtn = el("button", null, I.grid), lBtn = el("button", null, I.list);
    gBtn.type = "button"; lBtn.type = "button";
    gBtn.title = tc("网格", "Grid"); lBtn.title = tc("列表", "List");
    refs.gridBtn = gBtn; refs.listBtn = lBtn;
    gBtn.addEventListener("click", function () { _dp.mode = "grid"; dpSetPrefs({ mode: "grid" }); render(); });
    lBtn.addEventListener("click", function () { _dp.mode = "list"; dpSetPrefs({ mode: "list" }); render(); });
    vt.appendChild(gBtn); vt.appendChild(lBtn);
    tools.appendChild(vt);

    refs.srcWrap = el("span", "ssd-dp-srcwrap");
    tools.appendChild(refs.srcWrap);
    bar.appendChild(tools);
    root.appendChild(bar);
    syncSourceSelect();

    // ── 内容区 ──
    refs.content = el("div", "ssd-dp-content");
    root.appendChild(refs.content);

    bindResize();
    ensureData(viewDataKeys(_dp.view));
    render();
  }

  // 窗口宽度变化 → 总览模块行数重算（trimRows 依赖实际布局宽度）。
  // 只绑一次；页面卸载后（content 脱离文档）监听自动变空操作。
  var _resizeBound = false;
  function bindResize() {
    if (_resizeBound) return;
    _resizeBound = true;
    var t = 0;
    window.addEventListener("resize", function () {
      var c = _dp.refs.content;
      if (!c || !c.isConnected) return;
      clearTimeout(t);
      t = setTimeout(function () {
        if (_dp.refs.content && _dp.refs.content.isConnected && _dp.view === "overview") render();
      }, 200);
    });
  }

  function switchView(view) {
    _dp.view = view;
    _dp.page = 1;
    ensureData(viewDataKeys(view));
    render();
    try { var root = _dp.refs.content; if (root && root.closest(".ssd-dp-page")) window.scrollTo({ top: 0, behavior: "smooth" }); } catch (_) {}
  }

  function syncSourceSelect() {
    var refs = _dp.refs;
    if (!refs.srcWrap) return;
    // 数据源下拉（§4.5：仅多源时显示；与设置弹窗同一持久化值）
    if ((_dp.boxes || []).length < 2) { refs.srcWrap.innerHTML = ""; return; }
    var d = _dp.d.latest;
    var cur = d ? d.source.name : "";
    if (!refs.srcWrap.firstChild) {
      refs.srcWrap.appendChild(el("span", "ssd-dp-tool-label", tc("数据源", "Source")));
      var sel = document.createElement("select");
      sel.addEventListener("change", function () {
        dpSetPrefs({ source: sel.value });
        _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0; _dp.page = 1;
        // 角标按当前数据源统计（单源口径），切源后立即重算一次
        if (SSD.pollFollowed) SSD.pollFollowed(true);
        ensureData(viewDataKeys(_dp.view));
        render();
      });
      refs.srcWrap.appendChild(sel);
      refs.srcSel = sel;
    }
    var sel = refs.srcSel;
    if (sel && sel.options.length !== _dp.boxes.length) {
      sel.innerHTML = "";
      _dp.boxes.forEach(function (b) {
        var op = document.createElement("option");
        op.value = b.name;
        op.textContent = SSD.brandNameForEndpoint(b.endpoint, b.name);
        sel.appendChild(op);
      });
    }
    if (sel && cur && sel.value !== cur) sel.value = cur;
  }

  function doRefresh() {
    if (_dp.refreshing) return;
    _dp.refreshing = true;
    render();
    refreshAll().then(function () {
      var keys = viewDataKeys("overview");
      _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0;
      ensureData(keys, true);
      pollSettled(keys, function () { _dp.refreshing = false; render(); });
    }).catch(function (e) {
      _dp.refreshing = false;
      _dp.err.latest = e;
      render();
    });
  }

  // ── 渲染机：syncChrome（页头/开关/工具栏状态）+ renderContent（按视图）──
  function render() {
    var refs = _dp.refs;
    if (!refs.content) return;
    syncChrome();
    renderContent();
  }

  function syncChrome() {
    var refs = _dp.refs, d = _dp.d.latest;
    // meta chips（§3.1.1）
    if (refs.chips) {
      if (!d) refs.chips.innerHTML = "";
      else {
        var n = (d.latest || []).length + (d.preview || []).length;
        refs.chips.innerHTML =
          '<span class="ssd-dp-chip"><b>' + n + "</b> " + tc("个新场景", "new scenes") + "</span>" +
          '<span class="ssd-dp-chip"><b>' + (d.linkedCount || 0) + "</b> " + tc("位关联演员", "linked performers") + "</span>" +
          '<span class="ssd-dp-chip">' + tc("数据源", "Source") + " <b>" + SSD.brandNameForEndpoint(d.source.endpoint, d.source.name) + "</b></span>";
      }
    }
    if (refs.updated) refs.updated.textContent = relTime(_dp.fetchedAt);
    if (refs.refresh) {
      refs.refresh.disabled = _dp.refreshing;
      var svg = refs.refresh.querySelector("svg");
      if (svg) svg.classList.toggle("spinning", _dp.refreshing);
    }
    if (refs.tabs) {
      refs.tabs.querySelectorAll(".ssd-dp-tab").forEach(function (t) {
        t.classList.toggle("on", t.dataset.view === _dp.view);
      });
    }
    if (refs.gridBtn && refs.listBtn) {
      refs.gridBtn.classList.toggle("on", _dp.mode !== "list");
      refs.listBtn.classList.toggle("on", _dp.mode === "list");
    }
  }

  function renderContent() {
    var c = _dp.refs.content;
    if (!c) return;
    c.innerHTML = "";
    ensureData(viewDataKeys(_dp.view));
    switch (_dp.view) {
      case "overview": renderOverview(c); break;
      case "follow": renderFollow(c); break;
      case "latest": case "preview": case "trending": case "studios": renderDrill(c, _dp.view); break;
      case "performers": renderPerformers(c); break;
      case "perfFilter": renderPerfFilter(c); break;
      case "studioFilter": renderStudioFilter(c); break;
      case "settings": renderSettings(c); break;
      default: renderOverview(c);
    }
    SSD.layoutCardGrid();
  }

  // 入库后：失效本地 memo（ownedKeys 变了）→ 重建 latest/studios（缓存仍在，
  // buildResult 用新鲜 ownedKeys 重筛，已入库场景自然消失）；顺带标已读。
  var _savedDebounce = 0;
  window.addEventListener(SSD.SCENE_SAVED_EVENT, function (e) {
    var item = e && e.detail && e.detail.item;
    if (item && item.endpoint && item.scene) readMark(item.endpoint, item.scene.id);
    emitUnread();
    clearTimeout(_savedDebounce);
    _savedDebounce = setTimeout(function () {
      if (!_dp.refs.content) return;
      _dp.d.latest = null; _dp.d.studios = null;
      ensureData(["latest", "studios"]);
    }, 400);
  });

  // P4.7/P5 控制台验证出口
  SSD.dp.followList = followList;
  SSD.dp.followToggle = followToggle;
  SSD.dp.readIs = readIs;
  SSD.dp.readMark = readMark;
  SSD.dp.computeUnread = computeUnread;
  SSD.dp.importFavorites = importFavoritesFromLibrary;

  // ═══ init ════════════════════════════════════════════════════════════════
  function init() {
    console.log("[SSD] discover.js v" + (SSD.version || "?") + " loaded");
    THEME.start();
    // follow tab 红点跟随导航角标同一事件流（§10；P5 轮询驱动）
    window.addEventListener("ssd:unread-changed", function (e) {
      _unread = (e && e.detail) || 0;
      var dot = document.querySelector(".ssd-dp-tab[data-view=follow] .ssd-dp-tab-dot");
      if (dot) dot.remove();
      if (_unread > 0) {
        var tab = document.querySelector(".ssd-dp-tab[data-view=follow]");
        if (tab) {
          var d = document.createElement("i");
          d.className = "ssd-dp-tab-dot";
          tab.appendChild(d);
        }
      }
    });
    // 相对时间每分钟自刷新
    setInterval(function () {
      if (_dp.refs.updated) _dp.refs.updated.textContent = relTime(_dp.fetchedAt);
    }, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
