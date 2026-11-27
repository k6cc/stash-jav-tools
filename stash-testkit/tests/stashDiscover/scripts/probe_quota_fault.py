# -*- coding: utf-8 -*-
"""第四节·配额（五）：注入 QuotaExceededError，看偏好写入失败时的表现。"""
import json
import sys
import time

sys.path.insert(0, r"E:\stashAPP\devtools")
import stash_dev as sd  # noqa: E402

HOOK = r"""
(function () {
  window.__warns = [];
  ["warn", "error"].forEach(function (lvl) {
    const o = console[lvl].bind(console);
    console[lvl] = function () { try { window.__warns.push(lvl + ":" + Array.from(arguments).map(String).join(" ").slice(0, 110)); } catch (e) {} return o.apply(null, arguments); };
  });
  const orig = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (String(k).indexOf("SSD:dp:") === 0) {
      const e = new DOMException("quota", "QuotaExceededError");
      throw e;
    }
    return orig.call(this, k, v);
  };
  return "hooked";
})();
"""

SET_RANGE = r"""
(function (v) {
  const s = document.querySelector(".ssd-range-dp .ssd-range-sel");
  if (!s) return "no-sel";
  s.value = v; s.dispatchEvent(new Event("change", { bubbles: true }));
  return "set:" + v;
})(%s)
"""

READ = r"""
(function () {
  const s = document.querySelector(".ssd-range-dp .ssd-range-sel");
  return JSON.stringify({ prefs: localStorage.getItem("SSD:dp:prefs"), sel: s ? s.value : null, warns: (window.__warns || []).slice(0, 5) });
})();
"""

RESTORE = r"""
(function (v) {
  localStorage.setItem("SSD:dp:prefs", v);
  return localStorage.getItem("SSD:dp:prefs");
})(%s)
"""

BASE = '{"tagButton":true,"trendSub":"popular","popRange":"since","popSince":"2026-10-28","sort":"title","askTags":false}'


def main():
    cli, _ = sd.ensure_browser(9222)
    try:
        sd.open_stash_page(cli, "/plugins/stashDiscover")
        sd.apply_vsize(cli, "1440x900")
        time.sleep(7)
        sd.eval_async(cli, r"""(function(){const t=Array.from(document.querySelectorAll(".ssd-dp-tab")).find(x=>x.textContent.trim()==="Trending");if(t)t.click();return "ok";})()""", timeout=25)
        time.sleep(3)
        print("hook", sd.eval_async(cli, HOOK, timeout=20))
        print("base", sd.eval_async(cli, READ, timeout=30))

        print("set30", sd.eval_async(cli, SET_RANGE % json.dumps("30"), timeout=30))
        time.sleep(2.0)
        print("after-set", sd.eval_async(cli, READ, timeout=30))

        cli.send("Page.reload", {"ignoreCache": True})
        time.sleep(9)
        sd.eval_async(cli, r"""(function(){const t=Array.from(document.querySelectorAll(".ssd-dp-tab")).find(x=>x.textContent.trim()==="Trending");if(t)t.click();return "ok";})()""", timeout=25)
        time.sleep(3)
        print("after-reload", sd.eval_async(cli, READ, timeout=30))

        print("restore", sd.eval_async(cli, RESTORE % json.dumps(BASE), timeout=20))
    finally:
        sd.stop_browser(9222)


if __name__ == "__main__":
    main()
