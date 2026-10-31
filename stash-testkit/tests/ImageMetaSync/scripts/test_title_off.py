# -*- coding: utf-8 -*-
"""关掉「Fill tags / title / code」后，两条路径是否都真的不写标题（对比设置语义）。

预期（按 yml 描述「OFF = 只写演员/工作室/日期」）：两条路径都不写 title。
    图库路径  → 应通过
    兜底路径  → 若仍写入，即与设置语义不符（title 回退成文件名）

    python test_title_off.py
"""
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
from stash_client import Stash  # noqa: E402

PLUGIN_ID = "ImageMetaSync"
TASK = "Sync Image Metadata"
SCENE_ID = "273"          # IMS-TEST-001 测试场景
GID = None                # 运行时按场景解析，避免图库重建后 id 失效
FALLBACK_IDS = ["936", "937"]
SETTINGS = {"fillTagsTitleCode": True, "fillUrlsDetails": False, "overwrite": False,
            "includeScenesWithoutGallery": False, "excludeTags": ""}


def gallery_of_scene(s):
    sc = s.call('query($id:ID!){findScene(id:$id){galleries{id}}}', {"id": SCENE_ID})["findScene"]
    return sc["galleries"][0]["id"] if sc and sc.get("galleries") else None


def cfg(s, **kw):
    p = dict(SETTINGS)
    p.update(kw)
    s.call("mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
           {"id": PLUGIN_ID, "input": p})


def titles(s, gid):
    imgs = s.call("""query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1})
                     {images{id title performers{id} code}}}""",
                  {"f": {"galleries": {"value": [gid], "modifier": "INCLUDES_ALL"}}})["findImages"]["images"]
    return [(i["id"], i.get("title") or "", i.get("code") or "", [p["id"] for p in i["performers"]])
            for i in sorted(imgs, key=lambda x: int(x["id"]))]


def main():
    global GID
    s = Stash()
    GID = gallery_of_scene(s)
    if not GID:
        raise SystemExit("场景 %s 没有图库，先跑 test_e2e_gallery.py full" % SCENE_ID)
    print("== 图库路径：fillTagsTitleCode=OFF（先清空该图库图片元数据）==")
    cfg(s, fillTagsTitleCode=False)
    imgs = s.call("""query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1}){images{id}}}""",
                  {"f": {"galleries": {"value": [GID], "modifier": "INCLUDES_ALL"}}})["findImages"]["images"]
    for i in imgs:
        s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
               {"i": {"id": i["id"], "title": "", "code": "", "date": "", "urls": [],
                      "performer_ids": [], "tag_ids": [], "studio_id": None}})
    path = os.path.join(r"E:\stashAPP\plugins\k6cc\ImageMetaSync\.ims_pending", GID + ".log")
    before = os.path.getsize(path) if os.path.exists(path) else 0
    s.call("mutation($i:GalleryUpdateInput!){galleryUpdate(input:$i){id}}", {"i": {"id": GID}})
    t0 = time.time()
    while time.time() - t0 < 60:
        if os.path.exists(path) and os.path.getsize(path) > before:
            time.sleep(3)
            break
        time.sleep(1)
    for t in titles(s, GID):
        print("   id=%-5s title=%r code=%r perf=%s" % t)

    print("\n== 兜底路径：fillTagsTitleCode=OFF（先清空 936/937）==")
    for iid in FALLBACK_IDS:
        s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
               {"i": {"id": iid, "title": "", "code": "", "date": "", "urls": [],
                      "performer_ids": [], "tag_ids": [], "studio_id": None}})
    cfg(s, fillTagsTitleCode=False, includeScenesWithoutGallery=True)
    since = s.call("{logs{time}}")["logs"][0]["time"]
    s.call("mutation($id:ID!,$name:String!){runPluginTask(plugin_id:$id,task_name:$name)}",
           {"id": PLUGIN_ID, "name": TASK})
    t0 = time.time()
    while time.time() - t0 < 200:
        for l in s.call("{logs{time}}").get("logs", []):
            pass
        if any("Batch fallback done" in l["message"] for l in s.call("{logs{time message}}")["logs"]
               if l["time"] > since):
            break
        time.sleep(3)
    q = ('query($id:ID!){findImage(id:$id){id title code performers{id}}}')
    for iid in FALLBACK_IDS:
        i = s.call(q, {"id": iid})["findImage"]
        print("   id=%-5s title=%r code=%r perf=%s" % (
            i["id"], i.get("title") or "", i.get("code") or "", [p["id"] for p in i["performers"]]))
    cfg(s)


if __name__ == "__main__":
    main()
