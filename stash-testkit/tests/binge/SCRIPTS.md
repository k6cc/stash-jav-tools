# binge 脚本总览

> 流媒体端点机制、浏览器播放能力、探针判读口径的背景见 [`NOTES.md`](NOTES.md)；通用硬约束见 testkit 根 [`README.md`](../../README.md)。

## 首页热门 / 设置

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `probe_trending.py` | 拉 javstash `sort:TRENDING` 与 `sort:DATE` 两版 top30 对照，可按关键字标位置 | `python probe_trending.py [番号]` | 需要实例 + 网络；只读 |
| `probe_trending_filter.py` | 诊断某番号为何没进首页热门：模拟前端过滤链（owned / 日期窗口 / MAX=12 截断），逐条打印 SKIP 原因 | `python probe_trending_filter.py [番号] [lookback天数]` | 需要实例 + 网络；只读 |
| `probe_settings.py` | 打印 binge 插件**实际生效**的设置；带番号时额外查该片演员 gender | `python probe_settings.py [番号]` | 需要实例；只读 |

## 流媒体播放实测

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `hls_segment_probe.py` | 不开浏览器，模拟"按段取流"节奏，测服务端段生产延迟与冷重启周期；`--ffprobe` 逐段查时长/PTS/可解码帧 | `python hls_segment_probe.py --scene 244 --minutes 2 --lead 10 --reset-cache [--ffprobe]` | 需要实例；只读，产生转码缓存 |
| `hls_chrome_probe.py` | 真实 headless Chrome 播放，采样 `currentTime`/`buffered`/`readyState`，统计 waiting 与冻结；`--engine native\|hlsjs` 做 A/B | `python hls_chrome_probe.py --scene 244 --seconds 150 [--seek 600]` | 需要实例 + 本机 Chrome/Edge；只读 |
| `hls_pts_check.py` | 人为制造一次转码重启，用 ffprobe 比较重启前后段的起始 PTS，判断能否无缝续播 | `python hls_pts_check.py --scene 244 --base 300 --jump 340` | 需要实例 + ffprobe；只读 |
| `dash_mse_probe.js` | 验证 DASH→MSE 可行性：极简 MSE 播放器（零第三方库），测起播耗时、缓冲深度、慢段 | 见下方注入步骤 | 需要实例 + CDP 调试浏览器；只读 |

配套文件（都在 `scripts/`）：

- `_cfg.js`：`dash_mse_probe.js` 的运行配置，**内嵌明文 API key**，已由 `.gitignore`（`tests/**/_cfg.js`）排除，切勿提交；改 scene/seconds/resolution 后重新生成即可。
- `hls.min.js`（约 600KB）：`hls_chrome_probe.py --engine hlsjs` 的对照组依赖，不入库；缺失时 `curl -o hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js` 重建。

## dash_mse_probe.js 注入步骤

Stash 流端点**没有 CORS 头**，跨域 `fetch` 会失败：必须用 CDP 打开 Stash 同源页面（如 `http://127.0.0.1:9999/login`）再注入；段 URL 用 manifest 自带的 apikey（无需登录态）。

```bash
# 1) 生成配置（apikey 从 config.json 读）
python -c "import json;k=json.load(open('config.json'))['api_key'];open('tests/binge/scripts/_cfg.js','w').write('window.__DASHCFG__={scene:244,seconds:30,seek:0,bufferTarget:25,apikey:%s};'%json.dumps(k))"

# 2) 启调试浏览器（--remote-allow-origins=* 必带，否则握手 403）
python <skill>/scripts/start_chrome.py --headless \
  --extra --autoplay-policy=no-user-gesture-required

# 3) 同源页 → 注入配置 → 注入探针 → 等结果
python <skill>/scripts/cdp.py open "http://127.0.0.1:9999/login"
python <skill>/scripts/cdp.py eval --file tests/binge/scripts/_cfg.js
python <skill>/scripts/cdp.py eval --file tests/binge/scripts/dash_mse_probe.js
python <skill>/scripts/cdp.py --timeout 120 wait "window.__RESULT__"
python <skill>/scripts/cdp.py eval "JSON.stringify(window.__RESULT__.summary)"
```

判读：`waitingCount` 卡顿次数、`maxFreezeSec` 最长冻结、`leadMedian/leadMin` 缓冲领先深度（**需 > 服务端冷重启 1.7s 才不露转圈**）、`slowSegs` 单段生成 >1s；运行中看 `window.__STAGE__` / `window.__LIVEERR__` 定位卡点。

## 输出

`chrome_*.json` / `seg_*.json` 是一次性采样，**不留在 `tests/`**，结论进 `_archive/binge-hls-playback-2026-09-26.md`；原始输出不入库（`.gitignore` 已排除 `_archive/**/*.json`，且 URL 带 apikey）。
