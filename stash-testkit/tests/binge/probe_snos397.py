# -*- coding: utf-8 -*-
"""诊断 SNOS-397 为什么没进 binge 首页热门。

步骤：
  1. javstash 实时 trending top 30，找 SNOS-397 位置
  2. 本地 Stash 按 code 搜 SNOS-397，判断是否 owned
  3. 模拟 binge buildItems 过滤链，打印每部片进/不进的原因
"""
import json, sys, time, urllib.request, os
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

KEYWORD = "SNOS-397"


def jav_gql(endpoint, api_key, variables, timeout=45):
    body = json.dumps({"query": QUERY, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("ApiKey", api_key)
    req.add_header("User-Agent", "stash/1.0.0")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    s = Stash()
    cfg = s.call("""{ configuration { general { stashBoxes { endpoint api_key name } } } }""")
    box = next((b for b in cfg["configuration"]["general"]["stashBoxes"] if "javstash" in b["endpoint"]), None)
    endpoint, api_key = box["endpoint"], box["api_key"]

    # 1) 本地库搜 SNOS-397
    print(f"=== 0) 本地 Stash 搜 code={KEYWORD} ===")
    local = s.call("""
        query($q: String!) {
          findScenes(filter: { q: $q, per_page: 5 }) {
            scenes { id title code stash_ids { stash_id endpoint } }
          }
        }
    """, {"q": KEYWORD})
    local_hits = local["findScenes"]["scenes"]
    print(f"本地命中 {len(local_hits)} 条:")
    for sc in local_hits:
        sids = ", ".join(f"{x['endpoint']}={x['stash_id'][:8]}" for x in (sc.get("stash_ids") or []))
        print(f"  local_id={sc['id']}  code={sc.get('code')}  title={(sc.get('title') or '')[:40]}")
        print(f"    stash_ids: {sids or '(none)'}")

    time.sleep(1)

    # 2) javstash trending top 30
    print(f"\n=== 1) javstash sort=TRENDING top30 ===")
    res = jav_gql(endpoint, api_key, {
        "input": {"sort": "TRENDING", "direction": "DESC", "page": 1, "per_page": 30}
    })
    scenes = res["data"]["queryScenes"]["scenes"]

    # 收集本地已有的 javstash stash_id 集合（从上面搜索结果 + 全库扫太重，这里只看 SNOS-397）
    owned_jav_ids = set()
    for sc in local_hits:
        for sid in (sc.get("stash_ids") or []):
            if "javstash" in sid.get("endpoint", ""):
                owned_jav_ids.add(sid["stash_id"])

    # 模拟 buildItems 过滤链（lookback=7, previewDays=0, 只看 trending）
    # 今天 2026-09-25, lookback=7 → sinceDate=2026-09-18
    # previewDays=0 → previewCutoff=None（不限预告）
    # gender 过滤：默认女+跨性别女，这里简化为只看有 female 的
    # owned：只模拟 SNOS-397 的 owned 状态
    since_date = "2026-09-18"  # lookback=7
    preview_cutoff = None  # previewDays=0
    MAX_TRENDING = 12

    print(f"\n=== 2) 模拟过滤链 (sinceDate={since_date}, previewCutoff={preview_cutoff}, MAX={MAX_TRENDING}) ===")
    print(f"本地已 owned 的 javstash ids: {len(owned_jav_ids)} 个")
    print()

    taken = 0
    for i, sc in enumerate(scenes, 1):
        code = sc.get("code") or "(no code)"
        title = (sc.get("title") or "")[:40]
        rel = sc.get("release_date")
        perf = ", ".join(p["performer"]["name"] for p in sc.get("performers") or [])
        sid = sc["id"]

        reasons = []
        if sid in owned_jav_ids:
            reasons.append("OWNED")
        if not rel or rel < since_date:
            reasons.append(f"DATE<{since_date}")
        if preview_cutoff and rel and rel > preview_cutoff:
            reasons.append(f"PREVIEW>{preview_cutoff}")

        is_target = code == KEYWORD
        marker = "  <<<<<<< TARGET" if is_target else ""

        if reasons:
            print(f"  {i:2d}. [{rel}] {code:12s} | SKIP({', '.join(reasons)}) | {title}{marker}")
        else:
            taken += 1
            in_top = "✓进" if taken <= MAX_TRENDING else f"✗截(taken={taken}>12)"
            print(f"  {i:2d}. [{rel}] {code:12s} | {in_top} | {title}{marker}")
            if taken > MAX_TRENDING and not is_target:
                # 已经满了，后面的不用细看
                pass

    print(f"\n最终 taken = {taken}（binge 只展示前 {MAX_TRENDING} 个）")
    # 找 SNOS-397 的位置
    for i, sc in enumerate(scenes, 1):
        if sc.get("code") == KEYWORD:
            print(f"SNOS-397 在 trending top30 第 {i} 位")
            break


if __name__ == "__main__":
    main()
