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
