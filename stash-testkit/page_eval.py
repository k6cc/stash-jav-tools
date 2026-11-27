#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""page_eval.py —— 在已开的调试 Chrome 里跑一个 JS 文件（awaitPromise），只做四步。

为什么单独有它：`stash_dev.py eval` 在本机会整条挂住（无输出、python CPU≈0、十几分钟不返回），
而 `gql` / `status` 子命令正常。本脚本只做「选中 9999 标签页 → 导航 + 设视口 → Runtime.evaluate → 打印」，
任何一步失败立刻报错退出，不会静默空转。它不启动也不关闭浏览器，用完请自己 `stop_chrome.py --port 9222`。

前置：
    python C:\\Users\\k6cc\\.workbuddy\\skills\\browser-automation-cdp\\scripts\\start_chrome.py --port 9222

用法：
    python stash-testkit/page_eval.py <js 文件> [--path /plugins/stashDiscover] [--vsize 1400x900]
                                     [--settle 9] [--timeout 150] [--port 9222]

说明：
- `--path` 是 Stash 内路由，默认发现页 `/plugins/stashDiscover`（写成 `/plugins/k6cc/stashDiscover` 是空壳）。
- `--settle` 是导航后固定等待秒数；探针内部一般还会自己轮询等元素，这里给个起步值即可。
- 返回值按 `returnByValue` 直接打印；JS 抛异常打印 `JS_EXC` 并以 1 退出。
- 不写任何数据到 Stash，脚本本身的副作用由各探针自己声明（见 tests/<plugin>/SCRIPTS.md）。
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, r"C:\Users\k6cc\.workbuddy\skills\browser-automation-cdp\scripts")
from cdp import CDPClient  # noqa: E402

STASH = "http://127.0.0.1:9999"


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("js")
    ap.add_argument("--path", default="/plugins/stashDiscover")
    ap.add_argument("--vsize", default="1400x900")
    ap.add_argument("--settle", type=float, default=9.0)
    ap.add_argument("--timeout", type=float, default=150.0)
    ap.add_argument("--port", type=int, default=9222)
    a = ap.parse_args()

    code = Path(a.js).read_text(encoding="utf-8")
    cli = CDPClient(port=a.port, timeout=10)
    if not cli.is_alive():
        raise SystemExit("CDP %d 不可用：先跑 start_chrome.py --port %d" % (a.port, a.port))
    try:
        # 新起的浏览器只有 about:blank，没有 9999 标签页：这时退回当前首个 page
        try:
            cli.ensure_page(url_contains="127.0.0.1:9999")
        except Exception:
            cli.ensure_page()
        if a.vsize:
            w, h = a.vsize.lower().split("x")
            cli.send("Emulation.setDeviceMetricsOverride", {
                "width": int(w), "height": int(h), "deviceScaleFactor": 1, "mobile": False,
            })
        target = STASH + (a.path if a.path.startswith("/") else "/" + a.path)
        cli.send("Page.navigate", {"url": target})
        time.sleep(a.settle)
        print("URL: %s  TITLE: %s" % (cli.page_url(), cli.page_title()))
        res = cli.send("Runtime.evaluate", {
            "expression": code,
            "returnByValue": True,
            "awaitPromise": True,
            "userGesture": True,
        }, timeout=a.timeout)
        if res.get("exceptionDetails"):
            print("JS_EXC: " + json.dumps(res["exceptionDetails"], ensure_ascii=False)[:1200])
            return 1
        val = res.get("result", {}).get("value")
        print(val if val is not None else json.dumps(res.get("result", {}), ensure_ascii=False)[:800])
        return 0
    finally:
        cli.close()


if __name__ == "__main__":
    sys.exit(main())
