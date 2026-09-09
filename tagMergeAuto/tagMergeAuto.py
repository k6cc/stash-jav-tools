#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tag Merge Auto v1.0.0: 后台自动合并 tag（tagMerge 的无 UI 版本，零网络、零设置，由 tagMergeBackend 更名）。

- 钩子 Tag.Create.Post：新 tag 创建时立即查本地映射库 tag_merge_map.json，
  命中（归一化精确匹配）则合并进目标 tag；目标不存在时先创建再合并。
- 任务 "Full Scan & Merge"（任务列表页手动触发）：全库扫描，把存量源 tag
  合并进目标（首次安装后处理映射发布前已存在的源 tag，之后日常靠钩子闭环）。

与 tagMerge UI 版解析/执行逻辑一致：归一化精确匹配、防链式、幂等、
源 tag 合并后名称补写进目标别名（数据不丢失，仍可按原名搜索）。
映射库键 = 目标 tag 名，值 = 源 tag 名列表；"_" 开头的键（说明/被忽略的映射）跳过。
标准库 only。
"""
import sys, json, re, unicodedata, os, datetime

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

MAP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_merge_map.json")
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tag_merge_auto.log")

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

Q_TAG = "query($id: ID!){ findTag(id:$id){ id name aliases } }"
Q_TAGS = "query { findTags(filter:{per_page:-1}){ tags{ id name } } }"
Q_TAG_BY_NAME = ("query($n:String!){ findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},"
                 " filter:{per_page:1}){ tags{ id name } } }")
M_TAG_CREATE = "mutation($i: TagCreateInput!){ tagCreate(input:$i){ id name } }"
M_TAGS_MERGE = "mutation($i: TagsMergeInput!){ tagsMerge(input:$i){ id name aliases } }"
M_TAG_UPDATE = "mutation($i: TagUpdateInput!){ tagUpdate(input:$i){ id } }"

# ---------- 归一化 / 映射库 ----------
def nfc(s): return unicodedata.normalize("NFKC", (s or "").strip())
def norm(s): return re.sub(SEP_RE, "", nfc(s).lower())

def load_map():
    """解析 tag_merge_map.json：返回 [{target, sources}]；_ 开头键跳过（说明键 / 被忽略的映射）。"""
    try:
        with open(MAP_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log("load_map error: %s" % e)
        return []
    if not isinstance(data, dict): return []
    items = []
    for target, sources in data.items():
        if not isinstance(target, str) or not target or target.startswith("_"):
            continue
        if isinstance(sources, list):
            items.append({"target": target,
                          "sources": [s for s in sources if isinstance(s, str) and s.strip()]})
    return items

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
def handle_hook(gql):
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

    mapping = load_map()
    if not mapping: return
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
            print(json.dumps({"output": "merged '%s' into '%s'" % (name, r["target"])}))
        else:
            print(json.dumps({"output": "skip (no effective sources)"}))
    except Exception as e:
        log("hook merge error: %s" % e)
        print(json.dumps({"output": "merge error", "error": str(e)}))

# ---------- 任务：全量扫描合并 ----------
def scan_all(gql):
    data = gql(Q_TAGS, {})
    tags = ((data or {}).get("findTags") or {}).get("tags") or []
    mapping = load_map()
    if not mapping:
        return {"groups": 0, "merged": 0, "skipped": 0, "note": "empty mapping"}
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
    if mode == "scan_all":
        try:
            r = scan_all(gql)
            log("scan_all done: %s" % r)
            print(json.dumps({"output": r}))
        except Exception as e:
            log("scan_all error: %s" % e)
            print(json.dumps({"output": "error", "error": str(e)}))
    else:
        try:
            handle_hook(gql)
        except Exception as e:
            log("hook error: %s" % e)
            print(json.dumps({"output": "hook error", "error": str(e)}))

if __name__ == "__main__":
    main()
