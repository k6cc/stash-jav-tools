# -*- coding: utf-8 -*-
"""Tag Merge: 依据映射库 tag_merge_map.json 把相似名称的 tags 合并到目标 tag

- 源 tag 合并进目标后名称保留为目标的别名（数据不丢失）
- 目标 tag 不存在时自动新建
- 源不存在（已合并过/已改名）时自动跳过，任务可安全重复执行
- 映射库中以 _ 开头的键会被忽略，可用于临时禁用某条规则
"""
import sys
import os
import json
import re
import time
import unicodedata

try:
    import requests
    _HAS_REQUESTS = True
except ImportError:
    _HAS_REQUESTS = False

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
_MAP_FILE = os.path.join(_PLUGIN_DIR, "tag_merge_map.json")

# 与映射库生成规则一致的名称归一化：全角->半角、小写、去空白与分隔符
_SEP_RE = re.compile(r"[\s\u3000·、，,。/\-—_・]+")


def normalize(s):
    return _SEP_RE.sub("", unicodedata.normalize("NFKC", s).lower())


# ============================================================
# 日志（stash raw interface 协议）
# ============================================================

def _log(level_char, s):
    if not level_char:
        return
    prefix = (b"\x01" + level_char + b"\x02").decode()
    print(prefix + s + "\n", file=sys.stderr, flush=True)


def LogInfo(s):
    _log(b"i", s)


def LogWarning(s):
    _log(b"w", s)


def LogError(s):
    _log(b"e", s)


def LogProgress(p):
    _log(b"p", str(min(max(0, p), 1)))


def fatal(msg):
    LogError(msg)
    print(json.dumps({"output": "", "error": msg}))
    sys.exit(1)


# ============================================================
# Stash GraphQL 客户端
# ============================================================

class StashClient:

    def __init__(self, server):
        host = server.get("Host", "localhost")
        if host == "0.0.0.0":
            host = "localhost"
        self._url = f"{server.get('Scheme', 'http')}://{host}:{server.get('Port', 9999)}/graphql"
        self._headers = {"Content-Type": "application/json", "Accept": "application/json"}
        api_key = server.get("ApiKey")
        if api_key:
            self._headers["ApiKey"] = api_key
        self._cookies = None
        sc = server.get("SessionCookie")
        if sc:
            self._cookies = {"session": sc.get("Value")}

    def gql(self, query, variables=None, _max_retries=3):
        if not _HAS_REQUESTS:
            fatal("requests library not installed")
        payload = {"query": query}
        if variables:
            payload["variables"] = variables

        last_err = None
        r = None
        for attempt in range(_max_retries):
            try:
                r = requests.post(self._url, json=payload, headers=self._headers,
                                  cookies=self._cookies, timeout=30)
                break
            except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_err = e
                if attempt < _max_retries - 1:
                    wait = 2 ** (attempt + 1)
                    LogWarning(f"GraphQL 连接失败，{wait}s 后重试 {attempt + 1}/{_max_retries}")
                    time.sleep(wait)
        if r is None:
            raise ConnectionError(f"GraphQL failed after {_max_retries} retries: {repr(last_err)}")

        if r.status_code == 401:
            fatal("HTTP 401 Unauthorized")
        if r.status_code != 200:
            raise ConnectionError(f"GraphQL failed: {r.status_code} - {r.text[:200]}")

        data = r.json()
        if data.get("errors"):
            for err in data["errors"]:
                LogError(f"GraphQL error: {err.get('message', err)}")
            return {}
        return data.get("data", {})

    def find_all_tags(self):
        q = """query{findTags(filter:{per_page:-1}){tags{id name}}}"""
        return self.gql(q).get("findTags", {}).get("tags", [])

    def find_tag_aliases(self, tag_id):
        q = """query($id:ID!){findTag(id:$id){aliases}}"""
        return self.gql(q, {"id": tag_id}).get("findTag", {}).get("aliases") or []

    def tag_create(self, name):
        q = """mutation($i:TagCreateInput!){tagCreate(input:$i){id name aliases}}"""
        return self.gql(q, {"i": {"name": name}}).get("tagCreate")

    def tags_merge(self, source_ids, destination_id):
        q = """mutation($i:TagsMergeInput!){tagsMerge(input:$i){id name aliases}}"""
        return self.gql(q, {"i": {"source": source_ids, "destination": destination_id}}).get("tagsMerge")

    def tag_update_aliases(self, tag_id, aliases):
        q = """mutation($i:TagUpdateInput!){tagUpdate(input:$i){id}}"""
        return self.gql(q, {"i": {"id": tag_id, "aliases": aliases}}).get("tagUpdate")


# ============================================================
# 主流程
# ============================================================

def load_mapping():
    """读取映射库，返回按文档顺序的目标->源列表"""
    if not os.path.isfile(_MAP_FILE):
        fatal(f"映射库不存在: {_MAP_FILE}")
    try:
        with open(_MAP_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        fatal(f"映射库读取失败: {repr(e)}")

    mapping = {}
    for target, sources in data.items():
        if not isinstance(target, str) or target.startswith("_"):
            continue
        if not isinstance(sources, list):
            LogWarning(f"忽略非法条目（值必须是数组）: {target}")
            continue
        cleaned = [s for s in sources if isinstance(s, str) and s.strip()]
        if cleaned:
            mapping[target] = cleaned
    return mapping


def merge_tags(client, mapping):
    tags = client.find_all_tags()
    if tags is None:
        tags = []
    LogInfo(f"库内 tags: {len(tags)}，映射规则: {len(mapping)} 组")

    # 名称索引：精确名 -> tag；归一化名 -> tag 列表（大小写/全角半角/分隔符变体可能有多个）
    exact = {}
    norm_groups = {}
    for t in tags:
        exact.setdefault(t["name"], t)
        norm_groups.setdefault(normalize(t["name"]), []).append(t)

    target_names = set(mapping.keys())
    target_norms = {normalize(t) for t in mapping}

    deleted_ids = set()   # 已被合并消耗的源 tag
    used_dest_ids = set()
    stat = {"groups": 0, "tags": 0, "created": 0, "skipped_src": 0, "empty_groups": 0}

    total = len(mapping)
    for i, (target, sources) in enumerate(mapping.items()):
        LogProgress((i + 1) / total if total else 1)
        own_tn = normalize(target)

        # 解析目标（仅精确匹配；新建推迟到确认有源，避免为无源组创建空 tag）
        dest = exact.get(target)
        if dest and dest["id"] in deleted_ids:
            LogError(f"跳过组 [{target}]: 目标已被先前的合并消耗（映射存在链式引用，请检查）")
            continue

        # 解析源：源名的全部归一化变体 tag 都并入目标
        src_tags = []
        seen_ids = set()
        dest_id = dest["id"] if dest else None

        def add_candidate(t):
            if dest_id is not None and t["id"] == dest_id:
                return
            if t["id"] in seen_ids:
                return
            if t["id"] in deleted_ids or t["id"] in used_dest_ids:
                return
            seen_ids.add(t["id"])
            src_tags.append(t)

        for s in sources:
            if s == target:
                continue
            # 防链式：源名（精确或归一化）是"其他组"的目标名时不作为源。
            # 注意与本组目标归一化相同的源（如 3P·4P vs 3P/4P）不在此列，
            # 它们是目标自身的写法变体，正常并入目标。
            if s in target_names or (normalize(s) in target_norms and normalize(s) != own_tn):
                LogWarning(f"  [{target}] 跳过源 {s}: 是其他组的目标名")
                stat["skipped_src"] += 1
                continue
            cands = norm_groups.get(normalize(s), [])
            if not cands:
                # 不存在：可能已合并过或已改名，静默跳过（保证幂等）
                stat["skipped_src"] += 1
                continue
            for t in cands:
                add_candidate(t)

        # 目标自身的归一化变体（未列入源列表的库内 tag，如大小写/全角/分隔符差异）也并入目标
        for t in norm_groups.get(own_tn, []):
            add_candidate(t)

        if not src_tags:
            stat["empty_groups"] += 1
            continue

        # 确认有源后再新建目标，保证目标名称与映射库完全一致
        if not dest:
            dest = client.tag_create(target)
            if not dest:
                LogError(f"跳过组 [{target}]: 目标新建失败")
                continue
            stat["created"] += 1
            LogInfo(f"新建目标 tag: {target}")

        merged = client.tags_merge([t["id"] for t in src_tags], dest["id"])
        deleted_ids.update(t["id"] for t in src_tags)
        used_dest_ids.add(dest["id"])
        stat["groups"] += 1
        stat["tags"] += len(src_tags)

        # 补写别名：源名称并入目标 aliases（幂等，按大小写不敏感去重，与目标同名者跳过；
        # 字符串不同但归一化相同的变体如 3P·4P 仍保留为别名，保证按原名可搜索）
        dest_name = (merged or dest).get("name") or target
        aliases = (merged or {}).get("aliases")
        if aliases is None:
            aliases = client.find_tag_aliases(dest["id"])
        want = list(aliases)
        have = {a.lower() for a in want}
        dest_lower = dest_name.lower()
        for t in src_tags:
            nm = t["name"]
            if nm.lower() == dest_lower or nm.lower() in have:
                continue
            want.append(nm)
            have.add(nm.lower())
        if want != aliases:
            client.tag_update_aliases(dest["id"], want)

        LogInfo(f"{dest_name} ← 合并 {len(src_tags)} 个源: {'、'.join(t['name'] for t in src_tags)}")

    LogInfo(f"完成: 合并 {stat['groups']} 组 / {stat['tags']} 个 tag，"
            f"新建目标 {stat['created']} 个，跳过源 {stat['skipped_src']} 个，"
            f"无有效源 {stat['empty_groups']} 组")
    return stat


def main():
    raw = sys.stdin.read()
    try:
        fragment = json.loads(raw)
    except ValueError:
        fatal(f"无法解析插件输入: {raw[:200]}")

    server = fragment.get("server_connection")
    if not server:
        fatal("输入缺少 server_connection")

    LogInfo("Tag Merge starting")
    mapping = load_mapping()
    if not mapping:
        fatal("映射库为空或无有效条目")

    client = StashClient(server)
    merge_tags(client, mapping)

    print(json.dumps({"output": "OK", "error": None}))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f'\x01e\x02[tagMerge] FATAL: {repr(e)}\n', file=sys.stderr, flush=True)
        sys.exit(1)
