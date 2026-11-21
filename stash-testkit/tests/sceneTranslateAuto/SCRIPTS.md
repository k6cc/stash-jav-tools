# sceneTranslateAuto 脚本总览

> 插件的翻译引擎、语言判据等实现细节见 `../../sceneTranslateAuto/README.md`；通用硬约束见 testkit 根 [`README.md`](../../README.md)。

插件：`E:\Temp\stash-jav-tools\sceneTranslateAuto`，部署副本由 `config.json` 的 `plugin_dir` + `sceneTranslateAuto` 决定。

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `test_v123_optimizations.py` | 优化 1 快照防顺延 / 优化 2 google_free 逐 q 翻译 / 优化 3 zh 语言判据 | `python test_v123_optimizations.py` | 不需要；离线打桩 |
| `test_race_guard.py` | 写前重读守卫：nfo 竞态丢字段、实体消失、重读异常 fail-closed、图库分支 | `python test_race_guard.py` | 不需要；离线 |
| `test_guard_lang_delay.py` | 守卫语言判据（目标语言已变则不重译）+ worker 入队延迟/坏文件 | `python test_guard_lang_delay.py` | 不需要；离线 + 临时目录 |
| `test_scan_all.py` | Full Scan & Translate：分页聚合、语言预检、dry-run 审计、单场景异常隔离、进度与计数拆细 | `python test_scan_all.py` | 不需要；离线 |
| `worker_e2e.py` | 已部署插件的 worker 端到端：空队列退出、到期任务处理、未到期等待 | `python worker_e2e.py` | 需要实例 + 已部署；**写插件 `auto_state/pending` 与 pid 文件** |
| `real_chain_v123.py` | 全链路：造唯一视频 + nfo → 增量扫描 → 钩子入队 → worker 译写回 | `python real_chain_v123.py --dir <已注册库子目录> --prefix STA-` | 需要实例 + 已部署；**写库与测试目录**，需手动 `db_cleanup.py --prefix STA-` |

## 跑法约定

- 离线单测直接 `importlib` 加载插件源码，不启动 Stash，也不读写插件状态。
- `worker_e2e.py` 与 `real_chain_v123.py` 读 testkit 根 `config.json`；先确认 `plugin_dir` 指向的副本版本正确。
- `real_chain_v123.py` 的 `--dir` 必须是实例已注册库的子目录，且视频内容唯一（脚本已随机化，避免 oshash 合并空跑）。
