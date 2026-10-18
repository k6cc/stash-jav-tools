# stashDiscover

> v2.0.0：新增无数据兜底面板——未配置 stash-box / 演员无对应编号 / 源访问失败 / 源无结果四种情况不再显示空白或红字，而是按源列出状态与失败原因，并提供重试、打开编辑面板、在源上查找 TA 等入口；源请求加 15 秒超时与错误分类；演员未关联编号时可在面板内搜源同名演员并一键写入 stash_id（别名/信息/图片按需补齐，可先预览再关联或覆盖），或拉起原生编辑覆盖层后自动检测编号写入并重查；仅因时间窗口过滤时提供「不限时间（本次）」临时放宽（不写入设置）；修复 JAV 场景详情弹窗剧照探测命中 DMM 占位符的问题（content id 零位补齐 + 按各源 gallery 条目重建真图地址）

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
- **Jackett 资源搜索**：通过 Jackett Torznab API 搜索（URL 只填根地址即可自动补全），带磁力的结果优先、按做种数排序；默认搜索词自动推断（jav 用番号、欧美用标题），结果区顶部提供可编辑搜索框，支持按场景修正搜索词；点击搜索时弹窗自动滚动露出搜索状态，结果返回后原位替换不再滚动
- **复制磁力链接** / **推送 qBittorrent 下载**
- **双语界面** + **响应式设计**

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

## stash-box API 说明

本插件的 stash-box 调用约定：

- **场景列表**：`queryScenes(input:{performers:{value:[id],modifier:INCLUDES},sort:DATE,direction:DESC,page,per_page})`
- **场景图片**：`images[{url}]`（封面 + 剧照的扁平数组，非 front_cover/back_cover/screenshots）
- **场景详情**：`findScene(id)` 获取完整字段（director、production_date、urls.site 等）
- **Web 链接**：`new URL(endpoint).origin + "/scenes/" + id`

