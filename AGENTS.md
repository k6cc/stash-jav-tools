# AGENTS.md

本仓库是 Stash 插件集合（monorepo）：`sceneTranslate` / `sceneGallerySync` / `studioTools` / `JavStashLinker` / `performerMerge` / `tagMerge` 六个插件 + 根 `README.md` 版本表。插件版本由各 `<name>.yml` 的 `version:` 声明，Stash 实际读取该字段；发版时**所有版本号位置必须同步**，否则会漂移。

## 发版清单（六插件通用）

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致。通用同步项：

- 根 `README.md` 版本表（含全部六插件，发版必须同步）
- 各插件 `README.md` 头部 `> vX.Y.Z：` note，**只保留最新一条**
- 各插件 `yml` 的 `url:` 指向 Discourse 论坛帖，发布时确认链接正确

插件差异：

| 插件 | 代码内版本位置 | README 约定差异 |
|---|---|---|
| sceneTranslate | `translateProxy.py` 头部 banner（`Scene Translate Proxy vX.Y.Z`） | — |
| sceneGallerySync | — | 头部无 note；文末「## 变更历史」新增 `### X.Y.Z` 条目 |
| studioTools | — | — |
| JavStashLinker / performerMerge / tagMerge | 对应 `.js` 顶部 `PLUGIN_VERSION`（面板标题右侧显示） | — |

## 发版流程（git）

1. 更新上表所有位置（含根 `README.md` 版本表）
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件名>-vX.Y.Z`（如 `sceneTranslate-v2.9.2`）；多插件联动发版时每个插件各打一个 tag
5. `git push && git push --tags`
6. Windows：git 提示 LF→CRLF 属正常，不影响内容；PowerShell 不支持 heredoc，commit 用 `-m "..."` 即可

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

同级按钮（含 badge、图标按钮）**必须等高**，混排不齐即为 bug；层级差异只体现在尺寸，不体现在语义。

硬性规则：

- **可点击元素必须实心**；透明框元素**禁止**绑定点击事件、hover 变色和指针光标
- 同一行混排的小按钮/badge/图标按钮用 `inline-flex` + `align-items: center` + `line-height: 1` + `border-box` 保持等高
- badge/按钮加 `flex-shrink: 0`，文本区加 `min-width: 0` + 省略号，防窄屏压缩变形
- 状态展示用透明框状态样式，不用 disabled 实心按钮充当状态提示；disabled 仅用于短暂禁用（如搜索中按钮可例外显示为透明框状态样式）

### 状态切换按钮（筛选/开关类，如「冲突项」）

点击进入/退出某个筛选或模式，按钮承载开关两态，反馈必须是**切换态的持续显示**，不是按压瞬时反馈。

- **文案两态相同**：不用前缀符号（● 等）区分状态，状态信息全部由视觉承载
- **关闭态**：普通警告语义实心按钮（主题警告色，黄系），与同排按钮一致
- **激活态**（持续显示至退出）：背景比关闭态暗一档、文字降为浅灰；内圈底部一条纯白指示条——贴底边、左右内缩避开圆角与文字、加粗（约 3px）、两端圆角（可按主题微调）；hover 保持激活暗色不变，禁止弹回亮色 hover（会被误读为已退出）
- **禁止用 `:active` 按压反馈代替切换反馈**：按压松手即消失，表达不了持续状态
- **显隐跟随数据**：无可筛内容时整个按钮不渲染，而非 disabled 置灰

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

## 其他

- `.gitignore` 已忽略 `__pycache__` 与备份文件，不要提交
- 本文件是 agent 协作约定，不随插件版本发布
