#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Studio Tools Auto v1.1.0: 后台自动拉取/合并/更新工作室（studioTools 的无 UI 版本，由 studioToolsBackend 更名）。

- 钩子 Studio.Create.Post：新建工作室自动按优先级拉取 Stash-box 实例 →
  归一化精确匹配（无相似度阈值）→ canonical 名撞库（主名/别名交叉唯一）→
  合并进已有 或 补全自身字段（只填空，保留原名、canonical 名作别名）。
- 任务 "Scan Studios Without Stash IDs"（任务列表页手动触发）：全库无 stash_ids
  的工作室按同一管线扫描更新（存量兜底）。

设计要点：
- 匹配 = 归一化精确相等；Stash 名称/别名交叉唯一 → 精确相等即确定命中，无 0.9 类阈值。
- 源按设置优先级顺序查询；多源补齐（multiSourceFill，默认 OFF）：OFF = 首个精确命中即停、
  失败/未命中回退下一源，ON = 并发查询所有列表源、每个精确命中的源都贡献
  （stash_ids/urls/aliases 并集，源失败只影响该源）。
- 字段只填空（overwrite 全关）；别名/urls/stash_ids 追加缺失；别名写入前全库查重防撞。
- 上级工作室：目标 parent 为空时按最高优先级命中的 parent 补齐，仅当本地已存在同名工作室
  （不自动创建上级）——与 studioTools UI 版原设计一致。
- Stash 无原生 studioMerge mutation，合并流程自研（与 studioTools UI 版一致）：
  转移 scenes/images/galleries/groups/子工作室关联 → 更新目标字段 → 删除源。
- 图片子进程异步下载（钩子不阻塞）；失败只影响图片不影响字段。
标准库 only。骨架照抄 javstashAutofill。
"""
import sys, json, re, unicodedata, os, datetime, time, base64, subprocess, ssl, threading, urllib.request, concurrent.futures

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BUILTIN_SOURCES = [
    {"key": "javstash", "label": "JAVStash", "host": "javstash.org"},
    {"key": "stashdb", "label": "StashDB", "host": "stashdb.org"},
    {"key": "theporndb", "label": "ThePornDB", "host": "theporndb.net"},
]
# 默认优先级 = 空（全部实例：内置三源 + 自定义），见 resolve_sources
DEFAULT_TIMEOUT = 8
INDEX_TTL = 30  # 工作室名称索引缓存秒数（仅钩子路径使用）

LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "studio_tools_auto.log")
_LOG_LOCK = threading.Lock()  # 多源补齐并发拉取时日志写入需互斥

# 归一化规则与 tagMerge 一致：NFKC（全角→半角）、小写、去空白与分隔符
SEP_RE = re.compile(r"[\s\u3000·、，,。/\-—_・]+")

# ---------- GraphQL ----------
def make_gql(conn):
    scheme = conn.get("Scheme", "http")
    host = conn.get("Host") or "localhost"
    if host in ("0.0.0.0", ""): host = "localhost"
    port = conn.get("Port", 9999)
    cookie = conn.get("SessionCookie") or {}
    ck = cookie.get("Value")
    url = "%s://%s:%s/graphql" % (scheme, host, port)
    def gql(query, variables=None, timeout=90):
        data = json.dumps({"query": query, "variables": variables or {}}).encode()
        headers = {"Content-Type": "application/json"}
        if ck: headers["Cookie"] = "%s=%s" % (cookie.get("Name", "session"), ck)
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read())
        if j.get("errors"): raise RuntimeError(j["errors"])
        return j["data"]
    return gql

Q_CONFIG = "query { configuration { general { stashBoxes { name endpoint api_key } } } }"
Q_SCRAPE = ("query($source: ScraperSourceInput!, $input: ScrapeSingleStudioInput!) {"
            " scrapeSingleStudio(source: $source, input: $input) {"
            " name aliases image urls remote_site_id parent { stored_id name } } }")
Q_STUDIOS_IDX = "query { findStudios(filter:{per_page:-1}){ studios{ id name aliases } } }"
Q_STUDIO = ("query($id: ID!){ findStudio(id:$id){ id name aliases urls details image_path"
            " stash_ids{ endpoint stash_id } parent_studio{ id name } } }")
Q_SCENE_IDS = ("query($sid: ID!){ findScenes(scene_filter:{studio_id:$sid}, filter:{per_page:-1}){ scenes{ id } } }")
Q_IMAGE_IDS = ("query($sid: ID!){ findImages(image_filter:{studio_id:$sid}, filter:{per_page:-1}){ images{ id } } }")
Q_GALLERY_IDS = ("query($sid: ID!){ findGalleries(gallery_filter:{studio_id:$sid}, filter:{per_page:-1}){ galleries{ id } } }")
Q_GROUP_IDS = ("query($sid: ID!){ findGroups(group_filter:{studio_id:$sid}, filter:{per_page:-1}){ groups{ id } } }")
Q_CHILD_IDS = ("query($sid: ID!){ findStudios(studio_filter:{parent_studio_id:$sid}, filter:{per_page:-1}){ studios{ id } } }")
M_UPDATE = "mutation($i: StudioUpdateInput!){ studioUpdate(input:$i){ id name } }"
M_DESTROY = "mutation($i: StudioDestroyInput!){ studioDestroy(input:$i) }"
M_BULK_SCENE = "mutation($i: BulkSceneUpdateInput!){ bulkSceneUpdate(input:$i){ id } }"
M_BULK_IMAGE = "mutation($i: BulkImageUpdateInput!){ bulkImageUpdate(input:$i){ id } }"
M_BULK_GALLERY = "mutation($i: BulkGalleryUpdateInput!){ bulkGalleryUpdate(input:$i){ id } }"
M_BULK_GROUP = "mutation($i: BulkGroupUpdateInput!){ bulkGroupUpdate(input:$i){ id } }"
M_BULK_STUDIO = "mutation($i: BulkStudioUpdateInput!){ bulkStudioUpdate(input:$i){ id } }"

# ---------- 归一化 / 工具 ----------
def nfc(s): return unicodedata.normalize("NFKC", (s or "").strip())
def norm(s): return re.sub(SEP_RE, "", nfc(s).lower())
def split_aliases(s):
    if not s: return []
    return [a.strip() for a in re.split(r"[,，、/|]", s) if a.strip()]

def has_image(image_path):
    # Stash 对未设置自定义图的工作室，image_path 带 "default=true"
    return bool(image_path) and "default=true" not in image_path

def log(msg):
    line = "%s [st-backend] %s" % (datetime.datetime.now().isoformat(), msg)
    with _LOG_LOCK:
        # stderr 是 Stash 官方插件日志通道（[Plugin / 插件名] 前缀，errLog 控制级别）
        try:
            sys.stderr.write(line + "\n")
            sys.stderr.flush()
        except Exception:
            pass
        try:
            with open(LOG, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass

# ---------- 设置 ----------
def setting_bool(v, default=False):
    """BOOLEAN 设置解析：兼容 Stash 返回的真布尔与字符串形式。"""
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def get_settings(gql):
    try:
        plugins = ((gql("{ configuration { plugins } }").get("configuration") or {})
                   .get("plugins") or {})
        return plugins.get("studioToolsAuto") or {}
    except Exception as e:
        log("get_settings error: %s" % e)
        return {}

def resolve_sources(gql, settings):
    """解析拉取源列表，返回 (sources, multi, timeout)。

    - sourcePriority 为空（默认）→ 全部已配置实例：javstash → stashdb → theporndb
      → 其余自定义实例（按 Stash 元数据提供者配置顺序）。
    - 用户设置 → 逗号分隔列表即优先级即开关：内置 key（javstash/stashdb/theporndb）
      或自定义实例 endpoint；未列出的实例跳过，本地未配置对应 stash-box 的 key 跳过。
    - multi（多源补齐，默认 OFF）：ON = 并发查询所有列表源、每个精确命中的源都贡献
      （stash_ids/urls/aliases 并集）；OFF = 按序查询、首个精确命中即停。
    """
    multi = setting_bool(settings.get("multiSourceFill"))
    try:
        timeout = int(settings.get("timeoutPerSource") or DEFAULT_TIMEOUT)
        if timeout <= 0: timeout = DEFAULT_TIMEOUT
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    boxes = []
    try:
        boxes = ((gql(Q_CONFIG).get("configuration") or {}).get("general") or {}).get("stashBoxes") or []
    except Exception as e:
        log("get_stash_boxes error: %s" % e)
    if not boxes:
        return [], multi, timeout

    priority_raw = (settings.get("sourcePriority") or "").strip()
    if priority_raw:
        keys = [k.strip() for k in priority_raw.split(",") if k.strip()]
    else:
        # 默认全部：内置三源（按 BUILTIN_SOURCES 顺序）+ 其余自定义实例（配置顺序）
        keys = [s["key"] for s in BUILTIN_SOURCES]
        for b in boxes:
            ep = (b.get("endpoint") or "").lower()
            if any(s["host"] in ep for s in BUILTIN_SOURCES):
                continue
            keys.append(ep)

    def match_box(k):
        kk = k.lower()
        # 内置 key：host 子串匹配（javstash.org / stashdb.org / theporndb.net）
        for s in BUILTIN_SOURCES:
            if kk == s["key"] or s["key"] in kk:
                for b in boxes:
                    ep = (b.get("endpoint") or "").lower()
                    if s["host"] in ep:
                        return b, s["key"]
        # 自定义：endpoint 互相包含匹配
        for b in boxes:
            ep = (b.get("endpoint") or "").lower()
            if kk == ep or kk in ep or ep in kk:
                return b, ep
        return None, None

    sources = []
    used_eps = set()
    for k in keys:
        box, key = match_box(k)
        if not box or not box.get("endpoint"):
            log("source '%s' skipped (no matching configured stash-box)" % k)
            continue
        ep = (box["endpoint"] or "").lower()
        if ep in used_eps:
            continue
        used_eps.add(ep)
        sources.append({"key": key, "box": box})
    return sources, multi, timeout

# ---------- 拉取与匹配 ----------
def scrape(gql, term, box, timeout):
    """返回候选列表；请求失败返回 None（区别于空列表）。"""
    try:
        data = gql(Q_SCRAPE,
                   {"source": {"stash_box_endpoint": box["endpoint"]},
                    "input": {"query": term}},
                   timeout=timeout)
        return data.get("scrapeSingleStudio") or []
    except Exception as e:
        log("scrape %s error: %s" % (box.get("endpoint"), e))
        return None

def scrape_all(gql, term, sources, timeout):
    """并发拉取所有源，保持源顺序返回 [(source, cands)]；请求失败 cands 为 None。

    网络 I/O 等待时线程并发是真实并行；耗时 = 最慢源（≤ timeout），而非源数 × timeout。
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(sources) or 1, 8)) as ex:
        futs = [ex.submit(scrape, gql, term, s["box"], timeout) for s in sources]
        return [(s, f.result()) for s, f in zip(sources, futs)]

def find_exact(cands, name):
    """归一化精确相等匹配（无相似度阈值）；多个同名候选取第一个。"""
    nq = norm(name)
    for c in cands:
        if norm(c.get("name") or "") == nq:
            return c
    return None

# ---------- 工作室索引（主名/别名交叉唯一 → 精确查库） ----------
_index_cache = {"ts": 0, "index": None}

def build_index(studios):
    idx = {}
    for s in studios:
        sid = str(s["id"])
        idx.setdefault(norm(s.get("name") or ""), []).append(sid)
        for a in (s.get("aliases") or []):
            idx.setdefault(norm(a), []).append(sid)
    return idx

def get_studio_index(gql, studios=None):
    """全量工作室名称/别名索引（norm -> [id]）。传入 studios 则直接用（scan_all 免二次查询）。"""
    global _index_cache
    now = time.time()
    if studios is not None:
        return build_index(studios)
    if _index_cache["index"] is not None and now - _index_cache["ts"] < INDEX_TTL:
        return _index_cache["index"]
    data = gql(Q_STUDIOS_IDX)
    studios = ((data or {}).get("findStudios") or {}).get("studios") or []
    _index_cache = {"ts": now, "index": build_index(studios)}
    return _index_cache["index"]

def find_dup(index, name, exclude_id):
    ids = index.get(norm(name)) or []
    for i in ids:
        if i != str(exclude_id): return i
    return None

# ---------- 字段更新（只填空 + 并集 + 别名查重） ----------
def build_update(studio, hits, index):
    """构造对 studio 的补全更新：多候选（多源补齐）或单候选（首命中）合并。

    - 只填空：urls 各候选缺失追加；stash_ids 各命中源各自追加缺失（每源 endpoint 唯一）；
      aliases 追加缺失且写入前全库查重（撞其他工作室的名称/别名则跳过）。
      保留原名，canonical 名作别名。
    - parent：目标为空时按最高优先级命中的 parent 补齐，仅当本地已存在同名工作室
      （不自动创建上级，与 studioTools UI 版一致）；多命中只取最高优先级候选。
    """
    upd = {}
    sid = str(studio["id"])
    cands = [c for c, _ in hits]

    # urls：现有 + 各候选缺失追加
    existing_urls = list(studio.get("urls") or [])
    adds = []
    for cand in cands:
        for u in (cand.get("urls") or []):
            if u and isinstance(u, str) and u not in existing_urls and u not in adds:
                adds.append(u)
    if adds: upd["urls"] = existing_urls + adds

    # stash_ids：各命中源各自追加缺失（每源 endpoint 唯一）
    existing_ids = list(studio.get("stash_ids") or [])
    eps = {s.get("endpoint") for s in existing_ids}
    id_adds = []
    for cand, src in hits:
        if cand.get("remote_site_id") and src["box"]["endpoint"] not in eps:
            eps.add(src["box"]["endpoint"])
            id_adds.append({"endpoint": src["box"]["endpoint"], "stash_id": cand["remote_site_id"]})
    if id_adds: upd["stash_ids"] = existing_ids + id_adds

    # aliases：现有 + 各候选 (canonical 变体 + 候选别名) 缺失追加；全库查重防撞
    base = list(studio.get("aliases") or [])
    pool = []
    for cand in cands:
        cand_name = (cand.get("name") or "").strip()
        for a in split_aliases(cand.get("aliases")):
            if a and a not in pool:
                pool.append(a)
        if cand_name and norm(cand_name) != norm(studio.get("name") or "") and cand_name not in pool:
            pool.append(cand_name)
    used = {norm(x) for x in base} | {norm(studio.get("name") or "")}
    additions = []
    for a in pool:
        na = norm(a)
        if na in used: continue
        if any(i != sid for i in (index.get(na) or [])):
            log("%s: alias '%s' collides with another studio, skipped" % (sid, a))
            continue
        used.add(na)
        additions.append(a)
    if additions: upd["aliases"] = base + additions

    # parent：目标为空 → 最高优先级命中源的 parent.name → 本地已有同名工作室才设
    if not (studio.get("parent_studio") or {}).get("id"):
        for cand, _ in hits:
            pname = ((cand.get("parent") or {}).get("name") or "").strip()
            if not pname:
                continue
            pid = find_dup(index, pname, sid)
            if pid:
                upd["parent_id"] = pid
            else:
                log("%s: parent '%s' not found locally, skipped" % (sid, pname))
            break

    return upd

# ---------- 自研合并（Stash 无 studioMerge；与 UI 版 executeMerge 一致） ----------
def get_related_ids(gql, sid):
    rel = {}
    try:
        rel["scene"] = [s["id"] for s in ((gql(Q_SCENE_IDS, {"sid": sid}) or {}).get("findScenes") or {}).get("scenes") or []]
        rel["image"] = [s["id"] for s in ((gql(Q_IMAGE_IDS, {"sid": sid}) or {}).get("findImages") or {}).get("images") or []]
        rel["gallery"] = [s["id"] for s in ((gql(Q_GALLERY_IDS, {"sid": sid}) or {}).get("findGalleries") or {}).get("galleries") or []]
        rel["group"] = [s["id"] for s in ((gql(Q_GROUP_IDS, {"sid": sid}) or {}).get("findGroups") or {}).get("groups") or []]
        rel["child"] = [s["id"] for s in ((gql(Q_CHILD_IDS, {"sid": sid}) or {}).get("findStudios") or {}).get("studios") or []]
    except Exception as e:
        log("get_related_ids %s error: %s" % (sid, e))
    return rel

def transfer_related(gql, rel, dst_id):
    if rel.get("scene"): gql(M_BULK_SCENE, {"i": {"ids": rel["scene"], "studio_id": dst_id}})
    if rel.get("image"): gql(M_BULK_IMAGE, {"i": {"ids": rel["image"], "studio_id": dst_id}})
    if rel.get("gallery"): gql(M_BULK_GALLERY, {"i": {"ids": rel["gallery"], "studio_id": dst_id}})
    if rel.get("group"): gql(M_BULK_GROUP, {"i": {"ids": rel["group"], "studio_id": dst_id}})
    if rel.get("child"): gql(M_BULK_STUDIO, {"i": {"ids": rel["child"], "parent_id": dst_id}})

def merge_studio_into(gql, src_id, dst_id, values):
    """把 src 合并进 dst：转移关联 → 更新 dst 字段 → 删除 src。"""
    rel = get_related_ids(gql, src_id)
    transfer_related(gql, rel, dst_id)
    if values:
        gql(M_UPDATE, {"i": dict(values, id=dst_id)})
    gql(M_DESTROY, {"i": {"id": src_id}})
    return rel

# ---------- 图片（子进程异步，钩子不阻塞） ----------
def apply_image_async(conn, target_id, target_studio, cand, overwrite=False):
    if has_image(target_studio.get("image_path")) and not overwrite: return
    img = (cand or {}).get("image")
    if not img: return
    try:
        env = dict(os.environ, JAVSTASH_CONN=json.dumps(conn))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--set-image", str(target_id), img],
                         env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except Exception as e:
        log("%s: image spawn skipped (%s)" % (target_id, e))

def set_image_mode(target_id, image_url):
    """子进程入口：下载图片并以 base64 经 studioUpdate 设置（Stash 自身同步拉远程图会阻塞）。"""
    conn = json.loads(os.environ.get("JAVSTASH_CONN", "{}"))
    gql = make_gql(conn)
    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE  # 部分 Python 构建缺 CA 证书；图片为公开资源
    for attempt in range(3):
        try:
            req = urllib.request.Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=60, context=sslctx) as r:
                raw = r.read()
                ctype = r.headers.get("Content-Type", "image/jpeg")
            b64 = base64.b64encode(raw).decode()
            gql(M_UPDATE, {"i": {"id": target_id, "image": "data:%s;base64,%s" % (ctype, b64)}})
            log("%s: image set async (%s bytes)" % (target_id, len(raw)))
            return
        except Exception as e:
            log("%s: image async attempt %s failed (%s)" % (target_id, attempt + 1, e))
    log("%s: image async gave up" % target_id)

# ---------- 管线：单个工作室 拉取→匹配→合并/更新 ----------
def process_studio(gql, conn, studio, index, sources, multi, timeout):
    sid = str(studio["id"])
    name = studio.get("name") or ""
    if not name:
        return {"status": "skip", "reason": "no name"}
    if not sources:
        return {"status": "skip", "reason": "no enabled sources"}

    hits = []
    if multi:
        # 多源补齐：并发查询所有源，每个精确命中的源都贡献
        for s, cands in scrape_all(gql, name, sources, timeout):
            if cands is None:
                log("%s: source %s failed, no contribution" % (sid, s["key"]))
                continue
            exact = find_exact(cands, name)
            if exact:
                hits.append((exact, s))
                log("%s: source %s exact match" % (sid, s["key"]))
            else:
                log("%s: source %s no exact match, no contribution" % (sid, s["key"]))
    else:
        # 默认：按序查询，失败/未命中回退下一源，首个精确命中即停
        for s in sources:
            cands = scrape(gql, name, s["box"], timeout)
            if cands is None:
                log("%s: source %s failed, fallback" % (sid, s["key"]))
                continue
            exact = find_exact(cands, name)
            if exact:
                hits.append((exact, s))
                break
            log("%s: source %s no exact match, fallback" % (sid, s["key"]))

    if not hits:
        return {"status": "skip", "reason": "no exact match in any source"}

    hit, hit_box = hits[0]
    cand_name = (hit.get("name") or "").strip()
    # canonical 名撞库（主名/别名交叉唯一 → 精确查重）；多命中归一化等价 → 判定与命中数无关
    dup = find_dup(index, cand_name, sid)
    if dup:
        try:
            dst = (gql(Q_STUDIO, {"id": dup}) or {}).get("findStudio") or {}
            if not dst or not dst.get("name"):
                return {"status": "error", "reason": "dup studio %s not found" % dup}
            values = build_update(dst, hits, index)
            # 新建源的 stash_ids 并入目标（缺失才加）
            src_ids = studio.get("stash_ids") or []
            dst_eps = {s.get("endpoint") for s in (dst.get("stash_ids") or [])}
            src_adds = [s for s in src_ids if s.get("endpoint") not in dst_eps]
            if src_adds:
                values["stash_ids"] = list(dst.get("stash_ids") or []) + src_adds
            rel = merge_studio_into(gql, sid, dup, values)
            apply_image_async(conn, dup, dst, hit, overwrite=False)
            log("%s '%s': MERGED into %s '%s' (fields=%s, related=%s)" %
                (sid, name, dup, dst["name"], sorted(values.keys()),
                 {k: len(v) for k, v in rel.items() if v}))
            return {"status": "merged", "into": dup, "fields": sorted(values.keys())}
        except Exception as e:
            log("%s '%s': merge error %s" % (sid, name, e))
            return {"status": "error", "reason": str(e)}

    # 无撞 → 补全自身（只填空 + 多候选并集；canonical 名作别名）
    try:
        values = build_update(studio, hits, index)
        if values:
            gql(M_UPDATE, {"i": dict(values, id=sid)})
        apply_image_async(conn, sid, studio, hit, overwrite=False)
        srcs = ",".join(s["key"] for _, s in hits)
        if values:
            log("%s '%s': updated (fields=%s, sources=%s)" % (sid, name, sorted(values.keys()), srcs))
            return {"status": "updated", "fields": sorted(values.keys()), "source": srcs}
        log("%s '%s': hit in %s, no new fields" % (sid, name, srcs))
        return {"status": "hit", "source": srcs}
    except Exception as e:
        log("%s '%s': update error %s" % (sid, name, e))
        return {"status": "error", "reason": str(e)}

# ---------- 钩子：Studio.Create.Post ----------
def handle_hook(gql, conn, payload):
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    sid = ctx.get("id")
    htype = ctx.get("type", "")
    if not sid or "Studio.Create" not in htype:
        return {"status": "skip", "reason": "not studio create"}
    studio = ((gql(Q_STUDIO, {"id": sid}) or {}).get("findStudio") or {})
    if not studio or not studio.get("name"):
        return {"status": "skip", "reason": "no name"}
    index = get_studio_index(gql)
    settings = get_settings(gql)
    sources, multi, timeout = resolve_sources(gql, settings)
    return process_studio(gql, conn, studio, index, sources, multi, timeout)

# ---------- 任务：扫描缺少首个源 Stash ID 的工作室 ----------
def scan_all(gql, conn):
    settings = get_settings(gql)
    sources, multi, timeout = resolve_sources(gql, settings)
    data = gql("query { findStudios(filter:{per_page:-1}){ studios{"
               " id name aliases urls details image_path stash_ids{ endpoint stash_id }"
               " parent_studio{ id name } } } }")
    studios = ((data or {}).get("findStudios") or {}).get("studios") or []
    index = get_studio_index(gql, studios)
    if not sources:
        return {"total": len(studios), "scanned": 0, "skipped": len(studios),
                "note": "no enabled sources"}, []
    # 扫描范围 = 缺少首个优先级源 stash_id 的工作室（已有该源 ID = 已完成，跳过）
    primary_ep = (sources[0]["box"].get("endpoint") or "").lower()
    todo = []
    has_primary = 0
    for s in studios:
        if any((sid.get("endpoint") or "").lower() == primary_ep
               for sid in (s.get("stash_ids") or [])):
            has_primary += 1
        else:
            todo.append(s)
    results = []
    for s in todo:
        r = process_studio(gql, conn, s, index, sources, multi, timeout)
        results.append({"id": s["id"], "name": s.get("name") or "", **r})
    summary = {"total": len(studios), "primary": sources[0]["key"],
               "skipped_has_primary_sid": has_primary, "scanned": len(todo)}
    for st in ("merged", "updated", "hit", "skip", "error"):
        summary[st] = sum(1 for r in results if r.get("status") == st)
    return summary, results

# ---------- 入口 ----------
def main():
    try:
        # Stash 经管道传 UTF-8 JSON；Windows 下 sys.stdin 默认按 cp936 解码，
        # 直接 read() 遇中文会 UnicodeDecodeError，必须显式从 buffer 按 UTF-8 读
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        payload = json.loads(raw)
    except Exception as e:
        log("input parse error: %s" % e)
        print(json.dumps({"output": "no input"}))
        return
    conn = payload.get("server_connection", {})
    # 任务 defaultArgs 由 Stash 合并进 payload["args"]（源码 buildPluginInput），
    # 顶层 mode 仅为防御兼容
    args = payload.get("args") or {}
    mode = args.get("mode") or payload.get("mode") or "hook"
    gql = make_gql(conn)
    if mode == "scan_all":
        try:
            summary, results = scan_all(gql, conn)
            log("scan_all done: %s" % summary)
            print(json.dumps({"output": summary, "details": results}))
        except Exception as e:
            log("scan_all error: %s" % e)
            print(json.dumps({"output": "error", "error": str(e)}))
    else:
        try:
            r = handle_hook(gql, conn, payload)
            print(json.dumps({"output": r}))
        except Exception as e:
            log("hook error: %s" % e)
            print(json.dumps({"output": "hook error", "error": str(e)}))

if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--set-image":
        set_image_mode(sys.argv[2], sys.argv[3])
    else:
        main()
