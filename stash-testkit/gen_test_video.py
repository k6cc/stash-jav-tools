# -*- coding: utf-8 -*-
"""生成内容唯一的测试视频（供扫描入库验证）。

为什么内容必须唯一（关键）：
  Stash 按内容 hash（oshash）去重——复制/复用已有视频文件会让新文件被合并进已有场景，
  扫描表现为"空跑"（不建新场景）。本脚本用不同信号源/尺寸/帧率/时长生成每个视频，
  保证 oshash 互不相同。

用法：
  python gen_test_video.py --dir "E:/Temp/测试库/STA-122验证" --prefix TST- --count 3
（--dir 缺省读 config.json 的 test_dir；ffmpeg 路径读 config.json 的 ffmpeg_exe，可用环境变量 STASH_FFMPEG 覆盖）
"""
import argparse, json, os, subprocess, sys

def load_config():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def main():
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=cfg.get("test_dir", "."))
    ap.add_argument("--prefix", default="TST-")
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--ffmpeg", default=os.environ.get("STASH_FFMPEG", cfg.get("ffmpeg_exe", "ffmpeg")))
    args = ap.parse_args()

    # 每档信号源不同 → 内容唯一
    sources = [
        ["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-t", "30"],
        ["-f", "lavfi", "-i", "smptebars=size=1280x720:rate=25", "-t", "25"],
        ["-f", "lavfi", "-i", "testsrc=size=640x480:rate=24", "-t", "20"],
    ]
    names = ["%s%03d.mp4" % (args.prefix, i + 1) for i in range(args.count)]
    os.makedirs(args.dir, exist_ok=True)
    for i, name in enumerate(names):
        dst = os.path.join(args.dir, name)
        vf = sources[i % len(sources)]
        if os.path.exists(dst):
            print("exists:", name, os.path.getsize(dst), "bytes")
            continue
        cmd = [args.ffmpeg, "-y"] + vf + ["-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", dst]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            print("FAIL:", name, (p.stderr or p.stdout)[-400:])
            sys.exit(1)
        print("ok:", name, os.path.getsize(dst), "bytes")

if __name__ == "__main__":
    main()
