import sys
import json
import os
import re
import time
import subprocess

# 确保插件目录在 sys.path 最前，避免同名 config 模块被其他路径抢占
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

import config
import log
from stashInterface import StashInterface


class SceneGallerySync:

    MULTIPART_RE = re.compile(r'[-_](?:(?:cd|disc|part|pt)\d+|[a-z])$', re.IGNORECASE)
    PENDING_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".sgs_pending")

    def __init__(self, stash):
        self._stash = stash

    def process(self):
        mode = self._stash.get_mode()
        scene_id = self._stash.get_scene_id()
        hook_type = self._stash.get_hook_type()
        log.LogInfo(f"mode={mode} hook={hook_type} scene_id={scene_id}")

        if hook_type == "Scene.Create.Post":
            return

        if mode == "create_gallery":
            if not scene_id:
                # 任务界面直接点击（无 scene_id）：批量处理所有未关联图库的场景
                return self.__batch_create_galleries()
            # 按钮触发：图片入库由扫描负责，不做入库轮询，直接创建或立即失败
            # stash 对插件任务失败也标 FINISHED（job 状态不可依赖），
            # 前端通过解析本次任务写入 stash 的原始日志判定真实结果
            return self.__create_gallery_for_scene(scene_id, wait_for_images=False)

        if not scene_id:
            log.LogWarning("No scene_id")
            return
        elif hook_type == "Scene.Update.Post":
            if not self._stash.gql_checkPluginEnabled("nfoSceneParser"):
                log.LogInfo("nfoSceneParser not found, exiting")
                return
            # 前台阶段先检查 extrafanart 文件夹
            # extrafanart 是文件系统状态，不依赖 nfoSceneParser 的元数据写入
            # 无 extrafanart 的 scene（如 /social/x/ 抓取内容）直接跳过，避免启动无谓的后台轮询
            scene = self._stash.gql_findScene(scene_id)
            if not scene or not scene.get("files"):
                log.LogWarning(f"Scene {scene_id} not found or no files")
                return
            scene_dir = os.path.dirname(scene["files"][0]["path"])
            if not self.__find_extrafanart_folder(scene_dir):
                log.LogInfo("No extrafanart folder, skipping")
                return
            self.__spawn_background(scene_id)
        elif mode == "background":
            self.__run_background(scene_id)
        else:
            self.__create_gallery_for_scene(scene_id)

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

    def __spawn_background(self, scene_id):
        self.__cleanup_stale_tasks()
        os.makedirs(self.PENDING_DIR, exist_ok=True)
        task_file = os.path.join(self.PENDING_DIR, f"{scene_id}.json")
        try:
            with open(task_file, 'w', encoding='utf-8') as f:
                json.dump({
                    "scene_id": str(scene_id),
                    "server_connection": self._stash._fragment.get("server_connection", {}),
                }, f)
        except Exception as e:
            log.LogError(f"Task write failed: {repr(e)}")
            return

        python_exe = sys.executable
        script_path = os.path.abspath(__file__)
        plugin_dir = os.path.dirname(script_path)

        # 重定向 stdin/stdout 到 DEVNULL，stderr 到日志文件
        # 关键：如果不重定向，后台子进程会继承前台的 stdout/stderr 管道句柄，
        # 导致 stash 收不到 EOF，hook 一直阻塞直到后台超时退出
        log_path = os.path.join(self.PENDING_DIR, f"{scene_id}.log")
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

        log.LogInfo(f"Background task spawned for scene {scene_id}")

    def __run_background(self, scene_id):
        log.LogInfo(f"Background task started for scene {scene_id}")

        sleep_time = 3
        for attempt in range(12):
            time.sleep(sleep_time)
            scene = self._stash.gql_findScene(scene_id)
            if scene and scene.get("title"):
                break
            sleep_time = min(sleep_time + 2, 15)
        else:
            log.LogInfo("Timeout waiting for scene metadata")
            return

        self.__create_gallery_for_scene(scene_id)

    def __get_base_filename(self, scene_filename):
        result = scene_filename
        while True:
            new_result = self.MULTIPART_RE.sub('', result)
            if new_result == result:
                break
            result = new_result
        return result

    def __get_filename_chain(self, scene_filename):
        chain = [scene_filename]
        result = scene_filename
        while True:
            new_result = self.MULTIPART_RE.sub('', result)
            if new_result == result:
                break
            chain.append(new_result)
            result = new_result
        if ' ' in chain[-1]:
            first_word = chain[-1].split()[0]
            if first_word != chain[-1]:
                chain.append(first_word)
        return chain

    def __strip_cd_from_title(self, title):
        if not title:
            return title
        # 从配置读取剥离模式
        patterns = config.get_title_suffix_patterns()
        # 循环剥离后缀，直到无后缀可剥
        while True:
            stripped = title
            for pattern in patterns:
                new_title = re.sub(pattern, '', stripped, flags=re.IGNORECASE).strip()
                if new_title != stripped:
                    stripped = new_title
                    break
            if stripped == title:
                break
            title = stripped
        return title

    def __get_gallery_title(self, scene_title, scene_filename):
        base_filename = self.__get_base_filename(scene_filename)
        if scene_title:
            stripped = self.__strip_cd_from_title(scene_title)
            if stripped:
                return stripped
        return base_filename

    def __list_extrafanart_files(self, folder_path):
        try:
            files = []
            for f in os.listdir(folder_path):
                if os.path.splitext(f)[1].lower() in config.get_image_extensions():
                    files.append(os.path.join(folder_path, f))
            return sorted(files)
        except OSError:
            return []

    def __find_image_ids(self, file_paths, scene_dir):
        dir_images = self._stash.gql_findImagesInDirectory(scene_dir)
        found = {}
        for fp in file_paths:
            norm = fp.replace("\\", "/").lower()
            if norm in dir_images:
                found[fp] = dir_images[norm]
        return found

    def __poll_for_images(self, scene_dir, all_paths, found):
        missing = [p for p in all_paths if p not in found]
        if not missing:
            return found

        log.LogInfo(f"Waiting for {len(missing)} images to be indexed...")
        sleep_time = 5
        for attempt in range(12):
            time.sleep(sleep_time)
            dir_images = self._stash.gql_findImagesInDirectory(scene_dir)
            still_missing = []
            for p in missing:
                norm = p.replace("\\", "/").lower()
                if norm in dir_images:
                    found[p] = dir_images[norm]
                else:
                    still_missing.append(p)
            missing = still_missing
            if not missing:
                log.LogInfo("All images found")
                return found
            log.LogInfo(f"Still {len(missing)} images missing (attempt {attempt+1}/12)")
            sleep_time = min(sleep_time + 2, 15)

        log.LogInfo(f"Poll timeout, {len(missing)} images still missing")
        return found

    def __find_existing_gallery(self, gallery_title, scene_filename, scene_title):
        existing = self._stash.gql_findGalleries(gallery_title)
        if existing:
            return existing[0]

        base_filename = self.__get_base_filename(scene_filename)
        if base_filename != gallery_title:
            existing = self._stash.gql_findGalleries(base_filename)
            if existing:
                return existing[0]

        base_first = base_filename.split()[0] if ' ' in base_filename else base_filename
        if base_first != gallery_title:
            candidates = self._stash.gql_findGalleries(base_first, "INCLUDES")
            for g in candidates:
                g_first = g.get("title", "").split()[0] if g.get("title") else ""
                if g_first == base_first:
                    return g

        if scene_title:
            title_first = scene_title.split()[0]
            if title_first != gallery_title and title_first != base_first:
                candidates = self._stash.gql_findGalleries(title_first, "INCLUDES")
                for g in candidates:
                    g_first = g.get("title", "").split()[0] if g.get("title") else ""
                    if g_first == title_first:
                        return g

        return None

    def __batch_create_galleries(self):
        # 任务界面批量模式：为所有未关联图库的场景创建并关联图库
        # 串行逐个处理（单任务单请求，不派生子进程、不做入库轮询），不拥堵 stash
        # 等同后台创建逻辑但不等待图片入库（入库是扫描期间的事情）
        scenes = self._stash.gql_findScenesWithoutGallery()
        total = len(scenes)
        log.LogInfo(f"Batch: {total} scenes without gallery")
        if not total:
            return

        ok = no_folder = no_images = not_indexed = failed = 0
        for idx, (scene_id, scene_path) in enumerate(scenes, 1):
            try:
                # 文件系统预检查：无 extrafanart 文件夹或无图片的场景不发任何 GQL 请求
                scene_dir = os.path.dirname(scene_path)
                extrafanart_path = self.__find_extrafanart_folder(scene_dir)
                if not extrafanart_path:
                    no_folder += 1
                elif not self.__list_extrafanart_files(extrafanart_path):
                    no_images += 1
                else:
                    result = self.__create_gallery_for_scene(scene_id, wait_for_images=False)
                    if result is None:
                        ok += 1
                    elif result == "Extrafanart images not indexed in Stash":
                        not_indexed += 1
                        log.LogInfo(f"[{idx}/{total}] scene {scene_id} skipped: {result}")
                    else:
                        failed += 1
                        log.LogWarning(f"[{idx}/{total}] scene {scene_id} failed: {result}")
            except Exception as e:
                failed += 1
                log.LogError(f"[{idx}/{total}] scene {scene_id} error: {repr(e)}")
            if idx % 50 == 0:
                log.LogInfo(
                    f"Progress: {idx}/{total} (ok={ok} no_folder={no_folder} "
                    f"no_images={no_images} not_indexed={not_indexed} failed={failed})"
                )
        log.LogInfo(
            f"Batch done: total={total} created/updated={ok} no_folder={no_folder} "
            f"no_images={no_images} not_indexed={not_indexed} failed={failed}"
        )

    def __create_gallery_for_scene(self, scene_id, wait_for_images=True):
        # 成功返回 None，失败返回原因字符串（按钮任务据此向 stash job 报错）
        # wait_for_images：后台路径等待图片入库（扫描可能尚未完成）；按钮路径立即判定
        scene = self._stash.gql_findScene(scene_id)
        if not scene or not scene.get("files"):
            log.LogError(f"Scene {scene_id} not found or no files")
            return "Scene not found or no files"

        scene_path = scene["files"][0]["path"]
        scene_dir = os.path.dirname(scene_path)
        scene_filename = os.path.splitext(os.path.basename(scene_path))[0]

        extrafanart_path = self.__find_extrafanart_folder(scene_dir)
        if not extrafanart_path:
            log.LogInfo("No extrafanart folder, skipping")
            return "No extrafanart folder"

        poster_path = self.__find_poster_file(scene_dir, scene_filename)
        fanart_paths = self.__find_fanart_files(scene_dir, scene_filename)
        extrafanart_files = self.__list_extrafanart_files(extrafanart_path)

        if not extrafanart_files:
            log.LogInfo("No images in extrafanart folder, skipping")
            return "No images in extrafanart folder"

        all_paths = []
        if poster_path:
            all_paths.append(poster_path)
        all_paths.extend(fanart_paths)
        all_paths.extend(extrafanart_files)

        found = self.__find_image_ids(all_paths, scene_dir)

        extrafanart_ids = [found[p] for p in extrafanart_files if p in found]
        if not extrafanart_ids and wait_for_images:
            found = self.__poll_for_images(scene_dir, all_paths, found)
            extrafanart_ids = [found[p] for p in extrafanart_files if p in found]

        if not extrafanart_ids:
            log.LogInfo("No extrafanart images in DB, skipping (use button to create later)")
            return "Extrafanart images not indexed in Stash"

        poster_id = found.get(poster_path) if poster_path else None
        fanart_ids = [found[p] for p in fanart_paths if p in found]

        scene_title = scene.get("title")
        gallery_title = self.__get_gallery_title(scene_title, scene_filename)

        existing_gallery = self.__find_existing_gallery(gallery_title, scene_filename, scene_title)
        if existing_gallery:
            gid = existing_gallery["id"]
            existing_scene_ids = [s["id"] for s in existing_gallery.get("scenes", [])]
            # 从 extrafanart_ids 中移除 poster_id，避免重复添加
            gallery_image_ids = [iid for iid in extrafanart_ids + fanart_ids if iid and iid != poster_id]
            if poster_id:
                gallery_image_ids.insert(0, poster_id)
            if gallery_image_ids:
                self._stash.gql_addGalleryImages(gid, gallery_image_ids)
            if scene_id not in existing_scene_ids:
                self._stash.gql_addSceneToGallery(gid, existing_scene_ids + [scene_id])
            log.LogInfo(f"Appended to existing gallery {gid}")
            return None

        gallery_data = self.__build_gallery_data(scene, gallery_title)
        new_gallery = self._stash.gql_galleryCreate(gallery_data)
        if not new_gallery:
            log.LogError("Gallery create failed")
            return "Gallery create failed"

        gid = new_gallery["id"]
        log.LogInfo(f"Gallery {gid} created (title={gallery_title})")

        if poster_id:
            self._stash.gql_addGalleryImages(gid, [poster_id])
            self.__set_cover(gid, poster_id)

        if fanart_ids:
            self._stash.gql_addGalleryImages(gid, fanart_ids)

        # 从 extrafanart_ids 中移除 poster_id，避免重复添加
        final_extrafanart_ids = [iid for iid in extrafanart_ids if iid != poster_id]
        if final_extrafanart_ids:
            self._stash.gql_addGalleryImages(gid, final_extrafanart_ids)
        log.LogInfo(f"Gallery {gid} done")
        return None

    def __set_cover(self, gallery_id, image_id):
        try:
            self._stash.gql_gallerySetCover(gallery_id, image_id)
        except Exception as e:
            log.LogWarning(f"setCover failed: {repr(e)}")

    def __find_poster_file(self, scene_dir, scene_filename):
        filenames_to_try = self.__get_filename_chain(scene_filename)
        for name in config.get_poster_filenames():
            for fn in filenames_to_try:
                path = os.path.join(scene_dir, name.replace("{filename}", fn))
                if os.path.isfile(path):
                    return path
        return None

    def __find_fanart_files(self, scene_dir, scene_filename):
        filenames_to_try = self.__get_filename_chain(scene_filename)
        found = []
        seen = set()
        for name in config.get_fanart_filenames():
            for fn in filenames_to_try:
                path = os.path.join(scene_dir, name.replace("{filename}", fn))
                if os.path.isfile(path) and path not in seen:
                    found.append(path)
                    seen.add(path)
        return found

    def __find_extrafanart_folder(self, scene_dir):
        for name in config.get_extrafanart_folders():
            path = os.path.join(scene_dir, name)
            if os.path.isdir(path):
                return path
        return None

    def __build_gallery_data(self, scene, title):
        data = {
            "title": title,
            "code": scene.get("code"),
            "details": scene.get("details"),
            "date": scene.get("date"),
            "rating100": scene.get("rating100"),
            "urls": scene.get("urls"),
            "scene_ids": [scene["id"]],
            "performer_ids": [p["id"] for p in scene.get("performers", [])],
            "tag_ids": [t["id"] for t in scene.get("tags", [])],
        }
        if scene.get("studio"):
            data["studio_id"] = scene["studio"]["id"]
        return data


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
                    "args": {"mode": "background", "scene_id": task["scene_id"]},
                }
                is_background = True
            else:
                fragment = json.loads(arg)
        else:
            fragment = json.loads(sys.stdin.read())

        if is_background:
            log.set_plain(True)

        log.LogInfo("sceneGallerySync starting")
        stash = StashInterface(fragment)
        SceneGallerySync(stash).process()
        stash.exit_plugin("OK")
    except Exception as e:
        print(f'\x01e\x02[sceneGallerySync] FATAL: {repr(e)}\n', file=sys.stderr, flush=True)
        sys.exit(1)
