# sceneTranslateAuto v1.3.0 — scan_all 批量任务验证

v1.3.0 对 Full Scan & Translate 批量任务做了三项改动：新增 dry-run 审计任务、单场景翻译异常隔离（不再整组失败）、统计拆分为场景/图库独立计数。新增 `test_scan_all.py` 8 项单元测试覆盖。

## 测试结果（全部 PASS）

| 用例 | 验证点 |
|---|---|
| A1 multi-page aggregation | total>500 时多页 findScenes 结果全部收入 needed，第 3 页空列表终止 |
| A2 language pre-check filtering | 已译中文场景不进入 needed；title 或 details 任一需译即进入 |
| A3 empty library immediate return | needed=0 时无翻译调用，进度直接 1.0 |
| A4 dry-run no translate + audit stats | dry_run=true 不调用 translate_entity；返回 total_scenes/need_translate/title_need/details_need/galleries_need/cache_skip；log_audit 记录每条目标明细 |
| A5 single-scene exception isolation | batch 内一个场景 translate_entity 抛异常时，同组其他场景正常翻译；scenes_failed=1, scenes_translated=1 |
| A6 cache-hit with gallery-only need | 场景缓存命中但关联图库需译时，场景不写回（translate_entity 返回 None），图库被翻译 |
| A7 progress reporting | 每 batch 后进度递增，最终 1.0，所有值在 [0,1] |
| A8 split return values | 返回 scenes_translated/galleries_translated/scenes_failed；旧 done/failed 键已移除 |

## 回归测试

- `test_v123_optimizations.py`（13 项）：快照防顺延 / google_free 逐 q / zh 汉字占优判据 — PASS
- `test_race_guard.py`（8 项）：translate_entity 写回前重读竞态保护 — PASS
- `test_guard_lang_delay.py`（7 项）：语言守卫 + worker 入队延迟 — PASS

## 已知未修项（讨论后确认不修）

- 番号+英文演员名（如 `ABC-123 Jane Doe`）被 classify 为 en 仍会触发翻译：实际 JAV 标题中此形态极少见，且翻译引擎对人名常返回原文（`new != orig` 检查会拦截），不引入额外启发式避免误杀真英文标题。
- scan_all 与 hook worker 并发时缓存文件可能互相覆盖：影响极小（语言预检兜底跳过已译场景）。
