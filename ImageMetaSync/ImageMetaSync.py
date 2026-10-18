#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Image Meta Sync v1.0.0: 把场景级元数据回填到场景图库的图片记录（封面 + fanart + 剧照）。

- 钩子 Gallery.Create.Post / Gallery.Update.Post：派生 detached 子进程处理该图库，不阻塞扫描队列。
- 任务 "Sync Image Metadata"：批量处理全部图库；开启 includeScenesWithoutGallery 时兜底处理无图库场景。

设计要点：
- 以图库为处理单元，演员取该图库所有关联场景的并集；并集 != 1（0 个或 2 个以上）时整库跳过并记录日志。
- 字段只补空（overwrite 例外），逐图 imageUpdate 写入；不碰 rating100 / photographer / organized。
- 标题方案 B：封面用纯标题，剧照用「标题 #N」，N 优先取文件名尾部数字，冲突顺延到空号。
- 轻量单实例运行锁 + 变更队列，合并短时间内的重复图库变更事件。
"""

import sys
import json
import os
import re
import time
import subprocess

# Windows 管道默认 cp936 编码，标题含中日文时写 stderr 会乱码（stash 按 UTF-8 读取）
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# 确保插件目录在 sys.path 最前，避免同名 config 模块被其他路径抢占
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import config
import log
from stashInterface import StashInterface

# 多碟/分集后缀（与 sceneGallerySync 同源，用于无图库场景的封面/fanart 文件名链）
MULTIPART_RE = re.compile(r'[-_](?:(?:cd|disc|part|pt)\d+|[a-z])$', re.IGNORECASE)

# 钩子路径：等待图库图片挂载完成的轮询参数
READY_POLL_INTERVAL = 3
READY_POLL_ATTEMPTS = 6
READY_EMPTY_BREAK_AFTER = 3


class ImageMetaSync:

    PENDING_DIR = os.path.join(_PLUGIN_DIR, ".ims_pending")
    LOCK_FILE = os.path.join(PENDING_DIR, "run.lock")
    QUEUE_FILE = os.path.join(PENDING_DIR, "queue.jsonl")

    def __init__(self, stash):
        self._stash = stash
        self._settings = None
        self._excluded_tag_names = None

    # ============================================================
    # 入口
    # ============================================================

    def process(self):
        mode = self._stash.get_mode()
        hook_type = self._stash.get_hook_type()

        if mode == "background":
            return self.__background_run(self._stash.get_gallery_id())

        if hook_type in ("Gallery.Create.Post", "Gallery.Update.Post"):
            return self.__spawn_background(self._stash.get_hook_id())

        if mode == "sync_all":
            return self.__batch_sync_all()

        log.LogWarning(f"Unknown mode/hook: mode={mode} hook={hook_type}")

    # ============================================================
    # 设置
    # ============================================================

    def __settings(self):
        if self._settings is None:
            self._settings = self._stash.gql_getPluginSettings("ImageMetaSync")
        return self._settings

    def __excluded_tags(self):
        if self._excluded_tag_names is None:
            raw = self.__settings().get("excludeTags") or ""
            self._excluded_tag_names = set(n.strip().lower() for n in str(raw).split(",") if n.strip())
        return self._excluded_tag_names

    # ============================================================
    # 钩子：轻量派生后台进程（绝不阻塞扫描/其他后台任务）
    # ============================================================

    def __cleanup_stale_tasks(self):
        try:
            if not os.path.isdir(self.PENDING_DIR):
                return
            now = time.time()
            for f in os.listdir(self.PENDING_DIR):
                if not (f.endswith('.json') or f.endswith('.log')):
                    continue
                fp = os.path.join(self.PENDING_DIR, f)
                if os.path.isfile(fp) and now - os.path.getmtime(fp) > config.get_stale_file_max_age():
                    try:
                        os.unlink(fp)
                    except OSError:
                        pass
        except OSError:
            pass

    def __spawn_background(self, gallery_id):
        if not gallery_id:
            log.LogWarning("Gallery hook without id, skipped")
            return
        self.__cleanup_stale_tasks()
        os.makedirs(self.PENDING_DIR, exist_ok=True)

        task_file = os.path.join(self.PENDING_DIR, f"{gallery_id}.json")
        try:
            with open(task_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "gallery_id": str(gallery_id),
                    "server_connection": self._stash.server_connection(),
                }, f)
        except Exception as e:
            log.LogError(f"Task write failed: {repr(e)}")
            return

        python_exe = sys.executable
        script_path = os.path.abspath(__file__)
        plugin_dir = os.path.dirname(script_path)

        # 重定向 stdin/stdout 到 DEVNULL、stderr 到日志文件：
        # 否则后台子进程继承前台 stash 管道句柄，stash 收不到 EOF 会一直阻塞钩子
        log_path = os.path.join(self.PENDING_DIR, f"{gallery_id}.log")
        log_fh = open(log_path, 'a', encoding='utf-8')

        try:
            if sys.platform == "win32":
                subprocess.Popen(
                    [python_exe, script_path, task_file],
                    creationflags=0x00000008 | 0x00000200,
                    close_fds=True,
                    cwd=plugin_dir,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=log_fh,
                )
            else:
                subprocess.Popen(
                    [python_exe, script_path, task_file],
                    start_new_session=True,
                    close_fds=True,
                    cwd=plugin_dir,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=log_fh,
                )
        except Exception as e:
            log.LogError(f"Background start failed: {repr(e)}")
            return
        finally:
            log_fh.close()

        # stash 日志留痕：detached 进程无法写 stash 日志，后台结果只在 .ims_pending/{gallery_id}.log
        log.LogInfo(f"Gallery {gallery_id}: image metadata sync started in background "
                    f"(details: .ims_pending/{gallery_id}.log)")

    # ============================================================
    # 后台运行：单实例锁 + 变更队列（合并短时间内的重复图库变更）
    # ============================================================

    def __background_run(self, gallery_id):
        if not gallery_id:
            log.LogWarning("No gallery_id in background task")
            return
        self.__cleanup_stale_tasks()

        if not self.__acquire_lock():
            # 已有后台运行中：只登记本次变更，由运行中的进程代跑，避免并发重入
            self.__enqueue(gallery_id)
            log.LogInfo(f"Gallery {gallery_id}: another run in progress, queued")
            return

        try:
            seen = set()
            pending = [str(gallery_id)]
            while pending:
                gid = pending.pop(0)
                if gid in seen:
                    continue
                seen.add(gid)
                try:
                    self.__process_gallery(gid, wait_for_images=True)
                except Exception as e:
                    log.LogError(f"Gallery {gid} failed: {repr(e)}")
                pending.extend(self.__drain_queue())
        finally:
            self.__release_lock()

    def __acquire_lock(self):
        os.makedirs(self.PENDING_DIR, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, json.dumps({"pid": os.getpid(), "t": time.time()}).encode("utf-8"))
                os.close(fd)
                return True
            except FileExistsError:
                if self.__lock_stale():
                    try:
                        os.unlink(self.LOCK_FILE)
                    except OSError:
                        pass
                    continue
                return False
        return False

    def __lock_stale(self):
        try:
            return time.time() - os.path.getmtime(self.LOCK_FILE) > config.get_lock_stale_max_age()
        except OSError:
            return True

    def __release_lock(self):
        try:
            os.unlink(self.LOCK_FILE)
        except OSError:
            pass

    def __enqueue(self, gallery_id):
        try:
            with open(self.QUEUE_FILE, 'a', encoding='utf-8') as f:
                f.write(json.dumps({"gallery_id": str(gallery_id)}) + "\n")
        except OSError as e:
            log.LogError(f"Queue write failed: {repr(e)}")

    def __drain_queue(self):
        # 先改名再读，避免与并发追加写者互相覆盖
        proc_file = self.QUEUE_FILE + ".proc"
        try:
            os.rename(self.QUEUE_FILE, proc_file)
        except OSError:
            return []
        ids = []
        try:
            with open(proc_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ids.append(str(json.loads(line).get("gallery_id")))
                    except ValueError:
                        continue
        except OSError:
            pass
        try:
            os.unlink(proc_file)
        except OSError:
            pass
        return ids

    # ============================================================
    # 工具
    # ============================================================

    @staticmethod
    def __union_ids(scenes, field):
        out = []
        for s in scenes:
            for item in s.get(field) or []:
                i = item.get("id")
                if i and i not in out:
                    out.append(i)
        return out

    @staticmethod
    def __pick(scenes, field):
        """各场景该字段的非空值；唯一才采用，否则视为无法确认（返回 None）"""
        vals = []
        for s in scenes:
            v = s.get(field)
            if v is None or v == "":
                continue
            if v not in vals:
                vals.append(v)
        return vals[0] if len(vals) == 1 else None

    @staticmethod
    def __pick_id(scenes, field):
        ids = []
        for s in scenes:
            i = (s.get(field) or {}).get("id")
            if i and i not in ids:
                ids.append(i)
        return ids[0] if len(ids) == 1 else None

    @staticmethod
    def __union_list(scenes, field):
        out = []
        for s in scenes:
            for v in s.get(field) or []:
                if v not in out:
                    out.append(v)
        return out

    def __scene_tags(self, scenes):
        excluded = self.__excluded_tags()
        out = []
        for s in scenes:
            for t in s.get("tags") or []:
                i = t.get("id")
                if not i or i in out:
                    continue
                if excluded and (t.get("name") or "").strip().lower() in excluded:
                    continue
                out.append(i)
        return out

    @staticmethod
    def __first_path(image):
        paths = []
        for vf in image.get("visual_files") or []:
            if isinstance(vf, dict) and vf.get("path"):
                paths.append(vf["path"])
        return sorted(paths)[0] if paths else ""

    @staticmethod
    def __trailing_number(path):
        stem = os.path.splitext(os.path.basename(path or ""))[0]
        m = re.search(r'(\d+)$', stem)
        return int(m.group(1)) if m else None

    def __filename_chain(self, scene_filename):
        chain = [scene_filename]
        result = scene_filename
        while True:
            new_result = MULTIPART_RE.sub('', result)
            if new_result == result:
                break
            chain.append(new_result)
            result = new_result
        if ' ' in chain[-1]:
            first_word = chain[-1].split()[0]
            if first_word != chain[-1]:
                chain.append(first_word)
        return chain

    # ============================================================
    # 元数据解析（统一入口：图库路径传 scenes + gallery，兜底路径传单场景）
    # ============================================================

    def __resolve_meta(self, scenes, gallery, performer_id):
        s = self.__settings()
        fill_title = s.get("fillTagsTitleCode") is not False
        fill_details = s.get("fillUrlsDetails") is True

        title = self.__pick(scenes, "title") or (gallery or {}).get("title") or ""

        return {
            "overwrite": s.get("overwrite") is True,
            "performer_id": performer_id,
            "title": title if fill_title else None,
            "code": self.__pick(scenes, "code") if fill_title else None,
            "tag_ids": self.__scene_tags(scenes) if fill_title else [],
            "date": self.__pick(scenes, "date"),
            "studio_id": self.__pick_id(scenes, "studio"),
            "urls": self.__union_list(scenes, "urls") if fill_details else None,
            "details": self.__pick(scenes, "details") if fill_details else None,
        }

    def __used_numbers(self, images, cover_id, base_title):
        used = set()
        if not base_title:
            return used
        pat = re.compile(r'^' + re.escape(base_title) + r'\s*#(\d+)$')
        for img in images:
            if img["id"] == cover_id:
                continue
            m = pat.match((img.get("title") or "").strip())
            if m:
                used.add(int(m.group(1)))
        return used

    def __apply_to_images(self, images, cover_id, meta):
        base_title = meta.get("title")
        ow = meta["overwrite"]
        ordered = sorted(images, key=self.__first_path)

        # 标题编号：封面用纯标题，剧照用「标题 #N」；已有标题占位，冲突则顺延。
        # 先按文件名尾部数字分配（fanart1→#1），再给无数字的图顺延，避免整体挤号
        titles = {}
        if base_title:
            used = set() if ow else self.__used_numbers(images, cover_id, base_title)
            if cover_id:
                cur = next((i.get("title") or "" for i in images if i["id"] == cover_id), "")
                if ow or not cur.strip():
                    titles[cover_id] = base_title
            assignable = [i for i in ordered if i["id"] != cover_id
                          and (ow or not (i.get("title") or "").strip())]
            numbered, plain = [], []
            for img in assignable:
                n = self.__trailing_number(self.__first_path(img))
                (numbered if n is not None else plain).append((n, img))
            numbered.sort(key=lambda t: t[0])
            for n, img in numbered + plain:
                if n is None:
                    n = 1
                while n in used:
                    n += 1
                used.add(n)
                titles[img["id"]] = f"{base_title} #{n}"

        updated = 0
        for img in ordered:
            upd = {"id": img["id"]}
            if meta.get("performer_id") and (ow or not (img.get("performers") or [])):
                upd["performer_ids"] = [meta["performer_id"]]
            if meta.get("studio_id") and (ow or not (img.get("studio") or {}).get("id")):
                upd["studio_id"] = meta["studio_id"]
            if meta.get("date") and (ow or not img.get("date")):
                upd["date"] = meta["date"]
            if meta.get("code") and (ow or not img.get("code")):
                upd["code"] = meta["code"]
            if meta.get("details") and (ow or not img.get("details")):
                upd["details"] = meta["details"]
            if meta.get("urls") and (ow or not img.get("urls")):
                upd["urls"] = meta["urls"]
            if meta.get("tag_ids") and (ow or not (img.get("tags") or [])):
                upd["tag_ids"] = meta["tag_ids"]
            t = titles.get(img["id"])
            if t and (ow or not (img.get("title") or "").strip()):
                upd["title"] = t
            if len(upd) > 1:
                self._stash.gql_imageUpdate(upd)
                updated += 1
        return updated

    # ============================================================
    # 图库路径
    # ============================================================

    def __wait_gallery_ready(self, gallery_id, gallery):
        # 钩子在 galleryCreate 时触发，此时 sceneGallerySync 还没把图片挂到图库，
        # 需等图片数量连续两次读取相同（稳定）再处理，否则只能改到封面
        prev = None
        cur = gallery.get("image_count") or 0
        for attempt in range(READY_POLL_ATTEMPTS):
            if cur and cur == prev:
                return gallery
            if not cur and attempt >= READY_EMPTY_BREAK_AFTER:
                break
            prev = cur
            time.sleep(READY_POLL_INTERVAL)
            g = self._stash.gql_findGallery(gallery_id)
            if not g:
                break
            gallery = g
            cur = g.get("image_count") or 0
        return gallery

    def __process_gallery(self, gallery_id, gallery=None, wait_for_images=False, verbose=True):
        # 返回 (状态, 更新图片数)：ok / missing / no_scene / ambiguous / no_images
        g = gallery or self._stash.gql_findGallery(gallery_id)
        if not g:
            log.LogWarning(f"Gallery {gallery_id} not found")
            return "missing", 0

        scenes = g.get("scenes") or []
        if not scenes:
            if verbose:
                log.LogInfo(f"Gallery {gallery_id} '{g.get('title')}': no linked scene, skipped")
            return "no_scene", 0

        performer_ids = self.__union_ids(scenes, "performers")
        if len(performer_ids) != 1:
            titles = ", ".join((s.get("title") or s["id"]) for s in scenes[:3])
            log.LogWarning(
                f"Gallery {gallery_id} '{g.get('title')}' skipped: {len(performer_ids)} performer(s) "
                f"across {len(scenes)} scene(s) [{titles}]")
            return "ambiguous", 0

        if wait_for_images:
            g = self.__wait_gallery_ready(gallery_id, g)
            scenes = g.get("scenes") or scenes

        images = self._stash.gql_findImagesInGallery(gallery_id)
        if not images:
            if verbose:
                log.LogInfo(f"Gallery {gallery_id} '{g.get('title')}': no images, skipped")
            return "no_images", 0

        meta = self.__resolve_meta(scenes, g, performer_ids[0])
        cover_id = (g.get("cover") or {}).get("id")
        updated = self.__apply_to_images(images, cover_id, meta)
        if verbose and updated:
            log.LogInfo(f"Gallery {gallery_id} '{g.get('title')}': {len(images)} image(s) checked, "
                        f"{updated} updated")
        return "ok", updated

    # ============================================================
    # 无图库场景兜底（仅封面/fanart/poster，按文件名匹配）
    # ============================================================

    def __process_scene_no_gallery(self, scene_id, verbose=True):
        scene = self._stash.gql_findSceneFull(scene_id)
        if not scene or not scene.get("files"):
            log.LogWarning(f"Scene {scene_id} not found or no files")
            return "missing", 0

        performers = scene.get("performers") or []
        if len(performers) != 1:
            log.LogWarning(f"Scene {scene_id} '{scene.get('title')}' skipped: "
                           f"{len(performers)} performer(s)")
            return "ambiguous", 0

        scene_path = scene["files"][0]["path"]
        scene_dir = os.path.dirname(scene_path)
        scene_filename = os.path.splitext(os.path.basename(scene_path))[0]
        chain = self.__filename_chain(scene_filename)

        found = self._stash.gql_findImagesInDirectory(scene_dir)
        if not found:
            if verbose:
                log.LogInfo(f"Scene {scene_id} '{scene.get('title')}': no indexed image, skipped")
            return "no_images", 0

        poster_id = None
        for name in config.get_poster_filenames():
            for fn in chain:
                p = os.path.join(scene_dir, name.replace("{filename}", fn))
                iid = found.get(p.replace("\\", "/").lower()) if os.path.isfile(p) else None
                if iid:
                    poster_id = iid
                    break
            if poster_id:
                break

        ids = [poster_id] if poster_id else []
        for name in config.get_fanart_filenames():
            for fn in chain:
                p = os.path.join(scene_dir, name.replace("{filename}", fn))
                iid = found.get(p.replace("\\", "/").lower()) if os.path.isfile(p) else None
                if iid and iid not in ids:
                    ids.append(iid)

        if not ids:
            if verbose:
                log.LogInfo(f"Scene {scene_id} '{scene.get('title')}': no cover/fanart image, skipped")
            return "no_images", 0

        images = self._stash.gql_findImagesByIds(ids)
        if not images:
            return "no_images", 0

        meta = self.__resolve_meta([scene], None, performers[0]["id"])
        if not meta.get("title"):
            meta["title"] = scene_filename
        updated = self.__apply_to_images(images, poster_id, meta)
        if verbose and updated:
            log.LogInfo(f"Scene {scene_id} '{scene.get('title')}' (no gallery): "
                        f"{len(images)} image(s) checked, {updated} updated")
        return "ok", updated

    # ============================================================
    # 批量任务
    # ============================================================

    def __batch_sync_all(self):
        include_no_gallery = self.__settings().get("includeScenesWithoutGallery") is True

        galleries = self._stash.gql_findAllGalleries()
        total = len(galleries)
        log.LogInfo(f"Batch: {total} galleries")
        counts = {"ok": 0, "no_scene": 0, "ambiguous": 0, "no_images": 0, "missing": 0, "failed": 0}
        updated = 0
        for idx, g in enumerate(galleries, 1):
            try:
                status, n = self.__process_gallery(g["id"], gallery=g, verbose=False)
                counts[status] = counts.get(status, 0) + 1
                updated += n
            except Exception as e:
                counts["failed"] += 1
                log.LogError(f"[{idx}/{total}] gallery {g['id']} error: {repr(e)}")
            log.LogProgress(idx / total)
            if idx % 50 == 0:
                log.LogInfo(f"Progress: {idx}/{total} (ok={counts['ok']} no_scene={counts['no_scene']} "
                            f"ambiguous={counts['ambiguous']} no_images={counts['no_images']} "
                            f"failed={counts['failed']}, images_updated={updated})")

        log.LogInfo(f"Batch galleries done: total={total} ok={counts['ok']} "
                    f"no_scene={counts['no_scene']} ambiguous={counts['ambiguous']} "
                    f"no_images={counts['no_images']} missing={counts['missing']} "
                    f"failed={counts['failed']} images_updated={updated}")

        if not include_no_gallery:
            return

        scenes = self._stash.gql_findScenesWithoutGallery()
        total = len(scenes)
        log.LogInfo(f"Batch fallback: {total} scenes without gallery")
        counts = {"ok": 0, "ambiguous": 0, "no_images": 0, "missing": 0, "failed": 0}
        updated = 0
        for idx, (sid, _path) in enumerate(scenes, 1):
            try:
                status, n = self.__process_scene_no_gallery(sid, verbose=False)
                counts[status] = counts.get(status, 0) + 1
                updated += n
            except Exception as e:
                counts["failed"] += 1
                log.LogError(f"[{idx}/{total}] scene {sid} error: {repr(e)}")
            log.LogProgress(idx / total)
            if idx % 50 == 0:
                log.LogInfo(f"Progress: {idx}/{total} (ok={counts['ok']} ambiguous={counts['ambiguous']} "
                            f"no_images={counts['no_images']} failed={counts['failed']}, "
                            f"images_updated={updated})")

        log.LogInfo(f"Batch fallback done: total={total} ok={counts['ok']} "
                    f"ambiguous={counts['ambiguous']} no_images={counts['no_images']} "
                    f"missing={counts['missing']} failed={counts['failed']} images_updated={updated}")


if __name__ == '__main__':
    try:
        is_background = False
        if len(sys.argv) > 1:
            arg = sys.argv[1]
            if arg.endswith('.json') and os.path.isfile(arg):
                with open(arg, 'r', encoding='utf-8') as f:
                    task = json.load(f)
                try:
                    os.unlink(arg)
                except OSError:
                    pass
                fragment = {
                    "server_connection": task["server_connection"],
                    "args": {"mode": "background", "gallery_id": task["gallery_id"]},
                }
                is_background = True
            else:
                fragment = json.loads(arg)
        else:
            fragment = json.loads(sys.stdin.read())

        if is_background:
            log.set_plain(True)

        stash = StashInterface(fragment)
        ImageMetaSync(stash).process()
        stash.exit_plugin("OK")
    except Exception as e:
        print(f'\x01e\x02[ImageMetaSync] FATAL: {repr(e)}\n', file=sys.stderr, flush=True)
        sys.exit(1)
