# stashDiscover

> v0.2.8：头像卡定位修复——头像预载完成后再挂载（此前按塌陷高度定位，图片加载后卡片盖住演员名）；年龄/国籍徽章垂直居中对齐并更贴角落；年龄描边改为向四周渐淡
> v0.2.7：头像卡样式微调——头像不裁剪（只限制最大 120×120，保持原始比例）；年龄去背景改为白字深色描边（更小更粗）；国旗去描边缩小（18×12，轻投影）
> v0.2.6：搜索滚动简化——仅在点击搜索时滚动一次露出搜索状态，结果返回后不再二次滚动；头像卡改为纯头像并缩小（120px），左下角悬浮年龄、右下角悬浮国籍国旗（本地映射演员查本地 Stash，其余查 stash-box），国旗加载失败回退显示国家码
> v0.2.5：搜索时弹窗自动滚动到底部露出搜索状态；搜索栏按钮与输入框等高；弹窗演员名可点击——上方悬浮演员头像卡，点击头像打开 stash-box 演员页，点击空白关闭
> v0.2.4：修复「加入库」——urls 改为字符串数组、stash_ids 直接随 sceneCreate 提交、携带封面图，并增加两段式确认防误操作；修复「搜索资源」——后端归一化 Stash 监听地址（0.0.0.0 → 127.0.0.1），Jackett URL 支持只填根地址自动补全，带磁力的结果优先排序；「在 stash-box 查看」与来源标识改用品牌名（JAVStash / StashDB / TPDB）
> v0.2.3：封面角标重排——时长右下、工作室右上（字号调小）、预告左上角、来源左下角（多源时），预告与来源不再叠放；stash-box 每页大小按密度对称调整（修复只收缩不回升）；移除插件设置残留的每页个数读取
> v0.2.1：筛选条/卡片/分页按 Stash 原生样式还原；排序支持本地缓存重排；卡片新增演员/标签徽章悬停弹出；修复分页切换需点两次的问题
> v0.2.0：重命名为 stashDiscover；修正 stash-box API（queryScenes + images[] + findScene）；新增近期/预告窗口设置；加入库按 stash_id 映射演员/工作室；查看按钮动态显示源名

在 Stash 演员页面插入「发现」分页，发现该演员在已配置 stash-box 实例中存在、但本地库未拥有的场景。点击场景打开详情弹窗，可浏览封面剧照、加入库、在 stash-box 查看、通过 Jackett 搜索资源并复制磁力链接或推送到下载器。

## 功能

- **演员页分页注入**：在演员详情页标签栏新增「发现」标签
- **多 stash-box 支持**：自动读取 Stash 配置的所有 stash-box 实例
- **智能去重**：stash_id + 番号（code）双重匹配过滤本地已拥有场景；多 box 同场景按番号去重
- **近期窗口**（设置项 `recentDays`，默认 180）：仅显示最近 N 天内发行的场景，0 = 不限制
- **预告窗口**（设置项 `previewDays`，默认 7，字符串输入以支持 "-1"）：未来发行的场景视为预告。-1 = 隐藏全部预告，0 = 不限制，N = 仅显示 N 天内的预告。预告场景卡片左上角显示紫色「预告」角标
- **场景网格**：封面 + 标题 + 工作室 + 发行日期 + 时长 + 简介，与 Stash 原生 grid-card 一致；封面角标：时长右下、工作室右上、预告左上、来源左下（多源时）；文字下方显示演员/标签计数徽章，悬停弹出名单（本地演员带头像靠前）
- **原生筛选条**：搜索、日期排序下拉、升降序切换、每页个数（默认 40，发现页内调整）、卡片大小滑块；结果计数位于筛选条与卡片之间，底部分页为原生样式
- **详情弹窗**：
  - 封面 / 剧照轮播（左右翻页 + 计数器），打开时自动通过 `findScene` 获取完整详情（含导演、制作日期、URL 站点名等）
  - 三个主要操作按钮
  - 完整元数据（标题、番号、发行/制作日期、时长、导演、工作室、演员、标签、简介、链接）；点击演员名在上方悬浮纯头像卡（左下角年龄、右下角国籍国旗），点击头像打开 stash-box 演员页，点击空白处关闭
- **加入库**：将 stash-box 场景元数据创建为本地场景（两段式确认防误操作）。自动按 stash_id 映射所有演员和工作室（binge-cn 模式），查找/创建标签，携带封面图，stash_id 直接随创建提交
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

本插件遵循 binge-cn 的 stash-box 调用约定：

- **场景列表**：`queryScenes(input:{performers:{value:[id],modifier:INCLUDES},sort:DATE,direction:DESC,page,per_page})`
- **场景图片**：`images[{url}]`（封面 + 剧照的扁平数组，非 front_cover/back_cover/screenshots）
- **场景详情**：`findScene(id)` 获取完整字段（director、production_date、urls.site 等）
- **Web 链接**：`new URL(endpoint).origin + "/scenes/" + id`

## 版本历史

### v0.2.8
- 头像卡定位修复：头像预载完成后再挂载卡片（按真实尺寸定位），修复 v0.2.7 改为等比缩放后定位按塌陷高度计算、图片加载后卡片覆盖演员名的问题
- 预载期间再次点击同一演员名不再取消挂载（保持等待），避免"图片未加载完成时补点一次反而永远不出现"
- 年龄/国籍徽章统一 `inline-flex` 垂直居中（16px 行盒），更贴角落（bottom 3px / 左右 4px）
- 年龄描边改为渐变：内层细实描边保字形 + 外层三段递减模糊，向四周渐淡

### v0.2.7
- 头像卡样式微调：头像不再裁剪（`max-width/max-height: 120px` 保持原始比例）；年龄角标去背景，白字深色描边（10px/600）；国旗去描边缩小为 18×12（保留轻投影），文本回退同样用描边样式

### v0.2.6
- 搜索滚动简化：仅在点击搜索时滚动一次露出「正在通过 Jackett 搜索」，结果/错误在 loading 原位渲染，视口自然显示结果开头，不再二次滚动
- 头像卡改为纯头像并缩小（120px）：不再显示名字与「打开演员页」文字；左下角悬浮年龄徽章、右下角悬浮国籍国旗（flagcdn，加载失败回退国家码文本）
- 年龄/国籍按需异步查询：本地映射演员查本地 Stash `findPerformer{birthdate country}`，非本地演员查 stash-box `findPerformer{birth_date country}`，均由生日计算年龄；无数据时对应角标不显示

### v0.2.5
- 搜索开始与结果返回时弹窗自动平滑滚动到底部，露出搜索状态与结果区
- 搜索栏「搜索」按钮高度跟随输入框（覆盖小号按钮的固定 22px）
- 弹窗演员名可点击：上方悬浮演员头像卡（本地演员头像优先，无映射用 stash-box 图）；点击头像新标签打开对应 stash-box 演员页；点击空白处或滚动弹窗时关闭

### v0.2.4
- 修复「加入库」：`SceneCreateInput.urls` 为字符串数组（原传对象数组导致 GraphQL 校验失败）；`stash_ids` 直接随 `sceneCreate` 提交（删除第二次 `sceneUpdate` 往返）；携带封面图（`cover_image`）
- 「加入库」增加两段式确认：首次点击变为「确认加入库？」，4 秒内再次点击执行，超时自动还原，防止误操作
- 修复「搜索资源」：Python 后端将 Stash 监听地址 `0.0.0.0` / `::` 归一化为 `127.0.0.1`（Windows 下连接 0.0.0.0 报 WinError 10049，导致读取插件配置失败）
- Jackett URL 支持只填根地址（如 `http://192.168.3.190:9117`），自动补全 Torznab 端点；搜索结果中带磁力链接的优先显示
- 搜索结果区新增可编辑搜索框（原生样式）：默认搜索词自动推断（jav 用番号、欧美用标题），可按场景改词重搜（番号 / 标题 / 自定义关键词均支持）
- 「在 stash-box 查看」按钮与来源角标改用品牌名映射（javstash.org → JAVStash、stashdb.org → StashDB、theporndb.net → TPDB）

### v0.2.3
- 封面角标重排：时长右下、工作室右上（字号调小至 12px）、预告固定左上角、来源移至左下角（多源时显示），预告不再叠放于来源下方
- stash-box 每页大小密度自适应修复：此前只收缩不回升，现按剩余需求对称调整（高密度收缩到预期需求、需求增加时回升，范围 20–100）
- 移除插件设置残留的每页个数（perPage）读取死代码，每页个数仅由发现页筛选条控制

### v0.2.2
- 默认窗口：Recent Window 180 天 / Preview Window 7 天；Preview Window 输入框改为字符串类型，可输入 "-1"
- 每页个数（Scenes Per Page）从插件设置移至「发现」页筛选条，默认 40（20/40/80 可选）
- stash-box 拉取按 missing 密度动态调整每页大小：首轮按 box 允许的上限 100 拉取，密度低时翻倍增长、密度高且剩余需求少时收缩，减少翻页轮次与网络开销
- 预告角标移至卡片左上角（有来源角标时叠加其下方）
- 修复 Refract 主题下演员/标签徽章被隐藏的问题（高优先级覆盖原生 .card-popovers 的 display:none）

### v0.2.1
- 筛选条、场景卡片、底部分页按 Stash 原生样式还原（原生类名，主题自动继承）
- 「日期」改为下拉菜单（不切换方向）；方向按钮点击即时翻转，结果数 ≤ 每页个数时用本地缓存重排不重新拉取，否则转圈重新查询
- 卡片文字下方新增演员/标签计数徽章，悬停弹出名单：本地演员带头像靠前，非本地仅名字；弹出层不可点击
- 结果计数移至筛选条与卡片之间；底部分页改为原生 `< 1 2 >` 样式
- 修复打开「发现」后点击其他分页首次无响应的问题

### v0.2.0
- 重命名为 stashDiscover
- 修正 stash-box API：queryScenes 替代 queryPerformer，images[] 替代 front_cover/back_cover，findScene 获取详情
- 新增近期窗口（recentDays）和预告窗口（previewDays）设置项
- 预告场景显示紫色角标
- 加入库改为按 stash_id 映射所有演员和工作室（binge-cn 模式）
- 「在 stash-box 查看」按钮动态显示源域名
- 弹窗打开时自动 fetch 完整场景详情

### v0.1.0
- 初始版本（performerMissingScenes）
