// anon-stash.js — Stash UI 占位符注入器（演员/场景/工作室/标签/番号 匿名化）
// 同时兼容「发现页」(.ssd-dp-page) 与演员详情页「发现」tab。
(() => {
  if (window.__SSD_ANON && window.__SSD_ANON.timer) clearInterval(window.__SSD_ANON.timer);
  const enc = (s) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
  const uri = {
    p: enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#47535e"/><stop offset="1" stop-color="#2b353d"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><circle cx="200" cy="225" r="70" fill="#93a3ae" opacity="0.7"/><path d="M200 315c-70 0-126 48-142 118v167h284V433c-16-70-72-118-142-118z" fill="#93a3ae" opacity="0.7"/><text x="200" y="578" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="22" letter-spacing="2" fill="#cfd8de" opacity="0.85">PLACEHOLDER</text></svg>'),
    t: enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d4a55"/><stop offset="1" stop-color="#212a31"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/><circle cx="400" cy="210" r="56" fill="none" stroke="#9fb0bb" stroke-width="10" opacity="0.75"/><path d="M384 182l46 28-46 28z" fill="#9fb0bb" opacity="0.8"/><text x="400" y="322" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" letter-spacing="3" fill="#cfd8de" opacity="0.85">PLACEHOLDER</text></svg>'),
    s: enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#42505b"/><stop offset="1" stop-color="#232c33"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><path d="M95 235V135h55v100zM165 235V100h75v135zM255 235V155h50v80z" fill="#93a3ae" opacity="0.65"/><text x="200" y="278" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="18" letter-spacing="2" fill="#cfd8de" opacity="0.8">PLACEHOLDER</text></svg>'),
  };
  const S = (window.__SSD_ANON = { maps: { p: {}, s: {}, t: {}, g: {}, code: {} } });
  const letter = (i) => {
    let s = ""; i++;
    while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
    return s;
  };
  const assign = (kind, orig, prefix) => {
    const m = S.maps[kind];
    if (m[orig]) return m[orig];
    const idx = Object.keys(m).length;
    return (m[orig] = prefix + " " + letter(idx));
  };
  const swap = (el, kind, prefix) => {
    if (!el.dataset.ssdOrig) el.dataset.ssdOrig = el.textContent.trim();
    el.textContent = assign(kind, el.dataset.ssdOrig, prefix);
  };

  const kindForImg = (img) => {
    const src = img.getAttribute("src") || "";
    if (img.classList.contains("ssd-dp-pfavatar--studio")) return "s";
    if (img.closest(".ssd-dp-mini") || img.closest(".ssd-dp-pfhead") ||
        img.closest(".ssd-dp-fgrp-head") || img.classList.contains("ssd-dp-pfavatar") ||
        img.classList.contains("performer-card__image") ||
        img.classList.contains("performer-card-image") ||
        /performer\/\d+\/image/.test(src)) return "p";
    return "t";
  };

  const applyRoot = (root) => {
    root.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      if (src.indexOf("data:image/svg+xml") === 0) return;
      const kind = kindForImg(img);
      img.removeAttribute("srcset");
      img.src = uri[kind];
      img.alt = "";
    });
    // 演员名
    root.querySelectorAll(".ssd-dp-mini-name, .ssd-dp-pfname, .performer-name, .ssd-pill-text").forEach((el) => {
      const isStudio = !!el.closest(".ssd-dp-pfhead--studio");
      swap(el, isStudio ? "s" : "p", isStudio ? "Studio" : "Performer");
    });
    // 演员标签卡片里的名字
    root.querySelectorAll(".performer-card__name, .performer-card-name").forEach((el) => swap(el, "p", "Performer"));
    // 别名
    root.querySelectorAll(".ssd-dp-pfalias, .performer-disambiguation").forEach((el) => { el.textContent = "别名：Alias A / Alias B"; });
    // 工作室名
    root.querySelectorAll(".studio-overlay a, .ssd-dp-grpchip, .studio-card__name, .studio-card-name").forEach((el) => {
      if (!el.dataset.ssdOrig) el.dataset.ssdOrig = el.textContent.trim();
      const m = el.dataset.ssdOrig.match(/^(.*?)(\s*·\s*\d+)$/);
      const name = m ? m[1] : el.dataset.ssdOrig;
      el.textContent = assign("s", name, "Studio") + (m ? m[2] : "");
    });
    // 场景标题
    root.querySelectorAll(".card-section-title, .scene-card__title").forEach((el) => swap(el, "t", "Sample Scene"));
    // 场景简介
    root.querySelectorAll(".scene-card__description, .ssd-synopsis-text").forEach((el) => {
      el.textContent = "Placeholder synopsis text for layout preview.";
    });
  };

  const applyModal = (modal) => {
    modal.querySelectorAll(".ssd-carousel-hero").forEach((el) => { el.style.backgroundImage = 'url("' + uri.t + '")'; });
    modal.querySelectorAll(".ssd-modal-title").forEach((el) => { el.textContent = "CODE-001"; });
    modal.querySelectorAll(".ssd-meta-item").forEach((item) => {
      const label = (item.querySelector(".ssd-meta-label") || {}).textContent || "";
      const val = item.querySelector(".ssd-meta-value");
      if (!val) return;
      if (/番号|Code/.test(label)) val.textContent = "CODE-001";
      else if (/导演|Director/.test(label)) val.textContent = "Director A";
      else if (/工作室|Studio/.test(label)) {
        if (!val.dataset.ssdOrig) val.dataset.ssdOrig = val.textContent.trim();
        val.textContent = assign("s", val.dataset.ssdOrig, "Studio");
      }
    });
    modal.querySelectorAll(".ssd-pill").forEach((el) => {
      if (el.querySelector(".ssd-pill-text")) return;
      if (!el.dataset.ssdOrig) el.dataset.ssdOrig = el.textContent.trim();
      el.textContent = assign("g", el.dataset.ssdOrig, "Tag");
    });
    modal.querySelectorAll(".ssd-synopsis-text").forEach((el) => { el.textContent = "Placeholder synopsis text for layout preview."; });
  };

  const apply = () => {
    applyRoot(document.body);
    const modal = document.querySelector(".ssd-modal");
    if (modal) applyModal(modal);
  };
  apply();
  S.timer = setInterval(apply, 250);
  return { ok: true };
})();
