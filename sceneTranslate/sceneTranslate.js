/**
 * Scene Translate Plugin v2.9.0
 *
 * Adds one-click translate buttons to scene & image edit pages.
 * Settings (translateTool/targetLanguage/idleTimeout/proxyPort) are stored in
 * Stash plugin config only. config.json holds API keys (proxyPort is fallback).
 * google_free engine works without proxy (browser direct fallback);
 * other engines require the "Start Translate Proxy" task in plugin settings.
 * Proxy URL auto-detects host from Stash URL (supports Docker port mapping).
 */

try {
(function () {
  "use strict";

  // 幂等守卫：Stash 的 useScript 会在插件列表变化时移除并重挂 <script> 标签导致脚本重执行，
  // 重复执行会反复探测代理刷屏、堆积 MutationObserver、嵌套包装 pushState，跳过后续执行
  if (window.__sceneTranslateLoaded) return;
  window.__sceneTranslateLoaded = true;

  // ─── Config ────────────────────────────────────────────────────────

  // 用访问 Stash 的 hostname 自动推断代理 URL
  // 裸机: localhost/127.0.0.1 → 浏览器直接访问本机代理
  // Docker: 192.168.x.x → 浏览器访问映射到容器代理的宿主机端口
  var _proxyHost = window.location.hostname || "127.0.0.1";
  var config = {
    translateTool: "google_free",
    targetLanguage: "zh-CN",
    idleTimeout: 600,
    proxyUrl: "http://" + _proxyHost + ":9998",
  };

  var proxyOnline = false;
  var injectedSceneId = null;
  var _observerTimer = null;

  // ─── i18n：跟随 Stash 界面语言 ─────────────────────────────────────
  // 经 PluginApi 在 React 树内挂一个渲染 null 的桥接组件，读取 IntlProvider 的 context。
  // patch 点必须是 "App"（AppContainer，包裹全部页面内容）：不能用 "PluginRoutes"，
  // 它位于 <Switch> 内，URL 命中正常路由时不会被渲染。
  // PluginApi 不可用时 tc() 回退英文（本插件文案原本即英文）。
  var _intlMessages = null;
  var _intlLocale = "";

  (function initIntlBridge() {
    try {
      var api = window.PluginApi;
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return;
      var React = api.React;
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl();
        React.useEffect(function () {
          _intlMessages = intl.messages || null;
          _intlLocale = intl.locale || "";
        });
        return null;
      }
      api.patch.before("App", function (props) {
        return [{
          children: React.createElement(React.Fragment, null,
            React.createElement(IntlBridge),
            props.children)
        }];
      });
    } catch (e) {
      console.warn("[SceneTranslate] i18n bridge unavailable:", e);
    }
  })();

  // 自定义句（语言包中无对应 key）：中文语言用中文，其余语言用英文；语言未知时按英文兜底
  function tc(zh, en) {
    return (_intlLocale && !/^zh/i.test(_intlLocale)) ? en : zh;
  }

  // ─── Cross-browser fetch with timeout ─────────────────────────────

  function fetchWithTimeout(url, options, timeoutMs) {
    if (!timeoutMs) return fetch(url, options);

    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      options = options || {};
      options.signal = AbortSignal.timeout(timeoutMs);
      return fetch(url, options);
    }

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    options = options || {};
    options.signal = ctrl.signal;
    return fetch(url, options).then(
      function (resp) { clearTimeout(timer); return resp; },
      function (err) { clearTimeout(timer); throw err; }
    );
  }

  // ─── Stash GraphQL (Plugin Settings) ───────────────────────────────
  // 插件设置存储在 Stash 的 config.yml 中，通过 GraphQL 读写。
  // 这样不依赖代理在线就能拿到目标语言，解决 google_free 离线模式下的配置读取问题。

  var PLUGIN_ID = "sceneTranslate";

  function callGQL(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.errors && d.errors.length) throw new Error(d.errors[0].message);
      return d.data;
    });
  }

  function fetchStashPluginConfig() {
    return callGQL("query { configuration { plugins } }").then(function (data) {
      var plugins = (data && data.configuration && data.configuration.plugins) || {};
      return plugins[PLUGIN_ID] || {};
    });
  }

  // 应用插件页设置到内存 config（loadConfig 与每次点击前共用）
  function applyStashConfig(stashCfg) {
    if (stashCfg.translateTool) config.translateTool = stashCfg.translateTool;
    if (stashCfg.targetLanguage) config.targetLanguage = stashCfg.targetLanguage;
    if (stashCfg.idleTimeout !== undefined && stashCfg.idleTimeout !== null) {
      var n = parseInt(stashCfg.idleTimeout, 10);
      if (!isNaN(n)) config.idleTimeout = n;
    }
    if (stashCfg.proxyPort !== undefined && stashCfg.proxyPort !== null && String(stashCfg.proxyPort).trim() !== "") {
      var p = parseInt(stashCfg.proxyPort, 10);
      if (!isNaN(p) && p > 0 && p < 65536) {
        config.proxyUrl = "http://" + _proxyHost + ":" + p;
      }
    }
  }

  // ─── Proxy Connection ──────────────────────────────────────────────

  function fetchProxyConfig() {
    // 仅用于探测代理是否在线，不再从代理 /config 读取引擎/语言
    // （这三项已由 Stash 插件页管理，代理 /config 返回的是默认值，会覆盖正确配置）
    return fetchWithTimeout(config.proxyUrl + "/config", { method: "GET" }, 3000)
    .then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      proxyOnline = true;
      return true;
    }).catch(function () {
      proxyOnline = false;
      return false;
    });
  }

  function loadConfig() {
    // 仅读取 Stash 插件设置（不依赖代理在线，google_free 离线也能拿到目标语言）
    return fetchStashPluginConfig().then(function (stashCfg) {
      applyStashConfig(stashCfg);
      // 探测代理是否在线（离线则忽略，google_free 可走浏览器直连）
      fetchProxyConfig().catch(function () { /* proxy offline, fine */ });
      return true;
    }).catch(function () {
      // GraphQL 不可用（旧版 Stash 或异常）→ 仅探测代理
      return fetchProxyConfig();
    });
  }

  // 更新已注入按钮的 tooltip，使其反映最新 config
  function refreshButtonTooltips() {
    var btns = document.querySelectorAll(".scene-translate-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].title = tc("翻译", "Translate") + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";
    }
  }

  function ensureProxy() {
    if (proxyOnline) return Promise.resolve(true);
    return fetchProxyConfig();
  }

  // ─── Translation ──────────────────────────────────────────────────

  function translateViaProxy(text, targetLang, engine) {
    return fetch(config.proxyUrl + "/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, targetLang: targetLang, engine: engine, idleTimeout: config.idleTimeout }),
    }).then(function (resp) {
      if (!resp.ok) return resp.json().then(function (e) { throw new Error(e.error || "HTTP " + resp.status); });
      return resp.json();
    }).then(function (d) {
      if (d.error) throw new Error(d.error);
      proxyOnline = true;
      return d.translatedText;
    }).catch(function (e) {
      var msg = (e.message || "").toLowerCase();
      if (msg.indexOf("failed to fetch") >= 0 || msg.indexOf("networkerror") >= 0 ||
          msg.indexOf("err_connection") >= 0 || msg.indexOf("net::err_") >= 0 ||
          msg.indexOf("load failed") >= 0 || msg.indexOf("abort") >= 0) {
        proxyOnline = false;
      }
      throw e;
    });
  }

  function googleFreeTranslate(text, targetLang) {
    if (!text || !text.trim()) return Promise.resolve(text);
    var url = "https://translate.googleapis.com/translate_a/single?" +
      new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLang, dt: "t", q: text });
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d && Array.isArray(d[0])) {
        var t = "";
        for (var i = 0; i < d[0].length; i++) {
          if (Array.isArray(d[0][i]) && d[0][i][0]) t += d[0][i][0];
        }
        return t || text;
      }
      return text;
    });
  }

  function translateText(text, targetLang) {
    if (!text || !text.trim()) return Promise.resolve(text);
    var tool = config.translateTool || "google_free";

    if (tool === "google_free") {
      return translateViaProxy(text, targetLang, tool).catch(function () {
        return googleFreeTranslate(text, targetLang);
      });
    }

    return translateViaProxy(text, targetLang, tool);
  }

  // ─── React Input ──────────────────────────────────────────────────

  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ─── Translate Button ─────────────────────────────────────────────

  // 线性 SVG 图标（feather 风格，与 sceneGallerySync 注入按钮规格一致）
  var ICONS = {
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',  // 文A（lucide languages）
    spin: '<svg class="scene-translate-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  };

  function createTranslateButton(inputEl, fieldName) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm scene-translate-btn";
    btn.innerHTML = ICONS.globe;
    btn.style.cssText = "margin-left:6px;";
    btn.title = tc("翻译 " + fieldName, "Translate " + fieldName) + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";

    btn.addEventListener("click", function () {
      var text = inputEl.value || "";
      if (!text.trim()) return;
      btn.disabled = true;
      btn.innerHTML = ICONS.spin;

      ensureProxy().then(function (online) {
        // 每次点击前重新读取 Stash 插件设置，确保用户在设置页改的参数立即生效
        return fetchStashPluginConfig().then(function (stashCfg) {
          applyStashConfig(stashCfg);
          // 更新按钮 tooltip 反映最新配置
          btn.title = tc("翻译 " + fieldName, "Translate " + fieldName) + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";
        }).catch(function () { /* GraphQL 不可用则沿用内存配置 */ });
      }).then(function () {
        // google_free 可在代理离线时走浏览器直连兜底，不强制要求代理在线
        if (!proxyOnline && config.translateTool !== "google_free") {
          throw new Error(tc("代理未运行！请在插件设置中运行「启动翻译代理」任务。", "Proxy not running! Click 'Start Translate Proxy' in plugin settings."));
        }
        return translateText(text, config.targetLanguage);
      }).then(function (translated) {
        if (translated && translated !== text) {
          setNativeValue(inputEl, translated);
          btn.innerHTML = ICONS.ok;
          btn.classList.add("scene-translate-ok");
          setTimeout(function () {
            btn.innerHTML = ICONS.globe;
            btn.classList.remove("scene-translate-ok");
          }, 2000);
        } else {
          btn.innerHTML = ICONS.globe;
        }
      }).catch(function (e) {
        btn.innerHTML = ICONS.err;
        btn.classList.add("scene-translate-err");
        var msg = e.message || tc("未知错误", "Unknown error");
        btn.title = tc("错误：", "Error: ") + msg;
        console.error("[SceneTranslate] " + fieldName + " error: " + msg);
        setTimeout(function () {
          btn.innerHTML = ICONS.globe;
          btn.classList.remove("scene-translate-err");
          btn.title = tc("翻译 " + fieldName, "Translate " + fieldName) + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";
        }, 4000);
      }).finally(function () {
        btn.disabled = false;
      });
    });

    return btn;
  }

  // ─── Field Matching ───────────────────────────────────────────────

  var TITLE_PATTERNS = /title|标题|タイトル|제목/i;
  var DETAILS_PATTERNS = /details|synopsis|description|简介|详情|詳細|설명|あらすじ/i;
  var SKIP_PATTERNS = /studio|movie|tag|工作室|标签|系列|ショート|시리즈/i;

  // ─── Inject Buttons ───────────────────────────────────────────────

  function injectTranslateButtons() {
    var sceneId = getSceneIdFromUrl();
    if (!sceneId) return;
    if (sceneId === injectedSceneId && document.querySelector(".scene-translate-btn")) return;

    var labels = document.querySelectorAll("label");
    var titleInput = null, titleLabel = null;
    var detailsTextarea = null, detailsLabel = null;

    // 结构锚点优先（与界面语言无关）：Stash 编辑表单字段带 data-field / label[for] 属性
    var tRow = document.querySelector('[data-field="title"]');
    if (tRow) {
      titleInput = tRow.querySelector("input");
      titleLabel = tRow.querySelector("label");
    } else {
      titleInput = document.querySelector("input#title, input[name='title']");
      titleLabel = document.querySelector("label[for='title']");
    }
    var dRow = document.querySelector('[data-field="details"]');
    if (dRow) {
      detailsTextarea = dRow.querySelector("textarea");
      detailsLabel = dRow.querySelector("label");
    } else {
      detailsTextarea = document.querySelector("textarea#details, textarea[name='details']");
      detailsLabel = document.querySelector("label[for='details']");
    }

    // 文本匹配兜底（仅旧版本 Stash 无结构属性时使用）
    for (var i = 0; i < labels.length && (!titleInput || !detailsTextarea); i++) {
      var label = labels[i];
      var text = (label.textContent || "").trim();
      if (label.querySelector(".scene-translate-btn")) continue;

      if (!titleInput && TITLE_PATTERNS.test(text) && !SKIP_PATTERNS.test(text)) {
        var row = label.closest(".row") || label.closest(".form-group") || label.parentElement;
        if (row) {
          var input = row.querySelector('input[type="text"], input:not([type])');
          if (input) { titleInput = input; titleLabel = label; }
        }
      }
      if (!detailsTextarea && DETAILS_PATTERNS.test(text)) {
        var row = label.closest(".row") || label.closest(".form-group") || label.parentElement;
        if (row) {
          var ta = row.querySelector("textarea");
          if (ta) { detailsTextarea = ta; detailsLabel = label; }
        }
      }
    }

    // 找不到 label 时放弃本次注入（不使用 fallback 注入到 block 容器，避免整行显示）
    // 等待下次重试（onUrlChange 的多次 setTimeout / MutationObserver）
    if (titleInput && !titleLabel) titleInput = null;
    if (detailsTextarea && !detailsLabel) detailsTextarea = null;

    // 字段未准备好说明 DOM 还在渲染，等待下次重试
    if (!titleInput && !detailsTextarea) return;

    var injected = false;

    if (titleInput && titleLabel && !titleLabel.querySelector(".scene-translate-btn")) {
      titleLabel.appendChild(createTranslateButton(titleInput, "title"));
      injected = true;
    }

    if (detailsTextarea && detailsLabel && !detailsLabel.querySelector(".scene-translate-btn")) {
      detailsLabel.appendChild(createTranslateButton(detailsTextarea, "details"));
      injected = true;
    }

    if (injected) {
      injectedSceneId = sceneId;
    }
  }

  // ─── URL Helpers ──────────────────────────────────────────────────

  function getSceneIdFromUrl() {
    // 支持 scenes/images/galleries 编辑页，返回 "类型:id" 以避免 id 空间重叠
    var re = /\/(scenes?|images?|galleries?)\/(\d+)/;
    var m = window.location.pathname.match(re);
    if (m) return m[1] + ":" + m[2];
    m = window.location.hash.match(re);
    return m ? (m[1] + ":" + m[2]) : null;
  }

  function isScenePage() {
    return /\/(scenes?|images?|galleries?)\/\d+/.test(window.location.pathname + window.location.hash);
  }

  // ─── Init ──────────────────────────────────────────────────────────

  function initPlugin() {
    // 立即注册观察器，不等待 loadConfig
    // 否则 fetch 期间 React 组件已渲染，错过第一次 patch 回调和 MutationObserver 首次触发
    setupObservers();
    if (isScenePage()) {
      // 多次重试，覆盖 DOM 渐进渲染（Chrome 翻译干扰下更慢）
      setTimeout(injectTranslateButtons, 300);
      setTimeout(injectTranslateButtons, 1000);
      setTimeout(injectTranslateButtons, 2000);
      setTimeout(injectTranslateButtons, 3000);
    }
    // 异步加载配置，完成后刷新已注入按钮的 tooltip
    loadConfig().then(function () {
      refreshButtonTooltips();
    });
  }

  function setupObservers() {
    var PluginApi = window.PluginApi;
    if (PluginApi && PluginApi.patch && PluginApi.patch.after) {
      var names = ["Scene", "SceneEditPanel", "SceneEdit", "SceneDetails",
                   "Image", "ImageEditPanel", "ImageEdit", "ImageDetails"];
      for (var i = 0; i < names.length; i++) {
        try {
          PluginApi.patch.after(names[i], function (props) {
            requestAnimationFrame(function () {
              setTimeout(injectTranslateButtons, 200);
            });
            return props;
          });
        } catch (e) { /* skip */ }
      }
    }

    var observerTarget = document.querySelector(".main-content") || document.querySelector("#root") || document.body;
    var observer = new MutationObserver(function (mutations) {
      if (!isScenePage()) return;
      var hasMeaningfulChange = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "childList" && m.addedNodes.length > 0) {
          for (var j = 0; j < m.addedNodes.length; j++) {
            var node = m.addedNodes[j];
            if (node.nodeType === 1) {
              var tag = node.tagName;
              if (tag === "INPUT" || tag === "TEXTAREA" || tag === "LABEL" || tag === "FORM" || tag === "DIV") {
                hasMeaningfulChange = true;
                break;
              }
              if (node.querySelector && (node.querySelector("input") || node.querySelector("textarea") || node.querySelector("label"))) {
                hasMeaningfulChange = true;
                break;
              }
            }
          }
        }
        if (hasMeaningfulChange) break;
      }
      if (!hasMeaningfulChange) return;

      clearTimeout(_observerTimer);
      _observerTimer = setTimeout(function () {
        if (getSceneIdFromUrl() !== injectedSceneId) injectTranslateButtons();
      }, 300);
    });
    observer.observe(observerTarget, { childList: true, subtree: true });

    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () { origPush.apply(this, arguments); onUrlChange(); };
    history.replaceState = function () { origReplace.apply(this, arguments); onUrlChange(); };
    window.addEventListener("popstate", onUrlChange);
  }

  function onUrlChange() {
    if (!isScenePage()) { injectedSceneId = null; return; }
    injectedSceneId = null;
    // 导航到新页面时重新读取 Stash 插件设置，确保按钮 tooltip 即时反映最新配置
    loadConfig().then(function () {
      refreshButtonTooltips();
    });
    // 多次重试，覆盖 Chrome 翻译干扰下 DOM 渲染延迟的时机
    setTimeout(injectTranslateButtons, 300);
    setTimeout(injectTranslateButtons, 1000);
    setTimeout(injectTranslateButtons, 2000);
    setTimeout(injectTranslateButtons, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlugin);
  } else {
    initPlugin();
  }

})();
} catch (e) {
  console.error("[SceneTranslate] FATAL:", e);
}
