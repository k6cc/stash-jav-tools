# SceneBackfill 交接文档

> 更新：2026-11-20 11:51（复核修订：剔除误搬的 stashDiscover 议题） | 用途：新开对话接手继续开发 | 状态：**v0.1.0，未发版**
> 本文是内部开发文档，不推送（`docs/SceneBackfill-*` 已在根 `.gitignore`）。
> 原则：只记反直觉结论、适用边界、当前状态；实现细节看源码，UI 参考看 `docs/SceneBackfill-ui-reference.md`。

---

## 0. 接手先认三条硬规则

1. **用户没明确说「发版 / 发布」→ 只做本地落地**，不 commit / tag / Release。「要不要发版」的询问不等于授权。
2. **改完 `SceneBackfill.py` 必须同步部署目录并重启守护进程**：worker 启动时只 import 一次主模块，磁盘换文件不影响已加载的旧进程（本轮真实踩到，见 §4）。
3. **开发期版本号冻结在 `0.1.0`**，只在发版那一刻升一次 patch；不要每轮对话升版本。

---

## 1. 现状

### 它做什么

Stash 插件（`interface: raw` + UI 注入），把「有元数据、没文件」的场景补齐。两种补档方式由独立设置 `pipeline` 切换：

|  | self（默认） | whisparr |
|---|---|---|
| 谁搜片 / 挑版本 / 调下载器 | 插件（Jackett/Prowlarr + qB 或 Motrix） | Whisparr v3 自己来 |
| 链路 | 捕获 → 搜索 → 规则筛选 → 推送 → 下载 → 原地扫描 → 关联 | 捕获 → 交给 Whisparr → 轮询 → 扫描 → 关联 |
| 筛选规则 / 自动搜索 | 生效 | 不适用（自动开关改为「自动加片」） |
| 完成后的文件 | **原地扫描后关联，不搬动**（下载目录必须在库路径内） | **留在 Whisparr 根目录，不搬动** |

`pipeline` 是独立设置，不塞进 `downloader`。切换方式会自动清掉旧模式的未完成记录（保留已入库）。

### 文件与位置

| 项 | 路径 |
|---|---|
| 源码 | `E:\Temp\stash-jav-tools\SceneBackfill\` |
| 部署（Stash 实际读） | `E:\stashAPP\plugins\k6cc\SceneBackfill\` |
| 运行时 state / 日志 | `E:\stashAPP\plugin-data\SceneBackfill\`（`state.json` / `worker.log` / `run.lock` / `daemon.lock` / `daemon.want`） |
| 仓库根 / 发版规范 | `E:\Temp\stash-jav-tools\`（`AGENTS.md`、`docs/new-plugin-release.md`） |
| 索引仓库（另一仓库） | `E:\Temp\stash-plugins\`（远程 `k6cc/stash-plugins`） |
| 调试入口 | `E:\stashAPP\devtools\stash_dev.py` |

六个交付文件：`SceneBackfill.py`（后端主文件，~3940 行）、`SceneBackfillWorker.py`（守护）、`scenebackfill.js`（UI）、`scenebackfill.css`、`SceneBackfill.yml`（设置定义）、`README.md`。**源码与部署六文件当前完全一致。**

### 设置项（`SceneBackfill.yml` 13 项 / 线上已配 10 项新键）

| 键 | 说明 |
|---|---|
| `pipeline` | `self` / `whisparr`，留空 = self |
| `indexer` | `jackett` / `prowlarr`，配置阶段显式二选一 |
| `indexerUrl` / `indexerApiKey` | 上面选中的索引器地址与密钥 |
| `downloader` | `qb` / `motrix`，配置阶段显式二选一 |
| `downloaderUrl` / `downloaderUsername` / `downloaderKey` | qB 地址/登录名/密码，或 Motrix 桌面 RPC secret / Server Web 登录密钥；两个下载器共用一套字段 |
| `whisparrUrl` / `whisparrApiKey` / `whisparrStashRoot` | 仅 whisparr 模式；最后一项把 Whisparr 根目录映射成 Stash 可见路径 |
| `savePath` / `stashPath` | 下载器侧完成目录 / Stash 侧同目录（必须在库路径内） |

**只认新键**：`_cfg` 多键兜底、旧键优先、留空回退自适应、`plugin_data` 数据目录迁移已全部删除（用户 2026-11-20 定）。线上配置本轮已用 `configurePlugin` 整份迁移成新键，旧键清零、`pipeline=self` / `indexer=jackett` / `downloader=qb`。凭据明文不写进文档，从 `query{configuration{plugins}}` 读。

### 运行状态（2026-11-20 11:33）

| 服务 | 地址 | 状态 |
|---|---|---|
| 桌面 Motrix / aria2 | `127.0.0.1:16800` | 在线（secret 从 aria2c 进程命令行读） |
| NAS Motrix Server | `192.168.3.190:8066` | 在线（Web 登录密钥，重启不变） |
| NAS qBittorrent | `192.168.3.190:8090` | 在线，v5.3.0 |
| NAS Jackett | `192.168.3.190:9117` | 在线 |
| 本机 Whisparr v3 | `127.0.0.1:6969` | **已停**（测试用，`Whisparr.Console.exe /data=C:\ProgramData\Whisparr` 可再起） |
| 守护进程 worker | pid 见 `state.json` | 在跑，新代码，无报错 |

本机 Whisparr 是 **v3.6.3.1777 (Eros)**，装在 `E:\Whisparr`，数据目录 `C:\ProgramData\Whisparr`；root folder `E:\Downloads\Whisparr` **不在** Stash 库路径 `E:\Temp\测试库` 内。

### 完成度与验证状态

43/43 任务完成。本轮全部真实环境验证通过：

- 双通道 Motrix：桌面 `Aria2` / NAS `MotrixWeb` 登录 → 加任务 → 进度 → 文件 → 暂停/恢复/删除全链路；错密钥被拒；旧键被完全忽略。
- self 回归：自检 5–6 项全绿（autoImport 开启时多一项「库路径」）、progress、badge 5、capture 7、tick ok、`settings_view` 返回全套新键。
- whisparr 分支：真实 Whisparr v3 自检全绿、progress 连接成功、`POST /movie` + `DELETE` 往返、配置 `finally` 完整恢复。
- 部署：`py_compile` ×2 / `node --check` / `reloadPlugins: true` / 控制台 0 错误。

**仍只有 mock 的**：Whisparr「加片 → 它自己下载完 → 导入 → 插件扫描并 merge 回原场景」的端到端。用户 2026-11-20 决定不做真实全链路，理论上跑通即可。

**未真实验证的**：原地入库（不搬文件）的完整链路。新逻辑已上线，但这台 Stash 的库只有 `E:\Temp\测试库`、下载目录不在库内，且用户暂不使用自动/手动入库，所以没有跑真实「下载完 → 扫描 → merge」；文件不在库内时会明确报错而不是静默失败。

### 仓库状态

```
 M .gitignore
 M stash-testkit/INVENTORY.md
 M stash-testkit/README.md
?? SceneBackfill/
?? stash-testkit/tests/SceneBackfill/
```

SceneBackfill **未 commit / 未 tag / 未 Release**。`stash-testkit` 那两项是别的任务遗留，别顺手提交。

---

## 2. 架构速览（改代码前必读）

**调用通道**：前端 `mutation{runPluginOperation(plugin_id:$id,args:$a)}` → `SceneBackfill.py` 的 `main()` 按 `frag.args.mode` 查 `OPS` 分发 → stdout 输出**一条** JSON。

`OPS`（16 个）：`selftest` `capture` `badge` `search` `push` `progress` `import` `ignore` `done` `rules` `prefetch` `eval_rules` `control` `tick` `worker` `torrent`。

**进度回读已实现（v0.1，别当缺口）**：`progress` op → `do_progress()` 按 pipeline 分流到 `collect_progress()`（qB / Motrix）或 `collect_progress_whisparr()`，逐任务回读 `progress / dlspeed / eta / ready / state`；前端 `loadProgress` 消费，「下载中」tab 的 `progressCard` / `progressRow` / `dlModal` 实时显示百分比、速度、ETA，并带暂停/恢复/移除/入库。self 与 whisparr 共用同一套 row 形状。真实 qB v5.3.0 与桌面/NAS 版 Motrix 均实测通过。

**state.json 所有权**：页面与 worker 双写会互相覆盖，所以 `save_state(ctx, st, own=...)` 写前重读磁盘，把自己不拥有的顶层键用磁盘值覆盖。

| 常量 | 拥有的键 |
|---|---|
| `OWN_SCENES` | `scenes` `content` `daemon` `lastCapture` `durOff` |
| `OWN_CONTROL` | `control` |
| `OWN_RULES` | `rules` |

**场景状态机**（`scenes[sid].status`）：`captured` → `matched` / `low_confidence` / `no_result` → `pushed` → `downloaded` → `imported`，另有 `importing` / `ignored`。下载器句柄存 `rec["chosen"]["hash"]`；whisparr 模式复用该字段存 StashDB ID，另存 `movieId`。

**下载器抽象**：`QB` / `Aria2`（桌面）/ `MotrixWeb`（Server/NAS）统一暴露 `login / add_torrent / add_magnet / info / files / properties / start / stop / delete / set_prio / prefs`。`make_downloader(cfg)` 先按 `downloader_kind(cfg)` 选 qb / motrix，motrix 再由 `motrix_probe()` 按端点分 aria2 / web。

**索引器**：`indexer_kind(cfg)` 显式二选一；`indexer_mode(cfg)` 里按 URL 后缀判 torznab / jackett 是**端点格式构造**，不是服务类型猜测（保留合理）。

**Whisparr pipeline**：`pipeline_kind(cfg)` 分流 → `whisparr_push_scene` / `collect_progress_whisparr` / `import_scene_whisparr` / `run_tick_whisparr` / `_torrent_whisparr`。扫描关联抽成 `_link_scanned_files()`，self 与 whisparr 共用（`scan_and_find_many` → `findFiles` → `sceneMerge` / `sceneAssignFile`）。

**守护进程**：`SceneBackfillWorker.py` detach 启动，持 `daemon.lock`，每 90s 一次 `core.do_tick(ctx)`；`DAEMON_STALE=300s`、`DAEMON_IDLE_EXIT=30min`。三个自动开关全关且无在途任务、空闲 30 分钟后自退；`daemon.want` 单独存小文件决定「Stash 重启后要不要自己回来」。

---

## 3. 待办事项

### A. 发版（唯一阻塞项，需用户明确授权）

这是**新插件首发**，比日常发版多三步。顺序不可颠倒，完整流程见 `AGENTS.md` 发版节 + `docs/new-plugin-release.md`：

| # | 步骤 | 备注 |
|---|---|---|
| 0 | 发版前清理 | `SceneBackfill/__pycache__`、临时文件/截图、旧注释、死代码 |
| 1 | 升 patch 并同步四处 | `SceneBackfill.yml: version`、`scenebackfill.js: PLUGIN_VERSION`、`SceneBackfill/README.md` 头部 note（只保留最新一条）、**根 `README.md` 插件表新增一行**（当前没有 SceneBackfill 行） |
| 2 | **release.yml 白名单** | `.github/workflows/release.yml` 的 `on.push.tags` 加 `"SceneBackfill-v*.*.*"`（当前没有）；缺了打 tag 不触发构建 |
| 3 | **stash-plugins 占位符** | `plugins/main/index.yml` 追加 `version: 0.0.0` / 全 0 sha256 / path / date / **英文 description**（唯一一次手写机会，workflow 不覆盖）；`README.md` 插件表手动加行；**必须 push 到远程** |
| 4 | commit + tag | `fix|feat|docs(SceneBackfill): 描述, vX.Y.Z`；tag `SceneBackfill-vX.Y.Z`；`git push; git push --tags` |
| 5 | 验证 | `gh release view <tag> --json assets` 确认 zip；`gh api repos/k6cc/stash-plugins/pages --jq .status` 为 `built`；带 cache buster 查 index.yml 的 version 已更新（Pages 有 CDN 缓存，首次常读到旧值）；两仓库 `git status` 干净 |

另：`git push` 一次性用 `git push "https://k6cc:$(gh auth token)@github.com/<owner>/<repo>.git" <branch>`；受限沙箱下 push/tag 可能因 schannel TLS 握手被拦，需在沙箱外执行。

### B. 功能 / 验证缺口

| 项 | 说明 |
|---|---|
| NAS 版 Motrix 的能力缺口 | Server 版**没有 select-file 通道**，`set_prio` 是 no-op → 只能整包下载。用户 2026-11-20 决定接受，README 已写明「整个种子下载」 |
| 规则与试运行在 NAS 版的表现 | 不需要实测：试运行/规则只读索引器返回的 `.torrent` 文件清单（`fetch_torrent`），与下载器无关，判定结果和 qB 下完全一致；唯一差别是 push 时 NAS 不执行 `select` 计划。已在 303 上实测试运行（51 个清单缓存，pass/unknown 正常） |
| 原地入库未做真实验证 | 新逻辑要求下载目录在库路径内；这台 Stash 的库只有 `E:\Temp\测试库`，用户暂不使用自动/手动入库，所以没有跑真实「下载完 → 扫描 → merge」 |
| Whisparr 真实端到端 | 用户 2026-11-20 决定不做真实全链路，保留 mock + 自检；理论上跑通即可 |

### C. 可选收敛（非缺陷，不做也不影响功能）

- `indexer_mode()` 里按 URL 后缀判 torznab / jackett 的格式自适应，可考虑彻底按 `indexer` 显式值走；当前保留是端点构造需要。

### D. 明确不做（别主动提、别自己加）

- 不因本地网络波动或高延迟加超时预算 / 重试 / 降级冗余逻辑；不凭本地网络状况下环境结论（用户远程办公、代理节点不稳定，属环境噪声）。
- 不重发同一版本号；不做「自动推送时隐藏有结果」；排序三项不做开关；磁力不单独分组。

### E. 备忘录（记下，暂不做）

- 手动入库兼容「文件已被搬走」：现在 `import_scene` 要求文件还在下载目录（按 qB 任务 + 路径映射找），搬走后会报「下载目录里找不到」。将来可支持按文件名/大小在库内找最近文件再关联，或允许手动指定 file id。用户 2026-11-20 明确「暂时不做」。

> 别把 `docs/stashdiscover-download-status.md`（stashDiscover「发现页下载状态回显第一层」的**未实施讨论稿**）搬进本插件：那是另一个插件的议题，SceneBackfill 的进度回读 v0.1 已经做完（见 §2），不是待办、更不是"不做项"。

---

## 4. 经验踩坑（结论 + 适用边界）

### Stash 插件通道

> 以下是 Stash 插件通道的**通用结论**（跨插件适用，属平台行为，不是任何单个插件的功能设计）；SceneBackfill 目前只用 `runPluginOperation`，未用 `ui.assets` / `query{logs}` 传数据。

- `runPluginOperation` 是给前端回传结构化数据的**唯一干净通道**：stdout 只能输出**一条** `{"output": ...}` 或 `{"error": "..."}`，多一行就退化成 raw string；`interface{}` 无体积限制，但同步阻塞，反代 60s 超时会切断长任务。
- `ui.assets: /: .` 挂出的整个插件目录匿名可读、可列（`.py` 源码也能下）→ **不传任何非公开数据**（搜索结果、密钥、临时文件）。
- `query{logs}` 不能传数据：环形缓冲只留 30 条、单行 >64KB 截断、失败无声。
- manifest **不保证带 `apikey`**；后台进程要连回 Stash，从 `{config_dir}/config.yml` 的 `api_key` 读（`config_dir` 用「插件目录逐级向上找 config.yml」定位；Docker 下配置不在插件祖先目录时这套失效）。
- **`configurePlugin` 是整体替换**：只传一个键会把其余设置全清空。改单项必须先读 `configuration{plugins}` 全 map、改一项、整份回传；临时切模式测试一律 `dict(cur)` + update + `try/finally` 恢复。

### 配置 / 设置

- Stash yml `settings` 是静态的、不能条件显示 → 「选 qb 只显示 qb 字段」做不到，只能把两套字段合并成一套通用字段。
- `STRING` 与 `NUMBER` 在设置页都是「只读值 + 编辑按钮 + 弹窗」，换类型不会让界面变简单。
- 线上旧键配置必须整份迁移，否则删兜底后插件读不到任何连接信息（`qb!:qBittorrent URL is empty`）。

### 守护进程 / 并发

- **部署后端代码后必须重启守护**：`worker stop` → 等 `daemon.pid` 归 0 → `worker start`。`Ctx.config()` 是运行时 GraphQL 读的、不缓存，但已 import 的模块代码不刷新。本轮真实踩到：6.6 小时前启动的旧 worker 在配置迁移后持续报 `qBittorrent URL is empty`。
- stop 用 state 标记 + 子进程每 2 秒轮询，且只认 `pid` 是自己的标记；启动时**不要**乐观写 pid / 清 `stopping`（旧进程不退、新进程抢锁失败、残留 pid 让 UI 假报运行中）。
- 单实例锁用**内核字节锁**（Windows `msvcrt.locking` LK_NBLCK / POSIX `fcntl.flock` LOCK_NB）；**锁住了别 unlink 锁文件**（删文件 → 后来者锁新 inode → 双持），只 close 句柄。
- Windows 下 `os.kill(pid,0)` 判存活不可用（已退出进程不报错、不存在号抛 EINVAL 22、pid 会复用）；`msvcrt.locking` 对读也生效，pid 要写在 **1 MiB 偏移**处。测试占锁必须起真实持锁进程，往锁文件写一行 JSON 不算占锁。
- `daemon.want` 单文件存「上次是否开着」，不进 state.json（会被对方更早的快照盖掉）。

### 下载器 / 索引器

- **Motrix 桌面版与 Server/NAS 版是两套协议**，不是同一个密钥换着用（能力对照表见 `docs/SceneBackfill-ui-reference.md` §15）。`motrix_probe()` 各问一次端点区分，无需开关。
- Server 版 `/jsonrpc` 带 Bearer 反而 404；`query:getSettings` 能看到它内部 `:16800` 的 aria2 与 rpcSecret，但**那个端口不对 NAS 外部开放**，只能走 `/rpc/<kind>/<name>`。
- Server 版只收 bt/magnet（torrent 字节、HTTP 都 500）、句柄是 `taskId` UUID、无 select-file 通道 → 整包下载；`.torrent` 要先算 infohash 拼磁力（`torrent_magnet`）。
- Server 版 `getTaskFiles` 的 index 是 **0 基**（桌面 1 基），`selected` 决定 priority；`command:createTask` 重复提交同一磁力返回 `outcome:"created"` + 相同 `taskId`（幂等；`conflict`/`existingTaskId` 分支 2026-11-20 复测未触发，已删除）。
- aria2 没有逐文件优先级，只有 `select-file` 白名单；`keep` 为空（丢掉唯一文件）时跳过，否则不生效。
- 桌面 `--rpc-secret` 从 aria2c 进程命令行读（`Win32_Process.CommandLine`）；NAS Web 登录密钥**重启后不变**（用户确认）。

### Whisparr v3

- 只认 **StashDB UUID**；javstash ID 加进去是空壳。`POST /movie` 会校验 stashId 真实存在于 StashDB，假 UUID 返回 400 `A movie with this ID was not found`；插件最小 payload 实测有效，**不用**先 lookup 补全元数据（mock 没暴露这条）。
- root folder 必须在 Stash 库路径内；两边命名不同用 `whisparrStashRoot` 映射。不映射时自检 6 项里只有「库路径」红——是真实配置诊断，不是 bug。
- `monitored` 只影响自动搜索，**停不了正在下载的任务** → 插件不提供暂停/恢复。
- 插件只扫描 + merge 回原场景，**不搬文件、不删文件**。

### 工程 / 调试 / 发版

- **补丁脚本改函数签名要同步改所有调用点**；`py_compile` 查不出签名不匹配，真实 op 通道才报 TypeError。本轮 `_sf_patch_clean.py` 把 `resolve_apikey(ctx, cfg)` 改成单参数却漏改 `do_selftest` / `do_selftest_whisparr` 两处。用 AST 静态检查（模块级函数定义参数数 vs 裸调用传参数）扫全文件可一次兜住。
- 调试统一 `E:\stashAPP\devtools\stash_dev.py`：`status` / `gql` / `gql --page` / `ui` / `eval` / `console` / `shot`。**GraphQL 优先 ApiKey 直连**，只有要页面上下文才加 `--page`；调试 Chrome 不跨工具调用存活，连续操作要在一条命令/一个进程里跑完。
- 发版纪律：**Stash 判断有无新版看 index.yml 的 `date` 而不是 version**；线上是否生效按 `sha256` 校验；Pages 有 CDN 缓存，首次常读到旧值（带 cache buster 轮询）；不再重发同一版本号（改动一律升 patch）；远端默认分支是 **main**，别写 `HEAD:master`。
- 文档规范见 `docs/docs-writing.md`：README / yml 设置文案 / 论坛帖**不写交互类描述与技术实现细节**（判断句：用户只看屏幕能不能得出这句）；文案都走 `tc(中文, 英文)`，改中文必须同步英文；能用表不用段落。`docs/` 下分析/排查类 md 只留本地、不推送。

---

## 5. 环境速查

```bash
PY="C:/Users/k6cc/.workbuddy/binaries/python/versions/3.13.12/python.exe"
DEV="E:/stashAPP/devtools/stash_dev.py"

$PY $DEV status                                   # 体检
$PY $DEV gql "{...}"                              # GraphQL，ApiKey 直连
$PY $DEV gql "{...}" --vars '{"id":"SceneBackfill",...}'
$PY $DEV console /plugins/SceneBackfill --reload    # 强刷 + 抓控制台/异常
$PY $DEV shot out.png --path /plugins/SceneBackfill --vsize 1280x800
$PY $DEV gql "mutation { reloadPlugins }"
```

Stash 本体 `E:\stashAPP\`，端口 9999，用户 `k6cc`，已启用登录认证；账号在 `E:/stashAPP/devtools/stash_creds.json`。Stash v0.31.1 / databaseSchema 85。

凭据位置（**不在文档落明文**）：Stash 插件设置 `query{configuration{plugins}}`；Whisparr API Key `C:\ProgramData\Whisparr\config.xml`；桌面 Motrix secret 在 aria2c 进程命令行；NAS Motrix Web 登录密钥在本项目历史会话里给过。

常用自检 op（真实通道）：

```bash
$PY $DEV gql 'mutation($id:ID!,$a:Map!){runPluginOperation(plugin_id:$id,args:$a)}' \
  --vars '{"id":"SceneBackfill","a":{"mode":"selftest","lang":"zh"}}'
```

`mode` 可换 `progress` / `badge` / `capture` / `tick` / `worker`（带 `action=status|start|stop|auto`）。

---

## 6. 相关文档索引

| 文件 | 内容 |
|---|---|
| `AGENTS.md` | 发版清单、文件编辑约定、多语言约定、yml 设置项类型 |
| `docs/new-plugin-release.md` | **新插件首发**额外三步（白名单 / 占位符 / 日志） |
| `docs/SceneBackfill-ui-reference.md` | UI 设计参考、Whisparr 界面差异、设置项精简、Motrix 双通道能力对照表（§15） |
| `docs/SceneBackfill-plan.md` | 早期实施计划（大，按需查） |
| `docs/docs-writing.md` | 文档写作规范 |
| `SceneBackfill/README.md` | 面向用户的说明（设置表、补档方式、已知限制） |
| 根 `README.md` | 插件表（**发版时需新增 SceneBackfill 行**） |
| `.github/workflows/release.yml` | tag 白名单（**发版时需加 SceneBackfill**） |
