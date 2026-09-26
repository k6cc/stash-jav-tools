# tests/binge/NOTES.md — binge 播放链路实测

> 本目录除首页热门探测外，还放**流媒体播放实测探针**。Stash 流媒体端点机制、浏览器播放能力、探针判读口径都记在这里。

## Stash 流媒体端点（v0.31.1 源码 + 本地实例实证）

三种端点的 seek 机制完全不同，前端必须区分对待：

| | MP4/WebM 转码 | HLS | DASH |
|---|---|---|---|
| 端点 | `/scene/{id}/stream.mp4` | `/scene/{id}/stream.m3u8` | `/scene/{id}/stream.mpd` |
| 段格式 | 无（渐进流） | **mpegts**（`-hls_segment_type mpegts`） | **WebM**（`_v.webm` / `_a.webm`） |
| 编码 | h264 + aac | h264 + aac | **vp9 + opus** |
| `?start=N` | **有效**（`streamTranscode` → `ffmpeg -ss`） | **无效**（manifest 路由不读 start） | 无效（按段号） |
| seek 方式 | 重建 src 带 `?start=` | 浏览器按段号请求 `/stream.m3u8/{N}.ts` | 客户端自己算段号 |

HLS 段调度常量（`pkg/ffmpeg/stream_segmented.go`）：段长 2s、`maxSegmentBuffer=15`（领先 15 段即停止转码，下次取段 `-ss` 冷重启，实测冷启动 1.5~1.8s）、`maxSegmentGap=5`（段号跳跃 >5 判定为 seek 并重启 ffmpeg）、`maxSegmentWait=15s`（段生成超时返回 500）、`maxIdleTime=30s`（空闲则停转码并**删除整个缓存目录**）。

DASH manifest：段长 2s、`startNumber=0`、`init_v.webm` + `$Number$_v.webm`。`MediaSource.isTypeSupported('video/webm; codecs="vp9"')` = true，**WebM 段可直接 appendBuffer，不需要 transmux**（这是 DASH 相对 HLS 的关键差异）。

HLS/DASH 都要求 Stash 配置了 Cache 目录，否则 manifest 端点返回 503。

## 浏览器播放能力（2026-09 现状）

- **Chrome 141/142+ 才原生支持 HLS**（flag `ENABLE_HLS_DEMUXER`），Edge 142+ 同源继承，桌面 Firefox 仍不支持。
- Chrome 原生 HLS 有已知缺陷（Mux 2025-10 事故报告：141/142 会让所有 HLS 内容报错，官方建议优先 MSE）。实测其**前向缓冲只有约 10s**，而 Stash 服务端每约 30s 有 1.5~1.8s 冷重启 → 每 30~35s 一次可见转圈；段缺 SPS/PPS 时会**永久冻结且 `currentTime` 冻结、`readyState=2`、不触发 `error` 事件**（恢复逻辑必须靠看门狗，不能挂 `onError`）。
- **Chrome 没有原生 DASH**，`<video src="*.mpd">` 播不了，只能走 MSE。
- MSE 不接受 MPEG-TS → **自写 MSE 播 Stash 的 HLS 不可行**（TS→fMP4 转封装只能靠 hls.js 这类库）；DASH 的 WebM 段则可以。
- 分辨率枚举（GraphQL `StreamingResolutionEnum`）：`LOW / STANDARD / STANDARD_HD / FULL_HD / FOUR_K / ORIGINAL`，可拼在流 URL 上（`?resolution=STANDARD`）。

## 脚本清单（本目录 7 个脚本全部可复用，均已参数化，无硬编码）

### 首页热门 / 设置类

| 脚本 | 干什么 | 典型命令 |
|---|---|---|
| `probe_trending.py` | 拉 javstash `sort:TRENDING` 与 `sort:DATE` 两版 top30 对照，可按关键字标位置 | `python probe_trending.py T38-072` |
| `probe_trending_filter.py` | 诊断"某番号为何没进首页热门"：模拟前端过滤链（owned / 日期窗口 / MAX=12 截断），逐条打印 SKIP 原因 | `python probe_trending_filter.py SNOS-397 7`（番号 + lookback 天数，均可省略用默认） |
| `probe_settings.py` | 打印 binge 插件**实际生效**的设置值（排查"改了设置没变化"）；带番号参数时额外查该片演员 gender | `python probe_settings.py SNOS-397` |

### 流媒体播放实测类

| 脚本 | 干什么 | 典型命令 |
|---|---|---|
| `hls_segment_probe.py` | 不开浏览器，脚本模拟"按段取流"的节奏，测服务端段生产延迟与冷重启周期；`--ffprobe` 逐段查时长/PTS/可解码帧 | `python hls_segment_probe.py --scene 244 --minutes 2 --lead 10 --reset-cache --ffprobe` |
| `hls_chrome_probe.py` | 真实 headless Chrome 播放，采样 `currentTime`/`buffered`/`readyState`，统计 waiting 与冻结时长；`--engine native\|hlsjs` 可做 A/B；卡死瞬间抓服务端段状态 | `python hls_chrome_probe.py --scene 244 --seconds 150 --seek 600 --engine hlsjs --hls-buffer 30` |
| `hls_pts_check.py` | 逐段 ffprobe 查 PTS 连续性与实际可解码帧数 | `python hls_pts_check.py --scene 244 --base 300 --spread 10` |
| `dash_mse_probe.js` | 验证 DASH→MSE 可行性：自写极简 MSE 播放器（零第三方库），测起播耗时、缓冲深度、慢段 | 见下节 |

配套两个非脚本文件：

- `_cfg.js`（255B）：`dash_mse_probe.js` 的运行配置，由下面那条命令生成，**改 scene/seconds/resolution 后重新生成即可**。注意它**内嵌明文 API key**，已写入仓库根 `.gitignore`（`stash-testkit/tests/**/_cfg.js`），切勿提交。
- `hls.min.js`（619KB）：`hls_chrome_probe.py --engine hlsjs` 的对照组依赖，**不进插件构建**，同样已在 `.gitignore`（第三方副本不入库）。缺失时 `curl -o hls.min.js https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js` 重建。

## 产物去向

探针跑出来的 `chrome_*.json` / `seg_*.json` 是**一次性输出**，不留在 `tests/`（会让目录显得臃肿），归档到：

```
_archive/binge-hls-probe-outputs-2026-09-26/    # 2026-09-26 那轮 HLS 排查的原始采样
```

这些 JSON 的 URL 字段里带明文 API key，已由 `.gitignore` 的 `stash-testkit/_archive/**/*.json` 排除（`.md` 结论仍入库）。

结论性文档在 `_archive/binge-hls-playback-2026-09-26.md`。

### dash_mse_probe.js 用法（必须同源页面注入）

Stash 流端点**没有 CORS 头**，跨域 `fetch` 会失败。做法：用 CDP 打开 Stash 同源页面（如 `http://127.0.0.1:9999/login`），再注入脚本；段 URL 用 manifest 里自带的 apikey（无需登录态）。

```bash
# 1) 生成配置（apikey 从 config.json 读）
python -c "import json;k=json.load(open('config.json'))['api_key'];open('tests/binge/_cfg.js','w').write('window.__DASHCFG__={scene:244,seconds:30,seek:0,bufferTarget:25,apikey:%s};'%json.dumps(k))"

# 2) 启调试浏览器（--remote-allow-origins=* 必带，否则 cdp.py 握手 403）
python <skill>/scripts/start_chrome.py --headless \
  --extra --autoplay-policy=no-user-gesture-required

# 3) 打开同源页 → 注入配置 → 注入探针 → 等结果
python <skill>/scripts/cdp.py open "http://127.0.0.1:9999/login"
python <skill>/scripts/cdp.py eval --file tests/binge/_cfg.js
python <skill>/scripts/cdp.py eval --file tests/binge/dash_mse_probe.js
python <skill>/scripts/cdp.py --timeout 120 wait "window.__RESULT__"
python <skill>/scripts/cdp.py eval "JSON.stringify(window.__RESULT__.summary)"
```

判读口径：`summary.waitingCount` 是卡顿次数、`maxFreezeSec` 是最长冻结、`leadMedian/leadMin` 是缓冲领先深度（**领先深度 > 服务端冷重启耗时 1.7s 才不会露出转圈**）、`slowSegs` 是单段生成 >1s 的记录。脚本运行中可查 `window.__STAGE__` / `window.__LIVEERR__` 定位卡在哪一步。

## 环境坑

通用坑（headless 媒体时钟、CDP `--remote-allow-origins`、测流要同源注入）见主 `README.md` 硬约束「运行时」「工具链」两节，不在此重复。

本目录探针专属：

- ffprobe 在 `C:\Users\k6cc\Downloads\Programs\ffmpeg-8.0.1-essentials_build\bin\`（`hls_segment_probe.py --ffprobe` 会自动找，找不到再手动指）。
- 要看服务端转码启停时序时开 Debug 日志（方法见 README），读 `[transcode]` 行。
- `hls.min.js` 仅用于 `--engine hlsjs` 对照组，**不进插件构建**。
