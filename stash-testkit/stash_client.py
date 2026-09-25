# -*- coding: utf-8 -*-
"""Stash 实例测试通用客户端（供各插件验证复用）。

5 行上手：
  from stash_client import Stash
  s = Stash()                                  # 读同目录 config.json
  s.trigger_scan([r"E:\\...\\测试目录"])         # 增量扫描（勿 rescan:true）
  s.wait_for_scene(q="TST-", timeout=120)      # 等新场景入库
  s.destroy_scene("225")                        # Boolean，无 selection；blob 锁拦重试

定位：连接本地/远程 Stash 实例做场景生命周期（创建/查询/更新/销毁）、扫描触发、轮询等待。
认证：Stash API Key，请求双发 `ApiKey:` 与 `Authorization: Bearer` 两个头（已封装）。
配置：读同目录 config.json（复制自 config.example.json 并填写）；环境变量 STASH_API_URL / STASH_API_KEY 可覆盖。

老版本 GraphQL 兼容（v0.31.1 实测，完整版见 README.md 硬约束清单）：
  - findScenes 无 `path` 字段（Scene 只有 `paths`）；定位用 filter.q + 本地过滤
  - sceneDestroy 返回 Boolean，不写 selection；VideoFile 哈希在 files{fingerprints}
  - 别在 PowerShell 命令行内联 GraphQL（$id / ! 被插值），写 .py 文件执行
"""
import json, os, sys, time, urllib.request, urllib.error

_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config():
    if not os.path.exists(_CFG):
        raise FileNotFoundError(
            "缺少 config.json：复制 config.example.json 为 config.json 并填写 api_key 等字段")
    with open(_CFG, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["api_url"] = os.environ.get("STASH_API_URL", cfg.get("api_url", "http://localhost:9999/graphql"))
    cfg["api_key"] = os.environ.get("STASH_API_KEY", cfg.get("api_key", ""))
    if not cfg["api_key"]:
        raise ValueError("config.json 未填 api_key")
    return cfg


class Stash:
    def __init__(self, cfg=None):
        self.cfg = cfg or load_config()
        self.api = self.cfg["api_url"]
        self.key = self.cfg["api_key"]

    # ── 基础 ────────────────────────────────────────────────────────────────
    def gql(self, query, variables=None, timeout=60):
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        req = urllib.request.Request(self.api, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("ApiKey", self.key)
        req.add_header("Authorization", "Bearer " + self.key)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError("GraphQL HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:500]))

    def call(self, query, variables=None):
        res = self.gql(query, variables)
        if "errors" in res:
            raise RuntimeError("GraphQL errors: %s" % json.dumps(res["errors"], ensure_ascii=False)[:800])
        return res["data"]

    # ── 场景 ────────────────────────────────────────────────────────────────
    def scene_count(self):
        return self.call("{ findScenes(filter:{per_page:1}) { count } }")["findScenes"]["count"]

    def find_scene(self, sid):
        """返回单个场景 dict（id/title/details/created_at），不存在返回 None。"""
        data = self.call("query($id: ID!){ findScene(id:$id){ id title details created_at } }", {"id": str(sid)})
        return data["findScene"]

    def find_scenes(self, q=None, per_page=200):
        """findScenes 分页查询；老版本无 path 字段，按 title/details 子串过滤由调用方处理。"""
        filter_ = {"per_page": per_page}
        if q:
            filter_["q"] = q
        return self.call("query($f: FindFilterType){ findScenes(filter:$f){ scenes { id title details created_at } } }",
                         {"f": filter_})["findScenes"]["scenes"]

    def create_scene(self, fields):
        """fields: dict（title/code/urls/…）。返回 {id, title}。"""
        return self.call("mutation($i: SceneCreateInput!){ sceneCreate(input:$i){ id title } }",
                         {"i": fields})["sceneCreate"]

    def update_scene(self, sid, fields):
        """fields: dict（title/details/…）。返回 {id, title}。"""
        return self.call("mutation($i: SceneUpdateInput!){ sceneUpdate(input:$i){ id title } }",
                         {"i": dict(fields, id=str(sid))})["sceneUpdate"]

    def destroy_scene(self, sid):
        """销毁测试场景。老版本返回 Boolean，不要 selection。"""
        return self.call("mutation($id: ID!){ sceneDestroy(input:{id:$id}) }", {"id": str(sid)})["sceneDestroy"]


    # ── 场景文件/封面辅助（v0.31.1 实测沉淀） ────────────────────────────────
    def scene_oshash(self, scene):
        """从 scene.files[].fingerprints[] 取 oshash。
        v0.31.1 中 oshash 不在 Scene / VideoFile 顶层，只在
        files { fingerprints { type value } }（type == "oshash"）。"""
        for f in scene.get("files") or []:
            for fp in f.get("fingerprints") or []:
                if fp.get("type") == "oshash":
                    return fp.get("value")
        return None

    @staticmethod
    def scene_shot_ts(scene):
        """解析 paths.screenshot 的 ?t= 值（= 场景 updated_at epoch，响应缓存令牌）。
        封面竞态验证：shot_ts == created_at epoch ⇔ 场景创建后无人写入元数据（封面仍为自动帧）；
        任何写入（nfo 设 title/details/cover 等）都会使二者偏离。解析失败返回 None（保守当非 auto）。"""
        import datetime as dt
        p = (scene.get("paths") or {}).get("screenshot") or ""
        if "?t=" not in p:
            return None
        try:
            return int(p.split("?t=")[1].split("&")[0])
        except ValueError:
            return None

    def fetch_scene_image(self, sid):
        """抓 /scene/{id}/screenshot 端点字节（双认证头）。
        有自定义封面时返回封面字节，否则返回自动截图帧——封面内容验证用。"""
        import urllib.request as ur
        sc = self.call("query($id: ID!){ findScene(id:$id){ paths{ screenshot } } }", {"id": str(sid)})["findScene"]
        url = sc["paths"]["screenshot"]
        req = ur.Request(url)
        req.add_header("ApiKey", self.key)
        req.add_header("Authorization", "Bearer " + self.key)
        with ur.urlopen(req, timeout=30) as r:
            return r.read()

    # ── 扫描 ────────────────────────────────────────────────────────────────
    def trigger_scan(self, paths=None):
        """触发 metadataScan。paths 为空 = 全部分注册路径。
        注意：不要用 rescan:true（强制全量重扫）——实测会触发多插件 hook 风暴导致 Stash 崩溃（见 README）。"""
        return self.call("mutation($p: [String!]){ metadataScan(input:{paths:$p}) }", {"p": paths or []})

    # ── 轮询 ────────────────────────────────────────────────────────────────
    def wait_for_scene(self, q, timeout=120, interval=5):
        """轮询 findScenes(q=...) 直到出现匹配场景，返回匹配列表；超时返回空列表。
        注意：老版本 findScenes 的 q 匹配 title 等字段；按路径定位时需配合本地过滤。"""
        t0 = time.time()
        while time.time() - t0 < timeout:
            scenes = self.find_scenes(q=q)
            if scenes:
                return scenes
            time.sleep(interval)
        return []


def _demo():
    s = Stash()
    print("scenes:", s.scene_count())
    print("scene 220:", s.find_scene(220))


if __name__ == "__main__":
    _demo()
