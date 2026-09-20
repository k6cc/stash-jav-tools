#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stash plugin: Performer.Create.Post hook.
When a performer is created, search the configured source (default: the javstash
stash-box) by name, take the best name-matching candidate and fill only the empty
fields (skip if the best score is below THRESHOLD).

The primary-name handling depends on the creation origin (Identify vs. manual;
detected by the presence of stash_ids in the create input):
  - Identify creation -> prefer the scraper's canonical name as primary; the
    created name is demoted to an alias. If a performer with that name already
    exists, the new one is merged into it via performerMerge (scenes re-linked,
    new one removed, the existing one's empty fields filled, the created name kept
    as an alias, and the stash-box id carried over).
  - Manual creation    -> keep the created name as primary; the scraper name is
    added as an alias.
Existing values, existing images and existing aliases are protected (only empty
fields are filled / missing entries appended) unless a per-field overwrite toggle
is enabled. Measurements are normalised from javstash form (91H-56-88) to
(91(H)-56-88). Standard library only.
"""
import sys, json, re, unicodedata, urllib.request, difflib, os, datetime, base64, subprocess, ssl, time

JAV = "https://javstash.org/graphql"
THRESHOLD = 0.9
LOG = os.path.join(os.path.dirname(__file__), "javstash_autofill_plus.log")

def log(msg):
    try:
        with open(LOG, "a") as f:
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
        return plugins.get("javstashAutofill+") or {}
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
def find_by_name(gql, name, exclude_id):
    q = ("query($n:String!){ findPerformers(performer_filter:{name:{value:$n,modifier:EQUALS}},"
         " filter:{per_page:5}){ performers{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findPerformers", {}).get("performers", [])
    except Exception:
        return None
    for p in rows:
        if str(p["id"]) != str(exclude_id) and nfc(p["name"]) == nfc(name):
            return p["id"]
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
                     "studio{ stored_id name } performers{ stored_id name } tags{ stored_id name }")

def get_scene_full(gql, sid):
    q = ("query($id:ID!){ findScene(id:$id){ id title code details director date urls "
         "studio{ id name } performers{ id } tags{ id } groups{ group{ id } } paths{ screenshot } stash_ids{ endpoint stash_id } created_at } }")
    return gql(q, {"id": str(sid)}).get("findScene")

_CODE_RE = re.compile(r"^([A-Za-z]{2,6}[-_]?\d{2,5})")
def extract_code(scene):
    """Get studio code from scene, or extract from title prefix."""
    c = (scene.get("code") or "").strip()
    if c: return c
    t = (scene.get("title") or "").strip()
    m = _CODE_RE.match(t)
    return m.group(1) if m else None

def scrape_scene_full(gql, sid, source_url, scene=None, use_fallback=True):
    q = ("query($s:ScraperSourceInput!,$i:ScrapeSingleSceneInput!){"
         " scrapeSingleScene(source:$s,input:$i){ %s } }" % SCENE_FULL_FIELDS)
    try:
        hits = gql(q, {"s": {"stash_box_endpoint": source_url},
                       "i": {"scene_id": str(sid)}}).get("scrapeSingleScene") or []
    except Exception as e:
        log(f"scene {sid}: scrape error: {e}")
        return []
    if hits: return hits
    # fallback: try code/title as query
    code = extract_code(scene or {})
    if not code:
        log(f"scene {sid}: oshash miss, no code to fallback")
        return []
    try:
        hits = gql(q, {"s": {"stash_box_endpoint": source_url},
                       "i": {"query": code}}).get("scrapeSingleScene") or []
        if hits:
            # verify returned code matches searched code
            ret_code = (hits[0].get("code") or "").strip().upper()
            if ret_code and ret_code != code.upper():
                log(f"scene {sid}: code '{code}' returned '{ret_code}', mismatch, discarding")
                return []
            log(f"scene {sid}: oshash miss, code '{code}' matched")
    except Exception as e:
        log(f"scene {sid}: code fallback error: {e}")
        return []
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
    q = ("query($n:String!){ findPerformers(performer_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:5}){ performers{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findPerformers", {}).get("performers", [])
    except Exception:
        rows = []
    for r in rows:
        if nfc(r["name"]) == nfc(name): return str(r["id"])
    try:
        # creating a performer triggers Performer.Create.Post -> the performer autofill hook fills its fields
        r = gql("mutation($n:String!){ performerCreate(input:{name:$n}){ id } }", {"n": name})
        return str(r["performerCreate"]["id"])
    except Exception as e:
        log(f"performer create '{name}' failed: {e}"); return None

def find_or_create_tag(gql, name):
    if not name: return None
    q = ("query($n:String!){ findTags(tag_filter:{name:{value:$n,modifier:EQUALS}},filter:{per_page:5}){ tags{ id name } } }")
    try:
        rows = gql(q, {"n": name}).get("findTags", {}).get("tags", [])
    except Exception:
        rows = []
    for r in rows:
        if nfc(r["name"]) == nfc(name): return str(r["id"])
    try:
        r = gql("mutation($n:String!){ tagCreate(input:{name:$n}){ id } }", {"n": name})
        return str(r["tagCreate"]["id"])
    except Exception as e:
        log(f"tag create '{name}' failed: {e}"); return None

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

def apply_scene_image_async(conn, sid, image_url):
    """Spawn a detached process to download the cover and set it via sceneUpdate.cover_image."""
    if not conn: return
    try:
        env = dict(os.environ, JAVSTASH_CONN=json.dumps(conn))
        subprocess.Popen([sys.executable, os.path.abspath(__file__),
                          "--set-scene-image", str(sid), image_url],
                         env=env, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except Exception as e:
        log(f"scene {sid}: cover spawn skipped ({e})")

def set_scene_image_mode(sid, image_url):
    """Subprocess entry: download the cover and set it as base64 via sceneUpdate.cover_image."""
    conn = json.loads(os.environ.get("JAVSTASH_CONN", "{}"))
    gql = make_gql(conn)
    sslctx = ssl.create_default_context()
    sslctx.check_hostname = False
    sslctx.verify_mode = ssl.CERT_NONE
    for attempt in range(3):
        try:
            req = urllib.request.Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=20, context=sslctx) as r:
                raw = r.read()
                ctype = r.headers.get("Content-Type", "image/jpeg")
            b64 = base64.b64encode(raw).decode()
            gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }",
                {"i": {"id": str(sid), "cover_image": f"data:{ctype};base64,{b64}"}})
            log(f"scene {sid}: cover set async ({len(raw)} bytes)")
            return
        except Exception as e:
            log(f"scene {sid}: cover async attempt {attempt+1} failed ({e})")
    log(f"scene {sid}: cover async gave up")

def apply_scene_fill(gql, sid, scene, sc, src):
    """Build & run sceneUpdate for one scraped match. Empty-only for scalars; merge-dedup for urls/performers/tags; studio only when unset; stash_ids appended."""
    upd = {"id": str(sid)}
    def empty(f):
        v = scene.get(f)
        return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, list) and len(v) == 0)
    # scalars: empty only
    for f in ("title", "code", "details", "director", "date"):
        if empty(f) and sc.get(f):
            upd[f] = sc[f]
    # urls: merge de-dup
    existing_urls = [u.strip() for u in (scene.get("urls") or []) if u and u.strip()]
    new_urls = [u.strip() for u in (sc.get("urls") or []) if u and u.strip()]
    merged_urls = list(dict.fromkeys(existing_urls + new_urls))
    if merged_urls != existing_urls:
        upd["urls"] = merged_urls
    # studio: only when scene has none
    if not scene.get("studio"):
        st = sc.get("studio") or {}
        sid_studio = st.get("stored_id") or find_or_create_studio(gql, st.get("name"))
        if sid_studio: upd["studio_id"] = sid_studio
    # performers: merge de-dup (stored_id preferred, else find-or-create by name)
    existing_pids = {str(p["id"]) for p in (scene.get("performers") or [])}
    want_pids = set(existing_pids)
    for p in (sc.get("performers") or []):
        pid = p.get("stored_id") or find_or_create_performer(gql, p.get("name"))
        if pid: want_pids.add(str(pid))
    if want_pids != existing_pids:
        upd["performer_ids"] = sorted(want_pids, key=int)
    # tags: merge de-dup
    existing_tids = {str(t["id"]) for t in (scene.get("tags") or [])}
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
    # cover image: only when the scene still uses an auto-generated screenshot (no custom cover).
    # screenshot ?t= timestamp within 2h of created_at => auto-generated frame (empty cover);
    # much later timestamp means a custom cover was set => skip. data: URI set directly; http async.
    shot = ((scene.get("paths") or {}).get("screenshot") or "")
    sc_image = (sc.get("image") or "").strip()
    shot_is_auto = False
    try:
        if "?t=" in shot:
            shot_ts = int(shot.split("?t=")[1].split("&")[0])
            ca = scene.get("created_at") or ""
            import datetime as _dt
            created_ts = int(_dt.datetime.fromisoformat(ca.replace("Z","+00:00")).timestamp())
            shot_is_auto = abs(shot_ts - created_ts) < 7200
    except Exception:
        shot_is_auto = False
    if sc_image and shot_is_auto:
        if sc_image.startswith("data:"):
            upd["cover_image"] = sc_image
        else:
            apply_scene_image_async(scene.get("__conn__"), sid, sc_image)
    # drop the id-only payload
    if len(upd) > 1:
        gql("mutation($i:SceneUpdateInput!){ sceneUpdate(input:$i){ id } }", {"i": upd})
    return upd

def handle_scene_create(payload, conn, gql):
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    sid = ctx.get("id")
    if not sid:
        log_info("scene hook: no scene id"); return
    settings = get_settings(gql)
    if settings.get("sceneAutoFill") is False:   # default ON
        log_info("scene hook: autofill disabled"); return
    src = (settings.get("sceneSource") or JAV).strip()
    if not src.startswith("http"):
        log_info("scene hook: sceneSource must be a stash-box URL"); return
    scene = get_scene_full(gql, sid)
    if not scene:
        log_info(f"scene {sid}: not found, skip"); return
    rows = scrape_scene_full(gql, sid, src, scene, settings.get("sceneCodeFallback") is not False)
    if not rows:
        log(f"scene {sid}: no fingerprint match at {src} -> skip")
        log_info(f"scene {sid}: no match, skip"); return
    sc = rows[0]
    scene["__conn__"] = conn
    try:
        upd = apply_scene_fill(gql, sid, scene, sc, src)
        log(f"scene {sid}: filled {sorted(k for k in upd if k != 'id')}")
        log_info(f"scene {sid}: filled {sorted(k for k in upd if k != 'id')}")
    except Exception as e:
        log(f"scene {sid}: fill error: {e}")
        log_info(f"scene {sid}: fill error: {e}")

def handle_scene_backfill(payload, conn, gql):
    """Task: scan all scenes missing the configured stash-box endpoint, look them up by file hash and fill."""
    settings = get_settings(gql)
    src = (settings.get("sceneSource") or JAV).strip()
    if not src.startswith("http"):
        log_info("sceneSource must be a stash-box URL"); return
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
        scene["__conn__"] = conn
        hits = scrape_scene_full(gql, sid, src, scene, settings.get("sceneCodeFallback") is not False)
        if not hits: continue
        try:
            apply_scene_fill(gql, sid, scene, hits[0], src)
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

# ---------- main ----------
def main():
    try:
        payload = json.loads(sys.stdin.read())
    except Exception:
        log_info("no input from stdin"); return
    conn = payload.get("server_connection", {})
    ctx = (payload.get("args", {}) or {}).get("hookContext", {}) or {}
    pid = ctx.get("id")
    htype = ctx.get("type", "")

    gql = make_gql(conn)

    mode = (payload.get("args") or {}).get("mode") or ""
    if mode == "scene_backfill":
        handle_scene_backfill(payload, conn, gql); return

    if "Scene.Create" in htype:
        handle_scene_create(payload, conn, gql); return
    if not pid or "Performer.Create" not in htype:
        log_info("skip: not performer/scene create"); return
    create_input = ctx.get("input") or {}
    from_identify = bool(create_input.get("stash_ids"))

    try:
        perf = get_performer(gql, pid)
    except Exception as e:
        log(f"get_performer error {pid}: {e}"); log_info(f"performer {pid}: fetch error, skip"); return
    if not perf or not perf.get("name"):
        log_info(f"performer {pid}: no name, skip"); return
    name = perf["name"]
    targets = [name] + list(perf.get("alias_list") or [])

    # Settings: per-origin (Identify/manual) source and primary-name policy; match threshold.
    settings = get_settings(gql)
    if from_identify:
        src = settings.get("identifySource")
        use_scraper_name = settings.get("identifyUseScraperName")
        if use_scraper_name is None: use_scraper_name = True   # default: Identify prefers the scraper name
    else:
        src = settings.get("manualSource")
        use_scraper_name = settings.get("manualUseScraperName")
        if use_scraper_name is None: use_scraper_name = False  # default: manual keeps the created name
    source_input = build_source(src)
    try:
        threshold = float(settings.get("threshold"))
        if not (0 < threshold <= 1): threshold = THRESHOLD
    except (TypeError, ValueError):
        threshold = THRESHOLD
    # Per-field overwrite toggles (default all OFF = fill empty only).
    OW_MAP = {"gender":"owGender","birthdate":"owBirthdate","death_date":"owDeathDate","ethnicity":"owEthnicity",
              "country":"owCountry","hair_color":"owHairColor","eye_color":"owEyeColor","fake_tits":"owFakeTits",
              "career_length":"owCareerLength","tattoos":"owTattoos","piercings":"owPiercings","details":"owDetails",
              "height_cm":"owHeight","weight":"owWeight","measurements":"owMeasurements",
              "urls":"owUrls","alias_list":"owAliasList","image":"owImage"}
    ow = {f: bool(settings.get(k)) for f, k in OW_MAP.items()}

    cands = scrape_source(gql, name, source_input)
    if not cands:
        log(f"{pid} '{name}': no candidate ({source_input}) -> skip")
        log_info(f"performer {pid} '{name}': no candidate, skip"); return
    scored = sorted(((match_score(targets, [c.get("name")] + split_aliases(c.get("aliases"))), c)
                     for c in cands), key=lambda x: x[0], reverse=True)
    top_score, top = scored[0]
    if top_score < threshold:
        log(f"{pid} '{name}': best score {top_score:.2f} < {threshold} -> skip")
        log_info(f"performer {pid} '{name}': score {top_score:.2f} too low, skip"); return

    cand_name = (top.get("name") or "").strip()
    prefer_scraper = bool(use_scraper_name) and bool(cand_name) and norm(cand_name) != norm(name)
    ctx_label = "identify" if from_identify else "manual"
    # stash-box endpoint + remote id from the matched candidate (only when source is a stash-box URL)
    cand_ep = (source_input.get("stash_box_endpoint") or "").strip()
    cand_rid = (top.get("remote_site_id") or "").strip()

    try:
        if prefer_scraper:
            dup_id = find_by_name(gql, cand_name, exclude_id=pid)
            if dup_id:
                # duplicate -> merge the new one (pid) into the existing one (dup_id)
                dest = get_performer(gql, dup_id)
                extra = [perf["name"]] + list(perf.get("alias_list") or [])   # carry created name + aliases over
                values = build_update(dest, top, primary_name=dest["name"], extra_aliases=extra, set_name=False, ow=ow)
                sids = union_stash_ids(dest, perf)
                # also carry the matched stash-box id onto the merge destination
                if cand_ep and cand_rid:
                    cur = sids if sids is not None else list(dest.get("stash_ids") or [])
                    merged = add_endpoint_stash_id(cur, cand_ep, cand_rid)
                    if merged is not None: sids = merged
                if sids is not None: values["stash_ids"] = sids
                values["id"] = dup_id   # PerformerUpdateInput requires id (the merge destination)
                performer_merge(gql, [pid], dup_id, values)
                apply_image_async(conn, dup_id, dest, top, overwrite=ow.get("image"))
                log(f"{pid} '{name}' [{ctx_label}]: MERGED into {dup_id} '{dest['name']}' "
                    f"(fields={sorted(values.keys())}, score={top_score:.2f})")
                log_info(f"performer {pid}: merged into {dup_id}"); return
            # no duplicate -> rename to the scraper name (created name kept as alias)
            values = build_update(perf, top, primary_name=cand_name, extra_aliases=[perf["name"]], set_name=True, ow=ow)
            mode = f"{ctx_label}(rename)"
        else:
            # keep the created name as primary; the scraper name becomes an alias
            values = build_update(perf, top, primary_name=name, extra_aliases=[], set_name=False, ow=ow)
            mode = ctx_label
        # carry the matched stash-box id onto this performer if not already set
        if cand_ep and cand_rid:
            new_sids = add_endpoint_stash_id(perf.get("stash_ids"), cand_ep, cand_rid)
            if new_sids is not None:
                values["stash_ids"] = new_sids
        if values:
            performer_update(gql, pid, values)
        apply_image_async(conn, pid, perf, top, overwrite=ow.get("image"))
        log(f"{pid} '{name}' [{mode}]: filled {sorted(values.keys())} (score={top_score:.2f})")
        log_info(f"performer {pid} '{name}': filled {sorted(values.keys())}")
    except Exception as e:
        log(f"{pid} '{name}': apply error {e}")
        log_info(f"performer {pid} '{name}': apply error: {e}")

if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--set-scene-image":
        set_scene_image_mode(sys.argv[2], sys.argv[3])
    elif len(sys.argv) >= 4 and sys.argv[1] == "--set-image":
        set_image_mode(sys.argv[2], sys.argv[3])
    else:
        main()
