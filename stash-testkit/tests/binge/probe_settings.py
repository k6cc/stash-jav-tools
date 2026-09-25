# -*- coding: utf-8 -*-
"""补查：SNOS-397 演员 gender + binge 插件实际设置（lookback/preview/gender）。"""
import json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

s = Stash()

# 1) 查 binge 插件设置（老版本 configuration.plugins 直接是 map）
print("=== binge 插件设置 ===")
try:
    cfg = s.call("{ configuration { plugins } }")
    binge = (cfg["configuration"].get("plugins") or {}).get("binge") or {}
    keys_of_interest = [
        "lookbackDays", "previewDays", "previewSinkToBottom",
        "allowedGenders", "showGalleries", "includeStashDB",
        "hiddenFeedCategories", "sourceEndpoint",
    ]
    for k in keys_of_interest:
        print(f"  {k} = {binge.get(k)!r}")
except Exception as e:
    print("err:", e)

# 2) 查倉木華的 gender（从 trending 数据里拿）
print("\n=== 倉木華 gender ===")
import urllib.request, time
cfg2 = s.call("{ configuration { general { stashBoxes { endpoint api_key } } } }")
box = next(b for b in cfg2["configuration"]["general"]["stashBoxes"] if "javstash" in b["endpoint"])
body = json.dumps({"query": """
query Q($input: SceneQueryInput!) {
  queryScenes(input: $input) {
    scenes { code release_date performers { performer { name gender } } }
  }
}
""", "variables": {"input": {"sort": "TRENDING", "direction": "DESC", "page": 1, "per_page": 30}}}).encode()
req = urllib.request.Request(box["endpoint"], data=body, method="POST")
req.add_header("Content-Type", "application/json")
req.add_header("ApiKey", box["api_key"])
req.add_header("User-Agent", "stash/1.0.0")
with urllib.request.urlopen(req, timeout=45) as r:
    data = json.loads(r.read().decode())
for sc in data["data"]["queryScenes"]["scenes"]:
    if sc.get("code") == "SNOS-397":
        print(json.dumps(sc, ensure_ascii=False, indent=2))
        break
