# AGENTS.md

本仓库是 Stash 插件集合（monorepo）：`sceneTranslate` / `sceneGallerySync` / `studioTools` / `JavStashLinker` 四个插件 + 根 `README.md` 版本表。插件通过各 `<name>.yml` 的 `version:` 字段声明版本，Stash 实际读取该字段；发版时**所有版本号位置必须同步**，否则会漂移。

## 发版清单（四个插件通用）

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致。

| 插件 | 权威版本位置 | 需同步的位置 | README 版本说明约定 |
|---|---|---|---|
| sceneTranslate | `sceneTranslate.yml` `version:` | `translateProxy.py` 头部 banner（`Scene Translate Proxy vX.Y.Z`）；`README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| sceneGallerySync | `sceneGallerySync.yml` `version:` | 根 `README.md` 版本表 | 头部无 note；在文末「## 变更历史」新增 `### X.Y.Z` 条目 |
| studioTools | `studioTools.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| JavStashLinker | `JavStashLinker.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |

根 `README.md` 版本表包含全部四个插件，发版必须同步。各插件 `yml` 的 `url:` 字段指向 Discourse 论坛帖子，发布时确认链接正确。

## 发版流程（git）

1. 更新上表所有位置（含根 `README.md` 版本表）
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件名>-vX.Y.Z`（如 `sceneTranslate-v2.9.2`）；多插件联动发版时每个插件各打一个 tag
5. `git push && git push --tags`
6. Windows 下 git 提示 LF→CRLF 属正常，不影响内容；PowerShell 不支持 heredoc，commit 用 `-m "..."` 即可

## 其他

- `.gitignore` 已忽略 `__pycache__` 与备份文件，不要提交
- 本文件是 agent 协作约定，不随插件版本发布
