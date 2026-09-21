# -*- coding: utf-8 -*-
"""javstashAutofill+ v1.1.3 封面 blob 锁竞态修复单测。

覆盖（对应修复验收的单元级部分）：
1. cover 重读判断  _shot_is_auto：严格 created_at 判别
   - 无任何元数据写入（?t= == created_at）→ True
   - NFO 已写封面（?t= 偏离 created_at，哪怕 2s）→ False
   - 缺 ?t= / 坏时间戳 / 空 scene → False（fail-closed，保守跳过）
2. 失败重试路径  _is_blob_lock_error / _apply_cover_with_retry
   - 真实 blob 锁错误文本命中；普通错误不命中
   - 首次成功；blob 锁第 1/2 次失败后按 1s/2s 退避重试成功
   - blob 锁持续 → 1s/2s/4s 共 3 次重试后放弃
   - 非 blob 错误 → 立即放弃不重试
   - 重试期间 NFO 写入封面（重读非 auto）→ 放弃写
3. cover 分离提交  apply_scene_fill
   - 主 sceneUpdate 负载不携带 cover_image
   - data: URI 封面走独立 sceneUpdate，且发生在主 sceneUpdate 之前
运行：python tests/javstashAutofill/test_cover_race.py（无需实例；相对仓库定位插件源码）
"""
import importlib.util
import datetime as _dt
import json
import os
import sys
import time

PLUGIN = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
                      "javstashAutofill+", "javstash_autofill_plus.py")

CREATED = "2026-09-21T08:00:00+08:00"
BASE = int(_dt.datetime.fromisoformat(CREATED).timestamp())


def load_plugin():
    spec = importlib.util.spec_from_file_location("javstash_autofill_plus", PLUGIN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.log = lambda *a, **k: None          # 单测不写真实日志
    mod.logs = []
    def capture(*a, **k):
        mod.logs.append(a[0] if a else "")
    mod.log = capture
    mod._real_sleep = mod.time.sleep
    return mod


class FakeGql:
    """可编程 GraphQL 替身：记录调用，按场景状态与错误脚本响应。"""
    def __init__(self, mod):
        self.mod = mod
        self.calls = []
        self.scene = None          # findScene 返回的场景（cover 重读用）
        self.cover_errors = []     # 每次 sceneUpdate(cover_image) 依次抛出的异常列表
        self.main_errors = []      # 每次 sceneUpdate(非 cover) 依次抛出的异常列表
        self.sleeps = []

    def __call__(self, query, variables=None):
        self.calls.append({"q": query, "v": variables or {}})
        if "findScene(id" in query:
            return {"findScene": self.scene}
        if "sceneUpdate" in query:
            payload = (variables or {}).get("i") or {}
            if "cover_image" in payload:
                if self.cover_errors:
                    e = self.cover_errors.pop(0)
                    raise e
                return {"sceneUpdate": {"id": str(payload.get("id"))}}
            if self.main_errors:
                raise self.main_errors.pop(0)
            return {"sceneUpdate": {"id": str(payload.get("id"))}}
        return None

    def patch_sleep(self):
        orig = self.mod.time.sleep
        def fake(s):
            self.sleeps.append(s)
        self.mod.time.sleep = fake
        self._orig_sleep = orig

    def restore_sleep(self):
        self.mod.time.sleep = self._orig_sleep


BLOB_ERR = RuntimeError(json.dumps([
    {"message": 'deleting from filesystem: deleting file "blobs\\25\\0b\\abc": '
                'marking file "blobs\\25\\0b\\abc" for deletion: rename '
                'blobs\\25\\0b\\abc blobs\\25\\0b\\abc.delete: '
                'The process cannot access the file because it is being used by another process.',
     "path": ["sceneUpdate"]}]))

NORMAL_ERR = RuntimeError("some other graphql error")


def scene(shot_ts=None):
    """构造 findScene 返回；shot_ts 为 ?t= epoch（缺省 = created_at 本身，即无人写入）。"""
    st = BASE if shot_ts is None else shot_ts
    return {"created_at": CREATED, "paths": {"screenshot": "http://x/scene/1/screenshot?t=%d&x=1" % st}}


def run(name, fn):
    try:
        fn()
        print("PASS", name)
    except AssertionError as e:
        print("FAIL", name, "->", e)
        raise SystemExit(1)


def main():
    mod = load_plugin()

    # ---------- 1. _shot_is_auto ----------
    def t_auto_true():
        assert mod._shot_is_auto(scene()) is True
    run("shot_is_auto: 无写入(?t= == created_at) -> True", t_auto_true)

    def t_auto_nfo():
        assert mod._shot_is_auto(scene(shot_ts=BASE + 2)) is False
        assert mod._shot_is_auto(scene(shot_ts=BASE + 100)) is False
        assert mod._shot_is_auto(scene(shot_ts=BASE - 5)) is False
    run("shot_is_auto: NFO 已写封面(?t= 偏离, 哪怕 2s) -> False", t_auto_nfo)

    def t_auto_failclosed():
        assert mod._shot_is_auto({}) is False
        assert mod._shot_is_auto({"created_at": "2026-09-21T08:00:00+08:00", "paths": {}}) is False
        assert mod._shot_is_auto({"created_at": "bad", "paths": {"screenshot": "http://x/s?t=123"}}) is False
        assert mod._shot_is_auto({"created_at": "2026-09-21T08:00:00+08:00",
                                  "paths": {"screenshot": "http://x/s?t=abc"}}) is False
    run("shot_is_auto: 缺 ?t=/坏时间戳/空 -> False (fail-closed)", t_auto_failclosed)

    # ---------- 2. _is_blob_lock_error ----------
    def t_blob_detect():
        assert mod._is_blob_lock_error(BLOB_ERR) is True
        assert mod._is_blob_lock_error(RuntimeError("deleting from filesystem: deleting file blobs")) is True
        assert mod._is_blob_lock_error(RuntimeError("being used by another process")) is True
        assert mod._is_blob_lock_error(NORMAL_ERR) is False
        assert mod._is_blob_lock_error(RuntimeError("")) is False
    run("is_blob_lock_error: 真实错误命中/普通错误不命中", t_blob_detect)

    # ---------- 3. _apply_cover_with_retry ----------
    def t_retry_first_success():
        g = FakeGql(mod)
        g.patch_sleep()
        g.scene = scene()
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is True
        updates = [c for c in g.calls if "sceneUpdate" in c["q"] and "cover_image" in (c["v"].get("i") or {})]
        assert len(updates) == 1
        assert updates[0]["v"]["i"]["cover_image"] == "data:image/jpeg;base64,AAAA"
        g.restore_sleep()
    run("retry: 首次成功, 单独 sceneUpdate 写 data: URI 封面", t_retry_first_success)

    def t_retry_nfo_already():
        g = FakeGql(mod)
        g.patch_sleep()
        g.scene = scene(shot_ts=BASE + 5)      # nfo 已写封面
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is False
        updates = [c for c in g.calls if "sceneUpdate" in c["q"]]
        assert len(updates) == 0                      # 一次都没写
        assert g.sleeps == []
        g.restore_sleep()
    run("retry: 重读判定 nfo 已写封面 -> 跳过不写", t_retry_nfo_already)

    def t_retry_blob_then_ok():
        g = FakeGql(mod)
        g.patch_sleep()
        g.scene = scene()
        g.cover_errors = [BLOB_ERR, BLOB_ERR]
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is True
        assert g.sleeps == [1, 2]                     # 1s/2s 退避
        g.restore_sleep()
    run("retry: blob 锁前 2 次失败, 1s/2s 退避后成功", t_retry_blob_then_ok)

    def t_retry_blob_giveup():
        g = FakeGql(mod)
        g.patch_sleep()
        g.scene = scene()
        g.cover_errors = [BLOB_ERR, BLOB_ERR, BLOB_ERR, BLOB_ERR]
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is False
        assert g.sleeps == [1, 2, 4]                  # 1s/2s/4s 共 3 次重试
        g.restore_sleep()
    run("retry: blob 锁持续 -> 1s/2s/4s 3 次重试后放弃", t_retry_blob_giveup)

    def t_retry_nonblob():
        g = FakeGql(mod)
        g.patch_sleep()
        g.scene = scene()
        g.cover_errors = [NORMAL_ERR, BLOB_ERR]
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is False
        assert g.sleeps == []                         # 非 blob 错误不重试
        g.restore_sleep()
    run("retry: 非 blob 错误 -> 立即放弃不重试", t_retry_nonblob)

    def t_retry_nfo_midflight():
        g = FakeGql(mod)
        g.patch_sleep()
        # 每次重读返回状态可变：首次 auto，之后 nfo 写入（非 auto）
        states = [scene(), scene(shot_ts=BASE + 9)]
        def dynamic(*a, **k):
            s = states.pop(0) if states else states[-1]
            return s
        g.scene = None
        g_calls = {"findScene": dynamic, "sceneUpdate": None}
        orig = mod._reload_scene_cover
        mod._reload_scene_cover = lambda gql, sid: g_calls["findScene"]()
        g.cover_errors = [BLOB_ERR, BLOB_ERR, BLOB_ERR]
        ok = mod._apply_cover_with_retry(g, "1", "data:image/jpeg;base64,AAAA")
        assert ok is False
        assert g.sleeps == [1]                        # 第一次失败后退避，重读发现 nfo 已写 -> 放弃
        mod._reload_scene_cover = orig
        g.restore_sleep()
    run("retry: 重试期间 NFO 写入封面 -> 重读判定后放弃", t_retry_nfo_midflight)

    # ---------- 4. apply_scene_fill 分离提交 ----------
    def t_fill_separated():
        g = FakeGql(mod)
        g.scene = scene()
        sc = {"title": "JAV TITLE", "code": "ABC-123",
              "remote_site_id": "uuid-1",
              "image": "data:image/jpeg;base64,AAAA"}
        scene_in = {"id": "42", "title": "", "code": "", "details": "", "director": "", "date": None,
                    "urls": [], "studio": None, "performers": [], "tags": [], "groups": [],
                    "stash_ids": [], "paths": {"screenshot": "http://x/scene/42/screenshot?t=" + str(BASE)},
                    "created_at": "2026-09-21T08:00:00+08:00"}
        upd = mod.apply_scene_fill(g, "42", scene_in, sc, "https://javstash.org/graphql")
        assert "cover_image" not in upd
        scene_updates = [c for c in g.calls if "sceneUpdate" in c["q"]]
        assert len(scene_updates) == 2
        cover_upd = [c for c in scene_updates if "cover_image" in (c["v"].get("i") or {})]
        main_upd = [c for c in scene_updates if "cover_image" not in (c["v"].get("i") or {})]
        assert len(cover_upd) == 1 and len(main_upd) == 1
        assert cover_upd[0]["v"]["i"]["cover_image"] == "data:image/jpeg;base64,AAAA"
        # 封面单独 sceneUpdate 必须先于主 sceneUpdate（否则主更新会顶走 ?t= 导致误判）
        assert g.calls.index(cover_upd[0]) < g.calls.index(main_upd[0])
        assert main_upd[0]["v"]["i"]["title"] == "JAV TITLE"
        assert main_upd[0]["v"]["i"]["stash_ids"][0]["stash_id"] == "uuid-1"
    run("apply_scene_fill: 主负载无 cover_image, data: 封面独立提交且在主页面前", t_fill_separated)

    def t_fill_nfo_cover_skipped():
        g = FakeGql(mod)
        g.scene = scene(shot_ts=BASE + 5)      # nfo 已写封面
        sc = {"title": "JAV TITLE", "remote_site_id": "uuid-1",
              "image": "data:image/jpeg;base64,AAAA"}
        scene_in = {"id": "42", "title": "", "code": "", "details": "", "director": "", "date": None,
                    "urls": [], "studio": None, "performers": [], "tags": [], "groups": [],
                    "stash_ids": [], "paths": {"screenshot": "http://x/scene/42/screenshot?t=" + str(BASE + 5)},
                    "created_at": "2026-09-21T08:00:00+08:00"}
        upd = mod.apply_scene_fill(g, "42", scene_in, sc, "https://javstash.org/graphql")
        scene_updates = [c for c in g.calls if "sceneUpdate" in c["q"]]
        # 只有主更新，无封面更新
        assert len(scene_updates) == 1
        assert "cover_image" not in scene_updates[0]["v"]["i"]
        assert upd["title"] == "JAV TITLE"            # 数据字段正常填充
    run("apply_scene_fill: nfo 已写封面 -> 跳过封面, 数据字段仍填充", t_fill_nfo_cover_skipped)

    print("ALL PASS")


if __name__ == "__main__":
    main()
