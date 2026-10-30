# stashDiscover — 版本与轮次历史

> 每一轮用户要什么、最后改成了什么、当时踩到什么。回答「这版为什么长这样」用这里。
> 可复用的技术结论已另行沉淀到 [PITFALLS.md](PITFALLS.md)。

## 第二轮 UI 修订（v2.5.6 批次8，用户 2026-10-29 六条）

**1. 汇总只留三个符号**：`SSD.importSummary(ok, skip, failed)` 输出
`<span class="ssd-sums">` + 三个 `.ssd-sum`（绿勾 47,158,68 / 灰感叹 122,130,136 / 红叉 224,49,49），
三项**固定全显**（含 0），宽度恒定 162px，绝不随结果变长。失败原因走 `toast` 的 `title`。
`dpToast` 新增 `opts.html / opts.title`；除汇总外一律 `textContent`。

**2. 发现页多选**：`.ssd-dp-toolbar.is-selecting { justify-content: center }` + selbar
`flex: 0 1 auto`（原来是 `1 1 auto`，撑满后整组被推在左边）。入口按钮 32×30 → 34×32（与
视图切换同尺寸）；selicon/selact 30 → 32。
**贴顶的真相**：`position: sticky` 一直是生效的，只是调试窗口 1080 高时页面内容不足
（body scrollHeight − clientHeight 只有 83px），滚到底也碰不到顶。压视口到 1280×620 后
`scrollingElement.scrollTop=400 → bar.top=0`，确认真粘住。
> **测 sticky 必须先把内容撑过一屏**：`--vsize` 压视口，或给 body 末尾塞一个高 div。
> 另注：**sticky 的粘住范围受父容器边界限制**，用 body 末尾的 filler 撑高时，滚过父容器
> 底边后 bar 会跟着走（实测 top 从 0 → −300），那是 filler 造成的假象，不是 bug。

**3. 演员页 tab 改成「改造筛选栏」**：删掉独立 `.ssd-tabsel` 行，改成
`toolbar.classList.add("is-selecting")` + `toolbar.insertBefore(buildTabSelbar(), displayGroup)`。
CSS 只做显隐：选态收掉 search / sort / page-size / refresh / zoom / 多选入口 / 分页，
留操作组 + 网格·列表切换，整行 `justify-content: center`。
- 原生 `.filtered-list-toolbar` 高度 48，选态 47（**不能变高**）；操作组按钮必须 33px
  （原生 `.btn` 实测高 33），多选态整行才不增高。
- **筛选栏 sticky 加在 `.ssd-tab-pane .filtered-list-toolbar` 上**（连非选态一起贴顶，
  和 Stash 场景页一致）。实测：原始 top 647 → 滚 300 后 347 → 滚 700 后 **0**。
- 背景必须不透明（`var(--sx-bg)`），否则卡片从下面透上来。
- 刷新按钮原来没有类名，抓不到 → 补 `.ssd-tab-refresh`。

**4. 设置页**去掉「弹窗里临时改的勾选不写回这里」那句（行为没变，只是不写在提示里）。

**5. 入库预览**：
- 整行可点切换勾选：`impRow` 里给 row 挂 click，`e.target.closest("input, select,
  textarea, button, a, label")` 时放过 —— 点进文本框是改字，不该顺手关掉这一项。
  locked 行不挂。实测：日期行点行 true→false（并加 `is-off`）、点字段名再切回 true、
  点行内 input 不切换。
- 底部按钮 `.ssd-imp-foot .ssd-btn { height:34px; padding:0 20px }`（`.ssd-btn` 本身不带
  尺寸类，之前只有文字大小，实测 34px 现在点得动）。

**6. 已忽略管理页**：
- 工具栏 `justify-content: center`（去掉 igntools 的 `margin-left:auto`），搜索框
  `flex: 0 1 280px`（与筛选栏同宽），四个控件统一 30px。**`.ssd-dp-tabs` 自带 4px padding +
  1px 边框**，选态 tabs 会高到 39px → `.ssd-dp-igntabs { height:30px; padding:0 3px }`
  + tab `height:24px`。
- 卡片定宽 170px（演员卡 208px）+ `justify-content: center` 换行。**别用 grid 的
  `auto-fill`**：它会生成空轨道，宽屏上卡片组贴左；而且 `minmax(150px,172px)` 实测在
  1252 容器里算出 5 列 242px（并非预期 7 列 172px），行为不可预期。
- 详情弹窗 `min(420px, 92vw)`。**必须写成 `.ssd-dp-modal.ssd-dp-igmodal`**：`.ssd-dp-modal`
  在文件里排得更后，同特异性会把宽度改回 760。
- 封面 `aspect-ratio: 16/9 + object-fit: cover`，与卡片同比例（实测 723×407 = 1.78）。
- 新增导入：`SSD.dpIgnore.importJSON(text)` 只补本地没有的键（不覆盖已有决策、脏字段
  只按快照结构重建）。实测 5+5 条导出 2795 字符 → 清空 → 导入 added 10 → 再导 skipped 10；
  坏 JSON 返回 `ok:false`；带 `evil` 字段的记录只留 `{at,title,code,date,studio,cover,p}`。
- 补每页选择（24/48/96，与发现页共用 `perPage` 偏好）+ 底部翻页（‹ 1 2 ›）。40 条造数实测
  每页 24 张卡、共 46 部、按钮 1/2。

**快照体积（回答「是不是可以不缓存图片」）**：快照里**只有图片 URL 字符串，没有图片数据**。
实测 5 场景 + 5 演员 ≈ 2795 字符（≈280 字符/条），其中 cover/image URL 占 80–120 字符。
3000 条场景 ≈ 840KB，接近 1,000,000 字符预算。管理页 `<img loading="lazy">` + 分页已经
做到「按页懒加载图片」。若真要再省，只能丢 URL —— 代价是老记录没有封面（源站可能已下架，
反查不回来），不值得。

**补一条 CSS 特异性坑（同轮实测踩到）**：已忽略管理页的演员 tab 容器带着
`.ssd-dp-grid.mini`，它自己的 `display: grid` 特异性 (0,2,0) 高过 `.ssd-dp-iggrid`
(0,1,0) —— 只写 `.ssd-dp-iggrid { display: flex }` 不生效，卡片按 grid 轨道（180px）
排、而 `width: 236px` 照样生效 → **相邻卡片重叠 56px**，前几张的「恢复」按钮被
下一张卡的头像盖住。肉眼只看最后一张有按钮，`elementFromPoint` 命中 `IMG` 才定位到。
修法：显式写 `.ssd-dp-iggrid.ssd-dp-grid.mini { display: flex; ... }`。
> 判断「元素看不见」不要只看 `getComputedStyle`（全是 visible/opacity 1），
> 用 `document.elementFromPoint(中心)` 看实际命中谁 —— 重叠/遮挡一眼就出来。

## 第四轮（UI 修订：贴顶 / 按钮风格 / 已忽略页 / 多选演员）

**1. 贴顶被遮的真因是量不到顶栏高度，不是 z-index**。Stash 顶栏 `nav.top-nav.navbar`
是 `position: fixed; top:0; z-index:1030; height:48.75px`。插件脚本常常比 React 渲染
顶栏早，`initPlugin` 里立刻量 `getBoundingClientRect().height` 得到 **0**，写进
`--ssd-stick-top: 0px` 后栏就贴在 0，被顶栏整块盖住（`elementFromPoint` 命中的是 nav）。
修法两条一起：① 量到 0 **不覆盖**已有值；② `[400,1200,3000]` 三次延时重测，并在
`mountPage()` 再调一次。判定标准：`bar.getBoundingClientRect().top === nav.bottom`。

**2. 默认态不贴顶、只有多选态贴顶**。删掉全局
`.ssd-tab-pane .filtered-list-toolbar { position: sticky; top: 0; background: #1c1c1c }`，
改成 `.ssd-tab-pane.is-selecting .filtered-list-toolbar { position: sticky; top: var(--ssd-stick-top); background: var(--ssd-page-bg) }`。
那个 `#1c1c1c` 是「未知黑色底」的来源 —— 页面真实底色是 `body` 的 `rgb(32,43,51)`，
用 `--ssd-page-bg` 由 `syncStickyEnv()` 量 body 的 computed background 写进去。

**3. 多选按钮要对齐原生尺寸，光写 width 不够**。`.btn` 实测高 33px、`padding 5.25px 10.5px`、
`border-radius 3.5px`；`.btn-secondary` bg `rgb(57,75,89)`、`.btn-primary` bg `rgb(19,124,189)`。
图标按钮只写 `width:36px` 会得到 26px 高（inline-flex + svg 撑不出高度）→ 必须
`width:36px; height:33px; padding:0`。计数只写数字（原生就是这样），说明塞 `title`。

**4. 选态操作组改绝对定位**。`.ssd-dp-tools` 留在 flex 里会把中间那组推左 39px
（barMid 632 vs groupMid 593）→ `position:absolute; right:10px; top:50%; transform:translateY(-50%)`，
实测 delta 0。演员页同理，柱子居中靠 `.filtered-list-toolbar { justify-content:center }`
+ 右侧 `.btn-group { position:absolute; right:0 }`。

**5. 工具栏控件错位 3px 的元凶是 bootstrap label 的 `margin-bottom: .5rem`**。
flex 行里 `align-items:center` 对齐的是 margin-box，label 比按钮高 7px，视觉上低 3px。
修法：`.ssd-dp-ignsearch { height:30px; margin:0; align-items:center }`，实测三行全 `y=161`。

**6. gap 改了不生效 = 特异性被 grid 规则压过**。`.ssd-dp-page .ssd-card-grid`(0,2,0) 的
`display:grid` 压掉 `.ssd-dp-iggrid`(0,1,0) 的 gap，实测还是 82px。要连 `display` 一起写
`.ssd-dp-page .ssd-dp-iggrid { display:flex; flex-wrap:wrap; gap:6px }`。
**`@media(max-width:480px)` 里还有一份 `.ssd-dp-page .ssd-card-grid`(0,3,0)**，390 视口下
会把卡片算成 82px 宽 → 那条规则加 `:not(.ssd-dp-iggrid)`。窄屏两列用
`flex:1 1 calc(50% - 3px)` 在 `.ssd-dp-iggrid > *` 上做。

**7. `batchAddPerformers` 的 endpoint 必须是完整 URL**。索引 `byStashId` 按
`sid.endpoint.toLowerCase()` 精确匹配，传短名 `"javstash"` 一律 miss → 走 create 路径。
实测同一位演员：`https://javstash.org/graphql` → `exist:1`；`"javstash"` → `ok:1`。
后者不产生重复演员（Stash 对同 stash_id 会合并回原记录），但统计里「跳过」被算成「新建」，
汇总符号就错了。发现页 `__ssdItem.endpoint` 传的是完整 URL，正常。

**8. 抓 toast 别靠时序**。类名是 `.ssd-toast`（**不是** `.ssd-dp-toast`），挂在 `document.body`，
6s 后 remove。进度条消失到 toast 出现之间只差一帧，轮询容易两头空 —— 用
`MutationObserver(document.body, {childList:true})` 记录 addedNodes 最稳。

**9. 退出多选不写计数栏**。`selCount` 的文本只有 `syncSelBar()` 写，`exitSel()` 只调
`syncChrome()`，于是入库时写的「演员 1/1…」会留在 DOM 里，下次进多选勾选任何东西之前
先显示上一次的进度（元素隐藏时看不见，但文本在）。`exitSel()` 末尾补 `syncSelBar()`。

**10. `stash_dev.py shot --js` 必须包成 `(async()=>{...})()`**，裸 `await` 直接 SyntaxError。
`console` 子命令不支持 `--settle`，要等页面就绪就用 `--seconds 9 --reload`。

**11. `.filtered-list-toolbar` 的底色是 Stash 自己给的**：原生规则里就有
`background-color: rgb(32,43,51)`（Dark 主题的编译值，不是 CSS 变量）。插件只要不覆盖，
主题怎么变都跟着走；写 `background: var(--x)` 反而会在切主题后停在旧色。

**12. 三格连体按钮用原生 `.btn-group` 就有**：`> .btn:not(:first-child){margin-left:-1px}`
把相邻边框叠成一条，首尾各留 `border-top-*-radius: 0` → 整组一个外框。实测相邻格
`left - prev.right = -1`。数量格是 `span.btn`，照样吃这套规则。

**13. 筛「哪个 .btn-group 是视图切换」不要用 `:scope > .btn-group`**：`sort-by-select`
本身也带 `btn-group` 类且选态被 `display:none`（rect 全 0），会先命中它，算出「偏左
392px」的假结论。按 `classList.contains("btn-group") && !contains("sort-by-select")` 取。

**14. Stash 的插件 `exec: [python, …]` 不需要改成 `python3`**：`pkg/python/exec.go`
的 `Resolve()` 自己先 `LookPath("python3")` 再找 `python`，还支持设置里的解释器路径。
真正的前提是**容器里装了 Python** —— 官方镜像只装 `ca-certificates vips-tools ffmpeg`。

## 第五轮（搜索结果排序/折叠、超时、导航机制调研，2026-10-30）

**1. `\p{L}` 不能用**。`/[^\p{L}\p{N}]+/u` 在解析期就要求 u 标志支持 Unicode 属性转义，
  老浏览器直接抛 SyntaxError，**整个插件脚本连加载都过不去**（不是运行时报错）。
  归一化改用显式范围：`[^a-z0-9\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]`。

**2. 折叠的兜底会反过来废掉折叠**。第一版写「primary < 3 就把 low 全并回来」，实测
  query = 一整条英文标题时只有 1 条全命中，于是 10 条全回流，折叠条消失。
  正确做法是**补足到 `max(3, ceil(n*0.2))`**，从 low 里取分数最高的补，剩下的照旧折叠；
  另外先判 `anyHit`（全部 0 分说明词表对不上，例如中文 query 打英文标题）→ 原样返回。

**3. 发现页场景卡的选择器是 `.ssd-scene-card`**，`.ssd-card` 不存在（那是演员页 tab 的类）。
  搜索结果容器是 `[data-ssd-search]`，输入框 `[data-ssd-search-input]`，搜索按钮
  `.ssd-search-bar .ssd-btn-accent`。

**4. 本机 Jackett 搜英文长句返回 0 条**（只接了 JAV 索引器），所以「低匹配折叠」的 UI
  只能用假数据验证：把 `renderSearchResults` 导出后直接喂 `{query,count,results}`。
  纯逻辑（`rankSearchResults`）则可直接在页面里跑单测。

**5. 插件 nav 入口想「像 binge 一样是原生开关」，靠三件事拼出来**（Stash 没有原生插件菜单项）：
  ① `patch.before("CheckboxGroup")` 往 `menu-items` 组里塞 `{id}`，设置页就出现和内置项
  一样的复选框；② 在 `MainNavBar.MenuItems` 的 patch 里自己读
  `configuration.interface.menuItems` 决定渲不渲染；③ 首次装一份 seed，否则入口默认不显示。
  `MainNavbar.tsx` 的 `allMenuItems` 是硬编码 8 项，`menuItems` 只过滤这 8 项 —— 插件项
  永远轮不到 Stash 自己渲染，所以必须自己塞。

**6. 徽章与挂载方式无关**。`DiscoverNavItem` 本来就是 React 组件，徽章是组件内
  `useState` + 订阅 `ssd:unread-changed`，改「谁决定显示」不需要动徽章那 20 行。

**7. BRAND_MAP 只做显示名映射**（`stashDiscover.js` 唯一引用处是 `BRAND_MAP[host] || …`），
  改它的键顺序不会影响搜索顺序 —— 论坛里「调顺序结果更准」是心理作用。

## 第六轮（复选框图标 / 移动端贴顶 / 窄屏多选栏 / 已忽略页 / 导航原生开关，2026-10-30）

**1. 移动端 Stash 顶栏是 `fixed-top` 但贴在屏幕底部**。390×844 实测
  `nav.top-nav` rect = `top 759 / height 85`（底部导航条），桌面端是 `top 0 / 49`。
  所以「fixed 就把高度加进 `--ssd-stick-top`」是错的：移动端会凭空空出 85px。
  判据要加位置：`rect.top <= 8 && position !== "static"` 才算「在顶部挡着」，
  否则写 0。写 0 时不要再用「量到 0 就别覆盖」那道保护 —— 那道保护是防「SPA 还没
  布局」，区分办法是 `rect.height === 0` 时直接 return（不写），有高度就照写。

**2. 忽略记录的键是 `endpoint:stashId`，而 endpoint 自带冒号**（`https://stashdb.org/graphql`）。
  `split(":")` 会把 `https` 当 endpoint，补全请求永远找不到 box（第一版补全一条都没成）。
  解析一律 `lastIndexOf(":")` 从右切；显示「来源」时同理（否则会出现
  `来源 https · //stashdb.org/graphql`）。

**3. 「已忽略」卡片缺国籍/年龄，不是渲染问题，是快照没字段**。三个忽略入口里有两个
  拿的是 `scene.performers`（只有 id/name/图），快照自然空。补法：管理页打开时按需
  `findPerformer(id)` 补一次（`ssd:ign-enriched` 事件触发重绘），单条失败不影响其它条，
  一次最多 12 条，补过的键记内存防重复。顺带给卡片加三级回落
  （国旗/年龄 → 别名 → 数据源品牌），保证没有空卡。实测：`{name,image}` → `country JP /
  birthdate 1999-04-05 / gender FEMALE`，卡片副标题 `🇯🇵 27 岁`。

**4. `&times;` 文字图标撑不出 15px**。图标按钮换成 svg 之后，× 的 path 要铺满差不多
  和复选框外框一样的范围（`M4.5 4.5l15 15` 而不是 `M6 6l12 12`），否则一个 11px 的方框
  旁边挂一个 7.5px 的叉，看着就是「小一圈」。

**5. 窄屏多选栏是「挤爆」而不是「折行」**。390 视口发现页筛选栏 329px，六个控件
  316px + 视图切换 69px（绝对定位在右侧）→ 直接压在「入库」上。窄屏（≤560）的取舍：
  视图切换不参与多选，计数的「已选 N / 本页 M 项」只留数字，整组一行居中。
  不要改成两行 —— 贴顶的条变高反而更像错位。

**6. `stash_dev.py shot` 原来不支持 `--vsize`**（只有 `eval` 有），移动端布局根本截不到。
  已补：`apply_vsize` 在 `open_stash_page` 之后调用，和 eval 同一套 CDP 覆盖。

**7. 入口 seed 会真的改用户配置，别用「重新装一次」来测**。`configureInterface` 写
  `menuItems`、`configurePlugin` 写 `navSeeded`，两者都是持久化的；验证「首次安装」
  分支得先手动把 `stashDiscover` 从 menuItems 去掉、并删掉配置里的 `navSeeded`。
  正常升级路径（已存在但没 seed 过）会自己补上，实测 8 个配置键 + navSeeded = 9，没有被
  `configurePlugin` 整体替换掉。

## 第七轮（设置页实心按钮 / 勾选框图标 / 已忽略演员卡，2026-10-30）

**1. 国旗 emoji 这条路在 Windows 上根本走不通，别再「修」。** `String.fromCodePoint(0x1F1E6+…)`
拼出来的区域指示符，Segoe UI Emoji 没有国旗字形 → 浏览器退化成「JP」两个字母。
macOS/iOS 才是旗帜。要真旗面只能用图片：插件里演员卡角标早就走
`https://flagcdn.com/w40/<cc>.png`，已忽略页沿用同一源；`img.onerror` 把节点换成字母，
离线时不空白。CSP 实测 `img-src data: *`，外链图片不受限。

**2. 混排图片后不能再 `facts.join(" · ")`。** 一行的国旗是 `<img>`、性别是带色 span、
年龄是文本，只能按节点 append；分隔靠 flex `gap`，别留「·」。

**3. 窄屏「恢复」按钮要换行但不要铺满。** `flex: 1 1 100%` 会让按钮占满整行、像多出
一条信息栏；只改 `flex-basis` 又不够——`flex-shrink:0` 的按钮会继续和名字挤同一行。
可靠的写法是塞一个 `flex: 0 0 100%; height: 0` 的占位 div 强制断行，按钮保持内容宽度。
实测 390 视口：卡宽 161、按钮 43、左间距 11（= 卡内边距 + 边框），靠左对齐。

**4. `.ssd-dp-btn.solid` 和 `.ssd-dp-btn.ssd-dp-setbtn` 同为 (0,2,0)**，靠源码顺序决出：
setbtn 在文件更后（3269），`height:30px` 生效，solid 只负责底色。别把 setbtn 往前挪。

**5. 多选入口图标与全选图标是两件事。** 入口固定「框+勾」（能力标识），全选才是
空框 ↔ 框+勾（状态开关）。共用一个常量就会让「未全选」也显示成已勾选。

## 发现页缓存字段压缩（2026-10-31，v2.6.2）

按 4000 条 × 3 图的基准重算了 payload，结论与三个改动：

- **tags 是第二大字段，且四成是 JSON 壳**：stashdb 24 个 tag/条 → `[{name}]` 528 字符，
  名字本身只有 239，剩下 289 是每元素 12 字符的 `{"name":"…"},`。改「全源去重词典
  （`tagDict`）+ 场景存下标」后同一条 97 字符。实测同一条 trending 缓存（30 条场景）
  60779 → 44808 字符，**省 26.3%**。
  - 不升 `fmt`：老条目 `tags[0]` 是对象、新条目是数字，`hydrateCacheEntry` 靠
    「有没有 `tagDict`」判别，两代 payload 共存，老条目 12h 内自然被覆盖。
  - `tagDict` 不做裁剪收窄（被裁场景的 tag 仍留在词典里）：词典才几十 KB，remap 每条
    下标需要给 `store` 存快照（`build()` 会被预算循环调多次），不值。
- **图片 8 → 3**：实测三源每场景分别是 stashdb 1 / javstash 1 / TPDB 3 张，第 4 张起
  没有任何读取点（弹窗 detail 一到就整份换掉），8 是个永远碰不到的死上限。
- **`totalSeen` + 「缓存不完整」chip**：`cacheWrite` 把裁剪前条数写进 payload，读的时候
  比 `scenes.length` 就知道被裁了多少；UI 在 `.ssd-dp-pcount` 旁挂 chip（title 写
  「只存下最新 N 部（共拉到 M 部）」），点了走 `doRefresh()`。老条目没这字段 → 当完整。
  - 文字用 `--sx-tx2` 而不是 `--ssd-warning`：后者当文字色在浅色主题下对比度不够。

回归：`probe_cache_tags_index.js`（写→读往返、逐位比对下标→名字、老格式兼容、复原）、
`probe_cache_trim_setup.js` + `probe_cache_trim_chip.js`（裁到 10 条 → 热门视图出现 chip
→ 点它 → 重拉后「共 30 部」且 `totalSeen == scenes.length`）。

顺带：**yml 的 `tasks:` 段已删**。那两个按钮是历史遗留 —— 前端走 `runPluginOperation`，
不查 tasks 表；手动点必然因为没有 `query`/`magnet` 而失败，而 `runPluginTask` 只把 stdout
当日志、不解析 `{"error"}`，于是任务页显示「完成、无错误、什么都没发生」。
删除后实测 `runPluginOperation` 搜索仍返回 38 条。
