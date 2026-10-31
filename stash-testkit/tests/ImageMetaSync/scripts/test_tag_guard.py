"""离线验证 ImageMetaSync 的 tag 写入防护（不连数据库，用假 stash 驱动内部函数）。

覆盖：
 1) 场景快照里的 tag 已被合并删除 -> 写入前被过滤，不产生 FOREIGN KEY 整条回滚
 2) overwrite=OFF 时 tags 按并集补缺：图片落后的 tags 会补上，手工加的 tag 不丢
 3) 单条 imageUpdate 被拒 -> 去掉 tags 重试，其余字段照样落地，且不计入 updated

用法：
    python test_tag_guard.py
退出码 0 = 全部通过。
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "..", ".."))
PLUGIN = r"E:\stashAPP\plugins\k6cc\ImageMetaSync"
if not os.path.isdir(PLUGIN):
    PLUGIN = os.path.join(_HERE, "..", "..", "..", "..", "ImageMetaSync")
sys.path.insert(0, PLUGIN)

from ImageMetaSync import ImageMetaSync  # noqa: E402


class FakeStash:
    """只实现 ImageMetaSync 用到的三个查询；valid_tags 为 None 表示查不到 tag 列表。"""

    def __init__(self, valid_tags=None, reject_once_on=None):
        self.valid_tags = valid_tags
        self.reject_once_on = set(reject_once_on or [])
        self.calls = []
        self.tag_list_calls = 0

    def gql_findAllTagIds(self):
        self.tag_list_calls += 1
        return set(self.valid_tags or [])

    def gql_imageUpdate(self, data):
        self.calls.append(dict(data))
        iid = data["id"]
        # 真实 Stash：写入不存在的 tag id 会整条回滚，底层返回空
        if self.reject_once_on and iid in self.reject_once_on:
            self.reject_once_on.discard(iid)
            return None
        if "tag_ids" in data and self.valid_tags is not None:
            if any(t not in self.valid_tags for t in data["tag_ids"]):
                return None
        return {"id": iid}


def img(iid, name, tags=(), title=""):
    return {"id": iid, "title": title, "tags": [{"id": t} for t in tags],
            "performers": [{"id": "1"}], "studio": {"id": "67"}, "date": "2026-10-01",
            "code": "IMS-TEST-001", "urls": ["u"], "details": "d",
            "visual_files": [{"path": r"E:\lib\\%s.jpg" % name}]}


def meta(tag_ids, overwrite=False, title="T"):
    return {"overwrite": overwrite, "fill_title": True, "performer_id": "1",
            "title": title, "code": None, "tag_ids": list(tag_ids), "date": None,
            "studio_id": None, "urls": None, "details": None}


def apply(fake, images, cover_id, m):
    p = ImageMetaSync(fake)
    return p._ImageMetaSync__apply_to_images(images, cover_id, m)


def case_dead_tag():
    """场景快照里有已删除的 tag，过滤后正常写入。"""
    fake = FakeStash(valid_tags={"100", "200"})
    images = [img("1", "cover", tags=[]), img("2", "fanart1", tags=[])]
    n = apply(fake, images, "1", meta(["100", "999"]))  # 999 已被合并删除
    wrote = [c for c in fake.calls if "tag_ids" in c]
    ok = (n == 2 and wrote and all(c["tag_ids"] == ["100"] for c in wrote)
          and not any("999" in c["tag_ids"] for c in wrote))
    print("  [1] 死 tag 过滤: updated=%d tag_ids=%s -> %s"
          % (n, sorted({tuple(c["tag_ids"]) for c in wrote}), "PASS" if ok else "FAIL"))
    return ok


def case_tag_list_unknown():
    """查不到 tag 列表时不过滤（不能误清空所有 tags）。"""
    fake = FakeStash(valid_tags=None)
    images = [img("1", "cover", tags=[])]
    n = apply(fake, images, "1", meta(["777"]))
    wrote = [c for c in fake.calls if "tag_ids" in c]
    ok = n == 1 and wrote and wrote[0]["tag_ids"] == ["777"]
    print("  [1b] tag 列表不可用时不过滤: updated=%d -> %s" % (n, "PASS" if ok else "FAIL"))
    return ok


def case_union_heal():
    """overwrite=OFF：图片缺的 tag 补上，已有顺序与手工 tag 保留。"""
    fake = FakeStash(valid_tags={"100", "200", "300"})
    images = [img("1", "cover", tags=["100", "300"])]   # 300 = 手工加在图片上的
    n = apply(fake, images, "1", meta(["100", "200"]))
    wrote = [c for c in fake.calls if "tag_ids" in c]
    ok = n == 1 and wrote and wrote[0]["tag_ids"] == ["100", "300", "200"]
    print("  [2] 并集补缺: updated=%d tag_ids=%s -> %s"
          % (n, wrote[0]["tag_ids"] if wrote else None, "PASS" if ok else "FAIL"))

    # 幂等：图片已含全部期望 tags，不再发写请求
    fake2 = FakeStash(valid_tags={"100", "200", "300"})
    n2 = apply(fake2, [img("1", "cover", tags=["100", "200"], title="T")], "1", meta(["100", "200"]))
    ok2 = n2 == 0 and not fake2.calls
    print("  [2b] 幂等: updated=%d calls=%d -> %s"
          % (n2, len(fake2.calls), "PASS" if ok2 else "FAIL"))
    return ok and ok2


def case_overwrite_replace():
    """overwrite=ON：整体替换为场景 tags。"""
    fake = FakeStash(valid_tags={"100", "200"})
    images = [img("1", "cover", tags=["100", "300"])]
    n = apply(fake, images, "1", meta(["100", "200"], overwrite=True))
    wrote = [c for c in fake.calls if "tag_ids" in c]
    ok = n == 1 and wrote and wrote[0]["tag_ids"] == ["100", "200"]
    print("  [2c] overwrite 替换: updated=%d tag_ids=%s -> %s"
          % (n, wrote[0]["tag_ids"] if wrote else None, "PASS" if ok else "FAIL"))
    return ok


def case_reject_retry():
    """单图被拒：去掉 tags 重试，其余字段落地并计入 updated。"""
    fake = FakeStash(valid_tags={"100"}, reject_once_on={"2"})
    images = [img("1", "cover", tags=[]), img("2", "fanart1", tags=[])]
    n = apply(fake, images, "1", meta(["100"]))
    second = [c for c in fake.calls if c["id"] == "2"]
    retried = [c for c in second if "tag_ids" not in c]
    ok = (len(second) == 2 and retried and len(retried[0]) > 1 and n == 2)
    print("  [3] 被拒去 tags 重试: 图2 请求%d 次, updated=%d -> %s"
          % (len(second), n, "PASS" if ok else "FAIL"))

    # 只有 tags 一项时无重试余地，不计入 updated，也不抛异常
    fake2 = FakeStash(valid_tags=None, reject_once_on={"1"})
    n2 = apply(fake2, [img("1", "cover", tags=[], )], "1",
               {"overwrite": False, "fill_title": False, "performer_id": None, "title": None,
                "code": None, "tag_ids": ["100"], "date": None, "studio_id": None,
                "urls": None, "details": None})
    ok2 = n2 == 0 and len(fake2.calls) == 1
    print("  [3b] 仅 tags 被拒: updated=%d 请求%d 次 -> %s"
          % (n2, len(fake2.calls), "PASS" if ok2 else "FAIL"))
    return ok and ok2


def main():
    results = [case_dead_tag(), case_tag_list_unknown(), case_union_heal(),
               case_overwrite_replace(), case_reject_retry()]
    print("\n%d/%d 通过" % (sum(results), len(results)))
    print("RESULT: %s" % ("PASS" if all(results) else "FAIL"))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
