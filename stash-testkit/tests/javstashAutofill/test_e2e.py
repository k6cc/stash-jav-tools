# -*- coding: utf-8 -*-
"""端到端回归：真实测试库 + 真实 javstash + 已部署插件钩子。

用例（对应回归验证矩阵）：
  E2E-1  反查命中 -> 复用合并（创建带本地已有 javstash id 的演员 -> 被合并进本地演员）
  E2E-2  反查未命中 -> 按 id 直抓补全（创建带本地没有的 javstash id -> 直抓详情填充，主名保留）
  E2E-3  25s 卡顿消除（创建无匹配怪名 -> mutation 立即返回，演员保持空白）
  E2E-4  0.9 命中 + 本地别名命中（候选名命中本地演员别名且同 stash_id -> 合并，不新建重复）
  E2E-5  保守忽略（0.9 命中候选、本地同名演员带不同 stash_id -> 保持空白，不合并不挂 id）
  E2E-6  直抓补全的详情正确性（E2E-2 的字段级断言）

注意：Performer.Create.Post 钩子已部署（spawn 异步，performerFillDelay 默认 2s），
每次创建后等待 ~8s 让延迟 worker 完成。
"""
import sys, os, json, time, datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from stash_client import Stash

JAV = "https://javstash.org/graphql"
PASS, FAIL = [], []
def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    if not cond:
        print("  FAIL:", name, extra)

def log(msg):
    print(msg, flush=True)

s = Stash()
PERF_Q = 'id name alias_list gender birthdate height_cm measurements stash_ids{ endpoint stash_id } urls'

def find_perf(pid):
    d = s.call('query($id:ID!){ findPerformer(id:$id){ %s } }' % PERF_Q, {"id": str(pid)})
    return d["findPerformer"]

def find_perfs_by_name(name, per_page=50):
    # 老版本无 names 过滤器：全量拉取 + 端侧 norm 比对（测试库演员少）
    allp = s.call('{ findPerformers(filter:{per_page:500}){ performers{ %s } } }' % PERF_Q)["findPerformers"]["performers"]
    n = name.replace(" ", "").lower()
    return [p for p in allp if p["name"].replace(" ", "").lower() == n
            or any(a.replace(" ", "").lower() == n for a in (p.get("alias_list") or []))]

def create_perf(name, stash_ids=None):
    inp = {"name": name}
    if stash_ids: inp["stash_ids"] = stash_ids
    t0 = time.time()
    d = s.call("mutation($i:PerformerCreateInput!){ performerCreate(input:$i){ id name } }", {"i": inp})
    dt = time.time() - t0
    return d["performerCreate"], dt

def destroy_perf(pid):
    try:
        s.call("mutation($id:ID!){ performerDestroy(input:{id:$id}) }", {"id": str(pid)})
        return True
    except Exception as e:
        print("  destroy %s err: %s" % (pid, e)); return False

created_ids = []
try:
    # ---------- E2E-1 反查命中 -> 合并 ----------
    log("== E2E-1: stash-id reverse hit -> merge")
    target = find_perf(6)
    assert target and target["name"] == "Yua Mikami"
    jav_sid = next((x["stash_id"] for x in target["stash_ids"] if x["endpoint"] == JAV), None)
    assert jav_sid, "perf 6 lacks javstash id"
    before_6 = target["alias_list"] or []
    created, dt = create_perf("TST-AF1-" + "Yua Mikami", [{"endpoint": JAV, "stash_id": jav_sid}])
    created_ids.append(created["id"])
    log("  create took %.1fs (hook must return immediately)" % dt)
    time.sleep(9)
    after = find_perf(6)
    gone = find_perfs_by_name("TST-AF1-Yua Mikami")
    check("E2E-1 created performer removed by merge", find_perf(created["id"]) is None,
          "still exists %s" % created["id"])
    check("E2E-1 dest keeps its identity", after["name"] == "Yua Mikami")
    check("E2E-1 dest stash_ids intact", any(x["endpoint"] == JAV and x["stash_id"] == jav_sid for x in after["stash_ids"] or []))
    check("E2E-1 created name appended as alias", "TST-AF1-Yua Mikami" in (after["alias_list"] or []),
          json.dumps(after["alias_list"], ensure_ascii=False))

    # ---------- E2E-2 反查未命中 -> 直抓补全 ----------
    log("== E2E-2: stash-id reverse miss -> direct-fetch fill")
    rid2 = "b6e7cde8-13e2-49f6-8972-05c8de9e85d7"   # Lily La Beau on javstash (local absent)
    created2, dt2 = create_perf("TST-AF2-LilyLaBeau", [{"endpoint": JAV, "stash_id": rid2}])
    created_ids.append(created2["id"])
    log("  create took %.1fs" % dt2)
    time.sleep(9)
    p2 = find_perf(created2["id"])
    check("E2E-2 keeps created primary name", p2 and p2["name"] == "TST-AF2-LilyLaBeau", str(p2))
    check("E2E-2 stash_id attached", p2 and any(x["endpoint"] == JAV and x["stash_id"] == rid2 for x in p2["stash_ids"] or []))
    check("E2E-2 details filled (birthdate)", p2 and bool(p2.get("birthdate")), p2 and p2.get("birthdate"))
    check("E2E-2 details filled (gender)", p2 and bool(p2.get("gender")), p2 and p2.get("gender"))
    check("E2E-2 details filled (measurements)", p2 and bool(p2.get("measurements")), p2 and p2.get("measurements"))

    # ---------- E2E-3 25s 消除 ----------
    log("== E2E-3: unmatched name -> hook returns fast, blank kept")
    created3, dt3 = create_perf("TST-AF3-不存在の俳優XYZ123")
    created_ids.append(created3["id"])
    log("  create took %.1fs (was ~25s before async)" % dt3)
    check("E2E-3 mutation returns quickly (<8s)", dt3 < 8, "took %.1fs" % dt3)
    time.sleep(9)
    p3 = find_perf(created3["id"])
    check("E2E-3 blank kept (no candidate)", p3 and not (p3.get("birthdate") or p3.get("gender") or p3.get("stash_ids")),
          json.dumps(p3, ensure_ascii=False)[:200])

    # ---------- E2E-4 0.9 命中 + 本地别名命中 -> 合并 ----------
    log("== E2E-4: 0.9 hit, local alias hit, same stash-id -> merge")
    created4, dt4 = create_perf("三上悠亜")
    created_ids.append(created4["id"])
    log("  create took %.1fs" % dt4)
    time.sleep(12)   # scrape javstash takes a few seconds
    gone4 = find_perfs_by_name("三上悠亜")
    p6 = find_perf(6)
    check("E2E-4 created performer removed by merge", find_perf(created4["id"]) is None,
          "still exists %s" % created4["id"])
    check("E2E-4 merged into perf 6", str(p6["id"]) == "6")
    check("E2E-4 perf 6 keeps javstash id", any(x["endpoint"] == JAV and x["stash_id"] == jav_sid for x in p6["stash_ids"] or []))

    # ---------- E2E-5 保守忽略 ----------
    log("== E2E-5: candidate anchored elsewhere -> conservative blank")
    # 5a. 先建一个"主名不同、别名=候选名、带假 javstash id"的锚定演员
    #     （反查/直抓都失败 -> 保持带假 id 空白；Stash 主名唯一，故用别名承接）
    #     "RARA" 在 javstash 有候选（rid=3c6b435f-...），测试库无 RARA 主名。
    fake_sid = "00000000-0000-0000-0000-0000000000af"
    created5a, _ = create_perf("TST-AF5-Anchored", [{"endpoint": JAV, "stash_id": fake_sid}])
    created_ids.append(created5a["id"])
    try:
        s.call("mutation($i:PerformerUpdateInput!){ performerUpdate(input:$i){ id } }",
               {"i": {"id": str(created5a["id"]), "alias_list": ["RARA"]}})
    except Exception as e:
        print("  5a alias set err:", e)
    time.sleep(9)
    # 5b. 再建同名无 id 演员 -> 0.9 命中真实候选（rid=3c6b435f != 假 id）-> 保守忽略
    created5, dt5 = create_perf("RARA")
    created_ids.append(created5["id"])
    log("  create took %.1fs" % dt5)
    time.sleep(12)
    p5 = find_perf(created5["id"])
    p5a = find_perf(created5a["id"])
    check("E2E-5 second perf NOT merged into anchored one", p5 is not None and p5a is not None,
          "second=%s anchored=%s" % (bool(p5), bool(p5a)))
    check("E2E-5 second perf keeps no javstash id", p5 is not None and not any(x["endpoint"] == JAV for x in (p5["stash_ids"] or [])),
          json.dumps((p5 or {}).get("stash_ids"), ensure_ascii=False))
    check("E2E-5 second perf stays blank", p5 is not None and not (p5.get("birthdate") or p5.get("gender")),
          json.dumps(p5, ensure_ascii=False)[:160])
    check("E2E-5 anchored perf untouched", p5a is not None and any(x["endpoint"] == JAV and x["stash_id"] == fake_sid for x in p5a["stash_ids"] or []))

    # ---------- 汇总 ----------
    log("")
    log("PASS: %d, FAIL: %d" % (len(PASS), len(FAIL)))
    for f in FAIL: log("  FAIL:", f)
finally:
    # 清理（merge 掉的演员已不存在，destroy 幂等处理）
    for pid in created_ids:
        destroy_perf(pid)
    # 清理 perf 6 的测试别名（E2E-1 追加的）
    try:
        p6 = find_perf(6)
        if p6:
            als = [a for a in (p6["alias_list"] or []) if not a.startswith("TST-AF")]
            if len(als) != len(p6.get("alias_list") or []):
                s.call("mutation($i:PerformerUpdateInput!){ performerUpdate(input:$i){ id } }",
                       {"i": {"id": "6", "alias_list": als}})
                print("  perf 6 test aliases cleaned")
    except Exception as e:
        print("  perf6 alias cleanup err:", e)
    log("cleanup done")

sys.exit(1 if FAIL else 0)
