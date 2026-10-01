"""
stashDiscover backend

Handles Jackett resource search and downloader push (qBittorrent).
Results are emitted to the Stash log with a [SSD_RESULT] marker so the
frontend JS can parse them back.

Modes:
  search          — Jackett Torznab search, args: query
  push_download   — push magnet to qBittorrent, args: magnet, (optional) savepath
"""

import sys
import json
import os
import re
import urllib.request
import urllib.parse
import urllib.error
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

PLUGIN_ID = "stashDiscover"
RESULT_MARKER = "[SSD_RESULT]"
ERROR_MARKER = "[SSD_ERROR]"


class StashInterface:
    def __init__(self, fragment):
        self._fragment = fragment
        conn = fragment.get("server_connection", {})
        # Go marshals StashServerConnection without json tags (capitalized keys)
        self._scheme = conn.get("scheme") or conn.get("Scheme") or "http"
        self._host = conn.get("host") or conn.get("Host") or "localhost"
        # Stash may report its bind address (0.0.0.0 / ::) which is not
        # connectable on Windows (WinError 10049) — normalize to loopback
        if self._host in ("0.0.0.0", "::", "[::]", ""):
            self._host = "127.0.0.1"
        self._port = conn.get("port") or conn.get("Port") or 9999
        self._apikey = conn.get("apikey") or conn.get("ApiKey") or ""
        # Stash authenticates plugin processes via a signed session cookie,
        # not an API key
        cookie = conn.get("SessionCookie") or conn.get("sessionCookie") or {}
        cname = cookie.get("name") or cookie.get("Name") or ""
        cvalue = cookie.get("value") or cookie.get("Value") or ""
        self._cookie = f"{cname}={cvalue}" if cname and cvalue else ""
        self._args = fragment.get("args", {}) or {}

    def _gql(self, query, variables=None):
        url = f"{self._scheme}://{self._host}:{self._port}/graphql"
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._cookie:
            headers["Cookie"] = self._cookie
        if self._apikey:
            headers["ApiKey"] = self._apikey
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Stash GraphQL request failed (HTTP {e.code})") from e
        if body.get("errors"):
            raise RuntimeError(f"GQL error: {body['errors']}")
        return body.get("data", {})

    def get_mode(self):
        return self._args.get("mode", "")

    def get_arg(self, key, default=""):
        v = self._args.get(key, default)
        if isinstance(v, dict):
            return v.get("str", default)
        return v

    def get_plugin_config(self):
        # configuration.plugins 是 PluginConfigMap（JSON 对象，key=插件ID，value=设置），不带 subfields
        data = self._gql("query{configuration{plugins}}")
        plugins = ((data.get("configuration") or {}).get("plugins")) or {}
        return plugins.get(PLUGIN_ID, {})

    @staticmethod
    def exit_plugin(output="ok"):
        print(output)


def log_info(msg):
    print(f"\x01i\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

def log_warn(msg):
    print(f"\x01w\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

def log_error(msg):
    print(f"\x01e\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

def emit_result(obj):
    print(f"{RESULT_MARKER} {json.dumps(obj, ensure_ascii=False)}", file=sys.stderr, flush=True)

def emit_error(msg):
    print(f"{ERROR_MARKER} {msg}", file=sys.stderr, flush=True)


def http_request(url, method="GET", data=None, headers=None, timeout=30):
    req_headers = headers or {}
    req_data = None
    if data is not None:
        if isinstance(data, dict):
            req_data = urllib.parse.urlencode(data).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            req_data = data.encode("utf-8") if isinstance(data, str) else data
    req = urllib.request.Request(url, data=req_data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace"), dict(resp.headers)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return e.code, body, dict(e.headers or {})
    except Exception as e:
        return 0, str(e), {}


def _parse_torznab(xml_text):
    results = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log_warn(f"Torznab XML parse error: {e}")
        return results

    ns = {"torznab": "http://torznab.com/schemas/2015/feed"}
    channel = root.find("channel")
    if channel is None:
        return results

    for item in channel.findall("item"):
        title = (item.findtext("title") or "").strip()
        guid = (item.findtext("guid") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub_date = (item.findtext("pubDate") or "").strip()
        size = 0
        try:
            size = int(item.findtext("size") or "0")
        except ValueError:
            pass

        seeders = leechers = None
        magnet = None
        tracker = None
        for attr in item.findall("torznab:attr", ns):
            name = attr.get("name", "")
            value = attr.get("value", "")
            if name == "seeders":
                try: seeders = int(value)
                except ValueError: pass
            elif name == "peers":
                try: leechers = int(value)
                except ValueError: pass
            elif name == "magneturl":
                magnet = value
            elif name == "tracker":
                tracker = value

        if not magnet and link.startswith("magnet:"):
            magnet = link
        if not magnet and guid.startswith("magnet:"):
            magnet = guid

        if not title and magnet:
            m = re.search(r'dn=([^&]+)', magnet)
            if m:
                title = urllib.parse.unquote_plus(m.group(1))

        results.append({
            "title": title,
            "magnet": magnet or "",
            "link": link or guid,
            "size": size,
            "size_human": _human_size(size),
            "seeders": seeders if seeders is not None else -1,
            "leechers": leechers if leechers is not None else -1,
            "pub_date": pub_date,
            "tracker": tracker or "",
        })

    # Magnet-bearing results first, then by seeders — magnet-less proxy links
    # crowd the top when sorted by seeders alone
    results.sort(key=lambda r: (bool(r["magnet"]), r["seeders"]), reverse=True)
    return results


def _human_size(n):
    if not n or n <= 0:
        return "?"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} PB"


def _normalize_torznab_url(url):
    """Accept a Jackett base URL (http://host:9117) or partial API path and
    complete it to the full Torznab aggregate endpoint."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return u
    if u.endswith("/torznab"):
        return u
    if "/api/v2." in u:
        return u + "/torznab"
    return u + "/api/v2.0/indexers/all/results/torznab"


def do_search(stash, query):
    cfg = stash.get_plugin_config()
    jackett_url = _normalize_torznab_url(cfg.get("jackettUrl") or "")
    jackett_key = (cfg.get("jackettApiKey") or "").strip()

    if not jackett_url or not jackett_key:
        emit_error("Jackett not configured. Set Jackett API URL and API Key in plugin settings.")
        return

    log_info(f"Jackett endpoint: {jackett_url}")

    sep = "&" if "?" in jackett_url else "?"
    url = f"{jackett_url}{sep}apikey={urllib.parse.quote(jackett_key)}&q={urllib.parse.quote(query)}"

    log_info(f"Jackett search: {query}")
    status, body, _ = http_request(url, timeout=30)

    if status != 200:
        emit_error(f"Jackett request failed (HTTP {status}): {body[:200]}")
        return

    results = _parse_torznab(body)
    log_info(f"Jackett returned {len(results)} results")
    emit_result({"mode": "search", "query": query, "count": len(results), "results": results[:50]})


def do_push_download(stash, magnet, savepath=""):
    cfg = stash.get_plugin_config()
    dl_type = (cfg.get("downloaderType") or "qbittorrent").strip().lower()
    dl_url = (cfg.get("downloaderUrl") or "").strip().rstrip("/")
    dl_user = (cfg.get("downloaderUsername") or "").strip()
    dl_pass = (cfg.get("downloaderPassword") or "").strip()

    if not dl_url:
        emit_error("Downloader URL not configured.")
        return
    if not magnet:
        emit_error("No magnet link provided.")
        return

    if dl_type == "qbittorrent":
        _push_qbittorrent(dl_url, dl_user, dl_pass, magnet, savepath)
    else:
        emit_error(f"Unsupported downloader type: {dl_type}. Currently only qbittorrent is supported.")


def _push_qbittorrent(base_url, username, password, magnet, savepath):
    login_url = f"{base_url}/api/v2/auth/login"
    status, body, headers = http_request(
        login_url, method="POST",
        data={"username": username, "password": password},
        timeout=15,
    )
    if status != 200 or body.strip() != "Ok.":
        emit_error(f"qBittorrent login failed (HTTP {status}): {body[:100]}")
        return

    cookie = ""
    for k, v in headers.items():
        if k.lower() == "set-cookie":
            m = re.search(r'(SID=[^;]+)', v)
            if m:
                cookie = m.group(1)
                break

    if not cookie:
        emit_error("qBittorrent login did not return a session cookie.")
        return

    add_url = f"{base_url}/api/v2/torrents/add"
    form_data = {"urls": magnet}
    if savepath:
        form_data["savepath"] = savepath

    status, body, _ = http_request(
        add_url, method="POST", data=form_data,
        headers={"Cookie": cookie},
        timeout=15,
    )
    if status == 200:
        log_info(f"Pushed magnet to qBittorrent: {magnet[:60]}...")
        emit_result({"mode": "push_download", "ok": True, "message": "Pushed to downloader"})
    else:
        emit_error(f"qBittorrent add failed (HTTP {status}): {body[:200]}")


def main():
    try:
        if len(sys.argv) > 1:
            arg = sys.argv[1]
            if arg.endswith(".json") and os.path.isfile(arg):
                with open(arg, "r", encoding="utf-8") as f:
                    fragment = json.load(f)
                try:
                    os.unlink(arg)
                except OSError:
                    pass
            else:
                fragment = json.loads(arg)
        else:
            fragment = json.loads(sys.stdin.read())

        stash = StashInterface(fragment)
        mode = stash.get_mode()

        if mode == "search":
            query = stash.get_arg("query", "")
            if not query:
                emit_error("No search query provided.")
            else:
                do_search(stash, query)
        elif mode == "push_download":
            magnet = stash.get_arg("magnet", "")
            savepath = stash.get_arg("savepath", "")
            do_push_download(stash, magnet, savepath)
        else:
            log_warn(f"Unknown mode: {mode}")

        stash.exit_plugin("OK")

    except Exception as e:
        log_error(f"FATAL: {repr(e)}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
