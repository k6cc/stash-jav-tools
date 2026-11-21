# SceneBackfill（补档）验证笔记

插件：`E:\Temp\stash-jav-tools\SceneBackfill` → 部署到 `E:\stashAPP\plugins\k6cc\SceneBackfill`。
后端 `SceneBackfill.py`（一次调用一个 op）、守护 `SceneBackfillWorker.py`、前端 `scenebackfill.js`。

## 文件地图

| 文件 | 用途 |
|---|---|
| `../../plugin_op.py` | 任意插件跑 `runPluginOperation`，参数走 JSON（多行规则/正则在 shell 里必被吃引号） |
| `../../state_snapshot.py` | `plugin-data/<id>/state.json` 快照/还原；改状态做 UI 验证前先 snap |

```bash
python stash-testkit/plugin_op.py SceneBackfill '{"mode":"capture","lang":"zh"}'
python stash-testkit/plugin_op.py SceneBackfill --file args.json      # 参数复杂时写文件
python stash-testkit/state_snapshot.py snap SceneBackfill
python stash-testkit/state_snapshot.py restore SceneBackfill
python stash-testkit/deploy_plugin.py E:/Temp/stash-jav-tools/SceneBackfill
python stash-testkit/ui_probe.py --path /plugins/SceneBackfill \
  --selector ".sf-check-name" --sizes 345,390,768,860,1024
```

## 一次完整验证

1. `{"mode":"selftest"}` 六项全绿（qB / 下载目录 / 入库目录 / 空间 / 索引器 / 后台认证）
2. `{"mode":"capture"}` 看状态分布；`{"mode":"search","sceneId":X}` 看 `screen{pass,unknown,fail}`
3. `{"mode":"rules","save":"true",...}` 存完再读一次，确认字段没被吃掉
4. `{"mode":"worker","action":"start"}` → 等 90 s → `{"mode":"worker","action":"status"}` 的 `alive/ago`
5. `{"mode":"progress"}` 的 `conn.ok`（无任务时也会真登录，别只看有没有下载）

状态机：`captured → matched / low_confidence / no_result → pushed → downloaded → importing → imported`，`ignored` 旁路。

## 硬约束（都踩过）

- **数据目录是 `plugin-data`（连字符）**：写成 `plugin_data` 会凭空多出第二个目录，两边的 state 各写各的。
- **`configurePlugin` 是整体替换**：只传一个键会把其余设置全清空（qB 密码这类不可恢复）→ 读出整份、改一项、整份回传。
- **布尔 `false` 参数会被当成"没传"**：后端写 `str(args.get(k,"") or "")` 时 `False or ""` 得空串，开关只能开不能关。
- **页面和守护同时写 `state.json`**：tick 拿的是开场快照，整份写回会盖掉页面刚存的开关/规则 → 按顶层键分工（scenes/control/rules），写前重读。
- **守护进程没有 apikey**：`runPluginOperation` 不保证下发，退回读 `config.yml` 的 `api_key`；自检也必须走同一个函数，否则"实际能连、界面报红"。
- **qB 状态有秒级延迟**：点击后立刻读会读到旧值 —— 页面必须对刚点的按钮做短暂「状态锁」，否则乐观更新被下一次轮询打回去，人看到的就是"点了没反应，刷新才变"。
- **qB 5.x**：`stop`/`start`，4.x 是 `pause`/`resume`（`QB._new_api()` 判版本）；recheck 只能 POST，stopped 状态下 recheck 无效。
- **磁力候选没有文件清单**：`video_bytes` / `largest_video_share` / `filecount` / `files` 四类规则判不了 → verdict `unknown`，`unknown=ask` 时**永不自动推送**（这就是「待确认」的来源，不是数据坏了）。
- **Windows 字节锁**：`daemon.lock` 用 `msvcrt.locking`，锁住后连 `open("r+b")` 都 PermissionError；**不要 unlink 锁文件**（后来者会锁新 inode）。
- **停守护之后再快照**：`stop` 会往 `state.json` 写 `daemon.stopping = true`，这时 snap 出来的快照带着这个标记；还原后点「启动」新 worker 第一轮读到 `stopping` 且 pid 指向自己，会立刻写 `stop requested` 退出（日志里两次 `started` 紧跟 `stop requested`）。修法是先把 `daemon` 整块重置成 `{pid:0,lastTick:0}` 再启动，或等 5 分钟让心跳过期后重新走 stop→start。
- **图标别用 FontAwesome 类名**：这套构建里 `libraries.FontAwesomeSolid` 不保证有某个图标，缺一个就是一块空白；页面内联 SVG（`viewBox 0 0 16 16`、`stroke:currentColor`、`stroke-width:1.6`）才稳定对齐。
- **React 子节点不能字符串拼**：`ico("seed") + " " + n` 会渲染成 `[object Object]`，图标与文字必须作为两个子节点传。

## 界面令牌（v0.2 起）

`scenebackfill.css` 顶部两层令牌：中性面是半透明叠层（`rgba(255,255,255,.05)` / 亮色反向），跟着 Stash 底色自动变；语义色用 Flexoki 双值，靠 `.is-dark` / `.is-light` 切换，组件通过 `.is-h-<hue>` 工具类取 `--c/--cr`。**不要在新组件里写字面色值**，否则换主题就露馅（以前 `select option` 白底白字就是硬编码深色导致的）。

## 「最佳」怎么选

`rank_score = 番号命中 0.6 + 日期命中 0.2 + 搜索词其余重合 ≤0.2 + 后缀 0.25（可选）+ 含「最新地址」文件 0.30（可选）`。
只在 `pass` 里比，同分取做种多的；分数不参与淘汰——淘汰只看规则。
