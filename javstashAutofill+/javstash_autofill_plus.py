#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Javstash Autofill+ v1.3.1
Stash plugin: Performer.Create.Post hook + Scene.Create.Post hook.
Unified performer resolution (scene fill, backfill task and manual creation share it):
  - stash-id first: reverse-lookup the local performer carrying (endpoint, stash_id);
    hit -> reuse (created name appended as alias when it differs), miss -> fill
    directly by stash-id (findPerformerByID, bypassing name matching).
  - no stash-id: 0.9 name match. A matched local candidate (name or alias) is reused
    (merged, created name kept as an alias); a candidate whose identity is anchored
    to another stash-id is conservatively ignored (new one stays blank); otherwise
    the created name stays primary and the scraper name becomes an alias (unless
    owPerformerName is on).
The hook spawns a detached worker (performerFillDelay, default 2s) and returns
immediately, so a manual creation never blocks the UI on the search.
Existing values, existing images and existing aliases are protected (only empty
fields are filled / missing entries appended) unless a per-field overwrite toggle
is enabled. Measurements are normalised from javstash form (91H-56-88) to
(91(H)-56-88). Standard library only.
"""
import sys, json, re, unicodedata, urllib.request, urllib.error, difflib, os, datetime, base64, subprocess, ssl, time

JAV = "https://javstash.org/graphql"
THRESHOLD = 0.9
LOG = os.path.join(os.path.dirname(__file__), "javstash_autofill_plus.log")

def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8", errors="backslashreplace") as f:
            f.write(f"{datetime.datetime.now().isoformat()} {msg}\n")
    except Exception:
        pass
    print(f"[Javstash Autofill+] {msg}")

def _proto(level, msg):
    print(f"\x01{level}\x02{msg}", file=sys.stderr, flush=True)
def log_info(msg):
    _proto("i", msg)
def log_progress(p):
    _proto("p", f"{max(0.0,min(1.0,float(p))):.3f}")

# ---------- Stash GraphQL ----------
def make_gql(conn):
    scheme = conn.get("Scheme", "http")
    host = conn.get("Host") or "localhost"
    if host in ("0.0.0.0", ""): host = "localhost"
    port = conn.get("Port", 9999)
    cookie = conn.get("SessionCookie") or {}
    ck = cookie.get("Value")
    url = f"{scheme}://{host}:{port}/graphql"
    def gql(query, variables=None, timeout=30):
        data = json.dumps({"query": query, "variables": variables or {}}).encode()
        headers = {"Content-Type": "application/json"}
        if ck: headers["Cookie"] = f"{cookie.get('Name','session')}={ck}"
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read())
        if j.get("errors"): raise RuntimeError(j["errors"])
        return j["data"]
    return gql

# ---------- normalisation / matching ----------
def nfc(s):  return unicodedata.normalize("NFC", (s or "").strip())
def norm(s): return nfc(s).lower().replace(" ", "").replace("　", "")
def split_aliases(s):
    # aliases arrive as a list from the direct findPerformer fetch and as a
    # comma/sep string from the scraper; both are normalised to a list.
    if isinstance(s, list):
        return [a.strip() for a in s if a and str(a).strip()]
    if not s: return []
    return [a for a in re.split(r"[,，/、|]", s) if a.strip()]
def match_score(target_names, cand_names):
    tn = {norm(x) for x in target_names if x}
    cn = {norm(x) for x in cand_names if x}
    if tn & cn: return 1.0
    best = 0.0
    for a in tn:
        for b in cn:
            if a and b:
                r = difflib.SequenceMatcher(None, a, b).ratio()
                if r > best: best = r
    return best

# ---------- conversion ----------
def conv_meas(m):
    m = nfc(m)
    mm = re.match(r"^\s*(\d+)\s*([A-Za-z]{1,4})\s*-\s*(\d+)\s*-\s*(\d+)\s*$", m)
    return f"{mm.group(1)}({mm.group(2).upper()})-{mm.group(3)}-{mm.group(4)}" if mm else m
def to_int(s):
    try: return int(re.sub(r"[^\d]", "", str(s)))
    except Exception: return None

# ---------- scraper ----------
JAV_FIELDS = ("name disambiguation gender birthdate death_date ethnicity country hair_color eye_color "
              "height weight measurements fake_tits career_start career_end tattoos piercings "
              "details urls aliases images remote_site_id")
def scrape_source(gql, name, source_input):
    q = ("query($s:ScraperSourceInput!,$i:ScrapeSinglePerformerInput!){"
         " scrapeSinglePerformer(source:$s,input:$i){ %s } }" % JAV_FIELDS)
    try:
        return gql(q, {"s": source_input, "i": {"query": name}}).get("scrapeSinglePerformer") or []
    except Exception as e:
        log(f"scrape error: {e}"); return []

def get_settings(gql):
    try:
        plugins = (gql("{ configuration { plugins } }").get("configuration", {}) or {}).get("plugins") or {}
        # Stash derives the plugin id from the yml filename (javstashAutofillPlus.yml),
        # so settings are saved under "javstashAutofillPlus" — the only key we read.
        return plugins.get("javstashAutofillPlus") or {}
    except Exception:
        return {}
def build_source(source_str):
    # A URL is treated as a stash-box endpoint; anything else as a scraper_id.
    s = (source_str or JAV).strip()
    return {"stash_box_endpoint": s} if s.startswith("http") else {"scraper_id": s}

# ---------- performer read / write ----------
PERF_FIELDS = ("id name alias_list gender birthdate death_date ethnicity country hair_color "
               "eye_color height_cm weight measurements fake_tits career_length tattoos "
               "piercings details urls image_path stash_ids{ endpoint stash_id }")
def get_performer(gql, pid):
    q = "query($id:ID!){ findPerformer(id:$id){ %s } }" % PERF_FIELDS
    return gql(q, {"id": pid}).get("findPerformer")
def _fetch_all_performers(gql):
    """Legacy fallback: older Stash (pre-names-filter) cannot search aliases, so pull
    all performers and compare client-side. Returns a list, or None on error."""
    out, page = [], 1
    while True:
        try:
            rows = gql("{ findPerformers(filter:{per_page:500,page:%d}){ performers{ id name alias_list } } }" % page) \
                .get("findPerformers", {}).get("performers", [])
        except Exception:
            return None
        if not rows: break
        out.extend(rows)
        if len(rows) < 500: break
        page += 1
    return out

def find_by_name(gql, name, exclude_id):
    """Find a local performer whose NAME or ALIAS equals name (norm-exact), so a
    candidate never creates a duplicate next to an existing alias (Stash allows a
    primary name to repeat as another performer's alias). Primary-name hits take
    priority; otherwise the first alias hit wins. exclude_id is skipped. Uses the
    names filter when available and falls back to a client-side scan on older
    Stash versions that only have the primary-name filter."""
    if not name: return None
    q = ("query($n:String!){ findPerformers(performer_filter:{names:{value:$n,modifier:EQUALS_NOCASE}},"
         " filter:{per_page:50}){ performers{ id name alias_list } } }")
    try:
        rows = gql(q, {"n": name}).get("findPerformers", {}).get("performers", [])
    except Exception:
        rows = _fetch_all_performers(gql)
    if not rows: return None
    n = norm(name)
    for p in rows:
        if str(p["id"]) == str(exclude_id): continue
        if norm(p.get("name") or "") == n:
            return str(p["id"])
    for p in rows:
        if str(p["id"]) == str(exclude_id): continue
        for a in (p.get("alias_list") or []):
            if norm(a) == n:
                return str(p["id"])
    return None
def performer_update(gql, pid, upd):
    upd = dict(upd); upd["id"] = pid
    q = "mutation($i:PerformerUpdateInput!){ performerUpdate(input:$i){ id } }"
    return gql(q, {"i": upd})
def performer_merge(gql, source_ids, dest_id, values):
    q = "mutation($i:PerformerMergeInput!){ performerMerge(input:$i){ id } }"
    inp = {"source": [str(s) for s in source_ids], "destination": str(dest_id)}
    if values: inp["values"] = values
    return gql(q, {"i": inp})

def has_image(image_path):
    # Stash appends "default=true" to image_path when no custom image is set.
    return bool(image_path) and "default=true" not in image_path

# ---------- build the update (empty-only by default; alias/urls append-merge) ----------
def build_update(perf, cand, primary_name, extra_aliases=None, set_name=False, ow=None):
    ow = ow or {}
    upd = {}
    def empty(f):
        v = perf.get(f)
        return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, list) and len(v) == 0)
    def writable(f):  # write when empty; also write a non-empty field if overwrite (ow) is enabled.
        return empty(f) or bool(ow.get(f))
    simple = {"gender":"gender","birthdate":"birthdate","death_date":"death_date","ethnicity":"ethnicity",
              "country":"country","hair_color":"hair_color","eye_color":"eye_color","fake_tits":"fake_tits",
              "tattoos":"tattoos","piercings":"piercings","details":"details"}
    for pf, cf in simple.items():
        if writable(pf) and cand.get(cf): upd[pf] = cand[cf]
    if writable("career_length") and (cand.get("career_start") or cand.get("career_end")):
        cs = (cand.get("career_start") or "").strip()
        ce = (cand.get("career_end") or "").strip()
        if cs or ce:
            upd["career_length"] = f"{cs}-{ce}" if cs and ce else (f"{cs}-" if cs else f"-{ce}")
    if writable("height_cm") and cand.get("height"):
        v = to_int(cand["height"])
        if v: upd["height_cm"] = v
    if writable("weight") and cand.get("weight"):
        v = to_int(cand["weight"])
        if v: upd["weight"] = v
    if writable("measurements") and cand.get("measurements"):
        upd["measurements"] = conv_meas(cand["measurements"])
    # Writing twitter/instagram/url into the legacy fields makes performerMerge fail
    # ("Merging legacy performer URLs is not supported"), so use the modern urls list.
    # Pool = legacy single-field urls + the scraper's modern urls list. Overwrite = replace;
    # otherwise keep existing and append the missing ones (de-duplicated).
    url_pool = [u.strip() for u in (cand.get("twitter"), cand.get("instagram"), cand.get("url")) if u and u.strip()]
    for u in (cand.get("urls") or []):
        if u and u.strip(): url_pool.append(u.strip())
    url_pool = list(dict.fromkeys(url_pool))
    existing_urls = list(perf.get("urls") or [])
    if ow.get("urls"):
        new_urls = list(dict.fromkeys(url_pool))
        if new_urls and new_urls != existing_urls: upd["urls"] = new_urls
    else:
        useen = {u.strip() for u in existing_urls if u}
        url_adds = [u for u in url_pool if u not in useen]
        if url_adds: upd["urls"] = existing_urls + url_adds
    if set_name:
        upd["name"] = primary_name
    # alias: existing + missing of (scraper name + scraper aliases + extra). Exclude the primary name.
    pool = list(split_aliases(cand.get("aliases")))
    if cand.get("name"): pool.append(cand["name"])
    pool += list(extra_aliases or [])
    base = [] if ow.get("alias_list") else list(perf.get("alias_list") or [])  # overwrite -> drop existing (replace)
    seen = {norm(x) for x in base} | {norm(primary_name)}
    additions = []
    for a in pool:
        a = (a or "").strip()
        if not a: continue
        na = norm(a)
        if na in seen: continue
        seen.add(na); additions.append(a)
    if additions or (ow.get("alias_list") and base != list(perf.get("alias_list") or [])):
        upd["alias_list"] = base + additions
    # NB: the image is NOT included here; a slow fetch would fail the whole update, so it is applied separately.
    return upd

# Per-field overwrite toggles (default all OFF = fill empty only). All "other"
# performer fields share one group toggle (owPerformerOther); urls/alias_list/image
# keep their own single toggles.
PERF_OTHER_FIELDS = ("gender birthdate death_date ethnicity country hair_color eye_color "
                     "fake_tits career_length tattoos piercings details height_cm weight measurements")
OW_MAP = {f: "owPerformerOther" for f in PERF_OTHER_FIELDS.split()}
OW_MAP.update({"urls": "owUrls", "alias_list": "owAliasList", "image": "owImage"})
def build_ow(settings):
    return {f: bool(settings.get(k)) for f, k in OW_MAP.items()}

# Scene overwrite toggles (default all OFF = fill empty only).
SCENE_OW_MAP = {"title":"owSceneTitle","details":"owSceneDetails","tags":"owSceneTags",
                "urls":"owSceneUrls","image":"owSceneImage","other":"owSceneOther"}
def build_scene_ow(settings):
    return {f: bool(settings.get(k)) for f, k in SCENE_OW_MAP.items()}

def apply_image_async(conn, target_id, target_perf, cand, overwrite=False):
    """When there is no image (or overwrite is on), download and set it in a detached
    background process, so the hook returns immediately and Stash never blocks on a
    slow remote image fetch."""
    if has_image(target_perf.get("image_path")) and not overwrite: return
    imgs = cand.get("images") or []
    if not imgs: return
    try:
        env = dict(os.environ, JAVSTASH_CONN=json.dumps(conn))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--set-image", str(target_id), imgs[0]],
                         env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except Exception as e:
        log(f"{target_id}: image spawn skipped ({e})")

def set_image_mode(target_id, image_url):
    """Subprocess entry point: download the image and set it as base64 via performerUpdate
    (so Stash does not perform the slow remote fetch itself)."""
    conn = json.loads(os.environ.get("JAVSTASH_CONN", "{}"))
    gql = make_gql(conn)
    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE  # some Python builds lack CA certs; the image is public
    for attempt in range(3):
        try:
            req = urllib.request.Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20, context=sslctx) as r:
                raw = r.read()
                ctype = r.headers.get("Content-Type", "image/jpeg")
            b64 = base64.b64encode(raw).decode()
            performer_update(gql, target_id, {"image": f"data:{ctype};base64,{b64}"})
            log(f"{target_id}: image set async ({len(raw)} bytes)")
            return
        except Exception as e:
            log(f"{target_id}: image async attempt {attempt+1} failed ({e})")
    log(f"{target_id}: image async gave up")

def union_stash_ids(dest, source):
    """Add source stash_ids for endpoints the dest does not already have. None if nothing added."""
    by_ep = {s["endpoint"]: {"endpoint": s["endpoint"], "stash_id": s["stash_id"]}
             for s in (dest.get("stash_ids") or [])}
    added = False
    for s in (source.get("stash_ids") or []):
        if s["endpoint"] not in by_ep:
            by_ep[s["endpoint"]] = {"endpoint": s["endpoint"], "stash_id": s["stash_id"]}; added = True
    return list(by_ep.values()) if added else None

def add_endpoint_stash_id(existing_sids, endpoint, stash_id):
    """Append (endpoint, stash_id) unless that endpoint is already present. None if no change."""
    existing = list(existing_sids or [])
    if any((s.get("endpoint") == endpoint) for s in existing):
        return None
    existing.append({"endpoint": endpoint, "stash_id": stash_id})
    return existing

# ---------- scene create: autofill empty fields + stash-box id by file hash ----------
SCENE_FULL_FIELDS = ("title code details director date urls image remote_site_id duration "
                     "studio{ stored_id name } performers{ stored_id name remote_site_id } tags{ stored_id name }")

def get_scene_full(gql, sid):
    q = ("query($id:ID!){ findScene(id:$id){ id title code details director date urls "
         "studio{ id name } performers{ id } tags{ id } groups{ group{ id } } paths{ screenshot } "
         "stash_ids{ endpoint stash_id } created_at files{ path } } }")
    return gql(q, {"id": str(sid)}).get("findScene")

_CODE_RE = re.compile(r"^((?:FC2[-_]?PPV[-_]?\d{5,7}|FC2[-_]?\d{5,7}|[A-Za-z]{2,6}[-_]?\d{2,5}|\d{6}[-_]\d{2,5}|[A-Za-z]\d{4}))")
def codes_match(a, b):
    """Code equality with javstash-style suffix tolerance ('012012-920' vs
    '012012-920-carib', '020519_001' vs '020519_001-1pon'). Only a dash/underscore
    followed by a non-pure-digit suffix is tolerated, so unrelated codes
    (WANZ-334 vs WANZ-330) and numeric extensions (SSIS-123 vs SSIS-1234) never
    match while site annotations (carib/1pon/4K) do."""
    a, b = (a or "").strip().upper(), (b or "").strip().upper()
    if not a or not b:
        return False
    if a == b:
        return True
    for long, short in ((a, b), (b, a)):
        if long.startswith(short):
            rest = long[len(short):]
            if rest.startswith(("-", "_")) and len(rest) > 1 and not rest[1:].isdigit():
                return True
    return False
def extract_code(scene):
    """Get studio code from scene.code, else from the title prefix, else from the
    first file's basename. The last source matters for a bare scene right after
    scan, where the NFO/metadata has not been applied yet and title/code are empty
    (Scene.Create.Post races with the NFO parser)."""
    c = (scene.get("code") or "").strip()
    if c: return c
    t = (scene.get("title") or "").strip()
    if t:
        m = _CODE_RE.match(t)
        if m: return m.group(1)
    for f in (scene.get("files") or []):
        p = (f.get("path") or "").strip()
        if not p: continue
        base = p.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        m = _CODE_RE.match(base)
        if m: return m.group(1)
    return None

def strip_bd_code(code):
    """Retry lookup code with a trailing 'BD' brand suffix stripped:
    CWPBD-98 -> CWP-98, LAFBD-21 -> LAF-21. Requires a >=2-letter prefix so a
    genuine code that itself contains BD (e.g. SBD-123) is never mangled; the
    result must still look like a code. None when nothing to strip."""
    c = (code or "").strip().upper()
    m = re.match(r"^([A-Z]{2,6})BD[-_](\d{2,5})$", c)
    if not m:
        return None
    out = "%s-%s" % (m.group(1), m.group(2))
    return out if out != c else None

def _gql_scrape(gql, q, source_url, input_, label):
    """scrapeSingleScene with one retry on network-class failures. javstash.org
    drops keep-alive connections transiently (Stash logs 'unexpected EOF'), so
    batch backfills skip a few scenes per run; a single retry after a short
    pause recovers most. Non-network errors and normal empty results are not
    retried (empty results would just burn the rate limit)."""
    def once():
        return gql(q, {"s": {"stash_box_endpoint": source_url}, "i": input_}).get("scrapeSingleScene") or []
    try:
        return once()
    except Exception as e:
        msg = str(e).lower()
        is_net = isinstance(e, (urllib.error.URLError, urllib.error.HTTPError, TimeoutError)) or any(
            k in msg for k in ("eof", "request failed", "connection", "timeout", "reset", "503", "502", "500"))
        if not is_net:
            raise
        log(f"scene {label}: scrape network error: {e}, retrying once")
        time.sleep(1.5)
        return once()

def scrape_scene_full(gql, sid, source_url, scene=None, use_fallback=True):
    q = ("query($s:ScraperSourceInput!,$i:ScrapeSingleSceneInput!){"
         " scrapeSingleScene(source:$s,input:$i){ %s } }" % SCENE_FULL_FIELDS)
    try:
        hits = _gql_scrape(gql, q, source_url, {"scene_id": str(sid)}, sid)
    except Exception as e:
        log(f"scene {sid}: scrape error: {e}")
        return []
    code = extract_code(scene or {})
    oshash_hits = hits   # remember raw oshash candidates for the last-resort fallback
    if hits:
        # oshash can return several candidates (javstash fingerprint entries are
        # not always clean). When a local code is known, only trust candidates
        # whose code matches it; otherwise a wrong fingerprint entry would
        # overwrite an NFO/named scene with a foreign title/code/stash_id.
        if code:
            exact = [h for h in hits if codes_match(h.get("code"), code)]
            if exact:
                if len(exact) < len(hits):
                    log(f"scene {sid}: oshash gave {len(hits)} candidates, picked code-match '{exact[0].get('code')}'")
                return exact
            log(f"scene {sid}: oshash candidates {[(h.get('code') or '') for h in hits]} don't match local code '{code}', discarding")
            hits = []
        else:
            return hits   # no local code to verify against; best effort, unchanged
    if not use_fallback:
        return hits
    if not hits:
        # fallback: try code/title as query
        if not code:
            log(f"scene {sid}: oshash miss, no code to fallback")
            return []
        try:
            hits = _gql_scrape(gql, q, source_url, {"query": code}, sid)
            if hits:
                exact = [h for h in hits if codes_match(h.get("code"), code)]
                if exact:
                    log(f"scene {sid}: oshash miss, code '{code}' matched")
                    return exact
                ret_code = (hits[0].get("code") or "").strip().upper()
                if ret_code and not codes_match(ret_code, code):
                    log(f"scene {sid}: code '{code}' returned '{ret_code}', mismatch, discarding")
                    return []
                log(f"scene {sid}: oshash miss, code '{code}' matched (result has no code)")
        except Exception as e:
            log(f"scene {sid}: code fallback error: {e}")
            return []
        # original code found nothing: retry once with the BD brand suffix
        # stripped (CWPBD-98 -> CWP-98). Exact code match only, and the returned
        # row's code is blanked so the local code is never overwritten.
        if not hits:
            stripped = strip_bd_code(code)
            if stripped:
                try:
                    hits = _gql_scrape(gql, q, source_url, {"query": stripped}, sid)
                except Exception as e:
                    log(f"scene {sid}: BD-stripped retry error: {e}")
                    hits = []
                if hits:
                    exact = [h for h in hits if codes_match(h.get("code"), stripped)]
                    if exact:
                        # blank the code only when the local code FIELD is non-empty
                        # (title/filename-derived codes are not kept); a truly empty
                        # local code field may legitimately receive the stripped code.
                        if ((scene or {}).get("code") or "").strip():
                            exact[0]["code"] = ""
                            log(f"scene {sid}: code '{code}' not found, BD-stripped '{stripped}' matched (local code kept)")
                        else:
                            log(f"scene {sid}: code '{code}' not found, BD-stripped '{stripped}' matched (local code empty, filled)")
                        return exact
                    ret_code = (hits[0].get("code") or "").strip().upper()
                    if ret_code and not codes_match(ret_code, stripped):
                        log(f"scene {sid}: BD-stripped '{stripped}' returned '{ret_code}', mismatch, discarding")
                        return []
                log(f"scene {sid}: BD-stripped '{stripped}' no match")
                hits = []
        # fallback found nothing at all (javstash has no entry for this code):
        # adopt the oshash fingerprint candidate as a last resort, loudly, so
        # mismatches stay auditable in the log.
        if not hits and oshash_hits:
            adopted = oshash_hits[0].get("code") or "<no code>"
            log(f"scene {sid}: WARN fallback empty for '{code}', adopting oshash candidate '{adopted}' anyway (audit log)")
            return oshash_hits
    return hits

def _find_by_name(q_by_name, name, id_key):
    """Shared find-or-create: q_by_name(name) -> list of {id...}; caller does create."""
    try:
        rows = q_by_name(name)
    except Exception:
        return None
    for r in rows:
        if nfc(r.get("name") or "") == nfc(name):
            return str(r["id"])
    return None

def find_or_create_studio(gql, name):
    if not name: return None
    q = ("query($n:String!){ findStudios(studio_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:5}){ studios{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findStudios", {}).get("studios", [])
    except Exception:
        rows = []
    for r in rows:
        if nfc(r["name"]) == nfc(name): return str(r["id"])
    try:
        r = gql("mutation($n:String!){ studioCreate(input:{name:$n}){ id } }", {"n": name})
        return str(r["studioCreate"]["id"])
    except Exception as e:
        log(f"studio create '{name}' failed: {e}"); return None

def find_or_create_performer(gql, name):
    if not name: return None
    dup = find_by_name(gql, name, exclude_id=None)
    if dup: return dup
    try:
        # creating a performer triggers Performer.Create.Post -> the performer autofill hook fills its fields
        r = gql("mutation($n:String!){ performerCreate(input:{name:$n}){ id } }", {"n": name})
        return str(r["performerCreate"]["id"])
    except Exception as e:
        log(f"performer create '{name}' failed: {e}"); return None

# ---------- stash-id reverse lookup / direct fetch / unified resolution ----------
def find_by_stash_id(gql, endpoint, stash_id, exclude_id=None):
    """Reverse lookup: the local performer carrying (endpoint, stash_id). None when
    absent. The stash_ids_endpoint filter is only a pre-filter; the exact pair is
    verified client-side (the filter's EQUALS semantics are not relied upon)."""
    if not endpoint or not stash_id: return None
    q = ("query($e:String!,$s:[String!]!){ findPerformers(performer_filter:{"
         "stash_ids_endpoint:{endpoint:$e, stash_ids:$s, modifier:EQUALS}},"
         " filter:{per_page:10}){ performers{ id stash_ids{ endpoint stash_id } } } }")
    try:
        rows = gql(q, {"e": endpoint, "s": [stash_id]}).get("findPerformers", {}).get("performers", [])
    except Exception as e:
        log(f"stash-id reverse lookup {stash_id}: {e}")
        return None
    for p in rows:
        if str(p["id"]) == str(exclude_id): continue
        for s in (p.get("stash_ids") or []):
            if s.get("endpoint") == endpoint and s.get("stash_id") == stash_id:
                return str(p["id"])
    return None

def get_stashbox_api_key(gql, endpoint):
    """ApiKey of the configured stash-box endpoint. Newer Stash exposes
    configuration.stashBoxes; older versions keep them under general.stashBoxes."""
    ep = (endpoint or "").strip().rstrip("/")
    if not ep: return None
    def match(boxes):
        for b in boxes or []:
            if (b.get("endpoint") or "").strip().rstrip("/") == ep:
                key = (b.get("api_key") or "").strip()
                if key: return key
        return None
    try:
        boxes = (gql("{ configuration { stashBoxes { endpoint api_key } } }")
                 .get("configuration", {}) or {}).get("stashBoxes") or []
        k = match(boxes)
        if k: return k
    except Exception:
        pass
    try:
        boxes = (gql("{ configuration { general { stashBoxes { endpoint api_key } } } }")
                 .get("configuration", {}) or {}).get("general", {}).get("stashBoxes") or []
        return match(boxes)
    except Exception:
        return None
    return None

# Enum whitelists for local Stash compatibility (javstash returns e.g. BALD hair,
# which local Stash may not accept; unknown values are dropped rather than written).
_STASH_GENDERS = {"MALE","FEMALE","TRANSGENDER_MALE","TRANSGENDER_FEMALE","INTERSEX","NON_BINARY"}
_STASH_ETHNICITIES = {"CAUCASIAN","BLACK","ASIAN","INDIAN","LATIN","MIDDLE_EASTERN","MIXED","OTHER"}
_STASH_HAIRS = {"BLONDE","BRUNETTE","BROWN","BLACK","RED","AUBURN","GREY","WHITE","OTHER","VARIOUS"}
_STASH_EYES = {"BLUE","BROWN","GREY","GREEN","HAZEL","RED"}

def fetch_performer_by_id(gql, endpoint, stash_id):
    """Fetch a performer's full data from the stash-box by UUID, bypassing name
    matching. Stash's internal stashbox client has this capability but exposes only
    name-based scraping to plugins, so the configured ApiKey is used for a direct
    findPerformer call (mirroring Stash's ApiKey + User-Agent headers — javstash
    rejects bare urllib requests with 403). Returns data normalised to the scrape
    candidate shape, or None."""
    if not endpoint or not stash_id: return None
    api_key = get_stashbox_api_key(gql, endpoint)
    if not api_key:
        log(f"stash-id fetch {stash_id}: no api_key for {endpoint}")
        return None
    q = ("query($id:ID!){ findPerformer(id:$id){ name aliases gender birth_date death_date ethnicity country "
         "hair_color eye_color height band_size cup_size waist_size hip_size career_start_year career_end_year "
         "breast_type tattoos{ location description } piercings{ location description } urls{ url } images{ url } } }")
    data = json.dumps({"query": q, "variables": {"id": stash_id}}).encode()
    headers = {"Content-Type": "application/json", "ApiKey": api_key, "User-Agent": "stash/1.0.0"}
    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE  # some Python builds lack CA certs
    try:
        req = urllib.request.Request(endpoint, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=30, context=sslctx) as r:
            j = json.loads(r.read())
        if j.get("errors"):
            log(f"stash-id fetch {stash_id}: {j['errors']}")
            return None
        p = (j.get("data") or {}).get("findPerformer")
    except Exception as e:
        log(f"stash-id fetch {stash_id}: {e}")
        return None
    if not p: return None
    # ---- normalise javstash flat schema to the scrape-candidate shape ----
    p["birthdate"] = p.pop("birth_date", None) or ""
    def year_str(v):
        return str(v) if v is not None else ""
    p["career_start"] = year_str(p.pop("career_start_year", None))
    p["career_end"] = year_str(p.pop("career_end_year", None))
    h = p.get("height")
    p["height"] = str(h) if h is not None else ""
    band, cup, waist, hip = p.get("band_size"), p.get("cup_size"), p.get("waist_size"), p.get("hip_size")
    if all(v is not None for v in (band, cup, waist, hip)):
        p["measurements"] = "%s%s-%s-%s" % (band, cup, waist, hip)
    else:
        p["measurements"] = ""
    bt = p.pop("breast_type", None)
    p["fake_tits"] = bt if bt in ("NATURAL", "FAKE") else ""
    def bmod_str(items):
        out = []
        for it in items or []:
            loc = (it.get("location") or "").strip()
            desc = (it.get("description") or "").strip()
            if loc and desc: out.append(loc + ": " + desc)
            elif loc: out.append(loc)
            elif desc: out.append(desc)
        return ", ".join(out)
    p["tattoos"] = bmod_str(p.get("tattoos"))
    p["piercings"] = bmod_str(p.get("piercings"))
    for f, ok in (("gender", _STASH_GENDERS), ("ethnicity", _STASH_ETHNICITIES),
                  ("hair_color", _STASH_HAIRS), ("eye_color", _STASH_EYES)):
        v = p.get(f)
        if v is not None and v not in ok:
            p[f] = ""
    p["urls"] = [u.get("url") for u in (p.get("urls") or []) if u.get("url")]
    p["images"] = [im.get("url") for im in (p.get("images") or []) if im.get("url")]
    p["remote_site_id"] = stash_id
    return p
def create_performer(gql, name, stash_ids=None, cand=None, ow=None):
    """Create a performer carrying name + (optionally) stash_ids and fields from cand.
    The created name stays primary; cand name/aliases land in the alias list."""
    inp = {"name": name}
    if stash_ids:
        inp["stash_ids"] = [{"endpoint": ep, "stash_id": sid} for ep, sid in stash_ids]
    if cand:
        upd = build_update({}, cand, primary_name=name, extra_aliases=[], set_name=False, ow=ow or {})
        for k, v in upd.items():
            if k not in inp:
                inp[k] = v
    try:
        r = gql("mutation($i:PerformerCreateInput!){ performerCreate(input:$i){ id } }", {"i": inp})
        return str(r["performerCreate"]["id"])
    except Exception as e:
        log(f"performer create '{name}' failed: {e}")
        return None

def resolve_performer(gql, name, rid, src):
    """Unified performer resolution for scene fill (hook and backfill share this):
    stash-id reverse lookup first -> reuse; else create with the stash_id attached
    (details are filled afterwards by the async performer hook); no stash-id ->
    name/alias reuse (dedup) or create blank. Returns a performer id or None."""
    name = (name or "").strip()
    if not name: return None
    rid = (rid or "").strip()
    ep = (src or JAV).strip()
    if rid and ep.startswith("http"):
        pid = find_by_stash_id(gql, ep, rid)
        if pid: return str(pid)
        return create_performer(gql, name, stash_ids=[(ep, rid)])
    return find_or_create_performer(gql, name)

def find_or_create_tag(gql, name):
    if not name: return None
    q = ("query($n:String!){ findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:5}){ tags{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findTags", {}).get("tags", [])
    except Exception:
        rows = []
    for r in rows:
        if nfc(r["name"]) == nfc(name): return str(r["id"])
    # Pre-check: a Tag.Create.Post hook (e.g. tagMergeAuto) may have already merged
    # this name into a canonical tag's aliases; creating it again would fail with
    # 'name X is used as alias for Y' and spam the Stash log. Resolve name OR alias
    # first and return the canonical tag without firing the doomed tagCreate.
    hit = _find_tag_by_name_or_alias(gql, name)
    if hit is not None:
        return hit
    try:
        r = gql("mutation($n:String!){ tagCreate(input:{name:$n}){ id } }", {"n": name})
        if r and r.get("tagCreate"):
            return str(r["tagCreate"]["id"])
        log(f"tag create '{name}' returned no tag (likely merged by a Tag.Create.Post hook), alias lookup fallback")
    except Exception as e:
        log(f"tag create '{name}' failed: {e}, alias lookup fallback")
    # Race window: the hook merged the tag between the pre-check and tagCreate.
    return _find_tag_by_name_or_alias(gql, name)

def _find_tag_by_name_or_alias(gql, name):
    # Old Stash has no names filter — full pull; called only on fallback paths.
    try:
        rows = gql('{ findTags(filter:{per_page:-1}){ tags{ id name aliases } } }').get("findTags", {}).get("tags", [])
    except Exception:
        return None
    for r in rows:
        if nfc(r.get("name") or "") == nfc(name):
            return str(r["id"])
        for a in (r.get("aliases") or []):
            if nfc(a) == nfc(name):
                log(f"tag '{name}' resolved to canonical '{r.get('name')}' via alias")
                return str(r["id"])
    return None


def find_or_create_group(gql, name):
    if not name: return None
    q = ("query($n:String!){ findGroups(group_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:5}){ groups{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findGroups", {}).get("groups", [])
    except Exception:
        rows = []
    for r in rows:
        if nfc(r.get("name") or "") == nfc(name): return str(r["id"])
    try:
        r = gql("mutation($n:String!){ groupCreate(input:{name:$n}){ id } }", {"n": name})
        return str((r.get("groupCreate") or {}).get("id"))
    except Exception:
        return None
def _first_or_none(x):
    return (x or [None])[0]

def _shot_is_auto(scene):
    """True when the scene still uses the auto-generated screenshot (no custom cover).

    Stash's paths.screenshot ?t= is the scene's updated_at (cache-buster), so for a
    freshly created scene that no metadata writer has touched it equals created_at
    (delta 0). ANY write — e.g. the NFO parser setting title/details/cover right after
    the scan — moves ?t= away from created_at, meaning the cover is no longer the auto
    frame. Strict equality (not "within 2h") is what distinguishes "NFO already wrote a
    cover at scan time" from "still auto". Fail-closed: unreadable -> False (skip)."""
    shot = ((scene or {}).get("paths") or {}).get("screenshot") or ""
    if not shot or "?t=" not in shot:
        return False
    try:
        shot_ts = int(shot.split("?t=")[1].split("&")[0])
        ca = scene.get("created_at") or ""
        created_ts = int(datetime.datetime.fromisoformat(ca.replace("Z", "+00:00")).timestamp())
        return shot_ts == created_ts
    except Exception:
        return False


def _is_blob_lock_error(e):
    """Windows blob file-lock error: Stash fails to delete the old cover blob while
    another process holds it ('deleting from filesystem ... being used by another
    process'). Transient; a short retry usually succeeds."""
    s = str(e)
    return "deleting from filesystem" in s or "being used by another process" in s


def _reload_scene_cover(gql, sid):
    """Fresh read of the scene's cover-relevant state. None on read failure (skip cover)."""
    try:
        return gql("query($id:ID!){ findScene(id:$id){ created_at paths{ screenshot } } }",
                   {"id": str(sid)}).get("findScene")
    except Exception as e:
        log(f"scene {sid}: cover re-read failed ({e})")
        return None


def _download_image(image_url):
    """Download the cover bytes. Returns (raw, content_type) or (None, error)."""
    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE  # some Python builds lack CA certs; the image is public
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20, context=sslctx) as r:
                return r.read(), r.headers.get("Content-Type", "image/jpeg")
        except Exception as e:
            last = e
            time.sleep(1 << attempt)   # 1s, 2s
    return None, last


def _apply_cover_with_retry(gql, sid, image):
    """Write the scene cover in a SEPARATE sceneUpdate, never inside the main payload:
    a cover write failing on a Windows blob lock must not take down title/code/
    performers/tags etc. Re-reads the scene before every attempt and skips when the
    NFO parser (or anyone else) already set a custom cover; retries transient blob-lock
    errors with 1s/2s/4s backoff (3 retries). Returns True when the cover was written."""
    if not image:
        return False
    if image.startswith("data:"):
        payload = {"id": str(sid), "cover_image": image}
    else:
        raw, ctype = _download_image(image)
        if raw is None:
            log(f"scene {sid}: cover download failed ({ctype})")
            return False
        payload = {"id": str(sid),
                   "cover_image": "data:%s;base64,%s" % (ctype, base64.b64encode(raw).decode())}
    for attempt in range(4):   # 1 write + 3 retries
        fresh = _reload_scene_cover(gql, sid)
        if fresh is None or not _shot_is_auto(fresh):
            log(f"scene {sid}: cover skipped (custom cover already in place)")
            return False
        try:
            gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }", {"i": payload})
            log(f"scene {sid}: cover set")
            return True
        except Exception as e:
            if not _is_blob_lock_error(e):
                log(f"scene {sid}: cover update failed ({e})")
                return False
            if attempt < 3:
                log(f"scene {sid}: cover blob lock (retry {attempt + 1}/3 in {1 << attempt}s)")
                time.sleep(1 << attempt)
    log(f"scene {sid}: cover update gave up after 3 retries")
    return False

def apply_scene_fill(gql, sid, scene, sc, src, ow=None):
    """Build & run sceneUpdate for one scraped match. Empty-only by default (ow off);
    ow toggles per field group; urls/tags replace when their ow is on, else merge-dedup;
    studio only when unset unless ow["other"]; stash_ids always appended."""
    ow = ow or {}
    upd = {"id": str(sid)}
    def empty(f):
        v = scene.get(f)
        return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, list) and len(v) == 0)
    def writable(f, owkey=None):  # write when empty; also write a non-empty field if the toggle is on.
        return empty(f) or bool(ow.get(owkey or f))
    # Scalars: the delayed worker (sceneFillDelay, default 20s after creation) runs
    # after the NFO parser has written title/details/date, so non-empty values are
    # kept; ow["title"]/ow["other"] override that (setups without NFO import).
    if writable("title") and sc.get("title"):
        upd["title"] = sc["title"]
    for f in ("code", "details", "director", "date"):
        if writable(f, "other") and sc.get(f):
            upd[f] = sc[f]
    # urls: ow on -> replace with the scraper's; off -> merge de-dup
    existing_urls = [u.strip() for u in (scene.get("urls") or []) if u and u.strip()]
    new_urls = [u.strip() for u in (sc.get("urls") or []) if u and u.strip()]
    if ow.get("urls"):
        if new_urls and new_urls != existing_urls:
            upd["urls"] = new_urls
    else:
        merged_urls = list(dict.fromkeys(existing_urls + new_urls))
        if merged_urls != existing_urls:
            upd["urls"] = merged_urls
    # studio: only when scene has none (ow["other"] allows replacing an existing one)
    if (not scene.get("studio")) or ow.get("other"):
        st = sc.get("studio") or {}
        sid_studio = st.get("stored_id") or find_or_create_studio(gql, st.get("name"))
        if sid_studio: upd["studio_id"] = sid_studio
    # performers: unified resolution (stash-id reverse lookup first -> reuse; else
    # create carrying the stash_id; no stash-id -> name/alias reuse or create blank).
    # Merge-dedup by default; ow["other"] replaces the scene's set with the scraper's.
    existing_pids = {str(p["id"]) for p in (scene.get("performers") or [])}
    if ow.get("other"):
        want_pids = set()
        for p in (sc.get("performers") or []):
            pid = resolve_performer(gql, p.get("name"), p.get("remote_site_id"), src)
            if pid: want_pids.add(str(pid))
        if want_pids and want_pids != existing_pids:
            upd["performer_ids"] = sorted(want_pids, key=int)
    else:
        want_pids = set(existing_pids)
        for p in (sc.get("performers") or []):
            pid = resolve_performer(gql, p.get("name"), p.get("remote_site_id"), src)
            if pid: want_pids.add(str(pid))
        if want_pids != existing_pids:
            upd["performer_ids"] = sorted(want_pids, key=int)
    # tags: ow on -> replace with the scraper's; off -> merge de-dup
    existing_tids = {str(t["id"]) for t in (scene.get("tags") or [])}
    if ow.get("tags"):
        want_tids = set()
        for t in (sc.get("tags") or []):
            tid = t.get("stored_id") or find_or_create_tag(gql, t.get("name"))
            if tid: want_tids.add(str(tid))
        if want_tids and want_tids != existing_tids:
            upd["tag_ids"] = sorted(want_tids, key=int)
    else:
        want_tids = set(existing_tids)
        for t in (sc.get("tags") or []):
            tid = t.get("stored_id") or find_or_create_tag(gql, t.get("name"))
            if tid: want_tids.add(str(tid))
        if want_tids != existing_tids:
            upd["tag_ids"] = sorted(want_tids, key=int)
    # groups: find-or-create by name
    existing_gids = {str(g["group"]["id"] if g.get("group") else None) for g in (scene.get("groups") or [])}
    want_groups = []
    for g in (sc.get("groups") or []):
        gid = g.get("stored_id") or find_or_create_group(gql, g.get("name"))
        if gid and str(gid) not in existing_gids:
            want_groups.append({"group_id": str(gid)})
    if want_groups:
        upd["groups"] = want_groups
    # stash_id: append if missing for this endpoint
    sids = add_endpoint_stash_id(scene.get("stash_ids"), src, (sc.get("remote_site_id") or "").strip())
    if sids is not None:
        upd["stash_ids"] = sids
    # cover image: written in a SEPARATE sceneUpdate, never inside the main payload —
    # a cover write failing on a Windows blob lock must not take down title/code/
    # performers/tags etc. The fill-time snapshot only gates whether a cover write is
    # worth trying; the actual write re-reads the scene (fresh screenshot/created_at)
    # and skips when the NFO parser has already set a custom cover. Runs BEFORE the
    # main update: our own main update would move screenshot ?t= and make the re-read
    # misjudge the scene as already covered.
    sc_image = (sc.get("image") or "").strip()
    if sc_image:
        if ow.get("image") or _shot_is_auto(scene):
            _apply_cover_with_retry(gql, sid, sc_image)
        else:
            log(f"scene {sid}: cover skipped (custom cover already in place)")
    # drop the id-only payload
    if len(upd) > 1:
        gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }", {"i": upd})
    return upd

def spawn_fill_later(conn, sid):
    """Spawn a detached worker that waits for the NFO parser then fills the scene."""
    try:
        env = dict(os.environ, JAVSTASH_CONN=json.dumps(conn))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--fill-scene-later", str(sid)],
                         env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except Exception as e:
        log(f"scene {sid}: delayed fill spawn failed ({e})")

def _scene_fill_delay(settings):
    try:
        return max(0, int((settings or {}).get("sceneFillDelay") or 20))
    except (TypeError, ValueError):
        return 20

def fill_scene_later_mode(sid):
    """Delayed worker entry: wait for the NFO parser (sceneFillDelay, default 20s),
    then re-read and fill."""
    conn = json.loads(os.environ.get("JAVSTASH_CONN", "{}"))
    gql = make_gql(conn)
    settings = get_settings(gql)
    src = (settings.get("scraper") or JAV).strip()
    if not src.startswith("http"):
        log(f"scene {sid}: delayed fill skipped (bad source)"); return
    time.sleep(_scene_fill_delay(settings))
    scene = get_scene_full(gql, sid)
    if not scene:
        log(f"scene {sid}: delayed fill: scene not found, skip"); return
    rows = scrape_scene_full(gql, sid, src, scene, settings.get("sceneCodeFallback") is not False)
    if not rows:
        log(f"scene {sid}: no fingerprint match at {src} -> skip"); return
    sc = rows[0]
    try:
        upd = apply_scene_fill(gql, sid, scene, sc, src, ow=build_scene_ow(settings))
        log(f"scene {sid}: filled {sorted(k for k in upd if k != 'id')}")
    except Exception as e:
        log(f"scene {sid}: delayed fill error: {e}")

def handle_scene_create(payload, conn, gql):
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    sid = ctx.get("id")
    if not sid:
        log_info("scene hook: no scene id"); return
    settings = get_settings(gql)
    src = (settings.get("scraper") or JAV).strip()
    if not src.startswith("http"):
        log_info("scene hook: scraper must be a stash-box URL"); return
    # Spawn a delayed worker instead of filling now: the NFO parser may still
    # be writing title/details/date seconds after scene creation. Filling
    # immediately would race it; the delayed worker re-reads the scene after a
    # short wait and fills empty-only.
    spawn_fill_later(conn, sid)
    log_info(f"scene {sid}: queued delayed fill ({_scene_fill_delay(settings)}s)")

def handle_scene_backfill(payload, conn, gql):
    """Task: scan all scenes missing the configured stash-box endpoint, look them up by file hash and fill."""
    settings = get_settings(gql)
    src = (settings.get("scraper") or JAV).strip()
    if not src.startswith("http"):
        log_info("scraper must be a stash-box URL"); return
    # First pass: collect all scenes needing fill (missing endpoint + has files)
    todo = []
    page = 1
    while True:
        q = ('{ findScenes(filter:{per_page:100,page:%d,sort:"id"}){ scenes{ id files{ id } stash_ids{ endpoint } } } }' % page)
        try:
            rows = gql(q).get("findScenes", {}).get("scenes", [])
        except Exception as e:
            log_info(f"list error: {e}"); return
        if not rows: break
        for sc in rows:
            eps = {s["endpoint"] for s in (sc.get("stash_ids") or [])}
            if src in eps: continue
            if not (sc.get("files") or []): continue
            todo.append(sc["id"])
        page += 1
    total = len(todo)
    log_info(f"backfill: {total} scenes need stash_id, starting")
    filled = 0; matched = 0; done = 0
    for sid in todo:
        done += 1
        log_progress(done / total if total else 1.0)
        time.sleep(0.3)  # rate-limit JAVStash (~200/min)
        scene = get_scene_full(gql, sid)
        if not scene: continue
        hits = scrape_scene_full(gql, sid, src, scene, settings.get("sceneCodeFallback") is not False)
        if not hits: continue
        try:
            apply_scene_fill(gql, sid, scene, hits[0], src, ow=build_scene_ow(settings))
            matched += 1
            if (hits[0].get("remote_site_id") or "").strip():
                filled += 1
        except Exception as e:
            log(f"backfill scene {sid}: {e}")
        if done % 10 == 0 or done == total:
            log_info(f"progress: {done}/{total} (matched {matched}, added stash_id {filled})")
    out = f"backfill done: {total} scenes, matched {matched}, added stash_id {filled}"
    log(out)
    log_info(out)
    log_progress(1.0)

# ---------- performer create: async fill (stash-id reverse lookup first) ----------
def _performer_fill_delay(settings):
    try:
        return max(0, int((settings or {}).get("performerFillDelay") or 2))
    except (TypeError, ValueError):
        return 2

def handle_performer_create(payload, conn, gql):
    """Performer.Create.Post hook: spawn a detached worker and return immediately.
    The worker waits a short delay (performerFillDelay, default 2s) then re-reads
    the performer and fills it — the previous synchronous hook made a manual
    creation without a stash-id block the UI for ~25s on an unmatched JAVStash
    search, so the delay/fill must never run inside the hook itself."""
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    pid = ctx.get("id")
    if not pid:
        log_info("performer hook: no performer id"); return
    try:
        env = dict(os.environ, JAVSTASH_CONN=json.dumps(conn))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--fill-performer-later", str(pid)],
                         env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        log_info(f"performer {pid}: queued delayed fill")
    except Exception as e:
        log_info(f"performer {pid}: delayed fill spawn failed ({e})")

def fill_performer_later_mode(pid):
    """Delayed worker entry: wait performerFillDelay, re-read the performer and fill."""
    conn = json.loads(os.environ.get("JAVSTASH_CONN", "{}"))
    gql = make_gql(conn)
    settings = get_settings(gql)
    if settings.get("performerFill") is False:
        log_info(f"performer {pid}: performer fill disabled"); return
    time.sleep(_performer_fill_delay(settings))
    try:
        fill_performer(gql, conn, pid)
    except Exception as e:
        log(f"performer {pid}: delayed fill error: {e}")

def fill_performer(gql, conn, pid):
    """Unified performer fill (async worker). Origin is decided by the performer's
    actual stash_ids (the create input is not available in the worker):
      - with stash_ids: reverse-lookup the local performer (reuse/merge, created
        name appended as alias) or fill directly by id — bypasses name matching;
      - without stash_ids: 0.9 name match; a matched local candidate is reused
        (merged), an identity-anchored candidate is conservatively ignored, else
        the created name stays primary and the scraper name becomes an alias (unless
        owPerformerName is on)."""
    try:
        perf = get_performer(gql, pid)
    except Exception as e:
        log(f"get_performer error {pid}: {e}"); log_info(f"performer {pid}: fetch error, skip"); return
    if not perf or not perf.get("name"):
        log_info(f"performer {pid}: no name, skip"); return
    name = perf["name"]
    targets = [name] + list(perf.get("alias_list") or [])
    settings = get_settings(gql)
    ow = build_ow(settings)
    try:
        threshold = float(settings.get("threshold"))
        if not (0 < threshold <= 1): threshold = THRESHOLD
    except (TypeError, ValueError):
        threshold = THRESHOLD

    sids = perf.get("stash_ids") or []
    if sids:
        ep = (sids[0].get("endpoint") or "").strip()
        rid = (sids[0].get("stash_id") or "").strip()
        if not ep or not rid:
            log(f"performer {pid} '{name}': bad stash_ids, skip"); return
        # ① reverse lookup: the same stash-id already lives on another local performer
        dup = find_by_stash_id(gql, ep, rid, exclude_id=pid)
        if dup:
            dest = get_performer(gql, dup)
            if not dest:
                log(f"performer {pid} '{name}': reverse-hit {dup} unreadable, skip"); return
            extra = [name] + list(perf.get("alias_list") or [])
            cand = fetch_performer_by_id(gql, ep, rid)
            if cand:
                values = build_update(dest, cand, primary_name=dest["name"],
                                      extra_aliases=extra, set_name=False, ow=ow)
            else:
                values = {}
            sids2 = union_stash_ids(dest, perf)
            if sids2 is not None: values["stash_ids"] = sids2
            values["id"] = dup
            performer_merge(gql, [pid], dup, values)
            if cand:
                apply_image_async(conn, dup, dest, cand, overwrite=ow.get("image"))
            log(f"performer {pid} '{name}': MERGED into {dup} (stash-id match, fields={sorted(values.keys())})")
            log_info(f"performer {pid} '{name}': merged into {dup} (stash-id match)")
            return
        # ② no local reverse-hit -> fill directly by stash-id (bypasses name matching)
        cand = fetch_performer_by_id(gql, ep, rid)
        if not cand:
            log(f"performer {pid} '{name}': stash-id fetch failed ({ep}/{rid}), skip")
            log_info(f"performer {pid} '{name}': stash-id fetch failed, skip"); return
        values = build_update(perf, cand, primary_name=name, extra_aliases=[], set_name=False, ow=ow)
        if values:
            performer_update(gql, pid, values)
        apply_image_async(conn, pid, perf, cand, overwrite=ow.get("image"))
        log(f"performer {pid} '{name}': filled by stash-id {rid} ({sorted(values.keys())})")
        log_info(f"performer {pid} '{name}': filled by stash-id")
        return

    # ---------- no stash-id: 0.9 name match on the manual source ----------
    src = settings.get("scraper")
    source_input = build_source(src)
    cands = scrape_source(gql, name, source_input)
    if not cands:
        log(f"performer {pid} '{name}': no candidate ({source_input}), keep blank")
        log_info(f"performer {pid} '{name}': no candidate, skip"); return
    scored = sorted(((match_score(targets, [c.get("name")] + split_aliases(c.get("aliases"))), c)
                     for c in cands), key=lambda x: x[0], reverse=True)
    top_score, top = scored[0]
    if top_score < threshold:
        log(f"performer {pid} '{name}': best score {top_score:.2f} < {threshold}, keep blank")
        log_info(f"performer {pid} '{name}': score {top_score:.2f} too low, skip"); return
    cand_name = (top.get("name") or "").strip()
    cand_ep = (source_input.get("stash_box_endpoint") or "").strip()
    cand_rid = (top.get("remote_site_id") or "").strip()
    # reuse/dedup: a local performer already carrying the candidate name (name or alias)
    dup = find_by_name(gql, cand_name, exclude_id=pid)
    if dup:
        dup_perf = get_performer(gql, dup)
        if not dup_perf:
            log(f"performer {pid} '{name}': candidate-name hit {dup} unreadable, keep blank"); return
        dup_sids = {s.get("stash_id") for s in (dup_perf.get("stash_ids") or []) if s.get("stash_id")}
        if dup_sids and cand_rid not in dup_sids:
            # the candidate identity is anchored to another performer -> conservative:
            # never merge (irreversible) nor attach the id; keep the new one blank.
            log(f"performer {pid} '{name}': '{cand_name}' exists as {dup} with other stash ids, keep blank (conservative)")
            log_info(f"performer {pid} '{name}': candidate identity conflict, keep blank"); return
        extra = [name] + list(perf.get("alias_list") or [])
        values = build_update(dup_perf, top, primary_name=dup_perf["name"],
                              extra_aliases=extra, set_name=False, ow=ow)
        sids2 = union_stash_ids(dup_perf, perf)
        if cand_ep and cand_rid:
            cur = sids2 if sids2 is not None else list(dup_perf.get("stash_ids") or [])
            merged = add_endpoint_stash_id(cur, cand_ep, cand_rid)
            if merged is not None: sids2 = merged
        if sids2 is not None: values["stash_ids"] = sids2
        values["id"] = dup
        performer_merge(gql, [pid], dup, values)
        apply_image_async(conn, dup, dup_perf, top, overwrite=ow.get("image"))
        log(f"performer {pid} '{name}': MERGED into {dup} '{dup_perf['name']}' "
            f"(name/alias match, fields={sorted(values.keys())}, score={top_score:.2f})")
        log_info(f"performer {pid} '{name}': merged into {dup}"); return
    # no duplicate: created name stays primary (default); scraper name becomes an alias
    use_scraper_name = settings.get("owPerformerName")
    if use_scraper_name is None: use_scraper_name = False
    prefer_scraper = bool(use_scraper_name) and bool(cand_name) and norm(cand_name) != norm(name)
    if prefer_scraper:
        values = build_update(perf, top, primary_name=cand_name, extra_aliases=[name], set_name=True, ow=ow)
        mode = "rename"
    else:
        values = build_update(perf, top, primary_name=name, extra_aliases=[], set_name=False, ow=ow)
        mode = "keep-name"
    if cand_ep and cand_rid:
        new_sids = add_endpoint_stash_id(perf.get("stash_ids"), cand_ep, cand_rid)
        if new_sids is not None:
            values["stash_ids"] = new_sids
    if values:
        performer_update(gql, pid, values)
    apply_image_async(conn, pid, perf, top, overwrite=ow.get("image"))
    log(f"performer {pid} '{name}' [{mode}]: filled {sorted(values.keys())} (score={top_score:.2f})")
    log_info(f"performer {pid} '{name}': filled {sorted(values.keys())}")

# ---------- main ----------
def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        log_info("no input from stdin"); return
    conn = payload.get("server_connection", {})
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    htype = ctx.get("type", "")

    gql = make_gql(conn)

    mode = (payload.get("args") or {}).get("mode") or ""
    if mode == "scene_backfill":
        handle_scene_backfill(payload, conn, gql); return

    if "Scene.Create" in htype:
        handle_scene_create(payload, conn, gql); return
    if "Performer.Create" in htype:
        handle_performer_create(payload, conn, gql); return
    log_info("skip: not performer/scene create")

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--fill-scene-later":
        fill_scene_later_mode(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "--fill-performer-later":
        fill_performer_later_mode(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "--set-image":
        set_image_mode(sys.argv[2], sys.argv[3])
    else:
        main()
