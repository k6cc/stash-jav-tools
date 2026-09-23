# -*- coding: utf-8 -*-
"""交叉冲突/循环评估：nfoSceneParser v1.7.0 兜底 vs javstashAutofill+ v1.2.4 兜底
背景：两插件都监听 Scene.Create.Post（javstashAutofill+ 延迟 20s 填充），
且都依赖 tagMergeAuto 的 Tag.Create.Post 合并 + 各自的 tagCreate 失败兜底。
验证：同一 tag 名交替交给两个插件处理，统计 tagCreate mutation 是否收敛。
  未落盘源名：nfo 1 次 tagCreate（失败被钩子合并）→ 兜底命中规范 id；auto 预查命中 0 mutation
  已落盘后：两插件各轮 0 mutation（nfo T0 双 pass / auto 预查命中）→ 幂等收敛，无循环
用法：python test_cross_plugin_no_loop.py [插件目录]
依赖：测试库在线 + Tag Merge Auto 启用 + tag_merge_map.json。
"""
import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
STASH_JAV_TOOLS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TESTKIT = os.path.join(STASH_JAV_TOOLS, "stash-testkit")
PLUGIN_DIR = sys.argv[1] if len(sys.argv) > 1 else r"E:\stashAPP\plugins\k6cc\nfoSceneParser"
AUTOFILL_DIR = os.path.join(STASH_JAV_TOOLS, "javstashAutofill+")
for p in (PLUGIN_DIR, TESTKIT, AUTOFILL_DIR):
    if p not in sys.path:
        sys.path.insert(0, p)

from stash_client import Stash
from stashInterface import StashInterface
from nfoSceneParser import NfoSceneParser
import javstash_autofill_plus as autofill

stash = Stash()

# ---- 包装 gql：计数 auto 侧 mutation + 提供 data 层返回（模仿插件 __gql_call 语义）----
stats = {"mutations": 0, "queries": 0}
def gql(q, v=None):
    res = stash.gql(q, v or {})
    if "mutation" in q.lower():
        stats["mutations"] += 1
    else:
        stats["queries"] += 1
    if res.get("errors"):
        return None
    return res.get("data")

# ---- nfoSceneParser 实例（真库 StashInterface），并精确计数其 tagCreate/findTags ----
from urllib.parse import urlparse
cfg = json.load(open(os.path.join(TESTKIT, "config.json"), "r", encoding="utf-8"))
u = urlparse(cfg["api_url"])
fragment = {
    "args": {"mode": "normal", "hookContext": {"type": "Scene.Create.Post", "id": "0"}},
    "server_connection": {"Host": u.hostname, "Port": u.port, "Scheme": u.scheme,
                          "ApiKey": cfg["api_key"], "PluginDir": cfg["plugin_dir"]},
}
si = StashInterface(fragment)
nfo = NfoSceneParser(si)
orig_create = si.gql_tagCreate
orig_find = si.gql_findTags
nfo_stats = {"tagCreate": 0, "findTags": 0}
def cnt_create(name):
    nfo_stats["tagCreate"] += 1
    return orig_create(name)
def cnt_find(name=None):
    nfo_stats["findTags"] += 1
    return orig_find(name)
si.gql_tagCreate = cnt_create
si.gql_findTags = cnt_find

import io as _io, sys as _sys
def nfo_process(tag_name):
    nfo._file_data = {"tags": [tag_name], "title": "TST-CROSS"}
    buf = _io.StringIO(); old = _sys.stderr; _sys.stderr = buf
    try:
        ids = nfo._NfoSceneParser__find_create_tags()
    finally:
        _sys.stderr = old
    return ids, buf.getvalue()

def auto_process(tag_name):
    return autofill.find_or_create_tag(gql, tag_name)

# ---- 选目标名：优先未落盘映射源名；全落盘时用已落盘名（幂等路径）----
tags = stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"]
sm = [t for t in tags if t["name"] == "SM"]
if not sm:
    print("库中无 SM tag，终止"); sys.exit(1)
sm = sm[0]
by_name = {t["name"] for t in tags}
alias_set = {a for t in tags for a in (t.get("aliases") or [])}
mapping = json.loads(open(os.path.join(STASH_JAV_TOOLS, "tagMergeAuto", "tag_merge_map.json"), "rb").read().decode("utf-8"))
cand = None
for tgt, v in mapping.items():
    if tgt.startswith("_") or tgt != "SM":
        continue
    srcs = v if isinstance(v, list) else (v.get("sources", []) if isinstance(v, dict) else [])
    for s in srcs:
        if s != tgt and s not in by_name and s not in alias_set:
            cand = s; break
    if cand: break
name = cand or "SM拘束"  # 已落盘回退名
print("SM id:", sm["id"], "aliases:", sm.get("aliases"))
print(f"目标名: {name} | 落盘状态: name={'是' if name in by_name else '否'} alias={'是' if name in alias_set else '否'}")

sm_id = str(sm["id"])
all_ok = True
for round_i in range(1, 4):
    ids, logtxt = nfo_process(name)
    r = auto_process(name)
    hit = (ids == [sm_id]) and (str(r) == sm_id)
    all_ok = all_ok and hit
    print(f"轮{round_i}: nfo={ids} auto={r} 命中规范id={hit} "
          f"nfo_tagCreate={nfo_stats['tagCreate']} nfo_findTags={nfo_stats['findTags']} auto_mutation={stats['mutations']}")
    if round_i == 1:
        print(f"  轮1 nfo 走兜底: {'是' if 'create-fallback' in logtxt else '否(直接命中)'}")

m_total = stats["mutations"] + nfo_stats["tagCreate"]
print(f"\n3 轮后两插件 mutation 合计: {m_total}（未落盘首次 ≤2，此后 0 → 收敛）")
print(f"全部命中规范 id {sm_id}: {'PASS' if all_ok else 'FAIL'}")
print(f"收敛（第2轮起无新增 mutation）: {'PASS' if (nfo_stats['findTags'] >= 2 and m_total <= 2) else 'FAIL'}")

after = stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"]
sm2 = [t for t in after if t["name"] == "SM"][0]
dup = [t for t in after if t["name"] == name]
print(f"事后 SM aliases: {sm2.get('aliases')}")
print(f"独立 {name} tag: {'存在!' if dup else '无（已合并删除）'}")
