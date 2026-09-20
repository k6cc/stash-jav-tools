# -*- coding: utf-8 -*-
"""Stash 实例测试通用客户端（供各插件验证复用）。

定位：连接本地/远程 Stash 实例做场景生命周期（创建/查询/更新/销毁）、扫描触发、轮询等待。
认证：Stash API Key，请求需双发 `ApiKey:` 与 `Authorization: Bearer` 两个头（实测缺一不可）。

配置：读同目录 config.json（复制自 config.example.json 并填写）。
可用环境变量覆盖：STASH_API_URL / STASH_API_KEY。

老版本 GraphQL 兼容（v0.31.1 实测）：
  - findScenes 无 `path` 字段（Scene 只有 `paths`）；定位场景用 filter.q + title/path 子串本地过滤
  - sceneDestroy 返回 Boolean，不要写 selection（selection 会 422）
  - sceneUpdate 用 input 对象；无 me 字段；无 jobs 查询

用法示例：
  from stash_client import Stash
  s = Stash()
  s.find_scene(220)
  s.find_scenes(q="TST-")
  s.trigger_scan()                       # 增量扫描（勿用 rescan:true，见 README 已知坑）
  s.wait_for_scene(q="TST-999", timeout=120)
  s.destroy_scene("225")
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
