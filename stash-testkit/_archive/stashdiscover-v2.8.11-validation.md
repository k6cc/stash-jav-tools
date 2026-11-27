# stashDiscover 2.8.11 回归验证（2.8.9 → 2.8.11，2026-11-27）

2.8.11 发版前的全量回归：先只记录不改，全部测完再逐条修，改完逐条复测。本文件是**结论与证据索引**，
过程与逐条证据在插件仓库 `docs/archive/stashdiscover/`（`回归报告-2.8.11.md` / `回归发现-2.8.11.md`），可复用回归提示词在同仓库 `docs/dev/stashdiscover/回归测试提示词.md`。

## 环境

- Stash v0.32.0 / 实例 `http://127.0.0.1:9999`；插件安装目录 `E:\stashAPP\plugins\k6cc\stashDiscover`（非软链）
- 源：javastash `https://javastash.org/graphql`（api_key 已配）、stashdb.org、theporndb
- 界面语言 en-US（`isZh()` 实测 false），主题 Flexoki 暗色；演员 43 = AIKA（双源 ID）
- 基线偏好 `SSD:dp:prefs`：`{tagButton:true, trendSub:"popular", popRange:"since", popSince:"2026-10-28", sort:"title", askTags:false, source:"javastash"}`

## 结论

| ID | 结论 | 一句话证据 |
|---|---|---|
| F1 | 已修 | 英文 UI 下标签面板选「中出し」→ 工具栏 `StashDB has no tag 中出し · skipped`，整屏无中文残留 |
| F2 | 已修 | 场景弹窗 `{"role":"dialog","ariaModal":"true","label":"Scene details","close":"Close"}`，Esc 仍可关 |
| F3 | 已修 | 断源后页头 `— scenes / — performers`，tip `Counts are unknown, not zero: No linked performers on this source…` |
| F4 | 已修 | 断源期间状态行只有 `2/4 failed · 13:36:11`，不再并列 `updated just now` |
| F5 | 已修 | Latest / Upcoming 给 `-` + 说明 + Retry，不再写 `No unowned new scenes` / `No upcoming scenes` |
| F6 | 已修 | 25 个 `SSD:dp:*` 全写坏后重载：badCount 0、okCount 8、24 卡、163/108、控制台 0 错误 |
| F7 | 已修 | `prefs` 写成 `<<<garbage` 后重载：键被删除（`prefs: null`），页面按默认运行 |
| D1 | 无需改 | Phase 20 记录（`K1-K4-decisions.md`）已写明 `tag = 起始日 \|\| "all"`；testkit `SCRIPTS.md` 的旧描述本轮一并改掉 |
| D2 | 已改文档 | 提示词第五节还原口径改成「以动手前快照为准」+ 实测基线，不再写 `all / 空 / trending` |
| O1 | 已修 | 注入 `QuotaExceededError`：首次出现 `.ssd-toast.show`（8s），清掉后再触发**不再弹**，`prefs` 未被污染 |
| O2 | 无需改 | 真写满 4 MB 仍能改范围并持久化（替换键时新值更小），「配额满」挡不住小改动 |
| O3 | 已修 | TPDB 源下 tab `New on site` + tooltip `ThePornDB has no popularity ranking…`；切回 `Trending` 且 title 清除 |
| O4 | 已修 | 日历边线 `rgb(174,174,174)` → `rgb(48,64,77)`；几何不变：卡 212×209 / 表头 56 / 日格 24 / 箭头 32 / 选中 `rgb(33,107,165)` |

另：7 条「假 bug」判定为非缺陷（合成 click 不产生 mousedown、375 hover 点到视口外、探测脚本选项文案写错等），清单在 `回归发现-2.8.11.md` C 类。

## 修改与校验

- 改动集中在 `discover.js`（F3–F5、F6/F7、O1、O3）、`stashDiscover.js`（F1、F2）、`stashDiscover.css`（O4）。
- 每次改完：`node --check` → 纯 LF（`crlf=0`）→ 复制到安装目录 → 5 文件 MD5 全 `same` → `mutation{reloadPlugins}` → 探针复测。
- 最终 `discover.js` 7344 行、`stashDiscover.css` 5555 行。

## 限制

- 本机 Stash 配置里没有 `ui.theme` 键，**亮色主题无法真机切**；O4 的 fallback 色在亮色下的观感未实测（暗色已量）。
- 本机 TPDB 只有测试加的 3 工作室 + 4 演员，发现页三块完整渲染未覆盖（适配层另见 `probe_tpdb_api.py`）。
- 回归中一次环境事故：stash-box 的 javastash endpoint 被打成 `javastash.org`（多一个 a）导致全线 NXDOMAIN，
  与插件无关，判定与修法见 `PITFALLS.md`「数据与标识」域名条。

## 脚本

本轮新增/复用的探针见 `../tests/stashDiscover/SCRIPTS.md`「回归与故障注入」（含断源夹具 `boxes_break.gql` / `boxes_fix.gql` 和通用 runner `page_eval.py`）。完整回归套件（C1–C6 + 断源组，30+ 场景脚本与证据）在 `E:\stashAPP\devtools\regress_2811\`。
