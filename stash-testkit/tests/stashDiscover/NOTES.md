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

## 外部插件对照（2026-10-29）
- **tagMerge**（源码可读，同作者）：`normalize` 用 **NFKC** + 小写 + 剔分隔符 `\s·、，,。/-—_・`，比本插件的 `normalizedName`（NFC + 去空白）强，能命中全角与 `A / B` 写法；`candidateWords` + `filterTagHits` 是「本地主名/别名 ↔ 远端 name/aliases 归一化全等」的双向精确匹配，可直接搬。fill 缓存 `tgm.fillCache.v1.<endpoint>` **只存命中词**，未命中跨会话重查（能捕捉源站新增实体）。
- **binge**（`index.html` 打包 998KB，需用 `node -e` 按关键字切上下文读）：缓存键 `binge.source.<host>.newScenes.*`，与本插件同源形状，但写缓存是 `try{setItem}catch{}`——**无预算、无衰减、无告警**，比本插件弱；值得抄的只有「读时逐条校验 shape，坏数据当 miss」。它调的 `scrapeSinglePerformer({stash_box_index, stash_id})` 在当前 schema 已不成立（现为 `source` + `input{performer_id}`）。
- **`scrapeSinglePerformer` 抓 stash-box 演员（实测不可用）**：uuid → `strconv.Atoi` 报错；TPDB 数字 id → `performer with id 467417 not found`；`performer_input{stored_id}` → `not implemented`；`scrapePerformerURL` → index out of range。按 `input:{query:名字}` 能回结果（JAVStash 10 条 / TPDB 1 条），但 `stored_id` 为 null、无法确认是哪一位，且 TPDB 记录本身几乎全空（1 条只有 `fake_tits`）。结论：补全演员字段继续走 raw box GraphQL，别指望 scraper 层。

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

---

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

## 弹窗滚动容器是 .ssd-modal-body（2026-10-30）

`.ssd-modal` 是 `overflow:hidden`，`scrollHeight === clientHeight`（实测差 0），滚它等于没滚，
所以「点搜索资源后自动上滑到底」静默失效了很久。改滚 `.ssd-modal-body`；结果渲染后再把
`.ssd-search-header` 对齐到可视区顶部（否则滚动位置停在列表中间），翻页同样对齐。

- 回归：`probe_search_scroll.js` —— onClick.top == max、afterRender.headerOffset == 8、翻页后仍 8。

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
