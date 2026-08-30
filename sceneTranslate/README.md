# Scene Translate

Stash 插件 — 在场景、图片和图库编辑页面添加一键翻译按钮，支持翻译标题和详情。

> v2.9.0：新增插件页「代理端口」设置 — 端口改为插件页统一管理（浏览器与代理启动均读取），CSP 放行任意端口，config.json 的 proxyPort 降级为兜底；改端口后重新运行「Start Translate Proxy」即可。
> v2.8.0：UI 文案跟随 Stash 界面语言 — 按钮提示与错误信息按 Stash 语言设置自动切换中英文。
> v2.7.1：新增幂等守卫 — Stash 重挂插件脚本时不再重复初始化，消除代理探测请求刷屏、MutationObserver 堆积和 pushState 嵌套包装。

## 支持的翻译引擎

| 引擎 | 需要代理 | 需要密钥 | 说明 |
|------|---------|---------|------|
| `google_free` | 否 | 否 | Google 免费翻译，开箱即用（代理离线时走浏览器直连兜底） |
| `google_api` | 是 | API Key | Google Cloud Translation API |
| `microsoft` | 是 | API Key | Microsoft 翻译 |
| `baidu` | 是 | App ID + 密钥 | 百度翻译 |
| `deepl` | 是 | API Key | DeepL 官方 API 或 DeepLX 中转 |
| `openai` | 是 | API Key | OpenAI 或兼容 API |

## 安装

将 `sceneTranslate` 文件夹放入 Stash 的 `plugins` 目录：

```
~/.stash/plugins/sceneTranslate/
├── sceneTranslate.js
├── sceneTranslate.css
├── sceneTranslate.yml
├── translateProxy.py
└── config.json          ← 各引擎 API 密钥（端口兜底值）
```

## 配置

配置分两个入口，各司其职：

### Stash 插件设置页（翻译引擎 / 目标语言 / 空闲超时 / 代理端口）

进入 **Stash → 设置 → 插件 → Scene Translate**，可直接设置四项参数：

| 参数 | 说明 | 留空默认值 |
|------|------|-----------|
| 翻译引擎 | `google_free` / `google_api` / `microsoft` / `baidu` / `openai` / `deepl` | `google_free` |
| 目标语言 | `zh-CN` / `zh-TW` / `en` / `ja` / `ko` 等 | `zh-CN` |
| 空闲超时（秒） | 代理无请求时自动关闭的秒数，`0` 表示不自动关闭 | `600` |
| 代理端口 | 翻译代理监听端口，修改后需在插件任务里重新运行「Start Translate Proxy」；Docker 需同步映射该端口 | `9998` |

- 翻译引擎 / 目标语言 / 空闲超时修改后无需重启代理，翻译按钮在页面加载/导航时即时读取最新配置
- 代理端口是浏览器与代理的统一约定：浏览器 JS 与 Python 代理启动时都读本设置，改端口只需在插件页改一处
- `google_free` 无需代理与密钥，开箱即用

### config.json（各引擎 API 密钥）

`config.json` 仅存放各引擎的 API 密钥（支持 `//` 注释）；`proxyPort` 仅在插件页未设置端口时作兜底：

```json
{
  // 代理端口（兜底值，以 Stash 插件页的「代理端口」为准）
  "proxyPort": 9998,

  // 各引擎的 API Key（按需填写，选用对应引擎时必填）
  "googleApiKey": "",
  "microsoftApiKey": "",
  "microsoftRegion": "global",
  "baiduAppId": "",
  "baiduSecret": "",
  "openaiApiKey": "",
  "openaiModel": "gpt-4o-mini",
  "openaiBaseUrl": "",
  "deeplApiKey": "",
  "deeplFreeApi": false,
  "deeplBaseUrl": ""
}
```

修改 `config.json` 后需重启代理生效。

### 适用页面

翻译按钮会注入到以下编辑页面的 Title 和 Details 字段旁：

- 场景编辑页：`/scenes/{id}`
- 图片编辑页：`/images/{id}`
- 图库编辑页：`/galleries/{id}`

### Google Free（无需代理）

选择 `google_free` 引擎后，无需任何额外操作，刷新页面即可使用翻译按钮：

- 代理在线时优先走代理（Python 端请求 Google）
- 代理离线时自动走浏览器直连 `translate.googleapis.com`（需浏览器本机能访问 Google）

### 百度 / Microsoft / Google API / OpenAI（需要代理）

1. 在 `config.json` 中填写对应引擎的 API 密钥
2. 启动代理服务器：
   ```bash
   cd ~/.stash/plugins/sceneTranslate
   python translateProxy.py
   ```
   代理会自动加载同目录下的 `config.json`
3. 也可以在 Stash 的任务页面点击 **Start Translate Proxy**

### DeepL（官方 API 或 DeepLX 中转）

DeepL 支持两种模式：

**官方 API：**
- 填写 `deeplApiKey`（从 https://www.deepl.com/pro-account/registration 获取）
- `deeplFreeApi` 设为 `true` 使用免费版（api-free.deepl.com），`false` 使用 Pro 版（api.deepl.com）
- `deeplBaseUrl` 留空

**DeepLX 中转：**
- `deeplBaseUrl` 填写完整翻译接口地址，如 `http://192.168.3.190:1188/translate`
- `deeplApiKey` 填写 DeepLX 的访问令牌（如果 DeepLX 启用了 `-token` 参数）；无令牌则留空
- `deeplFreeApi` 在中转模式下无效，可忽略

## Docker 部署

Stash 官方 Docker 镜像已预装 Python，插件开箱即用。插件会**自动检测 Docker 环境**并适配：

- **代理监听**：自动绑定 `0.0.0.0`（裸机仍绑定 `127.0.0.1`，更安全）
- **浏览器代理 URL**：自动用访问 Stash 的 host（如 `http://192.168.1.100:9999` → 代理 URL 推断为 `http://192.168.1.100:9998`）
- **无需改 `config.json`**：Docker 检测和 host 推断都是自动的

**唯一需要手动操作**：映射代理端口 9998，让容器外的浏览器能访问容器内的代理。

### docker-compose.yml

```yaml
services:
  stash:
    image: stashapp/stash:latest
    ports:
      - "9999:9999"   # Stash Web 端口（已有）
      - "9998:9998"   # 翻译代理端口（新增）
    volumes:
      - ./data:/data
      - ./stash:/root/.stash
      # 插件目录挂载（安装插件后）
      - ./plugins:/root/.stash/plugins
```

### docker run

```bash
docker run -d \
  -p 9999:9999 \
  -p 9998:9998 \
  -v ./data:/data \
  -v ./stash:/root/.stash \
  --name stash stashapp/stash:latest
```

> 仅使用 `google_free` 引擎时无需映射 9998 端口（浏览器直连 Google，不经过代理）。使用其他引擎（Google API / Microsoft / Baidu / DeepL / OpenAI）时必须映射。

## 代理生命周期

- **自动启动**：Stash 加载插件时自动启动代理后台进程
- **优雅退出**：关闭 Stash 后代理自动检测并退出（TCP 端口检测）
- **空闲超时**：无翻译请求超过设定秒数后自动关闭（默认 600，可在 Stash 插件页配置；每次翻译请求会动态更新计时）
- **手动重启**：在 Stash 任务页面点击 **Start Translate Proxy** 可重启代理
- **配置重载**：修改 `config.json`（端口 / API 密钥）后需重启代理才能生效；翻译引擎 / 目标语言 / 空闲超时在 Stash 插件页修改，无需重启代理

## 代理 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config` | GET | 返回代理在线状态（引擎/语言以浏览器从 Stash 插件页传入为准） |
| `/translate` | POST | 翻译文本（请求体含 `engine`/`targetLang`/`idleTimeout`） |
| `/status` | GET | 查询代理状态和配置 |
| `/shutdown` | POST | 优雅关闭代理 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `config.json` | 代理端口 + 各引擎 API 密钥（支持 `//` 注释） |
| `sceneTranslate.js` | 前端脚本，注入翻译按钮 |
| `sceneTranslate.css` | 样式 |
| `sceneTranslate.yml` | Stash 插件定义（含翻译引擎/语言/超时设置项） |
| `translateProxy.py` | Python 翻译代理（绕过 CORS） |
