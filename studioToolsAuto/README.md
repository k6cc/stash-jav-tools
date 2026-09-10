# studioToolsAuto

> v1.1.1：简化 Source priority / Multi-source fill 设置文案；timeoutPerSource 支持留空（留空 = 默认 8s）

Stash 纯后台插件（`interface: raw`，不注入任何页面脚本/样式）：工作室创建时自动从已配置的 Stash-box 实例（JAVStash / StashDB / ThePornDB / 自定义）拉取资料，归一化精确匹配后**合并进已有工作室**或**补全新建工作室**；任务页手动触发可对缺少首个优先级源 Stash ID 的工作室批量执行同一管线。

与 UI 版 [studioTools](../studioTools/README.md) 的分工：UI 版提供手动搜索/合并面板；本插件无人值守自动化，只处理**新建**工作室与**存量缺少首个优先级源 Stash ID** 的工作室，不做手动预览合并。

## 依赖

- Python（Stash 内置运行环境即可，标准库 only，无第三方依赖）
- 需要在 Stash「设置 → 元数据提供者」中配置至少一个 Stash-box 实例（默认使用全部已配置实例：javstash → stashdb → theporndb → 其余自定义，按配置顺序）

## 安装

1. 将整个 `studioToolsAuto` 文件夹复制到 Stash 插件目录（通常为 Stash 数据目录下的 `plugins/`）
2. 重启 Stash，在「设置 → 插件」中确认 Studio Tools Auto 已启用
3. 任务列表页出现「Scan Studios Without Stash IDs」任务即安装成功

## 设置

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| Source priority | STRING | 空（全部实例） | 逗号分隔的实例列表，**列表即开关 + 优先级**：未列出的实例跳过；内置 key `javstash` / `stashdb` / `theporndb`，自定义实例写 endpoint URL。留空 = 全部已配置实例（javstash → stashdb → theporndb → 其余自定义） |
| Multi-source fill | BOOLEAN | OFF | **多源补齐**：ON = 并发查询所有列表源，每个精确命中的源都贡献（stash_ids/urls/aliases 并集）；OFF = 按序查询、首个精确命中即停 |
| Timeout per source (s) | STRING | 8 | 每源拉取超时 |

## 触发方式与行为

| 入口 | 触发 | 行为 |
|---|---|---|
| 钩子 `Studio.Create.Post` | 任意工作室创建 | 按优先级拉取 → 归一化精确匹配 → canonical 名撞库（主名/别名）则合并进已有，否则补全新建 |
| 任务「Scan Studios Without Stash IDs」 | 任务列表页手动点击 | 扫描**缺少首个优先级源 Stash ID** 的工作室（已有该源 ID = 已完成，跳过），按同一管线更新（存量兜底） |

管线细节：

- **源解析**：优先级列表的第一个源（primary）决定任务扫描范围；拉取时默认按优先级顺序**首个精确命中即停**、失败/未命中回退下一源；开启多源补齐（ON）则并发查询所有列表源、每个精确命中的源都贡献（未列出的实例与本地未配置的实例均跳过）
- **匹配 = 归一化精确相等**（全角→半角、忽略大小写与分隔符），无相似度阈值；Stash 名称/别名**交叉唯一**，精确相等即确定命中
- **合并**：canonical 名撞库中已有工作室（主名或别名）→ 新建的合并进已有（Stash 无原生 studioMerge，自研流程与 UI 版一致：转移 scenes/images/galleries/groups/子工作室关联 → 更新目标字段 → 删除新建）
- **补全**：无撞 → 只填空字段；`urls` / `stash_ids` / `aliases` 追加缺失；**保留原名，canonical 名追加为别名**；别名写入前全库查重，撞其他工作室的名称/别名则跳过该别名（记日志）
- **图片**：子进程异步下载（钩子不阻塞，失败只影响图片不影响字段），仅在工作室无图时设置
- **上级工作室**：目标 parent 为空时按最高优先级命中的 parent 补齐，仅当本地已存在同名工作室才设置（不自动创建上级，与 studioTools UI 版一致）；不改 rating/收藏等人工字段

## 日志

每次处理结果写入插件目录的 `studio_tools_auto.log`（来源、命中/回退、合并或更新明细、被跳过的冲突别名），**同时经 stderr 写入 Stash 日志**（`[Plugin / Studio Tools Auto]` 前缀，级别由 yml `errLog` 控制，默认 info）。

## 免责

- 钩子/任务会**合并并删除**新建的重复工作室（引用已转移，数据不丢失）；运行全量扫描前建议先做一次库备份
- 拉取来源为公开 Stash-box 实例，资料以各实例为准
