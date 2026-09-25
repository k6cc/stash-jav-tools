# 新插件首发流程（仅首次发布）

> **读这文件的时机**：发布仓库中尚不存在其发布条目的插件时（新插件首次上线、改名后的新 ID 同样适用）。日常发版见根 `AGENTS.md` 发版节。
> 依据 studioToolsAuto / tagMergeAuto 更名首发实况沉淀。

顺序不可颠倒，除走完常规发版流程外，首发必须多做三步：

## 1. release.yml 白名单

`.github/workflows/release.yml` 的 `on.push.tags` 必须新增 `"<插件>-v*.*.*"` 模式。

缺失时打 tag 不会触发任何构建，`gh run list` 永远为空，且已推送的 tag 不会补触发（需删远程 tag 重打重推：`git push origin :refs/tags/<tag>` + `git tag -d <tag>` + 重打 + `git push origin main --tags`）。

## 2. stash-plugins 占位符（必须先推送到远程）

本地 clone `E:\Temp\stash-plugins`（远程 `k6cc/stash-plugins`）常落后，先 `git fetch; git reset --hard origin/main`：

- 在 `plugins/main/index.yml` 末尾追加占位条目：`version: 0.0.0`、`sha256:` 全 0、`path:` 按 release URL 约定 `https://github.com/k6cc/stash-jav-tools/releases/download/<插件>-v0.0.0/<插件>-v0.0.0.zip`、`date:` 当前时间
- `README.md` 插件表与依赖清单**手动加行**（`scripts/sync_readme.py` 只更新已有行、不插入新行）
- commit 后**必须 push**——release workflow 是 clone 远程版再 awk 更新，占位符不在远程则 awk 找不到 `- id:` 静默跳过、链接推不上（tagMerge 曾长期停留在全 0 sha256 占位）

## 3. 运行时日志勿提交

`.gitignore` 已有 `*_backend.log` / `*_auto.log` 规则，新插件若带日志文件先确认被忽略，误提交后 `git rm --cached <log>` 补救。

## 闭环验证

yml `url:` 用真实 Discourse 帖链接（用户先发帖）→ 插件目录 commit/push → 打 tag → `gh run watch` 成功后回 stash-plugins 执行：

```
git fetch
git show origin/main:plugins/main/index.yml
```

确认该插件条目 `version`/`sha256` 已被真实值覆盖（占位符机制生效），再确认两仓库 `git status` 干净。
