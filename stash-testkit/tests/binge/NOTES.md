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

## 脚本

`scripts/` 下 7 个脚本（首页热门 / 设置 / HLS / DASH-MSE）的用途、跑法、副作用，以及 `dash_mse_probe.js` 的同源注入步骤与判读口径，统一见 [`SCRIPTS.md`](SCRIPTS.md)。

## 产物去向

探针跑出来的 `chrome_*.json` / `seg_*.json` 是**一次性输出**，不留在 `tests/`，也**不入库**：URL 字段带明文 API key，`.gitignore` 已排除 `stash-testkit/_archive/**/*.json`。

只看结论即可：`_archive/binge-hls-playback-2026-09-26.md`。需要新数据时按 `SCRIPTS.md` 重跑探针。

## 环境坑

通用坑（headless 媒体时钟、CDP `--remote-allow-origins`、测流要同源注入）见主 `README.md` 硬约束「运行时」「工具链」两节，不在此重复。

本目录探针专属：

- ffprobe 在 `C:\Users\k6cc\Downloads\Programs\ffmpeg-8.0.1-essentials_build\bin\`（`hls_segment_probe.py --ffprobe` 会自动找，找不到再手动指）。
- 要看服务端转码启停时序时开 Debug 日志（方法见 README），读 `[transcode]` 行。
- `hls.min.js` 仅用于 `--engine hlsjs` 对照组，**不进插件构建**。
