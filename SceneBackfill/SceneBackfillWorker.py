"""SceneBackfill background worker.

Started detached by the `worker` op, so it outlives the plugin call that
launched it. It holds daemon.lock (only one copy), ticks every
DAEMON_INTERVAL seconds, and writes a heartbeat the page reads to decide
whether it may run ticks itself.

It stops on three conditions, all of which exist to avoid a stray process:
the UI asked it to stop, every automation switch has been off with nothing in
flight for 30 minutes, or Stash has been unreachable for five rounds (which
means Stash restarted and the session this worker was given is gone).
"""

import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import SceneBackfill as core

MAX_FAILURES = 5


def log(ctx, msg):
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"
    try:
        p = os.path.join(core.data_dir(ctx), "worker.log")
        if os.path.isfile(p) and os.path.getsize(p) > 256 * 1024:
            os.replace(p, p + ".1")
        with open(p, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    print(f"[SceneBackfill worker] {msg}", file=sys.stderr, flush=True)


def build_ctx(conn):
    return core.Ctx({"server_connection": conn or {}, "args": {}})


def main(argv):
    conn = {}
    if len(argv) > 1:
        try:
            conn = json.loads(argv[1])
        except Exception:
            conn = {}
    ctx = build_ctx(conn)
    lock = core.RunLock(core.daemon_lock_path(ctx))
    if not lock.acquire():
        log(ctx, "another worker holds the lock, exiting")
        return
    lock.write_pid(os.getpid())
    log(ctx, f"started pid={os.getpid()} stash={ctx.scheme}://{ctx.host}:{ctx.port}")

    idle_since = 0.0
    failures = 0
    idle_exit = False
    try:
        while True:
            try:
                st = core.load_state(ctx)
                d = st.get("daemon") or {}
                # A `stopping` flag left behind by a worker that was killed
                # must not make the next one quit on sight, so it only counts
                # while it still names our own pid.
                if d.get("stopping") and int(d.get("pid") or 0) in (0, os.getpid()):
                    log(ctx, "stop requested")
                    break
                ctrl = core.get_control(st)
                busy = any(r.get("status") in ("pushed", "downloaded", "importing")
                           for r in (st.get("scenes") or {}).values())
                idle = not any((ctrl["autoSearch"], ctrl["autoPush"], ctrl["autoImport"])) and not busy

                # Heartbeat before the work: a tick that takes 45s must not make
                # the page think the worker died.
                d["pid"] = os.getpid()
                d["lastTick"] = int(time.time())
                st["daemon"] = d
                core.save_state(ctx, st)

                ctx.args = {"source": "worker"}
                out = core.do_tick(ctx)
                failures = 0
                acts = (out or {}).get("actions") or []
                if acts:
                    log(ctx, "tick: " + ", ".join(acts))
            except Exception as e:
                failures += 1
                log(ctx, f"tick failed ({failures}/{MAX_FAILURES}): {e}")
                log(ctx, traceback.format_exc()[-800:])
                if failures >= MAX_FAILURES:
                    log(ctx, "Stash unreachable or failing, exiting")
                    break

            if idle:
                if not idle_since:
                    idle_since = time.time()
                elif time.time() - idle_since > core.DAEMON_IDLE_EXIT:
                    log(ctx, "idle with all switches off, exiting")
                    idle_exit = True
                    break
            else:
                idle_since = 0.0

            # Sleep in slices: a stop request should land in seconds instead of
            # waiting out a full 90 s interval.
            until = time.time() + core.DAEMON_INTERVAL
            while time.time() < until:
                time.sleep(2)
                try:
                    sd = core.load_state(ctx).get("daemon") or {}
                except Exception:
                    sd = {}
                if sd.get("stopping") and int(sd.get("pid") or 0) in (0, os.getpid()):
                    break
    finally:
        try:
            st = core.load_state(ctx)
            # Only clear the heartbeat if it is still ours: a successor may
            # already have started and written its own pid.
            d = st.get("daemon") or {}
            if int(d.get("pid") or 0) == os.getpid():
                d["pid"] = 0
                d["lastTick"] = 0
                d["stoppedAt"] = int(time.time())
                d.pop("stopping", None)
                st["daemon"] = d
                core.save_state(ctx, st)
            # want 决定下次打开页面时要不要自己回来：手动停（在 stop 里清掉）
            # 和空闲自退都不该复活；只有 Stash 连不上（重启）才留着让它回来。
            if idle_exit:
                core.set_want(ctx, False)
        except Exception:
            pass
        lock.release()


if __name__ == "__main__":
    main(sys.argv)
