# -*- coding: utf-8 -*-
"""多视口 UI 布局回归：同一选择器在多个宽度下量位置 / 列数 / 行数 / 溢出。

为什么需要它：断点 bug（值没左对齐、卡片少一列、长标签断成三行、横向溢出）
只能在真实视口里量 rect 才能发现；手写 `stash_dev.py eval --vsize` 每换一个
宽度就要重跑一次，JS 里的引号在 PowerShell 里还会被吃掉。本脚本把这段循环固化。

依赖：`stash_dev.py`（默认 E:/stashAPP/devtools，可用 --dev 或环境变量 STASH_DEV 覆盖）

用法：
  python ui_probe.py --path /plugins/SceneBackfill --selector ".sb-check-name" --sizes 345,390,768,860,1024
  python ui_probe.py --path /plugins/SceneBackfill --selector ".sb-card" --sizes 390,768 --height 844

输出每行：
  size      视口宽×高
  n         匹配元素数
  cols      不同 x 的个数（网格=列数；对齐检查里应为 1）
  x         最左 x（多个元素是否左对齐看它和 cols）
  w / h     单元素最大宽 / 高
  lines     按 line-height 折算的最大行数
  rows      不同 y 的个数（网格=行数）
  ovf       文档是否横向溢出（scrollWidth > innerWidth）
"""
import json
import os
import subprocess
import sys

DEV = os.environ.get("STASH_DEV", r"E:\stashAPP\devtools\stash_dev.py")

JS = r"""(() => {
  const sel = %s;
  const els = Array.from(document.querySelectorAll(sel));
  const rs = els.map(e => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { x: Math.round(r.x), y: Math.round(r.y),
             w: Math.round(r.width), h: Math.round(r.height),
             lh: Math.round(parseFloat(cs.lineHeight) || 0) };
  });
  const xs = Array.from(new Set(rs.map(r => r.x))).sort((a, b) => a - b);
  const ys = Array.from(new Set(rs.map(r => r.y))).sort((a, b) => a - b);
  const n = rs.length;
  const lines = n ? Math.max(...rs.map(r => r.lh ? Math.round(r.h / r.lh) : 0)) : 0;
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight, n: n,
    cols: xs.length, xs: xs, rows: ys.length,
    x: n ? xs[0] : null,
    w: n ? Math.max(...rs.map(r => r.w)) : null,
    h: n ? Math.max(...rs.map(r => r.h)) : null,
    lines: lines,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1
  });
})()"""


def run_size(dev, path, selector, w, h, settle):
    expr = JS % json.dumps(selector)
    cmd = [sys.executable, dev, "eval", "--path", path,
           "--vsize", "%dx%d" % (w, h), "--settle", str(settle), expr]
    r = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=120)
    lines = [l for l in (r.stdout or "").splitlines() if l.strip()]
    if not lines:
        return None, (r.stderr or "").strip()[-300:]
    try:
        return json.loads(lines[-1]), None
    except json.JSONDecodeError:
        return None, lines[-1][-300:]


def main(argv):
    argv = argv[1:]
    opts = {"--path": "/", "--selector": "", "--sizes": "390,768,1024",
            "--height": "844", "--settle": "2", "--dev": DEV}
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in opts and i + 1 < len(argv):
            opts[a] = argv[i + 1]
            i += 2
        else:
            pos.append(a)
            i += 1
    if pos and not opts["--selector"]:
        opts["--selector"] = pos[0]
    if not opts["--selector"]:
        print(__doc__)
        return 1
    dev = opts["--dev"]
    if not os.path.isfile(dev):
        print("[x] 找不到 stash_dev.py：%s（用 --dev 或 STASH_DEV 指定）" % dev)
        return 2

    print("path=%s  selector=%s" % (opts["--path"], opts["--selector"]))
    print("%-9s %4s %4s %5s %6s %6s %5s %5s %s" %
          ("size", "n", "cols", "x", "w", "h", "lines", "rows", "ovf"))
    bad = 0
    for spec in opts["--sizes"].split(","):
        spec = spec.strip()
        if not spec:
            continue
        if "x" in spec.lower():
            w, h = spec.lower().split("x")
        else:
            w, h = spec, opts["--height"]
        data, err = run_size(dev, opts["--path"], opts["--selector"],
                             int(w), int(h), opts["--settle"])
        label = "%sx%s" % (w, h)
        if data is None:
            bad += 1
            print("%-9s [!] %s" % (label, err))
            continue
        if data["overflow"]:
            bad += 1
        print("%-9s %4d %4d %5s %6s %6s %5d %5d %s" % (
            label, data["n"], data["cols"], data["x"], data["w"], data["h"],
            data["lines"], data["rows"], "YES" if data["overflow"] else "-"))
    return 2 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
