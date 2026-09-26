# -*- coding: utf-8 -*-
"""补查 binge 插件的**实际生效设置** + 按需查某个番号在 javstash 上的演员 gender。

用途：
  - 排查"设置改了但首页没变化"：看插件里存的到底是不是你以为的值
  - 判断某片因 gender 被过滤时，查它在 stash-box 上的演员性别

用法：
  python probe_settings.py                 # 只打印 binge 插件设置
  python probe_settings.py SNOS-397        # 额外从 javstash trending 里查该番号的演员 gender

坑：老版本 Stash 的 `configuration.plugins` 是直接 map；新版可能走
`configuration.plugins` 之外的结构，取不到时会打印 err，按实际结构调整即可。
"""
import json, sys, os, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

s = Stash()

# 1) 查 binge 插件设置
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
        print("  %s = %r" % (k, binge.get(k)))
except Exception as e:
    print("err:", e)

# 2) 按需查某番号的演员 gender
keyword = sys.argv[1] if len(sys.argv) > 1 else None
if not keyword:
    sys.exit(0)

print("\n=== %s 的演员 gender ===" % keyword)
cfg2 = s.call("{ configuration { general { stashBoxes { endpoint api_key } } } }")
boxes = cfg2["configuration"]["general"]["stashBoxes"] or []
box = next((b for b in boxes if "javstash" in b["endpoint"]), None)
if box is None:
    print("未找到 javstash stash-box，现有：", [b["endpoint"] for b in boxes])
    sys.exit(1)

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
    if sc.get("code") == keyword:
        print(json.dumps(sc, ensure_ascii=False, indent=2))
        break
else:
    print("trending top30 里没有 %s，换 sort=DATE 或直接用 probe_trending.py 查" % keyword)
