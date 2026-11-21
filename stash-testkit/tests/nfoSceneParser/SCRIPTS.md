# nfoSceneParser 脚本总览

> `tagCreate` 与钩子语义见 testkit 根 [`README.md`](../../README.md)「GraphQL schema」；一次性结论见 `_archive/nfoSceneParser-v1.7.0-tagCreate-fallback.md`。

插件：`E:\Temp\stash-jav-tools\nfoSceneParser`，默认验证部署副本 `E:\stashAPP\plugins\k6cc\nfoSceneParser`（可传插件目录覆盖）。

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `test_tag_create_fallback.py` | 兜底主用例集：已合并名重拉、全新名不重拉、不存在名静默跳过、双 pass 回归、dry_mode | `python test_tag_create_fallback.py offline [插件目录]` / `live [插件目录]` | offline 不需要实例；live 需要，**写 tag** |
| `test_tag_create_fallback_live.py` | 真库兜底分支：真实 tagCreate → `Tag.Create.Post` 合并 → null → 重拉命中 | `python test_tag_create_fallback_live.py [插件目录]` | 需要实例 + Tag Merge Auto + `tag_merge_map.json`；**写 tag** |
| `test_tag_create_success_regression.py` | 成功路径回归：全新名时 `findTags` 只查 1 次、无额外重拉 | `python test_tag_create_success_regression.py [插件目录]` | 需要实例；**写 tag**，测后清理 |
| `test_cross_plugin_no_loop.py` | 与 javstashAutofill+ 交替处理同一 tag 名，统计 tagCreate 是否收敛（无循环） | `python test_cross_plugin_no_loop.py [插件目录]` | 需要实例 + Tag Merge Auto；**写 tag** |
| `probe_ghost_id.py` | 幽灵 id 边界：钩子合并删除 tag 后，原始 mutation 响应是否还带 id | `python probe_ghost_id.py` | 需要实例；**写 tag**（实验用），结论 v0.31.1 = 不带 id |

## 跑法约定

- 真库兜底必须选「映射表有、库中 name/alias 均无」的源名，否则 T0 双 pass 已命中，走不到 tagCreate。
- 所有脚本在 `scripts/` 内，按 `__file__` 上溯定位 testkit 根与仓库根，可任意目录执行。
- `offline` 分支不连实例；`live` 与其余四个脚本都会在真库创建 tag，跑前确认可清理。
