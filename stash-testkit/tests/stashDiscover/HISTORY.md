# stashDiscover — 版本与轮次历史

> 每一轮用户要什么、最后改成了什么。回答「这版为什么长这样」用这里。
> **机制型结论已全部搬到 [PITFALLS.md](PITFALLS.md)**（CSS 层级、宿主机制、测试方法、边界行为），
> 当前实现口径在 [FEATURES.md](FEATURES.md)，数据层在 [SEMANTICS.md](SEMANTICS.md)。

## 第二轮 UI 修订（v2.5.6 批次8，2026-10-29）

用户六条：汇总符号 / 发现页多选 / 演员页 tab 改造筛选栏 / 设置页文案 / 入库预览 / 已忽略管理页。

- **汇总只留三个符号**：`SSD.importSummary(ok, skip, failed)` 输出 `<span class="ssd-sums">` + 三个
  `.ssd-sum`（绿勾 47,158,68 / 灰感叹 122,130,136 / 红叉 224,49,49），三项**固定全显**（含 0），
  宽度恒定 162px，绝不随结果变长。失败原因走 `toast` 的 `title`；`dpToast` 补 `opts.html / opts.title`，
  除汇总外一律 `textContent`。
- **发现页多选**：`.ssd-dp-toolbar.is-selecting { justify-content: center }` + selbar `flex: 0 1 auto`
  （原来 `1 1 auto` 撑满后整组被推在左边）；入口按钮 32×30 → 34×32 与视图切换同尺寸，
  selicon/selact 30 → 32。
- **演员页 tab 改成「改造筛选栏」**：删掉独立 `.ssd-tabsel` 行，改成
  `toolbar.classList.add("is-selecting")` + `insertBefore(buildTabSelbar(), displayGroup)`；选态只靠
  CSS 收掉 search / sort / page-size / refresh / zoom / 多选入口 / 分页，留操作组 + 网格·列表切换。
  刷新按钮补 `.ssd-tab-refresh`（原来没有类名，抓不到）。
- **入库预览整行可点**：`impRow` 给 row 挂 click，命中 `input, select, textarea, button, a, label`
  时放过（点进文本框是改字，不该顺手关掉这一项），locked 行不挂。
- **已忽略管理页**：工具栏居中、四个控件统一 30px、卡片定宽 170px（演员卡 208px）+ flex 换行、
  详情弹窗 `min(420px, 92vw)`、封面 `aspect-ratio:16/9 + object-fit:cover`；导入
  `importJSON(text)` 只补本地没有的键（不覆盖既有决策，脏字段按快照结构重建）；补每页 24/48/96
  + 底部翻页。
- 机制型结论：sticky 的测量前提与父容器边界、原生工具栏高度基线、grid 空轨道与特异性重叠、
  源码顺序决定同特异性胜出、`elementFromPoint` 判遮挡 → 全部见 PITFALLS.md。

## 第四轮（UI 修订：贴顶 / 按钮风格 / 已忽略页 / 多选演员，2026-10-29）

- **贴顶偏移改用 `--ssd-stick-top`**（量 Stash 顶栏高度，`[400,1200,3000]` 三次延时重测），
  且**只在多选态贴顶**；页面底色由 `syncStickyEnv()` 量 body 的 computed background 写进
  `--ssd-page-bg`，替掉写死的 `#1c1c1c`。
- **多选按钮对齐原生尺寸**（`.btn` 33px 那套）；**选态操作组改绝对定位**到右侧，留在 flex 里会把
  中间那组推左 39px（barMid 632 vs groupMid 593）。演员页同理，柱子居中靠
  `.filtered-list-toolbar{justify-content:center}` + 右侧 `.btn-group{position:absolute;right:0}`。
- **已忽略页 gap / 窄屏卡片尺寸**两处都栽在特异性上，改成连 `display` 一起写、并给窄屏那条
  加 `:not(.ssd-dp-iggrid)`。
- **`batchAddPerformers` 的 endpoint 必须完整 URL**，否则「跳过」被算成「新建」，汇总符号错。
- **退出多选补 `syncSelBar()`**：`selCount` 的文本只有它写，`exitSel()` 只调 `syncChrome()`，
  于是上次的「演员 1/1…」会留到下次进多选（元素隐藏时看不见，文本在）。
- 机制型结论：顶栏量高度、原生尺寸基线、bootstrap label 的 margin、`.btn-group` 连体、toast 抓取、
  `--js` 包装 → 见 PITFALLS.md。

## 第五轮（搜索结果排序/折叠、超时、导航机制调研，2026-10-30）

- **归一化弃用 `\p{L}`**（parse 期 SyntaxError，整个脚本不加载），改显式 Unicode 范围。
- **低匹配折叠**：先按标题匹配度排序，取 `max(3, ceil(n*0.2))` 条作为「主要结果」，其余折叠成
  一条可展开的提示；先判 `anyHit` 再决定要不要排序。
- **导航入口改成「像 binge 一样是原生开关」**：设置 → 界面 → 菜单项目里出现同名复选框，
  直链仍可用（patch CheckboxGroup 塞项 + 自己按 `menuItems` 决定渲染 + 首次 seed）。
- 调研结论（徽章与挂载无关、`\p{L}`、`.btn-group` 选用器、假数据验折叠）→ PITFALLS.md。

## 第六轮（复选框图标 / 移动端贴顶 / 窄屏多选栏 / 已忽略页 / 导航原生开关，2026-10-30）

- **移动端贴顶判据加位置**：顶栏 `fixed` 但在屏幕底部，只看 `position` 会凭空空出 85px。
- **「已忽略」卡片补国籍/年龄**：三个忽略入口里有两个拿的是 `scene.performers`（只有 id/name/图），
  快照本来就没字段。管理页打开时按需 `findPerformer(id)` 补（`ssd:ign-enriched` 触发重绘，
  单条失败不影响其它，一次最多 12 条，补过的键记内存防重复），并给卡片三级回落
  （国旗/年龄 → 别名 → 数据源品牌）。
- **图标换成 svg**：× 的 path 铺满与复选框外框同范围。
- **窄屏多选栏取舍**：视图切换不参与多选、计数只留数字、整组一行居中。
- **`shot` 补 `--vsize`**（原先只有 `eval` 有，移动端布局截不到）。
- 机制型结论：移动端顶栏判据、忽略键的 `lastIndexOf(":")`、svg 图标范围、seed 会改用户配置
  → 见 PITFALLS.md。

## 第七轮（设置页实心按钮 / 勾选框图标 / 已忽略演员卡，2026-10-30）

- **国旗改用图片**：Windows 没有 emoji 国旗字形，改 `flagcdn.com` + `onerror` 退化字母。
- **一行混排 img / span / 文本**，按节点 append、靠 flex `gap` 分隔，不再 `join(" · ")`。
- **窄屏「恢复」按钮换行**：塞 0 高占位 div 断行，按钮保持内容宽度。
- **设置页实心按钮**：`.ssd-dp-btn.solid` 只管底色，高度由更靠后的 `.ssd-dp-setbtn` 决定。
- **多选入口图标与全选图标拆成两个常量**：入口固定「框+笔」（能力标识），全选才是空框 ↔ 框+勾
  （状态开关），共用一个会让「未全选」也显示成勾选态。
- 机制型结论：国旗 emoji、混排不能 join、占位断行、同特异性靠顺序 → 见 PITFALLS.md。

## 发现页缓存字段压缩（v2.6.2，2026-10-31）

按 4000 条 × 3 图的基准重算 payload，三个改动：

- **tags 改「全源去重词典 + 场景存下标」**（`tagDict`）：同一条 trending 缓存（30 条场景）
  60779 → 44808 字符（**省 26.3%**）。不升 `fmt`，靠「有没有 `tagDict`」判别两代 payload，
  老条目 12h 内自然被覆盖。
- **封面取图上限 8 → 3**（实测三源每场景 1 / 1 / 3 张，第 4 张起没有任何读取点）。
- **`totalSeen` + 「缓存不完整」chip**：把「预算裁条数」从静默错误变成可见状态，点了就重拉。
- 顺带删掉 `stashDiscover.yml` 的 `tasks:` 段（两个按钮手动点击必然失败且错误被吞）。

字段体积账、`tagDict` 为何不做裁剪收窄、`totalSeen` 的口径 → [SEMANTICS.md](SEMANTICS.md)
「发现页缓存」；任务通道为何只有 `runPluginOperation` → SEMANTICS「Jackett 搜索链路」。
回归探针见 [SCRIPTS.md](SCRIPTS.md)。

## v2.8.0：测试面板重做 / 总览加载态 / 查询层去重（v2.7.2 → 2.8.0，2026-11-14）

- **设置页测试弹窗改用宿主 `Bootstrap.Modal`**：X 按钮 + Header 下沿 / Footer 上沿各一条细线（照
  External Player Launcher）。Esc、遮罩关闭、背景滚动锁都由 Modal 提供；遮罩误关自己做防误触
  —— `backdrop:"static"` + 判「pointerdown 起点也在遮罩上且位移 < 8px」。点击泄漏分两层修：弹窗
  子树根 `stopPropagation`（挡 React 树冒泡）+ `document` 捕获阶段吞掉拖拽/遮罩落点（挡已跑出子树的
  那条 click）。机制见主 README「插件 UI」。
- **总览加载态**：等高骨架占位替代 `加载中…`（场景卡复用 `.ssd-card-grid`、文案区按卡档定高，迷你卡
  44px 头像），错误态带重试；数据落地按 `data-mod` 就地替换模块（`refreshModules`），不再
  `innerHTML=""` 整页重建。骨架只对齐典型卡高，实测模块差 0~22px、整页抖动 44px（原 51px 是整页跳）。
- **限流器加优先级**：`submit(fn, priority)` 把重试插到队头（实测冷加载里 latest 的两个请求原本要等到
  t+5.7s）。优先任务能越过尚未派发的排队任务，越不过已占满的 3 个槽位。
- **查询层**：`getPluginSettings` / `getStashBoxes` 并发去重 + 10s TTL（刷新窗口 `configuration{plugins}`
  5 → 1，用户点刷新会先清缓存）；SWR 后台刷新补 `.catch`；in-flight 去重键从「演员个数」改成 id 集合。
  冷加载剩下的 2 次配置查询经调用栈确认来自 peekaboo 插件，不是本插件。
- **tab 分页终止判据改用 count**（顺序：整页重复 → TPDB `hasMore=false` → 空页 → 取满 count →
  无 count 才退回「没回满」），加 `TAB_MAX_PAGES=50` 兜底；**本地快照拆键**
  `owned.v1`（10 分钟）/ `linked.v1`（1 小时），各 1.2M 字符预算，写失败 `console.warn` 一次，
  读时迁移旧 `local.v1`。
- 机制型结论：骨架容器类名、count 判据、弹窗指针事件测试法 → [PITFALLS.md](PITFALLS.md)；
  回归脚本 `probe_overview_placeholder.js` / `probe_tab_paging.js` / `probe_req_dist.js`。

## v2.8.1：排序体系 / 窗口下推源端（v2.8.0 → 2.8.1，2026-11-15）

- **时间窗口下界交给源端**：`fetchBoxPage` 拼 `date:{value: recentCutoffDate(recentDays+1), modifier:"GREATER_THAN"}`。
  多留一天是因为源只认严格大于（`GREATER_THAN_OR_EQUALS` 不是合法 modifier），边界当天的片子会被源剔掉，
  多取的那天由客户端窗口自己裁。原来只在客户端过滤：源按日期倒序发 1513 条，倒序翻 15 页、正序 19 页 77 秒；
  带上 date 后同一演员窗口内 18 条，一页取完，count 也变成窗口内的数。TPDB 只有批量路径
  `/scenes?performers[x]=…&date=…&date_operation=>` 认 date，子资源 `/performers/{uuid}/scenes` 带 date 直接
  报错、带整数 id 则忽略，所以有窗口时它走 `tpdbSinceScenes`（一次全量、排序交客户端、`hasMore:false`）。
- **tab 排序字段**：`DATE | TITLE | DURATION | PERFORMERS`，字段 + 方向都推给源。`PERFORMERS`（演员数）在
  `SceneQueryInput.SortEnum` 里没有对应项，`serverSortField()` 退回 DATE、取回窗口内全集后本地排；也因为取回
  仍是日期序，`boxPageOutOfWindow` 的早停照常有效。选它时自动切升序（找单人是主要动机）。
- **换排序不再整轮重查**：`applySort()` 在 `allLoaded` 时纯本地重排（实测点倒序 19 请求 → 0），没取完才回源。
  前提是窗口已下推、源回的就是全集。快照里 `sortField` 一起存，回来还是那个排序。
- **发现页排序（用户选 B）**：下拉同时作用于总览模块，但按模块决定 —— 最新发布 / 工作室新发布跟随；
  即将发布把日期方向冻结为「近→远」（预告按日期倒序无意义），标题 / 演员数照选；热门不跟随（重排就不是
  全站榜）；演员维度迷你卡不跟随。新增「演员数 ↑/↓」，`perfCountOf` 只数有 performer 主体的元素，0 人恒沉底。
- **窄屏下拉避让**：BS4 `.dropdown-menu` 恒 `left:0`，375px 下溢出 122px。打开时量矩形 → 越界翻成右对齐，
  仍越界再限宽 + `translateX`。注意 ≤360px 演员页原生 `performer-head` 本来就有 15px 溢出，别误判。
- **`perPage` 并入 10 分钟快照**（与 `currentPage` 成对，只存页码会落在空页）；下拉选项抽成 `PAGE_SIZE_OPTS`，
  还原时用它校验合法性。刷新仍回默认 40 —— `_tabSnap` 在内存里。
- 回归：`probe_tab_paging` normal 2 请求 / clamp 12 请求 240 卡 / ignore 2 请求即停，与 v2.8.0 基线一致。
  探针 mock 的场景日期改成「当天」，否则窗口下推后全被裁掉。

## v2.8.2：刷新不跳顶 / 刷新过程可见（v2.8.1 → 2.8.2，2026-11-15）

用户报「点刷新后卡片 20 秒内就填完了，停在页底 1~2 分钟却突然跳回顶部」，以及「点了刷新看不出动没动」。

- **跳顶两个根因**：① `pollSettled` 的 60 秒兜底定时器没 `clearTimeout`，先落地走完后它到点又跑一次，
  而那次在整页 `render()` 之后、高度没变就把 `scrollTop` 归零（打桩证明 JS 一次都没写过它，是浏览器钳的）；
  ② 整页重建时 `innerHTML=""` 让文档瞬时塌缩，浏览器立刻把 `scrollTop` 夹到 0，之后再写回也回不去。
  改：`pollSettled` 用 `done` 标志 + 清定时器保证只跑一次；`renderContent` / `refreshModules` 进门记
  `scrollTop`、建完写回（后者补一个 `requestAnimationFrame`）；只有翻页三处显式 `render({top:true})`。
- **`doRefresh` 收尾不再整页重画**：总览就地换模块（`refreshModules`），其他视图才 `render()`。
  实测刷新全程 `y=700` 不动、`scrollHeight=2043` 不变。
- **`trending` / `studios` 补 SWR**：原来只有 latest 有 stale 分支，另两个缓存过期只能空等。现在先出旧卡
  （实测 1s）再后台静默刷新（4.3s / 4.6s 就地回填），`_dataSeq` 守卫乱序。
- **页头文案收敛成一个出口** `statusText()`：原先 `syncChrome` 和每分钟的相对时间定时器各写一份，
  带后缀的文案最多活 60 秒就被无声抹掉。
- **进度与结果**：刷新中显示「更新中 2/4」（按数据集落地数）；结束给结论 —— 有新场景 `· +3`、
  没有 `· 无新增`、有失败 `· 2/4 失败`。结果类 10 秒后退回纯时间（`+3` 是动作结果不是持续状态），
  失败类常驻到下次成功。`title` 给「上次刷新 05:08:38」。首屏无旧数据时不报 `+N`（拿空集合比会出荒谬数）。
  新增数按三个场景族合并去重，只报增不报减。
- **过程可见**：总览模块卡片降到 `.5`，模块图标换成模块色散射条纹转圈（`repeating-conic-gradient` +
  `mask` 裁环，实测 15×15、颜色取到 latest 的绿），落地即淡回原图；数据集分三批（最新系 4 个模块 /
  热门 / 工作室）逐次亮回。钻取与列表视图没有模块头，整片 `is-refreshing` 降暗。不做 2px 进度条（冗余）。
- **`MODULE_DEPS` 反查**：一个模块要等全部依赖数据集落地才亮 —— 「有新发布的演员」同时吃 latest 与
  trendingPerf，只按 `MODULES_OF_DATASET` 会在 latest 到达时提前 3 秒亮。
- **模块配色提成 `--ssd-mod-c`**：6 条配色原挂在 `svg` 选择器上，转圈是伪元素拿不到，改成定义变量后共用。
- 坑：`render()` 先 `syncChrome()` 再 `renderContent()`，刷新中切回总览时文案写着「更新中 0/4」但模块全亮 ——
  加类那一刻节点还没建出来，得在 `renderContent()` 之后再补一次 `syncBusyMarks()`。
- 实测：文案 `0/4 → 1/4 → 3/4 → 4/4 → 刚刚更新 · 无新增`；后缀 8.6s 出现、18.6s 退回；劫持 fetch 让
  TRENDING 失败得「刚刚更新 · 1/4 失败」且 16 秒后仍在；360/320 屏最长英文 `updated 23 h ago · 2/4 failed`
  157px 不换行不溢出；七视图遍历 `errs=0`。探针 `probe_refresh_scroll.js`。

## v2.8.3：工作室角标左下档 / 长名截断 / 时长冒号字距（v2.8.2 → 2.8.3，2026-11-15）

- **「显示工作室角标」加左下档**（隐藏 / 右上 / 左上 / 左下）。同一个角只放一组：工作室选左侧任一角，
  自定义角标让到另一角；反过来自定义选中的角与工作室相同，工作室退回右上（它的默认位，永不被占）。
- **长名换行掉到封面外**：宿主的 `.studio-overlay` 是 `height:10%`（单行高）＋ `overflow:visible`，
  顶部两档溢出的行落在封面里看不出来，改到底部就往下掉进文字区。该档补 `height:auto`，底边钉住、盒子往上长。
- **三档都加两行截断**：`-webkit-line-clamp:2` 要落在真正装文字的元素上 —— 原生把名字包在 `inline-block`
  的 `<a>` 里，父 div 只有一个原子子盒，clamp 写在父级截不到内部的行，两层都写；同时必须 `height:auto`，
  否则 10% 高度配 `overflow:hidden` 会把第二行整行裁掉、连省略号都没有。另 `<a>` 自带 `text-align:right`，
  左角里两行名字右参差（有些卡没有这层 `<a>` 又是左对齐），左角强制 `left`。
- **时长冒号挤成一串**：根因是宿主全局 `letter-spacing:-0.04em`（10.5px 下 -0.42px/字），冒号的推进宽度
  只剩 1.9px，两侧还各被吃掉 0.42px。该角标还原成 `normal`（冒号 2.3px、整串 29.9→32.9px，右对齐不加宽布局）。
- 实测：19 张卡 × 三档最高 24px、越界 0；大档 28px；480/360 屏无横向溢出；单行 12px 与改前一致。
  坑：本机的工作室名被 peekaboo 换成假名且持续改写，验证角标排版前先关遮挡（`Shift+Alt+B` / 导航栏眼睛按钮）
  或把测试节点放进 Shadow DOM。
