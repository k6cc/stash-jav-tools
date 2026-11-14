# stashDiscover v2.8.0 发版前验证（2026-11-14）

**结论：四条修复全部实测通过；一条已知偏差（骨架与真实卡差 0~22px）写入 PITFALLS。**
本文是一次性验证记录，机制型结论已进 [PITFALLS.md](../tests/stashDiscover/PITFALLS.md) 与主 README「插件 UI」节，
这版改了什么见 [HISTORY.md](../tests/stashDiscover/HISTORY.md)。

环境：Stash v0.31.1 本机实例（`http://127.0.0.1:9999`），源 = javstash（可达）。

## 1. 设置页测试弹窗（点击泄漏 / 遮罩 / Esc / 样式）

用 CDP 真实指针事件，量 `.setting-group` 高度（收起 132 / 展开 1338）：

| 操作 | 弹窗 | 卡片高度 |
|---|---|---|
| 面板内点击 | 保持打开 | 132 |
| 面板内拖到设置页空白处松手 | 保持打开 | 132 |
| 面板内拖到遮罩上松手 | 保持打开 | 132 |
| 遮罩轻点 | 关闭 | 132 |
| 对照：直接点卡片头 | — | 132 → 1338 |

遮罩上滚 4 格背景 `scrollY` 保持 0；Esc 关闭；X 按钮实测色 `rgb(206,205,195)`（深底可见）。

## 2. 总览骨架占位 + 模块局部刷新

标准档（csize=1），冷加载（先清 `newScenes`/`trending`/`studios` 缓存）：

| 模块 | 骨架 | 落地 | 差 |
|---|---|---|---|
| actors | 100 | 100 | 0 |
| latest | 626 | 648 | +22 |
| trending | 325 | 346 | +21 |
| preview | 325 | 346 | +21 |
| studios | 325 | 326 | +1 |
| performers | 100 | 100 | 0 |

- 页头元素身份全程保持（`headKept:true`）→ 没有 `innerHTML=""` 整页重建；模块节点被替换
  （`secTagsKept:false`）→ 局部刷新确实生效。
- 整页高度 1873~1917（抖动 44px）。原问题是整页重建造成的 51px 跳，现在是模块内一跳。
- 差 21px 的原因：真实卡高度由内容撑开（长标题/角标多一行），骨架按典型卡高铺。不是几何错误。

## 3. 演员页「发现」tab 分页终止判据

mock `queryScenes`（`localStorage` 切 `SSD:probe.tabMode`），点「下一页」看是否继续：

| 模式 | 源行为 | 实测 |
|---|---|---|
| normal | 每页回满、count 正确 | 2 请求 / 40 张 / 第 2 页由本地缓存覆盖，0 新请求 |
| clamp | 每页只回 20、count=5000 | 翻到第 6 页共 240 个（每页 +40）；改前停在第 1 页 40 个 |
| ignore | 同批重发、count=0 | 首屏命中本地缓存，第 2 页没发请求 → 未测到（脚本给 hint） |

detail 显示第 2 页起 `per_page` 由 100 降到 20 —— 源压页时插件自适应，这正是「没回满」判据会误判的原因。

## 4. 查询层与本地快照

- 刷新窗口内 `configuration{plugins}`（23.8 KB/份）：**5 → 1** 次；本地 GQL 8 → 5 次。
- 冷加载残留的 2 次经 `new Error().stack` 确认来自 peekaboo 插件（`plugin/peekaboo/javascript:loadConfig`），
  不属本插件，未处理。
- 一次刷新总下载 3.2 MB / 10 请求，其中 `queryScenes` 4 次共 3.1 MB（p50 4.7s）—— 源侧单查询本身贵，
  本次不涉及。
- 本地快照：`owned.v1` 1.8 KB / 37 键、`linked.v1` 17.5 KB / 107 人；旧 `local.v1` 读时迁移并删除。
  模拟配额满：只出 1 条 `console.warn`，两次调用不重复报，页面照常。

## 回归脚本

`scripts/probe_overview_placeholder.js`、`scripts/probe_tab_paging.js`、`scripts/probe_req_dist.js`，
用法见 [SCRIPTS.md](../tests/stashDiscover/SCRIPTS.md)。
