# JavStashLinker

> v1.1.0：性能优化 — 并发扫描(4 req/s) + 渲染节流 + 分块加载 + 缓存apply数据，支持1000+场景无卡顿

Stash 插件：通过场景反推批量获取演员的 JAVStash ID。

## 匹配逻辑

从已有 JAVStash 场景 ID 的本地场景出发，查询 JAVStash 获取场景演员列表，再按以下优先级匹配到本地演员：

| 优先级 | 方法 | 置信度 | 说明 |
|--------|------|--------|------|
| 1 | stashdb_id 精确匹配 | high | JAVStash 演员有 stashdb stash_id，与本地演员的 stashdb stash_id 精确匹配 |
| 2 | 单演员场景自动关联 | high | 本地和 JAVStash 场景各只有 1 个未匹配演员，直接对应 |
| 3 | 名字/别名交叉匹配 | medium | JAVStash 演员名/别名 与 本地演员名/别名 交叉匹配（NFC 归一化） |
| 4 | 手动选择 | — | 多演员场景未命中，在 UI 中手动下拉选择 |

**已跳过**：本地演员已有 JAVStash stash_id 的不会重复处理。

## 安装

1. 将整个 `javstash_performer_matcher` 文件夹复制到 Stash 插件目录（通常为 `~/.stash/plugins/` 或 Stash 数据目录下的 `plugins/`）
2. 重启 Stash
3. 进入 **设置 → 插件**，在插件设置中填入 JAVStash API Key（从 javstash.org 账号设置页获取）

## 使用方法

### 方式一：交互式 UI（推荐）

1. 在 Stash 导航栏点击 **JAVStash Matcher** 按钮打开面板
2. 确认 JAVStash API Key 已填入
3. 点击 **开始扫描** 开始扫描
4. 查看扫描结果：
   - **自动匹配**：高置信度匹配（stashdb_id 或单演员），可直接应用
   - **待审核**：中置信度匹配（名字/别名），确认后应用
   - **未匹配**：未匹配的 JAVStash 演员，手动选择对应的本地演员
5. 在未匹配标签页中，为每个演员下拉选择本地演员
6. 点击 **应用匹配** 应用所有匹配
7. 应用后，本地演员将获得 JAVStash stash_id，JAVStash 演员名和别名会写入别名列表

### 方式二：批量任务（无 UI）

在 **设置 → 任务** 中运行：

- **Batch Scan**：扫描所有有 JAVStash ID 的场景，输出匹配结果到 `match_results.json`
- **Apply High-Confidence Matches**：应用高置信度匹配（仅 stashdb_id 和单演员匹配）

## 应用效果

每个成功应用的匹配会：

1. 在本地演员的 `stash_ids` 中添加 `{endpoint: "https://javstash.org/graphql", stash_id: "javstash演员ID"}`
2. 将 JAVStash 演员名添加到本地演员的 `aliases`（如不存在）
3. 将 JAVStash 演员的所有别名添加到本地演员的 `aliases`（如不存在）
4. **不修改**本地演员的现有名字

## 文件说明

| 文件 | 说明 |
|------|------|
| `javstash_performer_matcher.yml` | 插件定义文件（`interface: raw`，`{pluginDir}` 路径） |
| `javstash_performer_matcher.py` | Python 批量任务脚本（StashInterface + Stash 日志协议） |
| `javstash_performer_matcher.js` | 交互式 UI（DOM 注入 + MutationObserver + i18n bridge） |
| `javstash_performer_matcher.css` | 独立样式表（`jsm-` 前缀，`!important` 覆盖） |
| `match_results.json` | 批量扫描结果（运行后生成） |

## 技术细节

### JS 架构

- **幂等保护**：`window.__jsmLoaded` 防止重复加载
- **i18n bridge**：通过 `PluginApi.patch.before("App")` 注入 IntlProvider，支持中英文
- **DOM 注入**：导航栏按钮 + 全屏面板，不依赖 React 组件注册
- **MutationObserver**：监听 `.main-content` DOM 变化，确保 SPA 导航后按钮存在
- **History 劫持**：`pushState` / `replaceState` 包装，响应路由切换
- **PluginApi.patch.after**：Hook `SettingsToolsPanel` 等组件，辅助注入时机

### Python 架构

- **StashInterface 类**：封装 GraphQL 通信，提取 server_connection 参数
- **GraphQLClient**：`requests` 库 + 指数退避重试，401 致命退出
- **Stash 日志协议**：`\x01<level>\x02` 前缀（t/d/i/w/e/p），支持 Progress 条
- **匹配引擎**：纯函数 `match_scene()`，四级优先级匹配

### CSS 约定

- **前缀**：所有类名使用 `jsm-` 前缀
- **`!important`**：全面覆盖 Stash 内置样式
- **暗色主题**：`#1a1a1a` / `#2b2b2b` 背景，`#e0e0e0` 文字
- **色彩语义**：蓝色=操作，绿色=成功，红色=错误，黄色=警告
- **响应式**：640px 断点，移动端竖排卡片

## 依赖

- Python 3.6+ + `requests` 库
- Stash 最新版
- JAVStash API Key

## 注意事项

- 扫描时以 0.3 秒间隔请求 JAVStash API，避免触发限流
- 已有 JAVStash stash_id 的演员会被跳过
- 名字匹配使用 NFC 归一化 + 去空格 + 小写，不做模糊匹配
- `Apply` 操作会弹出确认对话框，显示待应用的匹配数量
- 建议先扫描查看结果，确认无误后再应用
