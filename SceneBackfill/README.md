# SceneBackfill

> v0.1.2：已忽略 tab 不再显示数量；下载中无任务时批量按钮常驻置灰，状态行高度保持一致。

Stash 插件：把只有元数据、没有文件的场景补齐——搜资源、交给下载器或 Whisparr，完成后把文件关联回原场景。全程不搬动文件。

## 依赖

| 组件 | 要求 |
|---|---|
| Stash | v0.31+ |
| Jackett 或 Prowlarr | `self` 模式：已配置至少一个索引器 |
| 下载器 | `self` 模式：qBittorrent 4.1+ 或 Motrix（桌面版 / Server/NAS 版） |
| Whisparr v3 (Eros) | `whisparr` 模式：需自带索引器与下载客户端 |
| Python | 3.8+（Stash 自带解释器即可） |

## 安装

1. 把 `SceneBackfill/` 复制到插件目录（`%USERPROFILE%\.stash\plugins\`）
2. 设置 → 插件 → Reload Plugins

## 设置

| 项 | 说明 |
|---|---|
| Fill Mode | `self`（自己搜、自己推）或 `whisparr`（交给 Whisparr）；留空 = `self` |
| Indexer | `jackett` 或 `prowlarr`；`self` 模式使用 |
| Indexer URL / API Key | 上面选中的索引器地址与密钥 |
| Network Timeout | 索引器搜索与种子预取的单次超时（秒）；留空 = 120，上限 600。NAS 或慢索引器可调大 |
| Downloader | `qb` 或 `motrix` |
| Downloader URL | qBittorrent Web UI（8090）、Motrix 桌面版 RPC（16800）或 Server 版 Web UI（8066） |
| Downloader Username | qBittorrent 登录名；Motrix 忽略 |
| Downloader Password / RPC Secret | qBittorrent 密码、Motrix 桌面版 `--rpc-secret` 或 Server 版 Web 登录密钥 |
| Whisparr URL / API Key | Whisparr v3 地址与 API Key；`whisparr` 模式使用 |
| Whisparr Root Folder | Whisparr 根目录在 Stash 里的路径；必须在库路径内，两边同名可留空 |
| Download Folder (downloader side) | 下载器视角的完成目录 |
| Download Folder (Stash side) | 同一目录在 Stash 里的路径；必须在库路径内 |

## 补档方式

|  | self | whisparr |
|---|---|---|
| 谁搜片、挑版本、调下载器 | 插件（Jackett / Prowlarr + qBittorrent / Motrix） | Whisparr v3 |
| 链路 | 捕获 → 搜索 → 按规则筛选 → 推送 → 下载 → 扫描 → 关联 | 捕获 → 交给 Whisparr → 轮询 → 扫描 → 关联 |
| 筛选规则 | 生效 | 不适用 |
| 完成后的文件 | 原地扫描后关联 | 留在 Whisparr 根目录 |

Whisparr 只认 StashDB 的场景 ID；只有 javstash ID 的场景不会交给它，会标注原因留在待处理。

## 路径怎么填

| 部署 | Download Folder (downloader side) | Download Folder (Stash side) |
|---|---|---|
| 下载器与 Stash 同机（Docker 各自挂载） | `/downloads/input` | `/qb/input` |
| 下载器在 NAS、Stash 在 Windows | `/downloads/input` | `\\nas\media\downloads\input` |

Stash 侧路径必须能被 Stash 读到且位于库路径内；qB 的临时目录要放在库外。

## 筛选规则

全部是勾选和下拉，不需要写正则。

| 项 | 说明 |
|---|---|
| 最低做种 | 低于这个数的资源不要 |
| 最多文件数 | 整包零碎文件太多的不要 |
| 视频最少体积 | 按整包视频总量算，1000 = 1GB；磁力按整包体积估 |
| 分辨率 | 点选，留空 = 不限 |
| 视频格式 | 点选容器格式，留空 = 不限；取消 ISO 即忽略 ISO 资源 |
| 标题必须包含 / 标题排除 | 空格分隔，可留空 |
| 整包拉黑关键词 | 标题或包内任一文件名命中就整包不要 |
| 下载哪些文件 | 只要视频 / 视频 + 字幕 / 全部文件 |
| 样片目录 | 种子里的 Sample 短片，跳过或少下 |
| 小文件门槛 | 低于正片这个体积比例的附带文件不下（≥10% / ≥30% / ≥60%） |
| 规则无法判定时 | 磁力判不了的规则按这里处置 |

全部满足才通过；原有规则行保留在「其他规则（高级）」。

**排序**（只在已通过的候选里比较，不参与淘汰；同分取做种多的）：

| 项 | 加分 |
|---|---|
| 番号出现在标题里 | 0.6 |
| 发布日期出现在标题里 | 0.2 |
| 搜索词其余部分的重合度 | ≤ 0.2 |
| 带 `-C` / `-U` / `-UC` 后缀（可选） | 0.25 |
| 含「最新地址」文件（可选） | 0.30 |

磁力看不到文件清单，拿不到「最新地址」这一档加分。

## 工作方式

`self` 模式：捕获 `files` 为空的场景 → 先按番号搜，没有番号就按标题、演员 + 日期、厂牌 + 日期搜 → 候选过筛选规则 → 推送选中的资源并只下选集里的文件 → 下载完成后在下载目录里原地扫描，把扫出来的场景关联回原场景。

`whisparr` 模式跳过搜索、筛选与推送：缺片直接交给 Whisparr，插件轮询到它导入文件后只做扫描与关联。

封面左下角是场景的番号（Stash 的 Scene Code），搜索优先用它。

## 自动化

| 开关 | 默认 | 做什么 |
|---|---|---|
| 捕获 → 搜索 | 关 | 新空场景自动搜；没搜到的按 15 分钟 → 1 小时 → 6 小时 → 24 小时退避重搜，6 次后停手 |
| 筛选 → 推送 | 关 | 规则全部通过的候选自动推；无法判定的按「规则无法判定时」处理 |
| 下载 → 入库 | 关 | 下载完成自动扫描、关联，不搬文件 |

`whisparr` 模式没有「捕获 → 搜索」；「筛选 → 推送」变为自动把缺片加进 Whisparr，「下载 → 入库」变为扫描并关联。

| 上限 | 说明 |
|---|---|
| 总量上限 GB | 未入库的下载总量，超了不再推。0 = 不限 |
| 每日条数 | 24 小时内最多推几条。0 = 不限 |

关掉页面后，守护进程会继续推进；三个开关全关且没有进行中的任务时自动退出。入库失败会退避重试，手动点「入库」立即重试。

## 文件说明

| 文件 | 作用 |
|---|---|
| `SceneBackfill.yml` | 设置项与插件元数据 |
| `SceneBackfill.py` | 全部后端逻辑，按 `mode` 分发操作，stdout 只回一条 JSON |
| `SceneBackfillWorker.py` | 后台守护进程，单实例 |
| `scenebackfill.js` / `.css` | 补档页面与设置页 UI |

## 注意事项

- 索引器搜索与种子预取都是同步请求，最长要到 Network Timeout（默认 120 秒）；Stash 前面有反向代理时，把它的超时放宽到 180 秒以上，否则会被提前切断
- 磁力只有整包体积可判，文件数、最大视频占比、「最新地址」加分都判不了
- 欧美（stashdb）场景通常没有番号，只能按标题或演员搜，命中率取决于索引器
- 插件不搬文件：文件留在下载目录，删掉它场景就会缺文件；要归档请自己复制后再让 Stash 扫描
- Motrix 桌面版没有独立临时目录，半成品直接写在下载目录里，可能被提前扫到
- Motrix Server/NAS 版只支持磁力，不能挑文件或设优先级，只能整个种子下载；规则与试运行照常判定，执行时会连杂项一起下
- 守护进程不自启；Stash 重启后，下次打开 Stash 页面时它会回来（手动停掉的不回来）
- `whisparr` 模式只支持 Whisparr v3 (Eros) 和 StashDB 场景 ID；索引器与下载客户端由 Whisparr 自己配置
- `whisparr` 模式不搬文件、不提供暂停与恢复；「总量上限 GB」不适用，「每日条数」仍生效
- `whisparr` 模式的根目录不在库路径内时扫不到文件，自检会报出来
- 切换补档方式会清掉旧模式的未完成记录（保留已入库）
