# -*- coding: utf-8 -*-
"""Unit tests for the race-guard in translate_entity (write-back re-read check).

Branches:
 1. title changed since snapshot (nfo race)   -> title write dropped, no sceneUpdate
 2. title unchanged                            -> normal write-back happens
 3. details changed, title unchanged           -> only title written
 4. entity gone at re-read                     -> no write
 5. re-read raises                             -> no write (fail closed)
 6. gallery path: changed title                -> no galleryUpdate
 7. gallery path: unchanged title              -> galleryUpdate happens
"""
import importlib.util, sys, os

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 相对仓库定位插件源码：本文件位于 stash-testkit/tests/sceneTranslateAuto/，上溯 4 级到仓库根
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
spec = importlib.util.spec_from_file_location(
    "sta", os.path.join(_REPO, "sceneTranslateAuto", "sceneTranslateAuto.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# deterministic translation: raw text -> CJK result (protect_codes disabled so raw text reaches dispatch)
FAKE_TR = {
    "TESC-002 シーンテスト競合": "TESC-002 场景测试冲突",
    "テスト詳細": "测试简介中文",
}
m.protect_codes = lambda text, pat: (text, [])
m.dispatch_translate_multi = lambda texts, target, engine, settings: \
    [FAKE_TR.get(t, "中文" + t) for t in texts]

SETTINGS = dict(m.DEFAULTS)
SETTINGS["targetLanguage"] = "zh-CN"
SETTINGS["minLength"] = 4
LIMITER = m.RateLimiter(1000)


class FakeGql:
    def __init__(self, scene_state, gallery_state=None, fail_reread=False):
        self.scene_state = scene_state
        self.gallery_state = gallery_state
        self.fail_reread = fail_reread
        self.writes = []  # list of (mutation_name, input)

    def __call__(self, query, variables=None, timeout=90):
        if "findScene" in query and "findScenes" not in query:
            if self.fail_reread:
                raise RuntimeError("re-read boom")
            return {"findScene": self.scene_state}
        if "findGallery" in query:
            if self.fail_reread:
                raise RuntimeError("re-read boom")
            return {"findGallery": self.gallery_state}
        if "sceneUpdate" in query:
            self.writes.append(("sceneUpdate", variables["i"]))
            return {"sceneUpdate": {"id": variables["i"]["id"]}}
        if "galleryUpdate" in query:
            self.writes.append(("galleryUpdate", variables["i"]))
            return {"galleryUpdate": {"id": variables["i"]["id"]}}
        raise AssertionError("unexpected query: " + query[:80])


JP_T = "TESC-002 シーンテスト競合"
JP_D = "テスト詳細"
CN_T = "中文加工标题（nfo插件写入的真标题）"
CN_D = "中文加工简介"

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

# 1. title changed since snapshot -> dropped
def t1():
    g = FakeGql({"id": "10", "title": CN_T, "details": ""})
    r = m.translate_entity(g, "scene", "10", JP_T, "", SETTINGS, {}, LIMITER)
    check(r is None, "expected None return")
    check(g.writes == [], "expected no sceneUpdate, got %r" % g.writes)

# 2. title unchanged -> normal write
def t2():
    g = FakeGql({"id": "11", "title": JP_T, "details": ""})
    r = m.translate_entity(g, "scene", "11", JP_T, "", SETTINGS, {}, LIMITER)
    check(r == {"title": "TESC-002 场景测试冲突"}, "unexpected updates %r" % r)
    check(len(g.writes) == 1 and g.writes[0][0] == "sceneUpdate"
          and g.writes[0][1]["title"] == "TESC-002 场景测试冲突", "bad write %r" % g.writes)

# 3. details changed, title unchanged -> only title written
def t3():
    g = FakeGql({"id": "12", "title": JP_T, "details": CN_D})
    r = m.translate_entity(g, "scene", "12", JP_T, JP_D, SETTINGS, {}, LIMITER)
    check(r == {"title": "TESC-002 场景测试冲突"}, "unexpected updates %r" % r)
    check(len(g.writes) == 1 and "details" not in g.writes[0][1]
          and g.writes[0][1]["title"] == "TESC-002 场景测试冲突",
          "bad write %r" % g.writes)

# 4. entity gone at re-read -> no write
def t4():
    g = FakeGql({})
    r = m.translate_entity(g, "scene", "13", JP_T, "", SETTINGS, {}, LIMITER)
    check(r is None and g.writes == [], "expected skip, got %r / %r" % (r, g.writes))

# 5. re-read raises -> fail closed
def t5():
    g = FakeGql(None, fail_reread=True)
    r = m.translate_entity(g, "scene", "14", JP_T, "", SETTINGS, {}, LIMITER)
    check(r is None and g.writes == [], "expected skip, got %r / %r" % (r, g.writes))

# 6. gallery: title changed -> no galleryUpdate
def t6():
    g = FakeGql(None, {"id": "20", "title": CN_T, "details": ""})
    r = m.translate_entity(g, "gallery", "20", JP_T, "", SETTINGS, {}, LIMITER)
    check(r is None and g.writes == [], "expected skip, got %r / %r" % (r, g.writes))

# 7. gallery: title unchanged -> galleryUpdate happens
def t7():
    g = FakeGql(None, {"id": "21", "title": JP_T, "details": ""})
    r = m.translate_entity(g, "gallery", "21", JP_T, "", SETTINGS, {}, LIMITER)
    check(r == {"title": "TESC-002 场景测试冲突"}, "unexpected updates %r" % r)
    check(len(g.writes) == 1 and g.writes[0][0] == "galleryUpdate", "bad write %r" % g.writes)

# 8. details changed, title also changed -> both dropped (race on both fields)
def t8():
    g = FakeGql({"id": "15", "title": CN_T, "details": CN_D})
    r = m.translate_entity(g, "scene", "15", JP_T, JP_D, SETTINGS, {}, LIMITER)
    check(r is None and g.writes == [], "expected skip, got %r / %r" % (r, g.writes))

run("t1 title-race dropped", t1)
run("t2 normal title write", t2)
run("t3 details-race dropped, title kept", t3)
run("t4 entity gone -> skip", t4)
run("t5 re-read error -> skip", t5)
run("t6 gallery title-race dropped", t6)
run("t7 gallery normal write", t7)
run("t8 both fields raced -> skip", t8)

for s, n in results:
    print(f"{s}  {n}")
if any(s == "FAIL" for s, _ in results):
    sys.exit(1)
print("ALL PASS")
