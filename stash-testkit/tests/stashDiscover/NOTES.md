# stashDiscover NOTES — 业务语义与实测口径

> stashDiscover 是 Python + UI 插件：演员页「发现」标签从 stash-box 找本地未拥有场景。本文件放插件特有的数据流/协议/显示口径与测试环境；通用坑（0.0.0.0 连接、logs 顺序、birthdate 字段、flagcdn 等）见主 `README.md` 硬约束清单。

## 数据流

- **发现页列表**：`queryScenes(performers INCLUDES, sort DATE, direction, page, per_page)` 多 box 并行；per_page 按 missing 密度在 20–100 对称自适应（首轮 100）；本地去重 = stash_id ∪ 番号（code）双键；recent/preview 窗口在拉取循环内按 release_date 过滤（无日期场景直通）。
- **弹窗详情**：打开时 `findScene(id)` 补全（director、production_date、urls、performers 含 `images { url }`——头像数据已自带）。
- **头像卡**（点弹窗演员 pill）：
  - 头像零请求：本地映射（发现页打开时已查好的 `_state.localPerformerMaps`）→ `/performer/<local_id>/image`；无映射用 box `images[0].url`。
  - 年龄/国籍点击后按需 1 次查询：本地映射走本地 `findPerformer{birthdate country}`，否则走 box `findPerformer{birth_date country}`（经 `_boxRateLimiter`）。
  - **头像先 `new Image()` 预载、完成后再挂载**：卡片尺寸随图等比收缩（max 120×120），提前定位会按塌陷高度计算、图片加载后卡片盖住 pill。
  - 点击语义：预载中同 pill 再点 = 继续等待（不取消）；挂载后再点同 pill = toggle 关闭；点卡片 = 新标签开 box 演员页；点空白/滚动弹窗 = 关闭。
- **加入库**：`sceneCreate` 的 `urls` 必须是**字符串数组**（传 `[{url}]` 对象数组过不了本地 schema 校验）；`stash_ids` 直接随 sceneCreate 提交；`cover_image` 携带 box 封面；演员/工作室按 stash_id 映射创建/关联；按钮两段式确认（红色二次点击，4 秒超时还原）。
- **弹窗剧照探测（DMM）**：JAV 场景用 `urls` 里的 r18 链接推 content id，拿不到再用番号 `deriveContentId`；非 JAV（欧美源）只有封面。两通道探测（r18.dev JSON → 非空即用，否则按补齐 id 枚举 DMM CDN），每次探测都按 `naturalWidth>=300 && naturalHeight>=200` 过滤，占位符不会进轮播。
  - **id 必须零补齐**：DMM CDN 的 content id 数字部分固定补到 5 位（`OFJE-614` → `ofje00614`），r18.dev 的 URL id 丢掉补齐（`id=ofje614`）；未补齐时 `<cid>jp-N.jpg` 全部命中 90×122 占位符（`ofje00614jp-11.jpg` 也是占位符，可据首尾命中数判断真实张数）。
  - **r18 `gallery[].image_full` 两种形态**：`<cid>-N.jpg`（120×90 缩略图）与 `<cid>jp-N.jpg`（本身即真图）；真实剧照恒为 `<host>/<dir>/<cid>jp-<n>.jpg`，所以按「条目自身目录 + cid + 序号」重建（`dmmShotUrl`），**不要就地插 `jp`**（对已是真图的条目会产出 `jpjp-N` 占位符）。
  - 实测：OFJE-614 → 11 张（封面 800×538 + `ofje00614jp-1..10`，534×800/800×534）；`hnds00084` → 10 张（封面 2184×1468 + `hnds00084jp-1..9`，600×800/800×600，r18 gallery 长度 9 吻合）。

## Jackett 搜索链路

- 前端 `runPluginTask(stashDiscover, Search Resources)` → 后端查 Jackett Torznab → 结果 JSON 以 `[SSD_RESULT]` marker 写 stderr → 前端轮询 Stash `logs` 匹配 marker（logs 新→旧，**正序第一个即最新**）。
- `jackettUrl` 支持只填根地址（`http://host:9117`），后端自动补全 `/api/v2.0/indexers/all/results/torznab`；`apikey` 参数必带。
- 结果排序：带磁力优先，再按 seeders 降序；搜索词自动推断（jav 用番号、欧美用标题），结果区顶部搜索框可改词重搜。

## 显示口径

- 品牌映射 BRAND_MAP：`javstash.org→JAVStash`、`stashdb.org→StashDB`、`theporndb.net→TPDB`（「在 xx 查看」按钮、来源角标统一）。
- 弹窗滚动：点搜索时滚动一次露出 loading；结果原位替换不再滚动。

## 实测环境

- 实例 `http://localhost:9999`（登录 k6cc / 3321）；演员 **43 = AIKA**（javstash + stashdb 双源）；非本地映射演员用篠田ゆう（javstash）。
- 关联/覆盖实测用临时演员 **97 = ZZ SSD Test（本上花梨）**、**98 = ZZ SSD Test2**，测完已 `performerDestroy` 删除；`preferredBox` 临时改 `stashdb` 后已还原 `javstash.org`（连同 `jackettUrl/jackettApiKey/recentDays:180/previewDays:"7"`）。
- Jackett 实例：`http://192.168.3.190:9117`（API key 在实例插件设置）。
- 浏览器实测用 Chrome DevTools MCP：点击后**轮询等元素出现再断言**（异步渲染/预载/回填，立即 evaluate 会读到中间态）。

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
