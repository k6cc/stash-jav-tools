# 截图 — Stash UI → 论坛帖

为插件生成可直接贴到论坛帖的截图（`docs/stashdiscover-*.png`）。演员 / 场景 / 工作室 / 标签 / 番号等真实内容统一替换为占位符。

## 快速开始

```bat
:: 1. 起带调试端口的 Chrome（自动打开 Stash）
stash-testkit\screenshots\launch-chrome.bat

:: 2. 首次：复制凭据模板并填账号密码（creds.json 已 gitignore）
copy stash-testkit\screenshots\creds.sample.json stash-testkit\screenshots\creds.json

:: 3. 跑场景（输出写入仓库 docs\）
node stash-testkit\screenshots\scenarios\stashdiscover-discover-page.mjs
node stash-testkit\screenshots\scenarios\stashdiscover-performer-tab.mjs 136
```

前置：Node ≥ 22（内置 `WebSocket` / `fetch`）、Stash 跑在 `http://localhost:9999`。

## 文件

| 文件 | 作用 |
|---|---|
| `capture.mjs` | CDP 会话工厂：连接 / 登录 / 导航 / 等元素 / 截图（含全页） / 注入占位符 |
| `anon-stash.js` | 占位符注入器（document-wide，覆盖发现页 / 演员·工作室详情页 / 弹窗） |
| `launch-chrome.bat` | 起带 `--remote-debugging-port=9333` 的 Chrome |
| `creds.sample.json` | 凭据模板 → `creds.json`（账号密码，已 gitignore） |
| `scenarios/<插件名>-<视图>.mjs` | 场景脚本，输出固定写 `docs/<插件名>-*.png` |

## 占位符规范（anon-stash.js）

| 类型 | 替换为 |
|---|---|
| 演员头像 | 人形占位 SVG（2:3） |
| 场景封面 / 弹窗轮播 | 播放图标占位 SVG（16:9） |
| 工作室图 | 建筑占位 SVG（4:3） |
| 演员名 / 别名 | `Performer A…` / `别名：Alias A / Alias B` |
| 场景标题 / 简介 | `Sample Scene A…` / `Placeholder synopsis…` |
| 工作室名 | `Studio A…`（分组 chip 保留「· N」计数） |
| 弹窗番号 / 导演 | `CODE-001` / `Director A` |
| 标签 | `Tag A…H` |

保留真实：数量、日期、时长、评分、界面文案、布局结构。同一原始值恒定映射到同一占位符（`A`/`B`/`C`…），跨图一致。

`anon-stash.js` 末尾用 `setInterval(apply, 250)` 持续重应用——SPA 重渲染会把真实内容刷回来，一次性替换不够。

## 编写新场景

```js
import { createSession } from "../capture.mjs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "../../..", "docs");
const s = await createSession({ port: 9333, width: 1600, height: 1000, dsf: 2 });
await s.loginIfNeeded();
await s.navigate("http://localhost:9999/performers/136");
await s.waitFor("!!document.querySelector('.performer')", 60000);
await s.injectAnon();
await s.shot(path.join(OUT, "stashdiscover-performer-136.png"), { full: true });
s.close();
```

会话方法：`navigate(url)` / `waitFor(expr, ms)` / `ev(js)` / `shot(file, {full})` / `clickTab(label)` / `gotoDiscoverPage()` / `injectAnon([path])` / `close()`。

## 截完校验（必做）

脚本跑完用正则抽查占位是否漏项，确认无真实人名 / 日文标题 / 工作室名 / 番号：

```js
await s.ev("JSON.stringify({names:[...document.querySelectorAll('.performer-name')].map(e=>e.textContent).slice(0,5)})")
```

## 注意

- 截图只改浏览器内存里的 DOM，不写 Stash 库；Chrome 用临时 profile 即可。
- 登录页提交按钮是 `input[type=submit]`（不是 `button`），填值必须走原生 setter + `input`/`change` 事件（`capture.mjs` 已封装）。
- 演员详情页插件 tab 注入结构是 `.nav-item.ssd-tab > a.ssd-nav-link`，需 `waitFor` 到注入完成再点。
- 断言/截图前先等目标元素出现并留 1.5–2.5s 渲染，否则截到 loading 中间态。
