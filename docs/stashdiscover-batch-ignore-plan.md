# 发现页：忽略 / 批量 / 入库字段 —— 开发备忘

> 起点：论坛用户两条请求（① 入库字段可关，尤其 Tags；② 发现有「忽略」）。本文为后续唯一依据，`stashdiscover-design.md` 不再更新。

## 1. 代码事实（已核实）

| 事实 | 位置 |
|---|---|
| 唯一过滤收口 `filterPipeline()`：已拥有、code 跨源去重、演员分组、`capByActor` 全在此 | `discover.js:777` |
| 「最新」按**库内演员 id 批量查**：`ids = linked.map(stashId)` → `performers:{value:ids, INCLUDES}` | `discover.js:939` |
| 导航红点轮询独立实现，不走 `filterPipeline` | `stashDiscover.js:5192-5305` |
| 演员页发现 tab **无场景级浏览器缓存**（`_state.cachedMissing` 是内存）；但已读写 `SSD:dp:prefs` / `read.v1` / `follow.v1` / `unread.v1` | `stashDiscover.js:600,5244,5288` |
| 已读键 `endpoint:sceneId`（小写），7 天 TTL | `discover.js:1213` |
| 通用分页 `pagerBar(view,total,totalPages,perPage,top)` | `discover.js:2200` |
| 场景入库统一入口 `handleSaveScene(item,btn)`，演员页发现 tab 与发现页弹窗共用 | `stashDiscover.js:4413,3732` |
| 场景入库实际写：title/code/details/date/urls/performer_ids/tag_ids/stash_ids/studio_id/director/cover_image | `stashDiscover.js:4494` |
| 演员入库只写 name/stash_ids/image | `discover.js:2367` |
| **演员字段映射已存在** `buildPerfDetailInput()`：gender/birthdate/death_date/country/ethnicity/hair_color/eye_color/height_cm/measurements/career_length/tattoos/piercings（注释：mirrors JavStashLinker） | `stashDiscover.js:1886` |
| box 演员数据 `searchPerformer` 已覆盖上述 12 字段 + aliases/urls/disambiguation/scene_count，**未选 tags** | `stashDiscover.js:1767` |
| 两步确认组件 `armConfirm(btn,idle,armed,run)`，4000ms 自动回退 | `stashDiscover.js:2383` |
| `performer_ids` 现在只映射**库内已有**演员（`buildLocalPerformerStashIdMap`），不自动建演员 | `stashDiscover.js:4440` |
| `urls` 里硬塞了 box 网页链接，无开关 | `stashDiscover.js:4477` |
| `loadLinkedPerformers` 一次拉全量演员（`per_page:-1`）的 id/name/image_path/stash_ids，**返回时只留带 stash_id 的**（设计如此，用于查询） | `discover.js:365` |
| 场景查询里 box 演员只有 `{id, name, images{url}}`，没有更多字段 | `stashDiscover.js:717,924` |
| 页面 tab 由 `VIEWS` 驱动，不在其中即无入口 tab | `discover.js:3341` |

## 2. 决策表

| # | 决策 |
|---|---|
| C1 | 演员入库要写**源拥有的全部字段**（现状只有 3 个是缺陷）。设置页做字段开关，与场景一起做。注意：补全插件本身也只写源给的内容，**这几个源演员没有 tags**，所以演员 tags 不做 |
| C1b | 场景入库要**自动创建本地不存在的演员**（只有 name + stash_ids，接受空档案），不做开关 |
| C1c | **查询只认 stash_ids，入库才核对名字**。无 stash_id 的本地演员查不到是设计前提，不是缺陷；同 stash_id 不同名视为同一人，本地名称为准；同名关联只判**同源**——无同源 id 就补，已有别的源 id 保留不删；同源但不同值视为不同人，新建 |
| C2 | 单条入库不再用二次确认态，改为**弹窗预览字段**（可勾选/修改），底部 确认/取消，参考 binge |
| C3 | 忽略演员 = 摘除该演员的 stash-box 查询 |
| C4 | 忽略键单源生效：`endpoint:sceneId` / `endpoint:stashId`，不做 code 跨源 |
| C5 | 已忽略管理：设置页首行卡片 → 无入口 tab 的分页视图，顶部 场景/演员 切换，两组都要「还原全部」 |
| C6 | 入库忽略字段：设置页卡片，右侧 场景/演员 两个按钮 → 弹窗；弹窗内全选、必要字段置顶且禁用 |
| C7 | 标签 / 工作室三态（全写 / 只关联已有 / 不写），**默认全写** |
| C8 | 单条忽略：主按钮区最右「拉黑」图标，二次点击确认 |
| C9 | 批量入口：筛选栏多选按钮（768 下不换行）+ 底部浮窗（已选 N · 忽略 · 入库 · 取消） |
| C10 | 只做当前页选择，不做跨页挑选；浮窗不做翻页 |
| C11 | 热门 / 发现演员是外部榜单，**不做忽略处理** |
| C12 | 演员页发现 tab 一起实现 多选 / 忽略 / 入库，与发现页共享记录 |
| C13 | 忽略记录**不做超窗清理**（保留全部，便于日后导出） |

## 3. 数据模型

```js
// SSD:dp:ignore.v1 —— 无 TTL
{
  scenes:     { "stashdb.org:abc-123": { at, title, date, code, cover, studio } },
  performers: { "stashdb.org:9f8e7d": { at, name, image } }
}
```

- 键格式与 `read.v1` 一致 → 演员页发现 tab、导航轮询直接读同一份
- **必须存快照**：只存 id 的话管理页无法显示「288 条是什么」，反查 box 又慢、已下架的还查不到。卡片上现成有，忽略时顺手带上
- 体量：288 条约 80 KB
- 场景被手动加入库 → 入库成功即删该条记录

### 3.1 不做超窗清理

记录只增不删，永久保留。理由：清理会让老片在窗口调大后「复活」，且将来要做导出时数据已经不完整。体量可控（288 条约 80 KB，2000 条约 550 KB）。

代价：忽略记录会随时间单调增长。若日后突破 1 MB，再考虑加手动清理，不做自动。

## 4. 入库弹窗（C2 / C1，本轮最大改动）

### 4.1 两条路径统一

| 入口 | 现状 | 改法 |
|---|---|---|
| 场景 `handleSaveScene(item, btn)` | 直接调 `sceneCreate` | 先构建 input 草稿（含演员建档的四步判定）→ 弹窗 → 确认后提交 |
| 演员 `performerCreate`（外部演员弹窗按钮） | 直接提交 3 字段 | 先按 stashId 拉全字段 → 弹窗 → 确认后提交 |

`handleSaveScene` 是演员页发现 tab 与发现页弹窗**共用**的，改一处两处生效。批量入库无法逐条弹窗 → 吃设置默认值。

### 4.2 弹窗内容

**场景**（每项可勾，带当前值预览）：

| 项 | 可勾 | 说明 |
|---|---|---|
| title / date / details / director / cover_image | ✓ | 默认按设置 |
| urls | ✓ | 现在会硬塞 box 网页链接，弹窗里拆两行（源链接 / 网页链接） |
| performer_ids | ✓ | 显示「关联 M 位已有 · **新建 N 位**」 |
| tag_ids | 三态 | 显示「匹配 M 个已有 · **将新建 N 个**」 |
| studio_id | 三态 | 显示「已匹配 / **将新建**」 |
| code / stash_ids | 禁用 | 必需字段，置顶灰显 |

**演员**：12 个可映射字段 + aliases + urls + tags + image。直接复用 `buildPerfDetailInput()`，把 Update 语义改成 Create（`need()` 恒为 true）。

### 4.3 顺带解决论坛的痛点

弹窗里那句「**将新建 N 个标签**」比设置里的静态开关直接 —— 用户看到数字就知道该不该勾。设置里的三态是默认值，弹窗里可临时改。

### 4.4 数据缺口

演员要写全字段，得**按 stashId 再查一次 box**（现有弹窗数据只有 name/image/stashId）。`searchPerformer` 已覆盖 12 字段，需补 `tags`。一次额外请求，弹窗打开时要有 loading 态。

box 侧拿不到的（weight / fake_tits / penis_length / circumcised / details）不要出现在弹窗里，避免空行。

### 4.5 演员建档的匹配规则（C1b / C1c）

两条铁律：

- **查询只认 stash_ids**：没有 stash_id 的本地演员不参与发现查询。这是设计前提，不是缺陷，不修。
- **只有入库才核对名字**，且只在「本地找不到该 stash_id」时才核对。

入库遇到源演员时的判定顺序：

| 步 | 条件 | 动作 |
|---|---|---|
| 1 | 本地有**同源同值** stash_id 的演员 | 直接用其 id。**不比名字、不改名**——源名不同也是同一人，本地名称为准 |
| 2 | 本地无此 stash_id，有同名演员（`normalizedName` 全等）且该演员**没有同源 id** | 直接关联：`performerUpdate` 补上此 id，用其 id。该演员已有的**其他源 id 一律保留，不删不改** |
| 3 | 同名演员**已有同源但不同值**的 id | 说明是两个人 → 新建，不合并、不覆盖 |
| 4 | 无同名 | `performerCreate({ name, stash_ids:[{endpoint, stash_id}] })` |

判定只看**同源**这一维：`stash_ids` 本来就是多源数组，一个人身上同时挂 stashdb 和 favdb 的 id 是正常状态，不能拿「已有别的源 id」当不同人的证据。只有同源 id 打架才是不相容。

**零额外查询**：`buildLocalPerformerStashIdMap` 本来就 `findPerformers(per_page:-1)` 拉了 id/name/image_path/stash_ids，只是只按当前 endpoint 建了 id 索引。在同一次响应里顺手建 name 索引即可，不加请求。注意触发点有两处（`discover.js:365` 的 `loadLinkedPerformers` 和 `stashDiscover.js:1206` 的 `buildLocalPerformerStashIdMap`），如果入库路径复用后者，索引就建在后者里。

**两点实现坑**：
1. 第 1 步的判定现有代码已是对的（`sid.endpoint.toLowerCase() === endpoint`），改的时候别退化成只比 stash_id 数字。
2. `performerUpdate` 的 `stash_ids` 是**整体替换**，第 2 步补 id 必须写成「原有数组 + 新条目」的合并，否则会把该演员身上其他源的 id 全冲掉 —— 这正是「不同源 id 不删除」的落地要求。

**匹配率上限**：`normalizedName` 只处理 NFC / 大小写 / 空白。box 名带别名的（`三上悠亜 (Yua Mikami)`）与本地名不相等 → 落到第 4 步新建。不做 aliases 比对（场景查询里演员只有 `{id, name, images}`，拿 aliases 要额外请求）。

新档案只有 name + stash_ids（box 场景数据里演员只有 `{id, name, images}`）。不带头像：`fetchImageDataUrl` 每张要跨域拉一次，10 个演员就是 10 次外链请求，批量时不划算。

批量入库还要注意：
- 建过的演员要记进内存 `createdMap`，否则同一演员在后续场景里被重复创建
- 串行执行，避免同一演员并发建档产生两条
- 弹窗 / 汇总里报「新建 N 位演员」，让用户知道库里多了东西

### 4.6 明确不做的

- **不做同名只读匹配**（原计划的 P0 取消）。查询输入只来自带 stash_id 的演员；库里「有同名但没关联」的人查不到，符合设计。
- **不删、不覆盖本地演员已有的其他源 id**（见上表第 2 步）。
- **不做别名匹配**（见上）。

## 5. 忽略场景

### 5.1 生效点（三处，缺一不可）

1. `filterPipeline()` 入口剪掉 → 最新 / 关注分组 / 本地有更新 / 工作室 / 总览计数 / 未读角标一次全生效
2. 导航红点轮询（`stashDiscover.js:5305` 后的统计循环）→ 否则页面看不见但红点还在数
3. 演员页发现 tab 渲染处 → 它现在只读已读做角标统计、不隐藏已读场景，忽略要单独加 filter

### 5.2 撤销

4 秒可撤销 toast：「已忽略 · 撤销」/「已忽略 N 项 · 撤销」。

## 6. 忽略演员

### 6.1 主生效点

`refreshDiscover` 构建 `ids` 后 filter 掉被忽略的 stashId —— 真不查，省流量。

### 6.2 缓存穿透（必须处理）

`newScenes` 缓存命中时不走 `refreshDiscover`，旧缓存里仍有被忽略演员的场景。只摘查询会出现「忽略了，刷新还在，过一阵又没了」。

双保险：
- 摘查询（网络路径）
- `filterPipeline` 再加一条：场景的库内演员**全部**被忽略才跳过（缓存路径也覆盖）

两条口径等价：场景由 A（忽略）、B（正常）共同出演 → B 的查询能返回 → 判定「并非全部被忽略」→ 保留。即「其他演员兜底」。

### 6.3 连带

- 关注了 A 又忽略 A → 关注 tab 该分组静默消失。建议顶部灰条「已忽略 N 位关注中的演员 · 管理」
- 该演员自己的发现 tab → 整页占位「该演员已忽略」+ 恢复按钮

## 7. 已忽略管理页

- 设置页首行卡片：左 `已忽略：N 部场景 · M 位演员`，右按钮「已忽略管理」
- `?view=ignored`，不进 `VIEWS`（无入口 tab）
- 顶部 场景 / 演员 切换；复用 `pagerBar()`；排序为忽略时间倒序（最近的可反悔）
- 卡片点开仍是详情弹窗，主按钮变「恢复显示」
- 两组各一个「还原全部」→ **弹窗确认**：写明「将恢复 N 部场景 / N 位演员，此操作不可撤销」，主按钮用危险色。不用 4 秒两步确认（那个适合误碰防护，不适合大批量不可逆操作）
- 288 条需要搜索（复用现有搜索框，作用于标题 / 演员名）
- 不做「超期记录已清理」提示（因为不再清理）

## 8. 批量选择

- 筛选栏「多选」按钮进入选择模式，卡片左上出现勾选圈；选择模式下点卡片 = 选中
- 底部浮窗：已选 N · 忽略 · 入库 · 取消；Esc 退出
- 网格 / 列表都要支持
- 场景卡（最新 / 关注 / 工作室 / 钻取）与演员卡可选；工作室卡不可选
- **只当前页**，「全选」也只全选当前页

## 9. 批量入库

- 串行 + 节流（`_boxRateLimiter` 管的是 box 查询，管不到本地 GQL，需另加）
- 演员建档在场景创建**之前**完成；个别演员建档失败 → 跳过该演员继续建场景（不中止整条），末尾汇总「跳过 N 位演员」
- 浮窗进度 `3/12 入库中…` + 失败计数 + 结束汇总「成功 10 · 跳过 1 · 失败 1 · 新建演员 8 位」
- 重复 code 跳过（入库前对 ownedKeys）
- 失败项保留可重试
- 切页 / 关页面提示

## 10. 待定稿

| # | 问题 | 倾向 |
|---|---|---|
| Q2 | 管理页卡片点开后的主按钮 | 变「恢复显示」，其余只读 |
| Q4 | 关注了 A 又忽略 A | 灰条提示 + 管理入口，不静默消失 |
| Q5 | 演员页发现 tab 遇到被忽略的场景 | 隐藏 + 顶部一行「已隐藏 N 个已忽略场景」 |
| Q6 | 演员页发现 tab 遇到自己被忽略 | 整页占位 + 恢复按钮 |
| Q9 | 忽略记录导出 JSON（localStorage 会被清缓存搞丢） | 管理页给导出按钮，导入暂不做 |
| Q10 | 二次确认超时 | 已有 `armConfirm()` 4000ms，直接用 |
| Q11 | 图标 | 新增 ban（拉黑）+ select（多选），现有 19 个里没有 |
| Q12 | 忽略快照 | 存（见 §3） |
| Q13 | 管理页排序 | 忽略时间倒序 |
| Q15 | 弹窗里改的勾选是否写回设置 | 不写回，仅本次生效 |
| Q16 | 场景入库弹窗里 urls 拆两行 | 拆，网页链接默认勾 |
| Q17 | 演员建档时同名要不要关联 | **已定：做，按同源判定**（见 §4.5）—— 本地同名演员**没有同源 id** 就补 id 关联；已有别的源 id 照常补、不删；同源不同值才新建 |
| Q18 | 演员建档时要不要带头像 | 不带。每个头像要跨域拉一次，10 个演员 10 次请求，批量不划算 |
| Q19 | 弹窗里「新建 N 位演员」是纯信息还是要能取消 | **已定：纯信息**，不做开关（建档无条件） |
| Q20 | 同 stash_id 不同名 | **已定：同一人，本地名称为准**，不因源名覆盖本地名 |
| Q21 | 「最新」覆盖范围要不要因同名匹配扩大 | **不做**。查询只认 stash_ids，无 id 的演员查不到是设计 |
| Q22 | 同名演员身上其他源的 stash_id | **保留，不删不改**。多源 id 共存是正常状态 |

## 11. 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| P1 | 忽略场景：单条 + 撤销 + 存储 + 三处生效点 | — |
| P2 | 忽略演员：查询摘除 + 缓存双保险 + 连带视图 | P1 存储 |
| P3 | 管理页（切换 / 分页 / 搜索 / 恢复 / 还原全部） | P1/P2 |
| P4 | 入库弹窗（场景 + 演员全字段）+ 场景入库演员建档 + 设置页字段开关 | 复用 `buildPerfDetailInput`、`normalizedName`；建档按 §4.5 四步判定 |
| P5 | 批量选择（先只接忽略）+ 批量入库 | P4 必须在批量入库前 |
| P6 | 演员页发现 tab 接入（多选 / 忽略 / 入库） | P1-P5 |

## 12. 待实测

- **T1**：ipad mini（768）筛选栏单行余量，加多选按钮（约 30px）后是否仍不换行。不够则收搜索框 + 减按钮间距
- **T2**：288 条忽略记录在 `filterPipeline` 的比对开销（不要每场景一次 localStorage 读取，先读一次转 Map）
