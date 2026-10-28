/* ──────────────────────────────────────────────────────────────────────────
 * stashDiscover — discover.js（"发现"导航页内容模块）
 * 加载条件：主 JS 的 maybeLoadDiscover() 按 enableDiscoverPage 设置 +
 * localStorage 缓存注入本文件；开关关闭时本文件完全不进浏览器（§1）。
 * 职责边界：导航按钮与 /plugins/stashDiscover 路由壳由主 JS 顶层同步注册
 * （可靠时序波次）；本文件只提供页面组件（window.SSD.discoverMount +
 * "ssd:discover-ready" 事件）与页内全部内容渲染。
 * 依赖：window.SSD（主 JS 导出的共享命名空间，见 stashDiscover.js 尾部）。
 * 设计规范：docs/stashdiscover-design.md（唯一事实源）。
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
      // acc 在 HUES 循环之外单独赋值，`-d`（hover 深色）必须同处补齐：
      // 缺它 → `.ssd-dp-btn.primary:hover` 的 background 计算为透明，
      // 按钮 hover 时"发白变灰"（用户 2026-10-27 实测「全部已读」）
      t["acc-d"] = mix(t.acc, "#000000", dark ? 0.2 : 0.14);
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
  // 条数护栏只防内存/序列化失控；真正的体积由 cacheWrite 的字节预算（3.2MB）决定。
  // 投影后单条约 1.2KB，1500 条会无谓丢掉窗口内较旧的数据（用户 2026-10-27）。
  var CACHE_SCENES_CAP = 4000;
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

  // 发现页回看窗口（用户 2026-10-26）：总览短窗、演员 tab 长窗，两者独立。
  // 发现页窗口持久化在 localStorage（发现页「设置」）；演员 tab 仍用插件设置。
  var DP_LOOKBACK_DEFAULT = 30;
  function dpRecentDays() {
    var v = toNum(dpPrefs().recentDays, DP_LOOKBACK_DEFAULT);
    return v < 0 ? DP_LOOKBACK_DEFAULT : v;
  }

  function lookbackText(days, zh) {
    if (days > 0) return zh ? "回看 " + days + " 天" : "lookback " + days + "d";
    return zh ? "回看：不限" : "lookback: unlimited";
  }

  // 「预告也计入提醒」（用户 2026-10-27）：默认关闭 = 预告不参与任何口径。
  // 开启后预告场景才计入未读、导航角标、红框、总览计数；无论开关如何，点开演员
  // 或展开分组都照常显示预告内容。
  // 与「关注演员新发布提醒」是两个独立维度，不互为父子：后者是强提醒总闸（导航
  // 数字角标），本开关只决定预告算不算进这些口径。
  function notifyPreviewScenes() { return dpPrefs().notifyPreviewScenes === true; }
  function isPreviewScene(sc) {
    return !!(sc && sc.release_date && sc.release_date > SSD.localDateStr(new Date()));
  }
  // 分组的「提醒口径」场景：默认剔除预告，开关开启后等于 g.items。
  // 关注排序 / 未读统计 / 总览计数统一走这里，保证口径一致。
  function notifyItems(g) {
    var items = (g && g.items) || [];
    if (notifyPreviewScenes()) return items;
    return items.filter(function (it) { return !isPreviewScene(it.scene); });
  }
  function notifyNewest(g) {
    var best = "";
    notifyItems(g).forEach(function (it) {
      var d = (it.scene && it.scene.release_date) || "";
      if (d > best) best = d;
    });
    return best;
  }

  // 活动数据源：localStorage 持久化值（若仍有效）→ yml preferredBox → 第一个
  function resolveSource(boxes, ymlSettings) {
    var prefs = dpPrefs();
    var wanted = prefs.source || (ymlSettings && ymlSettings.preferredBox) || "";
    var pick = null;
    if (wanted) {
      // endpoint 才是唯一键；name 分支只为兼容旧版本存下的值（也可能是
      // yml preferredBox，那里本来就是域名片段）
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].endpoint === wanted) { pick = boxes[i]; break; }
      }
      if (!pick) {
        for (var j = 0; j < boxes.length; j++) {
          if (boxes[j].name === wanted) { pick = boxes[j]; break; }
        }
      }
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
        var input = {
          performers: { value: performerStashIds, modifier: "INCLUDES" },
          sort: "DATE", direction: "DESC",
          page: page, per_page: BOX_PAGE_SIZE,
        };
        // 0 = 不限：不带日期过滤（GraphQL 的 date.value 不允许 null）
        if (sinceIsoDate) input.date = { value: sinceIsoDate, modifier: "GREATER_THAN" };
        // TPDB 的 queryScenes 恒返回空 → 内部自动切 REST（按演员逐个取并筛日期）
        return SSD.callBoxSceneList(box, input, BOX_TIMEOUT);
      });
    }
    function next(qs) {
      if (!qs || !qs.scenes) return null; // 无应答 ≠ 空结果（binge 教训）
      qs.scenes.forEach(function (s) { out.push(s); });
      // count 制终止（防源把 per_page 偷降到 100 时截断）
      if (qs.count != null && out.length >= qs.count) return out;
      if (qs.scenes.length === 0 || qs.hasMore === false) return out;
      // 硬上限：防源偷降 per_page 时无限翻页（用户 2026-10-26）
      if (page >= BOX_MAX_PAGES) return out;
      page++;
      return one().then(next);
    }
    return one().then(next);
  }

  // 全量演员新场景：100/批 × 3 宽并发；任一批失败 → 整体 null（不缓存部分）。
  // 会话内 in-flight 去重（binge 模式）。
  var _newScenesFlight = null;

  function fetchNewScenesForPerformers(box, performerStashIds, sinceIsoDate, onProgress) {
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
      var done = 0;
      function runWave() {
        if (idx >= batches.length) return merged;
        var wave = [];
        for (var w = 0; w < BATCH_CONCURRENCY && idx < batches.length; w++) wave.push(batches[idx++]);
        return Promise.all(wave.map(function (b) { return fetchScenesBatch(box, b, sinceIsoDate); })).then(function (results) {
          for (var r = 0; r < results.length; r++) {
            if (results[r] == null) return null; // 部分失败 → 整体 null
            merged = merged.concat(results[r]);
          }
          done += wave.length;
          // 4a：批量进度（用户 2026-10-26），仅用于加载态文案，不影响数据
          if (onProgress) onProgress(done, batches.length);
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
      return SSD.callBoxSceneList(box, {
        sort: "TRENDING", direction: "DESC", page: 1, per_page: TRENDING_PER_PAGE,
      }, BOX_TIMEOUT);
    }).then(function (qs) {
      return (qs && qs.scenes) || null; // null = 失败
    });
  }

  // §4.6 工作室新发布：收藏工作室单查询 studios INCLUDES + date 窗，懒分页
  function fetchStudioScenes(box, studioStashIds, sinceIsoDate) {
    var out = [];
    var page = 1;
    function one() {
      return SSD.boxRateLimiter.submit(function () {
        return SSD.callBoxSceneList(box, {
          date: { value: sinceIsoDate, modifier: "GREATER_THAN" },
          studios: { value: studioStashIds, modifier: "INCLUDES" },
          sort: "DATE", direction: "DESC",
          page: page, per_page: STUDIO_PAGE_SIZE,
        }, BOX_TIMEOUT);
      });
    }
    function next(qs) {
      if (!qs || !qs.scenes) return null;
      qs.scenes.forEach(function (s) { out.push(s); });
      if (qs.count != null && out.length >= qs.count) return out;
      if (qs.scenes.length === 0 || qs.hasMore === false) return out;
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
    // TPDB 没有热度排序（queryPerformers 的 gender/images 也全空），
    // 不做伪热门榜单 —— 返回空让 UI 走空状态，而不是报 API error。
    if (SSD.isTPDBBox(box)) {
      return Promise.resolve({ performers: [], degraded: true });
    }
    return SSD.boxRateLimiter.submit(function () {
      return SSD.callBoxPerformerList(box,
        { sort: "LAST_SCENE", direction: "DESC", page: 1, per_page: Math.max(perPage * 3, 90) },
        BOX_TIMEOUT);
    }).then(function (data) {
      var rows = ((data || {}).performers) || [];
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
          return SSD.callBoxPerformerList(box,
            { gender: g, sort: "LAST_SCENE", direction: "DESC", page: 1, per_page: perPage },
            20000);
        }).then(function (d) {
          return ((d || {}).performers) || [];
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
      return hydrateCacheEntry(e);
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
      return hydrateCacheEntry(e);
    } catch (_) { return null; }
  }

  // 缓存投影：写入前裁掉卡片/统计用不到的字段。
  // 线上实测（2026-10-27，javstash/30d，1844 条）：原始场景单条 12.5KB，其中
  // performers 占 11.2KB（13 人/条，每人带全量 images）。1500 条 ≈ 7.6MB 远超
  // localStorage 配额 → setItem 抛 QuotaExceededError → 缓存永远写不进 →
  // 每次刷新都全量重拉。
  // 对策：演员信息拆成去重索引（perfIndex，按 stashId 只存一次 name + 首图），
  // 场景里只留 id 列表；读取时 hydrate 还原成原结构，上层无感。
  // 实测单条降到约 1.2KB，1844 条 ≈ 2.2MB，可稳定写入。
  var CACHE_IMAGES_PER_SCENE = 8;   // 卡片轮播 + 弹窗打底；其余由详情接口补
  var CACHE_DETAILS_CHARS = 400;    // 卡片描述是 2 行截断，400 字足够且可被搜索
  var CACHE_BUDGET_CHARS = 3600000; // 单条缓存 payload 预算（该源实测配额 5,242,880 字符；
                                    // 线上 1844 条实测 3.0MB，留 30% 给其余 key）
  var CACHE_FMT = 3;                // 3 = 演员走 perfIndex 去重

  // 读取时把 perfIndex 还原成 [{performer:{id,name,images}}]，与旧格式一致
  function hydrateCacheEntry(e) {
    if (!e || e.fmt !== CACHE_FMT) return e;
    var idx = e.perfIndex || {};
    (e.scenes || []).forEach(function (sc) {
      if (!sc || !sc.performers) return;
      sc.performers = sc.performers.map(function (pid) {
        var p = idx[String(pid)] || {};
        var o = { performer: { id: pid, name: p.n || "" } };
        if (p.i) o.performer.images = [{ url: p.i }];
        return o;
      });
    });
    return e;
  }

  function slimSceneForCache(sc, perfIndex) {
    if (!sc || typeof sc !== "object") return sc;
    var perf = [], tags = [], imgs = [];
    (sc.performers || []).forEach(function (p) {
      var pf = (p && p.performer) || null;
      if (!pf || !pf.id) return;
      var id = String(pf.id);
      if (!perfIndex[id]) {
        perfIndex[id] = { n: pf.name || "" };
        if (pf.images && pf.images[0] && pf.images[0].url) perfIndex[id].i = pf.images[0].url;
      }
      perf.push(id);
    });
    (sc.tags || []).forEach(function (t) { if (t && t.name) tags.push({ name: t.name }); });
    (sc.images || []).slice(0, CACHE_IMAGES_PER_SCENE).forEach(function (im) {
      if (im && typeof im.url === "string" && im.url) imgs.push({ url: im.url });
    });
    return {
      id: sc.id, title: sc.title, code: sc.code,
      release_date: sc.release_date, duration: sc.duration, director: sc.director,
      details: sc.details ? String(sc.details).slice(0, CACHE_DETAILS_CHARS) : sc.details,
      studio: sc.studio ? { id: sc.studio.id, name: sc.studio.name } : sc.studio,
      performers: perf, tags: tags, images: imgs,
      urls: (sc.urls || []).map(function (u) { return { url: u && u.url }; }),
    };
  }

  function cacheWrite(host, family, sinceIsoDate, scenes) {
    var key = cacheKey(host, family);
    try {
      var perfIndex = {}, store = [];
      (scenes || []).forEach(function (sc) { if (sc) store.push(slimSceneForCache(sc, perfIndex)); });
      if (store.length > CACHE_SCENES_CAP) {
        store = store.slice().sort(function (a, b) {
          return String(b.release_date || "").localeCompare(String(a.release_date || ""));
        }).slice(0, CACHE_SCENES_CAP);
      }
      var build = function () {
        // 只保留仍在场景里出现的演员，避免索引随裁剪残留
        var used = {}, idx = {};
        store.forEach(function (sc) {
          (sc.performers || []).forEach(function (id) { used[String(id)] = 1; });
        });
        Object.keys(perfIndex).forEach(function (id) { if (used[id]) idx[id] = perfIndex[id]; });
        return JSON.stringify({
          fmt: CACHE_FMT, sinceIsoDate: sinceIsoDate || null, fetchedAt: Date.now(),
          perfIndex: idx, scenes: store,
        });
      };
      var payload = build();
      // 预算护栏：超预算按 0.7 递减重试（保留最新的那部分），仍写不进则出声
      for (var k = 0; k < 4 && payload.length > CACHE_BUDGET_CHARS && store.length > 1; k++) {
        store = store.slice(0, Math.max(1, Math.floor(store.length * 0.7)));
        payload = build();
      }
      localStorage.setItem(key, payload);
      // 清同家族旧版本 key（防版本升级孤儿条目占配额）
      var stale = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k2 = localStorage.key(i);
        if (k2 && k2.indexOf(LS_PREFIX + host + ":" + family + ".") === 0 && k2 !== key) stale.push(k2);
      }
      stale.forEach(function (k3) { localStorage.removeItem(k3); });
      if (payload.length > CACHE_BUDGET_CHARS * 0.9) {
        console.warn("[SSD] discover cache near budget:", family, payload.length, "chars,", store.length, "scenes");
      }
    } catch (e) {
      // 不再静默吞掉：写失败 = 下次必定全量重拉，必须留痕（用户 2026-10-27）
      console.warn("[SSD] discover cache write failed:", family, (e && e.name) || e);
    }
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
      var recentDays = dpRecentDays();
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
      return Promise.all([loadOwnedKeys(), fetchNewScenesForPerformers(box, ids, base.since, opts && opts.onProgress)]).then(function (r) {
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
              // 旧缓存可能没有 degraded 字段：TPDB 一律归一为 degraded
              var deg = SSD.isTPDBBox({ endpoint: base.source.endpoint }) ? true : e.degraded;
              return { source: base.source, fromCache: "fresh", performers: e.performers, degraded: deg };
            }
          }
        } catch (_) {}
      }
      var box = { name: base.source.name, endpoint: base.source.endpoint, apiKey: base.source.apiKey, host: host };
      return fetchTrendingPerformers(box, opts.perPage || 24, genders).then(function (r) {
        try {
          localStorage.setItem(LS_PREFIX + host + ":trendingPerf.v1", JSON.stringify({ fetchedAt: Date.now(), performers: r.performers, degraded: r.degraded }));
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
    progress: null,   // latest 拉取进度 {done,total}（4a，仅加载态文案）
    fetchedAt: 0,     // 数据集最新 fetchedAt（页头相对时间）
    search: "", page: 1,
    boxes: [],        // 已配置 stash-box（数据源下拉）
    refreshing: false,
    followOpenKey: null, // 关注分组展开态（会话级；单一 key = 手风琴，最多展开一位）
    perfGroup: null,  // 演员过滤视图：actorsWithNew 分组引用
    perfFrom: null,   // 进入演员过滤视图前的来源视图（返回按钮回到这里）
    studioGroup: null, // 工作室过滤视图：studio 分组引用
    csize: 1,         // 场景卡档位 0 紧凑 / 1 标准 / 2 大（只作用于场景网格）
    refs: {},         // chrome 元素引用（head/tabs/toolbar/content）
  };

  function dpSetPrefs(patch) {
    try {
      var p = dpPrefs();
      Object.keys(patch || {}).forEach(function (k) { p[k] = patch[k]; });
      localStorage.setItem(LS_PREFIX + "prefs", JSON.stringify(p));
      return true;
    } catch (err) {
      // 配额满时 setItem 抛 QuotaExceededError：以前静默吞掉，用户以为改了，
      // 一刷新就回到旧值（论坛反馈「选完 TPDB 切不回来」的候选原因）
      console.warn("[SSD] prefs write failed:", err);
      return false;
    }
  }

  // 一次性迁移（用户 2026-10-27）：旧 key skipPreviewNotify（"预告不提醒"，默认开）
  // → 新 key notifyPreviewScenes（"预告也计入提醒"，默认关）。两者语义相反，默认
  // 行为等价，所以只有明确选过「要提醒预告」（旧值 false）的用户需要补一条 true。
  function migratePreviewPref() {
    var p = dpPrefs();
    if (!Object.prototype.hasOwnProperty.call(p, "skipPreviewNotify")) return;
    if (p.skipPreviewNotify === false) p.notifyPreviewScenes = true;
    delete p.skipPreviewNotify;
    try { localStorage.setItem(LS_PREFIX + "prefs", JSON.stringify(p)); } catch (_) {}
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
      notifyItems(g).forEach(function (it) { if (!readIs(it.endpoint, it.scene.id)) n++; });
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
  // 反馈（用户 2026-10-27）：点击立即变色 + 文案「导入中…」+ 图标旋转；
  // 结束按结果给「已导入 N 位 / 均已关注 / 导入失败」并停留 ~2s，可被打断。
  function makeImportButton() {
    var btn = el("button", "ssd-dp-btn ghost", I.heartFill + "<span>" + tc("从收藏导入", "Import ❤ favorites") + "</span>");
    btn.type = "button";
    var busy = false;
    var resetT = 0;
    function setFace(cls, label) {
      btn.classList.remove("ok", "err", "busy");
      if (cls) btn.classList.add(cls);
      var span = btn.querySelector("span");
      if (span) span.textContent = label;
    }
    var idle = function () { setFace(null, tc("从收藏导入", "Import ❤ favorites")); btn.title = ""; };
    btn.addEventListener("click", function () {
      if (busy) return;
      busy = true;
      btn.disabled = true;
      clearTimeout(resetT);
      setFace("busy", tc("导入中…", "Importing…"));
      importFavoritesFromLibrary().then(function (r) {
        busy = false;
        btn.disabled = false;
        if (r.imported > 0) {
          // 导入的演员立即进入轮询：强制检查一次，绕过 6h 节流
          // （否则刚导入后角标/未读要等下一个 6h 窗口 — 用户 2026-10-25 第七轮）
          if (SSD.pollFollowed) SSD.pollFollowed(true);
          setFace("ok", tc("已导入 " + r.imported + " 位", "Imported " + r.imported));
          emitUnread();
          resetT = setTimeout(function () { idle(); render(); }, 1400);
          return;
        }
        setFace("ok", tc("均已关注", "Already followed"));
        btn.title = tc("库内收藏均已关注，或未关联当前数据源", "Favorites already followed, or not linked to the current source");
        resetT = setTimeout(idle, 2000);
      }).catch(function () {
        busy = false;
        btn.disabled = false;
        setFace("err", tc("导入失败", "Import failed"));
        resetT = setTimeout(idle, 2200);
      });
    });
    return btn;
  }

  // ── 图标（设计原型同款 SVG）──────────────────────────────────────────────
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
    back: sv('<path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/>'),
    refresh: sv('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>'),
    grid: sv('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    list: sv('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>'),
    heartFill: sv('<path d="M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 22.5 7.5 21 11c-2 4.5-9 9-9 9z"/>', "currentColor"),
    // 取关（取消关注）：爱心 + 斜杠。和列表里的爱心同源，一眼看出是「去掉关注」；
    // 纯图标按钮省掉英文 "Unfollow" 撑出的宽度（用户 2026-10-27）
    heartOff: sv('<path d="M12 20s-7-4.5-9-9c-1.5-3.5 1-7 4.5-7 2 0 3.5 1 4.5 2.5C13 5 14.5 4 16.5 4 20 4 22.5 7.5 21 11c-2 4.5-9 9-9 9z"/><path d="M4 4l16 16" stroke-width="2.6"/>'),
    // 筛选行收起后的「更多筛选」：两条滑杆，比漏斗更贴合「多个可调选项」的语义
    filter: sv('<circle cx="9" cy="7" r="2.5"/><path d="M3 7h3.5M11.5 7H21"/><circle cx="15" cy="17" r="2.5"/><path d="M3 17h9.5M17.5 17H21"/>'),
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
    // 角标要短：英文原本 "in 3 days" / "out today"（9 字符）在 217px 的卡上
    // 占去四分之一封面，压成 "in 3d" / "today"（用户 2026-10-28）
    if (isNaN(n) || n <= 0) return tc("今天上映", "today");
    return tc(n + " 天后上映", "in " + n + "d");
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
  // 预取上限（保守估算，宁多勿少）：按 180px 这个"最小可能卡宽"算列数，真实列数
  // 由 trimRows 渲染后按布局裁。
  //
  // 原先用 colsOf(240, true) 精确估，两个坑（用户 2026-10-27 iPad 实测）：
  //   1) half=true 假设 duo 恒为半宽，但 ≤900px 时 .ssd-dp-duo 已降为单列，
  //      按半宽算只出 2 张卡 → 834px 下 CSS 明明能排 3 列，第 3 张根本没生成；
  //   2) 240 比 CSS 的 minmax 大一截，临界宽度会少算一列。
  // 预取多个 3~5 张的代价只是多建几个 DOM（图片是 loading=lazy），换掉整类漏列 bug。
  function prefetchLimit(rows) {
    var w = _dp.refs.content ? _dp.refs.content.clientWidth : 1200;
    var cols = Math.max(1, Math.ceil(w / 180));
    return rows * cols + 2;
  }
  // 渲染后按真实列数截断：数第一行卡数 C，只保留 n 行（对窗口宽度/缩放/卡宽
  // 变化免疫——prefetchLimit 只是上限，行数最终以实际布局为准）
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
      if (k === "latest") _dp.progress = null;
      DATASETS[k]({ force: !!force, onProgress: k === "latest" ? updateFetchProgress : null }).then(function (r) {
        _dp.d[k] = r; _dp.loading[k] = false;
        if (k === "latest") _dp.progress = null;
        _dp.fetchedAt = Math.max(_dp.fetchedAt, r.fetchedAt || 0);
        if (k === "latest") { _dp.boxes = r.boxes || []; syncSourceSelect(); }
        emitUnread();
        render();
      }).catch(function (e) {
        _dp.loading[k] = false;
        if (k === "latest") _dp.progress = null;
        _dp.err[k] = e;
        render();
      });
    });
  }
  // 4a：批量进度只刷新加载态文案；节流避免整页高频重绘（用户 2026-10-26）
  var _progressTimer = 0;
  function updateFetchProgress(done, total) {
    _dp.progress = { done: done, total: total };
    if (_progressTimer) return;
    _progressTimer = setTimeout(function () {
      _progressTimer = 0;
      // 仅当当前视图会展示 latest 且仍在加载时重绘，避免打断设置页输入
      if (_dp.loading.latest && _dp.progress && viewDataKeys(_dp.view).indexOf("latest") >= 0) render();
    }, 400);
  }
  function loadingText() {
    var p = _dp.progress;
    if (!p || !(p.total > 1) || p.done >= p.total) return null;
    return tc("加载中… 已拉取 " + p.done + "/" + p.total + " 批",
      "Loading… " + p.done + "/" + p.total + " batches");
  }
  function pollSettled(keys, cb) {
    var t = setInterval(function () {
      var busy = keys.some(function (k) { return _dp.loading[k]; });
      if (!busy) { clearInterval(t); cb(); }
    }, 150);
    setTimeout(function () { clearInterval(t); cb(); }, 60000); // 兜底
  }
  // 源错误 → 具体原因（用户 2026-10-26：不再只显示 Unknown error）
  var ERR_KIND_TEXT = {
    timeout: ["请求超时：源响应太慢或被中断", "Timed out — the source did not respond in time"],
    network: ["无法连接：网络错误或源不可达", "Unreachable — network error"],
    auth: ["鉴权失败：请检查该源的 API Key", "Auth failed — check this source's API key"],
    blocked: ["请求被源拒绝", "Rejected by the source"],
    graphql: ["源接口返回错误", "The source API returned an error"],
    parse: ["源返回了无法解析的响应", "Bad response from the source"],
    fatal: ["数据加载失败", "Failed to load data"],
    "no-ids": ["缺少 stash-box 编号", "No stash-box ID"],
    unknown: ["未知错误", "Unknown error"],
  };
  function errText(e) {
    if (!e) return tc("未知错误", "Unknown error");
    if (e.ssdKind === "no-box") return tc(
      "未配置 stash-box — 请在 设置 → 元数据提供者 中添加一个实例",
      "No stash-box configured — add one under Settings → Metadata Providers");
    var pair = ERR_KIND_TEXT[e.ssdKind] || ERR_KIND_TEXT.unknown;
    var zh = pair[0], en = pair[1];
    // 明细一律附上：以前只有 "HTTP xxx" 才拼进去，于是 TPDB 在发现页的任何
    // 异常都只剩一句 "Unknown error"，用户和作者都拿不到线索（论坛反馈）
    var detail = String(e.message || "").trim();
    if (detail && detail !== "unknown") {
      if (detail.length > 160) detail = detail.slice(0, 160) + "…";
      zh += "（" + detail + "）";
      en += " (" + detail + ")";
    }
    return tc(zh, en);
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
    // 角标挂在 .thumbnail-section（与原生 .studio-overlay 同级）而不是
    // .scene-card-preview：sfwswitch（社区「NSFW 模糊」插件）给 preview 整体上
    // blur(30px)，filter 作用于整个子树，角标会被一起糊掉（用户 2026-10-28）。
    var badgeHost = card.querySelector(".thumbnail-section") || card.querySelector(".scene-card-preview");
    if (badgeHost) {
      // 角标归拢进一个竖向堆叠的容器：① 多个角标同时出现时（预告 + 库内演员）
      // 不再互相压在同一坐标上；② 位置由容器一处控制，「默认角标位置」才能只切
      // 一个属性（用户 2026-10-28）。发现页的源徽章恒不渲染（cardCtx 传空
      // queryBoxes），容器里实际是 预告 / 距上映天数 / 库内演员。
      var badgeBox = badgeHost.querySelector(".ssd-badges");
      if (!badgeBox) {
        badgeBox = el("div", "ssd-badges");
        var moved = badgeHost.querySelectorAll(".ssd-overlay-box, .ssd-overlay-preview");
        for (var bi = 0; bi < moved.length; bi++) badgeBox.appendChild(moved[bi]);
        badgeHost.appendChild(badgeBox);
      }
      if (opts.days) {
        var old = badgeBox.querySelector(".ssd-overlay-preview");
        if (old) old.remove();
        if (sc.release_date && sc.release_date > SSD.localDateStr(new Date())) {
          badgeBox.appendChild(el("span", "ssd-overlay-days", daysUntilText(sc.release_date)));
        }
      }
      // 徽章语义是「这部片里有你库内的演员」，不是「这部片已入库」——
      // 原本文案只写「库内」被读成后者（用户 2026-10-28 反馈）。
      // hasLocalPerformer 只在热门榜赋值，opts.inlib 再兜一层，防止将来别的
      // 数据集带上该字段时误显示。
      if (opts.inlib && item.hasLocalPerformer) {
        // 英文角标要短到与中文「库内演员」等宽（"Known performer" 在窄卡上压
        // 掉半张封面），缩写取 "Known"，完整解释放 title（用户 2026-10-28）
        var libBadge = el("span", "ssd-overlay-inlib", tc("库内演员", "Known"));
        libBadge.title = tc("这部片里有你库内的演员", "Features a performer in your library");
        badgeBox.appendChild(libBadge);
      }
    }
    if (opts.unread) {
      // 红框只在"计入提醒"时才画：默认预告不进未读（用户 2026-10-27）。
      // 点击仍一律标已读 —— 看过就是看过，之后打开「预告也计入提醒」不会翻旧账。
      if (!readIs(item.endpoint, sc.id) && (notifyPreviewScenes() || !isPreviewScene(sc))) {
        card.classList.add("ssd-card-new");
      }
      card.addEventListener("click", function () {
        readMark(item.endpoint, sc.id);
        emitUnread();
        if (_dp.view === "follow") render();
      });
    }
    return card;
  }
  // 列表模式（一个场景一行）下的未读标记：表格行画不出卡片那圈红框，改给 <tr>
  // 打 ssd-row-new（判定口径与卡片完全一致），封面描红 + 整行淡红，见 CSS。
  // 「记已读」只挂在封面链接上 —— 那才是打开场景弹窗的入口（用户 2026-10-28：
  // 光点行不该算看过）。标题列是跳 stash-box 的新标签页，也不算。
  // 不重排整表：此刻正在冒泡的可能是一个 target=_blank 的 <a>，重建表格有打断
  // 跳转的风险，所以只摘本行的标记，计数交给 emitUnread()。
  function decorateUnreadRows(tbl, items) {
    var rows = tbl.querySelectorAll("tbody tr");
    for (var i = 0; i < items.length && i < rows.length; i++) {
      (function (row, it) {
        var sc = it && it.scene;
        if (!sc) return;
        if (readIs(it.endpoint, sc.id)) return;
        if (!notifyPreviewScenes() && isPreviewScene(sc)) return;
        row.classList.add("ssd-row-new");
        var coverLink = row.querySelector("td.cover_image-data a");
        if (!coverLink) return;
        coverLink.addEventListener("click", function () {
          if (!row.classList.contains("ssd-row-new")) return;
          readMark(it.endpoint, sc.id);
          row.classList.remove("ssd-row-new");
          emitUnread();
        });
      })(rows[i], items[i]);
    }
  }
  function sceneGrid(items, opts) {
    opts = opts || {};
    if (_dp.mode === "list" && opts.allowList) {
      var tbl = SSD.buildSceneTable(items);
      if (opts.unread) decorateUnreadRows(tbl, items);
      return tbl;
    }
    var grid = el("div", "ssd-card-grid");
    grid.setAttribute("data-zoom", "0");
    var ctx = cardCtx();
    items.forEach(function (it, i) {
      grid.appendChild(decorateCard(SSD.buildSceneCard(it, i, ctx), it, opts));
    });
    return grid;
  }

  // ── 迷你演员卡（§3.2 模块 1/6）───────────────────────────────────────────
  // 迷你卡副标题「最新 <日期>」：日期整体不可断行，窄卡上只会折在「最新 」之后，
  // 不会出现「2026-10-」/「08」这种把日期劈成两半的断法（用户 2026-10-27 极窄屏）
  function subLatest(day) {
    return tc("最新 ", "newest ") + '<span class="ssd-dp-nw">' + (day || "—") + "</span>";
  }

  function miniPerfCard(o) {
    // 已关注 → 卡片底色轻染（CSS 里 color-mix 在主色上算，跟主题走）。
    // 关注页用的是行式卡片，不走这里，所以「已关注模块」不会被整片上色。
    var c = el("div", "ssd-dp-mini" + (o.heart ? " is-followed" : ""));
    // 头像单独包一层：已关注爱心要骑在圆形头像边框上，得有个定位基准
    var ava = el("div", "ssd-dp-mini-ava");
    var img = document.createElement("img");
    img.loading = "lazy";
    img.alt = o.name || "";
    img.src = o.image || letterAvatar(o.name);
    img.onerror = function () { this.src = letterAvatar(o.name); };
    ava.appendChild(img);
    // 已关注标记改到头像边框左下角（原来挂在卡片右下角，离头像太远、看着像卡片角标）
    if (o.heart) ava.appendChild(el("span", "ssd-mini-heart", I.heartFill));
    c.appendChild(ava);
    var tx = el("div", null);
    tx.style.minWidth = "0";
    tx.appendChild(el("div", "ssd-dp-mini-name", o.name || tc("未知演员", "Unknown")));
    if (o.sub) tx.appendChild(el("div", "ssd-dp-mini-sub", o.sub));
    c.appendChild(tx);
    if (o.badge) {
      var b = el("span", "ssd-dp-mini-badge" + (o.badgeKind ? " " + o.badgeKind : ""), o.badge);
      // 角标为省宽度用简写（「新作 3」），完整说法留在 title 里
      if (o.badgeTitle) b.title = o.badgeTitle;
      c.appendChild(b);
    }
    if (o.onClick) c.addEventListener("click", function (e) { o.onClick(e, c); });
    return c;
  }

  // ── 模块段（§3.2）────────────────────────────────────────────────────────
  function sec(parent, o) {
    var s = el("section", "ssd-dp-sec");
    // 模块标识：供 CSS 给标题图标上色（与主 tab 图标同一套色相 — 用户 2026-10-27）
    if (o.mod) s.setAttribute("data-mod", o.mod);
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
    // 合并为一个设置项时行数共享（用户 2026-10-26）：两个模块同一行数
    if (mergeTrendPreview()) rows.preview = rows.trending;
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

  // 热门 ∥ 即将发布合并成一个设置项（用户 2026-10-26）：
  // 排序与行数共享，两者在 order 中保持相邻并视作整体移动
  function pairAdjacentOrder(a, b) {
    var order = moduleOrder();
    var ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia < 0 || ib < 0 || Math.abs(ia - ib) === 1) return order;
    var first = ia < ib ? a : b, second = first === a ? b : a;
    var rest = order.filter(function (id) { return id !== second; });
    rest.splice(rest.indexOf(first) + 1, 0, second);
    return rest;
  }
  function moveModulePair(a, b, dir) {
    var order = pairAdjacentOrder(a, b);
    var ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia < 0 || ib < 0) return;
    var start = Math.min(ia, ib), end = Math.max(ia, ib);
    if (dir < 0) {
      if (start <= 0) return;
      var prev = order.splice(start - 1, 1)[0];
      order.splice(end, 0, prev);
    } else {
      if (end >= order.length - 1) return;
      var nxt = order.splice(end + 1, 1)[0];
      order.splice(start, 0, nxt);
    }
    dpSetPrefs({ order: order });
    render();
  }

  // 热门 ∥ 即将发布是否并排成一行（用户 2026-10-26 可设置；默认开启）
  function mergeTrendPreview() {
    return dpPrefs().mergeTrendPreview !== false;
  }

  // TPDB 没有热度排序（2026-10-26 实证：REST/GraphQL 的 sort 全被忽略，
  // 也没有本周热门接口）→ 该源下「热门」实为全站最新入库。按 A 方案把模块
  // 与 tab 都改名「网站上新」，不伪造热度榜。
  function currentSourceData() {
    return (_dp.d.trending && _dp.d.trending.source) ||
      (_dp.d.latest && _dp.d.latest.source) || null;
  }
  function trendingOnTPDB() {
    var s = currentSourceData();
    return !!(s && s.endpoint && SSD.isTPDBBox({ endpoint: s.endpoint }));
  }
  function trendingTitle() {
    return trendingOnTPDB() ? tc("网站上新", "New on site") : tc("热门", "Trending");
  }
  // 设置页提示用：当前选中的源是否 TPDB（数据尚未就绪时也能判断）
  function sourceIsTPDB() {
    var boxes = _dp.boxes || [];
    var src = _dp.d.latest && _dp.d.latest.source;
    var key = (src && (src.endpoint || src.name)) || dpPrefs().source || "";
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].name === key || boxes[i].endpoint === key) return SSD.isTPDBBox(boxes[i]);
    }
    return boxes.length === 1 && SSD.isTPDBBox(boxes[0]);
  }
  // TPDB 空状态兜底：旧缓存（2.2.4 前）可能没有 degraded 标志，
  // 或缓存里的 performers 为空但未标记；该源一律视为「无热度榜」。
  function trendingDegraded(tp) {
    return !!(tp && (tp.degraded || trendingOnTPDB()));
  }

  function renderOverview(c) {
    var rows = overviewRows();
    var order = moduleOrder().filter(moduleShown);
    var i = 0;
    while (i < order.length) {
      var id = order[i], nxt = order[i + 1];
      // 热门∥即将发布相邻时并排（duo），被排序拆开或关闭「并排」时各自全宽。
      // duo 先入文档再渲染模块——trimRows 需要真实布局才能数列数
      if (mergeTrendPreview() && ((id === "trending" && nxt === "preview") || (id === "preview" && nxt === "trending"))) {
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
      // 「预告内容不提醒」开启时，只有预告没有正式新作的演员直接剔除（用户 2026-10-27）
      var aw = (d ? (d.actorsWithNew || []) : []).filter(function (g) { return notifyItems(g).length > 0; });
      var awScenes = aw.reduce(function (n, g) { return n + notifyItems(g).length; }, 0);
      var s1 = sec(parent, {
        icon: I.star, title: tc("有新发布的演员", "Performers with releases"), mod: "actors",
        count: d ? tc(aw.length + " 位演员 · " + awScenes + " 部新作品 · " + lookbackText(d.recentDays, true),
          aw.length + " performers · " + awScenes + " new · " + lookbackText(d.recentDays, false)) : "",
        // 查看更多 → 发现演员页「本地有更新」tab（用户 2026-10-25）
        more: function () { dpSetPrefs({ perfSrc: "local" }); switchView("performers"); },
      });
      if (!d) secBody(s1, _dp.err.latest ? "error" : "loading", _dp.err.latest ? errText(_dp.err.latest) : loadingText(), retryLatest);
      else if (!aw.length) {
        // 区分「没有可匹配的演员」与「窗口内确实没有新作品」（用户 2026-10-26）
        var noLinked = !(d.linked || []).length;
        secBody(s1, null).appendChild(stateBox("empty", noLinked
          ? tc("本地演员还没有关联 stash-box 编号，无法匹配源数据", "No local performers are linked to stash-box IDs yet")
          : (d.actorsWithNew || []).length
            ? tc("仅有预告内容（已在设置中静音预告提醒）", "Preview-only releases (preview alerts are muted in Settings)")
            : tc("回看期内没有新作品", "No new releases in the lookback window")));
      }
      else {
        var g1 = el("div", "ssd-dp-grid mini");
        aw.slice(0, rows.actors * 12).forEach(function (grp) {
          var cnt = notifyItems(grp).length;
          g1.appendChild(miniPerfCard({
            name: grp.performer.name,
            image: grp.performer.image,
            sub: subLatest(notifyNewest(grp)),
            // 角标用「新作 3」：与英文 "3 new" 等宽，完整说法进 title
            badge: tc("新作 " + cnt, cnt + " new"),
            badgeTitle: tc(cnt + " 部新作品", cnt + " new"),
            heart: followHas(grp.performer.stashId),
            onClick: function () { openPerfFilter(grp); },
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
        icon: I.latest, title: tc("最新发布", "Latest"), mod: "latest",
        count: d ? tc((d.latest || []).length + " 部未拥有 · 每人最多 2 部", (d.latest || []).length + " unowned · max 2 per performer") : "",
        more: function () { switchView("latest"); },
      });
      if (!d) secBody(s2, _dp.err.latest ? "error" : "loading", _dp.err.latest ? errText(_dp.err.latest) : loadingText(), retryLatest);
      else if (!(d.latest || []).length) secBody(s2, null).appendChild(stateBox("empty", tc("暂无未拥有新场景", "No unowned new scenes")));
      else {
        var g2 = sceneGrid(d.latest.slice(0, prefetchLimit(rows.latest)));
        g2.classList.add("ssd-dp-grid");
        s2.appendChild(g2);
        trimRows(g2, rows.latest);
      }
      return;
    }
    if (id === "trending") {
      var s3 = sec(parent, {
        icon: I.trending, title: trendingTitle(), mod: "trending",
        count: t ? (trendingOnTPDB()
          ? tc(SSD.brandNameForEndpoint(t.source.endpoint, t.source.name) + " 无热度榜 · 按入库时间", "No popularity ranking — newest first")
          : tc(SSD.brandNameForEndpoint(t.source.endpoint, t.source.name) + " 全站榜 · 不限库内", "Site-wide · not library-filtered")) : "",
        more: function () { switchView("trending"); },
      });
      if (!t) secBody(s3, _dp.err.trending ? "error" : "loading", _dp.err.trending ? errText(_dp.err.trending) : null, function () { retryDataset("trending"); });
      else if (!(t.items || []).length) secBody(s3, null).appendChild(stateBox("empty", tc("榜单暂无内容", "Empty list")));
      else {
        var g3 = sceneGrid(t.items.slice(0, prefetchLimit(rows.trending)), { inlib: true });
        g3.classList.add("ssd-dp-grid");
        s3.appendChild(g3);
        trimRows(g3, rows.trending);
      }
      return;
    }
    if (id === "preview") {
      var s4 = sec(parent, {
        icon: I.preview, title: tc("即将发布", "Upcoming"), mod: "preview",
        count: d ? tc("未来 " + d.previewDays + " 天 · " + (d.preview || []).length + " 部", "next " + d.previewDays + "d · " + (d.preview || []).length) : "",
        // 查看更多 → 最新视图「预告」子 tab（预告分页并入最新 — 用户 2026-10-25）
        more: function () { dpSetPrefs({ latestSub: "preview" }); switchView("latest"); },
      });
      if (!d) secBody(s4, _dp.err.latest ? "error" : "loading", _dp.err.latest ? errText(_dp.err.latest) : loadingText(), retryLatest);
      else if (!(d.preview || []).length) secBody(s4, null).appendChild(stateBox("empty", tc("近期没有待发布场景", "No upcoming scenes")));
      else {
        var g4 = sceneGrid(d.preview.slice(0, prefetchLimit(rows.preview)), { days: true });
        g4.classList.add("ssd-dp-grid");
        s4.appendChild(g4);
        trimRows(g4, rows.preview);
      }
      return;
    }
    if (id === "studios") {
      // 模块：工作室新发布（收藏工作室，cap 2/工作室）
      var s5 = sec(parent, {
        icon: I.studios, title: tc("工作室新发布", "Studio releases"), mod: "studios",
        count: st ? tc((st.studioCount || 0) + " 个收藏工作室 · 每工作室最多 2 部", (st.studioCount || 0) + " favorites · max 2 per studio") : "",
        more: function () { switchView("studios"); },
      });
      if (!st) secBody(s5, _dp.err.studios ? "error" : "loading", _dp.err.studios ? errText(_dp.err.studios) : null, function () { retryDataset("studios"); });
      else if (!(st.items || []).length) {
        // 区分「还没有收藏工作室」与「收藏的工作室窗口内无新片」（用户 2026-10-26）
        secBody(s5, null).appendChild(stateBox("empty", !st.studioCount
          ? tc("还没有收藏工作室，先在本地库里收藏工作室", "No favorite studios yet — favorite some in your library")
          : tc("收藏的工作室暂无新作品", "No new releases from favorite studios")));
      }
      else {
        var g5 = sceneGrid(st.items.slice(0, prefetchLimit(rows.studios)));
        g5.classList.add("ssd-dp-grid");
        s5.appendChild(g5);
        trimRows(g5, rows.studios);
      }
      return;
    }
    if (id === "performers") {
      // 模块：发现演员（共同出演 ∥ 热门榜）
      var s6 = sec(parent, {
        icon: I.performers, title: tc("发现演员", "Discover performers"), mod: "performers",
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
            sub: coSub(cs),
            badge: tc("共同出演", "Co-star"), badgeKind: "co",
            onClick: function () { openPerfModal({ src: "co", stashId: cs.meta.stashId, name: cs.meta.name, image: cs.meta.image, scenes: cs.scenes, items: cs.items, coWith: cs.coWith }); },
          }));
        });
        trendingPerfMinis({ limit: Math.max(0, rows.performers * 12 - g6.children.length) }).forEach(function (pm) { g6.appendChild(pm); });
        if (!g6.children.length) s6.appendChild(stateBox("empty", trendingDegraded(tp)
          ? tc("该源不提供热门演员榜；共同出演暂无可发现演员", "No trending list on this source; no co-starred performers to discover")
          : tc("暂无可发现的演员", "No performers to discover")));
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
    var counts = {}, meta = {}, coWith = {};
    (d.actorsWithNew || []).forEach(function (g) {
      // 记住这位共演者是「跟谁同场」的：卡片副标题要说清入选原因，
      // 只写「共同出演 ×64」看不出这 64 场是和谁演的（用户 2026-10-27）
      var srcId = String((g.performer && g.performer.stashId) || "");
      var srcName = (g.performer && g.performer.name) || "";
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
          if (!coWith[pid]) coWith[pid] = {};
          var w = coWith[pid][srcId] || (coWith[pid][srcId] = { name: srcName, n: 0 });
          w.n++;
        });
      });
    });
    return Object.keys(counts).map(function (k) {
      // 按同场场景数降序：同一共演者可能同时与多位已关注演员同场
      var list = Object.keys(coWith[k] || {}).map(function (x) { return coWith[k][x]; })
        .sort(function (a, b) { return b.n - a.n; });
      return { meta: meta[k], scenes: counts[k].n, items: counts[k].items, coWith: list };
    }).sort(function (a, b) { return b.scenes - a.scenes; }).slice(0, 12);
  }

  // 共演卡副标题：说清「跟谁一起演」，而不是只给一个没有指向的场景数
  // （用户 2026-10-27：「共同出演 ×64」看不出这 64 场是和谁演的）
  function coSub(cs) {
    var list = cs.coWith || [];
    if (!list.length) return tc("共同出演", "Co-star");
    var more = list.length - 1;
    // 副标题只负责「和谁」；类型由角标「共同出演」交代，不必重复说「共演」
    return tc("与 " + list[0].name + (more ? " +" + more : ""),
              "with " + list[0].name + (more ? " +" + more : ""));
  }

  // 弹窗里有整行宽度，把「和谁 + 几场」写全
  function coStat(p) {
    var list = p.coWith || [];
    var n = p.scenes || 0;
    if (!list.length) return tc("共同出演 " + n + " 部", "in " + n + " scenes");
    if (list.length > 1) {
      return tc("与 " + list[0].name + " 等 " + list.length + " 人共同出演 " + n + " 部",
                "with " + list[0].name + " and " + (list.length - 1) + " more · " + n + " scenes");
    }
    return tc("与 " + list[0].name + " 共同出演 " + n + " 部",
              "with " + list[0].name + " · " + n + " scenes");
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
        // 只留作品数：「· 最近有新作」在窄卡里必然被省略号吃掉
        // （实测 1280 下文字需 125px、可用只有 113px — 用户 2026-10-27）
        sub: tc((pf.sceneCount || 0) + " 部作品", (pf.sceneCount || 0) + " scenes"),
        // 角标只留序号：英文 "Trending #12" 有 12 字符，迷你卡只有 168px 宽，
        // 会被撑到半张卡；中文「热门榜 #12」已经够短，保持（用户 2026-10-28）
        badge: tc("热门榜 #" + rank, "#" + rank), badgeKind: "hot",
        badgeTitle: tc("热门榜第 " + rank + " 位", "Trending #" + rank),
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
      c.appendChild(stateBox("loading", loadingText()));
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
        goStash.addEventListener("click", function () { window.location.assign(SSD.appUrl("/studios")); });
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
    // 英文标签缩短 + tab 允许换行，避免长词溢出按钮（用户 2026-10-27）
    var sub = el("div", "ssd-dp-tabs ssd-dp-subtabs");
    [["local", tc("本地有更新", "Local")], ["co", tc("共同出演", "Co-starred")], ["hot", tc("热门演员榜", "Trending")]].forEach(function (pair) {
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
      c.appendChild(stateBox("loading", loadingText()));
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
          sub: subLatest(grp.newest),
          badge: tc("新作 " + grp.items.length, grp.items.length + " new"),
          badgeTitle: tc(grp.items.length + " 部新作品", grp.items.length + " new"),
          heart: followHas(grp.performer.stashId),
          onClick: function () { openPerfFilter(grp); },
        }));
      });
    } else if (src === "co") {
      buildCoStars().forEach(function (cs) {
        if (q && cs.meta.name.toLowerCase().indexOf(q) === -1) return;
        grid.appendChild(miniPerfCard({
          name: cs.meta.name,
          image: cs.meta.image,
          sub: coSub(cs),
          badge: tc("共同出演", "Co-star"), badgeKind: "co",
          onClick: function () { openPerfModal({ src: "co", stashId: cs.meta.stashId, name: cs.meta.name, image: cs.meta.image, scenes: cs.scenes, items: cs.items, coWith: cs.coWith }); },
        }));
      });
    } else {
      trendingPerfMinis().forEach(function (pm) { grid.appendChild(pm); });
      if (!grid.children.length && trendingDegraded(_dp.d.trendingPerf)) {
        emptyMsg = tc("该源不提供热门演员榜（TPDB 没有热度排序）", "This source has no trending performers list (TPDB has no popularity sort)");
      }
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
      ? coStat(p)
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
    // 头像翻页状态（详情加载后填充）：加入库用当前查看的这张头像
    var avatarPager = { urls: [], idx: 0 };
    addBtn.addEventListener("click", function () {
      if (addBtn.disabled) return;
      addBtn.disabled = true;
      addBtn.textContent = tc("加入中…", "Adding…");
      var input = { name: p.name, stash_ids: [{ endpoint: endpoint, stash_id: String(p.stashId) }] };
      var avatarUrl = avatarPager.urls[avatarPager.idx] || "";
      fetchImageDataUrl(avatarUrl).then(function (dataUrl) {
        if (dataUrl) input.image = dataUrl;
        return SSD.callGQL(
          "mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}",
          { input: input }
        );
      }).then(function (r) {
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
    // 源按钮：品牌名 + 外链图标（弃 ↗ 文字箭头 — 用户 2026-10-25 第五轮；
    // 详情区右上角那颗在 2026-10-27 已换成返回按钮，这里不再与之对应）
    var boxBtn = el("a", "ssd-dp-btn", SSD.brandNameForEndpoint(endpoint) + I.ext);
    boxBtn.href = SSD.boxWebBase(endpoint) + "/performers/" + p.stashId;
    boxBtn.target = "_blank";
    boxBtn.rel = "noopener noreferrer";
    acts.appendChild(boxBtn);
    body.appendChild(acts);

    // 相关场景
    var sc = el("div", "ssd-dp-modal-scenes");
    // 档位随发现页滑块（用户 2026-10-28）：弹层不在 .ssd-dp-page 内，
    // 必须自己带一份 data-csize，CSS 才能算出 --ssd-card-min
    sc.setAttribute("data-csize", String(_dp.csize));
    // 角标三件套同理：弹层此时还没挂进 DOM，显式传节点写一次
    applyBadgePrefs([sc]);
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
        var pf = r && r.findPerformer;
        fillPerfDetail(h, pf);
        // 头像翻页：stash-box 头像常有多张，箭头贴在头像左右外侧
        if (pf && pf.images && pf.images.length) avatarPager = buildAvatarPager(h, pf.images);
      }).catch(function () {});

    // 场景区填充：共同出演源 = 共演场景；热门源 = 懒加载近期场景（§3.5）
    // allowList：列表模式下弹层里也是表格（用户 2026-10-28）
    if (p.src === "co" && p.items && p.items.length) {
      scBody.appendChild(sceneGrid(p.items.slice(0, 6), { allowList: true }));
      SSD.layoutCardGrid();
    } else {
      scBody.appendChild(stateBox("loading"));
      var input = { performers: { value: [p.stashId], modifier: "INCLUDES" }, sort: "DATE", direction: "DESC", per_page: 6 };
      SSD.callBoxSceneList({ endpoint: endpoint, api_key: apiKey }, input, BOX_TIMEOUT).then(function (qs) {
        if (!_dpModal) return;
        scBody.innerHTML = "";
        var scenes = (qs && qs.scenes) || [];
        if (!scenes.length) { scBody.appendChild(stateBox("empty", tc("暂无场景", "No scenes"))); return; }
        var box2 = { name: d.source.name, endpoint: endpoint, apiKey: apiKey };
        scBody.appendChild(sceneGrid(scenes.map(function (s2) { return shapeBoxItem(box2, s2); }), { allowList: true }));
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
  // 结构：头像（左下角国旗徽标）｜名称 / 别名（名称正下方）/ 性别·年龄 / 统计行。
  // 统计行（p.stat）放 info 列最后一行 = 详情区内部最下面（用户 2026-10-25 第四轮）。
  function buildPerfHead(p) {
    var head = el("div", "ssd-dp-pfhead" + (p.modal ? " ssd-dp-modal-head" : ""));
    var av = el("div", "ssd-dp-pfav");
    // 内层包住头像+国旗：外层的左右留白留给头像翻页箭头（外部演员弹窗）
    var pic = el("div", "ssd-dp-pfpic");
    var img = document.createElement("img");
    img.className = "ssd-dp-pfavatar";
    img.alt = p.name || "";
    img.src = p.image || letterAvatar(p.name);
    img.onerror = function () { this.src = letterAvatar(p.name); };
    pic.appendChild(img);
    var flag = el("span", "ssd-dp-pfflag");
    flag.style.display = "none";
    pic.appendChild(flag);
    av.appendChild(pic);
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
    // 详情区右上角外链图标已移除：外部演员弹窗由按钮区「品牌名 + ↗」承担，
    // 本地演员详情该位置改为返回按钮（用户 2026-10-27）
    return { head: head, av: av, avatar: img, flag: flag, aliasLine: aliasLine, genderLine: genderLine, statLine: statLine, info: info };
  }

  // 头像翻页（外部演员弹窗）：stash-box 的演员可有多张头像，箭头落在头像
  // 左右外侧；返回 {urls, idx}，加入库时按 idx 取「最后查看」的那张
  // （用户 2026-10-27）
  function buildAvatarPager(h, images) {
    var urls = [];
    (images || []).forEach(function (im) {
      var u = im && im.url;
      if (u && urls.indexOf(u) < 0) urls.push(u);
    });
    var state = { urls: urls, idx: 0 };
    if (!urls.length) return state;
    h.avatar.src = urls[0];
    if (urls.length < 2) return state;

    var av = h.av;
    var prev = el("button", "ssd-dp-avnav prev", "❮");
    var next = el("button", "ssd-dp-avnav next", "❯");
    prev.type = next.type = "button";
    prev.title = tc("上一张头像", "Previous avatar");
    next.title = tc("下一张头像", "Next avatar");
    prev.setAttribute("aria-label", prev.title);
    next.setAttribute("aria-label", next.title);

    // 张数徽标（右下角，样式对齐场景演员浮窗的年龄徽标）
    var count = el("span", "ssd-perf-badge ssd-dp-avcount");
    // 翻页加载条（头像下边缘内侧），图片 load/error 后隐藏
    var load = el("span", "ssd-dp-avload");
    load.appendChild(document.createElement("i"));
    function hideLoad() { load.classList.remove("on"); }
    h.avatar.addEventListener("load", hideLoad);
    h.avatar.addEventListener("error", hideLoad);

    function show(i) {
      var idx = Math.max(0, Math.min(urls.length - 1, i));
      // 真正换图才亮加载条（首图可能已是当前图）
      if (idx !== state.idx || !h.avatar.getAttribute("src")) load.classList.add("on");
      state.idx = idx;
      h.avatar.src = urls[idx];
      prev.disabled = idx === 0;
      next.disabled = idx === urls.length - 1;
      count.textContent = (idx + 1) + "/" + urls.length;
    }
    prev.addEventListener("click", function () { show(state.idx - 1); });
    next.addEventListener("click", function () { show(state.idx + 1); });
    av.appendChild(prev);
    av.appendChild(next);
    av.appendChild(count);
    av.appendChild(load);
    show(0);
    return state;
  }

  // 头像 → base64 data URL（performerCreate 的 image 只收 base64；
  // 跨域取不到时返回 null，加入库流程继续、只是不带图）
  function fetchImageDataUrl(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url, { mode: "cors", credentials: "omit" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(String(fr.result || "")); };
          fr.onerror = function () { reject(new Error("read failed")); };
          fr.readAsDataURL(blob);
        });
      })
      .catch(function (e) {
        console.warn("[SSD] avatar download skipped:", (e && e.message) || e);
        return null;
      });
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
    if (al && al.length) {
      // 与演员详情「搜索关联演员」的别名结构一致：只列 3 个，其余用 +N 徽标
      h.aliasLine.textContent = tc("别名：", "Aliases: ") + al.slice(0, 3).join(" / ");
      if (al.length > 3) {
        h.aliasLine.appendChild(document.createTextNode(" "));
        var more = document.createElement("span");
        more.className = "ssd-find-badge";
        more.textContent = "+" + (al.length - 3);
        h.aliasLine.appendChild(more);
      }
    }
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

  // 进入演员过滤视图：记录来源视图，详情页右上角返回时回到列表
  // （总览卡片 / 本地有更新 / 关注「详情」— 用户 2026-10-27）
  function openPerfFilter(grp) {
    _dp.perfGroup = grp;
    _dp.perfFrom = _dp.view || "performers";
    switchView("perfFilter");
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
    // 右上角返回：回到进入本视图前的列表（总览 / 本地有更新 / 关注）
    // — 取代原 stash-box 外链图标（用户 2026-10-27）
    var backBtn = el("button", "ssd-dp-extbtn", I.back);
    backBtn.type = "button";
    backBtn.title = tc("返回列表", "Back to list");
    backBtn.setAttribute("aria-label", tc("返回列表", "Back to list"));
    backBtn.addEventListener("click", function () { switchView(_dp.perfFrom || "performers"); });
    h.head.appendChild(backBtn);
    h.head.classList.add("has-back");
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
      window.location.assign(SSD.appUrl("/performers/" + pf.localId));
    });
    acts.appendChild(tabBtn);
    // 原「主页」按钮 → 源站演员页（品牌名 + 外链图标）；详情区右上角外链
    // 图标已改为返回按钮（用户 2026-10-27）
    var boxBtn = el("a", "ssd-dp-btn", SSD.brandNameForEndpoint(endpoint) + I.ext);
    boxBtn.href = SSD.boxWebBase(endpoint) + "/performers/" + pf.stashId;
    boxBtn.target = "_blank";
    boxBtn.rel = "noopener noreferrer";
    boxBtn.title = tc("在 stash-box 打开", "Open on stash-box");
    acts.appendChild(boxBtn);
    c.appendChild(acts);

    // 本地演员详情补全（性别/年龄/别名/国籍国旗）
    SSD.callGQL("query($id:ID!){findPerformer(id:$id){id gender birthdate country alias_list}}", { id: pf.localId }).then(function (r) {
      fillPerfDetail(h, r && r.findPerformer);
    }).catch(function () {});

    // 下半：场景卡（分组内不受 cap 限制）
    // allowList：列表模式下同样落成表格（用户 2026-10-28：原先这里固定网格）
    c.appendChild(sceneGrid(filterItems(g.items), { allowList: true }));
    SSD.layoutCardGrid();
  }

  // ── 工作室过滤视图（§8.2：与演员过滤视图同构）────────────────────────────
  function renderStudioFilter(c) {
    var g = _dp.studioGroup;
    var st = _dp.d.studios;
    if (!g || !st) { c.appendChild(stateBox("empty", tc("请从「工作室」视图进入", "Open from a studio card"))); return; }
    var endpoint = st.source.endpoint;
    var studio = g.studio || {};

    var head = el("div", "ssd-dp-pfhead has-back");
    // 1:1 小方框（用户 2026-10-27）：图片 contain 保证不裁切，横版 logo 的留白
    // 用同一张图放大模糊后铺底，观感上框是满的。图片和铺底由同一 src 驱动，
    // 加载失败时一起退回字母头像。
    var pic = el("div", "ssd-dp-studiopic");
    var img = document.createElement("img");
    img.className = "ssd-dp-pfavatar ssd-dp-pfavatar--studio";
    img.alt = studio.name || "";
    function setPic(src) {
      img.src = src;
      // 铺底走 CSS 变量：模糊层是伪元素，容器本身不能自带 background-image，
      // 否则图片 contain 区域之外会露出一份未模糊的原图
      pic.style.setProperty("--ssd-studio-bg", 'url("' + String(src).replace(/"/g, "%22") + '")');
    }
    setPic(studio.image || letterAvatar(studio.name));
    img.onerror = function () { setPic(letterAvatar(studio.name)); };
    pic.appendChild(img);
    head.appendChild(pic);
    var info = el("div", "ssd-dp-pfinfo");
    info.appendChild(el("div", "ssd-dp-pfname", studio.name || ""));
    var meta = el("div", "ssd-dp-pfmeta");
    meta.textContent = tc(g.items.length + " 部新作品 · 最新 " + (g.newest || "—") + " · 已收藏",
      g.items.length + " new · newest " + (g.newest || "—") + " · favorited");
    info.appendChild(meta);
    head.appendChild(info);
    // 右上角返回（用户 2026-10-27）：进到工作室详情后比「去 stash-box」更常用的是
    // 回列表；外链在下方 acts 里已有同名按钮，不重复。
    var back = el("button", "ssd-dp-extbtn", I.back);
    back.type = "button";
    back.title = tc("返回工作室列表", "Back to studios");
    back.setAttribute("aria-label", tc("返回工作室列表", "Back to studios"));
    back.addEventListener("click", function () { switchView("studios"); });
    head.appendChild(back);
    c.appendChild(head);

    var acts = el("div", "ssd-dp-pfactions");
    if (studio.localId) {
      var homeBtn = el("button", "ssd-dp-btn", tc("工作室主页", "Studio page"));
      homeBtn.type = "button";
      homeBtn.addEventListener("click", function () { window.location.assign(SSD.appUrl("/studios/" + studio.localId)); });
      acts.appendChild(homeBtn);
    }
    var boxBtn = el("a", "ssd-dp-btn", SSD.brandNameForEndpoint(endpoint) + I.ext);
    boxBtn.href = SSD.boxWebBase(endpoint) + "/studios/" + studio.stashId;
    boxBtn.target = "_blank";
    boxBtn.rel = "noopener noreferrer";
    acts.appendChild(boxBtn);
    c.appendChild(acts);

    c.appendChild(sceneGrid(filterItems(g.items), { allowList: true }));
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

    // 搜索（用户 2026-10-27）：关注视图原先完全不读 _dp.search，搜索框在此页无反应。
    // 命中规则：演员名命中 → 保留该分组（显示其全部场景）；否则看组内场景是否命中。
    var q = _dp.search.trim().toLowerCase();
    if (q) {
      fl = fl.filter(function (f) {
        if (String(f.name || "").toLowerCase().indexOf(q) !== -1) return true;
        var g = byStash[String(f.stashId)];
        return !!g && g.items.some(function (it) { return itemHaystack(it).indexOf(q) !== -1; });
      });
      if (!fl.length) {
        c.appendChild(stateBox("empty", tc("没有匹配的演员或场景", "No matching performers or scenes")));
        return;
      }
    }

    // 默认排序（用户 2026-10-27）：有新作品未读 → 有新作品已读 → 无新作品，
    // 同层内按名称（日文片假名/汉字混排用 ja + numeric 更稳）。
    function groupTier(g) {
      var items = notifyItems(g);
      if (!items.length) return 2;
      for (var i = 0; i < items.length; i++) {
        if (!readIs(items[i].endpoint, items[i].scene.id)) return 0;
      }
      return 1;
    }
    fl = fl.slice().sort(function (a, b) {
      var ta = groupTier(byStash[String(a.stashId)]), tb = groupTier(byStash[String(b.stashId)]);
      if (ta !== tb) return ta - tb;
      return String(a.name || "").localeCompare(String(b.name || ""), "ja", { numeric: true });
    });

    // 顶部：全部已读（§3.4）
    var allPairs = [], unreadTotal = 0;
    fl.forEach(function (f) {
      var g = byStash[String(f.stashId)];
      if (!g) return;
      notifyItems(g).forEach(function (it) {
        allPairs.push([it.endpoint, it.scene.id]);
        if (!readIs(it.endpoint, it.scene.id)) unreadTotal++;
      });
    });
    var bar = el("div", "ssd-dp-followbar");
    bar.appendChild(el("span", "ssd-dp-pcount",
      tc(fl.length + " 位关注 · " + unreadTotal + " 部未读", fl.length + " followed · " + unreadTotal + " unread")));
    // 按钮组靠右（用户 2026-10-27）：导入按钮常驻最右，「全部已读」出现时贴其左侧，
    // 不再出现"三个子元素被 space-between 顶到居中"的跳位。
    var barActs = el("div", "ssd-dp-followbar-acts");
    if (unreadTotal > 0) {
      var allBtn = el("button", "ssd-dp-btn primary", I.check + "<span>" + tc("全部已读", "Mark all read") + "</span>");
      allBtn.type = "button";
      allBtn.addEventListener("click", function () {
        readMarkAll(allPairs);
        emitUnread();
        render();
      });
      barActs.appendChild(allBtn);
    }
    barActs.appendChild(makeImportButton()); // §6.2 增量导入（已关注的自动跳过）
    bar.appendChild(barActs);
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
      if (g) notifyItems(g).forEach(function (it) { if (!readIs(it.endpoint, it.scene.id)) unread++; });
      var sub = el("div", "ssd-dp-mini-sub");
      var prevOnly = !!(g && g.items.length && !notifyItems(g).length);
      sub.textContent = !g ? tc("回看期内暂无新作品", "No new releases in the lookback window")
        : prevOnly ? tc(g.items.length + " 部预告（不提醒）", g.items.length + " preview only (muted)")
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
      // 展开箭头：SVG chevron（字符 ▸ 在 13px 下笔画太细，各平台渲染还不一致），
      // 收起朝右 / 展开朝下，靠旋转过渡
      if (g) {
        var caret = el("button", "ssd-dp-fgrp-caret" + (isOpen ? " open" : ""), "");
        caret.type = "button";
        caret.title = tc("展开 / 收起", "Expand / collapse");
        caret.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
          'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M4 6l4 4 4-4"/></svg>';
        caret.addEventListener("click", function (e) {
          e.stopPropagation();
          toggleRow();
        });
        rightBox.appendChild(caret);
      }
      // 详情 = 主色 tonal（半实心）：比 ghost 明显，又不像 primary 那样一屏变成色带
      var goBtn = el("button", "ssd-dp-btn tonal", tc("详情", "Details"));
      goBtn.type = "button";
      goBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (g) openPerfFilter(g);
        else if (f.localId) window.location.assign(SSD.appUrl("/performers/" + f.localId));
      });
      rightBox.appendChild(goBtn);
      // 取关 = 红色 tonal + 爱心斜杠图标（原来的 ♥ 看着像"收藏"，加文字又让英文
      // 版按钮过宽；改成图标后中英两版宽度一致 — 用户 2026-10-27）
      var unfBtn = el("button", "ssd-dp-btn tonal danger icon-only", I.heartOff);
      unfBtn.type = "button";
      unfBtn.title = tc("取消关注", "Unfollow");
      unfBtn.setAttribute("aria-label", unfBtn.title);
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
        // 搜索时组内也过滤；未搜索时照常显示全部（含预告 — 用户 2026-10-27）
        body.appendChild(sceneGrid(q ? filterItems(g.items) : g.items, { unread: true, allowList: true }));
        grp.appendChild(body);
      }
      c.appendChild(grp);
    });
    SSD.layoutCardGrid();
  }

  // ── 设置视图（§3.7：全部即时生效，localStorage 持久化）────────────────────
  // 右侧滑块开关（用户 2026-10-26：勾选框不好看）
  function switchToggle(checked, onChange, ariaLabel) {
    var lab = el("label", "ssd-dp-switch");
    var inp = document.createElement("input");
    inp.type = "checkbox";
    inp.checked = !!checked;
    if (ariaLabel) inp.setAttribute("aria-label", ariaLabel);
    inp.addEventListener("change", function () { onChange(inp.checked); });
    lab.appendChild(inp);
    lab.appendChild(el("span", "ssd-dp-switch-track"));
    return lab;
  }

  // 设置写入失败时的就地提示（配额满 → 改动刷新即丢）
  function settingsWarn(wrap, text) {
    if (!wrap) return;
    var old = wrap.querySelector(".ssd-dp-setwarn");
    if (old) old.remove();
    var box = document.createElement("div");
    box.className = "ssd-dp-setwarn";
    box.textContent = text;
    wrap.insertBefore(box, wrap.firstChild);
  }

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
      // value 用 endpoint：box 的 name 由用户填写、可以重复（Stash 新增
      // stash-box 时默认名就是 "StashDB"），同名时 select 会恒定命中第一项，
      // 表现就是「选了 TPDB 之后切不回 StashDB」（论坛反馈）
      op.value = b.endpoint;
      op.textContent = SSD.brandNameForEndpoint(b.endpoint, b.name);
      srcSel.appendChild(op);
    });
    var dNow = _dp.d.latest;
    // 回显：数据就绪用实际源；未就绪（切换后重载中/失败）回显持久化选择，
    // 避免误导性地跳回下拉第一项
    if (dNow && dNow.source) srcSel.value = dNow.source.endpoint || dNow.source.name || "";
    else if (prefs.source) {
      // 旧版存的是 box name，这里顺带解析成 endpoint 完成迁移
      var chosen = resolveSource(_dp.boxes || [], null);
      srcSel.value = (chosen && chosen.endpoint) || prefs.source;
    }
    srcSel.addEventListener("change", function () {
      if (!dpSetPrefs({ source: srcSel.value })) {
        settingsWarn(wrap, tc(
          "保存失败：浏览器本地存储已满。请先在设置里「重置」清出空间，改完的选择一刷新就会丢。",
          "Could not save: browser storage is full. Reset the settings to free space — changes will be lost on refresh."));
      }
      _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0; _dp.page = 1;
      // 角标按当前数据源统计（单源口径），切源后立即重算一次
      if (SSD.pollFollowed) SSD.pollFollowed(true);
      ensureData(viewDataKeys(_dp.view));
      render();
    });
    rowS.appendChild(srcSel);
    secG.appendChild(rowS);

    // 回看窗口（发现页口径；用户 2026-10-26：总览短窗、演员 tab 长窗）
    var rowW = el("div", "ssd-dp-setrow");
    rowW.appendChild(el("span", "ssd-dp-setname", tc("回看窗口（天）", "Lookback window (days)")));
    var inpW = document.createElement("input");
    inpW.type = "number";
    inpW.min = "0"; inpW.max = "3650"; inpW.step = "1";
    inpW.className = "ssd-dp-setsel num";
    inpW.value = String(dpRecentDays());
    inpW.addEventListener("change", function () {
      var v = parseInt(inpW.value, 10);
      if (isNaN(v) || v < 0) v = DP_LOOKBACK_DEFAULT;
      if (v > 3650) v = 3650;
      inpW.value = String(v);
      dpSetPrefs({ recentDays: v });
      _dp.d = {}; _dp.err = {}; _dp.fetchedAt = 0; _dp.page = 1;
      if (SSD.pollFollowed) SSD.pollFollowed(true);
      ensureData(viewDataKeys(_dp.view));
      render();
    });
    rowW.appendChild(inpW);
    secG.appendChild(rowW);
    secG.appendChild(el("div", "ssd-dp-sethint", tc(
      "0 = 不限。仅作用于发现页；演员详情「发现」标签的窗口在插件设置的 Recent Window 中调整。",
      "0 = unlimited. Applies to the Discover page only; the performer-page Discover tab uses Recent Window in the plugin settings.")));
    // TPDB 走批量查询，整体最多 TPDB_MAX_PAGES_BATCH 页（用户 2026-10-26）
    if (dpRecentDays() === 0 && sourceIsTPDB()) {
      var tpdbPages = SSD.TPDB_MAX_PAGES_BATCH || 5;
      secG.appendChild(el("div", "ssd-dp-sethint", tc(
        "当前源一次性批量取片：最多回溯 " + tpdbPages * 100 + " 部（" + tpdbPages + " 页），并非全部历史。",
        "This source fetches in one batch: at most " + tpdbPages * 100 + " scenes (" + tpdbPages + " pages), not full history.")));
    }

    // 通知开关（独立 key SSD:dp:notify，主 JS 轮询与导航角标读取；§6.4）
    // 右侧滑块（用户 2026-10-26：勾选框不好看）
    var notifyLabel = tc("关注的演员新发布提醒（导航角标）", "New-release alerts for followed performers (nav badge)");
    var rowN = el("div", "ssd-dp-setrow");
    rowN.appendChild(el("span", "ssd-dp-setname", notifyLabel));
    var notifyOn = true;
    try { notifyOn = localStorage.getItem("SSD:dp:notify") !== "0"; } catch (_) {}
    var swN = switchToggle(notifyOn, function (on) {
      try { localStorage.setItem("SSD:dp:notify", on ? "1" : "0"); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent("ssd:notify-changed")); } catch (_) {}
    }, notifyLabel);
    rowN.appendChild(swN);
    secG.appendChild(rowN);

    // 预告是否参与提醒（用户 2026-10-27 语义反转，默认关闭）：关闭时预告场景
    // 不计未读、不进角标、不标红框、不在「有新发布的演员」里单独占位；点开演员
    // 仍照常显示。与上面的强提醒总闸是两个独立维度，互不覆盖。
    var prevLabel = tc("预告（未上映）也计入提醒", "Count preview (upcoming) releases too");
    var rowP = el("div", "ssd-dp-setrow");
    rowP.appendChild(el("span", "ssd-dp-setname", prevLabel));
    rowP.appendChild(switchToggle(notifyPreviewScenes(), function (on) {
      dpSetPrefs({ notifyPreviewScenes: !!on });
      emitUnread();
      if (SSD.pollFollowed) SSD.pollFollowed(true); // 角标立即按新口径重算
      render();
    }, prevLabel));
    secG.appendChild(rowP);
    secG.appendChild(el("div", "ssd-dp-sethint", tc(
      "只决定预告场景算不算进统计：关闭时未读、红框、总览计数、导航角标都不含预告；点开演员仍照常显示。",
      "Controls whether upcoming scenes count toward unread marks, red borders, overview totals and the nav badge. Opening a performer always shows them.")));

    // 从收藏导入（§6.2；P5 工厂复用）
    var rowI = el("div", "ssd-dp-setrow");
    rowI.appendChild(makeImportButton());
    secG.appendChild(rowI);
    wrap.appendChild(secG);

    // ── 场景卡角标（用户 2026-10-28）─────────────────────────────────────
    // 三项都只切 CSS 属性，改完立即生效，不必重建卡片（重建会打断弹层与滚动位置）
    wrap.appendChild(el("h3", "ssd-dp-set-h", tc("场景卡角标", "Scene card badges")));
    var secB = el("div", "ssd-dp-set-box");

    // 工作室名（原生 .studio-overlay）：隐藏 / 右上（默认）/ 左上
    // 「左上」与「默认角标位置 = 左上」互斥 —— 左上角只放一组，选了这边另一组
    // 自动让位（见下方 setStudio / setPos 的联动）
    var rowB1 = el("div", "ssd-dp-setrow");
    rowB1.appendChild(el("span", "ssd-dp-setname", tc("显示工作室角标", "Show studio badge")));
    var selStudio = document.createElement("select");
    selStudio.className = "ssd-dp-setsel";
    [["none", tc("隐藏", "Hidden")], ["tr", tc("右上", "Top right")], ["tl", tc("左上", "Top left")]]
      .forEach(function (o) {
        var op = document.createElement("option");
        op.value = o[0];
        op.textContent = o[1];
        selStudio.appendChild(op);
      });
    selStudio.value = dpStudioBadge();
    var setStudio = function (v) {
      dpSetPrefs({ studioBadge: v });
      // 工作室占住左上 → 自定义角标让到左下
      if (v === "tl") dpSetPrefs({ badgePos: "bl" });
      syncBadgeSelects();
      applyBadgePrefs();
    };
    selStudio.addEventListener("change", function () { setStudio(selStudio.value); });
    rowB1.appendChild(selStudio);
    secB.appendChild(rowB1);

    // 右下角时长（原生 .scene-specs-overlay）：文字 = 现在的白字 + 阴影
    var durLabel = tc("显示时长角标", "Show duration badge");
    var rowB2 = el("div", "ssd-dp-setrow");
    rowB2.appendChild(el("span", "ssd-dp-setname", durLabel));
    var selDur = document.createElement("select");
    selDur.className = "ssd-dp-setsel";
    [["none", tc("隐藏", "Hidden")], ["text", tc("文字", "Text")], ["badge", tc("徽章", "Pill")]]
      .forEach(function (o) {
        var op = document.createElement("option");
        op.value = o[0];
        op.textContent = o[1];
        selDur.appendChild(op);
      });
    selDur.value = dpDurBadge();
    selDur.addEventListener("change", function () {
      dpSetPrefs({ durBadge: selDur.value });
      applyBadgePrefs();
    });
    rowB2.appendChild(selDur);
    secB.appendChild(rowB2);

    // 自定义角标（预告 / 距上映天数 / 库内演员）贴哪一侧
    var posLabel = tc("默认角标位置", "Default badge position");
    var rowB3 = el("div", "ssd-dp-setrow");
    rowB3.appendChild(el("span", "ssd-dp-setname", posLabel));
    var selPos = document.createElement("select");
    selPos.className = "ssd-dp-setsel";
    [["tl", tc("左上", "Top left")], ["bl", tc("左下", "Bottom left")]]
      .forEach(function (o) {
        var op = document.createElement("option");
        op.value = o[0];
        op.textContent = o[1];
        selPos.appendChild(op);
      });
    selPos.value = dpBadgePos();
    selPos.addEventListener("change", function () {
      dpSetPrefs({ badgePos: selPos.value });
      // 自定义角标要占左上 → 工作室角标（若也在左上）让到右上
      if (selPos.value === "tl" && dpStudioBadge() === "tl") dpSetPrefs({ studioBadge: "tr" });
      syncBadgeSelects();
      applyBadgePrefs();
    });
    rowB3.appendChild(selPos);
    secB.appendChild(rowB3);
    // 联动会改到另一个下拉的值，这里把两个 select 拉回实际偏好（静默，不提示）
    function syncBadgeSelects() {
      selStudio.value = dpStudioBadge();
      selPos.value = dpBadgePos();
    }

    secB.appendChild(el("div", "ssd-dp-sethint", tc(
      "只作用于发现页与演员弹层里的场景卡；演员详情「发现」标签保持原样。",
      "Applies to scene cards on the Discover page and in performer dialogs only; the performer-page Discover tab is unchanged.")));
    wrap.appendChild(secB);

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
    // 并排开关（用户 2026-10-26）：默认开启，仅影响总览里热门+即将发布相邻时
    // 右侧滑块（用户 2026-10-26：勾选框不好看）
    var mergeLabel = tc("热门与即将发布并排一行", "Trending and Upcoming side by side");
    var rowJ = el("div", "ssd-dp-setrow");
    rowJ.appendChild(el("span", "ssd-dp-setname", mergeLabel));
    var swJ = switchToggle(mergeTrendPreview(), function (on) {
      var patch = { mergeTrendPreview: on };
      if (on) {
        // 合并后共享排序与行数：两者相邻，行数对齐到热门（用户 2026-10-26）
        patch.order = pairAdjacentOrder("trending", "preview");
        var rw = dpPrefs().rows || {};
        rw.trending = curRows.trending;
        rw.preview = curRows.trending;
        patch.rows = rw;
      }
      dpSetPrefs(patch);
      render();
    }, mergeLabel);
    rowJ.appendChild(swJ);
    secM.appendChild(rowJ);
    var merged = mergeTrendPreview();
    MODULE_DEFS.forEach(function (m) {
      // 合并开启时「即将发布」并入「热门」一行，共享开关/行数/排序
      if (merged && m.id === "preview") return;
      var isPair = merged && m.id === "trending";
      var row = el("div", "ssd-dp-setrow");
      var lab = el("label", "ssd-dp-settoggle");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = isPair
        ? (moduleShown("trending") && moduleShown("preview"))
        : moduleShown(m.id);
      cb.addEventListener("change", function () {
        var mods = dpPrefs().modules || {};
        if (isPair) {
          mods.trending = cb.checked;
          mods.preview = cb.checked;
        } else {
          mods[m.id] = cb.checked;
        }
        dpSetPrefs({ modules: mods });
        render();
      });
      lab.appendChild(cb);
      lab.appendChild(el("span", null, isPair
        ? (trendingOnTPDB()
          ? tc(trendingTitle() + "与即将发布", "New on site & Upcoming")
          : tc("热门与即将发布", "Trending & Upcoming"))
        : (m.id === "trending" ? trendingTitle() : tc(m.zh, m.en))));
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
      rs.value = String(isPair ? curRows.trending : (curRows[m.id] || 1));
      rs.addEventListener("change", function () {
        var rw = dpPrefs().rows || {};
        var n = parseInt(rs.value, 10);
        if (isPair) {
          rw.trending = n;
          rw.preview = n;
        } else {
          rw[m.id] = n;
        }
        dpSetPrefs({ rows: rw });
        render();
      });
      ctl.appendChild(rs);

      var up = el("button", "ssd-dp-btn ghost sm", "↑");
      var dn = el("button", "ssd-dp-btn ghost sm", "↓");
      up.type = "button"; dn.type = "button";
      up.title = tc("上移", "Move up"); dn.title = tc("下移", "Move down");
      if (isPair) {
        var lo = Math.min(order.indexOf("trending"), order.indexOf("preview"));
        var hi = Math.max(order.indexOf("trending"), order.indexOf("preview"));
        up.disabled = lo <= 0;
        dn.disabled = hi < 0 || hi >= order.length - 1;
        up.addEventListener("click", function () { moveModulePair("trending", "preview", -1); });
        dn.addEventListener("click", function () { moveModulePair("trending", "preview", 1); });
      } else {
        var idx = order.indexOf(m.id);
        up.disabled = idx <= 0;
        dn.disabled = idx < 0 || idx >= order.length - 1;
        up.addEventListener("click", function () { moveModule(m.id, -1); });
        dn.addEventListener("click", function () { moveModule(m.id, 1); });
      }
      ctl.appendChild(up);
      ctl.appendChild(dn);
      row.appendChild(ctl);
      secM.appendChild(row);
    });
    wrap.appendChild(secM);

    // 恢复默认（清 prefs：order/modules/rows/source/perPage/sort/mode 全回默认；
    // notify 是独立 key，保留用户选择）
    var reset = el("button", "ssd-dp-btn ghost sm ssd-dp-reset", tc("恢复默认布局", "Reset to defaults"));
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
  var _unreadDataRef = null; // 触发过一次未读重算的数据引用（防重复刷事件）

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

    // URL ?view=xxx 只认首次（导航角标→关注视图）；后续变化交给 init 的巡检
    try {
      var m0 = /[?&]view=([a-z]+)/i.exec(String(window.location.search || ""));
      var v0 = m0 && String(m0[1]).toLowerCase();
      if (v0 && (v0 === "settings" || VIEWS.some(function (x) { return x.id === v0; }))) _dp.view = v0;
      _locSearchSeen = String(window.location.search || "");
    } catch (_) {}

    // 初始状态：持久化偏好回填（先于工具栏构建，保证 select 初值正确）
    var prefs = dpPrefs();
    if (prefs.sort) _dp.sort = prefs.sort;
    if (prefs.mode === "list" || prefs.mode === "grid") _dp.mode = prefs.mode;
    var cs = toNum(prefs.csize, 1);
    _dp.csize = cs >= 0 && cs <= 2 ? cs : 1;
    refs.page = root;

    // ── 页头行（§3.1.1）：标题 + meta chips + 刷新 + 相对时间 ──
    var head = el("div", "ssd-dp-head");
    var title = el("h2", "ssd-dp-title",
      '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M192 32c0-17.7 14.3-32 32-32C383.1 0 512 128.9 512 288c0 17.7-14.3 32-32 32s-32-14.3-32-32C448 164.3 347.7 64 224 64c-17.7 0-32-14.3-32-32zM60.6 220.6L164.7 324.7l28.4-28.4c-.7-2.6-1.1-5.4-1.1-8.3c0-17.7 14.3-32 32-32s32 14.3 32 32s-14.3 32-32 32c-2.9 0-5.6-.4-8.3-1.1l-28.4 28.4L291.4 451.4c14.5 14.5 11.8 38.8-7.3 46.3C260.5 506.9 234.9 512 208 512C93.1 512 0 418.9 0 304c0-26.9 5.1-52.5 14.4-76.1c7.5-19 31.8-21.8 46.3-7.3zM224 96c106 0 192 86 192 192c0 17.7-14.3 32-32 32s-32-14.3-32-32c0-70.7-57.3-128-128-128c-17.7 0-32-14.3-32-32s14.3-32 32-32z"/></svg>' +
      "<span>" + tc("发现", "Discover") + "</span>");
    refs.title = title;
    head.appendChild(title);
    refs.chips = el("span", "ssd-dp-chips");
    head.appendChild(refs.chips);
    // 顺序：状态文字在前、刷新按钮在后。刷新按钮固定贴最右，状态文字靠
    // margin-left:auto 吸在按钮左侧 —— 文字从「刚刚更新」变成「12 分钟前」
    // 只向左生长，按钮不会被推着跑（用户 2026-10-27）
    refs.updated = el("span", "ssd-dp-updated");
    head.appendChild(refs.updated);
    refs.refresh = el("button", "ssd-dp-refresh",
      I.refresh + "<span>" + tc("刷新", "Refresh") + "</span>");
    refs.refresh.type = "button";
    refs.refresh.setAttribute("aria-label", tc("刷新发现页", "Refresh discover page"));
    refs.refresh.addEventListener("click", doRefresh);
    head.appendChild(refs.refresh);
    root.appendChild(head);

    // 窄屏（≤480）：隐藏刷新按钮，「logo + 发现 + 状态文字」整块可点刷新；
    // 右侧空白不绑定点击（既不误触，也保住 ← 的指向意义 — 用户 2026-10-27）
    function narrowRefresh() {
      if (window.innerWidth > 480) return;
      doRefresh();
    }
    title.addEventListener("click", narrowRefresh);
    refs.updated.addEventListener("click", narrowRefresh);
    title.addEventListener("keydown", function (e) {
      if (window.innerWidth > 480) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); doRefresh(); }
    });
    var mqNarrow = window.matchMedia ? window.matchMedia("(max-width: 480px)") : null;
    function syncHeadA11y() {
      if (!mqNarrow || mqNarrow.matches) {
        title.setAttribute("role", "button");
        title.setAttribute("tabindex", "0");
        title.setAttribute("aria-label", tc("刷新发现页", "Refresh discover page"));
      } else {
        title.removeAttribute("role");
        title.removeAttribute("tabindex");
        title.removeAttribute("aria-label");
      }
    }
    syncHeadA11y();
    if (mqNarrow && mqNarrow.addEventListener) mqNarrow.addEventListener("change", syncHeadA11y);

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
    // 布局见 stashDiscover.css：单行优先（nowrap，搜索框先缩），真放不下时由
    // syncToolbar 打 .is-collapsed，收成「搜索框 + 更多按钮」（用户 2026-10-28）
    var bar = el("div", "ssd-dp-toolbar");
    refs.bar = bar;
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
    refs.tools = tools;
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

    // ── 场景卡档位滑块（用户 2026-10-28）：位于筛选行最右，只控制场景卡；
    //    演员迷你卡是另一套网格（.ssd-dp-grid.mini），不读这个变量 ──
    refs.csizeWrap = el("div", "ssd-dp-csize");
    refs.csize = document.createElement("input");
    refs.csize.type = "range";
    refs.csize.min = "0";
    refs.csize.max = "2";
    refs.csize.step = "1";
    refs.csize.className = "ssd-dp-range";
    refs.csize.value = String(_dp.csize);
    refs.csize.title = tc("场景卡大小", "Scene card size");
    refs.csize.setAttribute("aria-label", tc("场景卡大小", "Scene card size"));
    refs.csize.addEventListener("input", function () {
      // 拖动中只改 CSS 变量：auto-fill 自行调列数，零重排、即时可见
      _dp.csize = toNum(this.value, 1);
      applyCardSize();
    });
    refs.csize.addEventListener("change", function () {
      // 模块卡片数是按「首行列数 × 行数」裁剪的（trimRows），列数变了不重渲染
      // 会有模块只剩半行；松手后补一次（用户 2026-10-28）
      dpSetPrefs({ csize: _dp.csize });
      clearTimeout(_csizeT);
      _csizeT = setTimeout(function () { render(); }, 180);
    });
    refs.csizeWrap.appendChild(refs.csize);
    tools.appendChild(refs.csizeWrap);

    bar.appendChild(tools);

    // 「更多筛选」按钮：仅在 .is-collapsed 下显示（点开/收起的逻辑见下方
    // syncToolbar / setToolsOpen）。放在 tools 之后，展开时 tools 用 order:3
    // 落回第二行，DOM 顺序与视觉顺序一致，键盘 Tab 不会跳序。
    refs.more = el("button", "ssd-dp-more", I.filter);
    refs.more.type = "button";
    refs.more.title = tc("更多筛选", "More filters");
    refs.more.setAttribute("aria-label", tc("更多筛选", "More filters"));
    refs.more.setAttribute("aria-expanded", "false");
    refs.more.addEventListener("click", function () {
      setToolsOpen(!bar.classList.contains("is-open"));
    });
    bar.appendChild(refs.more);

    root.appendChild(bar);
    bindToolbarDismiss();
    syncSourceSelect();
    applyCardSize();
    applyBadgePrefs();
    syncToolbar();

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
        // 先定筛选行状态（可能改变工具栏高度），再按新布局重排模块
        syncToolbar();
        if (_dp.refs.content && _dp.refs.content.isConnected && _dp.view === "overview") render();
      }, 200);
    });
  }

  // 导航角标跳转带 ?view=follow（stashDiscover.js NavLink to），但原先从不解析
  // → 有角标时也落在总览（用户 2026-10-27 修）。React Router 改 search 不重挂载
  // 本页，故除首次挂载外，再靠 location 巡检兜住"已在页内点击导航"的情况。
  var _locSearchSeen = null;
  function syncViewFromLocation() {
    var s = "";
    try { s = String(window.location.search || ""); } catch (_) { return; }
    if (s === _locSearchSeen) return;
    _locSearchSeen = s;
    var m = /[?&]view=([a-z]+)/i.exec(s);
    var v = m && String(m[1]).toLowerCase();
    if (!v) return;
    var ok = v === "settings" || VIEWS.some(function (x) { return x.id === v; });
    if (!ok || _dp.view === v) return;
    _dp.view = v;
    _dp.page = 1;
    ensureData(viewDataKeys(v));
    render();
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
    // 窄屏标题整块可点：2 秒内重复点击忽略（用户 2026-10-27）
    var now = Date.now();
    if (now - (_dp.lastRefreshAt || 0) < 2000) return;
    _dp.lastRefreshAt = now;
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
  // 场景卡档位：滑块只切 .ssd-dp-page 的 data-csize，列宽由 CSS 变量
  // --ssd-card-min 接管（160/210/300；≤480 重映射 100/155/265）。
  var _csizeT = 0;
  // 有场景网格（sceneGrid → .ssd-card-grid）的视图；演员迷你卡视图（performers）
  // 与设置页不显示滑块。perfFilter / studioFilter 里也是 sceneGrid。
  var SCENE_GRID_VIEWS = {
    overview: 1, follow: 1, latest: 1, trending: 1, preview: 1, studios: 1,
    perfFilter: 1, studioFilter: 1
  };
  function applyCardSize() {
    var p = _dp.refs.page;
    if (p) p.setAttribute("data-csize", String(_dp.csize));
    // 演员弹层挂在 document.body 上（不在 .ssd-dp-page 作用域内），拿不到页面
    // 上的档位变量，要单独写一份；弹层开着时若档位变化也同步一次（用户 2026-10-28）
    var modalScenes = document.querySelectorAll(".ssd-dp-modal-scenes");
    for (var i = 0; i < modalScenes.length; i++) {
      modalScenes[i].setAttribute("data-csize", String(_dp.csize));
    }
  }

  // ── 场景卡角标（用户 2026-10-28）─────────────────────────────────────────
  // 三项都是纯 CSS 开关：只切 .ssd-dp-page / 弹层上的 data-* 属性，不重建卡片
  // （重建会打断弹层、丢滚动位置）。作用范围仅限发现页与演员弹层，演员详情
  // 「发现」tab 不经过这些选择器，保持原样。
  // "tr" 右上（默认）/ "tl" 左上 / "none" 隐藏。布尔值是上一版未发版实现的残留，
  // 顺手归一以免旧 localStorage 让下拉落到空值。
  function dpStudioBadge() {
    var v = dpPrefs().studioBadge;
    if (v === "tl") return "tl";
    if (v === "none" || v === 0 || v === false) return "none";
    return "tr";
  }
  function dpDurBadge() {
    var v = dpPrefs().durBadge;
    return (v === "none" || v === "badge") ? v : "text"; // 文字为默认
  }
  function dpBadgePos() { return dpPrefs().badgePos === "bl" ? "bl" : "tl"; }
  // nodes 省略 = 页面 + 当前所有弹层；传入 = 只写指定的（弹层刚创建、还没入 DOM 时用）
  function applyBadgePrefs(nodes) {
    var list = nodes || [];
    if (!nodes) {
      if (_dp.refs.page) list.push(_dp.refs.page);
      var ms = document.querySelectorAll(".ssd-dp-modal-scenes");
      for (var i = 0; i < ms.length; i++) list.push(ms[i]);
    }
    for (var k = 0; k < list.length; k++) {
      list[k].setAttribute("data-studio-badge", dpStudioBadge());
      list[k].setAttribute("data-dur-badge", dpDurBadge());
      list[k].setAttribute("data-badge-pos", dpBadgePos());
    }
  }

  // ── 筛选行收起 / 展开（用户 2026-10-28）───────────────────────────────
  // 判定不用媒体查询：控件组宽度随「数据源下拉」是否出现（多源才显示）变化，
  // 写死断点会让单源用户提前收起。改用量实际内容宽：
  //   单行需要 = 搜索框最小宽(180) + gap + 控件组自然宽
  // 收起的 tools 是 display:none，量不到宽，故临时改成 absolute + max-content
  // 量一次再还原——读写都在同一个 task 内完成，浏览器不会绘制中间态。
  var TB_SEARCH_MIN = 180;
  function toolsNaturalWidth() {
    var t = _dp.refs.tools;
    if (!t) return 0;
    var s = t.style;
    var old = [s.display, s.position, s.width, s.visibility, s.pointerEvents];
    s.display = "flex";
    s.position = "absolute";
    s.width = "max-content";
    s.visibility = "hidden";
    s.pointerEvents = "none";
    var w = t.getBoundingClientRect().width;
    s.display = old[0];
    s.position = old[1];
    s.width = old[2];
    s.visibility = old[3];
    s.pointerEvents = old[4];
    return w;
  }
  function setToolsOpen(on) {
    var bar = _dp.refs.bar;
    if (!bar) return;
    bar.classList.toggle("is-open", !!on);
    if (_dp.refs.more) _dp.refs.more.setAttribute("aria-expanded", on ? "true" : "false");
  }
  function syncToolbar() {
    var bar = _dp.refs.bar, t = _dp.refs.tools;
    if (!bar || !t || !bar.isConnected) return;
    // 还没进布局（宽 0）时别判定：会把可用宽算成负数、误收起
    if (bar.clientWidth < 1) return;
    var cs = getComputedStyle(bar);
    var padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var gap = parseFloat(cs.columnGap);
    if (isNaN(gap)) gap = 0;
    var avail = bar.clientWidth - padX;
    var need = TB_SEARCH_MIN + gap + toolsNaturalWidth();
    var collapse = need > avail + 0.5;
    if (collapse === bar.classList.contains("is-collapsed")) {
      // 展开态只在收起态下有意义：万一状态残留（宽度刚变过），这里兜一下
      if (!collapse) setToolsOpen(false);
      return;
    }
    bar.classList.toggle("is-collapsed", collapse);
    // 变宽到能放下了：顺手把面板收回，避免「已经全在行内了还挂着一个空面板」
    if (!collapse) setToolsOpen(false);
  }
  // 点筛选区以外任意位置收回（用户 2026-10-28）。document 上只绑一次，
  // 监听里按 isConnected 取当前 bar —— 页面重挂载后不会累积监听。
  var _tbDismissBound = false;
  function bindToolbarDismiss() {
    if (_tbDismissBound) return;
    _tbDismissBound = true;
    document.addEventListener("pointerdown", function (e) {
      var bar = _dp.refs.bar;
      if (!bar || !bar.isConnected || !bar.classList.contains("is-open")) return;
      if (bar.contains(e.target)) return;
      setToolsOpen(false);
    }, true);
    document.addEventListener("keydown", function (e) {
      var bar = _dp.refs.bar;
      if (e.key !== "Escape" || !bar || !bar.isConnected) return;
      if (!bar.classList.contains("is-open")) return;
      setToolsOpen(false);
    });
  }

  function render() {
    var refs = _dp.refs;
    if (!refs.content) return;
    syncChrome();
    renderContent();
  }

  // follow tab 红点：原实现只在「有事件到达」时挂/摘，页面重建 tabs 或事件
  // 早于挂载时状态就丢了（用户 2026-10-27 修）。改为渲染态驱动，事件只更新数字。
  function syncTabDot() {
    var tabs = _dp.refs.tabs;
    if (!tabs) return;
    var tab = tabs.querySelector('.ssd-dp-tab[data-view="follow"]');
    if (!tab) return;
    var dot = tab.querySelector(".ssd-dp-tab-dot");
    if (_unread > 0) {
      if (!dot) {
        dot = document.createElement("i");
        dot.className = "ssd-dp-tab-dot";
        tab.appendChild(dot);
      }
      dot.title = tc(_unread + " 部未读", _unread + " unread");
    } else if (dot) {
      dot.remove();
    }
  }

  function syncChrome() {
    var refs = _dp.refs, d = _dp.d.latest;
    // 数据换了一批 → 主动按当前关注口径重算一次未读，避免"页内显示 5 部未读、
    // tab 红点却是 0"（红点原仅由事件驱动，页面刚加载时没有事件 — 用户 2026-10-27）
    if (d && d !== _unreadDataRef) {
      _unreadDataRef = d;
      setTimeout(emitUnread, 0);
    }
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
    // 窄屏刷新反馈：状态文字变「更新中…」+ 标题图标旋转（用户 2026-10-27）
    if (refs.updated) {
      refs.updated.textContent = _dp.refreshing ? tc("更新中…", "Updating…") : relTime(_dp.fetchedAt);
      refs.updated.setAttribute("aria-busy", _dp.refreshing ? "true" : "false");
    }
    if (refs.title) {
      var tsvg = refs.title.querySelector("svg");
      if (tsvg) tsvg.classList.toggle("spinning", !!_dp.refreshing);
    }
    if (refs.refresh) {
      refs.refresh.disabled = _dp.refreshing;
      var svg = refs.refresh.querySelector("svg");
      if (svg) svg.classList.toggle("spinning", _dp.refreshing);
    }
    if (refs.tabs) {
      refs.tabs.querySelectorAll(".ssd-dp-tab").forEach(function (t) {
        t.classList.toggle("on", t.dataset.view === _dp.view);
      });
      // TPDB 下「热门」实为全站最新（A 方案）：tab 文案随当前源同步
      var tb = refs.tabs.querySelector('[data-view="trending"] span');
      if (tb) tb.textContent = trendingTitle();
      syncTabDot();
    }
    if (refs.gridBtn && refs.listBtn) {
      refs.gridBtn.classList.toggle("on", _dp.mode !== "list");
      refs.listBtn.classList.toggle("on", _dp.mode === "list");
    }
    // 档位滑块只对「有场景网格 + 网格模式」的视图可见（列表模式无卡片可缩放）
    if (refs.csizeWrap) {
      var showSize = _dp.mode !== "list" && !!SCENE_GRID_VIEWS[_dp.view];
      refs.csizeWrap.style.display = showSize ? "" : "none";
    }
    // 控件组的显隐（滑块/数据源）会改宽度 → 重新判定筛选行要不要收起
    syncToolbar();
  }

  function renderContent() {
    var c = _dp.refs.content;
    if (!c) return;
    c.innerHTML = "";
    ensureData(viewDataKeys(_dp.view));
    // 没配 stash-box 是全局状态：原先 6 个模块各挂一条「未配置」+ 重试，一屏
    // 重复 6 遍且没有去处提示。这里收敛成一条带「打开设置」的提示（用户 2026-10-28）。
    // 有旧数据时不挡（缓存还能看），仍走各模块内的行内提示。
    if (_dp.view !== "settings" && !_dp.d.latest &&
        _dp.err.latest && _dp.err.latest.ssdKind === "no-box") {
      var nb = el("div", "ssd-dp-state");
      nb.innerHTML = errText(_dp.err.latest);
      var nbActs = el("div", "ssd-dp-state-acts");
      var nbRetry = el("button", "ssd-dp-retry", tc("重试", "Retry"));
      nbRetry.type = "button";
      nbRetry.addEventListener("click", function () {
        _dp.err.latest = null;
        ensureData(viewDataKeys(_dp.view), true);
      });
      nbActs.appendChild(nbRetry);
      var nbSet = el("button", "ssd-dp-retry ghost", tc("打开设置", "Open settings"));
      nbSet.type = "button";
      nbSet.addEventListener("click", function () {
        window.open(SSD.appUrl("/settings"), "_blank", "noopener,noreferrer");
      });
      nbActs.appendChild(nbSet);
      nb.appendChild(nbActs);
      c.appendChild(nb);
      return;
    }
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
    migratePreviewPref(); // 旧「预告不提醒」开关 → 新「预告也计入提醒」（用户 2026-10-27）
    THEME.start();
    // follow tab 红点跟随导航角标同一事件流（§10；P5 轮询驱动）
    // 初值先取主 JS 写入的 unread.v1（硬刷新后事件可能早于本页挂载）
    try {
      var u0 = JSON.parse(localStorage.getItem("SSD:dp:unread.v1") || "null");
      if (u0 && typeof u0.n === "number") _unread = u0.n;
    } catch (_) {}
    window.addEventListener("ssd:unread-changed", function (e) {
      _unread = (e && e.detail) || 0;
      syncTabDot();
    });
    // 每秒巡检一次 location.search：导航角标带 ?view=follow 进入时切到关注视图
    setInterval(syncViewFromLocation, 1000);
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
