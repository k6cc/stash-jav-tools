# stashDiscover — 源适配与存储语义

> 数据层的事实：走哪个源、哪条协议、参数怎么拼、数据落在哪、缓存了什么。
> 改 `queryScenes` / `tpdb*` / `cacheWrite` / `dpIgnore` 之前读这里。
> 脚本 [SCRIPTS.md](SCRIPTS.md) · 交互口径 [FEATURES.md](FEATURES.md) · 踩过的坑 [PITFALLS.md](PITFALLS.md)

## 数据流

- **发现页列表**：`queryScenes(performers INCLUDES, sort DATE, direction, page, per_page)` 多 box 并行；per_page 按 missing 密度在 20–100 对称自适应（首轮 100）；本地去重 = stash_id ∪ 番号（code）双键；recent/preview 窗口在拉取循环内按 release_date 过滤（无日期场景直通）。
- **弹窗详情**：打开时 `findScene(id)` 补全（director、production_date、urls、performers 含 `images { url }`——头像数据已自带）。
- **头像卡**（点弹窗演员 pill）：
  - 头像零请求：本地映射（发现页打开时已查好的 `_state.localPerformerMaps`）→ `/performer/<local_id>/image`；无映射用 box `images[0].url`。
  - 年龄/国籍点击后按需 1 次查询：本地映射走本地 `findPerformer{birthdate country}`，否则走 box `findPerformer{birth_date country}`（经 `_boxRateLimiter`）。
  - **头像先 `new Image()` 预载、完成后再挂载**：卡片尺寸随图等比收缩（max 120×120），提前定位会按塌陷高度计算、图片加载后卡片盖住 pill。
  - 点击语义：预载中同 pill 再点 = 继续等待（不取消）；挂载后再点同 pill = toggle 关闭；点卡片 = 新标签开 box 演员页；点空白/滚动弹窗 = 关闭。
- **加入库**：改成三段式「算草稿 → 弹窗预览 → 确认提交」（v2.6.0 批次6，见下节）；`sceneCreate` 的 `urls` 必须是**字符串数组**（传 `[{url}]` 对象数组过不了本地 schema 校验）；`stash_ids` 直接随 sceneCreate 提交；`cover_image` 仍在场景落地后单独补；演员/工作室按 §4.5 四步判定建档/关联。
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

## 本地存储（localStorage）实测（2026-10-29）

脚本：`probe_localstorage.js`，在页面上下文跑，输出占用 / 配额 / 版本孤儿三段。

```
cd E:/stashAPP/devtools
MSYS_NO_PATHCONV=1 python stash_dev.py eval \
  "$(cat /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/probe_localstorage.js)" \
  --path /plugins/stashDiscover --settle 3
```

- **配额**：已经用了 719k 字符时，写入 4,000,000 成功、5,000,000 抛 `QuotaExceededError` → 上限约 **5.24M 字符**（与 `CACHE_BUDGET_CHARS` 注释一致）。探针会临时写入再删，不动既有键。
- **键位语义**：场景缓存是 `SSD:dp:<host>:<family>.v3`（`cacheKey`）；已读 / 关注 / 未读 / 轮询（`read.v1` `follow.v1` `unread.v1` `poll.v1`）都是**全局键**，无 host 前缀。
- **`cacheInvalidate(host)` 删的是 `SSD:dp:<host>:` 前缀的全部键**（刷新按钮 / 切源时调用）。任何「不能丢」的数据都不能带 host 前缀，否则一点刷新就没了。
- **升级孤儿实测 580,525 字符**（占插件存储 698,846 的 83%）：`javstash:newScenes.v2` 410,160、`javstash:studios.v2` 98,368、`theporndb:trending.v2` 36,567、`javstash:trending.v2` 35,061。成因：`cacheWrite` 只清「同 host + 同 family」的旧版本键，某个源升级后再没被访问过，旧条目就永久滞留。
- **孤儿判定不能用 `.v\d+$`**：`local.v1` / `follow.v1` / `unread.v1` / `poll.v1` / `trendingPerf.v1` 的 `.v1` 是各自存储的版本号，不跟 `CACHE_FMT` 走，按后缀粗暴匹配会误删用户数据。只认 `SSD:dp:<host>:{newScenes|trending|studios}.v<N>`。
- **单条快照体积**（做预算时用）：场景 259 字符（TPDB 50 条均值，最大 326），加前 4 位演员名 290；演员 151 字符（本机 115 位，中位 155），源侧头像 URL 另加约 60。
- 验收基线：孤儿清扫后 `orphanChars` 应为 0，`SSD:*` 由 698,846 降到约 118,000。
- **已落地（discover.js `sweepOrphanCaches()`，挂载发现页时跑一次）**：实测 `SSD:*` 699,353 → **118,828**、总占用 719,415 → 139,061、`orphanChars` 580,525 → **0**，与预估一致。
- **读时 shape 校验**：`saneCacheEntry()` 逐条丢弃坏场景（非对象 / id 不是非空字符串），全部坏才当 miss。探针 `probe_cache_shape.js`：混入 `{title}`/`null`/`42`/`{id:""}` 后仍走 `fresh` 且好条目全留；全部坏则返回 `fromCache:"network"`，两种情况都不抛异常。
- **`stash_dev.py eval` 踩坑**：`cmd_eval` 原先用同步 `Runtime.evaluate`，返回 Promise 的表达式会被序列化成 `{}`。已改为走 `eval_async`（`awaitPromise:true`），async 探针才能拿到真实值。

## 忽略记录（`SSD:dp:ignore.v1`，2026-10-29 实测）

- **键位**：全局键，`{ scenes:{}, performers:{}, trimmed:N }`。键名格式与 `read.v1` 一致 = **完整 endpoint + ":" + id 小写**（如 `https://stashdb.org/graphql:01a13457-…`），不是 host。带 host 前缀会被 `cacheInvalidate` 一刷新清空。
- **场景快照实测 194 字符**：`{at,title,date,code,cover,studio,p[前4演员名]}`。3,000 条约 580KB，在 1,000,000 字符预算内。
- **硬上限实测**：注入 3,200 条（869,200 字符）后再忽略 1 条 → 写回 3,000 条、`dropped:201`、`trimmed:201`，淘汰的是 `at` 最小的那批，新记录保留。
- **三处生效点**（探针 `probe_ignore_scene.js` / `probe_ignore_poll_stub.js` / `probe_ignore_ui.js`）：
  - `filterPipeline` 入口剪：6 部 → 忽略 1 部 → 5 部，撤销回 6 部；
  - 导航轮询：合成 3 部场景（命中数 4）→ 忽略 1 部变 3 → 忽略该演员变 1 → 再忽略另一演员变 0；
  - 卡片即时消失：弹窗里忽略后 5 张卡 → 4 张。
- **单条忽略交互**：弹窗主按钮区最右「忽略」+ ban 图标；第一次点击只 arm（文案变「确认忽略？」，不写记录），第二次才落库，然后弹「已忽略「片名」· 撤销」toast（4 秒）。
- **本机网络限制**：当时 `fetch('https://stashdb.org/graphql')` 直接 `Failed to fetch`（代理不可用），所以真实轮询无法联测；用 `window.fetch` 打桩喂合成场景验计数逻辑，属环境噪声不是代码问题（用户明确要求别据此改产品）。
- **探针清单**：`probe_localstorage.js`（占用/配额/孤儿）、`probe_cache_shape.js`（读时校验）、`probe_drill_layout.js`（关注截断/钻取分页/工具栏宽度）、`probe_unread_drill.js`（钻取记已读）、`probe_ignore_scene.js`、`probe_ignore_poll_stub.js`、`probe_ignore_ui.js`。

## 忽略快照字段与导出结构（v2.6.0 定稿，此后只加不改）

字段表见插件 `README.md`「忽略记录」一节 —— 定稿结论是**一个都不用删、没缺**：
场景 7 个（`at/title/date/code/cover/studio/p`）、演员 7 个（`at/name/image/alias_list/
country/birthdate/gender`），每个都有明确的读取点（卡片 / 弹窗 / 搜索）。

改动只有三条，都是防浪费配额与防静默丢数据：

- **`IGN_TEXT_CAP` 截断**：title 200 / studio 80 / code 40 / date 20 / name 120 / alias 60，
  写入与导入两侧都套。**URL 不截** —— 截断等于断链，`onerror` 兜不住半个 URL。
- **导入版本握手**：`version > 1` 照读已知字段、回报 `fileVersion` 让 UI 提示，不猜新字段。
- **无效条目计数**：键不是 `endpoint:id`、值不是对象 → `invalid++` 并在 toast 明示，
  以前是静默 `return`。

导出顶层固定 `{version:1, exportedAt, trimmed, scenes, performers}`；`exportedAt` / `trimmed`
只给人看，导入不读。回归跑 `probe_ign_export.js`（会临时清空记录、跑完还原）。

## 发现页缓存只到「卡片级」，不等于详情（2026-10-30 核对）

- localStorage `SSD:dp:cache:<host>:<family>.v3`，family = newScenes / trending / studios。
  12h 新鲜期（`CACHE_TTL_MS`），7 天 SWR 兜底，单族上限 4000 条 / 3.6M 字符（超了按 0.7 反复裁）。
- 存的是**卡片投影**：id / title / code / release_date / duration / director、details（截 400 字）、
  studio{id,name}、performers（去重成 id，索引只留 name + 首图）、tags[{name}]、
  images（前 8 张）、urls（只留 url，没有 site 名）。
- 场景详情弹窗**读**这份：一打开就用 `item.scene` 渲染详情区，所以不是空白转圈。
  但入库要完整字段（完整简介、标签 id、演员档案、源链接站点），必须再拉一次 `findScene` ——
  这是分层，不是重复。**场景详情不做短时缓存**（用户 2026-10-30 明确否掉），每次打开请求一次。
- 演员侧是另一回事：`boxPerfDetail` 有 10 分钟缓存，因为弹层和入库预览要的是同一份全字段。
- 刷新按钮 = `cacheInvalidate(host)` 删三族缓存 + `invalidateLocalMemos()` 清会话 memo +
  `_dp.d/_dp.err/_dp.fetchedAt` 归零 + `ensureData(keys, true)` 绕过缓存重拉并覆盖写回。

## Jackett 结果的来源索引器（2026-10-30）

聚合搜索每条 item 自带 `<jackettindexer id="torrentdownload">TorrentDownload</jackettindexer>`
（标签无命名空间前缀，个别版本写作 `jackett:indexer`）。`torznab:attr name="tracker"` 在当前
Jackett 版本不输出，所以老的 `tracker` 字段恒为空串 —— 前端 meta 里那一段从来没显示过。
`_parse_torznab()` 改按子元素本地名 `endswith("indexer")` 抓取，写进 `indexer`（无 text 取 id，
再退回 tracker 属性）。纯 XML 解析，零额外请求。

- 前端渲染成标题下方的小标签 `.ssd-search-item-indexer`，meta 改 flex 排布；
  结果行底色是写死的深灰，标签用中性半透明而不是 `--sx-*`（否则浅色主题下是亮块压深底）。
- 回归：`probe_search_scroll.js` —— pills 数 = 行数、rowsWithoutIndexer = 0。
- 本机连测时 Jackett 偶尔整批返回 0 条（索引器超时、channel 里没有 item），隔十几秒重跑即可，
  不是解析问题 —— 空响应下 pills 自然是 0。

## 显示口径

- 品牌映射 BRAND_MAP：`javstash.org→JAVStash`、`stashdb.org→StashDB`、`theporndb.net→TPDB`（「在 xx 查看」按钮、来源角标统一）。
- 弹窗滚动：点搜索时滚动一次露出 loading；结果原位替换不再滚动。

## 外部插件对照（2026-10-29）
- **tagMerge**（源码可读，同作者）：`normalize` 用 **NFKC** + 小写 + 剔分隔符 `\s·、，,。/-—_・`，比本插件的 `normalizedName`（NFC + 去空白）强，能命中全角与 `A / B` 写法；`candidateWords` + `filterTagHits` 是「本地主名/别名 ↔ 远端 name/aliases 归一化全等」的双向精确匹配，可直接搬。fill 缓存 `tgm.fillCache.v1.<endpoint>` **只存命中词**，未命中跨会话重查（能捕捉源站新增实体）。
- **binge**（`index.html` 打包 998KB，需用 `node -e` 按关键字切上下文读）：缓存键 `binge.source.<host>.newScenes.*`，与本插件同源形状，但写缓存是 `try{setItem}catch{}`——**无预算、无衰减、无告警**，比本插件弱；值得抄的只有「读时逐条校验 shape，坏数据当 miss」。它调的 `scrapeSinglePerformer({stash_box_index, stash_id})` 在当前 schema 已不成立（现为 `source` + `input{performer_id}`）。
- **`scrapeSinglePerformer` 抓 stash-box 演员（实测不可用）**：uuid → `strconv.Atoi` 报错；TPDB 数字 id → `performer with id 467417 not found`；`performer_input{stored_id}` → `not implemented`；`scrapePerformerURL` → index out of range。按 `input:{query:名字}` 能回结果（JAVStash 10 条 / TPDB 1 条），但 `stored_id` 为 null、无法确认是哪一位，且 TPDB 记录本身几乎全空（1 条只有 `fake_tits`）。结论：补全演员字段继续走 raw box GraphQL，别指望 scraper 层。
