# JavStashLinker

> v1.4.0：所有应用路径（单条应用、「应用全部」、手动搜索、Python 批量任务）新增**后台自动补图 + 演员信息补全** — 本地演员无自定义图片时补入 JAVStash 图片 URL（Stash 服务端下载，不占浏览器 CSP/无需 base64）；性别/生日/卒日/国家/人种/发色/瞳色/身高/三围/生涯/纹身/穿孔按「已有不覆盖」原则补齐，别名和 URL 增量添加；批量走独立限流队列（2 并发/300ms 间隔）；链接中的 StashDB / ThePornDB 演员链接（UUID 格式）转为对应端点的 stash_id 而非写入 urls（ThePornDB slug 格式链接无法经其 API 解析，忽略不进 urls）；同时修正 README 安装说明（API Key 经「元数据提供者」stash-box 配置自动复用，插件自身无设置项）
>
> v1.3.1：按钮悬浮提示文案按新规范精简 — title 只写操作影响的数据（`忽略该演员`、`仅应用 high 置信度`），会话级作用域等机制描述去冗，机制细节见 README
>
> v1.3.0：适配 Refract 主题移动端导航 — 按钮自动镜像进移动端抽屉（更多选项），并可在 Settings → Interface → Refract → Mobile dock 中固定到底部 dock；含 v1.2.3 源链接更新

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

1. 将整个 `JavStashLinker` 文件夹复制到 Stash 插件目录（通常为 `~/.stash/plugins/` 或 Stash 数据目录下的 `plugins/`）
2. 重启 Stash
3. 在 **设置 → 元数据提供者 → Stash-box 端点** 中添加 JAVStash 实例（端点 `https://javstash.org/graphql` + API Key，从 javstash.org 账号设置页获取）— 插件自动复用该配置，自身无任何设置项；未配置时扫描/搜索会弹窗提示

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

- **Batch Scan**：扫描所有有 JAVStash ID 的场景，输出匹配结果到 `match_results.json`（含演员详情/链接，供 Apply 使用）
- **Apply High-Confidence Matches**：应用高置信度匹配（仅 stashdb_id 和单演员匹配），与 UI 应用同规则 — 补全空白信息字段、跨站链接转 stash_id；需先（重新）运行 Batch Scan 以缓存演员详情，旧版扫描结果无详情数据则跳过补全

### 方式三：手动搜索（单个演员）

适合场景扫描覆盖不到的演员（无 JAVStash 场景 ID、或库中尚无对应场景）：

1. 打开面板，切到 **手动搜索** 标签页 — 自动列出所有未绑定 JAVStash ID 的本地演员（顶部可按名称/别名实时筛选）
2. 点击演员行右侧 **搜索** — 用该演员的主名+全部别名（去重后最多 15 个词）逐词调 JAVStash `searchPerformer`（4 req/s 限流）
3. **命中高可信度即停止搜索**：组框向下展开，只显示 high 候选，卡片显示证据明细（命中票数、生日/身高对比 ✓/△/✗、URL 交集、StashDB 交叉）
4. 点击 **应用** → 写入 stash_id + 别名 + URL 合并（与场景扫描应用同一条路径，只追加不覆盖）；**本地演员无自定义图片时后台自动补入图片，空白信息字段（性别/生日/国家/人种等）按「已有不覆盖」补齐**（见下方「应用效果」第 6、7 条）；应用后按钮显示 **已应用**，组框收缩
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
4. 将 JAVStash 演员的链接（URLs）追加到本地演员的 `urls`（去重合并，已有链接保留，无新增时不提交该字段；`stashdb.org` / `theporndb.net` 演员链接除外 — 见第 8 条）
5. **不修改**本地演员的现有名字
6. **后台补图**（所有应用路径：单条应用、「应用全部」、手动搜索）：本地演员无自定义图片（`image_path` 含 `default=true`）时，取 JAVStash 演员的第一张图片 URL 交给 `performerUpdate` 的 `image` 字段 — Stash 服务端自行下载（60s 超时，经 Referer/UA 头），不占浏览器 CSP、无需前端 base64，UI 不等待下载完成；补图经独立限流队列（2 并发/300ms 间隔）执行，失败仅记日志，不影响匹配结果。已有图片则跳过
7. **演员信息补全**（所有应用路径，与主更新同一 mutation）：性别、生日、卒日、国家（ISO 码）、人种、发色、瞳色、身高、三围（拼为 `34C-26-36` 式）、生涯（`2009` / `2009 - 2015`）、纹身/穿孔（`位置: 描述` 多条以 `; ` 连接）— 逐字段「本地已有值则跳过」，从不覆盖；枚举转显示字符串（如 `CAUCASIAN`→`Caucasian`、`MIDDLE_EASTERN`→`Middle Eastern`）；补了哪些字段记入日志
8. **跨站链接转 stash_id**（所有应用路径）：JAVStash 演员链接中的 `stashdb.org/performers/<uuid>` 和 `theporndb.net/performers/<uuid>`（UUID 格式）不写入 urls，本地演员无对应端点 stash_id 时直接转为该端点的 stash_id；`theporndb.net/performers/<slug>`（slug 格式，如 `arata-arina`）因 ThePornDB 的 stash_id 是 UUID、slug 无法经其 API 解析，忽略不写入 urls；已有对应端点 stash_id 的不重复添加。仅匹配主机名恰为这两站（含 `www.` 变体）的链接 — 嵌在查询参数、路径中或仿冒域名里的子串不会误命中，照常并入 urls

## 文件说明

| 文件 | 说明 |
|------|------|
| `JavStashLinker.yml` | 插件定义文件（`interface: raw`，`{pluginDir}` 路径） |
| `JavStashLinker.py` | Python 批量任务脚本（StashInterface + Stash 日志协议） |
| `JavStashLinker.js` | 交互式 UI（DOM 注入 + MutationObserver + i18n bridge） |
| `JavStashLinker.css` | 独立样式表（`jsm-` 前缀，`!important` 覆盖） |
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
- JAVStash stash-box 端点（含 API Key，在 **设置 → 元数据提供者** 中配置）

## 注意事项

- 扫描时以 0.3 秒间隔请求 JAVStash API，避免触发限流
- 已有 JAVStash stash_id 的演员会被跳过
- 名字匹配使用 NFC 归一化 + 去空格 + 小写，不做模糊匹配
- `Apply` 操作会弹出确认对话框，显示待应用的匹配数量
- 建议先扫描查看结果，确认无误后再应用
