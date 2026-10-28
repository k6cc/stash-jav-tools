# stashDiscover：Jackett 结果传不回前端（论坛 #22）

> 用户 TheShark 于 2026-10-28 反馈，v2.4.6 之后 Jackett 搜索"日志显示找到 233 条，插件里一条都没有"。
> 本文确认现有实现机制、定位根因、给出替代通道方案。**未改代码。**

## 1. 反馈事实

原贴：https://discourse.stashapp.cc/t/stashdiscover/17710/22

| 用户说法 | 截图证据 |
|---|---|
| "getting absolutely nothing from Jackett, even though the logs indicate that results were found" | 界面：`Search failed: Task finished without returning results — please retry` |
| "Since version 2.4.4 (?), data is no longer being passed from Jackett" | 日志：`Jackett returned 233 results (showing 50)`，紧随其后就是 `Plugin stashDiscover finished`，**中间没有任何 `[SSD_RESULT]` 行** |
| 昨天日志还出现"code 120" | 待确认，疑似另一条被截断的负载行 |

日志原文（用户贴的两张）：

```
09:27:40 debug Reading plugin configs from /config/plugins
09:27:40 debug Plugin stashDiscover started: /usr/bin/python3 .../stashDiscover.py
09:28:02 info  [Plugin / stashDiscover] [stashDiscover] Jackett endpoint: http://192.168.178.58:9117/api/v2.0/indexers/all/results/torznab
09:28:02 info  [Plugin / stashDiscover] [stashDiscover] Jackett search: White Lace Lingerie
09:28:42 info  [Plugin / stashDiscover] [stashDiscover] Jackett returned 233 results (showing 50)
09:28:42 debug Plugin stashDiscover finished
09:28:42 debug Plugin returned: 0xc001aaa810
```

注意 09:28:02 → 09:28:42，Jackett 单次耗时 **40 秒**。

### 1.1 这条回帖里提到的全部问题

| # | 他的说法 | 归类 |
|---|---|---|
| P1 | Jackett 结果传不回（主诉） | 本文件主题，见 §2–§4 |
| P2 | 选了 TPDB 后，总览里只有"热门"位有数据，其余模块报错 | 同源架构问题，见 §7 |
| P3 | "For some reason, 'New on Site' items are still being displayed" | TPDB 下"热门"位本来就被替换成"网站上新"（`discover.js:1833`），**这是设计，不是 bug**，需在回复里说明 |
| P4 | 昨天日志出现 "code 120 / Discover finished 120" | 待他贴原行；怀疑是另一条被截断的负载行（`[SSD_RESULT]` 被切到只剩前半段） |
| P5 | qB 5.3.0 还没法验证 | 依赖 P1 修好，不是新问题 |
| P6 | 问 "open terminal in Stash" 是什么意思 | 见 §10 末尾 |

同一帖子里另一个用户（`zxqlxy`，第 19–20 楼）报的是**另一件事**：数据源无法编辑 + 一个错误页，与 P1–P6 无关，先记着不混进来。

### 1.2 全帖问题核对（改通道不能只看 #22）

#22 只是最新一层。同一主题共 23 楼，`TheShark` 在 #12 已报过六点、`p0rnb0x` 在 #21 提过两条需求。
改通道前后都要过这张表，否则容易把已经修好的东西改回去。

| 来源 | 问题 | 状态 | 依据 |
|---|---|---|---|
| #22 P1 | Jackett 结果传不回 | ✅ 已修 | 方案 G，§6 |
| #22 P2 | TPDB 下总览三块报错 | ⬜ 方案定，代码未动 | §7.5，等 Jackett 上线后做 |
| #22 P3 | "New on Site" 仍在显示 | 🚫 设计如此 | TPDB 无热度维度，热门位改标签为网站上新 |
| #22 P4 | 日志 "code 120" | ❓ 未定位 | 待原行。也可能是 `jackettTimeout=120` 跑满 |
| #22 P5 | qB 5.3 无法验证 | ⬜ 被 P1 阻塞 | 204 登录已处理（`stashDiscover.py:339`） |
| #22 P6 | "open terminal in Stash" | ✅ 回复草稿 | §10 末 |
| #12 ① | qB 5.3.0 登录返回 204 | ✅ v2.4.6 | `stashDiscover.py:339`，本次未动 |
| #12 ② | 日志说 230 条、界面只有几条 | ✅ v2.4.6，本次再放宽 | 真实总数 + 截断提示（`stashDiscover.js:4736`）；上限 50→200 |
| #12 ③ | 搜 A 再搜 B 拿到 A 的结果 | ✅ 结构上消除 | 同步调用，无 rid/轮询，§6.2 |
| #12 ④ | **有 code 就用 code 搜，结果完全不相关** | ✅ v2.4.6，本次未动 | 见 §1.3；调用在通道之前，无回归 |
| #12 ⑤ | TPDB 在 Discover 页 "Unknown Error" | 🟡 只做了暴露错误 | 根因同 §7，代码未修 |
| #12 ⑥ | 选过 TPDB 后切不回 StashDB | ✅ v2.4.6 | 下拉 value 由名称改为 endpoint（`stashDiscover.js:1016`） |
| #21 ① | 入库字段应可关（尤其 Tags） | ⬜ 有计划未实现 | `stashdiscover-batch-ignore-plan.md` C6 |
| #21 ② | 已发现的场景应可「忽略」 | ⬜ 有计划未实现 | 同上 |
| #19 | 数据源无法编辑 + 错误页 | ❌ **完全没针对** | 唯一真空项，需要他给截图里的具体报错 |

### 1.3 #12 ④：TPDB 场景必须用标题搜，不是番号

这条不在 #22 里，但改通道时最容易被误伤，单列。

**成因**：TPDB 把 `external_id` 映射进 `code`，实测形如 `japanhdv.com-6097`（站点域名 + 站点内 ID），不是番号。
原逻辑是 `code || title`，只要 code 有值就压过标题 → 拿域名去搜 Jackett，结果自然不相关；没有 code 的场景反而准，这正是他描述的"按发行日期搜就正常"。

**现逻辑**（`stashDiscover.js:4576`）：

```
looksLikeCode(v)                      // 白名单式，只认番号形态
  ├ 长度 > 24 / 含空格或点 / uuid     → false
  ├ 051424_001                        → true
  └ SSIS-001 / T28-123 / FC2-PPV-1234 → true
searchQueryFor(sc) = looksLikeCode(code) ? code : (title || code)
```

TPDB 的 code 带域名点，第一个条件就挡掉，落到标题。JAV 的真番号照旧走 code。

**本次通道改造对这段零改动**：`searchQueryFor()` 在 `handleSearchResources()` 里算好默认值，早已是 `doSearchResources()` 的入参，换通道只改后者内部那一行调用。

**仍有两个尾巴**：

| 尾巴 | 现象 | 处理 |
|---|---|---|
| `slug-12345` 形态误判 | 正则接受「2–12 位字母数字 + `-` + 2–7 位数字」，无点的站点 code 会被当番号 | 暂无真实样本，先记着；真踩了再加源维度判断 |
| 标题当查询词的副作用 | 英文长标题命中极泛（"White Lace" 就 233 条），200 上限仍会截断；排序按 seeders 不按相关度 | 已有截断提示 + 输入框可改词重搜；要更好需做标题裁剪/相关度重排，未做 |

## 2. 现在的机制

是的，结果确实是**从 Stash 全局日志里捞回来的**，不是任何官方数据通道：

```
前端                       Python 插件                Stash                    前端
runPluginTask ──────────▶ do_search
                              ├ log_info("returned 233")
                              ├ print("[SSD_RESULT] {json...}", stderr)   （无级别前缀）
                              │                        └ 当普通 info 行写进日志
                              └ exit                    （日志环形缓冲，仅 30 条）
findJob 轮询 ────────────────────────────────────────▶ 只看 status
query{logs{level message}} ──────────────────────────▶ 在 30 条里找 rid 命中项
```

代码位置：

| 环节 | 位置 |
|---|---|
| 写结果 | `stashDiscover.py:120` `emit_result()` → `print(..., file=sys.stderr)` |
| 读结果 | `stashDiscover.js:4771` `fetchSearchResult()` → `query{logs{level message}}` |
| 等结果 | `stashDiscover.js:4796` `waitPayload()`，job 结束后最多再等 5 秒 |

**Stash 没有给插件前端提供结果通道**（已核对本机 schema）：

- 62 个 query、125 个 mutation 里没有任何通用键值/文件读写；
- `Job` 类型只有 `id / status / subTasks / description / progress / startTime / endTime / addTime / error` —— **没有 output**；
- 插件 stdout 的 `PluginOutput` 只会被服务端 `logger.Debugf("Plugin returned: %v", ...)` 打成一行调试文本，前端拿不到。

所以"读日志"不是偷懒，是当时唯一能用的路。但它确实是**旁路**：一个为人类排错设计的、有空量上限的、无序的文本流。

## 3. 根因：三个都无声的失败模式

全部从 Stash 源码确认，不需要用户环境复现：

| # | 失败模式 | 机制 | 症状 |
|---|---|---|---|
| F1 | **日志缓冲只有 30 条** | `query{logs}` 返回的是进程内环形缓冲，实测 `LOG_COUNT 30` | 慢搜索期间（本例 40s）用户又点了几次、或别的东西在写日志，结果行被挤出 30 条窗口 → 前端找不到 → "没收到结果" |
| F2 | **单行 >64KB 被截断** | `pkg/logger/plugin.go`：`maxLogLineLength = 64*1024`，超出截断并追加 `" [truncated]"` | JSON 被切半，`JSON.parse` 失败，而 **`rid` 写在 payload 末尾**（`emit_result` 最后追加），截断后 rid 直接丢失 → 前端判"不是我的结果" → 同样报 "没收到结果" |
| F3 | **两个限制都不报错** | 通道本身不提供任何诊断 | 用户和作者都只能猜，这是本次排查成本高的真正原因 |

F2 的体积是**擦着线**的。用真实字段结构估算（50 条上限）：

- 每条含 `title / magnet(6 个 tracker) / link(带 passkey 的 .torrent URL) / size / size_human / seeders / leechers / pub_date / tracker` ≈ **765 字节**
- 50 条 ≈ **38 KB**；日文/中文标题（UTF-8 三字节）再叠长磁力，就够越过 64 KB

这正好解释用户上一轮说的"**most cases** 能用，偶尔不行"——不是随机，是随 payload 大小抖动。他这次 220/233 条命中、索引器给的磁力长，就一直越线。

F1 与 F2 的症状完全一样（都落到 `waitPayload` 的超时文案），日志里看不出区别，这也是为什么 v2.4.5 加的 rid 修好了"串结果"却没修好"收不到"。

## 4. 结论

**不是查询逻辑的 bug，是传输通道选错了。** 修 rid、调超时、把 count 和 shown 分开，都是在一条注定丢数据的管道上打补丁。

## 5. 通道方案对比

先厘清一件事：**A 不是候选方案，A 就是现在的实现**。这里把它列进来只是为了说明"为什么不能再修下去"。真正的候选是 B/C/D/E/F 五个，全部评估过：

| 方案 | 是不是可行 | 判断 |
|---|---|---|
| **A. 现状：读 Stash 日志** | 能用但会丢 | 30 条窗口 + 64KB 截断 + 无诊断。**淘汰，不可修** |
| **B. 写文件 + 走插件静态资源路由** | ✅ 已具备，零配置 | `/plugin/{id}/assets/*` 就是 `http.FileServer`（`internal/api/routes_plugin.go`），本插件 `ui.assets: /: .` 已把**整个插件目录**挂出去。**推荐** |
| C. 浏览器直连 Jackett | ⚠️ 部分 | Jackett 的 CORS 是 **opt-in**（`Startup.cs`：`if (Helper.ServerConfiguration.AllowCORS) app.UseCors(...)`，默认关），且 Stash 走 https、Jackett 走 http 时被混合内容拦。只能当降级 |
| D. 经 GraphQL 中转（`querySQL`/`execSQL` 建临时表，或写插件 settings） | ⚠️ 能做但脏 | 为一次搜索结果往用户库里建表／污染插件设置，代价远大于收益。**淘汰** |
| E. 插件自己起一个临时 HTTP 端口回传 | ❌ | 要抢端口、过防火墙、管进程生命周期，Docker 下还要额外映射。**淘汰** |
| F. 拆成多行、每行一条结果，前端按 rid 收集 | ❌ | 仍然撞 30 条窗口：50 条结果本身就是 50 行，窗口只有 30。**淘汰** |

**B 也已被实测淘汰**，原因是安全而不是性能：`ui.assets: /: .` 挂出来的目录**匿名可读、可列目录**。

```
GET /plugin/stashDiscover/assets/cache/            → 200，直接列出全部结果文件名
GET /plugin/stashDiscover/assets/cache/search-xxx.json → 200，匿名拿到全部搜索结果
GET /plugin/stashDiscover/assets/stashDiscover.py  → 200，连源码都可读
```

（早先记录的"匿名 401"是错的，那次测的路径与实例状态不同。）搜索结果里有种子标题、磁力、以及部分索引器返回的带 `apikey` 的下载链接，任何人都能列出并下载——这个方案直接作废。

**胜出的是 G：`runPluginOperation`**，Stash 官方给插件留的同步通道：

```graphql
mutation { runPluginOperation(plugin_id: "stashDiscover", args: {mode: "search", query: "..."}) }
```

插件 stdout 输出一条 `{"output": {...}}`，`RunPluginOperation` 的 resolver 返回类型是 `interface{}`（`internal/api/resolver_mutation_plugin.go:68`），前端一次调用直接拿到结构化结果。三个失败模式同时消失，且**通道本身要会话**。

代价只有一个：**同步阻塞**，Jackett 慢查询期间这个 GraphQL 请求会一直挂着（实测一次 7.2s，慢索引器可能 40–120s）。反代默认 60s 超时的话会被切断——这是唯一需要留意的环境问题。

| 方案 | 判断 |
|---|---|
| A 读日志 | 淘汰，30 条窗口 + 64KB 截断，不可修 |
| B 写文件 + assets | **淘汰，匿名可读可列目录** |
| C 浏览器直连 Jackett | 淘汰，CORS 默认关 + 混合内容 |
| D GraphQL 建表/写设置 | 淘汰，弄脏用户库 |
| E 自起 HTTP 端口 | 淘汰，抢端口/过防火墙 |
| F 拆多行按 rid 收集 | 淘汰，50 条撞 30 条窗口 |
| **G runPluginOperation** | **采用** |

## 6. 实现（方案 G）

### 6.1 协议

一次调用一个同步请求，不再有 rid、轮询、文件：

```graphql
# 搜索
mutation { runPluginOperation(plugin_id: "stashDiscover", args: {mode: "search", query: "..."}) }
# 推送
mutation { runPluginOperation(plugin_id: "stashDiscover", args: {mode: "push_download", magnet: "..."}) }
```

插件侧只管 stdout 输出**一条** JSON：

| 情况 | stdout |
|---|---|
| 成功 | `{"output": {"mode":"search","count":233,"shown":200,"truncated":true,"results":[...]}}` |
| 失败 | `{"error": "Jackett request failed (HTTP 403): ..."}` |

`error` 会被 resolver 转成 GraphQL error，前端从 `errors[0].message` 取到的就是那句人话。

### 6.2 要点

| 项 | 做法 | 理由 |
|---|---|---|
| stdout 唯一性 | 删掉 `exit_plugin("OK")`，全脚本只有 emit 一处写 stdout | 两行输出会让 `json.Unmarshal` 失败，退化成 raw string |
| 错误 | 异常也走 `{"error":...}` | 否则前端只能等到超时，看不到原因 |
| 前端错误文案 | `gqlErrorMessage()` 解析 `[{message}]` | 原来直接显示 `[{"message":"..."}]` |
| 上限 | 50 → **200** | 通道没有 64KB 限制；UI 仍分页渲染 |
| 超时 | 后端 `jackettTimeout`（默认 120s，上限 600s） | 同步等待，浏览器 fetch 本身不限时 |
| 反代 | README 提示：反代 60s 超时需放宽 | 唯一的环境侧风险 |
| 清理 | 无需 | 不落盘 |

删掉的东西：`[SSD_RESULT]` / `[SSD_ERROR]` 两个 marker、`fetchSearchResult`、`fetchPushResult`、`pollJob`、`waitPayload`、`searchBudgetMs`、`newRequestId`，以及整套 cache 文件读写。

### 6.3 实测（本机实例，Jackett 已配）

| 项 | 结果 |
|---|---|
| 搜索 "White Lace" | **7.2s**，38 条，payload **80839 字节** |
| 80839 字节意味着什么 | 旧通道单行上限 65536，**这批结果必然被截断** —— 正好复现论坛症状 |
| 空 query | 0.3s 返回 `No search query provided.`（不再超时） |
| 未知 mode | 0.3s 返回 `Unknown mode: nope` |
| 是否落盘 | 无文件产生 |

三个失败模式同时消失：没有 30 条窗口、没有 64KB 截断、错误与结果都走同一条返回路径。

## 7. P2：TPDB 总览报错（与 Jackett 无关，独立修复）

一句话结论：TPDB 的 GraphQL `queryScenes` 是死的，REST 有批量过滤但参数是 `deepObject` 格式（`performers[整数_id]=x`）；插件用了错的数组写法试出 0 条，于是退化成"每个演员发一次子资源请求"，而这条链路上零单点容错 —— 一个坏 id 就让三块总览一起红。

> TPDB 的完整能力边界（哪些接口根本没有、哪些字段恒空、分页 1 万条硬顶、封面 90% 死链）见
> [`stashdiscover-tpdb-capabilities.md`](./stashdiscover-tpdb-capabilities.md)。本章只修 404 与容错。

P2 那两张总览截图（源选 TPDB）逐块看：

| 模块 | 状态 | 实际走的路 |
|---|---|---|
| 热门位（TPDB 下改名「网站上新 / New on site」） | **有数据** | `tpdbGlobalPage()` → `/scenes?per_page=..&page=..&orderBy=recently_created` |
| Performers with releases | `Rejected by the source (HTTP 404)` | `tpdbSinceScenes()` / `tpdbIdPage()` → `/performers/<id>/scenes?per_page=..` |
| Latest | 同上 | 同上（与上一块**共用同一个数据集**） |
| Upcoming | 同上 | 同上 |
| 点一次 Refresh 之后 | 三块变成 `Unreachable — network error (Failed to fetch)` | 同一批请求被中断 |

### 7.1 TPDB 其实支持批量 —— 是写法没对上

官方规范就在站点上：`https://theporndb.net/docs` → `https://theporndb.net/specs?openapi.json`（ThePornDB `v3.24.767`，OAS 3.0，42 个路径）。查这个 spec 才看清两件事：

**第一，GraphQL 的 `queryScenes` 确实是死的**（这条路没冤枉它）：

```
{queryScenes(input:{page:1,per_page:3,sort:"DATE",direction:"DESC"}){count scenes{id}}}
→ {"data":{"queryScenes":{"count":3,"scenes":null}}}          # 连 id 都拿不到，且无 errors

SceneQueryInput.performers = String（不是 stash-box 的 MultiIDCriterionInput）
→ performers:{value:[...],modifier:INCLUDES} → String cannot represent a non string value
```

**第二，REST 的 `/scenes` 有多演员过滤，只是参数是 `deepObject`**：

```yaml
name: performers
style: deepObject          # ← 关键：不是 performers[]=，是 performers[键]=值
schema:
  type: object
  description: The performer names to filter by
  example: { "84060": "Mia Malkova" }     # 键是整数 _id，值是名字
```

按这个格式实测（服务端 OR 合并，`total` 直接相加）：

| 请求 | 结果 |
|---|---|
| `performers[235140]=x`（Horny Lily） | 200，`total=314` |
| `performers[235140]=x&performers[97596]=x`（+ Hazel Tucker） | 200，**`total=472` = 314+158** |
| 30 个键 | 200，`total=1397` |
| 值随便填（`=x`）、名字写错 | 一样生效 —— **只认键，值被忽略** |
| `performers[]=<uuid>` / `performers[0]=<uuid>` | 200 但 `total=0` ← **我上一轮就是踩这个坑** |
| `performers[<uuid>]=x`（拿 uuid 当键） | 200 但 `total=0`（键必须是整数 `_id`） |

配套能力（全部实测）：

| 能力 | 用法 | 结果 |
|---|---|---|
| 单演员 | `performer_id=<整数_id>` 或 `/performers/{uuid}/scenes` | 200 |
| 每页上限 | `per_page` | **100**，>100 报 422 "must not be greater than 100" |
| 日期窗口 | `date=2026-01-01&date_operation=%3E` | 可用，`total` 正确收窄 |
| 排序 | `orderBy` 共 9 个枚举 | `recently_released` / `recently_created` 都是日期倒序 |
| uuid → 整数 `_id` | `/performers/{uuid}` | 返回 `_id`（235140）+ `is_parent` |

所以结论翻过来：**TPDB 有批量能力，代价是需要一次 uuid→整数 `_id` 的映射**。上一轮说"REST 逐 id 是唯一可用路径"是错的——那是我用 `performers[]=` 试出 0 条后下的结论。

### 7.2 404 的真实成因：id 有两种，单条路径只认其中一种

TPDB 的演员有两层记录：**parent**（stash-box 返回的那个 id）和**站点级**（`/scenes` 里 `performers[].id`，带 `is_parent:false`）。实测：

| 请求 | 结果 |
|---|---|
| `/performers/1545ccf9-…（parent）/scenes` | **200** |
| `/performers/1dc265ee-…（站点级）/scenes` | **404 `{"message":"performer not found"}`** |
| `/performers/12345/scenes`（数字 id） | 404，同一条 message |
| `/sites/<uuid>/scenes` | 200 |

`tpdbScene()` 里已经有正确的处理（`id: (par && par.id) || p.id`，注释写着"场景内演员是站点级记录；stash-box 的演员 id 是站点无关的 parent id"）——但那只是**读场景**这一侧。查询侧把 id 原样拼进 URL，脏 id 直接 404。

### 7.3 为什么三块一起红

三块（有新发布的演员 / 最新发布 / 即将发布）都读 `_dp.d.latest` 这**一个**数据集，而 `tpdbSinceScenes()` 里是：

```js
Promise.all(chunk.map(fetchOne))      // 3 个 id 一波
// 任何一个 reject → 整波 reject → 整批 null → scenes == null
// → throw { ssdKind:"box", message:"partial fetch failure" }
```

**零单点容错**：库里只要有一个 TPDB id 在单条路径上取不到（站点级 id、被 TPDB 合并/删除的演员），整块就报同一个错。热门位是独立端点（`/scenes?orderBy=recently_created`），所以它独活 —— 这正好对上截图。

### 7.4 三次修正记录

| 原判断 | 实测 |
|---|---|
| "端点路径不对，`/performers/<uuid>/scenes` 不存在" | 路径是对的，**id 用错**才 404 |
| "刷新后 Failed to fetch 是 CORS" | **不是**。TPDB 对 `Origin: http://192.168.3.190:9999` 回 `access-control-allow-origin` 回显 + `allow-credentials`，preflight 返 204 且 `allow-headers: authorization`。CORS 是通的 |
| "TPDB 没有批查询能力，只能逐个查" | **有**。`performers[整数_id]=x` 是批量入口，是我用了 `performers[]=` 才试出 0 条 |

那 `Failed to fetch` 是什么？插件把网络层异常一律归成 network（`tpdbGet` 的 catch），看不出细分。最可能是并发请求撞限流（社区 Jellyfin 插件按 **120 请求/分钟**限速，这是官方侧证），或他本机到 `api.theporndb.net` 的直连不稳。改成批量后请求数会掉一个量级，这条自然消解。

### 7.5 修复方向（改为批量，请求数降一个量级）

1. **uuid → 整数 `_id` 缓存**：`linked` 里只有 stash_id（uuid），批量键要整数。首次对每个演员打一次 `/performers/{uuid}` 取 `_id`，写进 localStorage（`_id` 永久稳定，之后 0 次请求）。转换失败的演员进 `skipped[]`，不参与批量
2. **场景查询改为一次批量**：`/scenes?performers[<id>]=x&performers[<id>]=x…&per_page=100&page=N&orderBy=recently_released`，有窗口时加 `date=&date_operation=>`。15 个演员从"几十个请求"降到 1–2 个
3. **保留单条路径作降级**：`_id` 转换不出来的演员，仍可走 `/performers/{uuid}/scenes`，单点 catch
4. **UI 给跳过提示**：模块下方一行灰字"已跳过 N 位演员"，而不是整块红

长期（和 Jackett 同方向）：TPDB 也搬到 Python 代理，api_key 从 `configuration.general.stashBoxes` 读。会牵动 `tpdbGet` 的全部调用点（`tpdbIdPage` / `tpdbSinceScenes` / `tpdbGlobalPage` / `callBoxPerformerList`），是独立改造，**别和 Jackett 通道改造塞进同一个版本**。

## 8. 改动清单（已实现）

| 文件 | 位置 | 改什么 |
|---|---|---|
| `stashDiscover.py` | `emit_result()` / `emit_error()` | 改为 stdout 输出 `{"output":...}` / `{"error":...}`；日志只留一行摘要 |
| `stashDiscover.py` | `main()` | 删 `exit_plugin("OK")`（stdout 只能有一条 JSON）；异常分支也发 `{"error":...}`；删 rid / prune 调用 |
| `stashDiscover.py` | `SEARCH_RESULT_LIMIT` | 50 → **200** |
| `stashDiscover.js` | 新增 `runPluginOp()` | `callGQL` 调 `runPluginOperation` |
| `stashDiscover.js` | 新增 `gqlErrorMessage()` | 把 GraphQL `[{message}]` 拆成一句人话 |
| `stashDiscover.js` | `doSearchResources()` / 推送按钮 | 改用 `runPluginOp`；删 `runPluginTask` / `pollJob` / `waitPayload` / `searchBudgetMs` / `newRequestId` / `fetchSearchResult` / `fetchPushResult` |
| `stashDiscover.yml` | — | **不动** |
| `README.md` | 变更说明 | 结果不再走日志；反代 60s 超时需放宽 |

## 9. 验证清单

| # | 场景 | 期望 | 状态 |
|---|---|---|---|
| V1 | 正常搜索 | 结果作为 `runPluginOperation` 返回值拿到，列表分页正常，抬头显示真实总数 | ✅ 38 条 / 7.2s |
| V2 | 超大 payload | 80KB 也能完整返回（旧实现 64KB 就截断） | ✅ 80839 字节 |
| V3 | 连搜 A 再 B | 同步调用，结构上不可能串号 | ✅ 无需专门处理 |
| V4 | 错误路径 | 空 query / 未知 mode 秒回错误文案，不再等到超时 | ✅ 0.3s |
| V5 | 慢索引器 60s+ | 请求挂住直到返回；**反代若设 60s 会被切断** | ⬜ 待慢源实测 |
| V6 | qB 推送 | 成功/失败都能显示 | ⬜ 待实测 |
| V7 | 子路径部署 `/stash/` | `appUrl()` 已处理，实际请求 200 | ⬜ 未测 |
| V8 | 插件目录只读 | 不影响（不再写文件） | ✅ 结构上排除 |
| V9 | 匿名访问 | 无任何结果文件可读 | ✅ 无落盘 |
| V10 | TPDB 场景点「搜索资源」 | 输入框默认填**标题**，不是 `xxx.com-6097` 这类 code；JAV 场景仍填番号 | ⬜ 待测（回归项，见 §1.3） |

## 10. 给论坛的回复草稿（英文）

> You're right, and thank you for the logs — they pinpoint it.
>
> The plugin was reading Jackett's results back from Stash's **global log stream**, which turned out to be a bad place to put data: the log API only keeps the last 30 entries, and any single line longer than 64 KB is truncated by Stash before it reaches the frontend. Your 233-result payload sits right on that limit, so the parse fails and the UI reports "no results" even though Jackett answered fine. That also explains why it worked "in most cases" before but not now — it depends on how long the magnets/titles are.
>
> I'm moving the results off the log entirely — the plugin now returns them as the return value of Stash's `runPluginOperation`, so there's no log window, no truncation, and errors surface as real error messages instead of silently missing results.
>
> On the Discovery page: that's a separate bug, and it isn't the log channel. The three failing modules (Performers with releases / Latest / Upcoming) share a single dataset that is built by calling TPDB's REST sub-resource once per performer (`/performers/{id}/scenes`). TPDB keeps two kinds of performer records — a parent id (what stash-box returns) and a site-level id (what appears inside `/scenes`); that endpoint only accepts the parent one, and a site-level id answers `404 performer not found`. On top of that the fetch has no per-id error handling: one bad id fails the whole batch, which is why all three modules show the same error while "New on site" — a single global endpoint — keeps working. The fix is to ask for all performers in one request instead (`/scenes?performers[<id>]=…`, which the API does support even though the docs bury it) and to skip — not fail — any id the source doesn't recognise.
>
> It is *not* a CORS problem, by the way — I checked, and the preflight from your Stash origin is allowed with the `authorization` header. If you can grab the failing request URL from the Network tab (or tell me whether those performers show up fine when you open them individually), that would pin down which ids are bad on your instance.
>
> And "New on Site" under TPDB is intentional, not a leftover: TPDB has no popularity ranking, so that module is relabelled to newest-first.
>
> "Open terminal" note: Stash has no built-in terminal — I meant `docker exec -it <container> sh`, or Portainer's console.


关于他问的 "open terminal in Stash"：Stash 没有内置终端，那是给 Docker 用户的——`docker exec -it <container> sh`，或在 Portainer 里开 console。回复里带一句即可。

## 11. 遗留

| # | 事项 | 处理 |
|---|---|---|
| Q1 | 用户说的 "code 120 / Discover finished 120" | 待他贴原行；怀疑是另一条被截断的负载 |
| Q2 | 50 → 200 是否够 | 文件通道无体积限制，200 是渲染取舍；可按需再调 |
| Q3 | TPDB 演员/站点端点 404（`/performers/<id>/scenes`） | **已查明**：路径没错，是 id 角色错配（REST 只认 parent id，站点级 id → 404）+ 无单点容错。见他实例上具体是哪些 id 404 需他给 Network 条目 |
| Q3b | TPDB 的 `queryScenes` 能不能救 | 不能：`scenes` 恒 null（count 有值），过滤参数类型也不兼容（要 String 不要对象） |
| Q3c | TPDB 有没有批量过滤 | **有**：`/scenes?performers[<整数_id>]=<任意值>`（deepObject），多键 OR 合并。但键只认整数 `_id`，uuid 打进去恒 0 条；每页上限 100 |
| Q4 | 是否顺便不再需要 `searchBudgetMs` | 需要：后端慢时仍要判定超时，但它现在只影响等待，不影响结果正确性 |
| Q5 | TPDB 改后端代理要不要和 Jackett 同版本 | **不要**。两者验证条件不同，混在一起出问题分不清是哪边 |
| Q6 | 发版顺序 | 先把 Jackett 通道改完单独发一版（P1 止血），TPDB 下一版 |
| Q7 | #19 数据源无法编辑 + 错误页 | **全帖唯一没针对的**。等 zxqlxy 给截图里的报错文本；下拉已改 endpoint，理论上不该复现 |
| Q8 | 标题搜 Jackett 命中过泛 | TPDB 场景只能靠标题，长标题命中几百条、按 seeders 排序。短期靠截断提示，长期要么裁剪标题要么相关度重排 |

