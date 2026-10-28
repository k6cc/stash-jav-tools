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

- 前端 `runPluginOp("search", {query})` → `mutation runPluginOperation(plugin_id, args)` → 插件 stdout 输出**唯一一条** `{"output": ...}`（错误走 `{"error": "..."}`）。同步调用，请求返回即结果：无任务 ID、无轮询、无日志中转。
- **别再改回用 `query{logs}` 取结果**：logs 只留 30 条、单行超 64KB 截断、失败无声；Jackett 多索引器一次就有 80KB。
- **别用插件目录当结果通道**：`ui.assets: /: .` 挂出来的目录匿名可读、可列目录（`.py` 源码可下）。
- 插件 stdout 只能一条 JSON，多打一行就退化成 raw string；排查用的日志走 stderr。
- `jackettUrl` 支持只填根地址（`http://host:9117`），后端自动补全 `/api/v2.0/indexers/all/results/torznab`；`apikey` 参数必带。
- 结果排序：带磁力优先，再按 seeders 降序；上限 200 条（`SEARCH_RESULT_LIMIT`），超出时抬头显示源侧真实总数。
- 搜索词推断：`looksLikeCode()` 白名单判定（长度 > 24 / 含空格或点 / uuid → 不是番号），像番号才用 `code`，否则用 `title`。TPDB 的 code 形如 `japanhdv.com-6097`，带点 → 判成非番号 → 走标题。

## TPDB 适配层（REST，不走 stash-box GraphQL）

TPDB 的 GraphQL 只有 11 个 query，`queryScenes` 恒返回 `{count, scenes:null}`，所以场景列表走公开 REST `https://api.theporndb.net`（key 取该 box 配置里的 `apikey`）。动这块之前先跑 `probe_tpdb_api.py`。

- **批量过滤是 deepObject**：`/scenes?performers[88334]=x&performers[94042]=x`，**值被忽略、只认键**；多键按 OR 合并，`meta.total` 直接相加。写 `performers[]=uuid` 或用 uuid 当键 → 200 但 `total:0`，**静默空集、不报错**，最容易误判成「这演员没片」。
- **键必须是整数 id**：演员用 `_id`（`/performers/{uuid}`），站点用 `id`（`/sites/{uuid}`）。
- **演员 id 分两层**：`is_parent:false` 是站点级记录，打 `/performers/{uuid}/scenes` 直接 404。旧实现用 `Promise.all` 零容错，一个这种 id 就让总览三块一起红（论坛反馈的实际根因）；现在解析失败只进 `skipped[]`。反过来 **parent uuid 打 `/performers/{uuid}/scenes` 是 200**，吃 `per_page`/`page`/`date`/`orderBy`、字段与 `/scenes` 一致 —— 单演员分页可以完全不解析整数 id，省一次请求。
- **没有批量解析 uuid 的接口**：`ids[]=` / `ids=a,b` / `uuid[]=` / `performer_ids[]=` 全被忽略（返回默认列表，不报错）。首次进页面必然有 N 次解析请求，结果落 `localStorage` 的 `ssd.tpdb.intIds`（`{id,p}`，`p=0` 为站点级；失败记 `{bad:1,t}`，7 天内不重试）。
- **当前实现口径**：单演员 DESC 直接打 `/performers/{uuid}/scenes`，不写整数缓存；该路径 404（站点级/已删）才回退——先解析 parent 整数 id，再不行按名字找**完全同名**的 parent，命中时 UI 显示「编号在源上查不到，已按名字匹配」。坏缓存只记 404，网络/超时/401 不记（本地网络抖一下不该让这个演员 7 天查不出东西）。
- `per_page` 硬顶 100；`total` 封顶 10000，`page > 100` 数据错乱；`date` 与 `orderBy` 可同时给。`/changes` 只回溯 14 天，不能当全量增量源。
- 翻页上限 `TPDB_MAX_PAGES_BATCH = 5` 页 + 时间预算 `TPDB_BATCH_BUDGET_MS = 8000`：每页实测 2–5 秒，翻满 5 页要 10–20 秒，首屏等不了；超预算按截断处理并在 UI 提示。
- 站点维度比演员慢（同一批数据翻页更多）：实测 500 条 19.3s，加预算后 9.8s / 300 条。

### 站点有层级，`sites[]` 查父站点必然是 0 条

TPDB 的站点是两层结构，网页导航也分两个入口：**`Sites`**（厂牌，如 ManyVids `5502`）和 **`Performer-Sites`**（演员在该厂牌下的个人页，如 `Manyvids: Lizzy Maestro` `75219`，`parent_id=5502`）。子站点的 `parent_id` 指向上级，上级的 `parent_id` 为 `null`。

- **父站点自身没有场景**：ManyVids 网页上直接写着 `Scenes 0/0`，主体是 `Sub Sites`（`Showing 1 to 18 of 26,476 results`）；I Want Clips 有 19,921 个子站点，父站点 `/sites/{id}/scenes` 也是 0。场景全部挂在子站点上。
- 所以 `sites[<id>]=x`（精确匹配 `Site` 这一层）对父站点**永远返回 0 条**——这就是"工作室场景拉不出来"的根因，与网络、key、分页都无关。
- **正确路径**：`/scenes?site_id=<整数id>&site_operation=Site%2FParent`。语义实测：
  | 站点 | Site | Parent | Site/Parent |
  |---|---|---|---|
  | ManyVids 5502（父） | 0 | 10000（顶格） | 10000 |
  | Manyvids: Lizzy Maestro 75219（子） | 563 | 0 | 563 |
  | Czech Casting 449 | 2086 | 3007 | 5093（= 相加，验证通过） |
  | Tushy 3417（子） | 689 | 689 | 689（**不膨胀**） |
- **`Site/Parent` 不要换成 `Site/Parent/Network`**：后者在测过的 6 个厂牌上与 `S/P` 完全一致，但在 Czech Casting 上多出 611 条（`Network` 的边界不明确），有把兄弟品牌混进来的风险。
- **`site_operation` 只认单值 `site_id`**：和 `sites[]` deepObject 同时给 → 返回 0 条；`site_id` 传两次也不 OR。站点维度只能一个站点一个请求（演员维度仍用 `performers[]` 批量）。
- 父站点场景量常见过万，`total` 会顶在 10000，靠 `date` 窗口 + 页数上限收窄；命中上限时 UI 要提示截断。
- **聚合回来的场景挂在子站点上**：`site_operation=Site/Parent` 返回的每条场景，`site` 字段是它真正的子站点（`Manyvids: AriaNicoleXXX` 之类），不是被查的父站点。总览按 `scene.studio.id` 分组，不归位就会把 500 条片拆成几百个「工作室」、并把每工作室上限一起冲垮。适配层把场景的 `studio.id` 覆盖成被查的 uuid（`tpdbSinceScenes` 用 `byId` 对应，`tpdbIdPage` 用 `tpdbStampStudio`），`discover.js` 缓存版本同步升到 `.v3`。
- **401 先查 key 指的是哪个源**：`config.yml` 的 `stash_boxes` 里 key 必须与 `endpoint` 配对。用「先找 theporndb、再往回抓最近的 apikey」的写法会拿到上一个 box（javstash 的 JWT，185 字符 vs 真实 TPDB key 48 字符），请求发得出去但大面积 401，看上去跟限流一模一样。换对 key 后 15 次连打 0 次 401（6.6s），说明 TPDB 没有这个速率限制。稳定 401 仍有个别站点级特例（Adult Candy Store `5995`），重试无用、只能跳过。

### 演员没有层级坑，但有同名分裂

- **parent 记录本身就是全量**：`/performers/{id}` 返回的 `site_performers[]`（站点级记录）逐个打 scenes 全是 0 条，父记录自己 59 条 —— 演员维度不需要像站点那样做子树聚合。
- **同名分裂是 TPDB 侧的数据问题**：`/performers?q=Emma%20Reed` 返回 6 条同名 parent，片量 59 / 1 / 105 / 2 / 71 / 0；stash_id 解析到的那条（`467421`）只有 1 条，`disambiguation` 是「Brunette, c2018, MVGCash」。插件只认 stash_id，显示 1 条是如实反映，不是 bug。**不要自动合并同名**：同一批结果里 `97320` 已有 105 条但 aliases 是 `Emma FTV / Laveah Smart`，明显是另一个人。
- 真正 0 条的演员也存在（Emiru Natsumi Saki `261004`，名字搜到的仍是同一条、0 条场景），UI 不该把这种情况当失败。

### 加入库（sceneCreate）：三个源都验过，坑集中在封面和标签

复现脚本 `verify_add_to_library.py --source stashdb|javstash|theporndb`（dry-run 默认，`--apply` 写库，`--cleanup` 删场景）。

- **封面不能进 `sceneCreate`**：Stash 会同步下载外链图，拉不动时整个 mutation 报
  `processing cover image: ...`，场景一条都建不出来。改成先建场景、再 `sceneUpdate{cover_image}`，失败只丢封面；`performerCreate` 的 `image` 同理，失败降级成不带图。
- **封面 URL 要按「谁托管」排序，不能照源给的顺序**。stashdb/javstash 的图在源站自己的域（`stashdb.org/images/*`、`javstash.org/images/*`），稳定；TPDB 的 `image` 字段是**抓来的外站直链**，26 个域名里 13 个下载失败（`ods.manyvids.com` 404、`cruel-handjobs.com` 直接断连），而 TPDB 自家的 `background.full`（`cdn.theporndb.net`）和 `poster`（`thumb.theporndb.net`）26/26 可用。`tpdbScene` 已把候选顺序改成 background → poster → 外站 image，入库时按候选链最多试 3 个（第一个失败不代表全失败）。同一张图实测：外站直链 `http error 404`，TPDB CDN 成功。
- **标签不能逐个 `tagCreate`**：本地库把英文名挂在中文标签上做别名（「金发」的别名含 `Blonde Hair (Female)`），逐个建会报 `name 'X' is used as alias for 'Y'`，实测 10 个标签丢 8 个。改成一次 `findTags(filter:{per_page:-1}){tags{id name aliases}}` 建 name+alias 索引，命中就不建。
- **全量索引也可能漏别名**：库在后台扫描时新标签陆续出现，索引建好之后才入库的标签查不到，`tagCreate` 又被别名拒掉，标签就丢了。`findOrCreateTag` 在建失败（或返回空）时按 `q=<name>` 回查一次，把别名占用的标签认回来。
- **演员头像直接给 Stash URL，别在浏览器里转 data URL**：`performerCreate.image` 两种都收，但浏览器 `fetch` 要 CORS，stashdb / javastash 的图没有 CORS 头，转 data URL 会静默失败、演员建出来没头像。现在先交 URL（Stash 服务端下载），失败才回落 data URL，最后无图。实测三源都能落头像（`image_path` 非空）。
- **场景内演员的 `id` 是站点级记录**，本地 stash_id 要用 `parent.id`（`tpdbScene` 已按此取）。本地没有这个编号时按 `performerCreate` 补建并带 `stash_ids`，否则加入的片显示「无演员」。新建工作室同样要带 `stash_ids`，只有按名字撞到已有工作室时才不写（不改用户既有数据）。
- **三源实测结果**（测试库 `localhost:9999`，每源一条未拥有场景，跑完即删）：stashdb `START-649` / `SDJS-383`、javstash `DSUVR-010`、theporndb `92c840f9` 全部建库成功，stash_ids / 演员 / 工作室 / 标签（5/5、10/10、9/9）齐备，封面均落在成功候选上，回查 `stash_id_endpoint` 命中 1。

## 显示口径

- 品牌映射 BRAND_MAP：`javstash.org→JAVStash`、`stashdb.org→StashDB`、`theporndb.net→TPDB`（「在 xx 查看」按钮、来源角标统一）。
- 弹窗滚动：点搜索时滚动一次露出 loading；结果原位替换不再滚动。

## 实测环境

- 实例 `http://localhost:9999`（登录凭据见 `screenshots/creds.json`，不入库）；演员 **43 = AIKA**（javstash + stashdb 双源）；非本地映射演员用篠田ゆう（javstash）。
- 关联/覆盖实测用临时演员 **97 = ZZ SSD Test（本上花梨）**、**98 = ZZ SSD Test2**，测完已 `performerDestroy` 删除；`preferredBox` 临时改 `stashdb` 后已还原 `javstash.org`（连同 `jackettUrl/jackettApiKey/recentDays:180/previewDays:"7"`）。
- Jackett 实例：`http://192.168.3.190:9117`（API key 在实例插件设置）。
- TPDB key：`E:/stashAPP/config.yml` 里该 stash-box 块的 `apikey`；`probe_tpdb_api.py` 与 `node_tpdb_harness.js` 都从那里读，不打印。
- **本机库的 TPDB 数据是测试加的**（3 个工作室 + 4 个演员），只够验适配层与入库链路；发现页三块的完整渲染仍需真实库。
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
