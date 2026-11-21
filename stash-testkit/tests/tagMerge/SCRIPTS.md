# tagMerge 脚本总览

> 映射业务语义（撞名判定、年龄语义、归一化字符集、写入三断言）见 [`NOTES.md`](NOTES.md)。本文件只写工具。

| 脚本 | 用途 | 跑法 | 实例 / 副作用 |
|---|---|---|---|
| `tagmap_norm.py` | simple / fuzzy 归一化（与插件 `SEP_RE` 逐字一致） | `echo "調教・奴隸" \| python tagmap_norm.py` | 不需要；纯函数，0 写入 |
| `tagmap_verify.py` | 两份映射文件逐字节一致、键内归一化重复、反链、源不在备份、unmapped 统计 | `python tagmap_verify.py --map tagMerge/tag_merge_map.json --auto tagMergeAuto/tag_merge_map.json --backup <备份 tags 目录>` | 不需要；只读 |
| `tagmap_scrape_defs.py` | 经本地 Stash 代理刮 stashdb / theporndb 的 tag 定义 | `python tagmap_scrape_defs.py --endpoint stashdb --name Gonzo`；`--endpoint theporndb --file names.txt --out defs.csv` | 需要实例 + 网络；**写 CSV 文件**（不写库） |

- `tagmap_verify.py` 依赖同目录 `tagmap_norm.py`，两者需一起移动。
- `tagmap_scrape_defs.py` 自己向上找含 `stash_client.py` 的目录，随目录搬移自适应。
- 审计数据（532 未映射抓取定义、分类、三轮 unmapped 清单）在 `../audit/`。
