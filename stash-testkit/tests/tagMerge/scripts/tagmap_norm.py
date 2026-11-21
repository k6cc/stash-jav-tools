# -*- coding: utf-8 -*-
"""tagMerge 映射归一化工具（与 tagMerge.js SEP_RE 逐字一致）。

simple = NFKC + lower + 删 [\\s\\u3000·、，,。/\\-—_・]（插件第 190 行字符集；
注意不含 ASCII 句点 '.' 与括号，含连字符/下划线/破折号；NFKC 会把 ·(U+00B7)→. 、／→/）
fuzzy  = simple + 繁转简(OpenCC t2s) + 日文假名/汉译(JP2CN) + 去 'ー'（仅归属判定辅助，插件实际匹配用 simple）
"""
import re
import unicodedata

_SEP = re.compile(r'[\s\u3000·、，,。/\-—_・]')


def norm_simple(s):
    """与插件一致的归一化匹配键。"""
    s = unicodedata.normalize('NFKC', s).lower()
    return _SEP.sub('', s)


def norm_fuzzy(s):
    """放宽版：繁简/日汉归一，用于辅助判定同义候选；OpenCC / jp2zh 不可用时降级为 simple。"""
    s = norm_simple(s)
    try:
        from opencc import OpenCC  # pip install opencc-python-reimplemented
        s = OpenCC('t2s').convert(s)
    except Exception:
        pass
    try:
        import jp2zh  # pip install jp2zh
        s = jp2zh.jp2zh(s, mode='zh2ja') or s
    except Exception:
        pass
    return s.replace('ー', '')


if __name__ == '__main__':
    import sys
    for line in sys.stdin:
        line = line.rstrip('\n')
        if line:
            print('%s\t%s' % (norm_simple(line), norm_fuzzy(line)))
