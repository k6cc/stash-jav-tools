# stashDiscover — 实测经验与坑

> 反直觉结论，以及「只有一条路能走」的记录。按主题分组，与轮次无关；条尾注明出处轮次。
> 遇到诡异现象先 grep 关键词再动手。某一轮具体改了什么见 [HISTORY.md](HISTORY.md)。

分组：卡片状态环 · 多选图标与层级 · 弹窗滚动 · 临时查看已忽略 · 重复忽略 ·
CSS 特异性与顺序 · 布局与尺寸基线 · Stash 宿主机制 · 浏览器与 JS · 测试方法 · 业务逻辑

---

## 卡片状态环：三种画法与取舍（2026-10-30 实测）

给场景卡画一圈「状态描边」（未读红框 / 多选蓝框），只有三种画法，实测结果：

| 画法 | 结果 |
|---|---|
| `outline` / `box-shadow` 画在卡片根 | 封面区**完全看不到**，只剩文字区那半圈 |
| `outline` 画在封面区块（`.video-section`）上 | 仍被它内部的 `<img>` 盖掉，只剩封面底边/右边一条 |
| 伪元素覆盖层（`inset:0` + `z-index`） | 四边完整，且 blur 插件开着也清晰 |

前两种失败的原因相同：`outline` / `box-shadow` 属于**元素自身绘制**，任何定位子元素都画在它
上面。所以这不是「选一种更好的」，而是只有伪元素这条路能走。

- 关注页未读：`.ssd-card-new::after`，z-index 12，2px 红边 + 整卡 9% 淡红。
- 多选选态：`.scene-card.is-sel::before`，z-index 13，只画边不染底。
- **故意占两个伪元素槽位**：卡片可能同时「未读 + 已选」，两层各画各的才能都成立；挤在一个
  槽位上，后声明的规则会把另一个整条顶掉（未读标记在多选期间就消失了）。
- 选态不染底：多选时要靠封面认片，整屏发蓝反而挡事；未读那 9% 是因为它要当一条常驻信息。
- z-index 阶梯：角标 9 < 未读环 12 < 选态环 13 < 勾选圈 14 < 演员小卡徽章 15 < 工具栏 25/90 < 弹层 99999。
  **演员小卡的「新作 N」徽章必须高于选态环**：它 `top:0 + translateY(-50%)` 骑在卡片上边框上，
  环在上层会从徽章文字中间划一道蓝线（用户 2026-10-30「边框应该在徽章下方」）。场景卡的角标
  不骑边，所以不需要这一层。
- 列表模式是例外（`<tr>` 不能定位）：`td` 14% 淡红 + 封面自身 `outline-offset:-2px`，
  前提是那张封面上面没有别的子元素 —— 换成卡片就必须走伪元素。

## 多选入口图标与选中态层级（2026-10-30）

- 入口图标 =「框里一支笔」的编辑图标（`I.selToggle` / `SSD_ICON_EDIT`，同一段 path），15px
  与工具栏其它图标一致。演进过程：复选框（像「未勾选项」）→ 放大到 20px（留白还是散）→
  「三行带勾」（和右边的列表视图撞脸）→ 现在这个。全选仍是 空盒 / 盒+勾 —— 两套图案分工：
  入口说「这是批量操作」，全选说「选没选」，不混。发现页入口位置移到「24 / 页」右侧
  （与视图切换连成一组「这一屏怎么展示」）。
- **选中描边不能用 outline / box-shadow**：两者都是元素自身绘制的，会被 `position: relative`
  的封面区（`.video-section`）整块盖住，只剩文字区那半圈（用户 2026-10-30 反馈「封面盖在
  选中边框上面」）。改画在卡片 `::before`（inset: 0 / z-index 13）：发现页 `--sx-acc`、
  演员页 `--ssd-sel-acc`。列表模式不受影响（那边是整行淡底）。
- `.ssd-dp-selbox` z-index 6 → 14：`.ssd-badges`(9) / `.studio-overlay`(8) 之前压在这颗勾选圈上。
- 多选态 `.ssd-badges` 默认在左上 6px，和勾选圈（8px, 24px 见方）完全重叠 → 让到 38px；
  `data-badge-pos="bl"`（底部）本来不撞，不动。
- 回归：`probe_batch_select.js`、`probe_tab_select.js`。**探针跑法**：先 `--path /` 并 `sleep 2500`
  等首页导航渲染，再点 `/performers` 列表页、`pushState` 进详情页 —— 直接 `--path /performers/xx`
  会被 SPA 弹回 `/`，首页直接 pushState 也进不去。

## 弹窗滚动容器是 .ssd-modal-body（2026-10-30）

`.ssd-modal` 是 `overflow:hidden`，`scrollHeight === clientHeight`（实测差 0），滚它等于没滚，
所以「点搜索资源后自动上滑到底」静默失效了很久。改滚 `.ssd-modal-body`；结果渲染后再把
`.ssd-search-header` 对齐到可视区顶部（否则滚动位置停在列表中间），翻页同样对齐。

- 回归：`probe_search_scroll.js` —— onClick.top == max、afterRender.headerOffset == 8、翻页后仍 8。

## 「临时查看已忽略」为什么不能靠摘列表（2026-10-30）

演员页「发现」tab 原来在忽略后把卡片从 `cachedMissing` **splice 掉**，于是片一旦被忽略就
从这个 tab 彻底消失 —— 空态还提示「清除搜索可查看已发现的全部场景」，点了也没用（搜索和
忽略是两个独立过滤器）。现在：

- 忽略只写记录，**不动 `cachedMissing`**；隐藏完全交给 `getFilteredMissing()` 的过滤器。
  代价是 `cachedMissing.length` 不再等于「可见条数」，计数行改用 `filtered.length`（本来也是）。
- `_state.showIgnored`（session 级，换人/刷新复位）打开时跳过忽略过滤，卡片回来，封面挂
  `.ssd-overlay-ignored`；工具栏下方出 chip「已忽略：临时显示 · 本次」+「恢复隐藏」。
- 空态分两种：搜索没命中（`no-match`，动作是清除搜索）vs 都忽略了（`ignored-hidden`，
  动作是「查看已忽略的场景」）。两者同时成立时（搜索 + 有已忽略）抬头按「没有匹配的场景」走，
  按钮变「清除搜索并查看已忽略」—— 只清搜索还是空屏，只显示忽略又会被搜索挡住。
- 角标颜色写死 `rgba(209,77,65,.94)`：演员 tab 不在 suiteTheme 的 `--sx-*` 作用域里，
  `color-mix(var(--sx-re)...)` 会整条失效只剩白字（实测第一版就是这么瞎的）。
- 回归：`probe_ignored_show.js` —— 全忽略 → 面板 → 打开（8 卡 / 8 徽章 / chip / 计数含已忽略）
  → 恢复隐藏 → 记录差集清零。

## 对「已忽略的场景」再点一次忽略（2026-10-30 实测结论）

「临时查看已忽略」打开后，已忽略的卡片照样能进多选、照样能点忽略 —— 这条路径必须想清楚：

- **存储层是幂等的**：`ignoreScene()` 命中已有键时不覆盖、不新增（`at` 保持不变），
  重复忽略后 payload 字节数一模一样（实测 2174 → 2174），不会写出重复键、不会虚增条数。
- **真正的坑在撤销，不在写入**：批量忽略把本次的 key 收进 `keys[]` 供「撤销」回滚。
  若把「早就忽略过的场景」也算进去，一次撤销会连**更早那次**忽略一起删掉 —— 用户只是
  顺手全选了一次，昨天/上周的决策就没了。所以三处都改成：命中已忽略就 `already++` 跳过，
  不进 `keys[]`。
  - `tabSelIgnore()`（演员页发现 tab）、`batchIgnoreSelected()`（发现页）、
    `toggleIgnoreScene()`（场景详情弹窗，弹窗里直接提示「已在忽略列表里」不动作）。
  - 全选都是已忽略项时 `keys` 为空 —— 这时报「存储写不进去（可能已满）」是**误报**，
    改写「选中的 N 项都已在忽略列表里，无需重复忽略」。
- **撤销要真的重扫**：原来只清 `cachedMissing` + `renderTabContent()`，注释写的是「原地重扫」
  但根本没扫 —— 实测撤销后列表一直空着，要用户手动刷新才回来。改调 `loadMissingScenes()`。
- 回归：`probe_reignore.js` —— 8 部里留 5 部旧记录 → 全选 8 部再忽略（应只新增 3 部、
  旧 5 部 `at` 不变、toast 报「已忽略 3 部 · 5 部已在列表，跳过」）→ 撤销（应只剩旧 5 部、
  且键集合完全一致）→ 再来一次（应提示「都已在忽略列表里」而非误报写失败）。

---

## CSS 特异性与源码顺序

同一层意图被另一条规则压掉时，**先数特异性，再数源码位置**；两者都相同才是真没生效。

- **`.ssd-dp-grid.mini` 的 `display:grid` 压掉 `.ssd-dp-iggrid` 的 `display:flex`**（(0,2,0) vs
  (0,1,0)）。已忽略页演员 tab 的容器同时带这两个类，结果卡片按 grid 轨道 180px 排、`width:236px`
  照样生效 → **相邻卡片重叠 56px**，前几张的「恢复」按钮被下一张头像盖住。肉眼只看到最后一张
  有按钮。修法：显式写 `.ssd-dp-iggrid.ssd-dp-grid.mini { display: flex; ... }`。（第二轮）
- **只改 `gap` 不生效，也是这条**：`.ssd-dp-page .ssd-card-grid`(0,2,0) 的 `display:grid` 还在，
  实测 gap 仍是 82px。要连 `display` 一起写 `.ssd-dp-page .ssd-dp-iggrid { display:flex; gap:6px }`。（第四轮）
- **`@media (max-width:480px)` 里还有一份 (0,3,0)**：390 视口下会把卡片算成 82px 宽 →
  那条规则要加 `:not(.ssd-dp-iggrid)`。（第四轮）
- **同特异性靠源码顺序决出**：`.ssd-dp-btn.solid` 与 `.ssd-dp-btn.ssd-dp-setbtn` 都是 (0,2,0)，
  setbtn 在文件更后（3269 行）所以 `height:30px` 生效、solid 只负责底色。**别把 setbtn 往前挪。**（第七轮）
- **详情弹窗宽度必须写双类名**：`.ssd-dp-modal.ssd-dp-igmodal`；只写 `.ssd-dp-igmodal` 会被文件里
  更靠后的 `.ssd-dp-modal` 同特异性改回 760。（第二轮）
- **判断「元素看不见」不要只看 `getComputedStyle`**（全是 visible / opacity 1），用
  `document.elementFromPoint(中心)` 看实际命中谁 —— 重叠、遮挡一眼就出来。（第二轮）

## 布局与尺寸基线

- **原生 `.btn` 实测**：高 33px、`padding 5.25px 10.5px`、`border-radius 3.5px`；
  `.btn-secondary` bg `rgb(57,75,89)`、`.btn-primary` bg `rgb(19,124,189)`。图标按钮**只写
  `width` 会得到 26px 高**（inline-flex + svg 撑不出高度）→ 必须 `width:36px; height:33px; padding:0`。（第四轮）
- **原生 `.filtered-list-toolbar` 高 48，选态 47**：多选态不能变高，操作组按钮必须 33px。（第二轮）
- **`.filtered-list-toolbar` 的底色是 Stash 给的**：原生规则里就有 `background-color: rgb(32,43,51)`
  （Dark 主题编译值，不是 CSS 变量）。插件不覆盖就跟着主题走；写 `background: var(--x)` 反而在
  切主题后停在旧色。之前那个「未知黑色底 `#1c1c1c`」就是自己写死的。（第四轮）
- **三格连体按钮用原生 `.btn-group` 就有**：`> .btn:not(:first-child){margin-left:-1px}` 把相邻
  边框叠成一条，首尾 `border-top-*-radius: 0` → 整组一个外框（实测相邻格 `left - prev.right = -1`）。
  数量格是 `span.btn`，照样吃这套规则。（第四轮）
- **工具栏控件错位 3px 的元凶是 bootstrap label 的 `margin-bottom: .5rem`**：flex 行
  `align-items:center` 对齐的是 margin-box，label 比按钮高 7px，视觉上低 3px。修法
  `.ssd-dp-ignsearch { height:30px; margin:0; align-items:center }`。（第四轮）
- **别用 grid 的 `auto-fill`**：会生成空轨道，宽屏上卡片组贴左；`minmax(150px,172px)` 实测在
  1252 容器里算出 5 列 242px（不是预期的 7 列 172px），行为不可预期。定宽卡 + flex 换行 + 居中。（第二轮）
- **`.ssd-dp-tabs` 自带 4px padding + 1px 边框**，选态 tabs 会高到 39px →
  `.ssd-dp-igntabs { height:30px; padding:0 3px }` + tab `height:24px`。（第二轮）
- **sticky 的三个前提**：① 内容要够长（见「测试方法」）；② **粘住范围受父容器边界限制**；
  ③ 背景必须不透明（`var(--sx-bg)`），否则卡片从下面透上来。（第二轮 / 第四轮）
- **图标 svg 要铺满同样的范围**：`&times;` 换成 svg 后，一个 11px 的方框旁边挂 7.5px 的叉就是
  「小一圈」，path 要写 `M4.5 4.5l15 15` 而不是 `M6 6l12 12`。（第六轮）
- **窄屏要让按钮换行但别铺满**：`flex: 1 1 100%` 会让按钮占满整行像多出一条信息栏，只改
  `flex-basis` 又压不住 `flex-shrink:0`。可靠做法是塞一个 `flex: 0 0 100%; height: 0` 的占位 div
  强制断行。（第七轮）
- **混排图片后不能再 `facts.join(" · ")`**：一行里国旗是 `<img>`、性别是带色 span、年龄是文本，
  只能按节点 append，分隔靠 flex `gap`。（第七轮）

## Stash 宿主机制

- **顶栏高度量到 0 不是「没有顶栏」，是脚本比 React 早**：`nav.top-nav.navbar` 是
  `position: fixed; top:0; z-index:1030; height:48.75px`。`initPlugin` 里立刻量会得到 0，写进
  `--ssd-stick-top: 0px` 后工具栏贴在 0，被顶栏整块盖住（`elementFromPoint` 命中的是 nav）。
  修法两条一起：① 量到 0 **不覆盖**已有值；② `[400,1200,3000]` 三次延时重测 + `mountPage()` 再调。
  判据：`bar.getBoundingClientRect().top === nav.bottom`。（第四轮）
- **移动端顶栏是 `fixed-top` 但贴在屏幕底部**：390×844 实测 rect `top 759 / height 85`，桌面端是
  `top 0 / 49`。所以「fixed 就把高度加进 `--ssd-stick-top`」是错的，会凭空空出 85px。判据要加
  位置：`rect.top <= 8 && position !== "static"` 才算挡在顶部；写 0 时**不要**再用「量到 0 就别
  覆盖」那道保护（它是防 SPA 未布局的），区分办法是 `rect.height === 0` 直接 return。（第六轮）
- **插件 nav 入口想「像 binge 一样是原生开关」，靠三件事拼出来**（Stash 没有原生插件菜单项）：
  ① `patch.before("CheckboxGroup")` 往 `menu-items` 组里塞 `{id}`，设置页就出现和内置项一样的
  复选框；② 在 `MainNavBar.MenuItems` 的 patch 里自己读 `configuration.interface.menuItems`
  决定渲不渲染；③ 首次装一份 seed。`MainNavbar.tsx` 的 `allMenuItems` 是硬编码 8 项，`menuItems`
  只过滤这 8 项 —— 插件项永远轮不到 Stash 自己渲染，必须自己塞。（第五轮）
- **徽章与挂载方式无关**：`DiscoverNavItem` 本来就是 React 组件，徽章是组件内 `useState` +
  订阅 `ssd:unread-changed`，改「谁决定显示」不用动徽章那 20 行。（第五轮）
- **插件 `exec: [python, …]` 不需要改成 `python3`**：`pkg/python/exec.go` 的 `Resolve()` 自己先
  `LookPath("python3")` 再找 `python`，还支持设置里的解释器路径。真正的前提是**容器里装了
  Python** —— 官方镜像只装 `ca-certificates vips-tools ffmpeg`。（第四轮）
- **`main` 里读参数的方式决定了任务页按钮注定没用**：前端走 `runPluginOperation` 把 `{mode,query}`
  交给进程；tasks 的 `defaultArgs` 只在手动点击时生效，而手动点击没有 query / magnet，
  `runPluginTask` 又只把 stdout 当日志、不解析 `{"error"}` → 任务页显示「完成、无错误、什么都没
  发生」。（第七轮）

## 数据与标识

- **endpoint 自带冒号，`split(":")` 必错**：忽略记录的键是 `endpoint:stashId`，endpoint 是
  `https://stashdb.org/graphql`。`split(":")` 会把 `https` 当 endpoint，补全请求永远找不到 box
  （第一版补全一条都没成）。一律 `lastIndexOf(":")` 从右切；显示「来源」同理，否则出现
  `来源 https · //stashdb.org/graphql`。（第六轮）
- **`batchAddPerformers` 的 endpoint 必须是完整 URL**：索引 `byStashId` 按
  `sid.endpoint.toLowerCase()` 精确匹配，传短名 `"javstash"` 一律 miss → 走 create 路径。
  实测同一位演员：完整 URL → `exist:1`；`"javstash"` → `ok:1`。不会产生重复演员（Stash 对同
  stash_id 会合并），但统计里「跳过」被算成「新建」，汇总符号就错了。发现页 `__ssdItem.endpoint`
  传的是完整 URL，这条路正常。（第四轮）
- **BRAND_MAP 只做显示名映射**（唯一引用处是 `BRAND_MAP[host] || …`），改键顺序不影响搜索顺序
  —— 论坛里「调顺序结果更准」是心理作用。（第五轮）
- **入口 seed 会真的改用户配置**：`configureInterface` 写 `menuItems`、`configurePlugin` 写
  `navSeeded`，两者都持久化。验证「首次安装」分支得先把 `stashDiscover` 从 menuItems 去掉、
  并删掉配置里的 `navSeeded`，别靠「重新装一次」。（第六轮）

## 浏览器与 JS

- **`\p{L}` 不能用**：`/[^\p{L}\p{N}]+/u` 在**解析期**就要求引擎支持 Unicode 属性转义，老浏览器
  直接抛 SyntaxError，**整个插件脚本连加载都过不去**（不是运行时报错）。归一化改用显式范围：
  `[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]`。（第五轮）
- **国旗 emoji 在 Windows 上根本走不通，别再「修」**：`String.fromCodePoint(0x1F1E6+…)` 拼出的
  区域指示符，Segoe UI Emoji 没有国旗字形 → 退化成「JP」两个字母；macOS/iOS 才有旗帜。要真旗面
  只能用图片（`https://flagcdn.com/w40/<cc>.png`，`onerror` 换成字母）。CSP 实测 `img-src data: *`，
  外链图片不受限。（第七轮）
- **抓 toast 别靠时序**：类名是 `.ssd-toast`（**不是** `.ssd-dp-toast`），挂在 `document.body`，
  6s 后 remove。进度条消失到 toast 出现只差一帧，轮询容易两头空 —— 用
  `MutationObserver(document.body, {childList:true})` 记 addedNodes 最稳。（第四轮）

- **节流的间隔要挂在「上次发起时间」上，不是「下次可发时间」**：写成
  `nextAt = max(now, nextAt) + gap` 时，第一次请求把 `nextAt` 置成 `now`，第二次读到的
  `wait = nextAt - now ≈ 0` —— gap 只被推到了将来、没被任何人等过。改成 `lastAt` 后
  `wait = max(0, lastAt + gap - now)` 才对：平时 `gap=0` → `wait` 恒 0（零开销），惩罚期才真排队。
  这个错五条功能用例全绿，只有耗时断言（同源间隔 1s）抓得到。（2026-10-31，429 退避）

## 测试方法

- **测 sticky 必须先把内容撑过一屏**：否则 `position: sticky` 一直是生效的，只是滚到底也碰不到
  顶（调试窗口 1080 高、`scrollHeight - clientHeight` 只有 83px）。用 `--vsize` 压到 1280×620
  这类矮视口即可复现（`scrollingElement.scrollTop=400 → bar.top=0`），或给 body 末尾塞一个高 div
  （但 filler 会造出「滚过父容器底边后 bar 跟着走」的假象）。（第二轮）
- **`.ssd-scene-card` 才是发现页场景卡**，`.ssd-card` 不存在（那是演员页 tab 的类）。搜索结果
  容器 `[data-ssd-search]`、输入框 `[data-ssd-search-input]`、搜索按钮 `.ssd-search-bar .ssd-btn-accent`。（第五轮）
- **筛「哪个 `.btn-group` 是视图切换」别用 `:scope > .btn-group`**：`sort-by-select` 自己也带
  `btn-group` 类且选态 `display:none`（rect 全 0），会先命中它，算出「偏左 392px」的假结论。
  按 `classList.contains("btn-group") && !contains("sort-by-select")` 取。（第四轮）
- **`stash_dev.py shot --js` 必须包成 `(async()=>{...})()`**，裸 `await` 直接 SyntaxError；
  `console` 子命令不支持 `--settle`，要等页面就绪用 `--seconds 9 --reload`。（第四轮）
- **`shot` 与 `eval` 都支持 `--vsize`**：`apply_vsize` 在 `open_stash_page` 之后调，走同一套 CDP
  覆盖。`shot` 早期只有 `eval` 有，移动端布局根本截不到。（第六轮，已补）
- **点完后立刻读 DOM 拿到的是中间态**：异步渲染 / 预载 / 回填都要轮询等元素出现再断言。

## 业务逻辑

- **低匹配折叠的兜底会反过来废掉折叠**：第一版写「primary < 3 就把 low 全并回来」，实测
  query = 一整条英文标题时只有 1 条全命中，于是 10 条全回流、折叠条消失。正确做法是**补足到
  `max(3, ceil(n*0.2))`**（从 low 里取分数最高的补，其余照旧折叠），另外先判 `anyHit`
  （全部 0 分说明词表对不上，例如中文 query 打英文标题）→ 原样返回。（第五轮）
- **窄屏多选栏是「挤爆」不是「折行」**：390 视口发现页筛选栏 329px，六个控件 316px + 视图切换
  69px（绝对定位在右侧）→ 直接压在「入库」上。≤560 的取舍：视图切换不参与多选，计数只留数字，
  整组一行居中。**别改成两行** —— 贴顶的条变高反而更像错位。（第六轮）
- **本地 Jackett 只接了 JAV 索引器**，英文长句返回 0 条，所以「低匹配折叠」的 UI 只能用假数据
  验证（把 `renderSearchResults` 导出后直接喂 `{query,count,results}`）；纯逻辑
  `rankSearchResults` 可以就地跑单测。（第五轮）
