# stash-jav-tools

Stash 插件工具集 — Python + UI 混合插件合集。

## 包含插件

| 插件 | 版本 | 类型 | 说明 |
|------|------|------|------|
| [sceneTranslate](./sceneTranslate/) | 2.9.2 | Python + UI | 场景/图片/图库编辑页一键翻译（Google/Microsoft/Baidu/DeepL/OpenAI，Stash UI 可配置） |
| [sceneGallerySync](./sceneGallerySync/) | 1.9.1 | Python + UI | 扫描入库时自动创建图库并关联影片 |
| [studioTools](./studioTools/) | 1.5.2 | 纯 UI | 工作室合并 + 多源搜索更新 StashDB/ThePornDB/JAVStash |
| [JavStashLinker](./JavStashLinker/) | 1.5.2 | Python + UI | 批量匹配 JAVStash 演员 ID：场景反推 + 名称搜索 + 手动搜索（证据评级，自动补图补信息） |
| [performerMerge](./performerMerge/) | 1.6.2 | 纯 UI | 重名演员检测与合并（证据分级连组 + 树级冲突检查），附带短名清理与别名修复 |
| [tagMerge](./tagMerge/) | 2.4.2 | 纯 UI | 按可编辑映射库合并相似 tags 为规范中文 tag（源名保留为别名，映射可编辑导出） |
| [studioToolsBackend](./studioToolsBackend/) | 1.0.0 | 纯后台 | 工作室创建时自动从 Stash-box 实例拉取资料，归一化精确匹配后合并/补全（零 UI 注入） |
| [tagMergeBackend](./tagMergeBackend/) | 1.0.0 | 纯后台 | 钩子自动合并新建 tag + 任务页全量扫描（本地映射表、零网络零设置） |

## 安装

### 方式一：通过 Stash 插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

> 此 URL 是统一插件源，包含多个插件，可一并安装。

### 方式二：手动安装

从 [Releases](https://github.com/k6cc/stash-jav-tools/releases) 下载对应插件的 zip，解压到 Stash 插件目录：

- **Windows**: `%USERPROFILE%\.stash\plugins\`
- **Linux/macOS**: `~/.stash/plugins/`

每个 zip 内文件直接放在以插件名命名的子目录下：

```
plugins/
  sceneTranslate/      # 解压 sceneTranslate-vX.Y.Z.zip
  sceneGallerySync/    # 解压 sceneGallerySync-vX.Y.Z.zip
  studioTools/         # 解压 studioTools-vX.Y.Z.zip
  JavStashLinker/      # 解压 JavStashLinker-vX.Y.Z.zip
  performerMerge/      # 解压 performerMerge-vX.Y.Z.zip
  tagMerge/            # 解压 tagMerge-vX.Y.Z.zip
  studioToolsBackend/  # 解压 studioToolsBackend-vX.Y.Z.zip
  tagMergeBackend/     # 解压 tagMergeBackend-vX.Y.Z.zip
```

## 前置依赖

| 插件 | Python | requests | Stash-box API Key |
|------|--------|----------|-----------------|
| sceneTranslate | 需要 | 需要 | 不需要 |
| sceneGallerySync | 需要 | 需要 | 不需要 |
| studioTools | 不需要 | 不需要 | Search 模块需要（StashDB/ThePornDB/JAVStash 任一） |
| JavStashLinker | 需要 | 需要 | JAVStash（经「设置 → 元数据提供者」stash-box 端点配置，插件自动复用） |
| performerMerge | 不需要 | 不需要 | 不需要（需 Stash v0.31.0+） |
| tagMerge | 不需要 | 不需要 | 不需要（需 Stash v0.30+） |
| studioToolsBackend | 需要 | 不需要 | 需要（经「设置 → 元数据提供者」配置 Stash-box 实例，插件自动复用） |
| tagMergeBackend | 需要 | 不需要 | 不需要 |

### Docker 部署

Stash 官方镜像已预装 Python 和 requests，无需额外操作。studioTools、performerMerge 和 tagMerge 是纯 UI 插件，studioToolsBackend / tagMergeBackend 是纯后台插件（标准库 only），Docker 和裸机均可直接使用。

### Windows / macOS 裸机部署（仅 Python 插件）

验证 `python --version` 与 `python -c "import requests"`；缺失时按顺序安装：

```powershell
# Windows（winget）
winget install Python.Python.3.12
pip install requests

# macOS（homebrew）
brew install python@3.12
pip3 install requests
```

## 触发方式

| 插件 | 类型 | 触发方式 |
|------|------|---------|
| sceneTranslate | Python + UI | 手动任务 + 场景/图片编辑页按钮 |
| sceneGallerySync | Python + UI | Scene.Update.Post 钩子 + 手动按钮 |
| studioTools | 纯 UI | 工作室详情页按钮 |
| JavStashLinker | Python + UI | 导航栏按钮 + 手动任务 |
| performerMerge | 纯 UI | 导航栏按钮 |
| tagMerge | 纯 UI | 导航栏按钮 |
| studioToolsBackend | 纯后台 | Studio.Create.Post 钩子 + 手动任务 |
| tagMergeBackend | 纯后台 | Tag.Create.Post 钩子 + 手动任务 |

各插件详细使用说明见对应目录下的 `README.md`。

## License

MIT
