# JavStashLinker

> v1.5.2：开关与文案细节 — ①「模糊匹配」滑块开启时滑轨显示**警告黄**（与冲突徽章同色系，区别于「别名搜索」的主题蓝）；②「别名搜索」悬浮提示精简；③修正面板标题版本号显示（v1.5.1 发版时 `PLUGIN_VERSION` 漏更，此前一直显示 v1.5.0）

Stash 插件：通过场景反推 + 名称搜索批量获取演员的 JAVStash ID。双引擎串行（场景反推 → 名称搜索），匹配按证据评级分 high/medium，冲突护栏防止一个 JAVStash ID 写入多个本地演员；应用时写入 stash_id、别名、URL，并补全空白信息字段与缺失图片（不覆盖已有值）。

## 依赖

- Python 3.6+ + `requests`
- JAVStash stash-box 端点（**设置 → 元数据提供者** 中配置，插件自动复用；未配置时扫描/搜索会弹窗提示）

## 安装

1. 将整个 `JavStashLinker` 文件夹复制到 Stash 插件目录（通常为 `~/.stash/plugins/` 或 Stash 数据目录下的 `plugins/`）
2. 重启 Stash

## 触发方式

| 入口 | 行为 |
|---|---|
| 导航栏 **JAVStash Matcher** 按钮 | 面板：扫描、按置信度审核应用、手动搜索单演员 |
| 任务 **Batch Scan** | 场景引擎（A）+ 名称搜索（B，固定最低风险配置：别名搜索√ / 模糊匹配✗），结果写 `match_results.json` |
| 任务 **Apply High-Confidence Matches** | 应用 high 匹配（与 UI 同规则），需先运行 Batch Scan 缓存演员详情 |

**补全单演员**（手动搜索页）：对「本地仅 1 个演员、该演员未绑定 JAVStash ID、场景已生成指纹（phash/oshash）」的场景调 JAVStash `findScenesBySceneFingerprints` 指纹搜索，命中且该 JAVStash 场景恰好单演员时按标准应用路径写入（stash_id + 别名 + URL + 信息补全 + 后台补图）；指纹无结果或多演员命中（无法唯一对应）跳过。仅 UI 手动搜索页提供，Python 批量任务不含。

## 匹配逻辑

**引擎 A — 场景反推**：从含 JAVStash 场景 ID 的本地场景出发，查询 JAVStash 获取场景演员列表，再按优先级匹配到本地演员：

| 优先级 | 方法 | 置信度 |
|---|---|---|
| 1 | stashdb_id 精确匹配 | high |
| 2 | 单演员场景自动关联 | high |
| 3 | 名字/别名交叉匹配（NFC 归一化） | medium |
| 4 | 手动选择 | — |

**引擎 B — 名称搜索**：对引擎 A 未覆盖且未绑定 JAVStash ID 的本地演员，取主名+全部别名（去重后最多 15 词）逐词调 JAVStash `searchPerformer`（4 req/s 限流），候选按置信度规则评级，命中 high 即停止当前演员。别名搜索（默认开）用主名+全部别名评估全部候选；关闭后仅搜主名、只核对排名第一候选。

**置信度规则**（手动搜索与引擎 B 共用）：

| 条件 | 置信度 |
|---|---|
| StashDB UUID 相等（本地 stashdb stash_id = JAVStash URLs 中 `stashdb.org/performers/<uuid>`，硬证据） | high |
| URL 交集 ≥2（单条可能是工作室网站，不作证据） | high |
| 名称精确命中 ≥3 票（本地与 JAVStash 名称/别名 NFC 归一化后精确相等） | high |
| 仅 2 个名称且全命中（需 ≥1 个名称归一化后 ≥3 字符，防 'Ai'/'An' 类短名撞车） | high |
| 名称命中 + 生日完整相等 | high |
| 相似度 ≥0.9 + 生日完整相等 | high |
| 名称命中 + 仅生日年份相等（AV 数据源生日常有 ±1 年误差） | medium |
| 相似度 ≥0.9（无其他证据，精确同名零证据） | medium |
| 相似度 0.7-0.9（拉丁名变体/词序差异，Levenshtein + 词序无关比对） | medium |
| ≥3 个名称中命中 2 票 | medium |
| JAVStash 演员已删除（通常已被合并） | 上限 medium |

说明：JAVStash `searchPerformer` 为模糊搜索（每词最多 10 条），"出现在搜索结果中"不算匹配，必须名称归一化后精确相等才计票。

**模糊匹配模式**（扫描开关，默认关）：仅按名称相似度评级（≥0.9 → high / 0.7-0.9 → medium），完全忽略 URL/StashDB/生日证据，供 stash_id 匹配不够精准时手动兜底。

**冲突护栏**：同一 JAVStash 演员被 ≥2 个本地演员以 high 置信度命中 → 整组标记「冲突」，批量应用跳过冲突项（防一个 JAVStash ID 写入多个本地演员），可逐条手动应用解冲突。已有 JAVStash ID 的演员不重复处理。

## 应用效果

每个成功应用的匹配：

1. 在本地演员 `stash_ids` 中添加 `{endpoint: "https://javstash.org/graphql", stash_id: "javstash演员ID"}`（已有 JAVStash ID 则跳过）
2. JAVStash 演员名 + 全部别名并入本地 `aliases`（不存在才加）
3. URLs 去重追加（已有链接保留，无新增时不提交该字段）；`stashdb.org` / `theporndb.net` 演员链接除外（见 7）
4. **不修改**本地演员的现有名字
5. **后台补图**（所有应用路径）：本地无自定义图片（`image_path` 含 `default=true`）时取 JAVStash 第一张图片 URL 交 `performerUpdate` 的 `image` 字段 — Stash 服务端自行下载，不占浏览器 CSP、UI 不等待；独立限流队列（2 并发/300ms 间隔），失败仅记日志
6. **信息补全**（所有应用路径）：性别、生日、卒日、国家（ISO 码）、人种、发色、瞳色、身高、三围、生涯、纹身/穿孔 — 逐字段「本地已有值则跳过」，从不覆盖；枚举转显示字符串（如 `CAUCASIAN`→`Caucasian`）
7. **跨站链接转 stash_id**：JAVStash 链接中的 `stashdb.org/performers/<uuid>` / `theporndb.net/performers/<uuid>`（UUID 格式）不写 urls，本地无对应端点 stash_id 时直接转为该端点 stash_id；`theporndb.net/performers/<slug>`（slug 格式）因无法经 API 解析为 UUID，忽略不写；仅匹配主机名恰为这两站（含 `www.` 变体）的链接，嵌在查询参数/路径中或仿冒域名的子串照常并入 urls

## 文件说明

| 文件 | 说明 |
|---|---|
| `JavStashLinker.yml` | 插件定义文件（`interface: raw`，`{pluginDir}` 路径） |
| `JavStashLinker.py` | Python 批量任务脚本（StashInterface + Stash 日志协议） |
| `JavStashLinker.js` | 交互式 UI（DOM 注入 + MutationObserver + i18n bridge） |
| `JavStashLinker.css` | 独立样式表（`jsm-` 前缀，`!important` 覆盖） |
| `match_results.json` | 批量扫描结果（运行后生成） |

## 注意事项

- 扫描以 0.3 秒间隔请求 JAVStash API，搜索走 4 req/s 限流，避免触发限流
- 已有 JAVStash stash_id 的演员会被跳过
- 名称匹配使用 NFC 归一化 + 去空格 + 小写，计票必须精确相等
- 引擎 B 搜索选项（别名搜索/模糊匹配）在点击「开始扫描」时快照生效；批量任务固定为最低风险配置
- Apply 会弹确认框显示待应用数量；建议先扫描查看结果再应用
