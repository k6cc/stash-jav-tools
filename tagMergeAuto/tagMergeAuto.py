#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tag Merge Auto v1.2.4: 后台自动合并 tag（tagMerge 的无 UI 版本，零网络、零设置，由 tagMergeBackend 更名）。

- 钩子 Tag.Create.Post：新 tag 创建时立即查本地映射库 tag_merge_map.json，
  命中（归一化精确匹配）则合并进目标 tag；目标不存在时先创建再合并。
- 任务 "Full Scan & Merge"（任务列表页手动触发）：全库扫描，把存量源 tag
  合并进目标（首次安装后处理映射发布前已存在的源 tag，之后日常靠钩子闭环）。
- 任务 "Fill Stash IDs"：按候选词（主名+别名）从 stash-box 为存量 tag 批量补 stash_id
  （复用 tagMerge UI 版填充ID 规则：fillNorm 不删分隔符、每词精准实体全收集、append 多写）。
- 填充查询缓存：命中词写入插件目录 fill_cache.json（按 box 隔离），任务/钩子下次跳过已命中词；
  未命中词跨会话重查（可捕捉 stash-box 新增实体）。
- 钩子合并新 tag 后，若 autoFillStashId 开（默认），自动给目标 tag 补 stash_id。

与 tagMerge UI 版解析/执行逻辑一致：归一化精确匹配、防链式、幂等、
源 tag 合并后名称补写进目标别名（数据不丢失，仍可按原名搜索）。
映射库键 = 目标 tag 名，值 = 源 tag 名列表；"_" 开头的键（说明/被忽略的映射）跳过。
标准库 only。
"""
import sys, json, re, unicodedata, os, datetime, time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_merge_map.json")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_merge_auto.log")
FILL_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fill_cache.json")

# 归一化规则与 tagMerge.js 一致：NFKC（全角→半角）、小写、去空白与分隔符
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
        import urllib.request
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read())
        if j.get("errors"): raise RuntimeError(j["errors"])
        return j["data"]
    return gql

def stash_language(gql):
    """读取 Stash 全局界面语言（configuration.interface.language），失败返回空串。"""
    try:
        r = gql("query { configuration { interface { language } } }")
        conf = (r or {}).get("configuration") or {}
        iface = conf.get("interface") or {}
        return (iface.get("language") or "").replace("-", "_")
    except Exception:
        return ""

def get_settings(gql):
    """读取插件页设置（yml settings 段渲染到 Settings → 插件），键为 yml 文件名派生的插件 id。"""
    try:
        plugins = ((gql("query { configuration { plugins } }") or {}).get("configuration") or {}).get("plugins") or {}
        return plugins.get("tagMergeAuto") or {}
    except Exception:
        return {}

Q_TAG = "query($id: ID!){ findTag(id:$id){ id name aliases } }"
Q_TAGS = "query { findTags(filter:{per_page:-1}){ tags{ id name } } }"
Q_TAG_BY_NAME = ("query($n:String!){ findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},"
                 " filter:{per_page:1}){ tags{ id name } } }")
M_TAG_CREATE = "mutation($i: TagCreateInput!){ tagCreate(input:$i){ id name } }"
M_TAGS_MERGE = "mutation($i: TagsMergeInput!){ tagsMerge(input:$i){ id name aliases } }"
M_TAG_UPDATE = "mutation($i: TagUpdateInput!){ tagUpdate(input:$i){ id } }"
# 填充 stash_id：全库 tag（含现有 stash_ids）+ stash-box 配置 + 单 tag 刮削
Q_TAGS_FILL = "query { findTags(filter:{per_page:-1}){ tags{ id name aliases stash_ids{ endpoint stash_id } } } }"
Q_BOXES = "query { configuration { general { stashBoxes { name endpoint } } } }"
Q_SCRAPE = ("query($source: ScraperSourceInput!, $input: ScrapeSingleTagInput!){"
            " scrapeSingleTag(source:$source, input:$input){ name alias_list remote_site_id } }")
Q_TAG_FILL_ONE = "query($id: ID!){ findTag(id:$id){ id name aliases stash_ids{ endpoint stash_id } } }"
FILL_QUERY_DELAY = 0.5  # 每词查询间隔（≈120 次/分，保守限速，与 tagMerge.js 一致）

# ---------- 归一化 / 映射库 ----------
def nfc(s): return unicodedata.normalize("NFKC", (s or "").strip())
def norm(s): return re.sub(SEP_RE, "", nfc(s).lower())

def map_candidates(lang):
    """映射表优先级链：<lang>.custom → custom → <lang> → 默认（存在即定，不存在顺延）。
    任何用户自定义（custom）优先于任何发行版。"""
    base = os.path.join(os.path.dirname(MAP_FILE), "tag_merge_map")
    cands = []
    if lang:
        cands.append("%s_%s.custom.json" % (base, lang))
    cands.append(base + ".custom.json")
    if lang:
        cands.append("%s_%s.json" % (base, lang))
    cands.append(base + ".json")
    return cands

def load_map(lang=None):
    """按优先级链解析映射表，返回 (items, error, path)。

    error：None=正常；"load_failed"=首个存在的候选解析失败（不静默回退）；
    "bad_root"=根非 JSON 对象；"empty"=无有效映射组。
    所有候选都不存在 → ("load_failed", None)。空 sources 组不构成有效映射。
    """
    for p in map_candidates(lang):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            continue
        except Exception as e:
            log("load_map error (%s): %s" % (os.path.basename(p), e))
            return [], "load_failed", p
        if not isinstance(data, dict):
            log("load_map error (%s): root is not a JSON object" % os.path.basename(p))
            return [], "bad_root", p
        items = []
        for target, sources in data.items():
            if not isinstance(target, str) or not target or target.startswith("_"):
                continue
            if isinstance(sources, list):
                cleaned = [s for s in sources if isinstance(s, str) and s.strip()]
                if cleaned:
                    items.append({"target": target, "sources": cleaned})
        if not items:
            return [], "empty", p
        return items, None, p
    return [], "load_failed", None

# ---------- 分组（与 tagMerge.js buildGroups 解析阶段一致） ----------
def build_groups(tags, mapping):
    exact = {}
    norm_groups = {}
    for t in tags:
        exact.setdefault(t["name"], t)
        norm_groups.setdefault(norm(t["name"]), []).append(t)

    target_names = set()
    target_norms = set()
    for m in mapping:
        target_names.add(m["target"])
        target_norms.add(norm(m["target"]))

    groups = []
    for m in mapping:
        own_tn = norm(m["target"])
        dest = exact.get(m["target"])
        src_tags = []
        seen_ids = set()

        def add_candidate(t):
            if dest and str(t["id"]) == str(dest["id"]): return
            if t["id"] in seen_ids: return
            seen_ids.add(t["id"])
            src_tags.append(t)

        for s in m["sources"]:
            if s == m["target"]: continue
            # 防链式：源名（精确或归一化）是其他组的目标名时不作为源；
            # 与本组目标归一化相同的源是目标自身的写法变体，正常并入
            if s in target_names or (norm(s) in target_norms and norm(s) != own_tn):
                continue
            for c in norm_groups.get(norm(s), []):
                add_candidate(c)
        # 目标自身的归一化变体（未列入源列表的库内 tag）
        for c in norm_groups.get(own_tn, []):
            add_candidate(c)

        if not src_tags: continue
        groups.append({"target": m["target"], "dest": dest, "sources": src_tags})

    groups.sort(key=lambda g: (-len(g["sources"]), g["target"]))
    return groups

# ---------- 执行单组合并（与 tagMerge.js runGroup 执行阶段一致） ----------
def run_group(gql, g, consumed):
    sources = [s for s in g["sources"]
               if s["id"] not in consumed and not (g["dest"] and s["id"] == g["dest"]["id"])]
    if not sources: return None

    dest_id = g["dest"]["id"] if g["dest"] else None
    created = False
    if not dest_id:
        res = gql(M_TAG_CREATE, {"i": {"name": g["target"]}})
        if not res or not res.get("tagCreate"): raise RuntimeError("tagCreate failed")
        dest_id = str(res["tagCreate"]["id"])
        created = True

    merged = gql(M_TAGS_MERGE, {"i": {"source": [s["id"] for s in sources], "destination": dest_id}})
    for s in sources: consumed[s["id"]] = True

    m = (merged or {}).get("tagsMerge") or {}
    dest_name = m.get("name") or g["target"]
    aliases = m.get("aliases")
    if aliases is None:
        d = gql(Q_TAG, {"id": dest_id})
        aliases = ((d or {}).get("findTag") or {}).get("aliases") or []
    aliases = list(aliases or [])

    # 源名补写进目标别名（大小写不敏感去重；与目标名相同则跳过）
    want = list(aliases)
    have = {a.lower() for a in aliases}
    dest_lower = dest_name.lower()
    for s in sources:
        sl = s["name"].lower()
        if sl == dest_lower or sl in have: continue
        have.add(sl)
        want.append(s["name"])
    if len(want) != len(aliases):
        gql(M_TAG_UPDATE, {"i": {"id": dest_id, "aliases": want}})

    return {"target": g["target"], "dest_id": dest_id, "created": created,
            "sources": [s["name"] for s in sources]}

# ---------- 钩子：Tag.Create.Post ----------
def handle_hook(gql, lang, args, settings):
    payload = _PAYLOAD
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    tid = ctx.get("id")
    htype = ctx.get("type", "")
    if not tid or "Tag.Create" not in htype:
        print(json.dumps({"output": "skip (not tag create)"}))
        return
    t = ((gql(Q_TAG, {"id": tid}) or {}).get("findTag") or {})
    if not t or not t.get("name"): return
    name = t["name"]

    mapping, map_err, _map_path = load_map(lang)
    if map_err:
        log("hook skip: mapping %s (new tag '%s' not merged)" % (map_err, name))
        print(json.dumps({"output": "skip (mapping %s)" % map_err}))
        return
    target_names = set(m["target"] for m in mapping)
    target_norms = set(norm(m["target"]) for m in mapping)
    n = norm(name)

    # 新 tag 名是某组目标名（规范化名）→ 不需要合并
    if n in target_norms: return

    hit = None
    for m in mapping:
        own_tn = norm(m["target"])
        for s in m["sources"]:
            if s == m["target"]: continue
            if s in target_names or (norm(s) in target_norms and norm(s) != own_tn): continue
            if norm(s) == n:
                hit = m
                break
        if hit: break
    if not hit: return

    dest_tag = None
    try:
        res = gql(Q_TAG_BY_NAME, {"n": m["target"]})
        tags = ((res or {}).get("findTags") or {}).get("tags") or []
        if tags: dest_tag = tags[0]
    except Exception as e:
        log("hook dest lookup error: %s" % e)

    g = {"target": m["target"], "dest": dest_tag,
         "sources": [t] if t.get("id") else []}
    # 防御：新 tag 若同时是目标自身（理论上已排除），跳过
    if g["dest"] and str(g["dest"]["id"]) == str(t["id"]): return
    consumed = {}
    try:
        r = run_group(gql, g, consumed)
        if r:
            log("hook merged '%s' -> '%s' (dest %s, created=%s)" % (name, r["target"], r["dest_id"], r["created"]))
            # 合并成功后自动补 stash_id（插件页设置 autoFillStashId 默认开；显式 False 才关）
            if settings.get("autoFillStashId") is not False:
                try:
                    box = resolve_box(gql, args.get("stashBox") or settings.get("stashBox") or "javstash")
                    if box:
                        dt = ((gql(Q_TAG_FILL_ONE, {"id": r["dest_id"]}) or {}).get("findTag") or {})
                        if dt:
                            cache = load_fill_cache()
                            try:
                                ok, why = fill_one_tag(gql, dt, box, bool(settings.get("forceQuery", False)), cache)
                            finally:
                                save_fill_cache(cache)
                            if ok:
                                log("hook auto-filled stash_id '%s' <- %s (%s)" % (dt.get("name"), box["name"], why))
                except Exception as e:
                    log("hook auto-fill stash_id error: %s" % e)
            print(json.dumps({"output": "merged '%s' into '%s'" % (name, r["target"])}))
        else:
            print(json.dumps({"output": "skip (no effective sources)"}))
    except Exception as e:
        log("hook merge error: %s" % e)
        print(json.dumps({"output": "merge error", "error": str(e)}))

# ---------- 填充 stash_id（与 tagMerge.js 填充ID Tab 规则一致） ----------
def fill_norm(s):
    """fillNorm：NFKC + 小写 + 连续空格归一 + trim；不删分隔符（3P/ 与 3P·4P 是不同实体）。"""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", (s or "")).lower()).strip()


def load_fill_cache():
    """读取命中词缓存 {endpoint: {norm_word: {"entities": [{id,name}], "ts": t}}}。
    只保留结构合法的命中词（entities 非空且每项含 id）；"_" 开头键（说明/防御）跳过。
    未命中词不入缓存 → 跨会话重查（与 tagMerge.js localStorage 缓存语义一致）。"""
    try:
        with open(FILL_CACHE_FILE, encoding="utf-8") as f:
            raw = json.load(f) or {}
    except Exception:
        return {}
    out = {}
    for ep, words in raw.items():
        if not isinstance(ep, str) or ep.startswith("_") or not isinstance(words, dict):
            continue
        wd = {}
        for k, v in words.items():
            if not isinstance(k, str) or not k or k.startswith("_") or not isinstance(v, dict):
                continue
            ents = v.get("entities")
            if isinstance(ents, list) and ents and all(isinstance(e, dict) and e.get("id") for e in ents):
                wd[k] = {"entities": ents, "ts": v.get("ts") or 0}
        if wd:
            out[ep] = wd
    return out


def save_fill_cache(cache):
    """原子写缓存（tmp + os.replace），失败静默（缓存是优化，不阻塞任务/钩子）。"""
    if not cache:
        return
    try:
        tmp = FILL_CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, FILL_CACHE_FILE)
    except Exception as e:
        log("fill cache save error: %s" % e)


def resolve_box(gql, want):
    """按用户输入名匹配 stash-box（小写包含匹配）；匹配不到按品牌优先级 JAVStash→StashDB→ThePornDB 选第一个。"""
    boxes = (((gql(Q_BOXES) or {}).get("configuration") or {}).get("general") or {}).get("stashBoxes") or []
    if not boxes:
        return None
    want = (want or "").strip().lower()
    if want:
        for b in boxes:
            if want in (b.get("name") or "").lower():
                return b
    def rank(b):
        n = (b.get("name") or "").lower()
        if "javstash" in n: return 0
        if "stashdb" in n: return 1
        if "porndb" in n: return 2
        return 3
    return sorted(boxes, key=rank)[0]


def candidate_words(t):
    """候选词：主名 + 别名。fillNorm 去重。"""
    seen, out = set(), []
    for w in list(t.get("aliases") or []) + [t.get("name")]:
        if not w: continue
        n = fill_norm(w)
        if n and n not in seen:
            seen.add(n); out.append(w)
    return out


def query_box_word(gql, endpoint, word):
    """查 stash-box 单词，返回命中实体 [{id,name}]（按 remote_site_id 去重；name/alias_list 精确 fillNorm 匹配）。"""
    try:
        res = gql(Q_SCRAPE, {"source": {"stash_box_endpoint": endpoint}, "input": {"query": word}}, timeout=30)
    except Exception as e:
        log("fill scrape error (%s / '%s'): %s" % (endpoint, word, e))
        return []
    rows = ((res or {}).get("scrapeSingleTag")) or []
    word_n = fill_norm(word)
    hits = {}
    for r in rows:
        if not r or not r.get("remote_site_id"): continue
        aliases = [fill_norm(a) for a in (r.get("alias_list") or [])]
        if fill_norm(r.get("name")) == word_n or word_n in aliases:
            hits[r["remote_site_id"]] = {"id": r["remote_site_id"], "name": r.get("name")}
    return list(hits.values())


def fill_one_tag(gql, tag, box, force=False, cache=None):
    """给单个 tag 补 stash_id（与 tagMerge.js 填充ID Tab 规则一致）：每词精准实体全收集、
    排除已存在 id（endpoint+id）、append 全部写入（同 box 可多条）。
    全量重查 force=True：该 box 已写过 id 也查询（只追加未写入实体），词缓存也绕过重查
    （可捕捉 stash-box 新增实体/别名），查询命中仍写回缓存。
    查询缓存：候选词命中缓存（按 box + fillNorm 词）→ 直接用实体免查询；未命中才查
    stash-box（查询后限速），命中词并入缓存由调用方统一持久化。
    返回 (wrote, reason)：reason=has_id（该 box 已有任意 id，force 时跳过此判定）/miss（无新增）/<写入条数>。"""
    ep = box["endpoint"]
    cache = cache if cache is not None else {}
    existing = tag.get("stash_ids") or []
    if not force and any(s.get("endpoint") == ep for s in existing):
        return False, "has_id"
    has = {(s.get("endpoint"), s.get("stash_id")) for s in existing}
    new = []
    for w in candidate_words(tag):
        key = fill_norm(w)
        ent = cache.get(ep, {}).get(key)
        if force or ent is None:
            hits = query_box_word(gql, ep, w)
            time.sleep(FILL_QUERY_DELAY)
            if hits:
                cache.setdefault(ep, {})[key] = {"entities": hits, "ts": time.time()}
            ent = {"entities": hits}
        for e in ent["entities"]:
            if (ep, e["id"]) not in has:
                new.append(e)
    # 跨词去重（同 box 实体 id 唯一）
    seen = set()
    uniq = []
    for e in new:
        if e["id"] in seen:
            continue
        seen.add(e["id"])
        uniq.append(e)
    if not uniq:
        return False, "miss"
    next_ids = [{"endpoint": s["endpoint"], "stash_id": s["stash_id"]} for s in existing]
    for e in uniq:
        next_ids.append({"endpoint": ep, "stash_id": e["id"]})
    gql(M_TAG_UPDATE, {"i": {"id": tag["id"], "stash_ids": next_ids}})
    tag["stash_ids"] = next_ids
    return True, str(len(uniq))


def fill_all(gql, box_name, force=False):
    """全量任务：所有该 box 无 stash_id 的 tag 逐个填充（进度经 Stash 任务协议上报）；
    force=True 时已写过 id 的 tag 也处理（只追加未写入实体）。
    任务级查询缓存：开始 load_fill_cache，结束时原子写回（含本次命中词）。"""
    box = resolve_box(gql, box_name)
    if not box:
        return {"wrote": 0, "failed": 0, "note": "no stash-box configured"}
    cache = load_fill_cache()
    tags = (((gql(Q_TAGS_FILL) or {}).get("findTags") or {}).get("tags")) or []
    total = len(tags)
    wrote = failed = missed = skipped = ids = 0
    log_info("fill_id start: %d tags, box=%s" % (total, box["name"]))
    try:
        for done, t in enumerate(tags, 1):
            log_progress(done / float(total) if total else 1.0)
            try:
                ok, why = fill_one_tag(gql, t, box, force, cache)
                if ok:
                    wrote += 1
                    ids += int(why)
                    log("fill_id wrote '%s' <- %s (%s ids)" % (t.get("name"), box["name"], why))
                elif why == "has_id":
                    skipped += 1
                else:
                    missed += 1
            except Exception as e:
                failed += 1
                log("fill_id tag '%s' error: %s" % (t.get("name"), e))
            if done % 20 == 0 or done == total:
                log_info("fill_id: %d/%d (wrote %d tags / %d ids, missed %d, failed %d)"
                         % (done, total, wrote, ids, missed, failed))
    finally:
        save_fill_cache(cache)
    log_progress(1.0)
    return {"box": box["name"], "wrote": wrote, "ids": ids, "skipped": skipped,
            "missed": missed, "failed": failed}


# ---------- 任务：全量扫描合并 ----------
def scan_all(gql, lang):
    data = gql(Q_TAGS, {})
    tags = ((data or {}).get("findTags") or {}).get("tags") or []
    mapping, map_err, _map_path = load_map(lang)
    if map_err:
        return {"groups": 0, "merged": 0, "skipped": len(tags), "note": "mapping %s" % map_err}
    groups = build_groups(tags, mapping)
    consumed = {}
    merged = 0
    for g in groups:
        try:
            r = run_group(gql, g, consumed)
            if r:
                merged += 1
                log("scan merged '%s' (dest %s, sources=%s)" % (r["target"], r["dest_id"], r["sources"]))
        except Exception as e:
            log("scan group '%s' error: %s" % (g["target"], e))
    return {"groups": len(groups), "merged": merged, "skipped": len(tags)}

# ---------- 入口 ----------
_PAYLOAD = {}

# Stash 任务进度协议：stderr 输出 \x01p\x02<0~1> 渲染进度条、\x01i\x02<msg> 任务页显示消息
def _proto(level, msg):
    try:
        sys.stderr.write("\x01%s\x02%s\n" % (level, msg))
        sys.stderr.flush()
    except Exception:
        pass

def log_progress(p):
    _proto("p", "%.3f" % max(0.0, min(1.0, float(p))))

def log_info(msg):
    _proto("i", str(msg))

def log(msg):
    line = "%s [tgm-backend] %s" % (datetime.datetime.now().isoformat(), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    # stderr 是 Stash 官方插件日志通道（[Plugin / 插件名] 前缀，errLog 控制级别）
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass

def main():
    global _PAYLOAD
    try:
        # Stash 经管道传 UTF-8 JSON；Windows 下 sys.stdin 默认按 cp936 解码，
        # 直接 read() 遇中文会 UnicodeDecodeError，必须显式从 buffer 按 UTF-8 读
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        _PAYLOAD = json.loads(raw)
    except Exception as e:
        log("input parse error: %s" % e)
        print(json.dumps({"output": "no input"}))
        return
    conn = _PAYLOAD.get("server_connection", {})
    # 任务 defaultArgs 由 Stash 合并进 payload["args"]（源码 buildPluginInput），
    # 顶层 mode 仅为防御兼容
    args = _PAYLOAD.get("args") or {}
    mode = args.get("mode") or _PAYLOAD.get("mode") or "hook"
    gql = make_gql(conn)
    lang = stash_language(gql)
    settings = get_settings(gql)
    if mode == "scan_all":
        try:
            r = scan_all(gql, lang)
            log("scan_all done: %s" % r)
            print(json.dumps({"output": r}))
        except Exception as e:
            log("scan_all error: %s" % e)
            print(json.dumps({"output": "error", "error": str(e)}))
    elif mode == "fill_id":
        try:
            # stashBox：任务参数优先，其次插件页设置，默认 javstash
            box_name = args.get("stashBox") or settings.get("stashBox") or "javstash"
            r = fill_all(gql, box_name, bool(settings.get("forceQuery", False)))
            log("fill_id done: %s" % r)
            print(json.dumps({"output": r}))
        except Exception as e:
            log("fill_id error: %s" % e)
            print(json.dumps({"output": "error", "error": str(e)}))
    else:
        try:
            handle_hook(gql, lang, args, settings)
        except Exception as e:
            log("hook error: %s" % e)
            print(json.dumps({"output": "hook error", "error": str(e)}))

if __name__ == "__main__":
    main()
