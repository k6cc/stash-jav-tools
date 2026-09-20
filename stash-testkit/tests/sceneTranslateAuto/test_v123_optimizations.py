# -*- coding: utf-8 -*-
"""v1.2.3 tests: 优化项 1 快照比对防顺延 / 优化项 2 google_free 逐 q 翻译 / 优化项 3 zh 分支组合判据。

优化1（快照防顺延）：
 S1. pending 任务同快照（title/details 未变）-> handle_hook 跳过重入队，enqueued_at 保留
 S2. 快照不同（nfo 真改了 title）-> handle_hook 重入队刷新 enqueued_at + 新快照
 S3. 旧格式任务文件（无快照字段）-> 视为无快照，刷新一次（兼容）
 S4. enqueue_task 写入 title_snapshot/details_snapshot；旧签名（无快照参数）写空快照
 S5. pending_task_matches：同快照 True / 快照不同 False / 旧格式 False / 文件缺失 False

优化2（google_free 多 q 逐条翻译）：
 G1. 多 q -> 每个入参各发一次请求，按序返回各 q 对应译文
 G2. 空响应 segs -> 返回原文
 G3. 请求持续失败 -> 3 次重试后抛 TranslateError
 G4. title+details 同时需翻译 -> 端到端写回两条字段

优化3（needs_translation zh 分支组合判据）：
 Z1. 混合标题汉字占优 -> 跳过（False）
 Z2. 假名占优 / 纯日文 -> 判 ja 翻译（True）
 Z3. 纯中文（含番号前缀）-> 跳过（False）
 Z4. 边界：汉字==假名 -> True；番号前缀不影响判定；details 同理
 Z5. 其他目标语言分支不受影响
"""
import importlib.util, sys, os, json, tempfile, time as _time
from urllib.parse import parse_qs, urlparse

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# 相对仓库定位插件源码：本文件位于 stash-testkit/tests/sceneTranslateAuto/，上溯 4 级到仓库根
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
spec = importlib.util.spec_from_file_location(
    "sta3", os.path.join(_REPO, "sceneTranslateAuto", "sceneTranslateAuto.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# 供后续用例恢复（S 组会对 find_scene/needs_translation 打桩，G/Z 组需用真实实现）
real_find_scene = m.find_scene
real_needs_translation = m.needs_translation

CODE = m.DEFAULTS["codePattern"]

JP_T = "TESC-200 シーンテスト"      # 假名占优（hanzi 2 < kana 6）
JP_D = "詳細テスト"                  # 假名占优（hanzi 2 < kana 3）
JP_B = "TESC-200 別表記タイトル"     # 假名占优的另一日文标题
CN_MIX = "SSIS-200 美少女 と温泉旅行"  # 汉字占优（hanzi 7 > kana 1）
CN_PURE = "美少女温泉旅行"

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


# ═══ 优化 1：快照比对防顺延 ═══════════════════════════════════════════════════

tmp = tempfile.mkdtemp(prefix="sta_v123_")
m.PENDING_DIR = os.path.join(tmp, "pending")
os.makedirs(m.PENDING_DIR, exist_ok=True)

SCENE_STATE = {}
m.spawn_worker = lambda: True
m.make_gql = lambda conn: (lambda *a, **k: {})
m.read_stash_plugin_config = lambda gql: {}
m.merged_settings = lambda stash_cfg: dict(m.DEFAULTS)
m.find_scene = lambda gql, sid: SCENE_STATE.get(str(sid), {})
m.needs_translation = lambda *a, **k: True  # 预检通过，直接进入入队路径

def hook_payload(sid):
    return {"server_connection": {}, "args": {"hookContext": {"id": str(sid), "type": "Scene.Update.Post"}}}

def write_task(sid, enqueued_at, title_snap=None, details_snap=None):
    task = {"scene_id": str(sid), "server_connection": {}, "enqueued_at": enqueued_at}
    if title_snap is not None:
        task["title_snapshot"] = title_snap
        task["details_snapshot"] = details_snap
    tf = os.path.join(m.PENDING_DIR, "%s.json" % sid)
    with open(tf, "w", encoding="utf-8") as f:
        json.dump(task, f)
    return tf

def read_task(sid):
    with open(os.path.join(m.PENDING_DIR, "%s.json" % sid), "r", encoding="utf-8") as f:
        return json.load(f)

# S1. 同快照 -> 跳过重入队，enqueued_at 保留
def s1():
    sid = "501"
    SCENE_STATE[sid] = {"id": sid, "title": JP_T, "details": JP_D}
    write_task(sid, 1234.0, JP_T, JP_D)
    m.handle_hook(hook_payload(sid))
    t = read_task(sid)
    check(t["enqueued_at"] == 1234.0, "same snapshot must keep enqueued_at, got %r" % t["enqueued_at"])
    check(t["title_snapshot"] == JP_T and t["details_snapshot"] == JP_D,
          "snapshot must be kept, got %r" % t)

# S2. 快照不同（title 被 nfo 改写）-> 重入队刷新
def s2():
    sid = "502"
    SCENE_STATE[sid] = {"id": sid, "title": JP_B, "details": JP_D}
    write_task(sid, 1234.0, JP_T, JP_D)
    m.handle_hook(hook_payload(sid))
    t = read_task(sid)
    check(t["enqueued_at"] > 1234.0, "different snapshot must refresh enqueued_at, got %r" % t["enqueued_at"])
    check(t["title_snapshot"] == JP_B, "snapshot must be updated, got %r" % t)

# S3. 旧格式任务文件（无快照）-> 兼容：刷新一次并补写快照
def s3():
    sid = "503"
    SCENE_STATE[sid] = {"id": sid, "title": JP_T, "details": JP_D}
    write_task(sid, 1234.0)  # 无快照字段（v1.2.2 及更早格式）
    m.handle_hook(hook_payload(sid))
    t = read_task(sid)
    check(t["enqueued_at"] > 1234.0, "old-format task must be refreshed once, got %r" % t["enqueued_at"])
    check("title_snapshot" in t and "details_snapshot" in t,
          "old-format task must gain snapshot fields, got %r" % t)

# S4. enqueue_task 写快照字段；旧签名（无快照参数）写空快照
def s4():
    m.enqueue_task({}, "504", JP_T, JP_D)
    t = read_task("504")
    check(t["scene_id"] == "504" and "enqueued_at" in t, "bad task %r" % t)
    check(t["title_snapshot"] == JP_T and t["details_snapshot"] == JP_D, "bad snapshot %r" % t)
    m.enqueue_task({}, "505")  # 旧调用签名兼容
    t2 = read_task("505")
    check(t2["title_snapshot"] == "" and t2["details_snapshot"] == "",
          "old-signature must write empty snapshot, got %r" % t2)

# S5. pending_task_matches 直接判定
def s5():
    write_task("601", 1.0, JP_T, JP_D)
    check(m.pending_task_matches("601", JP_T, JP_D) is True, "same snapshot must match")
    check(m.pending_task_matches("601", JP_B, JP_D) is False, "different title must not match")
    check(m.pending_task_matches("601", JP_T, "") is False, "different details must not match")
    write_task("602", 1.0)  # 旧格式
    check(m.pending_task_matches("602", JP_T, JP_D) is False, "old-format must not match (refresh once)")
    check(m.pending_task_matches("603", JP_T, JP_D) is False, "missing file must not match")


# ═══ 优化 2：google_free 逐 q 翻译 ════════════════════════════════════════════

_TR = {
    "TESC-100 タイトル": "场景测试标题中文",
    "詳細テスト": "详细测试中文",
}

class FakeResp:
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self):
        return self.body.encode("utf-8")

def make_fake_urlopen(calls):
    def fake(req, timeout=15):
        q = parse_qs(urlparse(req.full_url).query)["q"][0]
        calls.append(q)
        tr = _TR.get(q, "中文" + q)
        return FakeResp(json.dumps([[[tr, q, None, None]], "auto", "zh-CN"]))
    return fake

# G1. 多 q -> 逐 q 请求、按序返回各 q 译文
def g1():
    calls = []
    orig = m.urlopen
    m.urlopen = make_fake_urlopen(calls)
    try:
        out = m.google_free_translate_multi(["TESC-100 タイトル", "詳細テスト"], "zh-CN")
    finally:
        m.urlopen = orig
    check(out == ["场景测试标题中文", "详细测试中文"],
          "multi-q must translate each text in order, got %r" % out)
    check(calls == ["TESC-100 タイトル", "詳細テスト"],
          "must issue one request per q, got %r" % calls)

# G2. 空响应 -> 返回原文
def g2():
    orig = m.urlopen
    m.urlopen = lambda req, timeout=15: FakeResp("null")
    try:
        out = m.google_free_translate_multi(["ABC-123"], "zh-CN")
    finally:
        m.urlopen = orig
    check(out == ["ABC-123"], "empty response must fall back to original, got %r" % out)

# G3. 持续失败 -> 3 次重试后抛 TranslateError
def g3():
    def boom(req, timeout=15):
        raise OSError("boom")
    orig = m.urlopen
    m.urlopen = boom
    try:
        try:
            m.google_free_translate_multi(["X"], "zh-CN")
            check(False, "expected TranslateError")
        except m.TranslateError as e:
            check("Google free" in str(e), "unexpected error: %r" % e)
    finally:
        m.urlopen = orig

# G4. title+details 同时需翻译 -> 端到端写回两条字段
def g4():
    class FakeGql:
        def __init__(self, scene_state):
            self.scene_state = scene_state
            self.writes = []
        def __call__(self, query, variables=None, timeout=90):
            if "findScene" in query and "findScenes" not in query:
                return {"findScene": self.scene_state}
            if "sceneUpdate" in query:
                self.writes.append(variables["i"])
                return {"sceneUpdate": {"id": variables["i"]["id"]}}
            raise AssertionError("unexpected query: " + query[:80])
    calls = []
    orig_url = m.urlopen
    orig_prot = m.protect_codes
    orig_find = m.find_scene
    m.urlopen = make_fake_urlopen(calls)
    m.protect_codes = lambda text, pat: (text, [])
    m.find_scene = real_find_scene
    try:
        settings = dict(m.DEFAULTS)
        settings["targetLanguage"] = "zh-CN"
        settings["minLength"] = 4
        settings["translateTool"] = "google_free"
        g = FakeGql({"id": "41", "title": "TESC-100 タイトル", "details": "詳細テスト"})
        r = m.translate_entity(g, "scene", "41", "TESC-100 タイトル", "詳細テスト",
                               settings, {}, m.RateLimiter(1000))
        check(r == {"title": "场景测试标题中文", "details": "详细测试中文"},
              "both fields must be written, got %r" % r)
        check(len(g.writes) == 1
              and g.writes[0].get("title") == "场景测试标题中文"
              and g.writes[0].get("details") == "详细测试中文",
              "bad write %r" % g.writes)
        check(len(calls) == 2, "expected 2 per-q requests, got %r" % calls)
    finally:
        m.urlopen = orig_url
        m.protect_codes = orig_prot
        m.find_scene = orig_find


# ═══ 优化 3：needs_translation zh 分支组合判据 ════════════════════════════════

m.needs_translation = real_needs_translation  # 恢复真实实现（S 组曾打桩为恒 True）

# Z1. 混合标题汉字占优 -> 跳过（False）
def z1():
    check(m.needs_translation("SSIS-200 美少女 と温泉旅行", "zh-CN", CODE, 4) is False,
          "hanzi-dominant mixed must skip")
    check(m.needs_translation("美少女 と温泉旅行", "zh-CN", CODE, 4) is False,
          "hanzi-dominant mixed (no code) must skip")

# Z2. 假名占优 / 纯日文 -> 翻译（True）
def z2():
    check(m.needs_translation("ABP-551 園田みおん なまなかだし 14", "zh-CN", CODE, 4) is True,
          "kana-dominant mixed must translate")
    check(m.needs_translation("なまなかだし 14", "zh-CN", CODE, 4) is True,
          "pure kana must translate")
    check(m.needs_translation("テスト詳細", "zh-CN", CODE, 4) is True,
          "kana-dominant must translate")

# Z3. 纯中文（含番号前缀）-> 跳过（False）
def z3():
    check(m.needs_translation("ABP-551 美少女", "zh-CN", CODE, 4) is False,
          "pure hanzi with code must skip")
    check(m.needs_translation("美少女温泉旅行", "zh-CN", CODE, 4) is False,
          "pure hanzi must skip")

# Z4. 边界：汉字==假名 -> True；番号前缀不影响判定；details 同理
def z4():
    check(m.needs_translation("夫の目の前で", "zh-CN", CODE, 4) is True,
          "hanzi==kana must translate")
    check(m.needs_translation("ABP-551 美少女 と", "zh-CN", CODE, 4) is False,
          "code prefix must not flip hanzi-dominant verdict")
    check(m.needs_translation("詳細です", "zh-CN", CODE, 4) is True,
          "details-style hanzi==kana must translate")
    check(m.needs_translation("測試詳細", "zh-CN", CODE, 4) is False,
          "details-style pure hanzi must skip")

# Z5. 其他目标语言分支不受影响
def z5():
    check(m.needs_translation("美少女温泉旅行", "ja", CODE, 4) is True,
          "ja target must still translate hanzi text")
    check(m.needs_translation("Beautiful Girl", "zh-CN", CODE, 4) is True,
          "en text must translate for zh target")
    check(m.needs_translation("美少女", "zh-TW", CODE, 4) is False,
          "zh-TW target must skip pure hanzi")


run("S1 same-snapshot keeps enqueued_at", s1)
run("S2 different-snapshot refreshes", s2)
run("S3 old-format task refreshed once", s3)
run("S4 enqueue_task writes snapshot", s4)
run("S5 pending_task_matches verdicts", s5)
run("G1 per-q requests in order", g1)
run("G2 empty response falls back", g2)
run("G3 failure raises TranslateError", g3)
run("G4 title+details both written back", g4)
run("Z1 hanzi-dominant mixed skipped", z1)
run("Z2 kana-dominant/pure-ja translated", z2)
run("Z3 pure hanzi (with code) skipped", z3)
run("Z4 boundary samples", z4)
run("Z5 other targets unaffected", z5)

for s, n in results:
    print(f"{s}  {n}")
if any(s == "FAIL" for s, _ in results):
    sys.exit(1)
print("ALL PASS")
