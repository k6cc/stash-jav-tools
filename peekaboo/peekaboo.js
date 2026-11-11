/* Peekaboo v0.1.0 —— Stash 插件
 * 用生成的 SVG 占位图替换所有图片 / 视频画面，而不是高斯模糊。
 * 实现：<html> 上挂一个 class，CSS 把 img/video 的 filter 指向只输出 feImage 的
 * SVG 滤镜 —— 元素原始像素被整块丢弃，src 不动，关掉时无需还原任何东西。
 *
 * 另外三件事：悬停/按住 Shift 临时露原图；标题/人名/标签等文字按字段打码；
 * title、alt、浏览器标题、复制内容一并不留原字。
 */
(function () {
  "use strict";

  if (window.__peekabooLoaded) return;
  window.__peekabooLoaded = true;

  var PLUGIN_ID = "peekaboo";
  var PLUGIN_VERSION = "0.1.0";
  var LS_KEY = "peekaboo.on";
  var BTN_ID = "plugin-peekaboo";
  var DEFS_ID = "peekaboo-defs";
  var ON = "peekaboo-on";
  var PEEK = "peekaboo-peek";
  var REVEAL = "peekaboo-reveal";
  var ART_ATTR = "data-peekaboo-art";
  var TEXT_ATTR = "data-peekaboo-text";

  var SEL = "img, video";
  // 背景图形式的画面（播放器海报、进度条预览气泡、拖动预览的雪碧图）不经过 <img>
  var BG_SEL = '[style*="url("], .vjs-poster, .vjs-vtt-thumbnail-display, .wall-item-media, ' +
    '.scene-cover, .scrubber-item, .sprite-cell';
  var MEDIA_BG = /\/(scene|image|gallery|performer|studio|group)s?\//;

  // 悬停露原图按“卡片”整块生效：Stash 悬停后会插入预览视频盖住封面，只露 img 是看不见的
  var HOST_SEL = ".scene-card, .image-card, .gallery-card, .group-card, .studio-card, .performer-card, .wall-item";

  // 文字打码只碰“字段”，页签 / 按钮 / 筛选器 / 表单里的字一律不动
  var TEXT_SEL = [
    ".TruncatedText",
    ".tag-item",
    ".detail-item",
    ".detail-item-value",
    ".scene-details h6",
    ".scene-details a",
    ".details-list h6",
    ".gallery-details h6",
    ".image-details h6",
    ".scene-description",
    ".gallery-description",
    ".expandable-text",
    ".pre",
    ".scene-subheader .date",
    ".card-section",
    ".studio-overlay",
    ".file-path",
    ".performer-card__age",
    ".scene-card__date",
    ".group-card__date",
    ".gallery-card__date",
    ".image-card__date",
    'a[href^="/studios/"]',
    'a[href^="/performers/"]',
    ".stash-id-pill",
    ".scene-header",
    ".performer-head",
    ".studio-head",
    ".gallery-head",
    ".image-head",
    ".group-head"
  ].join(",");

  // 这些元素各自算“一个单位”：整块只出一条替换结果，内部被拆成多个文本节点也不拆词
  var UNIT_SEL = ".detail-item-title, .detail-item-value, .performer-name, .performer-disambiguation, .alias-head, " +
    ".group-name, .tag-name, .studio-name";

  // 整块跳过：导航、表单、设置页，以及控件本身（按钮文字不是库里的数据）
  var SAFE_SEL = ".navbar, .nav, .nav-link, .nav-item, .dropdown-menu, .dropdown-toggle, .react-select, " +
    "form, input, textarea, select, button, .btn, .btn-link, " +
    ".settings-container, .modal-header, .vjs-control-bar, .vjs-menu, " +
    ".details-edit, .card-controls, .card-popovers, .filter-button, .tag-select";

  var ART_COUNT = 32;
  var PALETTES = [
    ["#1f2937", "#3b5372"],
    ["#241f33", "#4c3f6b"],
    ["#1c2a27", "#37604f"],
    ["#2c211c", "#5f4633"],
    ["#232326", "#45464e"],
    ["#2e1f26", "#5e3d4b"],
    ["#1d2a30", "#3d5b68"],
    ["#272318", "#4f4a2f"]
  ];
  var MOTIFS = 4;

  // 固定英文词，不跟随界面语言
  var SUNNY = ["sunflower", "lemon soda", "cloud", "cotton candy", "daisy", "sea breeze",
    "bubbles", "orange soda", "mint", "sunbeam", "strawberry milk", "marble soda",
    "cherry blossom", "clover", "caramel", "star candy", "peach tea", "rainbow",
    "honeydew", "sunshine"];

  // 五种文字样式：阳光词 / 灰块 / 纯黑块 / 纯白块 / 逐字符字母
  var TEXT_STYLES = ["sunny", "symbol", "black", "white", "char"];
  var DEFAULT_TEXT_STYLE = "sunny";

  // 列表页标签页的名字，出现在浏览器标题里不算泄漏
  var UI_TITLE = ["短片", "图库", "演员", "工作室", "标签", "集合", "标记", "发现", "设置",
    "Scenes", "Galleries", "Performers", "Studios", "Tags", "Groups", "Markers",
    "Discover", "Settings", "Stash", "Stash UI"];

  var state = { on: false, reveal: false };
  var cfg = { enabled: false, hoverPeek: true, allowVideo: false, maskText: true, textStyle: DEFAULT_TEXT_STYLE };
  var cfgLoaded = false;
  var cfgSig = "";

  // ===== i18n：跟随 Stash 界面语言 =====
  var _intlLocale = "";

  (function initIntlBridge() {
    try {
      var api = window.PluginApi;
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return;
      var React = api.React;
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl();
        React.useEffect(function () { _intlLocale = intl.locale || ""; });
        return null;
      }
      api.patch.before("App", function (props) {
        return [{ children: React.createElement(React.Fragment, null, React.createElement(IntlBridge), props.children) }];
      });
    } catch (e) {
      console.warn("[peekaboo] i18n bridge unavailable, falling back to Chinese:", e);
    }
  })();

  function tc(zh, en) {
    return (_intlLocale && !/^zh/i.test(_intlLocale)) ? en : zh;
  }

  // ===== 占位图生成 =====
  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function artSvg(k) {
    var pal = PALETTES[k % PALETTES.length];
    var motif = Math.floor(k / PALETTES.length) % MOTIFS;
    var r = rng(k * 7919 + 31);
    var s = [];
    s.push("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120' width='120' height='120'>");
    s.push("<defs>");
    s.push("<linearGradient id='g' x1='0' y1='1' x2='1' y2='0'>");
    s.push("<stop offset='0' stop-color='" + pal[0] + "'/><stop offset='1' stop-color='" + pal[1] + "'/></linearGradient>");
    s.push("<radialGradient id='v' cx='0.5' cy='0.35' r='0.8'>");
    s.push("<stop offset='0' stop-color='#ffffff' stop-opacity='0.12'/>");
    s.push("<stop offset='1' stop-color='#000000' stop-opacity='0.18'/></radialGradient>");
    s.push("</defs>");
    s.push("<rect width='120' height='120' fill='url(#g)'/>");

    var i, x, y;
    if (motif === 0) {
      var cx = 40 + r() * 40, cy = 40 + r() * 40;
      for (i = 0; i < 4; i++) {
        s.push("<circle cx='" + cx.toFixed(1) + "' cy='" + cy.toFixed(1) + "' r='" + (15 + i * 16) +
          "' fill='none' stroke='#fff' stroke-opacity='" + (0.16 - i * 0.03).toFixed(2) + "' stroke-width='7'/>");
      }
      s.push("<circle cx='" + cx.toFixed(1) + "' cy='" + cy.toFixed(1) + "' r='9' fill='#fff' fill-opacity='0.16'/>");
    } else if (motif === 1) {
      var ox = r() * 12, oy = r() * 12;
      for (y = 0; y < 9; y++) {
        for (x = 0; x < 9; x++) {
          if (r() < 0.25) continue;
          s.push("<circle cx='" + (ox + x * 14 + 7).toFixed(1) + "' cy='" + (oy + y * 14 + 7).toFixed(1) +
            "' r='" + (2 + r() * 2).toFixed(1) + "' fill='#fff' fill-opacity='" + (0.12 + r() * 0.14).toFixed(2) + "'/>");
        }
      }
    } else if (motif === 2) {
      for (i = 0; i < 3; i++) {
        s.push("<rect x='" + (8 + r() * 50).toFixed(1) + "' y='" + (8 + r() * 50).toFixed(1) +
          "' width='" + (30 + r() * 40).toFixed(1) + "' height='" + (20 + r() * 30).toFixed(1) +
          "' rx='6' fill='#fff' fill-opacity='" + (0.07 + r() * 0.07).toFixed(2) +
          "' transform='rotate(" + (-30 + r() * 60).toFixed(1) + " 60 60)'/>");
      }
    } else {
      for (i = 0; i < 4; i++) {
        var yy = 28 + i * 20;
        s.push("<path d='M0 " + yy + " C 30 " + (yy - 14 + r() * 10).toFixed(1) + ", 60 " +
          (yy + 14 - r() * 10).toFixed(1) + ", 120 " + yy + "' fill='none' stroke='#fff' stroke-opacity='" +
          (0.17 - i * 0.03).toFixed(2) + "' stroke-width='5'/>");
      }
    }

    s.push("<rect width='120' height='120' fill='url(#v)'/>");
    s.push("</svg>");
    return s.join("");
  }

  function injectDefs() {
    if (document.getElementById(DEFS_ID)) return;
    var parts = ["<defs>"];
    for (var k = 0; k < ART_COUNT; k++) {
      // encodeURIComponent 不转义单引号，而 SVG 属性用的就是单引号 —— 不替换会截断 href
      var href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(artSvg(k)).replace(/'/g, "%27");
      parts.push("<filter id='peekaboo-art-" + k + "' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>");
      parts.push("<feImage href='" + href + "' preserveAspectRatio='xMidYMid slice' width='100%' height='100%'/>");
      parts.push("</filter>");
    }
    parts.push("</defs>");

    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("id", DEFS_ID);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    svg.innerHTML = parts.join("");
    document.body.appendChild(svg);
  }

  // ===== 画面打标 =====
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function artIndexOf(el) {
    var key = el.getAttribute("src") || el.getAttribute("poster") || "";
    if (!key && el.tagName === "VIDEO") key = el.currentSrc || "";
    // 雪碧图格子没有 src，用 background-position 之类的内联样式区分，否则整片格子同一张
    if (!key) key = (el.getAttribute("style") || "").slice(0, 140);
    if (!key || key.length < 8) key = (el.getAttribute("class") || "") + "|" + el.outerHTML.slice(0, 160);
    return hash(key) % ART_COUNT;
  }

  function mark(el) {
    if (!el || el.__peekabooMarked) return;
    el.__peekabooMarked = true;
    el.setAttribute(ART_ATTR, String(artIndexOf(el)));
  }

  function isMediaBackground(el, bg) {
    if (bg.indexOf("data:image/svg") !== -1) return false;              // 国旗等内联 SVG，不是画面
    if (MEDIA_BG.test(bg) || /sprite|screenshot|preview|thumb/i.test(bg)) return true;
    if (/data:image\//.test(bg)) {                                      // 内联位图（精灵图插件等）
      var r = el.getBoundingClientRect();
      return Math.max(r.width, r.height) >= 80;
    }
    return false;
  }

  function markBgEl(el) {
    if (!el || el.__peekabooMarked || el.tagName === "IMG" || el.tagName === "VIDEO") return;
    var bg = window.getComputedStyle(el).backgroundImage;
    if (!bg || bg.indexOf("url(") < 0) return;
    if (!isMediaBackground(el, bg)) return;
    mark(el);
  }

  function markTree(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches(SEL)) mark(root);
    var list = root.querySelectorAll(SEL);
    for (var i = 0; i < list.length; i++) mark(list[i]);

    if (root.matches && root.matches(BG_SEL)) markBgEl(root);
    var bgs = root.querySelectorAll(BG_SEL);
    for (var j = 0; j < bgs.length; j++) markBgEl(bgs[j]);
  }

  function markAll() {
    markTree(document.documentElement);
  }

  // 兜底：不用内联样式的背景图（主题/第三方插件自带的类）只能全量扫一遍计算样式。
  // 页面两千个元素约 10ms，只在有新节点进来时按 1.5s 节流跑。
  var bgScanTimer = 0;
  function scanBackgrounds() {
    if (!state.on) return;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) markBgEl(all[i]);
  }

  function scheduleBgScan() {
    if (bgScanTimer) return;
    bgScanTimer = setTimeout(function () { bgScanTimer = 0; scanBackgrounds(); }, 1500);
  }

  // ===== 文字打码 =====
  var textOrig = new Map();   // Text -> { orig, masked }
  var attrOrig = [];          // { el, name, orig, masked }
  var titleState = { orig: "", masked: "" };

  function visualLen(t) {
    var n = 0;
    for (var i = 0; i < t.length; i++) {
      if (/\s/.test(t.charAt(i))) { n += 0.34; continue; }
      n += t.charCodeAt(i) > 0x2e80 ? 1 : 0.56;
    }
    return n;
  }

  // 逐字符换小写字母，空格照留，替换后与原文一样长
  function letterize(s, seed) {
    var r = rng(seed >>> 0);
    var pool = "abcdefghijklmnopqrstuvwxyz";
    var out = "";
    for (var i = 0; i < s.length; i++) {
      out += /\s/.test(s.charAt(i)) ? s.charAt(i) : pool.charAt(Math.floor(r() * pool.length));
    }
    return out;
  }

  function maskValue(s, seed, words) {
    if (cfg.textStyle === "sunny") {
      var base = (seed || 0) >>> 0;
      var n = words > 0 ? words : (s.length > 60 ? 3 : (s.length > 14 ? 2 : 1));
      var out = [];
      for (var i = 0; i < n; i++) out.push(SUNNY[(base + i * 7) % SUNNY.length]);
      return out.join(" ");
    }
    if (cfg.textStyle === "char") return letterize(s, seed || 0);
    // symbol / black / white 都是等长块，差别只在颜色，颜色由 CSS 按 data-peekaboo-text 给
    var len = Math.max(1, Math.min(80, Math.round(visualLen(s))));
    var buf = "";
    for (var j = 0; j < len; j++) buf += "█";
    return buf;
  }

  function normalizeStyle(v) {
    var s = String(v || "").trim().toLowerCase();
    return TEXT_STYLES.indexOf(s) >= 0 ? s : "";
  }

  // 一条替换结果里的词数：0 = 按原文长度自动。项名固定一个词，主名 1–2 个，别名可多几个
  function wordsFor(el, orig) {
    if (el.closest(".alias-head")) return 3;
    if (el.closest(".performer-name")) return visualLen(orig || "") > 8 ? 2 : 1;
    if (el.closest(".detail-item-title")) return 1;
    return 0;
  }

  function textNodesOf(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var out = [];
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentElement;
      if (!p || inSafeZone(p)) continue;                                // 按钮/输入框里的字保留
      out.push(n);
    }
    return out;
  }

  // 整块当一个单位替换：像「性别:」这种被 React 拆成两个文本节点的，按节点分头替换会变成两个词
  function maskUnit(el, words) {
    // 只认自己这一层的文字：嵌套的字段/链接/药丸（owner 是自己的后代）各自成块，别被父级吞掉；
    // 反过来，目标只是字段内部的一个普通 span 时（owner 是祖先）仍归自己处理
    var nodes = textNodesOf(el).filter(function (node) {
      var owner = node.parentElement && node.parentElement.closest(TEXT_SEL + "," + UNIT_SEL);
      return !owner || owner === el || !el.contains(owner);
    });
    if (!nodes.length) return false;
    var done = true;
    var orig = "";
    for (var i = 0; i < nodes.length; i++) {
      var rec = textOrig.get(nodes[i]);
      orig += rec ? rec.orig : nodes[i].nodeValue;
      if (!rec || rec.masked !== nodes[i].nodeValue) done = false;
    }
    if (done || !orig.trim()) return false;

    // 详情区一行是「标签: 值」，只遮值，标签留着当路标；没有冒号的纯分组标签（「图库」）不遮
    var prefix = "";
    if (el.tagName === "H6") {
      var m = /^([^:：]{1,12}[:：]\s*)([\s\S]*)$/.exec(orig);
      if (!m || !m[2].trim()) return false;
      prefix = m[1];
    }
    var body = orig.slice(prefix.length);
    var masked = prefix + maskValue(body, hash((el.getAttribute("class") || el.tagName) + "|" + body), words);
    // 英文词要靠空格隔开，否则相邻节点/元素会连成 "mintsunshine"
    if (cfg.textStyle === "sunny") masked += " ";

    var target = null;
    for (var t = 0; t < nodes.length; t++) {
      var r0 = textOrig.get(nodes[t]);
      if ((r0 ? r0.orig : nodes[t].nodeValue).trim()) { target = nodes[t]; break; }
    }
    if (!target) target = nodes[0];

    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j];
      var r = textOrig.get(node);
      var o = r ? r.orig : node.nodeValue;
      var mm = node === target ? masked : "";
      textOrig.set(node, { orig: o, masked: mm });
      if (node.nodeValue !== mm) node.nodeValue = mm;
    }
    return true;
  }

  function unmaskNode(node) {
    var rec = textOrig.get(node);
    if (!rec) return;
    if (node.isConnected && node.nodeValue === rec.masked) node.nodeValue = rec.orig;
    textOrig.delete(node);
  }

  function maskAttrs(el) {
    var list = el.querySelectorAll("[title]");
    var own = el.hasAttribute && el.hasAttribute("title") ? [el] : [];
    var nodes = own.concat(Array.prototype.slice.call(list));
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.__peekabooAttr || inSafeZone(n)) continue;
      n.__peekabooAttr = true;
      var orig = n.getAttribute("title");
      if (!orig || !orig.trim()) continue;
      var masked = maskValue(orig, hash(orig));
      attrOrig.push({ el: n, name: "title", orig: orig, masked: masked });
      n.setAttribute("title", masked);
    }
    var imgs = el.tagName === "IMG" ? [el] : Array.prototype.slice.call(el.querySelectorAll("img[alt]"));
    for (var k = 0; k < imgs.length; k++) {
      var img = imgs[k];
      var alt = img.getAttribute("alt");
      if (!alt || !alt.trim() || img.__peekabooAttr) continue;
      if (inSafeZone(img)) continue;
      img.__peekabooAttr = true;
      var am = maskValue(alt, hash(alt));
      attrOrig.push({ el: img, name: "alt", orig: alt, masked: am });
      img.setAttribute("alt", am);
    }
  }

  function restoreAttrs() {
    for (var i = 0; i < attrOrig.length; i++) {
      var a = attrOrig[i];
      if (a.el.isConnected && a.el.getAttribute(a.name) === a.masked) a.el.setAttribute(a.name, a.orig);
      a.el.__peekabooAttr = false;
    }
    attrOrig = [];
  }

  function inSafeZone(el) {
    return !!(el && el.closest && el.closest(SAFE_SEL));
  }

  // 遮字元素的配色可能与本来的背景一样暗（标签就是深灰字），块会看不见；统一给中性灰
  function markMasked(el) {
    if (el.__peekabooMasked) return;
    el.__peekabooMasked = true;
    el.setAttribute("data-peekaboo-masked", "");
  }

  function unmaskEls() {
    var list = document.querySelectorAll("[data-peekaboo-masked]");
    for (var i = 0; i < list.length; i++) {
      list[i].removeAttribute("data-peekaboo-masked");
      list[i].__peekabooMasked = false;
    }
  }

  function isSettingsPage() {
    return location.pathname.indexOf("/settings") === 0;
  }

  function maskEl(el) {
    if (!el || inSafeZone(el)) return;
    var masked = false;
    if (el.matches(UNIT_SEL)) {
      masked = maskUnit(el, wordsFor(el, el.textContent));
    } else {
      // 容器里有角色元素（项的标题/值、主名、别名）就逐个处理，别把整块并成一条
      var units = el.querySelectorAll(UNIT_SEL);
      if (units.length) {
        for (var u = 0; u < units.length; u++) {
          if (maskUnit(units[u], wordsFor(units[u], units[u].textContent))) masked = true;
        }
      } else {
        masked = maskUnit(el, 0);
      }
    }
    maskAttrs(el);
    if (masked) markMasked(el);                                         // 没遮的标签保持原色
  }

  function maskTree(root) {
    if (!root || !cfg.maskText || !state.on) return;
    if (isSettingsPage()) return;                                       // 设置页没有库内容，一律不动
    if (root.nodeType === 3) {                                          // 文本节点被 React 改写
      var p = root.parentElement;
      if (!p || inSafeZone(p)) return;
      var unit = p.closest(UNIT_SEL);
      if (unit) {
        if (maskUnit(unit, wordsFor(unit, unit.textContent))) markMasked(unit);
        return;
      }
      if (!p.closest(TEXT_SEL)) return;                                 // 只处理字段区，别把界面文字也遮了
      if (maskUnit(p, 0)) markMasked(p);
      return;
    }
    if (root.nodeType !== 1) return;
    var els = [];
    if (root.matches && root.matches(TEXT_SEL + "," + UNIT_SEL)) els.push(root);
    var list = root.querySelectorAll(TEXT_SEL + "," + UNIT_SEL);
    for (var i = 0; i < list.length; i++) els.push(list[i]);
    for (var j = 0; j < els.length; j++) maskEl(els[j]);
  }

  function unmaskAll() {
    textOrig.forEach(function (rec, node) { unmaskNode(node); });
    textOrig.clear();
    restoreAttrs();
    unmaskEls();
  }

  function maskTitle() {
    if (!cfg.maskText || !state.on || isSettingsPage()) return;
    var t = document.title;
    if (!t) return;
    if (titleState.masked && t === titleState.masked) return;
    titleState.orig = t;
    var parts = t.split(" | ");
    if (UI_TITLE.indexOf(parts[0].trim()) === -1) parts[0] = "██████";
    titleState.masked = parts.join(" | ");
    document.title = titleState.masked;
  }

  function restoreTitle() {
    if (titleState.orig && document.title === titleState.masked) document.title = titleState.orig;
    titleState = { orig: "", masked: "" };
  }

  function applyTextMasks() {
    if (!state.on || !cfg.maskText || isSettingsPage()) {
      unmaskAll();
      restoreTitle();
      return;
    }
    document.documentElement.setAttribute(TEXT_ATTR, cfg.textStyle);     // 块状样式的颜色由 CSS 按它取
    maskTree(document.documentElement);
    maskTitle();
  }

  // ===== 动态内容 =====
  // 新增节点同步打标：交给下一帧就会先画出一帧原图（播放器海报、进度条预览气泡就是这里漏的）
  var textQueue = [];
  var textQueued = false;

  function flushText() {
    textQueued = false;
    var list = textQueue;
    textQueue = [];
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n.isConnected) continue;
      if (n.nodeType === 1) { markTree(n); maskTree(n); } else maskTree(n);
    }
    // 无限滚动会不断换掉文本节点，离场的引用留着没用
    if (textOrig.size > 4000) {
      textOrig.forEach(function (rec, node) {
        if (!node.isConnected) textOrig.delete(node);
      });
    }
  }

  function queueText(n) {
    textQueue.push(n);
    if (textQueued) return;
    textQueued = true;
    Promise.resolve().then(flushText);                                  // 微任务，仍在本次绘制前
  }

  var observer = new MutationObserver(function (mutations) {
    if (!state.on) return;
    var added = false;
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === "childList") {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType === 3) { queueText(node); continue; }       // React 换掉整段文字时不经过元素节点
          if (node.nodeType !== 1) continue;
          markTree(node);
          maskTree(node);
          added = true;
        }
      } else if (m.type === "characterData") {
        if (m.target && m.target.nodeType === 3) queueText(m.target);
      } else if (m.target && m.target.nodeType === 1) {
        queueText(m.target);
      }
    }
    if (added) scheduleBgScan();
  });

  function startObserver() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src", "poster"]
    });

    var titleObs = new MutationObserver(function () {
      if (state.on && cfg.maskText) maskTitle();
    });
    var watch = function () {
      var t = document.querySelector("title");
      if (t) titleObs.observe(t, { childList: true, characterData: true, subtree: true });
    };
    watch();
    // SPA 换页后 <title> 可能被整体替换
    setInterval(watch, 5000);
  }

  // ===== 视频 =====
  function pauseAllVideos() {
    var list = document.querySelectorAll("video");
    for (var i = 0; i < list.length; i++) {
      try { list[i].pause(); } catch (e) { /* 播放器未就绪 */ }
    }
  }

  document.addEventListener("play", function (e) {
    if (!state.on || cfg.allowVideo) return;
    var v = e.target;
    if (!v || v.tagName !== "VIDEO") return;
    // 卡片预览由 Stash 自己在悬停时播放，本就是静音的一段循环；这里只保证不出声，不拦
    if (v.classList.contains("scene-card-preview-video")) {
      v.muted = true;
      return;
    }
    try { v.pause(); } catch (err) { /* 忽略 */ }
  }, true);

  // ===== 悬停预览 =====
  var peekEl = null;
  var peekPending = null;
  var peekTimer = 0;
  var PEEK_DELAY = 280;

  function cancelPeek() {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = 0; }
    peekPending = null;
  }

  function peekStart(el) {
    if (!el || !el.isConnected) return;
    if (peekEl && peekEl !== el) peekEl.classList.remove(PEEK);
    peekEl = el;
    el.classList.add(PEEK);
  }

  function peekEnd() {
    cancelPeek();
    if (peekEl) {
      peekEl.classList.remove(PEEK);
      peekEl = null;
    }
  }

  function peekHost(e) {
    var t = e.target;
    if (!t || !t.closest) return null;
    var card = t.closest(HOST_SEL);
    if (card && card.querySelector("img, video, [" + ART_ATTR + "]")) return card;
    return t.closest("[data-peekaboo-art], img, video");
  }

  function schedulePeek(host, delay) {
    cancelPeek();
    peekPending = host;
    peekTimer = setTimeout(function () {
      peekTimer = 0;
      var el = peekPending;
      peekPending = null;
      peekStart(el);
    }, delay);
  }

  document.addEventListener("pointerover", function (e) {
    if (!state.on || !cfg.hoverPeek || state.reveal) return;
    var host = peekHost(e);
    if (!host) return;
    if (host === peekEl || host === peekPending) return;                // 卡片内部移动不重置计时
    if (peekEl) { peekEl.classList.remove(PEEK); peekEl = null; }
    schedulePeek(host, PEEK_DELAY);
  }, true);

  document.addEventListener("pointerout", function (e) {
    var to = e.relatedTarget;
    // 计时还没到就移开也要取消，否则计时器会把已经离开的卡片钉在“露原图”状态
    if (peekPending && (!to || !peekPending.contains(to))) cancelPeek();
    if (peekEl && (!to || !peekEl.contains(to))) peekEnd();
  }, true);

  // 触屏：长按预览
  document.addEventListener("touchstart", function (e) {
    if (!state.on || !cfg.hoverPeek || state.reveal) return;
    var host = peekHost(e);
    if (!host || host === peekEl) return;
    schedulePeek(host, 350);
  }, { capture: true, passive: true });

  ["touchend", "touchcancel", "touchmove"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (ev === "touchmove" && !peekEl && !peekPending) return;
      peekEnd();
    }, { capture: true, passive: true });
  });

  // 按住 Shift 全局露
  function setReveal(on) {
    on = !!on && state.on;
    if (state.reveal === on) return;
    state.reveal = on;
    if (on) peekEnd();
    document.documentElement.classList.toggle(REVEAL, on);
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Shift" || !state.on) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    setReveal(true);
  }, true);

  document.addEventListener("keyup", function (e) {
    if (e.key === "Shift") setReveal(false);
  }, true);

  window.addEventListener("blur", function () { setReveal(false); });

  // ===== 开关 =====
  function setState(on, persist) {
    on = !!on;
    state.on = on;
    if (on) {
      markAll();
      scanBackgrounds();
    }
    document.documentElement.classList.toggle(ON, on);
    if (!on) peekEnd();
    setReveal(false);
    applyTextMasks();
    if (on && !cfg.allowVideo) pauseAllVideos();

    try { localStorage.setItem(LS_KEY, on ? "1" : "0"); } catch (e) { /* 无痕模式 */ }

    updateButton();
    if (persist) persistState();
  }

  // configurePlugin 是整体覆盖：必须带上全部设置项，否则没传的会被写成空
  function persistState() {
    var ready = cfgLoaded
      ? Promise.resolve(true)
      : loadConfig().then(function (ok) { cfgLoaded = ok; return ok; });

    ready.then(function (ok) {
      if (!ok) return;
      cfg.enabled = state.on;
      return saveConfig({
        enabled: cfg.enabled,
        hoverPeek: cfg.hoverPeek,
        allowVideo: cfg.allowVideo,
        maskText: cfg.maskText,
        textStyle: cfg.textStyle
      });
    }).catch(function (e) {
      console.warn("[peekaboo] 保存状态失败：", e);
    });
  }

  function gql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (res) {
      return res.json();
    }).then(function (json) {
      if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
      return json.data;
    });
  }

  function saveConfig(settings) {
    return gql("mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}", {
      id: PLUGIN_ID,
      input: settings
    }).catch(function (e) {
      console.warn("[peekaboo] 写入设置失败：", e);
    });
  }

  // 插件设置没有「默认值」字段，新装的插件读到的全是 false / ""。
  // 用 textStyle 是否为空判断「从没保存过」，此时把默认值写回去，设置页才和实际行为一致
  var DEFAULTS = { hoverPeek: true, allowVideo: false, maskText: true, textStyle: DEFAULT_TEXT_STYLE };

  function loadConfig() {
    return gql("{configuration{plugins}}").then(function (data) {
      var plugins = (data && data.configuration && data.configuration.plugins) || {};
      var s = plugins[PLUGIN_ID] || {};
      var raw = s.textStyle == null ? "" : String(s.textStyle).trim();
      var first = !raw;
      cfg.enabled = s.enabled === true;
      cfg.hoverPeek = first ? DEFAULTS.hoverPeek : s.hoverPeek !== false;
      cfg.allowVideo = first ? DEFAULTS.allowVideo : s.allowVideo === true;
      cfg.maskText = first ? DEFAULTS.maskText : s.maskText !== false;
      cfg.textStyle = normalizeStyle(raw) || DEFAULTS.textStyle;
      if (first) {
        saveConfig({
          enabled: cfg.enabled,
          hoverPeek: cfg.hoverPeek,
          allowVideo: cfg.allowVideo,
          maskText: cfg.maskText,
          textStyle: cfg.textStyle
        });
      }
      // 配置读到时页面可能已经遮过一轮（那时用的还是默认样式），块的颜色靠这个属性取
      document.documentElement.setAttribute(TEXT_ATTR, cfg.textStyle);
      return true;
    }).catch(function (e) {
      console.warn("[peekaboo] 读取设置失败：", e);
      return false;
    });
  }

  function signature() {
    return [cfg.enabled, cfg.hoverPeek, cfg.allowVideo, cfg.maskText, cfg.textStyle].join("|");
  }

  // 设置页改完立刻生效，不用刷新
  function refreshFromSettings() {
    loadConfig().then(function (ok) {
      if (!ok) return;
      var sig = signature();
      if (sig === cfgSig) return;
      cfgSig = sig;
      if (cfg.enabled !== state.on) {
        setState(cfg.enabled, false);
      } else {
        if (state.on) {
          unmaskAll();                                                  // 样式/范围整个变过，先复原再重遮
          applyTextMasks();
          if (!cfg.allowVideo) pauseAllVideos();
        } else {
          unmaskAll();
        }
        updateButton();
      }
    });
  }

  function startSettingsSync() {
    setInterval(function () {
      if (isSettingsPage()) refreshFromSettings();
    }, 2000);
    window.addEventListener("focus", refreshFromSettings);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refreshFromSettings();
    });
    window.addEventListener("popstate", refreshFromSettings);

    // SPA 换页后同步一次，别的设备改了设置也能跟上
    var push = history.pushState;
    history.pushState = function () {
      var ret = push.apply(this, arguments);
      setTimeout(refreshFromSettings, 400);
      return ret;
    };
  }

  // ===== 导航栏按钮 =====
  function createButton() {
    if (document.getElementById(BTN_ID)) return;
    var wrap = document.createElement("a");
    wrap.className = "mr-2";
    wrap.innerHTML =
      '<button id="' + BTN_ID + '" type="button" class="minimal d-flex align-items-center h-100 btn btn-primary">' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor">' +
      '<path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5c-.93 0-1.82.18-2.65.5l.79.79A5.9 5.9 0 0 1 8 3.5c2.12 0 3.88 1.17 5.17 2.46A13.2 13.2 0 0 1 14.83 8c-.06.09-.12.18-.2.29-.33.48-.83 1.12-1.46 1.75-.17.17-.34.33-.52.49l.71.71z"/>' +
      '<path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822z"/>' +
      '<path d="M8.354 10.475l.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z"/>' +
      '<path d="M3.35 5.47c-.18.16-.35.32-.52.49A13.2 13.2 0 0 0 1.17 8l.2.29c.33.48.83 1.12 1.46 1.75C4.12 11.33 5.88 12.5 8 12.5c.72 0 1.39-.13 2.02-.36l.77.77A7 7 0 0 1 8 13.5C3 13.5 0 8 0 8s.94-1.72 2.64-3.24l.71.71z"/>' +
      '<path d="M13.646 14.354l-12-12 .708-.708 12 12-.708.708z"/>' +
      "</svg></button>";

    var tries = 0;
    var timer = setInterval(function () {
      var bar = document.querySelector(".navbar-buttons");
      if (bar) {
        clearInterval(timer);
        if (!document.getElementById(BTN_ID)) bar.insertBefore(wrap, bar.firstChild);
        var btn = document.getElementById(BTN_ID);
        if (btn) btn.addEventListener("click", function () { setState(!state.on, true); });
        updateButton();
        return;
      }
      if (++tries > 100) clearInterval(timer);
    }, 100);
  }

  function updateButton() {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.title = state.on
      ? tc("关闭遮挡（Shift+Alt+B）", "Turn the shield off (Shift+Alt+B)")
      : tc("开启遮挡（Shift+Alt+B）", "Turn the shield on (Shift+Alt+B)");
    btn.style.color = state.on ? "#5cff00" : "";
  }

  // ===== 快捷键 =====
  document.addEventListener("keydown", function (e) {
    if (!e.shiftKey || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code !== "KeyB" && e.key !== "B" && e.key !== "b") return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    setState(!state.on, true);
  }, true);

  // ===== 启动 =====
  function boot() {
    injectDefs();
    createButton();
    // 先用本浏览器的缓存值上屏，再用 Stash 设置校正。
    // 缓存为空（换设备、清过站点数据）时按“开”处理：宁可多遮一瞬，也别先露一帧原图
    var cached = null;
    try { cached = localStorage.getItem(LS_KEY); } catch (e) { /* 忽略 */ }
    if (cached !== "0") setState(true, false);

    startObserver();
    startSettingsSync();

    loadConfig().then(function (ok) {
      cfgLoaded = ok;
      if (!ok) return;
      cfgSig = signature();
      if (cfg.enabled !== state.on) setState(cfg.enabled, false);
      else updateButton();
    });

    console.log("[peekaboo] v" + PLUGIN_VERSION);
  }

  // 首屏绘制前就把 class 挂上（插件 CSS 按 class 门控）。缓存为关才不挂
  try {
    if (localStorage.getItem(LS_KEY) !== "0") document.documentElement.classList.add(ON);
  } catch (e) {
    document.documentElement.classList.add(ON);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
