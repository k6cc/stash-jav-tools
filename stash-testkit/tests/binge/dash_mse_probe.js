/**
 * DASH → MSE 可行性探针（不依赖 hls.js / 任何第三方库）
 *
 * 用途：验证 Stash 的 /scene/{id}/stream.mpd 端点能否由前端自写极简
 * MSE 播放器直接消费。Stash 的 DASH 段是 WebM（vp9 + opus），
 * MSE 原生支持 appendBuffer，不需要像 mpegts 那样做 transmux。
 *
 * 运行方式（同源页面内注入，页面须在 http://127.0.0.1:9999 下）：
 *   window.__DASHCFG__ = {scene, seconds, seek, bufferTarget};
 *   // 然后 eval 本文件
 * 结果写入 window.__RESULT__。
 */
(async () => {
    const CFG = window.__DASHCFG__ || {};
    const SCENE = CFG.scene || 244;
    const RUN_SECONDS = CFG.seconds || 60;
    const SEEK_TO = CFG.seek || 0;          // >0 时在第 8 秒跳到该位置
    const BUFFER_TARGET = CFG.bufferTarget || 30;
    const SEG = 2;                          // mpd 里 duration="2"

    const log = [];
    const samples = [];
    const events = [];
    window.__STAGE__ = "start";
    let t0 = Date.now();
    const rel = () => (Date.now() - t0) / 1000;
    const rec = (name, extra) =>
        events.push(Object.assign({ t: +rel().toFixed(3), name: name }, extra || {}));

    const KEY = CFG.apikey || "";
    const q = KEY ? "?apikey=" + KEY : "";

    // ── 1. 取 mpd ──────────────────────────────────────────────────────────
    const mpdUrl = "/scene/" + SCENE + "/stream.mpd" + q
        + (CFG.resolution ? "&resolution=" + CFG.resolution : "");
    let mpdText;
    try {
        const r = await fetch(mpdUrl);
        mpdText = await r.text();
        if (!r.ok) throw new Error("HTTP " + r.status);
    } catch (e) {
        window.__RESULT__ = { ok: false, error: "mpd fetch failed: " + e, log: log };
        return;
    }
    const doc = new DOMParser().parseFromString(mpdText, "application/xml");
    const mpdEl = doc.documentElement;
    const durStr = mpdEl.getAttribute("mediaPresentationDuration") || "PT0S";
    // 解析 ISO8601 时长 PT1H18M10S
    const dm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(durStr);
    const totalDur = dm
        ? (+(dm[1] || 0)) * 3600 + (+(dm[2] || 0)) * 60 + (+(dm[3] || 0))
        : 0;
    const totalSegs = Math.ceil(totalDur / SEG);
    const baseUrl = (doc.getElementsByTagName("BaseURL")[0] || {}).textContent
        || ("/scene/" + SCENE + "/stream.mpd/");
    const tmpls = Array.from(doc.getElementsByTagName("SegmentTemplate"));
    const vTmpl = tmpls.find((t) => (t.getAttribute("media") || "").includes("_v."));
    const aTmpl = tmpls.find((t) => (t.getAttribute("media") || "").includes("_a."));
    window.__STAGE__ = "mpd-ok";
    log.push("mpd: dur=" + totalDur + "s segs=" + totalSegs + " base=" + baseUrl);
    log.push("video tmpl=" + (vTmpl && vTmpl.getAttribute("media")));
    log.push("audio tmpl=" + (aTmpl && aTmpl.getAttribute("media")));

    const mediaUrl = (tmpl, n) => {
        if (!tmpl) return null;
        let m = tmpl.getAttribute("media").replace("$Number$", String(n));
        return baseUrl + m;   // base 已以 / 结尾，media 已含 apikey
    };
    const initUrl = (tmpl) => {
        if (!tmpl) return null;
        return baseUrl + tmpl.getAttribute("initialization");
    };

    // ── 2. 搭 video + MediaSource ──────────────────────────────────────────
    const v = document.createElement("video");
    v.muted = true;             // headless 无手势，静音可自动播
    v.autoplay = true;
    v.playsInline = true;
    v.controls = false;
    v.style.cssText = "position:fixed;left:0;top:0;width:320px;height:180px;z-index:99999";
    document.body.appendChild(v);

    const ms = new MediaSource();
    v.src = URL.createObjectURL(ms);

    ["waiting", "playing", "seeking", "seeked", "error", "stalled", "canplay"]
        .forEach((n) => v.addEventListener(n, () =>
            rec(n, { ct: +v.currentTime.toFixed(3), rs: v.readyState })));
    ms.addEventListener("error", () => rec("ms-error"));

    await new Promise((res) => ms.addEventListener("sourceopen", res, { once: true }));
    rec("sourceopen");
    window.__STAGE__ = "sourceopen";

    const V_MIME = 'video/webm; codecs="vp9"';
    const A_MIME = 'audio/webm; codecs="opus"';
    log.push("isTypeSupported vp9=" + MediaSource.isTypeSupported(V_MIME)
        + " opus=" + MediaSource.isTypeSupported(A_MIME));
    if (!MediaSource.isTypeSupported(V_MIME)) {
        window.__RESULT__ = { ok: false, error: "MSE 不支持 " + V_MIME, log: log };
        return;
    }

    const sbV = ms.addSourceBuffer(V_MIME);
    const sbA = aTmpl ? ms.addSourceBuffer(A_MIME) : null;
    window.__STAGE__ = "sb-added";
    sbV.mode = "segments";
    if (sbA) sbA.mode = "segments";

    // ── 3. 段装载 ──────────────────────────────────────────────────────────
    let nextSeg = 0;
    let inited = false;
    let fetching = false;
    let stopped = false;

    const append = (sb, buf) => new Promise((res, rej) => {
        const onEnd = () => { sb.removeEventListener("updateend", onEnd); res(); };
        sb.addEventListener("updateend", onEnd);
        try { sb.appendBuffer(buf); } catch (e) { rej(e); }
    });

    const fetchBuf = async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
        return await r.arrayBuffer();
    };

    // 目标缓冲深度：领先播放头 BUFFER_TARGET 秒就停止取段
    const leadSeconds = () => {
        let end = v.currentTime;
        try {
            const b = v.buffered;
            if (b.length) end = b.end(b.length - 1);
        } catch (e) { /* ignore */ }
        return end - v.currentTime;
    };

    const pump = async () => {
        if (fetching || stopped) return;
        fetching = true;
        try {
            if (!inited) {
                await append(sbV, await fetchBuf(initUrl(vTmpl)));
                if (sbA) await append(sbA, await fetchBuf(initUrl(aTmpl)));
                inited = true;
                rec("init-appended");
                window.__STAGE__ = "init-appended";
            }
            while (!stopped && nextSeg < totalSegs && leadSeconds() < BUFFER_TARGET) {
                const n = nextSeg++;
                const tSeg = Date.now();
                await append(sbV, await fetchBuf(mediaUrl(vTmpl, n)));
                if (sbA) await append(sbA, await fetchBuf(mediaUrl(aTmpl, n)));
                const dt = (Date.now() - tSeg) / 1000;
                if (dt > 1.0) rec("slow-seg", { seg: n, dt: +dt.toFixed(2) });
            }
        } catch (e) {
            const msg = String((e && e.message) || e);
            rec("pump-error", { msg: msg });
            window.__LIVEERR__ = msg + " @seg" + nextSeg
                + " rs=" + ms.readyState + " vrs=" + v.readyState;
        } finally {
            fetching = false;
        }
    };

    window.__SAMPLES__ = samples;
    window.__EVENTS__ = events;
    window.__LOG__ = log;

    const sampler = setInterval(() => {
        let be = 0;
        try {
            const b = v.buffered;
            if (b.length) be = b.end(b.length - 1);
        } catch (e) { /* ignore */ }
        samples.push({
            t: +rel().toFixed(3),
            ct: +v.currentTime.toFixed(3),
            rs: v.readyState,
            be: +be.toFixed(3),
            lead: +(be - v.currentTime).toFixed(3),
            paused: v.paused,
            seg: nextSeg,
        });
        if (!fetching) pump();
    }, 500);

    // ── 4. 起播 / seek ─────────────────────────────────────────────────────
    await pump();
    window.__STAGE__ = "first-pump-done";
    try { await v.play(); } catch (e) { rec("play-rejected", { msg: String(e && e.message || e) }); }
    window.__STAGE__ = "playing";

    if (SEEK_TO > 0) {
        setTimeout(() => {
            rec("do-seek", { to: SEEK_TO, ct: +v.currentTime.toFixed(3) });
            nextSeg = Math.floor(SEEK_TO / SEG);
            try { v.currentTime = SEEK_TO; } catch (e) { rec("seek-throw"); }
        }, 8000);
    }

    await new Promise((r) => setTimeout(r, RUN_SECONDS * 1000));
    stopped = true;
    clearInterval(sampler);

    // ── 5. 汇总 ────────────────────────────────────────────────────────────
    const waits = events.filter((e) => e.name === "waiting");
    let maxFreeze = 0;
    let prev = samples[0];
    for (const s of samples) {
        if (prev && s.ct - prev.ct < 0.05 && !s.paused) {
            maxFreeze = Math.max(maxFreeze, s.t - prev.t);
        }
        prev = s;
    }
    const leads = samples.map((s) => s.lead).filter((x) => x > 0);
    leads.sort((a, b) => a - b);

    window.__RESULT__ = {
        ok: true,
        scene: SCENE,
        engine: "dash-mse",
        bufferTarget: BUFFER_TARGET,
        duration: totalDur,
        samples: samples,
        events: events,
        log: log,
        summary: {
            playedTo: Math.max.apply(null, samples.map((s) => s.ct)),
            waitingCount: waits.length,
            waitingAt: waits.map((e) => +e.t.toFixed(1)),
            maxFreezeSec: +maxFreeze.toFixed(2),
            leadMedian: leads.length ? +leads[Math.floor(leads.length / 2)].toFixed(2) : 0,
            leadMin: leads.length ? +leads[0].toFixed(2) : 0,
            leadMax: leads.length ? +leads[leads.length - 1].toFixed(2) : 0,
            segsLoaded: nextSeg,
            slowSegs: events.filter((e) => e.name === "slow-seg")
                .map((e) => ({ t: e.t, seg: e.seg, dt: e.dt })),
            errors: events.filter((e) => e.name === "error" || e.name === "pump-error"),
        },
    };
})();
