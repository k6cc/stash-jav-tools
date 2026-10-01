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

## Jackett 搜索链路

- 前端 `runPluginTask(stashDiscover, Search Resources)` → 后端查 Jackett Torznab → 结果 JSON 以 `[SSD_RESULT]` marker 写 stderr → 前端轮询 Stash `logs` 匹配 marker（logs 新→旧，**正序第一个即最新**）。
- `jackettUrl` 支持只填根地址（`http://host:9117`），后端自动补全 `/api/v2.0/indexers/all/results/torznab`；`apikey` 参数必带。
- 结果排序：带磁力优先，再按 seeders 降序；搜索词自动推断（jav 用番号、欧美用标题），结果区顶部搜索框可改词重搜。

## 显示口径

- 品牌映射 BRAND_MAP：`javstash.org→JAVStash`、`stashdb.org→StashDB`、`theporndb.net→TPDB`（「在 xx 查看」按钮、来源角标统一）。
- 弹窗滚动：点搜索时滚动一次露出 loading；结果原位替换不再滚动。

## 实测环境

- 实例 `http://localhost:9999`（登录 k6cc / 3321）；演员 **43 = AIKA**（javstash + stashdb 双源）；非本地映射演员用篠田ゆう（javstash）。
- Jackett 实例：`http://192.168.3.190:9117`（API key 在实例插件设置）。
- 浏览器实测用 Chrome DevTools MCP：点击后**轮询等元素出现再断言**（异步渲染/预载/回填，立即 evaluate 会读到中间态）。
