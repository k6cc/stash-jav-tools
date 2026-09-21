# stash-testkit

Stash 插件开发用的**实例测试/验证工具集**（供本仓库各插件复用）。沉淀自 sceneTranslateAuto v1.2.1/v1.2.2 竞态修复与 javstashAutofill+ v1.1.3 封面 blob 锁竞态修复的实测流程：连实例、造测试场景、扫描入库、验证插件行为、清理。

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
    └── javstashAutofill/    # 封面 blob 锁竞态修复单测（test_cover_race.py）
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

## 清理规范

- 测试场景：`sceneDestroy(input:{id:"..."})`（返回 Boolean，不 selection；被 blob 锁拦时重试 2-3 次）。
- 测试文件：删测试目录；残留 DB 记录用 `db_cleanup.py --prefix <前缀>`（**prefix 必填且 ≥3 字符**，只删白名单）。
- 测试新建实体：diff 快照（performer/tag/studio 前后对比）逐个销毁；插件运行时状态：确认 pending 队列空、无残留 worker 进程、日志无报错。
- 破坏性测试前备份（实例数据目录或 DB 文件）。

## 插件特定测试

`tests/sceneTranslateAuto/`：
- `test_guard_lang_delay.py`：v1.2.2 守卫语言判据（已目标语言丢弃 / 非目标语言重译限 1 次）+ 入队延迟（到期处理 / 未到期等待 / 坏任务清理），7 项。
- `test_race_guard.py`：v1.2.1 守卫回归（title/details 竞态丢弃 / 正常写回 / 实体消失 / 读失败 fail-closed / gallery 路径），8 项。
- `worker_e2e.py`：端到端 worker 延迟链路（空队列立即退出 / 到期任务处理 / 未到期等待），**依赖本地已部署插件目录**（config.json 的 `plugin_dir`）。

`tests/javstashAutofill/`：
- `test_cover_race.py`：v1.1.3 封面 blob 锁竞态修复单测（`_shot_is_auto` 严格判别三态 / blob 锁错误识别 / 1s-2s-4s 退避重试 / 重试期间 NFO 写入放弃 / cover 分离提交且先于主更新），12 项，纯离线。

单测直接运行：`python tests/sceneTranslateAuto/test_guard_lang_delay.py`、`python tests/javstashAutofill/test_cover_race.py`（相对仓库定位插件源码，可整体搬移）。
