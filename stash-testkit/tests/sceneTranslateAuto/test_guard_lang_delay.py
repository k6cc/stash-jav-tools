# -*- coding: utf-8 -*-
"""v1.2.2 tests: guard language-judgement (retranslate) + worker enqueue delay.

Branches:
 A1. cur != snapshot, cur is target lang (CN)  -> drop, no retranslate, no write
 A2. cur != snapshot, cur is non-target (JP)   -> retranslate cur, write CN result (dispatch called twice)
 A3. retranslate result invalid (identity JP)  -> field dropped, no write
 A4. cur == snapshot                          -> normal write, dispatch once
 B1. enqueued task already due                 -> worker processes it, file removed
 B2. enqueued task not due yet                 -> worker waits (sleep), does not process
 B3. corrupt task file                         -> removed without processing
"""
import importlib.util, sys, os, json, tempfile, time as _time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 相对仓库定位插件源码：本文件位于 stash-testkit/tests/sceneTranslateAuto/，上溯 4 级到仓库根
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
spec = importlib.util.spec_from_file_location(
    "sta2", os.path.join(_REPO, "sceneTranslateAuto", "sceneTranslateAuto.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

JP_A = "TESC-002 シーンテスト競合"          # snapshot (JP)
JP_B = "TESC-002 別表記タイトル"            # current after nfo wrote (another JP)
CN_T = "中文加工标题（nfo 写入）"
CN_B_TR = "TESC-002 别表记标题"             # retranslate result of JP_B

CALLS = []  # recorded dispatch texts
def fake_dispatch(texts, target, engine, settings):
    CALLS.append(list(texts))
    out = []
    for t in texts:
        if t == JP_A:
            out.append("TESC-002 场景测试冲突")
        elif t == JP_B:
            out.append(CN_B_TR)
        else:
            out.append("中文" + t)
    return out

m.protect_codes = lambda text, pat: (text, [])
m.dispatch_translate_multi = fake_dispatch

SETTINGS = dict(m.DEFAULTS)
SETTINGS["targetLanguage"] = "zh-CN"
SETTINGS["minLength"] = 4
LIMITER = m.RateLimiter(1000)


class FakeGql:
    def __init__(self, scene_state):
        self.scene_state = scene_state
        self.writes = []

    def __call__(self, query, variables=None, timeout=90):
        if "findScene" in query:
            return {"findScene": self.scene_state}
        if "sceneUpdate" in query:
            self.writes.append(("sceneUpdate", variables["i"]))
            return {"sceneUpdate": {"id": variables["i"]["id"]}}
        raise AssertionError("unexpected query: " + query[:80])


results = []

def run(name, fn):
    try:
        fn()
        results.append(("PASS", name))
    except AssertionError as e:
        results.append(("FAIL", name + ": " + str(e)))

def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


# A1. cur is CN (target) -> drop, no retranslate (dispatch once), no write
def a1():
    CALLS.clear()
    g = FakeGql({"id": "30", "title": CN_T, "details": ""})
    r = m.translate_entity(g, "scene", "30", JP_A, "", SETTINGS, {}, LIMITER)
    check(r is None, "expected None, got %r" % r)
    check(g.writes == [], "expected no write, got %r" % g.writes)
    check(len(CALLS) == 1, "expected single dispatch, got %r" % CALLS)

# A2. cur is JP (non-target) -> retranslate cur, write its CN result
def a2():
    CALLS.clear()
    g = FakeGql({"id": "31", "title": JP_B, "details": ""})
    r = m.translate_entity(g, "scene", "31", JP_A, "", SETTINGS, {}, LIMITER)
    check(r == {"title": CN_B_TR}, "expected retranslate write, got %r" % r)
    check(len(CALLS) == 2 and CALLS[0] == [JP_A] and CALLS[1] == [JP_B],
          "expected two dispatches (snapshot then current), got %r" % CALLS)
    check(len(g.writes) == 1 and g.writes[0][1]["title"] == CN_B_TR,
          "bad write %r" % g.writes)

# A3. retranslate returns identity (still JP) -> rejected, no write
def a3():
    CALLS.clear()
    orig = m.dispatch_translate_multi
    m.dispatch_translate_multi = lambda texts, target, engine, settings: [JP_B]
    try:
        g = FakeGql({"id": "32", "title": JP_B, "details": ""})
        r = m.translate_entity(g, "scene", "32", JP_A, "", SETTINGS, {}, LIMITER)
        check(r is None, "expected None, got %r" % r)
        check(g.writes == [], "expected no write, got %r" % g.writes)
    finally:
        m.dispatch_translate_multi = orig

# A4. cur == snapshot -> normal write, dispatch once
def a4():
    CALLS.clear()
    g = FakeGql({"id": "33", "title": JP_A, "details": ""})
    r = m.translate_entity(g, "scene", "33", JP_A, "", SETTINGS, {}, LIMITER)
    check(r == {"title": "TESC-002 场景测试冲突"}, "unexpected %r" % r)
    check(len(CALLS) == 1, "expected single dispatch, got %r" % CALLS)
    check(len(g.writes) == 1, "expected one write, got %r" % g.writes)


# ─── worker delay ─────────────────────────────────────────────────────────────

tmp = tempfile.mkdtemp(prefix="sta_delay_test_")
m.PENDING_DIR = os.path.join(tmp, "pending")
os.makedirs(m.PENDING_DIR, exist_ok=True)
m.PID_FILE = os.path.join(tmp, "worker.pid")
m.LOG = os.path.join(tmp, "log.txt")
m.CACHE_FILE = os.path.join(tmp, "cache.json")
m.DEAD_FILE = os.path.join(tmp, "dead.jsonl")

PROCESSED = []
def fake_process(conn, sid, settings, limiter):
    PROCESSED.append(sid)
m.process_task = fake_process
m.read_stash_plugin_config = lambda gql: {"hookDelaySeconds": "0.1"}
m.make_gql = lambda conn: (lambda *a, **k: {})

# B1. due task -> processed, file removed
def b1():
    PROCESSED.clear()
    for f in os.listdir(m.PENDING_DIR):
        os.unlink(os.path.join(m.PENDING_DIR, f))
    tf = os.path.join(m.PENDING_DIR, "100.json")
    with open(tf, "w", encoding="utf-8") as f:
        json.dump({"scene_id": "100", "server_connection": {}, "enqueued_at": _time.time() - 100}, f)
    m.worker_main()
    check(PROCESSED == ["100"], "expected processed [100], got %r" % PROCESSED)
    check(not os.path.exists(tf), "task file should be removed")

# B2. not-due task -> waits, does not process
def b2():
    PROCESSED.clear()
    for f in os.listdir(m.PENDING_DIR):
        os.unlink(os.path.join(m.PENDING_DIR, f))
    tf = os.path.join(m.PENDING_DIR, "101.json")
    with open(tf, "w", encoding="utf-8") as f:
        json.dump({"scene_id": "101", "server_connection": {}, "enqueued_at": _time.time() + 3600}, f)
    sleeps = []
    orig_sleep = m.time.sleep
    def fake_sleep(s):
        sleeps.append(s)
        raise SystemExit  # interrupt the wait loop: we only assert first-round behaviour
    m.time.sleep = fake_sleep
    try:
        try:
            m.worker_main()
        except SystemExit:
            pass
        check(PROCESSED == [], "must not process a not-due task, got %r" % PROCESSED)
        check(sleeps, "expected worker to wait for the not-due task")
        check(os.path.exists(tf), "not-due task file must be kept")
    finally:
        m.time.sleep = orig_sleep

# B3. corrupt task file -> removed without processing
def b3():
    PROCESSED.clear()
    for f in os.listdir(m.PENDING_DIR):
        os.unlink(os.path.join(m.PENDING_DIR, f))
    tf = os.path.join(m.PENDING_DIR, "102.json")
    with open(tf, "w", encoding="utf-8") as f:
        f.write("{not json")
    m.worker_main()
    check(PROCESSED == [], "corrupt task must not be processed, got %r" % PROCESSED)
    check(not os.path.exists(tf), "corrupt task file should be removed")


run("A1 cur-CN dropped, no retranslate", a1)
run("A2 cur-JP retranslated & written", a2)
run("A3 invalid retranslate rejected", a3)
run("A4 unchanged normal write", a4)
run("B1 due task processed", b1)
run("B2 not-due task waits", b2)
run("B3 corrupt task removed", b3)

for s, n in results:
    print(f"{s}  {n}")
if any(s == "FAIL" for s, _ in results):
    sys.exit(1)
print("ALL PASS")
