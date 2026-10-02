# stashDiscover

> v1.1.0：新增原生列表显示（筛选栏网格/列表切换图标，记忆用户选择；列表列：封面、标题、日期、番号、时长、工作室、演员、标签；点封面开弹窗、点标题新标签打开 stash-box 场景页）；弹窗「番号」整项点击即复制（短暂变色反馈）；封面区 jav 标准比例铺满；演员头像卡点击即现竖版骨架（年龄/国籍角标、屏幕边缘避让）；翻页立即渲染本地已知内容、后台增量补齐；box 拉取到达窗口边界提前停止

在 Stash 演员页面插入「发现」分页，发现该演员在已配置 stash-box 实例中存在、但本地库未拥有的场景。点击场景打开详情弹窗，可浏览封面剧照、加入库、在 stash-box 查看、通过 Jackett 搜索资源并复制磁力链接或推送到下载器。

## 功能

- **演员页分页注入**：在演员详情页标签栏新增「发现」标签
- **多 stash-box 支持**：自动读取 Stash 配置的所有 stash-box 实例
- **智能去重**：stash_id + 番号（code）双重匹配过滤本地已拥有场景；多 box 同场景按番号去重
- **近期窗口**（设置项 `recentDays`，默认 180）：仅显示最近 N 天内发行的场景，0 = 不限制
- **预告窗口**（设置项 `previewDays`，默认 7，字符串输入以支持 "-1"）：未来发行的场景视为预告。-1 = 隐藏全部预告，0 = 不限制，N = 仅显示 N 天内的预告。预告场景卡片左上角显示紫色「预告」角标
- **场景网格**：封面 + 标题 + 工作室 + 发行日期 + 时长 + 简介，与 Stash 原生 grid-card 一致；封面角标：时长右下、工作室右上、预告左上、来源左下（多源时）；文字下方显示演员/标签计数徽章，悬停弹出名单（本地演员带头像靠前）
- **场景列表**：原生 table-list 表格视图（封面、标题、日期、番号、时长、工作室、演员、标签）；点击封面打开详情弹窗，点击标题新标签打开 stash-box 场景页
- **原生筛选条**：搜索、日期排序下拉、升降序切换、每页个数（默认 40，发现页内调整）、网格/列表显示切换（记忆选择）、卡片大小滑块（仅网格）；结果计数位于筛选条与卡片之间，底部分页为原生样式
- **详情弹窗**：
  - 封面 / 剧照轮播（左右翻页 + 计数器），打开时自动通过 `findScene` 获取完整详情（含导演、制作日期、URL 站点名等）
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

