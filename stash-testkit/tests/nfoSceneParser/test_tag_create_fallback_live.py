# -*- coding: utf-8 -*-
"""真库实测兜底分支：真实触发 tagCreate → Tag.Create.Post 钩子合并 → None → 兜底重拉命中
关键经验：真库验证兜底分支必须选「映射表有、库中 name/alias 均无」的源名，
否则 T0 全量时双 pass 已命中，根本走不到 tagCreate（如 ギャル 别名早已落盘 → 正常路径）。
运行需满足：测试库 Stash 在线 + Tag Merge Auto 插件启用 + tag_merge_map.json 存在。
用法：python test_tag_create_fallback_live.py [插件目录]"""
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

# 1. 读映射表（tagMergeAuto 的 key→sources 映射）
MAP_PATH = os.path.join(STASH_JAV_TOOLS, "tagMergeAuto", "tag_merge_map.json")
raw = open(MAP_PATH, "rb").read()
mapping = json.loads(raw.decode("utf-8"))

# 2. 库中 tag 现状
tags = stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"]
by_name = {t["name"]: t for t in tags}
all_alias = set()
for t in tags:
    for a in (t.get("aliases") or []):
        all_alias.add(a)

# 3. 找候选：目标在库中、源名不在库中 name/alias
cands = []
for tgt, v in mapping.items():
    if tgt.startswith("_") or tgt not in by_name:
        continue
    srcs = v if isinstance(v, list) else (v.get("sources", []) if isinstance(v, dict) else [])
    for s in srcs:
        if s != tgt and s not in by_name and s not in all_alias:
            cands.append((tgt, s))
print(f"候选 (目标在库中, 源名未落盘): {len(cands)}")
for tgt, s in cands[:15]:
    print(f"  {tgt} (id={by_name[tgt]['id']}) <- {s}")

if not cands:
    print("无候选，终止"); sys.exit(1)
tgt, src = cands[0]
tgt_id = by_name[tgt]["id"]
print(f"\n选用: {tgt} (id={tgt_id}) <- {src}")

# 4. 构造真实 StashInterface + parser，触发 __find_create_tags
from urllib.parse import urlparse
cfg_path = os.path.join(TESTKIT, "config.json")
cfg = json.load(open(cfg_path, "r", encoding="utf-8"))
u = urlparse(cfg["api_url"])
fragment = {
    "args": {"mode": "normal", "hookContext": {"type": "Scene.Create.Post", "id": "0"}},
    "server_connection": {"Host": u.hostname, "Port": u.port, "Scheme": u.scheme,
                          "ApiKey": cfg["api_key"], "PluginDir": cfg["plugin_dir"]},
}
si = StashInterface(fragment)
parser = NfoSceneParser(si)
parser._file_data = {"tags": [src], "title": "TST-FALLBACK-LIVE"}

import io as _io, sys as _sys
buf = _io.StringIO()
old = _sys.stderr
_sys.stderr = buf
try:
    ids = parser._NfoSceneParser__find_create_tags()
finally:
    _sys.stderr = old
logtxt = buf.getvalue()
print(f"\n返回 tag_ids: {ids}")
print(f"期望含 {tgt_id}: {'PASS' if tgt_id in ids else 'FAIL'}")
print(f"日志含 create-fallback: {'PASS' if 'create-fallback' in logtxt else 'FAIL'}")
for line in logtxt.splitlines():
    if any(k in line for k in ("create-fallback", "Matched", "Created", "GraphQL", "Error")):
        print("  LOG:", line.strip()[:160])

# 5. 状态检查：源名现在应成为目标的别名；无独立源名 tag（已合并删除）
after = stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"]
t_after = [t for t in after if str(t["id"]) == str(tgt_id)]
print(f"\n目标 {tgt} 现状 aliases: {t_after[0].get('aliases') if t_after else 'NOT FOUND'}")
dup = [t for t in after if t["name"] == src]
print(f"独立 {src} tag: {'存在!' if dup else '无（已合并删除）'}")
