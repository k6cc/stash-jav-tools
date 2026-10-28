"""TPDB 场景「加入库」链路验证（按插件 handleSaveScene 的顺序复现，可清理）。

顺序：本地演员按 stash_id 映射 → 缺的按源编号补建 → 工作室按 stash_id 找、
找不到按名字建（新建带编号）→ 标签按 name/alias 索引找、缺的建 → sceneCreate
→ 封面单独 sceneUpdate（失败只丢封面）。

用法：
    python verify_add_to_library.py                  # dry-run
    python verify_add_to_library.py --apply          # 写库
    python verify_add_to_library.py --apply --cleanup # 写库后删除场景
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from probe_tpdb_api import Client, load_key  # noqa: E402

STASH = "http://127.0.0.1:9999/graphql"
CFG = r"E:/stashAPP/config.yml"
BOX_ENDPOINT = "https://theporndb.net/graphql"
BOX_WEB = "https://theporndb.net"


def stash_key():
    txt = Path(CFG).read_text(encoding="utf-8")
    m = re.search(r"^api_key:\s*(\S+)\s*$", txt, re.M)
    if not m:
        raise SystemExit("config.yml 顶层没有 api_key")
    return m.group(1)


def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(STASH, data=body, headers={
        "Content-Type": "application/json", "ApiKey": stash_key(),
    })
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    if d.get("errors"):
        raise SystemExit("GQL 错误: " + json.dumps(d["errors"], ensure_ascii=False)[:500])
    return d["data"]


def local_maps():
    d = gql("{findPerformers(filter:{per_page:-1}){performers{id name stash_ids{endpoint stash_id}}}}")
    perfs = {}
    for p in d["findPerformers"]["performers"]:
        for s in p["stash_ids"]:
            if "theporndb" in s["endpoint"].lower():
                perfs[s["stash_id"].lower()] = p
    d = gql("{findStudios(filter:{per_page:-1}){studios{id name stash_ids{endpoint stash_id}}}}")
    studios = {}
    for s in d["findStudios"]["studios"]:
        for sid in s["stash_ids"]:
            if "theporndb" in sid["endpoint"].lower():
                studios[sid["stash_id"].lower()] = s
    return perfs, studios


def tag_index():
    d = gql("{findTags(filter:{per_page:-1}){tags{id name aliases}}}")
    idx = {}
    for t in d["findTags"]["tags"]:
        idx[t["name"].lower()] = t["id"]
        for a in (t.get("aliases") or []):
            if a:
                idx[str(a).lower()] = t["id"]
    return idx


def owned(stash_id):
    d = gql("""query($f:SceneFilterType){findScenes(scene_filter:$f,filter:{per_page:1}){count scenes{id title}}}""",
            {"f": {"stash_id_endpoint": {"endpoint": BOX_ENDPOINT, "stash_id": stash_id, "modifier": "EQUALS"}}})
    return d["findScenes"]["count"], (d["findScenes"]["scenes"] or [{}])[0]


def create_performer(stash_id, name, image):
    for with_img in (True, False):
        inp = {"name": name or "Unknown", "stash_ids": [{"endpoint": BOX_ENDPOINT, "stash_id": stash_id}]}
        if with_img and image:
            inp["image"] = image
        try:
            d = gql("mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}", {"input": inp})
            return (d["performerCreate"] or {}).get("id"), ("新建(带图)" if with_img and image else "新建")
        except SystemExit:
            if not (with_img and image):
                return None, "建失败"
    return None, "建失败"


def find_or_create_studio(name, stash_id):
    d = gql("query($f:FindFilterType!){findStudios(filter:$f){studios{id name}}}", {"f": {"q": name, "per_page": 5}})
    for s in d["findStudios"]["studios"]:
        if s["name"].lower() == name.lower():
            return s["id"], "命中同名"
    inp = {"name": name}
    if stash_id:
        inp["stash_ids"] = [{"endpoint": BOX_ENDPOINT, "stash_id": stash_id}]
    d = gql("mutation($input:StudioCreateInput!){studioCreate(input:$input){id}}", {"input": inp})
    return (d["studioCreate"] or {}).get("id"), "新建(带编号)"


def find_or_create_tag(name, idx):
    key = str(name or "").strip().lower()
    if not key:
        return None, "空"
    if idx.get(key):
        return idx[key], "命中(名/别名)"
    d = gql("mutation($input:TagCreateInput!){tagCreate(input:$input){id}}", {"input": {"name": name}})
    tid = (d["tagCreate"] or {}).get("id")
    if tid:
        idx[key] = tid
    return tid, "新建"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uuid", default="981149f3-e86a-4a1a-8881-a690367c8913")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--cleanup", action="store_true")
    args = ap.parse_args()

    cli = Client(load_key(CFG))
    perfs, studios = local_maps()

    st, body, _ = cli.get("/performers/%s/scenes?per_page=3&orderBy=recently_released" % args.uuid)
    scenes = body.get("data") or []
    if not scenes:
        raise SystemExit("没取到场景")
    sc = scenes[0]

    print("场景: %s" % str(sc.get("title"))[:70])
    print("  stash_id=%s date=%s" % (sc.get("id"), sc.get("date")))
    n, hit = owned(sc.get("id"))
    print("  本地已拥有: %s %s" % (n, hit.get("title") if n else ""))
    if n:
        print("\n该场景已在库中，换 --uuid 或先清理。")
        return

    site = sc.get("site") or {}
    site_uuid = str(site.get("uuid") or "")
    print("  工作室: %s (%s) 本地%s" % (site.get("name"), site_uuid[:8],
                                    "命中" if site_uuid.lower() in studios else "未命中"))
    tags = [t.get("name") for t in (sc.get("tags") or []) if t.get("name")]
    urls = [BOX_WEB + "/scenes/" + str(sc.get("id"))]
    for l in sc.get("links") or []:
        u = l if isinstance(l, str) else (l or {}).get("url")
        if u and u not in urls:
            urls.append(u)
    cover = sc.get("image") or sc.get("back_image") or ""
    print("  标签 %d 个, urls %d 条, 封面%s" % (len(tags), len(urls), "有" if cover else "无"))

    if not args.apply:
        print("\n[dry-run] 加 --apply 写库")
        return

    perf_ids, perf_log = [], []
    for p in sc.get("performers") or []:
        par = p.get("parent") or {}
        pid = str(par.get("id") or p.get("id") or "")
        lp = perfs.get(pid.lower())
        if lp:
            perf_ids.append(lp["id"])
            perf_log.append("%s 命中" % p.get("name"))
        else:
            img = par.get("image") or p.get("image") or ""
            nid, how = create_performer(pid, p.get("name"), img)
            if nid:
                perf_ids.append(nid)
            perf_log.append("%s %s" % (p.get("name"), how))
    print("  演员: %s" % "; ".join(perf_log))

    studio_id, how = find_or_create_studio(site.get("name") or "", site_uuid if site_uuid else None)
    print("  工作室落地: id=%s (%s)" % (studio_id, how))

    idx = tag_index()
    tag_ids, tag_log = [], []
    for name in tags:
        tid, thow = find_or_create_tag(name, idx)
        if tid:
            tag_ids.append(tid)
        tag_log.append("%s:%s" % (str(name)[:18], thow))
    print("  标签: %d/%d -> %s" % (len(tag_ids), len(tags), ", ".join(tag_log)))

    inp = {
        "title": sc.get("title") or None,
        "code": sc.get("sku") or None,
        "details": sc.get("description") or None,
        "date": sc.get("date") or None,
        "urls": urls,
        "performer_ids": perf_ids,
        "tag_ids": tag_ids,
        "stash_ids": [{"endpoint": BOX_ENDPOINT, "stash_id": str(sc.get("id"))}],
    }
    if studio_id:
        inp["studio_id"] = studio_id
    if sc.get("directors"):
        d0 = sc["directors"][0]
        inp["director"] = d0 if isinstance(d0, str) else (d0 or {}).get("name")
    # 封面不进 create：外链下载失败会让整条 sceneCreate 报错（实测 EOF）

    d = gql("""mutation($input:SceneCreateInput!){sceneCreate(input:$input){
        id title
        studio{id name stash_ids{endpoint stash_id}}
        performers{id name}
        tags{id name}
        stash_ids{endpoint stash_id}
        urls
    }}""", {"input": inp})
    created = d.get("sceneCreate") or {}
    print("\n创建: id=%s title=%s" % (created.get("id"), str(created.get("title"))[:50]))
    print("  stash_ids=%s" % created.get("stash_ids"))
    print("  studio=%s %s" % ((created.get("studio") or {}).get("name"),
                             (created.get("studio") or {}).get("stash_ids")))
    print("  performers=%s" % [p["name"] for p in (created.get("performers") or [])])
    print("  tags=%d urls=%d" % (len(created.get("tags") or []), len(created.get("urls") or [])))

    if created.get("id") and cover:
        try:
            gql("mutation($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}",
                {"input": {"id": created["id"], "cover_image": cover}})
            print("  封面: 已设置")
        except SystemExit as e:
            print("  封面: 失败（不影响场景）%s" % str(e)[:80])

    if created.get("id"):
        n2, hit2 = owned(sc.get("id"))
        print("  回查已拥有: %s %s" % (n2, hit2.get("title")))
        if args.cleanup:
            gql("mutation($id:ID!){sceneDestroy(input:{id:$id})}", {"id": created["id"]})
            print("  已删除测试场景 id=%s（演员/工作室/标签保留）" % created["id"])


if __name__ == "__main__":
    main()
