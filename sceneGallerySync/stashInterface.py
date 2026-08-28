import sys
import json
import os
import time
import log

try:
    import requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False


class StashInterface:

    def __init__(self, fragment):
        self._fragment = fragment
        self._server = fragment["server_connection"]
        self._mode = fragment["args"].get("mode", "normal")

        hook_ctx = fragment["args"].get("hookContext")
        if hook_ctx:
            self._scene_id = hook_ctx.get("id")
            self._hook_type = hook_ctx.get("type", "")
        else:
            self._scene_id = fragment["args"].get("scene_id")
            self._hook_type = fragment["args"].get("hook_type", "")

        self._scheme = self._server["Scheme"]
        self._host = self._server["Host"]
        self._port = str(self._server["Port"])
        self._api_key = self._server.get("ApiKey")
        self._session_cookie = None
        if self._server.get("SessionCookie"):
            self._session_cookie = {"session": self._server["SessionCookie"]["Value"]}
        if self._host == "0.0.0.0":
            self._host = "localhost"

        self._url = f"{self._scheme}://{self._host}:{self._port}/graphql"
        self._headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self._api_key:
            self._headers["ApiKey"] = self._api_key

    def get_scene_id(self):
        return self._scene_id

    def get_hook_type(self):
        return self._hook_type

    def get_mode(self):
        return self._mode

    def __gql(self, query, variables=None, _max_retries=3):
        if not _HAS_REQUESTS:
            self.__fatal("requests library not installed")

        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        last_err = None
        for attempt in range(_max_retries):
            try:
                r = requests.post(
                    self._url, json=payload, headers=self._headers,
                    cookies=self._session_cookie, timeout=30
                )
                break
            except requests.exceptions.ConnectionError as e:
                last_err = e
                if attempt < _max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    log.LogWarning(f"Connection error, retry {attempt+1}/{_max_retries} in {wait}s")
                    time.sleep(wait)
            except requests.exceptions.Timeout as e:
                last_err = e
                if attempt < _max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    log.LogWarning(f"Request timeout, retry {attempt+1}/{_max_retries} in {wait}s")
                    time.sleep(wait)
            except Exception as e:
                self.__fatal(f"GraphQL request failed: {repr(e)}")
        else:
            self.__fatal(f"GraphQL failed after {_max_retries} retries: {repr(last_err)}")

        if r.status_code == 401:
            self.__fatal("HTTP 401 Unauthorized")
        if r.status_code != 200:
            raise ConnectionError(f"GraphQL failed: {r.status_code} - {r.text[:200]}")

        data = r.json()
        if data.get("errors"):
            for err in data["errors"]:
                log.LogError(f"GraphQL error: {err.get('message', err)}")
            return {}
        return data.get("data", {})

    def __fatal(self, msg):
        log.LogError(msg)
        print(json.dumps({"output": "", "error": msg}))
        sys.exit(1)

    def gql_findScene(self, scene_id):
        q = """query($id:ID!){findScene(id:$id){id title code details urls date rating100 files{path}studio{id}tags{id}performers{id}}}"""
        return self.__gql(q, {"id": scene_id}).get("findScene")

    def gql_findGalleries(self, title, modifier="EQUALS"):
        q = """query($f:GalleryFilterType){findGalleries(gallery_filter:$f,filter:{per_page:-1}){galleries{id title scenes{id}}}}"""
        return self.__gql(q, {"f": {"title": {"value": title, "modifier": modifier}}}).get("findGalleries", {}).get("galleries", [])

    def gql_galleryCreate(self, data):
        q = """mutation($i:GalleryCreateInput!){galleryCreate(input:$i){id}}"""
        return self.__gql(q, {"i": data}).get("galleryCreate")

    def gql_addGalleryImages(self, gallery_id, image_ids):
        q = """mutation($i:GalleryAddInput!){addGalleryImages(input:$i)}"""
        return self.__gql(q, {"i": {"gallery_id": gallery_id, "image_ids": image_ids}})

    def gql_addSceneToGallery(self, gallery_id, scene_ids):
        q = """mutation($i:GalleryUpdateInput!){galleryUpdate(input:$i){id}}"""
        return self.__gql(q, {"i": {"id": gallery_id, "scene_ids": scene_ids}})

    def gql_gallerySetCover(self, gallery_id, cover_image_id):
        q = """mutation($i:GallerySetCoverInput!){setGalleryCover(input:$i)}"""
        return self.__gql(q, {"i": {"gallery_id": gallery_id, "cover_image_id": cover_image_id}})

    def gql_checkPluginEnabled(self, plugin_id):
        q = """{plugins{id enabled}}"""
        for p in self.__gql(q).get("plugins", []):
            if p.get("id") == plugin_id:
                return p.get("enabled", True)
        return False

    def gql_findScenesWithoutGallery(self, page_size=500):
        # 分页拉取所有场景，返回未关联图库场景的 (id, path) 列表
        # stash 各版本 SceneFilterType 无稳定的 has_gallery 过滤器，客户端过滤保证兼容
        q = """query($f:FindFilterType){findScenes(filter:$f){count scenes{id files{path} galleries{id}}}}"""
        result = []
        page = 1
        while True:
            data = self.__gql(q, {"f": {
                "per_page": page_size, "page": page, "sort": "path",
            }}).get("findScenes", {})
            scenes = data.get("scenes", [])
            if not scenes:
                break
            for s in scenes:
                if s.get("galleries"):
                    continue
                files = s.get("files") or []
                if not files:
                    continue
                result.append((s["id"], files[0]["path"]))
            if len(scenes) < page_size:
                break
            page += 1
        return result

    def gql_findImagesInDirectory(self, dir_path):
        # 同时查询 ImageFile 和 VideoFile 类型，因为 .gif 会被 Stash 当作 VideoFile 存储
        q = """query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1}){images{id visual_files{...on ImageFile{path}...on VideoFile{path}}}}}"""
        dir_norm = dir_path.replace("\\", "/").lower().rstrip("/")
        result = self.__gql(q, {"f": {"path": {"value": dir_path, "modifier": "INCLUDES"}}})
        images = result.get("findImages", {}).get("images", [])
        found = {}
        for img in images:
            img_id = img["id"]
            for vf in img.get("visual_files", []):
                if isinstance(vf, dict) and "path" in vf:
                    stored_norm = vf["path"].replace("\\", "/").lower()
                    if stored_norm.startswith(dir_norm + "/"):
                        found[stored_norm] = img_id
        return found

    def exit_plugin(self, msg="OK"):
        print(json.dumps({"output": msg, "error": None}))
        sys.exit()
