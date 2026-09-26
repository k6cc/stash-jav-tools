# -*- coding: utf-8 -*-
"""诊断「某部片为什么没进 binge 首页热门」——模拟前端过滤链，逐条打印进/不进的原因。

用途：
  - 复现 binge 首页热门卡片的选择口径，定位某番号被过滤在哪一步
  - 对照 javstash trending top30 与本地 owned / 日期窗口 / gender 的关系

前端过滤链（binge-cn `src/home/discoveryFeed.ts:272-284`）：
  owned（本地已有该 stash_id）→ release_date < sinceDate（lookback 天）
  → 预告窗口（previewDays）→ gender → MAX_TRENDING_ITEMS=12 截断

用法：
  python probe_trending_filter.py                  # 默认 SNOS-397、lookback=7
  python probe_trending_filter.py T38-072          # 指定番号
  python probe_trending_filter.py T38-072 14       # 同时指定 lookback 天数

本地 Stash 只需要能按 code 搜到该片即可判断 owned，无需全库扫描。
"""
import json, sys, time, urllib.request, os
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

QUERY = """
query Q($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    scenes {
      id title code release_date
      performers { performer { id name gender scene_count } }
    }
  }
}
"""

MAX_TRENDING = 12


def jav_gql(endpoint, api_key, variables, timeout=45):
    body = json.dumps({"query": QUERY, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("ApiKey", api_key)
    req.add_header("User-Agent", "stash/1.0.0")  # 裸 urllib 会被 javstash 403
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else "SNOS-397"
    lookback = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    s = Stash()
    cfg = s.call("""{ configuration { general { stashBoxes { endpoint api_key name } } } }""")
    boxes = cfg["configuration"]["general"]["stashBoxes"] or []
    box = next((b for b in boxes if "javstash" in b["endpoint"]), None)
    if box is None:
        print("未找到 javstash stash-box，现有：", [b["endpoint"] for b in boxes])
        return 1
    endpoint, api_key = box["endpoint"], box["api_key"]

    # 1) 本地库搜该番号 → 判断是否 owned
    print("=== 0) 本地 Stash 搜 code=%s ===" % keyword)
    local = s.call("""
        query($q: String!) {
          findScenes(filter: { q: $q, per_page: 5 }) {
            scenes { id title code stash_ids { stash_id endpoint } }
          }
        }
    """, {"q": keyword})
    local_hits = local["findScenes"]["scenes"]
    print("本地命中 %d 条:" % len(local_hits))
    owned_jav_ids = set()
    for sc in local_hits:
        sids = ", ".join("%s=%s" % (x["endpoint"], x["stash_id"][:8])
                         for x in (sc.get("stash_ids") or []))
        print("  local_id=%s  code=%s  title=%s" % (
            sc["id"], sc.get("code"), (sc.get("title") or "")[:40]))
        print("    stash_ids: %s" % (sids or "(none)"))
        for sid in (sc.get("stash_ids") or []):
            if "javstash" in sid.get("endpoint", ""):
                owned_jav_ids.add(sid["stash_id"])

    time.sleep(1.5)  # javstash 限流敏感

    # 2) javstash trending top 30
    print("\n=== 1) javstash sort=TRENDING top30 ===")
    res = jav_gql(endpoint, api_key, {
        "input": {"sort": "TRENDING", "direction": "DESC", "page": 1, "per_page": 30}
    })
    scenes = res["data"]["queryScenes"]["scenes"]

    since_date = (date.today() - timedelta(days=lookback)).isoformat()
    print("\n=== 2) 模拟过滤链 (sinceDate=%s, lookback=%d天, MAX=%d) ===" % (
        since_date, lookback, MAX_TRENDING))
    print("本地已 owned 的 javstash ids: %d 个\n" % len(owned_jav_ids))

    taken = 0
    for i, sc in enumerate(scenes, 1):
        code = sc.get("code") or "(no code)"
        title = (sc.get("title") or "")[:40]
        rel = sc.get("release_date")
        reasons = []
        if sc["id"] in owned_jav_ids:
            reasons.append("OWNED")
        if not rel or rel < since_date:
            reasons.append("DATE<%s" % since_date)
        marker = "  <<<<<<< TARGET" if code == keyword else ""
        if reasons:
            print("  %2d. [%s] %-12s | SKIP(%s) | %s%s" % (
                i, rel, code, ", ".join(reasons), title, marker))
        else:
            taken += 1
            in_top = "✓进" if taken <= MAX_TRENDING else "✗截(taken=%d>12)" % taken
            print("  %2d. [%s] %-12s | %s | %s%s" % (i, rel, code, in_top, title, marker))

    print("\n最终 taken = %d（binge 只展示前 %d 个）" % (taken, MAX_TRENDING))
    for i, sc in enumerate(scenes, 1):
        if sc.get("code") == keyword:
            print("%s 在 trending top30 第 %d 位" % (keyword, i))
            break
    else:
        print("%s 不在 trending top30" % keyword)
    return 0


if __name__ == "__main__":
    sys.exit(main())
