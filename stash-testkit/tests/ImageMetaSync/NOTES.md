# ImageMetaSync 验证 — 入口

图库图片元数据回填插件（`E:\stashAPP\plugins\k6cc\ImageMetaSync`）的端到端验证与结果审计。
本轮验证结论（v1.0.0）见 `stash-testkit/_archive/ImageMetaSync-v1.0.0-validation.md`。

## 文件地图

| 文件 | 内容 |
|---|---|
| `NOTES.md` | 本文件：路由 + 写入口径 + 实测环境 |
| `SCRIPTS.md` | 每个脚本验什么、会不会写数据、怎么跑 |
| `scripts/` | 全部脚本；`image_state.json` 是 `verify_image_meta_sync.py snapshot` 的本地快照（可删） |
| `stash-testkit/README.md` 硬约束 | 与插件无关的宿主机机制（path 过滤语义、钩子触发面、日志解码） |

## 快速路由

| 我要做 | 跑什么 |
|---|---|
| 全库体检（图片元数据是否符合口径） | `python scripts/audit_state.py [--dump]`，只读 |
| 造可控样本（1 视频 + 6 图，文件名含 `fanart1..3`/`still1` 制造编号冲突） | `python scripts/test_e2e_gallery.py setup` |
| 测建库钩子 + 竞态等待 + 编号 + 各开关 | `python scripts/test_e2e_gallery.py full` |
| 只校验当前样本结果（独立 oracle 推算） | `python scripts/test_e2e_gallery.py check` |
| 测无图库兜底路径 | `python scripts/test_fallback_no_gallery.py {clear\|run\|dir}` |
| 测锁 / 队列 / 过期清理 | `python scripts/test_lock_queue.py` |
| 测 `fillTagsTitleCode=OFF` 时两条路径的行为 | `python scripts/test_title_off.py`（结束会还原设置） |
| 校验插件用到的 GraphQL 字段在当前版本可用 | `python scripts/probe_schema.py` |
| 触发钩子并抓后台进程日志 | `python scripts/probe_hook_trigger.py <image_id> <gallery_id>` |
| 测「tag 被合并删除后仍用旧 id 写入」的后果 | `python scripts/test_tag_race.py probe` / `restore` |
| 测 tags 只同步一半后能否自愈 | `python scripts/test_tag_partial.py run` / `show` |
| 批量任务前后差异 | `python scripts/verify_image_meta_sync.py snapshot` → 跑任务 → `diff` |

## 写入口径（判 oracle 时按这个，不按 README 文案）

- **基标题 = 场景标题**，多场景取唯一值，否则回退图库标题（`__resolve_meta`：`__pick(scenes,"title") or gallery.title`）。场景无标题时兜底路径才回退**电影文件名**。
- 标题编号：封面写纯基标题，其余写「基标题 #N」。N 优先取图片文件名尾号（`fanart1.jpg`→1），冲突或无序时顺延到下一个空号；已有标题的图默认不动，其编号计入占用。
- 演员 / 工作室 / 日期 / 番号 / tag / url / 简介：默认只补空字段，`overwrite=true` 才改写已有值。
- **场景演员并集 != 1 → 整库跳过**（日志写明图库 id、标题、场景数、演员数）。包括 0 演员与多演员。
- 标题、番号、tag 受 `fillTagsTitleCode` 控制；url、简介受 `fillUrlsDetails` 控制；演员/工作室/日期不受任何开关控制。
- 无图库兜底只处理封面与 fanart（按 `config.py` 的文件名链），不碰剧照。

## 已知状态边界（不是 bug，判 FAIL 前先看这里）

- **场景后来加演员不会回溯**：图片里的演员是当时合法写入的值；此后再也不改写该库，`overwrite=true` 也救不回来（它只在处理到的库上生效，而被跳过的库根本不处理）。
- **共享图片会互相覆盖**：同一张图挂多个图库且两边演员不同，谁后触发钩子谁写；两边都是 2 演员被跳过时不会发生。
- 钩子窗口约 9~15s（`READY_POLL_INTERVAL=3` × 6 次，连续两次读数相同即提前返回）；建库后超过这个窗口才挂图不会补跑。
- **tags 只写一次，之后不跟进**（实测）：`fillTagsTitleCode` 开启时 tags 随场景一起写入，但判定条件是「图片 tags 为空」——
  首次同步拿到的若是场景的**部分** tags，此后场景补齐新 tag，图片也不会跟进，`overwrite=OFF` 下永不修正。
  同一条规则对 performer/studio/date/code 无害（场景定稿后不变），只有 tags 会持续增长，所以突出症状在 tags。

## 与 tagMergeAuto / nfoSceneParser 的 tag 竞态（实测，非推测）

写这张表的依据：`test_tag_race.py`（单点行为）+ `test_tag_partial.py`（自愈能力）。

| 场景 | 结果 |
|---|---|
| 用**已合并删除**的 tag id 调 `imageUpdate` | `FOREIGN KEY constraint failed`，**整条 mutation 回滚**，同批的 title/performer/studio 全部没写 |
| 同上，在插件里（v1.0.2 及更早） | `__gql` 只记 `GraphQL error` 并返回空、**不抛异常**，所以不会中断该图库，但 `updated` 仍 +1 —— 日志报「N updated」而实际一张没写 |
| tags 先写一半、场景后来补 tag（v1.0.2 及更早） | 重跑钩子**不补**（0/6），只有 `overwrite=ON` 或图片 tags 被清空才会重写 |
| `overwrite=ON` 时 | `tag_ids` 是**整体替换**，图片上手加的 tag 会被抹掉（1.0.3 起仍如此，属该开关的定义） |

v1.0.3 的对应处理（`test_tag_guard.py` 离线覆盖全部分支）：
- 写入前用 `gql_findAllTagIds()` 过滤，死 id 直接丢弃并 WARN；tag 列表查不到时**不过滤**（宁可写错也不静默清空）。
- `overwrite=OFF` 时 tags 改为**并集补缺**（`现有 ∪ 期望`），图片 tags 落后会自动追平，手工 tag 保留；`overwrite=ON` 维持整体替换。
- 单图被拒时去掉 `tag_ids` 重试一次，其余字段照样落地；`updated` 只统计真正成功的图片。

- 竞态窗口 = ImageMetaSync 读到 `gallery.scenes[].tags` 之后、写完最后一张图之前（秒级）。
  批量任务 + `parallel_tasks: 2`（本机配置）时，与 tagMergeAuto 的 Full Scan 或 nfoSceneParser 的 reload **可同时运行**，重叠概率不低。
- nfoSceneParser 侧已自保：`tagCreate` 返回后若 tag 已被 tagMergeAuto 合并删除，走 create-fallback 重新按 name/alias 解析（`__find_create_tags`）。
- 判定要点：`gallery.scenes[].tags` 是**那一刻的快照**，`GALLERY_FIELDS` 里带 `tags{id name}`，等待轮询最后一次查询即定稿。

## 日志与队列的观测陷阱（判 PASS 前必看）

钩子事件若撞上已有后台运行，会被写进 `queue.jsonl` 由**持锁进程代跑**——它处理这个图库，
但日志写进**持锁进程自己的** `.ims_pending/<别的 gid>.log`。于是目标图库的日志文件可能是 0 字节，
而数据其实早已写好。因此：

- 验证钩子是否生效一律看**数据**（演员/tags/标题），日志只作参考；`test_e2e_gallery.py` 的
  `wait_synced()` 与 `test_title_off.py` 都按这个口径判定。
- 跑测试前先清 `run.lock` / `queue.jsonl*`（`clear_pending()`），否则上一轮的残留会让本轮全部走"入队代跑"路径。

## 实测环境

- Stash v0.31.1 / databaseSchema 85，`http://localhost:9999`，插件装 `E:\stashAPP\plugins\k6cc\ImageMetaSync`
- 测试夹具：`E:\Temp\测试库\IMS-TEST-001\`（1 mp4 + 6 jpg），对应场景 `IMS-TEST-001 测试场景`
- 修改插件代码后**无需重启** Stash：钩子/任务每次 spawn 新 Python 进程读磁盘上的最新文件
