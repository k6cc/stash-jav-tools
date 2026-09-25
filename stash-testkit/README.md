# stash-testkit

Stash 插件开发用的**实例测试/验证工具集**（供本仓库各插件复用）：连实例、造测试场景、扫描入库、验证插件行为、清理。

> **AI agent 入口**：先读 [`INVENTORY.md`](INVENTORY.md)（任务→脚本映射表 + 5 条最高频硬约束）。本文件放完整硬约束清单与流程细节。

## 目录结构

```
stash-testkit/
├── INVENTORY.md            # 任务→脚本映射表（AI 入口，更新频率低）
├── README.md               # 本文件：流程 + 完整硬约束清单
├── config.example.json     # 配置模板（复制为 config.json；config.json 已 gitignore）
├── stash_client.py         # 通用 GraphQL 客户端（场景生命周期 / 扫描 / 轮询）
├── gen_test_video.py       # ffmpeg 生成内容唯一测试视频（避 oshash 合并）
├── db_cleanup.py           # 测试后 DB 孤儿清理（停实例→SQL→重启，自动级联）
├── tests/
│   ├── sceneTranslateAuto/  # 插件特定验证脚本
│   ├── javstashAutofill/    # 演员解析/封面竞态/BD 剥离单测与 E2E
│   ├── nfoSceneParser/      # tagCreate 兜底单测 + 幽灵 id 边界
│   ├── binge/               # 首页热门口径探测
│   └── tagMerge/            # tagMerge 映射维护：业务语义 + 工具（NOTES.md）
└── _archive/               # 历史排查结论/一次性验证报告（深查时再翻）
```

## 测试生命周期

新场景入库类插件（nfo / javstashAF+ / sceneGallerySync）：

| 步 | 动作 | 命令/要点 |
|---|---|---|
| 1 | 造素材 | `python gen_test_video.py --dir <测试目录> --prefix TST- --count 3`（内容必须唯一，见硬约束） |
| 2 | 放 nfo（如测解析） | 同名 `.nfo`；可加同名 `-cover.jpg` |
| 3 | 确认插件版本 | `plugins{ version }`（同 id 旧副本见硬约束） |
| 4 | 增量扫描 | `Stash().trigger_scan([paths])`，**勿 rescan:true** |
| 5 | 等场景入库 | `Stash().wait_for_scan(q="TST-", timeout=120)`；新场景插件走 `Scene.Create.Post`，留延迟（javstashAF+ 默认 20s） |
| 6 | 验证 | 重查 title/封面/字段；封面字节比对用 `fetch_scene_image()` |
| 7 | 清理 | `destroy_scene(id)`（blob 锁拦重试）→ 删测试目录 → `db_cleanup.py --prefix TST-`（自动级联 files 关联 + 孤儿 image） |

演员解析类插件（无需视频）：直接 `performerCreate` mutation 触发 `Performer.Create.Post` 钩子（异步化，mutation 立即返回，等 8-12s 再断言）。用例骨架见 `tests/javstashAutofill/test_e2e.py`。

## 硬约束清单

### 运行时

- **DB 直写前必停 Stash**（内存缓存/WAL 不同步）；`db_cleanup.py` 已内置停→写→重启。
- **勿用 `rescan:true`**（metadataScan 全量重扫触发多插件 hook 风暴，进程崩溃）；测试一律增量扫描。
- **封面 blob 锁**：Windows 下多插件并发写封面会让 `sceneUpdate` 失败（`being used by another process`），重试 2-3 次即可，别当插件 bug。
- **插件"查不到/版本旧" = 同 id 旧副本**：`E:\stashAPP\plugins\` 下另有同名目录时 Stash 加载旧副本。全盘找 `.yml` → 移除旧副本 → 重启 → 再查 version。
- **`configuration { plugins }` 只记录改过设置的插件**：仅安装且默认设置的插件不在 config.yml 也不在 plugins 查询结果里；读默认设置按插件目录 config.json 处理。
- **hook 并发 spawn worker**：重扫风暴下可能重复翻译一次；插件守卫（写前重读）保证不覆盖，仅浪费一次调用，已知。

### 数据语义

- **测试视频内容必须唯一**：复制已有文件会被 oshash 合并进旧场景，扫描表现为"空跑"。`gen_test_video.py` 用不同信号源/尺寸/帧率保证。
- **别造无文件裸场景测新场景插件**：`create_scene()` 建无文件场景会让 nfoSceneParser 等 `Scene.Create.Post` 插件 `IndexError: files[0]`。依赖文件的测试必须走"真实视频 + 增量扫描"。
- **封面"是否仍为自动帧"判别**：`screenshot?t=` 是场景 `updated_at` 的 epoch；`?t= == created_at` ⇔ 场景创建后无人写过任何元数据。
- **封面内容验证**：`fetch_scene_image()` 抓 screenshot 端点字节，与本地封面文件比对即可判定"封面被谁写了"。

### GraphQL schema（v0.31.1 实测）

- 扫描 mutation 名是 **`metadataScan`**（写 `scan` 会 422）；`findScenes` 无 `path` 字段（用 `paths`）。
- **`sceneDestroy` 返回 Boolean**，不要写 selection（写了 422）；`performerDestroy` 变量名必须与 mutation 内一致（`$id` 写 `$i` 会 422 "Variable never used"）。
- **VideoFile 哈希不在顶层**：`oshash` 只在 `files { fingerprints { type value } }`（`type == "oshash"`），用 `scene_oshash(scene)` 封装。
- **老版本无 `names` 过滤器**（v0.31.1 只有 `name`）：查"主名∪别名"需新版 `names` 优先 + 老版本全量拉取端侧比对回退。
- **`ScraperSourceInput` 不含 `api_key`**：scrape 自动用本地 stash-box 配置的 key，插件侧只传 `stash_box_endpoint`。
- **`scrapeSingleScene` 签名是 `source: ScraperSourceInput!`**（不是 `query` 参数）。
- **老版本 `plugins(include:[...])` 422**：用 `configuration { plugins }` 或 `plugins { id name settings {...} }`（settings 必须带子选择）。
- **`SceneQueryInput` 不收 `q` 字段**（422）；按 code/performer 精确查走对应字段。
- **tagCreate 被别名占用名拒绝**：已被用作其他 tag 别名的名字 `tagCreate` 报错；`Tag.Create.Post` 钩子（tagMergeAuto）同步合并会令 `tagCreate` 返回 `null`。javstashAF+ v1.2.4 起创建前先 name/别名预查。
- **Identify 新建 tag 不触发 `Tag.Create.Post` 钩子**（走仓库层 `tagCreator.Create()`）；兜底是手动跑 tagMergeAuto "Full Scan & Merge"（`runPluginTask(plugin_id:"tagMergeAuto", task_name:"Full Scan & Merge")`，`plugin_id` 是 `ID!`）。

### 外部源（javstash / stashdb）

- **javstash 直抓必须镜像 Stash 客户端头**：`ApiKey: <key>` + `User-Agent: stash/1.0.0`，裸 urllib 403。key 从 `configuration.stashBoxes`（老版本 `configuration.general.stashBoxes`）按 endpoint 取。
- **javstash 限流敏感**：连发请求 5 分钟级 read timeout；探测单请求 + 45s timeout + 请求间 sleep。
- **stashdb.org 本机匿名访问被拒**：只能经本地 stash `stash_box_endpoint` 代理。
- **box tag 网页 URL**：`endpoint 去 /graphql 尾 + "/tags/" + remote_site_id`，三 box 同构。

### 工具链

- **GraphQL 查询写 `.py` 脚本文件**，别在 PowerShell 命令行内联（`$id`/`!` 被插值导致 422）。
- **破坏性测试前备份**：实例数据目录或 `stash-go.sqlite`。

## 脚本索引

| 脚本 | 用途 |
|---|---|
| `stash_client.py` | GraphQL 客户端：场景 CRUD / 扫描 / 轮询 / 封面字节 |
| `gen_test_video.py` | 生成内容唯一测试视频 |
| `db_cleanup.py` | 测试收尾 DB 孤儿清理（`--prefix` 白名单，`--dry-run` 预览） |
| `tests/sceneTranslateAuto/` | 守卫语言判据 / 竞态 / worker 延迟单测与 E2E |
| `tests/javstashAutofill/` | 封面竞态 / 演员解析 / BD 剥离 / 刮削重试 / tag 预查单测 + E2E + javstash 探测 |
| `tests/nfoSceneParser/` | tagCreate 兜底单测 + 幽灵 id 边界 + 交叉无循环验证 |
| `tests/binge/probe_trending.py` | binge 首页 trending/costar 拉取口径探测 |
| `tests/binge/probe_settings.py` | binge 插件实际设置（lookback/preview/gender）补查 + javstash trending 演员 gender |
| `tests/binge/probe_snos397.py` | 诊断某番号为何没进 binge 首页热门（trending 定位 + 本地 owned + 过滤链模拟） |
| `tests/tagMerge/` | 映射维护：`NOTES.md`（业务语义）+ `tools/`（归一化/校验/刮定义） |

## 清理规范

- 测试场景：`sceneDestroy`（Boolean 无 selection；blob 锁拦重试 2-3 次）。
- 测试文件：删测试目录；`db_cleanup.py --prefix <前缀>`（prefix 必填 ≥3 字符，白名单；已自动级联 `scenes_files`/`images_files`/`image_files`/`files_fingerprints` + 孤儿 image 及其子关联）。
- 测试新建实体：diff 快照（performer/tag/studio 前后对比）逐个销毁；确认 pending 队列空、无残留 worker、日志无报错。
- 破坏性操作前备份。
