# stash-jav-tools

Stash 插件工具集 — Python + UI 混合插件合集。

## 包含插件

| 插件 | 版本 | 类型 | 说明 |
|------|------|------|------|
| [sceneTranslate](./sceneTranslate/) | 2.9.2 | Python + UI | 场景/图片/图库编辑页一键翻译，支持 Google/Microsoft/Baidu/DeepL/OpenAI，Stash UI 可配置 |
| [sceneGallerySync](./sceneGallerySync/) | 1.9.1 | Python + UI | 扫描入库时自动创建图库并关联影片 |
| [studioTools](./studioTools/) | 1.5.2 | 纯 UI | 工作室合并 + 多源搜索更新 StashDB/ThePornDB/JAVStash（无需 Python） |
| [JavStashLinker](./JavStashLinker/) | 1.3.0 | Python + UI | 批量匹配 JAVStash 演员 ID，场景反推 + 番号确认 + 名称/别名匹配 + 手动搜索（多信号证据规则） |
| [performerMerge](./performerMerge/) | 1.6.0 | 纯 UI | 重名演员检测与合并：证据分级连组（stash_id/共享 URL/主名全名/短名）+ 树级 ID/URL 冲突检查，冲突/低可信度组挂徽章并退出「合并全部」，被阻断对在「强制合并」页人工核实后手动合并；附带共享短名别名一键清理与别名单行合并错误拆分修复（无需 Python） |
| [tagMerge](./tagMerge/) | 2.3.0 | 纯 UI | 按可编辑映射库把相似名称的 tags（英文/日文/中文变体）合并为规范中文 tag，面板预览后一键合并，源名保留为别名；映射表可在面板内编辑并导出文件，冲突检测一键清理（无需 Python） |

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
  performerMerge/      # 解压 performerMerge-vX.Y.Z.zip
  tagMerge/            # 解压 tagMerge-vX.Y.Z.zip
```

## 前置依赖

| 插件 | Python | requests | Stash-box API Key |
|------|--------|----------|-----------------|
| sceneTranslate | 需要 | 需要 | 不需要 |
| sceneGallerySync | 需要 | 需要 | 不需要 |
| studioTools | 不需要 | 不需要 | Search 模块需要（StashDB/ThePornDB/JAVStash 任一） |
| JavStashLinker | 需要 | 需要 | JAVStash |
| performerMerge | 不需要 | 不需要 | 不需要（需 Stash v0.31.0+） |
| tagMerge | 不需要 | 不需要 | 不需要（需 Stash v0.30+） |

### Docker 部署

Stash 官方镜像已预装 Python 和 requests，无需额外操作。studioTools、performerMerge 和 tagMerge 是纯 UI 插件，Docker 和裸机均可直接使用。

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
8. 在「手动搜索」标签页：列出全部未绑定演员（可按名称/别名筛选），点「搜索」逐词搜 JAVStash，命中高可信度即停止，「更多」展开全部候选（StashDB 交叉/URL 交集/多名称一致/生日比对）

详细说明见 [JavStashLinker/README.md](./JavStashLinker/README.md)。

### performerMerge

1. 点击导航栏右侧的紫色合并图标，打开面板
2. 点击「开始扫描」— 遍历所有演员的名字+别名，归一化分组找出重名演员
3. 每组通过单选框选择目标演员（默认预选场景数最多的），行内徽章显示场景/别名/stash_id 等信息辅助判断
4. 点击组内「合并」或顶部「合并全部」— 名字/图片保留目标的，源演员名字+别名原样并入目标别名（仅精确去重），其余字段按官方规则合并，场景/标签转移到目标，源演员删除
5. 「强制合并」页列出被 stash_id 冲突阻断的重名对（可能为不同的人）：核实确为同一人后逐对手动强制合并（红色按钮，冲突明细可悬浮徽章查看），误报对可忽略；该页纯手动，不参与「合并全部」
6. 需要 Stash v0.31.0+（低版本面板会显示警告）

详细说明见 [performerMerge/README.md](./performerMerge/README.md)。

### tagMerge

1. 点击导航栏右侧的绿色标签图标，打开面板（「分组 / 查看映射 / 日志」分页始终显示，无需先扫描）
2. 「查看映射」分页可搜索/编辑映射表：顶部搜索框过滤，「添加」新建；每条映射可编辑/保存/撤销/删除，重复项按归一化规则实时标红提示；存在冲突时「冲突项」筛选列出冲突条目、冲突源标黄并可逐条「清理」；「导出文件」下载完整 JSON（含 `_` 说明键），手动替换插件目录中的 `tag_merge_map.json` 后重新扫描生效
3. 点击「开始扫描」— 读取映射库并匹配库内 tags，按分组预览将要合并的内容（每次扫描重新读取，替换文件后无需重启）
4. 每组第一行是目标 tag（不存在时标注「新建」），下方是源 tag 列表（含引用计数徽章 — 场景/标记/图库/图片/演员/群组/工作室/别名，仅显示非零项 — 与「变体」标注，指向行时高亮）；可按源忽略（行右侧「忽略」）或按组忽略（「合并」右侧「忽略」折叠整组），均仅本次会话生效、重新扫描重置，「合并全部」实时排除被忽略内容
5. 点击组内「合并」或顶部「合并全部」— 相似名称的 tags（如 `3p`、`3P·4P` → `3P/4P`）合并为规范中文 tag，源名保留为别名可继续搜索；合并完成后该组折叠成一行（目标名 · 并入源数 + 「已合并」徽章）
6. 已合并/不存在的源自动跳过，重新扫描即刷新预览

详细说明见 [tagMerge/README.md](./tagMerge/README.md)。

## 插件列表

| 插件 | 类型 | 触发方式 |
|------|------|---------|
| sceneTranslate | Python + UI | 手动任务 + 场景/图片编辑页按钮 |
| sceneGallerySync | Python + UI | Scene.Update.Post 钩子 + 手动按钮 |
| studioTools | 纯 UI | 工作室详情页按钮 |
| JavStashLinker | Python + UI | 导航栏按钮 + 手动任务 |
| performerMerge | 纯 UI | 导航栏按钮 |
| tagMerge | 纯 UI | 导航栏按钮 |

## License

MIT
