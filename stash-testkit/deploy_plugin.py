# -*- coding: utf-8 -*-
"""把插件源码目录同步到 Stash 插件目录，重载并校验版本。

为什么需要它：改完插件每次都是「复制 → reloadPlugins → 查 version」三步，
漏一步就会出现「代码是新的、跑的还是旧副本」（同 id 旧目录优先加载）。
本脚本把三步固化，并在插件根目录下发现同 id 的第二份 yml 时直接报警。

用法：
  python deploy_plugin.py E:/Temp/stash-jav-tools/SceneBackfill
  python deploy_plugin.py <src> --dest E:/stashAPP/plugins/k6cc
  python deploy_plugin.py <src> --no-reload        # 只同步不重载
  python deploy_plugin.py <src> --in-place         # 覆盖文件，不删目录

约定：
  - 插件 id 默认取源码目录名；yml 必须是 `<id>.yml`
  - 目标目录默认读 config.json 的 `plugin_dir`
  - 默认同步是「先删后拷」，源码里删掉的文件不会残留在部署目录
  - `--in-place` 保留目标目录本身、只覆盖文件：删目录会被 Stash 当成卸载，
    从插件源安装的插件会退化成「本地安装」，之后检查更新就找不到线上版本了
  - 退出码：0 版本校验通过；2 同步/重载/版本不符
"""
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stash_client import Stash, load_config  # noqa: E402


def read_version(yml):
    try:
        txt = yml.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(r"^version:\s*['\"]?([^'\"\s]+)", txt, re.M)
    return m.group(1) if m else None


def duplicate_ymls(plugins_root, plugin_id, keep_dir):
    """插件根目录下同 id 的其他 yml —— Stash 可能加载到旧副本。"""
    out = []
    for p in plugins_root.rglob(plugin_id + ".yml"):
        if keep_dir not in p.parents:
            out.append(p)
    return out


def main(argv):
    argv = argv[1:]
    if not argv:
        print(__doc__)
        return 1

    src = Path(argv.pop(0)).resolve()
    dest_root = None
    reload_ = True
    in_place = False
    timeout = 20.0
    if "--dest" in argv:
        i = argv.index("--dest")
        dest_root = Path(argv[i + 1]).resolve()
        del argv[i:i + 2]
    if "--no-reload" in argv:
        reload_ = False
    if "--in-place" in argv:
        argv.remove("--in-place")
        in_place = True
    if "--timeout" in argv:
        i = argv.index("--timeout")
        timeout = float(argv[i + 1])

    plugin_id = src.name
    yml = src / (plugin_id + ".yml")
    if not yml.is_file():
        print(f"[x] 源码目录里没有 {plugin_id}.yml：{src}")
        return 2
    want = read_version(yml)
    if not want:
        print(f"[x] {yml.name} 里读不到 version")
        return 2

    if dest_root is None:
        dest_root = Path(load_config().get("plugin_dir") or "E:/stashAPP/plugins/k6cc")
    dest = dest_root / plugin_id
    dest_root.mkdir(parents=True, exist_ok=True)

    if dest.exists() and in_place:
        # Keep the folder: deleting it makes Stash treat a source-installed
        # plugin as a local copy, so "check for updates" stops matching it.
        for p in src.rglob("*"):
            rel = p.relative_to(src)
            if any(x in ("__pycache__", ".git") for x in rel.parts):
                continue
            if p.suffix in (".pyc", ".snap"):
                continue
            target = dest / rel
            if p.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, target)
    else:
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns(
            "__pycache__", "*.pyc", ".git", "*.snap"))
    print(f"[1/3] 已同步 {src} -> {dest}")

    dups = duplicate_ymls(dest_root.parent, plugin_id, dest)
    if dups:
        print("[!] 发现同 id 的其他副本（Stash 可能加载它）：")
        for p in dups:
            print("    " + str(p))

    if not reload_:
        print("[2/3] 跳过重载")
        return 0 if not dups else 2

    s = Stash()
    try:
        s.gql("mutation{ reloadPlugins }")
    except Exception as e:
        print(f"[!] reloadPlugins 失败（实例可能正在重启）：{e}")
    print("[2/3] 已请求 reloadPlugins")

    deadline = time.time() + timeout
    got = None
    while time.time() < deadline:
        try:
            data = s.gql("query{ plugins { id version } }")
            for p in (data.get("data") or {}).get("plugins") or []:
                if p.get("id") == plugin_id:
                    got = p.get("version")
                    break
            if got:
                break
        except Exception:
            pass
        time.sleep(0.5)

    if got != want:
        print(f"[3/3] [x] 版本不符：部署目标 {want}，实例返回 {got}")
        return 2
    print(f"[3/3] [ok] {plugin_id} v{got} 已生效")
    return 0 if not dups else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
