# stash-testkit

Stash 插件开发用的**实例测试/验证工具集**（供本仓库各插件复用）。沉淀自 sceneTranslateAuto v1.2.1/v1.2.2 竞态修复的实测流程：连实例、造测试场景、扫描入库、验证插件行为、清理。

## 目录结构

```
stash-testkit/
├── README.md                # 本文件：方法 + 流程 + 已知坑
├── config.example.json      # 配置模板（复制为 config.json 填写；config.json 已被 .gitignore 忽略）
├── stash_client.py          # 通用 Stash GraphQL 客户端：场景生命周期 / 扫描触发 / 轮询等待（核心复用件）
├── gen_test_video.py        # ffmpeg 生成内容唯一测试视频（避 oshash 合并）
├── db_cleanup.py            # 测试后 DB 孤儿清理（白名单前缀；停实例→SQL→重启）
└── tests/
    └── sceneTranslateAuto/  # 插件特定验证脚本（单测 / 回归 / 端到端）
```

## 快速开始

1. 复制 `config.example.json` 为 `config.json`，填写 `api_key`（Stash 设置里生成；请求需双发 `ApiKey:` 与 `Authorization: Bearer` 头）、`db_path`、`stash_exe`、`ffmpeg_exe`、`plugin_dir`、`test_dir`。
2. 冒烟：`python stash_client.py`（应打印场景数与 scene 220）。
3. 也可用环境变量覆盖：`STASH_API_URL` / `STASH_API_KEY` / `STASH_FFMPEG`。

## 推荐测试流程（新场景入库类插件）

1. **生成测试素材**：`python gen_test_video.py --dir <测试目录> --prefix TST- --count 3`
   ——内容必须唯一（见已知坑 ①oshash）。
2. **放 nfo（如测试 nfo 解析）**：与视频同名 `.nfo`，含 `<title>`/`<num>` 等字段。
3. **触发扫描**：`python -c "from stash_client import Stash; Stash().trigger_scan()"`
   ——增量扫描，**勿用 rescan:true**（见已知坑 ②）。
4. **轮询确认**：`Stash().wait_for_scene(q="TST-", timeout=120)` 找到新场景；验证插件行为（如写待翻译 title → 等插件延迟 → 重查 title 变化）。
5. **清理**：`Stash().destroy_scene(id)`（sceneDestroy 语法见下）→ 删测试目录 → `python db_cleanup.py --prefix TST-` 清 DB 孤儿 → 确认 pending 队列空、场景数恢复。

## stash_client 速览

```python
from stash_client import Stash
s = Stash()
s.scene_count()                       # 场景总数
s.find_scene("220")                   # 单场景 {id,title,details,created_at}
s.find_scenes(q="TST-")               # findScenes 分页
s.create_scene({"title": "..."})      # SceneCreateInput
s.update_scene("225", {"title": "..."})  # SceneUpdateInput
s.destroy_scene("225")                # 老版本返回 Boolean，不要 selection
s.trigger_scan(paths=[])              # metadataScan；paths 空 = 全注册路径
s.wait_for_scene(q="TST-", timeout=120, interval=5)
```

## 已知坑（实测沉淀，改插件/写验证脚本前先看）

1. **oshash 内容去重**：复制/复用已有视频文件，Stash 按内容 hash 合并进已有场景，**不建新场景**——扫描表现为"空跑"。测试视频必须内容唯一（`gen_test_video.py` 用不同信号源/尺寸/帧率保证）。
2. **不要用 rescan:true（风暴源头）**：`metadataScan(input:{rescan:true})` 强制全量重扫 + 多插件 hook 并发 → Stash 进程崩溃（控制台日志尾为 hook 进程 `exit status 0xc000013a`）。**手动增量扫描从未复现**（怀疑与测试脚本触发方式/并发有关，待后续定位）。测试一律用增量扫描（`trigger_scan()` 不带 rescan）；全量重扫需求改用 UI 触发或先停多余插件。
3. **封面 blob 文件锁**：Windows 下多插件（如 javstashAF+ 与 nfoSceneParser）并发写封面 → `sceneUpdate` 因删除旧 blob 被占用整体失败（日志 `deleting from filesystem ... being used by another process`）。这不是查询/守卫问题，是文件锁；重试或错峰可解。
4. **老版本 GraphQL 差异**（v0.31.1 实测）：
   - `findScenes` 无 `path` 字段（`Scene` 只有 `paths` 数组）；定位用 `filter.q` + title/路径子串本地过滤。
   - `sceneDestroy` 返回 Boolean——**不要写 selection**（写了 422）。
   - `sceneUpdate` 用 `input` 对象；无 `me` 字段；无 `jobs` 查询。
5. **DB 直写前先停实例**：Stash 内存缓存与 WAL 不同步，运行中直接改 SQLite 会不一致。`db_cleanup.py` 已内置停→写→重启；自定义 DB 操作照此办。
6. **hook 并发 spawn worker**：重扫风暴下多个 hook 并发可能同时 spawn 多个 worker 处理同一 pending 文件（重复翻译一次）。插件守卫（写回前重读）保证不覆盖，仅浪费一次调用——已知，后续原子 PID 优化方向。
7. **sceneDestroy 后 files 表残留**：销毁场景只删关联；测试视频文件被手动删除后 `files` 表会残留记录（rescan 崩溃等场景可能漏清），用 `db_cleanup.py` 兜底。
8. **config.yml / `configuration { plugins }` 只记录改过设置的插件**：仅安装且设置保持默认的插件不会出现在 config.yml 与 plugins 查询结果里——**不要用它们判断插件是否启用或读取默认设置**。启用状态与设置存于 Stash DB（以插件页为准）；读不到某插件时按「默认设置 + 插件目录 config.json」处理（sceneTranslateAuto 的 `read_stash_plugin_config` 即此兜底）。

## 清理规范

- 测试场景：`sceneDestroy(input:{id:"..."})`（返回 Boolean，不 selection）。
- 测试文件：删测试目录；残留 DB 记录用 `db_cleanup.py --prefix <前缀>`（**prefix 必填且 ≥3 字符**，只删白名单）。
- 插件运行时状态：确认 `auto_state/pending` 空、无残留 worker 进程、日志无报错。
- 破坏性测试前备份（实例数据目录或 DB 文件）。

## 插件特定测试

`tests/sceneTranslateAuto/`：
- `test_guard_lang_delay.py`：v1.2.2 守卫语言判据（已目标语言丢弃 / 非目标语言重译限 1 次）+ 入队延迟（到期处理 / 未到期等待 / 坏任务清理），7 项。
- `test_race_guard.py`：v1.2.1 守卫回归（title/details 竞态丢弃 / 正常写回 / 实体消失 / 读失败 fail-closed / gallery 路径），8 项。
- `worker_e2e.py`：端到端 worker 延迟链路（空队列立即退出 / 到期任务处理 / 未到期等待），**依赖本地已部署插件目录**（config.json 的 `plugin_dir`）。

单测直接运行：`python tests/sceneTranslateAuto/test_guard_lang_delay.py`（相对仓库定位插件源码，可整体搬移）。
