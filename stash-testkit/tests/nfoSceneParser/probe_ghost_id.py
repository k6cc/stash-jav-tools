# -*- coding: utf-8 -*-
"""幽灵 id 边界验证（stash-client 直发原始 GraphQL，绕过插件层）
问题：tagCreate 响应带回数据（含 id）但 tag 已被 Tag.Create.Post 钩子合并删除 → 幽灵 id？
实验：
  A. 首次创建的映射源名（如 轻虐 → SM）：钩子合并后，mutation 原始响应是什么？
  B. 已合并名再次创建（如 SM拘束 → 已是 SM 别名）：响应是什么？
对照：
  C. 非映射源名（钩子不合并）：响应应带真实 id（可用本套件 success_regression 复验）
v0.31.1 实测结论：A 返回 data.tagCreate=null（无 errors），B 返回 errors + null，
均不带 id → 幽灵 id 不存在。跨 Stash 版本需重跑本脚本确认。
用法：python probe_ghost_id.py
"""
import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
STASH_JAV_TOOLS = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
TESTKIT = os.path.join(STASH_JAV_TOOLS, "stash-testkit")
if TESTKIT not in sys.path:
    sys.path.insert(0, TESTKIT)
from stash_client import Stash

stash = Stash()

# 0. 版本信息
try:
    ver = stash.call("{ version { version } }")
    print("Stash 版本:", ver.get("version"))
except Exception as e:
    print("查版本失败:", e)

# 1. 库中现状
tags = stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"]
by_name = {t["name"]: t for t in tags}
all_alias = set()
for t in tags:
    for a in (t.get("aliases") or []):
        all_alias.add(a)
sm = by_name.get("SM")
print(f"\nSM tag: {sm}")
print(f"轻虐 在库中 name/alias? name={'轻虐' in by_name}, alias={'轻虐' in all_alias}")

# 2. 读映射表，确认 轻虐 是 SM 的源名
MAP_PATH = os.path.join(STASH_JAV_TOOLS, "tagMergeAuto", "tag_merge_map.json")
mapping = json.loads(open(MAP_PATH, "rb").read().decode("utf-8"))
sm_sources = mapping.get("SM", [])
print(f"映射表 SM 源名数: {len(sm_sources)}，含 轻虐: {'轻虐' in sm_sources}")

MUT = """mutation($i: TagCreateInput!){ tagCreate(input:$i){ id name } }"""

def try_create(name):
    """发原始 tagCreate，返回 (原始响应dict, 是否带数据, data.id)"""
    res = stash.gql(MUT, {"i": {"name": name}})
    data = res.get("data") or {}
    tc = data.get("tagCreate")
    return res, tc is not None, (tc or {}).get("id") if tc else None

print("\n========== 实验 A：首次创建的映射源名 轻虐（钩子将合并） ==========")
resA, hasDataA, idA = try_create("轻虐")
print("原始响应 JSON:")
print(json.dumps(resA, ensure_ascii=False, indent=2))
if idA:
    alive = stash.call(f'query($id: ID!){{ findTag(id:$id){{ id name }} }}', {"id": str(idA)}).get("findTag")
    print(f"响应带 id={idA} → findTag 存活? {alive}")
else:
    print("响应未带 id（data.tagCreate 为空或 errors）→ 无幽灵 id")

print("\n========== 实验 B：已合并名再次创建 SM拘束（已是 SM 别名） ==========")
resB, hasDataB, idB = try_create("SM拘束")
print("原始响应 JSON:")
print(json.dumps(resB, ensure_ascii=False, indent=2))
if idB:
    alive = stash.call(f'query($id: ID!){{ findTag(id:$id){{ id name }} }}', {"id": str(idB)}).get("findTag")
    print(f"响应带 id={idB} → findTag 存活? {alive}")
else:
    print("响应未带 id → 无幽灵 id")

# 3. 事后状态（实验 A 会把 轻虐 合并进 SM aliases —— 测试库可接受的副作用）
sm_after = [t for t in stash.call("{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }")["findTags"]["tags"] if t["name"] == "SM"]
print("\n事后 SM aliases:", sm_after[0].get("aliases") if sm_after else "N/A")
