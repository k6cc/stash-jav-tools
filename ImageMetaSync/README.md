# ImageMetaSync 插件使用说明

> v1.0.0：初始版本

纯后台插件（无 JS/CSS、无 UI）。把场景级元数据回填到该场景图库的图片记录上（封面 + fanart + 剧照），最主要是补演员关联。以**图库为处理单元**：演员取该图库所有关联场景的并集，无法确认唯一演员（0 个或 2 个以上）时整库跳过并记录日志。

## 依赖

- **必须**：Python + `requests`（Stash Docker 镜像已内置）
- 建议配合 [sceneGallerySync](https://discourse.stashapp.cc/t/scenegallerysync/13853)：图库本身由它创建并关联场景，本插件只补图片元数据

## 安装

把 `ImageMetaSync/` 复制到 Stash 插件目录（Windows `%USERPROFILE%\.stash\plugins\`，Docker `~/.stash/plugins/`），重启后在「设置 → 插件」能读到设置项即成功。

## 设置

在「设置 → 插件 → ImageMetaSync」配置（默认值已可直接使用）：

| 设置项 | 默认 | 说明 |
|---|---|---|
| Fill tags / title / code | ON | 写入 tag、标题、番号（标题为「标题 #N」编号，封面用纯标题） |
| Fill urls / details | OFF | 写入 url 与简介 |
| Overwrite existing values | OFF | 覆盖已有值；OFF = 只补空字段 |
| Include scenes without a gallery | OFF | 批量任务同时处理无关联图库的场景（只处理封面/fanart/poster） |
| Excluded tags | 空 | 不写入图片的 tag 名称（逗号分隔） |

## 触发方式

| 入口 | 行为 |
|---|---|
| 钩子 Gallery.Create.Post / Gallery.Update.Post | 派生 detached 后台进程处理该图库，立即返回，不阻塞扫描队列 |
| 任务页 "Sync Image Metadata" | 批量处理全部图库；开启上述兜底开关时再处理无图库场景 |

## 核心机制

### 写入字段与来源

| 字段 | 来源 | 取值规则 |
|---|---|---|
| performers | 图库所有关联场景的并集 | 必须唯一，否则整库跳过 |
| studio / date / code / details | 关联场景 | 各场景取值一致才写入，不一致视为无法确认而跳过该字段 |
| urls | 关联场景 | 并集去重 |
| tag_ids | 关联场景 | 并集去重，剔除「Excluded tags」中的名称 |
| title | 图库标题（回退场景标题） | 封面用纯标题，剧照用「标题 #N」 |

### 标题编号

封面写纯标题；剧照写「标题 #N」。N 优先取图片文件名末尾数字（如 `backdrop1.jpg` → 1），无数字或与已用编号冲突时顺延到下一个空号。已有标题的图片默认不改写，其编号计入占用集合，保证同一图库内编号不重复。

### 跳过规则

场景/图库演员数不等于 1 时跳过（无法确认具体演员），日志显式记录图库 ID、标题、关联场景与演员数。多演员场景（如 3 人、4 人）与无演员场景都不写。

### 幂等与并发

- 默认只补空字段，重复运行结果一致。
- 钩子路径用单实例运行锁：已有后台运行中时，本次变更写入队列由运行中的进程代跑，避免并发重入；钩子在 `galleryCreate` 时触发，后台会等图库图片数量稳定后再处理，避免只改到封面。
- 批量任务为单任务串行，不派生子进程。

## 文件说明

| 文件 | 说明 |
|---|---|
| `ImageMetaSync.py` | 主程序：钩子派生、后台运行、图库处理、无图库兜底、批量任务 |
| `stashInterface.py` | Stash GraphQL 接口（含重试） |
| `config.py` | 封面/fanart 文件名约定、后台任务参数 |
| `log.py` | Stash 日志协议封装（后台模式输出纯文本到日志文件） |
| `ImageMetaSync.yml` | 插件清单定义 |

## 注意事项

- 图库的图片集合来自 `findImages(image_filter:{galleries:...})`，含封面与 fanart；无图库场景只按文件名匹配封面/fanart（同 sceneGallerySync 的文件名链规则），不处理剧照。
- 不写 `rating100`、`photographer`、`organized`。
- 后台进程日志在插件目录 `.ims_pending/{gallery_id}.log`，可安全删除该目录。
