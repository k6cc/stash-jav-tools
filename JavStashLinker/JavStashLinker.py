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

        log_info(f"=== Scan Complete ===")
        log_info(f"Auto-matched (high): {auto_count}")
        log_info(f"Needs review (medium): {review_count}")
        log_info(f"Unmatched: {unmatched_count}")

        with open(results_path, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)
        log_info(f"Results saved to: {results_path}")

        print(json.dumps({
            "output": f"Scan complete. Auto: {auto_count}, Review: {review_count}, Unmatched: {unmatched_count}",
        }))

    elif mode == "apply_auto":
        if not os.path.exists(results_path):
            log_error("No results file. Run batch_scan first.")
            print(json.dumps({"output": "Error: No results file", "error": "No results file"}))
            return

        with open(results_path, "r", encoding="utf-8") as f:
            all_results = json.load(f)

        applied = 0
        errors = 0

        for result in all_results:
            for match in result["matches"]:
                if match["confidence"] != "high":
                    continue
                try:
                    apply_match(stash, match["localPerformer"]["id"], match["javstashPerformer"])
                    applied += 1
                    log_info(f"Applied: {match['localPerformer']['name']} <- {match['javstashPerformer']['name']}")
                except Exception as e:
                    errors += 1
                    log_error(f"Error applying match: {e}")
                time.sleep(0.1)

        log_info(f"=== Apply Complete ===")
        log_info(f"Applied: {applied}, Errors: {errors}")
        print(json.dumps({
            "output": f"Apply complete. Applied: {applied}, Errors: {errors}",
        }))

    else:
        log_error(f"Unknown mode: {mode}")
        print(json.dumps({"output": f"Unknown mode: {mode}", "error": "Unknown mode"}))


if __name__ == "__main__":
    main()
