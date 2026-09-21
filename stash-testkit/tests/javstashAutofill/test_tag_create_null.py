# -*- coding: utf-8 -*-
"""find_or_create_tag null-return + alias fallback: when tagCreate returns null
or errors (a Tag.Create.Post hook, e.g. tagMergeAuto, merged/deleted the new tag
before the mutation response was built), the plugin falls back to a full tag scan
matching name OR alias and returns the canonical tag id. Offline mocks."""
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

# 1) null tagCreate -> alias fallback resolves canonical tag
g = FakeGQL([{"tagCreate": None}], CANON)
r = M.find_or_create_tag(g, "ギャル")
check("null tagCreate -> canonical via alias", r == "210", str(r))
check("fallback issued (3 calls: by-name + create + full scan)", len(g.calls) == 3, str(len(g.calls)))

# 2) tagCreate exception -> alias fallback resolves canonical tag
g2 = FakeGQL([RuntimeError("boom")], CANON)
r2 = M.find_or_create_tag(g2, "ギャル")
check("tagCreate error -> canonical via alias", r2 == "210", str(r2))

# 3) null tagCreate, full scan has NO alias match -> None (unchanged skip behaviour)
g3 = FakeGQL([{"tagCreate": None}], [])
r3 = M.find_or_create_tag(g3, "ギャル")
check("null tagCreate no fallback hit -> None", r3 is None, str(r3))

# 4) null tagCreate, full scan matches by main name (tag appeared meanwhile) -> its id
g4 = FakeGQL([{"tagCreate": None}], [{"id": "77", "name": "ギャル", "aliases": []}])
r4 = M.find_or_create_tag(g4, "ギャル")
check("fallback matches main name", r4 == "77", str(r4))

# 5) normal tagCreate -> id returned, no fallback query
g5 = FakeGQL([{"tagCreate": {"id": "99"}}], CANON)
r5 = M.find_or_create_tag(g5, "正常tag")
check("normal tagCreate -> id, no fallback", r5 == "99" and len(g5.calls) == 2, "%s calls=%d" % (r5, len(g5.calls)))

# 6) name already exists -> found by-name, no create, no fallback
g6 = FakeGQL([], [])
# by-name query returns the tag
def g6fn(q, v=None, timeout=30):
    return {"findTags": {"tags": [{"id": "55", "name": "已有tag"}]}}
r6 = M.find_or_create_tag(g6fn, "已有tag")
check("existing by name -> id without create", r6 == "55", str(r6))

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
