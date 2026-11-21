# -*- coding: utf-8 -*-
"""插件 plugin-data 的 state.json 快照/还原。

为什么需要它：改插件状态做 UI 验证（临时把某条改成 imported 截图、点「清空记录」、
试批量暂停）都可能不可逆地动到用户数据；先 snap 一份，测完 restore 就行。
后台守护进程若开着会在 90 秒内整份覆盖 scenes，验证前先停守护。

用法：
  python state_snapshot.py snap SceneBackfill
  python state_snapshot.py restore SceneBackfill
  python state_snapshot.py show SceneBackfill [--status]

选项：
  --data-root <dir>   默认 E:/stashAPP/plugin-data（Stash 的插件数据根目录）
  --keep              还原后保留 .snap 文件（默认删掉，避免误用过期快照）
"""
import json
import os
import shutil
import sys
from collections import Counter

ROOT = "E:/stashAPP/plugin-data"


def main(argv):
    argv = argv[1:]
    root = ROOT
    if "--data-root" in argv:
        i = argv.index("--data-root")
        root = argv[i + 1]
        del argv[i:i + 2]
    keep = "--keep" in argv
    argv = [a for a in argv if a != "--keep"]
    show_status = "--status" in argv
    argv = [a for a in argv if a != "--status"]
    if len(argv) < 2:
        print(__doc__)
        return 1

    cmd, plugin = argv[0], argv[1]
    d = os.path.join(root, plugin)
    state = os.path.join(d, "state.json")
    snap = state + ".snap"

    if cmd == "snap":
        if not os.path.isfile(state):
            print(f"没有 state.json：{state}")
            return 2
        shutil.copy(state, snap)
        print(f"已快照 -> {snap}")
        return 0

    if cmd == "restore":
        if not os.path.isfile(snap):
            print(f"没有快照：{snap}")
            return 2
        shutil.copy(snap, state)
        if not keep:
            os.remove(snap)
        print(f"已还原 <- {snap}" + ("（快照保留）" if keep else "（快照已删）"))
        return 0

    if cmd == "show":
        if not os.path.isfile(state):
            print(f"没有 state.json：{state}")
            return 2
        st = json.load(open(state, encoding="utf-8"))
        print("顶层键:", ", ".join(sorted(st.keys())))
        scenes = st.get("scenes") or {}
        if show_status:
            print("状态分布:", dict(Counter(r.get("status") for r in scenes.values())))
            for sid, r in scenes.items():
                print(f"  {sid}\t{r.get('status')}\t{r.get('code') or ''}")
        else:
            print(f"scenes={len(scenes)} content={len(st.get('content') or {})} "
                  f"control={st.get('control')}")
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
