# Scene Translate

Stash 插件 — 在场景和图片编辑页面添加一键翻译按钮，支持翻译标题和详情。

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
└── config.json          ← 编辑此文件配置
```

## 配置

所有设置在 `config.json` 中，支持 `//` 注释：

```json
{
  // 翻译引擎: google_free / google_api / microsoft / baidu / deepl / openai
  "translateTool": "google_free",

  // 目标语言: zh-CN, en, ja, ko ...
  "targetLanguage": "zh-CN",

  // 代理端口
  "proxyPort": 9998,

  // 空闲超时（秒），0 表示不自动关闭
  "idleTimeout": 600,

  // 各引擎的 API Key（按需填写）
  ...
}
```

修改 `config.json` 后需重启代理生效。

## 使用方式

### 适用页面

翻译按钮会注入到以下编辑页面的 Title 和 Details 字段旁：

- 场景编辑页：`/scenes/{id}`
- 图片编辑页：`/images/{id}`

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
- `deeplApiKey` 填写 DeepLX 的访问令牌（如果 DeepLX 启动了 `-token` 参数）；无令牌则留空
- `deeplFreeApi` 在中转模式下无效，可忽略

## 代理生命周期

- **自动启动**：Stash 加载插件时自动启动代理后台进程
- **优雅退出**：关闭 Stash 后代理自动检测并退出（TCP 端口检测）
- **空闲超时**：无翻译请求超过 `idleTimeout` 秒后自动关闭
- **手动重启**：在 Stash 任务页面点击 **Start Translate Proxy** 可重启代理
- **配置重载**：修改 `config.json` 后需重启代理才能生效

## 代理 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/config` | GET | 返回浏览器端配置（引擎、目标语言） |
| `/translate` | POST | 翻译文本 |
| `/status` | GET | 查询代理状态和配置 |
| `/shutdown` | POST | 优雅关闭代理 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `config.json` | 配置文件（支持 `//` 注释） |
| `sceneTranslate.js` | 前端脚本，注入翻译按钮 |
| `sceneTranslate.css` | 样式 |
| `sceneTranslate.yml` | Stash 插件定义 |
| `translateProxy.py` | Python 翻译代理（绕过 CORS） |
