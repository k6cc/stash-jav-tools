# nfoSceneParser（NFO 解析）验证笔记

插件：`E:\Temp\stash-jav-tools\nfoSceneParser` → 部署到 `E:\stashAPP\plugins\k6cc\nfoSceneParser`。
`Scene.Create.Post` 解析同名 `.nfo`；`tagCreate` 失败（被别名占用 / 被 `Tag.Create.Post` 钩子合并）时走兜底重拉。

## 文件地图

| 位置 | 内容 |
|---|---|
| `scripts/` | 兜底单测、真库 E2E、成功路径回归、跨插件无循环、幽灵 id 探针；逐个用途/跑法/副作用见 [`SCRIPTS.md`](SCRIPTS.md) |

## 快速验证

1. 离线：`python scripts/test_tag_create_fallback.py offline <插件目录>`（A–E 五组用例，不连实例）。
2. 真库：`test_tag_create_fallback_live.py` → `test_tag_create_success_regression.py` → `test_cross_plugin_no_loop.py`；需实例在线 + Tag Merge Auto 启用 + `tag_merge_map.json`。
3. 换 Stash 版本后重跑 `probe_ghost_id.py`：确认钩子合并删除 tag 后 mutation 仍不带幽灵 id。

## 实测环境

- 真库兜底必须选「映射表有、库中 name/alias 均无」的源名，否则 T0 双 pass 已命中，走不到 tagCreate。
- `tagCreate` 被别名占用会返回 `null`；`Tag.Create.Post` 同步合并会让它更稳定地返回 null —— 兜底必须重拉全量再按归一化匹配。
- v1.7.0 的一次性结论见 `_archive/nfoSceneParser-v1.7.0-tagCreate-fallback.md`；通用 schema 坑见根 `README.md`。
