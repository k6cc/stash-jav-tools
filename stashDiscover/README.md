# stashDiscover

> v2.6.2：发现页缓存瘦身，单条体积降约四分之一，大型库（4000 部）不再因缓存预算被悄悄裁掉早期场景；缓存确实被裁时计数旁会提示「缓存不完整」，点击即重新拉取；封面取图上限收紧到实际会用到的张数；移除任务页两个无法手动使用的按钮。

在 Stash 演员页面插入「发现」分页，发现该演员在已配置 stash-box 实例中存在、但本地库未拥有的场景。点击场景打开详情弹窗，可浏览封面剧照、加入库、在 stash-box 查看、通过 Jackett 搜索资源并复制磁力链接或推送到下载器。

## 功能

- **演员页分页注入**：在演员详情页标签栏新增「发现」标签
- **多 stash-box 支持**：自动读取 Stash 配置的所有 stash-box 实例
- **无数据兜底面板**：未配置 stash-box / 演员无对应编号 / 源访问失败 / 源无结果时，按源列出状态与失败原因，面板内提供重试、打开编辑面板、在源上查看；源请求带 15 秒超时与错误分类，部分源失败时卡片区顶部提示并可就地重试
- **编号关联闭环**：演员未关联编号时，可「在源上查找 TA」内联搜索各源同名演员并一键写入本地 stash_id；也可「打开编辑面板」拉起原生编辑覆盖层，写入编号后自动检测并重查
- **临时放宽时间窗口**：场景仅因时间窗口被过滤时，可「不限时间（本次）」临时放开近期/预告窗口（不写入设置），卡片区上方提供恢复入口
- **智能去重**：stash_id + 番号（code）双重匹配过滤本地已拥有场景；多 box 同场景按番号去重
- **近期窗口**（设置项 `recentDays`，默认 180）：仅显示最近 N 天内发行的场景，0 = 不限制
- **预告窗口**（设置项 `previewDays`，默认 7，字符串输入以支持 "-1"）：未来发行的场景视为预告。-1 = 隐藏全部预告，0 = 不限制，N = 仅显示 N 天内的预告。预告场景卡片左上角显示紫色「预告」角标
- **场景网格**：封面 + 标题 + 工作室 + 发行日期 + 时长 + 简介，与 Stash 原生 grid-card 一致；封面角标：时长右下、工作室右上、预告左上、来源左下（多源时）；文字下方显示演员/标签计数徽章，悬停弹出名单（本地演员带头像靠前）
- **场景列表**：原生 table-list 表格视图（封面、标题、日期、番号、时长、工作室、演员、标签）；点击封面打开详情弹窗，点击标题新标签打开 stash-box 场景页
- **原生筛选条**：搜索、日期排序下拉、升降序切换、每页个数（默认 40，发现页内调整）、网格/列表显示切换（记忆选择）、卡片大小滑块（仅网格）；结果计数位于筛选条与卡片之间，底部分页为原生样式
- **详情弹窗**：
  - 封面 / 剧照轮播（左右翻页 + 计数器）；JAV 场景额外按番号 / r18 链接探测 DMM 官方剧照（欧美源仅有封面），打开时自动通过 `findScene` 获取完整详情（含导演、制作日期、URL 站点名等）
  - 三个主要操作按钮
  - 完整元数据（标题、番号、发行/制作日期、时长、导演、工作室、演员、标签、简介、链接）；点击演员名在上方悬浮纯头像卡（左下角年龄、右下角国籍国旗），点击头像打开 stash-box 演员页，点击空白处关闭
- **加入库**：将 stash-box 场景元数据创建为本地场景（两段式确认防误操作）。自动按 stash_id 映射所有演员和工作室，查找/创建标签，携带封面图，stash_id 直接随创建提交
- **在 stash-box 查看**：新标签页打开该场景在对应 box 上的页面。已知源显示品牌名（javstash.org → JAVStash、stashdb.org → StashDB、theporndb.net → TPDB），未知源回退显示主机名
- **Jackett 资源搜索**：通过 Jackett Torznab API 搜索（URL 只填根地址即可自动补全），带磁力的结果优先、按做种数排序，再按标题与搜索词的匹配度重排（匹配度低的折叠在列表末尾，点「显示」展开）；默认搜索词自动推断（jav 用番号、欧美用标题），结果区顶部提供可编辑搜索框，支持按场景修正搜索词；每条结果标注来源索引器；点击搜索时弹窗自动滚动到底，结果返回后对齐结果抬头
- **复制磁力链接** / **推送 qBittorrent 下载**
- **双语界面** + **响应式设计**

## 发现页（主导航「发现」）

`enableDiscoverPage`（默认开启）是总闸，关掉后整个发现页模块不加载。日常收起入口不用关它 —— 导航按钮和内置菜单项一样，可以在 **设置 → 界面 → 菜单项目** 里勾选显示/隐藏（勾掉只隐藏按钮，直链 `/plugins/stashDiscover` 仍可打开）。

导航「发现」按钮聚合**库内演员**在 stash-box 上的未拥有新场景（回看窗口独立于演员 tab：读取 `recentDays`，默认 30 天，0 = 不限）：

- **总览 6 模块**：有新发布的演员（迷你卡）/ 最新发布（每人 cap 2）/ 热门（全站榜）/ 即将发布（预告）/ 工作室新发布（库内收藏工作室，cap 2/工作室）/ 发现演员（共同出演 + 热门演员榜，不在库的演员）
- **钻取视图**：最新 / 热门 / 预告 / 工作室四个下钻页（面包屑 + 分页 + 搜索 + 排序 + 网格/列表切换）
- **演员过滤视图**：演员详情头部（头像/元数据/关注按钮/发现 Tab 跳转/主页/StashDB 外链）+ 该演员全部新场景
- **工作室过滤视图**：工作室分组 chip 条 → 工作室详情（场景列表，角标区分库内/未拥有）
- **数据源切换**：多源时工具栏可切换当前数据源（单源视角，与演员 tab 的多源合并互补）
- **主题跟随**：从当前页面采样派生设计 token，深色/浅色/自定义 CSS 主题自动适配；375px 窄屏适配
- **卡片复用**：与演员 tab 同一套场景卡（封面角标/悬停 popover/详情弹窗/加入库/Jackett），新场景带未读红框，点击即标记已读

### 批量选择

两个入口都能多选，场景与演员可混选后一次处理：

| 入口 | 可批量做的事 |
|---|---|
| 发现页工具栏的多选开关 | 忽略 / 加入库 |
| 演员页「发现」tab 的多选开关 | 忽略 / 加入库 |

批量入库走 `sceneCreate` 与 `batchAddPerformers`；已在库的条目跳过，结果按成功 / 失败 / 跳过分别回报。

### 入库字段

「加入库」写入哪些字段按场景 / 演员分别存默认值，也能在确认弹窗里当场改（当场改动不回写默认值）。演员是三态：全写 / 只关联库里已有的 / 不写 —— 「只关联」用来避免同名误建。

### 忽略记录（设置 → 已忽略管理）

发现页可忽略不想再看到的场景 / 演员；管理页按名字、别名、番号、工作室、演员名搜回，逐条或全部恢复。

演员页「发现」tab 里的场景被全部忽略后，面板会给出临时查看入口：放出来的卡片带「已忽略」角标，忽略记录不受影响，恢复隐藏即回到原来的列表。临时放出来的卡片再点「忽略」不会改写原记录（已有的直接跳过），批量撤销也只回滚本次新增的那些。

忽略时把卡片上现成的字段存成**快照**，管理页因此不发任何请求——已下架条目反查 stash-box 失败率高，且每次翻页都要等。

| 类型 | 字段 | 用途 |
|---|---|---|
| 场景 | `at` | 忽略时间：排序与弹窗「忽略于」 |
| 场景 | `title` `code` `studio` `date` | 卡片与弹窗文字、搜索命中 |
| 场景 | `cover` | 缩略图与弹窗封面 |
| 场景 | `p` | 前 4 位演员名：搜索 + 弹窗名单 |
| 演员 | `at` `name` `image` | 排序 / 标题 / 头像 |
| 演员 | `alias_list` | 前 12 个别名：搜索 + 弹窗名单 |
| 演员 | `country` `birthdate` `gender` | 国旗、年龄（本地算）、性别符号 |

上限：场景 / 演员各 3000 条、整包 1,000,000 字符；超限按忽略时间淘汰最旧的，管理页显示累计淘汰条数。

**导出文件**（`stashDiscover-ignored-YYYY-MM-DD.json`）：

```json
{
  "version": 1,
  "exportedAt": "2026-10-30T12:00:00.000Z",
  "trimmed": 0,
  "scenes": {
    "<endpoint>:<sceneId>": { "at": 0, "title": "", "date": "", "code": "", "cover": "", "studio": "", "p": [] }
  },
  "performers": {
    "<endpoint>:<stashId>": { "at": 0, "name": "", "image": "", "alias_list": [], "country": "", "birthdate": "", "gender": "" }
  }
}
```

导入只补本地没有的键，不覆盖已有决策与忽略时间；`version` 比插件新的文件照读已知字段并提示；键不是 `endpoint:id`、或值不是对象的条目计入「格式无效」跳过。

## 关注通知系统

- **关注演员**：演员卡 ♥ / 演员弹层 / 演员过滤视图一键关注，新作品进「关注」视图分组展示
- **收藏导入**：「关注」视图与设置中可从库内收藏（❤）演员一键导入（仅导入有 stash-box 关联的）
- **未读提醒**：新场景红框 + 关注 tab 红点 + 导航「发现」按钮角标（未读数）；已读标记 7 天过期
- **后台轮询**：打开 Stash 即检查关注演员新作品（每 6 小时至多一次，只查关注列表，轻量）；打开发现页时全量管线零成本修正角标
- **免打扰**：设置中可关闭「关注的演员新发布提醒」（跳过轮询 + 隐藏角标）

## 工作室页「发现」tab

工作室详情页（`/studios/{id}`）注入与演员页同构的「发现」tab：该工作室（含 stash-box 层级匹配的母厂牌）在所有已配置 stash-box 的未拥有场景，多源合并，时间窗口与演员 tab 一致；「在源上查找」为演员专属功能，工作室 tab 不显示。

## 安装

1. 将 `stashDiscover/` 文件夹复制到 Stash 插件目录（`%USERPROFILE%\.stash\plugins\`）
2. 重启 Stash 或在 设置 → 插件 中 Reload Plugins
3. 确认插件已启用

### 依赖

- Stash v0.20+（推荐 v0.24+）
- Python 3.8+
- 已配置至少一个 stash-box 实例（设置 → 元数据提供者）
- 演员已关联对应 stash-box ID
- （可选）Jackett 实例 / qBittorrent

### Docker / Linux 部署

官方 `stashapp/stash` 镜像只有 `ca-certificates`、`vips-tools`、`ffmpeg`，**不含 Python**，而 Jackett 搜索与推送到下载器这两条链路都要跑 `stashDiscover.py`。不装 Python 时这两项会报 `executable file not found`，其余功能（浏览、入库、关注）不受影响。

```dockerfile
FROM stashapp/stash:latest
USER root
RUN apk add --no-cache python3     # Debian 基础镜像用 apt-get install -y python3
USER stash
```

插件 `exec` 声明的是 `python`，Stash 会自己先找 `python3` 再找 `python`（也可在 Stash 设置里指定解释器路径），所以容器里装 `python3` 就够。

容器内填地址有两个坑：

| 场景 | 不要填 | 应该填 |
|---|---|---|
| Jackett 在宿主机 | `http://localhost:9117` | `http://<宿主局域网IP>:9117` 或 `http://host.docker.internal:9117` |
| qBittorrent 在宿主机 | `http://localhost:8080` | 同上 |

`localhost` / `127.0.0.1` 在容器里指向 Stash 容器自己，不是宿主机。Linux 上 `host.docker.internal` 需要 compose 里加 `extra_hosts: ["host.docker.internal:host-gateway"]`，或直接用宿主 IP。

插件目录挂载到 `/root/.stash/plugins/stashDiscover`；目录需可写（Python 要写 `__pycache__`）。反代超时见下方「注意事项」。

## 配置

在 设置 → 插件 → stashDiscover 中配置：

| 设置项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| Recent Window (days) | NUMBER | 180 | 仅显示最近 N 天发行的场景。0 = 不限制 |
| Preview Window (days) | STRING | 7 | 未来场景的预告窗口，字符串输入以支持 "-1"。-1 = 隐藏全部预告，0 = 不限制，N = N 天内 |
| Jackett API URL | STRING | — | Jackett 根地址（自动补全 Torznab 端点）或完整 Torznab 端点 |
| Jackett API Key | STRING | — | Jackett API Key |
| Downloader Type | STRING | — | 目前仅支持 qbittorrent |
| Downloader URL | STRING | — | qBittorrent Web UI 地址 |
| Downloader Username | STRING | — | qBittorrent 用户名 |
| Downloader Password | STRING | — | qBittorrent 密码 |
| Preferred stash-box | STRING | — | 优先查询的 box 端点子串，留空=查询所有 |
| Enable Discover Page | BOOLEAN | true | 发现页总闸：关闭后导航入口消失、页面停用、discover.js 不加载（演员/工作室页的「发现」tab 不受影响）；需刷新浏览器生效。只想收起导航按钮的话，去 设置 → 界面 → 菜单项目 里取消勾选「发现」即可 |

## 注意事项

- **资源搜索是同步请求**：结果由 Stash 的插件调用直接返回，不经日志。Jackett 慢时这个请求会一直挂着，最长到后端 `jackettTimeout`（默认 120 秒）。**反向代理若设 60 秒超时需放宽到 180 秒以上**，否则会被提前切断，界面看到的仍是失败。
- 单次最多返回 200 条结果，超出时列表上方提示总数与实际显示条数，改搜索词可缩小范围。
- **搜索词质量决定结果质量**：Jackett 的查询是自由文本，索引器普遍按词匹配。TPDB 场景没有番号可用（其 code 字段是 `japanhdv.com-6097` 这类域名 id），只能用英文标题搜，泛匹配结果会偏多 —— 插件会按标题命中率重排并折叠低匹配项，想更精确可直接改搜索框里的词。
- **qBittorrent 4.x / 5.x**：两者 Web UI API 兼容，实测 5.3.0 的推送下载正常。

## stash-box API 说明

本插件的 stash-box 调用约定：

- **场景列表**：`queryScenes(input:{performers:{value:[id],modifier:INCLUDES},sort:DATE,direction:DESC,page,per_page})`；工作室侧用 `studios:{value:[id],modifier:INCLUDES}`（stash-box 按层级匹配，含母厂牌）
- **场景图片**：`images[{url}]`（封面 + 剧照的扁平数组，非 front_cover/back_cover/screenshots）
- **场景详情**：`findScene(id)` 获取完整字段（director、production_date、urls.site 等）
- **Web 链接**：`new URL(endpoint).origin + "/scenes/" + id`

