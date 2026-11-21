# javstashAutofill（演员补全）验证笔记

插件：`E:\Temp\stash-jav-tools\javstashAutofill+` → 部署到 `E:\stashAPP\plugins\k6cc\javstashAutofill+`。
监听 `Performer.Create.Post`（spawn 异步，默认延迟 2s），按 stash-id 反查 / 直抓补全演员，并做 tag 预查。

## 文件地图

| 位置 | 内容 |
|---|---|
| `scripts/` | 全部脚本（7 个离线单测 + 2 个真库 E2E + 1 个直抓探针），逐个用途/跑法/副作用见 [`SCRIPTS.md`](SCRIPTS.md) |

## 快速验证

1. 离线（不碰实例，约 1s）：`test_unified_resolve.py`、`test_cover_race.py`、`test_tag_create_null.py`、`test_code_extract.py`、`test_strip_bd.py`、`test_scrape_retry.py` —— 全绿说明解析决策树、封面竞态、tag 兜底、番号提取、网络重试都没回归。
2. 真库：`test_e2e.py`（6 条用例）→ `test_e2e_strip.py`（场景 219 BD 兜底）。都会新建/合并演员，先确认可清理。

## 实测环境

- javstash 限流敏感：探测用单请求 + 45s timeout + 请求间 sleep；直抓必须镜像 Stash 客户端头（`ApiKey` + `User-Agent: stash/1.0.0`）。
- 通用 schema 与外部源坑见 testkit 根 `README.md`；v1.2.0 一次性结论见 `_archive/javstashAutofill-v1.2.0-validation.md`。
