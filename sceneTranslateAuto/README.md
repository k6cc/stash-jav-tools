# sceneTranslateAuto

> v1.0.0：首发 — Scene Translate 的纯后台自动化版本，hook 自动翻译场景标题/简介 + 全量扫描任务

Stash 纯后台插件（`interface: raw`，不注入任何页面脚本/样式）：场景创建/更新时自动把标题（title）与简介（details）翻译为目标语言并写回，任务页可对存量场景全量执行同一管线。

与 UI 版 [sceneTranslate](../sceneTranslate/README.md) 的关系：复用同一套翻译引擎（google_free / google_api / microsoft / baidu / deepl / openai）与 `config.json` 密钥格式，但**无页面按钮、无翻译代理、无端口**——Python 后台直接调用翻译 API，写回走 GraphQL `sceneUpdate`。

## 依赖

- Python（Stash 内置运行环境即可，标准库 only，无第三方依赖）
- 需要容器/宿主机可访问翻译 API 外网（google_free 直连 `translate.googleapis.com`；其余引擎按 `config.json` 配置）
- 无需本地端口，Docker 部署**无需映射额外端口**

## 安装

1. 将整个 `sceneTranslateAuto` 文件夹复制到 Stash 插件目录（通常为 Stash 数据目录下的 `plugins/`）
2. 重启 Stash，在「设置 → 插件」中确认 Scene Translate Auto 已启用
3. 新建/更新任意场景即可验证 hook 生效（标题为非目标语言时自动翻译）；任务列表页出现「Full Scan & Translate」即安装成功

## 设置

### Stash 插件设置页

| 设置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| 翻译引擎 / Engine | STRING | `google_free` | `google_free`（免密钥）/ `google_api` / `microsoft` / `baidu` / `openai` / `deepl` |
| 目标语言 / Language | STRING | `zh-CN` | `zh-CN` / `zh-TW` / `en` / `ja` / `ko` 等 |
| 全量扫描并发 / Scan-all concurrency | STRING | `3` | 存量批量翻译线程数；docker/低功耗设备建议 2-3 |

### config.json（插件目录，大部分配置）

支持 `//` 注释，修改**无需重启**（每次处理时重新读取）：

| 配置 | 默认 | 说明 |
|---|---|---|
| 各引擎 API Key | 空 | 选用 `google_free` 以外引擎时必填（字段与 sceneTranslate 一致） |
| `rateLimits` | google_free 3 / baidu 1 / 其余 2 | 引擎级每秒最大翻译请求数（QPS 令牌桶，hook 与全量任务共用） |
| `batchSize` | 10 | 全量任务每次请求合并的场景数（hook 路径固定单场景 title+details 合并一个请求） |
| `codePattern` | `[A-Za-z]{2,10}[-_ ]?\d{2,6}` | 番号正则：全文匹配=纯番号跳过；部分匹配=翻译后原样还原 |
| `minLength` | 4 | 短于此字符数的标题/简介跳过（防番号/缩写/代词误翻） |
| `cacheHours` | 24 | 翻译缓存有效期（小时），内容一致且在有效期内不重复翻译 |

## 触发方式与行为

| 入口 | 触发 | 行为 |
|---|---|---|
| 钩子 `Scene.Create.Post` / `Scene.Update.Post` | 场景创建/更新 | 语言预检（毫秒级，无网络）→ 需翻译则写入 pending 队列并 spawn 单例后台 worker → worker 翻译并写回（hook 立即返回，不阻塞 Stash） |
| 任务「Full Scan & Translate」 | 任务列表页手动点击 | 全库分页扫描存量场景 → 按 `batchSize` 攒批合并翻译 → 并发 + 限速 → 批量写回（缓存跳过已翻译，可中断重跑） |

## 核心机制

**语言判断**（预检，目标语言 zh-CN 示例；en/ja 等目标语言对称）：

| 文本特征 | 判定 | 行为 |
|---|---|---|
| 全文匹配番号（如 `ABC-123`） | 标识符 | 跳过翻译 |
| 含日文假名（`\u3040-\u30ff`） | 日文 | 翻译 |
| 含 CJK 无假名 | 已是中文 | 跳过 |
| 含 CJK 无假名 + 含番号（如 `ABC-123 美少女`） | JAV 日文标题 | 翻译 |
| 纯 ASCII | 英文 | 目标 zh-CN 时翻译；目标 en 时跳过 |
| 短于此 `minLength` | — | 跳过 |

**写回语义**：

- 只写 `title` / `details`，**`code`（番号）字段绝不写**；标题内番号 token 翻译前提取、翻译后原样还原（占位符丢失时自动补回标题开头）
- 翻译结果**已是目标语言**且**与原文不同**才写回（引擎原样返回/半吊子翻译不写）
- 防循环：写回后再次触发 `Scene.Update.Post` → 语言复检（`is_target_language`）拦截，闭环终止
- 后台 worker 单例（pid 锁），同时只跑一个消费进程，低功耗设备友好

**限速与断点**：令牌桶按引擎 QPS 限速（baidu 免费版 QPS=1，勿调高）；翻译缓存按原文快照比对（内容一致跳过，用户改回非目标语言会重新翻译）；失败场景记入 `auto_state/dead_letter.jsonl`（含原因，可查可重跑）。

## 文件说明

| 文件 | 说明 |
|---|---|
| `sceneTranslateAuto.yml` | Stash 插件定义（hooks + 任务 + 3 项设置） |
| `sceneTranslateAuto.py` | 后台逻辑：语言预检、六引擎多段翻译、限速器、缓存、pending 队列与单例 worker |
| `config.json` | 引擎密钥 + 限速/批量合并/番号正则/长度阈值/缓存参数 |

## 注意事项

- 插件会**改写场景的标题与简介**；运行全量扫描前建议先做一次库备份（Stash「设置 → 任务 → 备份」）
- 禁用插件（设置 → 插件 → 关闭）即关闭自动翻译，无需其他开关
- 与 sceneGallerySync 同挂 `Scene.Update.Post`：两者 hook 均只做轻量预检/入队（毫秒级），互相不阻塞；本插件不订阅 Gallery/Image 事件
- 全量任务耗时长（受引擎 QPS 限制，1 万条 × baidu 1 QPS ≈ 数小时），可在任务运行中或中断后重跑，缓存自动跳过已处理场景
- 付费引擎（baidu / microsoft / deepl / openai）按字符/请求计费，批量任务前请确认配额
