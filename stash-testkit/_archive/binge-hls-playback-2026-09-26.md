# binge · HLS 流式传输卡顿/卡死排查（2026-09-26, Stash v0.31.1）

**一句话结论**：binge 的「HLS 流式传输」在 Chrome 上的卡顿与永久转圈，**根因是 Stash 服务端每约 30s 冷重启一次 ffmpeg（1.5~1.8s）+ Chrome 原生 HLS 缓冲只有约 10s 且对缺 SPS/PPS 的 TS 段会永久冻结不报错**，不是 binge 播放器代码的问题；社区（Mux 2025-10 事故报告）对 Chrome 原生 HLS 的共识是"优先 MSE 而非原生"。**最终决策：不为 Chrome 做兼容改造，不写进构建与插件文档；Chrome/Windows/Android 上用户自行避开 HLS 选项。**

## 现象

用户设置「流媒体类型 = HLS 流式传输」后：

1. MP4 直连正常；wmv 需转码时拖动进度条**画面从头播放**（时间码正常跳变）；
2. wmv 播放约 40s 后**永久转圈**，显卡转码再无状态；
3. MP4/MKV 首播 30s 后画面卡住约 8s（有声音），之后约每 1 分钟转圈 1s。

## 根因链（每项都有实测证据）

| 层 | 事实 | 证据 |
|---|---|---|
| 服务端 | ffmpeg 每约 30s 内容被 stop 一次（`maxSegmentBuffer=15`），下次取段 `-ss` 冷重启，**冷启动 1.5~1.8s** | Debug 日志 `[transcode]` 行；脚本模拟取流在 32/64/98/134/168s 出现 ~1.7s 延迟尖峰 |
| 客户端 | Chrome 原生 HLS 前向缓冲**只有约 10s**（p10 6.5s、最小 1.8s），贴着 1.7s 的重启耗时 | 真实 Chrome 采样：mkv 在 73.6/107.3/145.2s 各一次 `waiting`，间隔 ~34s |
| 致命 | wmv 拖到 600s 后播至 677.4s 冻结：`buffered_end` 继续涨到 687.87（领先 10.47s），`currentTime` 不动、`readyState=2`、**没有任何 `error` 事件**；30s 无请求后服务端 idle 清理删掉缓存目录 | `chrome_244_seek*.json`，3/3 稳定复现 |
| 排除项 | 不是时间戳断裂：相邻段 PTS 间隔恒为 2.000s，重启点前后也连续 | `hls_pts_check.py` |
| 诱因 | TS 分段普遍不带 SPS/PPS（约每 8~25 段才出现一次），独立解码报 `non-existing PPS 0 referenced / no frame!` | ffprobe 逐段 |

**推论**：任何挂在 `onError` 上的恢复逻辑都不会触发（卡死时不报错）；恢复只能靠**看门狗**（`currentTime` 停滞计时）。

## 修复尝试与 A/B 结果

- 已做并保留：HLS 下禁用 `?start=` 硬 seek、走原生 `currentTime` seek（`pickStream.isHlsStreamUrl()` + `SceneSlide`）。这修掉了"拖动后画面从头"。
- A/B（同一 wmv、同拖到 600s、同 150s）：**原生 HLS 在 677s 卡死 62~68s 不恢复；hls.js（`maxBufferLength=30`）一路播到 739s、全程 0 次 waiting**。hls.js 有效，但用户明确不引入。
- 硬约束：**不引 hls.js 就无法在 Chrome 上用 MSE 播 Stash 的 HLS** —— Stash 的 HLS 段是 mpegts，MSE 只接受 fMP4/WebM，TS→fMP4 转封装正是 hls.js 的核心工作。

## DASH 作为替代路径的可行性（已实测，未采纳）

Stash 的 `/scene/{id}/stream.mpd` 输出 **WebM 分段（vp9 + opus）**，MSE 可直接 `appendBuffer`、**无需转封装**：

| 指标 | 实测（scene 244, wmv, 1080p） |
|---|---|
| 起播 | init 段 1.18s append 完成，1.60s `canplay` + `playing` |
| 缓冲深度 | 自主拉到 **20~22s**（原生 HLS 只有 10s） |
| 慢段 | 2 次 × 1.01s，无 error |
| 段生成性能 | init 0.47s / 首段 0.36s / 后续 0.15s |

结论：技术路径成立，缓冲深度自控能完全吸收服务端 1.7s 尖峰。**未采纳**：headless 软解 1080p VP9 时画面在 12.1s 处冻结（有数据但不动），需真机 GPU 复测；且用户已决定不为 HLS 做改造。

## Safari 上的推测（未实测，本机无 Safari）

- Safari（macOS/iOS）是 HLS 的原生实现方，iOS 上由系统 AVPlayer 接管，与 Chrome 141+ 才仓促上线的 demuxer 不是一个成熟度；Stash 官方也把 HLS 定位为「such as on Apple devices」。
- 服务端每 30s 冷重启 1.7s 是**与浏览器无关**的，但 Safari 的前向缓冲通常明显深于 Chrome 的 10s，1.7s 的尖峰大概率被吸收掉 → **推测"每 30s 转圈一次"在 Safari 上不会出现或显著更轻**。
- 缺 SPS/PPS 的 TS 段：AVPlayer 的容错强于 Chrome 的 demuxer → **推测"永久冻结"大概率不会出现**，但这点不确定性最大，是需要真机验证的第一项。
- 若要在 iOS/macOS 上确认，验证顺序：先连续播 3 分钟看有无周期转圈，再拖到 10 分钟处看是否从目标位置续播且不再冻结。

## 决策与后续

- binge 不为 Chrome/Edge 增加 HLS 兼容逻辑（不做看门狗降级、不接 hls.js、不加 DASH 选项）。
- 插件 README / 汉化及修复.md **不记录**此项（用户指定）。
- 已保留的改动仅限"HLS 下不走 `?start=` 硬 seek"，那是真实的 seek bug 修复，与浏览器兼容无关。
