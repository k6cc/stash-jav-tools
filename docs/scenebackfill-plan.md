# SceneBackfill 方案稿（给「有元数据、没文件」的场景补资源）

> 状态：**方案已定 + 闭环全部实测完毕，未开工**。2026-11-19 第五版（第四版并进 Jackett / qB / 跨机路径实测；第五版按「跨盘搬运」复核结果把 `moveFiles` 整段删掉，改由插件自己搬）。
> 插件名 **SceneBackfill**：社区 stable/develop 索引 90 个 id、本仓库 21 个 id 均无 fill / missing / download 类冲突。
> 用途：开新对话整篇贴进去当起点。§1 的实测结论不用重跑，可以直接开工 v0.1。

## 0. 一句话

Stash 里 `files` 为空的场景（stashDiscover 入库的、javstashAutofill+ 建的、手动建的都算），插件捕获 → 多源搜索 → 按规则筛 → 推给 qB 只下选集里的文件 → 下载完自动扫描、把文件关联回原场景。

与 stashDiscover 的边界不变：那边找「库里还没有的场景」，这边补「有条目没文件」。**独立插件，不合并、不共享模块**（跨插件依赖太脆）。

## 1. 实测记录

2026-11-19，本机 Stash **v0.32.0** / Windows。库路径 `E:\Temp\测试库`，测试视频用 ffmpeg 现生成；Stash 调起的 python 是 `C:\Users\k6cc\AppData\Local\Python\pythoncore-3.14-64\python.exe`。网络侧对端：Jackett `192.168.3.190:9117`、qBittorrent **v5.3.0** `192.168.3.190:8090`、NAS 共享 `\\192.168.3.190\media`。

**闭环相关（全部实测，方案已按结果修正）**

| # | 结论 | 怎么测的 |
|---|---|---|
| 1 | 空场景能原生筛，不用全量拉 | `findScenes(scene_filter:{file_count:{value:0,modifier:EQUALS}})` → 7 条 |
| 2 | `metadataScan(paths:)` 对库外目录**什么都不建**，静默跳过 | mp4 放 `E:\Temp\_sf_test\out` 扫 → `findFiles` 0 条 |
| 3 | 库内扫描会**新建独立场景**，不会按 stash_id 并到既有空场景 | 先建空场景 305（带 stash_id）再扫同番号文件 → 多出 306 |
| 4 | 扫描建的新场景 **code / title 为空** | 306 的 code 与 title 都是空串，合并时不会污染原场景 |
| 5 | 扫描传**单个文件路径**也生效，不必传目录 | `paths:["…\SFPROBE-003.mp4"]` → 文件被索引 |
| 6 | `sceneAssignFile` 对「已属于别的场景的 primary file」**失败** | 305 ← 540（540 属 306）→ `cannot reassign primary file` |
| 7 | `sceneMerge(source:[扫描新建的场景], destination:原场景)` **一步到位**：文件挂过去、source 自动删除、原场景 id / code / title / stash_ids 全保留 | 307 + 308 merge → 只剩 307 且带文件 |
| 8 | `moveFiles` 目标**必须在库路径内**，库外直接被拒、不会跨盘拷贝 | 目标写 `C:\Temp\_sf_moved` → `must be within a stash library path` |
| 9 | 库内 `moveFiles` 改名 + 换目录后 **file id 不变**，场景关联跟着走 | 540 → `_sftest\final\SFPROBE-001.mp4` |
| 10 | **同 oshash 的文件扫描会被挂到既有场景**，不新建场景 | 同内容 mp4 复制进库再扫 → 直接挂到 305 |
| 11 | 插件任务里 detach 出去的 python 子进程**能活过任务** | 临时插件 `sfprobe`：`DETACHED_PROCESS` 起子进程后 launcher 立刻退出，任务结束 13s 后子进程仍在心跳 |

**搜索 / 下载器 / 跨机路径（2026-11-19 下午补测）**

| # | 结论 | 怎么测的 |
|---|---|---|
| 12 | Jackett torznab 搜索可用，正常 0.7~1.4s；**尾延迟会到 40s**（某个 indexer 挂住） | 同一查询间隔重跑，40s 只出现一次；`t=search&q=KAVR-495` |
| 13 | 下载链接两种形态：常规 indexer 返 **200 + `application/x-bittorrent` + `d8:announce…`**；磁力型 indexer 返 **302 `Location: magnet:?xt=urn:btih:…`** | 对比 4 个 indexer 的 `enclosure` |
| 14 | 本机 4 个 indexer 里只有 `sukebeinyaasi` / `knaben` 给 .torrent，`0magnet` / `torrentdownload` 是磁力重定向 | 逐个拉 enclosure |
| 15 | 跨站重复极多：START-608 28 条结果只有 **11 个唯一 infohash**；HND-391 11 条只有 5 个 | torznab `infohash` 属性去重 |
| 16 | bencode 纯 stdlib 能解：162KB 种子解析出 4 文件、含各扩展名体积 | 见 #17 的真实样本 |
| 17 | **真实种子里的广告文件也是 `.mp4`**：`manko.fun.mp4` 10.5M、`社 區 最 新 情 報.mp4` 14.4M、`台湾uu美少女直播…mp4` 13.2M，另有 `.url` / `.html` / `.txt` | 解析 HND-391、START-608 的种子清单 |
| 18 | qB 5.3.0 **删除**了 `torrents/pause` / `torrents/resume`（404），改成 `torrents/stop` / `torrents/start`；`add` 的 `paused=true` 被忽略，必须用 `stopped=true` | 四个端点逐个打 |
| 19 | 用 multipart 上传 .torrent → 立即返回 `added_torrent_ids`（含 hash）、中文名正确；用 `urls` 传 Jackett 直链 → `pending_count:1`（无 hash）、名字被百分号编码成 `HND-391-%E4%B8%AD…` | 两种加种方式对比 |
| 20 | `filePrio` 在 `stoppedDL` 状态生效，改完 `size` 立刻变成「选中体积」（2111266919 → 2100297728） | 关掉 3 个非目标文件 |
| 21 | `torrents/info` 单条约 17KB（2 条 34KB），全量拉会很大；`hashes=a\|b\|c` 批量 3 条只要 5~6ms | 计时 + 量响应体 |
| 22 | 磁力加进去：`state=stoppedDL` / `size=0` / `files=[]` / `has_metadata=false`；`start` 后 45s 仍是 `metaDL`（4 peers）→ **「等元数据」是真状态，必须给超时** | 加 magnet → start → 轮询 `properties.has_metadata` |
| 23 | Stash **能把 UNC 路径当库路径**：`\\192.168.3.190\media\downloads\sftest` 写进 `stashes` 后被正常扫描、入库、合并 | configureGeneral 加路径 → 扫 → merge |
| 24 | **`moveFiles` 跨卷不会失败**：Stash 用的是 `fsutil.SafeMove`（rename 失败 → 复制 → 删源），v0.32.0 源码注释就写着「to support cross-device moves」 | 读 `pkg/file/delete.go` + `pkg/fsutil/file.go`；实测 D:→E: 197MB 复制成功、大小一致、源已删 |
| 25 | `metadataScan` 是异步任务（返回 job id，立即 200），`jobQueue` 空时不代表失败 | 扫完轮询队列 |
| 26 | qB 实际映射：`/downloads/input` = `\\192.168.3.190\media\downloads\input`，`/downloads/incomplete` = `…\downloads\incomplete` | 共享目录列举与 qB 偏好对照 |
| 27 | **NAS 那台 Stash 里没有 `/downloads`**（`directory(path:"/downloads/input")` → `open /downloads: no such file or directory`），容器根下只有 `/app /config /data /social` | NAS 实例 v0.32.0，`k6cc/3321` 表单登录 |
| 28 | NAS 生产库 **12 条库路径全在 `/data/*`**（按题材分类）+ `/social`；1949 个场景、**0 个空场景** | 同上 |
| 29 | NAS 装了 `stashDiscover 2.8.4`（上游就在这台）、`stash-scheduler 0.6.1`（带「常驻后台调度器」任务，可借它的常驻形态） | `{plugins{id description tasks{name}}}` |
| 30 | 登录姿势：`POST /login` 必须 **form-urlencoded**，发 JSON 一律 401 | 两种都试过 |

**第二轮复核（2026-11-19 15:40，针对「跨盘能不能搬」）**

| # | 结论 | 怎么测的 |
|---|---|---|
| 31 | 早期那次 `moveFiles`（UNC → 本地库）的 panic **未能复现**：清掉残留 folder 记录后，同一条路径重跑成功、文件正常搬走 | 同一 UNC 源重跑，返回 `moveFiles: true` |
| 32 | **插件自己搬 + 扫目标 + merge 整条闭环通**：跨盘 `shutil.move` → 扫目标单文件 → 新建场景 313 → merge 进原空场景 315 → 文件挂到 315、313 自动消失 | D:\_sfdl（独立盘）→ E:\Temp\测试库\_e2e |
| 33 | `moveFiles` 的复制是**同步**的，且包在 `withTxn` 里（复制期间持写事务） | 读 `resolver_mutation_file.go` + 实测 197MB/0.2s（本机 SSD≈1.1GB/s） |
| 34 | NAS 生产库现在容器里有 `/qb`（`/qb/input`、`/qb/incomplete`），且 **`/qb/input` 被加进了库路径**（第 13 条）；`/downloads` 也在，但是空目录 | 只读 `directory()` 查询，未做任何写入 |
| 35 | **qB 的未完成内容在 `temp_path`，不在 `save_path`**：推磁力查 properties，`download_path=/downloads/incomplete`、`content_path=/downloads/incomplete/<种子名>`，而 `save_path=/downloads/input` | 推 SSIS-158 磁力后读 properties；该机 `temp_path_enabled=true`、`temp_path=/downloads/incomplete`、**`incomplete_files_ext=false`**（temp 若关掉，半成品会以最终文件名直接落进 save_path） |

**第三轮（2026-11-19 17:30，v0.2 规则与试运行落地时）**

| # | 结论 | 怎么测的 |
|---|---|---|
| 36 | 排除正则写域名（`489155`、`996gg`）会**命中主视频**：真实文件名是 `489155.com@CJOD-535-UC.mp4`，域名是压制组标签不是广告内容 | 试运行 CJOD-535，该候选选集池被清空、回退成「整包最大文件」 |
| 37 | **广告过滤交给 `file_min_share` 就够**：广告占整包 0.05~0.7%，主视频 99%+；默认 0.3 一把切干净 | 同上，8 条有清单的候选全部 1/N，不需要任何排除词 |
| 38 | 排除后若池为空，回退要**在池内**找最大视频再退到全集，否则过激的排除词反而选中它本来想干掉的文件 | 修 `pick_files` 前后对比同一候选 |
| 39 | 磁力型候选（302 → magnet）预检落 `magnet: true`，内容类规则全部 unknown；CJOD-535 的 13 条里 5 条 | prefetch 后读缓存 |
| 40 | 一次 prefetch 的预算必须 < 20s：`stash_dev.py gql` 客户端 20s 超时、反代 60s；budget=40 会被客户端先切断（插件侧照跑） | budget=40 报 TimeoutError，budget=12 正常 |
| 41 | `a == b in c` 在 Python 里是**链式比较**（`a == b and b in c`），布尔规则求值踩过一次 | `freeleech == false` 全部返回 fail，加括号后正常 |
| 42 | **`configurePlugin` 是整体替换不是合并**：只传一个键，其它设置全被清空（qbPassword 就这样丢过一次） | 传 `{stashDownloadPath:"E:\\Temp\\sfqbdrop"}`，回读只剩这一个键 |
| 43 | qB `stopped` 状态下 `recheck`（POST `torrents/recheck`）不生效，`progress` 一直是 0；**先 `start` 再 `recheck` 就会校验已有文件**，59KB 双文件种 3s 内 progress=1 | 预置文件 → recheck（无变化）→ start + recheck（完成） |
| 44 | 守护进程用 `sys.executable` + `DETACHED_PROCESS\|CREATE_NO_WINDOW` 启动后**能活过插件调用**：插件 op 1.5s 返回，进程继续按 90s 轮询，日志与心跳正常写 | `worker start` → 进程 7976 存活 9 分钟 → 跑了 5 轮 tick → stop 后自退并清心跳 |
| 45 | 内核字节锁在 Windows 上**连 `open("r+b")` 都挡**：第二个 worker 打开锁文件即 `Permission denied`，因此「打不开」就等于「已有实例」 | 手动起第二个 worker，输出 `another worker holds the lock` |
| 46 | `runPluginOperation` 的 manifest **不保证带 `apikey`**，守护进程拿它连回 Stash 会 401（日志里表现为 `capture!:HTTP Error 401`，看着像 Jackett 挂了）。改成从 `{config_dir}/config.yml` 的 `api_key` 读，实测 `gql` 直接通 | 旧 worker 每轮 `capture!:/qb!: 401`；新 worker 同一操作正常 |
| 47 | 启动守护时**乐观写 pid + 清 `stopping`** 会连环出错：清标记让旧 worker 不退了，新 worker 抢锁失败退出，残留的 pid 又让 UI 显示「运行中」 | 一停一起之间出现 `another worker holds the lock` + `alive:true, pid:14300`（进程已死） |
| 48 | 停止守护改成每 2 秒看一次 `daemon.stopping`（`pid` 必须是自己），响应从「等满 90 秒」降到秒级；新 worker 启动时残留的 `stopping` 因 pid 不匹配不会误杀 | stop 到 `stop requested` 日志之间 < 3s |

**已确认不可用 / 已否决**

| 项 | 结论 |
|---|---|
| 磁力候选的内容类筛选 | 无 .torrent 就没有文件清单，只能 unknown（#13 #14 #22） |
| 依赖 `moveFiles` 做跨盘搬运 | 能用但同步复制、无进度、持写事务（#24 #33）；插件自己搬更可控（§7） |
| 把 qB 下载目录当库路径（原地入库的代价） | 半成品会被扫进来、搬走文件后会被标 missing、全库扫描范围变大（§7） |
| NAS 上那台 Stash 的写入操作 | 能做（`k6cc/3321` 表单登录可用），但**生产库不做写测试**，仅在本地测试库验证 |
| NAS 上的 Motrix（`8066`） | 确认在跑，但 aria2 JSON-RPC 需 token，未接；v1 不做（§11） |

**沿用上一版的事实**：空场景字段齐（`code` / `date` / `performers` / `stash_ids` 都有，`studio` 全 null，不影响搜资源）；Stash 插件任务没有 cron（只有 `tasks` / `hooks`，TasksToolkit 的自跑 routine 需 Linux）。

## 2. 流程

捕获（`file_count=0`）→ 搜索（Jackett / Prowlarr）→ 筛选（规则 + 种子清单）→ 推送（qB 暂停加种、按下选集设优先级）→ 下载（进度 / 连接状态）→ 入库（搬入库 → 扫单文件 → merge 回原场景）。

三个自动化开关卡在三处：捕获→搜索、筛选→推送、下载→入库。开关关掉，流程就停在对应表格页等人确认。

| 做 | 不做 |
|---|---|
| 捕获 `file_count = 0` 的场景，落本地状态 | 不建场景、不改元数据（那是 stashDiscover 与刮削的活） |
| 多源搜索、规则筛选、打分排序 | 不做 Whisparr 搜索源（理由见 §11） |
| 推 qB、按选集只下要的文件、进度回显 | 不整理命名（rename 交给 Stash 或 renamer 插件） |
| 下载完搬进库目录、扫单文件、merge 回原场景、扫描建的重复场景自动消失 | 不动 qB 的种子记录；搬运只删「核对过、已成功落到库里的」源文件 |
| 可选后台守护（默认关） | 不监控「库里还没有的新片」（那是 stashDiscover 的关注功能） |

## 3. 页签（5 个 + 设置）

**「有结果」是自动化的产物**：搜到 → 过规则 → 通过的才进来。它不装需要人工重新判断的东西，否则和「待处理」没有区别。

| 页签 | 装什么 | 主操作 |
|---|---|---|
| 待处理 | 新捕获 / 等首搜 / 无结果待重试 / 候选全被淘汰或无法判定（卡片上标明第几次、下次时间、淘汰数；有候选的可展开强推） | 立即搜索、忽略 |
| 有结果 | 至少一个候选通过全部规则；卡上显示通过/待确认/淘汰计数与最佳候选 | 推送最佳、展开全部、规则详情 |
| 下载中 | 等元数据 / 下载 / 停滞 / 暂停；顶部显示下载器连接状态 | 暂停、继续、移除、入库 |
| 已完成 | 已入库 | 打开场景 |
| 已忽略 | — | 恢复 |
| 设置 | 自动化开关、总量闸、筛选规则与试运行、自检结果 | — |

不按初稿拆「已捕获 / 可添加」两个页签：两者只差「有没有进队列」，合成一个再配 chip 更省操作。**「无结果」不占页签**——它不是终态，会退避重试，放「待处理」当 chip。**「搜索中」也不占页签**：搜索是一次调用，第二轮就结束了，没有可盯的进度。

所有列表页都是带封面的卡片网格（封面取场景的 `paths.screenshot`），不是行式列表。

## 4. 状态机

| 状态 | 判据 | 谁推进 |
|---|---|---|
| `captured` | Stash 里 `file_count = 0` 且未记录 | 捕获轮询 |
| `searching` | 本轮正在搜 | tick |
| `matched` | 有候选通过全部硬筛与规则 | tick |
| `low_confidence` | 有候选但分数不到阈值，或有 `unknown` 项 | tick |
| `no_result` | 无候选，或全被规则淘汰 | tick |
| `pushed` | 已进 qB，Stash 侧 `files` 仍为空 | 推送成功 |
| `downloaded` | qB `progress = 1` | 进度轮询 |
| `importing` | 已触发 scan，等文件进库 / 等关联 | tick |
| `imported` | 原场景 `files` 非空 | 校验 |
| `failed` | 任一步失败且重试耗尽 | 各自 |
| `ignored` | 用户忽略 | UI |

- `no_result` 按 15min → 1h → 6h → 24h 退避，N 次后停手（别把 indexer 打死）。
- `imported` 的唯一判据是原场景 `files` 非空，**不信自己的记录**。
- 退避与重试计数都落 state.json；「N 天内不重搜」避免每次全量。

## 5. 数据与配置

- 状态文件：`{Stash 配置目录}/plugin_data/SceneBackfill/state.json`。**不能放插件目录**——升级会覆盖。
- 锁文件：`plugin_data/SceneBackfill/run.lock`，内核字节锁（`msvcrt.locking` / `fcntl.flock`，锁住就不 unlink），pid 写 1 MiB 偏移处。
- 守护进程一律用 `sys.executable` 启动，**不要写死 `python` / `python3`**：Stash 调插件用的解释器不一定是 PATH 里那个（本机是 `...\pythoncore-3.14-64\python.exe`）。
- 内容缓存：`content` 段按 infohash 存文件清单（`[路径, 体积]`、汇总），45 天淘汰；同一 hash 跨场景复用，重跑不重复拉。

```json
{
  "version": 1,
  "control": {"autoSearch": false, "autoPush": false, "autoImport": false,
              "maxTotalGB": 0, "maxPerDay": 0},
  "daemon": {"pid": 7976, "startedAt": 1795083480, "lastTick": 1795083930,
             "lastAction": "capture, gate:0B + 6.5GB > 1.0MB"},
  "rules": {"text": "seeders >= 1\nvideo_bytes >= 100M",
            "fileSelect": "\\.(mp4|mkv)$", "fileExclude": "(^|/)samples?/",
            "fileMinShare": 0.3, "unknown": "ask"},
  "content": {"<infohash 或归一化标题>": {
    "files": [["CJOD-535/CJOD-535.mp4", 5793887864]],
    "count": 5, "total": 5822867994, "video_bytes": 5793887713,
    "largest_video": 5793887864, "at": 1795080778}},
  "scenes": {"303": {
    "id": "303", "code": "CJOD-535", "status": "matched",
    "candidates": [{"title": "", "infohash": "", "seeders": 48, "score": 0.8,
                    "resolution": "1080p", "verdict": "pass"}],
    "chosen": {"hash": "", "title": "", "size": 0, "picked": "", "pickedNote": "", "savePath": ""}
  }}
}
```

- `daemon` 由 worker 每轮写心跳；worker 正常退出时清成 `{"pid": 0, "lastTick": 0, "stoppedAt": …}`。`lastTick` 超过 5 分钟即视为已停。
- `lastCapture` 记上次全量捕获时间，5 分钟内不重复抓。

- 磁力候选在 `content` 里落 `{"magnet": true}`，预检失败落 `{"error": "..."}`，两者都让内容类规则返回 unknown（不是 fail）。
- `scenes[*].candidates[*].verdict` 是**试运行写回**的 `pass/fail/unknown`，列表页只用它排序和上色，不影响手动推送。

**配置分两处**，按「改的频率」切：

| 放 yml（插件设置页） | 放页面「设置」页签 |
|---|---|
| 连接与凭证、三个路径 | 自动化开关、总量闸、筛选规则、试运行、自检、清理 |

理由：规则是长文本 + 要配试运行，yml 的 STRING 弹窗做不了；而凭证是一次性配置，没必要占页面空间。

| 设置项（yml，全 `STRING`） | 说明 |
|---|---|
| `jackettUrl` / `jackettApiKey` | 与 stashDiscover 同形 |
| `prowlarrUrl` / `prowlarrApiKey` | 留空则不用这个源 |
| `qbUrl` / `qbUsername` / `qbPassword` / `qbApiKey` | qB ≥5.2 可只填 ApiKey |
| `qbCompletePath` | qB 视角的完成目录（如 `/downloads/input`） |
| `stashDownloadPath` | 同一目录的 Stash 视角（如 `\\192.168.3.190\media\downloads\input`）；只要容器读得到即可，不必是库路径 |
| `libraryPath` | 入库目录（必须是 Stash 库路径）；留空 = 原地入库，文件留在下载目录（此时要求 qB 的 `temp_path` 在库外，见 §7） |
| `keepSeeding` | 搬运方式，**仅 B 模式生效**。`false`（默认）= **移动**，省空间，qB 里该种子会转入缺失；`true` = **复制**，保留源文件继续做种，占双倍空间 |
| `stashUrl` / `stashApiKey` | 守护进程自连用；`stashUrl` 留空回落到 `127.0.0.1` + 探测到的端口 |
| `concurrency` | 每 tick 处理条数，默认 3 |

三个路径在两种部署下的具体填法见 §7 的表。NAS 上 Stash 与 qB 同机时前两个值可能不同名（qB 里是 `/downloads/input`，Stash 容器里挂成 `/qb/input`），Windows 上第二个要写 UNC。

## 6. 时钟：A + B 双驱动

同一个 tick 引擎，两个驱动者：**页面**（30s 一轮 tick，另有 8s 一次只读进度刷新，关页即停）与**守护进程**（90s 一轮）。守护进程是设置里一个开关，默认关。

| 问题 | 做法 | 备注 |
|---|---|---|
| 启动 | 页面「启动守护」→ op 内 `Popen([sys.executable, worker.py])` 后立即返回；Windows 加 `DETACHED_PROCESS \| CREATE_NO_WINDOW`，Linux 用 `start_new_session=True` | 启动后 4s 内等 worker 自己写一次心跳，等不到就报「立刻退出，见 worker.log」——否则一个马上崩溃的子进程会让 UI 假活 5 分钟 |
| 认证 | 守护进程没有 `runPluginOperation` 上下文，必须自带凭据 → `stashApiKey` | 留空则沿用启动时页面会话里的 key；两个都没有时，仅在自动化开关打开后自检才报红 |
| 单实例 | 内核字节锁 `daemon.lock`；tick 之间另有一把 `run.lock` | Windows 上第二实例连 `open("r+b")` 都打不开，所以「打不开」即「已在跑」（#45） |
| 心跳 | 每轮 tick **开始前**写 `daemon.lastTick`（先写再干活，45s 的 tick 也不会被判成死了） | UI 显示「守护中 · 12s 前」；超过 5min 视为已停 |
| 退出 | UI 点停止 → 写 `daemon.stopping`，worker 下一轮开头读到就退出并清心跳；**不 kill 进程**，避免打断搬运中途 | 三开关全关且无进行中工作满 30min 自退；连续 5 轮 tick 抛异常（Stash 重启了）也退出 |
| 共存 | 页面 tick 前先看 `daemon.alive`，守护活着就直接跳过，降级成只读查看器 | 两套时钟不会同时写 state.json |
| 预算 | 单 tick 45s 上限（反代 60s） | 一轮最多：1 次捕获（5min 节流）+ 1 次 qB 读 + 若干入库 + 若干推送 + **1 条搜索**；预算不够的留到下一轮 |

**B 的另一条路已否掉（2026-11-19 查证）**：`stash-scheduler` 那种「点一次就常驻」的形态，本质是让一个插件 task **一直不返回**——Stash 的 task 就是等插件子进程退出，所以「常驻」= 长期占着一个 job，任务列表里永远显示运行中，还可能挤压扫描任务；它自己也仍然要靠 systemd / 启动脚本在 Stash 重启后重新拉起。因此不采用，直接走 detach 子进程（实测能活过插件调用，#44）。

## 7. 路径与入库：搬运归插件，Stash 只负责扫 + 合并

**为什么不再走 `moveFiles`**

1. 它的入参是「已经在库里的文件 id」，所以必须先扫下载目录 → 下载目录不得不建成库路径 → 见第 2 条。
2. 下载目录一旦是库路径，代价固定：没下完的半成品会被扫（qB 的 `temp_path` 能挡住一部分，但搬走文件后下次扫描会把它标成 missing）、13 条库路径的扫描范围白涨、种子里那堆广告文件也进库。
3. 它跨卷靠 `SafeMove`（rename → 复制 → 删源，源码实证 #24），能用，但是**同步**跑在 GraphQL 请求里：无进度、不能续传、复制期间持着写事务（#33）。2GB 在 HDD 上 15~30s，用户只能看着页面转圈。

结论：搬运由插件自己做，Stash 只出「扫描」和「合并」两件事。

**三个路径**

| 项 | 谁的视角 | 约束 |
|---|---|---|
| `qbCompletePath` | qB | qB 的完成目录（推种显式带 `savepath` + `category=SceneBackfill`，只认这一个） |
| `stashDownloadPath` | Stash | 同一目录的 Stash 视角；**只要容器里看得到、读得到**，不要求是库路径 |
| `libraryPath` | Stash | 入库目标，**必须是库路径**；留空 = 原地入库（此时 `stashDownloadPath` 自身必须是库路径） |

留空就是原地入库（扫下载目录里的文件），填了就是搬入库（搬到 `libraryPath` 再扫）。用户只填路径，不用选模式。**原地入库不等于免掉搬运，只是把搬运交给了 qB**：

| 方式 | 触发 | 谁搬 | 能保种 | 进度 | 失败怎么办 |
|---|---|---|---|---|---|
| A 原地入库 | `libraryPath` 留空 | qB 完成时自动从 temp 移到 save_path | 不能（qB 完成移动必删源） | 只有 `moving` 状态，看不到字节 | qB 停在 error，插件只能重推 |
| B 插件搬（默认推荐） | `libraryPath` 填了 | 插件 `safe_move` | `keepSeeding` 可控 | 字节级 | 留在「已完成」错误组，可重试 |

A 的致命点只有一个：**未完成文件不能落在库路径里**。你那台 qB 现在是 `temp_path_enabled=true` + `temp_path=/downloads/incomplete`（实测），半成品在下载盘的 temp 里、完成才移到 `input`，所以 A 是安全的。但 `temp_path` 一旦关掉就会出问题——`incomplete_files_ext` 也是 `false`，qB 会**以最终文件名边下边写**，Stash 扫到一个半截视频：建场景、算 oshash、之后文件长大也不会自动重算。自检里必须把这两项都查。

| 形态 | `qbCompletePath` | `stashDownloadPath` | `libraryPath` |
|---|---|---|---|
| **NAS 生产**（qB 与 Stash 同机） | `/downloads/input` | `/qb/input`（用户已挂进来，#34） | 填 `/data/...`（走 B，能归档、能保种）；留空则文件永远留在 `/qb/input`（走 A，要求 temp 在库外） |
| **Windows 测试**（qB 在 NAS） | `/downloads/input` | `\\192.168.3.190\media\downloads\input` | `E:\Temp\测试库\...`；留空 = 扫 UNC 原地入库 |

**搬运实现**（等价 `SafeMove`，但归我们管）：

```
try: os.replace(src, dst)                  # 同卷：瞬间完成
except OSError:                             # Linux 跨挂载 EXDEV / Windows ERROR_NOT_SAME_DEVICE
    copy2(src, dst + ".part") → flush+fsync → 核对 size → os.replace(dst.part, dst) → remove(src)
```

- **先写 `.part` 再原子改名**：中断只留一个 `.part`，不会出现「半截视频被当成正片入库」。
- 核对 size 之后才删源；删源失败就把新文件删掉并报错（和 Stash 的 `SafeMove` 同策略）。
- **目标已存在不覆盖**：同 size 视为「上次已搬成功」→ 直接进下一步；不同 size → 加 ` (2)` 后缀，绝不动库里已有的文件。
- 不预判同卷：Unraid 的 `/mnt/user` 是 FUSE 联合挂载，两个目录 `st_dev` 可能相同而 rename 照样 EXDEV；`try/except` 比判断可靠。
- 目标文件名：`libraryPath/<basename>`，默认沿用种子里的文件名（整理命名交给 Stash 或 renamer 插件）。
- **保种冲突**：搬走文件 = 那个种子在 qB 里变「缺失」。`keepSeeding` 默认 `false`（移动）：省空间，qB 里那个任务会转成缺失状态，插件**不替它删任务**，留着不影响任何事；想继续做种就开成 `true`（复制不删源，占双倍空间）。
- 搬完的判定**不能看源文件在不在**：复制模式下源本来就在。一律以 State 里的搬运标记 + 目标文件 size 校验为准，否则复制模式会被自己判成「还没搬」而反复搬。
- 搬运状态读 qB 时同理：移动模式下 qB 会报 `missingFiles` / `error`，那是我们自己搬走的，别当失败重推。判据是「该 hash 已进 `downloaded` 且目标文件 size 吻合」。

**闭环（2026-11-19 实测通过，#32）**

1. qB `progress = 1` → 等 3~5s 落盘
2. 拼路径：`properties.save_path` + `torrents/files` 的相对路径（qB 5.x 的 `info` 没有 `content_path`），按映射翻成 Stash 视角 → `os.path.exists` 校验；不存在就是映射错，报错停手
3. 配了 `libraryPath` → `safe_move` 到目标；没配 → 直接用下载目录里的路径
4. `metadataScan(paths:[目标文件])`，单文件扫描即可（#5）；异步任务，别等返回就以为扫完
5. `findFiles` 按路径拿 id，看它挂在哪个场景：
   - 已挂在原场景 → 完成（同 oshash 情况，#10）
   - 挂在一个新场景 → 下一步
   - 还没扫到 → 等下一轮
6. `sceneMerge(source:[新场景], destination: 原场景)` → 文件挂过去、source 自动删除、原场景 id / code / title / stash_ids 全保留（#7）
7. 校验原场景 `files` 非空 → `imported`

**不要用 `sceneDestroy` + `sceneAssignFile`**：文件归属新场景时 assign 报 `cannot reassign primary file`，必须先删场景把文件变成孤儿，中间留「场景没了、文件无主」的窗口。`sceneMerge` 一条 mutation 做完，没有中间态。

**生产库注意事项（NAS）**

- `/qb/input` 在不在库路径里，取决于选 A 还是 B，**两者互斥，别同时做**：
  - 走 **B**（填 `libraryPath`，文件搬进 `/data/...`）→ 把 `/qb/input` **从库路径撤掉**。留着会长出三个坑：全库扫描覆盖下载区、文件搬走后下次扫描报 missing、库路径列表越滚越长。
  - 走 **A**（`libraryPath` 留空）→ **必须留着**，且要确认 qB 的 `temp_path` 不在任何库路径内（半成品不能被发现）。
- `/qb` 与 `/data` 大概率是两个挂载点，跨挂载走复制；进度必须显示（已复制字节 / 总字节），别让页面干等。
- 生产库不做写测试。本轮所有写入都只发生在 Windows 测试库，NAS 只跑了只读查询。

**自检四项**（打开页面就跑，任一红就不让开始）

1. qB 可达且认证通过（记版本，决定 `stop/start` 还是 `pause/resume`）。
2. `stashDownloadPath` 存在且可读（**不要求是库路径**——这正是这次改法的收益）。
3. `libraryPath` 在库路径内、且可写（写一个 `.sf_probe` 再删掉）。**留空即走 A**，改查两件事：`stashDownloadPath` 在库路径内、且 qB 的 `temp_path_enabled=true` 而 `temp_path` 不落在任何库路径里；任一不满足就红字拦住——这是半成品入库的唯一入口。
4. 两个路径不是同一个目录（防自己搬自己），且剩余空间 ≥ 待搬体积。

## 8. 搜索源

| 源 | 接口 | 备注 |
|---|---|---|
| Jackett | `GET /api/v2.0/indexers/all/results/torznab/api?apikey=…&t=search&q=…` | 移植 stashDiscover 的 `_parse_torznab()` / `_normalize_torznab_url()` / `do_search()` |
| Prowlarr | `GET /api/v1/search?query=…&type=search`，`X-Api-Key` | 有 `downloadUrl` / `magnetUrl` / `seeders` / `size` / `indexer`；分辨率要自己解析 |

- 搜索词优先级：`code`（有番号就用，最准）→ 日期 + 首位女演员 → 标题 token。番号无结果时去掉连字符再试一次。
- 多源并行，按 **infohash 去重合并**，同一 release 取最大 seeders。实测去重率很高：28 条 → 11 个 hash，11 条 → 5 个。
- **infohash 不一定在 XML 里**：常规 indexer 有 `<torznab:attr name="infohash">`，磁力型 indexer 没有（只有 `seeders` / `peers` / `downloadvolumefactor`）。要拿 hash 得对 `enclosure` 发一次**不跟随重定向**的请求，读 `Location: magnet:?xt=urn:btih:…`（§1 #13）。这一步顺带就判定了「有没有 .torrent」。
- indexer 归属在 `<jackettindexer id="…">` 子元素里，**不要用命名空间路径取**（`findall('{torznab}jackettindexer')` 取不到），按标签后缀匹配最稳。
- 搜索耗时：正常 0.7~1.4s，**尾延迟能到 40s**（某 indexer 挂住，§1 #12）。所以 `timeout` 设 25~30s + 失败重试一次，且搜索不要卡在同步 op 里（守护进程 / 后台线程跑，UI 轮询状态）。
- 同一源两次请求间隔 ≥ 1s；限流就退回串行。
- `.torrent` 拉下来先验 `b'd:'` 开头且能完整 bencode 解析，不能就直接标「清单不可用」，别把 HTML 错误页当种子传进 qB。

## 9. 筛选：DSL + 试运行

两层。硬筛和内容规则**写在同一份 DSL 里**，一行一条，默认 AND（要 OR 用正则的 `|`，不引入括号和优先级——规则一复杂，调试成本远超省下的几行）。

```
# 硬筛
seeders >= 3
resolution in [1080p, 2160p]
size <= 20G
indexer in ["sukebei"]

# 内容（需 .torrent，磁力候选为 unknown）
files has /\.(mp4|mkv|wmv)$/i
files !has /(^|\/)(sample|广告|宣传)\//i
filecount <= 5
video_bytes >= 1.5G
largest_video_share >= 0.6
video_name ~ /HND-391/i
```

| 字段 | 需要清单 | 说明 |
|---|---|---|
| `title` / `indexer` | 否 | 字符串，`~` / `!~` 走正则 |
| `size` / `seeders` / `leechers` / `resolution` | 否 | 正则无匹配时 `resolution` 为 unknown |
| `files` / `filecount` / `video_bytes` / `largest_video_share` / `video_name` | **是** | 磁力候选为 unknown |
| `freeleech` | 否 | torznab `downloadvolumefactor = 0` |

- 操作符：`>= <= == != in [..] has !has ~ !~`；体积支持 `800M` / `20G` 后缀。
- 三态求值：`pass` / `fail` / `unknown`。`unknown` 的处置单独设一项：放行 / 淘汰 / **需人工确认（默认）**，落进「有结果 · 需人工确认」。
- **求值只在 python 侧跑**，试运行走一次 `mode: eval_rules` 的 op（候选已缓存，秒回）。不做 JS 版求值器——两套正则实现迟早漂移，会造出「试运行通过、实际推送被淘汰」这种最难查的 bug。
- 试运行面板要显示每条规则淘汰了多少候选（`7/12`）。量级写错（20G 写成 20M）时这个数字一眼能看出来。

**「只下视频」不够，必须选集**（实测 §1 #17）：真实种子里广告文件本身就是 `.mp4`，体积却只有主视频的万分之几。

| 实测样本（HND-391 / START-608） | 体积 | 占整包 |
|---|---|---|
| `HND-391.mp4`（正片） | 2002.9M | 99.5% |
| `manko.fun.mp4` | 10.5M | 0.5% |
| `社 區 最 新 情 報.mp4` | 14.4M | 0.5% |
| `台湾uu美少女直播 20年信誉保证服务全球.mp4` | 13.2M | 0.45% |
| `18+游戏大全(996gg.cc)-….mp4` | 1.9M | 0.05% |
| `.url` / `.html` / `.txt`（带网址） | ~0 | 0 |

所以选集规则独立于淘汰规则，写成 `file_` 前缀：

```
file_select  /\.(mp4|mkv|wmv|ts|m2ts|avi|mov|m4v)$/i   # 候选文件池
file_exclude /(^|\/)samples?\//i                       # 样本目录，可留空
file_min_share 0.3                                     # 体积 ≥ 最大视频的 30%
```

- 三条是 AND：先按扩展名取池，再去掉命中的，再按占比切。
- **默认排除词只留 `samples/`，广告靠占比切**（实测 #36 #37）：域名型排除词（`489155`、`996gg`）会命中主视频的文件名 `489155.com@CJOD-535-UC.mp4`——那是压制组标签，不是广告。真正要切掉的广告占整包 0.05~0.7%，`file_min_share 0.3` 已经全切。
- **分层回退**（#38）：占比切完若池为空，先在**文件池内**取最大视频（`note=largest`），池也空才退到全种子的最大视频（`note=largest-any`）。顺序反了会出现「排除词本意是干掉广告，结果选中了它」。
- 没有 `file_select` 时可退化成「只下最大的那个文件」，但合集种子里会漏，所以默认带上扩展名白名单。
- 磁力候选没有清单 → 选集为空 → 只能整包下，UI 明示「将整包下载，无法选集」。

### 规则决定状态

搜索一结束就用同一套规则给每个候选打 verdict，再定场景状态——「有结果」只装筛过的，永不等人重判：

| 判定 | 状态 | 去哪 | 之后 |
|---|---|---|---|
| ≥1 个 pass | `matched` | 有结果 | 自动推送（开关打开时） |
| 只有 unknown | `low_confidence` | 待处理（需确认） | 24 小时后自动重查 |
| 全 fail 或没候选 | `no_result` | 待处理（无结果） | 15m / 1h / 6h / 24h 退避重搜，6 次停手 |

文件清单还没抓到时 verdict 是 unknown，tick 会先补 `.torrent` 再重判，所以「有结果」不会停在半判定状态。规则一保存就重判所有在途场景，不用等下一轮搜索。
- `freeleech` 只当参考，不当稀缺信号：实测 TorrentDownload 同一批 13 条里 6 条全标 `downloadvolumefactor=0`。

**边界分片可能留下残片**：被跳过的文件若与要下的文件共享一个分片（2~4MB），qB 会把那一小段也写下来（按分片粒度，未逐字节验证）。解法是**只扫选中的那个文件路径**（单文件扫描实测可用 #5），不要扫整个目录；扫完只认选集里的 file id，其余不 merge、也不主动删（留给用户或 qB）。

- 有广告文件**不淘汰整包**：选集就能绕开。淘汰只留给 `exe/scr/lnk`、视频数为 0、最大视频占整包 < 20% 这种真垃圾。
- 体积筛选一律用**视频子集体积**，不是整包体积。

**打分只负责把候选分成「达标签选 / 需人工确认」，不参与规则淘汰**（规则是硬门槛，打分是同分排序）：

| 信号 | 权重（初值，待实测调） |
|---|---|
| 番号归一化后精确出现在标题 | ≥ 0.6 |
| 日期三元组相邻命中 | +0.34 |
| 标题 token 命中率 | 0 ~ 0.4 |

总分 ≥ 阈值（默认 0.6）→ `matched`；有候选但没到 → `low_confidence`。

分辨率判定：标题正则（`2160p|4k|1080p|720p…`）与文件清单（视频文件名、单文件体积）各判一次，**两处不一致取低**；都没有就是 unknown，不猜。

## 10. 下载器：只做 qB（v1），已按 5.3.0 实测

先 `GET /api/v2/app/version` 取版本，再选端点集：**5.x 用 `stop`/`start`，≤4.x 用 `pause`/`resume`**，两套都写上、按版本分支（实测 5.3.0 打 `pause`/`resume` 是 404）。

| 步骤 | 接口 | 实测要点 |
|---|---|---|
| 登录 | `POST /api/v2/auth/login`（form: username/password） | 5.3 回 **204** + `Set-Cookie: QBT_SID_<port>`；≤5.2 回 200 + `Ok.`；都要带 `Referer` |
| 加种 | `POST /api/v2/torrents/add`，multipart，`torrents` 字段放 .torrent 字节 | **立即回 `{"added_torrent_ids":["<hash>"]}`**、中文名不乱码。用 `urls` 传 Jackett 直链则回 `pending_count:1`（拿不到 hash）、名字被百分号编码——别用 |
| 加种参数 | `savepath` / `category=SceneBackfill` / `tags=sf:<sceneId>` / `stopped=true`（5.x）或 `paused=true`（4.x） | 5.3 **不认 `paused`**，传了也照下（实测第一次就这么翻的） |
| 清单 | `GET /api/v2/torrents/files?hash=` | 磁力未拿到元数据时返回 `[]`，不是报错 |
| 选文件 | `POST /api/v2/torrents/filePrio`：`hash` + `id`（`\|` 或逗号分隔）+ `priority`（1 正常 / 0 跳过） | `stoppedDL` 状态生效；改完 `torrents/info.size` 立刻变成选中体积 |
| 开始 / 停止 | `POST /api/v2/torrents/start` / `stop`（5.x） | 200 空体 |
| 进度 | `GET /api/v2/torrents/info?hashes=a\|b\|c` | 3 条 5~6ms；**别不带 hashes 全量拉**，单条 ~17KB |
| 元数据判据 | `GET /api/v2/torrents/properties?hash=` → `has_metadata` / `total_size` / `download_path` | 磁力 45s 仍 `has_metadata=false`（§1 #22） |
| 删除 | `POST /api/v2/torrents/delete`，`deleteFiles=false` | 文件已入库，只删任务 |

- **加种后 `torrents/files` 可能先返回 `[]`**：元数据没解析完时设 `filePrio` 会被静默丢弃（`size` 仍是整包、所有文件 prio 都是 1），必须轮询到清单非空再选集。v0.1 实现时踩过。
- 推种流程：插件自己拉 .torrent（要解析清单，字节本来就在手）→ multipart 上传（`stopped=true`）→ 等 files 非空 → `filePrio` 设定选集、其余 0 → `start`。全过程同步、有 hash、无轮询等待。
- 磁力候选：只能 `urls` 加，拿到 hash 但没有清单，选集只能整包；`start` 后进入「等元数据」，45s 无果就标「元数据超时」让人决定，不要无限等。
- 选文件**按路径匹配，不按下标**：磁力和种子的文件顺序未必一致。
- 进度一次批量查全部 hash，5s 一轮，全部终态就停；顶部显示登录状态 / qB 版本 / 离线。
- **`progress=1` 不等于文件已到位**：qB 从 temp 移到 save_path 期间状态是 `moving`（跨挂载时是复制），此时 `progress` 已经是 1.0 但文件还在 incomplete。判「可扫描」必须同时满足 `progress>=1` 且 `state` 不在 `moving / checkingUP / checkingResumeData / allocating`。走 A（原地入库）时这条尤其关键，否则会扫到一个正在搬的文件。
- 去重：先在 `torrents/info?hashes=<infohash>` 里确认没有同 hash 再推（`add` 撞车会回 409 `Conflict`）。
- 用 `tags=sf:<sceneId>` 找回关系，不依赖内存状态；qB 里删了任务就按「无记录」重建。
- 「将下载 X」直接用 `size`（= 选集体积），不用自己算、也不用 `total_size`。

## 11. 暂不做的两条

**Motrix / aria2（记录，v0.5 再说）**：用户 NAS 上 Motrix 一直在跑（`192.168.3.190:8066`，aria2 JSON-RPC 要 token，实测未接）。aria2 的 `--select-file` 只能在 `addTorrent` 那一刻给定，没有「暂停 → 改选择 → 继续」的等价流程，也无法对磁力预检。所以 Motrix 只能是**降级模式**：仅对拿到 .torrent 的候选做「只下视频」，磁力候选整包下、内容类规则一律 unknown。

**Whisparr 当搜索源（否决，别再讨论）**：它的 release 搜索依赖自己配的 indexer，且要先有对应条目的 series/movie 才能搜——库里没有的片子它也没有；它能做的是「给一个 stash_id，自己决定下哪一版」，这与本插件「按分辨率 / 做种挑 release」直接冲突。搜索源只做 Jackett + Prowlarr。

## 12. 风险

1. **误下**：搜索是猜词，低置信必须拦。自动推送只对 `matched` 生效，低置信永远手动。
2. **占盘**：`maxTotalGB` 是硬闸，不是提示；开自动前给出「本次将推 N 条 / 预计 X GB」的确认。
3. **搬坏文件**：跨盘复制可能中断（断电、容器重启）。对策：写 `.part` → fsync → 核对 size → 原子改名 → `keepSeeding=false` 时才删源；中断只留 `.part`，重跑时覆盖。失败留在「已完成」错误组，可手动重试。
4. **重复下载**：同 hash 已推过不重复推；同场景已 `imported` 不再处理。
5. **indexer 限流 / 被封**：分片 + 间隔 + 可暂停，必要时按源串行。
6. **欧美场景命中率低**：没有番号时搜索词质量差，低置信会很多——这是数据现实，页面上要说清，不是 bug。
7. **重复内容**：同 oshash 的文件扫描时会被 Stash 自动挂到既有场景、不新建（实测）。判断依据是 `file.scenes` 已包含目标场景，此时不要 merge，直接算完成。
8. **两个插件同时推同一场景**：stashDiscover 也有推送入口；两边 category 不同，插件只认自己的记录。

## 13. 已决 / 待实测 / 未决

已决：

- 插件名 SceneBackfill；独立插件，不并入 stashDiscover。
- 时钟 A + B（守护进程做开关，默认关）。
- 三条路径；**默认由插件搬运**（`os.replace` → 失败则 `.part` 复制 → 核对 → 删源），不用 `moveFiles`。`libraryPath` 留空 = 原地入库，搬运交给 qB，代价是不保种、只有 `moving` 状态无进度、失败只能重推，且要求 qB 的 `temp_path` 开着并落在库外。两条路互斥，由填不填决定，不需要用户选模式。
- **两种部署形态都要支持**：NAS 上的 Stash（库 `/data/*`，qB 与 Stash 同机，下载目录以 `/qb` 挂进来）与 Windows 上的 Stash（库本地、qB 在 NAS，走 UNC）。Windows 主要是自己测试用，但社区用户多在这边，不能只按 NAS 设计。
- 生产库（NAS）不做写测试；插件在那边只做「扫描 + 合并」，文件搬运只碰 `/qb/input` → 目标库目录。
- 筛选、试运行只在 python 求值；选题用「选集三行」（`file_select` / `file_exclude` / `file_min_share`），不再是「只下视频」。
- `keepSeeding` 默认 `false` = 移动（省空间，qB 里种子转缺失），开成 `true` = 复制保种。搬运完成与否只看 State 标记 + 目标 size，不看源文件在不在。
- v1 只支持 qB；按 `/app/version` 选 `stop/start` 还是 `pause/resume`；加种一律 multipart 上传 .torrent，不用 `urls` 传直链。

待实测（开工 v0.1 时做）：

1. 一条真种子从推送到 `imported` 全链路（含真文件、真分片残片的清理）。每一步都已单独实测，缺的是连起来。
2. NAS 上 `/qb` 与 `/data` 是否同一挂载（决定 2GB 是秒级 rename 还是 20s 复制，影响进度 UI 的粒度）。在容器里 `df /qb /data` 一眼就知道。
3. 跨文件边界分片到底会给被跳过的文件留下多大残片（决定入库后要不要清理 `.part` / 残片）。

已决（v0.3 追加）：

- **多文件入库**：`do_import` 改成「逐个搬 → 一次批量 `metadataScan` → 批量 `findFiles` 拿 id → 一条 `sceneMerge` 带多个 source」，A/B 段与合集不再只入最大那个。实测两个文件 3.4s 入库，原场景 `files` 两条。
- **总量闸**默认 0（不限），页面可设 `maxTotalGB` 与`maxPerDay`；触顶时 tick 停手，原因写进「最近」一行（如 `gate:0B + 6.5GB > 1.0MB`）。
- **搬完不删 qB 任务**：删任务会断做种历史，下载页给「移除」（只删任务、`deleteFiles=false`）让用户自己决定。
- 移除任务后记录回到 `matched`（有候选）或 `captured`，可以直接换候选重推。

未决：

1. README 里要不要直接给 docker 挂载片段（`-v /mnt/user/downloads:/qb`），还是只写「让 Stash 看得到下载目录」。

## 14. 分期

| 期 | 范围 | 验收 |
|---|---|---|
| v0.1 | 捕获 + 单源搜索 + 手动推送 + 闭环打通（原地入库 / 搬入库都走同一条 `safe_move`） | 本地空场景跑通：搜到 → 推 qB（只下选集）→ 100% → 搬运 → 扫单文件 → merge → 原场景 `files` 非空 |
| v0.2 ✅ | 规则 DSL + 清单预检 + 选集三行 + 试运行面板，**已完成**（2026-11-19） | 实测 CJOD-535：13 个候选 → 8 pass / 5 unknown（磁力）/ 1 fail（0 做种）；8 条有清单的候选全部选 1/N 个文件；推 720p 候选后 qB 里 `javsubs91.txt` 优先级 0、主视频 1，size 只算视频 |
| v0.3 ✅ | 三个开关 + 总量闸 + 守护进程 + 进度页 + 多文件入库，**已完成**（2026-11-19） | 守护进程存活 9 分钟、跑 5 轮 tick、stop 后自退清心跳；关页后仍推进；总量闸拦住 6.5GB（`gate:0B + 6.5GB > 1.0MB`）；自动搜索 2.4s 搜回 13 条；两文件种子入库并 merge；下载页暂停/继续/移除 |
| v0.3.1 ✅ | 规则驱动状态（搜完立刻判定，通过才进「有结果」）+ 封面卡片 + 无结果退避重搜 + 守护自带 api key，**已完成**（2026-11-19） | 守护自动跑出 `search:165:low_confidence → screen:252:matched`；未通过的全部退回待处理并显示「第 N 次 · 淘汰 X · 下次 HH:MM」；离线 7 条退避调度断言全过 |
| v0.4 | Prowlarr 双源 + 去重合并 | 双源结果按 infohash 合并（磁力型候选走 302 解 infohash） |
| v0.5 | Motrix 降级模式 | 仅 .torrent 候选可只下视频 |

## 15. 可复用代码索引

| 用途 | 位置 |
|---|---|
| torznab 解析 | `stashDiscover.py:193 _parse_torznab()` |
| torznab URL 归一化 | `stashDiscover.py:284 _normalize_torznab_url()` |
| 大小格式化 | `stashDiscover.py:274 _human_size()` |
| Jackett 搜索主流程 | `stashDiscover.py:308 do_search()` |
| 推 qB（登录 204/200 兼容、取 SID） | `stashDiscover.py:397 _push_qbittorrent()` |
| 搜索词是否番号 | `stashDiscover.js:8143 looksLikeCode()` |
| 标题匹配打分 | `stashDiscover.js:8505 titleMatchScore()` |
| 数值设置项解析（0 与空值语义） | `stashDiscover.py:297 _int_setting()` |
| 单实例锁（内核字节锁 + 1 MiB 偏移） | `ImageMetaSync/ImageMetaSync.py`（v1.0.4） |
| 三路径设置的文案与形态 | binge 的 `social_save_path`（`daemon_write_path` + `stash_path`） |
| 下载状态轮询的设计取舍 | `docs/stashdiscover-download-status.md` |

## 16. 开新对话怎么用

整篇贴进去，补一句「按这份方案开工做 v0.1」。§1 的实测结论不要重跑；v0.1 只剩「一条真种子连起来跑一遍」这件事，§13 的三个未决（总量闸默认值、要不要删空的 qB 任务、README 给不给挂载片段）可以在实现到那一步时再定。
