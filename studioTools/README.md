# Studio Tools

Stash 工作室详情页工具集 — 纯 UI 插件（JS + CSS，无需 Python）。

合并自 studioMerge v1.0.0 + studioSearch v2.2.0，两个模块共享 GraphQL 封装、URL 解析、MutationObserver、锚点按钮注入等基础设施。

> v1.2.1：合并字段勾选逻辑统一 — 单值字段（Stash ID/评分/收藏/忽略自动标签/已整理）与父工作室/图片同逻辑：目标列显示目标值、已合并列显示源值，两边都有勾目标，仅源有勾合并；修复目标无 Stash ID 源有时误勾目标、目标有简介源无时合并列复制目标内容并误勾合并两个 bug；简介：源无内容时合并列为空，两边都有时拼接（目标+分隔线+源）；「详情」改名「简介」。

> v1.2.0：合并弹窗增强 — 别名/网址列表自动增删行（输入即转正式行并追加空行、清空末行自动删除、清空中间行红字警告并禁用应用按钮）；对比表格扁平化（去内圈边框和列底色，仅横线分行）；Stash ID 端点徽章与 ID 值上下堆叠；「合并结果」列改名「已合并」；「调换」按钮改蓝底蓝字（与下拉选中项同色系）；极窄屏多项适配（父工作室/标签选项框收缩、长标签名省略号截断、清空按钮隐藏）；无内容时「下一步」禁用。

## 功能

### 工作室合并（Merge）

在工作室详情页「自动标签」按钮旁注入「合并」按钮，将一个工作室合并到另一个：

- 两步流程：选择源/目标 → 对比合并字段（ScrapeDialog 风格双列对比）
- 每个字段可选使用目标值或合并值（✓/✗）
- 合并结果列可编辑：拖拽排序、标签下拉选择、别名/网址增删
- 正确执行顺序：先重分配关联对象（场景/图片/图库/组合/子工作室），再更新目标，最后删除源
- 自动将非保留名添加为别名

### StashDB 搜索更新（Search）

在工作室详情页注入「更新」按钮，从 StashDB 搜索并更新工作室信息：

- 搜索框自动填充当前工作室名称，可修改后搜索
- 点击搜索结果后后台直接更新数据库（名称/别名/链接/图片/Stash ID/上级工作室）
- 自动匹配本地已有的上级工作室
- 图片由 Stash 后端下载，兼容 Docker 环境
- 更新完成后自动刷新页面

**前置条件**：需在 Stash「设置 → 元数据提供者 → Stash-box 端点」中配置 StashDB API Key。

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

| 组件 | 必需 | 说明 |
|------|------|------|
| **Stash** | 是 | v0.25+ |
| **现代浏览器** | 是 | Chrome、Firefox、Safari、Edge |
| **StashDB API Key** | Search 模块需要 | 设置 → 元数据提供者 → Stash-box 端点 |

> 纯 UI 插件（仅 JS + CSS），无需 Python。

## 使用方法

### 工作室合并

1. 进入任意工作室详情页
2. 点击操作栏中的「合并」按钮
3. 选择源工作室（将被合并并删除）和目标工作室（保留）
4. 在对比界面编辑合并结果（名称、别名、链接、标签、图片等）
5. 点击「应用合并」执行

### StashDB 搜索更新

1. 进入任意工作室详情页
2. 点击操作栏中的「更新」按钮（位于「自动标签」按钮旁）
3. 搜索框自动填充当前工作室名称，可修改后搜索
4. 点击搜索结果，后台自动更新工作室信息
5. 页面自动刷新

## 技术细节

- 两个模块共享 `fetchCurrentStudio()` 缓存（缓存 pending Promise），避免重复 GraphQL 查询，并保证合并/更新按钮注入顺序稳定
- 注入按钮使用统一的 `.st-inject-btn` 样式类（feather 风格线性 SVG 图标：`st-blue` 合并 / `st-green` 更新）
- 模块特定样式分别使用 `sm-`（merge）和 `ss-`（search）前缀，互不冲突
- MutationObserver + history hook 确保 SPA 路由切换时按钮正确注入/移除

## License

MIT
