# -*- coding: utf-8 -*-
"""ImageMetaSync 端到端验证脚本（本地实例）。

用法（先 `python verify_image_meta_sync.py snapshot` 落基线）：
    snapshot                 落 image_state.json（全部图片 + 图库元数据）
    show [gallery_id]        打印当前状态（全部图片或某图库图片 + 元数据）
    clear <gallery_id>       清空该图库所有图片的 演员/工作室/日期/番号/tag/标题/简介/urls
    diff                     与基线快照逐图对比，打印差异（改动字段 + 新值）
    task [--with-fallback]   运行任务 "Sync Image Metadata"，等完成并打印本插件日志
    hook <gallery_id>        触发 Gallery.Update.Post 钩子，等后台日志 .ims_pending/<gid>.log
    pending <gallery_id>     打印该图库的后台进程日志

约束：GraphQL 一律走本脚本（勿在 PowerShell 内联）；后台日志在插件目录的 .ims_pending/。
"""
import argparse
import io
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), ".."))
from stash_client import Stash  # noqa: E402

STATE_FILE = os.path.join(_HERE, "image_state.json")
PENDING_DIR = r"E:\stashAPP\plugins\k6cc\ImageMetaSync\.ims_pending"
PLUGIN_ID = "ImageMetaSync"
TASK_NAME = "Sync Image Metadata"
RACE_DELAY = 3  # race 用例：建空图库后延迟挂图的秒数

IMAGE_FIELDS = """
  id title code details date urls rating100 organized
  performers { id }
  studio { id }
  tags { id }
  visual_files { ... on ImageFile { path } ... on VideoFile { path } }
"""
GALLERY_FIELDS = """
  id title image_count
  cover { id }
  scenes { id title performers { id } }
"""


def gql_images(s, gallery_id=None):
    """图库图片（galleries INCLUDES_ALL）；无 gallery_id 时全库分页。"""
    out = []
    page = 1
    while True:
        if gallery_id:
            q = """query($f: ImageFilterType, $ff: FindFilterType){
              findImages(image_filter: $f, filter: $ff) { count images { %s } }
            }""" % IMAGE_FIELDS
            f = {"galleries": {"value": [str(gallery_id)], "modifier": "INCLUDES_ALL"}}
        else:
            q = """query($ff: FindFilterType){ findImages(filter: $ff) { count images { %s } } }""" % IMAGE_FIELDS
            f = None
        r = s.call(q, {"f": f, "ff": {"page": page, "per_page": 200}})["findImages"]
        out.extend(r["images"])
        if page * 200 >= r["count"]:
            break
        page += 1
    return out


def gql_galleries(s):
    return s.call("{ findGalleries(filter:{per_page:200}) { count galleries { %s } } }" % GALLERY_FIELDS)["findGalleries"]["galleries"]


def norm(image):
    return {
        "title": image.get("title") or "",
        "code": image.get("code") or "",
        "details": image.get("details") or "",
        "date": image.get("date") or "",
        "urls": sorted(image.get("urls") or []),
        "performer_ids": sorted(p["id"] for p in image.get("performers") or []),
        "studio_id": (image.get("studio") or {}).get("id") or "",
        "tag_ids": sorted(t["id"] for t in image.get("tags") or []),
        "rating100": image.get("rating100"),
        "organized": bool(image.get("organized")),
        "path": ((image.get("visual_files") or [{}])[0] or {}).get("path") or "",
    }


def cmd_snapshot(s, args):
    images = gql_images(s)
    galleries = gql_galleries(s)
    data = {
        "galleries": galleries,
        "images": {i["id"]: norm(i) for i in images},
    }
    with io.open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print("snapshot: %d images, %d galleries -> %s" % (len(images), len(galleries), STATE_FILE))


def cmd_show(s, args):
    if args.gallery_id:
        images = gql_images(s, args.gallery_id)
        g = s.call("query($id: ID!){ findGallery(id:$id){ %s } }" % GALLERY_FIELDS,
                   {"id": str(args.gallery_id)})["findGallery"]
        print(json.dumps(g, ensure_ascii=False, indent=2))
        print("images: %d" % len(images))
    else:
        images = gql_images(s)
    for i in sorted(images, key=lambda x: x["id"]):
        n = norm(i)
        print("%-5s perf=%-10s studio=%-4s date=%-10s code=%-9s tags=%-3s title=%r" % (
            i["id"], ",".join(n["performer_ids"]) or "-", n["studio_id"] or "-",
            n["date"] or "-", n["code"] or "-", len(n["tag_ids"]), n["title"]))
        print("      path=%s" % os.path.basename(n["path"]))


def cmd_clear(s, args):
    images = gql_images(s, args.gallery_id)
    if not images:
        print("no images in gallery %s" % args.gallery_id)
        return
    for i in images:
        s.call("""mutation($i: ImageUpdateInput!){ imageUpdate(input:$i){ id } }""",
               {"i": {"id": i["id"], "title": "", "code": "", "details": "", "date": "",
                      "urls": [], "performer_ids": [], "tag_ids": [], "studio_id": None}})
    print("cleared %d image(s) in gallery %s" % (len(images), args.gallery_id))


def cmd_diff(s, args):
    with io.open(STATE_FILE, "r", encoding="utf-8") as f:
        base = json.load(f)["images"]
    cur = {i["id"]: norm(i) for i in gql_images(s)}
    changed = 0
    for iid in sorted(cur, key=lambda x: int(x)):
        old, new = base.get(iid), cur[iid]
        if old is None:
            print("%-5s NEW  %s" % (iid, new))
            changed += 1
            continue
        fields = [k for k in old if old[k] != new[k]]
        if fields:
            changed += 1
            print("%-5s" % iid)
            for k in fields:
                print("      %-14s %r -> %r" % (k, old[k], new[k]))
    print("---- %d/%d images differ from snapshot" % (changed, len(cur)))


def newest_log_time(s):
    r = s.call("{ logs { time } }")
    return r["logs"][0]["time"] if r["logs"] else ""


def log_lines_since(s, marker, since, timeout=180, interval=3):
    """轮询 Stash 日志（新→旧），返回 since 之后、含 marker 那一行为止的最新窗口。
    必须传 since（任务启动前的最新日志时间），否则会匹配到上一次运行留下的同名 marker。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        lines = [(l["time"], l["level"], l["message"])
                 for l in s.call("{ logs { time level message } }")["logs"] if l["time"] > since]
        for idx, (_t, _lv, msg) in enumerate(lines):  # 新→旧，正序第一个即最新
            if marker in msg:
                return lines[:idx + 1]
        time.sleep(interval)
    return []


def cmd_task(s, args):
    if args.with_fallback:
        s.call("""mutation($id: ID!, $input: Map!){ configurePlugin(plugin_id:$id, input:$input) }""",
               {"id": PLUGIN_ID, "input": {"includeScenesWithoutGallery": True}})
        print("plugin setting includeScenesWithoutGallery = true")
    since = newest_log_time(s)
    job = s.call("""mutation($id: ID!, $name: String!){ runPluginTask(plugin_id:$id, task_name:$name) }""",
                 {"id": PLUGIN_ID, "name": TASK_NAME})
    print("runPluginTask job=%s (since=%s)" % (job, since))
    marker = "Batch fallback done" if args.with_fallback else "Batch galleries done"
    lines = log_lines_since(s, marker, since, timeout=300)
    for t, lv, msg in reversed(lines):
        print("%s %-5s %s" % (t, lv, msg.strip()))
    if not lines:
        print("!! marker %r not found within timeout" % marker)
    if args.with_fallback:
        s.call("""mutation($id: ID!, $input: Map!){ configurePlugin(plugin_id:$id, input:$input) }""",
               {"id": PLUGIN_ID, "input": {"includeScenesWithoutGallery": False}})
        print("plugin setting includeScenesWithoutGallery restored to false")


def cmd_hook(s, args):
    gid = str(args.gallery_id)
    log_path = os.path.join(PENDING_DIR, "%s.log" % gid)
    before = os.path.getsize(log_path) if os.path.exists(log_path) else 0
    s.call("""mutation($i: GalleryUpdateInput!){ galleryUpdate(input:$i){ id } }""",
           {"i": {"id": gid, "title": s.call("query($id:ID!){findGallery(id:$id){title}}",
                                             {"id": gid})["findGallery"]["title"]}})
    print("galleryUpdate(%s) sent — waiting for detached process" % gid)
    t0 = time.time()
    while time.time() - t0 < 30:
        if os.path.exists(log_path) and os.path.getsize(log_path) > before:
            break
        time.sleep(1)
    if os.path.exists(log_path):
        with io.open(log_path, "r", encoding="utf-8") as f:
            print(f.read().strip() or "(empty)")
    else:
        print("!! no background log at %s" % log_path)


def cmd_race(s, args):
    """Gallery.Create.Post 竞态：先建空图库（钩子立刻触发），延迟后再挂图，
    验证插件会等图片挂载完成而不是只改到封面。"""
    scene_id = str(args.gallery_id)
    if not args.image_ids:
        print("!! need at least one image id")
        return
    since = newest_log_time(s)
    g = s.call("""mutation($i: GalleryCreateInput!){ galleryCreate(input:$i){ id title } }""",
               {"i": {"title": "IMS race test", "scene_ids": [scene_id]}})["galleryCreate"]
    gid = g["id"]
    print("created gallery %s (scene %s, 0 images) — Gallery.Create.Post fired, since=%s" % (gid, scene_id, since))
    time.sleep(RACE_DELAY)
    s.call("""mutation($i: GalleryAddInput!){ addGalleryImages(input:$i) }""",
           {"i": {"gallery_id": gid, "image_ids": [str(x) for x in args.image_ids]}})
    print("attached %d image(s) after %ss" % (len(args.image_ids), RACE_DELAY))
    log_path = os.path.join(PENDING_DIR, "%s.log" % gid)
    t0 = time.time()
    while time.time() - t0 < 40:
        if os.path.exists(log_path) and os.path.getsize(log_path) > 0:
            break
        time.sleep(1)
    if os.path.exists(log_path):
        with io.open(log_path, "r", encoding="utf-8") as f:
            print(f.read().strip())
    else:
        print("!! no background log at %s" % log_path)
    print("cleanup: python verify_image_meta_sync.py destroy %s" % gid)


def cmd_destroy(s, args):
    gid = str(args.gallery_id)
    r = s.call("""mutation($i: GalleryDestroyInput!){ galleryDestroy(input:$i) }""",
               {"i": {"ids": [gid], "delete_file": False, "delete_generated": False,
                      "destroy_file_entry": False}})
    print("galleryDestroy(%s) -> %s" % (gid, r["galleryDestroy"]))


def cmd_pending(s, args):
    gid = str(args.gallery_id)
    for name in (gid + ".log",):
        p = os.path.join(PENDING_DIR, name)
        print("=== %s ===" % p)
        if os.path.exists(p):
            with io.open(p, "r", encoding="utf-8") as f:
                print(f.read().strip())
        else:
            print("(missing)")
    print("=== run.lock ===")
    lock = os.path.join(PENDING_DIR, "run.lock")
    print("exists" if os.path.exists(lock) else "absent")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["snapshot", "show", "clear", "diff", "task", "hook",
                                    "pending", "race", "destroy"])
    ap.add_argument("gallery_id", nargs="?", help="clear/show/pending/hook/destroy 用；race 时表示 scene_id")
    ap.add_argument("image_ids", nargs="*", help="race 用：延迟挂载的 image id 列表")
    ap.add_argument("--with-fallback", action="store_true")
    args = ap.parse_args()
    s = Stash()
    {"snapshot": cmd_snapshot, "show": cmd_show, "clear": cmd_clear, "diff": cmd_diff,
     "task": cmd_task, "hook": cmd_hook, "pending": cmd_pending,
     "race": cmd_race, "destroy": cmd_destroy}[args.cmd](s, args)


if __name__ == "__main__":
    main()
