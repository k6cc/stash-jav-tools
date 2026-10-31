# stashDiscover — 脚本总览

> 所有脚本都在 **`scripts/`** 子目录。每个脚本验什么、会不会写数据、怎么跑 —— 挑脚本看这里，别靠文件名猜。
> 业务口径见 [SEMANTICS.md](SEMANTICS.md) / [FEATURES.md](FEATURES.md)，历史见 [HISTORY.md](HISTORY.md)。

## 通用跑法

页面内探针（`probe_*.js`）都在页面上下文执行，统一走 `stash_dev.py eval`：

```bash
cd E:/stashAPP/devtools
MSYS_NO_PATHCONV=1 python stash_dev.py eval \
  "$(cat /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/<脚本>.js)" \
  --path /plugins/stashDiscover --settle 5 --timeout 200
```

- 结果是**一段 JSON**，探针各自带 `stage` 字段，卡在哪一步一眼看得出。
- 演员页相关探针用 `--path /`（直接 `/performers/<id>` 会被 SPA 弹回首页，探针内部自己 `pushState`）。
- 移动端布局加 `--vsize 390x844`；`shot` 子命令也支持 `--vsize`。
- 断言前必须等元素出现（异步渲染/预载/回填），点击后立刻读 DOM 拿到的是中间态。
- `shot --js` 要包成 `(async()=>{...})()`；`console` 子命令不支持 `--settle`。细节见 [PITFALLS.md](PITFALLS.md)「测试方法」。

## 网络层

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_429_backoff.js` | 429 退避：两次 429 后成功（2s+4s）／`Retry-After` 超上限直接报错不重试／重试耗尽带 `retried 2x`／500 不重试／被限流的源下一次至少隔 1s／没被打过的源零排队（< 200ms） | 否，全程 mock `fetch`。用 `--path /`（任何加载了 `SSD` 的页面都行，不需要进插件页） |

## 发现页

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_batch_select.js` | 多选入口 / 点选 / 全选 / 批量忽略 + 撤销 / 列表模式 / 退出 | 写忽略记录，测完撤销并核对条数还原 |
| `probe_search_scroll.js` | 点「搜索资源」后滚到底、渲染后抬头对齐、每条结果带索引器标签 | 否 |
| `probe_search_btns.js` | 搜索结果行内五类按钮（ghost / tonal / ok / err）+ 低匹配折叠条 | 否，灌假结果 |
| `probe_cache_tags_index.js` | `cacheWrite` → `cacheRead` 往返：下标逐位还原、老格式兼容、`totalSeen` | 重写缓存条目，结束复原 |
| `probe_cache_trim_setup.js` | **前置**：把 trending 缓存人为裁到 10 条（`totalSeen` 不动） | 是，只动缓存 |
| `probe_cache_trim_chip.js` | 「缓存不完整」chip 出现 → 点击 → 重拉后消失（须先跑 setup） | 是，走刷新重拉 |
| `probe_localstorage.js` | localStorage 配额上限、各键占用、版本孤儿清单 | 临时写入后删除，不动既有键 |

## 演员页「发现」tab

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_tab_select.js` | tab 的多选入口 / 点选 / 全选 / 批量忽略 + 撤销 / Esc 退出（含勾选圈 24px 断言） | 写忽略记录，测完还原 |
| `probe_ignored_show.js` | 全被忽略 → 空态入口 → 8 卡 8 徽章 + chip → 恢复隐藏 | 写忽略记录，按前后差集删 |
| `probe_reignore.js` | 已忽略的场景再忽略一次：幂等 / 不抛异常 / 撤销不误删更早记录 | 写忽略记录，按差集还原 |

## 忽略记录与已忽略管理页

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_ign_export.js` | 快照字段、`IGN_TEXT_CAP` 截断、导出结构、导入握手与无效条目计数 | **会临时清空 `ignore.v1`**，跑完还原 |
| `probe_ignored_page.js` | `?view=ignored`：搜索 / 切 tab / 分页 / 单条恢复 / 还原全部 / 淘汰提示 / 渲染耗时 | 自动还原 `ignore.v1` |

## 弹窗与按钮

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_back_key.js` | 返回键关 7 个弹窗、pathname 不变、× 关闭不留 history 垫层 | 只读 |
| `probe_banbtn_parity.js` | 忽略按钮在「场景弹窗 / 演员弹层」两容器 idle·armed·无 token 三态逐值一致 | 只读 |
| `probe_modal_acts.js` | 场景弹窗四颗按钮分类配色、文案层与图标层分离、跨容器圆角字号 | 只读 |
| `probe_import_dialog.js` | 入库弹窗三分支 + 字段开关持久化（`import.v1`） | 只开不确认，还原 `import.v1` |
| `probe_perf_detail_cache.js` | 演员详情冷 1 请求 / 热 0 请求 / 入库预览 0 请求 | 只读 |
| `probe_perf_box_queries.js` | 弹层与入库两条 box query 的体积与耗时对比 | 只读 |

## 移动端

| 脚本 | 验什么 | 会写数据吗 |
|---|---|---|
| `probe_mobile_stick.js` | 顶栏 position/height、sticky 元素实际位置、滚动后间隙 | 只读，配 `--vsize 390x844` |

## 不起浏览器的独立脚本

| 脚本 | 用途 |
|---|---|
| `probe_tpdb_api.py` | TPDB REST 语义的**唯一事实来源**：批量 deepObject、uuid→整数 id、`site_operation`、分页上限。改 `tpdb*` 前先跑 |
| `node_tpdb_harness.js` | 在 Node 里加载插件的 TPDB 适配层跑真实源，不起 UI 也能验；`--only` 单跑用例，`TPDB_DEBUG=1` 打请求日志 |
| `verify_add_to_library.py` | 「加入库」全链路（演员建档 → 工作室 → 标签 → sceneCreate → 封面候选链），`--source stashdb\|javstash\|theporndb`，默认 dry-run，`--apply` 写库，`--cleanup` 删场景 |

## 文档提到但已不在目录

以下探针是早期一次性验证，文件已删，结论保留在对应语义节 —— 别去找它们：

`probe_ignore_scene.js`、`probe_ignore_poll_stub.js`、`probe_ignore_ui.js`（忽略三处生效点，见 [SEMANTICS.md](SEMANTICS.md)「忽略记录」）、
`probe_ignore_performer.js`（查询摘除，见 [FEATURES.md](FEATURES.md)「忽略演员三处链路」）、
`probe_cache_shape.js`（读时 shape 校验，见 [SEMANTICS.md](SEMANTICS.md)「本地存储」）、
`probe_drill_layout.js`、`probe_unread_drill.js`（钻取分页与已读，对应功能已稳定）。
