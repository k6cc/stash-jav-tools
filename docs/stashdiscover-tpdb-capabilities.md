# TPDB 能力边界（vs stashdb / javstash）

> 实测日期 2026-10-28，实例取自本机 stash-box 配置里的 theporndb key。
> 结论全部来自实打实的请求，不是文档推断。凡标注"实测"的都有原始返回可复现。

## 1. 一页结论

TPDB 是**另一个产品**，不是 stash-box 的等价实现。它挂了 stash-box 的 GraphQL 外壳，但只实现了 11/36 个 query，
且其中 2 个（`queryScenes`、`queryPerformers`）字段返回空。插件现在对它是"多套 REST 补丁叠起来用"，
不是"少几个字段"。

| 类别 | 状态 |
|---|---|
| 单条读（findScene / findPerformer / findStudio / findTag） | ✅ 完整可用，结构与 stash-box 一致 |
| 单条搜（searchPerformer / searchScene） | ✅ 可用，但**没有 count、没有分页** |
| 列表/过滤（queryScenes） | ❌ `count` 有值、`scenes` 恒 null |
| 列表（queryPerformers） | ⚠️ 能翻页，但 gender / images / scene_count 恒空 |
| 工作室维度 | ❌ GraphQL 无 `queryStudios`，只能走 REST `/sites/{id}/scenes` |
| 全站遍历 | ⚠️ 硬顶 1 万条，第 100 页之后数据错乱 |
| 热度/趋势 | ❌ 没有该排序维度 |

## 2. GraphQL 接口差距

| | stashdb / javstash | TPDB |
|---|---|---|
| query 字段总数 | **36** | **11** |
| 场景列表 `queryScenes` | ✅ | ❌ 恒 null |
| 演员列表 `queryPerformers` | ✅ 全字段 | ⚠️ 部分字段恒空 |
| 工作室列表 `queryStudios` | ✅ | ❌ **schema 里没有这个字段** |
| 站点/分类 `querySites` `querySiteCategories` `queryTagCategories` | ✅ | ❌ |
| 演员搜 `searchPerformers`（返回 `{count, performers}`） | ✅ | ❌ 只有 `searchPerformer`（返回裸数组） |
| 场景搜 `searchScenes` | ✅ | ❌ 只有 `searchScene(term, limit)` |
| `searchStudio` `searchTag` `findTagOrAlias` | ✅ | ❌ |
| 草稿/编辑 `findDrafts` `findEdit` `queryEdits` | ✅ | ❌ |
| 通知 `queryNotifications` `getUnreadNotificationCount` `queryModAudits` | ✅ | ❌ |
| 重复检测 `queryExistingScene` `queryExistingPerformer` `fingerprintClusters` | ✅ | ❌ |
| `version` `getConfig` `findUser` `queryUsers` | ✅ | ❌（只有 `me`） |

`searchPerformer` 这个单数版在 stashdb 上**也能用**（返回数组），所以插件当前那句查询三源通吃，
不是 bug。但它是无 count 的裸数组，拿不到"共 N 位"。

## 3. 字段能取到，数据是空的

这两个不是 schema 问题，是数据不填。插件必须按"可能为空"处理。

| 字段 | 实测 | 影响 |
|---|---|---|
| `Scene.director` | `null` | 入库后 director 永远空 |
| `Scene.production_date` | `null` | 同上 |
| `Scene.duration` | `0`（REST 也是 null） | 时长徽章、时长字段无值 |
| `queryPerformers` 的 `gender` | `null` | 演员列表性别空 |
| `queryPerformers` 的 `images` | `[]` | 头像空 |
| `queryPerformers` 的 `scene_count` | `0` | 作品数空 |
| REST `/performers` 的 `extra.gender` | 抽样 20 条 **20 条全 null** | 插件靠它补性别 → 补不到 |
| REST scene 的 `rating` / `trailer` / `format` | 抽样 20 条：rating>0 **0**、trailer **1**、format **0** | 别指望这三个字段 |

**演员性别只有单条 `findPerformer` 拿得到**（Abella Danger → `FEMALE`、`1995-11-19`、`US`、2 个别名、3 张图）。
批量入库时每个演员要额外打一次单条请求，这是 TPDB 的固有成本。

## 4. REST 才能做到的事（写法都对过）

| 需求 | 正确写法 | 备注 |
|---|---|---|
| 按演员批量取场景 | `/scenes?performers[整数_id]=x&performers[整数_id]=x` | 多键 OR；**值被忽略**，只认键；键必须是整数 `_id`，uuid 当键返回 0 条 |
| 按标签批量取场景 | `/scenes?tags[整数_id]=x` | 有效（`Threesome (BTT)` → 9 条）。`tag_id=` **无效**（静默返回全局总数） |
| 按工作室取场景 | `/sites/{uuid}/scenes` 或 `/sites/{整数id}/scenes` | 两者都通；uuid 与 `findStudio` 的 id 一致 |
| 单条场景 | `/scenes/{uuid}` | 也能用 GraphQL `findScene` |
| 全文搜场景 | `/scenes?q=Abella` | 1790 条命中；这不是替代 `queryScenes` 的过滤，只能做关键字 |
| 增量变更 | `/changes/scenes?from=YYYY-MM-DD` | **只能回溯 14 天**（更早的 `from` 直接 422）；只返回 `id`/`uuid`，要再逐条取 |
| uuid → 整数 `_id` | `/performers/{uuid}` | 返回 `_id` 与 `is_parent`；`_id` 稳定，可永久缓存 |

## 5. 硬限制

| 限制 | 实测 |
|---|---|
| 每页上限 | `per_page` 最大 **100**，101 直接 422 |
| 总条数上限 | `meta.total` 恒 ≤ **10000**，无论过滤条件多宽 |
| 深分页 | `page=100` 与 `page=101` **返回同一批数据**；`page=200` 返回的是错位内容。即最多可靠翻 100 页 |
| 排序 | `orderBy` 只有 9 个枚举，无热度、无评分。`recently_released` 会把**未来发布日期**顶到最前（实测首条 2027-01-27） |
| 方向 | `direction=ASC` 被忽略；插件现在用"页号镜像 + 页内倒序"绕 |
| 增量窗口 | `/changes` 最多回看 14 天 |
| 演员 id 两层 | REST 只认 parent id；站点级 id（`is_parent:false`）打 `/performers/{id}/scenes` 直接 404 |
| 性别枚举 | REST 里有 `TRANSGENDER_FEMALE` 等值，插件 REST 分支只映射 MALE/FEMALE，其余被丢成 null |

## 6. 封面死链：这不是小问题

抽样 20 条场景的 `image` 字段（插件封面首选）：**可直连 1 条，不可用 9 条（10 条样本中）**。

原因：TPDB 的 `image` 绝大多数是**外站直链**（cruel-handjobs / manyvids / phncdn），带防盗链，
直连直接 SSL EOF 或 403。TPDB 自托管的 `poster` / `background` 才稳定（实测 200）。

插件现在按 `image → back_image → background → poster` 顺序逐张 onerror 回退。
代价是每张卡先发 1–3 个注定失败的跨域请求，2 屏卡片就是几十个失败请求 —— 首屏慢的一部分来自这里。

**可选改法**：TPDB 源下把 `poster` / `background` 提到回退链最前，`image` 降到末尾（或直接不用）。

## 7. 对插件功能的实际影响

| 功能 | 在 TPDB 源下的状态 |
|---|---|
| 「最新」/「关注」/总览三块 | 靠 REST 按 id 取，能用；但并发下容易整批失败（已知，见 jackett 文档 §7.3） |
| 「热门」tab | 无热度，已改名「网站上新」，走 `recently_created` |
| 工作室维度 | 能用，但只能走 REST `/sites/`，GraphQL 无接口 |
| 标签维度筛选 | REST `tags[整数id]` 可用；插件当前**没实现**按标签查源 |
| 演员卡片性别/头像 | 列表拿不到，只有单条有 |
| 场景详情弹窗 | 结构一致，能用；director / production_date / duration 空 |
| 场景入库 | 能写；上述空字段跟着空。演员必须额外单条查性别 |
| 演员入库 | 能写；gender / 身高 / 三围等大多空（TPDB 单条也只填部分） |
| 忽略演员（摘除查询） | TPDB 下查询本来就是按演员逐个发，忽略一个就少一串请求，**效果比别的源更明显** |

## 8. 待验证清单

按影响排序，每条都写清"怎么验证、失败长什么样"。

| | 待验证 | 为什么重要 | 怎么验 |
|---|---|---|---|
| V1 | 演员性别批量补齐的成本 | 场景入库要建缺失演员；每个演员额外一次单条请求，批量入库 20 个演员 = 20 次请求 | 拿库内 20 个 TPDB 演员 uuid 跑 `findPerformer`，看耗时与 null 比例 |
| V2 | 封面改用 `poster` 优先的收益 | `image` 90% 死链，白跑请求 | 抓 20 张卡的请求数与时序，对比改前改后 |
| V3 | `/changes` 14 天窗口能否替代日期窗口 | 现在"刷新"是按 `date > since` 逐个演员重拉，请求量 O(演员数)；changes 一次能拿全量变更 id | `from` 取 13 天前，看返回量与是否覆盖增量需求 |
| V4 | 分页 1 万条上限的实际影响 | 「网站上新」翻到第 100 页后数据会重复/错位 | 前端翻页条在 TPDB 源下的行为；必要时把翻页上限写死并提示 |
| V5 | 未来发布日期混入「最近 N 天」 | 实测首条是 2027-01-27，`date > since` 会把它算进窗口 | 窗口设为 7 天，看是否出现未来日期卡片 |
| V6 | 站点级 id 混入库内的概率 | 一旦有，`Promise.all` 整批 404；这是论坛那位的症状来源 | 遍历库内 TPDB 演员 id，打 `/performers/{id}/scenes` 统计 404 比例 |
| V7 | `queryPerformers` 的 `names` 精确匹配可靠性 | 若可用，入库时按名字找已有演员可以不依赖全量拉取 | `names:"Abella Danger"` → 实测 1 条命中，但只有 1 个样本 |
| V8 | TPDB 的 `date` 与 `release_date` | 已抽查 6 条一致 | 抽样 50 条确认后可以只用其中一个 |
| V9 | 演员别名（aliases）匹配 | TPDB 单条返回别名，可用于入库时的同名匹配 | 拿别名与本地库比对，看能否减少重复建档 |
| V10 | `/scenes?q=` 能否做源内场景搜索 | 发现页现在只能在已加载数据里过滤 | 关键词搜 3–5 个，看命中质量与 `most_relevant` 排序 |

## 9. 已经明确不做的事

- **不补 `queryStudios` 的等价实现**：TPDB 没有工作室搜索接口，`/sites` 只有列表与详情，做"工作室搜索"要客户端全量拉。
- **不用 rating / trailer / format**：数据 0/20，没有可用性。
- **不指望热度榜**：没有这个维度，改名「网站上新」是唯一诚实的做法。
- **不做 TPDB 的电影（movies）关联**：`Scene` 类型没有 movies 字段，`/movies` 是独立实体，无法从场景反查。
