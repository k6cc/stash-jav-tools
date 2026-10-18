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

# 图库查询字段：scenes 内联演员/工作室/tag（tag 带 name 用于「排除标签」过滤）
GALLERY_FIELDS = ("id title image_count cover{id} "
                  "scenes{id title code details date urls performers{id} studio{id} tags{id name}}")

# 图片查询字段
IMAGE_FIELDS = ("id title code details date urls performers{id} studio{id} tags{id} "
                "visual_files{...on ImageFile{path}...on VideoFile{path}}")


class StashInterface:

    def __init__(self, fragment):
        self._fragment = fragment
        self._server = fragment["server_connection"]
        self._mode = fragment["args"].get("mode", "normal")

        hook_ctx = fragment["args"].get("hookContext")
        if hook_ctx:
            self._hook_id = hook_ctx.get("id")
            self._hook_type = hook_ctx.get("type", "")
        else:
            self._hook_id = fragment["args"].get("gallery_id")
            self._hook_type = fragment["args"].get("hook_type", "")

        self._gallery_id = fragment["args"].get("gallery_id")

        self._scheme = self._server["Scheme"]
        self._host = self._server["Host"]
        self._port = str(self._server["Port"])
        self._api_key = self._server.get("ApiKey")
        self._session_cookie = None
        if self._server.get("SessionCookie"):
            self._session_cookie = {"session": self._server["SessionCookie"]["Value"]}
        # 0.0.0.0 是监听地址而非可连地址，Windows 下直连会报 WinError 10049
        if self._host in ("0.0.0.0", "::", "localhost"):
            self._host = "127.0.0.1"

        self._url = f"{self._scheme}://{self._host}:{self._port}/graphql"
        self._headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self._api_key:
            self._headers["ApiKey"] = self._api_key

    def get_mode(self):
        return self._mode

    def get_hook_type(self):
        return self._hook_type

    def get_hook_id(self):
        return self._hook_id

    def get_gallery_id(self):
        return self._gallery_id or self._hook_id

    def server_connection(self):
        return self._fragment.get("server_connection", {})

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

    # ---------- 插件设置 ----------

    def gql_getPluginSettings(self, plugin_id):
        # Stash 以 yml 文件名为插件 id 保存设置；未改过设置的插件不在该映射里
        q = """{ configuration { plugins } }"""
        plugins = (self.__gql(q).get("configuration", {}) or {}).get("plugins") or {}
        return plugins.get(plugin_id) or {}

    # ---------- 图库 ----------

    def gql_findGallery(self, gallery_id):
        q = """query($id:ID!){findGallery(id:$id){%s}}""" % GALLERY_FIELDS
        return self.__gql(q, {"id": gallery_id}).get("findGallery")

    def gql_findAllGalleries(self, page_size=200):
        q = """query($f:FindFilterType){findGalleries(filter:$f){galleries{%s}}}""" % GALLERY_FIELDS
        result = []
        page = 1
        while True:
            data = self.__gql(q, {"f": {"per_page": page_size, "page": page}}).get("findGalleries", {})
            galleries = data.get("galleries", [])
            result.extend(galleries)
            if len(galleries) < page_size:
                break
            page += 1
        return result

    # ---------- 图片 ----------

    def gql_findImagesInGallery(self, gallery_id):
        # MultiCriterionInput 的取值字段是 value；一个图库的图片含封面 + fanart + 剧照
        q = ("""query($f:ImageFilterType){findImages(image_filter:$f,filter:{per_page:-1})"""
             """{images{%s}}}""" % IMAGE_FIELDS)
        f = {"galleries": {"value": [gallery_id], "modifier": "INCLUDES_ALL"}}
        return self.__gql(q, {"f": f}).get("findImages", {}).get("images", [])

    def gql_findImage(self, image_id):
        q = """query($id:ID!){findImage(id:$id){%s}}""" % IMAGE_FIELDS
        return self.__gql(q, {"id": image_id}).get("findImage")

    def gql_findImagesByIds(self, image_ids):
        # ImageFilterType.id 是 IntCriterionInput（单值），没有批量 id 过滤器，逐个查
        out = []
        for iid in image_ids:
            img = self.gql_findImage(iid)
            if img:
                out.append(img)
        return out

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

    def gql_imageUpdate(self, data):
        q = """mutation($i:ImageUpdateInput!){imageUpdate(input:$i){id}}"""
        return self.__gql(q, {"i": data}).get("imageUpdate")

    # ---------- 场景 ----------

    def gql_findSceneFull(self, scene_id):
        q = ("""query($id:ID!){findScene(id:$id){id title code details date urls files{path} """
             """studio{id} tags{id name} performers{id}}}""")
        return self.__gql(q, {"id": scene_id}).get("findScene")

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

    def exit_plugin(self, msg="OK"):
        print(json.dumps({"output": msg, "error": None}))
        sys.exit()
