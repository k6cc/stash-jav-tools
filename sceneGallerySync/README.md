# sceneGallerySync 插件使用说明

## 功能概述

sceneGallerySync 是一个 Stash 插件，在影片扫描入库时自动创建同名图库，导入影片元数据（标题、工作室、演员等），自动关联影片，并设置封面和 fanart 图片。

### 核心功能

- **自动创建图库**：扫描入库时自动为包含 extrafanart 图片的影片创建图库
- **元数据同步**：图库自动继承影片的标题、工作室、演员、标签等数据
- **封面设置**：自动查找并设置图库封面（poster.jpg / folder.jpg）
- **fanart 导入**：自动导入影片同目录下的 fanart 图片到图库
- **多碟影片支持**：CD1/CD2、-a/-B/-c 等分集影片自动共享同一图库
- **手动创建**：在影片编辑页面提供"创建图库"按钮，支持一键创建

## 工作原理

### 创建图库的前置条件

插件创建图库前需通过三级检查，任一不满足则跳过：

| 检查 | 条件 | 不满足时行为 |
|------|------|------------|
| extrafanart 文件夹 | 影片同目录下存在配置的文件夹名（默认 `extrafanart`） | 跳过，不创建图库 |
| extrafanart 图片 | 文件夹内存在支持的图片文件（jpg/jpeg/png/gif/webp） | 跳过，不创建图库 |
| 图片已入库 | extrafanart 图片已被 Stash 扫描入库 | 轮询等待，超时后跳过（可手动按钮补建） |

> **封面和 fanart 不是必要条件**。即使没有 poster.jpg 或 fanart.jpg，只要 extrafanart 文件夹有图片就会创建图库。

### 三种执行模式

| 模式 | 触发方式 | 执行方式 | 说明 |
|------|----------|----------|------|
| **钩子模式** | Scene.Update.Post | 后台进程 | 扫描时自动触发，不阻塞扫描任务 |
| **后台模式** | 钩子模式自动派生 | 独立进程 | 等待 nfoSceneParser 完成后创建图库 |
| **手动模式** | 编辑页面按钮 | 同步执行 | 点击按钮直接创建，立即返回结果 |

### 钩子模式流程

```
影片扫描 → nfoSceneParser 导入 NFO → Scene.Update.Post 触发
  → 检测 nfoSceneParser 是否启用
  → 查询 scene 路径，前台检查 extrafanart 文件夹
    → 不存在：钩子立即退出，不启动后台
    → 存在：写入任务文件到 .sgs_pending/，启动独立后台进程
  → 钩子立即退出（不阻塞扫描）

后台进程：
  → 渐进退避等待影片元数据就绪（3s→5s→7s...最长15s，最多12次）
  → 查找封面、fanart、extrafanart 图片
  → 轮询等待图片入库（5s→7s→9s...最长15s，最多12次）
  → 四层搜索已有图库 → 创建或追加
  → 进程自动退出
```

### 关键设计

- **不阻塞扫描**：钩子模式使用一次性后台进程，钩子立即退出，不影响 Stash 扫描任务队列
- **前台早期过滤**：`Scene.Update.Post` 阶段先检查 extrafanart 文件夹，无图库前置条件的 scene（如 `/social/x/` 抓取内容）直接跳过，不启动后台进程，不进行无谓的元数据轮询
- **stdio 隔离**：后台子进程重定向 stdin/stdout 到 DEVNULL、stderr 到 `.sgs_pending/{scene_id}.log`，避免继承前台的 stash 管道句柄导致 hook 阻塞
- **nfoSceneParser 依赖**：自动模式仅在 nfoSceneParser 启用时触发，避免无 NFO 数据时创建空图库
- **进程隔离**：后台进程使用 `start_new_session=True`（Linux/Docker）或 `DETACHED_PROCESS`（Windows），成为独立进程
- **过期清理**：`.sgs_pending/` 目录中超过 1 小时的任务文件（`.json`）和日志文件（`.log`）自动清理

## 依赖

- **必须**：安装并启用 [nfoSceneParser](https://github.com/stashapp/CommunityScripts/tree/main/plugins/nfoSceneParser) 插件（仅自动模式需要，手动按钮不受影响）
- **必须**：Python `requests` 库（Stash Docker 镜像已内置）

## 目录结构要求

```
影片目录/
├─ 影片名.avi
├─ 影片名-poster.jpg          ← 封面（可选，优先）
├─ folder.jpg                  ← 封面（可选，备选）
├─ 影片名-fanart.jpg           ← fanart（可选）
├─ landscape.jpg               ← fanart（可选）
└─ extrafanart/                ← 必须！必须存在且含图片
   ├─ backdrop1.jpg
   ├─ backdrop2.jpg
   └─ ...
```

> **注意**：`extrafanart` 文件夹是创建图库的**必要条件**。文件夹不存在或内部无图片文件，插件都不会创建图库。封面和 fanart 为可选项，缺失不影响图库创建。

## 配置选项

编辑 `config.py` 文件自定义配置（不在 Stash 设置页面显示）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `poster_filenames` | `"{filename}-poster.jpg,folder.jpg"` | 封面文件名列表，按顺序查找，使用第一个找到的 |
| `fanart_filenames` | `"{filename}-fanart.jpg,landscape.jpg"` | fanart 文件名列表，所有找到的都导入图库 |
| `extrafanart_folders` | `"extrafanart"` | extrafanart 文件夹名列表，按顺序查找第一个存在的 |
| `image_extensions` | `".jpg,.jpeg,.png,.gif,.webp"` | 支持的图片扩展名，extrafanart 文件夹内仅导入这些格式 |
| `stale_file_max_age` | `3600` | 过期任务文件清理时间（秒），超过此时间的 `.sgs_pending` 文件自动删除 |
| `title_suffix_patterns` | 见下方详细说明 | 标题后缀剥离模式，用于让不同版本的影片关联同一图库 |

### 配置说明

- `{filename}` 会被替换为影片文件名（不含扩展名）
- 多碟影片（如 `影片-cd1.avi`、`影片-a.avi`）会按文件名链逐级尝试（详见多碟影片支持）
- 多个值用英文逗号分隔
- `poster_filenames` 按顺序查找，找到第一个即停止
- `fanart_filenames` 所有找到的文件都会导入
- `image_extensions` 扩展名需含点号，如 `.bmp`、`.tiff`
- `stale_file_max_age` 单位为秒，设为 `0` 可禁用自动清理
- 修改配置后无需重启 Stash，下次触发时自动生效

### title_suffix_patterns 配置说明

标题后缀剥离用于让不同版本的影片（如分集版、字幕版、无码版等）关联到同一图库。插件会按顺序循环剥离匹配的后缀，直到无后缀可剥。

**默认支持的后缀类型：**

| 类型 | 示例 | 说明 |
|------|------|------|
| 数字分集 | CD1, Disc2, Part3, Pt1 | 多碟/多集影片标记 |
| 单字母版本 | A, B, C | 字幕版、分集等单字母标记 |
| 数字分辨率 | 4K, 8K | 分辨率标识 |
| 中文类型 | 无码、破解、中文字幕、超清 | 中文影片类型标识 |

**配置格式：**
- 每行一个正则表达式（不需要写 `\s+` 前缀和 `$` 后缀，程序会自动添加）
- `#` 开头的行为注释
- 模式按从上到下顺序尝试匹配

**示例：剥离 `ABC-123 无码 CD1` → `ABC-123`**

```
CD\\d+           # 先剥离 CD1
无码             # 再剥离 无码
→ 结果: ABC-123
```

**扩展配置示例：**
```python
title_suffix_patterns = """
CD\\d+           # CD分集
Disc\\d+        # Disc分集
[a-zA-Z]        # 单字母
\\d+K           # 分辨率
国产|独家|中文|热血|素人  # 自定义中文后缀
"""
```

### 配置示例

```python
# 使用自定义封面文件名
poster_filenames = "{filename}-poster.jpg,{filename}-cover.jpg,folder.jpg"

# 添加更多 fanart 来源
fanart_filenames = "{filename}-fanart.jpg,landscape.jpg,clearart.png"

# 支持多种 extrafanart 文件夹名
extrafanart_folders = "extrafanart,extra fanart,art"
```

## 多碟影片支持

对于多碟影片（文件名包含以下分集后缀），插件会自动去除后缀生成基础文件名：

| 后缀类型 | 示例 | 说明 |
|----------|------|------|
| `-cd1`、`-cd2`、`-disc1`、`-part1`、`-pt1` | `IDBD-287-cd1.avi` | 数字编号分集 |
| `-a`、`-B`、`-c` | `OFJE-341-a.avi` | 字母编号分集（与 nfoSceneParser 一致） |
| `-C`（中文字幕） | `ABP-998-C-cd1.avi` | 字幕标记，自动剥离后与原版共享图库 |

插件处理逻辑：

1. 循环剥离分集后缀，直到无后缀可剥（如 `ABP-998-C-cd1` → `ABP-998-C` → `ABP-998`）
2. 使用 nfoSceneParser 处理后的标题（去除 ` CD1`/`CD2` 后缀）作为图库标题
3. 第一个分集创建图库，后续分集自动追加关联到同一图库
4. 封面和 fanart 搜索尝试文件名链中的每一级（见下方示例）

### 文件名链与图片查找

循环剥离产生的文件名链用于封面和 fanart 查找，按优先级从具体到通用。当基础文件名含空格时，自动追加番号首词：

```
ABP-998-C-cd1.avi 的封面查找顺序：
  1. ABP-998-C-cd1-poster.jpg  ← 分集专属封面
  2. ABP-998-C-poster.jpg      ← 字幕版封面
  3. ABP-998-poster.jpg        ← 共享封面

OFJE-351 101个美好日子-cd1.avi 的封面查找顺序：
  1. OFJE-351 101个美好日子-cd1-poster.jpg  ← 分集专属
  2. OFJE-351 101个美好日子-poster.jpg       ← 完整标题
  3. OFJE-351-poster.jpg                     ← 番号封面
```

> 多个分集共用一套图片和 NFO 文件时，只需保留基础文件名的图片即可。

### 字母后缀的特殊情况

- `-C` 后缀表示"中文字幕"版本，自动剥离后与原版共享图库
- `-C` 与 `-cd1` 组合时（如 `ABP-998-C-cd1`），两层后缀都会被剥离
- nfoSceneParser 对单独 `-C` 不添加 `CD` 后缀，本插件仍会剥离 `-C` 使字幕版与原版共享图库

### 图库关联搜索

当分集影片标题不完全一致时（如翻译差异），插件使用四层搜索确保关联：

| 层级 | 搜索方式 | 说明 |
|------|---------|------|
| 第1层 | 图库标题精确匹配 | 标题完全相同时直接命中 |
| 第2层 | 基础文件名精确匹配 | 无标题时以文件名创建的图库 |
| 第3层 | 文件名首词模糊匹配 | 文件名含空格时提取番号搜索 |
| 第4层 | 标题首词模糊匹配 | 文件名不含番号时从标题提取 |

第3、4层使用 INCLUDES 搜索 + 首词精确校验，避免 `AB-1` 误匹配 `AB-11`。

**示例**：
```
目录/
├─ IDBD-287-cd1.avi
├─ IDBD-287-cd2.avi
├─ IDBD-287-poster.jpg       ← 使用基础文件名匹配
└─ extrafanart/
   └─ ...

→ 创建一个图库 "IDBD-287"，同时关联 cd1 和 cd2

目录/
├─ OFJE-341-a.avi
├─ OFJE-341-B.avi
├─ OFJE-341-c.avi
├─ OFJE-341-B-poster.jpg     ← 分集专属封面
├─ OFJE-341-poster.jpg       ← 共享封面（备选）
└─ extrafanart/
   └─ ...

→ 创建一个图库 "OFJE-341"，同时关联 a、B、c
```

## 使用方式

### 自动模式（推荐）

1. 确保已安装 nfoSceneParser 并启用
2. 将影片按目录结构要求组织好
3. 在 Stash 中执行扫描任务
4. 扫描完成后插件自动创建图库

### 手动模式

1. 进入影片编辑页面
2. 在"图库"标签旁点击"创建图库"按钮
3. 按钮状态变化：创建中 → 任务已提交 → 恢复

> 手动模式不依赖 nfoSceneParser，可在任何时候使用。

## Docker 部署

### 环境要求

- Stash Docker 镜像已内置 Python 和 `requests` 库
- 插件目录需挂载到 Stash 的 plugins 目录

### 低功耗优化

本插件针对低功耗 Docker 环境（ARM 设备、低内存 VPS 等）做了以下优化：

| 优化项 | 说明 |
|--------|------|
| **渐进退避轮询** | 等待图片入库时逐步增加间隔（5s→7s→9s...），减少 GraphQL 请求频率 |
| **GraphQL 重试** | 连接错误和超时自动重试（最多3次，指数退避），适应低速环境 |
| **一次性后台进程** | 钩子立即退出不阻塞扫描，后台进程完成后自动退出，无守护进程开销 |
| **过期任务清理** | `.sgs_pending/` 中超过1小时的任务文件自动清理，防止磁盘占用 |
| **轻量级依赖** | 仅依赖 Python 标准库 + requests，无额外安装需求 |

### Docker Compose 示例

```yaml
services:
  stash:
    image: stashapp/stash:latest
    volumes:
      - /path/to/config:/root/.stash
      - /path/to/plugins:/root/.stash/plugins
      - /path/to/videos:/videos
      - /path/to/gallery:/gallery
```

### 注意事项

- Docker 内路径与宿主机路径不同，确保 Stash 扫描路径与实际文件路径一致
- 同时扫描大量影片时，每个影片会启动一个后台进程，低内存设备（<1GB）建议分批扫描
- 后台进程等待图片入库的最长时间约 140 秒，低速设备可能需要手动按钮补充创建

## 文件说明

| 文件 | 说明 |
|------|------|
| `sceneGallerySync.py` | 主程序，包含三种执行模式和图库创建逻辑 |
| `stashInterface.py` | Stash GraphQL API 接口，含重试机制 |
| `config.py` | 配置文件，管理文件名和文件夹名 |
| `log.py` | Stash 日志协议封装（SOH/STX 编码），后台模式输出纯文本到日志文件 |
| `sceneGallerySync.js` | 前端注入脚本，在编辑页面添加"创建图库"按钮 |
| `sceneGallerySync.css` | 前端按钮样式 |
| `sceneGallerySync.yml` | 插件清单定义 |

## 常见问题

**Q: 扫描后没有自动创建图库？**

A: 请依次检查：
1. nfoSceneParser 插件是否已安装并启用
2. 影片目录下是否有 `extrafanart` 文件夹
3. `extrafanart` 文件夹内是否有图片文件（jpg/jpeg/png/gif/webp）
4. 图片是否已被 Stash 扫描入库（查看 Stash 日志中的图片数量）
5. 查看 Stash 日志中是否有 `sceneGallerySync` 的错误信息

**Q: 图库只关联了一张碟片？**

A: 正常现象。CD1 扫描时创建图库，CD2 扫描时自动追加关联到同一图库。如果 CD2 的扫描在 CD1 图库创建之前完成，可能需要手动点击按钮。

**Q: 部分图片没有导入图库？**

A: 可能原因：
1. 图片尚未被 Stash 扫描入库 → 等待扫描完成后点击"创建图库"按钮
2. 图片文件扩展名不在支持列表中 → 支持格式：jpg、jpeg、png、gif、webp
3. extrafanart 文件夹中图片超过 1000 张 → 极端情况，需分目录存放

**Q: 低功耗设备上扫描很慢？**

A: 插件已做渐进退避优化，但以下建议可进一步提升：
1. 分批扫描，每次 50-100 部影片
2. 确保存储 I/O 性能（避免 SD 卡存储）
3. 如果内存有限（<1GB），减少同时扫描数量

**Q: 如何重新创建图库？**

A: 先在 Stash 中删除已有图库，然后在影片编辑页面点击"创建图库"按钮。

**Q: `.sgs_pending` 目录是什么？**

A: 钩子模式下的临时任务目录，用于后台进程读取连接信息。任务文件（`.json`）在后台进程启动后立即删除；后台日志文件（`.log`，1.6.0 新增）记录后台进程运行日志。超过 1 小时的残留文件会自动清理。可以安全删除整个目录。

## 变更历史

### 1.6.0

- **修复 hook 阻塞**：后台子进程未重定向 stdio，会继承前台的 stash stdout/stderr 管道句柄，导致 stash 在前台 `exit_plugin` 后仍收不到 EOF，hook 一直挂起直到后台超时（表现为手动编辑元数据时 UI 转圈数分钟、stash 日志出现 `operation cancelled`）
  - 重定向后台子进程 stdin/stdout 到 DEVNULL，stderr 写入 `.sgs_pending/{scene_id}.log`
  - 后台模式日志改用纯文本格式（`[INFO] xxx`），不再带 stash 协议前缀
  - `__cleanup_stale_tasks` 同时清理过期 `.json` 和 `.log` 文件
- **前台早期过滤 extrafanart**：`Scene.Update.Post` 阶段先查询 scene 路径并检查 extrafanart 文件夹，无文件夹的 scene（如 `/social/x/` 抓取内容）直接跳过，不启动后台进程，不进行无谓的 2.3 分钟 title 轮询
  - extrafanart 是文件系统状态，不依赖 nfoSceneParser 的元数据写入，可在 hook 触发瞬间检查
  - 保留 per-scene 顺序执行：每个 scene 的 hook 独立处理，不影响 stash 扫描线程调度

### 1.5.0

- 初始版本：钩子模式 + 后台模式 + 手动模式三种执行模式
- 渐进退避轮询等待元数据和图片入库
- 四层图库关联搜索，支持多碟影片自动共享同一图库
- 低功耗 Docker 环境优化（GraphQL 重试、过期任务清理）
