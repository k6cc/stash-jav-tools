/**
 * Studio Tools v1.0.0
 *
 * 合并自 studioMerge v1.0.0 + studioSearch v2.2.0
 * - 工作室合并：将一个工作室合并到另一个工作室（参考 Stash 原生合并对话框风格）
 * - StashDB 搜索：一键搜索并更新工作室信息
 *
 * 两个模块共享：graphql、escapeHtml/escapeAttr、URL 解析、fetchCurrentStudio、
 * MutationObserver、history hook、锚点按钮注入。注入按钮统一使用 .st-inject-btn 样式。
 */

console.log("[StudioTools] v1.0.0 loaded");

try {
(function () {
  "use strict";

  // ===== 共享常量 =====
  var GRAPHQL_ENDPOINT = "/graphql";
  var STASHDB_ENDPOINT = "https://stashdb.org/graphql";

  // ===== 共享状态 =====
  var _currentStudioId = null;
  var _currentStudioData = null;
  var _observerTimer = null;
  var _mergeBtnInjected = false;
  var _searchBtnInjected = false;
  var _allTagsCache = null;
  var _allStudiosCache = null;
  var _stashBoxConfig = null;
  var _searchPanel = null;

  // 合并两个模块所需的全部字段
  var Q_STUDIO = "query FindStudio($id: ID!) { findStudio(id: $id) { id name aliases urls details rating100 favorite image_path stash_ids { endpoint stash_id } parent_studio { id name } tags { id name } ignore_auto_tag organized } }";

  // ===== 共享工具 =====
  function graphql(query, variables) {
    return fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (body) {
          console.error("[StudioTools] HTTP " + resp.status, body);
          throw new Error("HTTP " + resp.status + ": " + body.substring(0, 200));
        });
      }
      return resp.json();
    }).then(function (data) {
      if (data.errors && data.errors.length > 0) {
        console.error("[StudioTools] GraphQL errors:", data.errors);
        throw new Error(data.errors[0].message);
      }
      return data;
    });
  }

  function stashdbGraphql(query, variables, apiKey) {
    return fetch(STASHDB_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ApiKey": apiKey },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (resp) {
      if (!resp.ok) throw new Error("StashDB HTTP " + resp.status);
      return resp.json();
    }).then(function (data) {
      if (data.errors && data.errors.length > 0) throw new Error(data.errors[0].message);
      return data;
    });
  }

  function escapeHtml(t) {
    if (!t) return "";
    var d = document.createElement("div");
    d.textContent = t;
    return d.innerHTML;
  }

  function escapeAttr(t) {
    if (t == null) return "";
    return String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function getStudioIdFromUrl() {
    var m = window.location.pathname.match(/\/studios\/(\d+)/) || window.location.hash.match(/\/studios\/(\d+)/);
    return m ? m[1] : null;
  }

  function isStudioDetailPage() { return !!getStudioIdFromUrl(); }

  function fetchCurrentStudio() {
    var id = getStudioIdFromUrl();
    if (!id) return Promise.resolve(null);
    if (_currentStudioId === id && _currentStudioData) return Promise.resolve(_currentStudioData);
    _currentStudioId = id;
    return graphql(Q_STUDIO, { id: id }).then(function (data) {
      _currentStudioData = data.data.findStudio;
      return _currentStudioData;
    });
  }

  // 查找按钮注入锚点（两个模块共用）。
  // 结构锚点与界面语言无关；文本匹配仅作旧版本兜底。
  // 返回 { parent: 容器, before: 参考节点或 null }，按钮通过 parent.insertBefore(btn, before) 插入。
  function getInjectSpot() {
    // 1) Auto Tag 按钮：.details-edit 中唯一被 <div> 包裹的直接子按钮（Stash DetailsEditNavbar 结构）
    var autoTag = document.querySelector("#studio-page .details-edit > div > button");
    if (autoTag && autoTag.parentElement) {
      return { parent: autoTag.parentElement, before: null };
    }
    // 2) 编辑栏自身：.save/.delete 类名与语言无关，插到其前面
    var navbar = document.querySelector("#studio-page .details-edit");
    if (navbar) {
      var ref = navbar.querySelector("button.save") || navbar.querySelector("button.delete");
      if (ref) return { parent: navbar, before: ref };
    }
    // 3) 文本兜底：按界面文本匹配 Auto Tag（去空格后比较，兼容 "Auto Tag…" 等变体）
    var allButtons = document.querySelectorAll("button");
    for (var i = 0; i < allButtons.length; i++) {
      var text = (allButtons[i].textContent || "").trim();
      var compact = text.toLowerCase().replace(/[\s…]+/g, "");
      if (text.indexOf("自动标签") !== -1 || compact.indexOf("autotag") !== -1) {
        return { parent: allButtons[i].parentElement, before: null };
      }
    }
    return null;
  }

  // ====================================================================
  // Merge 模块
  // ====================================================================
  var Merge = (function () {
    var Q_STUDIOS = "query FindStudios($filter: FindFilterType) { findStudios(filter: $filter) { studios { id name aliases urls details rating100 favorite image_path stash_ids { endpoint stash_id } parent_studio { id name } tags { id name } ignore_auto_tag organized } } }";
    var Q_TAGS = "query FindTags($filter: FindFilterType) { findTags(filter: $filter) { tags { id name } } }";
    var Q_SCENES = "query FindScenesByStudio($studio_id: ID!, $per_page: Int!) { findScenes(scene_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { count } }";
    var Q_IMAGES = "query FindImagesByStudio($studio_id: ID!, $per_page: Int!) { findImages(image_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { count } }";
    var Q_GALLERIES = "query FindGalleriesByStudio($studio_id: ID!, $per_page: Int!) { findGalleries(gallery_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { count } }";
    var Q_GROUPS = "query FindGroupsByStudio($studio_id: ID!, $per_page: Int!) { findGroups(group_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { count } }";
    var Q_CHILD_STUDIOS = "query FindChildStudios($parent_id: ID!, $per_page: Int!) { findStudios(studio_filter: { parents: { value: [$parent_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { count } }";
    var Q_SCENE_IDS = "query FindSceneIDsByStudio($studio_id: ID!, $per_page: Int!) { findScenes(scene_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { scenes { id } } }";
    var Q_IMAGE_IDS = "query FindImageIDsByStudio($studio_id: ID!, $per_page: Int!) { findImages(image_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { images { id } } }";
    var Q_GALLERY_IDS = "query FindGalleryIDsByStudio($studio_id: ID!, $per_page: Int!) { findGalleries(gallery_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { galleries { id } } }";
    var Q_GROUP_IDS = "query FindGroupIDsByStudio($studio_id: ID!, $per_page: Int!) { findGroups(group_filter: { studios: { value: [$studio_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { groups { id } } }";
    var Q_CHILD_IDS = "query FindChildIDsByStudio($parent_id: ID!, $per_page: Int!) { findStudios(studio_filter: { parents: { value: [$parent_id], modifier: INCLUDES } }, filter: { per_page: $per_page }) { studios { id } } }";
    var M_UPDATE = "mutation StudioUpdate($input: StudioUpdateInput!) { studioUpdate(input: $input) { id name } }";
    var M_DESTROY = "mutation StudioDestroy($input: StudioDestroyInput!) { studioDestroy(input: $input) }";
    var M_BULK_SCENE = "mutation BulkSceneUpdate($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }";
    var M_BULK_IMAGE = "mutation BulkImageUpdate($input: BulkImageUpdateInput!) { bulkImageUpdate(input: $input) { id } }";
    var M_BULK_GALLERY = "mutation BulkGalleryUpdate($input: BulkGalleryUpdateInput!) { bulkGalleryUpdate(input: $input) { id } }";
    var M_BULK_GROUP = "mutation BulkGroupUpdate($input: BulkGroupUpdateInput!) { bulkGroupUpdate(input: $input) { id } }";
    var M_BULK_STUDIO = "mutation BulkStudioUpdate($input: BulkStudioUpdateInput!) { bulkStudioUpdate(input: $input) { id } }";

    function loadAllTags() {
      if (_allTagsCache) return Promise.resolve(_allTagsCache);
      return graphql(Q_TAGS, { filter: { per_page: -1, sort: "name" } }).then(function (data) {
        _allTagsCache = data.data.findTags.tags || [];
        return _allTagsCache;
      });
    }

    function loadAllStudios() {
      if (_allStudiosCache) return Promise.resolve(_allStudiosCache);
      return graphql(Q_STUDIOS, { filter: { per_page: -1, sort: "name" } }).then(function (data) {
        _allStudiosCache = data.data.findStudios.studios || [];
        return _allStudiosCache;
      });
    }

    function MergeField(key, destVal, mergedVal, useMerged) {
      this.key = key;
      this.destValue = destVal;
      this.mergedValue = mergedVal;
      this.useMerged = !!useMerged;
    }

    function getStashIdEndpoint(sid) {
      if (!sid) return "";
      var ep = sid.endpoint || "";
      ep = ep.replace(/^https?:\/\//, "").replace(/\/graphql$/, "");
      return ep;
    }

    function buildStashIdHtml(sid, cssClass) {
      if (!sid) return "";
      var ep = getStashIdEndpoint(sid);
      var linkUrl = (sid.endpoint || "").replace(/\/graphql$/, "") + "/studios/" + sid.stash_id;
      var cls = cssClass || "";
      return '<div class="sm-stash-id-row ' + cls + '">' +
        '<span class="sm-stash-id-badge">' + escapeHtml(ep) + '</span>' +
        '<a class="sm-stash-id-link" href="' + escapeAttr(linkUrl) + '" target="_blank" rel="noopener">' + escapeHtml(sid.stash_id) + '</a>' +
        '</div>';
    }

    function mergeArrays(dst, src) { var r = dst.slice(); for (var i = 0; i < src.length; i++) { if (r.indexOf(src[i]) === -1) r.push(src[i]); } return r; }
    function mergeTags(dst, src) { var r = dst.slice(); for (var i = 0; i < src.length; i++) { if (!r.find(function(t) { return t.id === src[i].id; })) r.push(src[i]); } return r; }

    function computeMergeFields(src, dst, srcHasImage, dstHasImage) {
      var fields = {};
      var mergedAliases = mergeArrays(dst.aliases || [], src.aliases || []);
      var mergedUrls = mergeArrays(dst.urls || [], src.urls || []);
      var mergedTags = mergeTags(dst.tags || [], src.tags || []);
      var mergedRating = Math.max(dst.rating100 || 0, src.rating100 || 0) || null;
      var mergedFav = dst.favorite || src.favorite;
      var mergedDetails = dst.details || "";
      if (src.details && src.details !== mergedDetails) mergedDetails += (mergedDetails ? "\n\n--- 来自 " + src.name + " ---\n\n" : "") + src.details;

      fields.name = new MergeField("name", dst.name, src.name, false);
      fields.aliases = new MergeField("aliases", dst.aliases || [], mergedAliases, !!(mergedAliases.length));
      fields.urls = new MergeField("urls", dst.urls || [], mergedUrls, !!(mergedUrls.length));
      fields.stash_ids = new MergeField("stash_ids", dst.stash_ids || [], src.stash_ids || [], false);
      fields.tags = new MergeField("tags", (dst.tags || []).map(function (t) { return t.id; }), mergedTags.map(function (t) { return t.id; }), !!(mergedTags.length));
      fields.rating100 = new MergeField("rating100", dst.rating100 || null, mergedRating, !!(mergedRating));
      fields.favorite = new MergeField("favorite", !!dst.favorite, mergedFav, !!mergedFav);
      fields.details = new MergeField("details", dst.details || "", mergedDetails, !!(mergedDetails));
      fields.parent_id = new MergeField("parent_id", dst.parent_studio || null, src.parent_studio || null, !!(src.parent_studio && !dst.parent_studio));
      fields.image = new MergeField("image", dstHasImage ? dst.image_path : "", srcHasImage ? src.image_path : "", srcHasImage && !dstHasImage);
      fields.ignore_auto_tag = new MergeField("ignore_auto_tag", !!dst.ignore_auto_tag, src.ignore_auto_tag || dst.ignore_auto_tag, !!(src.ignore_auto_tag));
      fields.organized = new MergeField("organized", !!dst.organized, dst.organized || src.organized, !!(src.organized));

      return fields;
    }

    function createOverlay() { return createElement("div", "sm-overlay"); }
    function createElement(tag, cls) { var el = document.createElement(tag); if (cls) el.className = cls; return el; }

    function iconCheck(selected) {
      return selected
        ? '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>'
        : '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" class="sm-icon-muted"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>';
    }

    function fmtVal(v) { return v != null ? String(v) : ""; }

    function showSelectDialog(currentStudio) {
      graphql(Q_STUDIOS, { filter: { per_page: -1, sort: "name" } }).then(function (data) {
        var allStudios = data.data.findStudios.studios;
        _allStudiosCache = allStudios;
        var overlay = createOverlay();
        var dialog = createElement("div", "sm-dialog sm-dialog-select");

        function boxHtml(role, value, name) {
          return '<div class="sm-combobox" data-role="' + role + '" data-value="' + escapeAttr(value) + '">' +
            '<input type="text" class="sm-combobox-input" value="' + escapeAttr(name) + '" placeholder="请选择或输入搜索...">' +
            '<button class="sm-combobox-btn" type="button">&#9662;</button>' +
            '</div>';
        }

        dialog.innerHTML =
          '<h3 class="sm-title">合并工作室</h3>' +
          '<div class="sm-warning">源工作室的场景、图片、图库、组合及子工作室将重新分配到目标工作室，合并后源工作室将被删除。</div>' +
          '<div class="sm-field-group"><label class="sm-label">源工作室（将被合并并删除）</label>' + boxHtml("src", "", "") + '</div>' +
          '<div class="sm-swap-wrap"><button class="sm-swap-btn" type="button">&#8645; 调换</button></div>' +
          '<div class="sm-field-group"><label class="sm-label">目标工作室</label>' + boxHtml("dest", currentStudio.id, currentStudio.name) + '</div>' +
          '<div class="sm-btn-row"><button class="sm-btn-apply" disabled>下一步</button><button class="sm-btn-cancel">取消</button></div>';

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        var srcBox = dialog.querySelector('.sm-combobox[data-role="src"]');
        var destBox = dialog.querySelector('.sm-combobox[data-role="dest"]');
        var nextBtn = dialog.querySelector(".sm-btn-apply");
        var cancelBtn = dialog.querySelector(".sm-btn-cancel");
        var swapBtn = dialog.querySelector(".sm-swap-btn");

        function initCombobox(box) {
          var input = box.querySelector(".sm-combobox-input");
          var btn = box.querySelector(".sm-combobox-btn");
          var dropdown = null;

          function renderList(filter) {
            if (!dropdown) return;
            var listDiv = dropdown.querySelector(".sm-tag-dropdown-list");
            var fl = (filter || "").toLowerCase();
            var html = "";
            var matched = 0;
            for (var i = 0; i < allStudios.length; i++) {
              var s = allStudios[i];
              if (fl && s.name.toLowerCase().indexOf(fl) === -1) continue;
              html += '<div class="sm-tag-dropdown-item" data-id="' + s.id + '" data-name="' + escapeAttr(s.name) + '">' + escapeHtml(s.name) + '</div>';
              matched++;
            }
            if (matched === 0) html = '<div class="sm-tag-dropdown-empty">无匹配工作室</div>';
            listDiv.innerHTML = html;
          }

          function openDropdown() {
            if (dropdown) return;
            dropdown = document.createElement("div");
            dropdown.className = "sm-tag-dropdown sm-combobox-dropdown";
            dropdown.innerHTML = '<div class="sm-tag-dropdown-list"></div>';
            box.appendChild(dropdown);
            renderList(input.value);

            dropdown.addEventListener("mousedown", function (ev) {
              var item = ev.target.closest(".sm-tag-dropdown-item");
              if (!item) return;
              ev.preventDefault();
              ev.stopPropagation();
              var id = item.getAttribute("data-id");
              var name = item.getAttribute("data-name");
              box.setAttribute("data-value", id);
              input.value = name;
              closeDropdown();
              updateBtn();
            });
          }

          function closeDropdown() {
            if (dropdown) { dropdown.remove(); dropdown = null; }
          }

          input.addEventListener("focus", function () { openDropdown(); });
          input.addEventListener("input", function () {
            box.setAttribute("data-value", "");
            if (!dropdown) openDropdown();
            else renderList(input.value);
            updateBtn();
          });
          input.addEventListener("click", function (e) { e.stopPropagation(); });

          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            if (dropdown) closeDropdown();
            else { openDropdown(); input.focus(); input.select(); }
          });

          input.addEventListener("blur", function () {
            var val = input.value.trim().toLowerCase();
            if (val) {
              for (var i = 0; i < allStudios.length; i++) {
                if (allStudios[i].name.toLowerCase() === val) {
                  box.setAttribute("data-value", allStudios[i].id);
                  input.value = allStudios[i].name;
                  break;
                }
              }
            }
            updateBtn();
            setTimeout(closeDropdown, 150);
          });
        }

        initCombobox(srcBox);
        initCombobox(destBox);

        function updateBtn() {
          var sid = srcBox.getAttribute("data-value");
          var did = destBox.getAttribute("data-value");
          nextBtn.disabled = !(sid && did && sid !== did);
        }

        swapBtn.addEventListener("click", function () {
          var sid = srcBox.getAttribute("data-value");
          var did = destBox.getAttribute("data-value");
          var sName = srcBox.querySelector(".sm-combobox-input").value;
          var dName = destBox.querySelector(".sm-combobox-input").value;
          srcBox.setAttribute("data-value", did);
          destBox.setAttribute("data-value", sid);
          srcBox.querySelector(".sm-combobox-input").value = dName;
          destBox.querySelector(".sm-combobox-input").value = sName;
          updateBtn();
        });
        cancelBtn.addEventListener("click", function () { document.body.removeChild(overlay); });
        overlay.addEventListener("click", function (e) { if (e.target === overlay) document.body.removeChild(overlay); });
        nextBtn.addEventListener("click", function () {
          var sid = srcBox.getAttribute("data-value"), did = destBox.getAttribute("data-value");
          if (!sid || !did || sid === did) return;
          var srcObj = allStudios.find(function (s) { return s.id === sid; });
          var dstObj = allStudios.find(function (s) { return s.id === did; });
          document.body.removeChild(overlay);
          loadAndShowMergeDialog(srcObj, dstObj);
        });
        updateBtn();
      });
    }

    function loadAndShowMergeDialog(src, dst) {
      var overlay = createOverlay();
      var dialog = createElement("div", "sm-dialog");
      dialog.innerHTML = '<div class="sm-loading">加载中...</div>';
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      Promise.all([
        graphql(Q_SCENES, { studio_id: src.id, per_page: 0 }).then(function (d) { return d.data.findScenes.count; }),
        graphql(Q_IMAGES, { studio_id: src.id, per_page: 0 }).then(function (d) { return d.data.findImages.count; }),
        graphql(Q_GALLERIES, { studio_id: src.id, per_page: 0 }).then(function (d) { return d.data.findGalleries.count; }),
        graphql(Q_GROUPS, { studio_id: src.id, per_page: 0 }).then(function (d) { return d.data.findGroups.count; }),
        graphql(Q_CHILD_STUDIOS, { parent_id: src.id, per_page: 0 }).then(function (d) { return d.data.findStudios.count; }),
        checkHasRealImage(src.image_path),
        checkHasRealImage(dst.image_path)
      ]).then(function (results) {
        var counts = {
          scenes: results[0],
          images: results[1],
          galleries: results[2],
          groups: results[3],
          childStudios: results[4]
        };
        document.body.removeChild(overlay);
        showMergeDialog(src, dst, counts, results[5], results[6]);
      }).catch(function (err) {
        document.body.removeChild(overlay);
        alert("加载失败：" + err.message);
      });
    }

    function showMergeDialog(src, dst, counts, srcHasImage, dstHasImage) {
      var fields = computeMergeFields(src, dst, srcHasImage, dstHasImage);
      var overlay = createOverlay();
      var dialog = createElement("div", "sm-dialog sm-dialog-merge");

      var countsHtml = '<div class="sm-counts">';
      var items = [
        { label: "场景", count: counts.scenes },
        { label: "图片", count: counts.images },
        { label: "图库", count: counts.galleries },
        { label: "组合", count: counts.groups },
        { label: "子工作室", count: counts.childStudios }
      ];
      for (var i = 0; i < items.length; i++) {
        if (items[i].count > 0) {
          countsHtml += '<span class="sm-count-item">' + items[i].label + ': <strong>' + items[i].count + '</strong></span>';
        }
      }
      countsHtml += '</div>';

      var rows = "";
      rows += buildRow("name", "名称", fields, src, dst, "input");
      rows += buildRow("aliases", "别名", fields, src, dst, "aliases");
      rows += buildRow("urls", "网址", fields, src, dst, "urls");
      rows += buildRow("stash_ids", "Stash ID", fields, src, dst, "stash_ids");
      rows += buildRow("tags", "标签", fields, src, dst, "tags");
      rows += buildRow("rating100", "评分", fields, src, dst, "rating");
      rows += buildRow("favorite", "收藏", fields, src, dst, "checkbox");
      rows += buildRow("details", "详情", fields, src, dst, "textarea");
      rows += buildRow("parent_id", "父工作室", fields, src, dst, "parent_select");
      rows += buildRow("image", "图片", fields, src, dst, "image");
      rows += buildRow("ignore_auto_tag", "忽略自动标签", fields, src, dst, "checkbox");
      rows += buildRow("organized", "已整理", fields, src, dst, "checkbox");

      dialog.innerHTML =
        '<h3 class="sm-title">合并工作室</h3>' +
        '<div class="sm-info">将 <strong>' + escapeHtml(src.name) + '</strong> 合并到 <strong>' + escapeHtml(dst.name) + '</strong></div>' +
        countsHtml +
        '<div class="sm-merge-grid">' +
          '<div class="sm-merge-header"></div>' +
          '<div class="sm-merge-header sm-merge-dest-hdr">目标</div>' +
          '<div class="sm-merge-header sm-merge-merged-hdr">合并结果</div>' +
          rows +
        '</div>' +
        '<div class="sm-warning">此操作将把源工作室的所有关联对象重新分配到目标工作室，然后删除源工作室。此操作不可撤销。</div>' +
        '<div class="sm-btn-row"><button class="sm-btn-apply">应用合并</button><button class="sm-btn-cancel">取消</button></div>';

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      var cancelBtn = dialog.querySelector(".sm-btn-cancel");
      var applyBtn = dialog.querySelector(".sm-btn-apply");
      cancelBtn.addEventListener("click", function () { document.body.removeChild(overlay); });
      overlay.addEventListener("click", function (e) { if (e.target === overlay) document.body.removeChild(overlay); });

      dialog.addEventListener("click", function (e) {
        var btn = e.target.closest(".sm-select-btn");
        if (!btn) return;
        var row = btn.closest(".sm-merge-row");
        if (!row) return;
        var key = row.getAttribute("data-key");
        var useMerged = btn.getAttribute("data-use") === "merged";
        fields[key].useMerged = useMerged;
        updateSelectBtns(row, useMerged);

        if (key === "name") {
          handleNameToggle(dialog, src, dst, fields, useMerged);
          updateApplyBtnState(dialog);
        }
      });

      dialog.addEventListener("input", function (e) {
        var row = e.target.closest(".sm-merge-row");
        if (!row) return;
        var key = row.getAttribute("data-key");
        if (!fields[key].useMerged) {
          fields[key].useMerged = true;
          updateSelectBtns(row, true);
        }
        if (key === "name") {
          var nameValue = e.target.value.trim();
          handleNameChange(dialog, src, dst, fields, nameValue);
          updateApplyBtnState(dialog);
        }
      });

      initListDragDrop(dialog, "aliases", fields);
      initListDragDrop(dialog, "urls", fields);
      initListAddItem(dialog, "aliases", fields);
      initListAddItem(dialog, "urls", fields);
      initListDeleteItem(dialog, fields);
      initTagDropdown(dialog, src, dst, fields);
      initTagDelete(dialog, fields);
      initTagClearAll(dialog, fields);
      initParentStudioDropdown(dialog, src, dst, fields);
      handleNameToggle(dialog, src, dst, fields, fields.name.useMerged);
      updateApplyBtnState(dialog);

      applyBtn.addEventListener("click", function () {
        applyBtn.disabled = true;
        applyBtn.textContent = "合并中...";

        collectAndMerge(src, dst, fields, dialog)
          .then(function () {
            applyBtn.textContent = "合并成功！";
            setTimeout(function () { document.body.removeChild(overlay); window.location.reload(); }, 1000);
          })
          .catch(function (err) {
            applyBtn.disabled = false;
            applyBtn.textContent = "应用合并";
            alert("合并失败：" + err.message);
          });
      });
    }

    function updateSelectBtns(row, useMerged) {
      var destBtn = row.querySelector(".sm-select-dest");
      var mergedBtn = row.querySelector(".sm-select-merged");
      if (destBtn) {
        destBtn.classList.toggle("sm-selected", !useMerged);
        destBtn.innerHTML = iconCheck(!useMerged);
      }
      if (mergedBtn) {
        mergedBtn.classList.toggle("sm-selected", useMerged);
        mergedBtn.innerHTML = iconCheck(useMerged);
      }
    }

    function buildRow(key, title, fields, src, dst, type) {
      var field = fields[key];
      var useMerged = field.useMerged;
      var destSelClass = "sm-select-btn sm-select-dest" + (!useMerged ? " sm-selected" : "");
      var mergedSelClass = "sm-select-btn sm-select-merged" + (useMerged ? " sm-selected" : "");

      var destContent = "";
      var mergedContent = "";

      switch (type) {
        case "input":
          destContent = '<input type="text" class="sm-input" readonly value="' + escapeAttr(fmtVal(field.destValue)) + '">';
          mergedContent = '<input type="text" class="sm-input" data-field="' + key + '" value="' + escapeAttr(fmtVal(field.mergedValue)) + '">';
          break;

        case "rating":
          destContent = '<input type="number" class="sm-input" readonly value="' + escapeAttr(field.destValue != null ? String(Math.round(field.destValue / 20 * 10) / 10) : "") + '" min="0" max="5" step="0.5">';
          mergedContent = '<input type="number" class="sm-input" data-field="' + key + '" data-rating="true" min="0" max="5" step="0.5" value="' + escapeAttr(field.mergedValue != null ? String(Math.round(field.mergedValue / 20 * 10) / 10) : "") + '">';
          break;

        case "checkbox":
          destContent = '<input type="checkbox" class="sm-checkbox" readonly' + (field.destValue ? " checked" : "") + ' onclick="return false">';
          mergedContent = '<input type="checkbox" class="sm-checkbox" data-field="' + key + '"' + (field.mergedValue ? " checked" : "") + '>';
          break;

        case "textarea":
          destContent = '<textarea class="sm-textarea" readonly>' + escapeHtml(field.destValue || "") + '</textarea>';
          mergedContent = '<textarea class="sm-textarea" data-field="' + key + '">' + escapeHtml(field.mergedValue || "") + '</textarea>';
          break;

        case "aliases":
        case "urls":
          destContent = buildListDest(field.destValue);
          mergedContent = buildListMerged(key, field.mergedValue);
          break;

        case "stash_ids":
          destContent = buildStashIdsDest(field.destValue);
          mergedContent = buildStashIdsMerged(src);
          break;

        case "tags":
          destContent = buildTagsDest(src, dst, field.destValue);
          mergedContent = buildTagsMerged(src, dst, field.mergedValue);
          break;

        case "parent_select":
          destContent = buildParentDest(field.destValue);
          mergedContent = buildParentMerged(field);
          break;

        case "image":
          destContent = buildImageDest(field.destValue, dst);
          mergedContent = buildImageMerged(field.mergedValue, src);
          break;

        default:
          destContent = '<span class="sm-merge-val">' + escapeHtml(fmtVal(field.destValue)) + '</span>';
          mergedContent = '<span class="sm-merge-val">' + escapeHtml(fmtVal(field.mergedValue)) + '</span>';
          break;
      }

      return (
        '<div class="sm-merge-row" data-key="' + key + '">' +
          '<div class="sm-merge-lbl">' + escapeHtml(title) + '</div>' +
          '<div class="sm-merge-dest">' +
            '<button class="' + destSelClass + '" data-use="dest" type="button">' + iconCheck(!useMerged) + '</button>' +
            destContent +
          '</div>' +
          '<div class="sm-merge-merged">' +
            '<button class="' + mergedSelClass + '" data-use="merged" type="button">' + iconCheck(useMerged) + '</button>' +
            mergedContent +
          '</div>' +
        '</div>'
      );
    }

    function buildListDest(arr) {
      if (!arr || arr.length === 0) return '<span class="sm-merge-val">无</span>';
      var html = '<div class="sm-list-dest">';
      for (var i = 0; i < arr.length; i++) {
        html += '<div class="sm-list-item-dest"><input type="text" class="sm-list-input" readonly value="' + escapeAttr(arr[i]) + '"></div>';
      }
      html += '</div>';
      return html;
    }

    function buildListMerged(key, arr) {
      var html = '<div class="sm-list-merged" data-list-key="' + key + '">';
      if (arr && arr.length > 0) {
        for (var i = 0; i < arr.length; i++) {
          html += '<div class="sm-list-item" draggable="true">' +
            '<button class="sm-drag-handle" type="button">&#8801;</button>' +
            '<input type="text" class="sm-list-input" value="' + escapeAttr(arr[i]) + '">' +
            '<button class="sm-list-del" type="button">&#8722;</button>' +
          '</div>';
        }
      }
      html += '<div class="sm-list-item sm-list-item-new">' +
        '<input type="text" class="sm-list-input sm-list-new" placeholder="添加...">' +
      '</div>';
      html += '</div>';
      return html;
    }

    function buildStashIdsDest(stashIds) {
      if (!stashIds || stashIds.length === 0) return '<span class="sm-merge-val">无</span>';
      var html = '<div class="sm-stash-dest">';
      for (var i = 0; i < stashIds.length; i++) {
        html += buildStashIdHtml(stashIds[i], "sm-stash-id-dest");
      }
      html += '</div>';
      return html;
    }

    function buildStashIdsMerged(src) {
      var displayIds = src.stash_ids || [];
      var html = '<div class="sm-stash-merged">';
      if (displayIds.length > 0) {
        for (var i = 0; i < displayIds.length; i++) {
          html += buildStashIdHtml(displayIds[i], "sm-stash-id-merged");
        }
      } else {
        html += '<span class="sm-merge-val">无</span>';
      }
      html += '</div>';
      return html;
    }

    function buildImageDest(imageValue, studio) {
      if (imageValue) {
        return '<div class="sm-image-wrap"><img class="sm-image-preview" src="' + escapeAttr(studio.image_path) + '" alt="目标图片"></div>';
      }
      return '<span class="sm-merge-val">无</span>';
    }

    function buildImageMerged(imageValue, src) {
      var html = '<div class="sm-image-merged">';
      if (imageValue) {
        html += '<div class="sm-image-wrap"><img class="sm-image-preview" src="' + escapeAttr(src.image_path) + '" alt="源图片"></div>';
      } else {
        html += '<span class="sm-merge-val">无</span>';
      }
      html += '</div>';
      return html;
    }

    function buildParentDest(parentStudio) {
      if (!parentStudio) return '<span class="sm-merge-val">无</span>';
      return '<input type="text" class="sm-input" readonly value="' + escapeAttr(parentStudio.name) + '">';
    }

    function buildParentMerged(field) {
      var parent = field.mergedValue;
      var parentId = parent ? parent.id : "";
      var parentName = parent ? parent.name : "";
      var html = '<div class="sm-select-field" data-field="parent_id" data-value="' + escapeAttr(parentId) + '">';
      html += '<input type="text" class="sm-select-field-input" readonly value="' + escapeAttr(parentName) + '" placeholder="无">';
      html += '<button class="sm-select-field-btn" type="button">&#9662;</button>';
      html += '</div>';
      return html;
    }

    function initListDragDrop(dialog, key, fields) {
      var container = dialog.querySelector('.sm-list-merged[data-list-key="' + key + '"]');
      if (!container) return;
      var dragItem = null;

      container.addEventListener("dragstart", function (e) {
        var item = e.target.closest(".sm-list-item");
        if (!item || item.classList.contains("sm-list-item-new")) return;
        dragItem = item;
        item.classList.add("sm-dragging");
        e.dataTransfer.effectAllowed = "move";
      });

      container.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!dragItem) return;
        var item = e.target.closest(".sm-list-item");
        if (!item || item === dragItem || item.classList.contains("sm-list-item-new")) return;
        var rect = item.getBoundingClientRect();
        var midY = rect.top + rect.height / 2;
        if (e.clientY < midY) container.insertBefore(dragItem, item);
        else container.insertBefore(dragItem, item.nextSibling);
      });

      container.addEventListener("dragend", function () {
        if (dragItem) dragItem.classList.remove("sm-dragging");
        dragItem = null;
        var row = container.closest(".sm-merge-row");
        if (row && !fields[key].useMerged) {
          fields[key].useMerged = true;
          updateSelectBtns(row, true);
        }
      });
    }

    function initListAddItem(dialog, key, fields) {
      var container = dialog.querySelector('.sm-list-merged[data-list-key="' + key + '"]');
      if (!container) return;

      container.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var input = e.target;
        if (!input.classList.contains("sm-list-new")) return;
        var val = input.value.trim();
        if (!val) return;

        var newItem = document.createElement("div");
        newItem.className = "sm-list-item";
        newItem.draggable = true;
        newItem.innerHTML = '<button class="sm-drag-handle" type="button">&#8801;</button>' +
          '<input type="text" class="sm-list-input" value="' + escapeAttr(val) + '">' +
          '<button class="sm-list-del" type="button">&#8722;</button>';

        var newItemRow = container.querySelector(".sm-list-item-new");
        container.insertBefore(newItem, newItemRow);
        input.value = "";

        var row = container.closest(".sm-merge-row");
        if (row && !fields[key].useMerged) {
          fields[key].useMerged = true;
          updateSelectBtns(row, true);
        }
      });
    }

    function initListDeleteItem(dialog, fields) {
      dialog.addEventListener("click", function (e) {
        var delBtn = e.target.closest(".sm-list-del");
        if (!delBtn) return;
        var item = delBtn.closest(".sm-list-item");
        if (!item) return;
        var listContainer = item.closest(".sm-list-merged");
        var listKey = listContainer ? listContainer.getAttribute("data-list-key") : null;
        item.remove();

        if (listKey && fields[listKey]) {
          var row = listContainer.closest(".sm-merge-row");
          if (row && !fields[listKey].useMerged) {
            fields[listKey].useMerged = true;
            updateSelectBtns(row, true);
          }
        }
      });
    }

    function initParentStudioDropdown(dialog, src, dst, fields) {
      dialog.addEventListener("click", function (e) {
        var fieldWrap = e.target.closest(".sm-select-field[data-field='parent_id']");
        if (!fieldWrap) return;

        var existingDropdown = dialog.querySelector(".sm-studio-dropdown");
        if (existingDropdown) { existingDropdown.remove(); return; }

        loadAllStudios().then(function (allStudios) {
          var excludeIds = [src.id, dst.id];
          var filtered = allStudios.filter(function (s) { return excludeIds.indexOf(s.id) === -1; });

          var dropdown = document.createElement("div");
          dropdown.className = "sm-studio-dropdown";
          var searchHtml = '<input type="text" class="sm-tag-search" placeholder="搜索工作室...">';
          var listHtml = '<div class="sm-tag-dropdown-list"></div>';
          dropdown.innerHTML = searchHtml + listHtml;
          fieldWrap.appendChild(dropdown);

          var searchInput = dropdown.querySelector(".sm-tag-search");
          var listDiv = dropdown.querySelector(".sm-tag-dropdown-list");

          function renderList(filter) {
            var html = '<div class="sm-tag-dropdown-item" data-id="" data-name="">（无）</div>';
            for (var i = 0; i < filtered.length; i++) {
              var s = filtered[i];
              if (filter && s.name.toLowerCase().indexOf(filter.toLowerCase()) === -1) continue;
              html += '<div class="sm-tag-dropdown-item" data-id="' + s.id + '" data-name="' + escapeAttr(s.name) + '">' + escapeHtml(s.name) + '</div>';
            }
            if (!html) html = '<div class="sm-tag-dropdown-empty">无匹配工作室</div>';
            listDiv.innerHTML = html;
          }

          renderList("");
          searchInput.addEventListener("input", function (ev) { ev.stopPropagation(); renderList(searchInput.value); });
          searchInput.focus();

          listDiv.addEventListener("click", function (ev) {
            var item = ev.target.closest(".sm-tag-dropdown-item");
            if (!item) return;
            var id = item.getAttribute("data-id");
            var name = item.getAttribute("data-name");
            fieldWrap.setAttribute("data-value", id);
            fieldWrap.querySelector(".sm-select-field-input").value = name;
            dropdown.remove();

            var row = fieldWrap.closest(".sm-merge-row");
            if (row && !fields.parent_id.useMerged) {
              fields.parent_id.useMerged = true;
              updateSelectBtns(row, true);
            }
          });

          setTimeout(function () {
            function closeDropdown(ev) {
              if (!dropdown.contains(ev.target) && !fieldWrap.contains(ev.target)) {
                dropdown.remove();
                document.removeEventListener("click", closeDropdown);
              }
            }
            document.addEventListener("click", closeDropdown);
          }, 0);
        });
      });
    }

    function getAllTags(src, dst) {
      return (src.tags || []).concat(dst.tags || []);
    }

    function buildTagsDest(src, dst, tagIds) {
      var allTags = getAllTags(src, dst);
      if (!tagIds || tagIds.length === 0) return '<span class="sm-merge-val">无</span>';
      var html = '<div class="sm-tags-dest">';
      for (var i = 0; i < tagIds.length; i++) {
        var found = allTags.find(function (t) { return t.id === tagIds[i]; });
        if (found) html += '<span class="sm-tag-pill-dest">' + escapeHtml(found.name) + '</span>';
      }
      html += '</div>';
      return html;
    }

    function buildTagsMerged(src, dst, tagIds) {
      var allTags = getAllTags(src, dst);
      if (!tagIds || tagIds.length === 0) tagIds = [];
      var html = '<div class="sm-tags-merged">';
      html += '<div class="sm-tags-pills">';
      for (var i = 0; i < tagIds.length; i++) {
        var found = allTags.find(function (t) { return t.id === tagIds[i]; });
        if (found) {
          html += '<span class="sm-tag-pill" data-id="' + found.id + '" data-name="' + escapeAttr(found.name) + '">' + escapeHtml(found.name) + '<span class="sm-tag-del">&times;</span></span>';
        }
      }
      html += '</div>';
      if (tagIds.length > 0) {
        html += '<button class="sm-tag-clear-btn" type="button" title="删除所有标签">&times;</button>';
      }
      html += '<button class="sm-tag-dropdown-btn" type="button" title="选择标签">&#9662;</button>';
      html += '</div>';
      return html;
    }

    function initTagDelete(dialog, fields) {
      dialog.addEventListener("click", function (e) {
        var del = e.target.closest(".sm-tag-del");
        if (!del) return;
        var pill = del.closest(".sm-tag-pill");
        var row = pill ? pill.closest(".sm-merge-row") : null;
        if (pill) pill.remove();
        updateTagClearBtn(dialog);
        if (row && !fields.tags.useMerged) {
          fields.tags.useMerged = true;
          updateSelectBtns(row, true);
        }
      });
    }

    function initTagClearAll(dialog, fields) {
      dialog.addEventListener("click", function (e) {
        var btn = e.target.closest(".sm-tag-clear-btn");
        if (!btn) return;
        var container = btn.closest(".sm-tags-merged");
        if (!container) return;
        var pills = container.querySelectorAll(".sm-tag-pill");
        for (var i = 0; i < pills.length; i++) pills[i].remove();
        btn.remove();
        var row = container.closest(".sm-merge-row");
        if (row && !fields.tags.useMerged) {
          fields.tags.useMerged = true;
          updateSelectBtns(row, true);
        }
      });
    }

    function updateTagClearBtn(dialog) {
      var container = dialog.querySelector(".sm-tags-merged");
      if (!container) return;
      var pills = container.querySelectorAll(".sm-tag-pill");
      var existingBtn = container.querySelector(".sm-tag-clear-btn");
      var dropdownBtn = container.querySelector(".sm-tag-dropdown-btn");
      if (pills.length > 0 && !existingBtn) {
        var btn = document.createElement("button");
        btn.className = "sm-tag-clear-btn";
        btn.type = "button";
        btn.title = "删除所有标签";
        btn.innerHTML = "&times;";
        container.insertBefore(btn, dropdownBtn);
      } else if (pills.length === 0 && existingBtn) {
        existingBtn.remove();
      }
    }

    function initTagDropdown(dialog, src, dst, fields) {
      dialog.addEventListener("click", function (e) {
        var dropdownBtn = e.target.closest(".sm-tag-dropdown-btn");
        if (!dropdownBtn) return;

        var tagsContainer = dropdownBtn.closest(".sm-tags-merged");
        if (!tagsContainer) return;

        var existingDropdown = tagsContainer.querySelector(".sm-tag-dropdown");
        if (existingDropdown) { existingDropdown.remove(); return; }

        var selectedIds = getSelectedTagIds(tagsContainer);

        loadAllTags().then(function (allTags) {
          var dropdown = document.createElement("div");
          dropdown.className = "sm-tag-dropdown";
          var searchHtml = '<input type="text" class="sm-tag-search" placeholder="搜索标签...">';
          var listHtml = '<div class="sm-tag-dropdown-list"></div>';
          dropdown.innerHTML = searchHtml + listHtml;
          tagsContainer.appendChild(dropdown);

          var searchInput = dropdown.querySelector(".sm-tag-search");
          var listDiv = dropdown.querySelector(".sm-tag-dropdown-list");

          function renderList(filter) {
            var html = "";
            for (var i = 0; i < allTags.length; i++) {
              var tag = allTags[i];
              if (selectedIds.indexOf(tag.id) !== -1) continue;
              if (filter && tag.name.toLowerCase().indexOf(filter.toLowerCase()) === -1) continue;
              html += '<div class="sm-tag-dropdown-item" data-id="' + tag.id + '" data-name="' + escapeAttr(tag.name) + '">' + escapeHtml(tag.name) + '</div>';
            }
            if (!html) html = '<div class="sm-tag-dropdown-empty">无匹配标签</div>';
            listDiv.innerHTML = html;
          }

          renderList("");
          searchInput.addEventListener("input", function (ev) { ev.stopPropagation(); renderList(searchInput.value); });
          searchInput.focus();

          listDiv.addEventListener("click", function (ev) {
            var item = ev.target.closest(".sm-tag-dropdown-item");
            if (!item) return;
            ev.stopPropagation();
            var tagId = item.getAttribute("data-id");
            var tagName = item.getAttribute("data-name");
            var pill = document.createElement("span");
            pill.className = "sm-tag-pill";
            pill.setAttribute("data-id", tagId);
            pill.setAttribute("data-name", tagName);
            pill.innerHTML = escapeHtml(tagName) + '<span class="sm-tag-del">&times;</span>';
            var pillsArea = tagsContainer.querySelector(".sm-tags-pills");
            pillsArea.appendChild(pill);
            selectedIds.push(tagId);
            renderList(searchInput.value);
            updateTagClearBtn(dialog);
            searchInput.focus();

            var row = tagsContainer.closest(".sm-merge-row");
            if (row && !fields.tags.useMerged) {
              fields.tags.useMerged = true;
              updateSelectBtns(row, true);
            }
          });

          setTimeout(function () {
            function closeDropdown(ev) {
              if (!dropdown.contains(ev.target) && !dropdownBtn.contains(ev.target)) {
                dropdown.remove();
                document.removeEventListener("click", closeDropdown);
              }
            }
            document.addEventListener("click", closeDropdown);
          }, 0);
        });
      });
    }

    function getSelectedTagIds(container) {
      var pills = container.querySelectorAll(".sm-tag-pill[data-id]");
      var ids = [];
      for (var i = 0; i < pills.length; i++) ids.push(pills[i].getAttribute("data-id"));
      return ids;
    }

    function addAutoAliasIfMissing(aliasesList, aliasValue) {
      var existingInputs = aliasesList.querySelectorAll(".sm-list-item .sm-list-input");
      for (var i = 0; i < existingInputs.length; i++) {
        if (existingInputs[i].value === aliasValue) return;
      }
      var newItem = document.createElement("div");
      newItem.className = "sm-list-item";
      newItem.draggable = true;
      newItem.setAttribute("data-auto-alias", "true");
      newItem.innerHTML = '<button class="sm-drag-handle" type="button">&#8801;</button>' +
        '<input type="text" class="sm-list-input" value="' + escapeAttr(aliasValue) + '">' +
        '<button class="sm-list-del" type="button">&#8722;</button>';
      var addRow = aliasesList.querySelector(".sm-list-item-new");
      if (addRow) aliasesList.insertBefore(newItem, addRow);
      else aliasesList.appendChild(newItem);
    }

    function handleNameToggle(dialog, src, dst, fields, useMerged) {
      var aliasesList = dialog.querySelector('.sm-list-merged[data-list-key="aliases"]');
      if (!aliasesList) return;
      if (src.name === dst.name) return;
      var autoItems = aliasesList.querySelectorAll('.sm-list-item[data-auto-alias]');
      for (var i = 0; i < autoItems.length; i++) autoItems[i].remove();
      var aliasToAdd = useMerged ? dst.name : src.name;
      addAutoAliasIfMissing(aliasesList, aliasToAdd);
      if (!fields.aliases.useMerged) {
        fields.aliases.useMerged = true;
        var aliasesRow = aliasesList.closest(".sm-merge-row");
        if (aliasesRow) updateSelectBtns(aliasesRow, true);
      }
    }

    function handleNameChange(dialog, src, dst, fields, nameValue) {
      var aliasesList = dialog.querySelector('.sm-list-merged[data-list-key="aliases"]');
      if (!aliasesList) return;
      if (src.name === dst.name) return;
      var autoItems = aliasesList.querySelectorAll('.sm-list-item[data-auto-alias]');
      for (var i = 0; i < autoItems.length; i++) autoItems[i].remove();
      if (nameValue === src.name) {
        addAutoAliasIfMissing(aliasesList, dst.name);
      } else if (nameValue === dst.name) {
        addAutoAliasIfMissing(aliasesList, src.name);
      } else if (nameValue) {
        addAutoAliasIfMissing(aliasesList, src.name);
        addAutoAliasIfMissing(aliasesList, dst.name);
      }
      if (!fields.aliases.useMerged) {
        fields.aliases.useMerged = true;
        var aliasesRow = aliasesList.closest(".sm-merge-row");
        if (aliasesRow) updateSelectBtns(aliasesRow, true);
      }
    }

    function updateApplyBtnState(dialog) {
      var applyBtn = dialog.querySelector(".sm-btn-apply");
      if (!applyBtn) return;
      var nameInput = dialog.querySelector('[data-field="name"]');
      applyBtn.disabled = !(nameInput && nameInput.value.trim());
    }

    function collectListValues(dialog, listKey) {
      var listContainer = dialog.querySelector('.sm-list-merged[data-list-key="' + listKey + '"]');
      if (!listContainer) return [];
      var inputs = listContainer.querySelectorAll(".sm-list-input");
      var values = [];
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].classList.contains("sm-list-new")) continue;
        var val = inputs[i].value.trim();
        if (val) values.push(val);
      }
      return values;
    }

    function isSvgPlaceholder(resp) {
      var ct = (resp.headers.get("Content-Type") || "").toLowerCase();
      if (ct.indexOf("svg") === -1) return false;
      var cl = parseInt(resp.headers.get("Content-Length") || "0", 10);
      if (cl === 0) return false;
      return cl < 1000;
    }

    function checkHasRealImage(url) {
      if (!url) return Promise.resolve(false);
      function checkResponse(resp) {
        if (!resp.ok) return true;
        if (!isSvgPlaceholder(resp)) return true;
        return false;
      }
      function tryGet() {
        return fetch(url).then(checkResponse).catch(function () { return true; });
      }
      return fetch(url, { method: "HEAD" }).then(function (resp) {
        if (!resp.ok) return tryGet();
        return checkResponse(resp);
      }).catch(tryGet);
    }

    function fetchImageAsBase64(url) {
      return fetch(url).then(function (resp) {
        if (!resp.ok) return null;
        if (isSvgPlaceholder(resp)) return null;
        return resp.blob().then(function (blob) {
          return new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onloadend = function () { resolve(reader.result); };
            reader.onerror = function () { resolve(null); };
            reader.readAsDataURL(blob);
          });
        });
      }).catch(function () { return null; });
    }

    function collectAndMerge(src, dst, fields, dialog) {
      var name;
      if (fields.name.useMerged) {
        var nameEl = dialog.querySelector('[data-field="name"]');
        name = nameEl ? nameEl.value.trim() : dst.name;
      } else {
        name = dst.name;
      }

      var aliases = fields.aliases.useMerged
        ? collectListValues(dialog, "aliases").filter(function (a) { return a !== name; })
        : (dst.aliases || []).filter(function (a) { return a !== name; });

      var urls = fields.urls.useMerged
        ? collectListValues(dialog, "urls")
        : dst.urls || [];

      var stashIds = fields.stash_ids.useMerged
        ? src.stash_ids || []
        : dst.stash_ids || [];

      var tagIds;
      if (fields.tags.useMerged) {
        tagIds = [];
        var tagPills = dialog.querySelectorAll(".sm-tags-merged .sm-tag-pill[data-id]");
        for (var i = 0; i < tagPills.length; i++) tagIds.push(tagPills[i].getAttribute("data-id"));
      } else {
        tagIds = (dst.tags || []).map(function (t) { return t.id; });
      }

      var rating100 = null;
      if (fields.rating100.useMerged) {
        var ratingInput = dialog.querySelector('[data-field="rating100"]');
        if (ratingInput) {
          var rv = parseFloat(ratingInput.value);
          if (!isNaN(rv)) rating100 = Math.round(rv * 20);
        }
      } else {
        rating100 = dst.rating100 || null;
      }

      var favorite = fields.favorite.useMerged
        ? (dialog.querySelector('[data-field="favorite"]') || {}).checked || false
        : !!dst.favorite;

      var details = fields.details.useMerged
        ? (dialog.querySelector('[data-field="details"]') || {}).value || ""
        : dst.details || "";

      var parentId;
      if (fields.parent_id.useMerged) {
        var parentField = dialog.querySelector('.sm-select-field[data-field="parent_id"]');
        parentId = parentField ? parentField.getAttribute("data-value") : null;
        if (!parentId) parentId = null;
      } else {
        parentId = dst.parent_studio ? dst.parent_studio.id : null;
      }

      var ignoreAutoTag = fields.ignore_auto_tag.useMerged
        ? (dialog.querySelector('[data-field="ignore_auto_tag"]') || {}).checked || false
        : !!dst.ignore_auto_tag;

      var organized = fields.organized.useMerged
        ? (dialog.querySelector('[data-field="organized"]') || {}).checked || false
        : !!dst.organized;

      var imagePath = fields.image.useMerged ? fields.image.mergedValue : fields.image.destValue;

      return executeMerge(src.id, dst.id, {
        name: name,
        originalDstName: dst.name,
        aliases: aliases,
        urls: urls,
        stash_ids: stashIds,
        tag_ids: tagIds,
        rating100: rating100,
        favorite: favorite,
        details: details,
        parent_id: parentId,
        ignore_auto_tag: ignoreAutoTag,
        organized: organized,
        image: imagePath,
        imageField: fields.image,
        dstAliases: dst.aliases || [],
        dstUrls: dst.urls || [],
        dstStashIds: dst.stash_ids || [],
        dstTagIds: (dst.tags || []).map(function (t) { return t.id; }),
        dstFavorite: !!dst.favorite,
        dstDetails: dst.details || "",
        dstIgnoreAutoTag: !!dst.ignore_auto_tag,
        dstOrganized: !!dst.organized,
        dstRating100: dst.rating100,
        dstParentId: dst.parent_studio ? dst.parent_studio.id : null
      });
    }

    function executeMerge(srcId, dstId, collected) {
      var imageBase64 = null;
      var needFetchImage = collected.image && collected.image !== collected.imageField.destValue;
      var needClearImage = !collected.image && !!collected.imageField.destValue;

      return Promise.all([
        graphql(Q_SCENE_IDS, { studio_id: srcId, per_page: -1 }).then(function (d) { return (d.data.findScenes.scenes || []).map(function (s) { return s.id; }); }),
        graphql(Q_IMAGE_IDS, { studio_id: srcId, per_page: -1 }).then(function (d) { return (d.data.findImages.images || []).map(function (s) { return s.id; }); }),
        graphql(Q_GALLERY_IDS, { studio_id: srcId, per_page: -1 }).then(function (d) { return (d.data.findGalleries.galleries || []).map(function (s) { return s.id; }); }),
        graphql(Q_GROUP_IDS, { studio_id: srcId, per_page: -1 }).then(function (d) { return (d.data.findGroups.groups || []).map(function (s) { return s.id; }); }),
        graphql(Q_CHILD_IDS, { parent_id: srcId, per_page: -1 }).then(function (d) { return (d.data.findStudios.studios || []).map(function (s) { return s.id; }); })
      ]).then(function (results) {
        var sceneIds = results[0], imageIds = results[1], galleryIds = results[2], groupIds = results[3], childStudioIds = results[4];
        var promises = [];
        if (sceneIds.length > 0) promises.push(graphql(M_BULK_SCENE, { input: { ids: sceneIds, studio_id: dstId } }));
        if (imageIds.length > 0) promises.push(graphql(M_BULK_IMAGE, { input: { ids: imageIds, studio_id: dstId } }));
        if (galleryIds.length > 0) promises.push(graphql(M_BULK_GALLERY, { input: { ids: galleryIds, studio_id: dstId } }));
        if (groupIds.length > 0) promises.push(graphql(M_BULK_GROUP, { input: { ids: groupIds, studio_id: dstId } }));
        if (childStudioIds.length > 0) promises.push(graphql(M_BULK_STUDIO, { input: { ids: childStudioIds, parent_id: dstId } }));
        return Promise.all(promises);
      })
        .then(function () {
          if (needFetchImage) return fetchImageAsBase64(collected.image);
          return null;
        })
        .then(function (b64) {
          imageBase64 = b64;
          return graphql(M_DESTROY, { input: { id: srcId } });
        })
        .then(function () {
          var nameChanged = collected.name && collected.name !== collected.originalDstName;
          var step1 = nameChanged
            ? graphql(M_UPDATE, { input: { id: dstId, name: collected.name } })
            : Promise.resolve();

          return step1.then(function () {
            var input = { id: dstId };

            if (collected.aliases.join(",") !== collected.dstAliases.join(",")) input.aliases = collected.aliases;
            if (collected.urls.join(",") !== collected.dstUrls.join(",")) input.urls = collected.urls;
            if (JSON.stringify(collected.stash_ids) !== JSON.stringify(collected.dstStashIds)) {
              input.stash_ids = collected.stash_ids.map(function (s) { return { endpoint: s.endpoint, stash_id: s.stash_id }; });
            }
            if (collected.tag_ids.join(",") !== collected.dstTagIds.join(",")) input.tag_ids = collected.tag_ids;
            if (collected.favorite !== collected.dstFavorite) input.favorite = collected.favorite;
            if (collected.details !== collected.dstDetails) input.details = collected.details;
            if (collected.ignore_auto_tag !== collected.dstIgnoreAutoTag) input.ignore_auto_tag = collected.ignore_auto_tag;
            if (collected.organized !== collected.dstOrganized) input.organized = collected.organized;
            if (collected.rating100 !== collected.dstRating100) {
              if (collected.rating100) input.rating100 = collected.rating100;
              else input.rating100 = null;
            }
            if (collected.parent_id !== collected.dstParentId) input.parent_id = collected.parent_id || null;

            if (needFetchImage && imageBase64) input.image = imageBase64;
            else if (needClearImage) input.image = "";

            return graphql(M_UPDATE, { input: input });
          });
        });
    }

    function inject() {
      if (!isStudioDetailPage()) { _mergeBtnInjected = false; return; }
      if (_mergeBtnInjected || document.querySelector(".sm-btn")) { _mergeBtnInjected = true; return; }

      fetchCurrentStudio().then(function (studio) {
        if (!studio || document.querySelector(".sm-btn")) { _mergeBtnInjected = true; return; }
        var spot = getInjectSpot();
        if (!spot) return;
        var btn = document.createElement("button");
        btn.className = "st-inject-btn sm-btn";
        btn.textContent = "合并";
        btn.title = "将此工作室与另一个合并";
        btn.addEventListener("click", function () { showSelectDialog(studio); });
        spot.parent.insertBefore(btn, spot.before);
        _mergeBtnInjected = true;
      });
    }

    return { inject: inject };
  })();

  // ====================================================================
  // Search 模块
  // ====================================================================
  var Search = (function () {
    var Q_SCRAPE_STUDIO = "query ScrapeSingleStudio($source: ScraperSourceInput!, $input: ScrapeSingleStudioInput!) {" +
      " scrapeSingleStudio(source: $source, input: $input) {" +
      " name aliases image urls remote_site_id parent { stored_id name } } }";

    var Q_CONFIGURATION = "query Configuration { configuration { general { stashBoxes { name endpoint api_key } } } }";

    var Q_FIND_STUDIOS = "query FindStudios($filter: FindFilterType) { findStudios(filter: $filter) { studios { id name } } }";

    var Q_STASHDB_SEARCH_STUDIO = "query SearchStudio($term: String!) { searchStudio(term: $term) { id name parent { id name } } }";

    var M_UPDATE = "mutation StudioUpdate($input: StudioUpdateInput!) { studioUpdate(input: $input) { id name } }";

    function getStashBoxConfig() {
      if (_stashBoxConfig) return Promise.resolve(_stashBoxConfig);
      return graphql(Q_CONFIGURATION, {}).then(function (data) {
        var boxes = (((data.data || {}).configuration || {}).general || {}).stashBoxes || [];
        _stashBoxConfig = boxes.length > 0 ? boxes[0] : null;
        return _stashBoxConfig;
      }).catch(function () { return null; });
    }

    function inject() {
      if (!isStudioDetailPage()) { _searchBtnInjected = false; return; }
      if (_searchBtnInjected || document.querySelector(".ss-search-btn")) { _searchBtnInjected = true; return; }

      fetchCurrentStudio().then(function (studio) {
        if (!studio || document.querySelector(".ss-search-btn")) { _searchBtnInjected = true; return; }
        var spot = getInjectSpot();
        if (!spot) return;

        var btn = document.createElement("button");
        btn.className = "st-inject-btn ss-search-btn";
        btn.type = "button";
        btn.textContent = "更新";
        btn.title = "从 StashDB 搜索并更新工作室信息";
        btn.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          showSearchPanel(btn, studio);
        });
        spot.parent.insertBefore(btn, spot.before);
        _searchBtnInjected = true;
      });
    }

    function closeSearchPanel() {
      if (_searchPanel) { _searchPanel.remove(); _searchPanel = null; }
    }

    function showSearchPanel(anchorBtn, studio) {
      closeSearchPanel();

      var panel = document.createElement("div");
      panel.className = "ss-search-panel";
      panel.innerHTML =
        '<div class="ss-search-header">' +
          '<input type="text" class="ss-search-input" placeholder="输入工作室名称搜索..." value="' + escapeAttr(studio.name || "") + '">' +
          '<button class="ss-search-submit" type="button">搜索</button>' +
        '</div>' +
        '<div class="ss-results"><div class="ss-results-empty">输入名称后点击搜索</div></div>';

      document.body.appendChild(panel);
      positionPanel(panel, anchorBtn);
      _searchPanel = panel;

      var input = panel.querySelector(".ss-search-input");
      var submitBtn = panel.querySelector(".ss-search-submit");
      var resultsDiv = panel.querySelector(".ss-results");

      function doSearch() {
        var term = (input.value || "").trim();
        if (!term) return;
        submitBtn.disabled = true;
        submitBtn.textContent = "搜索中...";
        resultsDiv.innerHTML = '<div class="ss-results-loading">正在搜索 StashDB...</div>';

        performSearch(term).then(function (results) {
          renderResults(resultsDiv, results, studio);
        }).catch(function (err) {
          resultsDiv.innerHTML = '<div class="ss-results-error">搜索失败: ' + escapeHtml(err.message) + '</div>';
        }).then(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = "搜索";
        });
      }

      submitBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); doSearch(); });
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doSearch(); } });
      input.addEventListener("click", function (e) { e.stopPropagation(); });
      panel.addEventListener("click", function (e) { e.stopPropagation(); });

      setTimeout(function () {
        function closeHandler(ev) {
          if (!panel.contains(ev.target) && ev.target !== anchorBtn && !anchorBtn.contains(ev.target)) {
            closeSearchPanel();
            document.removeEventListener("click", closeHandler);
          }
        }
        document.addEventListener("click", closeHandler);
      }, 0);

      setTimeout(function () { input.focus(); input.select(); }, 50);
    }

    function positionPanel(panel, anchorBtn) {
      var rect = anchorBtn.getBoundingClientRect();
      var panelWidth = 480;
      var left = rect.left;
      if (left + panelWidth > window.innerWidth - 16) left = window.innerWidth - panelWidth - 16;
      if (left < 16) left = 16;
      panel.style.left = left + "px";
      panel.style.top = (rect.bottom + 6) + "px";
    }

    function performSearch(term) {
      return getStashBoxConfig().then(function (config) {
        var source = config && config.endpoint
          ? { stash_box_endpoint: config.endpoint }
          : { stash_box_index: 0 };
        return graphql(Q_SCRAPE_STUDIO, { source: source, input: { query: term } });
      }).then(function (data) {
        return (data.data || {}).scrapeSingleStudio || [];
      });
    }

    function renderResults(container, results, studio) {
      if (!results || results.length === 0) {
        container.innerHTML = '<div class="ss-results-empty">未找到匹配的工作室</div>';
        return;
      }

      var html = "";
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        var aliases = r.aliases ? r.aliases.split(",").map(function (a) { return a.trim(); }).filter(Boolean) : [];
        var urls = r.urls || [];
        var imageHtml = r.image
          ? '<img class="ss-result-image" src="' + escapeAttr(r.image) + '" alt="">'
          : '<div class="ss-result-placeholder">无图</div>';

        html += '<div class="ss-result-item" data-index="' + i + '">' +
          imageHtml +
          '<div class="ss-result-info">' +
            '<div class="ss-result-name">' + escapeHtml(r.name || "") + '</div>' +
            (aliases.length > 0 ? '<div class="ss-result-aliases">别名: ' + escapeHtml(aliases.join(", ")) + '</div>' : '') +
            (urls.length > 0 ? '<div class="ss-result-urls">' + escapeHtml(urls.join(", ")) + '</div>' : '') +
            (r.parent && r.parent.name ? '<div class="ss-result-parent">上级: ' + escapeHtml(r.parent.name) + '</div>' : '') +
            (r.remote_site_id ? '<div class="ss-result-stashid">Stash ID: ' + escapeHtml(r.remote_site_id) + '</div>' : '') +
          '</div>' +
        '</div>';
      }
      container.innerHTML = html;

      var items = container.querySelectorAll(".ss-result-item");
      for (var j = 0; j < items.length; j++) {
        items[j].addEventListener("click", function () {
          var idx = parseInt(this.getAttribute("data-index"), 10);
          closeSearchPanel();
          applyResult(results[idx], studio);
        });
      }
    }

    function applyResult(result, studio) {
      var name = result.name || "";
      var aliases = result.aliases ? result.aliases.split(",").map(function (a) { return a.trim(); }).filter(Boolean) : [];
      var urls = result.urls || [];
      var image = result.image || "";
      var stashId = result.remote_site_id || "";

      showProgress("正在更新工作室...");

      var input = { id: studio.id, name: name, aliases: aliases, urls: urls };

      if (stashId) {
        var existingStashIds = (studio.stash_ids || []).map(function (s) {
          return { endpoint: s.endpoint, stash_id: s.stash_id };
        });
        var hasNew = existingStashIds.some(function (s) {
          return s.stash_id === stashId && s.endpoint === STASHDB_ENDPOINT;
        });
        if (!hasNew) existingStashIds.push({ endpoint: STASHDB_ENDPOINT, stash_id: stashId });
        input.stash_ids = existingStashIds;
      }

      if (image) {
        if (image.indexOf("http") === 0 || image.indexOf("data:") === 0) input.image = image;
        else input.image = "data:image/jpeg;base64," + image;
      }

      var promises = [];

      var parentName = result.parent && result.parent.name ? result.parent.name : "";
      if (parentName) {
        promises.push(findLocalStudioId(parentName).then(function (parentId) {
          if (parentId !== undefined) input.parent_id = parentId;
        }));
      } else if (name) {
        promises.push(findParentStudioId(name).then(function (parentId) {
          if (parentId !== undefined) input.parent_id = parentId;
        }));
      }

      Promise.all(promises).then(function () {
        showProgress("正在写入数据库...");
        return graphql(M_UPDATE, { input: input });
      }).then(function () {
        showProgress("更新成功，正在刷新页面...");
        setTimeout(window.location.reload.bind(window.location), 800);
      }).catch(function (err) {
        showProgress("更新失败: " + err.message, true);
        setTimeout(hideProgress, 3000);
      });
    }

    function findParentStudioId(studioName) {
      return getStashBoxConfig().then(function (config) {
        if (!config || !config.api_key) return undefined;
        return stashdbGraphql(Q_STASHDB_SEARCH_STUDIO, { term: studioName }, config.api_key);
      }).then(function (data) {
        if (!data) return undefined;
        var studios = (data.data || {}).searchStudio || [];
        if (studios.length === 0) return undefined;

        var matched = null;
        for (var i = 0; i < studios.length; i++) {
          if (studios[i].name && studios[i].name.toLowerCase() === studioName.toLowerCase()) {
            matched = studios[i]; break;
          }
        }
        if (!matched) matched = studios[0];
        if (!matched || !matched.parent || !matched.parent.name) return undefined;

        return findLocalStudioId(matched.parent.name);
      }).catch(function () { return undefined; });
    }

    function findLocalStudioId(name) {
      return graphql(Q_FIND_STUDIOS, { filter: { per_page: 50, q: name, sort: "name" } }).then(function (data) {
        var localStudios = ((data.data || {}).findStudios || {}).studios || [];
        for (var j = 0; j < localStudios.length; j++) {
          if (localStudios[j].name && localStudios[j].name.toLowerCase() === name.toLowerCase()) {
            return localStudios[j].id;
          }
        }
        return undefined;
      }).catch(function () { return undefined; });
    }

    function showProgress(message, isError) {
      hideProgress();
      var overlay = document.createElement("div");
      overlay.className = "ss-progress-overlay";
      var box = document.createElement("div");
      box.className = "ss-progress-box" + (isError ? " ss-progress-error" : "");
      box.textContent = message;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }

    function hideProgress() {
      var existing = document.querySelector(".ss-progress-overlay");
      if (existing) existing.remove();
    }

    return { inject: inject };
  })();

  // ====================================================================
  // 共享：按钮注入、Observer、URL 变更
  // ====================================================================
  function injectButtons() {
    if (!isStudioDetailPage()) {
      _mergeBtnInjected = false;
      _searchBtnInjected = false;
      return;
    }
    Merge.inject();
    Search.inject();
  }

  function setupObservers() {
    var target = document.querySelector(".main-content") || document.querySelector("#root") || document.body;
    var obs = new MutationObserver(function (mutations) {
      if (!isStudioDetailPage()) return;
      if (_mergeBtnInjected && _searchBtnInjected) return;
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].type === "childList" && mutations[i].addedNodes.length > 0) {
          clearTimeout(_observerTimer);
          _observerTimer = setTimeout(injectButtons, 300);
          break;
        }
      }
    });
    obs.observe(target, { childList: true, subtree: true });

    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () { origPush.apply(this, arguments); onUrlChange(); };
    history.replaceState = function () { origReplace.apply(this, arguments); onUrlChange(); };
    window.addEventListener("popstate", onUrlChange);
    window.addEventListener("hashchange", onUrlChange);
  }

  function onUrlChange() {
    _currentStudioId = null;
    _currentStudioData = null;
    _mergeBtnInjected = false;
    _searchBtnInjected = false;
    var mergeBtn = document.querySelector(".sm-btn");
    if (mergeBtn) mergeBtn.remove();
    var searchBtn = document.querySelector(".ss-search-btn");
    if (searchBtn) searchBtn.remove();
    if (_searchPanel) { _searchPanel.remove(); _searchPanel = null; }
    if (isStudioDetailPage()) setTimeout(injectButtons, 300);
  }

  function initPlugin() {
    setupObservers();
    if (isStudioDetailPage()) setTimeout(injectButtons, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPlugin);
  } else {
    initPlugin();
  }

})();
} catch (e) {
  console.error("[StudioTools] FATAL:", e);
}
