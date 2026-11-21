"""SceneBackfill backend.

Fills scenes that carry metadata but no file: capture empty scenes, search
an indexer, push the chosen release to a downloader (or hand it to Whisparr),
then link the finished file back to the original scene with sceneMerge.

Every frontend call goes through runPluginOperation: stdout carries exactly one
JSON line ({"output": ...} or {"error": ...}). Nothing else may be printed to
stdout -- Stash degrades to a raw string the moment a second line appears.
"""

import base64
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

PLUGIN_ID = "SceneBackfill"
PLUGIN_VERSION = "0.1.5"
VIDEO_EXT = (".mp4", ".mkv", ".wmv", ".avi", ".ts", ".m2ts", ".mov", ".flv", ".m4v")
# Video containers plus disc images: the format rule is release-level, so ISO
# has to be visible to it even though it is never selected as a video file.
FORMAT_EXT = VIDEO_EXT + (".iso",)
# qB states in which the file on disk is not yet the final one
QB_BUSY_STATES = (
    "metaDL", "forcedMetaDL", "checkingDL", "checkingUP", "checkingResumeData",
    "allocating", "moving", "queuedDL", "queuedUP",
)


# ─── 日志与结果通道 ──────────────────────────────────────────────────────

def log_warn(msg):
    print(f"\x01w\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)


def log_error(msg):
    print(f"\x01e\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)


def emit_result(obj):
    print(json.dumps({"output": obj}, ensure_ascii=False), flush=True)


def emit_error(msg):
    log_warn(f"error -> {msg[:300]}")
    print(json.dumps({"error": msg}, ensure_ascii=False), flush=True)


def _safe_text(s):
    if not isinstance(s, str):
        return s
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        return s.encode("utf-8", "replace").decode("utf-8")


# ─── 上下文 ──────────────────────────────────────────────────────────────

class Ctx:
    def __init__(self, fragment):
        self.fragment = fragment or {}
        conn = self.fragment.get("server_connection") or {}
        self.scheme = conn.get("scheme") or conn.get("Scheme") or "http"
        host = conn.get("host") or conn.get("Host") or "127.0.0.1"
        if host in ("0.0.0.0", "::", "[::]", ""):
            host = "127.0.0.1"
        self.host = host
        self.port = conn.get("port") or conn.get("Port") or 9999
        self.apikey = conn.get("apikey") or conn.get("ApiKey") or ""
        cookie = conn.get("SessionCookie") or conn.get("sessionCookie") or {}
        cname = cookie.get("name") or cookie.get("Name") or ""
        cvalue = cookie.get("value") or cookie.get("Value") or ""
        self.cookie = f"{cname}={cvalue}" if cname and cvalue else ""
        self.args = self.fragment.get("args") or {}
        self.plugin_dir = os.path.dirname(os.path.abspath(__file__))
        self.lang = str(self.arg("lang", "") or "").strip().lower()

    def arg(self, key, default=""):
        v = self.args.get(key, default)
        if isinstance(v, dict):
            return v.get("str", v.get("int", v.get("bool", default)))
        return v

    @property
    def zh(self):
        return not self.lang.startswith("en")

    def gql(self, query, variables=None):
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.apikey:
            headers["ApiKey"] = self.apikey
        req = urllib.request.Request(
            f"{self.scheme}://{self.host}:{self.port}/graphql",
            data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if body.get("errors"):
            raise RuntimeError(f"GraphQL: {body['errors']}")
        return body.get("data") or {}

    def config(self):
        data = self.gql("query{configuration{plugins}}")
        plugins = ((data.get("configuration") or {}).get("plugins")) or {}
        return plugins.get(PLUGIN_ID) or {}

    def config_dir(self):
        """Stash config dir: the ancestor holding config.yml."""
        p = self.plugin_dir
        for _ in range(5):
            p = os.path.dirname(p)
            if os.path.isfile(os.path.join(p, "config.yml")):
                return p
        return None


def t_(ctx, zh, en):
    return zh if ctx.zh else en


# ─── 状态存储 ────────────────────────────────────────────────────────────

def data_dir(ctx):
    base = ctx.config_dir() or os.path.dirname(ctx.plugin_dir)
    d = os.path.join(base, "plugin-data", PLUGIN_ID)
    os.makedirs(d, exist_ok=True)
    return d


def state_file(ctx):
    return os.path.join(data_dir(ctx), "state.json")


def run_lock_path(ctx):
    return os.path.join(data_dir(ctx), "run.lock")


def daemon_lock_path(ctx):
    return os.path.join(data_dir(ctx), "daemon.lock")


def load_state(ctx):
    p = state_file(ctx)
    if not os.path.isfile(p):
        return {"version": 1, "scenes": {}}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log_warn(f"state unreadable, starting fresh: {e}")
        return {"version": 1, "scenes": {}}
    data.setdefault("version", 1)
    data.setdefault("scenes", {})
    return data


# Two processes write state.json: the page and the background worker. A tick
# runs for up to 45 s on a snapshot taken at its start, so writing that whole
# snapshot back would roll a switch the page saved meanwhile -- the switch
# flips in the UI and is gone one tick later. Each writer therefore owns a few
# top-level keys and re-reads the rest from disk just before writing.
OWN_SCENES = ("scenes", "content", "daemon", "lastCapture", "durOff", "pipeline")
OWN_CONTROL = ("control",)
OWN_RULES = ("rules",)


def save_state(ctx, st, own=OWN_SCENES):
    p = state_file(ctx)
    if os.path.isfile(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                disk = json.load(f)
        except Exception:
            disk = None
        if isinstance(disk, dict):
            for k, v in disk.items():
                if k not in own:
                    st[k] = v
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    # On Windows a concurrent reader blocks replace with WinError 5/32;
    # readers are short-lived page requests, so retry briefly.
    for attempt in range(6):
        try:
            os.replace(tmp, p)
            return
        except OSError as e:
            if attempt == 5 or getattr(e, "winerror", 0) not in (5, 32):
                raise
            time.sleep(0.05 * (attempt + 1))


# ─── 运行锁 ──────────────────────────────────────────────────────────────

class RunLock:
    """Kernel byte lock, non-blocking.

    Never unlink the lock file: a later process would lock a fresh inode while
    the first still holds the old one, which is exactly the double-run this
    exists to prevent. Close the handle instead.
    """

    def __init__(self, path):
        self.path = path
        self.fh = None

    def acquire(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            if not os.path.exists(self.path):
                open(self.path, "ab").close()
            # "a+b" would append every write regardless of seek position.
            fh = open(self.path, "r+b")
        except OSError as e:
            log_warn(f"lock open failed: {e}")
            return False
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self.fh = fh
        return True

    def write_pid(self, pid):
        """Offset 1 MiB: on Windows the byte lock also blocks readers, so the
        pid cannot live in the locked byte itself."""
        if not self.fh:
            return
        try:
            self.fh.seek(1024 * 1024)
            self.fh.write(f"{pid}\n".encode())
            self.fh.flush()
        except OSError:
            pass

    def release(self):
        if not self.fh:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self.fh.close()
        self.fh = None


# ─── 自动化开关 / 守护状态 ───────────────────────────────────────────────

DAEMON_INTERVAL = 90          # seconds between background ticks
DAEMON_STALE = 300            # a heartbeat older than this means it is gone
DAEMON_IDLE_EXIT = 30 * 60    # all switches off and nothing in flight
TICK_BUDGET = 45.0
BACKOFF = (900, 3600, 6 * 3600, 24 * 3600)


def get_control(st):
    c = st.get("control") or {}
    try:
        total = float(c.get("maxTotalGB") or 0)
    except Exception:
        total = 0.0
    try:
        per_day = int(c.get("maxPerDay") or 0)
    except Exception:
        per_day = 0
    # All three start off: a fresh install must not move files until the
    # user turns a switch on.
    return {
        "autoSearch": bool(c["autoSearch"]) if "autoSearch" in c else False,
        "autoPush": bool(c["autoPush"]) if "autoPush" in c else False,
        "autoImport": bool(c["autoImport"]) if "autoImport" in c else False,
        "maxTotalGB": total,
        "maxPerDay": per_day,
    }


def sync_pipeline(ctx, st, cfg=None):
    """Drop records made by the other pipeline after a mode switch.

    `pushed` / `downloaded` in one mode mean nothing in the other (the handle
    is a torrent hash in self, a StashDB id in whisparr), so keeping them only
    produces "lost task" rows. Finished imports are real history and stay.
    """
    cur = pipeline_kind(cfg if cfg is not None else ctx.config())
    prev = str(st.get("pipeline") or "")
    if not prev:
        st["pipeline"] = cur
        save_state(ctx, st)
        return 0
    if prev == cur:
        return 0
    dropped = 0
    for sid in list(st.get("scenes") or {}):
        if (st["scenes"][sid] or {}).get("status") != "imported":
            st["scenes"].pop(sid, None)
            dropped += 1
    st["content"] = {}
    st["pipeline"] = cur
    save_state(ctx, st)
    log_warn(f"pipeline {prev} -> {cur}; dropped {dropped} record(s)")
    return dropped


def set_control(st, args):
    cur = get_control(st)
    # `False or ""` is "" -- which used to mean "not passed", so a switch could
    # be turned on but never off.
    def raw_of(k):
        v = args.get(k, "")
        return "" if v is None else str(v).strip().lower()

    for k in ("autoSearch", "autoPush", "autoImport"):
        v = raw_of(k)
        if v in ("1", "true", "yes", "on"):
            cur[k] = True
        elif v in ("0", "false", "no", "off"):
            cur[k] = False
    for k in ("maxTotalGB", "maxPerDay"):
        raw = raw_of(k)
        if raw:
            try:
                cur[k] = float(raw) if k == "maxTotalGB" else int(float(raw))
            except Exception:
                raise RuntimeError(f"invalid {k}: {raw}")
    st["control"] = cur
    return cur


def daemon_status(st):
    d = st.get("daemon") or {}
    last = int(d.get("lastTick") or 0)
    pid = int(d.get("pid") or 0)
    now = int(time.time())
    # A heartbeat alone is not proof of life: a manual `tick` also stamps one.
    # The worker clears its pid on the way out, so a stale heartbeat plus a
    # pid that is still set means it was killed rather than stopped.
    return {
        "alive": bool(pid and last) and (now - last) < DAEMON_STALE,
        "pid": pid,
        "lastTick": last,
        "ago": (now - last) if last else -1,
        "startedAt": int(d.get("startedAt") or 0),
        "lastAction": d.get("lastAction") or "",
        "stopping": bool(d.get("stopping")),
    }


# 「上次是开着的」单独存一个小文件：state.json 是页面与守护两边都在整份回写的，
# 写进去会被对方更早的快照盖掉（实测手动停之后 want 就消失了）。
def want_file(ctx):
    return os.path.join(data_dir(ctx), "daemon.want")


def get_want(ctx):
    try:
        with open(want_file(ctx), encoding="utf-8") as f:
            return f.read().strip() == "1"
    except OSError:
        return False


def set_want(ctx, on):
    try:
        os.makedirs(data_dir(ctx), exist_ok=True)
        with open(want_file(ctx), "w", encoding="utf-8") as f:
            f.write("1" if on else "0")
    except OSError:
        pass


def pending_bytes(st):
    total = 0
    for rec in (st.get("scenes") or {}).values():
        if rec.get("status") in ("pushed", "downloaded", "importing"):
            total += int(((rec.get("chosen") or {}).get("size")) or 0)
    return total


def gate(st, add_bytes=0):
    """-> (ok, reason). Reason is shown in the UI when the automatic push stops."""
    c = get_control(st)
    limit = c["maxTotalGB"] * 1024 ** 3
    if limit > 0:
        used = pending_bytes(st)
        if used + add_bytes > limit:
            return False, f"{human_size(used)} + {human_size(add_bytes)} > {human_size(limit)}"
    if c["maxPerDay"] > 0:
        since = time.time() - 86400
        n = sum(1 for rec in (st.get("scenes") or {}).values()
                if int(rec.get("pushedAt") or 0) >= since)
        if n >= c["maxPerDay"]:
            return False, f"{n}/{c['maxPerDay']} today"
    return True, ""


def do_control(ctx):
    st = load_state(ctx)
    if str(ctx.arg("save", "") or "").strip().lower() in ("1", "true", "yes"):
        set_control(st, {
            "autoSearch": ctx.arg("autoSearch", ""),
            "autoPush": ctx.arg("autoPush", ""),
            "autoImport": ctx.arg("autoImport", ""),
            "maxTotalGB": ctx.arg("maxTotalGB", ""),
            "maxPerDay": ctx.arg("maxPerDay", ""),
        })
        save_state(ctx, st, own=OWN_CONTROL)
    used = pending_bytes(st)
    limit = get_control(st)["maxTotalGB"] * 1024 ** 3
    return {
        "control": get_control(st),
        "daemon": daemon_status(st),
        "gate": {"used": used, "limit": limit, "open": gate(st)[0],
                 "reason": gate(st)[1]},
    }


# ─── qBittorrent ─────────────────────────────────────────────────────────

class QBError(RuntimeError):
    pass


class QB:
    def __init__(self, cfg):
        self.base = downloader_url(cfg).rstrip("/")
        self.user = _settings_str(cfg, "downloaderUsername")
        self.pw = downloader_key(cfg)
        self.cookie = None
        self.version = ""
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(),
        )

    # -- low level --
    def _req(self, path, data=None, headers=None, timeout=30):
        url = self.base + path
        h = {"Referer": self.base}
        if headers:
            h.update(headers)
        if self.cookie:
            h["Cookie"] = self.cookie
        req = urllib.request.Request(url, data=data, headers=h,
                                     method="POST" if data is not None else "GET")
        try:
            with self.opener.open(req, timeout=timeout) as r:
                body = r.read().decode("utf-8", "replace")
                return r.status, body, r.headers
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace") if e.fp else ""
            return e.code, body, (e.headers or {})

    def login(self):
        if not self.base:
            raise QBError("qBittorrent URL is empty")
        body = urllib.parse.urlencode({"username": self.user, "password": self.pw}).encode()
        status, text, headers = self._req("/api/v2/auth/login", data=body, headers={
            "Content-Type": "application/x-www-form-urlencoded"})
        if status not in (200, 204):
            raise QBError(f"login failed (HTTP {status})")
        if status == 200 and text.strip() and text.strip() != "Ok.":
            raise QBError(f"login rejected: {text.strip()[:80]}")
        for raw in (headers.get_all("Set-Cookie") or []):
            pair = raw.split(";", 1)[0]
            if "=" in pair:
                self.cookie = pair
        if not self.cookie:
            raise QBError("login returned no session cookie")
        self.version = self._req("/api/v2/app/version")[1].strip()
        return self.version

    def api(self, path, data=None):
        status, text, _ = self._req(path, data=data)
        if status != 200:
            raise QBError(f"{path} -> HTTP {status} {text[:80]}")
        return text

    def post(self, path, data):
        return self.api(path, data=urllib.parse.urlencode(data).encode())

    # -- torrents --
    def add_torrent(self, raw_bytes, name, savepath, category, tags, stopped=True):
        boundary = "----SceneBackfill" + base64.b16encode(os.urandom(8)).decode()
        parts = []
        for k, v in (("savepath", savepath), ("category", category), ("tags", tags)):
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                         f'name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8"))
        if stopped:
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                         f'name="stopped"\r\n\r\ntrue\r\n'.encode())
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                     f'name="torrents"; filename="sf.torrent"\r\n'
                     f"Content-Type: application/x-bittorrent\r\n\r\n".encode()
                     + raw_bytes + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        status, text, _ = self._req(
            "/api/v2/torrents/add", data=b"".join(parts),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        if status != 200:
            raise QBError(f"add -> HTTP {status} {text[:80]}")
        try:
            payload = json.loads(text)
        except Exception:
            raise QBError(f"add returned '{text[:80]}'")
        ids = payload.get("added_torrent_ids") or []
        if not ids:
            raise QBError(f"add accepted nothing (failure={payload.get('failure_count')})")
        return ids[0].lower()

    def files(self, h):
        return json.loads(self.api(f"/api/v2/torrents/files?hash={h}"))

    def set_prio(self, h, indexes, priority):
        if not indexes:
            return
        self.post("/api/v2/torrents/filePrio",
                  {"hash": h, "id": "|".join(str(i) for i in indexes), "priority": priority})

    @staticmethod
    def _joined(h):
        """单条或一批都收：qB 的多任务接口吃 `a|b|c`。"""
        return h if isinstance(h, str) else "|".join(h)

    def start(self, h):
        endpoint = "start" if self._new_api() else "resume"
        self.post(f"/api/v2/torrents/{endpoint}", {"hashes": self._joined(h)})

    def stop(self, h):
        endpoint = "stop" if self._new_api() else "pause"
        self.post(f"/api/v2/torrents/{endpoint}", {"hashes": self._joined(h)})

    def delete(self, h, delete_files=False):
        self.post("/api/v2/torrents/delete",
                  {"hashes": self._joined(h), "deleteFiles": "true" if delete_files else "false"})

    def add_magnet(self, magnet, savepath, tags, stopped=True):
        status, text, _ = self._req("/api/v2/torrents/add", data=urllib.parse.urlencode({
            "urls": magnet, "savepath": savepath, "category": "SceneBackfill",
            "tags": tags, "stopped": "true" if stopped else "false"}).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"})
        if status != 200:
            raise QBError(f"add magnet -> HTTP {status}")
        m = re.search(r"btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})", magnet)
        if not m:
            raise QBError("magnet has no infohash")
        h = m.group(1).lower()
        self.start(h)
        return h

    def info(self, hashes=None):
        path = "/api/v2/torrents/info"
        if hashes:
            path += "?hashes=" + "|".join(hashes)
        return json.loads(self.api(path))

    def properties(self, h):
        return json.loads(self.api(f"/api/v2/torrents/properties?hash={h}"))

    def prefs(self):
        return json.loads(self.api("/api/v2/app/preferences"))

    def _new_api(self):
        """qB 5.x dropped pause/resume in favour of stop/start."""
        m = re.match(r"v?(\d+)\.(\d+)", self.version or "")
        if not m:
            return True
        return (int(m.group(1)), int(m.group(2))) >= (5, 0)


# ─── Motrix / aria2 ──────────────────────────────────────────────────────
# aria2 的 JSON-RPC 只有一套接口，桌面版（高级设置里的 RPC 密钥）和 NAS 版
# （Web 端那个密钥，需实测是否等价）用同一个地址：http://host:16800/jsonrpc。
# 它没有 qB 那种「任务哈希」概念，gid 就是任务标识，所以下面的 key 一律是 gid。

ARIA_KEYS = ["gid", "status", "totalLength", "completedLength", "downloadSpeed",
             "uploadSpeed", "numSeeders", "connections", "dir", "errorCode",
             "errorMessage", "files", "bittorrent", "infoHash"]

ARIA_STATE = {
    "active": "downloading",
    "waiting": "queuedDL",
    "paused": "pausedDL",
    "error": "error",
    "complete": "uploading",
    "removed": "removed",
}


class Aria2Error(RuntimeError):
    pass


def _aria_ranges(nums):
    """[1,2,3,5] -> '1-3,5'（aria2 的 select-file 语法）"""
    nums = sorted(set(int(n) for n in nums))
    out, start, prev = [], None, None
    for n in nums:
        if start is None:
            start = prev = n
        elif n == prev + 1:
            prev = n
        else:
            out.append(str(start) if start == prev else f"{start}-{prev}")
            start = prev = n
    if start is not None:
        out.append(str(start) if start == prev else f"{start}-{prev}")
    return ",".join(out)


class Aria2:
    def __init__(self, cfg):
        base = downloader_url(cfg).rstrip("/")
        self.base = base
        self.url = base if base.endswith("/jsonrpc") else base + "/jsonrpc"
        self.secret = downloader_key(cfg)
        self.version = ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, method, params=None):
        if not self.base:
            raise Aria2Error("Motrix URL is empty")
        payload = {"jsonrpc": "2.0", "id": "sf", "method": method,
                   "params": ([f"token:{self.secret}"] if self.secret else []) + list(params or [])}
        req = urllib.request.Request(self.url, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            # aria2 用 400 回非法的 token，正文里才有真正的原因
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            msg = ""
            try:
                msg = str(((json.loads(body) or {}).get("error") or {}).get("message") or "")
            except Exception:
                pass
            raise Aria2Error(msg or f"RPC HTTP {e.code}")
        except Exception as e:
            raise Aria2Error(_safe_text(str(e))[:140])
        if data.get("error"):
            raise Aria2Error(str((data["error"] or {}).get("message") or data["error"])[:160])
        return data.get("result")

    def login(self):
        v = self._call("aria2.getVersion") or {}
        self.version = str(v.get("version") or "")
        return "aria2 " + self.version

    # -- 任务 --
    def add_torrent(self, raw_bytes, name, savepath, category, tags, stopped=True):
        opts = {"pause": "true" if stopped else "false"}
        if savepath:
            opts["dir"] = savepath
        gid = self._call("aria2.addTorrent",
                         [base64.b64encode(raw_bytes).decode(), [], opts])
        return str(gid)

    def add_magnet(self, magnet, savepath, tags, stopped=True):
        opts = {"pause": "false"}
        if savepath:
            opts["dir"] = savepath
        gid = self._call("aria2.addUri", [[magnet], opts])
        return str(gid)

    def _status(self, gid):
        return self._call("aria2.tellStatus", [gid, ARIA_KEYS]) or {}

    def info(self, keys=None):
        out = []
        for gid in (keys or []):
            try:
                out.append(self._row(self._status(gid)))
            except Aria2Error:
                continue          # 任务被删了 / gid 失效，交给上层当 missing
        return out

    def _row(self, t):
        gid = str(t.get("gid") or "")
        bt = t.get("bittorrent") or {}
        name = (bt.get("info") or {}).get("name") or ""
        files = t.get("files") or []
        if not name and files:
            name = posixpath.basename((files[0].get("path") or "").replace("\\", "/"))
        # 暂停中的任务 totalLength 常是 0，文件清单里却有长度
        total = int(t.get("totalLength") or 0) or sum(int(f.get("length") or 0) for f in files)
        done = int(t.get("completedLength") or 0)
        speed = int(t.get("downloadSpeed") or 0)
        status = str(t.get("status") or "")
        return {
            # key 就是 gid：aria2 没有 qB 那种「以 infohash 当句柄」的概念
            "hash": gid,
            "name": _safe_text(name),
            "state": ARIA_STATE.get(status, status),
            "progress": (done / total) if total else 0,
            "size": total,
            "downloaded": done,
            "dlspeed": speed,
            "eta": int((total - done) / speed) if speed and total > done else 0,
            # aria2 只报「当前连上的做种数」，没有群里的总量
            "num_complete": int(t.get("numSeeders") or 0),
            "save_path": t.get("dir") or "",
        }

    def files(self, h):
        t = self._status(h)
        base = (t.get("dir") or "").replace("\\", "/").rstrip("/")
        out = []
        for f in (t.get("files") or []):
            p = (f.get("path") or "").replace("\\", "/")
            rel = p[len(base) + 1:] if base and p.startswith(base + "/") else posixpath.basename(p)
            out.append({
                "index": int(f.get("index") or 0) - 1,     # 对齐 qB 的 0 基
                "name": rel,
                "size": int(f.get("length") or 0),
                "priority": 1 if str(f.get("selected")) == "true" else 0,
            })
        return out

    def set_prio(self, h, indexes, priority):
        """aria2 没有逐文件优先级，只有 select-file 白名单：把要丢的从白名单里剔掉。"""
        if not indexes:
            return
        t = self._status(h)
        all_idx = [int(f.get("index") or 0) for f in (t.get("files") or [])]
        drop = {int(i) + 1 for i in indexes}          # 传进来是 0 基
        keep = [i for i in all_idx if i not in drop]
        if not keep:
            return
        self._call("aria2.changeOption", [h, {"select-file": _aria_ranges(keep)}])

    @staticmethod
    def _gids(h):
        if isinstance(h, str):
            return [x for x in h.split("|") if x]
        return [x for x in h if x]

    def start(self, h):
        for gid in self._gids(h):
            self._call("aria2.unpause", [gid])

    def stop(self, h):
        for gid in self._gids(h):
            self._call("aria2.pause", [gid])

    def delete(self, h, delete_files=False):
        for gid in self._gids(h):
            if not gid:
                continue
            try:
                self._call("aria2.forceRemove" if delete_files else "aria2.remove", [gid])
            except Aria2Error:
                pass
            try:
                self._call("aria2.removeDownloadResult", [gid])
            except Aria2Error:
                pass

    def properties(self, h):
        return {"save_path": self._status(h).get("dir") or ""}

    def prefs(self):
        """aria2 没有独立临时目录：半成品直接写在 dir 里，.aria2 控制文件跟着。"""
        return {"temp_path_enabled": False}


# ─── Motrix Server (NAS / Web build) ──────────────────────────────────────
# 桌面版与 Server 版是两套协议，按探测结果分流，用户只填「地址 + 密钥」：
#   桌面版  POST {base}/jsonrpc              params 里带 token:<rpc-secret>
#   Server  POST {base}/rpc/<kind>/<name>    Authorization: Bearer <operator-token>
# Server 版只收磁力（不收 torrent 字节、没有 select-file），任务句柄是
# taskId(UUID) 而不是 aria2 的 gid。探测各问一次，不做重试：地址填错是配置问题。

class MotrixWebError(Aria2Error):
    pass


def motrix_probe(base, key):
    """返回 ('aria2'|'web', version)。两个端点各问一次即可区分。"""
    if not base:
        return "", ""
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    payload = {"jsonrpc": "2.0", "id": "sf", "method": "aria2.getVersion",
               "params": (["token:" + key] if key else [])}
    try:
        req = urllib.request.Request(base + "/jsonrpc", data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        with op.open(req, timeout=10) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
            v = (obj.get("result") or {}).get("version")
            if v:
                return "aria2", str(v)
    except Exception:
        pass
    try:
        req = urllib.request.Request(base + "/rpc/auth/status",
                                     headers={"Authorization": "Bearer " + key})
        with op.open(req, timeout=10) as r:
            obj = json.loads(r.read().decode("utf-8", "replace"))
            if obj.get("authed"):
                return "web", ""
    except Exception:
        pass
    return "", ""


def torrent_magnet(raw_bytes, title=""):
    """Server 版只收磁力，从下载到的 .torrent 里算出 infohash 拼一个。"""
    data, i = raw_bytes, 0
    if data[i:i + 1] != b"d":
        raise MotrixWebError("invalid torrent")
    i += 1
    info = None
    while data[i:i + 1] != b"e":
        k, i = bdecode(data, i)
        start = i
        _, i = bdecode(data, i)
        if k == b"info":
            info = data[start:i]
    if not info:
        raise MotrixWebError("torrent has no info dict")
    dn = ("&dn=" + urllib.parse.quote(title)) if title else ""
    return "magnet:?xt=urn:btih:" + hashlib.sha1(info).hexdigest() + dn


WEB_STATE = {
    "fetching_metadata": "metaDL",
    "queued": "queuedDL",
    "downloading": "downloading",
    "active": "downloading",
    "paused": "pausedDL",
    "seeding": "uploading",
    "completed": "uploading",
    "complete": "uploading",
    "finished": "uploading",
    "error": "error",
}


class MotrixWeb:
    """Motrix 2 Server 版（NAS / Web UI）的下载器适配。"""

    magnet_only = True

    def __init__(self, cfg):
        self.base = downloader_url(cfg).rstrip("/")
        self.key = downloader_key(cfg)
        self.save_dir = ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, name, args=None):
        if not self.base:
            raise MotrixWebError("Motrix URL is empty")
        if name == "auth:status":
            url, payload, method = self.base + "/rpc/auth/status", None, "GET"
        else:
            kind = name.split(":", 1)[0]
            url = f"{self.base}/rpc/{kind}/{name}"
            payload, method = {"args": args if args is not None else [{}]}, "POST"
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Authorization": "Bearer " + self.key,
                     "Content-Type": "application/json"})
        try:
            with self.opener.open(req, timeout=30) as r:
                body = r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                err = (json.loads(body) or {}).get("error")
            except ValueError:
                err = body[:160]
            raise MotrixWebError(str(err)[:200] if err else f"HTTP {e.code}")
        except Exception as e:
            raise MotrixWebError(_safe_text(str(e))[:140])
        try:
            obj = json.loads(body)
        except ValueError:
            raise MotrixWebError("bad reply: " + body[:120])
        if isinstance(obj, dict) and obj.get("error"):
            raise MotrixWebError(str(obj["error"])[:200])
        return obj

    def login(self):
        if not (self._call("auth:status") or {}).get("authed"):
            raise MotrixWebError("Motrix Web auth failed; check the login key")
        cfg = self._call("query:getSettings") or {}
        self.save_dir = ((cfg.get("app") or {}).get("defaultSaveDir") or "").strip()
        return "server"

    @staticmethod
    def _gids(h):
        if isinstance(h, str):
            return [x for x in h.split("|") if x]
        return [x for x in h if x]

    def add_magnet(self, magnet, savepath, tags, stopped=True):
        task = {"type": "bt", "payload": {"kind": "magnet", "uri": magnet},
                "saveDir": savepath or self.save_dir or "/downloads"}
        r = self._call("command:createTask", [task]) or {}
        if r.get("outcome") == "created":
            return str(r.get("taskId") or "")
        raise MotrixWebError("createTask: " + json.dumps(r)[:160])

    def add_torrent(self, raw_bytes, name, savepath, category, tags, stopped=True):
        return self.add_magnet(torrent_magnet(raw_bytes, name), savepath, tags)

    def _tasks(self):
        r = self._call("query:listTasks", [{}])
        return r if isinstance(r, list) else []

    def _task(self, tid):
        for t in self._tasks():
            if str(t.get("id") or "").lower() == tid.lower():
                return t
        return {}

    def _row(self, t):
        total = int(t.get("totalBytes") or 0) or int(t.get("sizeWhenDone") or 0)
        done = int(t.get("downloadedBytes") or 0)
        speed = int(t.get("downloadSpeed") or 0)
        bt = t.get("bt") or {}
        status = str(t.get("status") or "")
        name = _safe_text(t.get("filename") or t.get("name") or "")
        # before metadata arrives the Server labels the row "[METADATA] magnet:..."
        if name.startswith("[METADATA]"):
            name = name[len("[METADATA]"):].strip()
        return {
            "hash": str(t.get("id") or ""),
            "name": name,
            "state": WEB_STATE.get(status, status),
            "progress": (done / total) if total else 0,
            "size": total,
            "downloaded": done,
            "dlspeed": speed,
            "eta": int(t.get("etaSeconds") or 0),
            "num_complete": int(bt.get("seeds") or bt.get("seedsInSwarm") or 0),
            "save_path": t.get("saveDir") or t.get("finalPath") or "",
        }

    def info(self, keys=None):
        by_id = {str(t.get("id") or "").lower(): t for t in self._tasks()}
        out = []
        for h in (keys or []):
            t = by_id.get(str(h).lower())
            if t:
                out.append(self._row(t))
        return out

    def files(self, h):
        tid = str(h)
        base = (self._task(tid).get("saveDir") or "").replace("\\", "/").rstrip("/")
        r = self._call("query:getTaskFiles", [tid])
        out = []
        for f in (r if isinstance(r, list) else []):
            p = (f.get("path") or "").replace("\\", "/")
            if base and p.startswith(base + "/"):
                p = p[len(base) + 1:]
            out.append({
                "index": int(f.get("index") or 0),   # Server 版是 0 基
                "name": p.lstrip("/") or posixpath.basename(p),
                "size": int(f.get("size") or 0),
                "priority": 1 if f.get("selected") else 0,
            })
        return out

    def set_prio(self, h, indexes, priority):
        """Server 版没有 select-file 通道，整包下载。"""
        return

    def start(self, h):
        for tid in self._gids(h):
            self._call("command:resumeTask", [tid])

    def stop(self, h):
        for tid in self._gids(h):
            self._call("command:pauseTask", [tid])

    def delete(self, h, delete_files=False):
        for tid in self._gids(h):
            self._call("command:removeTask",
                       [{"taskId": tid, "deleteWithFiles": bool(delete_files)}])

    def properties(self, h):
        return {"save_path": self._task(str(h)).get("saveDir") or ""}

    def prefs(self):
        return {"temp_path_enabled": False}


# ─── Whisparr v3 ─────────────────────────────────────────────────────────
# v3 (Eros) knows scenes by their StashDB id and runs its own search, release
# choice and download client. We only add the scene, poll it and scan the file
# Whisparr imported. javstash ids cannot be matched by Whisparr.

class WhisparrError(RuntimeError):
    pass


class Whisparr:
    def __init__(self, cfg):
        base, key = whisparr_cfg(cfg)
        self.base, self.key = base, key
        self.version = ""
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _call(self, method, path, params=None, body=None, timeout=25):
        if not self.base or not self.key:
            raise WhisparrError("Whisparr URL / API key not set")
        url = self.base + "/api/v3/" + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "X-Api-Key": self.key, "Content-Type": "application/json",
            "Accept": "application/json"})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "replace").strip()
        except urllib.error.HTTPError as e:
            raw = ""
            try:
                raw = e.read().decode("utf-8", "replace")
            except Exception:
                pass
            raise WhisparrError(self._err(e.code, raw))
        except Exception as e:
            raise WhisparrError(_safe_text(str(e))[:140])
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            raise WhisparrError("Whisparr returned non-JSON (wrong URL?)")

    @staticmethod
    def _err(status, body):
        if status in (401, 403):
            return "Whisparr rejected the API key"
        detail = ""
        try:
            parsed = json.loads(body)
            if isinstance(parsed, list):
                detail = "; ".join(str((x or {}).get("errorMessage") or "")
                                   for x in parsed[:3] if isinstance(x, dict))
            elif isinstance(parsed, dict):
                detail = str(parsed.get("message") or "")
        except Exception:
            pass
        return "Whisparr HTTP %d: %s" % (status, detail or (body or "")[:120])

    def login(self):
        st = self._call("GET", "system/status") or {}
        self.version = str(st.get("version") or "")
        # v2 is ThePornDB / Sonarr-based and uses a different scene id space.
        if self.version and not re.match(r"^v?3\.", self.version):
            raise WhisparrError("Whisparr v3 (Eros) required, got " + self.version)
        return "Whisparr v" + (self.version or "3")

    def roots(self):
        return [str(x.get("path") or "") for x in
                (self._call("GET", "rootfolder") or []) if isinstance(x, dict) and x.get("path")]

    def profiles(self):
        out = [{"id": int(p["id"]), "name": str(p.get("name") or "")}
               for p in (self._call("GET", "qualityprofile") or [])
               if isinstance(p, dict) and p.get("id") is not None]
        return sorted(out, key=lambda p: p["id"])

    def indexers(self):
        return [str(x.get("name") or "") for x in
                (self._call("GET", "indexer") or [])
                if isinstance(x, dict) and x.get("enable") is not False]

    def find(self, stash_id):
        d = self._call("GET", "movie",
                       {"stashId": urllib.parse.quote(stash_id, safe="")})
        if isinstance(d, list):
            d = d[0] if d else None
        return d if isinstance(d, dict) and d.get("id") else None

    def movies(self):
        """One round trip; keyed by the StashDB id we added the scene with."""
        out = {}
        for m in (self._call("GET", "movie", timeout=40) or []):
            if not isinstance(m, dict):
                continue
            for k in (m.get("stashId"), m.get("foreignId")):
                if k:
                    out[str(k).lower()] = m
        return out

    def queue_map(self):
        d = self._call("GET", "queue", {"pageSize": 1000,
                       "includeMovie": "false", "includeUnknownMovieItems": "true"}) or {}
        recs = d.get("records") if isinstance(d, dict) else d
        out = {}
        for r in recs or []:
            if isinstance(r, dict) and r.get("movieId"):
                out[int(r["movieId"])] = r
        return out

    def add_scene(self, stash_id, title="", year=""):
        have = self.find(stash_id)
        if have:
            return have
        roots = self.roots()
        if not roots:
            raise WhisparrError("Whisparr has no root folder")
        profiles = self.profiles()
        if not profiles:
            raise WhisparrError("Whisparr has no quality profile")
        profile = next((p for p in profiles if p["name"].lower() == "any"), profiles[0])
        payload = {
            "title": title or stash_id,
            "stashId": stash_id, "foreignId": stash_id,
            "monitored": True,
            "qualityProfileId": profile["id"],
            "rootFolderPath": roots[0],
            "addOptions": {"searchForMovie": True},
        }
        if year:
            try:
                payload["year"] = int(str(year)[:4])
            except (TypeError, ValueError):
                pass
        d = self._call("POST", "movie", body=payload)
        if not isinstance(d, dict) or not d.get("id"):
            raise WhisparrError("Whisparr did not return the added movie")
        return d

    def remove(self, movie_id):
        self._call("DELETE", "movie/%d" % int(movie_id),
                   {"deleteFiles": "false", "addImportListExclusion": "false"})


def pipeline_kind(cfg):
    """self: search + push ourselves. whisparr: hand the scene to Whisparr."""
    p = _settings_str(cfg, "pipeline").lower()
    return "whisparr" if p in ("whisparr", "w", "arr", "v3") else "self"


def whisparr_cfg(cfg):
    return (_settings_str(cfg, "whisparrUrl").rstrip("/"),
            _settings_str(cfg, "whisparrApiKey"))


def whisparr_stash_id(rec):
    """Whisparr only knows StashDB scenes; javstash ids produce empty shells."""
    for x in (rec.get("stashIds") or []):
        ep = str(x.get("endpoint") or "").lower()
        xid = str(x.get("stash_id") or "").strip()
        if "stashdb.org" in ep and xid:
            return xid
    return ""


def whisparr_stash_path(cfg, W, path):
    """Translate a Whisparr-side file path into the path Stash can scan."""
    p = (path or "").replace("\\", "/")
    to = _settings_str(cfg, "whisparrStashRoot").replace("\\", "/").rstrip("/")
    if not to:
        return p
    # Whisparr reports its own root; map that prefix onto Stash's name for it.
    roots = W.roots()
    q = (roots[0] if roots else "").replace("\\", "/").rstrip("/")
    return map_path(p, q, to)


def downloader_kind(cfg):
    """Explicit pick made at config time; empty defaults to qBittorrent."""
    if _settings_str(cfg, "downloader").lower() in ("motrix", "aria2", "m"):
        return "motrix"
    return "qb"


def downloader_name(cfg):
    return "Motrix" if downloader_kind(cfg) == "motrix" else "qBittorrent"


def make_downloader(cfg):
    if downloader_kind(cfg) == "qb":
        return QB(cfg)
    kind, _ = motrix_probe(downloader_url(cfg), downloader_key(cfg))
    return MotrixWeb(cfg) if kind == "web" else Aria2(cfg)


# ─── 设置 ────────────────────────────────────────────────────────────────

def downloader_url(cfg):
    return _settings_str(cfg, "downloaderUrl").rstrip("/")


def downloader_key(cfg):
    """qB password / Motrix desktop RPC secret / Motrix Server login key."""
    return _settings_str(cfg, "downloaderKey")


def _settings_str(cfg, key, default=""):
    v = cfg.get(key)
    if v is None:
        return default
    return str(v).strip()


def _truthy(v, default=False):
    if v is None or v == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def net_timeout(cfg, default=120):
    try:
        v = int(_settings_str(cfg, "netTimeout") or default)
    except ValueError:
        v = default
    return max(10, min(600, v))


def settings_view(cfg):
    return {
        "pipeline": pipeline_kind(cfg),
        "indexer": indexer_kind(cfg),
        "indexerUrl": indexer_url(cfg),
        "indexerApiKey": _settings_str(cfg, "indexerApiKey"),
        "downloader": downloader_kind(cfg),
        "downloaderUrl": downloader_url(cfg),
        "downloaderUsername": _settings_str(cfg, "downloaderUsername"),
        "downloaderKey": downloader_key(cfg),
        "whisparrUrl": whisparr_cfg(cfg)[0],
        "whisparrStashRoot": _settings_str(cfg, "whisparrStashRoot"),
        "savePath": _settings_str(cfg, "savePath"),
        "stashPath": _settings_str(cfg, "stashPath"),
    }


# ─── 路径工具 ────────────────────────────────────────────────────────────

def map_path(path, qb_base, stash_base):
    """Translate a qB-side path into the Stash-side path."""
    p = (path or "").replace("\\", "/")
    q = (qb_base or "").replace("\\", "/").rstrip("/")
    if not q or not stash_base:
        return p
    if p == q:
        return stash_base
    if p.startswith(q + "/"):
        return posixpath.join(stash_base.replace("\\", "/"), p[len(q) + 1:])
    return p


def local_path(p):
    return p.replace("/", os.sep) if os.sep == "\\" else p


def rel_url(u):
    """Stash builds absolute media URLs from its own host setting, so a page
    opened from a LAN address would ask 127.0.0.1 for the cover and get
    nothing. Keep the path, drop the origin."""
    if not u:
        return ""
    p = urllib.parse.urlparse(u)
    if p.netloc and p.path.startswith("/"):
        return p.path + ("?" + p.query if p.query else "")
    return u


def human_size(n):
    try:
        n = float(n)
    except Exception:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024


def in_stash_lib(ctx, path):
    """Return the matched library path, or None."""
    try:
        data = ctx.gql("query{configuration{general{stashes{path}}}}")
        stashes = ((data.get("configuration") or {}).get("general") or {}).get("stashes") or []
    except Exception:
        return None
    # normcase: 大小写与分隔符只在 Windows 上归一，Linux 容器里的路径保持区分大小写
    target = os.path.normcase(os.path.normpath(local_path(path or "")))
    for s in stashes:
        root = os.path.normcase(os.path.normpath(local_path(s.get("path") or "")))
        if not root:
            continue
        if target == root or target.startswith(root.rstrip(os.sep) + os.sep):
            return s.get("path")
    return None


def stash_roots(ctx):
    try:
        data = ctx.gql("query{configuration{general{stashes{path}}}}")
        stashes = ((data.get("configuration") or {}).get("general") or {}).get("stashes") or []
        return [s.get("path") for s in stashes if s.get("path")]
    except Exception:
        return []


# ─── 索引器：Jackett / Prowlarr ───────────────────────────────────────────
# 配置阶段二选一，URL 与密钥共用一套字段。

def indexer_url(cfg):
    return _settings_str(cfg, "indexerUrl").rstrip("/")


def indexer_kind(cfg):
    k = _settings_str(cfg, "indexer").lower()
    if k in ("prowlarr", "p"):
        return "prowlarr"
    if k in ("jackett", "j", "torznab"):
        return "jackett"
    return ""


def indexer_mode(cfg):
    base = indexer_url(cfg)
    if not base:
        return "none"
    if indexer_kind(cfg) == "prowlarr":
        return "prowlarr"
    if base.endswith("/api") or "/results/torznab" in base:
        return "torznab"
    return "jackett"


def torznab_url(cfg):
    base = indexer_url(cfg)
    if not base or indexer_mode(cfg) == "prowlarr":
        return ""
    if "/results/torznab" in base or base.endswith("/api"):
        return base
    return base + "/api/v2.0/indexers/all/results/torznab/api"


def prowlarr_api_url(cfg, path):
    """把用户填的地址收成 Prowlarr 的 API 根，再拼上具体路径。"""
    base = indexer_url(cfg)
    for marker in ("/api/v1/search", "/api/v1"):
        i = base.find(marker)
        if i >= 0:
            base = base[:i]
            break
    return base.rstrip("/") + "/api/v1" + path


def _prowlarr_flags(it):
    """indexerFlags 里出现 freeleech 才算免费；没列就等于没这信息。"""
    flags = [str(f).lower() for f in (it.get("indexerFlags") or [])]
    return True if "freeleech" in flags else None


def prowlarr_search(cfg, query, timeout=60):
    key = _settings_str(cfg, "indexerApiKey")
    if not indexer_url(cfg):
        raise RuntimeError("Indexer URL is empty")
    qs = urllib.parse.urlencode({"query": query, "type": "search", "apikey": key})
    req = urllib.request.Request(prowlarr_api_url(cfg, "/search") + "?" + qs,
                                 headers={"User-Agent": f"{PLUGIN_ID}/{PLUGIN_VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    data = json.loads(raw.decode("utf-8", "replace"))
    if isinstance(data, dict):            # 老版本包了一层
        data = data.get("releases") or data.get("results") or []
    out = []
    for it in data:
        if not isinstance(it, dict):
            continue
        title = _safe_text(it.get("title") or "")
        magnet = it.get("magnetUrl") or ""
        infohash = ""
        if magnet:
            m = re.search(r"btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})", magnet)
            if m:
                infohash = m.group(1).lower()
        link = it.get("downloadUrl") or ""
        # Prowlarr 自己生成的下载地址一般已带 apikey，没带的补一个
        if link and "apikey=" not in link.lower():
            link += ("&" if "?" in link else "?") + "apikey=" + urllib.parse.quote(key)
        res = it.get("resolution")
        if isinstance(res, (int, float)) and res:
            res = f"{int(res)}p"
        out.append({
            "title": title,
            "size": int(it.get("size") or 0),
            "link": link,
            "magnet": magnet,
            "infohash": infohash,
            "seeders": int(it.get("seeders") or 0),
            "peers": int(it.get("leechers") or 0),
            "leechers": int(it.get("leechers") or 0),
            "indexer": _safe_text(it.get("indexer") or ""),
            "freeleech": _prowlarr_flags(it),
            "resolution": res or candidate_resolution(title),
            "publishDate": it.get("publishDate") or "",
        })
    return out


def indexer_search(cfg, query, timeout=60):
    if indexer_mode(cfg) == "prowlarr":
        return prowlarr_search(cfg, query, timeout)
    return torznab_search(cfg, query, timeout)


def torznab_search(cfg, query, timeout=60):
    url = torznab_url(cfg)
    key = _settings_str(cfg, "indexerApiKey")
    if not url:
        raise RuntimeError("Indexer URL is empty")
    full = f"{url}?apikey={urllib.parse.quote(key)}&t=search&q={urllib.parse.quote(query)}"
    req = urllib.request.Request(full, headers={"User-Agent": f"{PLUGIN_ID}/{PLUGIN_VERSION}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    root = ET.fromstring(raw)
    out = []
    for item in root.findall("./channel/item"):
        attrs = {}
        for a in item:
            tag = a.tag
            if tag.endswith("attr") or tag.endswith("jackettindexer"):
                attrs[a.get("name") or tag.split("}")[-1]] = a.get("value") or (a.text or "")
        title = item.findtext("title") or ""
        size = item.findtext("size") or "0"
        link = ""
        enc = item.find("enclosure")
        if enc is not None:
            link = enc.get("url") or ""
        if not link:
            link = item.findtext("link") or ""
        magnet = attrs.get("magneturl") or ""
        infohash = (attrs.get("infohash") or "").lower()
        if not infohash and magnet:
            m = re.search(r"btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})", magnet)
            if m:
                infohash = m.group(1).lower()
        out.append({
            "title": _safe_text(title),
            "size": int(size or 0),
            "link": link,
            "magnet": magnet,
            "infohash": infohash,
            "seeders": int(attrs.get("seeders") or 0),
            "peers": int(attrs.get("peers") or 0),
            "leechers": int(attrs.get("peers") or 0),
            "indexer": attrs.get("jackettindexer") or attrs.get("indexer") or "",
            # None = indexer did not report it; a rules engine must not read
            # "no data" as "not freeleech".
            "freeleech": None if not attrs.get("downloadvolumefactor")
            else attrs.get("downloadvolumefactor") in ("0", "0.0"),
            "resolution": candidate_resolution(title),
            "publishDate": item.findtext("pubDate") or "",
        })
    return out


class _MagnetRedirect(urllib.request.HTTPRedirectHandler):
    """跟着 http(s) 跳转走，只把 magnet 跳转拦下来交给调用方。
    索引器的下载地址经常 302 到别处（Prowlarr 的 /download 就常这样）。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if (newurl or "").startswith("magnet:"):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_torrent(link, timeout=60):
    """Download a .torrent. Returns (bytes, None) or (None, magnet_url)."""
    if not link:
        return None, None
    if link.startswith("magnet:"):
        return None, link
    opener = urllib.request.build_opener(_MagnetRedirect, urllib.request.ProxyHandler({}))
    req = urllib.request.Request(link, headers={"User-Agent": f"{PLUGIN_ID}/{PLUGIN_VERSION}"})
    try:
        with opener.open(req, timeout=timeout) as r:
            data = r.read()
            return data, None
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location") or ""
        if e.code in (301, 302, 303, 307) and loc.startswith("magnet:"):
            return None, loc
        raise RuntimeError(f"torrent fetch HTTP {e.code}")


# ─── bencode ─────────────────────────────────────────────────────────────

def bdecode(data, i=0):
    c = data[i:i + 1]
    if c == b"d":
        i += 1
        out = {}
        while data[i:i + 1] != b"e":
            k, i = bdecode(data, i)
            v, i = bdecode(data, i)
            out[k] = v
        return out, i + 1
    if c == b"l":
        i += 1
        out = []
        while data[i:i + 1] != b"e":
            v, i = bdecode(data, i)
            out.append(v)
        return out, i + 1
    if c == b"i":
        j = data.index(b"e", i)
        return int(data[i + 1:j]), j + 1
    j = data.index(b":", i)
    n = int(data[i:j])
    return data[j + 1:j + 1 + n], j + 1 + n


def torrent_stats(raw):
    """File list and size breakdown of a .torrent. Single-file torrents have
    no 'files' key -- they are one implicit file named after info.name."""
    meta, _ = bdecode(raw)
    info = meta.get(b"info") or {}
    name = (info.get(b"name") or b"").decode("utf-8", "replace")
    files = info.get(b"files")
    if files:
        rows = [
            (("/".join(x.decode("utf-8", "replace") for x in f.get(b"path") or [])),
             int(f.get(b"length") or 0))
            for f in files
        ]
    else:
        length = int(info.get(b"length") or 0)
        rows = [(name, length)] if name else []
    total = sum(n for _, n in rows)
    videos = [(p, n) for p, n in rows if os.path.splitext(p.lower())[1] in VIDEO_EXT]
    video_bytes = sum(n for _, n in videos)
    largest = max((n for _, n in videos), default=0)
    return {
        "name": name,
        "files": [{"path": p, "size": n} for p, n in rows],
        "count": len(rows),
        "total": total,
        "video_count": len(videos),
        "video_bytes": video_bytes,
        "largest_video": largest,
        "video_share": round(video_bytes / total, 3) if total else 0.0,
    }


# ─── 规则 DSL ────────────────────────────────────────────────────────────
#
# One rule per line, all must pass. Three-valued: a rule that cannot be
# judged (magnet candidate, no file list yet) is "unknown", not "fail" --
# otherwise every magnet would be silently dropped before it is ever pushed.

DEFAULT_RULE_TEXT = """seeders >= 1
video_bytes >= 100M
largest_video_share >= 0.2
files !has /\\.(exe|scr|bat|lnk)$/i"""

DEFAULT_FILE_SELECT = r"\.(mp4|mkv|wmv|ts|m2ts|avi|mov|m4v)$"
# Ad filtering belongs to file_min_share: real ads are 0.05-0.7% of the release,
# while domain tags like "489155.com@" sit on the main video itself.
DEFAULT_FILE_EXCLUDE = r"(^|/)samples?/"
DEFAULT_FILE_MIN_SHARE = 0.3

NUM_FIELDS = {"size", "seeders", "leechers", "filecount", "video_bytes",
              "largest_video", "largest_video_share"}
# `anytext` is the torrent title plus every file name inside it: a blacklist
# word like 乐鱼 usually sits in one file, not in the title, and the whole
# release has to go -- that is a release-level rule, not a file selection.
TEXT_FIELDS = {"title", "indexer", "resolution", "video_name", "files", "anytext",
               "format"}
CONTENT_FIELDS = {"files", "filecount", "video_bytes", "largest_video",
                  "largest_video_share", "video_name"}
ALL_FIELDS = NUM_FIELDS | TEXT_FIELDS | {"freeleech"}

_SIZE_UNITS = {"K": 1024, "M": 1024 ** 2, "G": 1024 ** 3, "T": 1024 ** 4, "P": 1024 ** 5}
_RES_KEYS = (
    ("2160p", ("2160p", "4k", "uhd")),
    ("1080p", ("1080p", "fhd")),
    ("720p", ("720p",)),
    ("480p", ("480p",)),
)
_RES_RANK = {"2160p": 4, "1080p": 3, "720p": 2, "480p": 1, "": 0}

_RULE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(!?in|!?has|!?~|>=|<=|==|!=|>|<)\s*(.+?)\s*$")


def parse_number(raw):
    """``20G`` / ``1.5G`` / ``800M`` / ``3`` -> float. Suffixes are binary units."""
    s = str(raw).strip().strip('"').strip("'")
    m = re.match(r"^([\d.]+)\s*([KMGTPkmgtp])(?:i?B)?$", s)
    if m:
        return float(m.group(1)) * _SIZE_UNITS[m.group(2).upper()]
    return float(s)


def parse_regex(raw):
    """``/x/i`` -> case-insensitive, ``/x/`` -> exact, bare word -> insensitive.
    MULTILINE because ``files`` / ``video_name`` are newline-joined lists --
    without it ``$`` only ever matches the last file in the torrent."""
    s = str(raw).strip()
    if s.startswith("/") and s.endswith("/i") and len(s) > 3:
        return re.compile(s[1:-2], re.I | re.M)
    if s.startswith("/") and s.rfind("/") > 0:
        return re.compile(s[1:s.rfind("/")], re.M)
    return re.compile(s, re.I | re.M)


def parse_rules(text):
    """-> (rules, errors). Errors carry the line number so the editor can point at it."""
    rules, errors = [], []
    for n, line in enumerate((text or "").splitlines(), 1):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        m = _RULE_RE.match(s)
        if not m:
            errors.append({"line": n, "text": s, "error": "syntax"})
            continue
        field, op, raw = m.group(1), m.group(2), m.group(3)
        if field not in ALL_FIELDS:
            errors.append({"line": n, "text": s, "error": f"unknown field: {field}"})
            continue
        op_l = op.lower()
        base = op_l.lstrip("!")
        rule = {"line": n, "text": s, "field": field, "op": op_l, "raw": raw}
        try:
            if base == "in":
                if not (raw.startswith("[") and raw.endswith("]")):
                    raise ValueError("in needs [a, b]")
                rule["value"] = [x.strip().strip('"').strip("'")
                                 for x in raw[1:-1].split(",") if x.strip()]
            elif base in ("has", "~"):
                rule["value"] = parse_regex(raw)
            elif field in NUM_FIELDS:
                rule["value"] = parse_number(raw)
            else:
                rule["value"] = raw.strip().strip('"').strip("'")
        except Exception as e:
            errors.append({"line": n, "text": s, "error": str(e)})
            continue
        if base in (">=", "<=", ">", "<") and field not in NUM_FIELDS:
            errors.append({"line": n, "text": s, "error": f"{op} needs a numeric field"})
            continue
        if base == "has" and field not in TEXT_FIELDS:
            errors.append({"line": n, "text": s, "error": "has needs a text field"})
            continue
        rules.append(rule)
    return rules, errors


def content_key(cand):
    return (cand.get("infohash") or "").lower() or \
        re.sub(r"[^a-z0-9]+", "", (cand.get("title") or "").lower())


def cand_is_magnet(cand, content=None):
    """Only a magnet link is on offer -- no file list to read. The UI labels
    these rows 磁力 so the reason a rule came back unknown is on screen."""
    if content and content.get("magnet"):
        return True
    if content and content.get("files"):
        return False
    return not (cand.get("link") or "").startswith("http")


def detect_resolution(text):
    t = (text or "").lower()
    for name, keys in _RES_KEYS:
        if any(k in t for k in keys):
            return name
    return ""


def candidate_resolution(title, paths=None):
    """Title and file list are judged separately; the lower one wins."""
    a = detect_resolution(title)
    b = detect_resolution(" ".join(paths or [])) if paths else ""
    if a and b:
        return a if _RES_RANK[a] <= _RES_RANK[b] else b
    return a or b


def content_from_torrent(raw):
    st = torrent_stats(raw)
    files = [[f["path"], f["size"]] for f in st["files"]]
    return {
        "files": files,
        "count": st["count"],
        "total": st["total"],
        "video_bytes": st["video_bytes"],
        "largest_video": st["largest_video"],
        "at": int(time.time()),
    }


def _content_ok(content):
    return bool(content) and not content.get("magnet") and not content.get("error")


def _field_value(field, cand, content):
    """-> (value, known). Unknowable combinations stay unknown on purpose."""
    if field == "anytext":
        # Never unknown: the title is always there. The file list only widens
        # what the same rule can match, so a magnet still gets judged on its
        # title instead of landing in "needs a call".
        parts = [cand.get("title") or ""]
        if _content_ok(content):
            parts.extend(p for p, _ in (content.get("files") or []))
        return "\n".join(parts), True
    if field in CONTENT_FIELDS:
        if not _content_ok(content):
            # A magnet carries no file list, so the only size on offer is the
            # whole release. Judge the video-volume rule on that instead of
            # refusing to judge it at all -- a pack still has to be big enough.
            if field == "video_bytes" and content and content.get("magnet"):
                size = float(cand.get("size") or 0)
                return (size, True) if size > 0 else (None, False)
            return None, False
        files = content.get("files") or []
        if field == "files":
            return "\n".join(p for p, _ in files), True
        if field == "video_name":
            return "\n".join(posixpath.basename(p) for p, _ in files
                             if os.path.splitext(p.lower())[1] in VIDEO_EXT), True
        if field == "filecount":
            return float(content.get("count") or 0), True
        if field == "video_bytes":
            return float(content.get("video_bytes") or 0), True
        if field == "largest_video":
            return float(content.get("largest_video") or 0), True
        total = float(content.get("total") or 0)
        return (float(content.get("largest_video") or 0) / total if total else 0.0), True
    if field == "resolution":
        v = cand.get("resolution") or ""
        return v, bool(v)
    if field == "format":
        if _content_ok(content):
            exts = {os.path.splitext(p.lower())[1] for p, _ in (content.get("files") or [])}
            return " ".join(sorted(e.lstrip(".") for e in exts if e in FORMAT_EXT)), True
        m = re.search(r"\.(iso|mp4|mkv|wmv|avi|ts|m2ts|mov|m4v)\b",
                      cand.get("title") or "", re.I)
        if m:
            return m.group(1).lower(), True
        # Disc images often say ISO without a dot; the word alone is enough.
        return ("iso", True) if re.search(r"(?<![a-z])iso(?![a-z])",
                                         cand.get("title") or "", re.I) else (None, False)
    if field == "freeleech":
        v = cand.get("freeleech")
        return v, v is not None
    if field in ("title", "indexer"):
        return cand.get(field) or "", True
    if field in ("size", "seeders", "leechers"):
        return float(cand.get(field) or 0), True
    return None, False


def eval_rule(rule, cand, content):
    """-> 'pass' | 'fail' | 'unknown'."""
    val, known = _field_value(rule["field"], cand, content)
    if not known:
        return "unknown"
    op = rule["op"]
    neg = op.startswith("!")
    base = op.lstrip("!")
    if base == "in":
        if rule["field"] == "format":
            # A release may carry several containers; any listed one matches.
            have = set(str(val).lower().split())
            hit = bool(have & {str(x).lower() for x in rule["value"]})
        else:
            hit = str(val).lower() in [str(x).lower() for x in rule["value"]]
    elif base in ("has", "~"):
        hit = bool(rule["value"].search(str(val)))
    elif base in (">=", "<=", ">", "<"):
        a, b = float(val), float(rule["value"])
        if base == ">=":
            hit = a >= b
        elif base == "<=":
            hit = a <= b
        elif base == ">":
            hit = a > b
        else:
            hit = a < b
    elif base in ("=", "=="):
        if isinstance(val, bool):
            # chained comparison bites: `a == b in c` means `a == b and b in c`
            wanted = str(rule["value"]).strip().lower() in ("true", "1", "yes")
            hit = bool(val) == wanted
        elif rule["field"] in NUM_FIELDS:
            hit = float(val) == float(rule["value"])
        else:
            hit = str(val).strip().lower() == str(rule["value"]).strip().lower()
    else:
        return "unknown"
    return "pass" if hit != neg else "fail"


def eval_candidate(cand, content, parsed):
    """-> (verdict, failed_rule_texts). fail wins over unknown."""
    failed = []
    unknown = False
    for r in parsed:
        v = eval_rule(r, cand, content)
        if v == "fail":
            failed.append(r["text"])
        elif v == "unknown":
            unknown = True
    if failed:
        return "fail", failed
    return ("unknown" if unknown else "pass"), []


def pick_files(entries, rules):
    """entries: [(name, size)] -> (kept, meta). Selection is independent of
    rejection: an ad mp4 inside the release never disqualifies the release."""
    sel = (rules.get("fileSelect") or "").strip()
    exc = (rules.get("fileExclude") or "").strip()
    sel_re = parse_regex(sel) if sel else None
    exc_re = parse_regex(exc) if exc else None
    pool = [e for e in entries if not sel_re or sel_re.search(e[0])]
    kept = [e for e in pool if not (exc_re and exc_re.search(e[0]))]
    share = float(rules.get("fileMinShare") or 0)
    largest = max((e[1] for e in kept), default=0)
    if share > 0 and largest:
        kept = [e for e in kept if e[1] >= largest * share]
    note = ""
    if not kept:
        # Fall back inside the pool first: an over-eager exclude should never
        # end up picking the biggest file in the whole torrent, which is often
        # the very ad the rule was aiming at.
        vids = [e for e in pool if os.path.splitext(e[0].lower())[1] in VIDEO_EXT]
        note = "largest"
        if not vids:
            vids = [e for e in entries if os.path.splitext(e[0].lower())[1] in VIDEO_EXT]
            note = "largest-any"
        if vids:
            kept = [max(vids, key=lambda e: e[1])]
        elif entries:
            kept = list(entries)
            note = "all"
    return kept, {"pool": len(pool), "kept": len(kept), "total": len(entries), "note": note}


def pick_from_content(content, rules):
    kept, meta = pick_files([(p, int(n)) for p, n in content.get("files") or []], rules)
    meta["names"] = [p for p, _ in kept][:8]
    meta["bytes"] = sum(n for _, n in kept)
    return meta


def default_rules():
    return {
        "text": DEFAULT_RULE_TEXT,
        "fileSelect": DEFAULT_FILE_SELECT,
        "fileExclude": DEFAULT_FILE_EXCLUDE,
        "fileMinShare": DEFAULT_FILE_MIN_SHARE,
        "unknown": "ask",
        "preferSuffix": False,
        "preferAdFile": False,
    }


def get_rules(st):
    r = st.get("rules") or {}
    d = default_rules()
    try:
        share = float(r.get("fileMinShare", d["fileMinShare"]))
    except Exception:
        share = d["fileMinShare"]
    return {
        "text": r.get("text", d["text"]),
        "fileSelect": r.get("fileSelect", d["fileSelect"]),
        "fileExclude": r.get("fileExclude", d["fileExclude"]),
        "fileMinShare": share,
        "unknown": (r.get("unknown") or d["unknown"]).lower(),
        "preferSuffix": bool(r.get("preferSuffix", d["preferSuffix"])),
        "preferAdFile": bool(r.get("preferAdFile", d["preferAdFile"])),
    }


def _norm(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def title_score(code, title, date="", want=""):
    """Ranking only -- rules decide pass/fail, this only orders the survivors.
    ``want`` is what was searched for; without it a release name would only be
    compared to itself and every stranger would score the same."""
    t = _norm(title)
    if not t:
        return 0.0
    score = 0.0
    c = _norm(code)
    if c and c in t:
        score += 0.6
    if date and _norm(date) and _norm(date) in t:
        score += 0.2
    w = _norm(want)
    if w and w != c:
        if w in t:
            score += 0.2
        else:
            toks = [x for x in re.split(r"[^a-z0-9]+", (want or "").lower()) if len(x) >= 3]
            if toks:
                score += 0.2 * (sum(1 for x in toks if x in t) / len(toks))
    return round(min(score, 1.0), 2)


# Release-name suffixes: ABC-123-C / -U / -UC are re-uploads of the same scene
# (typically unwatermarked or uncensored). Optional, because on other trackers
# they mean nothing.
SUFFIX_RE = re.compile(r"[-_ ](UC|C|U)(?![A-Za-z0-9])", re.I)
# A "latest address" text file means the uploader kept the pack current.
ADFILE_RE = re.compile(r"最新地址|地址发布", re.I)


def suffix_tag(title):
    m = None
    for m in SUFFIX_RE.finditer(title or ""):
        pass
    return (m.group(1).upper() if m else "")


def rank_score(code, date, cand, content, rules, want=""):
    """Ranking only. Rules decide pass/fail; this decides which of the
    survivors the automatic push takes, so the optional preferences live here
    and not in the rule text."""
    score = title_score(code, cand.get("title") or "", date, want)
    if rules.get("preferSuffix") and suffix_tag(cand.get("title")):
        score += 0.25
    # Only a real file list can prove the note is inside the release, so a
    # magnet never earns this bonus.
    if rules.get("preferAdFile") and _content_ok(content):
        names = "\n".join(p for p, _ in (content.get("files") or []))
        if ADFILE_RE.search(names):
            score += 0.3
    return round(score, 3)


# ─── 自检 ────────────────────────────────────────────────────────────────

def do_selftest(ctx):
    cfg = ctx.config()
    s = settings_view(cfg)
    if pipeline_kind(cfg) == "whisparr":
        return do_selftest_whisparr(ctx, cfg, s)
    checks = []
    disk = {}

    def add(key, label_zh, label_en, ok, detail, hint=""):
        checks.append({"key": key, "label": t_(ctx, label_zh, label_en),
                       "ok": bool(ok), "detail": detail, "hint": hint})

    # 1. 下载器
    qb_ver, qb_err = "", ""
    dname = downloader_name(cfg)
    try:
        dlc = make_downloader(cfg)
        qb_ver = f"{dname} {dlc.login()}"
        add("qb", "下载器", "Downloader", True, qb_ver)
    except Exception as e:
        qb_err = str(e)
        add("qb", "下载器", "Downloader", False, qb_err,
            t_(ctx, "检查下载器地址与凭据", "Check the downloader URL and credentials"))

    # 2. 双目录：下载器侧用于定位与换算，Stash 侧用于扫描
    sp = s["savePath"]
    if not sp:
        add("savePath", "下载目录（下载器侧）", "Download folder (downloader side)", False,
            t_(ctx, "未填写", "empty"),
            t_(ctx, "填写下载器视角的完成目录（qB / Motrix 里看到的路径）",
               "Set the finished-download folder as the downloader sees it"))
    else:
        add("savePath", "下载目录（下载器侧）", "Download folder (downloader side)", True, sp)

    dl = s["stashPath"]
    dl_ok = bool(dl) and os.path.isdir(local_path(dl))
    if not dl:
        add("downloadPath", "下载目录（Stash 侧）", "Download folder (Stash side)", False,
            t_(ctx, "未填写", "empty"),
            t_(ctx, "填写同一目录在 Stash 里的路径", "Set the same folder as Stash sees it"))
    elif not dl_ok:
        add("downloadPath", "下载目录（Stash 侧）", "Download folder (Stash side)", False,
            t_(ctx, "目录不存在", "not found"),
            t_(ctx, "确认该目录已挂载进 Stash 容器", "Make sure the folder is mounted into Stash"))
    else:
        add("downloadPath", "下载目录（Stash 侧）", "Download folder (Stash side)", True, dl)

    # 3. auto import scans the finished file where it lies, so the download
    #    folder has to be inside a library; only checked when that step will run.
    st = load_state(ctx)
    ctrl = get_control(st)
    if ctrl["autoImport"]:
        roots = stash_roots(ctx)
        if not dl:
            add("libraryPath", "库路径", "Library path", False,
                t_(ctx, "下载目录未填", "download path missing"),
                t_(ctx, "自动入库要扫描下载目录，先填 Stash 侧下载目录",
                   "Auto import scans the download folder; set its Stash-side path first"))
        elif not sp:
            add("libraryPath", "库路径", "Library path", False,
                t_(ctx, "下载器侧目录未填", "downloader-side path missing"),
                t_(ctx, "先填下载器侧目录，插件才能把文件路径换算到 Stash",
                   "Set the downloader-side path first; the file path cannot be translated without it"))
        elif not in_stash_lib(ctx, dl):
            add("libraryPath", "库路径", "Library path", False,
                t_(ctx, "下载目录不在库路径内", "download folder is outside the library"),
                t_(ctx, "把下载目录加进库路径；库路径：" + ", ".join(roots[:4]),
                   "Add the download folder to a library path; library paths: " + ", ".join(roots[:4])))
        else:
            # in-place scanning means qB's partial files must stay outside the
            # library, otherwise half-written files get scanned as scenes too
            ok, detail = _check_temp_outside_lib(ctx, cfg, roots)
            add("libraryPath", "库路径", "Library path", ok, detail,
                t_(ctx, "qB 的临时目录必须开启且不在库路径内",
                   "qB temp folder must be enabled and outside the library"))

    # 4. free space where the downloads land
    if dl_ok:
        try:
            du = shutil.disk_usage(local_path(dl))
            add("space", "可用空间", "Free space", True, human_size(du.free))
            # 前端拿这两个数算「占总量多少」，别让它去解析上面的文字
            disk = {"free": int(du.free), "total": int(du.total)}
        except Exception:
            add("space", "可用空间", "Free space", True, "-")
    else:
        add("space", "可用空间", "Free space", True, "-")

    # 5. 索引器：caps / indexer 列表是最便宜的一次请求，不用占搜索配额
    if indexer_mode(cfg) == "none":
        add("jackett", "索引器", "Indexer", False,
            t_(ctx, "未填写", "empty"),
            t_(ctx, "填 Jackett 或 Prowlarr 地址与 API Key",
               "Fill in the Jackett or Prowlarr URL and API key"))
    else:
        ok, detail = _probe_indexer(cfg)
        add("jackett", "索引器", "Indexer", ok, detail,
            t_(ctx, "确认 Jackett / Prowlarr 在运行，API Key 正确",
               "Check that Jackett / Prowlarr is up and the API key is right"))

    # 6. the background worker has no page session to inherit
    if any((ctrl["autoSearch"], ctrl["autoPush"], ctrl["autoImport"])):
        # Same resolution order the worker uses, otherwise this check fails
        # while the worker is in fact authenticating fine.
        if resolve_apikey(ctx):
            add("apiKey", "后台认证", "Background auth", True,
                t_(ctx, "守护进程可登录 Stash", "worker can authenticate"))
        else:
            add("apiKey", "后台认证", "Background auth", False,
                t_(ctx, "没有 API Key", "no API key"),
                t_(ctx, "设置 → 安全 → API Key，填进插件设置",
                   "Settings -> Security -> API Key, then paste it into the plugin settings"))

    return {
        "checks": checks,
        "ok": all(c["ok"] for c in checks),
        "settings": {k: v for k, v in s.items() if k not in ("downloaderKey",)},
        "hasPassword": bool(s["downloaderKey"]),
        "version": PLUGIN_VERSION,
        "qbVersion": qb_ver,
        "downloader": downloader_kind(cfg),
        "pipeline": "self",
        "disk": disk,
    }


def do_selftest_whisparr(ctx, cfg, s):
    """Whisparr owns the search and the downloader; check what Stash can see."""
    checks = []
    disk = {}
    ver = ""

    def add(key, label_zh, label_en, ok, detail, hint=""):
        checks.append({"key": key, "label": t_(ctx, label_zh, label_en),
                       "ok": bool(ok), "detail": detail, "hint": hint})

    W = Whisparr(cfg)
    try:
        ver = W.login()
        add("qb", "Whisparr", "Whisparr", True, ver)
    except Exception as e:
        add("qb", "Whisparr", "Whisparr", False, _safe_text(str(e))[:160],
            t_(ctx, "检查 Whisparr 地址与 API Key", "Check the Whisparr URL and API key"))

    # Whisparr imports into its root folder; Stash has to see that same folder.
    root = s["whisparrStashRoot"]
    if not root:
        try:
            roots = W.roots()
            root = roots[0] if roots else ""
        except Exception:
            root = ""
    exists = bool(root) and os.path.isdir(local_path(root))
    if not root:
        add("downloadPath", "Whisparr 根目录", "Whisparr root folder", False,
            t_(ctx, "未读到", "not found"),
            t_(ctx, "Whisparr 里加一个根目录；路径不同名时填 Stash 视角路径",
               "Add a root folder in Whisparr; set the Stash-side path if it differs"))
    elif not exists:
        add("downloadPath", "Whisparr 根目录", "Whisparr root folder", False,
            t_(ctx, "Stash 看不到这个目录", "Stash cannot see this folder"),
            t_(ctx, "检查路径映射与 Stash 的挂载", "Check the path mapping and Stash's mounts"))
    else:
        add("downloadPath", "Whisparr 根目录", "Whisparr root folder", True, root)

    lib_roots = stash_roots(ctx)
    if exists:
        if not in_stash_lib(ctx, root):
            add("libraryPath", "库路径", "Library path", False,
                t_(ctx, "不在库路径内", "not inside a library path"),
                t_(ctx, "库路径：" + ", ".join(lib_roots[:4]),
                   "Library paths: " + ", ".join(lib_roots[:4])))
        else:
            ok, detail = _probe_write(root)
            add("libraryPath", "库路径", "Library path", ok, detail,
                t_(ctx, "确认 Stash 对该目录有写权限", "Check write access"))
        try:
            du = shutil.disk_usage(local_path(root))
            disk = {"free": int(du.free), "total": int(du.total)}
            add("space", "可用空间", "Free space", True, human_size(du.free))
        except Exception:
            add("space", "可用空间", "Free space", True, "-")
    else:
        add("libraryPath", "库路径", "Library path", False,
            t_(ctx, "根目录不可用", "root folder unavailable"))
        add("space", "可用空间", "Free space", True, "-")

    try:
        names = W.indexers()
        if names:
            add("jackett", "索引器", "Indexer", True,
                "%d · %s" % (len(names), ", ".join(names[:3])))
        else:
            add("jackett", "索引器", "Indexer", False,
                t_(ctx, "Whisparr 里没有启用的索引器", "No enabled indexer in Whisparr"),
                t_(ctx, "在 Whisparr 里加索引器，或接 Prowlarr",
                   "Add an indexer in Whisparr, or link Prowlarr"))
    except Exception as e:
        add("jackett", "索引器", "Indexer", False, _safe_text(str(e))[:160],
            t_(ctx, "确认 Whisparr 在运行", "Check that Whisparr is up"))

    st = load_state(ctx)
    ctrl = get_control(st)
    if any((ctrl["autoSearch"], ctrl["autoPush"], ctrl["autoImport"])):
        if resolve_apikey(ctx):
            add("apiKey", "后台认证", "Background auth", True,
                t_(ctx, "守护进程可登录 Stash", "worker can authenticate"))
        else:
            add("apiKey", "后台认证", "Background auth", False,
                t_(ctx, "没有 API Key", "no API key"),
                t_(ctx, "设置 → 安全 → API Key，填进插件设置",
                   "Settings -> Security -> API Key, then paste it into the plugin settings"))

    return {
        "checks": checks,
        "ok": all(c["ok"] for c in checks),
        "settings": {k: v for k, v in s.items() if k not in ("downloaderKey",)},
        "hasPassword": bool(s["downloaderKey"]),
        "version": PLUGIN_VERSION,
        "qbVersion": ver,
        "downloader": downloader_kind(cfg),
        "pipeline": "whisparr",
        "disk": disk,
    }


def _probe_write(path):
    probe = os.path.join(local_path(path), ".sf_probe")
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return True, path
    except Exception as e:
        return False, str(e)[:120]


def _probe_indexer(cfg):
    """最便宜的一次调用：Jackett 用 t=caps，Prowlarr 用 /api/v1/indexer 列表。
    两者都能验证地址 + 密钥，又不占用索引器的搜索配额。"""
    key = _settings_str(cfg, "indexerApiKey")
    if indexer_mode(cfg) == "prowlarr":
        full = prowlarr_api_url(cfg, "/indexer") + "?apikey=" + urllib.parse.quote(key)
        try:
            req = urllib.request.Request(full, headers={"User-Agent": f"{PLUGIN_ID}/{PLUGIN_VERSION}"})
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read()
            data = json.loads(raw.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            return False, f"HTTP {e.code}"
        except Exception as e:
            return False, _safe_text(str(e))[:120]
        if not isinstance(data, list):
            return False, "unexpected reply: not a list"
        return True, f"Prowlarr · {len(data)} indexers"
    url = torznab_url(cfg)
    full = f"{url}?apikey={urllib.parse.quote(key)}&t=caps"
    try:
        req = urllib.request.Request(full, headers={"User-Agent": f"{PLUGIN_ID}/{PLUGIN_VERSION}"})
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read()
        root = ET.fromstring(raw)
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except Exception as e:
        return False, _safe_text(str(e))[:120]
    if not root.tag.endswith("caps"):
        return False, f"unexpected reply: {root.tag.split('}')[-1]}"
    n = len(root.findall(".//category"))
    return True, f"Indexers OK · {n} categories"


def _check_temp_outside_lib(ctx, cfg, roots):
    try:
        dlc = make_downloader(cfg)
        dlc.login()
        prefs = dlc.prefs()
    except Exception as e:
        return False, str(e)[:120]
    if downloader_kind(cfg) == "motrix":
        # Motrix 没有独立临时目录，半成品和成品同一个 dir，这条检查不适用
        return True, t_(ctx, "Motrix 无独立临时目录，半成品会写在下载目录",
                        "Motrix has no separate temp dir; partial files land in the download folder")
    if not prefs.get("temp_path_enabled"):
        return False, t_(ctx, "qB 未开启临时目录，半成品会直写下载目录",
                         "temp_path is off; partial files land in the download folder")
    temp = prefs.get("temp_path") or ""
    dl = _settings_str(cfg, "stashPath")
    mapped = map_path(temp, _settings_str(cfg, "savePath"), dl)
    cand = os.path.normcase(os.path.normpath(local_path(mapped)))
    for root in roots:
        r = os.path.normcase(os.path.normpath(local_path(root)))
        if cand == r or cand.startswith(r.rstrip(os.sep) + os.sep):
            return False, t_(ctx, "qB 临时目录在库路径内，半成品会被扫进库",
                             "temp_path sits inside the library; partial files get scanned")
    return True, f"temp={temp}"


# ─── 捕获 ────────────────────────────────────────────────────────────────

CAPTURE_QUERY = """
query($n: Int) {
  findScenes(scene_filter: {file_count: {value: 0, modifier: EQUALS}},
             filter: {per_page: $n, sort: "created_at", direction: DESC}) {
    count
    scenes {
      id title code details date created_at rating100 organized
      paths { screenshot }
      studio { name }
      performers { name }
      tags { name }
      stash_ids { endpoint stash_id }
    }
  }
}
"""

# Stash 只在文件上带时长（Scene 已没有 duration 字段），补档场景恰好没有文件。
# stash-box 那条记录仍有时长，所以按 stash_id 回原站点取一次，取到就写进状态。
DURATION_PER_PASS = 40
DURATION_BATCH = 20


def _stash_boxes(ctx):
    """endpoint -> apikey, from Stash's own config (the plugin has no such setting)."""
    cfg_dir = ctx.config_dir()
    if not cfg_dir:
        return {}
    txt = ""
    for name in ("config.yml", "config.yaml"):
        p = os.path.join(cfg_dir, name)
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    txt = f.read()
            except OSError:
                txt = ""
            break
    if not txt:
        return {}
    m = re.search(r"(?m)^stash_boxes:[ \t]*\n((?:[ \t]+.*\n?)+)", txt)
    if not m:
        return {}
    boxes, cur = {}, {}
    for line in m.group(1).splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("- "):
            if cur.get("endpoint") and cur.get("apikey"):
                boxes[cur["endpoint"]] = cur["apikey"]
            cur = {}
            s = s[2:].strip()
        k, sep, v = s.partition(":")
        if sep:
            cur[k.strip()] = v.strip().strip("'\"")
    if cur.get("endpoint") and cur.get("apikey"):
        boxes[cur["endpoint"]] = cur["apikey"]
    return boxes


def fetch_durations(ctx, want, st, budget=DURATION_PER_PASS):
    """want: [(scene_id, endpoint, stash_id)] -> {scene_id: seconds}.

    One request carries several aliases, so twenty scenes cost one round trip.
    A missing duration only costs a badge, so a failure stays silent -- and
    turns the lookup off for half an hour, otherwise every capture would wait
    on a site that is not answering.
    """
    if not want:
        return {}
    off = st.get("durOff") if isinstance(st.get("durOff"), dict) else {}
    boxes = _stash_boxes(ctx)
    if not boxes:
        return {}
    by_ep = {}
    for sid, ep, xid in want[:budget]:
        if ep in boxes and time.time() - int(off.get(ep) or 0) > 1800:
            by_ep.setdefault(ep, []).append((sid, xid))
    out = {}
    for ep, items in by_ep.items():
        for i in range(0, len(items), DURATION_BATCH):
            chunk = items[i:i + DURATION_BATCH]
            parts, variables = [], {}
            for j, (_sid, xid) in enumerate(chunk):
                variables["i%d" % j] = xid
                parts.append("a%d: findScene(id: $i%d) { duration }" % (j, j))
            head = "query(" + ", ".join("$i%d: ID!" % j for j in range(len(chunk))) + ")"
            try:
                data = _post_json(ep, {"query": head + " { " + " ".join(parts) + " }",
                                       "variables": variables},
                                  {"Content-Type": "application/json", "ApiKey": boxes[ep]},
                                  timeout=6)
            except Exception as e:
                log_warn(f"duration lookup failed on {ep}: {_safe_text(str(e))[:120]}")
                off[ep] = int(time.time())
                st["durOff"] = off
                return out
            for j, (sid, _xid) in enumerate(chunk):
                sec = ((data or {}).get("data") or {}).get("a%d" % j) or {}
                sec = sec.get("duration")
                if sec:
                    out[sid] = int(round(float(sec)))
    return out


def _post_json(url, payload, headers, timeout=10):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def do_capture(ctx):
    st = load_state(ctx)
    sync_pipeline(ctx, st)
    limit = int(ctx.arg("limit", 300) or 300)
    # One round trip only: the page is waiting on this call, so the rest of the
    # durations fill in on later passes.
    total, scenes = capture_scenes(ctx, st, limit, dur_budget=DURATION_BATCH)
    save_state(ctx, st)
    counts = {}
    for s in scenes:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    return {"total": total, "scenes": scenes, "counts": counts}


def capture_scenes(ctx, st, limit=300, dur_budget=DURATION_PER_PASS):
    """Refresh the empty-scene list and fold it into state. Returns (total, rows)."""
    data = ctx.gql(CAPTURE_QUERY, {"n": limit})
    node = data.get("findScenes") or {}
    keep = []
    for s in node.get("scenes") or []:
        sid = str(s.get("id"))
        rec = st["scenes"].setdefault(sid, {"id": sid, "status": "captured"})
        if s.get("code"):
            rec["code"] = s["code"]
        if s.get("title"):
            rec["title"] = s["title"]
        if s.get("date"):
            rec["date"] = s["date"]
        if s.get("details"):
            rec["details"] = s["details"]
        if s.get("rating100"):
            rec["rating"] = s["rating100"]
        if s.get("organized"):
            rec["organized"] = True
        names = [t.get("name") for t in (s.get("tags") or []) if t.get("name")]
        if names:
            rec["tags"] = names[:12]
        shot = rel_url((s.get("paths") or {}).get("screenshot") or "")
        if shot:
            rec["shot"] = shot
        ids = [{"endpoint": (x.get("endpoint") or "").strip(),
                "stash_id": (x.get("stash_id") or "").strip()}
               for x in (s.get("stash_ids") or [])
               if (x.get("endpoint") or "").strip() and (x.get("stash_id") or "").strip()]
        if ids:
            rec["stashIds"] = ids
        status = rec.get("status") or "captured"
        if status == "imported":
            continue
        # Records written before the rules drove the status carry no screening
        # summary; judge them now so the Results tab never lists a scene with
        # nothing passing.
        if rec.get("candidates") and not rec.get("screen") and status not in (
                "pushed", "downloaded", "importing", "ignored"):
            screen_scene(st, sid)
            status = rec.get("status") or status
        keep.append((sid, s, rec, status))

    want = []
    for sid, s, rec, _status in keep:
        if rec.get("duration"):
            continue
        for x in (s.get("stash_ids") or []):
            ep = (x.get("endpoint") or "").strip()
            xid = (x.get("stash_id") or "").strip()
            if ep and xid:
                want.append((sid, ep, xid))
                break
    for sid, sec in fetch_durations(ctx, want, st, dur_budget).items():
        st["scenes"][sid]["duration"] = sec

    scenes = []
    for sid, s, rec, status in keep:
        scenes.append({
            "id": sid,
            "code": rec.get("code") or "",
            "title": rec.get("title") or "",
            "date": rec.get("date") or "",
            "duration": int(rec.get("duration") or 0),
            "details": rec.get("details") or "",
            "rating": int(rec.get("rating") or 0),
            "organized": bool(rec.get("organized")),
            "tags": rec.get("tags") or [],
            "shot": rel_url(rec.get("shot") or ""),
            "createdAt": s.get("created_at") or "",
            "studio": ((s.get("studio") or {}).get("name") or ""),
            "performers": [p.get("name") for p in (s.get("performers") or [])],
            "status": status,
            "attempts": int(rec.get("attempts") or 0),
            "searchedAt": int(rec.get("searchedAt") or 0),
            "nextSearchAt": next_search_at(rec) if status in ("no_result", "captured") else 0,
            "screen": rec.get("screen") or None,
            "candidates": rec.get("candidates") or [],
            "chosen": rec.get("chosen") or None,
            "error": rec.get("error") or "",
        })
    return node.get("count") or 0, scenes


def _id_list(v):
    """A multi-select arrives either as a list or as one comma-joined string."""
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, dict):
        return _id_list(v.get("str") or v.get("list") or "")
    s = str(v or "").strip()
    return [x.strip() for x in s.split(",") if x.strip()]


def do_ignore(ctx):
    st = load_state(ctx)
    if str(ctx.arg("action", "") or "").strip().lower() == "restore_all":
        n = 0
        for rec in st["scenes"].values():
            if rec.get("status") == "ignored":
                rec["status"] = "captured"
                n += 1
        if n:
            save_state(ctx, st)
        return {"ok": True, "count": n}
    ids = _id_list(ctx.arg("ids"))
    if ids:
        restore = str(ctx.arg("restore", "") or "").strip().lower() in ("1", "true", "yes")
        n = 0
        for sid in ids:
            rec = st["scenes"].get(sid)
            if not rec:
                continue
            rec["status"] = "captured" if restore else "ignored"
            n += 1
        if n:
            save_state(ctx, st)
        return {"ok": True, "count": n, "status": "captured" if restore else "ignored"}
    sid = str(ctx.arg("sceneId"))
    restore = str(ctx.arg("restore", "") or "").strip().lower() in ("1", "true", "yes")
    rec = st["scenes"].setdefault(sid, {})
    rec["status"] = "captured" if restore else "ignored"
    save_state(ctx, st)
    return {"ok": True, "sceneId": sid, "status": rec["status"]}


def do_done(ctx):
    """Forget imported scenes so the Done tab can be emptied.

    Only the record goes: the scene itself now has files, so the next capture
    pass will not pick it up again.
    """
    st = load_state(ctx)
    if str(ctx.arg("action", "") or "").strip().lower() != "clear":
        raise RuntimeError("unknown action")
    ids = set(_id_list(ctx.arg("ids")))
    gone = [sid for sid, rec in st["scenes"].items()
            if rec.get("status") == "imported" and (not ids or sid in ids)]
    for sid in gone:
        st["scenes"].pop(sid, None)
    if gone:
        save_state(ctx, st)
    return {"ok": True, "count": len(gone)}


# ─── 搜索 ────────────────────────────────────────────────────────────────

def search_terms(scene):
    """Queries to try in order, narrowest first.

    A code is a precise key and always wins. Western (stashdb) scenes carry no
    code, so the release name is the fallback; performer and studio are the
    last resort -- public indexers do index those, but matching is then by
    relevance rather than by identity.
    """
    code = (scene.get("code") or "").strip()
    title = " ".join((scene.get("title") or "").split())
    date = (scene.get("date") or "").strip()
    studio = ((scene.get("studio") or {}).get("name") or "").strip()
    stack = []
    for p in (scene.get("performers") or [])[:2]:
        name = (p.get("name") if isinstance(p, dict) else p) or ""
        if name.strip():
            stack.append(name.strip())
    perf = stack
    terms = []

    def add(t):
        t = " ".join(t.split())
        if t and t.lower() not in [x.lower() for x in terms]:
            terms.append(t)

    if code:
        add(code)
    if title:
        add(" ".join(title.split()[:8]))
    if not code:
        if perf:
            add(" ".join(perf) + (" " + date if date else ""))
        if studio:
            add(studio + (" " + date if date else ""))
    return terms[:3]


def do_search(ctx):
    if pipeline_kind(ctx.config()) == "whisparr":
        raise RuntimeError(t_(ctx, "Whisparr 模式下不用搜索", "Search is not used in Whisparr mode"))
    st = load_state(ctx)
    sid = str(ctx.arg("sceneId"))
    status, cands, best = search_scene(ctx, st, sid)
    save_state(ctx, st)
    rec = st["scenes"][sid]
    return {"sceneId": sid, "query": rec.get("query") or "",
            "candidates": cands, "status": status, "bestScore": best,
            "screen": rec.get("screen") or {}}


def screen_scene(st, sid):
    """Judge every candidate against the rules and set the scene's status.

    `matched` means at least one candidate passed every rule, and that is the
    only thing the Results tab shows -- so nothing waits there for a human to
    re-judge what the rules already rejected. A scene whose candidates all
    failed goes back to `no_result` and is retried on the backoff schedule.
    """
    rec = st["scenes"].get(sid) or {}
    rules = get_rules(st)
    parsed, _ = parse_rules(rules["text"])
    cache = st.get("content") or {}
    counts = {"pass": 0, "unknown": 0, "fail": 0}
    for c in rec.get("candidates") or []:
        content = cache.get(content_key(c))
        verdict, failed = eval_candidate(c, content, parsed)
        c["verdict"] = verdict
        # Ranking is re-derived here as well, because the "latest address"
        # preference needs the file list, which only exists after a prefetch.
        c["score"] = rank_score(rec.get("code") or "", rec.get("date") or "",
                                c, content, rules,
                                rec.get("query") or rec.get("title") or "")
        c["tag"] = suffix_tag(c.get("title") or "")
        # Own key: `magnet` already holds the magnet URL and the push path
        # reads it when the .torrent download fails.
        c["isMagnet"] = cand_is_magnet(c, content)
        # Kept so the detail popup can say which rule killed a candidate
        # instead of only that it was killed.
        if failed:
            c["failed"] = failed
        else:
            c.pop("failed", None)
        counts[verdict] = counts.get(verdict, 0) + 1
    if counts["pass"]:
        status = "matched"
    elif counts["unknown"]:
        status = "low_confidence"
    else:
        status = "no_result"
    rec["screen"] = {"pass": counts["pass"], "unknown": counts["unknown"],
                     "fail": counts["fail"], "at": int(time.time())}
    # Never walk a scene backwards once it is on its way into the library.
    if rec.get("status") not in ("pushed", "downloaded", "importing", "imported", "ignored"):
        rec["status"] = status
    return status, counts


def search_scene(ctx, st, sid):
    """Search one scene and record the result. Returns (status, candidates, best)."""
    cfg = ctx.config()
    data = ctx.gql("""
    query($id: ID!) {
      findScene(id: $id) {
        id title code date
        studio { name }
        performers { name }
      }
    }""", {"id": sid})
    scene = data.get("findScene") or {}
    terms = search_terms(scene)
    if not terms:
        raise RuntimeError(t_(ctx, "该场景没有番号也没有标题，无法搜索", "No code or title to search for"))
    code = scene.get("code") or ""
    date = scene.get("date") or ""
    query, results = terms[0], []
    for term in terms:
        query = term
        results = indexer_search(cfg, term, net_timeout(cfg))
        if results:
            break
    # A stranger is worse than nothing: the rules judge size, seeders and file
    # counts, none of which can tell one scene from another, so a release that
    # shares no identity token with what was searched for is dropped here.
    results = [r for r in results
               if title_score(code, r["title"], date, query) > 0] or results
    # dedupe by infohash, keep the healthiest. Magnet-only indexers report no
    # hash, so fall back to a normalised title -- otherwise the same release
    # shows up once per mirror.
    by_hash = {}
    for r in results:
        key = r["infohash"] or re.sub(r"[^a-z0-9]+", "", (r["title"] or "").lower()) or r["link"]
        cur = by_hash.get(key)
        if not cur or r["seeders"] > cur["seeders"]:
            by_hash[key] = r
    cands = sorted(by_hash.values(), key=lambda r: (-r["seeders"], -r["size"]))
    for c in cands:
        c["sizeText"] = human_size(c["size"])
        c["score"] = title_score(code, c["title"], date, query)
        c.pop("verdict", None)
    best = max((c["score"] for c in cands), default=0.0)
    prev = st["scenes"].get(sid) or {}
    rec = st["scenes"].setdefault(sid, {"id": sid})
    rec.update({
        "id": sid,
        "code": code,
        "title": scene.get("title") or "",
        "date": date,
        "query": query,
        "candidates": cands[:40],
        "searchedAt": int(time.time()),
        "attempts": int(prev.get("attempts") or 0) + 1,
        "error": "",
    })
    screen_scene(st, sid)
    return rec["status"], rec["candidates"], best


def next_search_at(rec):
    """no_result retries back off; a hammered indexer bans the whole instance."""
    n = int(rec.get("attempts") or 0)
    if n <= 0:
        return 0
    return int(rec.get("searchedAt") or 0) + BACKOFF[min(n - 1, len(BACKOFF) - 1)]


# ─── 规则与清单预检 ──────────────────────────────────────────────────────

CONTENT_TTL = 45 * 86400
# A failed fetch is kept so a slow indexer is not hit again on every tick, but
# for hours, not weeks: one timeout used to freeze that candidate for 45 days.
ERROR_TTL = 6 * 3600


def do_rules(ctx):
    st = load_state(ctx)
    if str(ctx.arg("save", "") or "").strip().lower() in ("1", "true", "yes"):
        st["rules"] = {
            "text": str(ctx.arg("text", DEFAULT_RULE_TEXT) or ""),
            "fileSelect": str(ctx.arg("fileSelect", DEFAULT_FILE_SELECT) or ""),
            "fileExclude": str(ctx.arg("fileExclude", DEFAULT_FILE_EXCLUDE) or ""),
            "fileMinShare": float(ctx.arg("fileMinShare", DEFAULT_FILE_MIN_SHARE) or 0),
            "unknown": str(ctx.arg("unknown", "ask") or "ask").lower(),
            "preferSuffix": _truthy(ctx.arg("preferSuffix", ""), False),
            "preferAdFile": _truthy(ctx.arg("preferAdFile", ""), False),
        }
        save_state(ctx, st, own=OWN_RULES)
        # Re-judge everything still in flight so the saved rules take effect on
        # the Results tab immediately instead of on the next search. Reload
        # first: the rules are already on disk, and this writer must not push
        # its own older view of the scenes over a tick that just ran.
        st = load_state(ctx)
        for sid, rec in st["scenes"].items():
            if rec.get("status") in ("pushed", "downloaded", "importing", "imported", "ignored"):
                continue
            if rec.get("candidates"):
                screen_scene(st, sid)
        save_state(ctx, st)
    rules = get_rules(st)
    _, errors = parse_rules(rules["text"])
    return {"rules": rules, "errors": errors, "defaults": default_rules()}


def do_prefetch(ctx):
    st = load_state(ctx)
    sid = str(ctx.arg("sceneId"))
    out = prefetch_scene(ctx, st, sid, float(ctx.arg("budget") or net_timeout(ctx.config())),
                         retry=bool(ctx.arg("force")))
    rec = st["scenes"].get(sid) or {}
    # Freshly fetched file lists are only useful once the scene is re-judged.
    if rec.get("candidates") and rec.get("status") not in (
            "pushed", "downloaded", "importing", "imported", "ignored"):
        screen_scene(st, sid)
        out["status"] = rec.get("status")
        out["screen"] = rec.get("screen")
    save_state(ctx, st)
    return out


def prefetch_scene(ctx, st, sid, budget=20, retry=False):
    """Pull .torrent files and cache their file lists. Bounded by a time budget
    so one slow indexer cannot push the operation past the proxy timeout."""
    rec = st["scenes"].get(sid) or {}
    cands = rec.get("candidates") or []
    cache = st.setdefault("content", {})
    now = int(time.time())
    for k in [k for k, v in cache.items()
              if now - int(v.get("at") or 0)
              > (ERROR_TTL if v.get("error") else CONTENT_TTL)]:
        cache.pop(k, None)
    deadline = time.time() + budget
    fetched = 0
    for c in cands:
        k = content_key(c)
        if not k:
            continue
        cached = cache.get(k)
        if cached is not None and not (retry and cached.get("error")):
            continue
        if not c.get("link"):
            cache[k] = {"magnet": True, "at": now}
            continue
        left = deadline - time.time()
        if left < 3:
            break
        try:
            raw, magnet = fetch_torrent(c["link"], timeout=min(40, int(left)))
        except Exception as e:
            cache[k] = {"error": _safe_text(str(e))[:200], "at": now}
            save_state(ctx, st)
            fetched += 1
            continue
        cache[k] = content_from_torrent(raw) if raw else {"magnet": True, "at": now}
        # Persist per torrent: a proxy timeout kills this process mid-round and
        # everything fetched so far would be thrown away.
        save_state(ctx, st)
        fetched += 1
    pending = sum(1 for c in cands if content_key(c) and content_key(c) not in cache)
    return {"sceneId": sid, "fetched": fetched, "cached": len(cache), "pending": pending}


def do_eval_rules(ctx):
    """Dry run: how many candidates each rule kills, and what would be downloaded."""
    st = load_state(ctx)
    sid = str(ctx.arg("sceneId"))
    rules = get_rules(st)
    parsed, errors = parse_rules(rules["text"])
    rec = st["scenes"].get(sid) or {}
    cands = rec.get("candidates") or []
    cache = st.get("content") or {}
    counter = [{"line": r["line"], "text": r["text"], "pass": 0, "fail": 0, "unknown": 0}
               for r in parsed]
    rows = []
    pending = 0
    policy = rules["unknown"]
    for c in cands:
        content = cache.get(content_key(c))
        if content is None:
            pending += 1
        for i, r in enumerate(parsed):
            counter[i][eval_rule(r, c, content)] += 1
        verdict, failed = eval_candidate(c, content, parsed)
        c["verdict"] = verdict
        if verdict == "fail":
            outcome = "reject"
        elif verdict == "unknown":
            outcome = {"allow": "pass", "reject": "reject"}.get(policy, "ask")
        else:
            outcome = "pass"
        row = {
            "title": c.get("title") or "",
            "indexer": c.get("indexer") or "",
            "size": c.get("size") or 0,
            "seeders": c.get("seeders") or 0,
            "score": c.get("score") or 0,
            "resolution": c.get("resolution") or "",
            "verdict": verdict,
            "outcome": outcome,
            "failed": failed[:3],
            "hasContent": _content_ok(content),
            "isMagnet": cand_is_magnet(c, content),
            "error": (content or {}).get("error") or "",
        }
        if _content_ok(content):
            row["select"] = pick_from_content(content, rules)
        rows.append(row)
    save_state(ctx, st)
    return {"sceneId": sid, "code": rec.get("code") or "", "rules": counter,
            "errors": errors, "candidates": rows, "pending": pending,
            "unknown": rules["unknown"]}


# ─── 推送 ────────────────────────────────────────────────────────────────

def do_push(ctx):
    st = load_state(ctx)
    sid = str(ctx.arg("sceneId"))
    idx = int(ctx.arg("index", 0) or 0)
    file_index = str(ctx.arg("fileIndex", "") or "").strip()
    out = push_scene(ctx, st, sid, idx, file_index)
    save_state(ctx, st)
    return out


def push_scene(ctx, st, sid, idx, file_index=""):
    if pipeline_kind(ctx.config()) == "whisparr":
        return whisparr_push_scene(ctx, st, sid)
    cfg = ctx.config()
    s = settings_view(cfg)
    rec = st["scenes"].get(sid) or {}
    cands = rec.get("candidates") or []
    if idx < 0 or idx >= len(cands):
        raise RuntimeError(t_(ctx, "候选不存在", "Candidate not found"))
    cand = cands[idx]

    qb = make_downloader(cfg)
    qb.login()

    torrent_bytes, magnet = None, None
    if cand.get("link"):
        torrent_bytes, magnet = fetch_torrent(cand["link"])
    if getattr(qb, "magnet_only", False):
        # Server 版只收磁力：把 .torrent 换成等价磁力，且整包下载（不能选文件）
        if torrent_bytes and not magnet:
            magnet = torrent_magnet(torrent_bytes, cand["title"])
        torrent_bytes = None
    if not torrent_bytes and not magnet:
        magnet = cand.get("magnet") or ""
    if not torrent_bytes and not magnet:
        raise RuntimeError(t_(ctx, "该候选没有可用的种子或磁力链接", "No torrent or magnet for this candidate"))

    savepath = s["savePath"] or "/downloads"
    tags = f"sf:{sid}"
    rules = get_rules(st)
    if torrent_bytes:
        h = qb.add_torrent(torrent_bytes, cand["title"], savepath, "SceneBackfill", tags, stopped=True)
        # The file list is empty until the metadata is parsed; setting priority
        # before that is silently dropped.
        files = _wait_files(qb, h)
        kept, note = [], ""
        if files:
            manual = next((f for f in files if str(f.get("index")) == file_index), None) if file_index.isdigit() else None
            if manual:
                kept, note = [(manual["name"], int(manual.get("size") or 0))], "manual"
            else:
                kept, meta = pick_files(
                    [(f["name"], int(f.get("size") or 0)) for f in files], rules)
                note = meta["note"]
        picked, picked_size = "all", 0
        if kept:
            names = {n for n, _ in kept}
            qb.set_prio(h, [f["index"] for f in files if f["name"] not in names], 0)
            time.sleep(0.4)
            picked = kept[0][0] if len(kept) == 1 else f"{len(kept)} files"
            picked_size = sum(n for _, n in kept)
        qb.start(h)
    else:
        h = qb.add_magnet(magnet, savepath, tags)
        picked, picked_size, note = "magnet", 0, ""

    rec["chosen"] = {
        "hash": h,
        "title": cand["title"],
        "indexer": cand.get("indexer") or "",
        "size": picked_size or cand.get("size") or 0,
        "magnet": bool(magnet and not torrent_bytes),
        "picked": picked,
        "pickedNote": note,
        "savePath": savepath,
    }
    rec["status"] = "pushed"
    rec["pushedAt"] = int(time.time())
    rec.pop("error", None)
    return {"ok": True, "hash": h, "picked": picked, "sceneId": sid}


def _wait_files(qb, h, timeout=15):
    """Torrents added without metadata report an empty file list; priority
    changes sent before the list exists are dropped without an error."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            fs = qb.files(h)
        except (QBError, Aria2Error):
            fs = []
        if fs:
            return fs
        time.sleep(0.4)
    return []


# ─── 进度 ────────────────────────────────────────────────────────────────

def do_badge(ctx):
    """Counts behind the nav badge: results / downloading / done / pending.

    The nav renders on every Stash page, so this stays a state read -- no qB
    call, no capture, nothing that could take a second. Priority and colour
    are decided by the frontend.
    """
    st = load_state(ctx)
    pipe = pipeline_kind(ctx.config())
    scenes = st["scenes"].values()

    def count(*statuses):
        return sum(1 for rec in scenes if rec.get("status") in statuses)

    return {
        "found": 0 if pipe == "whisparr" else count("matched"),
        "active": count("pushed", "downloaded"),
        "done": count("imported"),
        "pending": count("captured", "no_result", "low_confidence"),
    }


def do_progress(ctx):
    st = load_state(ctx)
    sync_pipeline(ctx, st)
    pipe = pipeline_kind(ctx.config())
    if pipe == "whisparr":
        rows, err, ver = collect_progress_whisparr(ctx, st)
    else:
        rows, err, ver = collect_progress(ctx, st)
    return {
        "torrents": rows,
        "conn": {"ok": not err, "error": err, "qbVersion": ver},
        "daemon": daemon_status(st),
        "control": get_control(st),
        "pipeline": pipe,
    }


def _pushed_rows(st):
    """(scene id, infohash, record) for every scene that has a torrent."""
    out = []
    for sid, rec in st["scenes"].items():
        h = ((rec.get("chosen") or {}).get("hash") or "").lower()
        if h and rec.get("status") != "ignored":
            out.append((sid, h, rec))
    return out


def _inflight_rows(st):
    """Pushed rows that have not been imported yet -- what the bulk buttons act on."""
    return [r for r in _pushed_rows(st) if r[2].get("status") != "imported"]


def collect_progress(ctx, st):
    """Read qB once and advance `pushed -> downloaded`.

    qB is contacted even with nothing in flight: the connection badge must
    reflect reality, not "no torrents to ask about".
    """
    rows_all = _pushed_rows(st)
    hashes = [h for _, h, rec in rows_all if rec.get("status") != "imported"]
    live, err, ver = {}, "", ""
    try:
        qb = make_downloader(ctx.config())
        ver = qb.login()
        if hashes:
            for t in qb.info(hashes):
                live[t["hash"].lower()] = t
    except Exception as e:
        err = _safe_text(str(e))[:200]
    changed = 0
    rows = []
    for sid, rec in st["scenes"].items():
        chosen = rec.get("chosen") or {}
        h = (chosen.get("hash") or "").lower()
        if not h or rec.get("status") == "ignored":
            continue
        status = rec.get("status")
        if status == "imported":
            rows.append({
                "sceneId": sid, "code": rec.get("code") or "", "hash": h,
                "name": chosen.get("title") or "", "state": "done",
                "progress": 1, "size": chosen.get("size") or 0,
                "downloaded": chosen.get("size") or 0, "dlspeed": 0, "eta": 0,
                "seeders": 0, "ready": False, "status": status,
                # 已完成页按天分组要用它；没有它只能全堆在一组里。
                "at": int(rec.get("importedAt") or 0),
            })
            continue
        t = live.get(h)
        if not t:
            rows.append({
                "sceneId": sid, "code": rec.get("code") or "", "hash": h,
                "name": chosen.get("title") or "", "state": "missing",
                "progress": 0, "size": chosen.get("size") or 0,
                "downloaded": 0, "dlspeed": 0, "eta": 0, "seeders": 0,
                "ready": False, "status": status,
            })
            continue
        progress = float(t.get("progress") or 0)
        state = t.get("state") or ""
        ready = progress >= 0.999 and state not in QB_BUSY_STATES
        # `moving` is busy: the file is still being relocated by qB itself.
        if ready and status == "pushed":
            rec["status"] = "downloaded"
            rec.pop("importFails", None)
            rec.pop("nextImportAt", None)
            changed += 1
        rows.append({
            "sceneId": sid,
            "code": rec.get("code") or "",
            "hash": h,
            "name": t.get("name") or chosen.get("title") or "",
            "state": state,
            "progress": round(progress, 4),
            "size": t.get("size") or 0,
            "downloaded": t.get("downloaded") or 0,
            "dlspeed": t.get("dlspeed") or 0,
            "eta": t.get("eta") or 0,
            "seeders": t.get("num_complete") or 0,
            "ready": ready,
            "status": rec.get("status"),
        })
    if changed:
        save_state(ctx, st)
    # The card shows the same cover it showed on the other tabs; an imported
    # scene has dropped out of the capture list, so the row carries it here.
    for r in rows:
        r["shot"] = rel_url((st["scenes"].get(r["sceneId"]) or {}).get("shot") or "")
    return rows, err, ver


# ─── 下载页操作 ──────────────────────────────────────────────────────────

def do_torrent(ctx):
    """pause / resume / remove one pushed torrent, or all of them at once."""
    st = load_state(ctx)
    if pipeline_kind(ctx.config()) == "whisparr":
        return _torrent_whisparr(ctx, st)
    action = str(ctx.arg("action", "") or "").strip().lower()
    ids = _id_list(ctx.arg("ids"))
    if ids or _truthy(ctx.arg("bulk", ""), False):
        return _torrent_bulk(ctx, st, action, ids)
    sid = str(ctx.arg("sceneId"))
    rec = st["scenes"].get(sid) or {}
    chosen = rec.get("chosen") or {}
    h = (chosen.get("hash") or "").lower()
    if not h:
        raise RuntimeError(t_(ctx, "该场景还没有推送记录", "Nothing pushed for this scene"))
    qb = make_downloader(ctx.config())
    qb.login()
    if action == "pause":
        qb.stop(h)
    elif action == "resume":
        qb.start(h)
    elif action == "remove":
        # Keep the torrent's own data: this only drops it from qB's list so the
        # slot is free for another candidate.
        qb.delete(h, delete_files=False)
        rec.pop("chosen", None)
        rec.pop("pushedAt", None)
        rec["status"] = "matched" if rec.get("candidates") else "captured"
        save_state(ctx, st)
    else:
        raise RuntimeError(f"unknown action: {action}")
    return {"ok": True, "sceneId": sid, "action": action, "status": rec.get("status")}


def _torrent_bulk(ctx, st, action, ids=None):
    """One qB round trip for pause/resume all, or forget the missing ones.

    `ids` narrows it to a multi-selected subset; empty means every task.
    """
    rows = _inflight_rows(st)
    if ids:
        wanted = set(ids)
        rows = [r for r in rows if r[0] in wanted]
    if not rows:
        return {"ok": True, "action": action, "count": 0}
    qb = make_downloader(ctx.config())
    qb.login()
    hashes = [h for _, h, _ in rows]
    if action in ("pause", "resume"):
        # qB takes a pipe-separated hash list, so this is a single call.
        if action == "pause":
            qb.stop(hashes)
        else:
            qb.start(hashes)
        return {"ok": True, "action": action, "count": len(hashes)}
    if action == "remove" and ids:
        # Multi-select remove: drop the record so the scene goes back to picking
        # a release; the files on disk stay.
        qb.delete(hashes, delete_files=False)
        for _sid, _h, rec in rows:
            rec.pop("chosen", None)
            rec.pop("pushedAt", None)
            rec["status"] = "matched" if rec.get("candidates") else "captured"
        save_state(ctx, st)
        return {"ok": True, "action": action, "count": len(hashes)}
    if action == "remove_missing":
        # "missing" means qB no longer has the torrent, so the record can never
        # finish on its own. Dropping it puts the scene back in play; nothing is
        # deleted from disk.
        live = {t["hash"].lower() for t in qb.info(hashes)}
        gone = 0
        for sid, h, rec in rows:
            if h in live:
                continue
            rec.pop("chosen", None)
            rec.pop("pushedAt", None)
            rec["status"] = "matched" if rec.get("candidates") else "captured"
            gone += 1
        if gone:
            save_state(ctx, st)
        return {"ok": True, "action": action, "count": gone}
    raise RuntimeError(f"unknown action: {action}")


# ─── 入库 ────────────────────────────────────────────────────────────────

def do_import(ctx):
    st = load_state(ctx)
    sid = str(ctx.arg("sceneId"))
    rec = st["scenes"].get(sid)
    if rec:
        # a manual click always tries now, whatever the backoff says
        rec.pop("nextImportAt", None)
    out = import_scene(ctx, st, sid)
    save_state(ctx, st)
    return out


def import_scene(ctx, st, sid):
    """Scan the finished files where they are, then link them to the scene.

    Nothing is moved: the plugin never touches files. The download folder must
    sit inside a Stash library, otherwise the scan finds nothing to link.
    """
    if pipeline_kind(ctx.config()) == "whisparr":
        return import_scene_whisparr(ctx, st, sid)
    cfg = ctx.config()
    s = settings_view(cfg)
    rec = st["scenes"].get(sid) or {}
    chosen = rec.get("chosen") or {}
    h = (chosen.get("hash") or "").lower()
    if not h:
        raise RuntimeError(t_(ctx, "该场景还没有推送记录", "Nothing pushed for this scene"))

    qb = make_downloader(cfg)
    qb.login()
    info = {t["hash"].lower(): t for t in qb.info([h])}.get(h)
    if not info:
        raise RuntimeError(t_(ctx, "下载器里找不到该任务", "Torrent not found in the downloader"))
    if float(info.get("progress") or 0) < 0.999 or (info.get("state") or "") in QB_BUSY_STATES:
        raise RuntimeError(t_(ctx, "还没下载完", "Download is not finished yet"))

    files = qb.files(h)
    picked = [f for f in files if int(f.get("priority") or 0) > 0 and
              os.path.splitext(f["name"].lower())[1] in VIDEO_EXT]
    if not picked:
        picked = [f for f in files if os.path.splitext(f["name"].lower())[1] in VIDEO_EXT]
    if not picked:
        raise RuntimeError(t_(ctx, "该种子里没有视频文件", "No video file in this torrent"))

    props = qb.properties(h)
    savepath = props.get("save_path") or chosen.get("savePath") or s["savePath"]
    sources = []
    for f in picked:
        qb_path = posixpath.join(savepath.replace("\\", "/"), f["name"])
        cand = map_path(qb_path, s["savePath"], s["stashPath"])
        if not os.path.isfile(local_path(cand)):
            raise RuntimeError(t_(
                ctx, f"下载目录里找不到 {f['name']}，检查路径映射",
                f"{f['name']} not found; check the path mapping"))
        sources.append(cand)

    if [p for p in sources if not in_stash_lib(ctx, p)]:
        raise RuntimeError(t_(
            ctx, "下载目录不在 Stash 库路径内，扫描不到这些文件；把它加进库路径",
            "The download folder is outside a Stash library; add it to a library path"))

    return _link_scanned_files(ctx, st, sid, sources)


def scan_and_find_many(ctx, paths, timeout=90):
    """One scan for all paths, then poll until every path has a file record."""
    if not paths:
        return {}
    ctx.gql("""
    mutation($p: [String!]!) {
      metadataScan(input: {paths: $p, scanGenerateCovers: false,
        scanGeneratePreviews: false, scanGenerateSprites: false,
        scanGeneratePhashes: false, scanGenerateThumbnails: false,
        scanGenerateImagePreviews: false, scanGenerateClipPreviews: false})
    }""", {"p": list(paths)})
    found = {}
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        for p in paths:
            if p in found:
                continue
            try:
                d = ctx.gql("""
                query($p: String!) {
                  findFiles(file_filter: {path: {value: $p, modifier: EQUALS}}) {
                    files { id }
                  }
                }""", {"p": p})
                got = ((d.get("findFiles") or {}).get("files") or [])
                if got:
                    found[p] = str(got[0]["id"])
            except Exception:
                pass
        if len(found) == len(paths):
            break
    return found


# ─── 时钟 ────────────────────────────────────────────────────────────────

MAX_ATTEMPTS = 6
# Import is retried by every tick; a file Stash cannot see (wrong path, outside
# the library) would otherwise be scanned every 90 seconds forever.
IMPORT_RETRY = (60, 300, 900, 3600, 21600)


def import_delay(fails):
    """Seconds before the next try after `fails` failures; None = give up."""
    if fails > len(IMPORT_RETRY):
        return None
    return IMPORT_RETRY[fails - 1]


def import_due(rec, now=None):
    if int(rec.get("importFails") or 0) > len(IMPORT_RETRY):
        return False
    return int(rec.get("nextImportAt") or 0) <= (now or time.time())


def mark_import_fail(rec):
    fails = int(rec.get("importFails") or 0) + 1
    rec["importFails"] = fails
    delay = import_delay(fails)
    rec["nextImportAt"] = int(time.time()) + delay if delay else 0


def do_tick(ctx):
    """One round of automation, driven either by the page or by the worker.

    Both callers share this body and the run lock: when the worker is alive the
    page steps aside, so two writers can never interleave on state.json.
    """
    st = load_state(ctx)
    sync_pipeline(ctx, st)
    ctrl = get_control(st)
    src = str(ctx.arg("source", "page") or "page").strip().lower()
    idle = not any((ctrl["autoSearch"], ctrl["autoPush"], ctrl["autoImport"]))
    if idle:
        return {"ok": True, "idle": True, "actions": [],
                "daemon": daemon_status(st), "control": ctrl}
    if src != "worker" and daemon_status(st)["alive"]:
        return {"ok": True, "skipped": "daemon", "actions": [],
                "daemon": daemon_status(st), "control": ctrl}
    lock = RunLock(run_lock_path(ctx))
    if not lock.acquire():
        return {"ok": True, "skipped": "busy", "actions": [],
                "daemon": daemon_status(st), "control": ctrl}
    try:
        return run_tick(ctx, st, ctrl, src)
    finally:
        lock.release()


def run_tick(ctx, st, ctrl, src):
    if pipeline_kind(ctx.config()) == "whisparr":
        return run_tick_whisparr(ctx, st, ctrl, src)
    deadline = time.time() + TICK_BUDGET
    actions = []

    def left():
        return deadline - time.time()

    # 1. keep the captured list current; a full scene scan is cheap
    if left() > 5 and time.time() - int(st.get("lastCapture") or 0) > 300:
        try:
            capture_scenes(ctx, st)
            st["lastCapture"] = int(time.time())
            actions.append("capture")
        except Exception as e:
            actions.append("capture!:" + _safe_text(str(e))[:80])

    # 2. one qB read drives every pushed scene forward
    try:
        _, qb_err, _ = collect_progress(ctx, st)
        if qb_err:
            actions.append("qb!:" + qb_err[:80])
    except Exception as e:
        actions.append("qb!:" + _safe_text(str(e))[:80])

    # 3. import
    if ctrl["autoImport"]:
        for sid in [s for s, r in st["scenes"].items()
                    if r.get("status") == "downloaded" and import_due(r)]:
            if left() < 25:
                break
            rec = st["scenes"][sid]
            try:
                res = import_scene(ctx, st, sid)
                if res.get("ok"):
                    actions.append("import:" + sid)
                else:
                    mark_import_fail(rec)
                    actions.append("import!:" + sid)
            except Exception as e:
                mark_import_fail(rec)
                rec["error"] = t_(ctx, "入库失败：", "import failed: ") + _safe_text(str(e))[:180]
                actions.append("import!:" + sid)
            save_state(ctx, st)

    # 4. finish screening: a scene waiting on file lists gets them fetched, then
    #    re-judged. Runs regardless of autoPush -- the Results tab has to show
    #    the real verdict even when pushing is off.
    rules = get_rules(st)
    parsed, _ = parse_rules(rules["text"])
    cache = st.setdefault("content", {})
    for sid, rec in list(st["scenes"].items()):
        if rec.get("status") != "low_confidence":
            continue
        if not needs_content(rec, parsed, cache):
            continue
        if left() < 22:
            break
        try:
            prefetch_scene(ctx, st, sid, budget=min(20.0, max(8.0, left() - 12)))
            screen_scene(st, sid)
            actions.append("screen:%s:%s" % (sid, rec.get("status")))
        except Exception as e:
            actions.append("screen!:" + sid)
        save_state(ctx, st)

    # 5. push what the rules approved
    if ctrl["autoPush"]:
        for sid in sorted((s for s, r in st["scenes"].items() if r.get("status") == "matched"),
                          key=lambda s: int(st["scenes"][s].get("searchedAt") or 0)):
            if left() < 20:
                break
            rec = st["scenes"][sid]
            idx = auto_push_pick(rec.get("candidates") or [], cache, parsed, rules["unknown"])
            if idx is None:
                continue
            cand = rec["candidates"][idx]
            ok, reason = gate(st, int(cand.get("size") or 0))
            if not ok:
                actions.append("gate:" + reason)
                break
            try:
                push_scene(ctx, st, sid, idx)
                actions.append("push:" + sid)
            except Exception as e:
                rec["error"] = t_(ctx, "推送失败：", "push failed: ") + _safe_text(str(e))[:180]
                actions.append("push!:" + sid)
            save_state(ctx, st)

    # 6. searches, as many as the budget allows. A round used to do one no
    #    matter how fast the indexer answered, so a fresh library of 50 empty
    #    scenes took 75 minutes to get its first look.
    if ctrl["autoSearch"]:
        for _ in range(5):
            if left() < 20:
                break
            sid = next_search_target(st)
            if not sid:
                break
            rec = st["scenes"][sid]
            try:
                search_scene(ctx, st, sid)
                actions.append("search:%s:%s" % (sid, rec.get("status")))
            except Exception as e:
                rec["error"] = t_(ctx, "搜索失败：", "search failed: ") + _safe_text(str(e))[:180]
                rec["attempts"] = int(rec.get("attempts") or 0) + 1
                rec["searchedAt"] = int(time.time())
                actions.append("search!:" + sid)
            save_state(ctx, st)

    if src == "worker":
        d = st.setdefault("daemon", {})
        d["lastTick"] = int(time.time())
        # One action, not the whole round: the settings line is one short row
        # and a list of every step just gets truncated mid-word.
        d["lastAction"] = (actions[-1] if actions else "")[:120]
    save_state(ctx, st)
    return {"ok": True, "actions": actions, "daemon": daemon_status(st),
            "control": ctrl}


def auto_push_pick(cands, cache, parsed, policy):
    """Index of the best candidate the rules let through without asking.

    Unknown stays unpushable unless the policy is `allow`: an automatic push of
    something nobody could judge is exactly what the ask policy exists to stop.
    """
    best_i, best_key = None, None
    for i, c in enumerate(cands):
        verdict, _ = eval_candidate(c, cache.get(content_key(c)), parsed)
        if verdict == "fail":
            continue
        if verdict == "unknown" and policy != "allow":
            continue
        key = (c.get("score") or 0, c.get("seeders") or 0)
        if best_key is None or key > best_key:
            best_i, best_key = i, key
    return best_i


def needs_content(rec, parsed, cache):
    """True when a content rule exists but some candidate has no file list yet."""
    if not any(r["field"] in CONTENT_FIELDS for r in parsed):
        return False
    return any(content_key(c) not in cache for c in (rec.get("candidates") or []))


def next_search_target(st):
    now = int(time.time())
    retry = []
    for sid, rec in st["scenes"].items():
        if not (rec.get("code") or rec.get("title")):
            continue
        status = rec.get("status")
        attempts = int(rec.get("attempts") or 0)
        if status == "captured":
            # A scene that has never been tried goes first; one whose search
            # threw has its attempts bumped, so it waits like any other miss.
            if not attempts:
                return sid
            if now >= next_search_at(rec):
                retry.append((attempts, sid))
        elif status == "no_result" and attempts < MAX_ATTEMPTS:
            at = next_search_at(rec)
            if now >= at:
                retry.append((attempts, sid))
        elif status == "low_confidence":
            # Candidates exist but nothing could be judged (magnet-only, or no
            # file list). Re-check once a day: new releases do keep appearing.
            at = int(rec.get("searchedAt") or 0) + BACKOFF[-1]
            if now >= at:
                retry.append((attempts + 1, sid))
    if retry:
        retry.sort()
        return retry[0][1]
    return None


# ─── 守护进程开关 ────────────────────────────────────────────────────────

WORKER_SCRIPT = "SceneBackfillWorker.py"


def resolve_apikey(ctx):
    """The worker is a separate process, so it needs its own credential.

    `runPluginOperation` does not always hand the plugin an api key; fall back
    to the one Stash already wrote into its own config.
    """
    if ctx.apikey:
        return ctx.apikey
    cfg_dir = ctx.config_dir()
    if not cfg_dir:
        return ""
    for name in ("config.yml", "config.yaml"):
        p = os.path.join(cfg_dir, name)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                txt = f.read()
        except OSError:
            continue
        m = re.search(r"(?m)^\s{0,4}api_?key\s*:\s*[\"']?([^\"'\s#]+)", txt)
        if m:
            return m.group(1)
    return ""


def start_worker(ctx, st):
    conn = {"scheme": ctx.scheme, "host": ctx.host, "port": ctx.port,
            "apikey": resolve_apikey(ctx)}
    script = os.path.join(ctx.plugin_dir, WORKER_SCRIPT)
    if not os.path.isfile(script):
        raise RuntimeError(f"missing {WORKER_SCRIPT}")
    kwargs = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": ctx.plugin_dir,
        "close_fds": True,
    }
    if os.name == "nt":
        # DETACHED_PROCESS keeps the worker alive after this plugin call returns.
        kwargs["creationflags"] = 0x00000008 | 0x08000000
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen([sys.executable, script, json.dumps(conn)], **kwargs)
    started = int(time.time())
    d = st.setdefault("daemon", {})
    d["pid"] = proc.pid
    d["startedAt"] = started
    set_want(ctx, True)
    # `stopping` is deliberately left alone: the outgoing worker only sees it
    # while its own pid is still in state, and it clears the block on exit.
    # Backdated so only a heartbeat written by the worker itself can pass the
    # check below.
    d["lastTick"] = started - 5
    d["lastAction"] = "starting"
    save_state(ctx, st)

    # A detached child that dies at once (missing module, dead API key) would
    # otherwise look alive to the UI for a full stale window.
    deadline = time.time() + 4
    while time.time() < deadline:
        time.sleep(0.5)
        fd = load_state(ctx).get("daemon") or {}
        if int(fd.get("pid") or 0) == proc.pid and int(fd.get("lastTick") or 0) >= started:
            return proc.pid
        if proc.poll() is not None:
            # Do not leave the pid we optimistically wrote: the UI would show a
            # worker that is not there until the stale window expires. want is
            # cleared too, otherwise every page load would retry a start that
            # already failed.
            fd = load_state(ctx)
            fd["daemon"] = {"pid": 0, "lastTick": 0, "stoppedAt": int(time.time())}
            save_state(ctx, fd)
            set_want(ctx, False)
            raise RuntimeError(t_(ctx, "守护进程启动后立刻退出，见 worker.log",
                                  "worker exited right after start, see worker.log"))
    return proc.pid


def daemon_lock_free(ctx):
    """The daemon lock is the only honest answer to "is a worker out there".
    Acquire-and-release: a copy that lost the race exits on its own, but it
    would have overwritten the healthy pid on the way out."""
    lk = RunLock(daemon_lock_path(ctx))
    ok = lk.acquire()
    if ok:
        lk.release()
    return ok


def do_worker(ctx):
    st = load_state(ctx)
    action = str(ctx.arg("action", "status") or "status").strip().lower()
    if action == "start":
        stt = daemon_status(st)
        if stt["alive"]:
            # Starting a second copy just loses the lock race, so say what is
            # actually happening instead of reporting a failure.
            return {"ok": True, "daemon": stt,
                    "note": "stopping" if stt["stopping"] else "already running"}
        pid = start_worker(ctx, st)
        return {"ok": True, "daemon": daemon_status(st), "pid": pid}
    if action == "auto":
        # 只有「上次是开着的」才拉起来：用户手动停的、空闲自退的都不算。
        stt = daemon_status(st)
        if stt["alive"]:
            if not get_want(ctx):
                set_want(ctx, True)   # 老版本起的守护没有这个标记，正在跑就先记账
            return {"ok": True, "daemon": stt, "revived": False}
        if not get_want(ctx) or stt["stopping"] or not daemon_lock_free(ctx):
            return {"ok": True, "daemon": stt, "revived": False}
        pid = start_worker(ctx, st)
        return {"ok": True, "daemon": daemon_status(st), "pid": pid, "revived": True}
    if action == "stop":
        d = st.setdefault("daemon", {})
        d["stopping"] = True
        set_want(ctx, False)
        # Leaving the heartbeat alone lets the UI say "stopping" instead of
        # flipping to "stopped" while the worker is still finishing a tick.
        save_state(ctx, st)
        return {"ok": True, "daemon": daemon_status(st)}
    return {"ok": True, "daemon": daemon_status(st), "control": get_control(st)}


# ─── 入口 ────────────────────────────────────────────────────────────────

# ─── Whisparr pipeline ───────────────────────────────────────────────────
# In whisparr mode the whole "search -> screen -> push to qB/Motrix" half is
# skipped. A captured scene is handed to Whisparr, polled, and the file it
# imported is scanned and linked back. No candidates, no rules, no moving.

def whisparr_push_scene(ctx, st, sid):
    rec = st["scenes"].get(sid) or {}
    xid = whisparr_stash_id(rec)
    if not xid:
        raise RuntimeError(t_(ctx, "这条场景没有 StashDB ID，Whisparr 认不出",
                              "This scene has no StashDB ID, Whisparr cannot match it"))
    W = Whisparr(ctx.config())
    W.login()
    movie = W.add_scene(xid, rec.get("title") or rec.get("code") or "",
                        rec.get("date") or "")
    mf = movie.get("movieFile") or {}
    rec["chosen"] = {
        "hash": xid,
        "movieId": movie.get("id"),
        "title": rec.get("title") or rec.get("code") or xid,
        "indexer": "Whisparr",
        "size": int(mf.get("size") or 0),
        "magnet": False,
        "picked": "whisparr",
    }
    rec["status"] = "pushed"
    rec["pushedAt"] = int(time.time())
    rec.pop("error", None)
    return {"ok": True, "hash": xid, "picked": "whisparr", "sceneId": sid}


def _whisparr_row(h, m, q):
    """Turn a Whisparr movie (+ its queue record) into a qB-shaped row."""
    mf = m.get("movieFile") or {}
    has = bool(m.get("hasFile"))
    size = int(mf.get("size") or 0)
    total = size or (int(q.get("size") or 0) if q else 0)
    left = int(q.get("sizeleft") or 0) if q else 0
    done = total if has else (total - left if q and total and left < total else 0)
    progress = 1.0 if has else ((done / total) if total else 0)
    state = "uploading" if has else ("downloading" if q else "queuedDL")
    return {
        "hash": h,
        "name": m.get("title") or "",
        "state": state,
        "progress": progress,
        "size": total,
        "downloaded": done,
        "dlspeed": 0,
        "eta": 0,
        "num_complete": 0,
    }


def collect_progress_whisparr(ctx, st):
    """One Whisparr read drives pushed -> downloaded; row shape matches qB."""
    rows_all = _pushed_rows(st)
    wanted = {h for _, h, rec in rows_all if rec.get("status") != "imported"}
    live, err, ver = {}, "", ""
    try:
        W = Whisparr(ctx.config())
        ver = W.login()
        if wanted:
            movies = W.movies()
            queues = W.queue_map()
            for h in wanted:
                m = movies.get(h)
                if not m:
                    continue
                live[h] = _whisparr_row(h, m, queues.get(int(m.get("id") or 0)))
    except Exception as e:
        err = _safe_text(str(e))[:200]
    changed = 0
    rows = []
    for sid, rec in st["scenes"].items():
        chosen = rec.get("chosen") or {}
        h = (chosen.get("hash") or "").lower()
        if not h or rec.get("status") == "ignored":
            continue
        status = rec.get("status")
        if status == "imported":
            rows.append({
                "sceneId": sid, "code": rec.get("code") or "", "hash": h,
                "name": chosen.get("title") or "", "state": "done",
                "progress": 1, "size": chosen.get("size") or 0,
                "downloaded": chosen.get("size") or 0, "dlspeed": 0, "eta": 0,
                "seeders": 0, "ready": False, "status": status,
                "at": int(rec.get("importedAt") or 0),
            })
            continue
        t = live.get(h)
        if not t:
            rows.append({
                "sceneId": sid, "code": rec.get("code") or "", "hash": h,
                "name": chosen.get("title") or "", "state": "missing",
                "progress": 0, "size": chosen.get("size") or 0,
                "downloaded": 0, "dlspeed": 0, "eta": 0, "seeders": 0,
                "ready": False, "status": status,
            })
            continue
        progress = float(t.get("progress") or 0)
        state = t.get("state") or ""
        ready = progress >= 0.999 and state not in QB_BUSY_STATES
        if ready and status == "pushed":
            rec["status"] = "downloaded"
            rec.pop("importFails", None)
            rec.pop("nextImportAt", None)
            changed += 1
        rows.append({
            "sceneId": sid, "code": rec.get("code") or "", "hash": h,
            "name": t.get("name") or chosen.get("title") or "",
            "state": state, "progress": round(progress, 4),
            "size": t.get("size") or 0, "downloaded": t.get("downloaded") or 0,
            "dlspeed": t.get("dlspeed") or 0, "eta": t.get("eta") or 0,
            "seeders": t.get("num_complete") or 0,
            "ready": ready, "status": rec.get("status"),
        })
    if changed:
        save_state(ctx, st)
    for r in rows:
        r["shot"] = rel_url((st["scenes"].get(r["sceneId"]) or {}).get("shot") or "")
    return rows, err, ver


def import_scene_whisparr(ctx, st, sid):
    """Whisparr already imported the file; scan it in place, never move it."""
    cfg = ctx.config()
    rec = st["scenes"].get(sid) or {}
    xid = (rec.get("chosen") or {}).get("hash") or ""
    if not xid:
        raise RuntimeError(t_(ctx, "该场景还没有推送记录", "Nothing pushed for this scene"))
    W = Whisparr(cfg)
    W.login()
    movie = W.find(xid)
    if not movie:
        raise RuntimeError(t_(ctx, "Whisparr 里找不到该场景", "Scene not found in Whisparr"))
    mf = movie.get("movieFile") or {}
    if not movie.get("hasFile") or not mf.get("path"):
        raise RuntimeError(t_(ctx, "Whisparr 还没导入文件", "Whisparr has not imported the file yet"))
    target = whisparr_stash_path(cfg, W, mf["path"])
    if not os.path.isfile(local_path(target)):
        raise RuntimeError(t_(ctx, f"找不到 {target}，检查 Whisparr 根目录映射",
                              f"{target} not found; check the root folder mapping"))
    return _link_scanned_files(ctx, st, sid, [target])


def _link_scanned_files(ctx, st, sid, targets):
    """Scan the finished files, then merge the scenes Stash made onto the
    original empty scene. Shared by the downloader and Whisparr pipelines."""
    rec = st["scenes"].get(sid) or {}
    found = scan_and_find_many(ctx, targets)
    missing = [p for p in targets if p not in found]
    if missing:
        rec["error"] = t_(ctx, f"扫描后仍缺 {len(missing)} 个文件",
                          f"{len(missing)} file(s) still missing after scan")
        save_state(ctx, st)
        if not found:
            return {"ok": False, "error": rec["error"]}
    ids = list(found.values())
    owner = ctx.gql("""
    query($ids: [ID!]!) {
      findFiles(ids: $ids) { files { id path ... on VideoFile { scenes { id } } } }
    }""", {"ids": ids})
    entries = ((owner.get("findFiles") or {}).get("files") or [])
    new_scenes, attached = [], 0
    for e in entries:
        scene_ids = [str(x.get("id")) for x in (e.get("scenes") or [])]
        if sid in scene_ids:
            attached += 1
        elif scene_ids:
            new_scenes.append(scene_ids[0])
    new_scenes = sorted(set(new_scenes))
    merged = False
    assigned = False
    if new_scenes:
        ctx.gql("""
        mutation($src: [ID!]!, $dst: ID!) {
          sceneMerge(input: {source: $src, destination: $dst}) { id }
        }""", {"src": new_scenes, "dst": sid})
        merged = True
    elif not attached and ids:
        ctx.gql("""
        mutation($sid: ID!, $fid: ID!) {
          sceneAssignFile(input: {scene_id: $sid, file_id: $fid}) { id }
        }""", {"sid": sid, "fid": ids[0]})
        assigned = True
    # How the file reached the scene, so a failure report can say which way it
    # went instead of just "imported".
    link = "merge" if merged else ("assign" if assigned else ("attached" if attached else "none"))
    check = ctx.gql("query($id: ID!){findScene(id: $id){id files{id path}}}", {"id": sid})
    files_now = (check.get("findScene") or {}).get("files") or []
    rec["status"] = "imported" if files_now else "downloaded"
    rec["importedAt"] = int(time.time())
    rec["file"] = {"id": ids[0] if ids else "", "count": len(files_now),
                   "paths": [f["path"] for f in files_now][:8]}
    rec["merged"] = merged
    rec["link"] = link
    if files_now:
        rec.pop("error", None)
        rec.pop("importFails", None)
        rec.pop("nextImportAt", None)
    else:
        rec["error"] = t_(ctx, "合并后原场景仍无文件", "Original scene still has no file")
    return {"ok": bool(files_now), "status": rec["status"], "files": len(files_now),
            "merged": merged, "link": link, "error": rec.get("error") or ""}


def run_tick_whisparr(ctx, st, ctrl, src):
    deadline = time.time() + TICK_BUDGET
    actions = []

    def left():
        return deadline - time.time()

    # 1. keep the captured list current
    if left() > 5 and time.time() - int(st.get("lastCapture") or 0) > 300:
        try:
            capture_scenes(ctx, st)
            st["lastCapture"] = int(time.time())
            actions.append("capture")
        except Exception as e:
            actions.append("capture!:" + _safe_text(str(e))[:80])

    # 2. one Whisparr read drives every pushed scene forward
    try:
        _, w_err, _ = collect_progress_whisparr(ctx, st)
        if w_err:
            actions.append("whisparr!:" + w_err[:80])
    except Exception as e:
        actions.append("whisparr!:" + _safe_text(str(e))[:80])

    # 3. import: scan the file Whisparr placed, do not move it
    if ctrl["autoImport"]:
        for sid in [s for s, r in st["scenes"].items()
                    if r.get("status") == "downloaded" and import_due(r)]:
            if left() < 25:
                break
            rec = st["scenes"][sid]
            try:
                res = import_scene_whisparr(ctx, st, sid)
                if res.get("ok"):
                    actions.append("import:" + sid)
                else:
                    mark_import_fail(rec)
                    actions.append("import!:" + sid)
            except Exception as e:
                mark_import_fail(rec)
                rec["error"] = t_(ctx, "入库失败：", "import failed: ") + _safe_text(str(e))[:180]
                actions.append("import!:" + sid)
            save_state(ctx, st)

    # 4. autoPush: hand captured scenes to Whisparr (no candidates, no rules)
    if ctrl["autoPush"]:
        for sid in sorted(s for s, r in st["scenes"].items() if r.get("status") == "captured"):
            if left() < 20:
                break
            rec = st["scenes"][sid]
            if not whisparr_stash_id(rec):
                if not rec.get("error"):
                    rec["error"] = t_(ctx, "没有 StashDB ID，Whisparr 认不出",
                                      "No StashDB ID; Whisparr cannot match it")
                    actions.append("skip:" + sid)
                continue
            ok, reason = gate(st, 0)
            if not ok:
                actions.append("gate:" + reason)
                break
            try:
                whisparr_push_scene(ctx, st, sid)
                actions.append("push:" + sid)
            except Exception as e:
                rec["error"] = t_(ctx, "推送失败：", "push failed: ") + _safe_text(str(e))[:180]
                actions.append("push!:" + sid)
            save_state(ctx, st)

    if src == "worker":
        d = st.setdefault("daemon", {})
        d["lastTick"] = int(time.time())
        d["lastAction"] = (actions[-1] if actions else "")[:120]
    save_state(ctx, st)
    return {"ok": True, "actions": actions, "daemon": daemon_status(st),
            "control": ctrl}


def _torrent_whisparr(ctx, st):
    """Pause/resume = monitored off/on; remove = drop the movie, keep files."""
    action = str(ctx.arg("action", "") or "").strip().lower()
    ids = _id_list(ctx.arg("ids"))
    bulk = _truthy(ctx.arg("bulk", ""), False)
    sid = str(ctx.arg("sceneId", "") or "")
    rows = _inflight_rows(st)
    if ids:
        wanted = set(ids)
        rows = [r for r in rows if r[0] in wanted]
    elif sid:
        rows = [r for r in rows if r[0] == sid]
    elif not bulk:
        rows = []
    if not rows:
        return {"ok": True, "action": action, "count": 0}
    W = Whisparr(ctx.config())
    W.login()
    if action in ("pause", "resume"):
        raise RuntimeError(t_(ctx, "Whisparr 自己管下载，去 Whisparr 里暂停",
                              "Whisparr manages downloads; pause it there"))
    if action in ("remove", "remove_missing"):
        if action == "remove_missing":
            have = W.movies()
            targets = [r for r in rows if r[1] not in have]
        else:
            targets = rows
        for _s, _h, rec in targets:
            mid = int((rec.get("chosen") or {}).get("movieId") or 0)
            if mid:
                try:
                    W.remove(mid)
                except Exception:
                    pass
            rec.pop("chosen", None)
            rec.pop("pushedAt", None)
            rec.pop("error", None)
            rec["status"] = "captured"
        if targets:
            save_state(ctx, st)
        return {"ok": True, "action": action, "count": len(targets)}
    raise RuntimeError("unknown action: " + action)


OPS = {
    "selftest": do_selftest,
    "capture": do_capture,
    "badge": do_badge,
    "search": do_search,
    "push": do_push,
    "progress": do_progress,
    "import": do_import,
    "ignore": do_ignore,
    "done": do_done,
    "rules": do_rules,
    "prefetch": do_prefetch,
    "eval_rules": do_eval_rules,
    "control": do_control,
    "tick": do_tick,
    "worker": do_worker,
    "torrent": do_torrent,
}


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        emit_error("no input")
        return
    frag = json.loads(raw)
    ctx = Ctx(frag)
    mode = str(ctx.arg("mode", "") or "").strip()
    handler = OPS.get(mode)
    if not handler:
        emit_error(f"unknown mode: {mode}")
        return
    try:
        emit_result(handler(ctx))
    except Exception as e:
        log_error(traceback.format_exc())
        emit_error(_safe_text(str(e)))


if __name__ == "__main__":
    main()
