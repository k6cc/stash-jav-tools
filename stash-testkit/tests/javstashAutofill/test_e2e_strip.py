# -*- coding: utf-8 -*-
"""E2E: BD-suffix strip retry on a real scene (219) + real javstash.

改 code=CWPBD-98 -> scrape_scene_full 走 oshash miss -> code fallback(CWPBD-98) miss
-> BD-strip(CWP-98) hit -> apply_scene_fill：验证本地 code 保持 CWPBD-98、stash_id 填上、
空字段填上。结束后恢复场景快照并清理新建演员。
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "javstashAutofill+"))
from stash_client import Stash
import javstash_autofill_plus as M

JAV = "https://javstash.org/graphql"
SID = "219"
PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond: print("  FAIL:", name, extra)

s = Stash()
gql = lambda q, v=None, timeout=45: s.call(q, v)

def scene_full(sid):
    return gql('{ findScene(id:%s){ id code title details director date urls '
               'performers{ id } tags{ id } stash_ids{ endpoint stash_id } } }' % sid)["findScene"]

snap = scene_full(SID)
print("before: code=%s title=%s sids=%s perfs=%s" % (
    snap.get("code"), (snap.get("title") or "")[:20],
    [(x["endpoint"].split("/")[2], x["stash_id"][:8]) for x in (snap.get("stash_ids") or [])],
    [p["id"] for p in snap.get("performers") or []]))

try:
    # 1) 本地 code 字段清空 + title 含 CWPBD-98（extract_code 从标题提取）
    gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }",
        {"i": {"id": SID, "code": "", "title": "CWPBD-98 テスト"}})
    scene = scene_full(SID)
    print("  local code cleared, title=CWPBD-98")
    time.sleep(0.5)

    # 2) 真实剥离链路
    hits = M.scrape_scene_full(gql, SID, JAV, scene, use_fallback=True)
    check("strip retry hit", len(hits) == 1, json.dumps([h.get("code") for h in hits], ensure_ascii=False))
    if hits:
        print("  hit code=%s title=%s rid=%s" % (hits[0].get("code"), (hits[0].get("title") or "")[:30], hits[0].get("remote_site_id")))
        check("stripped code kept (local code field empty)", (hits[0].get("code") or "") == "CWP-98")
        sc = hits[0]

        # 3) 应用填充
        M.apply_scene_fill(gql, SID, scene, sc, JAV, ow_title=False)
        time.sleep(1)
        after = scene_full(SID)
        check("local code written as CWP-98", after.get("code") == "CWP-98", after.get("code"))
        check("stash_id filled (javstash)", any(x["endpoint"] == JAV for x in (after.get("stash_ids") or [])),
              json.dumps([(x["endpoint"], x["stash_id"][:8]) for x in after.get("stash_ids") or []], ensure_ascii=False))
        check("details filled", bool((after.get("details") or "").strip()))
        check("performers filled", len(after.get("performers") or []) > 0, str([p["id"] for p in after.get("performers") or []]))
        print("  after: code=%s sids=%s perfs=%s" % (
            after.get("code"), [(x["endpoint"].split("/")[2], x["stash_id"][:8]) for x in (after.get("stash_ids") or [])],
            [p["id"] for p in after.get("performers") or []]))
finally:
    # 恢复快照
    try:
        inp = {"id": SID, "code": snap.get("code") or ""}
        if snap.get("title"): inp["title"] = snap["title"]
        if snap.get("details"): inp["details"] = snap["details"]
        if snap.get("date"): inp["date"] = snap["date"]
        if snap.get("urls"): inp["urls"] = snap["urls"]
        inp["stash_ids"] = snap.get("stash_ids") or []
        inp["performer_ids"] = [str(p["id"]) for p in snap.get("performers") or []]
        gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }", {"i": inp})
        print("  scene restored:", scene_full(SID).get("code"))
    except Exception as e:
        print("  restore err:", e)

print("")
print("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
for f in FAIL: print("  FAIL:", f)
sys.exit(1 if FAIL else 0)
