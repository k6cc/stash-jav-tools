# javstashAutofill 脚本总览

> 业务语义与插件实现见 `../../javstashAutofill+/README.md`；通用硬约束见 testkit 根 [`README.md`](../../README.md)。本文件只写脚本：验什么、怎么跑、会不会写数据。

插件：`E:\Temp\stash-jav-tools\javstashAutofill+`，部署副本 `E:\stashAPP\plugins\k6cc\javstashAutofill+`。

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `test_unified_resolve.py` | 统一演员解析决策树：主名/别名防重、stash-id 反查、merge、0.9 保守忽略、build_update | `python test_unified_resolve.py` | 不需要；离线 mock，0 写入 |
| `test_cover_race.py` | 封面 blob 锁竞态：auto 判别、1/2/4s 退避重试、封面独立提交 | `python test_cover_race.py` | 不需要；离线，0 写入 |
| `test_tag_create_null.py` | `find_or_create_tag` 预查 + tagCreate 返回 null 的兜底扫描 | `python test_tag_create_null.py` | 不需要；离线 mock |
| `test_code_extract.py` | 番号正则：HEYZO / 092026-001 / FC2 / FC2PPV 优先级 | `python test_code_extract.py` | 不需要；离线 |
| `test_strip_bd.py` | BD 后缀剥离：`CWPBD-98→CWP-98`、真 BD 码不误伤 | `python test_strip_bd.py` | 不需要；离线 |
| `test_scrape_retry.py` | 网络类失败（EOF/超时/拒连）只重试一次，非网络错误不重试 | `python test_scrape_retry.py` | 不需要；离线 |
| `probe_javstash.py` | 直连 javstash 探测：按番号 / 演员名 / stash-id 直抓 | `python probe_javstash.py --code CWP-98`；`--performer "Yua Mikami"`；`--fetch <uuid>` | 需要实例；只读，有网络请求（限流敏感，已内置 sleep） |
| `test_e2e.py` | 真库 + 真 javstash 的 6 条演员解析用例（命中合并 / 直抓补全 / 卡顿消除 / 别名 / 保守忽略 / 字段断言） | `python test_e2e.py` | 需要实例 + 已部署插件；**写数据**：创建/合并演员 |
| `test_e2e_strip.py` | 真实场景（219）改 code 触发 BD 兜底，验证本地 code 保留、stash_id 与空字段补全 | `python test_e2e_strip.py` | 需要实例；**写数据**：场景快照恢复 + 清理新建演员 |

## 跑法约定

- 这批脚本都在 `scripts/` 内，可任意目录执行；内部按 `__file__` 上溯定位 testkit 根与插件源码，不依赖当前工作目录。
- E2E 用例走真实 `Performer.Create.Post` 钩子（spawn 异步，默认延迟 2s），每次创建后需等约 8s 再断言。
- 跑 `test_e2e.py` / `test_e2e_strip.py` 前先确认实例与插件版本（见根 `INVENTORY.md` 的部署任务）。
