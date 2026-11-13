# stashDiscover

> v2.7.10：热门演员榜弹窗的场景加 10 分钟缓存；演员页「发现」标签离开再回来时 10 分钟内直接复用上次结果（刷新按钮照常重查）。

Stash 插件（`interface: raw` + UI）：从已配置的 stash-box 实例中找出本地库未拥有的场景，浏览、加入库、找资源并推送到下载器。

## 依赖

- Stash v0.20+（推荐 v0.24+）
- Python 3.8+（仅找资源与推送下载需要）
- 已配置至少一个 stash-box 实例（设置 → 元数据提供者）
- 演员 / 工作室已关联对应 stash-box ID
- （可选）Jackett 实例、qBittorrent / Motrix、Whisparr v3

## 安装

1. 将 `stashDiscover/` 文件夹复制到 Stash 插件目录（`%USERPROFILE%\.stash\plugins\`）
2. 重启 Stash 或在 设置 → 插件 中 Reload Plugins
3. 确认插件已启用

### Docker / Linux 部署

官方 `stashapp/stash` 镜像不含 Python，而找资源与推送到下载器都需要 Python。不装时这两项会报 `executable file not found`；浏览、入库、关注不受影响。

```dockerfile
FROM stashapp/stash:latest
USER root
RUN apk add --no-cache python3     # Debian 基础镜像用 apt-get install -y python3
USER stash
```

容器里装 `python3` 即可（Stash 会先找 `python3` 再找 `python`，也可在 Stash 设置里指定解释器路径）。

容器内 `localhost` / `127.0.0.1` 指向 Stash 容器自己，不是宿主机：Jackett、qBittorrent 在宿主机时填宿主局域网 IP 或 `host.docker.internal`（Linux 需 compose 加 `extra_hosts: ["host.docker.internal:host-gateway"]`）。

插件目录需可写。

## 设置

| 设置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| Recent Window (days) | STRING | 180 | 只显示最近 N 天发行的场景，0 = 不限，留空 = 180。仅演员 / 工作室 tab 生效 |
| Preview Window (days) | STRING | 7 | 未来场景的预告窗口。-1 = 隐藏全部，0 = 不限，N = N 天内。字符串输入以支持 `-1`，仅演员 / 工作室 tab 生效 |
| Jackett API URL | STRING | — | Jackett 根地址（自动补全 Torznab 端点）或完整 Torznab 端点 |
| Jackett API Key | STRING | — | Jackett API Key |
| Jackett Timeout (seconds) | STRING | 120 | 搜索超时秒数，留空 = 120，上限 600。慢 NAS 或索引器多时调大 |
| Downloader Type | STRING | qbittorrent | `qbittorrent` 或 `motrix`，留空 = qbittorrent |
| Downloader URL | STRING | — | qBittorrent 填 Web UI 地址；Motrix 桌面版填 RPC 地址 `http://127.0.0.1:16800`，Docker 版填 Web 地址 |
| Downloader Username | STRING | — | 仅 qBittorrent，Motrix 留空 |
| Downloader Password | STRING | — | qBittorrent Web UI 密码；Motrix 填「高级 → RPC」的密钥（桌面版）或 operator-token（Docker 版） |
| Whisparr URL | STRING | — | Whisparr v3 地址，如 `http://127.0.0.1:6969`，留空 = 不使用 Whisparr |
| Whisparr API Key | STRING | — | Whisparr → 设置 → 通用 → API Key |
| Preferred stash-box | STRING | — | 优先查询的 box 端点子串，留空 = 查询全部已配置实例 |
| Discover page | BOOLEAN | ON | 发现页总闸：关闭后整页与关注新作提醒一并停用；演员 / 工作室 tab 不受影响 |

## 入口与覆盖范围

| 入口 | 覆盖范围 |
|---|---|
| 演员详情页「发现」tab | 该演员在全部已配置 box 上的未拥有场景，多源合并；编号未关联时可在源上查找该演员并写入 stash_id |
| 工作室详情页「发现」tab | 该工作室（含 box 层级匹配的母厂牌）的未拥有场景，多源合并 |
| 主导航「发现」页 | 库内演员与收藏工作室的新作：总览（新发布 / 热门 / 即将发布 / 发现演员）、按演员与工作室分组的场景列表、批量忽略与入库；列表可按标题、番号、简介、工作室、演员、标签搜索 |
| 设置 → 已忽略管理 | 搜回被忽略的场景 / 演员并恢复，支持导出与导入 |

批量忽略与入库支持场景、演员混选；已在库的条目跳过。

## 核心机制

### 数据源与去重

- 自动复用 Stash「设置 → 元数据提供者」里配置的全部 stash-box 实例
- 端点写成 `http://`、带 `www.` 或末尾斜杠时按等价地址重试
- 本地已有按 stash_id 或番号命中即过滤；多 box 同一场景按番号合并
- 热门榜保留完整榜单与名次，已入库的仍上榜；其余视图只列未拥有
- 热门演员榜先摘掉已忽略与已入库的演员，由其后的 30 名以内补位，名次保留原值
- 多源时可只看单个源

### 时间窗口

- `recentDays` / `previewDays` 只作用于演员、工作室 tab；发现页的回看窗口独立（默认 30 天，0 = 不限）
- 发现页不做未来窗口过滤，预告模块列全部未来场景
- 场景仅因窗口被过滤时，可临时不限时间（不写入设置）

### 加入库（写入语义）

- 写入 stash-box 元数据，按 stash_id 映射演员与工作室；标签按名字查找，缺失则创建
- 演员三态：全写 / 只关联库里已有的 / 不写 —— 「只关联」用于避免同名误建
- 已在库的按 stash_id + 番号判重跳过
- 默认值按场景 / 演员分别保存，确认时的改动不回写默认值

### 找资源（Jackett）

- 搜索词按序推断：番号 → `YY MM DD` + 首位女演员 → 标题；演员名非拉丁文的场景不拼日期词
- 结果带磁力优先、按做种数排序，再按与搜索词的匹配度重排并折叠低匹配项
- 单次最多返回 200 条
- 支持复制磁力、推送 qBittorrent / Motrix；推送到 Whisparr 仅支持 v3，且仅 stashdb.org 源的场景（Whisparr 只认 TPDB 的 ID）

### 忽略记录

- 忽略时保存条目快照，管理页不再请求 box
- 上限：场景 / 演员各 3000 条、整包 1,000,000 字符，超限按忽略时间淘汰最旧
- 导出的 JSON 以 `<endpoint>:<id>` 为键；导入只补本地没有的键，不覆盖已有记录与忽略时间
- 在某演员的 tab 里场景被全部忽略后，临时放出的条目不改动既有忽略记录

### 关注通知

- 关注演员的新作计入未读；库内已收藏的演员可一键导入关注（仅导入已关联 box 的）
- 打开 Stash 任意页面即检查关注列表，每 6 小时至多一次
- 已读标记在回看窗口 + 7 天后过期，窗口不限则不过期
- 可关闭关注提醒，轮询与未读一并停用

## 注意事项

- **资源搜索是同步请求**：Jackett 慢时请求会一直挂着，最长到 `jackettTimeout`（默认 120 秒）。**反向代理若设 60 秒超时需放宽到 180 秒以上**，否则会被提前切断。
- **源限流自动退避**：源返回 429 时按它要求的间隔重试，两次仍被拒才报错；被限流过的源随后五分钟内自动拉大请求间隔。超时、网络与鉴权错误不重试。
- **qBittorrent 4.x / 5.x**：两代都能推送。
- **Motrix 不用填保存目录**：桌面版走 aria2 默认下载目录，Docker 版从 Motrix 自己的设置里读。
- **Whisparr 质量档案**在发现页「设置 → 推送质量档案」里选；默认「自动」= 先找名为 Any 的档案，再退到 id 最小的那个。根目录取 Whisparr 里的第一个。
- **更新插件后按 Ctrl+F5 强刷**：前端 JS/CSS 由 Stash 静态下发、不带版本号，浏览器会继续用旧的。
