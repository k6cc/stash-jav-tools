# nfoSceneParser — tagCreate 失败兜底（v1.7.0）验证结果与经验

> 对应功能：`__find_create_tags` 中 tagCreate 失败后「立即再查」兜底（对齐 javstashAutofill+ v1.2.4）。
> 验证时间：2026-09-23；测试库 Stash：**v0.31.1**（hash 4de2351e）；Tag Merge Auto 插件已启用。

## 一、验证矩阵（全部通过）

| # | 场景 | 方法 | 结果 |
|---|------|------|------|
| 1 | 已合并名（T0 miss → tagCreate None+钩子写别名 → 兜底命中规范 id） | 离线 mock 真实时序 | 命中 210，findTags 2 次，日志 `create-fallback` |
| 2 | 全新名（tagCreate 成功 → 原逻辑） | 离线 mock / 真库 | 用新 id；findTags **仅 1 次**（无兜底重拉） |
| 3 | 真不存在名（None+重拉无命中） | 离线 mock | 静默跳过、不中断 |
| 4 | 已有 tag 双 pass 命中（回归） | 离线 mock / 真库 | 不触发 tagCreate；findTags 仅 1 次 |
| 5 | dry_mode 拦截（回归） | 离线 mock | 行为不变 |
| 6 | 真库兜底分支端到端 | 真实触发 | `SM拘束` → 钩子合并 → None → 兜底命中 **SM id=138**，日志确认，无残留 |
| 7 | 幽灵 id 边界 | 直发原始 GraphQL | **不存在**（见下） |

## 二、幽灵 id 边界结论（重要）

问题：tagCreate 响应带回数据（id）但 tag 已被 `Tag.Create.Post` 钩子合并删除 → 插件 append 幽灵 id？

**v0.31.1 实测（stash-client 直发原始 mutation）**：

| 场景 | 原始响应 | 结论 |
|------|---------|------|
| 首次创建+钩子合并（`轻虐`） | `{"data":{"tagCreate":null}}`，无 errors | 不带 id → 无幽灵 id |
| 已合并名再次创建（`SM拘束`） | errors `name 'SM拘束' is used as alias for 'SM'` + `tagCreate:null` | 不带 id → 无幽灵 id |
| 非映射源名（对照） | `tagCreate:{id:244}`，id 存活 | 正常路径 |

→ 被钩子合并的 tagCreate 一律返回 null/errors，**不会返回已删除 tag 的 id**，`if new_tag:` 分支拿到的都是真实存活 id。跨 Stash 版本如需确认，重跑 `probe_ghost_id.py`。

## 三、可复用经验

### 1. 真库验证兜底分支的前提条件
**必须选「映射表有、库中 name/alias 均无」的源名**（脚本自动挑选候选）。
若用别名已落盘的源名（如 `ギャル`），T0 全量时双 pass 已命中，**走不到 tagCreate，测不到兜底**——那是正常路径回归，不是兜底验证。

### 2. 真实时序模拟（离线单测关键）
兜底竞态的完整时序是：T0 全量（源名还不是别名）→ tagCreate → 钩子合并并写别名 → mutation 返回 None → 兜底重拉（此时别名已落盘）→ 命中。
mock 时必须让 FakeStash 在 `tagCreate` 被调用后**更新内部 tags**（模拟钩子副作用落盘），否则重拉永远 miss。

### 3. 部署副本 ↔ 主仓库（nfoSceneParser-jav）同步
- 部署副本 `E:\stashAPP\plugins\k6cc\nfoSceneParser\` **不在 git 仓库**，与仓库代码唯一实质差异是行尾（仓库 CRLF / 副本 LF）与仓库已移除的 `manifest`。
- 发布时不能整体覆盖仓库，用 `git diff --no-index <repo> <dep>` 提取纯代码差异后**移植到仓库版**；`core.autocrlf=true` 时 git 会自动忽略行尾，哈希对比需先去 `\r\n`。
- 发版三处版本号（yml / README L3 / git tag）必须一致；release.yml 在 `STASH_PLUGINS_TOKEN` 已配置时全自动（zip + sha256 + stash-plugins index.yml + Release）。

### 4. 插件日志捕获
插件 `log.py` 写 stderr 且带 `\x01<level>\x02` 前缀；验证脚本用替换 `sys.stderr` 的 `LogCapture` 即可在 Python 内断言日志（无需解析 Stash 日志文件）。

## 五、与 javstashAutofill+ v1.2.4 的交叉冲突评估（无循环，实测验证）

两插件都监听 `Scene.Create.Post`（javstashAutofill+ 延迟 20s 填充），且都依赖 tagMergeAuto 合并 + 各自 tagCreate 失败兜底。**不会冲突、不会循环**：

1. **单插件无回路**：兜底是「1 次失败 → 1 次只读重拉 → 返回」，无 retry 循环（javstashAutofill+ 最多 pre-check 1 查 + tagCreate 1 写 + fallback 1 查）。
2. **兜底不触发钩子**：兜底命中后返回规范 tag id、**不再发 tagCreate** → 不再次触发 tagMergeAuto 的 `Tag.Create.Post` → 无链式合并；兜底重拉是只读 findTags，不触发任何钩子。
3. **两插件不互相调用**：各自独立函数，只共享 Stash 状态；同一名最终幂等收敛到同一规范 tag（`test_cross_plugin_no_loop.py` 实测：3 轮交替处理，始终返回同一规范 id；未落盘首次两插件 mutation 合计 ≤2，此后 0，无独立残留 tag）。
4. **并发同名 tagCreate 窗口**（理论注意点，非本次改造引入）：两插件同时发同名 tagCreate 时，Stash 唯一约束 + 钩子幂等合并会收敛；"响应带成功 id 但随后被钩子删除"的极端并发窗口串行实测不存在（见第二节），属 tagMergeAuto 三方竞态固有范畴。

既有（与兜底无关）的注意点：两插件都写场景 tag_ids（sceneUpdate 整体覆盖），javstashAutofill+ 的 20s 延迟即为规避顺序竞争而设——此行为 v1.7.0 前后一致。

## 六、脚本说明

| 脚本 | 作用 | 运行 |
|------|------|------|
| `test_tag_create_fallback.py` | 离线单测（5 场景）+ 真库正常路径 | `python test_tag_create_fallback.py offline [插件目录]` / `... live [插件目录]` |
| `test_tag_create_fallback_live.py` | 真库兜底分支端到端（自动挑候选源名） | `python test_tag_create_fallback_live.py [插件目录]` |
| `test_tag_create_success_regression.py` | 真库成功路径回归（findTags 计数=1）+ 自动清理测试 tag | `python test_tag_create_success_regression.py [插件目录]` |
| `probe_ghost_id.py` | 幽灵 id 边界实验（直发原始 mutation） | `python probe_ghost_id.py` |
| `test_cross_plugin_no_loop.py` | 与 javstashAutofill+ 交叉幂等/无循环验证（3 轮交替处理） | `python test_cross_plugin_no_loop.py [插件目录]` |

- 插件目录默认 `E:\stashAPP\plugins\k6cc\nfoSceneParser`，可传仓库目录 `E:\Temp\nfoSceneParser-jav` 对仓库版验证。
- 真库脚本依赖：测试库 Stash 在线（config.json）、Tag Merge Auto 插件启用、`tag_merge_map.json` 存在。
- 依赖 Python + requests（系统 Python 3.14.5 已验证）。
