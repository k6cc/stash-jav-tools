# stashDiscover — 功能实现口径

> 每个可点功能的实现约束与验收基线。改对应模块前只看这一节，不用翻整个目录。
> 跑验证见 [SCRIPTS.md](SCRIPTS.md)；数据层语义见 [SEMANTICS.md](SEMANTICS.md)。

## 已忽略管理页（`?view=ignored`，2026-10-29 实测）

- **入口**：设置页首行卡片「已忽略：N 部场景 · M 位演员」→「已忽略管理」；关注页灰条「已忽略 N 位关注中的演员 · 管理」也进这里。不进 `VIEWS`（无导航 tab），`EXTRA_VIEWS` 放行 `?view=ignored`。
- **全局筛选栏在该页隐藏**：它过滤的是发现页的 `_dp.q`，对本地快照无效，留着只会让人白搜。
- **实测数据（探针 `probe_ignored_page.js`）**：40 部场景 / 5 位演员 → 顶部「共 40 部」「场景 · 40」「演员 · 5」；搜索 `aika honda` 命中快照里写成 `Aika-Honda` 的那条（NFKC + 剔分隔符生效）；切 tab 保留搜索词、重置页码；单条恢复 5→4；还原全部弹窗「将恢复 4 位演员，此操作不可撤销」→ 0 且切到空态。
- **渲染耗时（T4）**：3,000 条时切 tab 重建 24 张卡 ≈ **3–4ms**（纯 JS，不含布局）；输入搜索一次到重绘 ≈ **130–150ms**（150ms debounce 之后的工作，含 3000 条归一化），未做虚拟滚动 —— 与文档「单页 24/48 卡 <100ms」的口径一致。
- **淘汰提示**：store 里 `trimmed>0` 时列表顶部一条「已自动淘汰 N 条最旧记录（超过 3000 条 / 1,000,000 字符上限）」。
- **导出**：`SSD.dpIgnore.exportJSON()` → Blob 下载 `stashDiscover-ignored-<date>.json`（含 version / exportedAt / trimmed / 两组快照）。

## 忽略演员三处链路（2026-10-29 实测）

- **查询摘除（§6.1）**：`refreshDiscover` 组 `ids` 后按 ignore.performers 过滤。探针 `probe_ignore_performer.js` 用打桩 fetch 抓查询变量：忽略 p1 后查询里已无 p1、仍有 p2。
- **缓存穿通双保险（§6.2）**：场景的「库内演员全部被忽略」才隐藏，其他演员兜底。合成 A(仅p1)/B(p1+p2)/C(仅p2)：忽略 p1 → 只剩 B、C；再忽略 p2 → 全空。
- **连带（§6.3）**：关注页分组 3→2 + 顶部灰条「已忽略 1 位关注中的演员」；演员页发现 tab 整页占位「这位演员已在发现页被忽略」+「恢复显示」（点完记录归零、占位消失）。

## 无数据兜底面板（v2.0.0）

- **面板判定**：`viewState` 由 `_state.boxStatus` 决定——全部源失败→`net-fail`，无 box→`no-box`，演员无对应编号→`no-ids`，无剩余卡片且被时间窗口滤过→`empty`（含 dropped 计数）。筛选条**只在 content/no-match 态渲染**；其余状态只有面板，面板自带「重试」。
- **演员无编号用例**：id **56 = 爱泽花梨**（`stash_ids` 为空，1 场景）；实测「在源上查找 TA」内联搜索返回 13 个同名候选，点「关联」写入 javstash 编号后自动重查 → 落 `empty`（8 条被 180/7 窗口滤掉）→「不限时间（本次）」放开后 8 张卡片 + 「恢复默认 (180/7)」。**测完必须还原 `stash_ids` 为 `[]`**（`performerUpdate input:{id,stash_ids:[]}`）。
- **原生编辑面板是整页内联，不是弹层**：点 `.detail-header button.edit` 后 `detail-header` 多出 `edit` class（`div.detail-header.edit.full-width`），此时**插件 tab 与 pane 整个被卸载**，`renderTabContent()` 静默 no-op；取消/保存后 React 重建 tab 栏，MutationObserver 重新注入并渲染。因此「等待编号写入」轮询以 `detail-header.edit` 是否消失作为收尾信号，不能靠 pane 判断。按钮 class `edit` 不受语言影响，勿用文案定位。
- **源失败/超时实测**：`navigate_page` 的 `initScript` 里打桩 `window.fetch`（javstash 立即 reject = 网络类；stashdb 返回 `{ok:false,status:401}` = 鉴权类；slow 版本延迟 settle 才能看到「正在查询…」行）——不需要断网或改设置。桩必须监听 `o.signal` 并抛 `AbortError`，否则超时用例会永远挂住。
- **`preferredBox` 会影响查询范围**：设为某源时，若演员在该源无编号，`queryBoxes` 过滤为空 → 回退查询其他有编号的源，并在 content/no-match 顶部显示 muted chip「<源> 无编号 · 已改查其他源」（empty 态改在面板描述里补一句）；要测多源进度行/部分失败提示条需**临时** `configurePlugin` 把 `preferredBox` 清空，测完还原。`_state.allBoxes` 始终是全部 box，「在源上查找 TA」不受 `preferredBox` 限制。
- 首屏 loading 帧早于 `queryBoxes` 就绪，必须在其解析后补一次 `renderTabContent()`，否则扫描态看不到按源进度行。

## 「在源上查找 TA」内联查找（v2.0.0）

- **入口规则**（`findEntryVisible(vs)`）：`no-ids` 恒显示（主按钮）；`empty` = 多源或回退时显示；`no-match` / `content` 仅回退（`preferredFallback`）时显示。**「单源/多源」以 `_state.allBoxes.length`（已配置源数）为准，`preferredBox` 的限制不算**。`no-match` 态**不跟** `empty` 的多源规则，只在回退时加。
- **块渲染位置**：`content` 态在回退行同一行右侧、卡片之前（顶层 pane）；`no-ids`/`empty`/`no-match` 在**面板内部**展开。
  - 已修 bug（**真实根因**）：`content` 分支在 `filtered.length === 0`（搜索把缓存过滤空 → no-match 面板）判定**之前**就已 append 了 meta 行 + 查找块，随后又 append 了 no-match 面板（面板内部也建查找块），导致**重复渲染**（`.ssd-find` 数量=2、`.ssd-find-item` 翻倍）。修复为把 `filtered.length === 0` 判定提前到 meta 行之前，直接 append no-match 面板并 `return`。此前「`if (_state.findOpen && panelState === \"content\")`」的猜测是无效死代码，已移除。
  - 验收口径：`.ssd-find` 数量恒为 1；`.ssd-find-item` 数量 == 唯一结果数。
- **收起行**：主名行 = 名称（13px 粗体）+ ` · 国旗` + ` · 性别` + ` · 年龄 N 岁`；**名称之后的元信息统一小号 11px（与别名行同号）并与主名共享基线**（`.ssd-find-name-main` 600/13px、`.ssd-find-meta` 11px 且**不设** `vertical-align`、国旗沿基础规则的 `vertical-align: -1px`）。**踩坑**：曾给 meta 与国旗加 `vertical-align: middle` 追求「居中」，结果 11px 文本与国旗都浮在基线之上、肉眼明显不齐（用户反馈「没有对齐」），已回退为基线对齐。年龄取自 `searchPerformer` 的 `birth_date` 经 `birthDateToAge` 计算，无生日则该项不显示；国旗/性别/年龄均无时整段不渲染。副行 = 别名（最多 3 + `+N`，N=隐藏数，`+N` 用边框徽章）+ 源徽章 + 三角箭头；整行可点 → 向下内联展开；**手风琴**（单一 `findExpandedKey`，同时只开一条）；大图懒加载。
  - 右侧徽章三态（`localStashIdForBox`）：候选 id == 本地在该源的 stash_id → 绿 `ssd-chip--ok`（不透明）「已关联 <源名>」；同源有 id 但不等 → 灰 `ssd-chip--dim`（**0.38 透明度**，冲突态刻意淡于普通源名）「已有 <源名>」；该源无本地 id → 灰 `ssd-chip--muted`（0.75）「<源名>」。三档透明度 1 / 0.75 / 0.38 拉开层次，扫一眼即可区分「已关联 / 无编号 / 编号冲突」。
- **展开**：左=演员大图（**图外侧**左右箭头 + 计数，默认第一张，**最后查看=所选**）；右=有值才显示的字段（性别/国籍(旗帜+名)/生日/身高/三围/生涯/全部别名/消歧/外部链接(仅 host，3 + `+N`)/源参演数）；底部三色动作**统一中号档**（`ssd-btn-md`，26px 高）：`源名` **secondary 灰**（新标签开 `boxWebBase + /performers/ + id`）、`关联` primary、`覆盖` accent。
- **边框徽章 `.ssd-find-badge`**：`+N`（别名隐藏数 / 外部链接隐藏数）与「源参演数」数字均用它（1px 灰边 + 3px 圆角 + 11px 字），与 `.ssd-chip` 区分（chip=胶囊态标签，badge=计数框）。
- **外链图标**：源跳转按钮不再拼接文本 `↗`，改用内联 SVG `FIND_EXT_SVG`（`appendExtIcon()` 追加 `.ssd-btn-icon`，11×11、`stroke: currentColor`）——经典「方框 + 右上出箭头」外链记号，换上标符号只是字形替换，按钮文案/配色/尺寸逻辑不变。
- **meta 行合并 + 窄屏换行**：`content`/`no-match` 态四个元素固定在同一个 `.ssd-window-row`，顺序为 [时间窗口：不限 · 本次] → [恢复默认 (N/M)] → [<源> 无编号 · 已改查其他源] → [在源上查找 TA]。它们被包成**两个 `.ssd-window-group`**（前两个一组、后两个一组），配合 `flex-wrap: wrap`，极窄屏时**只会在两组之间换行**——即「时间窗口 + 恢复默认」一行、「回退 chip + 入口按钮」一行；宽屏仍是一行（实测 516px pane 换行、1396px pane 不换行）。
- **查找块限宽 + 居中**：`.ssd-find { max-width: 685px; width: 100%; margin-left/right: auto }`。`width: 100%` 是必需的——面板是 flex column 容器，只给 `margin: auto` 会让块在交叉轴上退化成 shrink-to-fit（实测 401px，右侧出现大片留空）。**宽度与面板内容宽（685px）对齐**：`content` 态居中（1396px pane 左右各 ≈356px），`empty`/`no-ids`/`no-match` 面板内正好铺满，两条规则合并成一条，原先的 `.ssd-panel .ssd-find { max-width: none }` 例外已删除（面板内容宽 684px < 685px 上限，行为不变）。
- **入口按钮配色**：`no-match`、`no-ids` 与 **`empty`** 面板的入口按钮统一 info（蓝）；`content` 态合并行内的入口按钮仍为 secondary。
- **`empty` 态源跳转按钮**：「在 <源> 查看」→「<源> + 外链图标」（`appendExtIcon(makePanelBtn(sourceLabel(b), ...))`，仅换文案与图标，颜色/尺寸逻辑不变）。
- **场景详情弹窗源跳转按钮**：同样改为「<源名> + 外链图标」（`buildModal` 的 `[data-ssd-open-btn]` 与 `updateOpenButtonLabel`）。**踩坑**：`updateOpenButtonLabel` 每次都用 `btn.textContent = brand` 赋新文案，`textContent` 赋值会清空子节点，所以**必须在赋值后重新 `appendExtIcon()`**，否则图标被静默抹掉（或反复追加出多个）。实测 `[data-ssd-open-btn]`：文案=源品牌名、`.ssd-btn-icon svg` 数量恒为 1、11×11、`margin-left: 5px`、右缘与按钮内边距对齐（与同排其他大号按钮一致）；非 JAVStash 场景显示对应源名（如 `StashDB`）。
- **放开时间窗口后保留候选**：`loadMissingScenes()` 原先会把 `findState/findResults/findFailures/findMessage/findExpandedKey/findBusyKey/findRowMsg` 一并重置，导致点「不限时间（本次）」（或「恢复默认」）后已搜出的候选与展开态被清空（输入框与演员名行因不在重置范围内而保留）。现已**删除该重置**——重载只重建场景数据，查找块的结果/展开/行内提示全部保留（实测：搜出 23 条 → 点「不限时间」→ loading 帧过后 23 条仍在、`findState="done"`、`findTerm` 保留）。**切换演员**仍由 `resetPerformerState()` 清空，不受影响；`findRowMsg` 不再清空也意味着上一轮的动作反馈会随结果一起留在页面上。
- **切换演员重置**：`resetPerformerState()` 清 `findTerm` 与 `performerName`，修掉「换演员后查找框仍预填上一个演员名」的 bug。
- **重测基线**：`preferredBox=javstash.org`、`recentDays=180`、`previewDays="7"`；演员 43=AIKA（javstash+stashdb 双源）作收起行徽章三态用例；actor 56=爱泽花梨（无编号）+ 临时 `preferredBox=theporndb`/`previewDays=-1`/`recentDays=1` 作 empty+preferredFallback 四元素同行用例，测完均已还原。
- **关联（追加语义 + 同源编号替换）**：写 `stash_ids`（**只写候选所属源，该源已有编号时替换掉旧编号，其他源的原编号一律保留**，由 `mergeStashIds` 按 endpoint 归一比较实现）；`alias_list` = 源主名+源别名并入本地去重；其余字段只补空；`urls` 追加去重；**图片仅在本地无自定义图时补**（`hasCustomImage` = `image_path` 不含 `default=true`）；**永不改 name**。按钮 title 与成功提示按此语义一句话措辞（关联「替换该源编号，其余字段与别名补齐（不改名）」；覆盖「以源为准覆盖本地，本地独有不删除」）。
- **覆盖（以源为准）**：`stash_ids` 同上；`alias_list` = 源「主名+别名」**整体替换**；`urls` 覆盖式替换；图片=所选图覆盖（**源无图则不动本地图**）；其余字段覆盖式写入；源没有而本地有的字段**保留不删**；需**红色二次点击确认**；动作后**保持该条展开**，900ms 后自动重查。
- **career_length 覆盖残留（已知·保留）**：本地 `1990 - 1991`、源只有 `start=2007` → 拼出 `"2007"` → Stash 只更新 start、保留本地 end → 结果 `"2007 - 1991"`。与 JavStashLinker `buildPerfDetails` 的「源没有的字段不删」语义一致，不修。
- **图片写入**：图片可直接传 URL，由 Stash 服务端下载（JavStashLinker `applyPerformerImageAsync` 先例 L773-796）。
- **实测坑**：`image_path` 的 `?t=` 是 performer `updated_at` 派生，**任何 `performerUpdate` 都会变**，不能用 t 判断图片是否被替换；要判断图片内容需比对 `/performer/<id>/image` 的 **字节哈希（sha256）**。用此法已验证「关联时本地已有自定义图 → 不动图」（`imageChanged:false`）。
- 未测分支（代码已核对，逻辑正确）：覆盖时源无图 → `selectedImageUrl()` 为空 → 不写 `image`。（可选补测）

## 入库弹窗 + 演员建档四步（v2.6.0 批次6）

**流程**：`handleSaveScene` / 演员弹层「加入库」都不再直接提交，而是「本地索引算草稿（零写入）→ 弹窗预览 → 确认才写」。场景与演员共用一套 `.ssd-imp-*` 弹窗（深色面板，`z-index:100500` 压在 `.ssd-modal-overlay` 99999 之上）。

- **草稿零请求成本**：演员走 `findPerformers(per_page:-1)`（三索引 byStashId/byName/byAlias，60s 缓存）、标签走 `findTags(per_page:-1)`（`_tagIndex` 常驻）、工作室走 `findStudios(per_page:-1)`（`_studioIndex` 常驻）。**首次打开弹窗 = 3 个查询，之后都是内存**。别再写「逐个 q= 查」——同名/别名命中未知就没法在提交前算出「已匹配 / 将新建」。
- **`GenderEnum` 只收枚举名**：写库必须传 `FEMALE`，传显示串 `Female` 直接被拒（`Female is not a valid GenderEnum`，整个 mutation 返回 null）。**踩过**：`enumToDisplay(p.gender)` 用在 create 上导致「创建返回空结果」（真实原因被二次重试吞掉）。`ethnicity / hair_color / eye_color` 是 String 字段，仍用显示串 `Asian / Black / Brown`。`buildPerfDetailInput` 本来就用原值，别顺手「统一」成 enumToDisplay。
- **数值守卫**：`height` 可能是 `"168cm"`，写 `height_cm` 前必须 `Number.parseFloat` + `Number.isFinite`，否则整条 create/update 被拒。
- **创建失败别只报「返回空结果」**：头像走「直链交给 Stash 拉 → 浏览器转 data URL 再试 → 无图建档」三级降级，但**只有报错信息像图片问题**才降级；其他错误直接抛出，否则真实原因（如上面那条枚举错误）被盖掉，排查成本翻倍。
- **四步判定实测**（§4.5）：`id` → 直接复用（不改名、不覆盖任何字段）；`name`/`alias` → `performerUpdate` **只补 stash_ids**（`mergeStashIds` 合并，实测 performer 163 原有 stashdb id 保留 + 新增 javstash id，height/alias_list 未动）；`ambiguous`（同名候选 >1）→ 新建并在弹窗里单列提示；`new` → 建档案写全部勾选字段。
- **弹窗按「源里非空」动态渲染**：stashdb 一位演员出 12 行（性别/生日/国籍/族裔/发色/瞳色/身高/三围/从业期/别名/链接/头像）；TPDB 常见只有 1 行名字 + 一句「源上除名字外没有可写字段」。写死字段清单会让 TPDB 出现九行空行。
- **性别显示与写入分离**：`vals.gender` 存原枚举名，行里显示 `女 / Female`（`genderText`）。
- **场景弹窗字段**：必要字段（番号 / 源编号）置顶灰显不可取消；title/date/details/director 就地可改（改了自动勾上）；urls 拆「网页链接 / 源站链接」两行；演员只显示「关联 M 位已有 · 新建 N 位」不做开关（Q19）；标签/工作室三态 select，选「不写」时勾选框同步取消。
- **入库成功即删忽略记录**：`submitSceneImport` 末尾判 `dpIgnore.isSceneIgnored` → 删该条并广播 `ssd:ignore-changed`（§3 最后一条）。
- **实测一轮完整入库**：JUVR-304（StashDB，演员全部已关联）→ 场景 262 建成，studio `MadonnaVR` 新建、标签 7 个（4 匹配 + 3 新建）。**丢 1 个标签**：`MILF (30+)` 在本地是别人的别名，`tagCreate` 被拒且 `findTags(q="MILF (30+)")` 回查也没捞到 → 这是 `findOrCreateTag` 既有的缺口，不是弹窗引入。测完已 `sceneDestroy 262` / `performerDestroy 163` / `studioDestroy 102`。
- **设置页字段开关**：全局键 `SSD:dp:import.v1`（不能带 host 前缀，`cacheInvalidate` 一刷新就没）；结构 `{scene:{8 个布尔 + tags/studio 三态}, performer:{15 个布尔}}`；弹窗只写默认值，弹窗内临时改的勾选**不写回**（Q15）。设置卡片计数用 `.ssd-dp-set-impcount` 就地更新，不整页重绘（重绘会丢滚动位置）。
- **探针**：`probe_import_dialog.js`（三个分支 + 字段开关持久化 + 弹窗 DOM 结构，不写库）。

## 批量选择 + 批量入库（v2.6.0 批次7 / §8 §9 §13.3）

**形态**：`.ssd-dp-toolbar` 原地加 `.is-selecting`，搜索框与「更多」收掉，`.ssd-dp-tools` 里除 `.ssd-dp-viewtoggle` 全部隐藏，`.ssd-dp-selbar`（× | 已选 N · 本页 M 部 | 全选 | 忽略 | 入库）顶上来。**没有第二层浮层**，滚动时才 sticky（`position: sticky; top: 0`）。

- **点击拦截必须在捕获阶段**：卡片自己的「打开弹窗」监听在冒泡阶段，`content.addEventListener("click", fn, true)` 里 `stopPropagation` 才能拦住。`preventDefault` 一并掐掉卡片内 `<a>` 的原生跳转。
- **条目靠 `host.__ssdItem` 反查**：网格卡片和表格 `<tr>` 各挂一份。`buildSceneTable` 的 tbody 行序与 items 一一对应，`rows[i].__ssdItem = items[i]` 即可，不必改表格构造函数。
- **「本页」口径直接读 DOM**：`pageSelItems()` 遍历 `.scene-card, .ssd-scene-table tbody tr`，天然与用户眼前所见一致（总览多模块、关注分组展开都对），不用另存一份列表跟各视图同步。
- **视图切换要保留选择集**：`renderContent` 末尾统一 `applySelMarks()` 重打勾选圈。切网格/列表是同一批数据，清空选择只会让人烦。
- **切换视图/切 tab 前必须退出多选**：换数据集时选择集无意义（`switchView` 里判 `busy` 先拦，忙时不许切）；子 tab 与翻页那行（`.ssd-dp-headrow`）在多选态整行隐藏。
- **`SSD.isZh()` 不是全局函数**：discover.js 里裸写 `isZh()` 会抛 ReferenceError，症状是「点卡片没反应、计数全空」——因为 `selToggle` 抛错后 `applySelMarks` 没跑。本文件里 i18n 一律走 `SSD.isZh()` / `tc()`。
- **批量忽略**：逐条 `dpIgnore.ignoreScene(item)`，全部算完再派发一次 `ssd:ignore-changed`；toast 的撤销是逐 key `remove`，不整表还原（用户可能在此期间又忽略了别的）。
- **批量入库**（`batchImportSelected`）：串行 + 150ms 间隔；每条 `SSD.planSceneImport` → `SSD.pickFromPrefs`（**吃设置默认值**，不弹窗）→ `SSD.submitSceneImport`。进度就地写在 selbar 的 `.ssd-dp-selprog`。
- **重复 code 跳过**：开跑前一次 `findScenes(filter:{per_page:-1}){scenes{code}}` 建集合。**别逐条 `q=` 查**：大库里 q= 是模糊匹配，`ABC-123` 会撞上 `ABC-1234`，而且 N 次往返。
- **失败项留在选择集里**：结束后只清成功项，`SEL.items = failed`，工具栏仍在多选态，原地重试。
- **`ssd:scene-saved` 必须 bubbles**：`document.dispatchEvent(new CustomEvent(name, {detail}))` 默认 `bubbles: false`，而 discover.js 的两处监听挂在 **window** 上 → 事件根本传不过去。症状：入库成功、toast 正确、卡片不消失。**踩过**，两处派发都补了 `bubbles: true`。
- **`:local.v1` 给了 10 分钟 TTL**：这份 ownedKeys/linked 快照原先「无 TTL」，只清内存 memo（`invalidateLocalMemos`）不够 —— 下次 ensureData 又把旧快照读回来。现在 `_localDirty` 标记 + TTL 双保险：入库当下立刻重算，隔一次会话也不会拿 stale 数据当准。
- **实测**：5 卡 → 选 2 → 入库 → t≈6s 时列表降到 3 卡（已入库的消失）、toast「成功 2」；重复入库同一批 → 「成功 0 · 跳过 2」；批量忽略 2 部 → 5→3 卡 → 撤销回 0 条、5 卡。
- **探针**：`probe_batch_select.js`（进入/点选/全选/批量忽略+撤销/列表模式/退出，忽略记录测完还原）。

## 演员页「发现」tab 的多选（v2.6.0 批次7 / P6）

**这一页是 Stash 原生网格**（`.ssd-tab-pane` + `.filtered-list-toolbar`），不是发现页那套 `.ssd-dp-*`，所以多选是**独立一套状态与 DOM**（`_tabSel`），只复用底层：`dpIgnore` 存储 + `planSceneImport`/`pickFromPrefs`/`submitSceneImport`。

- **打开演员页不能用 `--path /performers/34`**：SPA 会把直接导航重定向回 `/`。先 `--path /`，再在页面里 `history.pushState` + `dispatchEvent(new PopStateEvent('popstate'))`，URL 才会落到 `/performers/34/scenes`。测试脚本都按这个来。
- **tab 入口类名是 `.ssd-nav-link`**，不是发现页的 `.ssd-dp-tab`。
- **卡片点击是 `card.onclick = openModal(item)`**（赋值而非 addEventListener），在网格容器上做捕获阶段 `stopPropagation` 就能拦住；`preventDefault` 顺带掐掉卡片内 popover 按钮的默认行为。
- **`cachedMissing` 要手动摘**：这一页不走 `filterPipeline`，批量忽略/入库后必须自己 `splice`，否则 `renderTabContent` 重绘又从原数组捞回来。
- **换人 / 重扫要清选择集**：`loadMissingScenes()` 开头重置 `_tabSel`，否则「已选 N」会留成一个清不掉的幽灵数。
- **样式作用域踩了两个坑**：
  1. 勾选圈类名写成 `.ssd-selbox`（少了 `dp-`）→ 没有任何 CSS 命中，SVG 撑成整屏大白勾。**统一用 `.ssd-dp-selbox`**。
  2. `--sx-acc` 是发现页 `.ssd-dp-page` 自己那套变量，演员页取不到 → `outline: 2px solid var(--sx-acc)` 整条简写失效，选中卡片完全看不出边框。现在变量定义在 `.ssd-tab-pane` 上，描边用 `box-shadow`（这一页的 `.scene-card` 上有原生 `outline:none` 类规则，outline 不可靠）。
  3. 按钮 `color: inherit` 会拿到链接蓝（「忽略」看着像超链接）→ `.ssd-tabsel` 上显式给 `--bs-body-color` 兜底。
- **实测**：演员 34（Rei Kamiki，stashdb + javstash）8 张卡 → 全选 8 → 批量忽略 2（8→6 卡，撤销回 0 条）→ 批量入库 2（8→6 卡，START-649 建成关联本演员/工作室 SODCreate/9 个标签）。测完已 `sceneDestroy 270/271`。
- **探针**：`probe_tab_select.js`（入口/点选/全选/批量忽略+撤销/Esc 退出，含勾选圈宽度断言 24px）。

## box 演员详情只拉一次（2026-10-30）

演员弹层要性别/年龄/别名/国籍/头像，入库预览要全字段（三围/纹身/链接/从业年…），
以前是两条不同 query：2.2KB 子集（弹层）+ 4.3KB 全集（入库），且第二条要等一个往返。
改成 `SSD.boxPerfDetail(endpoint, apiKey, stashId, timeout)` 一律拉全字段、按
`endpoint|stashId` 缓存 10 分钟（上限 64 条、按 at 淘汰）；入库预览从此零请求即时出。

- 失败降级为 `null` 且不写缓存：弹层不显示那几行标签、入库退成最小档案。
- 渲染只读不改源对象（`perfFieldValues` 是纯读），所以缓存复用不会产生差异。
- 回归：`probe_perf_detail_cache.js`（冷 1 请求 / 热 0 请求 / 入库 0 请求）；`probe_perf_box_queries.js` 量两条 query 的体积。
- **本机连测多次后 stashdb/javstash 会返回 `blocked`**（HTTP 429 一类），不是代码问题，隔一会儿再跑。

## 返回键关闭弹窗（v2.6.0，2026-10-30）

论坛 26 楼要求的「按返回键先关弹窗、而不是退出插件页」。`SSD.modalBack.hold(closeFn)`
打开时用 `history.pushState` 压一条 **同 URL** 记录（`{ssdBack: id}`），`popstate` 里关最上层；
pathname 没变，Stash 路由认为没动，卡片 DOM 不重建。

三个必须照做的点：

1. **按 × 关闭时要 `release(id)` 把那条记录吃掉**（内部 `history.back()` + `_backEcho` 计数
   吞掉自己触发的 popstate）。不吃掉，用户以后要多按一次返回键才离得开页面。
2. **嵌套会叠加**：场景详情 → 加入库预览，压两条，第一下关预览、第二下关详情。所以
   「全选重建」这类操作不能 `close(); open()` —— 会压第二条，改用 `rebuild()` 复用同一 id。
   但只复用 id 不够：`layer.close` 存的还是旧闭包，返回键会「吃掉记录但关不掉窗」
   （旧 overlay 已 remove）。复用 id 时必须 `modalBack.rebind(id, newClose)`。
3. **`pushState` 失败就不登记**（返回 0），宁可退化成「只能按 ×」，也不劫持返回键。

覆盖 7 个弹窗：场景详情（演员页/发现页共用 `buildModal`）、入库预览 ×2、演员弹层、
已忽略详情、还原全部确认、入库字段弹窗。回归跑 `probe_back_key.js`（缺数据的段会标 no-data）。

## 忽略按钮只有一份实现（2026-10-30）

场景详情弹窗的「忽略」与演员弹层的「忽略」改由同一个工厂生成 —— `ssdBanButton()`，
导出为 `SSD.banButton({label,title,aria,onConfirm})`，产出 `.ssd-dp-btn solid ssd-dp-banbtn`，
自己管 arm 态（4 秒自动复位）与二次确认；调用方只写「确认之后干什么」。

- 老 `.ssd-ban-btn` 那一整套 CSS（含 armed 的 (0,4,0) 覆盖）已删：留着就是两份肉眼对不齐的色值。
- **坑：场景详情弹窗挂在 body 上，拿不到主题 token。** suite 作用域必须带 `.ssd-modal`，
  否则 `--sx-ui3` 等全部无效。更狠的一层：`enableDiscoverPage` 关掉时 discover.js 根本不注入，
  token 连写都没人写 —— 所以 `.ssd-dp-btn.solid.ssd-dp-banbtn` / `.danger`（0,3,0 / 0,4,0）
  自带 `var(--sx-ui3, #403e3c)` 这类兜底值；选择器要足够长才能压过 `.ssd-dp-btn.solid`(0,2,0)。
- 回归：`probe_banbtn_parity.js`（idle / armed / 无 token 三态逐值比对两种容器；
  按钮有 0.15s transition，加 class 后至少等 250ms 再读 `getComputedStyle`）。

## 场景弹窗动作按钮同源改造（2026-10-30）

场景详情弹窗的「加入库 / 在源站打开 / 搜索资源」原来用旧版 `.ssd-btn` 三件套
（4px 圆角 + text-shadow + 写死的 `--ssd-*` 色），与演员弹层、已忽略管理不是一套。
现在统一走 `.ssd-dp-btn`：`primary` 实心（加入库）/ 描边（开源站）/ `tonal` 淡底（搜索资源），
加上忽略的 `solid` 中性实心 —— 四颗 8px 圆角、12.5px、34px 高，实测同排等高。

- **按钮内的文案是单独一层**（`<span data-ssd-lbl>`）。老代码用 `btn.textContent = "准备中…"`
  切状态，图标是 `innerHTML` 塞的，一改就跑丢；现在只换文案层（`setActLabel()`），
  图标层与 trailing 外链图标都不受影响 —— `updateOpenButtonLabel()` 换品牌名同理。
- **`.ssd-modal` 里补了一套 `--sx-*` 兜底（flexoki 暗色）**。弹窗挂在 body 上，
  发现页关闭时 discover.js 不注入 token；注入的 `<style>` 在 head 末尾、特异性相同，
  会正常覆盖这份兜底。
- 窄屏（≤480）四颗走 `grid-template-columns: 1fr 1fr` 的 2×2：挤一行「搜索资源」贴边，
  纯换行又会剩一颗半宽的忽略挂在末尾。
- 搜索栏的「搜索」小按钮一并换掉（`.ssd-search-bar .ssd-dp-btn` 覆盖 stretch/字号），
  输入框圆角同步 8px。
- **搜索结果行内按钮也已换**：复制磁力 / 打开链接 / 分页 / 低匹配「显示」用 `ghost sm`，
  推送下载用 `tonal sm`（不用 primary：一屏 20 行会连成蓝条色带，这是当初 tonal 存在的理由）；
  成功态 `ok`（绿实心）、失败态 `err`（红实心），替代旧的 `ssd-btn-success` / `ssd-btn-danger`。
- 回归：`probe_modal_acts.js`（分类配色 / 准备中状态图标是否保留 / 品牌名重写后 trail 图标）、
  `probe_search_btns.js`（灌假搜索结果验五类按钮 + ok/err 两态；**加类后要等 260ms**，
  否则读到的是 transition 起点的旧色）。
  `probe_banbtn_parity.js`、`probe_back_key.js`、`probe_import_dialog.js` 里的按钮选择器
  已从 `.ssd-modal .ssd-btn` 改成 `.ssd-modal .ssd-modal-acts > *`（旧选择器会找不到按钮）。
