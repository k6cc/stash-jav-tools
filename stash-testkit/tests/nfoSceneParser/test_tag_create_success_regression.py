# -*- coding: utf-8 -*-
"""真库回归：全新名 tagCreate 成功 → 原逻辑（findTags 仅 1 次、无兜底、无额外重拉），测试后清理
验证验收标准 3：兜底重拉只发生在失败路径，成功路径查询次数与改动前完全一致。
用法：python test_tag_create_success_regression.py [插件目录]
"""
import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
STASH_JAV_TOOLS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TESTKIT = os.path.join(STASH_JAV_TOOLS, "stash-testkit")
PLUGIN_DIR = sys.argv[1] if len(sys.argv) > 1 else r"E:\stashAPP\plugins\k6cc\nfoSceneParser"
for p in (PLUGIN_DIR, TESTKIT):
    if p not in sys.path:
        sys.path.insert(0, p)

from stash_client import Stash
from stashInterface import StashInterface
from nfoSceneParser import NfoSceneParser

stash = Stash()
from urllib.parse import urlparse
cfg = json.load(open(os.path.join(TESTKIT, "config.json"), "r", encoding="utf-8"))
u = urlparse(cfg["api_url"])
fragment = {
    "args": {"mode": "normal", "hookContext": {"type": "Scene.Create.Post", "id": "0"}},
    "server_connection": {"Host": u.hostname, "Port": u.port, "Scheme": u.scheme,
                          "ApiKey": cfg["api_key"], "PluginDir": cfg["plugin_dir"]},
}
si = StashInterface(fragment)

# 计数 gql_findTags 真实调用次数：包一层（验证成功路径无额外重拉）
orig_find = si.gql_findTags
calls = {"n": 0}
def counting_find(name=None):
    calls["n"] += 1
    return orig_find(name)
si.gql_findTags = counting_find

# 名字需避开映射表源名与库中 tag name/alias（用唯一前缀），否则会被钩子合并走兜底
new_name = "TST-FALLBACK-UNIQ-8842"
parser = NfoSceneParser(si)
parser._file_data = {"tags": [new_name], "title": "TST-FALLBACK-SUCCESS"}

import io as _io, sys as _sys
buf = _io.StringIO(); old = _sys.stderr; _sys.stderr = buf
try:
    ids = parser._NfoSceneParser__find_create_tags()
finally:
    _sys.stderr = old
logtxt = buf.getvalue()

print(f"返回 tag_ids: {ids}")
print(f"findTags 调用次数: {calls['n']}（期望 1 = 仅 T0，无兜底重拉）")
print(f"日志含 Created missing tags: {'PASS' if 'Created missing tags' in logtxt else 'FAIL'}")
print(f"日志含 create-fallback（应无）: {'FAIL-出现兜底!' if 'create-fallback' in logtxt else 'PASS'}")

# 验证创建的 tag 真实存在
assert ids and ids[0], "FAIL: 未创建成功"
tid = ids[0]
data = stash.call(f'query($id: ID!){{ findTag(id:$id){{ id name }} }}', {"id": str(tid)})
t = data.get("findTag")
print(f"库中确认新 tag: {t}")

# 清理：删除测试 tag（不留残留）
if t and t.get("id"):
    stash.call("mutation($i: TagDestroyInput!){ tagDestroy(input:$i) }", {"i": {"id": str(t["id"])}})
    after = stash.call('query($id: ID!){ findTag(id:$id){ id name } }', {"id": str(t["id"])})
    print(f"清理后 findTag: {after.get('findTag')}（None=已删除）")

ok = (calls["n"] == 1) and ("create-fallback" not in logtxt) and ("Created missing tags" in logtxt)
print(f"\n真库成功路径回归: {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
