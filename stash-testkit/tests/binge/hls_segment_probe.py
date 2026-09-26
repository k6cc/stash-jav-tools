# -*- coding: utf-8 -*-
"""HLS 分片取流节奏探针（用于定位 binge 在 HLS 模式下的周期性卡顿/转圈）。

原理：不启动浏览器，在脚本内模拟一个"播放器"——
  · 播放头按真实时间 1 段 / 2s 推进；
  · 始终维持"领先播放头 N 段"的预取窗口（模拟浏览器缓冲）；
  · 逐段按序串行请求 /scene/{id}/stream.m3u8/{seg}.ts，完整读掉响应体；
  · 播放头需要某段而该段尚未到达 → 记为一次 stall（等价于用户看到的转圈）。

这样能把"卡顿"精确归因到服务端分片生产延迟，排除浏览器缓冲策略的干扰。

用法：
  python hls_segment_probe.py --scene 222 --minutes 3                # mkv，跑 3 分钟
  python hls_segment_probe.py --scene 244 --minutes 3 --reset-cache  # wmv，清缓存冷启动
  python hls_segment_probe.py --scene 222 --minutes 2 --start-seg 300 # 从 10 分钟处起播
  python hls_segment_probe.py --scene 222 --probe-only               # 只测 manifest + 冷启动耗时

输出：
  · manifest 信息（总段数 / 时长）
  · 延迟 > 1s 的请求明细（相对时刻 / 段号 / 排队+传输耗时 / 字节数）
  · stall 明细（播放到几秒时卡住、卡多久）
  · 汇总（请求数、500 次数、p50/p95/max 延迟、stall 次数与总时长）
  · --json 可落盘原始结果

Stash 服务端机制速查（v0.31.1 pkg/ffmpeg/stream_segmented.go）：
  segmentLength=2s  maxSegmentBuffer=15（领先 15 段就停 ffmpeg）
  maxSegmentGap=5（段号跳跃 >5 判定 seek 并重启）  maxSegmentWait=15s（超时返回 500）
  maxIdleTime=30s（空闲则停转码并删除整个缓存目录）  monitorInterval=200ms
"""
import argparse
import json
import os
import queue
import shutil
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash  # noqa: E402

SEG = 2.0  # 服务端段长（stream_segmented.go: segmentLength = 2）

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 绕过本机 http 代理


# ── HTTP ────────────────────────────────────────────────────────────────────
def http_get(url, timeout=60):
    """返回 (status, bytes_len, err_text)。完整读掉响应体（模拟浏览器真的下载）。"""
    req = urllib.request.Request(url, method="GET")
    t0 = time.time()
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            n = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                n += len(chunk)
            return r.status, n, None
    except urllib.error.HTTPError as e:
        try:
            body = e.read()[:200].decode("utf-8", "replace")
        except Exception:
            body = ""
        return e.code, 0, (e.reason or "") + (" | " + body if body else "")
    except Exception as e:  # noqa: BLE001
        return -1, 0, "%s: %s" % (type(e).__name__, e)


# ── 缓存目录 ────────────────────────────────────────────────────────────────
def scene_oshash(stash, sid):
    data = stash.call(
        "query($id: ID!){ findScene(id:$id){ id files{ path duration fingerprints{ type value } } } }",
        {"id": str(sid)})["findScene"]
    for f in data.get("files") or []:
        for fp in f.get("fingerprints") or []:
            if fp.get("type") == "oshash":
                return fp["value"], data
    return None, data


def reset_cache(cache_dir, oshash, resolution):
    """删除本场景的 HLS 缓存目录（冷启动复现）。只删 *_hls* 目录，不动其他文件。"""
    if not cache_dir or not os.path.isdir(cache_dir):
        return 0
    n = 0
    for name in os.listdir(cache_dir):
        p = os.path.join(cache_dir, name)
        if not os.path.isdir(p) or "_hls" not in name:
            continue
        if oshash and not name.startswith(oshash):
            continue
        shutil.rmtree(p, ignore_errors=True)
        print("  [cache] 已删除 %s" % name)
        n += 1
    return n


def cache_sampler(cache_dir, oshash, stop_ev, out):
    """后台采样缓存目录：段数、最大段号、临时文件数（可看出 ffmpeg 是否在跑）。"""
    """采样项: (t, 最大已完成段号, 已完成段数, 临时文件数, 目录是否存在)

    目录不存在 = Stash 判定空闲（maxIdleTime=30s）把整个缓存目录删了，
    下一次取段必须冷重启 ffmpeg，是"卡 8 秒"的头号嫌疑。"""
    while not stop_ev.is_set():
        try:
            dirs = [d for d in os.listdir(cache_dir) if d.startswith(oshash) and "_hls" in d]
        except Exception:
            dirs = []
        if not dirs:
            out.append((time.time(), -1, 0, 0, False))
            stop_ev.wait(1.0)
            continue
        for d in dirs:
            full = os.path.join(cache_dir, d)
            try:
                names = os.listdir(full)
            except Exception:
                continue
            done = [x for x in names if x.endswith(".ts") and not x.startswith(".")]
            tmp = [x for x in names if x.startswith(".") and x.endswith(".ts")]
            idx = [int(x.split(".")[0]) for x in done if x.split(".")[0].isdigit()]
            out.append((time.time(), max(idx) if idx else -1, len(done), len(tmp), True))
        stop_ev.wait(1.0)


def report_segment_integrity(cache_dir, oshash):
    """跑完后扫描缓存里每一段：时长、首帧 PTS、ffprobe 解码错误。
    用来抓"服务端 stopTranscode 把最后一段写坏"这类问题——它会让浏览器
    有数据却播不动（currentTime 冻结、readyState=2、无 error 事件）。"""
    from hls_pts_check import find_ffprobe, seg_info, seg_frames  # 同目录，延迟导入避免循环

    ffprobe = find_ffprobe()
    if not ffprobe:
        print("\n  [完整性] 找不到 ffprobe，跳过")
        return
    d = None
    for name in os.listdir(cache_dir):
        if name.startswith(oshash) and "_hls" in name:
            d = os.path.join(cache_dir, name)
            break
    if not d:
        print("\n  [完整性] 缓存目录不存在，跳过")
        return
    files = sorted((int(f.split(".")[0]), os.path.join(d, f))
                   for f in os.listdir(d)
                   if f.endswith(".ts") and not f.startswith(".")
                   and f.split(".")[0].isdigit())
    print("\n──────── 分段完整性（ffprobe 逐段检查 %d 段）────────" % len(files))
    bad = []
    prev = None
    print("  段号    帧数  可解码时长   首帧PTS    末帧PTS   容器时长")
    for idx, path in files:
        pts, dur, err = seg_info(ffprobe, path)
        n, f0, f1 = seg_frames(ffprobe, path)
        span = (f1 - f0) if (f0 is not None and f1 is not None and n > 1) else None
        flags = []
        if span is not None and span < SEG - 0.3:
            flags.append("可解码仅 %.3fs（差 %.3fs）" % (span, SEG - span))
        if n == 0:
            flags.append("解不出任何帧")
        if pts is not None and prev is not None and abs((pts - prev) - SEG) > 0.35:
            flags.append("与上段 PTS 间隔 %.3fs（期望 %ss）" % (pts - prev, SEG))
        if err and "PPS" not in err:   # 每段都缺 PPS 属 TS 常态，单独说明
            flags.append("ffprobe: " + err.replace("\n", " ")[:120])
        mark = "⚠" if flags else " "
        print("  %s %-5d %5d  %8s   %9s  %9s  %8s%s" % (
            mark, idx, n,
            ("%.3f" % span) if span is not None else "-",
            ("%.3f" % f0) if f0 is not None else "-",
            ("%.3f" % f1) if f1 is not None else "-",
            ("%.3f" % dur) if dur is not None else "-",
            ("   ← " + "; ".join(flags)) if flags else ""))
        if flags:
            bad.append((idx, pts, dur, flags))
        if pts is not None:
            prev = pts
    print("  注：TS 分段普遍缺 SPS/PPS（ffprobe 报 non-existing PPS），"
          "独立解码首帧会失败，浏览器靠前一段的解码器状态续解，属正常现象。")
    if not bad:
        print("  全部正常：每段可解码≈%ss、PTS 连续" % SEG)
    else:
        print("  共 %d 段异常 → 缺帧/PTS 断裂会让浏览器在这些段上卡住"
              "（有数据但播不动，无 error 事件）" % len(bad))


# ── 主探针 ──────────────────────────────────────────────────────────────────
def run_probe(args):
    stash = Stash()
    origin = stash.cfg["api_url"].rsplit("/graphql", 1)[0]
    key = stash.cfg["api_key"]

    oshash, scene = scene_oshash(stash, args.scene)
    seg_url_tpl = "%s/scene/%s/stream.m3u8/%%d.ts?apikey=%s&resolution=%s" % (
        origin, args.scene, key, args.resolution)
    m3u8_url = "%s/scene/%s/stream.m3u8?apikey=%s&resolution=%s" % (
        origin, args.scene, key, args.resolution)

    print("场景 #%s  oshash=%s  resolution=%s" % (args.scene, oshash, args.resolution))
    for f in scene.get("files") or []:
        print("  文件: %s  duration=%.1fs  %sx%s" % (
            f.get("path"), f.get("duration") or 0, f.get("width"), f.get("height")))

    # manifest
    st, n, err = http_get(m3u8_url)
    if st != 200:
        print("manifest 请求失败: status=%s err=%s" % (st, err))
        return 1
    print("  manifest: %d 字节" % n)

    if args.reset_cache:
        reset_cache(args.cache_dir, oshash, args.resolution)

    # 冷启动：请求起始段，量一次 ffmpeg 启动耗时
    t0 = time.time()
    st, n, err = http_get(seg_url_tpl % args.start_seg, timeout=60)
    cold = time.time() - t0
    print("  冷启动段 #%d: status=%s %.2fs %d 字节 %s" % (args.start_seg, st, cold, n, err or ""))
    if args.probe_only:
        return 0

    # 段总量：用 ffprobe duration 估算（manifest 只给相对 URL，这里用 GraphQL duration）
    duration = 0
    for f in scene.get("files") or []:
        duration = max(duration, f.get("duration") or 0)
    total_segs = int(duration / SEG)
    print("  总时长 %.1fs → 约 %d 段（播放上限受 --minutes 控制）" % (duration, total_segs))

    # ── 取流工作线程（串行，模拟浏览器顺序取段）──
    results = []
    downloaded = set()
    lock = threading.Lock()
    q = queue.Queue()

    def worker():
        while True:
            seg, t_enq = q.get()
            if seg is None:
                break
            status, nbytes, err = http_get(seg_url_tpl % seg, timeout=60)
            t_end = time.time()
            with lock:
                results.append({
                    "seg": seg, "enqueue": t_enq, "end": t_end,
                    "queue": 0.0, "latency": t_end - t_enq,
                    "status": status, "bytes": nbytes, "err": err,
                })
                if status == 200:
                    downloaded.add(seg)
            q.task_done()

    th = threading.Thread(target=worker, daemon=True)
    th.start()

    samples = []
    stop_ev = threading.Event()
    if args.cache_dir and os.path.isdir(args.cache_dir) and oshash:
        threading.Thread(target=cache_sampler, args=(args.cache_dir, oshash, stop_ev, samples),
                         daemon=True).start()

    # ── 播放头推进 ──
    budget = args.minutes * 60.0
    start = time.time()
    next_req = args.start_seg + 1
    downloaded.add(args.start_seg)
    stalls = []
    cur = None
    max_depth = 0
    end_reason = "时间到"

    print("\n播放中（%.1f 分钟，预取窗口 %d 段 = %.0fs）…" % (args.minutes, args.lead, args.lead * SEG))
    while True:
        now = time.time()
        el = now - start
        if el >= budget:
            break
        ph = args.start_seg + int(el // SEG)          # 播放头当前消费的段号
        if ph >= total_segs:
            end_reason = "到达片尾"
            break
        while next_req <= ph + args.lead and next_req < total_segs:
            q.put((next_req, time.time()))
            next_req += 1
        depth = next_req - ph
        max_depth = max(max_depth, depth)
        with lock:
            have = ph in downloaded
        if not have:
            if cur is None:
                cur = {"seg": ph, "at": el, "t0": now}
        elif cur is not None:
            cur["dur"] = now - cur["t0"]
            stalls.append(cur)
            cur = None
        time.sleep(0.05)

    if cur is not None:          # 结束时仍卡着
        cur["dur"] = time.time() - cur["t0"]
        stalls.append(cur)
    stop_ev.set()
    q.put((None, 0))
    th.join(timeout=60)

    # ── 报告 ──
    ref = start
    rel = lambda t: t - ref  # noqa: E731
    ok = [r for r in results if r["status"] == 200]
    bad = [r for r in results if r["status"] != 200]
    lats = [r["latency"] for r in results]

    print("\n──────── 请求明细（延迟 > %.1fs）────────" % args.slow)
    print("  时刻(s)   段号   耗时(s)   字节      状态")
    for r in sorted(results, key=lambda x: x["seg"]):
        if r["latency"] >= args.slow:
            print("  %7.1f  %5d  %8.2f  %9d  %s%s" % (
                rel(r["enqueue"]), r["seg"], r["latency"], r["bytes"],
                r["status"], ("  " + (r["err"] or "")[:60]) if r["err"] else ""))

    print("\n──────── stall（播放头等不到段）────────")
    if not stalls:
        print("  无")
    for s in stalls:
        print("  播放到 %7.1fs（段 #%d）卡住，持续 %.2fs" % (s["at"], s["seg"], s["dur"]))

    print("\n──────── 汇总 ────────")
    print("  播放时长      : %.1fs（%s）" % (min(rel(results[-1]["end"]) if results else 0, budget), end_reason))
    print("  段请求        : %d（成功 %d / 失败 %d）" % (len(results), len(ok), len(bad)))
    if bad:
        print("  失败明细      : " + ", ".join("段#%d→%s" % (r["seg"], r["status"]) for r in bad[:20]))
    if lats:
        lats_sorted = sorted(lats)
        p50 = statistics.median(lats_sorted)
        p95 = lats_sorted[min(len(lats_sorted) - 1, int(len(lats_sorted) * 0.95))]
        print("  延迟 p50/p95/max: %.2fs / %.2fs / %.2fs" % (p50, p95, max(lats)))
    print("  stall 次数    : %d，累计 %.2fs，最长 %.2fs" % (
        len(stalls), sum(s["dur"] for s in stalls), max((s["dur"] for s in stalls), default=0)))
    print("  最大预取深度  : %d 段（%.0fs）" % (max_depth, max_depth * SEG))
    if samples:
        prod = [s for s in samples if s[1] >= 0]
        gone = [s for s in samples if not s[4]]
        print("  缓存目录采样  : %d 次，段生产进度 %s → %s" % (
            len(samples), prod[0][1] if prod else "-", prod[-1][1] if prod else "-"))
        if gone:
            print("  ⚠ 缓存目录消失: %d/%d 次采样（Stash 空闲 30s 删目录 → 下次取段需冷重启）" % (
                len(gone), len(samples)))
        else:
            print("  缓存目录      : 全程存在（未触发空闲删除）")

    if args.ffprobe:
        report_segment_integrity(args.cache_dir, oshash)

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"scene": args.scene, "resolution": args.resolution,
                       "start_seg": args.start_seg, "requests": results, "stalls": stalls},
                      f, ensure_ascii=False, indent=2)
        print("\n  原始结果已写入 %s" % args.json)
    return 0


def main():
    ap = argparse.ArgumentParser(description="HLS 分片取流节奏探针")
    ap.add_argument("--scene", required=True, help="场景 ID")
    ap.add_argument("--minutes", type=float, default=2.0, help="模拟播放分钟数（默认 2）")
    ap.add_argument("--start-seg", type=int, default=0, help="起始段号（段长 2s）")
    ap.add_argument("--resolution", default="ORIGINAL", help="ORIGINAL / 1080P / 720P …（默认 ORIGINAL）")
    ap.add_argument("--lead", type=int, default=4, help="预取窗口段数（默认 4 = 8s）")
    ap.add_argument("--cache-dir", default=r"E:\stashAPP\cache", help="Stash 缓存目录（用于采样/清理）")
    ap.add_argument("--reset-cache", action="store_true", help="开跑前删除本场景的 HLS 缓存（冷启动）")
    ap.add_argument("--probe-only", action="store_true", help="只测 manifest 与冷启动耗时")
    ap.add_argument("--slow", type=float, default=1.0, help="请求明细打印阈值（秒）")
    ap.add_argument("--ffprobe", action="store_true",
                    help="跑完用 ffprobe 逐段检查时长/PTS/解码错误（抓被写坏的段）")
    ap.add_argument("--json", help="原始结果 JSON 落盘路径")
    args = ap.parse_args()
    return run_probe(args)


if __name__ == "__main__":
    sys.exit(main())
