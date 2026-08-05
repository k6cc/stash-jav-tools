/**
 * Scene Translate Plugin v2.4
 *
 * Adds one-click translate buttons to scene edit page.
 * Proxy must be started manually via "Start Translate Proxy" task in plugin settings.
 */

console.log("[SceneTranslate] v2.4 loaded");

try {
(function () {
  "use strict";

  // ─── Config ────────────────────────────────────────────────────────

  var config = {
    translateTool: "google_free",
    targetLanguage: "zh-CN",
    proxyUrl: "http://127.0.0.1:9998",
  };

  var proxyOnline = false;
  var injectedSceneId = null;
  var _observerTimer = null;

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

  // ─── Proxy Connection ──────────────────────────────────────────────

  function fetchProxyConfig() {
    return fetchWithTimeout(config.proxyUrl + "/config", { method: "GET" }, 3000)
    .then(function (resp) {
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    }).then(function (data) {
      if (data.translateTool) config.translateTool = data.translateTool;
      if (data.targetLanguage) config.targetLanguage = data.targetLanguage;
      proxyOnline = true;
      return true;
    }).catch(function () {
      proxyOnline = false;
      return false;
    });
  }

  function loadConfig() {
    return fetchProxyConfig();
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
      body: JSON.stringify({ text: text, targetLang: targetLang, engine: engine }),
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

  function createTranslateButton(inputEl, fieldName) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-outline-secondary scene-translate-btn";
    btn.textContent = "\uD83C\uDF10";
    btn.style.cssText = "margin-left:6px;padding:2px 8px;font-size:14px;cursor:pointer;vertical-align:middle;";
    btn.title = "Translate " + fieldName + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";

    btn.addEventListener("click", function () {
      var text = inputEl.value || "";
      if (!text.trim()) return;
      btn.disabled = true;
      btn.textContent = "\u23F3";

      ensureProxy().then(function (online) {
        if (!online) {
          throw new Error("Proxy not running! Click 'Start Translate Proxy' in plugin settings.");
        }
        return translateText(text, config.targetLanguage);
      }).then(function (translated) {
        if (translated && translated !== text) {
          setNativeValue(inputEl, translated);
          btn.textContent = "\u2713";
          btn.classList.replace("btn-outline-secondary", "btn-success");
          setTimeout(function () {
            btn.textContent = "\uD83C\uDF10";
            btn.classList.replace("btn-success", "btn-outline-secondary");
          }, 2000);
        } else {
          btn.textContent = "\uD83C\uDF10";
        }
      }).catch(function (e) {
        btn.textContent = "\u2717";
        btn.classList.replace("btn-outline-secondary", "btn-danger");
        var msg = e.message || "Unknown error";
        btn.title = "Error: " + msg;
        console.error("[SceneTranslate] " + fieldName + " error: " + msg);
        setTimeout(function () {
          btn.textContent = "\uD83C\uDF10";
          btn.classList.replace("btn-danger", "btn-outline-secondary");
          btn.title = "Translate " + fieldName + " \u2192 " + config.targetLanguage + " [" + config.translateTool + "]";
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

    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      var text = (label.textContent || "").trim();
      if (label.querySelector(".scene-translate-btn")) continue;

      if (TITLE_PATTERNS.test(text) && !SKIP_PATTERNS.test(text)) {
        var row = label.closest(".row") || label.closest(".form-group") || label.parentElement;
        if (row) {
          var input = row.querySelector('input[type="text"], input:not([type])');
          if (input) { titleInput = input; titleLabel = label; }
        }
      }
      if (DETAILS_PATTERNS.test(text)) {
        var row = label.closest(".row") || label.closest(".form-group") || label.parentElement;
        if (row) {
          var ta = row.querySelector("textarea");
          if (ta) { detailsTextarea = ta; detailsLabel = label; }
        }
      }
    }

    if (!titleInput) {
      var allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
      if (allInputs.length > 0) {
        titleInput = allInputs[0];
        titleLabel = titleInput.closest(".row") ? titleInput.closest(".row").querySelector("label") : null;
      }
    }
    if (!detailsTextarea) {
      var allTAs = document.querySelectorAll("textarea");
      if (allTAs.length > 0) {
        detailsTextarea = allTAs[0];
        detailsLabel = detailsTextarea.closest(".row") ? detailsTextarea.closest(".row").querySelector("label") : null;
      }
    }

    var injected = false;

    if (titleInput && titleLabel && !titleLabel.querySelector(".scene-translate-btn")) {
      titleLabel.appendChild(createTranslateButton(titleInput, "title"));
      injected = true;
    } else if (titleInput) {
      var w = titleInput.closest(".col-sm-9") || titleInput.parentElement;
      if (w && !w.querySelector(".scene-translate-btn")) {
        w.appendChild(createTranslateButton(titleInput, "title"));
        injected = true;
      }
    }

    if (detailsTextarea && detailsLabel && !detailsLabel.querySelector(".scene-translate-btn")) {
      detailsLabel.appendChild(createTranslateButton(detailsTextarea, "details"));
      injected = true;
    } else if (detailsTextarea) {
      var w = detailsTextarea.closest(".col-lg-12") || detailsTextarea.closest(".col-sm-9") || detailsTextarea.parentElement;
      if (w && !w.querySelector(".scene-translate-btn")) {
        w.appendChild(createTranslateButton(detailsTextarea, "details"));
        injected = true;
      }
    }

    if (injected) {
      injectedSceneId = sceneId;
    }
  }

  // ─── URL Helpers ──────────────────────────────────────────────────

  function getSceneIdFromUrl() {
    var m = window.location.pathname.match(/\/scenes?\/(\d+)/);
    if (m) return m[1];
    m = window.location.hash.match(/\/scenes?\/(\d+)/);
    return m ? m[1] : null;
  }

  function isScenePage() {
    return /\/scenes?\/\d+/.test(window.location.pathname + window.location.hash);
  }

  // ─── Init ──────────────────────────────────────────────────────────

  function initPlugin() {
    loadConfig().then(function () {
      setupObservers();

      if (isScenePage()) {
        setTimeout(injectTranslateButtons, 300);
        setTimeout(injectTranslateButtons, 1000);
      }
    });
  }

  function setupObservers() {
    var PluginApi = window.PluginApi;
    if (PluginApi && PluginApi.patch && PluginApi.patch.after) {
      var names = ["Scene", "SceneEditPanel", "SceneEdit", "SceneDetails"];
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
    setTimeout(injectTranslateButtons, 300);
    setTimeout(injectTranslateButtons, 1000);
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
