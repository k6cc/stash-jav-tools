# Javstash Autofill+

> v1.1.3：封面与主数据分离提交（Windows blob 文件锁失败不再拖垮整个 sceneUpdate）；写封面前重读场景，NFO 已写封面则不覆盖；瞬时 blob 锁错误 1s/2s/4s 退避重试；新增 sceneFillDelay 设置（默认 20s）。

新演员创建时自动从 JAVStash 补全元数据；新场景入库时按文件指纹（oshash）自动从 JAVStash 补空白字段与 stash_id。纯后台 Python，无 UI 注入。

## 触发方式

| Hook / Task | 行为 |
| --- | --- |
| `Performer.Create.Post` | 演员创建时按名字搜 JAVStash，填充空白字段并写入 stash_id |
| `Scene.Create.Post` | 新场景按 oshash 查 JAVStash，填充空白字段并写入 stash_id |
| Task「Backfill scenes stash-box ID」 | 扫全库缺 JAVStash ID 的场景，按 oshash 批量补全 |

## 演员行为

- **按名匹配**：取名字相似度最高的候选，低于阈值（默认 0.9）跳过。
- **空字段才写**：默认只填空白字段，已有值不动；每个字段可单独开「覆盖」开关。
- **主名策略**：Identify 创建的演员默认用 scraper 名为主名（原名降级为别名）；手动创建的演员默认保留原名。两种策略都可在设置里切换。
- **重名合并**：scraper 名为主名时若已有同名演员，新演员合并进去（场景重新关联、新演员删除、stash_id 携带过去）。
- **URL 合并**：scraper 返回的所有 URL（含 `urls` 列表）与本地 URL 合并去重后写入。
- **stash_id 写入**：三种路径（普通 / 改名 / 合并）都会把 JAVStash 的 UUID 写进演员的 `stash_ids`。
- **入行/退圈年份**：JAVStash 的 career_start/career_end 格式化成 2017- 写入本地 career_length。
- **异步图片**：图片下载在 detached 子进程里做，hook 不阻塞。

## 场景行为

- **按 oshash 查 JAVStash**：新场景入库时，Stash 自动用文件指纹查 JAVStash，匹配上就写。
- **番号校验**：oshash 命中多个候选时，只采用 code 与本地番号一致的候选（容忍 carib/1pondo 式后缀标注，如 `012012-920-carib`）；本地番号按 scene.code / 标题前缀 / 文件名顺序提取，支持：字母-数字（`ABC-123`、`ABCD00123`）、caribbeancom/1pondo 式数字开头（`051011-694`、`070313_620`）、FC2（`FC2-PPV-4484216`）、单字母-数字（`n0783`）。无可信候选则整体丢弃；仅当番号 fallback 查询完全无结果（javstash 库中确无此番号）时，才降级采纳 oshash 第一个候选并在日志打 WARN 记录本地番号与候选番号，便于事后审计。
- **番号 fallback**：oshash 未命中（或被校验丢弃）时，用本地番号作 query 再搜一次，返回 code 同样须与本地番号一致。
- **延迟填充**：Scene.Create.Post 触发后不立即写入，而是 spawn detached 进程等待 sceneFillDelay（默认 20 秒，可配）再重查场景——给 NFO 解析插件留足写入时间，避免竞态抢先写入错误标题。标量空才填，NFO 已写的 title/details/date 天然保留；无 NFO 的用户开「覆盖标题」开关即可让插件写标题。
- **标量空才填**：title / code / details / director / date。
- **studio**：仅当场景无 studio 时按名找/建。
- **performers / tags / urls**：与本地已有值合并去重（scraper 自带 `stored_id` 优先，否则按名 find-or-create；新建演员会触发演员 hook 补全）。
- **系列/合集**：scraper 返回的 groups 按名 find-or-create，追加到场景。
- **封面**：单独提交（主 sceneUpdate 不携带 cover_image，Windows blob 文件锁失败只影响封面、不影响 title/code/performers/tags 等字段）；写封面前重读场景，仅当截图时间戳仍等于 created_at（尚无任何元数据写入）才写入——NFO 已写封面则跳过不覆盖；瞬时 blob 锁错误按 1s/2s/4s 退避重试。
- **stash_id**：追加到 `stash_ids`，不覆盖其他端点。

## 依赖

- Stash 0.31+，Python 3。
- JAVStash（或其他 stash-box）在 **Settings → Metadata Providers → Stash-box Endpoints** 已配置。

## 设置

| 设置 | 说明 |
| --- | --- |
| Scene auto-add stash IDs | 新场景自动按 oshash 查 JAVStash 并填充。默认开。 |
| Scraper (scene) | 场景刮削的 stash-box URL。空 = javstash。必须是 URL，不能是 scraper_id。 |
| Fallback to code search | oshash 搜不到时用番号再搜。默认开。 |
| Scraper (Identify) / (manual) | 演员刮削源，按创建来源区分。URL 或 scraper_id。空 = javstash。 |
| Use scraper name (Identify) / (manual) | 对应来源是否用 scraper 名为主名。默认 Identify 开、manual 关。 |
| Name-match threshold | 名字相似度阈值（0-1），默认 0.9。 |
| Overwrite: *field* | 演员各字段是否覆盖已有值。默认关 = 只填空。 |
| Overwrite scene title | 开 = 标题已有值也写；关（默认）= 标题交给 NFO/文件名。无 NFO 导入的用户开此开关。 |
| Scene fill delay | 延迟填充等待秒数（默认 20），等 NFO 解析器先写入 title/details/cover。 |

## 备注

- 刮削走 Stash 自己的 `scrapeSinglePerformer` / `scrapeSingleScene`，插件本身不需要 API key。
- Identify 创建的演员通过 create input 里是否有 `stash_ids` 判断。
- 日志写到插件目录 `javstash_autofill_plus.log`。
