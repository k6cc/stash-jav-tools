# ImageMetaSync — 脚本总览

全部脚本在 `scripts/`。`python` 指 `C:/Users/k6cc/.workbuddy/binaries/python/versions/3.13.12/python.exe`，
在 `scripts/` 目录下执行。脚本一律直接读写**真实实例**，跑前注意"写数据"列。

| 脚本 | 验什么 | 写数据 | 跑法 |
|---|---|---|---|
| `audit_state.py` | 全库口径体检：演员并集、多演员库、标题编号唯一性、封面纯标题 | 否 | `python audit_state.py [--dump]`；`--dump` 打印每个图库明细 |
| `verify_image_meta_sync.py` | 快照 / 单图库状态 / 清空 / 批量任务 / 触发钩子 / 读后台日志 | 是（clear/task/hook） | `snapshot` → `task [--with-fallback]` → `diff`；单库 `show <gid>` / `clear <gid>` / `pending <gid>` |
| `test_e2e_gallery.py` | 受控 E2E：建空图库 → 延迟 3s 挂图 → 校验竞态等待、各字段、编号、开关、多演员跳过 | 是（建/删测试图库 96、写 6 张图元数据、临时改设置） | `full`（全 6 阶段）/ `setup` / `check` / `hook <gid>` / `skip` / `reset` / `cleanup`；`check` 用独立 oracle 推算期望值 |
| `test_fallback_no_gallery.py` | 无图库兜底：清空 936/937 → 跑任务 → 断言按文件名链回填 | 是 | `python test_fallback_no_gallery.py {clear\|run\|dir}` |
| `test_lock_queue.py` | 锁/队列：持锁只入队、假锁不消费队列、过期清理覆盖 `queue.jsonl*` | 是（只动 `.ims_pending` 内文件 + 触发 galleryUpdate 95） | `python test_lock_queue.py`，约 90s |
| `test_title_off.py` | `fillTagsTitleCode=OFF` 时图库路径与兜底路径都不写标题/番号/tag | 是（改设置，结束前还原） | `python test_title_off.py` |
| `probe_schema.py` | 插件用到的 GraphQL 字段/参数在当前 Stash 版本是否可用 | 否 | `python probe_schema.py` |
| `probe_hook_trigger.py` | `imageUpdate` / `addGalleryImages` 是否会触发 `Gallery.Update.Post` | 是（改图/挂图再撤回） | `python probe_hook_trigger.py <image_id> <gallery_id>` |
| `probe_shared_images.py` | 统计多图库共享图片、未入图库图片、图库↔场景演员关系 | 否 | `python probe_shared_images.py` |

## 复用注意

- 测试夹具（`E:\Temp\测试库\IMS-TEST-001`）的 6 张图是同一批，图库每次 `full` 会重建（id 递增），**图片 id 相对固定**（938~943 附近）；换机器/换库要先跑 `setup` 再 `check`。
- `test_e2e_gallery.py` 的 oracle 依赖"封面由 Stash 选 `fanart1.jpg`"这一事实；换文件名集合要同步改期望表。
- 脚本改插件设置后务必还原（`test_e2e_gallery.py` 的 `full`、`test_title_off.py` 结尾都会还原为默认：`fillTagsTitleCode=true, fillUrlsDetails=false, overwrite=false, excludeTags="", includeScenesWithoutGallery=false`）。
