# -*- coding: utf-8 -*-
"""ImageMetaSync 受控 E2E：一个图库覆盖 默认填充 / urls 开关 / 排除 tag / overwrite / 多演员跳过。

前置：E:\\Temp\\测试库\\IMS-TEST-001 已扫描入库（视频 + 6 张图，文件名特意含冲突号）。

    python test_e2e_gallery.py full      # 跑全部阶段并汇总 PASS/FAIL（会改插件设置，结束自动还原）
    python test_e2e_gallery.py setup     # 只建图库（延迟挂图，测竞态等待）
    python test_e2e_gallery.py check      # 只核对当前状态与 oracle
    python test_e2e_gallery.py reset      # 清空该图库图片元数据
    python test_e2e_gallery.py hook       # 触发 Gallery.Update.Post 并等后台日志
    python test_e2e_gallery.py skip       # 场景加第二个演员 → 跑批量任务 → 验证整库跳过
    python test_e2e_gallery.py cleanup    # 删图库（不动文件）

口径来源：README「写入字段与来源」「标题编号」「跳过规则」。
"""
import json
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
from stash_client import Stash  # noqa: E402

PLUGIN_ID = "ImageMetaSync"
TASK = "Sync Image Metadata"
PENDING = r"E:\stashAPP\plugins\k6cc\ImageMetaSync\.ims_pending"
DIR = r"E:\Temp\测试库\IMS-TEST-001"
SCENE_TITLE = "IMS-TEST-001 测试场景"
GALLERY_TITLE = "IMS TEST 001 GALLERY"
SCENE_URL = "https://example.com/ims"
SCENE_DETAILS = "IMS 详情测试"
TAG_A, TAG_B = "122", "168"          # 3P/4P, 4K
TAG_A_NAME = "3P/4P"
PERFORMER, STUDIO, DATE, CODE = "1", "67", "2026-10-01", "IMS-TEST-001"
RACE_DELAY = 3

DEFAULTS = {"fillTagsTitleCode": True, "fillUrlsDetails": False, "overwrite": False,
            "includeScenesWithoutGallery": False, "excludeTags": ""}

IMAGE_FIELDS = ("id title code details date urls performers{id} studio{id} tags{id} "
                "visual_files{...on ImageFile{path}...on VideoFile{path}}")


# ────────────────────────── 基础设施 ──────────────────────────
def cfg(s, **kw):
    payload = dict(DEFAULTS)
    payload.update(kw)
    s.call("mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
           {"id": PLUGIN_ID, "input": payload})
    return payload


def find_scene(s):
    rows = s.call('{findScenes(filter:{per_page:-1,sort:"path"}){scenes{id title performers{id} '
                  'files{path}}}}')["findScenes"]["scenes"]
    for x in rows:
        for f in x["files"]:
            if os.path.basename(f["path"]).startswith("IMS-TEST-001"):
                return x
    return None


def images_in_dir(s):
    """ImageFilterType.path 的 INCLUDES 只匹配目录名 basename，传绝对路径恒 0，故本地过滤。"""
    dir_norm = DIR.replace("\\", "/").lower().rstrip("/") + "/"
    imgs = s.call("query{findImages(filter:{per_page:-1}){images{%s}}}" % IMAGE_FIELDS)["findImages"]["images"]
    out = [i for i in imgs
           if ((((i.get("visual_files") or [{}])[0] or {}).get("path") or "").replace("\\", "/").lower()
               .startswith(dir_norm))]
    return sorted(out, key=lambda i: ((i.get("visual_files") or [{}])[0] or {}).get("path") or "")


def find_gallery(s, scene_id):
    gs = s.call("{findGalleries(filter:{per_page:-1}){galleries{id title cover{id} image_count "
                "scenes{id}}}}")["findGalleries"]["galleries"]
    for g in gs:
        if any(sc["id"] == scene_id for sc in g["scenes"]):
            return g
    return None


def reset_images(s, imgs):
    for i in imgs:
        s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
               {"i": {"id": i["id"], "title": "", "code": "", "details": "", "date": "",
                      "urls": [], "performer_ids": [], "tag_ids": [], "studio_id": None}})


def wait_log(gid, timeout=90):
    path = os.path.join(PENDING, "%s.log" % gid)
    t0 = time.time()
    while time.time() - t0 < timeout:
        if os.path.exists(path) and os.path.getsize(path) > 0:
            size = -1
            while os.path.getsize(path) != size:
                size = os.path.getsize(path)
                time.sleep(2)
            return open(path, encoding="utf-8").read().strip()
        time.sleep(2)
    return "(超时无日志)"


def clear_pending():
    """清掉上次运行残留的锁与队列：持锁进程会把新事件只登记入队由自己代跑，
    新事件就不会写自己的日志文件，导致本脚本误判「钩子没跑」。"""
    removed = []
    for name in ("run.lock", "queue.jsonl", "queue.jsonl.proc"):
        p = os.path.join(PENDING, name)
        if os.path.exists(p):
            try:
                os.unlink(p)
                removed.append(name)
            except OSError:
                pass
    if removed:
        print("清理残留：%s" % removed)


def wait_synced(s, timeout=90):
    """只按数据判定建库钩子是否生效：事件可能被持锁进程代跑，日志会落到别的文件里。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        imgs = images_in_dir(s)
        if len(imgs) >= 6 and all(
                [p["id"] for p in i.get("performers") or []] == [PERFORMER]
                and sorted(t["id"] for t in i.get("tags") or []) == sorted([TAG_A, TAG_B])
                and i.get("title") for i in imgs[:6]):
            return True, int(time.time() - t0)
        time.sleep(3)
    return False, timeout


def trigger_hook(s, gid, fresh=True):
    """galleryUpdate 触发 Gallery.Update.Post；fresh=True 时先清空该图库图片元数据。"""
    if fresh:
        reset_images(s, images_in_dir(s))
    path = os.path.join(PENDING, "%s.log" % gid)
    before = os.path.getsize(path) if os.path.exists(path) else 0
    s.call("mutation($i:GalleryUpdateInput!){galleryUpdate(input:$i){id}}", {"i": {"id": gid}})
    t0 = time.time()
    while time.time() - t0 < 60:
        if os.path.exists(path) and os.path.getsize(path) > before:
            time.sleep(3)
            break
        time.sleep(1)
    log = open(path, encoding="utf-8").read().strip() if os.path.exists(path) else ""
    return log.splitlines()[-1] if log else "(无日志)"


# ────────────────────────── oracle ──────────────────────────
def first_path(i):
    return ((i.get("visual_files") or [{}])[0] or {}).get("path") or ""


def oracle_titles(imgs, cover_id, base):
    """空状态下的应有标题：封面纯标题；其余「基标题 #N」，N 优先文件尾号，冲突/无尾号顺延。"""
    used, out = set(), {}
    if not base:
        return out
    if cover_id:
        out[cover_id] = base
    numbered, plain = [], []
    for i in sorted(imgs, key=first_path):
        if i["id"] == cover_id:
            continue
        m = re.search(r'(\d+)$', os.path.splitext(os.path.basename(first_path(i)))[0])
        (numbered if m else plain).append((int(m.group(1)) if m else None, i))
    numbered.sort(key=lambda t: t[0])
    for n, i in numbered + plain:
        if n is None:
            n = 1
        while n in used:
            n += 1
        used.add(n)
        out[i["id"]] = "%s #%d" % (base, n)
    return out


# ────────────────────────── 阶段 ──────────────────────────
def stage_setup(s):
    sc = find_scene(s)
    if not sc:
        return None, ["找不到 IMS-TEST-001 场景，先扫描测试目录"]
    sid = sc["id"]
    s.update_scene(sid, {"title": SCENE_TITLE, "performer_ids": [PERFORMER], "studio_id": STUDIO,
                         "date": DATE, "code": CODE, "urls": [SCENE_URL],
                         "details": SCENE_DETAILS, "tag_ids": [TAG_A, TAG_B]})
    imgs = images_in_dir(s)
    if len(imgs) < 6:
        return None, ["目录内图片 %d 张，不足 6，先扫描" % len(imgs)]

    g = find_gallery(s, sid)
    if g:
        print("图库已存在 %s，复用（不测竞态）" % g["id"])
        gid = g["id"]
    else:
        reset_images(s, imgs)          # 先清空，确保元数据只能由建库钩子填入
        g = s.call("mutation($i:GalleryCreateInput!){galleryCreate(input:$i){id}}",
                   {"i": {"title": GALLERY_TITLE, "scene_ids": [sid]}})["galleryCreate"]
        gid = g["id"]
        print("建图库 %s（0 张图），%ss 后挂图 → 测竞态等待" % (gid, RACE_DELAY))
        time.sleep(RACE_DELAY)
        s.call("mutation($i:GalleryAddInput!){addGalleryImages(input:$i)}",
               {"i": {"gallery_id": gid, "image_ids": [i["id"] for i in imgs]}})
        print("已挂 %d 张图" % len(imgs))

    ready, waited = wait_synced(s, 90)
    log = wait_log(gid, timeout=5)
    print("--- 建库钩子后台日志（%ds%s）---\n%s"
          % (waited, "内完成" if ready else " 仍未完成", log))
    fails = []
    if not ready:
        fails.append("建库钩子未在 90s 内写入图片元数据")
    g = find_gallery(s, sid)
    if not g.get("cover"):
        fails.append("图库无封面（编号方案 A 分支未覆盖）")
    return {"gid": gid, "sid": sid}, fails


def check(s, cover_id, base, expect_tags, expect_urls, expect_details):
    imgs = images_in_dir(s)
    want = oracle_titles(imgs, cover_id, base)
    fails = []
    for i in imgs:
        name = os.path.basename(first_path(i))
        t = i.get("title") or ""
        print("  %-5s %-26s perf=%-4s studio=%-4s date=%-11s tags=%-8s urls=%-2d %r" % (
            i["id"], name, ",".join(p["id"] for p in i["performers"]) or "-",
            (i.get("studio") or {}).get("id") or "-", i.get("date") or "-",
            sorted(t2["id"] for t2 in i.get("tags") or []), len(i.get("urls") or []), t))
        if want.get(i["id"]) and t != want[i["id"]]:
            fails.append("标题 %s：应为 %r，实际 %r" % (name, want[i["id"]], t))
        if [p["id"] for p in i["performers"]] != [PERFORMER]:
            fails.append("%s 演员 %s ≠ [%s]" % (name, [p["id"] for p in i["performers"]], PERFORMER))
        if (i.get("studio") or {}).get("id") != STUDIO:
            fails.append("%s studio ≠ %s" % (name, STUDIO))
        if i.get("date") != DATE:
            fails.append("%s date=%r" % (name, i.get("date")))
        if i.get("code") != CODE:
            fails.append("%s code=%r" % (name, i.get("code")))
        if sorted(t2["id"] for t2 in i.get("tags") or []) != sorted(expect_tags):
            fails.append("%s tags=%s，应为 %s" % (name, sorted(t2["id"] for t2 in i.get("tags") or []),
                                                 sorted(expect_tags)))
        if expect_urls is not None and (i.get("urls") or []) != expect_urls:
            fails.append("%s urls=%s，应为 %s" % (name, i.get("urls"), expect_urls))
        if expect_details is not None and (i.get("details") or "") != expect_details:
            fails.append("%s details=%r" % (name, i.get("details")))
    nums = {}
    for i in imgs:
        m = re.match(r'^' + re.escape(base) + r' #(\d+)$', i.get("title") or "")
        if m:
            nums.setdefault(int(m.group(1)), []).append(i["id"])
    for n, ids in nums.items():
        if len(ids) > 1:
            fails.append("编号 #%d 重复 %s" % (n, ids))
    return fails


def stage_default(s, ctx, base_title):
    cfg(s)
    log = trigger_hook(s, ctx["gid"])
    print("--- 默认设置（tags/title ON, urls OFF）后台日志：%s" % log)
    imgs = images_in_dir(s)
    g = find_gallery(s, ctx["sid"])
    fails = check(s, (g.get("cover") or {}).get("id"), base_title,
                  expect_tags=[TAG_A, TAG_B], expect_urls=[], expect_details="")
    return fails


def stage_urls(s, ctx, base_title):
    cfg(s, fillUrlsDetails=True)
    log = trigger_hook(s, ctx["gid"])
    print("--- fillUrlsDetails=ON 后台日志：%s" % log)
    g = find_gallery(s, ctx["sid"])
    imgs = images_in_dir(s)
    fails = []
    for i in imgs:
        if (i.get("urls") or []) != [SCENE_URL]:
            fails.append("%s urls=%s 未写入" % (i["id"], i.get("urls")))
        if (i.get("details") or "") != SCENE_DETAILS:
            fails.append("%s details=%r 未写入" % (i["id"], i.get("details")))
    cfg(s)
    return fails


def stage_exclude(s, ctx, base_title):
    cfg(s, excludeTags=TAG_A_NAME)
    log = trigger_hook(s, ctx["gid"])
    print("--- excludeTags=%r 后台日志：%s" % (TAG_A_NAME, log))
    imgs = images_in_dir(s)
    fails = []
    for i in imgs:
        got = sorted(t["id"] for t in i.get("tags") or [])
        if got != [TAG_B]:
            fails.append("%s tags=%s，应只剩 [%s]" % (i["id"], got, TAG_B))
    cfg(s)
    return fails


def stage_overwrite(s, ctx, base_title):
    imgs = images_in_dir(s)
    custom = imgs[1]["id"]
    s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
           {"i": {"id": custom, "title": "手工标题"}})
    cfg(s, overwrite=False)
    log = trigger_hook(s, ctx["gid"], fresh=False)
    cur = [i for i in images_in_dir(s) if i["id"] == custom][0]
    fails = []
    if (cur.get("title") or "") != "手工标题":
        fails.append("overwrite=OFF 时手工标题被改：%r" % cur.get("title"))
    cfg(s, overwrite=True)
    log2 = trigger_hook(s, ctx["gid"], fresh=False)
    cur = [i for i in images_in_dir(s) if i["id"] == custom][0]
    want = oracle_titles(imgs, (find_gallery(s, ctx["sid"]).get("cover") or {}).get("id"), base_title)
    if (cur.get("title") or "") != want.get(custom):
        fails.append("overwrite=ON 时未覆盖为 %r，实际 %r" % (want.get(custom), cur.get("title")))
    cfg(s)
    print("--- overwrite OFF/ON 后台日志：%s / %s" % (log, log2))
    return fails


def stage_skip(s, ctx):
    s.update_scene(ctx["sid"], {"performer_ids": [PERFORMER, "2"]})
    before = {i["id"]: i.get("title") for i in images_in_dir(s)}
    since = s.call("{logs{time}}")["logs"][0]["time"]
    s.call("mutation($id:ID!,$name:String!){runPluginTask(plugin_id:$id,task_name:$name)}",
           {"id": PLUGIN_ID, "name": TASK})
    log_line, skip_line = None, None
    t0 = time.time()
    while time.time() - t0 < 180:
        for l in s.call("{logs{time message}}")["logs"]:
            if l["time"] <= since:
                continue
            if "Batch galleries done" in l["message"]:
                log_line = l["message"]
            if "performer(s)" in l["message"] and "skipped" in l["message"]:
                skip_line = l["message"]
        if log_line and skip_line:
            break
        time.sleep(3)
    s.update_scene(ctx["sid"], {"performer_ids": [PERFORMER]})
    print("--- 批量：%s" % log_line)
    print("--- 跳过日志：%s" % skip_line)
    fails = []
    if not skip_line:
        fails.append("多演员场景没有明显的跳过日志")
    after = {i["id"]: i.get("title") for i in images_in_dir(s)}
    if before != after:
        fails.append("跳过模式下标题被改动")
    return fails


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "full"
    s = Stash()
    sc = find_scene(s)
    if not sc:
        print("!! 无 IMS-TEST-001 场景")
        return
    g = find_gallery(s, sc["id"])
    ctx = {"sid": sc["id"], "gid": g["id"] if g else None}
    base_title = SCENE_TITLE

    if cmd == "setup":
        clear_pending()
        ctx, fails = stage_setup(s)
        print("\nsetup fails: %s" % fails)
    elif cmd == "check":
        g = find_gallery(s, ctx["sid"])
        print("fails: %s" % check(s, (g.get("cover") or {}).get("id"), base_title,
                                  [TAG_A, TAG_B], None, None))
    elif cmd == "reset":
        reset_images(s, images_in_dir(s))
        print("已清空")
    elif cmd == "hook":
        print(trigger_hook(s, ctx["gid"]))
    elif cmd == "skip":
        print("skip fails: %s" % stage_skip(s, ctx))
    elif cmd == "cleanup":
        if ctx["gid"]:
            s.call("mutation($i:GalleryDestroyInput!){galleryDestroy(input:$i)}",
                   {"i": {"ids": [ctx["gid"]], "delete_file": False, "delete_generated": False,
                          "destroy_file_entry": False}})
            print("已删图库 %s" % ctx["gid"])
    else:  # full
        results = []
        clear_pending()
        if ctx["gid"]:  # 每次都从干净图库开始，保证竞态用例真实
            s.call("mutation($i:GalleryDestroyInput!){galleryDestroy(input:$i)}",
                   {"i": {"ids": [ctx["gid"]], "delete_file": False, "delete_generated": False,
                          "destroy_file_entry": False}})
            print("清理旧图库 %s" % ctx["gid"])
            ctx["gid"] = None
        ctx, fails = stage_setup(s)
        results.append(("建库 + 竞态等待 + 首次回填", fails))
        if ctx:
            results.append(("默认设置全字段", stage_default(s, ctx, base_title)))
            results.append(("fillUrlsDetails=ON", stage_urls(s, ctx, base_title)))
            results.append(("excludeTags", stage_exclude(s, ctx, base_title)))
            results.append(("overwrite OFF/ON", stage_overwrite(s, ctx, base_title)))
            results.append(("多演员整库跳过", stage_skip(s, ctx)))
        print("\n===== 汇总 =====")
        for name, f in results:
            print("%-24s %s" % (name, "PASS" if not f else "FAIL"))
            for x in f[:8]:
                print("    - " + x)


if __name__ == "__main__":
    main()
