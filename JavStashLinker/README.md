# JavStashLinker

> v1.2.0：新增「手动搜索」— 列出全部未绑定 JAVStash 的演员，逐词搜索命中高可信度即停止，「更多」展开全部候选；多信号证据规则（StashDB 交叉 / URL 交集 / 多名称一致 / 生日比对）；含 v1.1.3 扫描 0 结果反馈修复

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

### 方式三：手动搜索（单个演员）

适合场景扫描覆盖不到的演员（无 JAVStash 场景 ID、或库中尚无对应场景）：

1. 打开面板，切到 **手动搜索** 标签页 — 自动列出所有未绑定 JAVStash ID 的本地演员（顶部可按名称/别名实时筛选）
2. 点击演员行右侧 **搜索** — 用该演员的主名+全部别名（去重后最多 15 个词）逐词调 JAVStash `searchPerformer`（4 req/s 限流）
3. **命中高可信度即停止搜索**：组框向下展开，只显示 high 候选，卡片显示证据明细（命中票数、生日/身高对比 ✓/△/✗、URL 交集、StashDB 交叉）
4. 点击 **应用** → 写入 stash_id + 别名 + URL 合并（与场景扫描应用同一条路径，只追加不覆盖）；应用后按钮显示 **已应用**，组框收缩
5. 点击 **更多**（应用按钮右侧，或「未找到高可信度候选」提示行右侧）：继续搜索剩余词 — **高可信度结果保持置顶可见、可随时应用**，进度行追加在下方；搜完后追加全部 medium / 手动确认候选（靠 high/medium 徽章颜色区分）
6. 状态行右侧 **▲** 可收起该组搜索结果，恢复搜索前状态；未找到高可信度时显示简短提示（JAVStash 未返回任何候选时仅显示状态行）
7. **忽略**（搜索按钮右侧）：本轮将该演员从列表中排除，关闭面板后重置

#### 手动搜索置信度规则

| 条件 | 置信度 | 说明 |
|------|--------|------|
| StashDB UUID 相等 | high | 本地 stashdb stash_id = JAVStash 演员 URLs 中的 stashdb.org/performers/<uuid>（硬证据） |
| URL 交集 ≥2 | high | 本地与 JAVStash 有 ≥2 条相同链接；单条可能是工作室网站，不作证据 |
| 名称精确命中 ≥3 票 | high | 本地主名/别名与 JAVStash 名称/别名 NFC 归一化后精确相等 |
| 仅 2 个名称且全命中 | high | 需至少 1 个名称归一化后 ≥3 字符（防 'Ai'/'An' 类共享短名撞车，否则 medium） |
| 名称命中 + 生日完整相等 | high | 1993-08-16 完整日期相等 |
| 名称命中 + 仅生日年份相等 | medium | AV 数据源生日常有 ±1 年误差 |
| ≥3 个名称中命中 2 票 | medium | |
| JAVStash 演员已删除 | 上限 medium | 已删除的 stash-box 演员通常已被合并 |

说明：JAVStash `searchPerformer` 为模糊搜索（每词最多 10 条），"出现在搜索结果中"不算匹配，必须名称归一化后精确相等才计票。

## 应用效果

每个成功应用的匹配会：

1. 在本地演员的 `stash_ids` 中添加 `{endpoint: "https://javstash.org/graphql", stash_id: "javstash演员ID"}`（已有 JAVStash ID 则跳过）
2. 将 JAVStash 演员名添加到本地演员的 `aliases`（如不存在）
3. 将 JAVStash 演员的所有别名添加到本地演员的 `aliases`（如不存在）
4. 将 JAVStash 演员的所有链接（URLs）追加到本地演员的 `urls`（去重合并，已有链接保留，无新增时不提交该字段）
5. **不修改**本地演员的现有名字

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
