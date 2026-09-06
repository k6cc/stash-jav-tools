# AGENTS.md

本仓库是 Stash 插件集合（monorepo）：`sceneTranslate` / `sceneGallerySync` / `studioTools` / `JavStashLinker` / `performerMerge` / `tagMerge` 六个插件 + 根 `README.md` 版本表。插件通过各 `<name>.yml` 的 `version:` 字段声明版本，Stash 实际读取该字段；发版时**所有版本号位置必须同步**，否则会漂移。

## 发版清单（六个插件通用）

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致。

| 插件 | 权威版本位置 | 需同步的位置 | README 版本说明约定 |
|---|---|---|---|
| sceneTranslate | `sceneTranslate.yml` `version:` | `translateProxy.py` 头部 banner（`Scene Translate Proxy vX.Y.Z`）；`README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| sceneGallerySync | `sceneGallerySync.yml` `version:` | 根 `README.md` 版本表 | 头部无 note；在文末「## 变更历史」新增 `### X.Y.Z` 条目 |
| studioTools | `studioTools.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| JavStashLinker | `JavStashLinker.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| performerMerge | `performerMerge.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |
| tagMerge | `tagMerge.yml` `version:` | `README.md` 头部 `> vX.Y.Z：`；根 `README.md` 版本表 | 头部**只保留最新一条** note |

根 `README.md` 版本表包含全部六个插件，发版必须同步。各插件 `yml` 的 `url:` 字段指向 Discourse 论坛帖子，发布时确认链接正确。

## 发版流程（git）

1. 更新上表所有位置（含根 `README.md` 版本表）
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件名>-vX.Y.Z`（如 `sceneTranslate-v2.9.2`）；多插件联动发版时每个插件各打一个 tag
5. `git push && git push --tags`
6. Windows 下 git 提示 LF→CRLF 属正常，不影响内容；PowerShell 不支持 heredoc，commit 用 `-m "..."` 即可

## 文件编辑（agent 工作约定）

- **同一文件的多处修改一律串行执行**：等上一次编辑落盘完成后再发起下一次；只有不同文件的修改可以并行。原因：并行的每次编辑基于各自的文件快照应用差异后整体写回，后完成者覆盖先完成者，同批只有最后落盘的一处存活（tagMerge.js 曾多次复现修改静默丢失）
- 多处修改完成后用 `rg` 逐点核对关键改动确已在盘，再报完成

## UI 交互设计规范（全部带 UI 的插件通用）

**色彩与尺寸不绑定具体值**：各插件有自己的主题色（JavStashLinker 蓝、performerMerge 紫等），按钮取色跟随插件主题——主操作用主题色、忽略/中性灰、警告黄、删除/关闭红。本规范约束的是**交互语义和层级关系**，不是具体色号和像素。

### 按钮语义（与主题无关，必须遵守）

**核心语义：实心按钮 = 可点击/交互；透明框（边框+半透明底）= 状态/提示，无指针光标、无 hover 变色。**

| 语义角色 | 用色逻辑 | 示例 |
|---|---|---|
| 主操作 | 插件主题色（蓝/绿/紫随主题），hover 加深 | 搜索、更多、恢复 |
| 确认执行 | 主题色或强调色（如绿），hover 加深 | 应用、保存、执行合并 |
| 中性辅助 | 灰系实心，hover 微亮 | 忽略、▲ 收起 |
| 危险/关闭 | 红系，或灰底 hover 变红 | 删除、× 关闭 |
| 状态展示 | 透明框 + 同色边框 + 半透明底文字（badge 类 / `*-btn-state`），`cursor: default` | 已应用、high/medium、已忽略、搜索中... |
| 暗淡提示文字 | 小字号灰系 | 状态行、计数、证据明细 |

### 按钮尺寸层级（三级，具体像素可按主题调整）

| 层级 | 用途 | 参考尺寸（jsm/pdm 现行值） |
|---|---|---|
| 大（主按钮） | 面板级唯一/主导操作：开始扫描、应用全部 | padding 6×16，字号 13 |
| 中（动作按钮） | 常规整行操作：打开面板、单卡片主操作 | 介于两者之间 |
| 小（行内/组按钮） | 卡片行内密集操作：应用、忽略、更多、▲ | padding 3×10，字号 11，定高 22px |

同级按钮（含 badge、图标按钮）**必须等高**，混排不齐即为 bug；层级差异只体现在尺寸，不体现在语义。

硬性规则：

- **可点击元素必须实心**；透明框元素**禁止**绑定点击事件、hover 变色和指针光标
- **高度统一**：同一行内混排的小按钮/badge/图标按钮用 `inline-flex` + `align-items: center` + `line-height: 1` + `border-box` 保持等高
- badge/按钮加 `flex-shrink: 0`，文本区加 `min-width: 0` + 省略号，防窄屏压缩变形
- 交互状态机显示用状态样式，不用 disabled 实心按钮充当状态提示（disabled 仅用于短暂禁用，如搜索中按钮可例外显示为透明框状态样式）

### 状态切换按钮（筛选/开关类，如「冲突项」）

适用：点击进入/退出某个筛选或模式，按钮本身承载开关两态。反馈必须是**切换态的持续显示**，不是按压瞬时反馈。

- **文案两态相同**：不用前缀符号（● 等）区分状态，状态信息全部由视觉承载
- **关闭态**：普通警告语义实心按钮（主题警告色，黄系），与同排按钮一致
- **激活态**（切换反馈，持续显示至退出）：
  - 背景比关闭态暗一档、文字降为浅灰，与关闭态拉开可辨对比
  - 内圈底部一条纯白指示条：贴底边、左右内缩避开圆角与文字、加粗（约 3px，两端圆角，可按主题微调）
  - hover 保持激活暗色不变 — 禁止弹回亮色 hover 色，否则会被误读为已退出
- **禁止用 `:active` 按压反馈代替切换反馈**：按压松手即消失，表达不了持续状态
- **显隐跟随数据**：无可筛内容时整个按钮不渲染，而非 disabled 置灰

### 极窄屏适配（所有 UI 插件必须兼容）

目标：**≤480px 完全可用**（元素不溢出、关键操作不隐藏），640px 为优化断点，触屏设备同样可用。

- 所有 flex/grid 子项容器必须加 `min-width: 0`，防止长文本撑破布局
- 长名称/长列表用 `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 截断，完整内容放 `title` 提示
- 关键操作按钮（应用/删除/关闭等）加 `flex-shrink: 0`，任何情况下不被压缩或挤出屏幕
- ≤640px：卡片容器允许 `flex-wrap: wrap`，信息占满首行；badge 与操作按钮组换行到信息下方**右侧**（`justify-content: flex-end`，与宽屏时按钮位置呼应）；提示文字/状态行保持靠左
- 面板/滚动容器加 `scrollbar-gutter: stable`，防止滚动条出现/消失引起布局抖动；弹窗类 UI 把滚动放在**面板内部**（`max-height` + `overflow-y: auto`），外层容器不滚动，避免外层滚动条/gutter 占位导致面板右侧留空
- 弹窗/面板 ≤480px 两侧铺满：外层容器 padding 清零、面板圆角取消、`max-height: 100vh`（与 640px 换行断点分开：640 换行、480 铺满）
- 弹窗内容低于屏幕高度时上下居中：面板用 `margin: auto 0`（而非 `align-items: center`，后者内容超高时顶部溢出无法滚回）；超出时自动退化为顶对齐
- 触屏设备或 ≤640px：仅装饰性交互（拖拽把手、标签清除 ×）可隐藏，功能按钮一律保留
- 表格类数据（如合并对照表）在窄屏改用横向滚动或堆叠布局，不用缩字号硬塞

### 多语言（i18n，所有带 UI 的插件通用）

**双语言模型：中文 / 英文**，跟随 Stash 界面语言，不引入第三方语言与翻译文件。三插件（JavStashLinker / performerMerge / tagMerge）共用同一实现，新插件照抄：

- **调用约定**：模块级 `tc(zh, en)` 函数，`_intlLocale` 以 `zh` 开头返回中文，否则英文。**所有用户可见字符串必须包 `tc()` 且两个参数都写**：按钮文案、标题、tooltip（`title` 属性）、`alert`/`confirm` 弹窗、badge、placeholder、日志条目、空态提示
- **语言来源**：`initIntlBridge()` 通过 `PluginApi` 挂 React 组件读 `api.libraries.Intl.useIntl().locale`，同步到 `_intlLocale`；桥接失败（PluginApi 不可用/异常）静默降级为英文默认——不允许抛错阻塞插件加载
- **动态文案**：拼接变量写法 `tc("已合并 " + n + " 个", "Merged " + n)`，两种语言各自完整组句，不抽词根
- **不翻译的内容**：数据值（tag/演员/工作室名）、GraphQL 语句、`console.log`（前缀用 `[jsm]`/`[pdm]`/`[tgm]` 等插件缩写）、CSS 类名、localStorage 键
- **弹窗与确认框**：`confirm()` 用于破坏性/批量操作前置确认，文案必须双语且包含关键数字（组数/源数/将发生什么）；`alert()` 仅用于错误与不可继续的提示；操作结果提示优先走面板内状态行（分色），不用弹窗

## 其他

- `.gitignore` 已忽略 `__pycache__` 与备份文件，不要提交
- 本文件是 agent 协作约定，不随插件版本发布
