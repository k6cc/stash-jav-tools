# INVENTORY — 任务 → 脚本映射表

> AI agent 入口：**先读本文件**找"我要做 X 该跑哪个脚本"；硬约束与坑见 `README.md`，业务语义深查见各 `tests/<plugin>/NOTES.md` 或 `_archive/`。
> 本表更新频率低（新增测试脚本时才改），改动时务必同步 `README.md` 脚本索引。

## 30 秒连接

- 实例：`http://localhost:9999/graphql`，配置目录 `E:\stashAPP\`
- 认证：请求**双发** `ApiKey: <key>` + `Authorization: Bearer <key>` 头（缺一不可，已封装在 `stash_client.py`）
- 配置：复制 `config.example.json` → `config.json`（已 gitignore），填 `api_key` / `db_path` / `stash_exe` / `ffmpeg_exe` / `test_dir`
- 冒烟：`python stash_client.py`（应打印场景数）

## 任务 → 脚本

| 我要做 | 跑什么 | 关键命令 |
|---|---|---|
| 冒烟/确认连得上 | `stash_client.py` | `python stash_client.py` |
| 造内容唯一测试视频（避 oshash 去重） | `gen_test_video.py` | `python gen_test_video.py --dir <测试目录> --prefix TST- --count 3` |
| 触发增量扫描（勿 rescan） | `stash_client.Stash.trigger_scan` | `python -c "from stash_client import Stash; Stash().trigger_scan([r'...'])"` |
| 等新场景入库 | `stash_client.Stash.wait_for_scene` | `s.wait_for_scene(q="TST-", timeout=120, interval=5)` |
| 销毁单场景（blob 锁拦时重试 2-3 次） | `stash_client.Stash.destroy_scene` | `s.destroy_scene("225")` |
| **测试收尾清 DB 孤儿**（files + scenes_files + images_files + image_files + files_fingerprints + 孤儿 image） | `db_cleanup.py` | `python db_cleanup.py --prefix TST- --dry-run` → 确认清单 → 去掉 `--dry-run` 真跑（自动停/启 Stash） |
| 测新场景入库类插件（nfo / javstashAF+ / sceneGallerySync） | 流程：gen_test_video → 放同名 .nfo/-cover.jpg → trigger_scan → wait_for_scene → 给 hook 留延迟（javstashAF+ 默认 20s）→ 验证 → db_cleanup | 见 `README.md` 测试生命周期 |
| 测演员解析类插件（performerCreate 钩子） | 直接 `performerCreate` mutation，不用视频 | 骨架见 `README.md` E2E 节；用例见 `tests/javstashAutofill/test_e2e.py` |
| 测 tagCreate 失败兜底（nfoSceneParser） | `tests/nfoSceneParser/test_tag_create_fallback.py` | `python tests/nfoSceneParser/test_tag_create_fallback.py offline <插件目录>` |
| 测 tagCreate 兜底真库端到端 | `tests/nfoSceneParser/test_tag_create_fallback_live.py` | 自动挑候选源名，测完自清理 |
| tagMerge 映射维护/校验 | `tests/tagMerge/tools/` | `tagmap_norm.py` / `tagmap_verify.py` / `tagmap_scrape_defs.py`（用法见 `tests/tagMerge/NOTES.md`） |
| 探 javstash 某番号/演员 | `tests/javstashAutofill/probe_javstash.py` | `python probe_javstash.py --code T38-072` / `--performer 三上悠亜` / `--fetch <uuid>` |
| 诊断某番号为何没进 binge 首页热门 | `tests/binge/probe_trending_filter.py` | `python probe_trending_filter.py [番号] [lookback天数]`（模拟前端过滤链，逐条打印 SKIP 原因） |
| 测 Stash HLS 段生产节奏 | `tests/binge/hls_segment_probe.py` | `python hls_segment_probe.py --scene 244 --minutes 2 --lead 10 --reset-cache [--ffprobe]` |
| 真实 Chrome 播放 HLS / A/B | `tests/binge/hls_chrome_probe.py` | `python hls_chrome_probe.py --scene 244 --seconds 150 [--seek 600] [--engine native\|hlsjs]` |
| 探 tagCreate 幽灵 id 边界 | `tests/nfoSceneParser/probe_ghost_id.py` | 直发原始 mutation，确认钩子合并时不返回已删 tag 的 id |
| 查 DB 孤儿（只读） | 直连 sqlite3 | 见 `README.md` 硬约束"DB 直写前停实例" |

## 硬约束（每条都踩过，别再踩）

完整版见 `README.md` 硬约束清单；最高频 4 条：

1. **DB 直写前必停 Stash**（运行中改 SQLite 内存缓存/WAL 不一致）；`db_cleanup.py` 已内置停→写→重启
2. **别用 `rescan:true`**（metadataScan 全量重扫触发 hook 风暴崩溃）；测试一律增量扫描
3. **测试视频内容必须唯一**（`gen_test_video.py` 保证），复制已有文件会被 oshash 合并进旧场景
4. **GraphQL 查询写 `.py` 脚本文件**，别在 PowerShell 命令行内联（`$id`/`!` 会被插值导致 422）

## 归档

历史排查结论、一次性验证报告见 `_archive/`，深查时再翻；主 README 与本文件不重复这些内容。

## 沉淀规范（用户说"沉淀本轮经验"时遵守）

**触发**：测试/证实/修改完成后，用户明确要求"沉淀"时，按本节把本轮经验写入本工具集。不是每次测试都写，只写"下次还会用到"的东西。

### 第一步：按信息类型分流到对应位置

| 本轮产生了什么 | 写到哪 |
|---|---|
| 新脚本/新工具/新入口 | 索引规则：**插件级脚本只精确到 `tests/<插件名>/` 目录行、仅在 README 用途列补充能做什么**（不单独一行、不进 INVENTORY 任务表）；**多插件共用/系统层面**的脚本才在 README 单独一行介绍；INVENTORY 任务表**只收录高频任务脚本**（冒烟/造视频/扫描/等场景/清孤儿/常用单测入口等），低频诊断探针一律只进 README 用途列 |
| 下次还会踩的坑（运行时/数据语义/schema/外部源/工具链） | `README.md` 硬约束清单对应分类下加一条 |
| 最高频新坑（5 条 top 里要换进来的） | 同步更新本文件"硬约束 top 5" |
| 某插件特有的业务语义（映射规则、刮削口径、字段语义） | 对应 `tests/<plugin>/NOTES.md`，不要进主 README |
| 一次性验证结论（X/Y PASS、过程修复的 bug、某次排查根因） | `_archive/<描述性文件名>.md`（文件名带版本号/日期，如 `xxx-v1.2.0-validation.md`） |
| 配置项变化（新字段、路径变动） | `config.example.json` 加字段说明 |
| 通用工具脚本能力增强（如 db_cleanup 新增清理范围） | 改脚本 docstring + 同步 README 硬约束/清理规范描述 |

### 第二步：写作规范

- **操作导向，不是时间序**：写"做 X 会 Y"，不写"我们当时做了 A 然后 B 然后 C"。例：`tagCreate 被别名占用名会返回 null`，不写"2026-09-23 我们跑 test_xxx 发现..."。
- **一句话说清规则，不展开因果**：硬约束写成动词开头、条件明确；"会导致什么/为什么"除非是下次必须知道的前提，否则不写。
- **同一信息只在一处**：通用硬约束只进 README；业务语义只进子目录 NOTES；别处用指针"见 README 硬约束"或"见 tests/tagMerge/NOTES"，不复制。
- **_archive 文件要自包含**：文件名带版本/日期；正文开头一句话说明"这是哪次验证/排查、结论是什么"，深查的人不读 git log 也能懂。
- **删旧不删错**：发现旧文档与新结论矛盾时，改旧文档或把旧文件移到 `_archive/`，不要两份并存。

### 第三步：反模式（不要写）

- 设计辩护（"为什么不会循环""为什么这个架构是对的"）——除非它直接影响下次操作
- 排查过程流水账（"先试了 A 不行，又试了 B"）
- 仓库发版/CI/AGENTS.md 范畴的内容（那是主仓库 `AGENTS.md` 的事）
- 已被脚本/工具自动覆盖的人工步骤（例：db_cleanup 已自动清 visual_files 孤儿，就别再在文档里教"手动 SQL 删三表"）
- 过期快照（"2026-09 时 javstash 状态是..."）——会过期的状态表不进主文档，要留就放 `_archive/` 并带日期

### 第四步：自检清单

沉淀完跑一遍：

- [ ] 新增/改动的脚本，INVENTORY 任务表和 README 脚本索引两边都加了？
- [ ] 新坑进了 README 硬约束的正确分类？
- [ ] 业务语义有没有误塞进主 README（应该进子目录 NOTES）？
- [ ] 一次性结论有没有误塞进主 README（应该进 `_archive/`）？
- [ ] 同一信息有没有在两处写不同措辞？
- [ ] 本文件 top 5 硬约束要不要换入新坑？

