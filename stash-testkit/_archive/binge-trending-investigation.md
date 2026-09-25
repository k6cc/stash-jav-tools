# binge 首页"热门/发现"拉取口径 — 经验沉淀

> 排查自 2026-09-25：用户报告 T38-072（由良かな）在 javstash 首页热门区，但没进 binge 首页热门卡片。

## 一、链路速查（binge-cn 源码）

| 卡片角标 | 种子来源 | GraphQL | 缓存 |
|---|---|---|---|
| **热门**（trending） | `getTrendingStashDBScenes()` | `sort: TRENDING, per_page: 30`，**不带日期过滤** | localStorage `discovery.seeds.v1`，**TTL 12h** |
| **发现**（costar） | `getNewStashDBScenesForPerformers()` | `date: GREATER_THAN sinceDate, performers INCLUDES 已关注演员, sort: DATE DESC` | 共享 newScenes v4 缓存，12h 级 |

关键文件：
- `src/api/stashdb.ts:1037` — trending 查询
- `src/api/stashdb.ts:462` — costar 查询
- `src/home/discoveryFeed.ts:44` — 12h 缓存
- `src/home/discoveryFeed.ts:272-284` — 前端过滤链
- `src/home/useFeed.ts:380` — sinceDate 计算

## 二、前端过滤链（trending 种子 → 最终卡片）

按顺序过滤，满 `MAX_TRENDING_ITEMS = 12` 就停：

1. `owned.has(s.id)` — 用户库里已有 → 跳过
2. `!s.releaseDate || s.releaseDate < sinceDate` — 无日期或早于 lookback 窗口 → 跳过
3. `previewCutoff && s.releaseDate > previewCutoff` — 预告窗口外 → 跳过
4. gender 过滤（`allowedGenders`）
5. `scenesById` 去重（trending 先加载，优先于 costar）
6. headline 演员 `MAX_SCENES_PER_PRIMARY = 2` 上限

## 三、时间基准（排除 UTC/本地分叉）

三处日期**全部**用 `localDateStr()`（`src/utils/date.ts`），不是 `toISOString()`：

- `sinceDate` — `useFeed.ts:380`
- `todayDate` — `useFeed.ts:390`
- `previewCutoffDate` — `stashdb.ts:266`

trending 和 costar **共用同一个 `sinceDate` 入参**（`useFeed.ts:487`）。

**结论**：不存在"发现用浏览器时间、热门用 UTC"的分叉。看到"9-22 的片排在发现卡片上面"只是按 `effectiveAt`（= releaseDate）倒序混排的正常结果。

## 四、实测结论（2026-09-25，javstash.org）

跑 `python probe_trending.py T38-072`：

- **TRENDING top 30**：日期分布 2026-08-25 ~ 2026-09-22，**没有 9-25 当天新片**
- T38-072（由良かな，9-25 新片）**不在 top 30**
- 用户点 refresh 后仍不进 → 排除 12h 缓存

**根因**：stash-box `sort: TRENDING` 按热度算法（favourites / edits / views）排序，**不是按发布日期**。新片需要攒热度才进 top 30。javstash 网页首页"热门"区 ≠ GraphQL TRENDING top 30（口径不同，网页端可能展示更多条或用"最近创建"排序）。

## 五、工具用法

```bash
# 基线：跑 trending + date 对照
python probe_trending.py

# 带关键字：模糊匹配 code / title / 演员名，标记命中位置
python probe_trending.py T38-072
python probe_trending.py 由良かな
```

脚本自动从本地 Stash `configuration.general.stashBoxes` 选 javstash.org 的 box，无需手填 key。

## 六、已知坑（本次踩到）

1. **老版本 Stash 字段位置**：`configuration.stashBoxes` 422，老版本在 `configuration.general.stashBoxes`（坑 ⑥/⑭）
2. **老版本 plugins 查询**：`plugins(include: ["binge"])` 422，老版本语法不同——本工具不读插件配置，直接按 endpoint 含 "javstash" 选 box
3. **javstash 直抓必须带 UA**：裸 urllib 403，需 `ApiKey: <key>` + `User-Agent: stash/1.0.0`（坑 ⑭）
4. **javstash 限流敏感**：请求间 sleep 1.5s（坑 ⑰）
5. **`SceneQueryInput` 不接受 `q` 字段**：按 code/performer 精确查的语法本工具未实现；如需精确查某部片，用 `sort: DATE` 翻页或在 javstash 网页搜

## 七、可选改进方向（未实施）

- `TRENDING_DISCOVERY_PER_PAGE` 30 → 50–100，给新片更多窗口
- trending 种子加 `sort: DATE DESC` 补充查询，和 TRENDING 合并去重——新片即使没攒热度也能进
