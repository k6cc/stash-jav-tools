# -*- coding: utf-8 -*-
"""无图库场景兜底路径验证：清空 CAWD-762 两张图的元数据，跑兜底批量，看是否重填。

    python test_fallback_no_gallery.py clear   # 清空该场景封面/fanart 元数据
    python test_fallback_no_gallery.py run     # includeScenesWithoutGallery=true 跑批量（结束还原）
    python test_fallback_no_gallery.py dir     # 只打印插件目录过滤的实际返回（诊断用）
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
from stash_client import Stash  # noqa: E402

PLUGIN_ID = "ImageMetaSync"
TASK = "Sync Image Metadata"
SCENE_DIR = r"E:\Temp\测试库"
TARGET_IDS = ["936", "937"]   # CAWD-762-UC-poster.jpg / -fanart.jpg（场景 250 无图库）

SETTINGS = {"fillTagsTitleCode": True, "fillUrlsDetails": False, "overwrite": False,
            "includeScenesWithoutGallery": False, "excludeTags": ""}


def cfg(s, **kw):
    p = dict(SETTINGS)
    p.update(kw)
    s.call("mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
           {"id": PLUGIN_ID, "input": p})


def dump(s):
    q = ('query($id:ID!){findImage(id:$id){id title code date performers{id} studio{id} '
         'visual_files{...on ImageFile{path}}}}')
    for iid in TARGET_IDS:
        i = s.call(q, {"id": iid})["findImage"]
        print("  %s %-22s perf=%-6s studio=%-4s date=%-11s code=%-11s title=%r" % (
            i["id"], os.path.basename(((i["visual_files"] or [{}])[0] or {}).get("path") or ""),
            ",".join(p["id"] for p in i["performers"]) or "-", (i.get("studio") or {}).get("id") or "-",
            i.get("date") or "-", i.get("code") or "-", i.get("title") or ""))


def cmd_dir(s):
    for val in (SCENE_DIR, SCENE_DIR.replace("\\", "/"), "测试库", "CAWD-762"):
        d = s.call('query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1}){count}}',
                   {"f": {"path": {"value": val, "modifier": "INCLUDES"}}})
        print("  path INCLUDES %-28r -> %d" % (val, d["findImages"]["count"]))


def cmd_clear(s):
    for iid in TARGET_IDS:
        s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
               {"i": {"id": iid, "title": "", "code": "", "date": "", "details": "",
                      "urls": [], "performer_ids": [], "tag_ids": [], "studio_id": None}})
    print("已清空：")
    dump(s)


def cmd_run(s):
    since = s.call("{logs{time}}")["logs"][0]["time"]
    cfg(s, includeScenesWithoutGallery=True)
    s.call("mutation($id:ID!,$name:String!){runPluginTask(plugin_id:$id,task_name:$name)}",
           {"id": PLUGIN_ID, "name": TASK})
    done = None
    t0 = time.time()
    while time.time() - t0 < 200:
        for l in s.call("{logs{time message}}")["logs"]:
            if l["time"] > since and "Batch fallback done" in l["message"]:
                done = l["message"]
        if done:
            break
        time.sleep(3)
    print("批量结果：%s" % done)
    cfg(s)
    print("结果图：")
    dump(s)


if __name__ == "__main__":
    s = Stash()
    {"clear": cmd_clear, "run": cmd_run, "dir": cmd_dir}[sys.argv[1]](s)
