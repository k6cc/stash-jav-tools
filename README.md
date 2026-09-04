# stash-jav-tools

Stash 插件工具集 — Python + UI 混合插件合集。

## 包含插件

| 插件 | 版本 | 类型 | 说明 |
|------|------|------|------|
| [sceneTranslate](./sceneTranslate/) | 2.9.2 | Python + UI | 场景/图片/图库编辑页一键翻译，支持 Google/Microsoft/Baidu/DeepL/OpenAI，Stash UI 可配置 |
| [sceneGallerySync](./sceneGallerySync/) | 1.9.1 | Python + UI | 扫描入库时自动创建图库并关联影片 |
| [studioTools](./studioTools/) | 1.5.2 | 纯 UI | 工作室合并 + 多源搜索更新 StashDB/ThePornDB/JAVStash（无需 Python） |
| [JavStashLinker](./JavStashLinker/) | 1.0.0 | Python + UI | 批量匹配 JAVStash 演员 ID，场景反推 + 番号确认 + 名称/别名匹配 |

## 安装

### 方式一：通过 Stash 插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

> 此 URL 是统一插件源，包含多个插件，可一并安装。

然后从列表中安装对应插件。

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
```

## 前置依赖

| 插件 | Python | requests | Stash-box API Key |
|------|--------|----------|-----------------|
| sceneTranslate | 需要 | 需要 | 不需要 |
| sceneGallerySync | 需要 | 需要 | 不需要 |
| studioTools | 不需要 | 不需要 | Search 模块需要（StashDB/ThePornDB/JAVStash 任一） |
| JavStashLinker | 需要 | 需要 | JAVStash |

### Docker 部署

Stash 官方镜像已预装 Python 和 requests，无需额外操作。studioTools 是纯 UI 插件，Docker 和裸机均可直接使用。

### Windows / macOS 裸机部署（仅 Python 插件）

在 PowerShell（Windows）或终端（macOS）执行以下命令验证：

```powershell
python --version                  # 应输出 Python 3.x.x
python -c "import requests"       # 应无报错
```

若任一报错，按以下顺序安装：

```powershell
# Windows（winget）
winget install Python.Python.3.12
pip install requests

# macOS（homebrew）
brew install python@3.12
pip3 install requests
```

## 使用方法

### sceneTranslate

sceneTranslate 在 **Stash → 设置 → 插件 → Scene Translate** 中配置翻译引擎、目标语言、空闲超时（留空使用默认值 `google_free` / `zh-CN` / `600`）；`config.json` 仅存放代理端口与各引擎 API 密钥。

1. **google_free 引擎无需启动代理**：选择 `google_free` 后刷新页面即可使用翻译按钮（代理在线时优先走代理，离线时浏览器直连 Google 兜底）
2. **其他引擎（Google API / Microsoft / Baidu / DeepL / OpenAI）需要代理**：在 Stash「设置 → 插件 → 插件任务」中点击 **Start Translate Proxy** 启动翻译代理
3. 进入任意场景编辑页（`/scenes/{id}`）、图片编辑页（`/images/{id}`）或图库编辑页（`/galleries/{id}`），标题和详情字段旁会出现翻译按钮
4. 点击翻译按钮，将原文翻译为目标语言
5. 支持的翻译引擎：Google Free（免费）、Google API、Microsoft、Baidu、DeepL、OpenAI

详细配置见 [sceneTranslate/README.md](./sceneTranslate/README.md)。

### sceneGallerySync

1. 插件在场景更新时自动触发（扫描入库后）
2. 检测同目录下的 `extrafanart/` 文件夹、`{文件名}-poster.jpg`、`{文件名}-fanart.jpg` 等图片
3. 自动创建图库，导入图片，关联影片，设置封面
4. 多碟影片（CD1/CD2 等）自动共享同一图库
5. 也可在场景编辑页手动点击"创建图库"按钮

详细配置见 [sceneGallerySync/README.md](./sceneGallerySync/README.md)。

### studioTools

1. 进入任意工作室详情页
2. 操作栏「自动标签」按钮旁会注入两个按钮：
   - **合并** — 将当前工作室合并到另一个工作室（ScrapeDialog 风格双列对比）
   - **更新** — 从 StashDB/ThePornDB/JAVStash 搜索并更新工作室信息（可切换单源或「全部」并发搜索）
3. 点击对应按钮按提示操作

详细说明见 [studioTools/README.md](./studioTools/README.md)。

### JavStashLinker

1. 确保已在 Stash「设置 → 元数据提供者」中配置 JAVStash 端点和 API Key
2. 点击导航栏右侧的链接图标，打开匹配面板
3. 点击「开始扫描」— 自动扫描所有含 JAVStash 场景 ID 的场景，反查演员列表
4. 在「自动匹配」标签页查看 high 置信度匹配（单演员场景 + 番号确认名称匹配）
5. 在「待审核」标签页审核 medium 置信度匹配（纯名称/别名匹配）
6. 在「未匹配」标签页为多演员场景手动选择本地演员
7. 点击「应用全部」批量应用 high 置信度匹配，或逐条点击「应用」按钮

详细说明见 [JavStashLinker/README.md](./JavStashLinker/README.md)。

## 插件列表

| 插件 | 类型 | 触发方式 |
|------|------|---------|
| sceneTranslate | Python + UI | 手动任务 + 场景/图片编辑页按钮 |
| sceneGallerySync | Python + UI | Scene.Update.Post 钩子 + 手动按钮 |
| studioTools | 纯 UI | 工作室详情页按钮 |
| JavStashLinker | Python + UI | 导航栏按钮 + 手动任务 |

## License

MIT
