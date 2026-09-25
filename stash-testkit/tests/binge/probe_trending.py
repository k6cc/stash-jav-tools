# -*- coding: utf-8 -*-
"""binge 首页"热门"(trending) 拉取口径探测工具。

用途：
  - 复现/诊断"为什么某部片没进 binge 首页热门卡片"
  - 对照 javstash 网页首页"热门"区与 binge GraphQL 种子的口径差异

链路（binge-cn 源码）：
  - 热门种子: getTrendingStashDBScenes() → GraphQL sort:TRENDING per_page:30
      src/api/stashdb.ts:1037
  - 发现种子: getNewStashDBScenesForPerformers() → sort:DATE DESC, 按已关注演员
      src/api/stashdb.ts:462
  - 缓存: trending 走 localStorage 12h（discovery.seeds.v1）
      src/home/discoveryFeed.ts:44
  - 前端过滤: owned / releaseDate < sinceDate / 预告窗口 / gender / MAX_TRENDING_ITEMS=12
      src/home/discoveryFeed.ts:272-284

实测沉淀（2026-09-25）：
  - TRENDING 按热度算法（favourites/edits/views）排序，不是按发布日期
  - 新上架片需要攒热度才进 top 30；当天新片大概率不在窗口内
  - javstash 网页首页"热门"区 ≠ GraphQL sort:TRENDING top 30（口径不同）
  - sinceDate / todayDate / previewCutoff 全部 localDateStr()（UTC+8 本地日历），
    trending 与 costar 共用同一 sinceDate，不存在 UTC/本地分叉

用法：
  python probe_trending.py                  # 跑 trending + date 对照
  python probe_trending.py T38-072          # 额外按 code 模糊匹配标记
"""
import json, sys, time, urllib.request, urllib.error, os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

QUERY_SCENES = """
query QueryScenes($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    scenes {
      id title code release_date
      performers { performer { id name gender scene_count } }
    }
  }
}
"""


def javstash_gql(endpoint, api_key, variables, timeout=45):
    body = json.dumps({"query": QUERY_SCENES, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("ApiKey", api_key)
    # 坑 ⑭：裸 urllib 会被 javstash 403，必须镜像 Stash 客户端 UA
    req.add_header("User-Agent", "stash/1.0.0")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def pick_javstash_box():
    s = Stash()
    # 老版本 Stash：configuration.general.stashBoxes（坑 ⑥/⑭）
    cfg = s.call("""{ configuration { general { stashBoxes { endpoint api_key name } } } }""")
    boxes = cfg["configuration"]["general"]["stashBoxes"] or []
    for b in boxes:
        print(f"[stash-box] {b['endpoint']}  name={b.get('name')}")
    box = next((b for b in boxes if "javstash" in b["endpoint"]), None)
    if box is None:
        box = boxes[0]
    return box["endpoint"], box["api_key"]


def perf_names(sc):
    return ", ".join(p["performer"]["name"] for p in sc.get("performers") or [])


def hits(sc, keyword):
    if not keyword:
        return False
    k = keyword.lower()
    return (k in (sc.get("code") or "").lower()
            or k in (sc.get("title") or "").lower()
            or k in perf_names(sc).lower())


def run_sort(endpoint, api_key, sort, keyword, label, per_page=30):
    print(f"\n=== {label}: sort={sort} per_page={per_page} ===")
    res = javstash_gql(endpoint, api_key, {
        "input": {"sort": sort, "direction": "DESC", "page": 1, "per_page": per_page}
    })
    if "errors" in res:
        print("errors:", json.dumps(res["errors"], ensure_ascii=False))
        return []
    scenes = res["data"]["queryScenes"]["scenes"]
    print(f"返回 {len(scenes)} 条")
    hit_positions = []
    for i, sc in enumerate(scenes, 1):
        mark = "  <<<<" if hits(sc, keyword) else ""
        if mark:
            hit_positions.append(i)
        print(f"  {i:2d}. [{sc.get('release_date')}] {sc.get('code') or '(no code)'} | "
              f"{(sc.get('title') or '')[:48]} | {perf_names(sc)}{mark}")
    if keyword:
        print(f"\n关键字 '{keyword}' 命中位置: {hit_positions or '不在 top' + str(per_page)}")
    return scenes


def main():
    keyword = sys.argv[1] if len(sys.argv) > 1 else None
    endpoint, api_key = pick_javstash_box()
    print(f"[使用] {endpoint}")

    run_sort(endpoint, api_key, "TRENDING", keyword, "binge 热门种子同款")
    time.sleep(1.5)  # 坑 ⑰：javstash 限流敏感，请求间 sleep
    run_sort(endpoint, api_key, "DATE", keyword, "对照：最新 release_date")


if __name__ == "__main__":
    main()
