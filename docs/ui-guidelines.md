# UI 交互设计规范（带 UI 的插件通用）

> **读这文件的时机**：改任何带 UI 的插件 `.js`（JavStashLinker / performerMerge / tagMerge / 未来新 UI 插件）前必读。纯后台 Python 插件（studioToolsAuto / tagMergeAuto / sceneTranslateAuto）不适用。
> 本规范从根 `AGENTS.md` 拆出，与 `AGENTS.md` 其他节无重复。

**语义不绑定色值**：各插件有自己的主题色（JavStashLinker 蓝、performerMerge 紫等），按钮取色跟随插件主题——主操作用主题色、忽略/中性灰、警告黄、删除/关闭红。本规范约束**交互语义和层级关系**，不是具体色号和像素。

## 按钮语义（与主题无关，必须遵守）

**实心按钮 = 可点击/交互；透明框（边框+半透明底）= 状态/提示，无指针光标、无 hover 变色。**

| 语义角色 | 用色逻辑 | 示例 |
|---|---|---|
| 主操作 | 插件主题色，hover 加深 | 搜索、更多、恢复 |
| 确认执行 | 主题色或强调色（如绿），hover 加深 | 应用、保存、执行合并 |
| 中性辅助 | 灰系实心，hover 微亮 | 忽略、▲ 收起 |
| 危险/关闭 | 红系，或灰底 hover 变红 | 删除、× 关闭 |
| 状态展示 | 透明框 + 同色边框 + 半透明底（badge / `*-btn-state`），`cursor: default` | 已应用、high/medium、已忽略、搜索中... |
| 暗淡提示 | 小字号灰系 | 状态行、计数、证据明细 |

尺寸三级（像素可按主题调整；层级差异只在尺寸，不在语义）：

| 层级 | 用途 | 参考尺寸 |
|---|---|---|
| 大（主按钮） | 插件级主导操作：合并全部、开始扫描、应用全部 | padding 6×16，字号 13；**不设 height、不设 line-height:1、不加 inline-flex**，高度由上下 padding 6px 撑出（约 31px） |
| 中（动作按钮） | 分页/Tab 级主操作：查询、合并、清理、导出等 | padding 4×12，字号 12，定高 26px，inline-flex + line-height:1 |
| 小（行内/组按钮） | 结果卡片行内密集操作：应用、忽略、更多、▲ | padding 3×10，字号 11，定高 22px，inline-flex + line-height:1 |

> 旧插件（jsm/pdm/tgm 现行版本）未使用中档类，保持现状；新面板/新插件按上表取值。三档高度约 31 / 26 / 22px，梯度递增。

硬性规则：

- **同一 flex 按钮组内的所有 `<button>` 必须同档同高，禁止跨档混排**；中档/小档的等高基座（`inline-flex` + `align-items:center` + `line-height:1` + 定高）声明在各自档类上（如 `<prefix>-btn-md` / `<prefix>-btn-sm`），大档不设 height/line-height:1/inline-flex，高度由 padding 撑出（约 31px）
- **可点击元素必须实心**；透明框元素（badge/状态框）**禁止**绑定点击事件、hover 变色、指针光标
- **禁止用垂直 margin 微调徽章/按钮的垂直位置**（`margin-top: 2px` 式"视觉补偿"会造成整组元素相对徽章下沉，已两次复现）；垂直对齐只靠容器 `align-items: center` 与等高盒模型
- badge/按钮加 `flex-shrink: 0`，文本区加 `min-width: 0` + 省略号，防窄屏压缩变形
- 状态展示用透明框状态样式，不用 disabled 实心按钮充当状态提示；disabled 仅用于短暂禁用（如搜索中按钮可例外显示为透明框状态样式）

## 状态切换按钮（筛选/开关类，如「冲突项」）

反馈必须是**切换态的持续显示**，不是按压瞬时反馈：

- **文案两态相同**：不用前缀符号（● 等）区分状态，状态信息全部由视觉承载
- **激活态**（持续显示至退出）：背景比关闭态暗一档、文字降为浅灰；内圈底部一条纯白指示条——贴底边、不影响文字垂直居中位置、左右内缩避开圆角、约 3px、两端圆角（可按主题微调）；hover 保持激活暗色不变，禁止弹回亮色 hover（会被误读为已退出）
- **禁止用 `:active` 按压反馈代替切换反馈**：按压松手即消失，表达不了持续状态
- **显隐跟随数据**：意外触发的模式（冲突检测、低可信度）无可筛内容时整个按钮不渲染，而非 disabled 置灰；用户手动触发的模式（「已忽略」筛选）按钮常驻显示，入口始终可发现、可退出

## 滑轨式开关（选项开关，如「别名搜索」「模糊匹配」「全部 box」）

用于搜索/扫描前的参数选项，与上一节按钮式筛选开关区分：

| | 滑轨式（本节） | 按钮式（上一节） |
|---|---|---|
| 用途 | 执行前的参数选项 | 列表筛选模式 |
| 典型 | 别名搜索、模糊匹配、全部 box、全量重查 | 冲突项、已忽略 |

- 用 `<div>`（不是 `<button>`）+ 滑轨圆点 + 文字标签，整个控件可点；类名 `<prefix>-toggle`，开启加 `.on`，警告类加 `-warn`（开启变黄，用于"降低安全/自动应用"的选项）
- 滑轨 28×14px 胶囊，圆点 10px 白色，0.15s 左右滑动；关闭灰 `#555`，开启跟随主题色；标签 12px 灰字在右侧
- `title` 写开/关分别做什么；busy 时加 `.disabled`（opacity 0.5 + pointer-events:none）
- 无 `:active` 按压反馈、无 hover 变色；自身 inline-flex + align-items:center，放进按钮组天然居中，不要定高、不要 margin 微调

## 列表筛选搜索框（长列表分页/面板应有）

适用：只能手动浏览编辑的分页（列表项 > 20 或需滚动才能看完）应提供搜索/筛选框；短列表、按序浏览有意义的场景可豁免。JavStashLinker 手动搜索页、performerMerge 分组列表均属此类。

- **即时过滤**：`oninput` 立即筛选，**不防抖、不等回车**；在名称和别名上做大小写不敏感的包含匹配
- **IME 兜底**：`oninput` 中 `e.isComposing` 为 true 时跳过（组字期间不重渲染，防打断候选框），并监听 `compositionend` 做最终提交——部分输入法选字完成后不触发带最终值的 input 事件，只靠 oninput 会漏
- **焦点与光标保持**：渲染前记录 `selectionStart`，渲染后 `focus()` + `setSelectionRange`，否则每敲一个字符光标跳回末尾/丢焦
- **重渲染最小化**：列表分块渲染（IntersectionObserver 按块追加），避免每次输入全量重建 DOM
- **清除按钮**（输入框内嵌）：显隐跟随渲染架构——全量重渲染插件（JavStashLinker）用**条件渲染**（有内容才 append 进 DOM）；局部渲染插件（tagMerge 工具栏刻意不重建以保焦点）用 **`hidden` 属性切换**（`clearBtn.hidden = !value`）。绝对定位在输入框右侧内部（`position: absolute; right` + 父容器 `position: relative`），输入框 `padding-right` 预留按钮空间；实心灰（中性可点击语义）、hover 变红（清除=危险暗示）、22px 定高；点击后清空筛选并把焦点还给输入框
- **计数反馈**：筛选时显示「匹配 N / 总数 M」暗淡文字，无筛选时显示「全部 N 个」；有关联排除项（已忽略等）时追加「（已忽略 X 个）」

## 幂等守卫（所有 UI 插件入口必须）

插件 script 可能被 Stash 重复执行，入口必须带全局幂等守卫，防止双重初始化（面板重复注入、监听器翻倍）：

```js
if (window.__<插件缩写>Loaded) return;
window.__<插件缩写>Loaded = true;
```

现有插件缩写：jsm（JavStashLinker）/ pdm（performerMerge）/ tgm（tagMerge）。动态注入的子机制（如 Refract 主题 tile）用独立标志位（`__<缩写>RefractTileInit`）。

## 极窄屏适配（所有 UI 插件必须兼容）

目标：**≤480px 完全可用**（元素不溢出、关键操作不隐藏），640px 为优化断点，触屏设备同样可用。

- flex/grid 子项容器必须加 `min-width: 0`，防长文本撑破布局；长名称/长列表用 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 截断，完整内容放 `title` 提示
- 关键操作按钮（应用/删除/关闭等）加 `flex-shrink: 0`，任何情况下不被压缩或挤出屏幕
- ≤640px：卡片容器 `flex-wrap: wrap`，信息占满首行；badge 与操作按钮组换行到信息下方**右侧**（`justify-content: flex-end`）；提示文字/状态行保持靠左
- 面板/滚动容器加 `scrollbar-gutter: stable` 防滚动条出现/消失引起布局抖动；弹窗类 UI 把滚动放在**面板内部**（`max-height` + `overflow-y: auto`），外层容器不滚动，避免外层滚动条/gutter 占位导致面板右侧留空
- 弹窗/面板 ≤480px 两侧铺满：外层容器 padding 清零、面板圆角取消、`max-height: 100vh`（与 640px 断点分开：640 换行、480 铺满）；弹窗内容低于屏幕高度时上下居中：面板用 `margin: auto 0`（而非 `align-items: center`，后者内容超高时顶部溢出无法滚回）；超出时自动退化为顶对齐
- 触屏设备或 ≤640px：仅装饰性交互（拖拽把手、标签清除 ×）可隐藏，功能按钮一律保留；表格类数据（如合并对照表）窄屏改用横向滚动或堆叠布局，不用缩字号硬塞

## 多语言（i18n，所有带 UI 的插件通用）

**双语言中文/英文**，跟随 Stash 界面语言，不引入第三方语言与翻译文件。JavStashLinker / performerMerge / tagMerge 共用同一实现，新插件照抄：

- **调用约定**：模块级 `tc(zh, en)`，`_intlLocale` 以 `zh` 开头返回中文，否则英文。**所有用户可见字符串必须包 `tc()` 且两个参数都写**：按钮文案、标题、tooltip（`title` 属性）、`alert`/`confirm` 弹窗、badge、placeholder、日志条目、空态提示
- **语言来源**：`initIntlBridge()` 通过 `PluginApi` 挂 React 组件读 `api.libraries.Intl.useIntl().locale` 同步到 `_intlLocale`；桥接失败（PluginApi 不可用/异常）静默降级英文——不抛错阻塞插件加载
- **动态文案**：拼接变量写法 `tc("已合并 " + n + " 个", "Merged " + n)`，两种语言各自完整组句，不抽词根
- **不翻译**：数据值（tag/演员/工作室名）、GraphQL 语句、`console.log`（前缀用 `[jsm]`/`[pdm]`/`[tgm]` 等插件缩写）、CSS 类名、localStorage 键
- **弹窗与确认框**：`confirm()` 用于破坏性/批量操作前置确认，文案双语且含关键数字（组数/源数/将发生什么）；`alert()` 仅用于错误与不可继续的提示；操作结果优先走面板内状态行（分色），不用弹窗
- **确认框文案只写操作对象与简洁警告，不写机制描述**：仅保留「对什么对象做什么 + 破坏性后果/冲突警示」（如 `将 2 个演员合并到「X」？源演员将被删除。`）；拆分/删除/合并的具体规则（按什么分隔符、丢弃什么、去重方式、字段如何合并）属机制描述，放按钮 `title` 悬浮提示与 README
- **按钮 `title` 不写交互过程描述**：操作完成后界面如何变化（`完成后卡片收缩变灰`、`卡片收缩成一行`、`折叠该组`、`不自动重新扫描` 等）不属于悬浮提示的内容；`title` 只写「操作影响什么数据」（如 `仅删除别名条目`、`忽略该短名`），能从按钮文案看懂的就不加 title
