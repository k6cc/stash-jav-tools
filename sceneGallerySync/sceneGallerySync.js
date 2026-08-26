(function () {
  // 幂等守卫：Stash 会随任务轮询的 React 重渲染周期性重执行插件脚本（PendingScript 机制），
  // 重复执行会堆积 MutationObserver、嵌套包装 pushState，跳过后续执行
  if (window.__sceneGallerySyncLoaded) return;
  window.__sceneGallerySyncLoaded = true;

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

  // 提交任务，resolve 为 job_id（runPluginTask 返回标量 job id），提交失败则 reject
  function runTask(sceneId) {
    return callGQL(
      "mutation($id:ID!,$t:String!,$a:[PluginArgInput!]){runPluginTask(plugin_id:$id,task_name:$t,args:$a)}",
      { id: PLUGIN_ID, t: TASK_NAME, a: [{ key: "mode", value: { str: "create_gallery" } }, { key: "scene_id", value: { str: sceneId } }] }
    ).then(function (r) {
      return (r && r.runPluginTask) || null;
    });
  }

  var JOB_POLL_INTERVAL = 1500;
  // 按钮路径不做图片入库轮询，任务几秒内结束
  var JOB_POLL_TIMEOUT = 15000;

  // 轮询 stash job 直到终态（FINISHED / FAILED / CANCELLED）
  function pollJob(jobId, onDone) {
    var startTime = Date.now();
    var withError = true; // 旧版 stash 无 Job.error 字段，出错时自动降级重试

    function tick() {
      var fields = "id status" + (withError ? " error" : "");
      callGQL("query($i:FindJobInput!){findJob(input:$i){" + fields + "}}", { i: { id: jobId } })
        .then(function (r) {
          var job = r && r.findJob;
          if (!job) { onDone("MISSING"); return; }
          var st = job.status;
          if (st === "FINISHED" || st === "FAILED" || st === "CANCELLED") {
            onDone(st, withError ? job.error : null);
            return;
          }
          if (Date.now() - startTime > JOB_POLL_TIMEOUT) { onDone("TIMEOUT"); return; }
          setTimeout(tick, JOB_POLL_INTERVAL);
        })
        .catch(function (e) {
          if (withError) {
            withError = false;
            setTimeout(tick, 200);
            return;
          }
          console.error("[SGS] pollJob", e);
          onDone("ERROR");
        });
    }
    tick();
  }

  // stash 对插件任务失败也标 FINISHED，job 状态不可依赖；
  // 按钮任务结束后解析本次任务写入 stash 的原始日志判定真实结果。
  // 注意：logs 接口返回最新在前（新条目前插）且仅保留最近 30 条；
  // message 带插件前缀，须用包含匹配
  // 返回 "OK" / 失败原因 key / null（日志未就绪或无法判定）
  function fetchResult(sceneId) {
    return callGQL("query{logs{level message}}", {})
      .then(function (r) {
        var logs = (r && r.logs) || [];
        // 锚点：从头（最新）向后找第一条 mode=create_gallery 且 scene_id 匹配的日志（按钮任务独有）
        var anchor = -1;
        var anchorRe = new RegExp("mode=create_gallery.*scene_id=" + sceneId + "(?![0-9])");
        for (var i = 0; i < logs.length; i++) {
          if (anchorRe.test((logs[i] || {}).message || "")) { anchor = i; break; }
        }
        if (anchor === -1) return null;
        // 锚点之后（时间上更晚）的日志在数组中索引更小；向 0 扫描，
        // 遇到更新的进程启动日志即停止，避免误读其他运行
        for (var j = anchor - 1; j >= 0; j--) {
          var m = (logs[j] || {}).message || "";
          if (m.indexOf("sceneGallerySync starting") !== -1) break;
          if (m.indexOf("Appended to existing gallery") !== -1 || /Gallery \d+ done/.test(m)) return "OK";
          if (m.indexOf("No extrafanart folder, skipping") !== -1) return "No extrafanart folder";
          if (m.indexOf("No images in extrafanart folder") !== -1) return "No images in extrafanart folder";
          if (m.indexOf("No extrafanart images in DB") !== -1) return "Extrafanart images not indexed in Stash";
          if (m.indexOf("not found or no files") !== -1) return "Scene not found or no files";
          if (m.indexOf("Gallery create failed") !== -1) return "Gallery create failed";
        }
        return null;
      })
      .catch(function () { return null; });
  }

  var FAIL_REASONS = {
    "No extrafanart folder": "未找到 extrafanart 文件夹",
    "No images in extrafanart folder": "extrafanart 文件夹中没有图片",
    "Extrafanart images not indexed in Stash": "图片尚未入库（请先扫描）",
    "Scene not found or no files": "未找到场景或场景无文件",
    "Gallery create failed": "图库创建失败"
  };

  function mapReason(s) {
    if (!s) return "";
    s = String(s).trim();
    for (var k in FAIL_REASONS) {
      if (FAIL_REASONS.hasOwnProperty(k) && s.indexOf(k) !== -1) return FAIL_REASONS[k];
    }
    return s;
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

  // 图标按钮样式（纯图标：文件夹轮廓 + 加号，蓝色）
  var ICONS = {
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
    loading: '<svg class="sgs-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" width="16" height="16"><circle cx="12" cy="12" r="9" stroke-dasharray="42 15"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M9.2 14.2l2 2 4-4.5"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M10 12.3l4 4"/><path d="M14 12.3l-4 4"/></svg>'
  };

  function ensureStyle() {
    if (document.getElementById("sgs-btn-style")) return;
    var s = document.createElement("style");
    s.id = "sgs-btn-style";
    s.textContent = [
      ".sgs-btn.sgs-btn-icon{display:inline-flex;align-items:center;justify-content:center;padding:2px 7px;line-height:1;vertical-align:middle;color:#339af0;border:1px solid rgba(51,154,240,.45);background:rgba(51,154,240,.06);}",
      ".sgs-btn.sgs-btn-icon:hover:not(:disabled){color:#4dabf7;border-color:rgba(77,171,247,.8);background:rgba(77,171,247,.14);}",
      ".sgs-btn.sgs-btn-icon:disabled{opacity:.85;}",
      ".sgs-btn.sgs-btn-icon svg{width:16px;height:16px;display:block;}",
      ".sgs-btn.sgs-btn-ok{color:#37b24d;border-color:rgba(55,178,77,.5);background:rgba(55,178,77,.08);}",
      ".sgs-btn.sgs-btn-err{color:#f03e3e;border-color:rgba(240,62,62,.5);background:rgba(240,62,62,.08);}",
      ".sgs-btn .sgs-spin{animation:sgs-rotate 1s linear infinite;}",
      "@keyframes sgs-rotate{to{transform:rotate(360deg);}}",
      "@media (prefers-reduced-motion: reduce){.sgs-btn .sgs-spin{animation:none;}}"
    ].join("\n");
    document.head.appendChild(s);
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

    ensureStyle();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm sgs-btn sgs-btn-icon";
    btn.title = "创建图库";
    btn.innerHTML = ICONS.idle;
    btn.onclick = function () {
      btn.disabled = true;
      btn.title = "创建中...";
      btn.className = "btn btn-sm sgs-btn sgs-btn-icon";
      btn.innerHTML = ICONS.loading;

      function finish(ok, title, ms) {
        btn.title = title;
        btn.className = "btn btn-sm sgs-btn sgs-btn-icon " + (ok ? "sgs-btn-ok" : "sgs-btn-err");
        btn.innerHTML = ok ? ICONS.ok : ICONS.err;
        setTimeout(function () {
          btn.className = "btn btn-sm sgs-btn sgs-btn-icon";
          btn.title = "创建图库";
          btn.innerHTML = ICONS.idle;
          btn.disabled = false;
        }, ms || (ok ? 5000 : 8000));
      }

      runTask(sceneId).then(function (jobId) {
        // 旧版 stash 无 job_id：退回「已提交」提示
        if (!jobId) { finish(true, "任务已提交"); return; }
        pollJob(jobId, function (status, error) {
          if (status === "FINISHED") {
            // job 恒报 FINISHED，解析日志确认真实结果；日志入库比 job 结束略慢，重试几次
            var attempts = 0;
            (function check() {
              fetchResult(sceneId).then(function (result) {
                attempts++;
                if (!result && attempts < 3) { setTimeout(check, 1000); return; }
                if (result === "OK") {
                  finish(true, "图库已创建/更新");
                } else if (result) {
                  finish(false, "创建失败：" + mapReason(result));
                } else {
                  finish(true, "任务已结束，详情请查看日志");
                }
              });
            })();
          } else if (status === "FAILED") {
            var reason = mapReason(error);
            finish(false, "创建失败：" + (reason || "详情请查看日志"));
          } else if (status === "CANCELLED") {
            finish(false, "任务已取消");
          } else {
            // TIMEOUT / MISSING / ERROR：任务可能仍在后台执行
            finish(true, "任务仍在执行，请稍后在任务页查看结果");
          }
        });
      }).catch(function (e) {
        console.error("[SGS]", e);
        finish(false, "提交失败", 3000);
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
