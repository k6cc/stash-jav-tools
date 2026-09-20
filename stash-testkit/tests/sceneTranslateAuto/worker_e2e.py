# -*- coding: utf-8 -*-
"""sceneTranslateAuto worker 端到端验证（需已部署插件到本地实例，无库写入副作用）：
1. 空队列 -> worker 立即退出，0 处理
2. 到期假任务（enqueued_at 过去，sid 不存在）-> 处理 -> "scene not found" -> 文件删除
3. 未到期假任务（enqueued_at +3600s）-> worker 等待（进程存活），文件保留 -> 终止并清理

依赖：config.json（plugin_dir 指向已部署插件目录，如 E:/stashAPP/plugins/k6cc）。
"""
import json, os, io, subprocess, sys, time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "config.json")
with open(_CFG, "r", encoding="utf-8") as f:
    CFG = json.load(f)
PLUGIN_ROOT = os.path.join(CFG["plugin_dir"], "sceneTranslateAuto")
STA = os.path.join(PLUGIN_ROOT, "sceneTranslateAuto.py")
PENDING = os.path.join(PLUGIN_ROOT, "auto_state", "pending")
PID_FILE = os.path.join(PLUGIN_ROOT, "auto_state", "worker.pid")

CONN = {"Scheme": "http", "Host": "localhost", "Port": 9999,
        "Dir": os.path.dirname(CFG["stash_exe"])}

def clear_pending():
    if os.path.isdir(PENDING):
        for f in os.listdir(PENDING):
            try:
                os.unlink(os.path.join(PENDING, f))
            except OSError:
                pass

def run_worker(timeout=30):
    return subprocess.run([sys.executable, STA, "--mode", "worker"], capture_output=True,
                          text=True, encoding="utf-8", errors="replace", timeout=timeout)

# 1. empty queue -> immediate exit, 0 processed
clear_pending()
p = run_worker(30)
print("=== 1 empty queue === exit:", p.returncode)

# 2. due fake task -> processed & removed
clear_pending()
tf = os.path.join(PENDING, "99999.json")
with open(tf, "w", encoding="utf-8") as f:
    json.dump({"scene_id": "99999", "server_connection": CONN, "enqueued_at": time.time() - 100}, f)
p = run_worker(60)
print("=== 2 due task === exit:", p.returncode, "file_exists:", os.path.exists(tf))

# 3. not-due fake task -> worker waits (alive), file kept; then kill & clean
clear_pending()
tf2 = os.path.join(PENDING, "99998.json")
with open(tf2, "w", encoding="utf-8") as f:
    json.dump({"scene_id": "99998", "server_connection": CONN, "enqueued_at": time.time() + 3600}, f)
proc = subprocess.Popen([sys.executable, STA, "--mode", "worker"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(4)
alive = proc.poll() is None
print("=== 3 not-due task === worker_alive_after_4s:", alive, "file_exists:", os.path.exists(tf2))
if alive:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

# cleanup: remove fake pending + stale pid
clear_pending()
if os.path.exists(PID_FILE):
    try:
        os.unlink(PID_FILE)
    except OSError:
        pass
print("cleanup done")
