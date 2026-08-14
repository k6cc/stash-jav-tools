console.log("[SceneGallerySync] v1.5.0 loaded");
(function () {
  var PLUGIN_ID = "sceneGallerySync";
  var TASK_NAME = "Create Gallery for Scene";
  var injectedSceneId = null;
  var _observerTimer = null;

  function callGQL(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables }),
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.errors && r.errors.length) throw new Error(r.errors[0].message);
        return r.data;
      });
  }

  function runTask(sceneId) {
    return callGQL(
      "mutation($id:ID!,$t:String!,$a:[PluginArgInput!]){runPluginTask(plugin_id:$id,task_name:$t,args:$a)}",
      { id: PLUGIN_ID, t: TASK_NAME, a: [{ key: "mode", value: { str: "create_gallery" } }, { key: "scene_id", value: { str: sceneId } }] }
    ).then(function () { return true; }).catch(function (e) { console.error("[SGS]", e); return false; });
  }

  function getSceneIdFromUrl() {
    var m = window.location.pathname.match(/\/scenes?\/(\d+)/);
    if (m) return m[1];
    m = window.location.hash.match(/\/scenes?\/(\d+)/);
    return m ? m[1] : null;
  }

  function isScenePage() {
    return /\/scenes?\/\d+/.test(window.location.pathname + window.location.hash);
  }

  function injectButton() {
    var sceneId = getSceneIdFromUrl();
    if (!sceneId) return;
    if (sceneId === injectedSceneId && document.querySelector(".sgs-btn")) return;

    // 结构锚点优先（与界面语言无关）：Stash 编辑表单字段带 data-field / label[for] 属性
    var target = document.querySelector('label[for="gallery_ids"]')
      || document.querySelector('[data-field="gallery_ids"] label');

    // 文本匹配兜底（仅旧版本 Stash 无结构属性时使用）
    if (!target) {
      var labels = document.querySelectorAll("label");
      for (var i = 0; i < labels.length; i++) {
        var t = labels[i].textContent.trim();
        if (labels[i].querySelector(".sgs-btn")) continue;
        if (/galleries|gallery|galerie|图库|ギャラリー|갤러리/i.test(t) && !/studio|movie|tag|performer|工作室|标签|演员|系列/i.test(t)) {
          target = labels[i];
          break;
        }
      }
    }
    if (!target) return;

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-outline-secondary sgs-btn";
    btn.textContent = "创建图库";
    btn.onclick = function () {
      btn.disabled = true;
      btn.textContent = "创建中...";
      btn.className = "btn btn-sm btn-warning sgs-btn";
      runTask(sceneId).then(function (ok) {
        btn.className = "btn btn-sm " + (ok ? "btn-info" : "btn-danger") + " sgs-btn";
        btn.textContent = ok ? "任务已提交" : "提交失败";
        setTimeout(function () {
          btn.className = "btn btn-sm btn-outline-secondary sgs-btn";
          btn.textContent = "创建图库";
          btn.disabled = false;
        }, ok ? 5000 : 3000);
      });
    };
    target.appendChild(document.createTextNode(" "));
    target.appendChild(btn);
    injectedSceneId = sceneId;
  }

  function setupObservers() {
    var PluginApi = window.PluginApi;
    if (PluginApi && PluginApi.patch && PluginApi.patch.after) {
      var names = ["Scene", "SceneEditPanel", "SceneEdit", "SceneDetails"];
      for (var i = 0; i < names.length; i++) {
        try {
          PluginApi.patch.after(names[i], function (props) {
            requestAnimationFrame(function () {
              setTimeout(injectButton, 200);
            });
            return props;
          });
        } catch (e) {}
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
        if (getSceneIdFromUrl() !== injectedSceneId) injectButton();
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
    setTimeout(injectButton, 300);
    setTimeout(injectButton, 1000);
  }

  function initPlugin() {
    setupObservers();
    if (isScenePage()) {
      setTimeout(injectButton, 300);
      setTimeout(injectButton, 1000);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlugin);
  } else {
    initPlugin();
  }
})();
