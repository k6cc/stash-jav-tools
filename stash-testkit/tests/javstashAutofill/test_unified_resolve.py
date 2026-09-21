# -*- coding: utf-8 -*-
"""离线单测：统一演员解析决策树（mock gql，不连 Stash/javstash）。

覆盖回归验证矩阵的可离线部分：
  1. find_by_name 防重复：主名命中优先 / 别名命中 / exclude_id 排除 / norm 宽容
  2. find_by_stash_id 反查：endpoint+stash_id 端侧精确比对 / exclude / 无命中
  3. resolve_performer：有 rid 反查命中->复用 / 未命中->create 带 stash_ids / 无 rid->name/alias 复用或新建
  4. fill_performer stash-id 分支：反查命中->merge（别名追加）/ 未命中->直抓补全（保留主名）
  5. fill_performer 0.9 分支：dup 有异 id->保守忽略 / dup 无 id 或同 id->merge / 无 dup->keep-name+挂 id
  6. build_update：候选名/别名追加、主名保留、空值保护
"""
import os, sys, types, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
import javstash_autofill_plus as M

PASS = []
FAIL = []
def check(name, cond, extra=""):
    if cond: PASS.append(name)
    else:
        FAIL.append(name + (" :: " + str(extra) if extra else ""))
        print("FAIL:", name, extra)

JAV = "https://javstash.org/graphql"

# ---------------- fake gql ---------------- 
class FakeGQL:
    """Queryable fake: routes by marker substrings."""
    def __init__(self, performers=None):
        self.performers = performers or []      # list of dicts (id/name/alias_list/stash_ids)
        self.created = []
        self.updated = {}
        self.merged = []
        self.fetch_cands = {}                    # stash_id -> cand dict (for fetch_performer_by_id)
        self.scrape_cands = {}                   # name -> [(score_name, cand)] top candidate
        self.api_keys = {JAV: "k-test"}
    def _findPerformers(self):
        return {"findPerformers": {"performers": self.performers}}
    def _findByStashFilter(self, ep, sids):
        out = []
        for p in self.performers:
            ps = [s for s in (p.get("stash_ids") or []) if s.get("endpoint") == ep and s.get("stash_id") in sids]
            if ps: out.append(p)
        return {"findPerformers": {"performers": out}}
    def __call__(self, query, variables=None, timeout=30):
        variables = variables or {}
        if "findPerformers" in query:
            if "stash_ids_endpoint" in query:
                return self._findByStashFilter(variables.get("e"), variables.get("s") or [])
            return self._findPerformers()
        if "findPerformerByID" in query:
            sid = variables.get("id")
            c = self.fetch_cands.get(sid)
            return {"data": {"findPerformerByID": c}} if c is not None else {"data": {"findPerformerByID": None}, "errors": [{"message": "not found"}]}
        if "configuration" in query:
            return {"configuration": {"stashBoxes": [{"endpoint": JAV, "api_key": self.api_keys.get(JAV, "k-test")}], "general": {}}}
        if "findPerformer(" in query:
            pid = variables.get("id")
            for p in self.performers:
                if str(p["id"]) == str(pid):
                    return {"findPerformer": p}
            return {"findPerformer": None}
        if "performerCreate" in query:
            inp = variables.get("i") or {}
            pid = "new-%d" % (len(self.created) + 1)
            rec = {"id": pid, "name": inp.get("name"), "alias_list": list(inp.get("alias_list") or []),
                   "stash_ids": list(inp.get("stash_ids") or [])}
            self.created.append(rec)
            self.performers.append(rec)
            return {"performerCreate": {"id": pid}}
        if "performerUpdate" in query:
            inp = variables.get("i") or {}
            self.updated[inp.get("id")] = inp
            for p in self.performers:
                if str(p["id"]) == str(inp.get("id")):
                    for k, v in inp.items():
                        if k != "id": p[k] = v
            return {"performerUpdate": {"id": inp.get("id")}}
        if "performerMerge" in query:
            inp = variables.get("i") or {}
            self.merged.append(inp)
            src = [str(s) for s in inp.get("source") or []]
            dst = str(inp.get("destination"))
            vals = inp.get("values") or {}
            keep = None
            for p in self.performers:
                if str(p["id"]) == dst: keep = p
            self.performers = [p for p in self.performers if str(p["id"]) not in src]
            if keep is not None:
                for k, v in vals.items():
                    if k != "id": keep[k] = v
            return {"performerMerge": {"id": dst}}
        if "scrapeSinglePerformer" in query:
            name = (variables.get("i") or {}).get("query") or ""
            c = self.scrape_cands.get(name)
            return {"scrapeSinglePerformer": [c] if c else []}
        raise AssertionError("unexpected query: " + query[:120])

def make_cand(name, rid=None, aliases=None, **kw):
    c = {"name": name, "aliases": aliases or [], "gender": kw.get("gender", "FEMALE"),
         "birthdate": kw.get("birthdate", "1990-01-01"), "urls": kw.get("urls", []),
         "measurements": kw.get("measurements", ""), "images": kw.get("images", [])}
    if rid: c["remote_site_id"] = rid
    return c

# 直抓通道在网络层（单测 mock 掉；e2e 验证真实 javstash）
def _fake_fetch(gql, endpoint, stash_id):
    return gql.fetch_cands.get(stash_id)
M.fetch_performer_by_id = _fake_fetch

# ================= 1. find_by_name 防重复 =================
g = FakeGQL(performers=[
    {"id": "1", "name": "三上悠亜", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "a"}]},
    {"id": "2", "name": "Other", "alias_list": ["三上悠亚"], "stash_ids": []},
])
check("find_by_name primary hit", M.find_by_name(g, "三上悠亜", None) == "1")
check("find_by_name alias hit", M.find_by_name(g, "三上悠亚", None) == "2")
check("find_by_name norm tolerance", M.find_by_name(g, " 三上 悠亜 ", None) == "1")
check("find_by_name exclude primary", M.find_by_name(g, "三上悠亜", "1") == None)
check("find_by_name exclude alias", M.find_by_name(g, "三上悠亚", "2") == None)
check("find_by_name miss", M.find_by_name(g, "不存在", None) == None)

# ================= 2. find_by_stash_id 反查 =================
g = FakeGQL(performers=[
    {"id": "10", "name": "A", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "x1"}]},
    {"id": "11", "name": "B", "alias_list": [], "stash_ids": [{"endpoint": "https://stashdb.org/graphql", "stash_id": "x1"}]},
])
check("reverse hit", M.find_by_stash_id(g, JAV, "x1") == "10")
check("reverse endpoint mismatch", M.find_by_stash_id(g, "https://stashdb.org/graphql", "x1") == "11")
check("reverse exclude", M.find_by_stash_id(g, JAV, "x1", exclude_id="10") == None)
check("reverse miss", M.find_by_stash_id(g, JAV, "nope") == None)

# ================= 3. resolve_performer（场景填充） =================
g = FakeGQL(performers=[
    {"id": "20", "name": "三上悠亜", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "rid1"}]},
])
# 有 rid 反查命中 -> 复用
check("resolve reuse by stash-id", M.resolve_performer(g, "三上悠亚", "rid1", JAV) == "20")
# 有 rid 反查未命中 -> create 带 stash_ids
pid = M.resolve_performer(g, "新演员", "rid-new", JAV)
check("resolve create with stash_id", pid is not None and g.created and g.created[-1]["stash_ids"] == [{"endpoint": JAV, "stash_id": "rid-new"}])
# 无 rid -> name/alias 复用
check("resolve reuse by name", M.resolve_performer(g, "三上悠亜", "", JAV) == "20")
# 无 rid -> 新建空演员
before = len(g.performers)
pid2 = M.resolve_performer(g, "无名氏", "", JAV)
check("resolve create blank", pid2 is not None and len(g.performers) == before + 1 and g.created[-1].get("stash_ids") == [])

# ================= 4. fill_performer stash-id 分支 =================
# 4a. 反查命中 -> merge（输入名追加为别名），详情用直抓 cand
g = FakeGQL(performers=[
    {"id": "30", "name": "三上悠亜", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "ridA"}]},
    {"id": "31", "name": "三上悠亚", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "ridA"}]},
])
g.fetch_cands["ridA"] = make_cand("三上悠亜", rid="ridA", gender="FEMALE", birthdate="1995-05-05")
M.fill_performer(g, {}, "31")
check("stash-id hit merged", len(g.merged) == 1 and g.merged[0]["destination"] == "30" and g.merged[0]["source"] == ["31"])
merged_vals = g.merged[0].get("values") or {}
check("stash-id merge keeps dest name", g.performers[0]["name"] == "三上悠亜")
check("stash-id merge appends created name alias", "三上悠亚" in g.performers[0].get("alias_list") or [])
check("stash-id merge fills details", g.performers[0].get("birthdate") == "1995-05-05")
check("stash-id merge keeps stash_ids", any(s["stash_id"] == "ridA" for s in g.performers[0].get("stash_ids") or []))

# 4b. 反查未命中 -> 直抓补全（保留主名）
g = FakeGQL(performers=[
    {"id": "40", "name": "优芽", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "ridB"}]},
])
g.fetch_cands["ridB"] = make_cand("優芽", rid="ridB", aliases=["优芽"], gender="FEMALE", birthdate="1998-08-08")
M.fill_performer(g, {}, "40")
check("stash-id no-hit updated", "40" in g.updated)
upd = g.updated.get("40") or {}
check("stash-id no-hit keeps primary", g.performers[0]["name"] == "优芽")
check("stash-id no-hit alias from cand", any(M.norm(a) == M.norm("優芽") for a in (g.performers[0].get("alias_list") or [])))
check("stash-id no-hit fills details", g.performers[0].get("birthdate") == "1998-08-08")

# ================= 5. fill_performer 0.9 分支 =================
# 5a. dup 有异 stash_id -> 保守忽略（不动）
g = FakeGQL(performers=[
    {"id": "50", "name": "Genjin Moribayashi", "alias_list": [], "stash_ids": [{"endpoint": "https://stashdb.org/graphql", "stash_id": "db1"}]},
])
g.scrape_cands["Genjin Moribayashi"] = make_cand("Genjin Moribayashi", rid="jav-other")
M.fill_performer(g, {}, "51")  # 51 不存在 -> get_performer 返回 None -> skip；构造存在的新演员再测
# 重新构造：pid 51 存在于库中
g.performers.append({"id": "51", "name": "Genjin Moribayashi", "alias_list": [], "stash_ids": []})
M.fill_performer(g, {}, "51")
check("0.9 conservative ignore no merge", len(g.merged) == 0 and "51" not in g.updated)

# 5b. dup 无 stash_id -> merge + 补详情 + 挂候选 id（名字完全一致，0.9 必命中）
g = FakeGQL(performers=[
    {"id": "60", "name": "三上悠亜", "alias_list": [], "stash_ids": []},
])
g.performers.append({"id": "61", "name": "三上悠亜", "alias_list": [], "stash_ids": []})
g.scrape_cands["三上悠亜"] = make_cand("三上悠亜", rid="ridC", gender="FEMALE", birthdate="1996-06-06")
M.fill_performer(g, {}, "61")
check("0.9 dup merge", len(g.merged) == 1 and g.merged[0]["destination"] == "60" and g.merged[0]["source"] == ["61"])
mv = g.merged[0].get("values") or {}
check("0.9 dup merge attaches cand id", any(s.get("stash_id") == "ridC" for s in mv.get("stash_ids") or []))
# 输入名 == 主名时不得重复追加主名进别名（正确行为）
check("0.9 dup merge no self-alias", not any(M.norm(a) == M.norm("三上悠亜") for a in (g.performers[0].get("alias_list") or [])))
# 输入名 != 主名时才追加：候选别名含输入名（javstash 候选常带变体别名）→ 1.0 命中
g2 = FakeGQL(performers=[{"id": "60b", "name": "三上悠亜", "alias_list": [], "stash_ids": []}])
g2.performers.append({"id": "61b", "name": "三上悠亚", "alias_list": [], "stash_ids": []})
g2.scrape_cands["三上悠亚"] = make_cand("三上悠亜", rid="ridC2", aliases=["三上悠亚"], gender="FEMALE")
M.fill_performer(g2, {}, "61b")
check("0.9 dup merge appends created name", len(g2.merged) == 1 and any(M.norm(a) == M.norm("三上悠亚") for a in (g2.performers[0].get("alias_list") or [])))

# 5c. dup 同 stash_id（候选 id == dup 的 id）-> merge（不是保守忽略）
g = FakeGQL(performers=[
    {"id": "70", "name": "Yua Mikami", "alias_list": [], "stash_ids": [{"endpoint": JAV, "stash_id": "ridD"}]},
])
g.performers.append({"id": "71", "name": "Yua Mikami", "alias_list": [], "stash_ids": []})
g.scrape_cands["Yua Mikami"] = make_cand("Yua Mikami", rid="ridD")
M.fill_performer(g, {}, "71")
check("0.9 same-id dup merges", len(g.merged) == 1 and g.merged[0]["destination"] == "70")

# 5d. 无 dup -> keep-name（候选名成别名 + 挂 id；输入=候选名时用别名字变体制造差异）
g = FakeGQL(performers=[])
g.performers.append({"id": "80", "name": "三上悠亜", "alias_list": [], "stash_ids": []})
g.scrape_cands["三上悠亜"] = make_cand("三上悠亜", rid="ridE", gender="FEMALE")
M.fill_performer(g, {}, "80")
check("0.9 no dup keep name", g.performers[0]["name"] == "三上悠亜")
check("0.9 no dup attaches id", any(s.get("stash_id") == "ridE" for s in (g.performers[0].get("stash_ids") or [])))
# 输入名 = 候选名时无别名差异；别名池已有主名 -> 无新增。此用例验证 keep-name 全链路即可。

# ================= 6. build_update 别名/主名/空值 =================
perf = {"id": "90", "name": "主名", "alias_list": ["已有别名"], "urls": ["u1"], "birthdate": "", "gender": None}
cand = make_cand("候选名", aliases=["候选别名"], birthdate="1990-01-01", urls=["u2"])
upd = M.build_update(perf, cand, primary_name="主名", extra_aliases=[], set_name=False, ow={})
check("build_update keeps primary", upd.get("name") is None)
als = upd.get("alias_list") or []
check("build_update appends cand name+alias", M.norm("候选名") in [M.norm(a) for a in als] and M.norm("候选别名") in [M.norm(a) for a in als])
check("build_update keeps existing alias", M.norm("已有别名") in [M.norm(a) for a in als])
check("build_update fills empty only", upd.get("birthdate") == "1990-01-01" and upd.get("gender") == "FEMALE")
check("build_update url append", upd.get("urls") == ["u1", "u2"])
# 覆盖开关
upd2 = M.build_update(perf, cand, primary_name="主名", extra_aliases=[], set_name=False, ow={"birthdate": True, "gender": True})
check("build_update overwrite on", upd2.get("birthdate") == "1990-01-01" and upd2.get("gender") == "FEMALE")

# ================= 汇总 =================
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  -", f)
sys.exit(1 if FAIL else 0)
