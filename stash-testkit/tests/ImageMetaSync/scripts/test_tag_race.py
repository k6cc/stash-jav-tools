"""ImageMetaSync 写 tags 与 tagMergeAuto / nfoSceneParser-jav 的竞态验证。

核心问题：ImageMetaSync 从 gallery.scenes[].tags 读 tag id，等待图库就绪后才写图片。
若这期间 tagMergeAuto 把该 tag 合并进 canonical tag（source 被删除），
imageUpdate 里带着已删除的 id 会怎样：整条失败 / 静默丢弃 / 自动替换？

用法（会建/删临时 tag，跑完自动清理）：
    python test_tag_race.py probe     # 单点行为验证
    python test_tag_race.py restore   # 手动清理残留
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from stash_client import Stash

GID = "95"          # 兜底值，实际按场景动态解析（图库可能被重建）
SCENE_ID = "273"
SRC = "IMS-RACE-SRC"
DST = "IMS-RACE-DST"


def gallery_of_scene(s):
    sc = s.call('query($id:ID!){findScene(id:$id){galleries{id image_count scenes{id}}}}', {"id": SCENE_ID})["findScene"]
    gs = sc.get("galleries") or []
    if not gs:
        raise SystemExit("场景 %s 没有关联图库" % SCENE_ID)
    return gs[0]["id"]


def tags_of_image(s, iid):
    d = s.call('query($id:ID!){findImage(id:$id){id title tags{id name}}}', {"id": iid})["findImage"]
    return d


def find_tag(s, name):
    d = s.call('query($n:String!){findTags(tag_filter:{name:{value:$n,modifier:EQUALS}}){tags{id name}}}',
               {"n": name})["findTags"]["tags"]
    return d[0] if d else None


def cleanup(s):
    for name in (SRC, DST):
        t = find_tag(s, name)
        if t:
            s.call('mutation($i:TagDestroyInput!){tagDestroy(input:$i)}', {"i": {"id": t["id"]}})
            print("  destroyed tag %s (%s)" % (name, t["id"]))


def probe(s):
    cleanup(s)
    gid = gallery_of_scene(s)
    print("0) 场景 %s 的图库 = %s" % (SCENE_ID, gid))
    # 1) 建两个临时 tag
    a = s.call('mutation($i:TagCreateInput!){tagCreate(input:$i){id name}}', {"i": {"name": SRC}})["tagCreate"]
    b = s.call('mutation($i:TagCreateInput!){tagCreate(input:$i){id name}}', {"i": {"name": DST}})["tagCreate"]
    print("1) 建 tag: SRC=%s DST=%s" % (a["id"], b["id"]))

    # 2) SRC 挂到场景上（模拟 nfoSceneParser 写完后的状态）
    sc = s.call('query($id:ID!){findScene(id:$id){id tags{id}}}', {"id": SCENE_ID})["findScene"]
    ids = [t["id"] for t in sc["tags"]]
    s.call('mutation($i:SceneUpdateInput!){sceneUpdate(input:$i){id}}',
           {"i": {"id": SCENE_ID, "tag_ids": ids + [a["id"]]}})
    print("2) 场景 %s tags: %s + SRC" % (SCENE_ID, ids))

    # 3) 模拟 ImageMetaSync 的读取（gallery.scenes[].tags 快照）
    g = s.call('query($id:ID!){findGallery(id:$id){id scenes{id tags{id name}}}}', {"id": gid})["findGallery"]
    snap = [t for sc2 in g["scenes"] for t in (sc2.get("tags") or [])]
    print("3) ImageMetaSync 读到 tags 快照: %s" % [(t["id"], t["name"]) for t in snap])
    snap_ids = [t["id"] for t in snap]

    # 4) tagMergeAuto 合并 SRC -> DST（SRC 被删除，Stash 会替换所有引用）
    m = s.call('mutation($i:TagsMergeInput!){tagsMerge(input:$i){id name aliases}}',
               {"i": {"source": [a["id"]], "destination": b["id"]}})["tagsMerge"]
    print("4) tagsMerge 后: %s aliases=%s" % (m["name"], m.get("aliases")))

    # 5) 用旧快照（含已删除的 SRC id）写图片，看 Stash 行为
    imgs = s.call('query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:2}){images{id title tags{id name}}}}',
                  {"f": {"galleries": {"value": [gid], "modifier": "INCLUDES_ALL"}}})["findImages"]["images"]
    if not imgs:
        print("!! 图库 %s 没有图片，跳过写入验证" % gid)
        return
    img = imgs[0]
    before = img
    print("5) 目标图片 %s 当前 tags=%s title=%r" % (img["id"], [t["name"] for t in img["tags"]], img["title"]))
    try:
        r = s.call('mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id title tags{id name}}}',
                   {"i": {"id": img["id"], "tag_ids": snap_ids, "title": "__RACE_PROBE__"}})
        after = r["imageUpdate"]
        print("   写入成功 -> title=%r tags=%s" % (after["title"], [t["name"] for t in after["tags"]]))
        verdict = []
        if after["title"] != "__RACE_PROBE__":
            verdict.append("title 未写入")
        names = [t["name"] for t in after["tags"]]
        if SRC in names:
            verdict.append("残留已删除的 SRC（悬空引用）")
        if DST in names and SRC not in names:
            verdict.append("Stash 自动替换为 DST")
        if not after["tags"]:
            verdict.append("tag 被静默丢弃（空）")
        print("   判定:", "；".join(verdict) or "其他")
    except Exception as e:
        print("   写入报错 -> %s" % str(e)[:300])
        still = tags_of_image(s, img["id"])
        print("   报错后图片实际状态: title=%r tags=%s" % (still["title"], [t["name"] for t in still["tags"]]))

    # 6) 还原图片
    s.call('mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}',
           {"i": {"id": img["id"], "title": before["title"],
                  "tag_ids": [t["id"] for t in before["tags"]]}})
    print("6) 图片已还原")


def restore(s):
    cleanup(s)
    sc = s.call('query($id:ID!){findScene(id:$id){id tags{id name}}}', {"id": SCENE_ID})["findScene"]
    keep = [t["id"] for t in sc["tags"] if not t["name"].startswith("IMS-RACE")]
    s.call('mutation($i:SceneUpdateInput!){sceneUpdate(input:$i){id}}',
           {"i": {"id": SCENE_ID, "tag_ids": keep}})
    print("场景 tags 已还原: %s" % keep)


if __name__ == "__main__":
    s = Stash()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if cmd == "restore":
        restore(s)
    else:
        probe(s)
