# Javstash Autofill+

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
- **番号 fallback**：oshash 搜不到时，自动用番号（本地 code 字段，或从标题前缀提取）作 query 再搜一次。
- **标量空才填**：title / code / details / director / date。
- **studio**：仅当场景无 studio 时按名找/建。
- **performers / tags / urls**：与本地已有值合并去重（scraper 自带 `stored_id` 优先，否则按名 find-or-create；新建演员会触发演员 hook 补全）。
- **系列/合集**：scraper 返回的 groups 按名 find-or-create，追加到场景。
- **封面**：仅当场景还是自动生成截图（无自定义封面）时写入 scraper 封面；已有自定义封面不覆盖。
- **stash_id**：追加到 `stash_ids`，不覆盖其他端点。

## 依赖

- Stash 0.31+，Python 3。
- JAVStash（或其他 stash-box）在 **Settings → Metadata Providers → Stash-box Endpoints** 已配置。

## 设置

| 设置 | 说明 |
| --- | --- |
| Scene auto-add stash IDs | 新场景自动按 oshash 查 JAVStash 并填充。默认开。 |
| Scraper (scene) | 场景刮削的 stash-box URL。空 = javstash。必须是 URL，不能是 scraper_id。 |
| Scraper (Identify) / (manual) | 演员刮削源，按创建来源区分。URL 或 scraper_id。空 = javstash。 |
| Use scraper name (Identify) / (manual) | 对应来源是否用 scraper 名为主名。默认 Identify 开、manual 关。 |
| Name-match threshold | 名字相似度阈值（0-1），默认 0.9。 |
| Overwrite: *field* | 演员各字段是否覆盖已有值。默认关 = 只填空。 |

## 备注

- 刮削走 Stash 自己的 `scrapeSinglePerformer` / `scrapeSingleScene`，插件本身不需要 API key。
- Identify 创建的演员通过 create input 里是否有 `stash_ids` 判断。
- 日志写到插件目录 `javstash_autofill_plus.log`。
