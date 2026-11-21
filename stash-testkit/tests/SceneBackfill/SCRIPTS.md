# SceneBackfill 脚本总览

> 插件状态机、规则口径与实测坑见 [`../NOTES.md`](../NOTES.md)。通用工具（`plugin_op.py` / `state_snapshot.py` / `deploy_plugin.py` / `ui_probe.py`）在 testkit 根目录，不在此目录。

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `sf_verify.py` | 一键验收：selftest（下载器/双目录/库路径/空间/索引器/后台认证）+ 规则回读 + 下载器连接 + 守护心跳 + `state.json` 状态机巡检 | `python sf_verify.py`；`--skip selftest,progress`；`--with-worker-start`（额外拉起守护并等心跳）；`--data-root <dir>` | 需要实例；**只读**（不存规则、不启停守护、不写 state）。退出码 1 = 有 FAIL |

## 判读

- `state 巡检` FAIL 的常见来源：未知 status、`pushed/downloaded/importing` 缺 `chosen.hash`、记录 `id` 与键不一致、`daemon.stopping` 残留但 `pid=0`。
- `守护进程` 默认只读取状态，未运行记为 WARN 而非 FAIL；发版前要确认常驻时加 `--with-worker-start`。
- 改状态做 UI 验证仍用根目录 `state_snapshot.py`（先 `snap` 再动），不要用本脚本。
