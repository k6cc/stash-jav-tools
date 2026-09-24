# stash-testkit 经验注意（NOTES）

> 本文件沉淀跨任务可复用的踩坑与调用约定；config.json（含 JWT API Key）已被 .gitignore 忽略，**切勿提交**。

## 本地 Stash 接入

- 启动：`Start-Process E:/stashAPP/stash-win.exe --nobrowser`，监听 `http://localhost:9999/graphql`；无 `--nobrowser` 会拉起浏览器。
- 认证：GraphQL 请求必须**双发** `ApiKey:` 与 `Authorization: Bearer` 两个头（实测缺一不可），见 `stash_client.py`。
- 老版本 v0.31.1 schema 要点（兼容性清单）：
  - `scrapeSingleTag(source:{stash_box_endpoint}, input:{query})` 属 **Query 字段**（不是 Mutation），返回 `[ScrapedTag{name, description, alias_list, remote_site_id}]`，可一次返回多个近似匹配。
  - 无 `findTag(name)` / `queryTags`；`findTags(filter{per_page,page,q})` 仅按 q 模糊。
  - `sceneDestroy` 返回 Boolean，selection 会 422；`findScenes` 无 `path` 字段（用 `paths`）；`metadataScan` 勿用 `rescan:true`（会触发多插件 hook 风暴崩溃）。

## 外部刮削源状态（2026-09 实测）

| 源 | 状态 | 可用路径 |
|---|---|---|
| stashdb.org | 公共 GraphQL/网页匿名全部 `not authorized`（网页仅登录框） | 仅经本地 stash `stash_box_endpoint` 代理 |
| theporndb.net | 经本地 stash 可查，但 tag 基本**无 description**（有 id，可与备份 stash_id 交叉验证） | 同上代理 |
| theporndb.org | 域名不可解析 | 不可用 |
| javstash.org/graphql | 直连 403（Cloudflare 1010）；经本地 stash 也拿不到描述 | 兜底意义有限 |

## tagMerge 映射专项经验

- 备份 tag 结构：`{name, aliases[], stash_ids[{stash_id, endpoint, updated_at}]}`。
- **撞名警告**：JAV 片商/系列码（SSIS/SSNI/IPX/IPZZ/DVDES/FSDSS/JUL/BLK/PRED…）在 stashdb 存在**同名但语义无关**的西片 tag（如 SSIS=辅助口交、SONE=囚犯、JUL=美国独立日、BLK 实为 kira*kira 系列前缀）。判定标准：备份该 tag 的 stash_id 与抓取 remote_site_id 是否一致——CONFIRMED 定义可直接用，UNCERTAIN（只有名字匹配、备份无对应 stash_id）需按"该 tag 在库中是否作英文词义使用"决定，纯片商码跳过。
- 年龄分两类语义，勿混并：`18+/20+/30+` = **主演实际年龄区间**；`Teen (18–22)/Teen Girl/Young (22–30)/Young Woman` = **角色年龄**（暗示 18–22 / 22–30）。
- catch-all 类：`Exclusive` 定义含"出道首发 + 独占平台"两义，单键并入会误分类；`Gonzo/Softcore/Behind the Scenes/Professional Production` 等定义明确可直接用。
- 归一化：simple = NFKC+lower+删 `[\s\u3000·、，,。/\-—_・]`（**必须与插件 tagMerge.js 第 190 行 SEP_RE 逐字一致**）；fuzzy = +OpenCC t2s +JP2CN +去 `ー`（仅归属判定辅助，见 `tools/tagmap_norm.py`）。
- **字符集口径教训（2026-09）**：曾用含 ASCII 句点 `.` 与括号的字符集，把 `調教・奴隸.` 与 `調教·奴隸` 误判为"键内重复"并删源。插件 SEP_RE **不含 `.` 与括号**，且 NFKC 下 `・`(U+30FB) 保持、`·`(U+00B7)→`.`，故两者归一化为 `調教奴隸.` vs `調教.奴隸` **不相等、非冲突**（UI 也不会提示）。校验字符集必须与插件逐字一致，勿自行扩删。
- 写入三断言：新源不重复、新源归一化不等于任何键（防链式）、新源必须是备份真实 tag 名。
- 同步硬规则：`tagMerge/tag_merge_map.json` 与 `tagMergeAuto/tag_merge_map.json` 必须逐字节一致（写入后 Copy-Item + SHA256 核对）。
- 日文词判定示例：まんぐり返し/マングリ返し = piledriver 体位 → 并入"折体"（其源已有 `Piledriver`）；デジモ = デジタルモザイク（数字马赛克，SOD 2000 年开发）→ "有码"；屈曲位/座位为独立体位词，无干净合并目标时保留不映射。
- 结果口径：备份 956 tag → 映射覆盖后 unmapped 455（片商码/系列标题/个人库标记按规则跳过），映射 427 条目（426 键 + 1 `_说明`）。

## 可复用工具（tools/）

| 脚本 | 用途 |
|---|---|
| `tagmap_norm.py` | simple/fuzzy 归一化（stdin 逐行输出两列） |
| `tagmap_verify.py` | 双文件同步 + 键内重复 + 反链 + 源核对 + unmapped 统计 |
| `tagmap_scrape_defs.py` | 经本地 stash 刮 stashdb/theporndb 定义（`--endpoint --name/--file --out`） |

审计数据见 `audit/`（532 未映射抓取定义、分类、三轮 unmapped 清单）。
