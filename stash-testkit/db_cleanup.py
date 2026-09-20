# -*- coding: utf-8 -*-
"""测试后清理 DB 孤儿记录（已删文件但 DB 里残留的 files / scenes_files 行）。

何时用：sceneDestroy 只删场景关联；若测试视频文件被手动删除，files 表会残留记录
（下次扫描应能清理，但 rescan 崩溃等场景可能漏），本脚本兜底清理。

安全（务必遵守）：
  - 只删除 basename LIKE '<prefix>%' 的 files 行及其 scenes_files 关联——prefix 必填，
    是测试文件命名前缀（如 TST-），绝不可为空/过宽，否则会误删用户数据
  - 先停 Stash 再写库（Stash 内存缓存与 WAL 不同步，运行中直写会不一致），写后重启
  - 有备份再执行；执行前打印待删清单

用法：
  python db_cleanup.py --prefix TST-
（db/stash 路径读 config.json 的 db_path / stash_exe，可用环境变量覆盖）
"""
import argparse, json, os, sqlite3, subprocess, sys, time

def load_config():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def main():
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", required=True, help="测试文件 basename 前缀（白名单，如 TST-）")
    ap.add_argument("--db", default=cfg.get("db_path"))
    ap.add_argument("--stash-exe", default=cfg.get("stash_exe"))
    ap.add_argument("--dry-run", action="store_true", help="只打印待删清单不执行")
    args = ap.parse_args()

    if len(args.prefix) < 3:
        print("prefix 过短（<3 字符），拒绝执行")
        sys.exit(1)

    conn = sqlite3.connect(args.db, timeout=15)
    cur = conn.cursor()
    cur.execute("SELECT id, basename FROM files WHERE basename LIKE ?", (args.prefix + "%",))
    rows = cur.fetchall()
    print("待删 files:", rows)
    if args.dry_run:
        print("dry-run，未执行")
        return

    # 停 Stash
    if args.stash_exe:
        p = subprocess.run(["taskkill", "/IM", os.path.basename(args.stash_exe), "/F"],
                           capture_output=True, text=True)
        print("stop:", (p.stdout or p.stderr).strip())
        time.sleep(3)

    cur.execute("DELETE FROM scenes_files WHERE file_id IN (SELECT id FROM files WHERE basename LIKE ?)",
                (args.prefix + "%",))
    print("scenes_files deleted:", cur.rowcount)
    cur.execute("DELETE FROM files WHERE basename LIKE ?", (args.prefix + "%",))
    print("files deleted:", cur.rowcount)
    conn.commit()
    conn.close()

    # 重启 Stash
    if args.stash_exe and os.path.exists(args.stash_exe):
        proc = subprocess.Popen([args.stash_exe], cwd=os.path.dirname(args.stash_exe))
        print("stash restarted, pid:", proc.pid)

if __name__ == "__main__":
    main()
