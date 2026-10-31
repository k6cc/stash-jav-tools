# -*- coding: utf-8 -*-
"""运行锁 + 变更队列的端到端验证（走真实钩子链路）。

按**数据**判定，不看日志：日志行只在 updated>0 时才有，且钩子代跑会把日志写进别的
gallery 的日志文件（见 NOTES.md），用日志断言会误报。

验证点：
 1) 已有进程持锁时，新钩子只登记队列、不动数据（先清空一张图的标题作观测点）
 2) 持锁进程被硬杀后，下一次钩子**立即**接替：数据被补上、队列被 drain（不等 900s）
 3) .ims_pending 过期清理覆盖 queue.jsonl / queue.jsonl.proc

    python test_lock_queue.py
"""
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
sys.path.insert(0, _HERE)
from stash_client import Stash  # noqa: E402
from _lock_helper import cleanup, hard_kill, spawn_holder  # noqa: E402

PLUGIN = r"E:\stashAPP\plugins\k6cc\ImageMetaSync"
PENDING = os.path.join(PLUGIN, ".ims_pending")
LOCK = os.path.join(PENDING, "run.lock")
QUEUE = os.path.join(PENDING, "queue.jsonl")
PROC = QUEUE + ".proc"
SCENE_ID = "273"

IMAGES_Q = """query($f: ImageFilterType){
  findImages(image_filter: $f, filter: {per_page: -1}){ images{ id title } } }"""


def gallery_of_scene(s):
    sc = s.call("query($id: ID!){ findScene(id: $id){ galleries{ id } } }", {"id": SCENE_ID})["findScene"]
    return sc["galleries"][0]["id"] if sc and sc.get("galleries") else None


def images(s, gid):
    f = {"galleries": {"value": [gid], "modifier": "INCLUDES_ALL"}}
    imgs = s.call(IMAGES_Q, {"f": f})["findImages"]["images"]
    return sorted(imgs, key=lambda x: int(x["id"]))


def set_title(s, iid, title):
    s.call("mutation($i: ImageUpdateInput!){ imageUpdate(input: $i){ id } }", {"i": {"id": iid, "title": title}})


def trigger(s, gid):
    s.call("mutation($i: GalleryUpdateInput!){ galleryUpdate(input: $i){ id } }", {"i": {"id": gid}})


def queue_ids():
    if not os.path.exists(QUEUE):
        return []
    with open(QUEUE, encoding="utf-8") as f:
        return [l.strip() for l in f if l.strip()]


def main():
    s = Stash()
    gid = gallery_of_scene(s)
    if not gid:
        raise SystemExit("场景 %s 没有图库，先跑 test_e2e_gallery.py full" % SCENE_ID)
    print("场景 %s 的图库：%s" % (SCENE_ID, gid))
    cleanup(PLUGIN)

    # 观测点：清空末图的标题，看「持锁时不动、接替后补上」
    imgs = images(s, gid)
    target = imgs[-1]["id"]
    set_title(s, target, "")
    print("观测图片 %s 的标题已清空（图库共 %d 张）" % (target, len(imgs)))

    # 1) 真实持锁进程占住锁，钩子应当只入队
    holder, line = spawn_holder(PLUGIN)
    print("\n1) 持锁进程：%s (pid=%s)" % (line, holder.pid))
    trigger(s, gid)
    time.sleep(15)
    queued = queue_ids()
    title_now = [i for i in images(s, gid) if i["id"] == target][0].get("title") or ""
    print("   queue.jsonl：%s" % (queued or "-"))
    print("   观测图标题：%r（预期仍为空）" % title_now)
    ok1 = any('"gallery_id": "%s"' % gid in q for q in queued) and not title_now.strip()

    # 2) 硬杀持锁进程（不给 finally 机会），再触发一次，应当立即接替并处理
    hard_kill(holder)
    print("\n2) 已硬杀持锁进程（run.lock 残留：%s），立即再触发钩子 …" % os.path.exists(LOCK))
    t0 = time.time()
    trigger(s, gid)
    filled_at = None
    for _ in range(30):
        time.sleep(1)
        cur = [i for i in images(s, gid) if i["id"] == target][0].get("title") or ""
        if cur.strip():
            filled_at = round(time.time() - t0, 1)
            break
    drained = False
    for _ in range(10):
        if not os.path.exists(QUEUE):
            drained = True
            break
        time.sleep(1)
    print("   观测图标题被补上用时：%s 秒，内容 %r" % (filled_at, cur.strip()))
    print("   队列已 drain：%s" % drained)
    ok2 = filled_at is not None and filled_at < 30 and drained

    # 3) 过期清理是否覆盖队列文件：造超龄 queue.jsonl + .proc，触发一次钩子
    with open(QUEUE, "w", encoding="utf-8") as f:
        f.write('{"gallery_id": "0"}\n')
    with open(PROC, "w", encoding="utf-8") as f:
        f.write('{"gallery_id": "0"}\n')
    old = time.time() - 7200
    for p in (QUEUE, PROC):
        os.utime(p, (old, old))
    print("\n3) 已把 queue.jsonl / .proc 的 mtime 调到 2 小时前，触发钩子验证清理 …")
    trigger(s, gid)
    time.sleep(15)
    proc_gone = not os.path.exists(PROC)
    print("   queue.jsonl.proc 被回收：%s" % proc_gone)
    ok3 = proc_gone and not any('"gallery_id": "0"' in q for q in queue_ids())

    cleanup(PLUGIN)
    print("\n--- 汇总 ---")
    for name, ok in (("持锁时只入队", ok1), ("硬杀后立即接替", ok2), ("过期队列被回收", ok3)):
        print("  %-12s %s" % (name, "PASS" if ok else "FAIL"))
    passed = ok1 and ok2 and ok3
    print("RESULT: %s" % ("PASS" if passed else "FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
