# -*- coding: utf-8 -*-
"""nfoSceneParser tagCreate 失败兜底 —— 离线单测套件（+ 真库正常路径）
验证内容（对齐 v1.7.0 / javstashAutofill+ v1.2.4 语义）：
  A. 已合并名（真实时序：T0 miss → tagCreate None + 钩子写别名 → 兜底重拉命中规范 id）
  B. 全新名（tagCreate 成功 → 原逻辑，findTags 仅 1 次，无兜底重拉）
  C. 真不存在名（None + 重拉无命中 → 静默跳过、不中断）
  D. 已有 tag 双 pass 命中（不触发 tagCreate、findTags 仅 1 次 —— 回归）
  E. dry_mode 拦截（回归）
  live: 真库正常路径命中（如 ギャル → 210 双 pass alias 命中）

用法：
  python test_tag_create_fallback.py offline [插件目录]
  python test_tag_create_fallback.py live [插件目录]
插件目录默认部署副本 E:/stashAPP/plugins/k6cc/nfoSceneParser；传仓库目录可对仓库版验证。
"""
import sys, io, os, json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
STASH_JAV_TOOLS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TESTKIT = os.path.join(STASH_JAV_TOOLS, "stash-testkit")
PLUGIN_DIR = sys.argv[2] if len(sys.argv) > 2 else r"E:\stashAPP\plugins\k6cc\nfoSceneParser"
for p in (PLUGIN_DIR, TESTKIT):
    if p not in sys.path:
        sys.path.insert(0, p)

import config
import log
from nfoSceneParser import NfoSceneParser

# ---------- 工具：捕获插件日志（log.py 写 stderr，SOH/STX 前缀） ----------
class LogCapture:
    def __init__(self):
        self.lines = []
        self._orig_stderr = sys.stderr
    def __enter__(self):
        sys.stderr = self
        return self
    def __exit__(self, *a):
        sys.stderr = self._orig_stderr
    def write(self, s):
        self.lines.append(s)
        return len(s)
    def flush(self):
        pass
    def has(self, substr):
        return any(substr in l for l in self.lines)

# ---------- Part 1: 离线单测 ----------
class FakeStash:
    def __init__(self, tags, tag_create_result, mutate_on_create=None):
        self.tags = tags
        self.tag_create_result = tag_create_result
        self.mutate_on_create = mutate_on_create
        self.findTags_calls = 0
        self.tagCreate_calls = 0
    def get_mode(self):
        return "normal"
    def gql_findTags(self, name=None):
        self.findTags_calls += 1
        return {"tags": self.tags}
    def gql_tagCreate(self, name):
        self.tagCreate_calls += 1
        if self.mutate_on_create:
            self.mutate_on_create(name)  # 模拟 Tag.Create.Post 钩子副作用落盘
        return self.tag_create_result

def make_parser(stash, file_tags):
    p = NfoSceneParser(stash)
    p._file_data = {"tags": file_tags, "title": "TST-OFFLINE"}
    return p

def run_offline():
    ok = True
    def check(name, cond, detail=""):
        nonlocal ok
        tag = "PASS" if cond else "FAIL"
        if not cond:
            ok = False
        print(f"  [{tag}] {name} {detail}")

    base_tags = [
        {"id": "1", "name": "HD", "aliases": []},
        {"id": "210", "name": "辣妹", "aliases": ["ギャル"]},
        {"id": "3", "name": "VR", "aliases": ["VR专用"]},
    ]

    # 场景 A：已合并名 → T0 双 pass miss → tagCreate 返回 None（钩子已合并写别名）→ 兜底命中 210
    # 真实时序：T0 全量时 ギャル 还不是别名；tagCreate 触发的 Tag.Create.Post 钩子把源名写进
    # 辣妹 aliases 后 mutation 才返回 None；兜底重拉时别名已落盘 → 命中 210
    print("[A] 已合并名（tagCreate=None，钩子写别名后兜底命中 210）")
    pre_tags = [
        {"id": "1", "name": "HD", "aliases": []},
        {"id": "210", "name": "辣妹", "aliases": []},
        {"id": "3", "name": "VR", "aliases": ["VR专用"]},
    ]
    def merge_hook(stash, name):
        for t in stash.tags:
            if t["name"] == "辣妹" and name not in (t.get("aliases") or []):
                t["aliases"] = (t.get("aliases") or []) + [name]
    with LogCapture() as cap:
        s = FakeStash(pre_tags, None, mutate_on_create=lambda n: merge_hook(s, n))
        p = make_parser(s, ["ギャル"])
        ids = p._NfoSceneParser__find_create_tags()
    check("兜底命中 210", ids == ["210"], f"ids={ids}")
    check("触发 tagCreate", s.tagCreate_calls == 1)
    check("重拉全量(共2次 findTags)", s.findTags_calls == 2, f"calls={s.findTags_calls}")
    check("日志含 create-fallback", cap.has("create-fallback"), f"log={cap.lines[:2]}")

    # 场景 B：全新名 → tagCreate 返回 id → 原逻辑，不多查
    print("[B] 全新名（tagCreate 返回新 id）")
    with LogCapture() as cap:
        s = FakeStash(base_tags, {"id": "999"})
        p = make_parser(s, ["全新标签XYZ"])
        ids = p._NfoSceneParser__find_create_tags()
    check("使用新 id 999", ids == ["999"], f"ids={ids}")
    check("findTags 仅 1 次(无兜底重拉)", s.findTags_calls == 1, f"calls={s.findTags_calls}")
    check("日志含 Created missing tags", cap.has("Created missing tags"))

    # 场景 C：真不存在名 → tagCreate None + 重拉无命中 → 跳过、不中断
    print("[C] 真不存在名（tagCreate=None，重拉无命中）")
    with LogCapture() as cap:
        s = FakeStash(base_tags, None)
        p = make_parser(s, ["完全不存在的标签ZZZ"])
        ids = p._NfoSceneParser__find_create_tags()
    check("静默跳过(ids 空)", ids == [], f"ids={ids}")
    check("重拉发生(2次)", s.findTags_calls == 2, f"calls={s.findTags_calls}")
    check("无 create-fallback 日志", not cap.has("create-fallback"))

    # 场景 D：已有 tag 双 pass 命中 → 不触发 tagCreate，findTags 仅 1 次（回归）
    print("[D] 已有 tag 直接命中（辣妹 name 命中 210）")
    with LogCapture() as cap:
        s = FakeStash(base_tags, None)
        p = make_parser(s, ["辣妹"])
        ids = p._NfoSceneParser__find_create_tags()
    check("命中 210", ids == ["210"], f"ids={ids}")
    check("未触发 tagCreate", s.tagCreate_calls == 0)
    check("findTags 仅 1 次", s.findTags_calls == 1, f"calls={s.findTags_calls}")

    # 场景 E：blacklist/dry_mode 拦截不变（回归）
    print("[E] dry_mode 拦截（回归）")
    orig_dry = config.dry_mode
    config.dry_mode = True
    try:
        s = FakeStash(base_tags, None)
        p = make_parser(s, ["全新标签YYY"])
        ids = p._NfoSceneParser__find_create_tags()
        check("dry_mode 下跳过", ids == [] and s.tagCreate_calls == 0, f"ids={ids}, tagCreate={s.tagCreate_calls}")
    finally:
        config.dry_mode = orig_dry

    print(f"\n离线单测结果: {'全部通过' if ok else '存在失败'}")
    return ok

# ---------- Part 2: 真库正常路径（回归：已合并名别名落盘时走双 pass 命中） ----------
def run_live():
    from stash_client import load_config
    from stashInterface import StashInterface
    from urllib.parse import urlparse

    cfg = load_config()
    u = urlparse(cfg["api_url"])
    fragment = {
        "args": {"mode": "normal", "hookContext": {"type": "Scene.Create.Post", "id": "0"}},
        "server_connection": {"Host": u.hostname, "Port": u.port, "Scheme": u.scheme,
                              "ApiKey": cfg["api_key"], "PluginDir": cfg["plugin_dir"]},
    }
    stash = StashInterface(fragment)
    parser = NfoSceneParser(stash)
    parser._file_data = {"tags": ["ギャル"], "title": "TST-FALLBACK-VERIFY"}

    print("[LIVE] 真库正常路径：file_tag=ギャル（别名已落盘）→ 双 pass 命中 辣妹 id=210")
    with LogCapture() as cap:
        ids = parser._NfoSceneParser__find_create_tags()
    print(f"  返回 tag_ids: {ids}")
    assert "210" in ids, f"FAIL: 未命中 210, ids={ids}"
    assert not cap.has("create-fallback"), "FAIL: 正常路径不应走兜底"
    print("[LIVE] 通过（正常双 pass 命中，无兜底）")

if __name__ == "__main__":
    part = sys.argv[1] if len(sys.argv) > 1 else "offline"
    ok = True
    if part in ("all", "offline"):
        ok = run_offline()
    if part in ("all", "live"):
        run_live()
    sys.exit(0 if ok else 1)
