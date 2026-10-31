# -*- coding: utf-8 -*-
"""ImageMetaSync 运行锁的跨进程测试工具（test_lock_takeover / test_lock_queue 共用）。

子进程里 `import ImageMetaSync` 后直接调用私有的 `__acquire_lock` 等，测的是真实代码路径。
"""
import os
import subprocess
import sys
import tempfile
import time

CHILD_SRC = r'''
import importlib, os, sys, time
plugin, action = sys.argv[1], sys.argv[2]
sys.path.insert(0, plugin)
os.chdir(plugin)
mod = importlib.import_module("ImageMetaSync")

if action.startswith("fb_"):
    # 模拟「该文件系统不支持字节锁」：让 __os_lock 抛 EINVAL，验证是否退化到 mtime 判定
    def _boom(fh):
        raise OSError(22, "simulated: fs does not support locking")
    mod.ImageMetaSync._ImageMetaSync__os_lock = staticmethod(_boom)
    action = action[3:]

sync = mod.ImageMetaSync(None)
if action in ("hold", "try", "release"):
    ok = sync._ImageMetaSync__acquire_lock()
elif action in ("mtime_hold", "mtime_try"):
    ok = sync._ImageMetaSync__acquire_lock_by_mtime()
print("ACQUIRED" if ok else "BUSY", flush=True)
if action == "release":
    sync._ImageMetaSync__release_lock()
elif action in ("hold", "mtime_hold"):
    time.sleep(120)
'''


def helper_path():
    # 临时文件残留旧版本会让子进程跑的不是当前代码，内容不一致就重写
    path = os.path.join(tempfile.gettempdir(), "_ims_lock_child.py")
    cur = None
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cur = f.read()
        except OSError:
            cur = None
    if cur != CHILD_SRC:
        with open(path, "w", encoding="utf-8") as f:
            f.write(CHILD_SRC)
    return path


def spawn_holder(plugin, action="hold"):
    """起一个持锁进程，返回 (Popen, 首行输出)。持锁进程会 sleep 120s，用完必须 kill。"""
    p = subprocess.Popen([sys.executable, helper_path(), plugin, action],
                         stdout=subprocess.PIPE, text=True)
    return p, p.stdout.readline().strip()


def run_child(plugin, action="try"):
    """跑一次抢锁进程，返回 (是否抢到, 耗时秒)。进程退出即释放锁。"""
    t0 = time.time()
    p = subprocess.run([sys.executable, helper_path(), plugin, action],
                       capture_output=True, text=True)
    out = (p.stdout or "").strip().splitlines()
    if not out:
        print("   子进程无输出，stderr:", (p.stderr or "").strip()[:300])
    return (bool(out) and out[0] == "ACQUIRED"), round(time.time() - t0, 2)


def hard_kill(p):
    """模拟硬杀：Windows 走 TerminateProcess，POSIX 走 SIGKILL，都不给 finally 机会。"""
    p.kill()
    p.wait()


def cleanup(plugin):
    pending = os.path.join(plugin, ".ims_pending")
    for name in ("queue.jsonl", "queue.jsonl.proc", "run.lock"):
        f = os.path.join(pending, name)
        if os.path.exists(f):
            try:
                os.unlink(f)
            except OSError:
                pass
