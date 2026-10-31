# -*- coding: utf-8 -*-
"""运行锁 + 变更队列的竞态验证（只操作插件目录里的锁/队列文件，不改数据库）。

验证点：
 1) 有锁时新钩子只登记队列不处理（日志 "another run in progress, queued"）
 2) 手工占的假锁不消费队列：删锁后队列不会自己跑，要等下一次钩子才被 drain
    （这是测试构造，不是产品缺陷；插件内部收尾窗口的补偿逻辑从外部构造不出来）
 3) .ims_pending 过期清理覆盖 queue.jsonl / queue.jsonl.proc

    python test_lock_queue.py
"""
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
from stash_client import Stash  # noqa: E402

PENDING = r"E:\stashAPP\plugins\k6cc\ImageMetaSync\.ims_pending"
LOCK = os.path.join(PENDING, "run.lock")
QUEUE = os.path.join(PENDING, "queue.jsonl")
PROC = QUEUE + ".proc"


def logs(s, since):
    return [l for l in s.call("{logs{time message}}")["logs"] if l["time"] > since]


def trigger(s, gid):
    s.call("mutation($i:GalleryUpdateInput!){galleryUpdate(input:$i){id}}", {"i": {"id": gid}})


def main():
    s = Stash()
    gid = "95"
    for p in (LOCK, QUEUE, PROC):
        if os.path.exists(p):
            os.unlink(p)
            print("清理残留 %s" % os.path.basename(p))

    # 1) 手动持锁，模拟「已有进程在跑」
    with open(LOCK, "w", encoding="utf-8") as f:
        f.write('{"pid": 0, "t": 0}')
    print("已占锁 run.lock")
    since = s.call("{logs{time}}")["logs"][0]["time"]
    trigger(s, gid)
    time.sleep(15)
    lines = [l["message"] for l in logs(s, since) if "ImageMetaSync" in l["message"]]
    print("--- 有锁时的钩子日志 ---")
    for m in lines:
        print("   " + m.strip())
    queued = os.path.exists(QUEUE)
    print("queue.jsonl 存在：%s，内容：%s" % (
        queued, open(QUEUE, encoding="utf-8").read().strip() if queued else "-"))

    # 2) 释放锁（模拟持锁进程退出），不再触发任何事件，观察队列是否被处理
    os.unlink(LOCK)
    print("已删锁，等待 40s 观察队列是否被处理（假锁不消费队列，预期无日志）…")
    since2 = s.call("{logs{time}}")["logs"][0]["time"]
    time.sleep(40)
    lines2 = [l["message"] for l in logs(s, since2) if "ImageMetaSync" in l["message"]]
    print("--- 删锁后 40s 内插件日志 %d 行 ---" % len(lines2))
    for m in lines2:
        print("   " + m.strip())
    still = os.path.exists(QUEUE)
    print("queue.jsonl 仍在：%s" % still)

    # 3) 过期清理是否覆盖队列文件：造超龄 queue.jsonl + .proc，占假锁触发一次钩子
    with open(QUEUE, "w", encoding="utf-8") as f:
        f.write('{"gallery_id": "0"}\n')
    with open(PROC, "w", encoding="utf-8") as f:
        f.write('{"gallery_id": "0"}\n')
    old = time.time() - 7200
    for p in (QUEUE, PROC):
        os.utime(p, (old, old))
    with open(LOCK, "w", encoding="utf-8") as f:
        f.write('{"pid": 0, "t": 0}')
    print("\n已把 queue.jsonl / .proc 的 mtime 调到 2 小时前并占锁，触发钩子验证清理 …")
    since3 = s.call("{logs{time}}")["logs"][0]["time"]
    trigger(s, gid)
    time.sleep(15)
    proc_gone = not os.path.exists(PROC)
    print("queue.jsonl.proc 被回收：%s" % proc_gone)
    if os.path.exists(QUEUE):
        print("重建的 queue.jsonl 内容：%s（应只剩本次新事件）"
              % open(QUEUE, encoding="utf-8").read().strip())
    for line in [l["message"] for l in logs(s, since3) if "ImageMetaSync" in l["message"]]:
        print("   " + line.strip())
    print("RESULT: %s" % ("PASS" if proc_gone else "FAIL"))

    os.unlink(LOCK)
    for p in (QUEUE, PROC):
        if os.path.exists(p):
            print("清理测试残留 %s" % os.path.basename(p))
            os.unlink(p)


if __name__ == "__main__":
    main()
