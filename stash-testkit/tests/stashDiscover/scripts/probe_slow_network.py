# -*- coding: utf-8 -*-
"""第四节·慢网：3s 延迟下重载发现页，看骨架/占位是否稳定、工具栏是否消失。"""
import json
import sys
import time

sys.path.insert(0, r"E:\stashAPP\devtools")
import stash_dev as sd  # noqa: E402

SAMPLE = r"""
(function () {
  const qa = (x) => Array.from(document.querySelectorAll(x));
  const page = document.querySelector(".ssd-dp-page");
  const tb = document.querySelector(".ssd-dp-page .ssd-dp-toolbar") || document.querySelector(".ssd-dp-page .ssd-tb") || null;
  const g = document.querySelector(".ssd-dp-grid");
  const t = page ? (page.innerText || "").replace(/\s+/g, " ") : "";
  return JSON.stringify({
    mounted: !!page,
    tbY: tb ? Math.round(tb.getBoundingClientRect().top) : null,
    gridH: g ? Math.round(g.getBoundingClientRect().height) : null,
    skel: qa(".ssd-dp-grid.is-skel").length,
    cards: qa(".scene-card").length,
    status: (t.match(/updated[^R]{0,22}|Updating[^R]{0,14}/) || [null])[0],
    counts: (t.match(/Discover\s+\d+\s+scenes/) || [null])[0]
  });
})();
"""


def main():
    cli, _ = sd.ensure_browser(9222)
    try:
        sd.open_stash_page(cli, "/plugins/stashDiscover")
        sd.apply_vsize(cli, "1440x900")
        time.sleep(6)
        print("baseline", sd.eval_async(cli, SAMPLE, timeout=30))

        cli.send("Network.enable", {})
        cli.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 3000,
            "downloadThroughput": 2 * 1024 * 1024 // 8, "uploadThroughput": 1024 * 1024 // 8,
        })
        cli.send("Page.reload", {"ignoreCache": True})
        for i in range(16):
            time.sleep(1.5)
            print("t%04.1fs" % ((i + 1) * 1.5), sd.eval_async(cli, SAMPLE, timeout=30))

        cli.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1,
        })
        time.sleep(4)
        print("restored", sd.eval_async(cli, SAMPLE, timeout=30))
    finally:
        sd.stop_browser(9222)


if __name__ == "__main__":
    main()
