# AGENTS.md

本仓库是 Stash 插件集合（monorepo）：`sceneTranslate` / `sceneGallerySync` / `studioTools` / `JavStashLinker` / `performerMerge` / `tagMerge` / `studioToolsBackend` / `tagMergeBackend` 八个插件 + 根 `README.md` 版本表。插件版本由各 `<name>.yml` 的 `version:` 声明，Stash 实际读取该字段。

## 发版清单（插件通用）

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致。通用同步项：

- 根 `README.md` 版本表（含全部八插件，发版必须同步）
- 各插件 `README.md` 头部 `> vX.Y.Z：` note，**只保留最新一条**
- 各插件 `yml` 的 `url:` 指向 Discourse 论坛帖，发布时确认链接正确
- **tagMergeBackend 的 `tag_merge_map.json` 与 tagMerge 保持同源同步**（复制自 tagMerge 目录，任一侧更新后必须同步另一份）

插件差异：

| 插件 | 代码内版本位置 | README 约定差异 |
|---|---|---|
| sceneTranslate | `translateProxy.py` 头部 banner（`Scene Translate Proxy vX.Y.Z`） | — |
| sceneGallerySync | — | 头部无 note；文末「## 变更历史」新增 `### X.Y.Z` 条目 |
| studioTools | — | — |
| JavStashLinker / performerMerge / tagMerge | 对应 `.js` 顶部 `PLUGIN_VERSION`（面板标题右侧显示） | — |
| studioToolsBackend / tagMergeBackend | `studioToolsBackend.py` / `tagMergeBackend.py` 头部 docstring banner（`... Backend vX.Y.Z`） | 头部有 note；tagMergeBackend 另需同步 `tag_merge_map.json`（见上） |

## 发版流程（git）

1. 更新上表所有位置（含根 `README.md` 版本表）
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件名>-vX.Y.Z`（如 `sceneTranslate-v2.9.2`）；多插件联动发版时每个插件各打一个 tag
5. `git push; git push --tags`（分号分隔，勿用 `&&`）
6. 验证发版完成：`gh run list --limit 1` 找到 Release workflow → `gh run watch <id> --exit-status` 等待成功；`gh release view <tag> --json assets` 确认 zip 产物存在；`git status` 确认工作区干净
7. Windows：git 提示 LF→CRLF 属正常，不影响内容；PowerShell 5.1 不支持 heredoc 与 `&&`/`||` 语句分隔符，commit 用 `-m "..."`、命令链用 `;`；**沙箱内 `git push` 会因 schannel TLS 握手失败被拦**（`fatal: unable to access ... schannel: failed to receive handshake`）——push/tag 推送需在沙箱外执行（`dangerouslyDisableSandbox`），commit/add 等本地操作不受影响

## 新插件首发流程（仅首次发布，已踩坑）

新插件 = 仓库中尚不存在其发布条目的插件（如首次上线的 backend）。除走完「发版流程」外，首发必须多做三步，且**顺序不可颠倒**（依据 tagMergeBackend / studioToolsBackend 首发实况）：

1. **release.yml 白名单**：`.github/workflows/release.yml` 的 `on.push.tags` 必须新增 `"<插件>-v*.*.*"` 模式——缺失时打 tag 不会触发任何构建，`gh run list` 永远为空，且已推送的 tag 不会补触发（需删远程 tag 重打重推：`git push origin :refs/tags/<tag>` + `git tag -d <tag>` + 重打 + `git push origin main --tags`）
2. **stash-plugins 占位符（必须先推送到远程）**：本地 clone `E:\Temp\stash-plugins`（远程 `k6cc/stash-plugins`）常落后，先 `git fetch; git reset --hard origin/main`；在 `plugins/main/index.yml` 末尾追加占位条目（`version: 0.0.0`、`sha256:` 全 0、`path:` 按 release URL 约定 `https://github.com/k6cc/stash-jav-tools/releases/download/<插件>-v0.0.0/<插件>-v0.0.0.zip`、`date:` 当前时间）；`README.md` 插件表与依赖清单**手动加行**（`scripts/sync_readme.py` 只更新已有行、不插入新行）；commit 后**必须 push**——release workflow 是 clone 远程版再 awk 更新，占位符不在远程则 awk 找不到 `- id:` 静默跳过、链接推不上（tagMerge 曾长期停留在全 0 sha256 占位）
3. **运行时日志勿提交**：`.gitignore` 已有 `*_backend.log` 规则，新插件若带日志文件先确认被忽略，误提交后 `git rm --cached <log>` 补救

其余顺序与常规发版一致：yml `url:` 用真实 Discourse 帖链接（用户先发帖）→ 插件目录 commit/push → 打 tag → 验证。**闭环验证**：`gh run watch` 成功后回 stash-plugins 执行 `git fetch; git show origin/main:plugins/main/index.yml`，确认该插件条目 `version`/`sha256` 已被真实值覆盖（占位符机制生效），再确认两仓库 `git status` 干净。

## 文件编辑（agent 工作约定）

- **同一文件的多处修改一律串行执行**：等上一次编辑落盘完成后再发起下一次；只有不同文件的修改可以并行。原因：并行的每次编辑基于各自快照应用差异后整体写回，后完成者覆盖先完成者，同批只有最后落盘的一处存活（tagMerge.js 曾多次复现修改静默丢失）
- 多处修改完成后用 `rg` 逐点核对关键改动确已在盘，再报完成

## UI 交互设计规范（全部带 UI 的插件通用）

**色彩与尺寸不绑定具体值**：各插件有自己的主题色（JavStashLinker 蓝、performerMerge 紫等），按钮取色跟随插件主题——主操作用主题色、忽略/中性灰、警告黄、删除/关闭红。本规范约束**交互语义和层级关系**，不是具体色号和像素。

### 按钮语义（与主题无关，必须遵守）

**实心按钮 = 可点击/交互；透明框（边框+半透明底）= 状态/提示，无指针光标、无 hover 变色。**

| 语义角色 | 用色逻辑 | 示例 |
|---|---|---|
| 主操作 | 插件主题色，hover 加深 | 搜索、更多、恢复 |
| 确认执行 | 主题色或强调色（如绿），hover 加深 | 应用、保存、执行合并 |
| 中性辅助 | 灰系实心，hover 微亮 | 忽略、▲ 收起 |
| 危险/关闭 | 红系，或灰底 hover 变红 | 删除、× 关闭 |
| 状态展示 | 透明框 + 同色边框 + 半透明底（badge / `*-btn-state`），`cursor: default` | 已应用、high/medium、已忽略、搜索中... |
| 暗淡提示 | 小字号灰系 | 状态行、计数、证据明细 |

### 按钮尺寸层级（三级，像素可按主题调整）

| 层级 | 用途 | 参考尺寸（jsm/pdm 现行值） |
|---|---|---|
| 大（主按钮） | 面板级唯一/主导操作：开始扫描、应用全部 | padding 6×16，字号 13 |
| 中（动作按钮） | 常规整行操作：打开面板、单卡片主操作 | 介于两者之间 |
| 小（行内/组按钮） | 卡片行内密集操作：应用、忽略、更多、▲ | padding 3×10，字号 11，定高 22px |

层级差异只体现在尺寸，不体现在语义。

硬性规则：

- 同级按钮（含 badge、图标按钮）**必须等高**，混排不齐即为 bug
- **可点击元素必须实心**；透明框元素**禁止**绑定点击事件、hover 变色和指针光标
- 同一行混排的小按钮/badge/图标按钮用 `inline-flex` + `align-items: center` + `line-height: 1` + `border-box` + 固定高度（小号 22px）保持等高；**等高基座声明在小号类上**（如 `.tgm-btn-sm` + `.tgm-badge`），大按钮（面板级主操作：合并全部/开始扫描/添加/导出文件等）保持自然高度、不强制盒模型 — 等高盒模型混排只发生在小号元素之间，禁止把 `line-height: 1`/定高上移到大按钮基类（会压缩大按钮高度，已复现）
- **禁止用垂直 margin 微调徽章/按钮的垂直位置**（`margin-top: 2px` 式"视觉补偿"会造成整组元素相对徽章下沉，已两次复现）；垂直对齐只靠容器 `align-items: center` 与等高盒模型解决
- badge/按钮加 `flex-shrink: 0`，文本区加 `min-width: 0` + 省略号，防窄屏压缩变形
- 状态展示用透明框状态样式，不用 disabled 实心按钮充当状态提示；disabled 仅用于短暂禁用（如搜索中按钮可例外显示为透明框状态样式）

### 状态切换按钮（筛选/开关类，如「冲突项」）

点击进入/退出某个筛选或模式，按钮承载开关两态，反馈必须是**切换态的持续显示**，不是按压瞬时反馈。

- **文案两态相同**：不用前缀符号（● 等）区分状态，状态信息全部由视觉承载
- **关闭态**：普通警告语义实心按钮（主题警告色，黄系），与同排按钮一致
- **激活态**（持续显示至退出）：背景比关闭态暗一档、文字降为浅灰；内圈底部一条纯白指示条——贴底边、左右内缩避开圆角与文字、加粗（约 3px）、两端圆角（可按主题微调）；hover 保持激活暗色不变，禁止弹回亮色 hover（会被误读为已退出）
- **禁止用 `:active` 按压反馈代替切换反馈**：按压松手即消失，表达不了持续状态
- **显隐跟随数据（仅意外触发的模式）**：模式由数据状态意外产生、用户未主动进入（如冲突检测、低可信度）→ 无可筛内容时整个按钮不渲染，而非 disabled 置灰；模式由用户手动操作触发（如忽略条目后的「已忽略」筛选）→ 按钮常驻显示，入口始终可发现、可退出

### 列表筛选搜索框（长列表分页/面板应有）

**适用**：只能手动浏览编辑的分页（列表项 > 20 或需滚动才能看完）应提供搜索/筛选框；短列表、按序浏览有意义的场景可豁免。JavStashLinker 手动搜索页、performerMerge 分组列表均属此类。

**交互行为：**

- **即时过滤**：`oninput` 立即筛选，**不防抖、不等回车**；在名称和别名上做大小写不敏感的包含匹配
- **IME 兜底**：`oninput` 中 `e.isComposing` 为 true 时跳过（组字期间不重渲染，防打断候选框），并监听 `compositionend` 做最终提交——部分输入法选字完成后不触发带最终值的 input 事件，只靠 oninput 会漏
- **焦点与光标保持**：渲染前记录 `selectionStart`，渲染后 `focus()` + `setSelectionRange`，否则每敲一个字符光标跳回末尾/丢焦
- **重渲染最小化**：列表分块渲染（IntersectionObserver 按块追加），避免每次输入全量重建 DOM

**清除按钮（输入框内嵌）：**

- 显隐实现**跟随渲染架构**：全量重渲染插件（如 JavStashLinker）用**条件渲染**——有内容才 append 进 DOM，随重渲染自然出现/消失；局部渲染插件（如 tagMerge 工具栏刻意不重建以保焦点）用 **`hidden` 属性切换**——按钮常驻 DOM，`clearBtn.hidden = !value` 控制显隐。两种方式观感相同，选错架构才会出问题
- 绝对定位在输入框右侧内部（`position: absolute; right` + 父容器 `position: relative`），输入框 `padding-right` 预留按钮空间
- 样式：实心灰（中性可点击语义）、hover 变红（清除=危险暗示）、22px 定高（与图标按钮统一）；点击后清空筛选并把焦点还给输入框

**计数反馈**：筛选时显示「匹配 N / 总数 M」暗淡文字，无筛选时显示「全部 N 个」；有关联排除项（已忽略等）时追加「（已忽略 X 个）」

### 幂等守卫（所有 UI 插件入口必须）

插件 script 可能被 Stash 重复执行，入口必须带全局幂等守卫，防止双重初始化（面板重复注入、监听器翻倍）：

```js
if (window.__<插件缩写>Loaded) return;
window.__<插件缩写>Loaded = true;
```

现有插件缩写：jsm（JavStashLinker）/ pdm（performerMerge）/ tgm（tagMerge）。动态注入的子机制（如 Refract 主题 tile）用独立标志位（`__<缩写>RefractTileInit`）。

### 极窄屏适配（所有 UI 插件必须兼容）

目标：**≤480px 完全可用**（元素不溢出、关键操作不隐藏），640px 为优化断点，触屏设备同样可用。

- flex/grid 子项容器必须加 `min-width: 0`，防长文本撑破布局
- 长名称/长列表用 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 截断，完整内容放 `title` 提示
- 关键操作按钮（应用/删除/关闭等）加 `flex-shrink: 0`，任何情况下不被压缩或挤出屏幕
- ≤640px：卡片容器 `flex-wrap: wrap`，信息占满首行；badge 与操作按钮组换行到信息下方**右侧**（`justify-content: flex-end`）；提示文字/状态行保持靠左
- 面板/滚动容器加 `scrollbar-gutter: stable` 防滚动条出现/消失引起布局抖动；弹窗类 UI 把滚动放在**面板内部**（`max-height` + `overflow-y: auto`），外层容器不滚动，避免外层滚动条/gutter 占位导致面板右侧留空
- 弹窗/面板 ≤480px 两侧铺满：外层容器 padding 清零、面板圆角取消、`max-height: 100vh`（与 640px 断点分开：640 换行、480 铺满）
- 弹窗内容低于屏幕高度时上下居中：面板用 `margin: auto 0`（而非 `align-items: center`，后者内容超高时顶部溢出无法滚回）；超出时自动退化为顶对齐
- 触屏设备或 ≤640px：仅装饰性交互（拖拽把手、标签清除 ×）可隐藏，功能按钮一律保留
- 表格类数据（如合并对照表）窄屏改用横向滚动或堆叠布局，不用缩字号硬塞

### 多语言（i18n，所有带 UI 的插件通用）

**双语言中文/英文**，跟随 Stash 界面语言，不引入第三方语言与翻译文件。JavStashLinker / performerMerge / tagMerge 共用同一实现，新插件照抄：

- **调用约定**：模块级 `tc(zh, en)`，`_intlLocale` 以 `zh` 开头返回中文，否则英文。**所有用户可见字符串必须包 `tc()` 且两个参数都写**：按钮文案、标题、tooltip（`title` 属性）、`alert`/`confirm` 弹窗、badge、placeholder、日志条目、空态提示
- **语言来源**：`initIntlBridge()` 通过 `PluginApi` 挂 React 组件读 `api.libraries.Intl.useIntl().locale` 同步到 `_intlLocale`；桥接失败（PluginApi 不可用/异常）静默降级英文——不抛错阻塞插件加载
- **动态文案**：拼接变量写法 `tc("已合并 " + n + " 个", "Merged " + n)`，两种语言各自完整组句，不抽词根
- **不翻译**：数据值（tag/演员/工作室名）、GraphQL 语句、`console.log`（前缀用 `[jsm]`/`[pdm]`/`[tgm]` 等插件缩写）、CSS 类名、localStorage 键
- **弹窗与确认框**：`confirm()` 用于破坏性/批量操作前置确认，文案双语且含关键数字（组数/源数/将发生什么）；`alert()` 仅用于错误与不可继续的提示；操作结果优先走面板内状态行（分色），不用弹窗
- **确认框文案只写操作对象与简洁警告，不写机制描述**：操作按钮的确认信息仅保留「对什么对象做什么 + 破坏性后果/冲突警示」（如 `将 2 个演员合并到「X」？源演员将被删除。`、`拆分「Y」的 3 条单行合并别名？`）；拆分/删除/合并的具体规则（按什么分隔符、丢弃什么、去重方式、字段如何合并）属于机制描述，放按钮 `title` 悬浮提示与 README；完成后界面如何变化、是否自动重扫等交互过程描述只放 README（见下条）
- **按钮 `title` 不写交互过程描述**：操作完成后界面如何变化（`完成后卡片收缩变灰`、`卡片收缩成一行`、`折叠该组`、`不自动重新扫描` 等）不属于按钮悬浮提示的内容——用户执行前不需要知道界面反馈细节，执行后自然看到；`title` 只写「操作影响什么数据」（如 `仅删除别名条目`、`忽略该短名`），能从按钮文案看懂的就不加 title

## 论坛介绍文章（forum-post-*.md）

插件功能多次迭代后，Discourse 论坛帖内容可能滞后。更新论坛介绍时，在仓库根目录写 `forum-post-<插件名小写>.md`（如 `forum-post-javstashlinker.md`），已被 `.gitignore` 排除、不随仓库发布，用户手动粘贴到论坛。

写作规则（极简优先，读者是论坛用户不是开发者；篇幅与详略以 `forum-post-javstashlinker.md` / `forum-post-performermerge.md` 为基准，超出即视为写复杂了）：

- **只写**：插件定位（解决什么问题）、各功能模块一句话职责、核心机制表（匹配优先级/置信度规则，每行一句话）、安装方式、依赖、配套插件；每个模块小节正文 ≤ 3 句（表格/条目另计）
- **Summary 表一句定位**：主操作 + 纯 UI 声明，不加机制枚举括号（证据分级链条等正文有表）、不加行为尾注（引用转移/源删除/仅追加）
- **禁举例**：规则直接写规则本身，名字/别名/变体/损坏串/大小写对比式的示例一律不写
- **禁入口总述与 UI 状态**：不写「图标打开面板有哪些标签页」入口总述（模块名由小节标题承载）、hover 提示内容、徽章数据清单、折叠/忽略的交互逻辑
- **禁字段级枚举**：合并/写入行为只留方向性一句（如「名字/图片始终保留目标」），不逐字段列规则（stash_id/URL/标签/收藏…），不写 append-only/空值保护细节
- **禁操作与提交细节**：逐条提交方式、失败跳过、批量跳过、完成后重扫时机均不写
- **禁后果推导与实现注脚**：规则后不追加「会导致什么」（匹配不到/漏报/误报来源等推导）；不写「与官方对话框同一 mutation」式说明、算法步骤链（分隔符→trim→去重）；模块定位性动机（Hi stashers 开场、模块首句问题引入）除外
- **兜底不写**：其余 UI 交互细节（按钮行为/折叠展开/开关位置/颜色尺寸）、底层实现（架构/i18n/observer/CSP）、功能开发逻辑——这些属于 README 的内容
- **注意事项归拢一处**：条目化，每条一句话，不展开「因为什么/会造成什么」
- 语言英文，保留原帖框架（Summary 表 + Hi stashers 开头 + 章节结构）与语气；只剩一层小节时总述标题（如「What it does」）可省；截图过时则移除占位，发帖时现截现传

## 其他

- `.gitignore` 已忽略 `__pycache__`、备份文件与论坛文章草稿（`forum-post-*.md`），不要提交
- 本文件是 agent 协作约定，不随插件版本发布
