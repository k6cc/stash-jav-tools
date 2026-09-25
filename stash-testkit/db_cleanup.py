# -*- coding: utf-8 -*-
"""测试后清理 DB 孤儿记录（已删文件但 DB 里残留的行）。

何时用：sceneDestroy 只删场景关联；若测试视频/图片文件被手动删除，files 表及各
关联表会残留记录（下次扫描应能清理，但 rescan 崩溃等场景可能漏），本脚本兜底清理。

覆盖范围（白名单 prefix 命中的 files 及其衍生孤儿）：
  - files                       按 basename LIKE '<prefix>%'
  - scenes_files                按上述 file_id 级联
  - images_files                按上述 file_id 级联（image→file 关联）
  - image_files                 按上述 file_id 级联（file 格式/宽高元数据）
  - files_fingerprints          按上述 file_id 级联（md5/oshash 指纹）
  - images                      全局扫描：无 images_files 关联且无 galleries_images
                                归属的孤儿 image 行（坑 ㉑ 场景：sceneGallerySync
                                为测试场景建的 gallery 视频条目，file 删了 image 还在）
  - 上述孤儿 image 的子关联：images_tags / performers_images / image_urls /
                                image_custom_fields / galleries_images

安全（务必遵守）：
  - 只删除 basename LIKE '<prefix>%' 的 files 行及其级联——prefix 必填且 >=3 字符，
    绝不可为空/过宽，否则会误删用户数据
  - 孤儿 image 扫描是全局的（不按 prefix），但只删"无任何 file 关联且无任何 gallery
    归属"的 image，正常 image 一定有 images_files 行，不会被误删
  - 先停 Stash 再写库（Stash 内存缓存与 WAL 不同步，运行中直写会不一致），写后重启
  - 有备份再执行；执行前打印待删清单（--dry-run 只打印不执行）

用法：
  python db_cleanup.py --prefix TST-
  python db_cleanup.py --prefix TST- --dry-run
（db/stash 路径读 config.json 的 db_path / stash_exe，可用环境变量覆盖）
"""
import argparse, json, os, sqlite3, subprocess, sys, time

# 孤儿 image 删除时顺带清理的子关联表（都有 image_id 列）
IMAGE_CHILD_TABLES = ("images_tags", "performers_images", "image_urls",
                      "image_custom_fields", "galleries_images")


def load_config():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def placeholders(n):
    return ",".join("?" * n)


def main():
    cfg = load_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", required=True,
                    help="测试文件 basename 前缀（白名单，如 TST-）")
    ap.add_argument("--db", default=cfg.get("db_path"))
    ap.add_argument("--stash-exe", default=cfg.get("stash_exe"))
    ap.add_argument("--dry-run", action="store_true",
                    help="只打印待删清单不执行")
    args = ap.parse_args()

    if len(args.prefix) < 3:
        print("prefix 过短（<3 字符），拒绝执行")
        sys.exit(1)
    if not args.db:
        print("未配置 db_path（config.json 或 --db）")
        sys.exit(1)

    like = args.prefix + "%"
    conn = sqlite3.connect(args.db, timeout=15)
    cur = conn.cursor()

    # ---- 1. 收集待删 file id ----
    cur.execute("SELECT id, basename FROM files WHERE basename LIKE ?", (like,))
    file_rows = cur.fetchall()
    file_ids = [r[0] for r in file_rows]
    print(f"待删 files ({len(file_rows)}):")
    for r in file_rows:
        print(f"  id={r[0]}  basename={r[1]}")

    # ---- 2. 统计各关联表将被级联删除的行数（dry-run 也要看） ----
    cascade_counts = {}
    if file_ids:
        ph = placeholders(len(file_ids))
        for t in ("scenes_files", "images_files", "image_files", "files_fingerprints"):
            try:
                n = cur.execute(
                    f"SELECT COUNT(*) FROM {t} WHERE file_id IN ({ph})",
                    file_ids,
                ).fetchone()[0]
                cascade_counts[t] = n
            except Exception as e:
                cascade_counts[t] = f"err: {e}"
        print("级联关联表待删行数：")
        for t, n in cascade_counts.items():
            print(f"  {t}: {n}")

    # ---- 3. 全局孤儿 image：无 file 关联 且 无 gallery 归属 ----
    cur.execute("""
        SELECT i.id, i.title
        FROM images i
        LEFT JOIN images_files if2 ON if2.image_id = i.id
        LEFT JOIN galleries_images gi ON gi.image_id = i.id
        WHERE if2.image_id IS NULL AND gi.image_id IS NULL
    """)
    orphan_images = cur.fetchall()
    orphan_ids = [r[0] for r in orphan_images]
    print(f"孤儿 images（无 file 关联且无 gallery 归属，{len(orphan_images)}）:")
    for r in orphan_images:
        print(f"  image id={r[0]}  title={r[1]}")

    if args.dry_run:
        print("dry-run，未执行")
        conn.close()
        return

    if not file_ids and not orphan_ids:
        print("没有待删数据，退出")
        conn.close()
        return

    # ---- 4. 停 Stash ----
    if args.stash_exe:
        p = subprocess.run(
            ["taskkill", "/IM", os.path.basename(args.stash_exe), "/F"],
            capture_output=True, text=True,
        )
        print("stop:", (p.stdout or p.stderr).strip())
        time.sleep(3)

    # ---- 5. 执行删除（单事务） ----
    try:
        cur.execute("BEGIN")
        if file_ids:
            ph = placeholders(len(file_ids))
            for t in ("scenes_files", "images_files", "image_files",
                      "files_fingerprints"):
                cur.execute(
                    f"DELETE FROM {t} WHERE file_id IN ({ph})", file_ids)
                print(f"{t} deleted:", cur.rowcount)
            cur.execute("DELETE FROM files WHERE id IN (%s)" % ph, file_ids)
            print("files deleted:", cur.rowcount)

        if orphan_ids:
            ph = placeholders(len(orphan_ids))
            for t in IMAGE_CHILD_TABLES:
                try:
                    cur.execute(
                        f"DELETE FROM {t} WHERE image_id IN ({ph})", orphan_ids)
                    print(f"{t} deleted:", cur.rowcount)
                except Exception as e:
                    print(f"{t} skip: {e}")
            cur.execute("DELETE FROM images WHERE id IN (%s)" % ph, orphan_ids)
            print("images deleted:", cur.rowcount)

        conn.commit()
        print("COMMITTED")
    except Exception as e:
        conn.rollback()
        print("ROLLED BACK:", e)
        raise
    finally:
        conn.close()

    # ---- 6. 重启 Stash ----
    if args.stash_exe and os.path.exists(args.stash_exe):
        proc = subprocess.Popen(
            [args.stash_exe], cwd=os.path.dirname(args.stash_exe))
        print("stash restarted, pid:", proc.pid)


if __name__ == "__main__":
    main()
