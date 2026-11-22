# SceneBackfill — 入库路径语义

> 一句话：**只有 SceneBackfill 自己发起的 import 会合并文件**。库里别处冒出来的文件、用户手工扫描、手工搬走的文件，都不会触发合并，也不会自愈。
> 脚本 [SCRIPTS.md](SCRIPTS.md) · 实测坑 [NOTES.md](NOTES.md)

## 唯一的合并点

- `mode=import` → `import_scene` → 定位文件 → `scan_and_find_many`（真正的 `metadataScan`）→ 按路径找 file → 文件已属于别的场景 → `sceneMerge(src=[那个场景], dst=原场景)`。
- 手动点「入库」和守护自动入库走**同一个入口**，`autoImport` 开关只管守护那个循环，不管 op；手动点击会先清 `nextImportAt`（不受退避限制）。
- **定位文件只有一条路**：qB `properties.save_path` + `files()` 的文件名 → `map_path` → `os.path.isfile`。没有「按文件名/哈希在库里搜」的兜底。
- `sceneMerge` 只迁文件 + `values.custom_fields`，源场景被销毁、原场景标量字段原样；**合并不会叫醒任何插件**（见 `../../README.md` 硬约束「数据语义」）。

## 入库前置条件（缺哪条报哪句）

| 条件 | 不满足时的报错 |
|---|---|
| 记录里有 `chosen.hash` | 该场景还没有推送记录 |
| 下载器里任务还在 | 下载器里找不到该任务 |
| `progress ≥ 0.999` 且状态不 busy | 还没下载完 |
| 映射后的原路径上文件还在 | 下载目录里找不到 X，检查路径映射 |
| 该路径在某个库路径内 | 下载目录不在 Stash 库路径内 |

自动模式按 60s→5min→15min→1h→6h 重试 6 次后放弃；手动模式每次都从头试。

## 文件已经进库时会发生什么

| 触发方式 | 临时场景 | 谁合并 | 结果 |
|---|---|---|---|
| 守护自动入库（开关开） | Stash 扫描时建 | SceneBackfill，扫后 2–6s | 正常闭环 |
| 手动点「入库」（开关无关） | 同上 | 同上 | 同上，时延由点击时刻决定 |
| 自己在 Stash 里手工扫描 | Stash 建 | **没人合并** | 两个同 `stash_id` 场景；原场景仍 `file_count=0`，永远留在待处理池；记录停在「下载中」 |
| 先搬文件到库里别处再扫描 | Stash 建 | **没人合并**，且 import 报「下载目录里找不到」 | 同上，且不写任何标记，其他插件照常填新场景 |

- 手工扫描后的补救：再点一次「入库」能合并（`link=merge`），但期间在临时场景上做的编辑（评分/组织标记/手写标签）会丢；搬走文件的只能搬回原路径、Stash 里手动 merge，或手动把 file 指回原场景。
- 记录状态 `imported` 才进「已完成」tab；`downloaded` 留在下载列表，行尾与详情弹窗都有「入库」。已完成里再点入库是幂等重跑（`link=attached`）。
- 手动入库是同步 `runPluginOperation`，反代 60s 上限，而 `scan_and_find_many` 最长等 90s：前端可能报超时，但文件可能已合并 → 再点一次看 `attached`。

## 临时场景上各插件做什么（默认 20s 窗口）

- **nfoSceneParser**：目录里没 `.nfo` → 不动。
- **javstashAutofill+**：排 `sceneFillDelay`（默认 20s）延迟任务。场景已被合并 → `scene gone, skip`（只写插件日志，不写 Stash 日志）；未被合并 → oshash 查到同一条就全量填（含 `stash_ids`），这次写入触发 `Scene.Update.Post`。
- **sceneGallerySync**：只挂 `Scene.Update.Post`。合并不触发，所以「靠合并拿到文件」的场景不会自动建图库，只有当别人写这个场景时才被叫醒。
- **sceneTranslateAuto**：建场景时标题为空 → skip；被 autofill 的 Update.Post 叫醒后 25s 才翻，赶上合并就是白做一次。
- **tagMergeAuto**：只吃 `Tag.Create.Post`，与合并无关。

## 合并失败时的标记

`_mark_merge_failed` 给每个源场景写 `custom_fields.sb_merge_to=<原场景 id>`（`sb_merge_at` 带 1 天 TTL），autofill / gallerySync / nfoSceneParser / translateAuto 见到就跳过，避免给「等下一次重试合并」的残留场景补元数据。**某场景静默不处理，先查 `custom_fields`**。协议全文见主仓库 `AGENTS.md`「跨插件约定」。

## 测试口径

- 想验「入库合并」，必须让它自己 import（手动点或开守护）。用 `trigger_scan` 代替只会造出一个不合并的临时场景。
- 验手动入库时下载器里要留着那个任务、文件要停在原 `save_path`，否则只能测到报错分支。
