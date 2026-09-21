# -*- coding: utf-8 -*-
"""find_or_create_tag name/alias pre-check + fallback (v1.2.4):
- before creating, a full scan resolves a name already merged into a canonical
  tag's aliases (Tag.Create.Post hook, e.g. tagMergeAuto) and returns it WITHOUT
  firing a doomed tagCreate (Stash log stays quiet);
- tagCreate null/error still falls back to the same scan (race window).
Offline mocks."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
import javstash_autofill_plus as M

PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond: print("  FAIL:", name, extra)

class FakeGQL:
    """by-name findTags -> empty; tagCreate -> scripted; per_page:-1 full scan -> all_tags."""
    def __init__(self, create_results, all_tags=None):
        self.create_results = list(create_results)
        self.all_tags = all_tags or []
        self.calls = []
    def __call__(self, q, v=None, timeout=30):
        self.calls.append((q, v))
        if "tagCreate" in q:
            return self.create_results.pop(0) if self.create_results else {"tagCreate": None}
        if "per_page:-1" in q:
            return {"findTags": {"tags": self.all_tags}}
        return {"findTags": {"tags": []}}

CANON = [{"id": "210", "name": "辣妹", "aliases": ["ギャル"]}]
n_create = lambda g: sum(1 for q, _ in g.calls if "tagCreate" in q)

# 1) alias pre-check hit -> canonical id, NO tagCreate fired (log stays quiet)
g = FakeGQL([], CANON)
r = M.find_or_create_tag(g, "ギャル")
check("alias pre-check -> canonical, no tagCreate", r == "210" and n_create(g) == 0,
      "r=%s create_calls=%d" % (r, n_create(g)))

# 2) pre-check main-name hit (tag exists as main name only)
g2 = FakeGQL([], [{"id": "77", "name": "ギャル", "aliases": []}])
r2 = M.find_or_create_tag(g2, "ギャル")
check("pre-check main-name -> its id, no tagCreate", r2 == "77" and n_create(g2) == 0, str(r2))

# 3) pre-check empty, tagCreate exception -> post fallback resolves alias
g3 = FakeGQL([RuntimeError("boom")], CANON)
r3 = M.find_or_create_tag(g3, "ギャル")
check("create error -> post fallback canonical", r3 == "210", str(r3))

# 4) pre-check empty, tagCreate null -> post fallback resolves alias
g4 = FakeGQL([{"tagCreate": None}], CANON)
r4 = M.find_or_create_tag(g4, "ギャル")
check("create null -> post fallback canonical", r4 == "210", str(r4))

# 5) pre-check empty, create null, no fallback hit -> None
g5 = FakeGQL([{"tagCreate": None}], [])
r5 = M.find_or_create_tag(g5, "ギャル")
check("no fallback hit -> None", r5 is None, str(r5))

# 6) normal create: pre-check empty -> tagCreate succeeds, no extra scan
g6 = FakeGQL([{"tagCreate": {"id": "99"}}], [])
r6 = M.find_or_create_tag(g6, "正常tag")
check("normal create -> id", r6 == "99", str(r6))
check("normal create: by-name + pre-scan + create", len(g6.calls) == 3, str(len(g6.calls)))

# 7) name already exists by-name -> id, single query
def g7(q, v=None, timeout=30):
    return {"findTags": {"tags": [{"id": "55", "name": "已有tag"}]}}
r7 = M.find_or_create_tag(g7, "已有tag")
check("existing by name -> id", r7 == "55", str(r7))

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
