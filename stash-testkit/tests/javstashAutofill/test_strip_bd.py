# -*- coding: utf-8 -*-
"""BD-suffix strip retry: strip_bd_code + scrape_scene_full fallback path (offline mocks)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
import javstash_autofill_plus as M

PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond: print("  FAIL:", name, extra)

# ---- strip_bd_code ----
check("strip CWPBD-98 -> CWP-98", M.strip_bd_code("CWPBD-98") == "CWP-98")
check("strip LAFBD-21 -> LAF-21", M.strip_bd_code("LAFBD-21") == "LAF-21")
check("strip lowercase cwpbd-98", M.strip_bd_code("cwpbd-98") == "CWP-98")
check("strip underscore CWPBD_98", M.strip_bd_code("CWPBD_98") == "CWP-98")
check("genuine BD code SBD-123 untouched", M.strip_bd_code("SBD-123") is None)
check("no BD CWP-98 untouched", M.strip_bd_code("CWP-98") is None)
check("digits too short CWPBD-9 untouched", M.strip_bd_code("CWPBD-9") is None)
check("FC2PPV-123456 untouched", M.strip_bd_code("FC2PPV-123456") is None)
check("plain word untouched", M.strip_bd_code("RandomTitle") is None)
check("empty untouched", M.strip_bd_code("") is None)

# ---- scrape_scene_full: BD-strip retry path (all mocks local) ----
def make_gql(routes, log_queries=None):
    def gql(q, v=None, timeout=30):
        if log_queries is not None: log_queries.append(v or {})
        inp = (v or {}).get("i") or {}
        if "scene_id" in inp:
            return {"scrapeSingleScene": routes.get("oshash", [])}
        qry = (inp.get("query") or "").strip()
        return {"scrapeSingleScene": routes.get(qry, routes.get("*", []))}
    return gql

SC = {"title": "CWPBD-98 サンプル", "code": "", "performers": [], "tags": []}
sc = lambda **kw: dict(SC, **kw)

# 1) oshash miss + code fallback miss + BD-strip hit, local code field non-empty ->
#    returns stripped candidate, code blanked (local code protected)
queries = []
g = make_gql({"oshash": [], "CWPBD-98": [], "CWP-98": [{"title": "Carib CWP-98", "code": "CWP-98",
                                                       "performers": [], "tags": []}]}, queries)
hits = M.scrape_scene_full(g, "1", "https://javstash.org/graphql", sc(code="CWPBD-98"))
check("bd-hit returns one row", len(hits) == 1, str(hits))
check("bd-hit code blanked (local code kept)", (hits[0].get("code") or "") == "", str(hits))
check("bd-hit queries included stripped", any((q.get("i") or {}).get("query") == "CWP-98" for q in queries))

# 1b) local code FIELD empty (code only in title) -> stripped code is kept for writing
g1b = make_gql({"oshash": [], "CWPBD-98": [], "CWP-98": [{"title": "Carib CWP-98", "code": "CWP-98",
                                                          "performers": [], "tags": []}]})
hits1b = M.scrape_scene_full(g1b, "1", "https://javstash.org/graphql", sc())  # code="" title=CWPBD-98 ...
check("bd-hit empty-local-code keeps stripped code", len(hits1b) == 1 and (hits1b[0].get("code") or "") == "CWP-98",
      str(hits1b))

# 2) BD-strip query returns a non-matching code -> discarded (return [])
g2 = make_gql({"oshash": [], "CWPBD-98": [], "CWP-98": [{"title": "Other", "code": "SSIS-123", "performers": [], "tags": []}]})
hits2 = M.scrape_scene_full(g2, "1", "https://javstash.org/graphql", sc(code="CWPBD-98"))
check("bd-mismatch discarded", hits2 == [], str(hits2))

# 3) genuine BD code (SBD-123): no strip, no extra query, normal fallback result
queries3 = []
g3 = make_gql({"oshash": [], "SBD-123": [{"title": "X", "code": "SBD-123", "performers": [], "tags": []}]}, queries3)
hits3 = M.scrape_scene_full(g3, "1", "https://javstash.org/graphql", sc(code="SBD-123"))
check("genuine-BD no strip", len(hits3) == 1 and (hits3[0].get("code") or "") == "SBD-123", str(hits3))
check("genuine-BD no extra query", not any((q.get("i") or {}).get("query") == "S-123" for q in queries3))

# 4) BD-strip retry disabled when use_fallback=False
g4 = make_gql({"oshash": [], "CWPBD-98": [], "CWP-98": [{"title": "Carib", "code": "CWP-98", "performers": [], "tags": []}]})
hits4 = M.scrape_scene_full(g4, "1", "https://javstash.org/graphql", sc(code="CWPBD-98"), use_fallback=False)
check("fallback off -> no strip retry", hits4 == [], str(hits4))

# 5) oshash hit with matching code still wins before any strip
g5 = make_gql({"oshash": [{"title": "Real", "code": "CWPBD-98", "performers": [], "tags": []}], "CWPBD-98": [], "CWP-98": []})
hits5 = M.scrape_scene_full(g5, "1", "https://javstash.org/graphql", sc(code="CWPBD-98"))
check("oshash exact still first", len(hits5) == 1 and (hits5[0].get("code") or "") == "CWPBD-98", str(hits5))

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
sys.exit(1 if FAIL else 0)
