# ImageMetaSync v1.0.0 验证报告（2026-10-31）

对 `ImageMetaSync` 1.0.0 做的端到端验证：结论是**核心逻辑按预期工作**，发现 3 个真实缺陷（已当场修复，未发版）与若干设计边界。
脚本与复跑方式见 `stash-testkit/tests/ImageMetaSync/`。

## 验证方式

复用 stash-testkit，在 `tests/ImageMetaSync/scripts/` 新建 9 个脚本。E2E 用 ffmpeg 造 1 个视频 + 6 张图
（文件名故意含 `fanart1..3` 与 `still1` 制造编号冲突），增量扫描入库后**先建空图库、延迟 3 秒再挂图**，专打 `galleryCreate` 钩子的竞态等待。
判定用独立 oracle（按文件名尾号 + 占用集推算期望标题），不复用插件代码。

## 结果

| 用例 | 结果 |
|---|---|
| GraphQL 字段兼容（v0.31.1 / schema 85） | PASS |
| 建库钩子 + 等待挂图（延迟 3s）→ 6/6 图写入 | PASS |
| 演员 / 工作室 / 日期 / 番号 / tag / 标题写入 | PASS |
| 标题编号：尾号优先、冲突顺延、封面纯标题 | PASS |
| `fillUrlsDetails` / `excludeTags` / `overwrite` 开与关 | PASS |
| 多演员整库跳过（日志含 id + 标题 + 演员数） | PASS |
| 批量任务幂等（重跑 0 更新） | PASS |
| 无图库兜底（清空后重填） | PASS |
| `imageUpdate` 不触发 `Gallery.Update.Post`（无自激循环） | PASS |
| `fillTagsTitleCode=OFF` 时两条路径都不写标题 | PASS（修复后） |

## 修复的缺陷（本地已改，未发版）

1. **兜底路径无视标题开关**：`__process_scene_no_gallery` 无条件 `meta["title"] = scene_filename`，
   关掉标题开关后仍会用**文件名**写标题。修法：`__resolve_meta` 返回 `fill_title`，回退仅在开关开启且场景无标题时生效。
2. **收尾窗口入队事件无人处理**：`__background_run` 在最后一次 drain 与 `release_lock` 之间入队的变更会滞留到下一次钩子。
   修法：释放锁后检查队列，非空则重抢锁续跑一轮（迭代，无递归）。
   注：原先报告的"删锁后 40s 不处理"是测试构造（手工占的是假锁，不会消费队列），不是此缺陷的表现。
3. **`queue.jsonl` / `.proc` 永不回收**：`__cleanup_stale_tasks` 只清 `.json`/`.log`。修法：按文件名前缀一并纳入过期清理。

另修文档口径：插件 README 写 title 来源"图库标题（回退场景标题）"，实现是**场景标题优先**（回退图库标题），已改正。

## 撤销的疑点

- **路径分隔符敏感**：手工探针传 `E:/Temp/测试库` 得 0 条、传反斜杠得 151 条，曾判为插件缺口。
  实际插件用的是 `os.path.dirname(scene["files"][0]["path"])`（Stash 返回原样路径），不会出现正斜杠，**不是缺陷**。
  复用价值只剩一条工具铁律：手工查 `path` 过滤器必须用 Stash 存储原值（已进 README 硬约束）。

## 不改的边界

- 场景后来新增演员不回溯已写图片，且此后整库跳过（要修得记录"本插件写过什么"，成本远超收益）。
- 共享图片在两边演员不同时互相覆盖（低概率，且被 2 演员跳过规则挡住）。
- `run.lock` 以 mtime 判过期、不续期：单次运行超 900s 理论上可被抢占，后果是重复写同样的值。
  （后续版本已改为内核字节锁，硬杀即刻释放、锁文件不再 unlink，此条仅作 v1.0.0 记录，详见 NOTES.md「运行锁」）
- 每张图一次 `imageUpdate`，Stash 无批量接口；日志里的 "N updated" 统计的是发出请求数，GraphQL 报错也 +1。
