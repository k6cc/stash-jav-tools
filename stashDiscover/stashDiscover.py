"""
stashDiscover backend

Handles Jackett resource search and downloader push (qBittorrent).

Results are written to cache/<kind>-<rid>.json inside the plugin directory and
picked up by the frontend over the plugin's own asset route. They are NOT sent
through the Stash log: that channel is a 30-entry ring buffer and truncates any
line over 64KB, so large payloads silently disappeared.

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
# 单次搜索下发给前端的条数上限。operation 通道没有日志的 64KB 行上限；
# UI 仍然分页渲染，200 只是"能一次拿全"，不是"一屏显示 200 条"。
SEARCH_RESULT_LIMIT = 200


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


def log_info(msg):
    print(f"\x01i\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

def log_warn(msg):
    print(f"\x01w\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

def log_error(msg):
    print(f"\x01e\x02[{PLUGIN_ID}] {msg}", file=sys.stderr, flush=True)

# ─── 结果通道：stdout → runPluginOperation 的返回值 ───────────────────────
# 旧做法把结果打成一行 [SSD_RESULT] 到 stderr，前端用 query{logs} 捞回来。
# 那条通道实测三处硬伤：
#   1. logs 是环形缓冲，只留 30 条 —— Jackett 慢查询期间别的日志一刷就没了
#   2. 单行超过 64KB 被 Stash 截断 —— 长标题 + 多 tracker 很容易擦线
#   3. 两者都不报错，前端只能看到"没收到结果"
# 也试过写文件走插件静态资源路由（ui.assets: /: .），但实测那个目录
# **匿名可读、可列目录** —— /plugin/stashDiscover/assets/cache/ 匿名 200 并列出
# 全部结果文件名，搜索结果里的种子标题与下载链接就成了公开资源。该方案作废。
# 现在走 Stash 官方的 runPluginOperation：stdout 输出一条 {"output": ...}，
# 由 GraphQL 原样返回前端。通道本身要会话、没有截断、不需要轮询。
def emit_result(obj):
    n = len(obj.get("results") or [])
    log_info(f"result → {n} items" if n else "result → ok")
    print(json.dumps({"output": obj}, ensure_ascii=False), flush=True)

def emit_error(msg):
    log_warn(f"error → {msg[:200]}")
    print(json.dumps({"error": msg}, ensure_ascii=False), flush=True)


# ─── 界面语言 ────────────────────────────────────────────────────────────
# 前端把 isZh() 的结果作为 args.lang 传进来。只影响**给人看的**文案；
# 日志与 HTTP 明细保持英文（用户看日志的多，第三方报错也原样保留更好搜索）。
# 缺省中文：未升级的前端不带 lang，行为跟以前一致。
def want_zh(stash):
    lang = str(stash.get_arg("lang", "") or "").strip().lower()
    return not lang.startswith("en")


def _t(zh, zh_text, en_text):
    return zh_text if zh else en_text

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

        # 聚合搜索时 item 自带来源索引器：
        #   <jackettindexer id="torrentdownload">TorrentDownload</jackettindexer>
        # 标签名不带命名空间前缀，个别版本写作 <jackett:indexer>，所以按本地名
        # 兜底匹配。这条信息本来就在响应里，解析零额外请求。
        indexer = None
        for child in item:
            if not isinstance(child.tag, str):
                continue
            if child.tag.rsplit("}", 1)[-1].lower().endswith("indexer"):
                indexer = (child.text or "").strip() or (child.get("id") or "").strip()
                break

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
            "indexer": indexer or tracker or "",
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
    # 0 是旧版 NUMBER 设置项被 Stash 写下的「未设置」脏值（现已改 STRING 并在前端
    # 迁移）。0 秒超时没有意义，落到下限只会让搜索必然失败，所以按默认值处理。
    if v <= 0:
        return default
    return max(lo, min(hi, v))


def do_search(stash, query, zh=True):
    cfg = stash.get_plugin_config()
    jackett_url = _normalize_torznab_url(cfg.get("jackettUrl") or "")
    jackett_key = (cfg.get("jackettApiKey") or "").strip()
    # 索引器聚合搜索在 NAS / 慢索引器上常超过 30s，默认放宽到 120s，
    # 并允许在插件设置里按需上调（论坛反馈：30s 会稳定超时）
    jackett_timeout = _int_setting(cfg, "jackettTimeout", 120, 10, 600)

    if not jackett_url or not jackett_key:
        emit_error(_t(zh,
                      "Jackett 未配置：请在插件设置里填写 Jackett 的 API 地址与 API Key。",
                      "Jackett not configured. Set Jackett API URL and API Key in plugin settings."))
        return

    log_info(f"Jackett endpoint: {jackett_url}")

    sep = "&" if "?" in jackett_url else "?"
    url = f"{jackett_url}{sep}apikey={urllib.parse.quote(jackett_key)}&q={urllib.parse.quote(query)}"

    log_info(f"Jackett search: {query}")
    status, body, _ = http_request(url, timeout=jackett_timeout)

    if status != 200:
        emit_error(_t(zh,
                      f"Jackett 请求失败（HTTP {status}）：{body[:200]}",
                      f"Jackett request failed (HTTP {status}): {body[:200]}"))
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


def do_push_download(stash, magnet, savepath="", zh=True):
    cfg = stash.get_plugin_config()
    dl_type = (cfg.get("downloaderType") or "qbittorrent").strip().lower()
    dl_url = (cfg.get("downloaderUrl") or "").strip().rstrip("/")
    dl_user = (cfg.get("downloaderUsername") or "").strip()
    dl_pass = (cfg.get("downloaderPassword") or "").strip()

    if not dl_url:
        emit_error(_t(zh, "下载器地址未填写。", "Downloader URL not configured."))
        return
    if not magnet:
        emit_error(_t(zh, "没有拿到磁力链接。", "No magnet link provided."))
        return

    if dl_type == "qbittorrent":
        _push_qbittorrent(dl_url, dl_user, dl_pass, magnet, savepath, zh)
    else:
        emit_error(_t(zh,
                      f"暂不支持下载器类型 {dl_type}，目前只支持 qBittorrent。",
                      f"Unsupported downloader type: {dl_type}. Currently only qbittorrent is supported."))


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


def _push_qbittorrent(base_url, username, password, magnet, savepath, zh=True):
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
        emit_error(_t(zh,
                      f"qBittorrent 登录失败（HTTP {status}）：{body[:100]}",
                      f"qBittorrent login failed (HTTP {status}): {body[:100]}"))
        return

    cookie = _session_cookie(headers)

    if not cookie:
        emit_error(_t(zh,
                      "qBittorrent 登录成功但没有返回会话 cookie。",
                      "qBittorrent login did not return a session cookie."))
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
        emit_error(_t(zh,
                      f"qBittorrent 添加任务失败（HTTP {status}）：{body[:200]}",
                      f"qBittorrent add failed (HTTP {status}): {body[:200]}"))


# ─── 连接测试（设置页「测试」按钮，用户 2026-11-02）─────────────────────
# 三项各自返回一行结果，前端只负责画勾叉，不判断成败：
#   jackett      → Torznab t=caps（最轻的请求，但 Jackett 对 caps 同样校验 key）
#   qbittorrent  → 登录 → app/version，顺带读默认保存路径
#   stash-box    → 只读 Stash 配置 + 本地库统计，**不发外网请求**（用户要求）
def _host_of(url):
    try:
        return urllib.parse.urlparse(url).netloc or url
    except Exception:
        return url


def _test_jackett(cfg, zh=True):
    item = {"key": "jackett", "label": "Jackett", "ok": False, "detail": "", "hint": ""}
    url = _normalize_torznab_url(cfg.get("jackettUrl") or "")
    key = (cfg.get("jackettApiKey") or "").strip()
    if not url or not key:
        item["detail"] = _t(zh, "URL 或 API Key 未填写", "URL or API key is missing")
        return item
    sep = "&" if "?" in url else "?"
    caps = f"{url}{sep}t=caps&apikey={urllib.parse.quote(key)}"
    status, body, _ = http_request(caps, timeout=15)
    host = _host_of(url)
    if status == 200:
        # caps 解析不出 indexer 列表（Jackett 的 caps 不含），只确认可达 + key 通过
        item["ok"] = True
        item["detail"] = _t(zh, f"{host} 可达", f"{host} reachable")
        title = ""
        try:
            root = ET.fromstring(body)
            srv = root.find("server")
            if srv is not None:
                title = srv.get("title") or ""
        except ET.ParseError:
            item["hint"] = _t(zh,
                              "返回内容不是 Torznab XML，确认地址指向 Jackett 的 Torznab 接口",
                              "The response is not Torznab XML — check that the URL points at Jackett's Torznab endpoint")
        if title:
            item["detail"] = f"{host} · {title}"
    elif status in (401, 403):
        item["detail"] = _t(zh, f"API Key 无效（HTTP {status}）", f"API key rejected (HTTP {status})")
        item["hint"] = _t(zh,
                          "用 Jackett 仪表盘右上角的 API Key；Prowlarr 的 key 不通用",
                          "Use the API key from the top-right of the Jackett dashboard; a Prowlarr key will not work")
    elif status == 0:
        item["detail"] = _t(zh, f"连不上 {host}", f"Can't reach {host}")
        item["hint"] = body[:150]
    else:
        item["detail"] = f"HTTP {status}"
        item["hint"] = body[:150]
    return item


def _test_downloader(cfg, zh=True):
    item = {"key": "qbittorrent", "label": "qBittorrent", "ok": False, "detail": "", "hint": ""}
    url = (cfg.get("downloaderUrl") or "").strip().rstrip("/")
    user = (cfg.get("downloaderUsername") or "").strip()
    pwd = (cfg.get("downloaderPassword") or "").strip()
    dl_type = (cfg.get("downloaderType") or "qbittorrent").strip().lower()
    if dl_type and dl_type != "qbittorrent":
        item["detail"] = _t(zh, f"暂不支持 {dl_type}", f"{dl_type} is not supported yet")
        return item
    if not url:
        item["detail"] = _t(zh, "URL 未填写", "URL is missing")
        return item
    host = _host_of(url)
    status, body, headers = http_request(
        f"{url}/api/v2/auth/login", method="POST",
        data={"username": user, "password": pwd}, timeout=15,
    )
    if status == 403:
        item["detail"] = _t(zh, "登录被拒（HTTP 403）", "Login refused (HTTP 403)")
        item["hint"] = _t(zh,
                          "连续登录失败后 qB 会临时封 IP，先在 Web UI 里登录一次解除",
                          "qB temporarily bans the IP after repeated failed logins — log in once in the Web UI to clear it")
        return item
    if status == 0:
        item["detail"] = _t(zh, f"连不上 {host}", f"Can't reach {host}")
        item["hint"] = body[:150]
        return item
    # ≤5.2 → 200 "Ok."；5.3.0 → 204 空 body（会话 cookie 仍在）
    if not (status == 204 or (status == 200 and body.strip() == "Ok.")):
        item["detail"] = _t(zh, f"登录失败（HTTP {status}）", f"Login failed (HTTP {status})")
        item["hint"] = (body[:150] or _t(zh, "检查用户名与密码", "Check the username and password"))
        return item
    cookie = _session_cookie(headers)
    if not cookie:
        item["detail"] = _t(zh, "登录成功但没有拿到会话 cookie",
                            "Logged in but no session cookie came back")
        item["hint"] = _t(zh,
                          "确认 Web UI 地址完整（含端口），且没有被反向代理吞掉 Set-Cookie",
                          "Check that the Web UI URL is complete (including the port) and that no reverse proxy is dropping Set-Cookie")
        return item
    hdr = {"Cookie": cookie}
    status, body, _ = http_request(f"{url}/api/v2/app/version", headers=hdr, timeout=10)
    if status != 200:
        item["detail"] = _t(zh, f"会话无效（HTTP {status}）", f"Session rejected (HTTP {status})")
        item["hint"] = _t(zh,
                          "登录成功了但后续请求被拒，通常是反代没转发 cookie",
                          "Login worked but later requests were refused — usually a reverse proxy not passing cookies through")
        return item
    version = body.strip() or "?"
    save_path = ""
    status2, body2, _ = http_request(f"{url}/api/v2/app/preferences", headers=hdr, timeout=10)
    if status2 == 200:
        try:
            save_path = str((json.loads(body2) or {}).get("save_path") or "")
        except (ValueError, AttributeError):
            pass
    item["ok"] = True
    item["detail"] = f"{host} · qBittorrent {version}"
    if save_path:
        item["hint"] = _t(zh, f"默认保存路径 {save_path}", f"Default save path {save_path}")
    return item


def _test_stashboxes(stash, zh=True):
    """只读配置 + 本地库统计：不发任何 stash-box 请求（用户 2026-11-02）。"""
    try:
        data = stash._gql("{configuration{general{stashBoxes{name endpoint api_key}}}}")
        boxes = ((data.get("configuration") or {}).get("general") or {}).get("stashBoxes") or []
    except Exception as e:
        return [{"key": "stashbox", "label": "stash-box", "ok": False,
                 "detail": _t(zh, f"读取 Stash 配置失败：{e}",
                              f"Could not read the Stash configuration: {e}"), "hint": ""}]
    if not boxes:
        return [{"key": "stashbox", "label": "stash-box", "ok": False,
                 "detail": _t(zh, "Stash 里没有配置 stash-box", "No stash-box is configured in Stash"),
                 "hint": _t(zh, "设置 → 元数据提供者 → stash-box 添加并认证",
                            "Settings → Metadata Providers → add and authenticate a stash-box")}]
    # 本地演员的 stash_id（一次查完，避免每个 box 查一遍）
    counts = {}
    try:
        pdata = stash._gql("{findPerformers(filter:{per_page:-1}){performers{stash_ids{endpoint stash_id}}}}")
        for p in (pdata.get("findPerformers") or {}).get("performers") or []:
            for sid in (p.get("stash_ids") or []):
                ep = (sid.get("endpoint") or "").lower()
                if ep:
                    counts[ep] = counts.get(ep, 0) + 1
    except Exception as e:
        return [{"key": "stashbox", "label": "stash-box", "ok": False,
                 "detail": _t(zh, f"统计本地演员失败：{e}",
                              f"Could not count local performers: {e}"), "hint": ""}]
    out = []
    for b in boxes:
        ep = (b.get("endpoint") or "").lower()
        n = counts.get(ep, 0)
        has_key = bool((b.get("api_key") or "").strip())
        key_state = _t(zh, "已配置 Key" if has_key else "缺少 API Key",
                       "API key set" if has_key else "API key missing")
        count_part = _t(zh, f"本地 {n} 位演员带该 box 的 ID",
                        f"{n} performers in your library carry this box's ID")
        item = {
            "key": "stashbox:" + ep,
            "label": b.get("name") or _host_of(ep),
            "ok": has_key and n > 0,
            "detail": key_state + " · " + count_part,
            "hint": "" if n else _t(zh,
                                    "本地还没有演员链接到这个 box，发现页会看不到它的数据",
                                    "No performer in your library is linked to this box yet, so the Discover page won't see its data"),
        }
        out.append(item)
    return out


def do_test(stash, zh=True):
    cfg = stash.get_plugin_config()
    items = [_test_jackett(cfg, zh), _test_downloader(cfg, zh)]
    items.extend(_test_stashboxes(stash, zh))
    log_info("connection test → " + ", ".join(
        f"{i['label']}={'ok' if i['ok'] else 'fail'}" for i in items))
    emit_result({"mode": "test", "ok": all(i["ok"] for i in items), "items": items})


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
        zh = want_zh(stash)

        if mode == "search":
            query = stash.get_arg("query", "")
            if not query:
                emit_error(_t(zh, "没有搜索关键词。", "No search query provided."))
            else:
                do_search(stash, query, zh)
        elif mode == "push_download":
            magnet = stash.get_arg("magnet", "")
            savepath = stash.get_arg("savepath", "")
            do_push_download(stash, magnet, savepath, zh)
        elif mode == "test":
            do_test(stash, zh)
        else:
            emit_error(f"Unknown mode: {mode or '(empty)'}")

    except Exception as e:
        log_error(f"FATAL: {repr(e)}")
        import traceback
        traceback.print_exc(file=sys.stderr)
        # stdout 是唯一的结果通道，异常也要从那里回，否则前端只看到超时
        emit_error(f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
