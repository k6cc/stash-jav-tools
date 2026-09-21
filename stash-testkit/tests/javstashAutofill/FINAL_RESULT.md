# javstashAutofill+ 演员解析重构 — 验证结论

## 端到端回归（真实测试库 + 真实 javstash + 已部署钩子）18/18 PASS
| 用例 | 验证点 | 结果 |
|---|---|---|
| E2E-1 | 反查命中 → 合并复用 + 创建名追加别名 | PASS |
| E2E-2 | 反查未命中 → 按 stash_id 直抓补全（详情+图片异步） | PASS |
| E2E-3 | 25s 卡顿消除（performerCreate 0.3s 返回） | PASS |
| E2E-4 | 0.9 命中 → 本地别名命中 → 同 id 合并（防重复） | PASS |
| E2E-5 | 保守忽略（候选身份锚定他处 → 保持空白） | PASS |

## 离线单测 test_unified_resolve.py：37/37 PASS

## 过程修复的真实问题
1. javstash 直抓 422：`urls` 是 `[URL!]!` 对象数组 → `urls{ url }` + 归一化
2. 老版本 Stash 无 `names` 过滤器（find_by_name 422 失效）→ 新版本 names / 老版本全量拉取端侧比对回退

## 交付
- 源文件：E:\Temp\stash-jav-tools\javstashAutofill+\javstash_autofill_plus.py（1054 行）
- 部署副本：E:\stashAPP\plugins\k6cc\javstashAutofill+\（MD5 一致）
- 版本：yml version 1.1.4（未变）
- 测试库清理干净：49 演员、无 TST 残留、perf 6 别名/ids 复原
