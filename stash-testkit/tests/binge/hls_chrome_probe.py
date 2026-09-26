# -*- coding: utf-8 -*-
"""HLS 真实播放探针（headless Chrome，实时播放 + 事件/采样上报）。

与 hls_segment_probe.py 的分工：
  · hls_segment_probe.py —— 脚本模拟取流节奏，纯服务端时序，无浏览器变量；
  · 本脚本 —— 真实 <video> 播放，能看到浏览器缓冲策略、waiting/stalled 事件、
    画面冻结（currentTime 不推进）等用户实际观感，且能测 seek 后是否真从目标位置恢复。

实现：起一个本地 HTTP 服务（127.0.0.1:8765）下发测试页 + 接收上报，
用 headless Chrome 实时播放指定时长后回收 JSON 做分析（不走 CDP，兼容性更好）。

用法：
  python hls_chrome_probe.py --scene 222 --seconds 150 --reset-cache   # mkv 播 150s
  python hls_chrome_probe.py --scene 244 --seconds 180 --reset-cache   # wmv 播 180s
  python hls_chrome_probe.py --scene 244 --seconds 60 --seek 600       # 起播 8s 后拖到 10 分钟
  python hls_chrome_probe.py --scene 222 --seconds 90 --chrome "C:\\...\\msedge.exe"

输出：
  · 播放器能力（canPlayType）、duration、分辨率、就绪耗时
  · waiting/stalled/error 事件时间线
  · 画面冻结区间（currentTime 停滞 ≥0.5s 且未暂停）
  · seek 结果（目标值 / 实际落点 / 恢复播放耗时 / seek 后画面是否推进）
  · 汇总（冻结次数、累计冻结时长、最长冻结）

注意：headless Chrome 实时播放需真实时间推进，不要加 --virtual-time-budget
（该参数下媒体时钟不前进，currentTime 恒为 0）。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stash_client import Stash  # noqa: E402
from hls_segment_probe import http_get, scene_oshash, reset_cache  # noqa: E402

DEFAULT_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PAGE = r"""<!doctype html><meta charset="utf-8">
<video id="v" playsinline muted style="width:640px;height:360px;background:#000"></video>
<script src="/hls.min.js"></script>
<script>
const CFG = __CFG__;
const ev = [];          // 事件
const samples = [];     // 采样
const t0 = performance.now();
const rel = () => (performance.now() - t0) / 1000;
const v = document.getElementById('v');
const rec = (name, extra) => ev.push(Object.assign({
  name, t: +rel().toFixed(3), ct: +v.currentTime.toFixed(3), rs: v.readyState
}, extra || {}));

let seekPlan = CFG.seek > 0 ? {at: CFG.seekAt, target: CFG.seek, done: false} : null;

['loadstart','loadedmetadata','canplay','canplaythrough','playing','waiting','stalled',
 'suspend','abort','ended','seeking','seeked','progress','error'].forEach(n => {
  v.addEventListener(n, () => rec(n, n === 'error' && v.error ? {
    code: v.error.code, msg: v.error.message } : {}));
});

const p = v.play();
if (p && p.catch) p.catch(e => rec('play-rejected', {msg: String(e)}));

if (CFG.engine === 'hlsjs' && window.Hls && window.Hls.isSupported()) {
  // hls.js 接管：可配置前向缓冲（原生 HLS 只有 ~10s，服务端每 30s 内容
  // 要冷重启 ffmpeg 1.5~1.8s，缓冲越浅越容易被看见）
  const hls = new Hls({
    maxBufferLength: CFG.hlsBuffer,
    maxMaxBufferLength: CFG.hlsBuffer * 2,
    maxBufferSize: 400 * 1000 * 1000,
    maxBufferHole: 0.5
  });
  window.__hls = hls;
  hls.on(Hls.Events.ERROR, (e, d) => rec('hls-error', {
    msg: d.type + '/' + d.details + (d.fatal ? '/FATAL' : '')}));
  hls.on(Hls.Events.FRAG_LOADED, (e, d) => rec('frag', {msg: '#' + (d.frag && d.frag.sn)}));
  hls.on(Hls.Events.MANIFEST_PARSED, () => rec('hls-ready'));
  hls.loadSource(CFG.url);
  hls.attachMedia(v);
} else {
  v.src = CFG.url;
  v.load();
}

const sampler = setInterval(() => {
  let be = 0;
  try { be = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0; } catch (e) {}
  // 持续兜底起播：hls.js attachMedia 会打断首次 play()，不重试就会全程 paused
  if (v.paused && !document.hidden) {
    const pp = v.play();
    if (pp && pp.catch) pp.catch(() => {});
  }
  samples.push({t: +rel().toFixed(3), ct: +v.currentTime.toFixed(3), rs: v.readyState,
                be: +be.toFixed(3), paused: v.paused});
  if (seekPlan && !seekPlan.done && rel() >= seekPlan.at) {
    seekPlan.done = true;
    rec('do-seek', {target: seekPlan.target});
    try { v.currentTime = seekPlan.target; } catch (e) { rec('seek-throw', {msg: String(e)}); }
  }
}, 250);

setTimeout(() => {
  clearInterval(sampler);
  let canPlay = {};
  try {
    canPlay = {
      m3u8: v.canPlayType('application/vnd.apple.mpegurl'),
      mp4: v.canPlayType('video/mp4'),
      ts: v.canPlayType('video/mp2t')
    };
  } catch (e) {}
  fetch('/report', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      events: ev, samples, canPlay,
      duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      currentSrc: v.currentSrc
    })}).then(() => { document.title = 'done'; });
}, CFG.seconds * 1000);
</script>
"""


class Handler(BaseHTTPRequestHandler):
    report = None
    cfg = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/hls.min.js"):
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hls.min.js")
            if os.path.exists(p):
                body = open(p, "rb").read()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)
            return
        body = PAGE.replace("__CFG__", json.dumps(Handler.cfg)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        Handler.report = json.loads(self.rfile.read(n).decode("utf-8"))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


def analyze(rep, args):
    ev = rep.get("events") or []
    sm = rep.get("samples") or []
    print("\n──────── 播放器 ────────")
    print("  canPlayType  : m3u8=%s  mp4=%s  ts=%s" % (
        rep.get("canPlay", {}).get("m3u8"), rep.get("canPlay", {}).get("mp4"),
        rep.get("canPlay", {}).get("ts")))
    print("  duration     : %s  分辨率: %sx%s" % (
        rep.get("duration"), rep.get("videoWidth"), rep.get("videoHeight")))

    print("\n──────── 关键事件 ────────")
    for e in ev:
        if e["name"] in ("loadstart", "loadedmetadata", "canplay", "playing", "waiting",
                         "stalled", "error", "seeking", "seeked", "do-seek", "ended",
                         "play-rejected", "seek-throw", "hls-ready", "hls-error"):
            extra = ""
            if e.get("code") is not None:
                extra += " code=%s %s" % (e["code"], e.get("msg", ""))
            elif e.get("target") is not None:
                extra += " target=%s" % e["target"]
            elif e.get("msg"):
                extra += " %s" % e["msg"]
            print("  %8.2fs  %-14s ct=%8.2f readyState=%s%s" % (
                e["t"], e["name"], e["ct"], e["rs"], extra))

    # 画面冻结：未暂停但 currentTime 停滞
    freezes = []
    cur = None
    for i in range(1, len(sm)):
        a, b = sm[i - 1], sm[i]
        dt = b["t"] - a["t"]
        dct = b["ct"] - a["ct"]
        if (not b["paused"]) and dct < 0.05 and dt > 0:
            if cur is None:
                cur = {"t0": a["t"], "ct": a["ct"], "dur": 0.0, "minrs": min(a["rs"], b["rs"])}
            cur["dur"] += dt
            cur["minrs"] = min(cur["minrs"], b["rs"])
        else:
            if cur is not None and cur["dur"] >= 0.5:
                freezes.append(cur)
            cur = None
    if cur is not None and cur["dur"] >= 0.5:
        freezes.append(cur)

    print("\n──────── 画面冻结（currentTime 停滞 ≥0.5s 且未暂停）────────")
    if not freezes:
        print("  无")
    for f in freezes:
        print("  %8.2fs 处（播放位置 %.2fs）冻结 %.2fs，期间最小 readyState=%s" % (
            f["t0"], f["ct"], f["dur"], f["minrs"]))

    ct_max = max((s["ct"] for s in sm), default=0)
    played = sm[-1]["t"] if sm else 0
    print("\n──────── 汇总 ────────")
    print("  采样时长    : %.1fs，播放位置推进到 %.2fs" % (played, ct_max))
    # 缓冲领先深度 = buffered.end - currentTime：这就是"卡顿抗性强弱"。
    # 服务端每 ~30s 内容要重启一次 ffmpeg（实测冷重启 1.5~1.8s），
    # 客户端领先深度若小于该值就会转圈。
    depths = sorted(s["be"] - s["ct"] for s in sm if s["be"] > s["ct"])
    if depths:
        print("  缓冲领先    : 最小 %.2fs / p10 %.2fs / 中位 %.2fs / 最大 %.2fs" % (
            depths[0], depths[int(len(depths) * 0.1)], depths[len(depths) // 2], depths[-1]))
        print("  → 服务端重启耗时约 1.5~1.8s，领先深度低于该值即出现可见转圈")
    print("  冻结次数    : %d，累计 %.2fs，最长 %.2fs" % (
        len(freezes), sum(f["dur"] for f in freezes), max((f["dur"] for f in freezes), default=0)))
    wait_n = sum(1 for e in ev if e["name"] == "waiting")
    err_n = sum(1 for e in ev if e["name"] == "error")
    print("  waiting 事件: %d，error 事件: %d" % (wait_n, err_n))
    if err_n:
        for e in ev:
            if e["name"] == "error":
                print("    %8.2fs error code=%s %s" % (e["t"], e.get("code"), e.get("msg", "")))
    if args.seek > 0:
        do = next((e for e in ev if e["name"] == "do-seek"), None)
        after = [s for s in sm if do and s["t"] >= do["t"]]
        landed = after[0]["ct"] if after else None
        resumed = next((s for s in after if s["ct"] > (landed or 0) + 0.5), None)
        print("  seek 结果   : 目标 %.0fs，落点 %s，%s" % (
            args.seek, landed,
            ("%.2fs 后画面恢复推进" % (resumed["t"] - do["t"])) if (resumed and do)
            else "画面未恢复推进"))
    return freezes


def post_check(stash, args, freeze):
    """浏览器仍活着时，直接从脚本侧请求卡住位置附近的段，判定责任方：
    · 服务端秒回 → 浏览器/解码侧问题；
    · 服务端挂住或 500 → 服务端分片生产问题（ffmpeg 停摆 / 重启抖动）。"""
    origin = stash.cfg["api_url"].rsplit("/graphql", 1)[0]
    tpl = "%s/scene/%s/stream.m3u8/%%d.ts?apikey=%s&resolution=%s" % (
        origin, args.scene, stash.cfg["api_key"], args.resolution)
    seg = int(freeze["ct"] // 2)
    print("\n──────── 卡死瞬间服务端状态 ────────")
    print("  卡在播放位置 %.2fs → 段 #%d（浏览器尚未关闭，直连请求同一流）" % (freeze["ct"], seg))
    for s in (seg, seg + 1, seg + 2):
        t0 = time.time()
        st, n, err = http_get(tpl % s, timeout=20)
        print("    段 #%-5d status=%-4s %.2fs %10d 字节 %s" % (s, st, time.time() - t0, n, err or ""))
    cs = _cache_state(args)
    if cs:
        print("    缓存目录: %s" % cs)
    # 再取一次 manifest，确认服务端整体仍健康
    t0 = time.time()
    st, n, err = http_get("%s/scene/%s/stream.m3u8?apikey=%s&resolution=%s" % (
        origin, args.scene, stash.cfg["api_key"], args.resolution), timeout=20)
    print("    manifest : status=%s %.2fs %d 字节" % (st, time.time() - t0, n))


def _cache_state(args):
    if not os.path.isdir(args.cache_dir):
        return None
    oshash, _ = scene_oshash(Stash(), args.scene)
    if not oshash:
        return None
    for d in os.listdir(args.cache_dir):
        if d.startswith(oshash) and "_hls" in d:
            full = os.path.join(args.cache_dir, d)
            names = os.listdir(full)
            done = [x for x in names if x.endswith(".ts") and not x.startswith(".")]
            tmp = [x for x in names if x.startswith(".") and x.endswith(".ts")]
            idx = sorted(int(x.split(".")[0]) for x in done if x.split(".")[0].isdigit())
            return "%s：已完成 %d 段（最大 #%s），临时文件 %d 个%s" % (
                d, len(done), idx[-1] if idx else "-", len(tmp),
                "，编号连续" if idx and idx[-1] - idx[0] + 1 == len(idx) else "，编号有空洞")
    return "无匹配缓存目录（可能已被空闲清理删除）"


def main():
    ap = argparse.ArgumentParser(description="HLS 真实播放探针（headless Chrome）")
    ap.add_argument("--scene", required=True, help="场景 ID")
    ap.add_argument("--seconds", type=int, default=120, help="播放秒数（默认 120）")
    ap.add_argument("--resolution", default="ORIGINAL")
    ap.add_argument("--seek", type=float, default=0, help=">0 则在起播 8s 后拖到该秒")
    ap.add_argument("--seek-at", type=float, default=8, help="触发 seek 的时刻（默认起播后 8s）")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--chrome", default=DEFAULT_CHROME)
    ap.add_argument("--cache-dir", default=r"E:\stashAPP\cache")
    ap.add_argument("--reset-cache", action="store_true")
    ap.add_argument("--engine", choices=["native", "hlsjs"], default="native",
                    help="native = Chrome 原生 HLS；hlsjs = hls.js 接管（可配前向缓冲）")
    ap.add_argument("--hls-buffer", type=float, default=30,
                    help="hls.js 的 maxBufferLength（秒，默认 30）")
    ap.add_argument("--post-check", type=float, default=3.0,
                    help="冻结超过该秒数时，关闭浏览器前先抓服务端状态（默认 3s，0 = 关闭）")
    ap.add_argument("--json", help="原始上报 JSON 落盘路径")
    args = ap.parse_args()

    if not os.path.exists(args.chrome):
        print("找不到浏览器: %s" % args.chrome)
        return 1

    stash = Stash()
    origin = stash.cfg["api_url"].rsplit("/graphql", 1)[0]
    url = "%s/scene/%s/stream.m3u8?apikey=%s&resolution=%s" % (
        origin, args.scene, stash.cfg["api_key"], args.resolution)

    if args.reset_cache:
        # 复用 segment 探针的清理逻辑（按 oshash 精准删除 *_hls* 目录）
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from hls_segment_probe import scene_oshash, reset_cache  # noqa: E402
        oshash, _ = scene_oshash(stash, args.scene)
        reset_cache(args.cache_dir, oshash, args.resolution)

    Handler.cfg = {"url": url, "seconds": args.seconds, "seek": args.seek, "seekAt": args.seek_at,
                   "engine": args.engine, "hlsBuffer": args.hls_buffer}
    Handler.report = None
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    profile = tempfile.mkdtemp(prefix="hlsprobe-")
    cmd = [args.chrome, "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
           "--autoplay-policy=no-user-gesture-required", "--window-size=1280,720",
           "--user-data-dir=" + profile,
           "http://127.0.0.1:%d/?scene=%s" % (args.port, args.scene)]
    print("场景 #%s  播放 %ds%s" % (args.scene, args.seconds,
                                    ("  8s 后拖到 %.0fs" % args.seek) if args.seek else ""))
    print("  URL: %s" % url)
    t_wall0 = time.strftime("%H:%M:%S")
    print("  开始时刻: %s（用于与 Stash 日志时间对齐）" % t_wall0)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    deadline = time.time() + args.seconds + 60
    while time.time() < deadline and Handler.report is None:
        time.sleep(1)
    time.sleep(1)

    def shutdown():
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        srv.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    if Handler.report is None:
        print("未收到上报（浏览器可能启动失败或播放未开始）")
        shutdown()
        return 1
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(Handler.report, f, ensure_ascii=False, indent=2)
        print("原始上报已写入 %s" % args.json)

    freezes = analyze(Handler.report, args)
    print("  结束时刻: %s（冻结时刻 ≈ 开始 + 上表 t0）" % time.strftime("%H:%M:%S"))
    # 浏览器仍活着 → 立刻抓服务端状态，判断是"服务端不出段"还是"浏览器侧卡住"
    big = [f for f in freezes if f["dur"] >= args.post_check]
    if big:
        post_check(stash, args, big[-1])
    shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
