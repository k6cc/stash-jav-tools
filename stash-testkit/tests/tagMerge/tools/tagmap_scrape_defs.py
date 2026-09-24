# -*- coding: utf-8 -*-
"""经本地 Stash 刮 stashdb / theporndb tag 定义（可复用）。

背景：stashdb 公共 GraphQL/网页匿名全拒，须经本地 stash 的 stash_box_endpoint 代理；
theporndb.net 可查但大多无 description（返回 id 可交叉验证备份 stash_id）。

用法：
  python tools/tagmap_scrape_defs.py --endpoint stashdb --name Gonzo --name Softcore
  python tools/tagmap_scrape_defs.py --endpoint theporndb --file names.txt [--out defs.csv]

输出列：name, desc, aliases, id（制表符/CSV）。
"""
import argparse
import io
import os
import sys
import time

# 向上定位 stash-testkit 根（含 stash_client.py），随目录搬移自适应
_D = os.path.dirname(os.path.abspath(__file__))
while _D and not os.path.exists(os.path.join(_D, 'stash_client.py')):
    _D = os.path.dirname(_D)
sys.path.insert(0, _D)
from stash_client import Stash

Q = '''query($s: ScraperSourceInput!, $i: ScrapeSingleTagInput!) {
  scrapeSingleTag(source: $s, input: $i) { name description alias_list remote_site_id }
}'''

_ENDPOINTS = {
    'stashdb': 'https://stashdb.org/graphql',
    'theporndb': 'https://theporndb.net/graphql',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--endpoint', choices=sorted(_ENDPOINTS), required=True)
    ap.add_argument('--name', action='append', default=[])
    ap.add_argument('--file', help='每行一个 tag 名')
    ap.add_argument('--out', help='输出文件（默认 stdout）')
    ap.add_argument('--delay', type=float, default=0.4, help='请求间隔秒')
    a = ap.parse_args()

    names = list(a.name)
    if a.file:
        with open(a.file, encoding='utf-8') as f:
            names += [ln.strip() for ln in f if ln.strip()]

    s = Stash()
    buf = io.StringIO()
    buf.write('name\tdesc\taliases\tid\n')
    for n in names:
        try:
            r = s.gql(Q, {'s': {'stash_box_endpoint': _ENDPOINTS[a.endpoint]}, 'i': {'query': n}}, timeout=60)
            items = (r.get('data') or {}).get('scrapeSingleTag') or []
            exact = [it for it in items if (it.get('name') or '').lower() == n.lower()]
            hits = exact or items[:1]
            if not hits:
                buf.write('%s\t\t\t\n' % n)
            for it in hits:
                buf.write('%s\t%s\t%s\t%s\n' % (
                    n, (it.get('description') or '').replace('\t', ' '),
                    '|'.join(it.get('alias_list') or []), (it.get('remote_site_id') or '')))
        except Exception as e:
            buf.write('%s\tERR %s\t\t\n' % (n, str(e)[:80]))
        time.sleep(a.delay)

    out = a.out or '-'
    if out == '-':
        sys.stdout.write(buf.getvalue())
    else:
        with open(out, 'w', encoding='utf-8') as f:
            f.write(buf.getvalue())
        print('written:', out)


if __name__ == '__main__':
    main()
