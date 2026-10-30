"""场景「加入库」链路验证（多源，按插件 handleSaveScene 的顺序复现，可清理）。

顺序：本地演员按 stash_id 映射 → 缺的按源编号补建（带图，失败降级不带图）→
工作室按 stash_id 找、找不到按名字建（新建带编号）→ 标签按 name/alias 索引找、
缺的建 → sceneCreate → 封面按候选链逐个试 sceneUpdate（失败只丢封面）。

源：stashdb / javstash / theporndb 三个都支持。stashdb、javstash 走 stash-box
GraphQL；theporndb 走 REST（插件也是这么做的）。

用法：
    python verify_add_to_library.py --source stashdb          # dry-run
    python verify_add_to_library.py --source javstash --apply # 写库
    python verify_add_to_library.py --source theporndb --apply --cleanup
    python verify_add_to_library.py --source stashdb --kind performer --apply --cleanup
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from probe_tpdb_api import Client, load_key, rows  # noqa: E402

STASH = "http://127.0.0.1:9999/graphql"
CFG = r"E:/stashAPP/config.yml"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"


# ─── 配置 ────────────────────────────────────────────────────────────────────

def load_boxes():
    """按 YAML 列表项配对读 endpoint + apikey（不能跨项串抓，见 probe_tpdb_api）。"""
    lines = Path(CFG).read_text(encoding="utf-8").splitlines()
    out, cur = [], None
    for ln in lines:
        if not ln.strip():
            continue
        if ln.lstrip().startswith("- "):
            cur = {}
            out.append(cur)
            ln = ln.lstrip()[2:]
        elif not ln.startswith(" ") and not ln.startswith("\t"):
            cur = None
            continue
        if cur is None:
            continue
        m = re.match(r"(api_?key|endpoint):\s*(\S+)", ln.strip(), re.I)
        if m:
            cur[m.group(1).lower().replace("_", "")] = m.group(2).strip("\"'")
    return [b for b in out if b.get("endpoint") and b.get("apikey")]


def pick_box(source):
    for b in load_boxes():
        if source in b["endpoint"]:
            return b
    raise SystemExit("config.yml 里没有 %s，可选：%s" % (source, [b["endpoint"] for b in load_boxes()]))


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
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise SystemExit("GQL HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:300]))
    if d.get("errors"):
        raise SystemExit("GQL 错误: " + json.dumps(d["errors"], ensure_ascii=False)[:400])
    return d["data"]


# ─── 取场景（归一化成插件里的 scene 形状）──────────────────────────────────

SCENE_Q = """
query($input:SceneQueryInput!){queryScenes(input:$input){count scenes{
  id title code details release_date duration
  urls { url site { name } }
  studio { id name }
  performers { as performer { id name images { url } } }
  tags { id name }
  images { url }
}}}
"""


def box_scenes(box, n):
    headers = {"Content-Type": "application/json", "ApiKey": box["apikey"], "User-Agent": UA}
    body = json.dumps({
        "query": SCENE_Q,
        "variables": {"input": {"per_page": n, "sort": "DATE", "direction": "DESC"}},
    }).encode()
    req = urllib.request.Request(box["endpoint"], data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read().decode("utf-8", "replace"))
    if d.get("errors"):
        raise SystemExit("%s: %s" % (box["endpoint"], json.dumps(d["errors"])[:300]))
    scenes = ((d.get("data") or {}).get("queryScenes") or {}).get("scenes") or []
    out = []
    for s in scenes:
        out.append({
            "id": s.get("id"),
            "title": s.get("title") or "",
            "code": s.get("code") or "",
            "details": s.get("details") or "",
            "release_date": s.get("release_date") or "",
            "urls": [u.get("url") for u in (s.get("urls") or []) if u.get("url")],
            "studio": s.get("studio"),
            "performers": s.get("performers") or [],
            "tags": s.get("tags") or [],
            "images": s.get("images") or [],
        })
    return out


def tpdb_scenes(n):
    """与插件 tpdbScene 同构：封面候选按 TPDB 自家 CDN 优先排序。"""
    cli = Client(load_key(CFG))
    st, body, _ = cli.get("/scenes?per_page=%d&orderBy=recently_created" % n)
    if st != 200:
        raise SystemExit("TPDB REST %s" % st)
    out = []
    for r in rows(body):
        bg = (r.get("background") or {}).get("full") or ""
        imgs = []
        for u in (bg, r.get("poster"), r.get("image"), r.get("back_image")):
            if u and u not in imgs:
                imgs.append(u)
        site = r.get("site") or {}
        out.append({
            "id": r.get("id"),
            "title": r.get("title") or "",
            "code": r.get("sku") or r.get("external_id") or "",
            "details": r.get("description") or "",
            "release_date": r.get("date") or "",
            "urls": [r.get("url")] if r.get("url") else [],
            "studio": {"id": site.get("uuid") or "", "name": site.get("name") or ""} if site else None,
            "performers": [{
                "as": p.get("name") or "",
                "performer": {
                    "id": ((p.get("parent") or {}).get("id") or p.get("id") or ""),
                    "name": p.get("name") or "",
                    "images": [{"url": (p.get("parent") or {}).get("face")
                                or (p.get("parent") or {}).get("image")}] if ((p.get("parent") or {}).get("face")
                                                                                or (p.get("parent") or {}).get("image")) else [],
                },
            } for p in (r.get("performers") or [])],
            "tags": [{"id": t.get("uuid") or "", "name": t.get("name") or ""} for t in (r.get("tags") or [])],
            "images": [{"url": u} for u in imgs],
        })
    return out


# ─── 本地库 ──────────────────────────────────────────────────────────────────

def local_maps(endpoint):
    d = gql("{findPerformers(filter:{per_page:-1}){performers{id name stash_ids{endpoint stash_id}}}}")
    perfs = {}
    for p in d["findPerformers"]["performers"]:
        for s in p["stash_ids"]:
            if s["endpoint"].lower() == endpoint.lower():
                perfs[str(s["stash_id"]).lower()] = p
    d = gql("{findStudios(filter:{per_page:-1}){studios{id name stash_ids{endpoint stash_id}}}}")
    studios = {}
    for s in d["findStudios"]["studios"]:
        for sid in s["stash_ids"]:
            if sid["endpoint"].lower() == endpoint.lower():
                studios[str(sid["stash_id"]).lower()] = s
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


def owned(endpoint, stash_id):
    d = gql("""query($f:SceneFilterType){findScenes(scene_filter:$f,filter:{per_page:1}){count scenes{id title}}}""",
            {"f": {"stash_id_endpoint": {"endpoint": endpoint, "stash_id": stash_id, "modifier": "EQUALS"}}})
    return d["findScenes"]["count"], (d["findScenes"]["scenes"] or [{}])[0]


def create_performer(endpoint, stash_id, name, image):
    for with_img in (True, False):
        inp = {"name": name or "Unknown", "stash_ids": [{"endpoint": endpoint, "stash_id": stash_id}]}
        if with_img and image:
            inp["image"] = image
        try:
            d = gql("mutation($input:PerformerCreateInput!){performerCreate(input:$input){id}}", {"input": inp})
            return (d["performerCreate"] or {}).get("id"), ("新建(带图)" if with_img and image else "新建")
        except SystemExit:
            continue
    return None, "建失败"


def find_or_create_studio(endpoint, name, stash_id):
    d = gql("query($f:FindFilterType!){findStudios(filter:$f){studios{id name}}}", {"f": {"q": name, "per_page": 5}})
    for s in d["findStudios"]["studios"]:
        if s["name"].lower() == name.lower():
            return s["id"], "命中同名"
    inp = {"name": name}
    if stash_id:
        inp["stash_ids"] = [{"endpoint": endpoint, "stash_id": stash_id}]
    d = gql("mutation($input:StudioCreateInput!){studioCreate(input:$input){id}}", {"input": inp})
    return (d["studioCreate"] or {}).get("id"), "新建(带编号)"


def find_or_create_tag(name, idx):
    key = str(name or "").strip().lower()
    if not key:
        return None, "空"
    if idx.get(key):
        return idx[key], "命中(名/别名)"
    try:
        d = gql("mutation($input:TagCreateInput!){tagCreate(input:$input){id}}", {"input": {"name": name}})
        tid = (d.get("tagCreate") or {}).get("id")
    except SystemExit:
        tid = None
    if tid:
        idx[key] = tid
        return tid, "新建"
    # 建不出来（名字被别人挂成别名 / 静默 null）：按名字回查一次，命中就用
    d2 = gql("query($f:FindFilterType!){findTags(filter:$f){tags{id name aliases}}}",
             {"f": {"q": name, "per_page": 5}})
    for t in d2["findTags"]["tags"]:
        if t["name"].lower() == key or any(a and a.lower() == key for a in (t.get("aliases") or [])):
            idx[key] = t["id"]
            return t["id"], "回查别名命中"
    return None, "建失败"


def web_url(endpoint, scene_id):
    base = endpoint.split("/graphql")[0]
    site = {"stashdb.org": "stashdb.org", "javstash.org": "javstash.org",
            "theporndb.net": "theporndb.net"}.get(base.split("//")[-1], base.split("//")[-1])
    return "https://%s/scenes/%s" % (site, scene_id)


def run_performer(endpoint, args):
    """演员单独加入库：对应 discover.js 的「＋ 加入库」按钮。

    头像走 image URL（Stash 服务端下载）为主路径——浏览器 fetch 受 CORS 限制，
    stashdb / javstash 的图没有 CORS 头，转 data URL 会静默丢图。
    """
    scenes = tpdb_scenes(12) if "theporndb" in endpoint else box_scenes(pick_box(args.source), 12)
    perfs, _ = local_maps(endpoint)
    for sc in scenes:
        for p in sc.get("performers") or []:
            pf = p.get("performer") or {}
            pid = str(pf.get("id") or "")
            if not pid or pid.lower() in perfs:
                continue
            img = ((pf.get("images") or [{}])[0] or {}).get("url") or ""
            print("演员: %s (%s) 头像=%s" % (pf.get("name"), pid[:8], (img.split("/")[2] if img else "无")))
            if not args.apply:
                print("\n[dry-run] 加 --apply 写库")
                return
            d = gql("""mutation($input:PerformerCreateInput!){performerCreate(input:$input){
                id name image_path stash_ids{endpoint stash_id} }}""",
                    {"input": {"name": pf.get("name") or "Unknown",
                               "stash_ids": [{"endpoint": endpoint, "stash_id": pid}],
                               "image": img} if img else
                              {"name": pf.get("name") or "Unknown",
                               "stash_ids": [{"endpoint": endpoint, "stash_id": pid}]}})
            c = d["performerCreate"]
            print("  建库 id=%s 头像=%s stash_id=%s" % (
                c["id"], "已落库" if c.get("image_path") else "空",
                (c.get("stash_ids") or [{}])[0].get("stash_id")))
            if args.cleanup:
                for attempt in range(5):
                    try:
                        gql("mutation($id:ID!){performerDestroy(input:{id:$id})}", {"id": c["id"]})
                        print("  已删除测试演员 %s" % c["id"])
                        break
                    except SystemExit:
                        # 头像还在生成，blob 被占用，稍等重试
                        import time
                        time.sleep(4)
                else:
                    print("  删除失败（blob 占用），稍后手动删 id=%s" % c["id"])
            return
    print("没有未入库的演员样本")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="theporndb", help="stashdb / javstash / theporndb")
    ap.add_argument("--kind", default="scene", choices=["scene", "performer"])
    ap.add_argument("--index", type=int, default=0, help="取第几条场景")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--cleanup", action="store_true")
    args = ap.parse_args()

    box = pick_box(args.source)
    endpoint = box["endpoint"]
    print("源: %s" % endpoint)

    if args.kind == "performer":
        run_performer(endpoint, args)
        return

    scenes = tpdb_scenes(30) if "theporndb" in endpoint else box_scenes(box, 30)
    perfs, studios = local_maps(endpoint)

    # 挑一条还没入库的
    target = None
    for sc in scenes:
        n, _ = owned(endpoint, sc["id"])
        if not n:
            target = sc
            break
    if not target:
        raise SystemExit("这 30 条都已在库里，换 --source 或稍后重试")
    sc = target

    print("场景: %s" % str(sc["title"])[:70])
    print("  id=%s date=%s code=%s" % (sc["id"], sc["release_date"], sc["code"]))
    covers = [i["url"] for i in sc["images"] if i.get("url")]
    print("  封面候选 %d 个: %s" % (len(covers), " | ".join(u.split("/")[2] for u in covers)))

    site = sc.get("studio") or {}
    site_id = str(site.get("id") or "")
    print("  工作室: %s (%s) 本地%s" % (site.get("name"), site_id[:8],
                                    "命中" if site_id.lower() in studios else "未命中"))
    tags = [t.get("name") for t in (sc.get("tags") or []) if t.get("name")]
    perf_list = sc.get("performers") or []
    print("  演员 %d 个, 标签 %d 个" % (len(perf_list), len(tags)))

    if not args.apply:
        print("\n[dry-run] 加 --apply 写库")
        return

    perf_ids, perf_log, created_perfs = [], [], []
    for p in perf_list:
        pf = p.get("performer") or {}
        pid = str(pf.get("id") or "")
        if not pid:
            continue
        lp = perfs.get(pid.lower())
        if lp:
            perf_ids.append(lp["id"])
            perf_log.append("%s 命中" % pf.get("name"))
        else:
            img = ((pf.get("images") or [{}])[0] or {}).get("url") or ""
            nid, how = create_performer(endpoint, pid, pf.get("name"), img)
            if nid:
                perf_ids.append(nid)
                created_perfs.append(nid)
            perf_log.append("%s %s" % (pf.get("name"), how))
    print("  演员: %s" % "; ".join(perf_log))

    studio_id, how = None, "无"
    if site.get("name"):
        studio_id, how = find_or_create_studio(endpoint, site["name"], site_id or None)
    print("  工作室落地: id=%s (%s)" % (studio_id, how))

    idx = tag_index()
    tag_ids, tag_log = [], []
    for name in tags:
        tid, thow = find_or_create_tag(name, idx)
        if tid:
            tag_ids.append(tid)
        if thow not in ("命中(名/别名)",):
            tag_log.append("%s:%s" % (str(name)[:14], thow))
    print("  标签: %d/%d %s" % (len(tag_ids), len(tags), ", ".join(tag_log) or "全部命中"))

    urls = [web_url(endpoint, sc["id"])] + [u for u in sc["urls"] if u][:6]
    inp = {
        "title": sc["title"] or None,
        "code": sc["code"] or None,
        "details": sc["details"] or None,
        "date": sc["release_date"] or None,
        "urls": urls,
        "performer_ids": perf_ids,
        "tag_ids": tag_ids,
        "stash_ids": [{"endpoint": endpoint, "stash_id": str(sc["id"])}],
    }
    if studio_id:
        inp["studio_id"] = studio_id

    d = gql("""mutation($input:SceneCreateInput!){sceneCreate(input:$input){
        id title
        studio{id name}
        performers{id name}
        tags{id name}
        stash_ids{endpoint stash_id}
        urls
    }}""", {"input": inp})
    created = d.get("sceneCreate") or {}
    print("\n创建: id=%s title=%s" % (created.get("id"), str(created.get("title"))[:50]))
    print("  stash_ids=%s" % created.get("stash_ids"))
    print("  studio=%s" % (created.get("studio") or {}).get("name"))
    print("  performers=%s" % [p["name"] for p in (created.get("performers") or [])])
    print("  tags=%d urls=%d" % (len(created.get("tags") or []), len(created.get("urls") or [])))

    if created.get("id"):
        cover_ok = None
        for u in covers:
            host = u.split("/")[2]
            try:
                gql("mutation($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}",
                    {"input": {"id": created["id"], "cover_image": u}})
                print("  封面: 成功 -> %s" % host)
                cover_ok = u
                break
            except SystemExit as e:
                print("  封面: 失败 %s -> %s" % (host, str(e)[:90]))
        if not cover_ok:
            print("  封面: 全部候选失败（场景已建，仅缺封面）")

        n2, hit2 = owned(endpoint, sc["id"])
        print("  回查已拥有: %s %s" % (n2, hit2.get("title")))
        if args.cleanup:
            for attempt in range(5):
                try:
                    gql("mutation($id:ID!){sceneDestroy(input:{id:$id})}", {"id": created["id"]})
                    print("  已删除测试场景 id=%s" % created["id"])
                    break
                except SystemExit:
                    import time
                    time.sleep(3)   # 封面还在生成，blob 被占用
            else:
                print("  删除失败（blob 占用），稍后手动删 id=%s" % created["id"])
            if created_perfs:
                print("  本次新建演员（需手工清）: %s" % ", ".join(created_perfs))


if __name__ == "__main__":
    main()
