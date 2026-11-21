/**
 * SceneBackfill frontend.
 *
 * Registers /plugins/SceneBackfill and a nav entry. Everything goes through
 * runPluginOperation: the backend prints one JSON line, Stash returns it
 * verbatim. No file cache, no log scraping.
 *
 * Rules are evaluated only in Python. The dry-run panel calls the same
 * eval_rule the push path uses, so a rule can never "pass the preview and
 * fail the push".
 */
(function () {
  "use strict";

  if (window.__sfLoaded) return;
  window.__sfLoaded = true;

  var PLUGIN_ID = "SceneBackfill";
  var PLUGIN_VERSION = "0.1.8";
  var Api = window.PluginApi;

  // The nav entry and the page logo are the same magnet. Resolved lazily so a
  // Stash build without FontAwesome just falls back to text.
  function faIcon(name, cls) {
    try {
      var libs = Api.libraries || {};
      var solid = libs.FontAwesomeSolid || {};
      var RAF = libs.ReactFontAwesome || {};
      if (!solid[name] || !RAF.FontAwesomeIcon) return null;
      return Api.React.createElement(RAF.FontAwesomeIcon, {
        icon: solid[name], className: cls || "", fixedWidth: true,
      });
    } catch (e) { return null; }
  }

  var _locale = "";
  var _localeSubs = [];
  function setLocale(loc) {
    var next = String(loc || "");
    if (next === _locale) return;
    _locale = next;
    _localeSubs.slice().forEach(function (fn) { fn(); });
  }
  // Until the bridge reports a locale, assume Chinese: the page paints long
  // before the bridge's effect runs, and defaulting to English made every
  // reload flash a screen of English first.
  function isZh() {
    var l = (_locale || "").toLowerCase();
    return l ? l.indexOf("zh") === 0 : true;
  }
  function tc(zh, en) { return isZh() ? zh : en; }

  // ─── i18n bridge ────────────────────────────────────────────────────────
  (function initIntl() {
    try {
      if (!Api || !Api.React || !Api.patch || !Api.libraries || !Api.libraries.Intl) return;
      var React = Api.React;
      var layoutEffect = React.useLayoutEffect || React.useEffect;
      function Bridge() {
        var intl = Api.libraries.Intl.useIntl();
        // Layout effect, not effect: it fires before the browser paints, so a
        // locale other than the default never shows up as a flash.
        layoutEffect(function () { setLocale(intl && intl.locale); },
          [intl && intl.locale]);
        // Stash 一重启守护进程就连不上、几轮后自己退出。这里每次打开 Stash
        // 问一次后端：上次是开着的就拉起来；用户手动停过、空闲自退的不会。
        React.useEffect(function () {
          var t = window.setTimeout(function () {
            op({ mode: "worker", action: "auto" }).catch(function () { /* 下次打开再说 */ });
          }, 3000);
          return function () { window.clearTimeout(t); };
        }, []);
        return null;
      }
      Api.patch.before("App", function (props) {
        return [{
          children: React.createElement(React.Fragment, null,
            React.createElement(Bridge), props.children),
        }];
      });
    } catch (e) { /* stay on the default */ }
  })();

  // Re-render whatever is mounted the moment the locale lands.
  function useLocale() {
    var React = Api.React;
    var layoutEffect = React.useLayoutEffect || React.useEffect;
    var bumpState = React.useState(0);
    var seen = React.useRef(_locale);
    layoutEffect(function () {
      function bump() { bumpState[1](function (n) { return n + 1; }); }
      _localeSubs.push(bump);
      if (seen.current !== _locale) { seen.current = _locale; bump(); }
      return function () {
        var i = _localeSubs.indexOf(bump);
        if (i >= 0) _localeSubs.splice(i, 1);
      };
    }, []);
    return _locale;
  }

  // ─── GraphQL ────────────────────────────────────────────────────────────
  // Stash 挂在反代子路径（如 https://host/stash/）时，页面会被改写 <base href>；
  // 根绝对路径会绕过它打到域名根，所以内部 URL 一律经这里解析。
  function appUrl(path) {
    var p = String(path == null ? "" : path);
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(p) ||
      p.indexOf("data:") === 0 || p.indexOf("blob:") === 0) return p;
    try {
      var base = new URL(document.baseURI || (location.origin + "/"));
      var prefix = base.pathname;                 // "/" 或 "/stash/"
      // Stash 自己返回的媒体路径已经带上反代前缀（BaseURL 中间件加的），别再套一次
      if (prefix.length > 1 && p.charAt(0) === "/" &&
        (p + "/").indexOf(prefix) === 0) return p;
      return new URL(p.replace(/^\/+/, ""), base).toString();
    } catch (e) { return p; }
  }

  function callGQL(query, variables) {
    return fetch(appUrl("/graphql"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.errors && d.errors.length) throw new Error(d.errors[0].message || "GraphQL error");
      return d.data;
    });
  }

  function op(args) {
    var a = Object.assign({}, args, { lang: isZh() ? "zh" : "en" });
    return callGQL("mutation($id:ID!,$a:Map!){runPluginOperation(plugin_id:$id,args:$a)}",
      { id: PLUGIN_ID, a: a })
      .then(function (d) { return d.runPluginOperation; });
  }

  // Every visit to another Stash page unmounts this component, so a fresh
  // fetch made the plugin look like it reloads from zero every time. The last
  // answer is kept here and painted immediately on the way back, then
  // refreshed in the background.
  var CACHE = { self: null, cap: null, prog: [], conn: null, ctrl: null, at: 0 };
  function remember(key, value) {
    CACHE[key] = value;
    CACHE.at = Date.now();
  }

  // 导航角标：优先级 有结果 → 下载中 → 已完成(增量) → 待处理，颜色跟着选中
  // 的那一组走。导航在任何页面都渲染，所以先画上一次的答案，再由页面（数据
  // 到手时）或一次只读 state 的请求更新。
  var NAV = {
    c: { found: 0, active: 0, done: 0, pending: 0 },
    evt: "sf:nav-count", badgeEvt: "sf:nav-badge", asked: false,
  };
  function navCount(c) {
    if (typeof c === "number") c = { found: c };
    NAV.c = {
      found: Math.max(0, Number(c && c.found) || 0),
      active: Math.max(0, Number(c && c.active) || 0),
      done: Math.max(0, Number(c && c.done) || 0),
      pending: Math.max(0, Number(c && c.pending) || 0),
    };
    try {
      window.dispatchEvent(new CustomEvent(NAV.evt, { detail: NAV.c }));
    } catch (e) { /* 老浏览器没有 CustomEvent，下一次渲染照样能拿到 NAV.c */ }
  }

  // ── 浏览器侧偏好：导航角标、版本号、统计栏、已完成增量 ─────────────
  // 全是展示偏好，存 localStorage 而不是插件配置；导航条在任何页面都渲染，
  // 同步读取才能避免首屏闪一下再消失。
  var UI_EVT = "sf:ui-pref";
  var NAV_BADGE_KEY = "sf.navBadge";
  var DONE_SEEN_KEY = "sf.doneSeen";
  function prefOn(key, def) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? def : v !== "0";
    } catch (e) { return def; }
  }
  function prefSet(key, on) {
    try { window.localStorage.setItem(key, on ? "1" : "0"); } catch (e) { /* 隐私模式 */ }
    try { window.dispatchEvent(new CustomEvent(UI_EVT)); } catch (e) { /* 同上 */ }
  }
  function navBadgeOn() { return prefOn(NAV_BADGE_KEY, true); }
  function showVerOn() { return prefOn("sf.showVer", true); }
  function showStatsOn() { return prefOn("sf.showStats", true); }
  function setNavBadge(on) {
    prefSet(NAV_BADGE_KEY, on);
    // 导航项不在页面组件树里，单独发事件让它重渲染。不能复用 nav-count：
    // 数字没变时 setState 同一个值会被 React 跳过。
    try { window.dispatchEvent(new CustomEvent(NAV.badgeEvt)); } catch (e) { /* 同上 */ }
  }

  // 已完成增量：上次看过「已完成」之后又入库了几条。第一次读取时把当前数量
  // 记为基线，升级上来的老用户不会一次看到一大串「+N」。
  function doneSeen() {
    try {
      var v = window.localStorage.getItem(DONE_SEEN_KEY);
      return v === null ? null : Math.max(0, Number(v) || 0);
    } catch (e) { return null; }
  }
  function markDoneSeen(n) {
    var v = Math.max(0, Number(n) || 0);
    try { window.localStorage.setItem(DONE_SEEN_KEY, String(v)); } catch (e) { /* 隐私模式 */ }
    try { window.dispatchEvent(new CustomEvent(NAV.badgeEvt)); } catch (e) { /* 同上 */ }
  }
  function doneInc(n) {
    var seen = doneSeen();
    if (seen === null) { markDoneSeen(n); return 0; }
    return Math.max(0, (Number(n) || 0) - seen);
  }

  // 导航角标：先看有结果，再看下载中，再看已完成增量，最后是待处理。
  // 数字对应的底色由调用方按 tone 上色（gr/cy/bl/ye）。
  function pickBadge(c) {
    if (!c) return null;
    if (c.found > 0) return { n: c.found, tone: "gr" };
    if (c.active > 0) return { n: c.active, tone: "cy" };
    var inc = doneInc(c.done || 0);
    if (inc > 0) return { n: inc, tone: "bl", plus: true };
    if (c.pending > 0) return { n: c.pending, tone: "ye" };
    return null;
  }

  // 设置页里的开关行。用组件自己的 state 兜住勾选状态，localStorage 只是持久层。
  function NavBadgeToggle() {
    var React = Api.React;
    var on = React.useState(navBadgeOn());
    return React.createElement("label", { className: "sf-toggle sf-toggle--switch" },
      React.createElement("span", { className: "sf-toggle-text" },
        React.createElement("b", null, tc("导航栏数字角标", "Navigation count badge")),
        React.createElement("span", { className: "sf-meta" },
          tc("关闭后不再显示导航栏数字", "Hides the number in the navigation when off"))),
      React.createElement("span", { className: "sf-switch" },
        React.createElement("input", {
          type: "checkbox", checked: on[0],
          onChange: function (e) { setNavBadge(e.target.checked); on[1](e.target.checked); },
        }),
        React.createElement("i", { "aria-hidden": "true" })));
  }

  function PrefSwitch(props) {
    var React = Api.React;
    var on = React.useState(props.get());
    return React.createElement("label", { className: "sf-toggle sf-toggle--switch" },
      React.createElement("span", { className: "sf-toggle-text" },
        React.createElement("b", null, props.title),
        React.createElement("span", { className: "sf-meta" }, props.hint)),
      React.createElement("span", { className: "sf-switch" },
        React.createElement("input", {
          type: "checkbox", checked: on[0],
          onChange: function (e) { props.set(e.target.checked); on[1](e.target.checked); },
        }),
        React.createElement("i", { "aria-hidden": "true" })));
  }

  // qB takes a few seconds to report a new run state, so a progress read that
  // lands in between used to repaint the old label -- a click on pause looked
  // ignored until the page was refreshed. Hold the intended state per scene
  // until qB agrees, or until this window runs out.
  var PENDING = {};

  // Stash does not expose its theme as a CSS variable, and this plugin's own
  // fallbacks are dark-theme values -- on a light theme the selects ended up
  // near-white on near-white. Read the real page colour once and let the CSS
  // follow it.
  function pageIsDark() {
    try {
      var bg = window.getComputedStyle(document.body).backgroundColor || "";
      var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
      if (!m) return true;
      var r = +m[1], g = +m[2], b = +m[3];
      return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    } catch (e) { return true; }
  }

  // ─── helpers ────────────────────────────────────────────────────────────
  function humanSize(n) {
    var v = Number(n) || 0, u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? Math.round(v) : v.toFixed(1)) + u[i];
  }
  function pct(v) { return Math.round((Number(v) || 0) * 100); }
  // 2h28m / 47m —— 场景时长，Stash 的卡片也是这个读法
  function fmtDur(sec) {
    var v = Math.round(Number(sec) || 0);
    if (v < 60) return "";
    var h = Math.floor(v / 3600), m = Math.round((v % 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return (h ? h + "h" : "") + (m ? m + "m" : "");
  }
  function etaText(s) {
    var v = Number(s) || 0;
    if (!v || v >= 8640000) return "—";
    if (v < 60) return v + "s";
    if (v < 3600) return Math.round(v / 60) + "m";
    return Math.round(v / 3600) + "h";
  }
    function agoText(s) {
      var v = Number(s) || 0;
      if (v < 0) return "—";
      if (v < 90) return v + "s";
      if (v < 3600) return Math.round(v / 60) + "m";
      return Math.round(v / 3600) + "h";
    }
  // qB reports pausedDL/stoppedDL on 5.x and pausedDL on 4.x.
  function isPaused(state) { return /paused|stopped/i.test(state || ""); }

  // ─── icons ──────────────────────────────────────────────────────────────
  // 内联 SVG（16×16，stroke 1.6，currentColor）而不是 FontAwesome：这套构建里
  // 图标不保证齐，缺一个就是一块空白。所有图标共用一套线宽，视觉才对得齐。
  var ICONS = {
    search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.3 10.3 13.6 13.6"/>',
    download: '<path d="M8 2.6v7.2M4.9 6.9 8 10l3.1-3.1M2.8 13h10.4"/>',
    clock: '<circle cx="8" cy="8" r="5.4"/><path d="M8 4.9V8l2.2 1.5"/>',
    check: '<path d="M3 8.6l3.2 3.1L13 4.9"/>',
    alert: '<path d="M8 2.8 14 13H2z"/><path d="M8 6.6v3.1M8 11.5v.1"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    ban: '<circle cx="8" cy="8" r="5.4"/><path d="M4.4 11.6 11.6 4.4"/>',
    pause: '<path d="M5.8 3.6v8.8M10.2 3.6v8.8"/>',
    play: '<path d="M5.4 3.4 12.4 8l-7 4.6z"/>',
    trash: '<path d="M3.2 4.6h9.6M6.3 4.6V3.1h3.4v1.5M4.8 4.6l.6 8.4h5.2l.6-8.4"/>',
    refresh: '<path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.9M13.4 2.6v3h-3"/>',
    grid: '<rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1"/><rect x="8.8" y="2.6" width="4.6" height="4.6" rx="1"/><rect x="2.6" y="8.8" width="4.6" height="4.6" rx="1"/><rect x="8.8" y="8.8" width="4.6" height="4.6" rx="1"/>',
    list: '<circle cx="3.4" cy="4.4" r=".9" fill="currentColor" stroke="none"/><circle cx="3.4" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3.4" cy="11.6" r=".9" fill="currentColor" stroke="none"/><path d="M6.2 4.4h7.2M6.2 8h7.2M6.2 11.6h7.2"/>',
    // 三个点：这枚按钮后面是「更多工具」，不再只是筛选
    more: '<circle cx="3.7" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="12.3" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
    external: '<path d="M9.6 2.8h3.6v3.6M13.2 2.8 7.8 8.2M6 4.2H3v8.8h8.8V10"/>',
    chevron: '<path d="M4.6 6.2 8 9.6l3.4-3.4"/>',
    folder: '<path d="M2.6 4.2h4l1.2 1.6h5.6v6.4H2.6z"/>',
    magnet: '<path d="M4.2 3v4.4a3.8 3.8 0 0 0 7.6 0V3"/><path d="M4.2 6.6h2.6M9.2 6.6h2.6"/>',
    seed: '<circle cx="8" cy="8" r="5.4"/><path d="M8 11.2V5.4M5.5 7.9 8 5.4l2.5 2.5"/>',
    plus: '<path d="M8 4v8M4 8h8"/>',
    info: '<circle cx="8" cy="8" r="5.4"/><path d="M8 7.4v3.4M8 5.2v.1"/>',
    // 框里一支笔（stashDiscover 同款）：进多选，不是「已全选」
    edit: '<path d="M8.3 2H3.7a1.3 1.3 0 0 0-1.3 1.3v9.4a1.3 1.3 0 0 0 1.3 1.3h8.6a1.3 1.3 0 0 0 1.3-1.3V8.3"/><path d="M11.7 2.4l1.9 1.9-5.9 5.9-2.5.6.6-2.5z"/>',
  };
  function ico(name, cls) {
    return Api.React.createElement("svg", {
      className: "sf-ico" + (cls ? " " + cls : ""),
      viewBox: "0 0 16 16", fill: "none", stroke: "currentColor",
      strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true",
      dangerouslySetInnerHTML: { __html: ICONS[name] || "" },
    });
  }

  // 点遮罩关闭的防误触：click 的 target 是按下与松开的最近公共祖先，从弹窗内
  // 按住拖到遮罩上松手时 target 就是遮罩，只判 e.target === 遮罩会误关。要求：
  // 按下时就在遮罩本身、位移 < 8px、且不是长按（> 700ms）才关。
  function ModalBack(props) {
    var React = Api.React;
    var down = React.useRef(null);
    return React.createElement("div", {
      className: "sf-modal-back",
      onPointerDown: function (e) {
        down.current = {
          on: e.target === e.currentTarget,
          x: e.clientX, y: e.clientY, t: Date.now(),
        };
      },
      onClick: function (e) {
        var d = down.current;
        down.current = null;
        if (e.detail === 0 || !d || !d.on) return;          // 键盘 / 脚本触发
        if (e.target !== e.currentTarget) return;
        if (Math.abs(e.clientX - d.x) > 8 || Math.abs(e.clientY - d.y) > 8) return;
        if (Date.now() - d.t > 700) return;                 // 长按选词后松手
        if (props.onClose) props.onClose();
      },
    }, props.children);
  }

  // ─── 状态 → 图标 / 语义色 / 文案（唯一来源）───────────────────────────────
  // 页面里任何“这东西现在什么状态”都从这里取，别处不再各写一套配色。
  var SMETA = {
    captured: { hue: "tx3", icon: "clock", zh: "待搜索", en: "New" },
    searching: { hue: "bl", icon: "search", zh: "搜索中", en: "Searching" },
    matched: { hue: "gr", icon: "check", zh: "有结果", en: "Found" },
    low_confidence: { hue: "ye", icon: "alert", zh: "需确认", en: "Check" },
    no_result: { hue: "tx3", icon: "search", zh: "无结果", en: "No result" },
    pushed: { hue: "cy", icon: "download", zh: "下载中", en: "Downloading" },
    downloaded: { hue: "bl", icon: "download", zh: "待入库", en: "Ready" },
    importing: { hue: "cy", icon: "refresh", zh: "入库中", en: "Importing" },
    imported: { hue: "gr", icon: "check", zh: "已入库", en: "In library" },
    missing: { hue: "re", icon: "x", zh: "任务丢失", en: "Lost" },
    ignored: { hue: "tx3", icon: "ban", zh: "已忽略", en: "Ignored" },
  };
  function metaOf(st) { return SMETA[st] || SMETA.captured; }
  function statusLabel(s) { var m = metaOf(s); return isZh() ? m.zh : m.en; }
  function statusPill(st) {
    var m = metaOf(st);
    return Api.React.createElement("span", { className: "sf-pill is-h-" + m.hue },
      ico(m.icon), statusLabel(st));
  }

  var UNKNOWN_POLICY = {
    ask: function () { return tc("需人工确认", "Ask me"); },
    allow: function () { return tc("放行", "Allow"); },
    reject: function () { return tc("淘汰", "Reject"); },
  };

  // ─── page ───────────────────────────────────────────────────────────────
  function Page() {
    var React = Api.React;
    var h = React.createElement;
    var useState = React.useState, useEffect = React.useEffect, useCallback = React.useCallback;
    useLocale();

    var tabState = useState(function () {
      try { return window.localStorage.getItem("sf.tab") || "pending"; }
      catch (e) { return "pending"; }
    });
    var tab = tabState[0];
    function switchTab(id) {
      tabState[1](id);
      // 「待入库」只是下载页里的一个筛选，换 tab 就该失效
      filterState[1]("");
      selOnState[1](false);
      selState[1]({});
      idxState[1]("");
      resState[1]("");
      toolsOpenState[1](false);
      try { window.localStorage.setItem("sf.tab", id); } catch (e) { /* private mode */ }
    }

    var selfState = useState(CACHE.self);
    var self = selfState[0], setSelf = selfState[1];
    // 补档方式：whisparr 时整条搜索/挑选链路交给 Whisparr，界面不出现候选与规则
    function isWsp() { return !!(self && self.pipeline === "whisparr"); }
    // 「qBittorrent / Motrix / Whisparr」会出现在连接行、确认框和头部版本号里
    function dlName() {
      if (isWsp()) return "Whisparr";
      return (self && self.downloader === "motrix") ? "Motrix" : "qBittorrent";
    }
    var capState = useState(CACHE.cap);
    var cap = capState[0], setCap = capState[1];
    var progState = useState(CACHE.prog || []);
    var prog = progState[0], setProg = progState[1];
    var connState = useState(CACHE.conn);
    var conn = connState[0], setConn = connState[1];
    var busyState = useState("");
    var busy = busyState[0], setBusy = busyState[1];
    var msgState = useState(null);
    var msg = msgState[0], setMsg = msgState[1];
    var detailState = useState("");
    var detailId = detailState[0], setDetailId = detailState[1];
    // 下载中的弹窗和场景详情弹窗是两件事：前者只有进度与下载操作。
    var dlState = useState("");
    var dlId = dlState[0], setDlId = dlState[1];
    // 窄屏的「更多」只留一个，就在工具条里：各 tab 自己的批量按钮、自动开关
    // 在正文里构建时顺手塞进这里，桌面端照旧留在原位。
    var MEXTRA = [];
    // 弹窗打开时锁住背后页面：滚轮与触摸会穿到下层，滚的是列表不是弹窗
    var modalOpen = !!detailId || !!dlId;
    useEffect(function () {
      if (!modalOpen) return;
      var de = document.documentElement, b = document.body;
      var o1 = de.style.overflow, o2 = b.style.overflow;
      de.style.overflow = "hidden";
      b.style.overflow = "hidden";
      return function () { de.style.overflow = o1; b.style.overflow = o2; };
    }, [modalOpen]);
    var viewState = useState(function () {
      try { return window.localStorage.getItem("sf.view") || "grid"; }
      catch (e) { return "grid"; }
    });
    var view = viewState[0], setView = viewState[1];
    function switchView(v) {
      viewState[1](v);
      try { window.localStorage.setItem("sf.view", v); } catch (e) { /* private mode */ }
    }
    var qState = useState("");
    var q = qState[0], setQ = qState[1];
    // 统计卡点一下就只留这一组；再点一次回到全部
    var filterState = useState("");
    var filter = filterState[0], setFilter = filterState[1];
    // 索引器 / 分辨率只作用于「有结果」：一张卡片就是一个场景，它值不值得留
    // 取决于它挑中的那条（最佳）资源，所以按最佳候选的物理属性筛。
    var idxState = useState("");
    var idx = idxState[0], setIdx = idxState[1];
    var resState = useState("");
    var res = resState[0], setRes = resState[1];
    // 多选：选中态只活在当前 tab 里，换 tab / 退出即清空
    var selOnState = useState(false);
    var selOn = selOnState[0], setSelOn = selOnState[1];
    var selState = useState({});
    var sel = selState[0], setSel = selState[1];
    var toolsOpenState = useState(false);
    var toolsOpen = toolsOpenState[0], setToolsOpen = toolsOpenState[1];
    // 当前这一屏能被选中的 id，由正文渲染时填入；全选只认它
    var VIS = [];

    function toggleSel(sid) {
      var k = String(sid);
      setSel(function (cur) {
        var next = Object.assign({}, cur);
        if (next[k]) delete next[k]; else next[k] = true;
        return next;
      });
    }
    function selIds() { return Object.keys(sel); }
    function exitSel() { setSelOn(false); setSel({}); }
    // 卡片与标题点了是进详情，多选时改成勾选 —— 一处判断，两个入口都走它
    function openOf(sid, opener) {
      return function () {
        if (selOn) { toggleSel(sid); return; }
        (opener || openDetail)(sid);
      };
    }
    var foldState = useState({});
    var fold = foldState[0], setFold = foldState[1];
    // 详情弹窗里「已淘汰」是废条目，默认收起；换一个场景重新折回去
    var rejFoldState = useState(true);
    var rejFolded = rejFoldState[0], setRejFolded = rejFoldState[1];
    var brokenState = useState({});
    var shotBroken = brokenState[0], setShotBroken = brokenState[1];

    var draftState = useState(CACHE.rules ? CACHE.rules.rules : null);
    var draft = draftState[0], setDraft = draftState[1];
    var formState = useState(CACHE.rules ? parseForm(CACHE.rules.rules && CACHE.rules.rules.text) : null);
    var ruleForm = formState[0], setRuleForm = formState[1];
    var defaultsState = useState(CACHE.rules ? CACHE.rules.defaults : null);
    var defaults = defaultsState[0], setDefaults = defaultsState[1];
    var errState = useState(CACHE.rules ? (CACHE.rules.errors || []) : []);
    var ruleErrors = errState[0], setRuleErrors = errState[1];
    var evalState = useState(null);
    var evalResult = evalState[0], setEvalResult = evalState[1];
    var evalBusyState = useState("");
    var evalBusy = evalBusyState[0], setEvalBusy = evalBusyState[1];
    var evalPickState = useState("");
    var evalPick = evalPickState[0], setEvalPick = evalPickState[1];

    var ctrlState = useState(CACHE.ctrl);
    var ctrl = ctrlState[0], setCtrl = ctrlState[1];
    var ctrlDraftState = useState(null);
    var ctrlDraft = ctrlDraftState[0], setCtrlDraft = ctrlDraftState[1];

    var toast = useCallback(function (text, bad) {
      setMsg({ text: text, bad: !!bad });
      window.setTimeout(function () { setMsg(null); }, 4200);
    }, []);

    var loadSelf = useCallback(function () {
      return op({ mode: "selftest" }).then(function (d) { remember("self", d); setSelf(d); })
        .catch(function (e) {
          var bad = { ok: false, checks: [], error: String(e.message || e) };
          remember("self", bad);
          setSelf(bad);
        });
    }, []);

    var loadCapture = useCallback(function () {
      return op({ mode: "capture" }).then(function (d) {
        (d.scenes || []).forEach(function (s) {
          if (s && s.shot) s.shot = appUrl(s.shot);
        });
        remember("cap", d);
        setCap(d);
      }).catch(function (e) {
        toast(String(e.message || e), true);
      });
    }, []);

    var loadProgress = useCallback(function () {
      return op({ mode: "progress" }).then(function (d) {
        var rows = settle((d && d.torrents) || []);
        rows.forEach(function (r) { if (r && r.shot) r.shot = appUrl(r.shot); });
        remember("prog", rows);
        if (d && d.conn) { remember("conn", d.conn); setConn(d.conn); }
        setProg(rows);
        if (d && d.daemon) {
          setCtrl(function (c) { return c ? Object.assign({}, c, { daemon: d.daemon }) : c; });
        }
        if (d && d.control) {
          // Switches are owned by do_control; this only keeps the panel honest
          // when another window changed them.
          setCtrl(function (c) {
            return c ? Object.assign({}, c, { control: d.control }) : c;
          });
        }
        if (d && d.daemon && CACHE.ctrl) CACHE.ctrl.daemon = d.daemon;
        if (d && d.pipeline) {
          if (CACHE.self && CACHE.self.pipeline !== d.pipeline) CACHE.self.pipeline = d.pipeline;
          setSelf(function (prev) {
            return prev && prev.pipeline === d.pipeline ? prev
              : Object.assign({}, prev || {}, { pipeline: d.pipeline });
          });
        }
      }).catch(function () { /* progress is best-effort */ });
    }, []);

    var loadControl = useCallback(function (syncDraft) {
      return op({ mode: "control" }).then(function (d) {
        remember("ctrl", d);
        setCtrl(d);
        if (syncDraft) setCtrlDraft(d.control);
      }).catch(function (e) { toast(String(e.message || e), true); });
    }, []);

    var loadRules = useCallback(function () {
      return op({ mode: "rules" }).then(function (d) {
        remember("rules", d);
        setDraft(d.rules);
        setRuleForm(parseForm(d.rules && d.rules.text));
        setDefaults(d.defaults);
        setRuleErrors(d.errors || []);
      }).catch(function (e) { toast(String(e.message || e), true); });
    }, []);

    var reload = useCallback(function () {
      return Promise.all([loadSelf(), loadCapture(), loadProgress(), loadControl(true)]);
    }, []);

    var refreshingState = useState(false);
    var refreshing = refreshingState[0], setRefreshing = refreshingState[1];
    function doRefresh() {
      if (refreshing) return;
      setRefreshing(true);
      reload().then(function () {
        toast(tc("已刷新", "Refreshed"));
      }).catch(function (e) {
        toast(String(e.message || e), true);
      }).then(function () { setRefreshing(false); });
    }

    useEffect(function () { reload(); }, []);
    useEffect(function () { if (tab === "settings" && !draft) loadRules(); }, [tab, draft]);

    // Esc closes the popup; the backdrop click does too. In multi-select Esc
    // means "leave selection", which is the only way out on a phone.
    useEffect(function () {
      if (!detailId && !dlId && !selOn) return undefined;
      function onKey(e) {
        if (e.key !== "Escape") return;
        if (detailId || dlId) { setDetailId(""); setDlId(""); return; }
        setSelOn(false); setSel({});
      }
      window.addEventListener("keydown", onKey);
      return function () { window.removeEventListener("keydown", onKey); };
    }, [detailId, dlId, selOn]);

    useEffect(function () {
      var t = window.setInterval(loadProgress, 8000);
      return function () { window.clearInterval(t); };
    }, []);

    // Page clock. Only does something when an automation switch is on and no
    // worker is alive; the backend returns early otherwise.
    useEffect(function () {
      var inflight = false;
      var t = window.setInterval(function () {
        if (inflight) return;
        inflight = true;
        op({ mode: "tick", source: "page" }).then(function (d) {
          if (!d) return;
          if (d.daemon) {
            setCtrl(function (c) { return c ? Object.assign({}, c, { daemon: d.daemon }) : c; });
          }
          if (d.actions && d.actions.length) {
            loadCapture();
            loadProgress();
          }
        }).catch(function () { /* next tick retries */ })
          .then(function () { inflight = false; });
      }, 30000);
      return function () { window.clearInterval(t); };
    }, []);

    // 从 self 切到 whisparr 后，记住的「有结果」tab 已不存在，把它送到 Whisparr 页
    useEffect(function () {
      if (isWsp() && tab === "results") switchTab("downloading");
    }, [tab, self]);

    function act(args, doneMsg) {
      setBusy(args.mode + ":" + (args.sceneId || ""));
      op(args).then(function () {
        if (doneMsg) toast(doneMsg);
        return Promise.all([loadCapture(), loadProgress(), loadSelf()]);
      }).catch(function (e) {
        toast(String(e.message || e), true);
      }).then(function () { setBusy(""); });
    }

    // A scene the rules could not judge is usually just missing file lists.
    // Fetch them in the background and re-screen, without blocking the page.
    function screenInBackground(sid) {
      op({ mode: "prefetch", sceneId: sid, force: true })
        .then(loadCapture).catch(function () { /* next tick retries */ });
    }

    function doSearch(sid) {
      setBusy("search:" + sid);
      op({ mode: "search", sceneId: sid }).then(function (r) {
        var scr = (r && r.screen) || {};
        if (r && r.status === "matched") {
          toast(tc("通过筛选 " + scr.pass + " 个，淘汰 " + scr.fail,
            scr.pass + " passed, " + scr.fail + " rejected"));
          switchTab("results");
        } else if (r && r.status === "low_confidence") {
          toast(tc(scr.unknown + " 个候选缺清单，正在补",
            scr.unknown + " need a file list, fetching"));
          screenInBackground(sid);
        } else {
          toast(tc(r && r.candidates && r.candidates.length
            ? "规则淘汰了全部 " + r.candidates.length + " 个"
            : "没有搜到结果", "no candidate passed the rules"), true);
        }
        return Promise.all([loadCapture(), loadProgress()]);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function doPush(sid, index) {
      setBusy("push:" + sid);
      op({ mode: "push", sceneId: sid, index: index }).then(function (r) {
        toast(isWsp() ? tc("已交给 Whisparr", "Sent to Whisparr")
          : tc("已推送：" + ((r && r.picked) || ""), "Pushed: " + ((r && r.picked) || "")));
        setDetailId("");
        switchTab("downloading");
        return Promise.all([loadCapture(), loadProgress()]);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function doImport(sid) {
      setBusy("import:" + sid);
      op({ mode: "import", sceneId: sid }).then(function (r) {
        if (r && r.ok) toast(tc("已入库", "Imported"));
        else toast((r && r.error) || tc("入库失败", "Import failed"), true);
        return Promise.all([loadCapture(), loadProgress()]);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function doIgnore(sid, restore) {
      act({ mode: "ignore", sceneId: sid, restore: restore ? "true" : "" },
        restore ? tc("已恢复", "Restored") : tc("已忽略", "Ignored"));
    }

    // qB reports the new state a beat after the call returns, so the button
    // label is repainted from the action itself and the refresh confirms it.
    function paintState(sid, action) {
      if (action !== "pause" && action !== "resume") return;
      var paused = action === "pause";
      PENDING[sid] = { paused: paused, until: Date.now() + 12000 };
      setProg(function (rows) {
        return (rows || []).map(function (r) {
          return r.sceneId === sid
            ? Object.assign({}, r, { state: paused ? "stoppedDL" : "downloading" })
            : r;
        });
      });
    }

    // A read that still carries the pre-click state is overridden, not shown.
    function settle(rows) {
      var now = Date.now();
      return (rows || []).map(function (r) {
        var p = PENDING[r.sceneId];
        if (!p) return r;
        if (now > p.until || isPaused(r.state) === p.paused) {
          delete PENDING[r.sceneId];
          return r;
        }
        return Object.assign({}, r, { state: p.paused ? "stoppedDL" : "downloading" });
      });
    }

    function doTorrent(p, action) {
      if (action === "remove" && !window.confirm(tc(
        "从 " + dlName() + " 移除这个任务？已下载的文件会保留。",
        "Remove this torrent from " + dlName() + "? Downloaded files stay on disk."))) return;
      setBusy("torrent:" + p.sceneId);
      paintState(p.sceneId, action);
      op({ mode: "torrent", sceneId: p.sceneId, action: action }).then(function () {
        toast(action === "pause" ? tc("已暂停", "Paused")
          : action === "resume" ? tc("已继续", "Resumed")
            : tc("已移除任务", "Torrent removed"));
        // Only a removal changes the scene record; pause/resume just needs the
        // progress read, and the capture pass is the slowest call here.
        return action === "remove"
          ? Promise.all([loadProgress(), loadCapture()])
          : loadProgress();
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function doBulk(action) {
      if (action === "remove_missing" && !window.confirm(isWsp()
        ? tc("清掉记录里 Whisparr 已经没有的场景？它们会退回重新加片。",
             "Forget scenes Whisparr no longer has? They go back to being sent.")
        : tc("清掉记录里 " + dlName() + " 已经没有的任务？这些场景会退回重新挑选资源。",
             "Forget torrents " + dlName() + " no longer has? Those scenes go back to picking a release."))) return;
      setBusy("bulk:" + action);
      if (action !== "remove_missing") {
        (prog || []).forEach(function (p) {
          if (p.status !== "imported") paintState(p.sceneId, action);
        });
      }
      op({ mode: "torrent", bulk: "true", action: action }).then(function (r) {
        var n = (r && r.count) || 0;
        toast((action === "pause" ? tc("已全部暂停", "All paused")
          : action === "resume" ? tc("已全部下载", "All resumed")
            : tc("已移除缺失任务", "Missing removed")) + " · " + n);
        return action === "remove_missing"
          ? Promise.all([loadProgress(), loadCapture()])
          : loadProgress();
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function bulkRestore() {
      if (!window.confirm(tc("把忽略的场景全部放回待处理？", "Put every ignored scene back in Pending?"))) return;
      setBusy("ignore:all");
      op({ mode: "ignore", action: "restore_all" }).then(function (r) {
        var n = (r && r.count) || 0;
        toast(tc("已还原 " + n + " 个", n + " restored"));
        return loadCapture();
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function clearDone() {
      if (!window.confirm(tc("清空已完成记录？场景本身已经入库，不会受影响。",
        "Clear the done list? The scenes themselves are already imported."))) return;
      setBusy("done:clear");
      op({ mode: "done", action: "clear" }).then(function (r) {
        var n = (r && r.count) || 0;
        toast(tc("已清空 " + n + " 条", n + " cleared"));
        return Promise.all([loadProgress(), loadCapture()]);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    // 多选：能一次交代的（忽略 / 暂停 / 移除 / 清记录）走一个 ids，
    // 需要逐个跑的（搜索 / 推送）按顺序来，一个失败不拖住其余。
    function eachSel(ids, fn) {
      var i = 0, n = 0;
      function step() {
        if (i >= ids.length) return Promise.resolve({ count: n });
        var sid = ids[i++];
        return fn(sid).then(function () { n++; return step(); })
          .catch(function () { return step(); });
      }
      return step();
    }

    function runSel(kind) {
      var ids = selIds();
      if (!ids.length) return;
      var n0 = ids.length;
      if (kind === "remove" && !window.confirm(isWsp()
        ? tc("从 Whisparr 移除这 " + n0 + " 个场景？已下载的文件会保留。",
             "Remove these " + n0 + " scenes from Whisparr? Downloaded files stay on disk.")
        : tc("从 " + dlName() + " 移除这 " + n0 + " 个任务？已下载的文件会保留。",
             "Remove these " + n0 + " torrents? Downloaded files stay on disk."))) return;
      if (kind === "forget" && !window.confirm(tc(
        "从已完成里移除这 " + n0 + " 条记录？场景本身已经入库，不受影响。",
        "Forget these " + n0 + " done records? The scenes stay imported."))) return;
      if (kind === "ignore" && !window.confirm(tc(
        "忽略这 " + n0 + " 个场景？", "Ignore these " + n0 + " scenes?"))) return;

      setBusy("sel:" + kind);
      var job = null;
      if (kind === "ignore" || kind === "restore") {
        job = op({ mode: "ignore", ids: ids, restore: kind === "restore" ? "true" : "" });
      } else if (kind === "forget") {
        job = op({ mode: "done", action: "clear", ids: ids });
      } else if (kind === "pause" || kind === "resume" || kind === "remove") {
        if (kind !== "remove") {
          ids.forEach(function (sid) { paintState(sid, kind); });
        }
        job = op({ mode: "torrent", ids: ids, action: kind });
      } else if (kind === "search") {
        job = eachSel(ids, function (sid) { return op({ mode: "search", sceneId: sid }); });
      } else if (kind === "push") {
        job = eachSel(ids, function (sid) {
          if (isWsp()) return op({ mode: "push", sceneId: sid });
          var s = byId[sid] || {};
          var all = s.candidates || [];
          var best = topCandidate(s);
          if (!best) return Promise.resolve();
          return op({ mode: "push", sceneId: sid, index: all.indexOf(best) });
        });
      }
      (job || Promise.resolve({ count: 0 })).then(function (r) {
        var n = r && r.count != null ? r.count : n0;
        toast(kind === "search" ? tc("已搜索 " + n + " 个", n + " searched")
          : kind === "push" ? tc("已推送 " + n + " 个", n + " pushed")
            : kind === "ignore" ? tc("已忽略 " + n + " 个", n + " ignored")
              : kind === "restore" ? tc("已恢复 " + n + " 个", n + " restored")
                : kind === "forget" ? tc("已移除 " + n + " 条记录", n + " records dropped")
                  : kind === "resume" ? tc("已继续 " + n + " 个", n + " resumed")
                    : kind === "pause" ? tc("已暂停 " + n + " 个", n + " paused")
                      : tc("已移除 " + n + " 个任务", n + " removed"));
        exitSel();
        if (kind === "push") switchTab("downloading");
        return Promise.all([loadCapture(), loadProgress()]);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    function saveControl(next, msg) {
      var payload = Object.assign({ mode: "control", save: "true" }, next);
      setBusy("control");
      // Paint the new switches before the round trip: waiting for the server
      // made a click look like it only raised a toast.
      setCtrl(function (c) { return c ? Object.assign({}, c, { control: next }) : c; });
      setCtrlDraft(next);
      op(payload).then(function (d) {
        remember("ctrl", d);
        setCtrl(d);
        setCtrlDraft(d.control);
        toast(msg || tc("自动化设置已保存", "Automation saved"));
      }).catch(function (e) {
        toast(String(e.message || e), true);
        loadControl(true);
      }).then(function () { setBusy(""); });
    }

    function toggleDaemon() {
      var alive = !!(ctrl && ctrl.daemon && ctrl.daemon.alive);
      setBusy("daemon");
      op({ mode: "worker", action: alive ? "stop" : "start" }).then(function (d) {
        setCtrl(function (c) { return c ? Object.assign({}, c, { daemon: d.daemon }) : c; });
        if (d.note === "already running") toast(tc("守护已在运行", "Worker is already running"));
        else toast(alive ? tc("守护正在停止", "Stopping worker") : tc("守护已启动", "Worker started"));
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    // A dry run needs the file lists, which means downloading .torrent files.
    // Each round is time-boxed on the backend; stop when nothing is left or
    // after a few rounds, so a dead indexer cannot hang the page.
    function runEval(sid) {
      if (!sid) return;
      setEvalPick(sid);
      setEvalBusy(sid);
      setEvalResult(null);
      op({ mode: "prefetch", sceneId: sid, force: true }).then(function () {
        return op({ mode: "eval_rules", sceneId: sid });
      }).then(function (r) {
        setEvalResult(r);
        var rejected = (r.candidates || []).filter(function (c) { return c.outcome === "reject"; }).length;
        toast(tc("试运行完成，淘汰 " + rejected + " 个", rejected + " rejected"));
        return loadCapture();
      }).catch(function (e) {
        toast(String(e.message || e), true);
      }).then(function () { setEvalBusy(""); });
    }

    function saveRules(next, doneText) {
      var payload = Object.assign({ mode: "rules", save: "true" }, next);
      setBusy("rules");
      op(payload).then(function (d) {
        remember("rules", d);
        setDraft(d.rules);
        setRuleForm(parseForm(d.rules && d.rules.text));
        setRuleErrors(d.errors || []);
        var bad = (d.errors || []).length;
        toast(bad ? tc("已保存，" + bad + " 行有误", "Saved, " + bad + " bad lines")
          : (doneText || tc("规则已保存", "Rules saved")), bad > 0);
      }).catch(function (e) { toast(String(e.message || e), true); })
        .then(function () { setBusy(""); });
    }

    if (!Api || !Api.React) {
      return h("div", { className: "sf-page" }, "PluginApi unavailable");
    }

    var scenes = (cap && cap.scenes) || [];
    var pending = scenes.filter(function (s) {
      return s.status === "captured" || s.status === "no_result" || s.status === "low_confidence";
    });
    var found = scenes.filter(function (s) { return s.status === "matched"; });
    var ignored = scenes.filter(function (s) { return s.status === "ignored"; });
    var done = (prog || []).filter(function (p) { return p.status === "imported"; });
    var withCands = scenes.filter(function (s) { return (s.candidates || []).length > 0; });

    var live = (prog || []).filter(function (p) { return p.status !== "imported"; });
    var readyRows = live.filter(function (p) { return p.ready; });

    // 页面在场时不用再问后端：把四组数一起交给导航
    useEffect(function () {
      navCount({
        found: isWsp() ? 0 : found.length,
        active: live.length,
        done: done.length,
        pending: pending.length,
      });
    }, [found.length, live.length, done.length, pending.length, self]);

    // 停在「已完成」上时随时把基线推平：新入库的当场消化掉，不在离开页面后
    // 又补出一个「+N」。
    useEffect(function () {
      if (tab === "done" && cap) markDoneSeen(done.length);
    }, [tab, done.length, cap]);

    // 设置页里的浏览器偏好改动后重画整页（版本号、统计栏都直接读 localStorage）
    var uiTick = useState(0);
    useEffect(function () {
      function bump() { uiTick[1](function (v) { return v + 1; }); }
      window.addEventListener(UI_EVT, bump);
      return function () { window.removeEventListener(UI_EVT, bump); };
    }, []);

    var tabs = [
      { id: "pending", label: tc("待处理", "Pending"), n: pending.length, hue: "ye", icon: "clock" },
      isWsp() ? null : { id: "results", label: tc("有结果", "Results"), n: found.length, hue: "gr", icon: "check" },
      { id: "downloading", label: isWsp() ? tc("Whisparr", "Whisparr") : tc("下载中", "Downloading"), n: live.length, hue: "cy", icon: "download" },
      { id: "done", label: tc("已完成", "Done"), n: done.length, hue: "bl", icon: "folder" },
      { id: "ignored", label: tc("已忽略", "Ignored"), n: ignored.length, hideCount: true, hue: "tx3", icon: "ban" },
      { id: "settings", label: tc("设置", "Settings"), n: 0, hue: "tx3", icon: "info" },
    ].filter(Boolean);
    // 「已完成」只显示上次看过之后的增量；点开一次就清零
    var dinc = doneInc(done.length);

    // 搜索只按「用户记得住的东西」匹配：番号、标题、演员。
    var needle = String(q || "").trim().toLowerCase();
    function hit(s) {
      if (!needle) return true;
      return [s.code, s.title, (s.performers || []).join(" ")]
        .join(" ").toLowerCase().indexOf(needle) >= 0;
    }
    function hitProg(p) {
      if (!needle) return true;
      var s = byId[p.sceneId] || {};
      return [p.code, p.name, s.title].join(" ").toLowerCase().indexOf(needle) >= 0;
    }

    // ─── 统计卡 / 工具条 ───────────────────────────────────────────────────
    // 这排卡同时是筛选器：点一下就只看这一组，再点回到全部。
    function statCard(n, hue, label, on, onClick) {
      return h("button", {
        className: "sf-stat is-h-" + hue + (n ? "" : " is-zero") + (on ? " is-on" : ""),
        onClick: onClick,
      },
        h("span", { className: "sf-stat-n" }, n),
        h("span", { className: "sf-stat-l" }, label));
    }

    function statsRow() {
      var g = (ctrl && ctrl.gate) || {};
      var used = Number(g.used) || 0;
      var limit = Number(g.limit) || 0;
      var over = limit > 0 && used >= limit;
      // 进度条画的是「这批没入库的下载 / 还能用的空间」（= 在飞 / (在飞 + 剩余)），
      // 不是整盘占用——整盘里绝大部分是库里已有的片子，跟这个插件无关。
      var dk = (self && self.disk) || {};
      var total = Number(dk.total) || 0;
      var avail = Number(dk.free) || 0;
      var room = used + avail;
      var pct = avail > 0 && total > 0 && room > 0 ? Math.min(100, used / room * 100) : 0;
      var tone = pct >= 90 ? "re" : pct >= 70 ? "or" : "cy";
      var free = "";
      var sp = ((self && self.checks) || []).filter(function (c) { return c.key === "space"; })[0];
      if (sp && sp.detail && sp.detail !== "-") free = sp.detail;
      return h("div", { className: "sf-stats" }, [
        statCard(pending.length, "ye", tc("待处理", "Pending"),
          tab === "pending", function () { switchTab("pending"); }),
        isWsp() ? null : statCard(found.length, "gr", tc("有结果", "Results"),
          tab === "results", function () { switchTab("results"); }),
        statCard(live.length, "cy",
          isWsp() ? tc("Whisparr 中", "In Whisparr") : tc("下载中", "Downloading"),
          tab === "downloading" && !filter, function () { switchTab("downloading"); setFilter(""); }),
        statCard(readyRows.length, "bl", tc("待入库", "Ready"),
          tab === "downloading" && filter === "ready",
          function () { switchTab("downloading"); setFilter("ready"); }),
        h("button", {
          className: "sf-stat sf-stat--wide" + (over ? " is-h-re" : ""),
          onClick: function () { switchTab("settings"); },
          title: tc("推送上限，点开设置", "Push cap, opens settings"),
        },
          h("div", { className: "sf-stat-n" }, humanSize(used),
            total ? h("span", { className: "sf-stat-pct" }, Math.round(pct) + "%") : null),
          h("div", { className: "sf-stat-wrow" },
            h("span", { className: "sf-stat-l" },
              limit ? tc("占用 · 上限 " + humanSize(limit), "used · cap " + humanSize(limit))
                : tc("占用 · 无上限", "used · no cap")),
            free ? h("span", { className: "sf-stat-l sf-stat-free" },
              tc("剩 " + free, free + " free")) : null),
          // 贴在卡片底边、脱离布局流，不参与撑高
          total ? h("div", {
            className: "sf-stat-bar is-h-" + tone,
            title: tc("这批下载占可用空间 " + Math.round(pct) + "%",
              Math.round(pct) + "% of free space in use"),
          }, h("i", { style: { width: pct + "%" } })) : null),
      ].filter(Boolean));
    }

    function viewSeg() {
      return h("div", { className: "sf-seg" },
        [{ id: "grid", icon: "grid", zh: "网格", en: "Grid" },
        { id: "list", icon: "list", zh: "列表", en: "List" }].map(function (v, i) {
          return h("button", {
            key: i,
            className: "sf-segb" + (view === v.id ? " is-on" : ""),
            title: tc(v.zh, v.en),
            onClick: function () { switchView(v.id); },
          }, ico(v.icon));
        }));
    }

    // 下拉筛选的候选值：只列当前这一屏真实出现过的，避免空选项
    function optionsOf(items, pick) {
      var seen = {}, out = [];
      (items || []).forEach(function (s) {
        var v = pick(s);
        if (!v || seen[v]) return;
        seen[v] = true;
        out.push(v);
      });
      out.sort();
      return out;
    }

    function filterSelect(value, opts, onChange, allLabel) {
      // 只剩一项时也留着：这枚下拉本身就是「这里能筛」的提示
      if (!opts.length) return null;
      return h("select", {
        className: "sf-input sf-select sf-select--mini" + (value ? " is-on" : ""),
        value: value, onChange: function (e) { onChange(e.target.value); },
        title: allLabel,
      },
        h("option", { value: "" }, allLabel),
        opts.map(function (o) { return h("option", { key: o, value: o }, o); }));
    }

    function selToggle() {
      return h("button", {
        className: "sf-icb" + (selOn ? " is-acc" : ""),
        title: selOn ? tc("退出多选（Esc）", "Exit selection (Esc)") : tc("多选", "Select"),
        "aria-label": tc("多选", "Select"), "aria-pressed": selOn,
        onClick: function () { if (selOn) exitSel(); else setSelOn(true); },
      }, ico(selOn ? "x" : "edit"));
    }

    function refreshBtn() {
      return h("button", {
        className: "sf-icb" + (refreshing ? " is-busy" : ""), disabled: refreshing,
        title: tc("刷新", "Refresh"), "aria-label": tc("刷新", "Refresh"),
        onClick: doRefresh,
      }, ico("refresh"));
    }

    // 工具条居中成一组，不铺满整行；窄屏时收进「更多」，展开后落在下面一行。
    function toolsBar() {
      if (tab === "settings") return null;
      var candFilters = tab === "results"
        ? [
          filterSelect(idx, optionsOf(found, function (s) {
            var b = topCandidate(s); return b && b.indexer;
          }), setIdx, tc("全部索引器", "All indexers")),
          filterSelect(res, optionsOf(found, function (s) {
            var b = topCandidate(s); return b && b.resolution;
          }), setRes, tc("全部分辨率", "All resolutions")),
        ].filter(Boolean)
        : [];
      return h("div", { className: "sf-tools" + (toolsOpen ? " is-open" : "") },
        h("label", { className: "sf-search" },
          ico("search"),
          h("input", {
            type: "search", value: q,
            placeholder: tc("搜番号 / 标题 / 演员", "Search code / title / performer"),
            onChange: function (e) { setQ(e.target.value); },
          })),
        // 窄屏唯一的一枚「更多」：筛选项、视图、多选、刷新，加上当前 tab 的批量动作
        h("button", {
          className: "sf-icb sf-tools-more" + (toolsOpen ? " is-acc" : ""),
          title: tc("更多工具", "More tools"), "aria-label": tc("更多工具", "More tools"),
          "aria-expanded": toolsOpen,
          onClick: function () { setToolsOpen(!toolsOpen); },
        }, ico("more")),
        h("div", { className: "sf-tools-extra" },
          MEXTRA.length ? h("div", { className: "sf-tools-mob" }, MEXTRA) : null,
          candFilters,
          // 这一组图标在窄屏单独占一行，不至于把刷新孤零零地甩到第三行
          h("div", { className: "sf-tools-icons" },
            selToggle(),
            viewSeg(),
            refreshBtn())));
    }

    // 多选时的操作条：退出 / 计数 / 清空 / 全选 + 这一 tab 能做的批量动作
    function selActions() {
      var n = selIds().length;
      var dis = function (extra) { return n ? (extra || "") : " is-off"; };
      if (tab === "pending") {
        return [
          isWsp() ? h("button", {
            className: "sf-btn sf-btn-sm" + dis(),
            onClick: function () { runSel("push"); },
          }, ico("download"), tc("交给 Whisparr", "Send to Whisparr"))
            : h("button", {
            className: "sf-btn sf-btn-sm" + dis(),
            onClick: function () { runSel("search"); },
          }, ico("search"), tc("立即搜索", "Search")),
          h("button", {
            className: "sf-btn sf-btn-sm sf-btn-ghost" + dis(),
            onClick: function () { runSel("ignore"); },
          }, ico("ban"), tc("忽略", "Ignore")),
        ];
      }
      if (tab === "results") {
        return [
          h("button", {
            className: "sf-btn sf-btn-sm" + dis(),
            onClick: function () { runSel("push"); },
          }, ico("download"), tc("推送最佳", "Push best")),
          h("button", {
            className: "sf-btn sf-btn-sm sf-btn-ghost" + dis(),
            onClick: function () { runSel("ignore"); },
          }, ico("ban"), tc("忽略", "Ignore")),
        ];
      }
      if (tab === "downloading") {
        return [
          isWsp() ? null : h("button", {
            className: "sf-btn sf-btn-sm" + dis(),
            onClick: function () { runSel("resume"); },
          }, ico("play"), tc("继续", "Resume")),
          isWsp() ? null : h("button", {
            className: "sf-btn sf-btn-sm sf-btn-ghost" + dis(),
            onClick: function () { runSel("pause"); },
          }, ico("pause"), tc("暂停", "Pause")),
          h("button", {
            className: "sf-btn sf-btn-sm sf-btn-ghost is-danger" + dis(),
            onClick: function () { runSel("remove"); },
          }, ico("trash"), tc("移除", "Remove")),
        ].filter(Boolean);
      }
      if (tab === "done") {
        return [h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost is-danger" + dis(),
          onClick: function () { runSel("forget"); },
        }, ico("trash"), tc("移除记录", "Remove"))];
      }
      return [h("button", {
        className: "sf-btn sf-btn-sm" + dis(),
        onClick: function () { runSel("restore"); },
      }, ico("plus"), tc("恢复", "Restore"))];
    }

    function selBar() {
      if (!selOn) return null;
      var n = selIds().length;
      return h("div", { className: "sf-selbar" },
        h("button", {
          className: "sf-icb", title: tc("退出多选（Esc）", "Exit selection (Esc)"),
          onClick: exitSel,
        }, ico("x")),
        h("span", { className: "sf-selbar-n" }, tc("已选 " + n, n + " selected")),
        h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost", disabled: !n,
          onClick: function () { setSel({}); },
        }, tc("清空", "Clear")),
        h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost", disabled: !VIS.length,
          onClick: function () {
            var next = {};
            VIS.forEach(function (id) { next[id] = true; });
            setSel(next);
          },
        }, tc("全选", "Select all")),
        h("div", { className: "sf-selbar-act" }, selActions()));
    }

    // 列表模式下按天分组：今天 / 昨天 / 最近 7 天 / 更早
    function dayBucket(ts) {
      var t = Number(ts) || 0;
      if (!t) return 3;
      var days = Math.floor((Date.now() / 1000 - t) / 86400);
      if (days <= 0) return 0;
      if (days === 1) return 1;
      if (days <= 7) return 2;
      return 3;
    }
    var DAY_LABEL = [
      function () { return tc("今天", "TODAY"); },
      function () { return tc("昨天", "YESTERDAY"); },
      function () { return tc("最近 7 天", "LAST 7 DAYS"); },
      function () { return tc("更早", "EARLIER"); },
    ];

    function pill(hue, text, iconName) {
      return h("span", { className: "sf-pill is-h-" + hue },
        iconName ? ico(iconName) : null, text);
    }
    function warnPill(text) { return pill("ye", text); }

    // verdict (pass/unknown/fail) on result cards, outcome (pass/ask/reject)
    // in the dry run -- both must render, otherwise unknowns look like passes.
    function verdictPill(v) {
      if (v === "pass") return pill("gr", tc("通过", "Pass"));
      if (v === "fail" || v === "reject") return pill("re", tc("淘汰", "Rejected"));
      if (v === "unknown" || v === "ask") return pill("ye", tc("待确认", "Check"));
      return null;
    }

    // ─── cards ───────────────────────────────────────────────────────────
    var shotOf = {};
    var byId = {};
    scenes.forEach(function (s) { if (s.shot) shotOf[s.id] = s.shot; byId[s.id] = s; });

    function clockText(ts) {
      var v = Number(ts) || 0;
      if (!v) return "";
      var d = new Date(v * 1000);
      var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
      var now = new Date();
      if (d.toDateString() === now.toDateString()) return hm;
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
    }

    // ─── 通用渲染件 ───────────────────────────────────────────────────────
    function badge(hue, content, title) {
      return h("span", { className: "sf-badge " + (hue ? "is-h-" + hue : "is-mute"), title: title || "" },
        content);
    }
    // 带图标的徽章：图标与文字要作为两个子节点，不能字符串拼（会渲染成 [object Object]）
    function badgeIco(hue, iconName, text, title) {
      return h("span", { className: "sf-badge " + (hue ? "is-h-" + hue : "is-mute"), title: title || "" },
        ico(iconName), text);
    }
    function iconBtn(name, title, onClick, cls) {
      return h("button", {
        className: "sf-icb" + (cls ? " " + cls : ""), title: title,
        onClick: onClick, "aria-label": title,
      }, ico(name));
    }

    function tile(key, coverNode, body, foot) {
      var k = String(key);
      var picked = selOn && !!sel[k];
      return h("article", {
        className: "sf-tile" + (selOn ? " is-pick" : "") + (picked ? " is-sel" : ""),
        key: key,
        onClick: selOn ? function (e) {
          var t = e.target;
          if (t && t.closest && t.closest("button, a, .sf-shot--btn, .sf-title--btn")) return;
          toggleSel(k);
        } : null,
      },
        coverNode,
        h("div", { className: "sf-tile-body" }, body.filter(Boolean)),
        foot && foot.length ? h("div", { className: "sf-tile-foot" }, foot.filter(Boolean)) : null);
    }

    // 列表上方的一条：左边一句话（连接状态 / 条数），右边这一屏的批量动作。
    // 窄屏只留左边那句话，按钮搬进工具条的「更多」。
    function listBar(meta, buttons, wide) {
      var shown = (buttons || []).filter(Boolean);
      return h("div", { className: "sf-listbar" + (wide ? " sf-listbar--wide" : "") },
        h("div", { className: "sf-listbar-meta" }, meta),
        shown.length ? h("div", { className: "sf-listbar-btns" }, shown) : null);
    }

    // 分组头：图标 + 名字 + 计数 pill + 右侧折叠箭头。整行可点收起。
    function groupHead(key, hue, iconName, label, n, extra) {
      var folded = !!fold[key];
      return h("button", {
        className: "sf-gh is-h-" + hue + (folded ? " is-fold" : ""),
        onClick: function () {
          var next = Object.assign({}, fold);
          next[key] = !next[key];
          setFold(next);
        },
      },
        ico(iconName),
        h("span", { className: "sf-gh-name" }, label),
        h("span", { className: "sf-gn" }, n),
        h("span", { className: "sf-gh-tail" }, extra || null),
        ico("chevron", "sf-gh-caret"));
    }

    // 封面 + 标题是进详情的入口；卡片本身不响应点击，里面的按钮才不会被吃掉。
    function openDetail(sid) { setDetailId(String(sid)); setDlId(""); setRejFolded(true); }
    function openDl(sid) { setDlId(String(sid)); setDetailId(""); }

    // 封面：左下番号（没有番号就不占位，欧美场景本来没有），
    // 右下时长（下载中是百分比，时长就退到卡片正文里）。
    function coverOf(s, badgeNode, prog, onOpen) {
      var shot = shotOf[s.id] || s.shot || "";
      var broken = shotBroken[s.id];
      var dur = fmtDur(s.duration);
      var picked = selOn && !!sel[String(s.id)];
      return h("div", {
        className: "sf-shot sf-shot--btn" + (prog != null ? " has-prog" : ""),
        onClick: selOn ? function () { toggleSel(s.id); } : (onOpen || function () { openDetail(s.id); }),
        title: selOn ? tc("勾选", "Select") : tc("查看详情", "Open details"),
      },
        shot && !broken
          ? h("img", {
            src: shot, alt: "", loading: "lazy",
            onError: function () {
              var o = {}; o[s.id] = true; setShotBroken(Object.assign({}, shotBroken, o));
            },
          })
          : h("span", { className: "sf-shot-ph sf-lib" }, s.code || "—"),
        selOn
          ? h("span", { className: "sf-shot-check" + (picked ? " is-on" : "") },
            picked ? ico("check") : null)
          : null,
        s.code ? h("span", { className: "sf-shot-code sf-lib" }, s.code) : null,
        badgeNode || null,
        prog == null ? null : h("div", { className: "sf-shot-prog" },
          h("i", { style: { width: prog + "%" } })),
        prog != null
          ? h("span", { className: "sf-shot-pct" }, prog + "%")
          : dur ? h("span", { className: "sf-shot-dur" }, dur) : null);
    }

    function sceneLine(s) {
      var bits = [(s.performers || []).join(" / "), s.date, s.studio].filter(Boolean);
      return h("div", { className: "sf-meta" + (bits.length ? " sf-lib" : "") },
        bits.join(" · ") || "—");
    }

    // 库内容标记：sf-lib 只说明「这串来自 Stash 库」，插件自己的统计、种子名不加，
    // 外部遮蔽插件据此只遮库内容。类名本身不参与任何样式。
    // 一行里混了库内容与插件统计时（「演员 · 大小 · 3 小时前」），库那截单独包一层。
    function libLine(main, rest) {
      var out = [];
      if (main) out.push(main === "—" ? "—" : h("span", { className: "sf-lib" }, main));
      (rest || []).forEach(function (x) { if (x) out.push(" · ", x); });
      return out.length ? out : "—";
    }

    // 一行灰字的副标题，按顺序取第一个有的字段组合
    function sceneSub(s) {
      return [(s.performers || []).join(" / "), s.studio, s.date].filter(Boolean).join(" · ") || "—";
    }

    // Two rows at most: whatever does not fit collapses into a "+3" chip, so a
    // scene with fifteen tags cannot push the cover out of proportion.
    function chipRow(items, max, cls) {
      var list = (items || []).filter(Boolean);
      if (!list.length) return null;
      var shown = list.slice(0, max);
      var rest = list.length - shown.length;
      return h("div", { className: "sf-tags " + (cls || "") },
        shown.map(function (t) { return h("span", { className: "sf-tag sf-lib", key: t }, t); }),
        rest > 0 ? h("span", {
          className: "sf-tag sf-tag-more", title: list.slice(max).join("、"),
        }, "+" + rest) : null);
    }

    // 候选的物理属性：分辨率 / 体积 / 做种 / 来源站 / 免费 / 补档后缀
    // compact = 卡片与列表行：来源站名太长，会把一行徽章挤到裁切，省略它。
    function releaseBadges(c, compact) {
      var out = [];
      if (c.resolution) out.push(badge("tx3", c.resolution));
      if (c.size) out.push(badge("", humanSize(c.size)));
      if (c.seeders != null) out.push(badgeIco("", "seed", c.seeders, tc("做种数", "seeders")));
      if (c.indexer && !compact) {
        out.push(badgeIco("", "folder", c.indexer, tc("来源站", "indexer")));
      }
      if (c.freeleech) out.push(badge("gr", tc("免费", "Free"),
        tc("站点把这条标为免费：下载量不计入分享率",
          "The tracker marks this freeleech: the download does not count against your ratio")));
      if (c.tag) out.push(badge("or", c.tag, tc("补档后缀", "Re-upload suffix")));
      return out;
    }

    // 时长徽章：列表行里一枚，和分辨率/体积并排
    function durBadge(sec) {
      var d = fmtDur(sec);
      return d ? badgeIco("", "clock", d, tc("时长", "Duration")) : null;
    }

    // 为什么是这条：三态理由 chip。ok=支持，no=缺失（红字），na=只是无法判断。
    function reasonChip(kind, text) {
      return h("span", { className: "sf-rc is-" + kind }, text);
    }
    function reasonChips(s, c) {
      var out = [];
      var title = String(c.title || "").toLowerCase();
      var flat = title.replace(/[^a-z0-9]/g, "");
      if (s.code) {
        // 番号比对前两边都去掉连字符与空格：同一条资源在站点上的写法并不统一
        var code = String(s.code).toLowerCase().replace(/[^a-z0-9]/g, "");
        out.push(flat.indexOf(code) >= 0
          ? reasonChip("ok", tc("番号命中", "code matched"))
          : reasonChip("no", tc("标题无番号", "no code in name")));
      }
      if (s.date) {
        var d = String(s.date).replace(/[^0-9]/g, "");
        out.push(flat.indexOf(d) >= 0 || title.indexOf(String(s.date)) >= 0
          ? reasonChip("ok", tc("日期命中", "date matched"))
          : reasonChip("na", tc("标题无日期", "no date in name")));
      }
      if (c.isMagnet) out.push(reasonChip("na", tc("磁力无清单", "magnet, no list")));
      else if (c.hasContent === false) out.push(reasonChip("na", tc("未取到清单", "list not fetched")));
      return out;
    }
    function reasonRow(s, c) {
      var chips = reasonChips(s, c);
      return chips.length ? h("div", { className: "sf-rcs" }, chips) : null;
    }

    // Every card here is already in the tab it belongs to, so "Found" or
    // "Imported" says nothing. A badge is only worth the space when it marks
    // something a glance cannot tell: a freeleech release, or a -C/-U/-UC
    // re-upload.
    function topCandidate(s) {
      var pass = (s.candidates || []).filter(function (c) { return c.verdict === "pass"; });
      return pass.slice().sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (b.seeders || 0) - (a.seeders || 0);
      })[0];
    }

    function badgeOf(s) {
      var best = topCandidate(s);
      if (!best) return null;
      if (best.freeleech) {
        return h("span", {
          className: "sf-pill is-h-gr",
          title: tc("站点把这条标为免费：下载量不计入分享率",
            "The tracker marks this freeleech: the download does not count against your ratio"),
        }, tc("免费", "Free"));
      }
      if (best.tag) return h("span", { className: "sf-pill is-h-or" }, best.tag);
      return null;
    }

    function candRow(s, c, opts) {
      var o = opts || {};
      var i = (s.candidates || []).indexOf(c);
      var pushing = busy === "push:" + s.id;
      var pass = c.verdict === "pass";
      return h("div", {
        className: "sf-cand" + (c.verdict === "fail" ? " is-off" : "") + (o.best ? " is-best" : ""),
        key: (c.infohash || c.title || i) + "",
      },
        h("div", { className: "sf-cand-main" },
          h("div", { className: "sf-cand-title sf-lib", title: c.title }, c.title),
          h("div", { className: "sf-row-badges", style: { marginTop: "5px" } },
            releaseBadges(c)),
          c.failed && c.failed.length
            ? h("div", { className: "sf-rcs" },
              h("span", { className: "sf-rc is-no" }, tc("卡在 ", "failed ") + c.failed.join(" / ")))
            : reasonRow(s, c)),
        h("div", { className: "sf-cand-side" },
          h("button", {
            className: "sf-btn sf-btn-sm" + (pass ? "" : " sf-btn-ghost"),
            disabled: pushing,
            onClick: function () { doPush(s.id, i); },
          }, pass ? tc("推送", "Push") : tc("强推", "Push anyway"))));
    }

    // 列表行：96px 封面 + 标题/副标题 + 状态 + 徽章 + 图标按钮
    function rowOf(o) {
      var k = String(o.key);
      var picked = selOn && !!sel[k];
      var onHit = selOn ? function () { toggleSel(k); } : o.onOpen;
      return h("div", {
        className: "sf-row" + (selOn ? " is-pick" : "") + (picked ? " is-sel" : ""),
        key: o.key,
        onClick: selOn ? function (e) {
          var t = e.target;
          if (t && t.closest && t.closest("button, a, .sf-row-shot, .sf-row-title")) return;
          toggleSel(k);
        } : null,
      },
        h("div", {
          className: "sf-row-shot",
          onClick: onHit,
          title: selOn ? tc("勾选", "Select") : tc("查看详情", "Open details"),
        },
          o.shot ? h("img", { src: o.shot, alt: "", loading: "lazy" })
            : h("span", { className: "sf-shot-ph sf-lib" }, o.code || "—"),
          selOn
            ? h("span", { className: "sf-shot-check" + (picked ? " is-on" : "") },
              picked ? ico("check") : null)
            : null,
          o.prog == null ? null : h("div", { className: "sf-shot-prog" },
            h("i", { style: { width: o.prog + "%" } }))),
        h("div", { className: "sf-row-main" },
          h("div", { className: "sf-row-title" + (o.lib ? " sf-lib" : ""), title: o.title, onClick: onHit },
            o.title || tc("（无标题）", "(no title)")),
          o.sub ? h("div", { className: "sf-row-sub" }, o.sub) : null,
          o.release ? h("div", { className: "sf-row-release sf-lib", title: o.release }, o.release) : null),
        h("div", { className: "sf-row-state" }, o.state),
        h("div", { className: "sf-row-badges" }, o.badges || []),
        h("div", { className: "sf-row-act" }, (o.actions || []).filter(Boolean)));
    }

    function pendingCard(s) {
      var isBusy = busy === "search:" + s.id;
      var scr = s.screen || {};
      var cands = s.candidates || [];
      var bits = [];
      if (s.status === "no_result") {
        bits.push(tc("第 " + (s.attempts || 1) + " 次没搜到合格的",
          "attempt " + (s.attempts || 1) + ", nothing passed"));
        if (scr.fail) bits.push(tc("淘汰 " + scr.fail, scr.fail + " rejected"));
        if (s.nextSearchAt) bits.push(tc("下次 " + clockText(s.nextSearchAt), "next " + clockText(s.nextSearchAt)));
        else if ((s.attempts || 0) >= 6) bits.push(tc("已停止自动重试", "no more retries"));
      } else if (s.status === "low_confidence") {
        bits.push(tc((scr.unknown || 0) + " 个候选无法判定", (scr.unknown || 0) + " need a call"));
        if (scr.fail) bits.push(tc("淘汰 " + scr.fail, scr.fail + " rejected"));
      } else {
        bits.push(isWsp() ? tc("等待交给 Whisparr", "waiting to be sent to Whisparr")
          : tc("等待自动搜索", "waiting to be searched"));
      }
      var body = [
        h("div", {
          className: "sf-tile-title sf-title--btn sf-lib", title: s.title,
          onClick: openOf(s.id),
        }, s.title || tc("（无标题）", "(no title)")),
        sceneLine(s),
        h("div", { className: "sf-meta sf-screen-line" }, bits.join(" · ")),
        cands.length
          ? h("div", { className: "sf-meta" },
            s.status === "low_confidence"
              ? tc("搜到 " + cands.length + " 个 · 信息不全，需确认",
                  cands.length + " found · incomplete, check")
              : tc("搜到 " + cands.length + " 个，均未通过筛选",
                  cands.length + " found, none passed"))
          : null,
      ];
      if (s.error) body.push(h("div", { className: "sf-meta sf-err" }, s.error));
      return tile(s.id, coverOf(s, statusPill(s.status)),
        body,
        [
          isWsp()
            ? h("button", {
              className: "sf-btn sf-btn-md", disabled: busy === "push:" + s.id,
              onClick: function () { doPush(s.id, 0); },
            }, ico("download"), tc("交给 Whisparr", "Send to Whisparr"))
            : h("button", {
              className: "sf-btn sf-btn-md", disabled: isBusy,
              onClick: function () { doSearch(s.id); },
            }, isBusy ? tc("搜索中…", "Searching…") : tc("立即搜索", "Search")),
          iconBtn("ban", tc("忽略", "Ignore"), function () { doIgnore(s.id, false); },
            "is-danger"),
        ]);
    }

    function pendingRow(s) {
      var scr = s.screen || {};
      var isBusy = busy === "search:" + s.id;
      var extra = [];
      if (s.status === "no_result" && s.nextSearchAt) {
        extra.push(tc("下次 " + clockText(s.nextSearchAt), "next " + clockText(s.nextSearchAt)));
      } else if (s.status === "low_confidence") {
        extra.push(tc((scr.unknown || 0) + " 个待确认", (scr.unknown || 0) + " to check"));
      }
      return rowOf({
        key: s.id, code: s.code, title: s.title, lib: true,
        shot: shotOf[s.id] || s.shot || "",
        sub: libLine(sceneSub(s), extra),
        onOpen: function () { openDetail(s.id); },
        state: statusPill(s.status),
        badges: [durBadge(s.duration), badge("", tc("试过 " + (s.attempts || 0) + " 次", (s.attempts || 0) + " tries"))],
        actions: [
          isWsp()
            ? iconBtn("download", tc("交给 Whisparr", "Send to Whisparr"),
              function () { doPush(s.id, 0); }, "is-acc")
            : iconBtn("search", tc("立即搜索", "Search"), function () { doSearch(s.id); },
              isBusy ? "is-busy" : ""),
          iconBtn("ban", tc("忽略", "Ignore"), function () { doIgnore(s.id, false); }, "is-danger"),
        ],
      });
    }

    function resultCard(s) {
      var all = s.candidates || [];
      var pass = all.filter(function (c) { return c.verdict === "pass"; });
      var unk = all.filter(function (c) { return c.verdict === "unknown"; });
      var bad = all.filter(function (c) { return c.verdict === "fail"; });
      var best = pass.slice().sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (b.seeders || 0) - (a.seeders || 0);
      })[0];
      var bestIdx = best ? all.indexOf(best) : -1;
      var pushing = busy === "push:" + s.id;
      var body = [
        h("div", {
          className: "sf-tile-title sf-title--btn sf-lib", title: s.title,
          onClick: openOf(s.id),
        }, s.title || tc("（无标题）", "(no title)")),
        sceneLine(s),
        h("div", { className: "sf-score" },
          pill("gr", tc(pass.length + " 个通过", pass.length + " passed")),
          unk.length ? warnPill(tc("待确认 " + unk.length, unk.length + " to check")) : null,
          bad.length ? h("span", { className: "sf-meta sf-rej" }, tc("淘汰 " + bad.length, bad.length + " rejected")) : null),
      ];
      if (best) {
        // 绿块本身就是「最佳」的那个：不再挂文字标签，窄屏标题没地方被它挤
        body.push(h("div", { className: "sf-best" },
          h("div", { className: "sf-cand-title sf-lib", title: best.title }, best.title),
          h("div", { className: "sf-row-badges", style: { marginTop: "4px" } },
            releaseBadges(best, true))));
      }
      return tile(s.id, coverOf(s, badgeOf(s)), body, [
        best ? h("button", {
          className: "sf-btn sf-btn-md", disabled: pushing,
          onClick: function () { doPush(s.id, bestIdx); },
        }, ico("download"), pushing ? tc("推送中…", "Pushing…") : tc("推送最佳", "Push best")) : null,
        iconBtn("list", tc("详情", "Details"), function () { openDetail(s.id); }),
      ]);
    }

    function resultRow(s) {
      var all = s.candidates || [];
      var pass = all.filter(function (c) { return c.verdict === "pass"; });
      var unk = all.filter(function (c) { return c.verdict === "unknown"; });
      var best = pass.slice().sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (b.seeders || 0) - (a.seeders || 0);
      })[0];
      var bestIdx = best ? all.indexOf(best) : -1;
      var pushing = busy === "push:" + s.id;
      return rowOf({
        key: s.id, code: s.code, title: s.title, lib: true,
        shot: shotOf[s.id] || s.shot || "",
        sub: libLine(sceneSub(s)),
        release: best ? best.title : "",
        onOpen: function () { openDetail(s.id); },
        state: h("div", null,
          pill("gr", tc(pass.length + " 通过", pass.length + " passed")),
          unk.length ? h("div", { className: "sf-meta" },
            tc(unk.length + " 待确认", unk.length + " to check")) : null),
        badges: (best ? releaseBadges(best, true) : []).concat([durBadge(s.duration)]),
        actions: [
          best ? iconBtn("download", tc("推送最佳", "Push best"),
            function () { doPush(s.id, bestIdx); }, "is-acc" + (pushing ? " is-busy" : "")) : null,
          iconBtn("list", tc("详情", "Details"), function () { openDetail(s.id); }),
        ],
      });
    }

    // 任务状态：ready 优先（可入库），其余走 SMETA；missing 单独一个
    function progStateOf(p) {
      if (p.ready) return "downloaded";
      if (p.state === "missing") return "missing";
      return "pushed";
    }

    function progressCard(p) {
      var importing = busy === "import:" + p.sceneId;
      var acting = busy === "torrent:" + p.sceneId;
      var paused = isPaused(p.state);
      var done = pct(p.progress);
      var sc = byId[p.sceneId] || {};
      var dur = fmtDur(sc.duration);
      var body = [
        h("div", { className: "sf-tile-title sf-lib", title: p.name },
          p.code || p.name || "—"),
        h("div", { className: "sf-meta sf-lib", title: p.name }, p.name || ""),
        h("div", { className: "sf-meta" },
          humanSize(p.downloaded) + " / " + humanSize(p.size) +
          (p.ready ? "" : (p.dlspeed ? " · " + humanSize(p.dlspeed) + "/s" : "") +
            (p.eta ? " · ETA " + etaText(p.eta) : "")) +
          (dur ? " · " + dur : "")),
      ];
      var foot = [];
      if (p.ready) foot.push(h("button", {
        className: "sf-btn sf-btn-md", disabled: importing,
        onClick: function () { doImport(p.sceneId); },
      }, ico("download"), importing ? tc("入库中…", "Importing…") : tc("入库", "Import")));
      if (!isWsp() && !p.ready && p.state !== "missing") foot.push(iconBtn(
        paused ? "play" : "pause",
        paused ? tc("继续", "Resume") : tc("暂停", "Pause"),
        function () { doTorrent(p, paused ? "resume" : "pause"); },
        acting ? "is-busy" : ""));
      if (!p.ready) foot.push(iconBtn("trash", tc("移除", "Remove"),
        function () { doTorrent(p, "remove"); }, "is-danger"));
      return tile(p.sceneId, coverOf({
        id: p.sceneId, code: p.code || "", duration: sc.duration || 0,
        shot: p.shot || sc.shot || "",
      }, paused
        ? Api.React.createElement("span", { className: "sf-pill is-h-ye" },
            ico("pause"), tc("已暂停", "Paused"))
        : statusPill(progStateOf(p)), p.ready ? null : done,
        function () { openDl(p.sceneId); }), body, foot);
    }

    function progressRow(p) {
      var importing = busy === "import:" + p.sceneId;
      var acting = busy === "torrent:" + p.sceneId;
      var paused = isPaused(p.state);
      var done = pct(p.progress);
      var rate = p.ready ? "" : [
        p.dlspeed ? humanSize(p.dlspeed) + "/s" : "",
        p.eta ? "ETA " + etaText(p.eta) : "",
      ].filter(Boolean).join(" · ");
      return rowOf({
        key: p.sceneId, code: p.code, title: p.code || p.name, lib: true,
        shot: p.shot || (byId[p.sceneId] || {}).shot || "",
        sub: [humanSize(p.size), rate].filter(Boolean).join(" · "),
        release: p.name || "",
        prog: p.ready ? null : done,
        onOpen: function () { openDl(p.sceneId); },
        state: h("div", null,
          statusPill(progStateOf(p)),
          p.ready ? null : h("div", { className: "sf-meta" },
            done + "% · " + humanSize(p.downloaded))),
        badges: [durBadge((byId[p.sceneId] || {}).duration), badge("", paused ? tc("已暂停", "paused") : tc("进行中", "active"))],
        actions: [
          p.ready ? iconBtn("download", tc("入库", "Import"),
            function () { doImport(p.sceneId); }, "is-acc" + (importing ? " is-busy" : "")) : null,
          !isWsp() && !p.ready && p.state !== "missing" ? iconBtn(paused ? "play" : "pause",
            paused ? tc("继续", "Resume") : tc("暂停", "Pause"),
            function () { doTorrent(p, paused ? "resume" : "pause"); }, acting ? "is-busy" : "") : null,
          !p.ready ? iconBtn("trash", tc("移除", "Remove"),
            function () { doTorrent(p, "remove"); }, "is-danger") : null,
          iconBtn("list", tc("详情", "Details"), function () { openDl(p.sceneId); }),
        ],
      });
    }

    // 连接状态一行：下载器通不通 + 守护心跳。并入列表条左侧，不再单占一行。
    function connLine() {
      var d = (ctrl && ctrl.daemon) || {};
      var ok = conn ? conn.ok : true;
      var dn = dlName();
      return h("span", { className: "sf-conn" + (ok ? " is-ok" : " is-bad") },
        h("span", { className: "sf-dot" }),
        h("span", { className: "sf-conn-text" },
          ok ? tc(dn + " 已连接", dn + " connected")
            : tc(dn + " 连接失败：", dn + " failed: ") + ((conn && conn.error) || "")),
        h("span", { className: "sf-meta" },
          d.alive
            ? tc("守护中 · " + agoText(d.ago) + "前心跳", "worker alive · " + agoText(d.ago) + " ago")
            : tc("页面驱动，关页即停", "page-driven, stops when closed")));
    }

    function autoFlags(c) {
      var flags = [
        isWsp() ? null : ["autoSearch", tc("自动搜索", "Search")],
        ["autoPush", isWsp() ? tc("自动加片", "Add") : tc("自动推送", "Push")],
        ["autoImport", tc("自动入库", "Import")],
      ].filter(Boolean);
      return flags.map(function (f, i) {
        var isOn = !!c[f[0]];
        return h("button", {
          className: "sf-auto-flag" + (isOn ? " is-on" : ""),
          key: i,
          title: isOn ? tc("点击关闭", "Click to turn off") : tc("点击开启", "Click to turn on"),
          onClick: function () { flipFlag(f[0]); },
        },
          h("i", { className: "sf-auto-dot" }),
          f[1]);
      });
    }

    function flipFlag(key) {
      var c = (ctrl && ctrl.control) || {};
      if (!ctrl) return;
      var next = Object.assign({}, c);
      next[key] = !next[key];
      var label = { autoSearch: tc("自动搜索", "Search"),
        autoPush: isWsp() ? tc("自动加片", "Add") : tc("自动推送", "Push"),
        autoImport: tc("自动入库", "Import") }[key] || key;
      saveControl(next, label + (next[key] ? tc(" 已开", " on") : tc(" 已关", " off")));
    }

    function autoBar() {
      var c = (ctrl && ctrl.control) || {};
      var d = (ctrl && ctrl.daemon) || {};
      var keys = isWsp() ? ["autoPush", "autoImport"] : ["autoSearch", "autoPush", "autoImport"];
      var on = keys.filter(function (k) { return c[k]; }).length;
      var flags = autoFlags(c);
      // 窄屏三个开关藏起来，改从工具条的「更多」里点（同一组按钮，换了个位置）
      MEXTRA.push(h("div", { className: "sf-auto-flags", key: "auto-mob" }, autoFlags(c)));
      return h("div", { className: "sf-autobar" + (on === 0 ? " is-idle" : "") },
        h("div", { className: "sf-auto-flags" }, flags),
        h("span", { className: "sf-meta" },
          on === 0 ? tc("自动化全部关闭，不会自己动", "all automation off")
            : d.alive ? tc("守护中 · " + agoText(d.ago) + "前心跳", "worker alive · " + agoText(d.ago) + " ago")
              : tc("页面驱动，关页即停", "page-driven, stops when closed")),
        d.alive ? null : h("button", {
          className: "sf-btn sf-btn-sm", disabled: busy === "daemon",
          onClick: toggleDaemon,
        }, tc("后台运行", "Run in background")),
        h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost",
          onClick: function () { switchTab("settings"); },
        }, tc("设置", "Settings")));
    }

    function doneCard(p) {
      var s = byId[p.sceneId] || {};
      var body = [
        h("div", {
          className: "sf-tile-title sf-title--btn sf-lib", title: s.title || p.name,
          onClick: openOf(p.sceneId, openDl),
        }, s.title || p.code || p.name || "—"),
        sceneLine(s),
        h("div", { className: "sf-meta" }, humanSize(p.size)),
      ];
      return tile(p.sceneId, coverOf({
        id: p.sceneId, code: p.code || s.code || "", duration: s.duration || 0,
        shot: p.shot || s.shot || "",
      }, statusPill("imported"), null, function () { openDl(p.sceneId); }), body, [
        h("a", { className: "sf-btn sf-btn-md sf-btn-link", href: appUrl("/scenes/" + p.sceneId) },
          tc("打开", "Open")),
      ]);
    }

    function doneRow(p) {
      var s = byId[p.sceneId] || {};
      return rowOf({
        key: p.sceneId, code: p.code || s.code, title: s.title || p.code || p.name, lib: true,
        shot: p.shot || s.shot || "",
        sub: libLine(sceneSub(s), [humanSize(p.size),
          p.at ? agoText(Math.round(Date.now() / 1000 - p.at)) + tc("前", " ago") : ""]),
        release: p.name || "",
        onOpen: function () { openDl(p.sceneId); },
        state: statusPill("imported"),
        badges: [durBadge(s.duration)],
        actions: [h("a", {
          className: "sf-icb", href: appUrl("/scenes/" + p.sceneId), target: "_blank",
          rel: "noreferrer", title: tc("打开场景", "Open scene"),
        }, ico("external"))],
      });
    }

    function ignoredCard(s) {
      return tile(s.id, coverOf(s, statusPill("ignored")), [
        h("div", {
          className: "sf-tile-title sf-title--btn sf-lib", title: s.title,
          onClick: openOf(s.id),
        }, s.title || s.code || "—"),
        sceneLine(s),
      ], [
        h("button", {
          className: "sf-btn sf-btn-md sf-btn-ghost",
          onClick: function () { doIgnore(s.id, true); },
        }, ico("plus"), tc("恢复", "Restore")),
      ]);
    }

    function ignoredRow(s) {
      return rowOf({
        key: s.id, code: s.code, title: s.title, lib: true,
        shot: shotOf[s.id] || s.shot || "",
        sub: libLine(sceneSub(s)),
        onOpen: function () { openDetail(s.id); },
        state: statusPill("ignored"),
        badges: [durBadge(s.duration)],
        actions: [iconBtn("plus", tc("恢复", "Restore"), function () { doIgnore(s.id, true); })],
      });
    }

    // ─── rule form ────────────────────────────────────────────────────────
    // The DSL stays the storage format; this form only writes the lines it
    // owns and keeps everything else verbatim, so nothing the user typed can
    // be lost by touching a dropdown.
    var RES_CHOICES = ["2160p", "1080p", "720p"];
    var FORMAT_CHOICES = ["mp4", "mkv", "wmv", "avi", "ts", "m2ts", "mov", "m4v", "iso"];
    var FILE_SCOPE = [
      { id: "video", re: "\\.(mp4|mkv|wmv|ts|m2ts|avi|mov|m4v)$" },
      { id: "videoSub", re: "\\.(mp4|mkv|wmv|ts|m2ts|avi|mov|m4v|srt|ass|ssa|sub|idx)$" },
      { id: "all", re: "" },
    ];
    var EXCLUDE_SCOPE = [
      { id: "samples", re: "(^|/)samples?/" },
      { id: "none", re: "" },
    ];
    var SHARE_CHOICES = [
      { v: 0, zh: "不过滤", en: "Off" },
      { v: 0.1, zh: "≥ 10%", en: "≥ 10%" },
      { v: 0.3, zh: "≥ 30%（默认）", en: "≥ 30% (default)" },
      { v: 0.6, zh: "≥ 60%", en: "≥ 60%" },
    ];

    function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    function wordsOf(s) {
      return String(s || "").split(/[\s,，、]+/).filter(function (w) { return !!w; });
    }
    function mbLine(mb) {
      var n = Number(mb) || 0;
      if (n >= 1024) return "video_bytes >= " + (Math.round(n / 102.4) / 10) + "G";
      return "video_bytes >= " + Math.round(n) + "M";
    }
    function mbFromRaw(raw) {
      var m = /^([\d.]+)\s*([KMGTPkmgtp])?/.exec(String(raw).trim());
      if (!m) return "";
      var n = parseFloat(m[1]);
      var u = (m[2] || "").toUpperCase();
      var f = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 }[u];
      if (!f) return String(Math.round(n / 1024 / 1024));   // bare bytes
      return String(Math.round(n * f));
    }
    function emptyForm() {
      return { minSeed: "", res: [], minMB: "", maxFiles: "", must: "", ban: "", banPack: "", fmt: [], extra: "" };
    }
    function parseForm(text) {
      var f = emptyForm();
      var extra = [];
      String(text || "").split("\n").forEach(function (line) {
        var s = line.trim();
        if (!s) return;
        var m = /^([a-z_]+)\s*(!?in|!?has|>=|<=|==|>|<)\s*(.+)$/i.exec(s);
        var field = m ? m[1].toLowerCase() : "";
        var op = m ? m[2].toLowerCase() : "";
        var raw = m ? m[3].trim() : "";
        if (field === "seeders" && op === ">=") { f.minSeed = String(parseFloat(raw) || ""); return; }
        if (field === "filecount" && op === "<=") { f.maxFiles = String(parseFloat(raw) || ""); return; }
        if (field === "video_bytes" && op === ">=") { f.minMB = mbFromRaw(raw); return; }
        if (field === "resolution" && op === "in") {
          f.res = raw.replace(/^\[|\]$/g, "").split(",")
            .map(function (x) { return x.trim().replace(/^["']|["']$/g, "").toLowerCase(); })
            .filter(Boolean);
          return;
        }
        if (field === "format" && op === "in") {
          f.fmt = raw.replace(/^\[|\]$/g, "").split(",")
            .map(function (x) { return x.trim().replace(/^["']|["']$/g, "").toLowerCase(); })
            .filter(Boolean);
          return;
        }
        if (field === "title" && (op === "has" || op === "!has")) {
          var body = raw.replace(/^\/|\/[a-z]*$/gi, "");
          if (body === raw) body = raw;
          var words = body.split("|").map(function (w) {
            return w.replace(/\\(.)/g, "$1").trim();
          }).filter(Boolean);
          if (op === "has") f.must = words.join(" ");
          else f.ban = words.join(" ");
          return;
        }
        if (field === "anytext" && op === "!has") {
          var body2 = raw.replace(/^\/|\/[a-z]*$/gi, "");
          f.banPack = body2.split("|").map(function (w) {
            return w.replace(/\\(.)/g, "$1").trim();
          }).filter(Boolean).join(" ");
          return;
        }
        extra.push(s);
      });
      f.extra = extra.join("\n");
      return f;
    }
    function buildText(f) {
      var lines = [];
      if (Number(f.minSeed) > 0) lines.push("seeders >= " + Math.round(Number(f.minSeed)));
      if ((f.res || []).length) lines.push("resolution in [" + f.res.join(", ") + "]");
      if ((f.fmt || []).length) lines.push("format in [" + f.fmt.join(", ") + "]");
      if (Number(f.minMB) > 0) lines.push(mbLine(Number(f.minMB)));
      if (Number(f.maxFiles) > 0) lines.push("filecount <= " + Math.round(Number(f.maxFiles)));
      var must = wordsOf(f.must);
      if (must.length) lines.push("title has /" + must.map(escRe).join("|") + "/i");
      var ban = wordsOf(f.ban);
      if (ban.length) lines.push("title !has /" + ban.map(escRe).join("|") + "/i");
      var pack = wordsOf(f.banPack);
      if (pack.length) lines.push("anytext !has /" + pack.map(escRe).join("|") + "/i");
      if (String(f.extra || "").trim()) lines.push(String(f.extra).trim());
      return lines.join("\n");
    }
    function matchPreset(list, re) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].re === (re || "")) return list[i].id;
      }
      return "";
    }

    // ─── settings ─────────────────────────────────────────────────────────
    function field(label, control, hint) {
      return h("label", { className: "sf-field" },
        h("span", { className: "sf-field-label" }, label),
        control,
        hint ? h("span", { className: "sf-field-hint" }, hint) : null);
    }

    function patch(key, value) {
      var o = Object.assign({}, draft);
      o[key] = value;
      setDraft(o);
    }

    function automationPanel() {
      if (!ctrlDraft) return h("div", { className: "sf-empty" }, tc("加载中…", "Loading…"));
      var d = (ctrl && ctrl.daemon) || {};
      var alive = !!d.alive;
      var gi = (ctrl && ctrl.gate) || { used: 0, limit: 0, open: true };
      var switches = [
        isWsp() ? null : { key: "autoSearch", label: tc("捕获 → 搜索", "Capture → search"),
          hint: tc("新空场景自动搜，搜不到逐级退避", "Searches new empty scenes; misses back off") },
        { key: "autoPush", label: isWsp() ? tc("捕获 → 加片", "Capture → add")
            : tc("筛选 → 推送", "Filter → push"),
          hint: isWsp() ? tc("新空场景自动交给 Whisparr", "Hands new empty scenes to Whisparr")
            : tc("规则全过才推，无法判定按规则区处置", "Only what passes every rule") },
        { key: "autoImport", label: tc("下载 → 入库", "Download → import"),
          hint: isWsp() ? tc("Whisparr 导入后自动扫描、合并，不搬文件", "Scans and merges after Whisparr imports; files stay put")
            : tc("下载完自动扫描、关联，不搬文件", "Scans and links on finish; files stay put") },
      ].filter(Boolean);
      function toggle(key, checked) {
        var o = Object.assign({}, ctrlDraft);
        o[key] = checked;
        setCtrlDraft(o);
      }
      function num(key, value) {
        var o = Object.assign({}, ctrlDraft);
        o[key] = value;
        setCtrlDraft(o);
      }
      return h("section", { className: "sf-panel sf-panel--auto" },
        panelHead("clock", "自动化", "Automation",
          h("span", { className: "sf-panel-tag" },
            alive ? tc("守护中 · " + agoText(d.ago) + "前", "worker alive · " + agoText(d.ago) + " ago")
              : d.stopping ? tc("正在停止", "stopping")
                : tc("守护未运行", "worker stopped"))),
        h("div", { className: "sf-toggles" }, switches.map(function (sw) {
          return h("label", { className: "sf-toggle sf-toggle--row", key: sw.key },
            h("span", { className: "sf-toggle-text" },
              h("b", null, sw.label),
              h("span", { className: "sf-meta" }, sw.hint)),
            h("input", {
              type: "checkbox", checked: !!ctrlDraft[sw.key],
              onChange: function (e) { toggle(sw.key, e.target.checked); },
            }));
        })),
        h("div", { className: "sf-grid2 sf-grid2--cards" },
          field(tc("总量上限 GB", "Total limit GB"),
            h("input", {
              className: "sf-input", type: "number", min: "0", step: "1",
              value: ctrlDraft.maxTotalGB,
              onChange: function (e) { num("maxTotalGB", e.target.value); },
            }), tc("未入库的下载总量，0 = 不限", "In-flight bytes, 0 = no limit")),
          field(tc("每日条数", "Per day"),
            h("input", {
              className: "sf-input", type: "number", min: "0", step: "1",
              value: ctrlDraft.maxPerDay,
              onChange: function (e) { num("maxPerDay", e.target.value); },
            }), tc("24 小时内最多推几条，0 = 不限", "Pushes per 24 h, 0 = no limit"))),
        h("div", { className: "sf-actions sf-actions--foot" },
          h("span", { className: "sf-meta" },
            gi.limit > 0
              ? tc("占用 " + humanSize(gi.used) + " / " + humanSize(gi.limit) + (gi.open ? "" : " · 已触顶"),
                humanSize(gi.used) + " / " + humanSize(gi.limit) + (gi.open ? "" : " · at limit"))
              : tc("占用 " + humanSize(gi.used), humanSize(gi.used) + " in flight"),
            d.lastAction ? " · " + tc("最近：", "last: ") + d.lastAction : ""),
          h("button", {
            className: "sf-btn sf-btn-md", disabled: busy === "control",
            onClick: function () { saveControl(ctrlDraft); },
          }, tc("保存", "Save")),
          h("button", {
            className: "sf-btn sf-btn-md sf-btn-ghost", disabled: busy === "daemon",
            onClick: toggleDaemon,
          }, alive ? tc("停止守护", "Stop worker") : tc("启动守护", "Start worker"))));
    }

    function rulesPanel() {
      if (!draft) return h("div", { className: "sf-empty" }, tc("加载中…", "Loading…"));
      var f = ruleForm || emptyForm();
      function setF(key, value) {
        var o = {};
        Object.keys(f).forEach(function (k) { o[k] = f[k]; });
        o[key] = value;
        setRuleForm(o);
      }
      function toggleRes(r) {
        var list = (f.res || []).slice();
        var i = list.indexOf(r);
        if (i >= 0) list.splice(i, 1); else list.push(r);
        setF("res", list);
      }
      function toggleFmt(x) {
        var list = (f.fmt || []).slice();
        var i = list.indexOf(x);
        if (i >= 0) list.splice(i, 1); else list.push(x);
        setF("fmt", list);
      }
      function pickPreset(key, list, id) {
        var hit = list.filter(function (x) { return x.id === id; })[0];
        patch(key, hit ? hit.re : (draft[key] || ""));
      }
      var selId = matchPreset(FILE_SCOPE, draft.fileSelect);
      var excId = matchPreset(EXCLUDE_SCOPE, draft.fileExclude);
      var shareId = "";
      SHARE_CHOICES.forEach(function (s) {
        if (Math.abs(Number(draft.fileMinShare) - s.v) < 0.001) shareId = String(s.v);
      });
      var numInput = function (key, hint, step) {
        return h("input", {
          className: "sf-input", type: "number", min: "0", step: step || "1",
          value: f[key], placeholder: tc("不限", "any"),
          onChange: function (e) { setF(key, e.target.value); },
        });
      };
      return h("section", { className: "sf-panel sf-panel--rules sf-panel--wide" },
        panelHead("check", "筛选规则", "Rules",
          h("span", { className: "sf-meta" },
            tc("全部满足才通过", "Every rule must pass"))),
        h("div", { className: "sf-form" },
          h("div", { className: "sf-form-row" },
            field(tc("最低做种", "Min seeders"), numInput("minSeed"),
              tc("低于这个数的不要", "Releases below this are dropped")),
            field(tc("最多文件数", "Max files"), numInput("maxFiles"),
              tc("整包塞太多零碎文件的不要", "Keeps out packs of many small files")),
            field(tc("视频最少体积 MB", "Min video size MB"),
              numInput("minMB", "", "10"),
              tc("整包视频总量，1000 = 1GB；磁力按整包体积算", "Total video bytes; 1000 = 1GB. Magnets use the release size"))),
          h("div", { className: "sf-form-row" },
            h("div", { className: "sf-field sf-field-wide" },
              h("span", { className: "sf-field-label" }, tc("分辨率", "Resolution")),
              h("div", { className: "sf-chips" },
                RES_CHOICES.map(function (r) {
                  var on = (f.res || []).indexOf(r) >= 0;
                  return h("button", {
                    key: r, type: "button",
                    className: "sf-chip" + (on ? " is-on" : ""),
                    onClick: function () { toggleRes(r); },
                  }, r);
                }),
                h("span", { className: "sf-field-hint" },
                  (f.res || []).length ? tc("只留选中的", "Only these")
                    : tc("不选 = 不限", "None selected = any"))))),
          h("div", { className: "sf-form-row" },
            h("div", { className: "sf-field sf-field-wide" },
              h("span", { className: "sf-field-label" }, tc("视频格式", "Video format")),
              h("div", { className: "sf-chips" },
                FORMAT_CHOICES.map(function (x) {
                  var on = (f.fmt || []).indexOf(x) >= 0;
                  return h("button", {
                    key: x, type: "button",
                    className: "sf-chip" + (on ? " is-on" : ""),
                    onClick: function () { toggleFmt(x); },
                  }, x.toUpperCase());
                }),
                h("span", { className: "sf-field-hint" },
                  (f.fmt || []).length
                    ? tc("只留选中的；取消 ISO 即忽略 ISO 资源", "Only these; untick ISO to ignore ISO releases")
                    : tc("不选 = 不限", "None selected = any"))))),
          h("div", { className: "sf-form-row" },
            field(tc("标题必须包含", "Title must contain"),
              h("input", {
                className: "sf-input", value: f.must, spellCheck: false,
                placeholder: tc("可不填，多个用空格分隔", "Optional, space separated"),
                onChange: function (e) { setF("must", e.target.value); },
              })),
            field(tc("标题排除", "Title must not contain"),
              h("input", {
                className: "sf-input", value: f.ban, spellCheck: false,
                placeholder: tc("可不填，多个用空格分隔", "Optional, space separated"),
                onChange: function (e) { setF("ban", e.target.value); },
              }))),
          h("div", { className: "sf-form-row" },
            h("div", { className: "sf-field sf-field-wide" },
              h("span", { className: "sf-field-label" },
                tc("整包拉黑关键词", "Reject the whole release")),
              h("input", {
                className: "sf-input", value: f.banPack, spellCheck: false,
                placeholder: tc("例如：乐鱼 第一会所", "e.g. a watermark or a spam site"),
                onChange: function (e) { setF("banPack", e.target.value); },
              }),
              h("span", { className: "sf-field-hint" },
                tc("标题或包内任一文件名命中就整包不要，空格分隔多个，留空 = 不启用",
                  "Matched in the title or any file name; space separated, empty = off")))),
          h("div", { className: "sf-form-row" },
            field(tc("下载哪些文件", "Which files"),
              h("select", {
                className: "sf-input", value: selId || "custom",
                onChange: function (e) { pickPreset("fileSelect", FILE_SCOPE, e.target.value); },
              }, FILE_SCOPE.map(function (o) {
                var zh = o.id === "video" ? "只要视频" : o.id === "videoSub" ? "视频 + 字幕" : "全部文件";
                var en = o.id === "video" ? "Videos only" : o.id === "videoSub" ? "Videos + subtitles" : "Everything";
                return h("option", { value: o.id, key: o.id }, tc(zh, en));
              }).concat(selId ? [] : [h("option", { value: "custom", key: "custom" },
                tc("自定义", "Custom"))]))),
            field(tc("样片目录", "Sample clips"),
              h("select", {
                className: "sf-input", value: excId || "custom",
                onChange: function (e) { pickPreset("fileExclude", EXCLUDE_SCOPE, e.target.value); },
              }, EXCLUDE_SCOPE.map(function (o) {
                return h("option", { value: o.id, key: o.id },
                  o.id === "samples" ? tc("跳过", "Skip") : tc("一起下", "Download"));
              }).concat(excId ? [] : [h("option", { value: "custom", key: "custom" },
                tc("自定义", "Custom"))])),
              tc("种子里的 Sample 短片", "The Sample clip some releases carry")),
            field(tc("小文件门槛", "Small files"),
              h("select", {
                className: "sf-input", value: shareId || "custom",
                onChange: function (e) {
                  if (e.target.value !== "custom") patch("fileMinShare", e.target.value);
                },
              }, SHARE_CHOICES.map(function (s) {
                return h("option", { value: String(s.v), key: s.v }, tc(s.zh, s.en));
              }).concat(shareId ? [] : [h("option", { value: "custom", key: "custom" },
                tc("自定义", "Custom"))])),
              tc("低于正片这个体积比例的附带文件不下", "Attached files below this share of the main video")),
            field(tc("规则无法判定时", "When undecidable"),
              h("select", {
                className: "sf-input", value: draft.unknown || "ask",
                onChange: function (e) { patch("unknown", e.target.value); },
              }, ["ask", "allow", "reject"].map(function (k) {
                return h("option", { value: k, key: k }, UNKNOWN_POLICY[k]());
              })), tc("磁力看不到包内文件", "Magnets hide their files"))),
          h("details", { className: "sf-adv" },
            h("summary", null, tc("其他规则（高级）", "Other rules (advanced)")),
            h("div", { className: "sf-rank" },
              h("div", { className: "sf-rank-head" },
                tc("怎么选出「最佳」", "How the best release is picked")),
              h("div", { className: "sf-rank-row" },
                h("span", null, tc("番号出现在标题里", "Code in the release name")),
                h("code", null, "+0.6")),
              h("div", { className: "sf-rank-row" },
                h("span", null, tc("发布日期出现在标题里", "Release date in the name")),
                h("code", null, "+0.2")),
              h("div", { className: "sf-rank-row" },
                h("span", null, tc("搜索词其余部分的重合度", "Rest of the query, by overlap")),
                h("code", null, "≤ +0.2")),
              h("div", { className: "sf-rank-row" },
                h("span", null, tc("带 -C / -U / -UC 后缀（需勾选）", "-C / -U / -UC re-upload (if ticked)")),
                h("code", null, "+0.25")),
              h("div", { className: "sf-rank-row" },
                h("span", null, tc("含「最新地址」文件（需勾选）", "Carries a 最新地址 note (if ticked)")),
                h("code", null, "+0.30")),
              h("span", { className: "sf-field-hint" },
                tc("只在已经通过筛选的候选里比，同分取做种多的；分数不参与淘汰",
                  "Compared only among candidates that already passed; ties go to more seeders. The score never rejects anything"))),
            h("div", { className: "sf-prefs" },
              h("label", { className: "sf-check-inline" },
                h("input", {
                  type: "checkbox", checked: !!draft.preferSuffix,
                  onChange: function (e) { patch("preferSuffix", e.target.checked); },
                }),
                h("span", null, tc("带 -C / -U / -UC 后缀的优先", "-C / -U / -UC re-uploads first"))),
              h("label", { className: "sf-check-inline" },
                h("input", {
                  type: "checkbox", checked: !!draft.preferAdFile,
                  onChange: function (e) { patch("preferAdFile", e.target.checked); },
                }),
                h("span", null, tc("含「最新地址」文件的优先", "Releases carrying a 最新地址 note")))),
            h("textarea", {
              className: "sf-textarea", rows: 4, spellCheck: false,
              value: f.extra || "",
              placeholder: "largest_video_share >= 0.2",
              onChange: function (e) { setF("extra", e.target.value); },
            }),
            h("span", { className: "sf-field-hint" },
              tc("这一框里的行原样生效，通常不用动", "These lines apply verbatim; usually leave them alone")))),
        ruleErrors.length
          ? h("div", { className: "sf-errors" }, ruleErrors.map(function (e) {
            return h("div", { className: "sf-err", key: e.line },
              tc("第 " + e.line + " 行", "Line " + e.line) + " · " + e.text + " — " + e.error);
          }))
          : null,
        h("div", { className: "sf-actions" },
          h("button", {
            className: "sf-btn sf-btn-md", disabled: busy === "rules",
            onClick: function () {
              saveRules(Object.assign({}, draft, { text: buildText(ruleForm || emptyForm()) }));
            },
          }, tc("保存规则", "Save rules")),
          h("button", {
            className: "sf-btn sf-btn-md sf-btn-ghost", disabled: busy === "rules" || !defaults,
            onClick: function () {
              if (!defaults) return;
              setRuleForm(parseForm(defaults.text));
              saveRules(defaults, tc("已恢复默认", "Defaults restored"));
            },
          }, tc("恢复默认", "Defaults"))));
    }

    function ruleLine(r, total) {
      var killed = r.fail + ((evalResult && evalResult.unknown === "reject") ? r.unknown : 0);
      return h("div", { className: "sf-rule" + (killed ? " is-hit" : ""), key: r.line },
        h("code", { className: "sf-rule-text" }, r.text),
        h("span", { className: "sf-meta" },
          killed + "/" + total + " " + tc("淘汰", "rejected")),
        r.unknown ? h("span", { className: "sf-meta sf-unknown" },
          r.unknown + " " + tc("未知", "unknown")) : null);
    }

    function evalRows() {
      return (evalResult.candidates || []).map(function (r, i) {
        var bits = [(r.seeders || 0) + tc(" 做种", " seeds"), humanSize(r.size)];
        if (r.resolution) bits.push(r.resolution);
        if (r.indexer) bits.push(r.indexer);
        if (r.select) {
          bits.push(tc("选集 " + r.select.kept + "/" + r.select.total + " · " + humanSize(r.select.bytes),
            "picks " + r.select.kept + "/" + r.select.total + " · " + humanSize(r.select.bytes)));
          if (r.select.note) bits.push(tc("回退：最大视频", "fallback: largest"));
        }
        if (r.isMagnet) bits.push(tc("磁力", "magnet"));
        if (r.error) bits.push(r.error);
        return h("div", {
          className: "sf-cand sf-cand-eval" + (r.outcome === "reject" ? " is-off" : ""),
          key: "e" + i,
        },
          h("div", { className: "sf-cand-main" },
            h("div", { className: "sf-cand-title sf-lib", title: r.title }, r.title),
            h("div", { className: "sf-meta" }, bits.join(" · ")),
            r.select && r.select.names && r.select.names.length && r.select.kept < r.select.total
              ? h("div", { className: "sf-meta sf-picked sf-lib" }, r.select.names.join("  "))
              : null,
            r.failed && r.failed.length
              ? h("div", { className: "sf-meta sf-err" }, tc("卡在：", "failed: ") + r.failed.join(" / "))
              : null),
          verdictPill(r.outcome));
      });
    }

    function evalPanel() {
      var total = (evalResult && evalResult.candidates) ? evalResult.candidates.length : 0;
      return h("section", { className: "sf-panel sf-panel--eval sf-panel--wide" },
        panelHead("play", "试运行", "Dry run",
          h("div", { className: "sf-head-right" },
            h("select", {
              className: "sf-input sf-select", value: evalPick || (withCands[0] && withCands[0].id) || "",
              onChange: function (e) { setEvalPick(e.target.value); },
            }, withCands.length ? withCands.map(function (s) {
              return h("option", { value: s.id, key: s.id },
                (s.code || s.title || s.id) + " · " + (s.candidates || []).length);
            }) : h("option", { value: "" }, tc("没有已搜索的场景", "nothing searched yet"))),
            h("button", {
              className: "sf-btn sf-btn-md",
              disabled: !withCands.length || !!evalBusy,
              onClick: function () { runEval(evalPick || (withCands[0] && withCands[0].id)); },
            }, evalBusy ? tc("预检中…", "Fetching…") : tc("运行", "Run")))),
        evalResult
          ? h("div", null,
            evalResult.errors && evalResult.errors.length
              ? h("div", { className: "sf-errors" }, evalResult.errors.map(function (e) {
                return h("div", { className: "sf-err", key: "x" + e.line },
                  tc("第 " + e.line + " 行", "Line " + e.line) + " · " + e.error);
              }))
              : null,
            h("div", { className: "sf-rules" },
              (evalResult.rules || []).map(function (r) { return ruleLine(r, total); })),
            h("div", { className: "sf-meta sf-eval-sum" },
              tc("未预检 " + (evalResult.pending || 0) + " 个 · 无法判定的按「" +
                UNKNOWN_POLICY[evalResult.unknown || "ask"]() + "」处理",
                (evalResult.pending || 0) + " not prefetched · unknown treated as \"" +
                UNKNOWN_POLICY[evalResult.unknown || "ask"]() + "\"")),
            h("div", { className: "sf-cands" }, evalRows()))
          : h("div", { className: "sf-empty" },
            withCands.length
              ? tc("选一个场景点运行：先抓种子清单，再逐条统计淘汰数",
                "Pick a scene and run: fetch torrents, then count what each rule kills")
              : tc("先去搜一次，才有候选可试运行", "Search something first")));
    }

    // ─── 详情弹窗（挑资源的地方）───────────────────────────────────────────
    // 只负责「这个场景有哪些资源、该推哪条」；已经在下载的场景走 dlModal。
    function detailModal() {
      if (!detailId) return null;
      var s = byId[detailId];
      if (!s) {
        // 已入库的场景退出了抓取列表，退回它自己的进度行，至少还有封面和标题
        var row = (prog || []).filter(function (p) { return p.sceneId === detailId; })[0];
        s = row ? {
          id: detailId, code: row.code, title: row.name,
          shot: row.shot, status: row.status,
        } : { id: detailId };
      }
      var cands = (s.candidates || []).slice();
      var pass = cands.filter(function (c) { return c.verdict === "pass"; });
      var unk = cands.filter(function (c) { return c.verdict === "unknown"; });
      var bad = cands.filter(function (c) { return c.verdict === "fail"; });
      var best = pass.slice().sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (b.seeders || 0) - (a.seeders || 0);
      })[0];
      var searching = busy === "search:" + s.id;
      var pushing = busy === "push:" + s.id;
      var shot = s.shot || shotOf[s.id] || "";
      var close = function () { setDetailId(""); };
      var actions = [
        isWsp() ? h("button", {
          className: "sf-btn sf-btn-md", disabled: pushing,
          onClick: function () { doPush(s.id, 0); },
        }, ico("download"), tc("交给 Whisparr", "Send to Whisparr"))
          : h("button", {
          className: "sf-btn sf-btn-md", disabled: searching,
          onClick: function () { doSearch(s.id); },
        }, ico("search"), searching ? tc("搜索中…", "Searching…") : tc("重新搜索", "Search again")),
        h("a", {
          className: "sf-btn sf-btn-md sf-btn-ghost sf-btn-link",
          href: appUrl("/scenes/" + s.id), target: "_blank", rel: "noreferrer",
        }, ico("external"), tc("打开场景", "Open scene")),
        s.status === "ignored" ? h("button", {
          className: "sf-btn sf-btn-md sf-btn-ghost",
          onClick: function () { doIgnore(s.id, true); },
        }, ico("plus"), tc("恢复", "Restore")) : h("button", {
          className: "sf-btn sf-btn-md sf-btn-ghost",
          onClick: function () { close(); doIgnore(s.id, false); },
        }, ico("ban"), tc("忽略", "Ignore")),
      ];

      // BEST PICK 条：一条最该推送的，理由写全，先给按钮再给列表
      var pick = best ? h("div", { className: "sf-pick" },
        h("div", { className: "sf-pick-head" },
          h("span", { className: "sf-pick-tag" }, tc("最佳选择", "BEST PICK")),
          pill("gr", tc("通过全部规则", "passed every rule"))),
        h("div", { className: "sf-pick-name sf-lib", title: best.title }, best.title || ""),
        h("div", { className: "sf-row-badges", style: { marginTop: "6px" } }, releaseBadges(best)),
        reasonRow(s, best),
        h("div", { className: "sf-pick-foot" },
          h("button", {
            className: "sf-btn sf-btn-md", disabled: pushing,
            onClick: function () { doPush(s.id, cands.indexOf(best)); },
          }, ico("download"), pushing ? tc("推送中…", "Pushing…") : tc("推送这条", "Push this one")),
          h("span", { className: "sf-meta" },
            tc("同组内按番号 / 日期 / 标题重合度排序", "Ranked by code, date and title overlap")))) : null;

      // 分组头：给了 foldOpt 就是可折叠的（「已淘汰」默认收起，省得占版面）
      function group(label, hue, iconName, items, foldOpt) {
        if (!items.length) return null;
        var folded = !!(foldOpt && foldOpt.folded);
        return h("div", { className: "sf-group", key: label },
          foldOpt
            ? h("button", {
              className: "sf-gh is-h-" + hue + (folded ? " is-fold" : ""),
              onClick: foldOpt.onToggle, "aria-expanded": !folded,
            },
              ico(iconName),
              h("span", { className: "sf-gh-name" }, label),
              h("span", { className: "sf-gn" }, items.length),
              h("span", { className: "sf-gh-tail" }),
              ico("chevron", "sf-gh-caret"))
            : h("div", { className: "sf-gh is-h-" + hue, style: { cursor: "default" } },
              ico(iconName),
              h("span", { className: "sf-gh-name" }, label),
              h("span", { className: "sf-gn" }, items.length)),
          folded ? null : h("div", { className: "sf-cands" }, items.map(function (c) {
            return candRow(s, c, { best: c === best, showVerdict: c !== best });
          })));
      }

      return h(ModalBack, { onClose: close },
        h("div", { className: "sf-modal" },
          h("button", { className: "sf-modal-x", onClick: close, title: tc("关闭", "Close") },
            ico("x")),
          h("div", { className: "sf-modal-head" },
            h("div", { className: "sf-modal-shot" },
              shot ? h("img", { src: shot, alt: "", loading: "lazy" })
                : h("span", { className: "sf-shot-ph sf-lib" }, s.code || "—")),
            h("div", { className: "sf-modal-info" },
              h("div", { className: "sf-modal-code sf-lib" }, s.code || "—"),
              h("h2", { className: "sf-modal-title sf-lib", title: s.title },
                s.title || tc("（无标题）", "(no title)")),
              h("div", { className: "sf-meta sf-lib" },
                [s.date, s.studio, fmtDur(s.duration)].filter(Boolean).join(" · ") || "—"),
              chipRow(s.performers, 7, "sf-tags--perf"),
              h("div", { className: "sf-score" },
                s.status ? statusPill(s.status) : null,
                cands.length ? h("span", { className: "sf-meta" },
                  tc("搜到 " + cands.length + " 个 · " + pass.length + " 个通过",
                    cands.length + " found · " + pass.length + " passed")) : null,
                s.rating ? h("span", { className: "sf-meta" },
                  "★ " + (s.rating / 20).toFixed(1)) : null),
              chipRow(s.tags, 7),
              s.details ? h("p", { className: "sf-modal-details sf-lib-desc" }, s.details) : null,
              h("div", { className: "sf-modal-actions" }, actions))),
          h("div", { className: "sf-modal-body" },
            cands.length
              ? h("div", null,
                pick,
                group(tc("通过", "Passed"), "gr", "check", pass),
                group(tc("待确认", "Needs a call"), "ye", "alert", unk),
                group(tc("已淘汰", "Rejected"), "tx3", "x", bad, {
                  folded: rejFolded,
                  onToggle: function () { setRejFolded(!rejFolded); },
                }))
              : h("div", { className: "sf-empty" },
                tc("这个场景还没有搜到资源。点「重新搜索」或等后台自动跑。",
                  "No releases yet. Search now, or wait for the background pass.")))));
    }

    // ─── 下载弹窗（已经在下的东西）─────────────────────────────────────────
    // 和详情弹窗分成两个：这里没有“推送 / 重新搜索”，只有进度和下载操作。
    function dlModal() {
      if (!dlId) return null;
      var p = (prog || []).filter(function (x) { return x.sceneId === dlId; })[0];
      if (!p) return null;
      var s = byId[dlId] || {};
      var done = pct(p.progress);
      var paused = isPaused(p.state);
      var importing = busy === "import:" + dlId;
      var acting = busy === "torrent:" + dlId;
      var shot = p.shot || s.shot || shotOf[dlId] || "";
      var close = function () { setDlId(""); };

      var nums = [
        h("span", { key: "d" }, tc("已下载 ", "done "),
          h("b", null, humanSize(p.downloaded)), " / " + humanSize(p.size)),
        p.ready ? null : h("span", { key: "s" }, tc("速度 ", "rate "),
          h("b", null, p.dlspeed ? humanSize(p.dlspeed) + "/s" : "—")),
        p.ready ? null : h("span", { key: "e" }, "ETA ", h("b", null, etaText(p.eta))),
        p.seeders != null ? h("span", { key: "p" }, tc("做种 ", "seeds "),
          h("b", null, p.seeders)) : null,
        fmtDur(s.duration) ? h("span", { key: "t" }, tc("时长 ", "length "),
          h("b", null, fmtDur(s.duration))) : null,
      ].filter(Boolean);

      var actions = [];
      var live2 = p.status !== "imported";
      if (p.ready) {
        actions.push(h("button", {
          className: "sf-btn sf-btn-md", disabled: importing,
          onClick: function () { doImport(dlId); },
        }, ico("download"), importing ? tc("入库中…", "Importing…") : tc("入库", "Import")));
      } else if (!isWsp() && live2 && p.state !== "missing") {
        actions.push(h("button", {
          className: "sf-btn sf-btn-md", disabled: acting,
          onClick: function () { doTorrent(p, paused ? "resume" : "pause"); },
        }, ico(paused ? "play" : "pause"), paused ? tc("继续", "Resume") : tc("暂停", "Pause")));
      }
      if (live2 && !p.ready) {
        actions.push(h("button", {
          className: "sf-btn sf-btn-md sf-btn-ghost", disabled: acting,
          onClick: function () { doTorrent(p, "remove"); },
        }, ico("trash"), tc("移除任务", "Remove")));
      }
      actions.push(h("a", {
        className: "sf-btn sf-btn-md sf-btn-ghost sf-btn-link",
        href: appUrl("/scenes/" + dlId), target: "_blank", rel: "noreferrer",
      }, ico("external"), tc("打开场景", "Open scene")));

      return h(ModalBack, { onClose: close },
        h("div", {
          className: "sf-modal sf-modal--dl",
        },
          h("button", { className: "sf-modal-x", onClick: close, title: tc("关闭", "Close") },
            ico("x")),
          h("div", { className: "sf-modal-head" },
            h("div", { className: "sf-modal-shot" },
              shot ? h("img", { src: shot, alt: "", loading: "lazy" })
                : h("span", { className: "sf-shot-ph sf-lib" }, p.code || "—")),
            h("div", { className: "sf-modal-info" },
              h("div", { className: "sf-modal-code sf-lib" }, p.code || s.code || "—"),
              h("h2", { className: "sf-modal-title sf-lib", title: s.title || p.name },
                s.title || p.name || tc("（无标题）", "(no title)")),
              h("div", { className: "sf-meta sf-lib" }, sceneSub(s)),
              h("div", { className: "sf-score" }, statusPill(progStateOf(p))))),
          h("div", { className: "sf-dl-body" },
            h("div", { className: "sf-dl-state" },
              h("span", { className: "sf-dl-pct" }, p.ready ? "100%" : done + "%"),
              paused ? pill("ye", tc("已暂停", "paused")) : null,
              p.state === "missing" ? pill("re", isWsp()
                ? tc("Whisparr 里没有这个场景", "not in Whisparr")
                : tc("下载器里没有这个任务", "not in the downloader")) : null),
            h("div", { className: "sf-bar sf-bar--lg" },
              h("i", { style: { width: (p.ready ? 100 : done) + "%" } })),
            h("div", { className: "sf-dl-nums" }, nums),
            h("div", { className: "sf-dl-name sf-lib" }, p.name || "—")),
          h("div", { className: "sf-dl-foot" }, actions)));
    }

    // 括号说明整体不拆行：窄屏上「(Stash side)」不能一半在上一行、一半在下一行
    function nbLabel(label) {
      var s = String(label || "");
      var i = s.indexOf(" (");
      if (i < 0) i = s.indexOf("（");
      if (i < 0) return s;
      return [
        h("span", { key: "p" }, s.slice(0, i)),
        " ",
        h("span", { className: "sf-nb", key: "nb" }, s.slice(i).trim()),
      ];
    }

    // 面板统一标题：彩色图标块 + 标题 + 右侧状态胶囊，设置页各卡片因此长一样的头
    function panelHead(iconName, zh, en, right) {
      return h("div", { className: "sf-panel-head" },
        h("div", { className: "sf-panel-title" },
          h("span", { className: "sf-panel-ico" }, ico(iconName)),
          h("h3", null, tc(zh, en))),
        right || null);
    }

    // 默认视图：和工具条同一套分段按钮，改动立即生效并记住
    function viewChoice() {
      return h("div", { className: "sf-toggle sf-toggle--row" },
        h("span", { className: "sf-toggle-text" },
          h("b", null, tc("默认视图", "Default view")),
          h("span", { className: "sf-meta" },
            tc("打开页面时默认用网格还是列表", "Grid or list when the page opens"))),
        h("div", { className: "sf-seg" },
          [{ id: "grid", icon: "grid", zh: "网格", en: "Grid" },
          { id: "list", icon: "list", zh: "列表", en: "List" }].map(function (v) {
            return h("button", {
              key: v.id, type: "button",
              className: "sf-segb" + (view === v.id ? " is-on" : ""),
              title: tc(v.zh, v.en),
              onClick: function () { switchView(v.id); },
            }, ico(v.icon));
          })));
    }

    function settingsPanel() {
      return h("div", { className: "sf-settings" },
        automationPanel(),
        h("section", { className: "sf-panel sf-panel--ui" },
          panelHead("grid", "界面", "Interface",
            h("span", { className: "sf-panel-tag" },
              tc("仅当前浏览器", "This browser"))),
          h("div", { className: "sf-toggles" }, h(NavBadgeToggle),
            h(PrefSwitch, {
              get: showVerOn,
              set: function (v) { prefSet("sf.showVer", v); },
              title: tc("显示版本号", "Show version"),
              hint: tc("标题旁显示插件版本号", "Shows the plugin version beside the title"),
            }),
            h(PrefSwitch, {
              get: showStatsOn,
              set: function (v) { prefSet("sf.showStats", v); },
              title: tc("显示统计栏", "Show stats"),
              hint: tc("顶部那排统计卡；同样的入口在 tab 栏也有",
                "The stat cards on top; the tabs carry the same entries"),
            }),
            viewChoice())),
        isWsp() ? null : rulesPanel(),
        isWsp() ? null : evalPanel(),
        h("section", { className: "sf-panel sf-panel--checks sf-panel--wide" },
          panelHead("info", "自检", "Checks",
            h("span", { className: "sf-meta" },
              tc("连接与路径在插件设置页配置", "Connection and paths live in the plugin settings"))),
          self ? h("div", { className: "sf-checks" }, (self.checks || []).map(function (c) {
            return h("div", { className: "sf-check" + (c.ok ? " is-ok" : " is-bad"), key: c.key },
              pill(c.ok ? "gr" : "re", c.ok ? "OK" : "!"),
              h("span", { className: "sf-check-name" }, nbLabel(c.label || c.key)),
              h("span", { className: "sf-meta" }, c.detail || ""),
              c.hint && !c.ok ? h("span", { className: "sf-hint" }, c.hint) : null);
          })) : h("div", { className: "sf-empty" }, tc("加载中…", "Loading…"))));
    }

    // 一组 = 折叠头 + 卡片墙或列表行；空组不出现。
    function section(key, hue, iconName, label, items, cardFn, rowFn, extra) {
      if (!items.length) return null;
      var gk = tab + ":" + key;
      var folded = !!fold[gk];
      return h("section", { className: "sf-group", key: gk },
        groupHead(gk, hue, iconName, label, items.length, extra),
        folded ? null : (view === "grid"
          ? h("div", { className: "sf-cards" }, items.map(cardFn))
          : h("div", { className: "sf-rows" }, items.map(rowFn))));
    }

    function emptyBox(text) { return h("div", { className: "sf-empty" }, text); }

    var body = null;
    if (tab === "pending") {
      var pend = pending.filter(hit);
      var ask = pend.filter(function (s) { return s.status === "low_confidence"; });
      var miss = pend.filter(function (s) { return s.status === "no_result"; });
      var fresh = pend.filter(function (s) { return s.status === "captured"; });
      VIS = pend.map(function (s) { return String(s.id); });
      body = h("div", { className: "sf-stack" },
        autoBar(),
        q && !pend.length
          ? emptyBox(tc("没有匹配「" + q + "」的场景", "Nothing matches \"" + q + "\""))
          : null,
        section("ask", "ye", "alert", tc("需确认", "Needs you"), ask, pendingCard, pendingRow),
        section("miss", "tx3", "search", tc("没搜到", "No release"), miss, pendingCard, pendingRow),
        section("new", "tx3", "clock",
          isWsp() ? tc("待交给 Whisparr", "To send") : tc("待搜索", "New"),
          fresh, pendingCard, pendingRow),
        !pending.length ? emptyBox(isWsp()
          ? tc("没有待处理的场景。新抓到的会自动交给 Whisparr",
               "Nothing pending. New scenes are sent to Whisparr automatically")
          : tc("没有待处理的场景。新抓到会自动搜，搜不到按 15 分钟 / 1 小时 / 6 小时 / 1 天退避重试",
               "Nothing pending. New scenes are searched automatically; misses back off 15m / 1h / 6h / 1d")) : null);
    } else if (tab === "results") {
      var foundList = found.filter(hit).filter(function (s) {
        if (!idx && !res) return true;
        var b = topCandidate(s);
        if (!b) return false;
        return (!idx || (b.indexer || "") === idx) && (!res || (b.resolution || "") === res);
      });
      VIS = foundList.map(function (s) { return String(s.id); });
      body = h("div", { className: "sf-stack" },
        autoBar(),
        section("pass", "gr", "check", tc("通过筛选", "Passed"), foundList, resultCard, resultRow),
        !found.length ? emptyBox(tc(
          "还没有通过筛选的候选。搜到的资源先过规则，通过的才落到这里",
          "Nothing passed the rules yet. Results land here only after they pass")) : null,
        q && !foundList.length ? emptyBox(tc("没有匹配「" + q + "」的结果", "Nothing matches \"" + q + "\"")) : null);
    } else if (tab === "downloading") {
      var anyMissing = live.some(function (p) { return p.state === "missing"; });
      var liveList = live.filter(hitProg);
      var ready = liveList.filter(function (p) { return p.ready; });
      var lost = liveList.filter(function (p) { return !p.ready && p.state === "missing"; });
      var busy2 = liveList.filter(function (p) { return !p.ready && p.state !== "missing"; });
      VIS = liveList.map(function (p) { return String(p.sceneId); });
      var showReady = filter !== "ready";
      // 没有任务时按钮照常占位（置灰），否则这行只剩连接状态，高度会比有卡片时矮一截
      var noLive = !live.length;
      var bulk = [
        isWsp() ? null : h("button", {
          className: "sf-btn sf-btn-sm", key: "b1", disabled: noLive || busy === "bulk:resume",
          onClick: function () { doBulk("resume"); },
        }, ico("play"), tc("全部下载", "Resume all")),
        isWsp() ? null : h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost", key: "b2", disabled: noLive || busy === "bulk:pause",
          onClick: function () { doBulk("pause"); },
        }, ico("pause"), tc("全部暂停", "Pause all")),
        h("button", {
          className: "sf-btn sf-btn-sm sf-btn-ghost", key: "b3",
          disabled: noLive || busy === "bulk:remove_missing" || !anyMissing,
          title: anyMissing ? "" : (isWsp()
            ? tc("Whisparr 里都还在", "Nothing is missing")
            : tc("下载器里都还在", "Nothing is missing")),
          onClick: function () { doBulk("remove_missing"); },
        }, ico("trash"), tc("移除缺失", "Remove missing")),
      ].filter(Boolean);
      // 窄屏这几个按钮跟着工具条的「更多」走
      MEXTRA.push(h("div", { className: "sf-listbar-btns", key: "bulk-mob" }, bulk));
      body = h("div", { className: "sf-stack" },
        listBar(connLine(), bulk, true),
        section("ready", "bl", "download", tc("待入库", "Ready"), ready, progressCard, progressRow),
        showReady ? section("busy", "cy", "download",
          isWsp() ? tc("Whisparr 处理中", "In Whisparr") : tc("下载中", "Downloading"),
          busy2, progressCard, progressRow) : null,
        section("lost", "re", "x", tc("任务丢失", "Lost"), lost, progressCard, progressRow),
        !live.length ? emptyBox(isWsp()
          ? tc("Whisparr 里没有进行中的场景", "Nothing in Whisparr")
          : tc("没有进行中的下载", "Nothing downloading")) : null,
        filter === "ready" && !ready.length ? emptyBox(tc("没有待入库的任务", "Nothing ready to import")) : null);
    } else if (tab === "done") {
      var doneList = (prog || []).filter(function (p) {
        return p.status === "imported" && hitProg(p);
      });
      VIS = doneList.map(function (p) { return String(p.sceneId); });
      var buckets = [[], [], [], []];
      doneList.forEach(function (p) { buckets[dayBucket(p.at)].push(p); });
      var clearBtn = h("button", {
        className: "sf-btn sf-btn-sm sf-btn-ghost", key: "clr", disabled: busy === "done:clear",
        onClick: clearDone,
      }, ico("trash"), tc("清空记录", "Clear list"));
      if (done.length) MEXTRA.push(h("div", { className: "sf-listbar-btns", key: "done-mob" }, [clearBtn]));
      body = h("div", { className: "sf-stack" },
        done.length ? listBar(
          h("span", { className: "sf-meta" }, tc(done.length + " 条已入库", done.length + " imported")),
          [clearBtn]) : null,
        buckets.map(function (items, i) {
          return section("day" + i, "bl", "clock", DAY_LABEL[i](), items, doneCard, doneRow);
        }),
        !done.length ? emptyBox(tc("还没有入库完成的场景", "Nothing imported yet")) : null,
        done.length && !doneList.length
          ? emptyBox(tc("没有匹配「" + q + "」的记录", "Nothing matches \"" + q + "\"")) : null);
    } else if (tab === "ignored") {
      var ign = ignored.filter(hit);
      VIS = ign.map(function (s) { return String(s.id); });
      var restoreBtn = h("button", {
        className: "sf-btn sf-btn-sm sf-btn-ghost", key: "rst", disabled: busy === "ignore:all",
        onClick: bulkRestore,
      }, ico("plus"), tc("全部还原", "Restore all"));
      if (ignored.length) MEXTRA.push(h("div", { className: "sf-listbar-btns", key: "ign-mob" }, [restoreBtn]));
      body = h("div", { className: "sf-stack" },
        ignored.length ? listBar(
          h("span", { className: "sf-meta" }, tc(ignored.length + " 个已忽略", ignored.length + " ignored")),
          [restoreBtn]) : null,
        section("ign", "tx3", "ban", tc("已忽略", "Ignored"), ign, ignoredCard, ignoredRow),
        !ignored.length ? emptyBox(tc("没有忽略的场景", "Nothing ignored")) : null);
    } else {
      body = settingsPanel();
    }

    var healthy = self && self.ok;
    var fails = ((self && self.checks) || []).filter(function (c) { return !c.ok; });
    var daemonAlive = !!(ctrl && ctrl.daemon && ctrl.daemon.alive);
    return h("div", { className: "sf-page " + (pageIsDark() ? "is-dark" : "is-light") },
      h("header", { className: "sf-head" },
        h("div", { className: "sf-brand" },
          h("span", { className: "sf-logo" }, faIcon("faMagnet", "sf-logo-ico") || "SF"),
          h("div", { className: "sf-brand-text" },
            h("div", { className: "sf-name" }, tc("补档", "Scene Backfill")),
            h("div", {
              className: "sf-meta",
              title: showVerOn()
                ? "v" + PLUGIN_VERSION + (self && self.qbVersion ? " · " + self.qbVersion : "")
                : (self && self.qbVersion ? self.qbVersion : ""),
            },
              tc("缺文件的场景自动补种", "Fills scenes that have no file") +
              (showVerOn() ? " · v" + PLUGIN_VERSION : "")))),
        h("div", { className: "sf-head-right" },
          // 自检状态：桌面端是「√ 自检通过」，窄屏只留一个 √（文字藏起来，宽度收成方块）
          self ? h("button", {
            className: "sf-pill sf-pill--mini" + (healthy ? " is-icon-only" : "") +
              " is-h-" + (healthy ? "gr" : "re"),
            title: fails.length
              ? fails.map(function (c) { return (c.label || c.key) + "：" + (c.detail || ""); }).join("\n")
              : tc("自检通过", "All checks passed"),
            "aria-label": healthy ? tc("自检通过", "Checks OK")
              : tc(fails.length + " 项未通过", fails.length + " failed"),
            onClick: function () { switchTab("settings"); },
          }, ico(healthy ? "check" : "alert"),
            healthy ? h("span", { className: "sf-pill-txt" }, tc("自检通过", "Checks OK"))
              : String(fails.length)) : null,
          h("button", {
            className: "sf-icb" + (daemonAlive ? " is-acc" : ""),
            disabled: busy === "daemon",
            title: daemonAlive ? tc("后台守护中，点击停止", "Worker running, click to stop")
              : tc("后台运行（关页也能继续）", "Run in background"),
            "aria-label": tc("后台运行", "Run in background"),
            onClick: toggleDaemon,
          }, ico(daemonAlive ? "pause" : "play")))),

      h("div", { className: "sf-tabrow" },
        h("nav", { className: "sf-tabs" }, tabs.map(function (t) {
          return h("button", {
            key: t.id,
            className: "sf-tab is-h-" + t.hue + (tab === t.id ? " is-on" : ""),
            onClick: function () { switchTab(t.id); },
          }, ico(t.icon), t.label,
            t.id === "done"
              ? (dinc > 0 ? h("span", { className: "sf-count is-new" },
                "+" + (dinc > 99 ? "99" : dinc)) : null)
              : t.n && !t.hideCount
                ? h("span", { className: "sf-count" + (t.id === "pending" ? " is-hot" : "") }, t.n)
                : null);
        }))),

      showStatsOn() ? statsRow() : null,
      toolsBar(),
      selBar(),
      h("main", { className: "sf-body" }, body),
      detailModal(),
      dlModal(),
      msg ? h("div", { className: "sf-toast" + (msg.bad ? " is-bad" : "") }, msg.text) : null);
  }

  // ─── register ───────────────────────────────────────────────────────────
  (function boot() {
    if (!Api || !Api.register || !Api.React) {
      console.warn("[SF] PluginApi missing, page not registered");
      return;
    }
    var React = Api.React;
    try {
      Api.register.route("/plugins/SceneBackfill", Page);
    } catch (e) {
      console.warn("[SF] route registration failed:", e);
    }
    try {
      var Nav = Api.libraries.Bootstrap.Nav;
      var NavLink = Api.libraries.ReactRouterDOM.NavLink;
      var FAS = Api.libraries.FontAwesomeSolid || {};
      var FAIcon = Api.libraries.ReactFontAwesome.FontAwesomeIcon;
      var IntlLib = Api.libraries.Intl || {};
      var useIntl = IntlLib.useIntl || function () { return null; };
      // The nav renders before the locale bridge has fired, so a plain tc()
      // here would stick on the English label forever -- read the locale
      // inside the component and re-render when it changes.
      function NavItem() {
        var intl = useIntl();
        var loc = String((intl && intl.locale) || _locale || "").toLowerCase();
        var zh = loc.indexOf("zh") === 0;
        var cnt = React.useState(NAV.c);
        var tick = React.useState(0);
        React.useEffect(function () {
          var alive = true;
          function apply(c) { if (alive) cnt[1](c || NAV.c); }
          function on(e) { apply(e && e.detail); }
          // 开关变了必须重渲染，哪怕数字没动。
          function bump() { if (alive) tick[1](function (v) { return v + 1; }); }
          window.addEventListener(NAV.evt, on);
          window.addEventListener(NAV.badgeEvt, bump);
          // 别的页面也有导航条，而页面组件不在场，只能问一次后端；
          // 同一次加载里只问一次，之后的更新走事件。关了角标就不问。
          if (!NAV.asked && navBadgeOn()) {
            NAV.asked = true;
            op({ mode: "badge" }).then(function (r) {
              if (!r || typeof r !== "object") return;
              navCount({
                found: r.found, active: r.active,
                done: r.done, pending: r.pending,
              });
            }).catch(function () { NAV.asked = false; });
          }
          return function () {
            alive = false;
            window.removeEventListener(NAV.evt, on);
            window.removeEventListener(NAV.badgeEvt, bump);
          };
        }, []);
        var b = navBadgeOn() ? pickBadge(cnt[0]) : null;
        return React.createElement(Nav.Link,
          { as: "div", eventKey: "/plugins/SceneBackfill", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
          React.createElement(NavLink, {
            exact: true,
            to: "/plugins/SceneBackfill",
            activeClassName: "active",
            className: "btn minimal p-4 p-xl-2 d-flex d-xl-inline-block " +
              "flex-column justify-content-between align-items-center sf-nav-item",
          },
            React.createElement(FAIcon, {
              icon: FAS.faMagnet || FAS.faDownload,
              className: "fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0",
              fixedWidth: true,
            }),
            React.createElement("span", null, zh ? "补档" : "Backfill"),
            b ? React.createElement("span", { className: "sf-nav-n is-" + b.tone, key: "n" },
              b.plus ? (b.n > 99 ? "+99" : "+" + b.n)
                : (b.n > 99 ? "99+" : String(b.n))) : null));
      }
      // ─── 原生导航开关 ─────────────────────────────────────────────────
      // Stash 的导航只渲染 interface.menuItems 里列出的条目。要让插件入口和
      // 内置项一样能在设置里勾选，需要两件事：把插件 id 塞进「菜单项目」的
      // 多选框，以及渲染前读 menuItems 决定是否显示。直链
      // /plugins/SceneBackfill 不受影响，路由始终注册。
      var NAV_ID = PLUGIN_ID;
      var forceNav = false;

      try {
        Api.patch.before("CheckboxGroup", function (props) {
          // 这段在 Stash 自己的 render 里跑，抛异常会把整站换成错误页 →
          // 出什么事都原样返回。
          try {
            if (!props || props.groupId !== "menu-items" || !Array.isArray(props.items)) return [props];
            if (props.items.some(function (it) { return it && it.id === NAV_ID; })) return [props];
            return [Object.assign({}, props, {
              items: props.items.concat([{ id: NAV_ID, headingID: tc("补档", "Backfill") }]),
            })];
          } catch (e) {
            console.warn("[SF] menu-items patch failed:", e);
            return [props];
          }
        });
      } catch (e) {
        console.warn("[SF] CheckboxGroup patch unavailable:", e);
      }

      // 首次安装 seed 一次：新装的 Stash 不会自动把未知 id 放进 menuItems，
      // 不 seed 的话入口一开始就是不显示的。用插件配置里的 navSeeded 记住
      // 「已经 seed 过」——之后没勾上就是用户主动取消的，尊重它。
      // configurePlugin 是整体替换而不是合并，必须把读回来的配置整体带上。
      callGQL("query{configuration{interface{menuItems}plugins}}").then(function (data) {
        var cfg = (data && data.configuration) || {};
        var items = ((cfg.interface || {}).menuItems) || [];
        if (items.indexOf(NAV_ID) !== -1) return null;
        var mine = ((cfg.plugins || {})[NAV_ID]) || {};
        if (mine.navSeeded) return null;
        return callGQL(
          "mutation($items:[String!]){configureInterface(input:{menuItems:$items}){menuItems}}",
          { items: items.concat([NAV_ID]) }
        ).then(function () {
          return callGQL(
            "mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
            { id: NAV_ID, input: Object.assign({}, mine, { navSeeded: true }) }
          );
        }).then(function () { forceNav = true; });
      }).catch(function (e) {
        // 非致命：最坏情况入口不显示，用户还能在设置里手动勾上
        console.warn("[SF] nav seed failed:", e);
      });

      // 读不到配置时一律当「显示」——绝不让入口因为一次读取失败而消失。
      function navEnabled() {
        var hook = Api.GQL && Api.GQL.useConfigurationQuery;
        if (typeof hook !== "function") return true;
        var data;
        try { data = hook().data; } catch (e) { return true; }
        var items = data && data.configuration && data.configuration.interface &&
          data.configuration.interface.menuItems;
        if (!items) return true;
        return items.indexOf(NAV_ID) !== -1 || forceNav;
      }

      Api.patch.before("MainNavBar.MenuItems", function (props) {
        try {
          if (!props) return [props];
          if (!navEnabled()) return [props];
          var kids = React.Children.toArray(props.children);
          if (kids.some(function (c) { return c && c.type === NavItem; })) return [props];
          kids.push(React.createElement(NavItem, { key: "sf-nav" }));
          return [Object.assign({}, props, { children: kids })];
        } catch (e) {
          return [props];
        }
      });
    } catch (e) {
      console.warn("[SF] nav registration failed:", e);
    }

    // ─── 插件设置页「测试」按钮 ───────────────────────────────────────────
    // The yml settings can only render input fields, so the button goes into
    // Stash's own plugin card: patch SettingGroup and touch only our card.
    try {
      mountSettingsTest(React);
    } catch (e) {
      console.warn("[SF] settings test button failed:", e);
    }
  })();

  function mountSettingsTest(React) {
    var h = React.createElement;
    var libs = Api.libraries || {};
    var Bootstrap = libs.Bootstrap || {};
    var Button = Bootstrap.Button;
    var Modal = Bootstrap.Modal;
    if (!Api.patch || !Button || !Modal || !Modal.Header) return;
    var FAS = libs.FontAwesomeSolid || {};
    var RAF = libs.ReactFontAwesome || {};

    // Modal content sits in a portal, but React events still bubble through
    // the React tree to the plugin card header, which is a collapse toggle.
    function stopBubble(e) { e.stopPropagation(); }

    function Rows(props) {
      var items = props.items || [];
      return h("div", { className: "sf-test-list" }, items.map(function (it, i) {
        // Three states: ok ✓ / bad ✗ / skip – (an optional check that neither
        // passed nor failed should not carry a green tick).
        var st = it.state || (it.ok ? "ok" : "bad");
        return h("div", { className: "sf-test-row is-" + st, key: i },
          h("span", { className: "sf-test-mark" },
            st === "skip" ? "–" : (st === "ok" ? "✓" : "✗")),
          h("div", { className: "sf-test-body" },
            h("div", { className: "sf-test-name" }, it.label || it.key || ""),
            h("div", { className: "sf-test-detail" }, String(it.detail || "")),
            it.hint ? h("div", { className: "sf-test-hint" }, it.hint) : null));
      }));
    }

    function TestDialog(props) {
      var st = props.state;
      // Backdrop and drag both need to be handled here (backdrop:"static"
      // turns off the built-in onHide):
      // 1) a light click on the backdrop closes the dialog;
      // 2) pressing inside the panel and releasing outside must not close it —
      //    this react-bootstrap version only checks click.target === .modal, and
      //    a drag from the panel to the backdrop lands exactly there;
      // 3) the click a drag leaves behind targets the nearest common ancestor,
      //    which can be the plugin card header itself and would collapse it.
      //    That click has already left the dialog subtree, so Header/Body/Footer
      //    handlers never see it; it has to be caught in the document capture
      //    phase, before React's bubble handlers run.
      React.useEffect(function () {
        if (!props.show) return undefined;
        var content = document.querySelector(".sf-test-content");
        var root = content && content.closest(".modal");
        if (!root) return undefined;
        var pressed = false, dragged = false, sx = 0, sy = 0;

        function onDown(e) {
          pressed = true; dragged = false;
          sx = e.clientX; sy = e.clientY;
        }
        function onMove(e) {
          if (!pressed) return;
          if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) dragged = true;
        }
        function onClick(e) {
          var inside = content.contains(e.target);
          // Inside the panel and not a drag release: a real click, let the
          // button's own React handler have it.
          if (inside && !dragged) { pressed = false; return; }
          e.stopPropagation();
          e.preventDefault();
          if (!dragged && e.target === root) props.onClose();
          pressed = false; dragged = false;
        }
        function reset() { pressed = false; dragged = false; }

        root.addEventListener("pointerdown", onDown, true);
        document.addEventListener("pointermove", onMove, true);
        document.addEventListener("click", onClick, true);
        document.addEventListener("pointercancel", reset, true);
        window.addEventListener("blur", reset);
        return function () {
          root.removeEventListener("pointerdown", onDown, true);
          document.removeEventListener("pointermove", onMove, true);
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("pointercancel", reset, true);
          window.removeEventListener("blur", reset);
        };
      }, [props.show]);

      var body;
      if (st.loading) {
        body = h("div", { className: "sf-test-wait" },
          h("span", { className: "sf-test-dots" }, h("i"), h("i"), h("i")),
          h("span", null, tc("测试中…", "Testing…")));
      } else if (st.error) {
        body = h("div", { className: "sf-test-err" }, st.error);
      } else {
        body = h(Rows, { items: st.items || [] });
      }
      return h(Modal, {
        show: !!props.show, onHide: props.onClose, backdrop: "static",
        centered: true, dialogClassName: "sf-test-dialog",
        contentClassName: "sf-test-content" + (pageIsDark() ? "" : " is-light"),
      },
        h(Modal.Header, { closeButton: true, onClick: stopBubble, onMouseDown: stopBubble },
          h(Modal.Title, null, tc("插件自检", "Plugin checks"))),
        h(Modal.Body, { onClick: stopBubble, onMouseDown: stopBubble }, body),
        h(Modal.Footer, { onClick: stopBubble, onMouseDown: stopBubble },
          h(Button, { variant: "secondary", onClick: props.onRun, disabled: st.loading },
            tc("重新测试", "Test again")),
          h(Button, { variant: "primary", onClick: props.onClose }, tc("关闭", "Close"))));
    }

    function TestButton() {
      var openPair = React.useState(false);
      var open = openPair[0], setOpen = openPair[1];
      var stPair = React.useState({ loading: false, items: null, error: null });
      var st = stPair[0], setSt = stPair[1];

      function run() {
        setSt({ loading: true, items: null, error: null });
        op({ mode: "selftest" }).then(function (r) {
          setSt({ loading: false, items: (r && r.checks) || [], error: null });
        }).catch(function (e) {
          setSt({ loading: false, items: null, error: String((e && e.message) || e) });
        });
      }
      function openIt() {
        setOpen(true);
        if (!st.items && !st.loading) run();
      }
      // An anchor, not a button: Collapsable Plugin Settings treats the last
      // button in the card header as the enable switch and would restyle it.
      var trigger = h("a", {
        className: "btn btn-primary sf-test-btn", role: "button", tabIndex: 0,
        onClick: function (e) { e.preventDefault(); openIt(); },
        onKeyDown: function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openIt(); }
        },
      },
        (RAF.FontAwesomeIcon && FAS.faFlask)
          ? h(RAF.FontAwesomeIcon, { icon: FAS.faFlask, className: "sf-test-ico" }) : null,
        tc("测试", "Test"));

      return h(React.Fragment, null, trigger,
        h(TestDialog, { show: open, state: st, onClose: function () { setOpen(false); }, onRun: run }));
    }

    // Insert before the forum-link button in the card header; append if that
    // button is ever removed from Stash.
    function inject(node, el) {
      if (!node || !node.props) return false;
      var kids = node.props.children;
      if (!Array.isArray(kids)) kids = kids ? [kids] : [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k && k.type && k.type.displayName === "Button" && k.props && k.props.href) {
          kids.splice(i, 0, el);
          node.props.children = kids;
          return true;
        }
      }
      for (var j = 0; j < kids.length; j++) {
        if (kids[j] && inject(kids[j], el)) return true;
      }
      return false;
    }

    Api.patch.after("SettingGroup", function (props, _ctx, original) {
      try {
        var kids = props && props.children;
        var owner = Array.isArray(kids) ? kids[1] : null;
        var pid = owner && owner.props && owner.props.pluginID;
        if (pid !== PLUGIN_ID) return original;
        var el = h(TestButton, null);
        if (!inject(props.topLevel, el) && props.topLevel && props.topLevel.props) {
          var c = props.topLevel.props.children;
          props.topLevel.props.children = (Array.isArray(c) ? c : [c]).concat([el]);
        }
      } catch (e) {
        console.warn("[SF] test button injection failed:", e);
      }
      return original;
    });
  }
})();
