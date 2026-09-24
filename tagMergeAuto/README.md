# tagMergeAuto

> v1.2.5：填充改词级跳过（与 tagMerge v2.7.3 同源）——已写入词不查询，新词必查询；钩子填充补写 跳过/成功 日志（miss 不写）

Stash 纯后台插件（`interface: raw`，不注入任何页面脚本/样式）：按优先级链读取插件目录的映射库（`tag_merge_map_<界面语言>.custom.json` → `tag_merge_map.custom.json` → `tag_merge_map_<界面语言>.json` → `tag_merge_map.json`），把名称相似的 tags（英文/日文/中文变体）自动合并为规范中文 tag。

与 UI 版 [tagMerge](../tagMerge/README.md) 使用**同一套解析与合并逻辑**（归一化精确匹配、防链式、幂等、源名补写进目标别名），但触发方式完全自动化：

- **钩子（自动）**：新 tag 创建（`Tag.Create.Post`）时立即查映射库，命中即合并进目标；目标 tag 不存在时先创建再合并；合并成功后若开关开（默认），自动给目标 tag 补 stash_id
- **任务（手动）**：任务列表页「Full Scan & Merge」全库合并存量源 tag；「Fill Stash IDs」批量为存量 tag 补 stash_id

## 依赖

- Python（Stash 内置运行环境即可，标准库 only，无第三方依赖）
- stash-box 实例（经「设置 → 元数据提供者」配置，插件自动复用；填充ID 功能依赖，合并功能不需要）

## 安装

1. 将整个 `tagMergeAuto` 文件夹复制到 Stash 插件目录（通常为 Stash 数据目录下的 `plugins/`）
2. 重启 Stash，在「设置 → 插件」中确认 Tag Merge Auto 已启用
3. 任务列表页出现「Full Scan & Merge」「Fill Stash IDs」任务即安装成功；新建任意 tag 即可验证钩子生效

## 映射表

默认映射表 `tagMergeAuto/tag_merge_map.json` 是 UI 版 `tagMerge/tag_merge_map.json` 的副本，**编辑任一份后需同步另一份**（发布时以 UI 版为权威源）。读取优先级（存在即用，前面的不存在才顺延）：

| 优先级 | 文件 | 角色 |
|---|---|---|
| 1 | `tag_merge_map_<界面语言>.custom.json` | 用户自定义（导出生成，升级插件不覆盖） |
| 2 | `tag_merge_map.custom.json` | 用户自定义（导出生成，升级插件不覆盖） |
| 3 | `tag_merge_map_<界面语言>.json` | 发行版语言映射（预留，暂不提供） |
| 4 | `tag_merge_map.json` | 发行版默认（升级插件会覆盖） |

`<界面语言>` 取 Stash 全局语言设置（Settings → Interface → Language，`zh-TW` → `zh_TW`）。自定义映射表由 UI 版「导出文件」生成后放入本插件目录即可，无需替换默认文件。

## 触发方式与行为

| 入口 | 触发 | 行为 |
|---|---|---|
| 钩子 `Tag.Create.Post` | 任意 tag 创建 | 归一化查映射库 sources → 命中则合并进目标（目标不存在先建）→ 源名补写目标别名 → 自动补 stash_id |
| 任务「Full Scan & Merge」 | 任务列表页手动点击 | 全库扫描，按映射库合并全部可合并分组（源数降序），存量兜底 |
| 任务「Fill Stash IDs」 | 任务列表页手动点击 | 按候选词从 stash-box 为存量 tag 批量补写（已写入词自动跳过） |

合并行为与 UI 版一致：

- 匹配为**归一化后精确匹配**（全角→半角、忽略大小写与分隔符），不做子串/模糊匹配
- **防链式**：源名是其他条目的目标名时不作为源；目标自身的写法变体正常并入
- **幂等**：源 tag 已不存在（被先前合并消耗）时静默跳过，任务可重复执行
- 源 tag 合并后名称补写进目标别名（大小写不敏感去重），引用由 Stash 的 `tagsMerge` 统一转移，数据不丢失
- 以 `_` 开头的映射键跳过（说明键 / 被忽略的映射，与 UI 版一致）

## 填充 stash_id

复用 tagMerge UI 版「填充ID」规则（v2.7.3 起同源），差别仅在无 UI 预览、后台串行执行：

- **候选词**：主名 + 别名
- **归一化**：`fillNorm` = NFKC 全角→半角 + 小写 + 连续空格归一 + trim，**不删分隔符**（`3P/` 与 `3P·4P` 是不同实体）
- **精准匹配**：每词独立，查询词需命中实体 name 或 aliases（归一化后）；近似结果不写
- **写入**：每词精准实体全收集、排除已存在 id（endpoint+id）、append 全部写入——同一 box 可持有**多条** stash_id；无新增跳过（miss）
- **词级跳过**：候选词已写入该 box（词缓存实体全部已存在）不查询；新词/未命中词必查询——该 box 已有 id 的 tag，其新合并词照样查询
- **全量重查**：插件设置「Force re-query」开关（默认关）开启时全部词重新查询（绕过词缓存，可捕捉 stash-box 新增实体/别名），仅追加未写入实体
- **stash-box 选择**：任务参数 `stashBox` 默认 `javstash`，按实例名小写包含匹配；匹配不到按品牌优先级 JAVStash → StashDB → ThePornDB 选第一个
- **查询缓存**：命中词写入插件目录 `fill_cache.json`（按 endpoint 隔离），下次任务/钩子跳过已命中词（免查询免限速）；未命中词跨会话重查（可捕捉 stash-box 新增实体）；运行时产物不入库、升级插件保留
- **限速**：每词查询间隔 0.5s（≈120 次/分，公共 box 限流）；可重复执行（已写/未命中不重复写）
- **钩子自动化**：插件页「设置 → 插件 → Tag Merge Auto」中 `auto-fill stash_id` 开关（默认开）控制钩子合并后是否自动补 stash_id；新 tag 合并后只查一次、失败不阻塞合并

## 日志

结果写入插件目录的 `tag_merge_auto.log`（钩子/任务每次触发一行摘要：命中映射、合并方向、源列表、填充写入/冲突/未命中、失败项），**同时经 stderr 写入 Stash 日志**（`[Plugin / Tag Merge Auto]` 前缀，级别由 yml `errLog` 控制，默认 info）。

## 免责

合并会删除源 tag（保留别名与引用）。运行全量扫描前建议先做一次库备份（Stash「设置 → 任务 → 备份」）。
