# -*- coding: utf-8 -*-
"""tagMerge 映射库校验工具（可复用）。

用法：
  python tools/tagmap_verify.py --map tagMerge/tag_merge_map.json \
      --auto tagMergeAuto/tag_merge_map.json --backup <备份tags目录> [--list-unmapped]

输出：
  - 两份文件 JSON 有效 + 逐字节一致（SHA256）
  - 键内源归一化重复 / 反链（源归一化 = 其他键）/ 源不在备份 三项检查
  - unmapped 统计（备份 tag 中既非键也非源的）
注意：存量映射包含大量 stashdb 别名，'源不在备份'默认只统计不失败；新增条目是否真实备份名由写入脚本断言。
"""
import argparse
import glob
import hashlib
import json
import os

from tagmap_norm import norm_simple


def load_tags(backup_dir):
    tags = {}
    for fp in glob.glob(os.path.join(backup_dir, '*.json')):
        with open(fp, encoding='utf-8') as f:
            t = json.load(f)
        tags[t['name']] = t
    return tags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--map', required=True)
    ap.add_argument('--auto', required=True)
    ap.add_argument('--backup', required=True)
    ap.add_argument('--list-unmapped', action='store_true')
    a = ap.parse_args()

    m = json.load(open(a.map, encoding='utf-8'))
    m2 = json.load(open(a.auto, encoding='utf-8'))
    assert m == m2, 'FATAL: map 与 auto 两份文件内容不一致'
    h1 = hashlib.sha256(open(a.map, 'rb').read()).hexdigest()
    h2 = hashlib.sha256(open(a.auto, 'rb').read()).hexdigest()
    print('json ok | entries=%d keys=%d | sha256 match=%s (%s)' % (
        len(m), len([k for k in m if not k.startswith('_')]), h1 == h2, h1[:12]))

    keys = [k for k in m if not k.startswith('_')]
    key_n = set(norm_simple(k) for k in keys)
    src_all = [s for v in m.values() if isinstance(v, list) for s in v]

    # 1) 键内源归一化重复
    dups = []
    for k, v in m.items():
        seen = set()
        for s in v if isinstance(v, list) else []:
            sn = norm_simple(s)
            if sn in seen:
                dups.append((k, s))
            seen.add(sn)
    print('键内源重复: %d %s' % (len(dups), dups[:6]))

    # 2) 反链（源归一化 = 其他键；键自引用变体不算）
    chain = [(k, s, key_n[norm_simple(s)])
             for k, v in m.items() if isinstance(v, list)
             for s in v if norm_simple(s) in key_n and norm_simple(s) != norm_simple(k)]
    print('反链: %d %s' % (len(chain), chain[:6]))

    # 3) 源是否备份真实 tag 名（统计不失败）
    tags = load_tags(a.backup)
    notreal = [s for s in src_all if s not in tags]
    print('源不在备份: %d（存量含别名属正常）' % len(notreal))

    # 4) unmapped
    src_n = set(norm_simple(s) for s in src_all)
    unmapped = sorted(n for n in tags if norm_simple(n) not in key_n and norm_simple(n) not in src_n)
    print('unmapped: %d' % len(unmapped))
    if a.list_unmapped:
        for n in unmapped:
            print('  ', n)


if __name__ == '__main__':
    main()
