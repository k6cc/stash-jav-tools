# -*- coding: utf-8 -*-
"""F6/F7 复测：写坏所有 SSD:dp:* 键与偏好，重载后应被清理且页面正常。"""
import json
import sys
import time

sys.path.insert(0, r"E:\stashAPP\devtools")
import stash_dev as sd  # noqa: E402

CORRUPT = r"""
(function () {
  const ks = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf("SSD:dp:") === 0) ks.push(k); }
  ks.forEach((k) => localStorage.setItem(k, "{{{ not json"));
  localStorage.setItem("SSD:dp:prefs", "<<<garbage");
  return JSON.stringify({ corrupted: ks.length });
})();
"""

AUDIT = r"""
(function () {
  const bad = [], ok = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k.indexOf("SSD:dp:") !== 0) continue;
    const v = localStorage.getItem(k) || "";
    try { JSON.parse(v); ok.push(k); } catch (e) { bad.push(k); }
  }
  const qa = (x) => Array.from(document.querySelectorAll(x));
  const page = document.querySelector(".ssd-dp-page") || document.body;
  const t = (page.innerText || "").replace(/\s+/g, " ");
  return JSON.stringify({
    badCount: bad.length, okCount: ok.length,
    cards: qa(".scene-card").length,
    counts: (t.match(/Discover\s+\d+\s+scenes\s+\d+\s+performers/) || [null])[0],
    prefs: localStorage.getItem("SSD:dp:prefs")
  });
})();
"""

BASE = '{"tagButton":true,"trendSub":"popular","popRange":"since","popSince":"2026-10-28","sort":"title","askTags":false}'


def main():
    cli, _ = sd.ensure_browser(9222)
    try:
        sd.open_stash_page(cli, "/plugins/stashDiscover")
        sd.apply_vsize(cli, "1440x900")
        time.sleep(7)
        print("before", sd.eval_async(cli, AUDIT, timeout=40))
        print("corrupt", sd.eval_async(cli, CORRUPT, timeout=40))
        cli.send("Page.reload", {"ignoreCache": True})
        time.sleep(10)
        print("after-reload", sd.eval_async(cli, AUDIT, timeout=40))
        print("set-base", sd.eval_async(cli, "(function(){localStorage.setItem('SSD:dp:prefs', %s);return 'ok';})()" % json.dumps(BASE), timeout=20))
        cli.send("Page.reload", {"ignoreCache": True})
        time.sleep(9)
        print("final", sd.eval_async(cli, AUDIT, timeout=40))
    finally:
        sd.stop_browser(9222)


if __name__ == "__main__":
    main()
