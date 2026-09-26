# -*- coding: utf-8 -*-
"""HLS 分段时间戳（PTS）连续性检查 —— 定位"重启转码后画面永久卡死"的根因。

背景：Stash 服务端在"领先 15 段"或"段号跳跃 >5"时会 stopTranscode，
随后用 `ffmpeg -ss N` 冷重启。本脚本人为制造一次重启，然后用 ffprobe
比较重启点前后两段的起始 PTS：
  · PTS 连续（≈ 段号 × 2s）   → 浏览器可以无缝续播；
  · PTS 断裂（回跳/归零/重复） → 浏览器无法 append，画面永久卡死
    （Stash 的 manifest 从不写 #EXT-X-DISCONTINUITY，Chrome 原生 HLS 因此
     静默停止，既不报错也不恢复，只在 readyState=2 空转）。

用法：
  python hls_pts_check.py --scene 244 --base 300 --jump 340
  python hls_pts_check.py --scene 222 --base 300 --jump 340 --resolution ORIGINAL

输出：缓存目录里每段的首帧 PTS，并标出断裂点。
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stash_client import Stash  # noqa: E402
from hls_segment_probe import http_get, scene_oshash, reset_cache  # noqa: E402

FFPROBE_CANDIDATES = [
    r"C:\Users\k6cc\Downloads\Programs\ffmpeg-8.0.1-essentials_build\bin\ffprobe.exe",
    "ffprobe",
]


def find_ffprobe():
    for c in FFPROBE_CANDIDATES:
        if os.path.sep in c:
            if os.path.exists(c):
                return c
        else:
            if shutil.which(c):
                return c
    return None


def seg_pts(ffprobe, path):
    """取该段第一个视频帧的 pts_time（失败返回 None）。"""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "packet=pts_time", "-read_intervals", "%+#1",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        s = (out.stdout or "").strip().splitlines()
        if not s:
            return None
        m = re.search(r"-?\d+(?:\.\d+)?", s[0])   # csv 输出形如 "681.433333,"
        return float(m.group(0)) if m else None
    except Exception:
        return None


def seg_frames(ffprobe, path):
    """返回 (帧数, 首帧PTS, 末帧PTS)。可解码时长 = 末帧 - 首帧，
    比容器 duration 更能反映"浏览器到底能播出多少画面"。"""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=120)
        vals = []
        for line in (out.stdout or "").splitlines():
            m = re.search(r"-?\d+(?:\.\d+)?", line)
            if m:
                vals.append(float(m.group(0)))
        if not vals:
            return 0, None, None
        return len(vals), vals[0], vals[-1]
    except Exception:  # noqa: BLE001
        return 0, None, None


def seg_info(ffprobe, path):
    """返回 (首帧PTS, 时长, 错误输出)。错误输出非空 = ffprobe 报解码问题。"""
    pts = seg_pts(ffprobe, path)
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=60)
        dur_s = (out.stdout or "").strip().splitlines()
        m = re.search(r"-?\d+(?:\.\d+)?", dur_s[0]) if dur_s else None
        dur = float(m.group(0)) if m else None
        err = ((out.stderr or "").strip())[:300]
    except Exception as e:  # noqa: BLE001
        dur, err = None, "ffprobe 异常: %s" % e
    return pts, dur, err


def main():
    ap = argparse.ArgumentParser(description="HLS 分段 PTS 连续性检查")
    ap.add_argument("--scene", required=True)
    ap.add_argument("--base", type=int, default=300, help="先请求的段（冷启动点）")
    ap.add_argument("--spread", type=int, default=10, help="base 之后连续请求几段（同一进程产出）")
    ap.add_argument("--jump", type=int, default=340, help="跳跃到该段，强制服务端 stop+重启")
    ap.add_argument("--resolution", default="ORIGINAL")
    ap.add_argument("--cache-dir", default=r"E:\stashAPP\cache")
    args = ap.parse_args()

    ffprobe = find_ffprobe()
    if not ffprobe:
        print("找不到 ffprobe，无法检查 PTS")
        return 1

    stash = Stash()
    origin = stash.cfg["api_url"].rsplit("/graphql", 1)[0]
    tpl = "%s/scene/%s/stream.m3u8/%%d.ts?apikey=%s&resolution=%s" % (
        origin, args.scene, stash.cfg["api_key"], args.resolution)
    oshash, scene = scene_oshash(stash, args.scene)
    print("场景 #%s  oshash=%s  ffprobe=%s" % (args.scene, oshash, ffprobe))

    reset_cache(args.cache_dir, oshash, args.resolution)

    def cache_max():
        """当前缓存里已生成的最大段号（用于计算跳跃点）。"""
        for name in os.listdir(args.cache_dir):
            if name.startswith(oshash) and "_hls" in name:
                full = os.path.join(args.cache_dir, name)
                idx = [int(f.split(".")[0]) for f in os.listdir(full)
                       if f.endswith(".ts") and not f.startswith(".") and f.split(".")[0].isdigit()]
                return full, (max(idx) if idx else -1)
        return None, -1

    print("\n[1] 冷启动于段 #%d，并连续取 #%d~#%d（进程 A 产出）" % (
        args.base, args.base + 1, args.base + args.spread))
    for s in range(args.base, args.base + args.spread + 1):
        st, n, err = http_get(tpl % s, timeout=60)
        print("    段 #%-4d status=%s %8d 字节" % (s, st, n))
    time.sleep(1.0)
    _, M = cache_max()
    if M < 0:
        print("缓存为空，无法继续")
        return 1
    print("    进程 A 已产出到段 #%d" % M)

    # 跳跃 >5 段 → stopTranscode + 冷重启（进程 B），把 tp.segment 推到 M+6
    far = M + 6
    print("\n[2] 跳到段 #%d（>maxSegmentGap=5 → 服务端 stop + 冷重启为进程 B）" % far)
    for s in range(far, far + 3):
        t0 = time.time()
        st, n, err = http_get(tpl % s, timeout=60)
        print("    段 #%-4d status=%s %8d 字节  %.2fs" % (s, st, n, time.time() - t0))

    # 回退请求 M+1 → 段号 < tp.segment → 再次 stop + 冷重启（进程 C）
    # 于是段 #M（进程 A）与段 #M+1（进程 C）adjacent 且分属两个进程，
    # 正是真实播放中"重启点"的形态。
    print("\n[3] 回退请求段 #%d（< 进程 B 的 tp.segment → 再冷重启为进程 C）" % (M + 1))
    for s in range(M + 1, M + 4):
        t0 = time.time()
        st, n, err = http_get(tpl % s, timeout=60)
        print("    段 #%-4d status=%s %8d 字节  %.2fs" % (s, st, n, time.time() - t0))
    print("\n    → 段 #%d 来自进程 A，段 #%d 来自进程 C（即播放中的重启点）" % (M, M + 1))

    # ── ffprobe 全部已生成段 ──
    d = None
    for name in os.listdir(args.cache_dir):
        if name.startswith(oshash) and "_hls" in name:
            d = os.path.join(args.cache_dir, name)
            break
    if not d:
        print("\n缓存目录不存在，无法检查")
        return 1
    files = sorted((int(f.split(".")[0]), os.path.join(d, f))
                   for f in os.listdir(d)
                   if f.endswith(".ts") and not f.startswith(".") and f.split(".")[0].isdigit())
    print("\n[3] 逐段首帧 PTS（缓存目录 %s，共 %d 段）" % (os.path.basename(d), len(files)))
    print("    段号   首帧PTS     段号×2s   偏差")
    rows = []
    for idx, path in files:
        pts = seg_pts(ffprobe, path)
        rows.append((idx, pts))
        if pts is None:
            print("    %-6d (ffprobe 失败)" % idx)
            continue
        expect = idx * 2.0
        delta = pts - expect
        flag = ""
        if abs(delta) > 1.0:
            flag = "   ← 断裂（偏差 %.2fs）" % delta
        print("    %-6d %-11.3f %-9.1f %+.2f%s" % (idx, pts, expect, delta, flag))

    # 断裂点汇总
    breaks = []
    prev = None
    for idx, pts in rows:
        if pts is None:
            continue
        if prev is not None:
            gap = pts - prev[1]
            if abs(gap - 2.0) > 1.0:
                breaks.append((prev[0], idx, gap, pts))
        prev = (idx, pts)
    print("\n──────── 结论 ────────")
    if not breaks:
        print("  PTS 全程连续（相邻段间隔均 ≈2s），重启未造成时间戳断裂。")
    else:
        for a, b, gap, pts in breaks:
            print("  ⚠ 段 #%d → #%d 之间 PTS 断裂：间隔 %.3fs（正常应为 2.0s），"
                  "新段 PTS=%.3f" % (a, b, gap, pts))
        print("  → 服务端冷重启（-ss）产出的段时间戳与前一段不连续；"
              "Stash manifest 不写 #EXT-X-DISCONTINUITY，"
              "Chrome 原生 HLS 遇到该断裂会静默停在 readyState=2（无 error 事件、不恢复）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
