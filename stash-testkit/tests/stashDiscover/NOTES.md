# stashDiscover — 测试与排查入口

> 本目录按用途拆成几个文件，**先看下面的地图再决定读哪一个**，不要通读。
> 插件实现与功能说明见 `../../stashDiscover/README.md`；通用硬约束（DB 直写、扫描、CDP、logs 顺序等）见 testkit 根 [`README.md`](../../README.md)。

## 文件地图

| 文件 | 放什么 | 什么时候读 |
|---|---|---|
| `NOTES.md` | 本文件：文件地图 + 快速路由 + 实测环境 | 每次开工先看 |
| `SEMANTICS.md` | 数据层：数据流、Jackett 链路、TPDB REST、localStorage、忽略记录与快照结构、缓存分层、显示口径 | 改查询 / 缓存 / 忽略存储 / 源适配 |
| `FEATURES.md` | 功能口径：兜底面板、内联查找、入库弹窗四步、批量选择、tab 多选、已忽略管理页、返回键、按钮同源 | 改 UI 交互或入库流程 |
| `PITFALLS.md` | 机制与坑（按主题分组）：CSS 层级与尺寸基线、Stash 宿主机制（顶栏 / 菜单 / exec）、数据标识、浏览器 JS、测试方法、边界行为 | 遇到「明明写了却不生效」 |
| `HISTORY.md` | 版本与轮次：每轮用户要什么、改成了什么（只剩结论，机制细节已进 PITFALLS） | 想知道某处为什么长这样 |
| `SCRIPTS.md` | 脚本总览：每个探针验什么、会不会写数据、怎么跑 | 要跑验证 |
| `scripts/` | 全部探针与独立脚本（`probe_*.js` / `probe_*.py` / `node_tpdb_harness.js` / `verify_add_to_library.py`） | 跑脚本时来这取 |

## 快速路由

| 我要… | 先读 |
|---|---|
| 改 TPDB 适配层 / 加新源 | `SEMANTICS.md`「TPDB 适配层」→ 跑 `probe_tpdb_api.py` 确认语义 |
| 调缓存预算、缓存字段、图片张数 | `SEMANTICS.md`「发现页缓存只到卡片级」+ `HISTORY.md`「发现页缓存字段压缩」 |
| 动忽略记录结构或导出格式 | `SEMANTICS.md`「忽略记录」「忽略快照字段」+ `PITFALLS.md`「再点一次忽略」 |
| 改多选入口 / 选中态样式 | `FEATURES.md` 两节多选 + `PITFALLS.md`「状态环」「入口图标层级」 |
| 改弹窗按钮 / 搜索结果按钮 | `FEATURES.md`「按钮同源」两节 |
| 改入库流程 | `FEATURES.md`「入库弹窗 + 演员建档四步」+ `verify_add_to_library.py` |
| 排查「样式不生效 / 被盖住」 | `PITFALLS.md`「CSS 特异性与源码顺序」「布局与尺寸基线」（先搜 `特异性`、`盖住`、`z-index`） |
| 排查「Stash 那边行为怪」 | `PITFALLS.md`「Stash 宿主机制」「数据与标识」 |
| 跑一轮回归 | `SCRIPTS.md` 按板块挑脚本 |

## scripts/ 目录

脚本与夹具一律按「用途 + 有没有副作用 + 怎么跑」列在 [`SCRIPTS.md`](SCRIPTS.md)，这里不再重复；
源码只在 `scripts/` 一处，本目录不再放脚本。

## 实测环境

- 实例 `http://localhost:9999`（登录凭据见 `screenshots/creds.json`，不入库）；演员 **43 = AIKA**（javstash + stashdb 双源）；非本地映射演员用篠田ゆう（javstash）。
- 关联/覆盖实测用临时演员 **97 = ZZ SSD Test（本上花梨）**、**98 = ZZ SSD Test2**，测完已 `performerDestroy` 删除；`preferredBox` 临时改 `stashdb` 后已还原 `javstash.org`（连同 `jackettUrl/jackettApiKey/recentDays:180/previewDays:"7"`）。
- Jackett 实例：`http://192.168.3.190:9117`（API key 在实例插件设置）。
- TPDB key：`E:/stashAPP/config.yml` 里该 stash-box 块的 `apikey`；`scripts/probe_tpdb_api.py` 与 `scripts/node_tpdb_harness.js` 都从那里读，不打印。
- **本机库的 TPDB 数据是测试加的**（3 个工作室 + 4 个演员），只够验适配层与入库链路；发现页三块的完整渲染仍需真实库。
- 浏览器实测用 Chrome DevTools MCP：点击后**轮询等元素出现再断言**（异步渲染/预载/回填，立即 evaluate 会读到中间态）。
