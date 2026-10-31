# -*- coding: utf-8 -*-
"""校验 ImageMetaSync 用到的 GraphQL 字段在当前 Stash 版本存在（只读）。

插件把查询错误吞成 {}（stashInterface.__gql 出错返回空字典），字段不存在时
表现为「Gallery not found / no images」而非报错，纯看日志无法区分是数据问题还是
schema 不兼容。任何一次改动字段后先跑本脚本。

    python probe_schema.py            # 字段存在性 + 真实数据样本
"""
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
from stash_client import Stash  # noqa: E402

# 与插件里 GALLERY_FIELDS / IMAGE_FIELDS 完全一致
GALLERY_FIELDS = ("id title image_count cover{id} "
                  "scenes{id title code details date urls performers{id} studio{id} tags{id name}}")
IMAGE_FIELDS = ("id title code details date urls performers{id} studio{id} tags{id} "
                "visual_files{...on ImageFile{path}...on VideoFile{path}}")

CHECKS = [
    ("gallery",  """query($id:ID!){findGallery(id:$id){%s}}""" % GALLERY_FIELDS, {"id": "1"}),
    ("image",    """query($id:ID!){findImage(id:$id){%s}}""" % IMAGE_FIELDS, {"id": "1"}),
    ("images_in_gallery",
     """query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1}){images{%s}}}"""
     % IMAGE_FIELDS, {"f": {"galleries": {"value": ["1"], "modifier": "INCLUDES_ALL"}}}),
    ("galleries_page",
     """query($f:FindFilterType){findGalleries(filter:$f){count galleries{%s}}}""" % GALLERY_FIELDS,
     {"f": {"per_page": 3, "page": 1}}),
    ("scenes_page",
     """query($f:FindFilterType){findScenes(filter:$f){count scenes{id files{path} galleries{id}}}}""",
     {"f": {"per_page": 3, "page": 1, "sort": "path"}}),
    ("scene_full",
     """query($id:ID!){findScene(id:$id){id title code details date urls files{path} studio{id} tags{id name} performers{id}}}""",
     {"id": "1"}),
]


def raw(s, query, variables):
    """绕过 Stash.call 的错误处理，直接看 errors。"""
    import urllib.request
    body = json.dumps({"query": query, "variables": variables}).encode("utf-8")
    req = urllib.request.Request(s.api, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("ApiKey", s.key)
    req.add_header("Authorization", "Bearer " + s.key)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    s = Stash()
    ok = True
    for name, q, v in CHECKS:
        d = raw(s, q, v)
        errs = d.get("errors")
        if errs:
            ok = False
            print("FAIL  %-18s %s" % (name, "; ".join(e.get("message", "")[:160] for e in errs)))
        else:
            key = list(d["data"].keys())[0] if d.get("data") else "?"
            val = d["data"][key] if d.get("data") else None
            print("ok    %-18s %s" % (name, json.dumps(val, ensure_ascii=False)[:150]))
    print("\n%s" % ("ALL FIELD CHECKS PASSED" if ok else "SOME CHECKS FAILED — 插件会静默退化"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
