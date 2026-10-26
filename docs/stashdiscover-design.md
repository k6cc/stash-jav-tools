# 发现页设计定稿（讨论记录）

> 状态：设计讨论已完成，待实施。2026-10-22 与用户逐条确认。
> 范围：在 stashDiscover 插件内新增全局"发现"导航页，展示库内演员的未拥有场景，附关注通知系统。
> 修订：2026-10-22 第二轮——开关默认开、发现页单源、全部已读按钮、通知开关、轮询澄清。
> 修订：2026-10-22 第三轮——热门演员榜查询定稿（复用 binge）、设置分级原则、查询源持久化。
> 修订：2026-10-22 第四轮——卡片与响应式规范（卡片还原第一）、演员过滤视图（详情+场景复用模块）。
> 修订：2026-10-22 第五轮——演员过滤视图详情区元素与按钮区细化。
> 修订：2026-10-22 第六轮——可复用模块清单、铃铛定位迁入 §10、确认望远镜图标不变。
> 修订：2026-10-22 第七轮——角标技术可行性查证（MainNavBar.MenuItems 无原生 Badge，但插件对 NavLink 子节点有完全控制权，可叠加绝对定位角标）。
> 修订：2026-10-23 第八轮——导航图标定稿为卫星天线 faSatelliteDish（与轮询接收新作信号机制语义自洽），弃用双筒望远镜。
> 修订：2026-10-23 第十轮——扩展"工作室新发现"侧：发现页加"工作室新发布"模块 + 工作室钻取视图、工作室详情页注入"发现"tab、工作室过滤视图复用演员过滤视图模块、工作室数据管线（`studios INCLUDES` GraphQL filter + `sort DATE`）。坚持轻量单一架构，不引入后端任务与文件缓存。

---

## 1. 开关与加载架构（已确认）

- `stashDiscover.yml` 新增 BOOLEAN 设置 `enableDiscoverPage`，**默认开**（既然开发了，先让用户看到，不喜欢再手动关），切换后需刷新浏览器。
- 主 JS 始终加载（必须先读设置才能决定后续），开关打开时动态注入独立 `discover.js`——发现页代码关闭时完全不进浏览器。
- 主 JS 多出约 100 行共享工具导出（`window.SSD` 命名空间），关闭时仅解析、零执行开销。
- Stash CSP `script-src 'self'` 已确认放行同源 `/plugin/stashDiscover/discover.js` 动态注入。

## 2. 导航入口与路由（已确认）

- 入口：主导航栏（`MainNavBar.MenuItems` patch，curator 插件已在本 Stash 版本验证可用）。
- 标签："发现"，图标：卫星天线 `faSatelliteDish`（FA6 solid）。语义与"轮询接收关注演员新作信号"机制自洽，整页概念闭环。兜底：FA 不可用时用内联 SVG（path 取自 `svgs/solid/satellite-dish.svg`）。
- 路由：`/plugins/stashDiscover`（`PluginApi.register.route`）。
- React 页面组件 + ref/useEffect 挂载 vanilla 渲染（curator 同款模式）。

## 3. 页面结构

### 3.1 顶部控制区（自上而下）

1. 页标题"发现" + meta chips（场景数 / 演员数 / 数据源）+ 刷新按钮 + "X小时前更新"相对时间。
2. 模块滑动开关组（InsightsI18n `.ins-tabs` 胶囊风格：圆角容器 + `color-mix` 高亮，用 Stash CSS 变量保证主题跟随）：
   `⌂ 总览 | ♥ 关注 | ◷ 最新 | ▲ 热门 | ▷ 预告 | ☺ 发现演员 | ▣ 工作室 | ⚙ 设置`
   - 既是模块切换也是钻取入口；"关注"tab 角标红点 = 有未读。
   - "工作室"tab 是工作室侧钻取入口（第十轮扩展），与演员侧各模块对称。
   - "设置"按钮独立在右侧。
3. 筛选行（贯穿所有视图）：搜索、排序、每页、网格/列表切换、**数据源切换下拉**（仅配置了多个 stash-box 时显示，见 §4.5）。
4. 分页开关组（仅钻取模式，与筛选行**平行**）：`‹ [1][2][…][n] ›` 页码胶囊 + 每页数；底部重复一次免滚回顶部。

### 3.2 总览模式（模块顺序已确认）

| 顺序 | 模块 | 行数 | 卡片 |
|---|---|---|---|
| 1 | ★ 有新发布的演员 | 1 | 迷你演员卡：头像+名字+"N 部新作品"角标 |
| 2 | ◷ 最新发布 | 2 | 原生场景卡 |
| 3 | ▲ 热门（与 4 并排） | 1 | 原生场景卡 |
| 4 | ▷ 即将发布（与 3 并排） | 1 | 原生场景卡 + "X天后上映"角标 |
| 5 | ▣ 工作室新发布 | 1 | 原生场景卡（含工作室信息） |
| 6 | ☺ 发现演员 | 1 | 迷你演员卡：头像+名字+来源标记 |

- 每模块头部：标题 + 统计 + 「查看更多 →」（切到该模块钻取视图）。
- 热门/即将发布两个 1 行模块左右并排（窄屏自动堆叠）；发现页设置可关闭并排（`mergeTrendPreview`，默认开 — 用户 2026-10-26）。
- 并排开启时，设置页里「热门」与「即将发布」合并为**一个设置项**（用户 2026-10-26）：一个显示开关同时控制两者、一个行数值同时写入 `rows.trending` / `rows.preview`、一组上移/下移把两者视为整体移动（`pairAdjacentOrder` + `moveModulePair`）。关闭并排后恢复为两个独立设置项。
- 各模块行数可在设置里调 1–3。

### 3.3 钻取模式

- 点击「查看更多」或顶部模块开关 → 单模块全量分页视图。
- 返回总览：靠顶部模块开关（第七轮起无「← 返回总览」面包屑）。
- 分页开关组出现（见 3.1.4）。

### 3.4 关注视图

- 按关注演员分组：头像 + 名字 + "N 部新作品 · 未读/已读" + 展开箭头 + 详情 + 取消关注。
- **整行点击 = 展开/收起**（详情、取消关注、箭头按钮除外），手风琴最多展开一位，默认全部收起（第七轮）。
- **单源口径**（第七轮）：只列当前数据源的关注演员、只统计当前源的未读；角标轮询同源；切换数据源即重算。
- 展开后显示该演员的场景卡（未读场景红框标记）；分组内场景**不受**每人上限约束。
- 视图顶部「**全部已读**」按钮：一键标记全部已读、消除铃铛。
- 场景级已读：点开卡片或加入库后标已读；7 天自动过期兜底清铃铛。
- 全部已读 / 当前源无关注演员时显示空状态（后者提示切换源或导入）。

### 3.5 发现演员视图

- 模块内子切换两个数据源：
  - **共同出演**（默认）：从已拉取的库内演员新场景中提取不在库的 co-star，按共现次数排序。零额外查询。
  - **stash-box 热门演员榜**：复用 binge Discover Performers 的成熟设计（`binge-cn/src/api/stashdb.ts` 的 `getTrendingStashDBPerformers`）：
    - 查询：`queryPerformers(input: {sort: "LAST_SCENE", direction: "DESC", page: 1, per_page: N})`，镜像 stashdb.org/performers 的"最近有新作"推荐位。
    - 字段：`id, name, gender, birth_date, images {url}, scene_count`（+count）。
    - **性能关键**：**不要带 gender 过滤**——带过滤的查询在 StashDB 侧要 6–19 秒，不带约 1.5 秒。先拉一页不过滤的宽结果（`per_page = max(N*3, 90)`），前端本地过滤性别；本地过滤后不足 12 个才降级为按性别逐查（每次 20s 超时兜底）。
    - 过滤已在库的演员，显示排名。
    - **TPDB 例外**：REST `/performers` 忽略 sort 参数、GraphQL `queryPerformers` 也忽略排序，无热度榜可依；返回 `degraded` 空状态并提示「该源不提供热门演员榜」，不伪造榜单（用户 2026-10-26）。注意 `callBoxPerformerList(box, input)` 的 `input` 是**裸入参**，内部才包 `{input:…}`，调用方不要再包一层（曾导致 422）。
- 卡片：头像 + 名字 + 来源标记（"共同出演 ×N" / "热门榜 #N"）。
- 点击卡片 → 详情弹层：头像/基本信息（性别、共演或热门信息、场景数）+ 「＋加入库」+ 「在 stash-box 打开」+ 相关场景卡（共同出演源显示共演场景；热门源懒加载该演员近期场景）。

### 3.6 设置分级原则（已确认）

- **Stash 插件设置页**（yml，服务端持久化、跨浏览器同步）：只放**必须**或**频率非常低**的设置项——`enableDiscoverPage`（决定代码是否加载，必须）；`recentDays`/`previewDays`/`preferredBox` 等**演员详情 tab** 依赖的低频项保持现状（`recentDays` 不再影响发现页）。
- **插件设置弹窗**（localStorage，浏览器持久化）：其余全部设置项。

### 3.7 插件设置弹窗

- 模块开关（显示/隐藏各模块）。
- 总览模块排序（上移/下移按钮）。
- 每模块行数 1–3。
- **查询源**：当前数据源选择，持久化 localStorage（见 §4.5）；切换后立即按新源重算关注角标。
- **回看窗口（天）**：发现页独立窗口（默认 30，0 = 不限；用户 2026-10-26）；改动后清页面缓存并按新窗口重算，同时重算关注角标。
- **显示上限**（第七轮）：每位演员最多场景 / 每个工作室最多场景，1–10 下拉（默认 2，见 §4.3）；改动只用现有缓存重算平铺列表，不重新联网。
- **「关注的演员新发布不提醒」开关**：关闭后不轮询、不显示铃铛（关注列表与关注页照常可用）。
- "从库内收藏(❤)导入关注"按钮（见 §6）。
- 存 localStorage（UI 偏好，binge 同款模式）。

### 3.8 工作室钻取视图（第十轮扩展）

- 入口：总览模块 §3.2 第 5 项"工作室新发布"的「查看更多」、或顶部滑动开关组「▣ 工作室」。
- 内容：单源（当前选中 stash-box）下，收藏(❤)的工作室新发布场景的全量分页列表。
- 与"最新发布"钻取结构对称（场景卡列表 + 分页 + 筛选行），区别仅在数据源是工作室收藏而非库内演员。
- 卡片为原生 `.scene-card.grid-card.card`（§7.1），但额外显示工作室信息（场景卡原生结构里已有 `.studio-overlay`，复用即可，无需新组件）。
- 排序默认按发布日期降序；可在筛选行切到工作室名/演员热度等（实施时按可用字段自拟）。
- 每工作室上限规则见 §4.6。

## 4. 数据管线（参考 binge）

### 4.1 演员口径

- 主查询范围：**stash-box 有关联（有 stash_id）的本地演员**。
- 查询：按 endpoint 分批（100/批）`queryScenes`，`date` 过滤窗口（窗口为 0 时不传 `date`）+ `performers INCLUDES`，`sort: DATE`，懒分页。
- **拉取上限（2026-10-26 复核）**：当前是「先拉全 → 内存过滤排序 → UI 本地分页」，不是按页懒加载。
  - 非 TPDB 源：`per_page=1000` 自动翻页，`BOX_MAX_PAGES=50` 硬上限（此前仅定义未使用，现已接入 `fetchScenesBatch`），防止源偷降 `per_page` 时无限翻页。
  - TPDB 源：REST 按演员逐个取，`TPDB_MAX_PAGES_PER_ID=2`（每页 ≤100 → **每人最多 200 部**），窗口设为 0 也不会全量回溯；设置页在「回看窗口 = 0 且当前源为 TPDB」时显示该截断提示。`tpdbSinceScenes` 在「还有更早场景、但已到页数上限」时返回 `truncated=true`（同时修复了旧条件 `p < MAX+1` 会多取一页的问题），演员/工作室详情「发现」tab 仅在真截断时于结果计数下方提示「每位演员（每个工作室）最多回溯 200 部，已达上限」（用户 2026-10-26）。
  - localStorage 缓存只保留按发行日期最新的 1500 条（`CACHE_SCENES_CAP`），无限窗口下刷新后历史数据会变少。
  - **拉取进度（4a，用户 2026-10-26）**：`fetchNewScenesForPerformers` 每完成一波批次回调 `onProgress(done,total)`；加载态在总览「有新发布的演员 / 最新发布 / 即将发布」与最新/发现演员钻取页显示「加载中… 已拉取 N/M 批」（仅 `total > 1` 时），每 400ms 节流重绘，完成或失败即清除。

### 4.2 窗口

- 最新/有新发布的演员：**发现页独立窗口**，默认回看 30 天，可在发现页「设置 → 回看窗口」调整（0 = 不限）；不再复用插件 `recentDays`（用户 2026-10-26）。
- 演员详情「发现」tab：仍用插件设置 `recentDays`（默认 180 天），长窗便于单演员场景浏览。
- 预告：未来 `previewDays`（默认 7 天）内发布。
- 热门：StashDB 全站热门榜（`sort: TRENDING`），见 §5。

### 4.3 筛选规则（已确认）

- 排除已拥有：本地 `stash_id`（endpoint+id）与 `code` 双重匹配。
- code 跨 stash-box 源去重。
- `preferredBox` 设置过滤（作为发现页默认源，见 §4.5）。
- **每人/每工作室上限**（默认 2，binge `MAX_SCENES_PER_PRIMARY` 同源语义，按本地演员 id 计数）：**发现页设置 tab 可调 1–10**（`capPerActor` / `capPerStudio`，第七轮）；只约束平铺列表（总览模块 + "最新"/"工作室"钻取）；**热门钻取、关注分组、演员/工作室详情内的场景列表不受限**。

### 4.4 缓存（已确认）

- localStorage + SWR：进页面先渲染缓存立刻可看 → 后台静默刷新 → 手动刷新按钮强制拉新。
- 缓存 key 按数据源 host + 查询参数分键（参数变了自动失效，binge 同款）。
- 视图状态记 URL query（`?view=trending&page=3`）做成开关，**默认关**。

### 4.5 数据源限制（已确认）

- 发现页**单源查询**（区别于演员页 Missing tab 的多源合并，后者保持现状）。
- **查询源选择持久化 localStorage**；初始默认：yml `preferredBox`（若配置）→ 否则第一个配置的 stash-box。
- 筛选行的源切换下拉与设置弹窗的"查询源"是同一持久化值的两处入口，切换即记住。
- 缓存按源分键，切换即切缓存、零成本。
- 热门榜、发现演员的热门演员榜、**工作室模块**均用当前选中源，保证整页数据一致。

### 4.6 工作室数据管线（第十轮扩展）

#### 工作室口径

- **仅 Stash 原生收藏(❤)的工作室**——`studio_filter: { favorite: true }` 模式，与演员侧的"关注演员订阅"机制对称。
- 不并入全库工作室：库 ≠ 收藏，全量查询成本不可控且信号弱；工作室收藏在 Stash 里是常用功能，口径有信号。
- **不做独立的"关注工作室"概念**：工作室收藏(❤)本身就是天然的订阅信号，无需再叠一层轻量订阅（避免和关注演员重复造轮子）。

#### 查询模式

- 一次 `queryScenes` 查询当前源所有收藏工作室的新作品，filter 用 `studios: { value: [stash_id...], modifier: INCLUDES }`，`sort: DATE`、`direction: DESC`、`per_page: 100`、懒分页。
- 工作室 → stash-box 关联键：`studio.stash_ids { endpoint, stash_id }`，先取当前选中源的 stash_id 列表作为 filter value。
- 查询字段对齐 §4.1 演员侧 `BOX_SCENE_FIELDS` + 必要的 `studio { id name parent { id name } }`。

#### 窗口与筛选

- 复用 §4.2 的 30 天 lookback 窗口（打开发现页才查，不设每日定时任务）。
- 排除已拥有：复用 §4.3 双重匹配（local stash_id + code）+ code 跨源去重。
- **每工作室上限 2**：与演员侧每人上限 2 对称，防止单个高产工作室刷屏；总览模块和钻取视图均保留此 cap。

#### 缓存

- 复用 §4.4 的 localStorage + SWR，缓存 key 加 `:studios` 后缀分键，与演员侧缓存独立。

## 5. 「热门」数据源（已确认）

- **StashDB 全站热门榜原样展示，不过滤库内演员**——定位是"额外获取渠道"（binge 原版行为）。
- 含库内演员的卡片加小角标区分。
- 热门榜同时可喂"发现演员"模块的信息。
- **TPDB 例外（2026-10-26 定案，A 方案）**：`sort=TRENDING` 在 TPDB REST 被降级为按入库时间（[stashDiscover.js](../stashDiscover/stashDiscover.js) 的 `tpdbGlobalPage`）。实测 `sort=trending/popularity/rating/views/top/top_week` 全部被忽略，`rating` 100 条全 0、无 `views` 字段；站点首页「Top Scenes This Week!」为登录后服务端渲染（Nuxt SSR），无 XHR/公开接口，`/scenes/trending`、`/trending` 均 404。因此**不接入本周热门**：TPDB 源下模块与 tab 统一改名「网站上新 / New on site」（副标题标出源名与「无热度榜 · 按入库时间」），不伪造热度排序。改名取通用词而非「TPDB上新」，因为副标题已带源名，后续若出现同样无热度榜的源也无需再改文案。
- **排序口径复核（2026-10-26，官方 OpenAPI）**：`https://api.theporndb.net/specs?openapi.json`（v3.24.767）显示场景排序参数是 **`orderBy`**，枚举 `recently_created / recently_released / recently_updated / most_relevant / duration_* / former_*`（小写）；演员与站点用 `recently_created / recently_updated`（小写，文档里的大写枚举会被服务端拒绝）。实测 `sort=date&direction=desc` 与 `orderBy=recently_created` 的前 10 条 ID 完全一致——即插件现状就是「最新入库」，副标题「按入库时间」正确（早前「按发行日期」的判断有误，已回退）。不带排序参数的默认顺序并非 created desc（站点默认呈字母序），所以必须显式带排序；`tpdbGlobalPage` 已改为文档化的 `orderBy=recently_created`。仍无 trending/week 接口：首页「Top Scenes / Top Performers / Top Sites This Week」均为服务端计算，无 XHR；`/tools` 只是外链工具目录（JellyFin、Plex、Whisparr、Stash、社区刮削器、TMM、Namer 与 API、Register），唯一 API 入口是 `api.theporndb.net/docs`。
- **TPDB 热门演员榜空状态兜底（v2.2.6）**：旧版缓存的 `trendingPerf.v1` 可能没有 `degraded` 字段（或为空但未标记），导致空状态退回「暂无可发现的演员」。现读取缓存与渲染时都按 `trendingDegraded()` 归一：TPDB 源恒视为 degraded，显示「该源不提供热门演员榜」。
- **TPDB 封面回退与动图保留（v2.2.7）**：TPDB REST 的 `image` 多为外站直链（manyvids / phncdn / clips4sale），带防盗链，`<img>` 直连会失败（实测 24 张里 13 张）。现 `tpdbScene` 的 `images` 顺序为 外站图 → TPDB 自托管 `poster` / `background.full`，卡片 `onerror` 依次回退，不再直接隐藏留白；`background`/`background_back` 是对象，取 `.full` 而非当字符串。部分 `image` 为 `*_prev_tn.gif` 或 animated webp，弹层不再用 `findScene.images` 整体替换当前图，而是探测可加载性后与详情图、DMM 截图去重合并，动图封面打开后仍保留。
- **TPDB 封面顺序调整（2026-10-26）**：`images` 改为 外站图 → 横版（`back_image` / `background.full` / `background_back.full`）→ 竖版（`poster` / `poster_image`）。此前竖版 `poster`（800×1200）排在横版背景之前，弹层第二张看起来是竖版封面；现在横版优先，列表回退顺序也同步生效。
- **封面黑屏优化（2026-10-26，方案 A+B + 外站补丁）**：外站首图常为 gif/webp，直接赋 `img.src` 时网络失败需等浏览器超时才触发 `onerror`，期间封面空白（先黑屏再恢复静态图），且切页重建卡片会反复重演。现 `setCoverImage` 改为：首图**疑似动图（gif/webp）或与后备图不同域**时先显示静态后备图，同时用 `probeUrl(url, 15000)` 后台探测，通过后再替换（浏览器已缓存，无空档）；**只有 `onerror` 才算失败**，超时只表示「慢」、不写负缓存，探测失败把 URL 写入 `sessionStorage` 负缓存 `SSD:imgfail.v1`（TTL 12h，失败 **10 分钟后允许后台重探一次**，避免网络抖动把封面钉死 12 小时），`next()` 回退链也会跳过负缓存命中的候选——此前只有动图分支查负缓存，TPDB 的外站 jpg 首图每次切页都要空白 0.5–1.2s 再回退（实测负缓存 36 条全是 manyvids / phncdn / iwantclips 的 jpg）；重探成功会解除负缓存并恢复 `visibility`。单图或无静态后备时保持原直连行为。**场景弹层（2026-10-26 补）**：`openModal` 不再等 `Promise.all(probe)` 过滤后才显示，而是先挂静态后备图，再逐张后台探测、加载成功才按原顺序补进轮播；负缓存命中（10 分钟内）的 URL 直接跳过连探测都不发，弹层不再每次打开先空白，详情图里的已失败外站图也不进轮播。

## 5.1 设置项控件样式（用户 2026-10-26）

- 「关注的演员新发布提醒」「热门与即将发布并排一行」使用**右侧滑块开关**（`.ssd-dp-switch`，原生 checkbox 视觉隐藏 + `::after` 圆钮），名称在左、开关靠右（`margin-left:auto`，窄屏 `align-self:flex-end`）。
- 设置视图内容居中（用户 2026-10-26）：`.ssd-dp-settings` 加 `width:100%; max-width:860px; margin-inline:auto`，页面根 `.ssd-dp-page` 的其余视图仍占满可用宽度。
- 「恢复默认布局」为右对齐紧凑按钮（`.ssd-dp-btn.ghost.sm.ssd-dp-reset`，`align-self:flex-end`），不占满整行。

## 6. 关注与通知系统（已确认）

### 6.1 概念（与 binge 对照）

- binge 的"关注"= 立即入库（`performerCreate` + stash_ids 回链，无独立关注态、无通知）。
- 我们的"关注"= **独立轻量订阅状态**：localStorage 记录，不入库，专职驱动新作品通知。

### 6.2 关注页口径（已确认）

- 主口径 = 插件自己的关注列表（轮询成本可控、符合"必须是关注的才提醒"）。
- **单源口径**（第七轮）：关注列表按当前数据源过滤（只列当前源演员），角标轮询也只统计当前源；切源即强制重算。
- 设置里提供一键"从库内收藏(❤)导入"：**只导入与当前数据源关联的 stash_id**（别源收藏不导入，避免导入后关注页永远「暂无新作品」）。
- 不直接并入全库演员（库 ≠ 关心，铃铛信号会被稀释）。

### 6.3 关注入口

1. 演员详情弹层 / "有新发布的演员"迷你卡上加 ♥ 按钮。
2. 演员页 Missing Scenes tab 顶部加关注按钮（最顺手）。
3. 关注页可取消关注。

### 6.4 轮询与铃铛

- **轮询与缓存是两套独立机制**：
  - 发现页全量查询（含 SWR 缓存）：只在**打开发现页时**触发，查全库有关联演员（分批 100/批），不主动跑。
  - 关注轮询：**打开 Stash（任何页面）**即跑（会话内一次 + 最小间隔 6 小时，localStorage 记上次检查时间），**只查关注列表演员**，轻量。
  - 打开发现页刷新全量缓存时，关注演员的新作品状态顺带同步（全量数据已拉过，零额外成本）。
- 刷新按钮旁显示"X小时前更新"相对时间。
- 铃铛定位详见 §10「关注通知的导航呈现」（已迁出本节）。
- 关注页 tab 角标红点同步。
- 已读粒度：场景级持久记录；点开过/加入库即消；7 天自动过期；关注视图顶部「全部已读」一键消除。
- 轮询范围 = 关注列表（含从收藏导入的）。
- 设置开关「关注的演员新发布不提醒」关闭时：跳过轮询、隐藏角标，关注页照常。

## 7. 卡片与响应式规范（已确认）

### 7.1 卡片还原优先级

- **场景卡片 1:1 原生 Stash 结构**（`.scene-card.grid-card.card` 系），主题插件直接套用——这是硬性要求。
- **演员卡片同样 1:1 原生**：结构与元素名对齐 Stash 演员卡（`.performer-card.grid-card.card` 系，含头像、名字等原生元素层级）。
- **优先级：卡片还原第一，UI 规范第二**——当移动端规范与卡片原生结构冲突时，卡片结构让位（原生卡在窄屏的已知截断问题不修复，保持与 Stash 原生一致）。

### 7.2 移动端窄屏规范

- 所有自绘 UI（开关组、筛选行、分页、模块头部、弹层、设置页）在窄屏必须**无冲突、无截断、无重叠**，必要时自动换行（`flex-wrap` / 媒体查询降级为网格布局，参考 InsightsI18n `.ins-tabs` 的 `@media` 降级写法）。
- 例外：1:1 还原的场景/演员卡片（原生列表在窄屏的截断问题不用理会）。
- 最终目的：尽可能兼容第三方主题 + 保证移动端窄屏体验。

### 7.3 交互

- 卡片交互沿用演员页 tab 现有弹窗：详情 + 保存到 Stash + Jackett 搜索下载。
- 保存成功后该场景从各视图移除（发 `ssd:scene-saved` 事件，主 JS `handleSaveScene` 对发现页条目跳过"当前演员"回退）。

### 7.4 工作室卡片规范（第十轮扩展）

- **工作室详情头部复用原生 StudioCard 结构**（已查证 Stash 源码 `ui/v2.5/src/components/Studios/StudioCard.tsx`）：
  - 根容器 `GridCard` + `className="studio-card zoom-N"`，与演员卡同构（`.studio-card.grid-card.card.zoom-N`）。
  - 头像层 `.studio-card-header > img.studio-card-image`。
  - 详情层 `.studio-card__details`，含名字、parent/child studios（`.studio-parent-studios` / `.studio-child-studios`）、scene-count/image-count 等原生计数元素。
- **工作室新发布模块的场景卡**：复用 §7.1 原生场景卡，工作室信息走场景卡原生 `.studio-overlay`（已有结构，无需新组件）。
- 优先级同 §7.1：卡片还原第一，移动端规范第二。工作室卡窄屏的已知截断问题不修复，与 Stash 原生一致。

## 8. 「有新发布的演员」交互（已确认）

- 卡片点击 → 发现页内该演员的过滤视图（不跳走，保持上下文）。
- 卡片上放小图标 → 跳该演员页 Missing Scenes tab。
- 关注的演员在此卡片加 ♥ 状态。

### 8.1 演员过滤视图（已确认）

- 结构：**上半部演员详情 + 下半部场景卡片**，不要只有场景卡片。
- 演员详情与按钮文案均走 `tc()` 中英双语，**按钮文案实施时自拟**（不照搬下方描述性用词）。

#### 演员详情区（从上到下）

- 左上头像（`/performer/{id}/image` 或 stash-box 头像）。
- 名字（对齐原生 `.performer-name`）+ 别名（对齐 `.performer-disambiguation`）。
- 性别图标（对齐 `.gender-icon`）+ 年龄（对齐 `.performer-card__age`）。
- 基本信息一行 meta（新作品数等）。
- 整行宽自适应、`flex-wrap` 防窄屏截断（§7.2）。

#### 按钮区

- 「关注/已关注」♥ 切换（关注态持久化，见 §6）。
- 跳该演员页「发现」tab（即本插件注入的 Missing Scenes tab，名称 = tc("发现","Discover")），目标 `/performers/{id}` 带 tab 激活。
- 跳该演员 stash 主页（`/performers/{id}` 不带 tab）。
- **stash-box 打开**：演员详情区**右上角**放置外链图标按钮（`faUpRightFromSquare` / `↗`），无文字标签，点击新窗口打开当前源该演员的 stash-box 详情页。

#### 复用

- 所有"点演员头像/名字进入"的过滤视图统一复用这个模块（有新发布的演员、关注视图的演员分组、发现演员详情弹层的场景区等），一处实现多处挂载。

### 8.2 工作室过滤视图与详情页 tab 注入（第十轮扩展）

#### 工作室过滤视图（与演员过滤视图同构）

- 结构：**上半部工作室详情 + 下半部场景卡片**，复用 §7.4 原生 StudioCard 结构。
- 详情区元素（从上到下）：
  - 工作室图片（`/studio/{id}/image` 或 stash-box 头像）：左图右文布局，**宽度自适应铺满、按原始比例完整显示不裁切**（`.ssd-dp-pfavatar--studio`：`width: clamp(240px, 32%, 460px)` + `height:auto` + `object-fit:contain`，第七轮）。演员详情图固定 2:3 竖版（108×162 cover），两者共用基类但用修饰类分道，互不影响。
  - 工作室名 + parent studio（若有）+ child studios（若有）——对齐 `.studio-card__details` 原生子元素。
  - meta 一行（新作品数、场景总数等，对齐 `scene-count` 等原生计数元素）。
  - 整行宽自适应、`flex-wrap` 防窄屏截断（§7.2）。
- 按钮区（与 §8.1 演员按钮区对称，文案走 `tc()` 中英双语，**实施时自拟**）：
  - 跳该工作室 stash 主页（`/studios/{id}`）。
  - **stash-box 打开**：详情区**右上角**外链图标按钮（内联 SVG 外链图标 `I.ext`，**不再用 `↗` 字符**），无文字；按钮区另有带品牌名的 `<a>` 按钮（同样用 SVG 外链图标），新窗口打开当前源该工作室的 stash-box 详情页。
  - **不设"关注工作室"按钮**——工作室收藏(❤)是 Stash 原生订阅信号，无需重复（§4.6）。
- 复用：所有"点工作室头像/名字进入"的视图统一复用此模块（工作室新发布模块的"查看工作室作品"入口等）。

#### 工作室详情页 tab 注入（与演员详情页 tab 同构）

- 在工作室详情页（`/studios/{id}`）注入"发现"tab，与本插件在演员页注入的 Missing Scenes tab **完全同构**：
  - tab 名：`tc("发现", "Discover")`（与演员 tab 同名，保持入口语义一致）。
  - tab 内容：当前工作室在该 stash-box 源下的未拥有场景列表（复用主 JS 现有 stashDiscover 演员页 tab 的多源合并逻辑——**工作室 tab 同样允许多源合并**，与发现页导航页的"单源"区分开，与演员 tab 行为一致）。
  - 复用 §8.2 上方的工作室过滤视图模块（详情头部 + 场景区）作为 tab 内容主体。
- patch 入口：与演员页 tab 注入对称，在主 JS（stashDiscover.js）扩展 `setupObservers` / `ensureTabInjected` 增加 `/studios/` 路径识别，注入相同的 NavTab 结构。
- 入口开关：受同一个 `enableDiscoverPage` 控制？还是单独的 `enableStudioTab`？**待实施时定**——倾向复用 `enableDiscoverPage`（减少设置项），开关关闭时工作室 tab 也不注入。

## 9. 技术实现要点

### 9.0 可复用模块清单

发现页拆分为以下可复用单元，一处实现、多处挂载：

| 模块 | 内容 | 复用点 |
|---|---|---|
| 场景卡 | 卡片 + hover popover + 详情/保存/Jackett 弹窗 | 总览/钻取/关注/演员过滤视图/工作室过滤视图 |
| 迷你演员卡 | 头像 + 名字 + 来源角标 | 有新发布的演员 / 发现演员 / 关注视图演员行 |
| 迷你工作室卡 | 头像 + 工作室名 + parent 标记 | 工作室新发布模块（如做汇总卡片显示）/ 工作室过滤视图 |
| 模块头部条 | 标题 + 统计 + "查看更多" | 所有总览模块（含工作室新发布） |
| 分页开关组 | 页码胶囊 + 每页数 | 所有钻取视图顶/底（含工作室钻取） |
| 筛选行 | 搜索 + 排序 + 每页 + 网格/列表 + 源切换下拉 | 所有视图（含工作室视图） |
| 加载/错误/空状态 | 三态组件 | 全视图 |
| 错误文案 | 按失败类型给出原因：超时 / 无法连接 / 鉴权失败 / 被源拒绝 / 接口错误 / HTTP 状态码 | 全视图 |
| 空状态文案 | 区分「本地演员未关联编号」「还没有收藏工作室」「窗口内无新作品」与「源不支持该榜单」 | 总览模块与热门演员榜 |
| 演员过滤视图 | 演员详情 + 场景区（§8.1） | 点演员头像进入的所有入口 |
| 工作室过滤视图 | 工作室详情 + 场景区（§8.2） | 点工作室进入的所有入口 + 工作室详情页 tab |
| 演员入库链路 | scrape + performerCreate + 降级 | 发现演员入库、关注后入库（如有） |
| 工作室入库链路 | （未来扩展）scrapeSingleStudio + studioCreate + 降级 | 工作室 tab 入库按钮（如未来扩展；当前工作室侧仅做发现展示） |

### 9.1 其他要点

- 主 JS 导出 `window.SSD`：`callGQL`、`callBoxGQL`、`getStashBoxes`、`getPluginSettings`、限流器、`tc`、日期工具、`brandNameForEndpoint`、`boxSceneUrl`、`BOX_SCENE_FIELDS`、`buildSceneCard/buildPerformerPopoverContent/buildSceneTable/makeChip/makePanelBtn/boxErrText/openModal`（带 ctx 参数，默认回退 `_state`）、`layoutCardGrid`（多网格 `data-zoom`）。
- 演员入库：Stash 内置 stashbox 刮削（`scrapeSinglePerformer`，注意 stash_id 放 `query` 不放 `performer_id`，类型是 ID 会 422）+ `performerCreate` 带 `stash_ids` 回链；刮削失败降级为名字+图片+链接。参考 `binge-cn/src/api/mutations.ts`。
- 热门演员榜：`queryPerformers` `sort: LAST_SCENE`（不带 gender 过滤，宽页本地过滤，详见 §3.5），参考 `binge-cn/src/api/stashdb.ts` 的 `getTrendingStashDBPerformers`。
- **工作室新发布查询**（第十轮扩展）：`queryScenes` + `studios: { value: [stash_id...], modifier: INCLUDES }` + `sort: DATE` + `direction: DESC`，一次查当前源所有收藏工作室。**复用** `window.SSD.callBoxGQL`，无需 Python 后端、无需文件缓存。
- **工作室详情页 tab 注入**：主 JS 扩展 `ensureTabInjected` 识别 `/studios/` 路径，注入与演员 tab 同构的 NavTab；tab 内容复用工作室过滤视图模块（§8.2）。
- 导航 patch：`PluginApi.patch.after("MainNavBar.MenuItems")`，Nav.Link + NavLink + FontAwesomeIcon，参考 `E:/stashAPP/plugins/mrx-31415/stash-curator/stash-curator.js` 的 CuratorNavItem。
- 开关样式：参考 `InsightsI18n.css` 的 `.ins-tabs`（11px 圆角容器）/`.ins-seg`（9px 分段），高亮用 `color-mix`，颜色取 Stash CSS 变量。
- 语言：全部走 `tc()` 中英双语。
- CSS 新增 `.ssd-dp-*` 前缀，作用域镜像 `.ssd-tab-pane` 模式；所有自绘布局必须带窄屏适配（§7.2）。

## 10. 关注通知的导航呈现（已确认）

### 技术可行性（已查证 Stash 源码）

- Stash 原生 `MainNavBar.MenuItems`（`ui/v2.5/src/components/MainNavbar.tsx`）为 PatchComponent，原结构 `Nav.Link > LinkContainer > Button > Icon + span`，**无 Badge/count 原生支持**。
- 但插件对注入的 `Nav.Link` 子节点有**完全控制权**（curator 已证：子节点里塞 FontAwesomeIcon + span）；我们在 NavLink 内多挂一个绝对定位的角标 div 即可，**角标状态变化由 React 重渲染**，零主题冲突（色块用 Stash danger CSS 变量，圆点小、圈数小）。
- 这种 patch 在 MainNavBar.MenuItems 上叠加角标是已验证模式；角标不会侵入原生菜单项 DOM。

### 呈现规则

- **不注入主导航"演员"文字旁铃铛**（原方案废弃——主导航已有"发现"按钮，无需在"演员"旁重复提醒入口）。
- **角标定位**：紧贴主导航"发现"按钮右上角（绝对定位 + Stash danger 色变量 + 白字），未读新作品数量。
- **望远镜图标保持不变**——图标语义稳定；角标作为"有新通知"的附属指示，不改变导航入口本身。
- 角标渲染由注入的 React 组件管理状态，与主导航 patch 同步更新。
- 点击「发现」（无论有无角标）→ 进入发现页；角标存在时默认落到**关注视图**（让用户直接看到新作品），无角标时落到总览。
- 关注页 tab 角标红点同步；全部已读或"关注的演员新发布不提醒"开关关闭时，角标消失。
- 注意：角标用 React 状态驱动轮询结果——轮询在主 JS（constantly loaded）发起，结果写 localStorage，发现页注入组件订阅 localStorage 事件或通过 window CustomEvent 同步。

## 11. 待确认项

（无——原"热门演员榜 API 字段"已于 2026-10-22 第三轮讨论定稿，见 §3.5。）

## 12. 实施状态（2026-10-23，P0-P8 全部完成）

**全部已实施并经浏览器验证**（各 Phase 验证记录见 git 历史中的 PROGRESS.md）：

- **P0 地基**：suiteTheme 移植（scope `.ssd-dp-page, .ssd-nav-item`）+ CSS 骨架。
- **P1 入口**：主 JS 顶层同步注册导航 + 路由壳（规避注册时序竞态），discover.js 经 `SSD.discoverMount` + `"ssd:discover-ready"` 提供页面组件；壳内 200ms 安全轮询兜底事件丢失（React passive effect 时序），~20s 超时降级重试。locale 经 `"ssd:locale-changed"` 事件重渲染。
- **P2 数据管线**：演员/热门/工作室三管线 + localStorage SWR 缓存（`refreshAll` 同时失效本地 memo）。
- **P3 原型**：单文件 HTML 原型（类名/token 与实现一致，P4 零翻译成本；快照见 git 历史）。
- **P4 视图**：总览 6 模块 + 4 钻取 + 演员/工作室过滤视图 + 发现演员 + 关注视图。搜索框限宽 300px/max 320 左对齐（用户确认），375px 满宽降级。
- **P5 关注系统**：收藏一键导入、主 JS 轮询（打开 Stash 触发、6h 节流、只查关注列表、每 endpoint 单查询、performer×scene 口径不做库内排除——页内全量管线修正）、导航角标 React 状态 + CustomEvent 同步（bump 必须函数式更新防陈旧闭包 bail out）、免打扰。
- **P6 设置**：renderOverview 模块化（MODULE_DEFS + order 防御性归一 + 模块渲染函数表，trending/preview 相邻时 duo 并排）；设置 9 行（查询源/通知/导入 + 6 模块开关×行数×排序 + 恢复默认）。
- **P7 工作室 tab**：`_state.entityType` 分支复用演员 tab 全套管线；fetchBoxPage 切 `studios INCLUDES`（stash-box 层级匹配含母厂牌）；「在源上查找」演员专属隐藏。
- **P8 收尾**：全量回归（桌面 + 375px 0 溢出、主题 token 采样）、README v2.1.0、git 分 Phase 提交。

**版本**：v2.1.0（yml + 主 JS）。提交粒度：每 Phase 一个 commit。

## 13. 工作室侧设计边界（第十轮）

### 范围声明

- 工作室侧与演员侧是**平行对称设计**：相同的数据管线架构（`callBoxGQL` + `queryScenes` + localStorage SWR）、相同的卡片还原规范（§7.1/§7.4）、相同的过滤视图模块结构（§8.1/§8.2）、相同的 tab 注入模式（演员页 tab / 工作室页 tab）。
- **不做**：独立的"关注工作室"概念（复用 Stash 收藏❤作为天然订阅信号）、工作室入库链路（仅做发现展示，未来如需入库再扩展）。
- 工作室 tab 入口开关：倾向复用 `enableDiscoverPage`（减少设置项），实施时确认。
