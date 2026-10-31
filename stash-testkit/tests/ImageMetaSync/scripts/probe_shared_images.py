# -*- coding: utf-8 -*-
"""列场景与「未入图库」图片，为 E2E 选场景/图片。只读。"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from stash_client import Stash

s = Stash()
sc = s.call("{findScenes(filter:{per_page:-1}){count scenes{id title studio{id} performers{id} "
            "galleries{id} files{path}}}}")["findScenes"]
print("scenes %d" % sc["count"])
for x in sc["scenes"]:
    print("%-4s perf=%-14s gal=%-8s %-32s %s" % (
        x["id"], [p["id"] for p in x["performers"]], [g["id"] for g in x["galleries"]],
        (x["title"] or "")[:32], [os.path.basename(f["path"]) for f in x["files"]]))

imgs = s.call("{findImages(filter:{per_page:-1}){images{id title galleries{id} performers{id} "
              "visual_files{...on ImageFile{path}...on VideoFile{path}}}}}")["findImages"]["images"]
print("\n--- 未入图库的图片 ---")
for i in imgs:
    if not i["galleries"]:
        print(i["id"], i["title"] or "-", [x["id"] for x in i["performers"]],
              ((i["visual_files"] or [{}])[0] or {}).get("path"))
