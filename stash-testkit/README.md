# stash-testkit

Stash 插件开发用的**实例测试/验证工具集**（供本仓库各插件复用）。沉淀自 sceneTranslateAuto v1.2.1/v1.2.2 竞态修复、javstashAutofill+ v1.1.3 封面 blob 锁竞态修复与 v1.2.0 演员解析重构/番号 BD 剥离的实测流程：连实例、造测试场景、扫描入库、验证插件行为、清理。

## 目录结构

```
stash-testkit/
├── README.md                # 本文件：方法 + 流程 + 已知坑
├── config.example.json      # 配置模板（复制为 config.json 填写；config.json 已被 .gitignore 忽略）
├── stash_client.py          # 通用 Stash GraphQL 客户端：场景生命周期 / 扫描触发 / 轮询等待 / 封面指纹辅助（核心复用件）
├── gen_test_video.py        # ffmpeg 生成内容唯一测试视频（避 oshash 合并）
├── db_cleanup.py            # 测试后 DB 孤儿清理（白名单前缀；停实例→SQL→重启）
└── tests/
    ├── sceneTranslateAuto/  # 插件特定验证脚本（单测 / 回归 / 端到端）
    └── javstashAutofill/    # v1.1.3 封面竞态 + v1.2.0 演员解析/BD 剥离单测、E2E 与 javstash 探测工具
```

## 快速开始

1. 复制 `config.example.json` 为 `config.json`，填写 `api_key`（Stash 设置里生成；请求需双发 `ApiKey:` 与 `Authorization: Bearer` 头）、`db_path`、`stash_exe`、`ffmpeg_exe`、`plugin_dir`、`test_dir`。
2. 冒烟：`python stash_client.py`（应打印场景数与 scene 220）。
3. 也可用环境变量覆盖：`STASH_API_URL` / `STASH_API_KEY` / `STASH_FFMPEG`。

## 推荐测试流程（新场景入库类插件）

1. **生成测试素材**：`python gen_test_video.py --dir <测试目录> --prefix TST- --count 3`
   ——内容必须唯一（见已知坑 ③oshash）。
2. **放 nfo（如测试 nfo 解析）**：与视频同名 `.nfo`，含 `<title>`/`<num>`/`<plot>`/`<premiered>` 等字段；可加同名 `-cover.jpg`（nfoSceneParser 会把它写成场景封面）。
3. **部署/确认插件**：`plugins` 查询确认 version 符合预期（见已知坑 ② 同 id 旧副本）。
4. **触发扫描**：`python -c "from stash_client import Stash; Stash().trigger_scan([r'E:\...\测试目录'])"`
   ——增量扫描，**勿用 rescan:true**（见已知坑 ④）；mutation 名是 `metadataScan`，不是 `scan`。
5. **轮询确认**：`Stash().wait_for_scene(q="TST-", timeout=120)` 找到新场景；新场景入库类插件（nfoSceneParser、javstashAF+ 等）走 `Scene.Create.Post`，验证时给插件留延迟（如 javstashAF+ 默认 20s），到期重查 title/封面/字段变化。
6. **清理**：`Stash().destroy_scene(id)`（sceneDestroy 语法见下；被 blob 锁拦时重试）→ 删测试目录 → `python db_cleanup.py --prefix TST-` 清 DB 孤儿 → 确认 pending 队列空、场景数恢复。

## stash_client 速览

```python
from stash_client import Stash
s = Stash()
s.scene_count()                       # 场景总数
s.find_scene("220")                   # 单场景 {id,title,details,created_at}
s.find_scenes(q="TST-")               # findScenes 分页
s.create_scene({"title": "..."})      # SceneCreateInput（仅纯 API 测试用，见已知坑 ①）
s.update_scene("225", {"title": "..."})  # SceneUpdateInput
s.destroy_scene("225")                # 老版本返回 Boolean，不要 selection
s.trigger_scan(paths=[])              # metadataScan；paths 空 = 全注册路径
s.wait_for_scene(q="TST-", timeout=120, interval=5)
s.scene_oshash(scene)                 # 从 scene.files[].fingerprints[] 取 oshash（v0.31.1 不在顶层）
s.scene_shot_ts(scene)                # 解析 screenshot ?t=（= updated_at epoch，封面竞态判别用）
s.fetch_scene_image(sid)              # 抓 screenshot 端点字节（有自定义封面返回封面字节，验证封面内容）
```

## 已知坑（实测沉淀，改插件/写验证脚本前先看）

1. **探测别造无文件裸场景（新场景入库类插件的硬前提）**：用 `create_scene()` 建「无文件」场景来探测/测试，会触发 nfoSceneParser 等 `Scene.Create.Post` 插件崩溃——`self._scene["files"][0]["path"]` → `IndexError: list index out of range`，hook 返回 `exit status 1`（日志出现 `[Plugin / nfoSceneParser] IndexError`）；sceneGallerySync 同时报 `Scene N not found or no files`。**凡测试依赖文件的新场景插件，必须用真实视频 + 增量扫描让场景由扫描器创建**（files 非空）；裸场景只适合纯 API 测试，且要预期 nfoSceneParser 等插件报错、随后清理。
2. **插件「查不到」或版本不符 = 同 id 旧副本**：`plugins` 查询只返回改过设置的插件（config.yml 同理，见已知坑 ⑩），但**能查到 ≠ 版本对**。部署新版本后若查询仍返回旧版（如 1.0.1），多半是 `E:\stashAPP\plugins\`（或其它插件根）下另有同名旧插件目录与新部署目录同 id 冲突、Stash 加载了旧副本。处置：`Get-ChildItem <stash安装目录> -Recurse -Filter <插件>.yml` 全盘找副本 → 移除旧副本 → 重启 Stash → 再查 `plugins{ version }` 确认。
3. **oshash 内容去重**：复制/复用已有视频文件，Stash 按内容 hash 合并进已有场景，**不建新场景**——扫描表现为"空跑"。测试视频必须内容唯一（`gen_test_video.py` 用不同信号源/尺寸/帧率保证）。
4. **不要用 rescan:true（风暴源头）**：`metadataScan(input:{rescan:true})` 强制全量重扫 + 多插件 hook 并发 → Stash 进程崩溃（控制台日志尾为 hook 进程 `exit status 0xc000013a`）。**手动增量扫描从未复现**。测试一律用增量扫描；全量重扫需求改用 UI 触发或先停多余插件。
5. **封面 blob 文件锁**：Windows 下多插件（如 javstashAF+ 与 nfoSceneParser）并发写封面 → `sceneUpdate` 因删除旧 blob 被占用整体失败（日志 `deleting from filesystem ... being used by another process`）。这不是查询/守卫问题，是文件锁；重试或错峰可解（javstashAF+ v1.1.3 起：封面与主数据分离提交 + 1s/2s/4s 退避重试 + 写前重读场景）。**sceneDestroy 也会被同一把锁拦**（`The process cannot access the file because it is being used by another process`），销毁失败重试 2-3 次即可，别当成插件 bug。
6. **老版本 GraphQL 差异**（v0.31.1 实测）：
   - 扫描 mutation 名是 **`metadataScan(input:{paths})`**，写 `scan` 会 `Cannot query field "scan" on type "Mutation"`。
   - `findScenes` 无 `path` 字段（`Scene` 只有 `paths` 数组）；定位用 `filter.q` + title/路径子串本地过滤。
   - **VideoFile 哈希不在顶层**：`oshash` 不在 `Scene` 也不在 `VideoFile` 字段，只在 `files { fingerprints { type value } }`（`type == "oshash"`）——查询写法 `findScene{ files{ fingerprints{ type value } } }`（`stash_client.scene_oshash()` 封装）。
   - `sceneDestroy` 返回 Boolean——**不要写 selection**（写了 422）。
   - `sceneUpdate` 用 `input` 对象；无 `me` 字段；无 `jobs` 查询。
   - 本地 `scrapeSingleScene` 签名是 `source: ScraperSourceInput!`（**不是** `query` 参数）；javstash.org 直连无 endpoint key 会 403。
7. **DB 直写前先停实例**：Stash 内存缓存与 WAL 不同步，运行中直接改 SQLite 会不一致。`db_cleanup.py` 已内置停（`taskkill /IM stash-win.exe /F`）→写→重启（`Popen([stash_exe], cwd=…)`，无重定向）——**不要先手动停再跑它**。
8. **hook 并发 spawn worker**：重扫风暴下多个 hook 并发可能同时 spawn 多个 worker 处理同一 pending 文件（重复翻译一次）。插件守卫（写回前重读）保证不覆盖，仅浪费一次调用——已知，后续原子 PID 优化方向。
9. **sceneDestroy 后 files 表残留**：销毁场景只删关联；测试视频文件被手动删除后 `files` 表会残留记录（rescan 崩溃等场景可能漏清），用 `db_cleanup.py` 兜底。
10. **config.yml / `configuration { plugins }` 只记录改过设置的插件**：仅安装且设置保持默认的插件不会出现在 config.yml 与 plugins 查询结果里——**不要用它们判断插件是否启用或读取默认设置**。启用状态与设置存于 Stash DB（以插件页为准）；读不到某插件时按「默认设置 + 插件目录 config.json」处理（sceneTranslateAuto 的 `read_stash_plugin_config` 即此兜底）。
11. **封面「是否仍为自动帧」判别**：`paths.screenshot ?t=` 是场景 **updated_at 的 epoch**（响应缓存令牌，非截图文件 mtime）。`?t= == created_at` ⇔ 场景创建后无人写入任何元数据 ⇒ 封面仍是自动帧；任何写入（nfo 设 title/details/cover 等）都会使二者偏离。**「?t= 与 created_at 差 <2h」这类启发式是错的**（它测的是最后更新时间，与封面有无无关）。判别器封装在 `stash_client.scene_shot_ts()`。
12. **封面内容验证**：screenshot 端点返回自定义封面（有则封面字节，无则自动截图帧）——`fetch_scene_image()` 抓字节与本地封面文件比对（如 nfo 的 `-cover.jpg`）即可判定「封面被谁写了」。验证 javstash 侧封面以插件日志（`cover set` / `cover skipped (custom cover already in place)`）+ 截图字节变化佐证（本地 GraphQL 刮削签名不同、javstash.org 直连 403，见已知坑 ⑥）。
13. **PowerShell 内联 GraphQL 会被插值**：`$id`、`!` 在 PowerShell 双引号/here-string 里会被当变量/历史展开，导致 422 或语法错——**GraphQL 查询（尤其含变量的）一律写成 .py 脚本文件执行**，勿在命令行内联。本会话 Git 的 Edit 工具对部分文件曾出现「File has not been read yet」卡死，改用 `[IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM、LF 结尾）绕过。
14. **javstash 直抓（findPerformer by id）schema 实测**（v1.2.0 直抓通道）：
    - 查询名是 `findPerformer(id:ID!)`，**不是** `findPerformerByID`（422 `unknown field`）。
    - 裸 urllib 请求被 javstash 拒（403）——需镜像 Stash 客户端头 `ApiKey: <key>` + `User-Agent: stash/1.0.0`；key 从 stashBoxes 配置按 endpoint 取（老版本在 `configuration.general.stashBoxes`，新版本在 `configuration.stashBoxes`）。
    - schema 平铺：`birth_date`/`death_date`（String）、`band_size`/`cup_size`/`waist_size`/`hip_size` 拼 `measurements`、`career_start_year`/`career_end_year`（Int）、`height`（Int）、`breast_type`（enum NATURAL/FAKE/NA）、`tattoos`/`piercings`（BodyModification 对象数组需子选择 `{ location description }`）、**`urls` 是 `[URL!]!` 对象数组**（必须 `urls{ url }`，直接列 `urls` 会 422）、`images{ url }`。
    - 枚举白名单：gender/ethnicity/hair_color/eye_color 未知值（如 BALD）丢弃再写本地，否则本地 Stash 拒绝。
15. **老版本 Stash 无 `names` 过滤器**：`performer_filter:{names:{...}}` 在 v0.31.1 报 422（`Field "names" is not defined by type "PerformerFilterType"`，只有 `name` 主名过滤器）——查「主名∪别名」需新版 names 优先 + 老版本回退全量拉取（`findPerformers(filter:{per_page:500})` 分页）端侧 norm 比对。
16. **`ScraperSourceInput` 不含 `api_key` 字段**：`scrapeSinglePerformer`/`scrapeSingleScene` 的 `source` 变量传 `api_key` 会 422（unknown field）——Stash 服务端 scrape 自动用自身配置的 stash-box key，插件侧 source 只传 `stash_box_endpoint`。
17. **javstash 限流敏感**：连发请求出现 5 分钟级 read timeout（非 429，是挂起到超时）——探测/直抓必须单请求 + 长 timeout（45s）+ 请求间隙 sleep；E2E 脚本用 `run_in_background` + TaskOutput 读输出，别前台等。
18. **performerDestroy 变量名**：`mutation($id:ID!){ performerDestroy(input:{id:$id}) }`——写成 `$i` 而 mutation 内未用会 422（`Variable "$i" is never used`）。`Performer.Create.Post` 钩子对裸 performers 无 IndexError 问题（坑 ① 只针对 Scene.Create.Post）。
19. **0.9 匹配用例的前缀陷阱**：E2E 测试演员名带前缀（`TST-AF1-`）会拉低 javstash 搜索分数（0.31-0.50 < 0.9）走不到 0.9 分支——带 stash_id 的用例可带前缀（反查/直抓不搜名），**0.9 用例必须用 javstash 可命中的真实名字**；且按名查询会把「别名含测试名」的本地演员算进结果，断言按 pid 而非名字。
20. **tagCreate 被别名占用名拒绝（与 tagMergeAuto 钩子同源）**：`tagCreate` 对「已被用作其他 tag 别名」的名称报错（`name X is used as alias for 'Y'`），且 `Tag.Create.Post` 钩子（tagMergeAuto）同步合并会令 `tagCreate` 返回 `null`（`'NoneType' object is not subscriptable`）——两种形态同一根因：新 tag 被钩子即时合并，源名进了目标别名。javstashAutofill+ v1.2.4 起 `find_or_create_tag` 创建前先做 name/别名预查（已合并名称直接返回规范 tag，不再发起必败 tagCreate、Stash 日志零噪音），创建失败/竞态窗口再兜底「全量按 name/别名」查询；非 tagMergeAuto 环境下的纯别名占用拒绝仍是库数据状态（插件捕获跳过）。
21. **删文件不级联 → findImages visual_files 孤儿报错**：测试删除视频文件后（sceneDestroy / 删目录 / db_cleanup），若该视频曾被用作某 image 的 visual_files（如 sceneGallerySync 为场景建的 gallery 视频条目），`files` 行被清但 `images_files`（image→file 关联）、`image_files`（file 格式元数据）、`files_fingerprints` 残留孤儿 → `findImages` 解析 `visual_files` 报 `sql: no rows in result set`，且 Stash 对当页每张图重放同一失败（一页 25 张刷 25 条）。实测：file 455（mjpeg 视频）已删、image 866 无 gallery 归属仍引用它、md5 指纹残留。**Stash 删 file 不级联清这三表**。处置：DB 直写删孤儿（三表中 file 不存在者 + 无文件无 gallery 的 image 行），或删场景前先 destroy 其 gallery。
22. **Identify 新建 tag 不触发 Tag.Create.Post 钩子（tagMergeAuto 不即时合并）**：Identify（stash-box 或本地 scraper 源）新建 tag 走仓库层 `tagCreator.Create()`，不经 GraphQL mutation resolver，`Tag.Create.Post` 钩子不触发——监听该钩子的自动合并插件（tagMergeAuto）不会即时合并 Identify 新建的映射源名 tag，源 tag 残留。与坑 ⑳ 对比：只有 GraphQL `tagCreate` 建 tag 才触发钩子（同步合并返回 `null`）。**兜底**：触发 tagMergeAuto 任务 "Full Scan & Merge"（mode=scan_all）全库扫描合并，语义正确（源删、目标别名补回源名、场景关联转移、stash_id 转移 UPDATE OR IGNORE）。实测（v0.31.1）：本地 script scraper 源 + `metadataIdentify`（tags MERGE+createMissing）新建「ギャル」tag 存活、`tag_merge_auto.log` 零新增；随后 `runPluginTask(plugin_id:"tagMergeAuto", task_name:"Full Scan & Merge")`（**plugin_id 类型是 `ID!`**，写成 String 422）3s 合并完成、tag 总数自动复原。另注：v0.31.1 `metadataIdentify` 返回 `ID` 标量（写 selection 会 422）；scraper yml 顶层 `description` 字段不存在（写了报 `yaml: unmarshal errors: field description not found in type scraper.Definition`）。

## 封面竞态 E2E 方法（javstashAF+ × nfoSceneParser）

验证 Windows 下两插件并发写同一 scene 封面时，nfo 的 sceneUpdate 不再因 blob 锁整体失败。

**素材与时间线**（`gen_test_video.py` 生成，内容唯一）：
- `A.mp4 + A.nfo`（title/num/plot/premiered，num 用 javstash 可命中的番号）+ `A-cover.jpg`（红）→ 场景 A：nfo 在创建后 ~2s 写 title/details/date/封面
- `B-noNFO.mp4`（文件名带同番号，无 nfo）→ 场景 B：javstashAF+ 正向路径（无 nfo 抢写，应写 javstash 封面）
- `C.mp4`（无番号无 nfo）→ 对照：无匹配不动
- javstashAF+ 延迟 worker 在创建后 ~20s 填充（`sceneFillDelay` 默认 20s）

**验证**：
1. 判别：A 的 `?t= 偏离 created_at`（nfo 已写）；B 在填充前 `?t= == created_at`、填充后偏离。
2. 封面：A 截图字节 == `A-cover.jpg`（nfo 封面**未被** javstashAF+ 覆盖，插件日志应有 `cover skipped (custom cover already in place)`）；B 截图字节 != 自动帧且 != 红封面（javstash 照片已写，日志应有 `cover set`）。
3. 数据：A 保留 nfo 的 title/details/date + 填充 perf/tags/stash_id/studio/urls；B 全量填充（含 title）。
4. 日志：nfo 与 javstashAF+ 日志、Stash 控制台全窗口 **无 `being used by another process`**。
5. 清理：`sceneDestroy`（锁拦则重试）→ 删测试目录 → `db_cleanup.py --prefix A-` / `--prefix B-`（前缀 ≥3 字符）→ 测试新建实体（studio 等）diff 清理。

## 演员解析类插件 E2E 方法（javstashAutofill+ v1.2.0 重构验证）

**无需视频场景**：`performerCreate` mutation 直接触发 `Performer.Create.Post` 钩子（钩子已异步化，mutation 立即返回；填充在 detached worker 延迟 `performerFillDelay` 默认 2s 后执行，断言前等 8-10s）。

用例骨架（真实 javstash + 测试库，见 `tests/javstashAutofill/test_e2e.py`）：
- **反查合并**：创建带「本地已有」javstash stash_id 的演员 → 反查命中 → 源演员被合并消失（performerMerge 删源）、创建名追加为别名（若与目标主名/别名不同）、目标 stash_ids 不变。
- **直抓补全**：创建带「本地没有」javstash stash_id 的演员 → 按 id 直抓详情（绕过名称匹配），主名保留创建名、详情空才填、图片异步。
- **0.9 合并**：创建 javstash 可命中的真实名字（不带 id，如「三上悠亜」）→ 候选名命中本地演员别名且同 stash_id → 合并（防重复覆盖主名∪别名）。
- **保守忽略**：先建「别名=候选名、带假 javstash id」的锚定演员（反查/直抓失败保持空白），再建同名无 id 演员 → 0.9 命中真实候选（rid ≠ 假 id）→ 保持空白不合并不挂 id。
- **25s 消除**：创建 javstash 查无结果的怪名 → mutation 应 <8s 返回（旧版同步钩子约 25s）。

**场景番号 BD 剥离 E2E**（真实 javstash，见 `test_e2e_strip.py`）：
1. 选无 javstash stash_id 的场景，`sceneUpdate` 改 code 为「javstash 无收录」的 BD 番号（如 `CWPBD-98`，javstash 只有 `CWP-98`）。
2. `scrape_scene_full` → oshash miss → code fallback miss → BD 剥离（`CWP-98`）命中。
3. `apply_scene_fill` 后断言：本地 code 非空则保持 `CWPBD-98` 不变；本地 code 字段为空则写入 `CWP-98`；stash_id/空字段填上。
4. 恢复场景快照 + 清理新建演员（destroy 被 blob 锁拦时等 Stash 释放再重试，见坑 ⑤/⑱）。

## 清理规范

- 测试场景：`sceneDestroy(input:{id:"..."})`（返回 Boolean，不 selection；被 blob 锁拦时重试 2-3 次）。
- 测试文件：删测试目录；残留 DB 记录用 `db_cleanup.py --prefix <前缀>`（**prefix 必填且 ≥3 字符**，只删白名单）。
- 测试新建实体：diff 快照（performer/tag/studio 前后对比）逐个销毁；插件运行时状态：确认 pending 队列空、无残留 worker 进程、日志无报错。
- 孤儿引用：文件删除后顺带清 `images_files` / `image_files` / `files_fingerprints` 中指向已删 file 的行与「无文件且无 gallery」的 image 行——否则 findImages 解析 visual_files 刷 `sql: no rows in result set`（见已知坑 ㉑）。
- 破坏性测试前备份（实例数据目录或 DB 文件）。

## 插件特定测试

`tests/sceneTranslateAuto/`：
- `test_guard_lang_delay.py`：v1.2.2 守卫语言判据（已目标语言丢弃 / 非目标语言重译限 1 次）+ 入队延迟（到期处理 / 未到期等待 / 坏任务清理），7 项。
- `test_race_guard.py`：v1.2.1 守卫回归（title/details 竞态丢弃 / 正常写回 / 实体消失 / 读失败 fail-closed / gallery 路径），8 项。
- `worker_e2e.py`：端到端 worker 延迟链路（空队列立即退出 / 到期任务处理 / 未到期等待），**依赖本地已部署插件目录**（config.json 的 `plugin_dir`）。

`tests/javstashAutofill/`：
- `test_cover_race.py`：v1.1.3 封面 blob 锁竞态修复单测（`_shot_is_auto` 严格判别三态 / blob 锁错误识别 / 1s-2s-4s 退避重试 / 重试期间 NFO 写入放弃 / cover 分离提交且先于主更新），12 项，纯离线。
- `test_unified_resolve.py`：v1.2.0 演员解析单测（反查 / 直抓归一化 / 防重复主名∪别名 / 0.9 三态 / 合并别名 / 保守忽略 / build_update），37 项，纯离线（FakeGQL + 本地 fetch stub）。
- `test_strip_bd.py`：v1.2.0 场景番号 BD 剥离单测（剥离形态 / 真含 BD 不剥离 / mismatch 丢弃 / fallback 关闭不触发 / oshash 优先 / 本地 code 空保留写入），19 项，纯离线。
- `test_scrape_retry.py`：v1.2.2 场景刮削网络类失败重试单测（URLError/EOF 文本/request failed 识别、重试仅一次、重试仍失败回退跳过、非网络/空结果不重试、sleep 1.5s、三路径 oshash/fallback/BD-strip），18 项，纯离线。
- `test_tag_create_null.py`：v1.2.4 tag 预查+兜底单测（创建前 name/别名预查命中直接返回规范 tag 且不发 tagCreate / 创建 null/异常兜底命中 / 无命中 None / 正常创建 / 已存在名直接复用），8 项，纯离线。
- `test_e2e.py`：端到端回归（反查合并 / 直抓补全 / 25s 消除 / 0.9 别名合并 / 保守忽略），18 断言，真实 javstash + 测试库（已部署插件，断言前等 8-12s）。
- `test_e2e_strip.py`：BD 剥离端到端（本地 code 非空保持 / 空则写入 + stash_id/空字段填充 + 快照恢复），真实 javstash。
- `probe_javstash.py`：javstash 探测工具（`--code` 番号查询命中 / `--performer` 名称刮削 / `--fetch <uuid>` 直抓测试）。
- `FINAL_RESULT.md`：v1.2.0 验证结论存档（单测/E2E 矩阵 + 过程修复记录）。

单测直接运行：`python tests/sceneTranslateAuto/test_guard_lang_delay.py`、`python tests/javstashAutofill/test_cover_race.py`（相对仓库定位插件源码，可整体搬移）。
