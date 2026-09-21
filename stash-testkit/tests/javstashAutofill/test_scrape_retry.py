# -*- coding: utf-8 -*-
"""Network-class retry in scrape_scene_full (via _gql_scrape): javstash.org
drops keep-alive connections transiently (Stash logs 'unexpected EOF'), so the
scrape retries once on network-class failures only. Offline mocks."""
import sys, os, urllib.error
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
import javstash_autofill_plus as M

PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond: print("  FAIL:", name, extra)

JAV = "https://javstash.org/graphql"
SC = {"title": "T", "code": "CWP-98", "performers": [], "tags": []}
ROW = {"title": "Carib CWP-98", "code": "CWP-98", "performers": [], "tags": []}

def make_gql(fails, routes, log_calls=None):
    """fails: exceptions raised in order (None = pass through normally) before
    normal dispatch kicks in; consumed once per call."""
    state = {"i": 0}
    def gql(q, v=None, timeout=30):
        if log_calls is not None: log_calls.append((v or {}).get("i") or {})
        if state["i"] < len(fails):
            e = fails[state["i"]]
            state["i"] += 1
            if e is not None:
                raise e
        inp = (v or {}).get("i") or {}
        if "scene_id" in inp:
            return {"scrapeSingleScene": routes.get("oshash", [])}
        qry = (inp.get("query") or "").strip()
        return {"scrapeSingleScene": routes.get(qry, routes.get("*", []))}
    return gql, state

# silence the module logger (it prints to stderr); keep behavior, no noise
sleeps = []
_orig_sleep = M.time.sleep
M.time.sleep = lambda s: sleeps.append(s)

# 1) URLError (network) -> retry succeeds (oshash path)
calls = []
g, st = make_gql([urllib.error.URLError("conn refused")], {"oshash": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("URLError retry succeeds", len(hits) == 1 and (hits[0].get("code") or "") == "CWP-98", str(hits))
check("URLError retried exactly once", st["i"] == 1 and len(calls) == 2, "calls=%d" % len(calls))
check("retry slept 1.5s once", sleeps == [1.5], str(sleeps))
sleeps.clear()

# 2) Stash-side scrape error text ('unexpected EOF') -> retry succeeds
calls = []
g, st = make_gql([RuntimeError("[{'message': 'scrapeSingleScene request failed: Post \"https://javstash.org/graphql\": unexpected EOF'}]")],
                 {"oshash": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("EOF text retry succeeds", len(hits) == 1, str(hits))
check("EOF text retried once", st["i"] == 1 and len(calls) == 2, "calls=%d" % len(calls))
sleeps.clear()

# 3) 'request failed' text (without EOF) -> retry succeeds
calls = []
g, st = make_gql([RuntimeError("request failed: boom")], {"oshash": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("'request failed' retry succeeds", len(hits) == 1, str(hits))
check("'request failed' retried once", st["i"] == 1 and len(calls) == 2, "calls=%d" % len(calls))
sleeps.clear()

# 4) retry also fails -> [] (outer guard swallows), task skips, two calls total
calls = []
g, st = make_gql([urllib.error.URLError("a"), urllib.error.URLError("b")], {"oshash": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("retry-fail returns []", hits == [], str(hits))
check("retry-fail called twice", len(calls) == 2, "calls=%d" % len(calls))
sleeps.clear()

# 5) non-network error -> NOT retried (one call), falls to []
calls = []
g, st = make_gql([RuntimeError("some graphql validation error")], {"oshash": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("non-network error not retried", len(calls) == 1, "calls=%d" % len(calls))
check("non-network error -> []", hits == [], str(hits))
sleeps.clear()

# 6) normal empty result -> NOT retried (one call), proceeds to code fallback
calls = []
g, st = make_gql([], {"oshash": [], "CWP-98": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC)
check("empty oshash not retried", len(calls) == 2, "calls=%d" % len(calls))  # oshash + code fallback
check("empty oshash -> fallback hit", len(hits) == 1, str(hits))
sleeps.clear()

# 7) code fallback path: network error on the fallback query -> retry succeeds
#    (oshash empty normally, fallback raises once then succeeds)
calls = []
g2, st2 = make_gql([None, urllib.error.URLError("timeout")], {"oshash": [], "CWP-98": [ROW]}, calls)
hits = M.scrape_scene_full(g2, "1", JAV, SC)
check("fallback network retry succeeds", len(hits) == 1 and (hits[0].get("code") or "") == "CWP-98", str(hits))
check("fallback retried once", len(calls) == 3, "calls=%d" % len(calls))  # oshash + fallback + retry
sleeps.clear()

# 8) BD-strip path: network error on the stripped query -> retry succeeds
#    (oshash empty, code CWPBD-98 empty, stripped query raises once then succeeds;
#     local code field is non-empty so the returned code is blanked — protection)
SC_BD = dict(SC, code="CWPBD-98")
calls = []
g, st = make_gql([None, None, urllib.error.URLError("drop")], {"oshash": [], "CWPBD-98": [], "CWP-98": [ROW]}, calls)
hits = M.scrape_scene_full(g, "1", JAV, SC_BD)
check("bd-strip network retry succeeds", len(hits) == 1, str(hits))
check("bd-strip local code protected", (hits[0].get("code") or "") == "", str(hits))
check("bd-strip retried once", len(calls) == 4, "calls=%d" % len(calls))  # oshash + code + strip + retry
sleeps.clear()

M.time.sleep = _orig_sleep

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
