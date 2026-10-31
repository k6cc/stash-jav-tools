# -*- coding: utf-8 -*-
"""验证 imageUpdate / addGalleryImages 是否触发 Gallery.Update.Post（插件自激循环风险）。

判定依据：钩子每触发一次，插件在 stash 日志写一行
  "Gallery <id>: image metadata sync started in background"
⇒ 改一张图后出现新的 started 行 = imageUpdate 触发了图库钩子（overwrite 模式会自激）。

    python probe_hook_trigger.py <image_id> <gallery_id>

注意：`query{logs}` 是 30 条环形缓冲、无 filter，只能高频轮询（2s）抓。
"""
import json
import os
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from stash_client import Stash  # noqa: E402

MARK = "image metadata sync started in background"


def logs(s):
    """Stash 日志里混有非 UTF-8 字节，用 replace 解码。"""
    body = json.dumps({"query": "{logs{time level message}}"}).encode("utf-8")
    req = urllib.request.Request(s.api, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("ApiKey", s.key)
    req.add_header("Authorization", "Bearer " + s.key)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))["data"]["logs"]


def watch(s, since, seconds, tag):
    seen = {}
    t0 = time.time()
    while time.time() - t0 < seconds:
        for l in logs(s):
            if l["time"] > since:
                seen[(l["time"], l["message"])] = l
        time.sleep(2)
    hits = [l for l in seen.values() if MARK in l["message"] or "ImageMetaSync" in l["message"]]
    print("[%s] 抓到新日志 %d 行，插件相关 %d 行" % (tag, len(seen), len(hits)))
    for l in sorted(hits, key=lambda x: x["time"]):
        print("   %s %-5s %s" % (l["time"], l["level"], l["message"].strip()[:140]))
    return hits


def main():
    img_id, gid = str(sys.argv[1]), str(sys.argv[2])
    s = Stash()
    since = logs(s)[0]["time"]
    cur = s.call("query($id:ID!){findImage(id:$id){title}}", {"id": img_id})["findImage"]
    print("image %s title=%r（图库 %s）" % (img_id, cur["title"], gid))

    s.call("mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}",
           {"i": {"id": img_id, "title": cur["title"] or ""}})
    print("已发 imageUpdate（写回原 title），轮询 20s …")
    hits = watch(s, since, 20, "imageUpdate 后")

    since2 = logs(s)[0]["time"]
    imgs = s.call("""query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:2}){images{id}}}""",
                  {"f": {"galleries": {"value": [gid], "modifier": "INCLUDES_ALL"}}})["findImages"]["images"]
    if imgs:
        s.call("mutation($i:GalleryAddInput!){addGalleryImages(input:$i)}",
               {"i": {"gallery_id": gid, "image_ids": [imgs[0]["id"]]}})
        print("已发 addGalleryImages（重复挂已在库的图 %s），轮询 20s …" % imgs[0]["id"])
        hits2 = watch(s, since2, 20, "addGalleryImages 后")
    else:
        hits2 = []
        print("该图库无图片，跳过 addGalleryImages")

    print("\n结论：")
    print("  imageUpdate      → %s" % ("会触发图库钩子（自激风险）" if hits else "不触发图库钩子"))
    print("  addGalleryImages → %s" % ("会触发图库钩子" if hits2 else "不触发（或未测）"))


if __name__ == "__main__":
    main()
