# -*- coding: utf-8 -*-
"""sceneTranslateAuto scan_all (Full Scan & Translate / Preview) 单元测试。

覆盖：
 A1. 分页聚合：多页 findScenes 结果全部收入 needed
 A2. 语言预检过滤：已译场景不进入 needed
 A3. 空库（needed=0）：立即返回，进度 1.0，无翻译调用
 A4. dry-run：不调用 translate_entity，返回审计统计，log_audit 记录明细
 A5. 单场景异常隔离：batch 内一个场景翻译抛异常不影响同组其他场景
 A6. 缓存命中 + 仅图库需译：场景不重译，图库被翻译
 A7. 进度上报：每 batch 后递增，最终 1.0
 A8. 返回值拆细：scenes_translated / galleries_translated / scenes_failed 独立计数
"""
import importlib.util, sys, os, json

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
spec = importlib.util.spec_from_file_location(
    "sta_scan", os.path.join(_REPO, "sceneTranslateAuto", "sceneTranslateAuto.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

CODE = m.DEFAULTS["codePattern"]
JP_T = "TESC-100 シーンテスト"
JP_D = "テスト詳細"
CN_T = "中文已译标题"
CN_D = "中文已译简介"

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


def make_settings(**over):
    s = dict(m.DEFAULTS)
    s.update(over)
    return s


class FakeGql:
    """按 page 返回场景列表；findScenes 之外的 query 抛错（scan_all 扫描阶段不应发其他查询）。"""

    def __init__(self, pages, total=None):
        self.pages = pages
        self.total = total if total is not None else sum(len(p) for p in pages)
        self.calls = 0

    def __call__(self, query, variables=None, timeout=90):
        if "findScenes" in query:
            self.calls += 1
            page = (variables or {}).get("filter", {}).get("page", 1)
            idx = page - 1
            scenes = self.pages[idx] if 0 <= idx < len(self.pages) else []
            return {"findScenes": {"count": self.total, "scenes": scenes}}
        if "configuration" in query:
            return {"configuration": {"plugins": {}}}
        raise AssertionError("unexpected query in scan phase: " + query[:80])


def scene(sid, title, details, galleries=None):
    return {"id": str(sid), "title": title, "details": details,
            "galleries": galleries or []}


def gallery(gid, title, details=""):
    return {"id": str(gid), "title": title, "details": details}


def base_payload():
    return {"server_connection": {"Scheme": "http", "Host": "localhost", "Port": 9999},
            "args": {"mode": "scan_all"}}


# ═══ A1. 分页聚合 ═══════════════════════════════════════════════════════════

def a1():
    # total > per_page(500) 才会触发第 2 页查询；每页只放少量场景，第 3 页返回空终止
    pages = [
        [scene(1, JP_T, JP_D), scene(2, JP_T, JP_D)],
        [scene(3, JP_T, JP_D), scene(4, JP_T, JP_D)],
        [],
    ]
    g = FakeGql(pages, total=1000)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings(batchSize=10, scanAllConcurrency=1)
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    m.log_progress = lambda p: None
    m.log_audit = lambda msg: None
    translate_calls = []
    m.translate_entity = lambda gql, kind, eid, *a, **k: (
        translate_calls.append((kind, eid)) or {"title": "译"})
    r = m.scan_all(base_payload())
    check(g.calls == 2, "expected 2 page queries (page 3 empty breaks), got %d" % g.calls)
    check(r["needed"] == 4, "expected needed=4, got %d" % r["needed"])
    check(len(translate_calls) == 4, "expected 4 translate calls, got %d" % len(translate_calls))


# ═══ A2. 语言预检过滤 ═══════════════════════════════════════════════════════

def a2():
    pages = [[
        scene(1, JP_T, JP_D),    # 需译
        scene(2, CN_T, CN_D),    # 已译（中文）
        scene(3, JP_T, ""),      # title 需译
        scene(4, CN_T, JP_D),    # details 需译
    ]]
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings()
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    m.log_progress = lambda p: None
    m.log_audit = lambda msg: None
    m.translate_entity = lambda *a, **k: {"title": "译"}
    r = m.scan_all(base_payload())
    check(r["needed"] == 3, "expected needed=3 (scenes 1,3,4), got %d" % r["needed"])


# ═══ A3. 空库 ═══════════════════════════════════════════════════════════════

def a3():
    g = FakeGql([[]], total=0)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings()
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    progress = []
    m.log_progress = lambda p: progress.append(p)
    m.log_audit = lambda msg: None
    tr_calls = []
    m.translate_entity = lambda *a, **k: (tr_calls.append(1) or {"title": "译"})
    r = m.scan_all(base_payload())
    check(r["needed"] == 0, "expected needed=0, got %d" % r["needed"])
    check(tr_calls == [], "expected no translate calls, got %d" % len(tr_calls))
    check(progress and progress[-1] == 1.0, "expected final progress 1.0, got %r" % progress)


# ═══ A4. dry-run ═══════════════════════════════════════════════════════════

def a4():
    pages = [[
        scene(1, JP_T, JP_D, [gallery(10, JP_T)]),
        scene(2, CN_T, CN_D),
        scene(3, JP_T, ""),
    ]]
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings()
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    log_msgs = []
    m.log = lambda msg: log_msgs.append(msg)
    m.log_progress = lambda p: None
    audit = []
    m.log_audit = lambda msg: audit.append(msg)
    tr_calls = []
    m.translate_entity = lambda *a, **k: (tr_calls.append(1) or {"title": "译"})
    payload = base_payload()
    payload["args"]["dry_run"] = True
    r = m.scan_all(payload)
    check(r.get("dry_run") is True, "expected dry_run=True, got %r" % r)
    check(r["need_translate"] == 2, "expected need_translate=2, got %d" % r["need_translate"])
    check(r["title_need"] == 2, "expected title_need=2, got %d" % r["title_need"])
    check(r["details_need"] == 1, "expected details_need=1, got %d" % r["details_need"])
    check(r["galleries_need"] == 1, "expected galleries_need=1, got %d" % r["galleries_need"])
    check(tr_calls == [], "dry-run must not call translate_entity, got %d calls" % len(tr_calls))
    check(len(audit) >= 3, "expected audit log entries (2 scenes + 1 gallery), got %d" % len(audit))
    check(any("DRY-RUN audit" in msg for msg in log_msgs),
          "expected DRY-RUN audit summary in log, got %r" % log_msgs)


# ═══ A5. 单场景异常隔离 ═══════════════════════════════════════════════════

def a5():
    pages = [[scene(999, JP_T, JP_D), scene(2, JP_T, JP_D)]]
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings(batchSize=2, scanAllConcurrency=1)
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    m.log_progress = lambda p: None
    m.log_audit = lambda msg: None

    def fake_translate(gql, kind, eid, title, details, settings, cache, limiter):
        if str(eid) == "999":
            raise RuntimeError("translate boom")
        return {"title": "译" + title}

    m.translate_entity = fake_translate
    r = m.scan_all(base_payload())
    check(r["scenes_failed"] == 1, "expected scenes_failed=1, got %d" % r["scenes_failed"])
    check(r["scenes_translated"] == 1, "expected scenes_translated=1, got %d" % r["scenes_translated"])
    check(r["needed"] == 2, "expected needed=2, got %d" % r["needed"])


# ═══ A6. 缓存命中 + 仅图库需译 ═════════════════════════════════════════════

def a6():
    # 场景 1 标题已译（中文）且缓存命中，但关联图库 10 是日文需译
    pages = [[scene(1, CN_T, CN_D, [gallery(10, JP_T, JP_D)])]]
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings()
    # 缓存：scene 1 命中（title/details 与当前一致）
    m.load_cache = lambda: {"1": {"at": 9999999999, "title": CN_T, "details": CN_D}}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    m.log_progress = lambda p: None
    m.log_audit = lambda msg: None
    translated = []

    def fake_translate(gql, kind, eid, title, details, settings, cache, limiter):
        # 模拟 translate_entity 内部缓存检查：缓存命中的场景返回 None（不写回）
        if kind == "scene" and str(eid) == "1":
            return None
        translated.append((kind, eid))
        return {"title": "译" + title}

    m.translate_entity = fake_translate
    r = m.scan_all(base_payload())
    check(r["needed"] == 1, "expected needed=1 (cache-hit scene with gallery need), got %d" % r["needed"])
    kinds = [k for k, _ in translated]
    check("scene" not in kinds, "cached scene must not be written back, got %r" % translated)
    check(("gallery", "10") in translated, "gallery 10 must be translated, got %r" % translated)
    check(r["galleries_translated"] == 1, "expected galleries_translated=1, got %d" % r["galleries_translated"])


# ═══ A7. 进度上报 ═════════════════════════════════════════════════════════

def a7():
    pages = [[scene(i, JP_T, JP_D) for i in range(1, 6)]]  # 5 场景
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings(batchSize=2, scanAllConcurrency=1)
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    progress = []
    m.log_progress = lambda p: progress.append(p)
    m.log_audit = lambda msg: None
    m.translate_entity = lambda *a, **k: {"title": "译"}
    m.scan_all(base_payload())
    check(len(progress) >= 3, "expected >=3 progress calls (3 batches), got %d" % len(progress))
    check(progress[-1] == 1.0, "expected final progress 1.0, got %r" % progress[-1])
    check(all(0.0 <= p <= 1.0 for p in progress), "progress out of range: %r" % progress)


# ═══ A8. 返回值拆细 ═══════════════════════════════════════════════════════

def a8():
    pages = [[scene(1, JP_T, JP_D, [gallery(10, JP_T)]),
              scene(2, CN_T, CN_D)]]
    g = FakeGql(pages)
    m.make_gql = lambda conn: g
    m.read_stash_plugin_config = lambda gql: {}
    m.merged_settings = lambda cfg: make_settings()
    m.load_cache = lambda: {}
    m.save_cache = lambda c: None
    m.log = lambda msg: None
    m.log_progress = lambda p: None
    m.log_audit = lambda msg: None
    m.translate_entity = lambda *a, **k: {"title": "译"}
    r = m.scan_all(base_payload())
    check("scenes_translated" in r, "missing scenes_translated")
    check("galleries_translated" in r, "missing galleries_translated")
    check("scenes_failed" in r, "missing scenes_failed")
    check("done" not in r, "old 'done' key should be removed, got %r" % r)
    check("failed" not in r, "old 'failed' key should be removed, got %r" % r)
    check(r["scenes_translated"] == 1, "expected 1 scene translated, got %d" % r["scenes_translated"])
    check(r["galleries_translated"] == 1, "expected 1 gallery translated, got %d" % r["galleries_translated"])


run("A1 multi-page aggregation", a1)
run("A2 language pre-check filtering", a2)
run("A3 empty library immediate return", a3)
run("A4 dry-run no translate + audit stats", a4)
run("A5 single-scene exception isolation", a5)
run("A6 cache-hit with gallery-only need", a6)
run("A7 progress reporting", a7)
run("A8 split return values", a8)

for s, n in results:
    print("%s  %s" % (s, n))
if any(s == "FAIL" for s, _ in results):
    sys.exit(1)
print("ALL PASS")
