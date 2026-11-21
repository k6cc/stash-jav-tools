# sceneTranslateAuto（自动翻译）验证笔记

插件：`E:\Temp\stash-jav-tools\sceneTranslateAuto` → 部署到 `E:\stashAPP\plugins\k6cc\sceneTranslateAuto`（由 `config.json` 的 `plugin_dir` 决定）。
`Scene.Create.Post` / 图库钩子入队，worker 延迟翻译 title/details，写前重读快照防竞态。

## 文件地图

| 位置 | 内容 |
|---|---|
| `scripts/` | 4 个离线单测 + worker 端到端 + 真实全链路；逐个用途/跑法/副作用见 [`SCRIPTS.md`](SCRIPTS.md) |

## 快速验证

1. 离线（不碰实例）：`test_v123_optimizations.py`、`test_race_guard.py`、`test_guard_lang_delay.py`、`test_scan_all.py`。
2. 已部署插件：`worker_e2e.py` 验证空队列 / 到期任务 / 未到期等待三种 worker 行为（会写 `auto_state/pending`）。
3. 全链路：`real_chain_v123.py --dir <已注册库子目录> --prefix STA-`，造唯一视频 + nfo → 增量扫描 → 钩子入队 → 译写回；结束后 `sceneDestroy` + `db_cleanup.py --prefix STA-`。

## 实测环境

- 离线单测用 `importlib` 直接加载已部署或仓库版 `sceneTranslateAuto.py`，不启动 Stash。
- 写回守卫按快照比对：nfo 在延迟窗口内改了 title，翻译结果会被丢弃（fail-closed），不是丢功能。
- v1.3.0 `scan_all` 一次性结论见 `_archive/sceneTranslateAuto-v1.3.0-scan_all-validation.md`；通用硬约束见根 `README.md`。
