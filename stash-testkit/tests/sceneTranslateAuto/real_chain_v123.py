# -*- coding: utf-8 -*-
"""sceneTranslateAuto v1.2.3 真实链路验证（stash-testkit 推荐流程的轻量版）：
直接 sceneCreate 触发 Scene.Create.Post hook → 入队(快照) → worker 延迟 → 翻译写回。

场景 A（STA-777）：title/details 均假名占优日文 → 应两字段都被翻译成中文（验证优化2 逐 q 写回 + hook/worker 链路）
场景 B（STA-778）：title/details 汉字占优（含少量假名）→ 应保持原样不被翻译（验证优化3 跳过侧真实行为）
"""
import sys, time, os
# 相对定位 stash-testkit（本文件位于 stash-testkit/tests/sceneTranslateAuto/，上溯 3 级）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from stash_client import Stash

s = Stash()

def has_kana(t):
    return any("\u3040" <= c <= "\u30ff" for c in (t or ""))

def show(tag, sc):
    print("%s: id=%s title=%r details=%r kana=%s" % (
        tag, sc.get("id"), (sc.get("title") or "")[:60], (sc.get("details") or "")[:60], has_kana(sc.get("title"))))

# 场景 A：假名占优（hanzi: 温泉旅行=4 / kana: なまなかだし=6）
a = s.create_scene({"title": "STA-777 なまなかだし 温泉旅行",
                    "details": "なまなかだしの物語。温泉で美少女のシーンが続く。"})
# 场景 B：汉字占优（hanzi: 美少女温泉旅行=7 / kana: と=1）
b = s.create_scene({"title": "STA-778 美少女 と温泉旅行",
                    "details": "美少女温泉旅行の記録。"})
print("created A id=%s, B id=%s" % (a["id"], b["id"]))

t0 = time.time()
last_a = None
while time.time() - t0 < 300:
    sa = s.find_scene(a["id"])
    sb = s.find_scene(b["id"])
    if sa != last_a:
        show("A", sa)
        last_a = sa
    # A 已译（无假名）即达标；B 需保持假名（未被翻译）
    if sa and not has_kana(sa.get("title")) and not has_kana(sa.get("details")):
        ok_a = True
        break
    time.sleep(10)
else:
    ok_a = False

print("--- final states ---")
show("A", s.find_scene(a["id"]))
show("B", s.find_scene(b["id"]))
b2 = s.find_scene(b["id"])
ok_b = bool(b2) and has_kana(b2.get("title")) and has_kana(b2.get("details"))

print("RESULT A(translated both):", ok_a, " B(kept untranslated):", ok_b)
