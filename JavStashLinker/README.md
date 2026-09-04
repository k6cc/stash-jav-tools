# JavStashLinker

Stash 演员元数据批量关联工具 — Python + UI 混合插件。

通过场景 Stash ID 反查 JAVStash 演员，自动/半自动将 JAVStash Performer ID 写入本地演员的 stash_id。

> v1.0.0：首发版本 — 场景反推 + 番号确认 + 名称/别名匹配，交互式 UI 批量审核与写入。

## 功能

### 批量匹配 JAVStash 演员 ID

从所有含 JAVStash Stash ID 的场景出发，反查 JAVStash 场景的演员列表，通过多级匹配策略关联本地演员：

- **匹配优先级**：
  1. **已有 stash_id 跳过** — 本地演员已有 JAVStash ID 的场景自动跳过
  2. **单演员场景** — 一对一自动关联（high 置信度）
  3. **番号确认 + 名称匹配** — 场景番号匹配后，演员名称/别名命中（high 置信度）
  4. **纯名称/别名匹配** — 番号不匹配时降级（medium 置信度，待审核）
  5. **多演员未命中** — 列出手动选择

- **写入内容**：
  - JAVStash stash_id（不覆盖已有）
  - JAVStash 演员名 + 别名合并到本地演员 aliases（去重）
  - JAVStash 演员 URLs 合并到本地演员 urls（去重）

### 交互式 UI

- 导航栏注入链接图标按钮，点击打开全屏面板
- **自动匹配** / **待审核** / **未匹配** 三标签页
- 每条匹配可单独应用或忽略
- "应用全部" 仅应用 high 置信度匹配，medium 需单独应用
- 扫描进度实时显示，日志区记录操作结果
- 增量扫描：跳过所有演员均已匹配的场景

### 批量任务（无 UI）

- **Batch Scan** — 扫描所有场景，输出 `match_results.json`
- **Apply High-Confidence Matches** — 应用上次扫描的 high 置信度匹配

## 安装

### 方式一：通过 Stash 插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

然后从列表中安装 **JavStashLinker**。

### 方式二：手动安装

从 [Releases](https://github.com/k6cc/stash-jav-tools/releases) 下载 `JavStashLinker-vX.Y.Z.zip`，解压到 Stash 插件目录：

- **Windows**: `%USERPROFILE%\.stash\plugins\`
- **Linux/macOS**: `~/.stash/plugins/`

```
plugins/
  JavStashLinker/
    JavStashLinker.yml
    JavStashLinker.py
    JavStashLinker.js
    JavStashLinker.css
```

## 前置依赖

| 组件 | 必需 | 说明 |
|------|------|------|
| **Stash** | 是 | v0.25+ |
| **Python** | 是 | 3.8+，批量任务需要 |
| **requests** | 是 | `pip install requests` |
| **JAVStash API Key** | 是 | 设置 → 元数据提供者 → Stash-box 端点 |

> JAVStash 的 endpoint 和 API Key 直接从 Stash「设置 → 元数据提供者」读取，无需在插件页面重复配置。

## 使用方法

### 交互式匹配（推荐）

1. 点击导航栏右侧的链接图标，打开匹配面板
2. 点击「开始扫描」，等待扫描完成
3. 在「自动匹配」标签页查看 high 置信度匹配
4. 在「待审核」标签页审核 medium 置信度匹配，可单独应用或忽略
5. 在「未匹配」标签页为多演员场景手动选择本地演员
6. 点击「应用全部」批量应用所有 high 置信度匹配，或逐条点击「应用」按钮

### 批量任务

在 **Stash → 设置 → 插件 → 插件任务** 中：

1. 运行 **Batch Scan** — 扫描所有含 JAVStash ID 的场景
2. 运行 **Apply High-Confidence Matches** — 自动应用高置信度匹配

## 技术细节

- **番号提取**：优先读取场景 `code` 字段（工作室代码），为空时从标题前缀提取（`番号 标题...` 格式）
- **名称归一化**：NFC 统一 + 括号消歧义后缀去除 + 大小写归一化
- **别名写入**：直接传数组给 GraphQL `alias_list` 字段，兼容数组/字符串读取
- **增量扫描**：分页查询（每页 1000 条），跳过所有演员均已匹配的场景
- **防重复写入**：同会话内已应用的演员记录在 `_appliedPerformers`，不重复处理
- **导航栏注入**：DOM 注入到 `.navbar-buttons` 按钮区，MutationObserver + history hook 确保 SPA 路由后不丢失
- **CSP 白名单**：yml 中声明 `javstash.org` + `stashdb.org` 的 `connect-src`

## License

MIT
