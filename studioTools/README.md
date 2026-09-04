# Studio Tools

Stash 工作室详情页工具集 — 纯 UI 插件（JS + CSS，无需 Python）。

合并自 studioMerge v1.0.0 + studioSearch v2.2.0，两个模块共享 GraphQL 封装、URL 解析、MutationObserver、锚点按钮注入等基础设施。

> v1.5.2：搜索源名称显示优化 — stashdb→StashDB、theporndb→ThePornDB、javstash→JAVStash（按钮、来源徽标、tooltip 等全部生效位置）。

## 功能

### 工作室合并（Merge）

在工作室详情页「自动标签」按钮旁注入「合并」按钮，将一个工作室合并到另一个：

- 两步流程：选择源/目标 → 对比合并字段（ScrapeDialog 风格双列对比）

- 每个字段可选使用目标值或合并值（✓/✗）

- Stash ID 多实例：已合并列默认显示源的值（源有值时追加目标独有实例，源为空则显示空）；源带来新实例时自动勾「已合并」列，同源冲突勾「目标」列

- 合并结果列可编辑：拖拽排序、标签下拉选择、别名/网址增删

- 正确执行顺序：先重分配关联对象（场景/图片/图库/组合/子工作室），再更新目标，最后删除源

- 自动将非保留名添加为别名

### 多源搜索更新（Search）

在工作室详情页注入「更新」按钮，从 StashDB / ThePornDB / JAVStash 搜索并更新工作室信息：

- 搜索框自动填充当前工作室名称，可修改后搜索

- 搜索框下方可切换搜索源：内置 StashDB/ThePornDB/JAVStash + 「元数据提供者」中配置的其他 Stash-box 实例（按域名排序追加，显示名称优先），选择自动记忆

- 「全部」模式：所有可用源并发搜索（每源 8s 超时），结果按源顺序流式渲染并在名称右侧标注来源；空结果/超时源保留一行淡字提示

- 未配置入口的内置源置灰不可选（「全部」模式下不参与搜索）；自定义实例选中时以白色边框区分

- 点击搜索结果后后台直接更新数据库（名称/别名/链接/图片/Stash ID/上级工作室）

- 自动匹配本地已有的上级工作室

- 图片由 Stash 后端下载，兼容 Docker 环境

- 更新完成后自动刷新页面

**前置条件**：需在 Stash「设置 → 元数据提供者 → Stash-box 端点」中配置至少一个搜索源的 API Key。

## 安装

### 方式一：通过 Stash 插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

然后从列表中安装 **Studio Tools**。

### 方式二：手动安装

从 [Releases](https://github.com/k6cc/stash-jav-tools/releases) 下载 `studioTools-vX.Y.Z.zip`，解压到 Stash 插件目录：

- **Windows**: `%USERPROFILE%\.stash\plugins\`

- **Linux/macOS**: `~/.stash/plugins/`

```
plugins/
  studioTools/
    studioTools.yml
    studioTools.js
    studioTools.css
```

## 前置依赖

| 组件                    | 必需          | 说明                                                        |
| --------------------- | ----------- | --------------------------------------------------------- |
| **Stash**             | 是           | v0.25+                                                    |
| **现代浏览器**             | 是           | Chrome、Firefox、Safari、Edge                                |
| **Stash-box API Key** | Search 模块需要 | 设置 → 元数据提供者 → Stash-box 端点（StashDB/ThePornDB/JAVStash 任一） |

> 纯 UI 插件（仅 JS + CSS），无需 Python。

## 使用方法

### 工作室合并

1. 进入任意工作室详情页
2. 点击操作栏中的「合并」按钮
3. 选择源工作室（将被合并并删除）和目标工作室（保留）
4. 在对比界面编辑合并结果（名称、别名、链接、标签、图片等）
5. 点击「应用合并」执行

### 多源搜索更新

1. 进入任意工作室详情页
2. 点击操作栏中的「更新」按钮（位于「自动标签」按钮旁）
3. 搜索框自动填充当前工作室名称，可修改后搜索
4. 在搜索框下方点选搜索源（「全部」或单源，选择会记忆）
5. 点击搜索结果，后台自动更新工作室信息
6. 页面自动刷新

## 技术细节

- 两个模块共享 `fetchCurrentStudio()` 缓存（缓存 pending Promise），避免重复 GraphQL 查询，并保证合并/更新按钮注入顺序稳定

- 注入按钮使用统一的 `.st-inject-btn` 样式类（feather 风格线性 SVG 图标：`st-blue` 合并 / `st-green` 更新）

- 模块特定样式分别使用 `sm-`（merge）和 `ss-`（search）前缀，互不冲突

- MutationObserver + history hook 确保 SPA 路由切换时按钮正确注入/移除

## License

MIT
