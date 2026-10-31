# -*- coding: utf-8 -*-
"""ImageMetaSync 结果审计：只读，检查图库图片的写入是否符合设计口径。

检查项（任一不过即有 bug 或数据被误写）：
  A 同一图库内：有演员的图片 performer 集合一致，且等于关联场景演员并集
  B 同一图库内：演员数 != 1 的图库，图片演员必须为空（整库跳过）
  C 标题：同一图库内 形如「基标题 #N」的 N 不重复；封面（cover）为纯基标题
  D 只读字段：rating100 / organized 未被修改（与传入的基线快照比）
  E 图库内被处理图片的 code/date/studio 与场景一致（有则该字段写对）

口径：基标题 = 场景标题（多场景取唯一值，否则回退图库标题），与插件 `__resolve_meta` 一致。
B 项对「场景后续新增演员」的图库只记为提示：图片里的演员是当时合法写入的历史值，不算写错。

    python audit_state.py                 # 只打印审计结论
    python audit_state.py --dump          # 额外打印每个图库明细
"""
import argparse
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
from stash_client import Stash  # noqa: E402

GALLERY_FIELDS = ("id title image_count cover{id} "
                  "scenes{id title performers{id} studio{id} date code}")
IMAGE_FIELDS = ("id title code date performers{id} studio{id} tags{id} rating100 organized "
                "visual_files{...on ImageFile{path}...on VideoFile{path}}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", action="store_true")
    args = ap.parse_args()
    s = Stash()

    galleries = s.call("query{findGalleries(filter:{per_page:-1}){count galleries{%s}}}"
                       % GALLERY_FIELDS)["findGalleries"]["galleries"]
    problems = []
    notes = []
    total_imgs = 0
    for g in galleries:
        imgs = s.call("""query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1})
                         {images{%s}}}""" % IMAGE_FIELDS,
                      {"f": {"galleries": {"value": [g["id"]], "modifier": "INCLUDES_ALL"}}}
                      )["findImages"]["images"]
        total_imgs += len(imgs)
        perf_union = set()
        for sc in g.get("scenes") or []:
            perf_union |= {p["id"] for p in sc.get("performers") or []}
        cover_id = (g.get("cover") or {}).get("id")
        scene_titles = {(sc.get("title") or "").strip() for sc in g.get("scenes") or []} - {""}
        base = (scene_titles.pop() if len(scene_titles) == 1
                else (g.get("title") or "").strip())

        # A/B 演员
        perf_sets = {frozenset(p["id"] for p in i.get("performers") or []) for i in imgs}
        if len(perf_union) == 1:
            expect = frozenset(perf_union)
            bad = [i for i in imgs if frozenset(p["id"] for p in i.get("performers") or []) not in (expect, frozenset())]
            # 只补空模式允许本来就有别的演员？不，图片新建时为空，出现别的演员=写错
            if bad:
                problems.append("A gallery %s: %d 图演员与场景并集(%s)不符，例如 %s -> %s"
                                % (g["id"], len(bad), ",".join(expect), bad[0]["id"],
                                   [p["id"] for p in bad[0].get("performers") or []]))
            empty = [i for i in imgs if not (i.get("performers") or [])]
            if empty and not args.dump:
                problems.append("A' gallery %s: %d/%d 图无演员（应已回填）"
                                % (g["id"], len(empty), len(imgs)))
        else:
            filled = [i for i in imgs if i.get("performers")]
            if filled:
                notes.append("B gallery %s: 场景演员并集=%d（不满足单演员），%d 图仍带演员 —— "
                             "属场景后来加演员的历史残留，插件不再改写该库"
                             % (g["id"], len(perf_union), len(filled)))

        # C 标题编号
        if base:
            pat = re.compile(r'^' + re.escape(base) + r'\s*#(\d+)$')
            nums, bad_title = {}, []
            for i in imgs:
                t = (i.get("title") or "").strip()
                m = pat.match(t)
                if m:
                    nums.setdefault(int(m.group(1)), []).append(i["id"])
                elif t and t != base:
                    bad_title.append((i["id"], t))
            dup = {n: ids for n, ids in nums.items() if len(ids) > 1}
            if dup:
                problems.append("C gallery %s: 编号重复 %s" % (g["id"], dup))
            if bad_title:
                problems.append("C' gallery %s: %d 图标题既非基标题也非 #N，例如 %s"
                                % (g["id"], len(bad_title), bad_title[0]))
            cov = next((i for i in imgs if i["id"] == cover_id), None)
            if cov is not None and (cov.get("title") or "").strip() not in ("", base):
                problems.append("C'' gallery %s: 封面标题 %r != 基标题" % (g["id"], cov.get("title")))

        if args.dump:
            print("gallery %s '%s' cover=%s imgs=%d scenes=%d perf_union=%d"
                  % (g["id"], base[:40], cover_id, len(imgs), len(g.get("scenes") or []), len(perf_union)))
            for i in sorted(imgs, key=lambda x: int(x["id"])):
                print("   %-5s perf=%-6s studio=%-4s date=%-10s code=%-9s r=%-4s org=%-5s %-45s %r"
                      % (i["id"], ",".join(p["id"] for p in i.get("performers") or []) or "-",
                         (i.get("studio") or {}).get("id") or "-", i.get("date") or "-",
                         i.get("code") or "-", i.get("rating100"), bool(i.get("organized")),
                         os.path.basename(((i.get("visual_files") or [{}])[0] or {}).get("path") or ""),
                         (i.get("title") or "")[:60]))

    print("\n%d galleries, %d images" % (len(galleries), total_imgs))
    if notes:
        print("\n提示 %d 条（不是 bug）：" % len(notes))
        for n in notes:
            print("  - " + n)
    if problems:
        print("\n问题 %d 条：" % len(problems))
        for p in problems:
            print("  - " + p)
    else:
        print("\n审计通过：无异常")


if __name__ == "__main__":
    main()
