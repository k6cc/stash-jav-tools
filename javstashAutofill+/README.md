# Javstash Autofill+

> v1.2.1：日志文件显式 UTF-8 编码（errors=backslashreplace），消除 Linux/Docker 容器 C locale 下日志静默丢失（插件功能本不受影响）。

新演员创建时自动从 JAVStash 补全元数据；新场景入库时按文件指纹（oshash）自动从 JAVStash 补空白字段与 stash_id。纯后台 Python，无 UI 注入。

## 触发方式

| Hook / Task | 行为 |
| --- | --- |
| `Performer.Create.Post` | 演员创建后钩子立即返回，后台进程延迟 `performerFillDelay`（默认 2s）再反查/匹配填充 |
| `Scene.Create.Post` | 新场景按 oshash 查 JAVStash，延迟 `sceneFillDelay`（默认 20s）等 NFO 写入后填充空白字段与 stash_id |
| Task「Backfill scenes stash-box ID」 | 扫全库缺 JAVStash ID 的场景，按 oshash 批量补全 |

## 演员行为

- **反查优先（带 stash_id）**：创建时带 stash_id → 先反查本地同 id 演员；命中即合并复用（创建名与主名/别名不同则追加为别名），不新建；本地无 → 按 stash_id 直抓详情补全（绕过名称匹配）。
- **0.9 名称匹配（无 stash_id）**：按名取相似度最高候选，低于阈值（默认 0.9）保持空白；候选名命中本地演员（主名或别名）→ 同 stash_id 合并复用、无/异 stash_id 保守忽略；无命中 → 创建名保留为主名、scraper 名追加为别名。
- **防重复**：候选名命中本地别名也复用，不创建第二个同主名演员。
- **空字段才写**：默认只填空白字段，已有值不动；每字段可单独开「覆盖」开关。
- **别名追加**：复用发生时，创建名若与目标主名/现有别名不同，自动追加为别名。
- **URL 合并**：scraper 返回的所有 URL（含 `urls` 列表）与本地 URL 合并去重后写入。
- **stash_id 写入**：所有路径都会把 JAVStash 的 UUID 写进演员的 `stash_ids`。
- **入行/退圈年份**：JAVStash 的 career_start/career_end 格式化成 2017- 写入本地 career_length。
- **异步图片**：图片下载在 detached 子进程里做，hook 不阻塞。

## 场景行为

- **按 oshash 查 JAVStash**：新场景入库时，Stash 自动用文件指纹查 JAVStash，匹配上就写。
- **番号校验**：oshash 命中多个候选时，只采用 code 与本地番号一致的候选（容忍 carib/1pondo 式后缀标注）；本地番号按 scene.code / 标题前缀 / 文件名顺序提取。无可信候选则整体丢弃；仅当番号 fallback 查询完全无结果时才降级采纳 oshash 第一个候选并在日志打 WARN 审计。
- **番号 fallback**：oshash 未命中（或被校验丢弃）时，用本地番号作 query 再搜一次，返回 code 须与本地番号一致。
- **BD 后缀剥离重试**：oshash 与番号 fallback 全部失败后，若番号形如 `XXXBD-NNN`（前缀 ≥2 字母）剥离为 `XXX-NNN` 再精确搜一次（`CWPBD-98`→`CWP-98`）；本地 code 非空不覆盖，为空则写入剥离后番号。
- **延迟填充**：Scene.Create.Post 触发后不立即写入，spawn detached 进程等待 sceneFillDelay 再重查场景，给 NFO 解析插件留足写入时间。标量空才填；无 NFO 的用户开「覆盖标题」开关。
- **标量空才填**：title / code / details / director / date。
- **studio**：仅当场景无 studio 时按名找/建。
- **performers / tags / urls**：与本地已有值合并去重（场景演员按 stash_id 反查或按名 find-or-create，新建演员触发演员 hook 补全）。
- **系列/合集**：scraper 返回的 groups 按名 find-or-create，追加到场景。
- **封面**：单独提交（主 sceneUpdate 不携带 cover_image，Windows blob 文件锁失败只影响封面）；写封面前重读场景，仅当截图时间戳仍等于 created_at 才写入；瞬时 blob 锁错误按 1s/2s/4s 退避重试。
- **stash_id**：追加到 `stash_ids`，不覆盖其他端点。

## 依赖

- Stash 0.31+，Python 3。
- JAVStash（或其他 stash-box）在 **Settings → Metadata Providers → Stash-box Endpoints** 已配置。

## 设置

| 设置 | 说明 |
| --- | --- |
| Scene auto-add stash IDs | 新场景自动按 oshash 查 JAVStash 并填充。默认开。 |
| Scraper (scene) | 场景刮削的 stash-box URL。空 = javstash。必须是 URL。 |
| Fallback to code search | oshash 搜不到时用番号再搜。默认开。 |
| Scraper (Identify) / (manual) | 演员刮削源，按创建来源区分。URL 或 scraper_id。空 = javstash。Identify 项已废弃不再读取。 |
| Use scraper name (Identify) / (manual) | Identify 项已废弃不再读取；manual 开 = 手动创建也用 scraper 名为主名，关（默认）= 保留创建名。 |
| Name-match threshold | 名字相似度阈值（0-1），默认 0.9。 |
| Performer fill delay (s) | 演员延迟填充等待秒数（默认 2）。钩子立即返回，仅填充延迟。 |
| Scene fill delay (s) | 场景延迟填充等待秒数（默认 20），等 NFO 解析器先写入 title/details/cover。 |
| Overwrite: *field* | 演员各字段是否覆盖已有值。默认关 = 只填空。 |
| Overwrite scene title | 开 = 标题已有值也写；关（默认）= 标题交给 NFO/文件名。 |

## 备注

- 刮削走 Stash 自己的 `scrapeSinglePerformer` / `scrapeSingleScene`；带 stash_id 的直抓补全使用 Stash 配置的 stash-box ApiKey。
- 日志写到插件目录 `javstash_autofill_plus.log`。
