> v1.0.0：基于 sanjiswe 的 O Stats 插件的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言。

# oStatsI18n

统计页 O 统计 + 观看时长追踪插件（O Stats 的多语言重构）。纯 UI + Python 任务：把今日 O 数、纪录日、连续天数、平均时长等卡片，O 次数 / 观看时长柱状图与「当日回顾」时间线注入统计页；观看时长按日记录并跨设备同步。

## 依赖

- Stash 界面语言为中文时 UI 显示中文，否则英文（i18n 桥接失败降级英文）
- Python（`saveWatchData` 任务，保存观看时长）

## 安装

复制 `oStatsI18n` 文件夹到 Stash 插件目录，重启 Stash，进入统计页即生效。

## 触发方式

| 入口 | 行为 |
|---|---|
| 统计页 | 渲染 O 统计卡片、最 O/最长播放场景、双柱状图、当日回顾时间线、观看时长导出/导入、缓存开关 |

## 核心机制

- 观看时长：页面播放 10 秒采样、2 秒防抖，经 `saveWatchData` 任务写入 `watch_data.json`（简单格式：日期 → 当日总秒数）；跨标签页经 localStorage 合并，页面卸载用 sendBeacon 兜底
- O 统计：按 `o_history` 时间戳构建日期映射，一次遍历供全部卡片/图表复用
- 缓存：场景数据 localStorage 缓存（10 分钟 TTL，统计页底部开关）
- 导出格式：`{"version":"2.0","data":{"YYYY-MM-DD":"watchTime,oCount"}}`

## 文件说明

| 文件 | 说明 |
|---|---|
| oStatsI18n.js | UI 主逻辑（含中英文案，插件 ID 为 `oStatsI18n`） |
| oStatsI18n.yml | 插件定义与任务声明 |
| save_watch_data.py | Python 任务：保存/读取观看数据（load 模式含旧格式迁移） |
| load_watch_data.py | 旧版独立读取脚本（未挂任务，保留兼容） |

## 注意事项

- `watch_data.json` 为运行时数据（不随仓库发布），删除后从零开始记录
- 与官方 O Stats 并存时各自独立存储（localStorage 键、数据路径、任务 ID 均以 `oStatsI18n` 命名）
- 中文界面下时间使用 24 小时制，日期使用中文格式；英文界面保持原 12 小时制与 `MM/DD/YYYY`
