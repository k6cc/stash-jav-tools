# -*- coding: utf-8 -*-
"""sceneTranslateAuto v1.2.3 真实链路验证（按 stash-testkit README 推荐流程）：
生成内容唯一测试视频 + nfo → 增量扫描 → 场景入库触发 Scene.Create.Post hook → 入队(快照)
→ worker 延迟翻译 → 写回验证。

场景 A（假名占优日文 title+details）→ title+details 均被翻译成中文（验证优化2 逐 q 写回 + 全链路）
场景 B（汉字占优、含少量假名）→ 保持原样不被翻译（验证优化3 跳过侧真实行为）

用法：
  python real_chain_v123.py --dir "E:/Temp/测试库/STA-123" --prefix STA- [--timeout 200]
  --dir 须为实例已注册库的子目录（config.yml stashes，见 testkit README 已知坑 8）；
  插件须已部署且 hook 生效（实例重启后加载）。
注意：
  - 测试视频内容必须唯一：本脚本用自定义 lavfi 组合 + 随机时长，避免与 gen_test_video.py
    固定信号源重复（oshash 合并会"空跑"，见 testkit README 已知坑 1）
  - 增量扫描（不带 rescan:true，见已知坑 2）
  - 验证后手动清理：sceneDestroy 两个场景 → 删测试目录 → db_cleanup.py --prefix <前缀>
"""
import argparse, json, os, random, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

KANA_RE = ("\u3040", "\u30ff")

def has_kana(t):
    return any("\u3040" <= c <= "\u30ff" for c in (t or ""))

def load_cfg():
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config.json")
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    cfg = load_cfg()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="已注册库下的测试子目录（须在实例 config.yml stashes 内）")
    ap.add_argument("--prefix", default="STA-", help="文件/场景前缀（≥3 字符，db_cleanup 白名单用）")
    ap.add_argument("--timeout", type=int, default=200, help="翻译等待秒数")
    ap.add_argument("--ffmpeg", default=cfg.get("ffmpeg_exe", "ffmpeg"))
    args = ap.parse_args()
    if len(args.prefix) < 3:
        print("prefix 过短（<3 字符）"); sys.exit(1)

    os.makedirs(args.dir, exist_ok=True)
    # 场景 A：假名占优（title hanzi 4 < kana 6；details hanzi 8 < kana 11）
    # 场景 B：汉字占优（title hanzi 7 > kana 1；details hanzi 7 > kana 1）
    jobs = [
        ("%s001.mp4" % args.prefix, "testsrc2=size=1024x576:rate=30", random.randint(20, 24)),
        ("%s002.mp4" % args.prefix, "smptehdbars=size=960x540:rate=24", random.randint(16, 20)),
    ]
    for name, src, dur in jobs:
        dst = os.path.join(args.dir, name)
        if not os.path.exists(dst):
            cmd = [args.ffmpeg, "-y", "-f", "lavfi", "-i", src, "-t", str(dur),
                   "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", dst]
            p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            if p.returncode != 0:
                print("FAIL ffmpeg:", (p.stderr or p.stdout)[-300:]); sys.exit(1)
        print("video ok:", name)

    nfos = {
        "%s001.nfo" % args.prefix:
            '<movie><title>%s001 なまなかだし 温泉旅行</title>'
            '<plot>なまなかだしの物語。温泉で美少女のシーンが続く。</plot>'
            '<num>%s001</num></movie>' % (args.prefix, args.prefix),
        "%s002.nfo" % args.prefix:
            '<movie><title>%s002 美少女 と温泉旅行</title>'
            '<plot>美少女温泉旅行の記録。</plot>'
            '<num>%s002</num></movie>' % (args.prefix, args.prefix),
    }
    for name, body in nfos.items():
        with open(os.path.join(args.dir, name), "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n")

    s = Stash()
    s.trigger_scan(paths=[args.dir.replace("\\", "/")])
    print("scan triggered")

    t0 = time.time()
    scenes = []
    while time.time() - t0 < 120:
        scenes = s.find_scenes(q=args.prefix)
        if len(scenes) >= 2:
            break
        time.sleep(5)
    if len(scenes) < 2:
        print("FAIL: expected 2 scenes, found %d (oshash merge? nfo parse?)" % len(scenes))
        for x in scenes:
            print("  id=%s title=%r" % (x["id"], (x.get("title") or "")[:50]))
        sys.exit(1)
    by_title = {x["title"]: x for x in scenes}
    a = by_title.get("%s001 なまなかだし 温泉旅行" % args.prefix)
    b = by_title.get("%s002 美少女 と温泉旅行" % args.prefix)
    if not a or not b:
        print("FAIL: nfo titles not applied; found:", [x["title"] for x in scenes])
        sys.exit(1)
    print("scenes: A=%s B=%s" % (a["id"], b["id"]))

    t0 = time.time()
    ok = False
    while time.time() - t0 < args.timeout:
        sa = s.find_scene(a["id"])
        sb = s.find_scene(b["id"])
        if (sa and sb and not has_kana(sa.get("title")) and not has_kana(sa.get("details"))
                and has_kana(sb.get("title"))):
            ok = True
            break
        time.sleep(8)
    sa = s.find_scene(a["id"])
    sb = s.find_scene(b["id"])
    print("A(%s) title:   %r" % (a["id"], (sa.get("title") or "")[:70]))
    print("A(%s) details: %r" % (a["id"], (sa.get("details") or "")[:70]))
    print("B(%s) title:   %r" % (b["id"], (sb.get("title") or "")[:70]))
    print("B(%s) details: %r" % (b["id"], (sb.get("details") or "")[:70]))
    print("RESULT A translated both fields:", ok)
    print("cleanup: sceneDestroy %s %s -> 删 %s -> db_cleanup.py --prefix %s"
          % (a["id"], b["id"], args.dir, args.prefix))
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
