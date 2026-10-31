"""验证 tags 只同步到一半后能否自愈（模拟 nfoSceneParser 晚于 ImageMetaSync 写完 tags）。

核心：ImageMetaSync 只在 image.tags 为空（或 overwrite=ON）时才写 tag_ids。
若首次同步拿到的是场景的部分 tags，之后场景补上剩余 tags，图片不会跟进。

用法：
    python test_tag_partial.py run       # 完整实验（自动还原）
    python test_tag_partial.py show      # 只看当前状态
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from stash_client import Stash

SCENE_ID = "273"
TAG_A = "3P/4P"      # 场景现有 tag 122
TAG_B = "4K"         # 场景现有 tag 168


def scene(s):
    return s.call('query($id:ID!){findScene(id:$id){id title tags{id name} galleries{id}}}',
                  {"id": SCENE_ID})["findScene"]


def images(s, gid):
    return s.call('query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1})'
                  '{images{id title tags{id name}}}}',
                  {"f": {"galleries": {"value": [gid], "modifier": "INCLUDES_ALL"}}})["findImages"]["images"]


def trigger(s, gid):
    """galleryUpdate（值不变）触发 Gallery.Update.Post。"""
    t = s.call('query($id:ID!){findGallery(id:$id){title}}', {"id": gid})["findGallery"]["title"]
    s.call('mutation($i:GalleryUpdateInput!){galleryUpdate(input:$i){id}}', {"i": {"id": gid, "title": t}})


def set_scene_tags(s, ids):
    s.call('mutation($i:SceneUpdateInput!){sceneUpdate(input:$i){id}}',
           {"i": {"id": SCENE_ID, "tag_ids": ids}})


def clear_image_tags(s, imgs):
    for i in imgs:
        s.call('mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}',
               {"i": {"id": i["id"], "tag_ids": []}})


def dump(imgs, label):
    print("   %s" % label)
    for i in imgs:
        print("     img %-4s tags=%-22s %r" % (i["id"], ",".join(t["name"] for t in i["tags"]) or "-", i["title"]))


def run(s):
    sc = scene(s)
    gid = sc["galleries"][0]["id"]
    keep_tags = [t["id"] for t in sc["tags"]]
    tag_a = next((t for t in sc["tags"] if t["name"] == TAG_A), None)
    tag_b = next((t for t in sc["tags"] if t["name"] == TAG_B), None)
    if not (tag_a and tag_b):
        raise SystemExit("场景缺少 %s / %s，无法做该实验" % (TAG_A, TAG_B))
    imgs = images(s, gid)
    backup = {i["id"]: ([t["id"] for t in i["tags"]], i["title"]) for i in imgs}
    print("0) 图库 %s，%d 张图；场景 tags=%s" % (gid, len(imgs), [t["name"] for t in sc["tags"]]))

    try:
        # 阶段 1：场景只有 TAG_A（模拟 nfoSceneParser 只写了第一个 tag），图片 tags 清空
        set_scene_tags(s, [tag_a["id"]])
        clear_image_tags(s, imgs)
        print("\n1) 场景设为 [%s]，图片 tags 清空，触发钩子" % TAG_A)
        trigger(s, gid)
        time.sleep(35)
        imgs1 = images(s, gid)
        dump(imgs1, "第一次同步后：")
        first = {i["id"]: [t["name"] for t in i["tags"]] for i in imgs1}
        got_a = sum(1 for v in first.values() if v == [TAG_A])
        print("   -> %d/%d 张图 tags=[%s]" % (got_a, len(imgs1), TAG_A))

        # 阶段 2：场景补上 TAG_B（模拟 nfoSceneParser 后半段完成），再次触发
        set_scene_tags(s, [tag_a["id"], tag_b["id"]])
        print("\n2) 场景补上 tags -> [%s, %s]，再次触发钩子（overwrite=OFF）" % (TAG_A, TAG_B))
        trigger(s, gid)
        time.sleep(30)
        imgs2 = images(s, gid)
        dump(imgs2, "第二次同步后：")
        second = {i["id"]: [t["name"] for t in i["tags"]] for i in imgs2}
        healed = sum(1 for v in second.values() if set(v) == {TAG_A, TAG_B})
        print("   -> %d/%d 张图补上了 %s" % (healed, len(imgs2), TAG_B))
        print("\n判定: %s" % ("能自愈" if healed == len(imgs2)
                              else "不能自愈（overwrite=OFF 时图片已有 tags 就不再写）"))
    finally:
        set_scene_tags(s, keep_tags)
        for iid, (tids, title) in backup.items():
            s.call('mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}',
                   {"i": {"id": iid, "tag_ids": tids, "title": title}})
        print("\n已还原场景与图片")


if __name__ == "__main__":
    s = Stash()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "show":
        sc = scene(s)
        print("场景 tags:", [t["name"] for t in sc["tags"]])
        dump(images(s, sc["galleries"][0]["id"]), "图库图片：")
    else:
        run(s)
