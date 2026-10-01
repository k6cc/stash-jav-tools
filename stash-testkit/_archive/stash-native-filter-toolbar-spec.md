# Stash 原生筛选条 1:1 还原规格（v0.31.1 实测）

来源：localhost:9999 `/scenes` 页面 DOM + 计算样式实测，源码 `ui/v2.5/src/components/List/`。
适用：插件内自建列表需与 Stash 原生视觉保持一致时。

## 还原原则

筛选条整体是一个 react-bootstrap `ButtonToolbar`（`.filtered-list-toolbar.btn-toolbar`）。
**直接复用 Stash 的 Bootstrap 类名**（`btn btn-secondary` / `form-control` / `btn-toolbar` / `dropdown-toggle` / `btn-group`），
主题（深/浅）由当前 Stash 主题自动继承，不在插件里写死颜色。

## 容器

| 属性 | 值 |
|---|---|
| 类名 | `filtered-list-toolbar btn-toolbar` |
| display | flex，`flex-wrap: wrap`，`align-items: center` |
| gap / row-gap | 7px |
| margin-top | -7px |

## 控件组成（从左到右）

| # | 控件 | 结构 / 类名 | 图标 | 说明 |
|---|---|---|---|---|
| 1 | 搜索框 | `.clearable-input-group.search-term-input` > `input.clearable-text-field.form-control` | 放大镜（placeholder 内） | `flex-grow:1`，宽约 224px；**有输入时**追加 `button.clearable-text-field-clear.btn.btn-secondary`（title=清除，× 图标） |
| 2 | 已存筛选下拉 | `.saved-filter-dropdown.dropdown.btn-group` > `.dropdown-toggle.btn.btn-secondary` | bookmark | 菜单 = 已存过滤器列表 + 「设置为默认」 |
| 3 | 筛选器按钮 | `button.filter-button.btn.btn-secondary` | filter（漏斗） | title=编辑筛选器；角标数字 = 活动筛选条件数 |
| 4 | 排序 | `.sort-by-select.dropdown.btn-group`：`input-group-prepend > .dropdown-toggle`（显示当前排序名）+ 方向按钮 + （random 时）reshuffle 按钮 | 方向按钮 caret-up / caret-down | toggle 文案 = 当前排序（如「日期」）；tooltip = 升序/降序 |
| 5 | 每页个数 | `.page-size-selector` > `select.btn-secondary.form-control` | — | 选项：20 / 40 / 60 / 120 / 250 / 500 / 1000 / 自定义… |
| 6 | 列表操作 | `.list-operations` > btn-group：play 按钮 + `#more-menu` ellipsis 下拉 | play / ellipsis | 列表页特有（播放/更多），通用筛选条可省略 |
| 7 | 视图切换 | `.btn-group` > 4 个 `.btn.btn-secondary`（active 态加 `active` 类） | th-large（网格）/ list（列表）/ square（墙）/ tags（标记） | 快捷键 `v g` / `v l` / `v w` / `v t`；`displayModeOptions.length > 1` 时才渲染 |
| 8 | 卡片大小 | `.zoom-slider-container` > `input[type=range].zoom-slider.form-control-range`，min=0 max=3 | — | 容器宽 60px；仅网格/墙视图渲染；快捷键 `+` / `-` |

工具栏正下方是分页信息行 `.pagination-index-container`（如 `1-17 of 17 (1D 2h 58m - 55.2 GiB)`）。

## 尺寸实测（深色主题，1920 宽视口）

| 元素 | 尺寸 |
|---|---|
| 按钮（.btn-secondary） | 高 ~33px；padding 5.25px 10.5px；字号 14px；圆角 3.5px（btn-group 内测圆角归零） |
| 搜索输入框 | 高 ~29px；宽 224px（flex-grow 自适应） |
| 每页 select | 宽 ~74px |
| 滑块 | 容器 60px × 轨道高 6px |

按钮色（深色主题 `#202b33` 底）：背景/边框 `#394755`，文字白色。**不要写死**——用类名继承。

## 场景排序项（30 项，菜单按中文名排序）

比特率、标签数量、标题、播放量、播放长度、创建于、短片序号、分辨率、感知相似度（pHash码）、高潮次数、更新于、工作室、工作室代码、互动、互动速度、恢复时间、路径、评分、日期、时长、是否已经整理、随机、文件大小、文件数量、文件修改时间、演员年龄、演员数量、帧率、最后播放在、最近一次高潮在

## 卡片缩放档位（场景网格）

`SceneCardGrid.tsx`：`zoomWidths = [280, 340, 480, 640]`（zoom 0–3），容器不足时收缩：

```
maxUsable = containerWidth - 30
cols      = ceil(maxUsable / preferredWidth)
cardWidth = maxUsable / cols - 10
```

实测视口下卡片宽：zoom0=221 / zoom1=279 / zoom2=376 / zoom3=568px。

## DOM 骨架（复刻用）

```html
<div role="toolbar" class="filtered-list-toolbar btn-toolbar">
  <div class="clearable-input-group search-term-input">
    <input placeholder="搜索…" class="clearable-text-field form-control">
    <!-- 有输入时才出现 -->
    <button title="清除" class="clearable-text-field-clear btn btn-secondary">×</button>
  </div>
  <div role="group" class="btn-group">
    <div class="saved-filter-dropdown dropdown btn-group">
      <button class="dropdown-toggle btn btn-secondary">书签图标</button>
    </div>
    <button title="编辑筛选器" class="filter-button btn btn-secondary">漏斗图标</button>
  </div>
  <div role="group" class="sort-by-select dropdown btn-group">
    <div class="input-group-prepend">
      <button class="dropdown-toggle btn btn-secondary">日期</button>
    </div>
    <button class="btn btn-secondary">caret-down</button>
  </div>
  <div class="page-size-selector">
    <select class="btn-secondary form-control">
      <option>20</option><option>40</option><option>60</option><option>120</option>
      <option>250</option><option>500</option><option>1000</option><option>自定义...</option>
    </select>
  </div>
  <div role="group" class="btn-group">
    <button class="btn active btn-secondary">th-large</button>
    <button class="btn btn-secondary">list</button>
    <button class="btn btn-secondary">square</button>
    <button class="btn btn-secondary">tags</button>
  </div>
  <div class="zoom-slider-container">
    <input type="range" class="zoom-slider form-control-range" min="0" max="3" value="1">
  </div>
</div>
```

注意：插件 UI 运行在 Stash 主页面 CSP 下（`script-src`/`style-src`/`connect-src` 可在 yml `ui.csp` 声明，`img-src` 服务端固定 `data: *`），无需为筛选条额外申请 CSP。
