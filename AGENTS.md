# AGENTS.md

本仓库是 Stash 插件集合（monorepo）：`sceneTranslate` / `sceneGallerySync` / `studioTools` / `JavStashLinker` / `performerMerge` / `tagMerge` / `studioToolsAuto` / `tagMergeAuto` 八个插件 + 根 `README.md` 版本表 + `stash-testkit/`（实例测试工具集，非发布物，见末尾「测试工具集」节）。插件版本以各 `<name>.yml` 的 `version:` 为权威，Stash 实际读取该字段。

## 发版

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致。通用同步项：

- 根 `README.md` 版本表（含全部八插件，发版必同步）
- 各插件 `README.md` 头部 `> vX.Y.Z：` note，**只保留最新一条**；sceneGallerySync 例外：头部无 note，在文末「## 变更历史」新增 `### X.Y.Z` 条目
- 各插件 `yml` 的 `url:` 指向 Discourse 论坛帖，发布时确认链接正确
- **tagMergeAuto 的 `tag_merge_map.json` 与 tagMerge 保持同源同步**（复制自 tagMerge 目录，任一侧更新后必须同步另一份）；映射表读取按优先级链（`tag_merge_map_<lang>.custom.json` → `tag_merge_map.custom.json` → `tag_merge_map_<lang>.json` → `tag_merge_map.json`），用户自定义文件（`tag_merge_map*.custom.json`）是本地产物，不入库、不参与同步、不打进发布 zip

代码内版本位置：

| 插件 | 代码内版本位置 |
|---|---|
| sceneTranslate | `translateProxy.py` 头部 banner（`Scene Translate Proxy vX.Y.Z`）+ 状态报文 `"version"` 字段；`sceneTranslate.js` 头部 banner（`Scene Translate Plugin vX.Y.Z`） |
| JavStashLinker / performerMerge / tagMerge | 对应 `.js` 顶部 `PLUGIN_VERSION`（面板标题右侧显示） |
| studioToolsAuto / tagMergeAuto / sceneTranslateAuto | 对应 `.py` 头部 docstring banner（`... Auto vX.Y.Z`） |

### 流程

1. 更新上表所有位置（含根 `README.md` 版本表）
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件名>-vX.Y.Z`（如 `sceneTranslate-v2.9.2`）；多插件联动发版时每个插件各打一个 tag
5. `git push; git push --tags`（分号分隔，勿用 `&&`）
6. 验证：`gh run list --limit 1` 找 Release workflow → `gh run watch <id> --exit-status` 等待成功；`gh release view <tag> --json assets` 确认 zip 产物存在；`git status` 确认工作区干净
7. Windows：git 提示 LF→CRLF 属正常，不影响内容；commit 用 `-m "..."`、命令链用 `;`（勿用 `&&`/`||`，PowerShell 5.1 不支持）；**受限沙箱环境下 `git push` 可能因 schannel TLS 握手失败被拦**（`fatal: unable to access ... schannel: failed to receive handshake`）——push/tag 推送需在沙箱外执行，commit/add 等本地操作不受影响

### 新插件首发（仅首次发布，顺序不可颠倒）

新插件 = 仓库中尚不存在其发布条目的插件（如首次上线的 backend，改名后的新 ID 同样适用）。除走完上述流程外，首发必须多做三步（依据 studioToolsAuto / tagMergeAuto 更名首发实况）：

1. **release.yml 白名单**：`.github/workflows/release.yml` 的 `on.push.tags` 必须新增 `"<插件>-v*.*.*"` 模式——缺失时打 tag 不会触发任何构建，`gh run list` 永远为空，且已推送的 tag 不会补触发（需删远程 tag 重打重推：`git push origin :refs/tags/<tag>` + `git tag -d <tag>` + 重打 + `git push origin main --tags`）
2. **stash-plugins 占位符（必须先推送到远程）**：本地 clone `E:\Temp\stash-plugins`（远程 `k6cc/stash-plugins`）常落后，先 `git fetch; git reset --hard origin/main`；在 `plugins/main/index.yml` 末尾追加占位条目（`version: 0.0.0`、`sha256:` 全 0、`path:` 按 release URL 约定 `https://github.com/k6cc/stash-jav-tools/releases/download/<插件>-v0.0.0/<插件>-v0.0.0.zip`、`date:` 当前时间）；`README.md` 插件表与依赖清单**手动加行**（`scripts/sync_readme.py` 只更新已有行、不插入新行）；commit 后**必须 push**——release workflow 是 clone 远程版再 awk 更新，占位符不在远程则 awk 找不到 `- id:` 静默跳过、链接推不上（tagMerge 曾长期停留在全 0 sha256 占位）
3. **运行时日志勿提交**：`.gitignore` 已有 `*_backend.log` / `*_auto.log` 规则，新插件若带日志文件先确认被忽略，误提交后 `git rm --cached <log>` 补救

其余顺序与常规发版一致：yml `url:` 用真实 Discourse 帖链接（用户先发帖）→ 插件目录 commit/push → 打 tag → 验证。**闭环验证**：`gh run watch` 成功后回 stash-plugins 执行 `git fetch; git show origin/main:plugins/main/index.yml`，确认该插件条目 `version`/`sha256` 已被真实值覆盖（占位符机制生效），再确认两仓库 `git status` 干净。

## 文件编辑（agent 工作约定）

- **同一文件的多处修改一律串行执行**：等上一次编辑落盘完成后再发起下一次；只有不同文件的修改可以并行。原因：并行的每次编辑基于各自快照应用差异后整体写回，后完成者覆盖先完成者，同批只有最后落盘的一处存活（tagMerge.js 曾多次复现修改静默丢失）
- 多处修改完成后用 `rg` 逐点核对关键改动确已在盘，再报完成
- **Edit 工具偶发「File has not been read yet」卡死**（即使刚 Read 过）：改用 PowerShell `[IO.File]::ReadAllText($path)` + `[IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding $false))` 做字符串替换绕过；写回用 UTF-8 无 BOM、LF 结尾，与仓库现有文件一致

## 专题规范（按需 Read，不每次必读）

- **改带 UI 的插件 `.js` 前**：读 `docs/ui-guidelines.md`（按钮语义/状态切换/搜索框/幂等守卫/窄屏/i18n）。纯后台 Python 插件不适用。
- **写/改插件 README 或 `forum-post-*.md` 前**：读 `docs/docs-writing.md`（README 结构与取舍 + 论坛帖写作规则）。

## 测试工具集（stash-testkit/）

插件开发/验证用的本地 Stash 实例测试工具集，**不随插件发布**。AI 做插件测试时入口是 `stash-testkit/INVENTORY.md`（任务→脚本映射表 + 硬约束 top5），流程细节与硬约束清单在 `stash-testkit/README.md`，业务语义深查在 `tests/<plugin>/NOTES.md`，历史结论在 `_archive/`。

**用户说"沉淀本轮经验"时**，按 `stash-testkit/INVENTORY.md` 末尾的「沉淀规范」四步走：分流（新脚本→INVENTORY+README 索引 / 通用坑→README 硬约束 / 业务语义→子目录 NOTES / 一次性结论→_archive/）→ 写作（操作导向、不重复、可执行）→ 反模式（不写设计辩护/流水账/已被脚本覆盖的人工步骤）→ 自检（两处索引同步、分类正确、无重复）。

## 其他

- `.gitignore` 已忽略 `__pycache__`、备份文件、论坛文章草稿（`forum-post-*.md`）、`stash-testkit/config.json`（含 API key），不要提交
- 本文件是 agent 协作约定，不随插件版本发布
