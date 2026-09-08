#!/usr/bin/env python3
"""JavStashLinker - Batch task for Stash."""

import sys
import json
import time
import os
import re
import unicodedata

import requests

STASHDB_ENDPOINT = "https://stashdb.org/graphql"
TPDB_ENDPOINT = "https://theporndb.net/graphql"
JAVSTASH_ENDPOINT = "https://javstash.org/graphql"

# ==================== Logging (Stash protocol) ====================

def _log(level, msg):
    print(f"\x01{level}\x02{msg}", file=sys.stderr, flush=True)

def log_trace(msg): _log("t", msg)
def log_debug(msg): _log("d", msg)
def log_info(msg): _log("i", msg)
def log_warn(msg): _log("w", msg)
def log_error(msg): _log("e", msg)
def log_progress(p):
    p = max(0.0, min(1.0, float(p)))
    _log("p", f"{p:.3f}")


# ==================== GraphQL Client ====================

class GraphQLClient:
    def __init__(self, url, api_key=None):
        self.url = url
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["ApiKey"] = api_key

    def query(self, query_str, variables=None, retries=3):
        payload = {"query": query_str}
        if variables:
            payload["variables"] = variables

        for attempt in range(retries):
            try:
                resp = requests.post(
                    self.url,
                    json=payload,
                    headers=self.headers,
                    timeout=60,
                )
                if resp.status_code == 401:
                    _log("e", "Authentication failed (401)")
                    raise Exception("Authentication failed (401)")
                if resp.status_code != 200:
                    _log("e", f"HTTP {resp.status_code}: {resp.text[:200]}")
                    raise Exception(f"HTTP {resp.status_code}")
                data = resp.json()
                if "errors" in data:
                    for err in data["errors"]:
                        _log("e", f"GraphQL error: {err.get('message', err)}")
                    raise Exception(f"GraphQL errors: {data['errors']}")
                return data.get("data", {})
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt < retries - 1:
                    wait = 2 ** attempt
                    _log("w", f"Retry {attempt + 1}/{retries} after {wait}s: {e}")
                    time.sleep(wait)
                else:
                    raise
        return {}


# ==================== Stash Interface ====================

class StashInterface:
    def __init__(self, fragment):
        server = fragment.get("server_connection", {})
        self.scheme = server.get("Scheme", server.get("scheme", "http"))
        self.host = server.get("Host", server.get("host", "localhost"))
        self.port = server.get("Port", server.get("port", 9999))
        self.api_key = server.get("ApiKey", server.get("api_key", ""))
        self.url = f"{self.scheme}://{self.host}:{self.port}/graphql"
        self.client = GraphQLClient(self.url, self.api_key if self.api_key else None)

    def get_stash_box_config(self):
        query = """
        query {
          configuration {
            general {
              stashBoxes { name endpoint api_key }
            }
          }
        }
        """
        data = self.client.query(query)
        boxes = data.get("configuration", {}).get("general", {}).get("stashBoxes", [])
        js_box = None
        stashdb_box = None
        for b in boxes:
            if "javstash.org" in (b.get("endpoint") or ""):
                js_box = b
            if "stashdb.org" in (b.get("endpoint") or ""):
                stashdb_box = b
        return {
            "javstash_endpoint": js_box["endpoint"] if js_box else JAVSTASH_ENDPOINT,
            "javstash_api_key": js_box["api_key"] if js_box else "",
            "stashdb_endpoint": stashdb_box["endpoint"] if stashdb_box else STASHDB_ENDPOINT,
        }

    def get_scenes_with_javstash_id(self):
        PAGE_SIZE = 1000
        page = 1
        result = []
        while True:
            query = """
            query($filter: FindFilterType!) {
              findScenes(filter: $filter) {
                count
                scenes {
                  id
                  title
                  performers {
                    id
                    name
                    alias_list
                    stash_ids { endpoint stash_id }
                  }
                  stash_ids { endpoint stash_id }
                }
              }
            }
            """
            data = self.client.query(query, {"filter": {"per_page": PAGE_SIZE, "page": page, "sort": "path"}})
            find_scenes = data["findScenes"]
            total = find_scenes["count"]
            for s in find_scenes["scenes"]:
                has_js = any(sid["endpoint"] == JAVSTASH_ENDPOINT for sid in s.get("stash_ids", []))
                if not has_js:
                    continue
                performers = s.get("performers", [])
                if not performers:
                    continue
                all_have_js = all(
                    any(sid["endpoint"] == JAVSTASH_ENDPOINT for sid in p.get("stash_ids", []))
                    for p in performers
                )
                if not all_have_js:
                    result.append(s)
            if page * PAGE_SIZE >= total:
                break
            page += 1
        return result

    def get_performer(self, performer_id):
        query = """
        query($id: ID!) {
          findPerformer(id: $id) {
            id
            name
            alias_list
            urls
            stash_ids { endpoint stash_id }
            gender
            birthdate
            death_date
            country
            ethnicity
            hair_color
            eye_color
            height_cm
            measurements
            career_length
            tattoos
            piercings
          }
        }
        """
        data = self.client.query(query, {"id": performer_id})
        return data.get("findPerformer")

    def get_all_performers(self):
        PAGE_SIZE = 1000
        page = 1
        result = []
        while True:
            query = """
            query($filter: FindFilterType!) {
              findPerformers(filter: $filter) {
                count
                performers {
                  id
                  name
                  disambiguation
                  alias_list
                  birthdate
                  urls
                  height_cm
                  stash_ids { endpoint stash_id }
                }
              }
            }
            """
            data = self.client.query(query, {"filter": {"per_page": PAGE_SIZE, "page": page, "sort": "name"}})
            fp = data["findPerformers"]
            result.extend(fp.get("performers", []))
            if page * PAGE_SIZE >= fp["count"]:
                break
            page += 1
        return result

    def update_performer(self, performer_id, stash_ids, alias_list, urls=None, details=None):
        mutation = """
        mutation($input: PerformerUpdateInput!) {
          performerUpdate(input: $input) { id }
        }
        """
        inp = {
            "id": performer_id,
            "stash_ids": stash_ids,
            "alias_list": alias_list,
        }
        if urls is not None:
            inp["urls"] = urls
        if details:
            inp.update(details)
        self.client.query(mutation, {
            "input": inp
        })


# ==================== Matching Engine ====================

def normalize_name(name):
    if not name:
        return ""
    s = unicodedata.normalize("NFC", name).lower().strip()
    s = s.replace(" ", "")
    s = re.sub(r'[（(].*?[)）]', '', s)
    return s


def parse_alias_list(val):
    if not val:
        return []
    if isinstance(val, list):
        return [str(a).strip() for a in val if str(a).strip()]
    return [a.strip() for a in re.split(r'[\n,]', str(val)) if a.strip()]


def build_alias_list(arr):
    return "\n".join(arr or [])


# ==================== Name Similarity ====================

def levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for k in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[k - 1] else 1
            cur[k] = min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + cost)
        prev = cur
    return prev[len(b)]


# Loose normalization: NFC lowercase, drop parentheticals and punctuation; spaces
# are KEPT so latin word order can be handled by token sorting.
def normalize_name_loose(name):
    if not name:
        return ""
    s = unicodedata.normalize("NFC", name).lower().strip()
    s = re.sub(r'[（(].*?[)）]', '', s)
    s = re.sub(r"[・·.,'’`\-–—_]", ' ', s)
    return re.sub(r"\s+", " ", s).strip()


def name_similarity(a, b):
    la = normalize_name_loose(a)
    lb = normalize_name_loose(b)
    if not la or not lb:
        return 0.0
    sa = la.replace(" ", "")
    sb = lb.replace(" ", "")
    if not sa or not sb:
        return 0.0
    if sa == sb:
        return 1.0
    direct = 1.0 - levenshtein(sa, sb) / max(len(sa), len(sb))
    ta = "".join(sorted(la.split(" ")))
    tb = "".join(sorted(lb.split(" ")))
    if ta == tb:
        return 1.0
    sorted_ratio = 1.0 - levenshtein(ta, tb) / max(len(ta), len(tb))
    return max(direct, sorted_ratio)


def performer_name_similarity(local_perf, js_perf):
    locals_ = [local_perf.get("name")] + parse_alias_list(local_perf.get("alias_list", ""))
    jss = [js_perf.get("name")] + list(js_perf.get("aliases", []) or [])
    best = 0.0
    for a in locals_:
        if not a:
            continue
        for b in jss:
            if not b:
                continue
            s = name_similarity(a, b)
            if s > best:
                best = s
    return best


# ==================== Search Engine (Engine B) ====================

# Build search terms from a local performer: main name + aliases, dedup by
# normalized form, main first, capped at 15 terms (mirrors the JS plugin).
def build_search_terms(local_perf):
    seen = set()
    terms = []

    def add(raw, is_main):
        norm = normalize_name(raw)
        if not norm or norm in seen:
            return
        seen.add(norm)
        terms.append({"raw": str(raw).strip(), "norm": norm, "isMain": bool(is_main)})

    add(local_perf["name"], True)
    for a in parse_alias_list(local_perf.get("alias_list", "")):
        add(a, False)
    return terms[:15]


# Evaluate a JAVStash candidate against a local performer (evidence mode —
# the Python batch task always runs alias search ON / fuzzy OFF, the lowest
# risk profile; it is not controlled by the UI checkboxes).
#   stashdb UUID cross-ref equal              -> high
#   URL intersection >= 2                     -> high
#   >=3 names exact-matched                   -> high
#   exactly 2 names, both matched, one long   -> high
#   name match + full birthdate equal         -> high
#   sim >= 0.9 + full birthdate equal         -> high
#   name match + birth year equal             -> medium
#   sim >= 0.9 (exact-ish name, no evidence)  -> medium (review)
#   sim 0.7-0.9 (latin variant/word order)    -> medium (review)
#   2 of >=3 names matched                    -> medium
#   deleted performer capped at medium
def evaluate_candidate(local_perf, js_perf, terms):
    js_names = {normalize_name(js_perf.get("name", ""))}
    for a in js_perf.get("aliases", []) or []:
        js_names.add(normalize_name(a))
    js_names.discard("")

    votes = [t for t in terms if t["norm"] in js_names]
    has_long_vote = any(len(t["norm"]) >= 3 for t in votes)

    local_stashdb_id = None
    for sid in local_perf.get("stash_ids", []) or []:
        if "stashdb.org" in (sid.get("endpoint") or ""):
            local_stashdb_id = str(sid.get("stash_id") or "").lower()
    js_stashdb_ids = []
    for u in js_perf.get("urls", []) or []:
        url_str = u if isinstance(u, str) else u.get("url", "")
        m = re.search(r"stashdb\.org/performers/([0-9a-fA-F-]{36})", url_str or "")
        if m:
            js_stashdb_ids.append(m.group(1).lower())
    stashdb_match = bool(local_stashdb_id and local_stashdb_id in js_stashdb_ids)

    local_urls = local_perf.get("urls", []) or []
    js_urls = []
    for u in js_perf.get("urls", []) or []:
        url_str = u if isinstance(u, str) else u.get("url", "")
        if url_str:
            js_urls.append(url_str)
    url_intersect = sum(1 for u in js_urls if u in local_urls)

    lb = local_perf.get("birthdate") or ""
    jb = js_perf.get("birth_date") or ""
    bday_full = bool(lb and jb and lb == jb)
    bday_year = bool(lb and jb and lb[:4] == jb[:4])

    sim = performer_name_similarity(local_perf, js_perf)

    v = len(votes)
    total = len(terms)

    confidence = None
    if stashdb_match:
        confidence = "high"
    elif url_intersect >= 2:
        confidence = "high"
    elif v >= 3:
        confidence = "high"
    elif total == 2 and v == 2 and has_long_vote:
        confidence = "high"
    elif v >= 1 and bday_full:
        confidence = "high"
    elif sim >= 0.9 and bday_full:
        confidence = "high"
    elif v >= 1 and bday_year:
        confidence = "medium"
    elif sim >= 0.9:
        confidence = "medium"
    elif sim >= 0.7:
        confidence = "medium"
    elif v == 2:
        confidence = "medium"
    if js_perf.get("deleted") and confidence == "high":
        confidence = "medium"

    return {
        "confidence": confidence,
        "voteCount": v,
        "totalNames": total,
        "stashdbMatch": stashdb_match,
        "urlIntersect": url_intersect,
        "bdayFull": bday_full,
        "bdayYear": bday_year,
        "sim": round(sim, 2),
    }


def evidence_better(a, b):
    rank = {"high": 0, "medium": 1}
    ra = rank.get(a["confidence"], 2)
    rb = rank.get(b["confidence"], 2)
    if ra != rb:
        return ra < rb
    if a["stashdbMatch"] != b["stashdbMatch"]:
        return a["stashdbMatch"]
    if a["voteCount"] != b["voteCount"]:
        return a["voteCount"] > b["voteCount"]
    if a["urlIntersect"] != b["urlIntersect"]:
        return a["urlIntersect"] > b["urlIntersect"]
    return a.get("sim", 0) > b.get("sim", 0)


def eval_best_candidate(local_perf, cand_map, terms):
    best = None
    for jp in cand_map.values():
        ev = evaluate_candidate(local_perf, jp, terms)
        if ev["confidence"] is None:
            continue
        if best is None or evidence_better(ev, best[1]):
            best = (jp, ev)
    return best


def match_scene(local_scene, javstash_scene):
    local_performers = local_scene.get("performers", [])
    js_performers = [
        ap["performer"] for ap in javstash_scene.get("performers", [])
        if ap.get("performer")
    ]

    matches = []
    matched_local = set()
    matched_js = set()

    # Skip local performers that already have JAVStash stash_id
    # and mark corresponding JAVStash performers as matched too
    js_ids = {p["id"] for p in js_performers}
    for lp in local_performers:
        for sid in lp.get("stash_ids", []):
            if sid["endpoint"] == JAVSTASH_ENDPOINT:
                matched_local.add(lp["id"])
                if sid["stash_id"] in js_ids:
                    matched_js.add(sid["stash_id"])

    # 1. Single performer auto-associate
    unmatched_js = [p for p in js_performers if p["id"] not in matched_js]
    unmatched_local = [p for p in local_performers if p["id"] not in matched_local]

    if len(unmatched_js) == 1 and len(unmatched_local) == 1:
        matches.append({
            "javstashPerformer": unmatched_js[0],
            "localPerformer": unmatched_local[0],
            "confidence": "high",
            "method": "single_performer",
        })
        matched_local.add(unmatched_local[0]["id"])
        matched_js.add(unmatched_js[0]["id"])

    # 2. Name/alias cross match
    for js_perf in js_performers:
        if js_perf["id"] in matched_js:
            continue
        js_names = {normalize_name(js_perf["name"])}
        for a in js_perf.get("aliases", []):
            js_names.add(normalize_name(a))
        js_names.discard("")

        for local_perf in local_performers:
            if local_perf["id"] in matched_local:
                continue
            local_names = {normalize_name(local_perf["name"])}
            for a in parse_alias_list(local_perf.get("alias_list", "")):
                local_names.add(normalize_name(a))
            local_names.discard("")

            if js_names & local_names:
                matches.append({
                    "javstashPerformer": js_perf,
                    "localPerformer": local_perf,
                    "confidence": "medium",
                    "method": "name_alias",
                })
                matched_local.add(local_perf["id"])
                matched_js.add(js_perf["id"])
                break

    # 4. Unmatched
    final_unmatched_js = [p for p in js_performers if p["id"] not in matched_js]
    final_unmatched_local = [p for p in local_performers if p["id"] not in matched_local]

    return {
        "sceneId": local_scene["id"],
        "sceneTitle": local_scene.get("title", ""),
        "matches": matches,
        "unmatchedJavstash": final_unmatched_js,
        "unmatchedLocal": final_unmatched_local,
    }


_applied_performers = set()

# stash-box enum value (e.g. MIDDLE_EASTERN) -> Stash display string (e.g. Middle Eastern)
def enum_to_display(v):
    def cap(m):
        return (" " if m.group(1) else "") + m.group(2).upper()
    return re.sub(r"(^|_)([a-z])", cap, str(v).lower())

# stash-box body modifications [{location, description}] -> Stash free-text string
def mods_to_string(mods):
    parts = []
    for t in mods or []:
        loc = t.get("location", "")
        desc = t.get("description") or ""
        parts.append(f"{loc}: {desc}" if desc else loc)
    return "; ".join(parts)

# Build performer detail fields to fill: only fields the local performer lacks.
def build_perf_details(local_perf, js_perf):
    def empty(v):
        return v is None or v == ""
    d = {}
    if empty(local_perf.get("gender")) and not empty(js_perf.get("gender")):
        d["gender"] = js_perf["gender"]
    if empty(local_perf.get("birthdate")) and not empty(js_perf.get("birth_date")):
        d["birthdate"] = js_perf["birth_date"]
    if empty(local_perf.get("death_date")) and not empty(js_perf.get("death_date")):
        d["death_date"] = js_perf["death_date"]
    if empty(local_perf.get("country")) and not empty(js_perf.get("country")):
        d["country"] = js_perf["country"]
    if empty(local_perf.get("ethnicity")) and not empty(js_perf.get("ethnicity")):
        d["ethnicity"] = enum_to_display(js_perf["ethnicity"])
    if empty(local_perf.get("hair_color")) and not empty(js_perf.get("hair_color")):
        d["hair_color"] = enum_to_display(js_perf["hair_color"])
    if empty(local_perf.get("eye_color")) and not empty(js_perf.get("eye_color")):
        d["eye_color"] = enum_to_display(js_perf["eye_color"])
    if empty(local_perf.get("height_cm")) and not empty(js_perf.get("height")):
        d["height_cm"] = js_perf["height"]
    if empty(local_perf.get("measurements")) and not (empty(js_perf.get("band_size")) and empty(js_perf.get("cup_size")) and empty(js_perf.get("waist_size")) and empty(js_perf.get("hip_size"))):
        parts = []
        bust = f"{js_perf.get('band_size') or ''}{js_perf.get('cup_size') or ''}"
        if bust:
            parts.append(bust)
        if not empty(js_perf.get("waist_size")):
            parts.append(str(js_perf["waist_size"]))
        if not empty(js_perf.get("hip_size")):
            parts.append(str(js_perf["hip_size"]))
        if parts:
            d["measurements"] = "-".join(parts)
    if empty(local_perf.get("career_length")) and not (empty(js_perf.get("career_start_year")) and empty(js_perf.get("career_end_year"))):
        if not empty(js_perf.get("career_start_year")) and not empty(js_perf.get("career_end_year")):
            d["career_length"] = f"{js_perf['career_start_year']} - {js_perf['career_end_year']}"
        else:
            d["career_length"] = str(js_perf.get("career_start_year") or js_perf.get("career_end_year"))
    if empty(local_perf.get("tattoos")) and js_perf.get("tattoos"):
        d["tattoos"] = mods_to_string(js_perf["tattoos"])
    if empty(local_perf.get("piercings")) and js_perf.get("piercings"):
        d["piercings"] = mods_to_string(js_perf["piercings"])
    return d

# Stash-box cross links (stashdb.org / theporndb.net performer URLs) never merge into
# local urls. Only URLs whose host is exactly one of those sites (www. allowed) count —
# UUID-form links convert to stash_ids for the matching endpoint, ThePornDB slug links
# (unresolvable by their API) are dropped. Everything else, including URLs merely
# embedding such a link in a query param or on a lookalike domain, is left alone.
_CROSS_SITE_RE = re.compile(r"^https?://([^/?#]+)/performers/([^/?#]+)", re.I)
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_CROSS_SITE_HOSTS = {
    "stashdb.org": "stashdb.org",
    "www.stashdb.org": "stashdb.org",
    "theporndb.net": "theporndb.net",
    "www.theporndb.net": "theporndb.net",
}

def cross_site_performer_ref(url_str):
    m = _CROSS_SITE_RE.match(url_str or "")
    if not m:
        return None
    site = _CROSS_SITE_HOSTS.get(m.group(1).lower())
    if not site:
        return None
    return {
        "endpoint": f"https://{site}/graphql",
        "stash_id": m.group(2) if _UUID_RE.match(m.group(2)) else None,
    }


def apply_match(stash, local_perf_id, js_perf):
    if local_perf_id in _applied_performers:
        return
    _applied_performers.add(local_perf_id)

    perf = stash.get_performer(local_perf_id)
    if not perf:
        raise Exception(f"Performer not found: {local_perf_id}")

    existing_stash_ids = perf.get("stash_ids", [])
    new_stash_ids = list(existing_stash_ids)
    if not any(sid["endpoint"] == JAVSTASH_ENDPOINT for sid in existing_stash_ids):
        new_stash_ids.append({
            "endpoint": JAVSTASH_ENDPOINT,
            "stash_id": js_perf["id"],
        })

    existing_aliases = parse_alias_list(perf.get("alias_list", ""))
    if js_perf.get("name") and js_perf["name"] not in existing_aliases:
        existing_aliases.append(js_perf["name"])
    for alias in js_perf.get("aliases", []):
        if alias and alias not in existing_aliases:
            existing_aliases.append(alias)

    # Merge URLs (dedup); stash-box cross links (stashdb/theporndb) become stash_ids
    existing_urls = perf.get("urls", []) or []
    new_urls = list(existing_urls)
    have_endpoints = {sid["endpoint"] for sid in new_stash_ids}
    cross_added = []
    for url_obj in js_perf.get("urls", []) or []:
        url_str = url_obj if isinstance(url_obj, str) else url_obj.get("url", "")
        if not url_str:
            continue
        ref = cross_site_performer_ref(url_str)
        if ref:
            if ref["stash_id"] and ref["endpoint"] not in have_endpoints:
                new_stash_ids.append({"endpoint": ref["endpoint"], "stash_id": ref["stash_id"]})
                have_endpoints.add(ref["endpoint"])
                cross_added.append(ref["endpoint"])
            continue
        if url_str not in new_urls:
            new_urls.append(url_str)
    urls_to_send = new_urls if len(new_urls) != len(existing_urls) else None

    details = build_perf_details(perf, js_perf)

    stash.update_performer(local_perf_id, new_stash_ids, existing_aliases, urls_to_send, details)

    if details:
        log_info(f"  Filled performer info ({', '.join(details.keys())})")
    for ep in cross_added:
        log_info(f"  Filled stash_id from link ({ep})")


# ==================== Main ====================

def main():
    input_str = sys.stdin.read()
    input_json = json.loads(input_str)
    mode = input_json.get("mode", "batch_scan")

    server = input_json.get("server_connection", {})
    stash = StashInterface({"server_connection": server})

    box_config = stash.get_stash_box_config()
    javstash_endpoint = box_config["javstash_endpoint"]
    javstash_api_key = box_config["javstash_api_key"]
    if not javstash_api_key:
        log_error("JAVStash not configured. Add it in Settings → Metadata Providers.")
        print(json.dumps({"output": "Error: JAVStash not configured", "error": "Not configured"}))
        return
    javstash = GraphQLClient(javstash_endpoint, javstash_api_key)

    output_dir = os.path.dirname(os.path.abspath(__file__))
    results_path = os.path.join(output_dir, "match_results.json")

    if mode == "batch_scan":
        log_info("Fetching scenes with JAVStash IDs...")
        scenes = stash.get_scenes_with_javstash_id()
        log_info(f"Found {len(scenes)} scenes with JAVStash IDs")

        all_results = []
        auto_count = 0
        review_count = 0
        unmatched_count = 0

        for i, scene in enumerate(scenes):
            javstash_id = None
            for sid in scene.get("stash_ids", []):
                if sid["endpoint"] == JAVSTASH_ENDPOINT:
                    javstash_id = sid["stash_id"]
                    break
            if not javstash_id:
                continue

            title = scene.get("title", scene["id"])
            log_info(f"[{i + 1}/{len(scenes)}] {title}")
            log_progress((i + 1) / len(scenes))

            try:
                query = """
                query($id: ID!) {
                  findScene(id: $id) {
                    id
                    title
                    performers {
                      as
                      performer {
                        id
                        name
                        disambiguation
                        aliases
                        urls { url }
                        gender
                        birth_date
                        death_date
                        career_start_year
                        career_end_year
                        height
                        cup_size
                        band_size
                        waist_size
                        hip_size
                        hair_color
                        eye_color
                        ethnicity
                        country
                        tattoos { location description }
                        piercings { location description }
                      }
                    }
                  }
                }
                """
                js_data = javstash.query(query, {"id": javstash_id})
                js_scene = js_data.get("findScene")
                if not js_scene:
                    log_warn(f"  Not found on JAVStash")
                    continue

                result = match_scene(scene, js_scene)
                all_results.append(result)

                high = [m for m in result["matches"] if m["confidence"] == "high"]
                med = [m for m in result["matches"] if m["confidence"] == "medium"]
                auto_count += len(high)
                review_count += len(med)
                unmatched_count += len(result["unmatchedJavstash"])

                log_info(f"  High:{len(high)} Medium:{len(med)} Unmatched:{len(result['unmatchedJavstash'])}")
            except Exception as e:
                log_error(f"  Error: {e}")

            time.sleep(0.3)

        log_info(f"=== Scene engine complete ===")
        log_info(f"Auto-matched (high): {auto_count}")
        log_info(f"Needs review (medium): {review_count}")
        log_info(f"Unmatched: {unmatched_count}")

        # Engine B: search-match performers the scene engine left unmatched.
        # Fixed profile per spec: alias search ON, fuzzy OFF (not UI-controlled).
        search_matches = []
        try:
            log_info("Search engine: fetching performers...")
            performers = stash.get_all_performers()
            scene_matched_local = set()
            for r in all_results:
                for m in r["matches"]:
                    scene_matched_local.add(m["localPerformer"]["id"])
            targets = [
                p for p in performers
                if not any(sid["endpoint"] == JAVSTASH_ENDPOINT for sid in p.get("stash_ids", []))
                and p["id"] not in scene_matched_local
            ]
            log_info(f"Search engine: {len(targets)} unlinked performers")

            search_query = """
            query($term: String!) {
              searchPerformer(term: $term) {
                id
                name
                disambiguation
                aliases
                deleted
                urls { url }
                gender
                birth_date
                death_date
                career_start_year
                career_end_year
                height
                cup_size
                band_size
                waist_size
                hip_size
                hair_color
                eye_color
                ethnicity
                country
                tattoos { location description }
                piercings { location description }
              }
            }
            """

            search_high = 0
            search_med = 0
            for i, p in enumerate(targets):
                log_info(f"[{i + 1}/{len(targets)}] {p['name']}")
                log_progress((i + 1) / len(targets))

                terms = build_search_terms(p)
                cand_map = {}
                best = None
                try:
                    for t in terms:
                        data = javstash.query(search_query, {"term": t["raw"]})
                        for jp in data.get("searchPerformer", []) or []:
                            cand_map[jp["id"]] = jp
                        best = eval_best_candidate(p, cand_map, terms)
                        if best and best[1]["confidence"] == "high":
                            break  # early stop
                        time.sleep(0.25)
                except Exception as e:
                    log_error(f"  Search error: {e}")

                if best and best[1]["confidence"]:
                    js_perf, ev = best
                    search_matches.append({
                        "localPerformerId": p["id"],
                        "localPerformerName": p["name"],
                        "jsPerf": js_perf,
                        "confidence": ev["confidence"],
                    })
                    if ev["confidence"] == "high":
                        search_high += 1
                    else:
                        search_med += 1
                    log_info(f"  -> {js_perf['name']} ({ev['confidence']}, sim {ev['sim']})")

                time.sleep(0.3)

            log_info(f"=== Search engine complete ===")
            log_info(f"Search high: {search_high}, review: {search_med}, no hit: {len(targets) - search_high - search_med}")
        except Exception as e:
            log_error(f"Search engine error: {e}")

        with open(results_path, "w", encoding="utf-8") as f:
            json.dump({"scenes": all_results, "search_matches": search_matches}, f, ensure_ascii=False, indent=2)
        log_info(f"Results saved to: {results_path}")

        print(json.dumps({
            "output": f"Scan complete. Auto: {auto_count + search_high}, Review: {review_count + search_med}, Unmatched: {unmatched_count}",
        }))

    elif mode == "apply_auto":
        if not os.path.exists(results_path):
            log_error("No results file. Run batch_scan first.")
            print(json.dumps({"output": "Error: No results file", "error": "No results file"}))
            return

        with open(results_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # v1.5.0 format: {"scenes": [...], "search_matches": [...]};
        # older files are plain scene lists (no engine B data).
        if isinstance(data, list):
            scene_results = data
            search_matches = []
        else:
            scene_results = data.get("scenes", [])
            search_matches = data.get("search_matches", [])

        # Candidates: scene highs + search highs
        candidates = []
        for result in scene_results:
            for match in result["matches"]:
                if match["confidence"] == "high":
                    candidates.append((match["localPerformer"]["id"], match["javstashPerformer"]))
        for sm in search_matches:
            if sm["confidence"] == "high":
                candidates.append((sm["localPerformerId"], sm["jsPerf"]))

        # Conflict guard: a JAVStash performer high-matched to multiple distinct
        # local performers is excluded from auto-apply entirely.
        by_js = {}
        for local_id, js_perf in candidates:
            by_js.setdefault(js_perf["id"], set()).add(local_id)
        conflict_js = {js_id for js_id, locals_ in by_js.items() if len(locals_) >= 2}
        if conflict_js:
            log_warn(f"{len(conflict_js)} conflicting JAVStash performers skipped (matched to multiple locals)")

        applied = 0
        errors = 0
        skipped_conflict = 0

        for local_id, js_perf in candidates:
            if js_perf["id"] in conflict_js:
                skipped_conflict += 1
                log_warn(f"Skipped conflicting match: {js_perf['name']}")
                continue
            try:
                apply_match(stash, local_id, js_perf)
                applied += 1
                log_info(f"Applied: {local_id} <- {js_perf['name']}")
            except Exception as e:
                errors += 1
                log_error(f"Error applying match: {e}")
            time.sleep(0.1)

        log_info(f"=== Apply Complete ===")
        log_info(f"Applied: {applied}, Errors: {errors}, Conflicts skipped: {skipped_conflict}")
        print(json.dumps({
            "output": f"Apply complete. Applied: {applied}, Errors: {errors}, Conflicts skipped: {skipped_conflict}",
        }))

    else:
        log_error(f"Unknown mode: {mode}")
        print(json.dumps({"output": f"Unknown mode: {mode}", "error": "Unknown mode"}))


if __name__ == "__main__":
    main()
