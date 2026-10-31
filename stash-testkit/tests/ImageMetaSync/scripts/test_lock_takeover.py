# -*- coding: utf-8 -*-
"""运行锁语义验证（离线，不连 Stash、不碰数据库）。

验证点：
 1) 持锁进程存活时，第二个进程抢不到锁（BUSY）
 2) 持锁进程被硬杀（TerminateProcess / SIGKILL）后，后来者能**立即**抢到锁，不用等 900s
 3) 正常释放后锁文件仍在（OS 锁模式不 unlink），且新进程能正常抢到
 4) mtime 兜底路径行为不变：存活时 BUSY，删锁后可抢

用法：
    python test_lock_takeover.py [插件目录]
默认 E:\\stashAPP\\plugins\\k6cc\\ImageMetaSync（测已部署代码）。
"""
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _lock_helper import cleanup, hard_kill, run_child, spawn_holder  # noqa: E402

DEFAULT_PLUGIN = r"E:\stashAPP\plugins\k6cc\ImageMetaSync"


def main():
    plugin = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PLUGIN
    if not os.path.isfile(os.path.join(plugin, "ImageMetaSync.py")):
        print("找不到插件：%s" % plugin)
        return 1
    lock = os.path.join(plugin, ".ims_pending", "run.lock")
    results = []
    print("插件目录：%s\n" % plugin)
    cleanup(plugin)

    # --- 1) 持锁进程存活 -> BUSY
    holder, line = spawn_holder(plugin)
    print("1) 持锁子进程：%s (pid=%s)" % (line, holder.pid))
    ok, cost = run_child(plugin)
    print("   第二个进程抢锁：%s（%.2fs）" % ("ACQUIRED" if ok else "BUSY", cost))
    results.append(("存活时互斥", line == "ACQUIRED" and not ok))

    # --- 2) 硬杀持锁进程 -> 立即抢到
    hard_kill(holder)
    time.sleep(0.3)
    ok, cost = run_child(plugin)
    print("2) 硬杀持锁进程后立刻抢锁：%s（%.2fs）" % ("ACQUIRED" if ok else "BUSY", cost))
    print("   run.lock 仍在（OS 锁不 unlink）：%s" % os.path.exists(lock))
    results.append(("硬杀后可抢占", ok and cost < 5))
    results.append(("释放后锁文件保留", os.path.exists(lock)))

    # --- 3) 正常释放后仍可抢
    holder, line = spawn_holder(plugin)
    ok2, _ = run_child(plugin)
    hard_kill(holder)
    time.sleep(0.3)
    ok3, cost3 = run_child(plugin)
    print("3) 正常持锁时抢锁：%s；释放后再抢：%s（%.2fs）"
          % ("ACQUIRED" if ok2 else "BUSY", "ACQUIRED" if ok3 else "BUSY", cost3))
    results.append(("释放后可重入", (not ok2) and ok3))

    # --- 4) mtime 兜底路径行为不变
    cleanup(plugin)
    holder, line = spawn_holder(plugin, "mtime_hold")
    print("4) mtime 兜底持锁：%s" % line)
    ok4, _ = run_child(plugin, "mtime_try")
    hard_kill(holder)
    if os.path.exists(lock):
        os.unlink(lock)
    ok5, _ = run_child(plugin, "mtime_try")
    print("   存活时抢锁：%s（预期 BUSY）；删锁后：%s（预期 ACQUIRED）"
          % ("ACQUIRED" if ok4 else "BUSY", "ACQUIRED" if ok5 else "BUSY"))
    results.append(("mtime 兜底不变", (not ok4) and ok5))

    # --- 5) 文件系统不支持字节锁时，__acquire_lock 能自动退化到 mtime（不能卡死队列）
    cleanup(plugin)
    holder, line = spawn_holder(plugin, "fb_hold")
    print("5) 模拟不支持 OS 锁时的持锁：%s" % line)
    ok6, _ = run_child(plugin, "fb_try")
    print("   第二个进程抢锁：%s（预期 BUSY）" % ("ACQUIRED" if ok6 else "BUSY"))
    hard_kill(holder)
    ok7, _ = run_child(plugin, "fb_try")
    print("   持锁进程死后抢锁：%s（mtime 兜底等 900s，预期 BUSY）"
          % ("ACQUIRED" if ok7 else "BUSY"))
    if os.path.exists(lock):
        os.unlink(lock)
    ok8, _ = run_child(plugin, "fb_try")
    print("   删锁后抢锁：%s（预期 ACQUIRED，证明退化路径没把队列锁死）"
          % ("ACQUIRED" if ok8 else "BUSY"))
    results.append(("不支持锁时退化", (not ok6) and (not ok7) and ok8))

    cleanup(plugin)
    print("\n--- 汇总 ---")
    for name, ok in results:
        print("  %-14s %s" % (name, "PASS" if ok else "FAIL"))
    passed = all(ok for _, ok in results)
    print("RESULT: %s" % ("PASS" if passed else "FAIL"))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
