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
# 单次搜索下发给前端的条数上限：一条结果带标题/磁力/大小/做种数，50 条
# 已经够翻三页，再多只会把日志行撑大（见 count 与 truncated 的注释）
SEARCH_RESULT_LIMIT = 50


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

# 结果/错误通过 Stash 的全局日志流回传给前端，而日志里没有请求边界：多个任务
# 交错、上一次请求迟到落库，都会让「取最新一条 [SSD_RESULT]」读到别人的结果
# （论坛反馈：搜演员 A 之后再搜 B，显示的还是 A 的结果）。每次任务带一个前端
# 生成的 requestId，回写进 payload，前端只认自己那个。
_REQUEST_ID = ""

def set_request_id(rid):
    global _REQUEST_ID
    _REQUEST_ID = str(rid or "").strip()

def emit_result(obj):
    if _REQUEST_ID and isinstance(obj, dict):
        obj = dict(obj)
        obj["rid"] = _REQUEST_ID
    print(f"{RESULT_MARKER} {json.dumps(obj, ensure_ascii=False)}", file=sys.stderr, flush=True)

def emit_error(msg):
    # 带 rid 时输出 JSON（前端按 rid 过滤），否则保持旧的纯文本格式，
    # 让未升级的前端仍能读到错误文案
    if _REQUEST_ID:
        payload = json.dumps({"rid": _REQUEST_ID, "message": msg}, ensure_ascii=False)
        print(f"{ERROR_MARKER} {payload}", file=sys.stderr, flush=True)
    else:
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
            # 保留 HTTPMessage，qBittorrent 登录可能分多条 Set-Cookie
            return resp.status, resp.read().decode("utf-8", errors="replace"), resp.headers
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        return e.code, body, (e.headers or {})
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


def _int_setting(cfg, key, default, lo, hi):
    try:
        v = int(str(cfg.get(key) or "").strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def do_search(stash, query):
    cfg = stash.get_plugin_config()
    jackett_url = _normalize_torznab_url(cfg.get("jackettUrl") or "")
    jackett_key = (cfg.get("jackettApiKey") or "").strip()
    # 索引器聚合搜索在 NAS / 慢索引器上常超过 30s，默认放宽到 120s，
    # 并允许在插件设置里按需上调（论坛反馈：30s 会稳定超时）
    jackett_timeout = _int_setting(cfg, "jackettTimeout", 120, 10, 600)

    if not jackett_url or not jackett_key:
        emit_error("Jackett not configured. Set Jackett API URL and API Key in plugin settings.")
        return

    log_info(f"Jackett endpoint: {jackett_url}")

    sep = "&" if "?" in jackett_url else "?"
    url = f"{jackett_url}{sep}apikey={urllib.parse.quote(jackett_key)}&q={urllib.parse.quote(query)}"

    log_info(f"Jackett search: {query}")
    status, body, _ = http_request(url, timeout=jackett_timeout)

    if status != 200:
        emit_error(f"Jackett request failed (HTTP {status}): {body[:200]}")
        return

    results = _parse_torznab(body)
    # count 必须与真正下发的条数分开：以前 count 报总数、payload 却截到 50，
    # 前端抬头显示 230 条而列表只有 50（论坛反馈「230 results 只显示几条」）
    total = len(results)
    shown = results[:SEARCH_RESULT_LIMIT]
    log_info(f"Jackett returned {total} results (showing {len(shown)})")
    emit_result({
        "mode": "search", "query": query,
        "count": total, "shown": len(shown),
        "truncated": total > SEARCH_RESULT_LIMIT,
        "results": shown,
    })


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


def _session_cookie(headers):
    """qBittorrent ≤5.1 sends `SID=…`, 5.2+ renamed the session cookie to
    `QBT_SID_<port>` (and may split Set-Cookie across header lines). Collect
    every SID-bearing cookie pair instead of hard-coding the old name."""
    lines = []
    try:
        lines = headers.get_all("Set-Cookie") or []
    except AttributeError:
        for k, v in (headers or {}).items():
            if k.lower() == "set-cookie":
                lines.append(v)
    pairs = []
    for line in lines:
        # a server may combine several cookies into one header line
        for part in re.split(r",\s*(?=[^=;,\s]+=)", line or ""):
            m = re.match(r"\s*([^=;,\s]+)=([^;,]*)", part)
            if not m:
                continue
            if "SID" in m.group(1).upper():
                pairs.append(f"{m.group(1)}={m.group(2)}")
    return "; ".join(pairs)


def _push_qbittorrent(base_url, username, password, magnet, savepath):
    login_url = f"{base_url}/api/v2/auth/login"
    status, body, headers = http_request(
        login_url, method="POST",
        data={"username": username, "password": password},
        timeout=15,
    )
    # qBittorrent ≤5.2：登录成功返回 200 + body "Ok."
    # qBittorrent 5.3.0：改成 204 No Content（空 body），会话 cookie 仍在
    # Set-Cookie 里 —— 老代码硬判 200 会把成功的登录当成失败（论坛反馈）
    if status == 204 or (status == 200 and body.strip() == "Ok."):
        pass
    else:
        emit_error(f"qBittorrent login failed (HTTP {status}): {body[:100]}")
        return

    cookie = _session_cookie(headers)

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
        set_request_id(stash.get_arg("rid", ""))
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
