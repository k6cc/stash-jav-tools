# discover.js 实施进度（断点续传文件）

> 规则：每完成一个子任务立即更新本文件状态列（⬜ 待做 / 🔄 进行中 / ✅ 完成 / ⚠️ 完成但有遗留）。中断后从最后一个非 ⬜ 行继续，不依赖对话记忆。
> 设计规范唯一事实源：`discover-page-design.md`（356 行 13 节）。代码现状：主 JS/yml 骨架已改（`window.SSD` + `maybeLoadDiscover`），未提交。

## P0 地基

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 0.1 | 创建 PROGRESS.md | ✅ | 本文件 | — |
| 0.2 | 移植 suiteTheme() 到 discover.js（scope 限插件根选择器，Flexoki 检测保留） | ✅ | discover.js | node --check 通过 |
| 0.3 | CSS 骨架：.ssd-dp-page 根 + 开关组/筛选行/模块段基础类 + 窄屏 @media 降级 | ✅ | stashDiscover.css（1082→1432 行） | 追加段落完成 |

## P1 入口 ✅ 2026-10-23 浏览器全项验证通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 1.1 | MainNavBar patch：faSatelliteDish 图标 + "发现" + 角标容器 | ✅ | **stashDiscover.js** 顶层 registerDiscoverEntry()（导航注册从 discover.js 迁移至此，见下方重构说明） | 导航出现、图标正常、locale 中文 |
| 1.2 | register.route(/plugins/stashDiscover) + React 壳 + ref 挂载 vanilla | ✅ | 主 JS DiscoverRouteShell（壳）+ discover.js DiscoverPage/mountPage（内容） | 直接 URL 与 SPA 导航均渲染 7 tabs |
| 1.3 | suiteTheme scope 扩展到导航角标元素 | ✅ | discover.js THEME scope ".ssd-dp-page, .ssd-nav-item" | Flexoki 启用时 --sx-bg=#100F0F 精确值，默认主题采样 dark |

### 2026-10-23 P1 验证中发现并修复的 4 个问题

1. **yml `default: true` 导致插件加载失败**（Stash SettingConfig 无 default 字段，
   14:35 起日志持续报 unmarshal error）→ 删除该字段，JS 侧已有"缺失视为开"兜底。
2. **discover.js URL 404**：Stash 只服务 yml 声明过的文件 → yml 加 `ui.assets:
   { /: . }`（tagMerge/oStats 先例），URL 改为 `/plugin/{id}/assets/discover.js`
   （MIME text/javascript 验证通过）。
3. **注册时序竞态**：discover.js 经"设置查询→注入"比其他插件晚一个网络往返，
   MainNavBar/Router 首渲染后 patch 不生效（间歇性导航/页面丢失）→ **重构**：
   导航 patch + 路由壳移到主 JS 顶层同步注册（LockdownI18n 同款可靠波次），
   discover.js 只经 `SSD.discoverMount` + "ssd:discover-ready" 提供页面组件；
   开关同步读 localStorage 缓存（key `SSD:discoverOn`），异步设置查询负责校正
   （关闭→"ssd:discover-disabled" 事件隐藏入口；下次加载零注册零注入，已验证）。
4. **locale 时序**：导航首渲染早于 IntlBridge 填 _intlLocale，显示英文 →
   IntlBridge 变更时派发 "ssd:locale-changed"（setTimeout(0) 避免监听器未挂），
   导航项监听后重渲染（中文「发现」验证通过）。

## P2 数据管线 ✅ 2026-10-23 浏览器全项验证通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 2.1 | 演员侧管线：本地有关联演员查询 → 分批 queryScenes（100/批、date 窗口、performers INCLUDES、懒分页） | ✅ | discover.js L255-435 | SSD.dp.getDiscoverData()：16 关联演员、1.7s、latest 4 + preview 1 |
| 2.2 | 筛选与 cap：排除已拥有（stash_id+code 双键）、code 跨源去重、每人上限 2 | ✅ | discover.js filterPipeline L643 | latest 4 = ≥2 演员 × cap2；actorsWithNew 3 组按量排序 |
| 2.3 | SWR 缓存层：localStorage 按源 host+参数分键，进页先渲染缓存再静默刷新 | ✅ | discover.js L545-760 | 二次调用 fromCache="fresh" 仅 7ms；5 个缓存键（local/trending/trendingPerf/studios/newScenes .v1） |
| 2.4 | 热门榜：TRENDING sort 全站原样（含库内演员角标标记） | ✅ | discover.js L819-855 | getTrendingData() 30 条真实数据；getTrendingPerformers() 24 人全 FEMALE（性别过滤生效）、二调 fresh |
| 2.5 | 工作室管线：收藏(❤)工作室 → studios INCLUDES 单查询（cap 2/工作室） | ✅ | discover.js L857-934 | 临时收藏 S1：组内 12 场景（分组不受限）、总览 capped 4（2 工作室 × cap2）✓ 已还原 |

### 2026-10-23 P2 验证记录与修复

- 验证方式：Chrome DevTools MCP 控制台直调 `SSD.dp.*` 四入口（pageId=2，
  http://localhost:9999/plugins/stashDiscover）。
- recentDays 默认值 30 符合设计文档 §4.2（"回看 30 天"）；用户当前未设置
  recentDays/previewDays（仅 enableDiscoverPage:true），previewDays 回退 7 正确。
- 工作室端到端验证：测试期间用户真实收藏了 Kawaii（stashdb 关联）+ 测试临时
  收藏 S1 → studioCount=2、groups=2（S1 12 + Kawaii 6 场景）、cappedItems=4，
  cap 逻辑与"分组计数不受限、总览 cap2"均符合 §4.6。S1 已还原为未收藏。
- **发现并修复：refreshAll() 不失效本地 memo** —— 收藏工作室后会话内点刷新
  仍读到旧 memo（空收藏）→ refreshAll 现在同时调 invalidateLocalMemos()。
- 控制台干净（仅 Stash 自身 manifest 图标警告，与插件无关）。
- 工作副本与实装目录（E:\stashAPP\plugins\k6cc\stashDiscover\）已同步，
  node --check 通过（52,998+ 字节）。

## P3 UI 设计稿 ✅ 2026-10-23 用户确认通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 3.1 | v0 原型：顶部开关组/筛选行/总览 6 模块/演员过滤视图，明暗双主题模拟 | ✅ | prototype/index.html（单文件，856 行） | 用户过目通过；自动化验证：三主题 token 跟随（Stash 深色/浅色/Flexoki 精确值）、1440px 与窄屏（tabs 4 列网格降级、无横向滚动、duo 堆叠、零溢出元素）、18/18 占位图加载 |

### 2026-10-23 P3 原型说明

- 类名/token 与实际实现完全一致：.ssd-dp-*（stashDiscover.css P0.3 骨架）+
  --sx-*（discover.js suiteTheme 输出），P4 实施时零翻译成本。
- 右下角悬浮主题切换器为原型专用（真实插件由 Stash 当前主题自动驱动采样）。
- 占位图：图片 API 需鉴权浏览器不可达（code 1001），改用程序化 SVG 数据 URI
  （真实插件用 stash-box 场景封面/演员头像真实 URL）。
- 场景卡为 Stash 原生结构 1:1（.scene-card.grid-card.card 系 + studio-overlay
  + scene-specs-overlay + card-popovers），含 ssd-overlay-box/preview/days 徽标。
- 总览 6 模块齐全：迷你演员卡（含关注♥、角标）/最新（2 行）/热门∥即将发布
  并排（含"N 天后上映"绿标）/工作室新发布（cap 2）/发现演员（共同出演∥热门榜）。

## P4 视图实现 ✅ 2026-10-23 浏览器全项验证通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 4.1 | 顶部控制区：标题+meta chips+刷新+相对时间；滑动开关组；筛选行；分页组 | ✅ | discover.js L999+ renderChrome + css | 8 tab、搜索框限宽 300px/maxw 320 左对齐、375px 满宽换行 3 行无溢出 |
| 4.2 | 总览 6 模块 + 模块头部（标题/统计/查看更多）+ 行数设置生效 | ✅ | renderOverview | 6 模块、15 卡、11 迷你卡、chips（5 新场景/16 关联演员/StashDB）、"56 分钟前"相对时间 |
| 4.3 | 钻取视图：最新/热门/预告/工作室（分页+筛选+返回总览） | ✅ | renderDrill | 最新：面包屑+4 卡（cap2）+"第 1 / 1 页 · 共 4 部"+列表模式表格；热门 24 卡+分页器；预告"13 天后上映"绿标；工作室分组 chip |
| 4.4 | 演员过滤视图（§8.1 详情区+按钮区+场景区，复用挂载） | ✅ | renderPerfFilter + openPerfModal | Rei Kamiki 4 按钮（♡关注/发现Tab/主页/StashDB↗）、异步补全"女 · 26 岁"、分组场景不受 cap |
| 4.5 | 工作室过滤视图（§8.2 同构） | ✅ | renderStudioFilter + grpstrip | chip"S1 · 12"/"Kawaii · 6"、S1 详情 12 卡、Kawaii localId=69 正常 |
| 4.6 | 发现演员：共同出演+热门演员榜双源、详情弹层、入库链路 | ✅ | renderPerformers + openPerfModal | 共同出演 0 张（正确：窗口内 5 位出演者全在库）、热门榜 23 张带 #1-#3 排名角标、弹层 ~4s 懒加载性别+6 相关场景 |
| 4.7 | 关注视图：分组+已读标记+全部已读+空状态 | ✅ | renderFollow + follow/read store 桩 | toggle 后未读=2、红框卡 2 张、tab 红点、全部已读后未读=0 红点消失 |

### 2026-10-23 P4 验证记录与修复

- **发现并修复：壳/discover-ready 竞态**（375px+ignoreCache 硬刷新后页面壳卡
  loading）——React passive effect 在 commit 后才运行，discover.js 的
  "ssd:discover-ready" 事件在监听器挂载前派发即丢失。修复：壳内加 200ms
  安全轮询直接检查 `SSD.discoverMount` 标志（不依赖事件），~20s 未到达降级
  为错误提示+重试按钮（`injectDiscoverScript(force)` 带缓存穿透参数）。
  修复后 375px+ignoreCache 完整复现条件下验证通过（8 tab/16 卡/无溢出）。
- **StashDB 行为记录（非 bug）**：`studios INCLUDES` 过滤器按层级匹配——
  收藏 Kawaii 会命中母厂牌 S1 的场景（S1 不在本地库所以只有 stash-box 按钮，
  属正确行为）。顺手加 stash_id 键两侧 toLowerCase 归一化防御。
- 375px 走查：媒体查询生效（搜索框 `flex:1 1 100% / maxw:none` 满宽、
  工具栏 3 行 132px）、0 横向溢出；桌面 1550px 恢复单行 48px、搜索框
  300px 左对齐。注意：resize_page 在 reload 后不保持，窄屏验证需用
  emulate viewport 覆盖（跨导航持久）。
- 主题 token 采样验证：#202B33/#3991C8/dark（默认主题跟随）。
- 三文件（stashDiscover.js / discover.js / stashDiscover.css）已 node --check
  并同步至实装目录。

### P4 实施要点（含用户确认的偏好）

- **搜索输入框限宽**（用户 2026-10-23 确认）：`flex: 0 1 300px; min-width:
  180px; max-width: 320px`，左对齐，不横向铺满——原型 .ssd-dp-toolbar .grow
  已改，实现时照搬；其余细节后续可调。
- 原型（prototype/index.html）为视觉唯一参考：类名 .ssd-dp-* 与
  stashDiscover.css P0.3 骨架一致；原型中新增而骨架缺失的类（.ssd-dp-grid/
  .ssd-dp-mini 系/.ssd-dp-viewtoggle/.grow/.ssd-overlay-days/.ssd-mini-heart/
  .ssd-mini-src 等）需移植进 stashDiscover.css。
- 场景卡必须用主 JS 的 SSD.buildSceneCard（原生结构 1:1），不得另写卡片。
- 4.7 关注视图的数据层（关注列表+已读态 localStorage）由 P5.1 提供——P4 先
  以最小 store 桩实现渲染，P5 补轮询与导入。

## P5 关注系统 ✅ 2026-10-23 浏览器全项验证通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 5.1 | 关注列表 localStorage + 收藏(❤)一键导入 | ✅ | discover.js importFavoritesFromLibrary + makeImportButton（followbar+空状态） | 控制台导入 5/5（skipped 0/noId 0）、关注 1→6 人、视图 6 分组"2 部未读" |
| 5.2 | 轮询：主 JS 端打开 Stash 触发+6h 节流，只查关注列表 | ✅ | stashDiscover.js dpPollFollowed（§6.4 块） | 刷新后 poll.v1/unread.v1 自动写入；二次刷新 lastAt 不变（节流生效）；每 endpoint 单查询（performers INCLUDES 分组） |
| 5.3 | 导航角标：React 状态+CustomEvent 同步，有角标点击落关注视图 | ✅ | 主 JS DiscoverNavItem（缓存初值+muted+notify-changed）+ discover.js emitUnread 持久化 | 角标"2"出现→notify="0"消失→"1"恢复；follow tab 红点同步；unread-changed 事件全链路 |

### 2026-10-23 P5 验证记录与修复

- **发现并修复：陈旧闭包 bump**——`lc[1](lc[0] + 1)` 捕获 mount 时 state，
  第二次触发起 setState 相同值被 React bail out（页面加载时 locale-changed
  必然已触发过一次，后续 notify-changed 全部无效）。两处（导航 lc bump、
  壳重试按钮 att bump）改为函数式更新 `s[1](function(v){return v+1;})`。
- 轮询口径 = 关注演员×场景对（与页内 computeUnread/renderFollow 一致），
  刻意不做库内排除（重）；页内全量管线是 source of truth，打开发现页零成本
  修正。单 box 失败保留缓存计数（下轮重试）；轻量通道只取第一页 100 条。
- muted 开关（`SSD:dp:notify`="0"）P5 已生效（跳过轮询+隐藏角标），
  P6 设置弹窗补 UI 写入该 key 并 dispatch "ssd:notify-changed"。
- 导入的 5 位关注演员为用户库内真实 ❤ 收藏（验证时导入，语义正确已保留）。

## P6 设置弹窗 ✅ 2026-10-23 浏览器全项验证通过

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 6.1 | 模块开关/排序/行数 1-3/查询源/通知开关（localStorage） | ✅ | discover.js renderSettings + renderOverview 模块化 + css .ssd-dp-set-* | 详见下方记录 |

### 2026-10-23 P6 验证记录

- 设置视图结构：通用（查询源 3 源下拉/通知开关/从收藏导入）+ 总览模块
  （6 行开关×行数×上移下移）+ 恢复默认 = 9 行 7 开关 7 下拉 12 排序按钮。
- 模块开关：隐藏"工作室新发布" → prefs.modules.studios=false → 总览 5 模块。
- 行数：latest 2→1 写入 prefs.rows。排序：发现演员 ↑ → order 数组与总览
  顺序同步变化。恢复默认：prefs 清空、顺序回默认 6 模块。
- 通知开关：checkbox ↔ `SSD:dp:notify` "0"/"1" + "ssd:notify-changed" →
  导航角标即时隐藏/恢复（P5 链路复验）。
- 查询源：切换 → prefs.source 写入 + 全数据集重载；切回正常。回显修正：
  数据未就绪时用 prefs.source 回显（不跳回第一项）。
- renderOverview 重构为模块渲染函数表 + order 遍历；trending/preview 相邻
  时仍并排（duo），被排序拆开则各自全宽。prefs.order/moduleOrder 防御性
  归一（补缺失/滤未知 id）。
- 全程无横向溢出；硬刷新回归通过（8 tab + 设置结构完整）。

## P7 工作室详情页 tab

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 7.1 | 主 JS ensureTabInjected 扩展 /studios/ 路径，注入同构"发现"tab（多源合并） | ✅ | stashDiscover.js（entityType 分支：isStudioPage/getStudioIdFromUrl/loadLocalStudio/loadLocalSceneKeys 参数化/fetchBoxPage studios INCLUDES/文案区分/findEntryVisible 守卫） | Kawaii(/studios/69)：tab 注入(.studio-tabs 命中)、31 卡+分页行+工具栏、无错误态、"在源上查找"按预期隐藏；演员页回归通过（Rei Kamiki 7 卡） |

### 2026-10-23 P7 实施说明

- 复用演员 tab 全套管线（_state + renderTabContent + 窗口过滤/库内排除/
  分页/搜索/排序），仅按 `_state.entityType` 切换：实体加载
  （loadLocalStudio）、box 查询 filter（studios INCLUDES，stash-box 层级
  匹配含母厂牌）、no-ids/未找到/preferredFallback 文案、演员专属
  "在源上查找"入口隐藏（findEntryVisible 首行守卫，两处 buildFindBlock
  渲染点因 findOpen 只能由入口置位而自然失效）。
- 工作室 tab 窗口默认 180 天（与演员 tab 一致，read from settings
  recentDays/previewDays）；发现页导航页的 30 天回看是独立口径。

## P8 收尾 ✅ 2026-10-23

| # | 任务 | 状态 | 产出 | 验证 |
|---|---|---|---|---|
| 8.1 | 全量回归（含窄屏 375px、主题切换） | ✅ | — | 桌面 1550px：8 tab/6 模块默认顺序/15 卡/11 迷你卡/角标"2"/--sx-bg #202B33；emulate 375x812：0 横向溢出、工具栏 3 行 132px |
| 8.2 | README 更新 + 设计文档 §12 状态更新 | ✅ | README.md（v2.1.0 三新章节+配置行+API 说明）+ discover-page-design.md §12（P0-P8 实施状态摘要） | — |
| 8.3 | git 分阶段提交（每 Phase 一个 commit） | ✅ | 4 commits：`0b3ca6e` 设计+原型(P3) / `39d796a` 发现页本体(P0-P6) / `42681af` 主JS集成 v2.1.0(P1/P5/P7) / `b6aecf3` 文档(P8) | git log 确认，工作树 clean；同文件跨 Phase 改动按功能归属分组，message 标注 Phase |

> 8.3 说明：discover.js/stashDiscover.js 等单文件的改动跨多个 Phase 且无中间
> 快照，无法逐 Phase 拆分；采用功能归属分 4 个 commit，每个 message 明确
> 标注覆盖的 Phase，保留阶段可读性。本地领先 origin/main 4 commits（未推送）。

## 遗留问题 / 技债

（无阻塞性技债。以下为已记录的已知行为决策，非遗留 bug：）

- 轮询轻量通道刻意不做库内排除（重查询）；发现页全量管线是 source of
  truth，打开页面即零成本修正角标（设计决策，见 P5 记录）。
- 工作室 tab 的「在源上查找」入口由 findEntryVisible 守卫隐藏（findOpen
  仅能由该入口置位，渲染路径自然失效）——如后续要彻底移除渲染分支可再收。
- StashDB `studios INCLUDES` 按层级匹配（收藏 Kawaii 命中母厂牌 S1 场景）
  是 box 侧行为，非插件 bug（P4 记录）。
- chrome-devtools resize_page 不跨 reload 持久，窄屏验证用 emulate viewport
  覆盖（测试环境怪癖，与插件无关）。

## 2026-10-23 真实浏览器样式修复轮（用户反馈：角标错位/搜索居中/duo 多行）

| # | 问题 | 修复 | 验证 |
|---|---|---|---|
| S1 | 场景卡角标错位：来源 pill 与原生 specs 基线差 5px（挂载点 .scene-card-preview 比原生 .thumbnail-section 矮 5px——margin-bottom:5px）；days/inlib pill 用 0.5rem 与 studio 0.7rem 不齐 | CSS：.ssd-overlay-box `bottom: calc(1rem - 5px)`；days/inlib `top/left: 0.7rem` | specs.bottom − boxPill.bottom = 0；daysVsStudioTop = 0（预告卡实测） |
| S2 | 搜索框要求居中（原左对齐） | 工具栏改 grid 三列（1fr auto 1fr）：搜索框中列几何居中、控件组包 .ssd-dp-tools 右列靠右；≤1020px 回退 flex wrap（720 以下搜索满宽） | 1550px：searchCenterOffset=0；900/375px 正常换行 0 溢出 |
| S3 | 热门/即将发布默认 1 行但不同窗口宽度出现多行 | 三重修复：a) colsOf 加 half 参数（duo 半宽列数）；b) 场景网格容器从 flex-wrap 改 CSS grid（minmax(230px,1fr)——列结构不依赖图片加载）；c) trimRows 渲染后按真实列数截断 + window resize 监听（debounce 200ms 重渲染总览） | 1550：duo 热门 3 卡 1 行；900：duo 堆叠单列 latest 3+1 两行（rows=2 允许）；375：1 列 2 行；resize 切换自动重算 |
| S4 | （S3 调试中发现的隐藏 bug）flex-wrap 容器在 .ssd-dp-sec 里塌缩到内容宽（margin:0 auto 吞掉 stretch；图片加载前卡片被瞬时拉到整行宽 1466px） | 同 S3-b：CSS grid 容器根治；duo 列改 `minmax(0,1fr)`（含 900px 媒体查询）防内层 grid min-content 撑爆（曾现 2150px 溢出 2810px） | 全宽度 0 横向溢出 |

### 走查记录（1550 / 900 / 375px + 默认主题）

- 角标：boxPill↔specs 底边差 0、days↔studio 顶边差 0、左侧 left 全等；
  inlib 与 days 同 CSS 规则（同基线）。
- 工具栏：桌面搜索框几何居中 + 控件右对齐；窄屏满宽换行。
- 网格：latest 4 卡（数据量）、duo 热门 trim 后 3 卡 1 行、预告 1 卡、
  工作室 3 卡；mini 网格 3/8 卡各 1 行。
- 视图：follow 红框卡 2 张、settings 9 行 2 面板、trending 钻取正常。
- 主题 token --sx-bg #202B33（默认主题跟随正常）。
- node --check 通过，工作副本与实装目录已同步。

## 2026-10-25 样式修复第二轮（用户反馈 8 项）

| # | 问题（用户 2026-10-25） | 修复 | 验证 |
|---|---|---|---|
| R1 | 搜索框和筛选栏要**一起**整组横向居中（原：搜索框单独居中+控件靠右） | .ssd-dp-toolbar 改 flex + `justify-content:center`（S2 的 grid 三列与 1020px 回退断点删除），flex-wrap 兜底窄屏换行仍居中 | 502px / 1550px：groupCenterOffset=0；1550px 单行 48.2px；502px 换行态整组仍居中 |
| R2 | 总览模块之间没有隔开 | .ssd-dp-sec / .ssd-dp-duo `margin-bottom: 2.1rem`（last-child 归零） | 双宽度顶层模块间距全 29px 均匀 |
| R3 | 刷新按钮被挤成两行 | .ssd-dp-refresh `white-space: nowrap` + `flex: none` | 刷新按钮 h=29.3 单行（双宽度） |
| R4 | 演员角标叠在名字行，要移到卡片右上角外面 | .ssd-dp-mini `overflow: visible`；badge 改 `top:0; right:8px; translateY(-50%)` 骑卡右上外沿 | badgeProtrudesAbove=9.2px 外凸（双宽度） |
| R5 | 总览"n部新作品"角标要醒目色 | badge 默认态醒目橙底白字（--sx-or + 阴影）；co/hot 变体跟随同一位置 | bg rgb(218,112,44) 白字（双宽度） |
| R6 | 演员详情头像用竖版长图，右侧详情加国家/别名 | .ssd-dp-pfavatar 108×162 竖版 2:3（窄屏 64×96）object-position:top；renderPerfFilter 补 findPerformer 查询：性别/年龄/国家并入 meta 行 + alias_list 别名行（:empty 隐藏） | 1550px：108×162（ratio 1.5）；502px：64×96；"女 · 26 岁 · JP" + "别名：Kamiki Rei / Shiori / しおり / 園田みおん / 神木麗" |
| R7 | 右上箭头改用外链图标 | I.ext 换 lucide external-link（三段 path） | extIconPaths 三段 path ✓ |
| R8 | 按钮区去掉 stash-box 打开按钮（详情区外链图标已够） | renderPerfFilter 删 boxBtn；openPerfModal / renderStudioFilter 的同名按钮保留（用户仅指演员详情区） | actionButtons = ["♥ 已关注","发现 Tab","主页"]，无 stash-box 按钮 |

### 走查记录（502px 窄屏 + 1550px 桌面，已登录）

- R1-R8 全项 DOM 度量通过（见上表）；duo 1550px 两列 731+731px、
  0 溢出，热门 trim 后 3 卡 1 行；全页 overflowX=0（双宽度）。
- node --check 通过，工作副本与实装目录已同步（discover.js + stashDiscover.css）。

### R9 缓存踩坑修复（用户反馈：演员详情区和按钮区"好像没修复"）

- **根因**：discover.js 走 assets 端点（`/plugin/{id}/assets/`——无
  Cache-Control/ETag，仅 Last-Modified）→ 浏览器启发式缓存持续命中旧文件；
  主 JS/CSS 走 `/javascript`、`/css` 专用端点（no-cache + ETag，每次刷新
  revalidate）→ CSS 修复（R1-R5）正常生效，discover.js 修复（R6/R7/R8
  恰好全在此文件）被缓存吞掉。验证浏览器是全新实例（空缓存）所以看到新版。
- **修复**：injectDiscoverScript 注入 URL 加 `?t=` + Date.now()，强制每次
  文档加载拉新，与 ui.* 端点的 no-cache 语义对齐；版本 bump 2.1.1
  （yml + PLUGIN_VERSION）。
- **验证**：服务器响应头确认（ui 端点 no-cache+ETag vs assets 端点无缓存头；
  assets 响应含 pfalias 新代码）；刷新后 `discover.js?t=...` 全新网络拉取
  （transferSize 38028，非缓存命中），页面 7 模块挂载、0 溢出。
- **用户侧**：普通刷新（F5）即可——主 JS 走 no-cache 端点必然更新，新主 JS
  注入带时间戳 URL 后 discover.js 必然重新拉取。

## 2026-10-25 第三轮（用户需求 8 项：导航重构 + 演员详情模块统一）

| # | 需求（用户 2026-10-25） | 实现 | 验证 |
|---|---|---|---|
| N1 | "有新发布的演员"查看更多 → 发现演员页 | actors 模块 more：dpSetPrefs({perfSrc:"local"}) + switchView("performers") | 点击后 activeTab=performers、本地有更新 subtab on |
| N2 | 发现演员页增加"本地所有有更新的演员"tab | renderPerformers 三 subtab（本地有更新/共同出演/热门演员榜），local 分支渲染全量 actorsWithNew（可搜索、♥ 标、点击→perfFilter）；数据依赖只需 latest（hot 才需要 trendingPerf） | 48 张迷你卡全带本地头像；空态文案"回看期内没有新作品" |
| N3 | 预告分页合并到最新分页 + 预告 tab | VIEWS 删 preview 页 tab（7 tab）；renderDrill latest 视图内嵌"已发布·N | 预告·M"subtab（latestSub pref 持久化）；DRILL.preview 转为 sub 配置（date-asc+days 绿标）；总览预告模块 more → latest+预告 sub | 最新视图：已发布·46/预告·40，切预告 40 卡分页+“2 天后上映”绿标；预告模块 more 落在预告 sub ✓ |
| N4 | 演员详情区别名放到名称下面 | 共享模块 buildPerfHead：info 顺序 = 名称 → 别名 → 性别·年龄（R6 的 meta 并入方案作废） | infoOrder = [pfname, pfalias, pfgender]，别名"Maria Sakamoto / Miyu Aizawa / 坂本マリア" |
| N5 | 国籍用国旗放到头像上面（参考 stash 演员详情 tab） | 头像包 .ssd-dp-pfav + 左下角 .ssd-dp-pfflag 徽标；Stash 自带 flag-icons（fi-xx，与原生详情 tab 同源，实测 background-image 为内嵌 SVG）→ fillPerfDetail 设 fi 类；countryIso()：ISO2 直用 + 全名兜底表（JAPAN→JP 等 30 项）；本地 findPerformer 与 box findPerformer 均取 country | 108×162 头像左下 30×22 fi-jp 国旗（窄屏 64×96 头像 24×18）；弹窗（box country）同样 fi-jp |
| N6 | 演员详情区 n 部新作品放到最下面 | 统计行 .ssd-dp-pfstat 统一放按钮区下方（perfFilter："37 部新作品 · 最新 2026-11-19"；弹窗："共同出演 ×66" / "热门榜 #20 · 49 部作品"） | contentOrder = [pfhead, pfactions, pfstat, card-grid]；modal 同构 |
| N7 | 共同出演/热门演员榜弹窗用相同演员详情模块 | buildPerfHead/fillPerfDetail 共享（弹窗加 modal 类名）；弹窗 box 查询扩 country+aliases；统计行随模块移到按钮下方 | 弹窗结构 = close/pfhead/pfactions/pfstat/scenes；name→alias→gender 与 perfFilter 完全同构 |
| N8 | 共同出演的演员加载头像 | 主 JS BOX_SCENE_FIELDS performers 增 images{url}（与 L632 既有查询同模式）；buildCoStars meta.image；co 迷你卡与弹窗即时带头像（弹窗另由 findPerformer 补全） | co tab 12/12 卡真实头像（javstash.org）；总览发现演员模块 8/8；弹窗头像即点即显 |

### 走查记录（1550 / 375px，已登录，刷新后新代码）

- 页 tab 7 个（预告已并入最新）；总览 6 模块齐全；0 横向溢出（双宽度）。
- 本地有更新 tab：48 卡全头像；follow 视图 6 组正常（当前回看期均无新作，
  详情→perfFilter 路径与本地 tab 同代码已验）。
- 弹窗双源（co/hot）均：国旗 fi-jp、别名行、统计行底部、6 相关场景卡。
- 375px：latest subtab 正常、弹窗 fitsViewport、flag 24×18、0 溢出。
- SWR 缓存说明：latest 数据集缓存不含演员头像字段，需点"刷新"或等静默
  刷新后共同出演头像才出现（本轮验证已点刷新确认全量头像）。
- node --check 通过；三文件已同步实装目录；测试写入的 perfSrc/latestSub
  偏好已复位默认。

## 2026-10-25 第四轮（用户需求 7 项：细节修正）

| # | 需求（用户 2026-10-25） | 实现 | 验证 |
|---|---|---|---|
| R1 | "n部新作品，最新……统计放到演员详情区的下面，不是按钮区的下面" | buildPerfHead 增 p.stat → info 列最后一行 statLine（名称→别名→性别·年龄→统计）；perfFilter/openPerfModal 删按钮区下独立 stat div 改传 p.stat | 弹窗 infoLines 末行 "共同出演 ×64"；perfFilter 末行 "37 部新作品 · 最新 2026-11-19"；旧位置 0 残留 |
| R2 | "演员头像国旗缩小（场景的二级弹窗点击演员就有国旗的实现…）" | 弃 flag-icons fi-xx，改与主 JS 场景弹窗演员 popup 同实现：flagcdn w40 img + onerror ISO 文本兜底；CSS 徽标改为半透明黑底小徽章（桌面 img 20×14、窄屏 16×11，padding 2px 3px） | 桌面 flagRect 20×14、375px 16×11、src=flagcdn.com/w40/jp.png；无 fi-xx 类 |
| R3 | "共同出演列表还是没有头像，点开才有" | 根因 = 第三轮验证点过刷新但用户浏览器仍是旧 SWR 缓存（v1 无 performers images 字段）→ cacheKey 家族版本 .v1→.v2（newScenes/studios/trending）强制全端失效重拉 | 刷新后 v2 键写入；co tab 12/12 卡真实头像（javstash.org 直链） |
| R4 | ""加入库"按钮怎么是黑色的？" | 根因 = 用户主题采样主色过暗（黑系主题）→ suiteTheme derive() 增防黑守卫：lum(t.acc)<0.09 时退回橙色 t.or | 我方主题加入库按钮 rgb(57,145,200) 蓝不受影响（守卫仅拦近黑主色） |
| R5 | "返回总览按钮，我倾向分页有子tab的要有，没子tab不要有" | renderDrill 面包屑移入 view==="latest" 块（唯一有子tab 的钻取视图，含预告 sub）；trending/studios/perfFilter/studioFilter 均无 | latest：crumb"返回总览"+subtab"已发布·47/预告·42"；热门/工作室/演员过滤均 crumbCount=0 |
| R6 | "工作室分页，如果没有任何工作室被关注，提示…然后"去stash查看"按钮跳转到stash原生工作室列表" | renderDrill 空态分支：view==="studios" && !ds.studioCount（收藏数，非场景数）→ stateBox 提示"还没有收藏的工作室。在 Stash 中收藏（♥）工作室后…" + "去 Stash 查看" primary 按钮 → /studios；有关注但无新发布仍走通用空态 | 有关注时正常渲染组条（Prestige·12→cap 2 卡）；空态结构同 stateBox("error") 内按钮先例，.ssd-dp-state flex-column 居中布局确认 |
| R7 | "发现页作为单源目标，封面左下角不需要显示源名字" | cardCtx() queryBoxes 传空数组（主 JS buildSceneCard 仅 st.queryBoxes.length>1 时渲染 .ssd-overlay-box 徽标） | 总览/最新/热门/工作室四视图 sourceBadges=0（预告左上绿标保留，属不同功能） |

### 走查记录（1440 / 375px，已登录，ignoreCache 刷新后新代码）

- 缓存 .v2 生效：SSD:dp:javstash.org:{newScenes,studios,trending}.v2 写入，
  trendingPerf/local/follow 家族无 schema 变化保持 .v1。
- 弹窗（co）：info 列 = 名称→别名→"女·30 岁"→"共同出演 ×64"，加入库按钮
  蓝 rgb(57,145,200)，国旗 flagcdn jp 20×14，6 相关场景。
- perfFilter（本地有更新 51 卡取第一）：info 末行 "37 部新作品 · 最新
  2026-11-19"，按钮区 ♡关注/发现Tab/主页，无面包屑。
- 工作室视图：组条 Prestige·12（cap 2 卡）；latest 子 tab 计数随缓存刷新为
  已发布·47/预告·42。
- 375px：国旗 16×11、头像 64×96、0 横向溢出。
- node --check 通过；discover.js + stashDiscover.css 已同步实装目录
  （stashDiscover.js 本轮无改动）；测试写入偏好已复位（perfSrc=co, latestSub=new）。

## 2026-10-25 第五轮（用户需求 4 项：外部演员弹窗修复）

| # | 需求（用户 2026-10-25） | 实现 | 验证 |
|---|---|---|---|
| R1 | "外部演员的弹窗没有关闭按钮" | 根因 = .ssd-dp-modal overflow-y:auto 为滚动容器，close 按钮position:absolute 随内容滚动滚出视野（内容超 86vh 一滚就消失）。修复 = 内层滚动：modal 改 flex column + 新增 .ssd-dp-modal-body（overflow-y:auto, padding 18px/窄屏 14px），close 悬浮 modal 右上（z-index:2 + ui 底色替代透明） | 滚动到底后 close.top 74→74 完全固定；可见底色 rgb(48,64,77)；375px 同样固定可视 |
| R2 | "stash-box打开依然是右上箭头，不是外链图标" | acts 区 boxBtn 由 `品牌名 + " ↗"` 文字箭头改 `品牌名 + I.ext` SVG 外链图标（flex gap 6px 自动间距，13px svg） | boxBtn = 文本"JAVStash" + svg 13px，无 ↗ 字符 |
| R3 | "加入库之后还会显示加入库，点击提示加入失败" | 根因 = 重开弹窗不做在库预检，performerCreate 重复 stash_id 报错。修复 = ①打开弹窗 loadLinkedPerformers 预检：stash_id 已在库 → 直接「已加入 ✓」禁用；②失败分支先失效 memo 复查本地库，已存在 → 显示已加入（并刷新数据集）而非「加入失败」；markAdded/markFailed 收敛为函数 | みなと羽琉（已入库）开弹窗即「已加入 ✓」disabled；木村愛心/miru 显示「＋ 加入库」；实测加入流程 加入中…→已加入✓→重开仍「已加入 ✓」disabled |
| R4 | "已加入和加入失败的文字依然是和底色相近，不好阅读" | .ssd-dp-btn.ok/.err 由描边+浅色文字（gr-tx/re-tx）改实底白字：ok=绿底 var(--sx-gr)+#fff，err=红底 var(--sx-re)+#fff | ok 实测 bg rgb(135,154,57) + color rgb(255,255,255)，高对比 |

### 走查记录（1440 / 375px，已登录，ignoreCache 刷新后新代码）

- 弹窗结构 = close + modal-body（head/acts/scenes 全在 body 内），滚动只发生在
  body 层，close 与 modal 定位解耦。
- co 列表 12 卡逐个抽验：在库演员（みなと羽琉）预检即显已加入；未入库演员
  可正常加入，成功后绿底白字「已加入 ✓」，重开不再重复创建。
- 375px：body padding 14px、close 固定可视、0 横向溢出。
- node --check 通过；discover.js + stashDiscover.css 已同步实装目录；
  测试写入偏好已复位（木村愛心入库为流程验证产物，属功能预期数据）。
