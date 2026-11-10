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
# Stash 把 args 以 UTF-8 写进 stdin，但 Windows 下 sys.stdin 默认按本地代码页
# （中文系统 cp936）解码：中文/日文搜索词要么直接 UnicodeDecodeError，要么被
# surrogateescape 变成孤立代理项（U+DC80..DCFF），一路传到
# urllib.parse.quote() 才炸成 "surrogates not allowed"（论坛实测日文标题）。
# 必须显式按 UTF-8 解码 stdin —— stdout/stderr 早就这么做了，只有 stdin 漏了。
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")

_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

PLUGIN_ID = "stashDiscover"
# 单次搜索下发给前端的条数上限。operation 通道没有日志的 64KB 行上限；
# UI 仍然分页渲染，200 只是"能一次拿全"，不是"一屏显示 200 条"。
SEARCH_RESULT_LIMIT = 200


def _safe_text(s):
    """去掉 JSON 里可能夹带的孤立代理项。

    Windows 上按本地代码页解码过的字符串会带 U+DC80..DCFF，这种字符没法编码成
    UTF-8：拼进 URL 会让 urllib.parse.quote 抛 UnicodeEncodeError，写进结果又会
    让 json.dumps 出错。这里统一换成 '?'，宁可搜不到也不整条失败。
    """
    if not isinstance(s, str):
        return s
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        return s.encode("utf-8", "replace").decode("utf-8")


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


def _post_json(url, payload, headers=None, timeout=15):
    """POST 一段 JSON。http_request 只把 dict 编成表单，JSON 走这里。"""
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    return http_request(url, method="POST", data=body, headers=h, timeout=timeout)


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
    # 0 秒超时没有意义：落到下限只会让搜索必然失败，所以按默认值处理。
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

    if dl_type in ("qbittorrent", "qb", "qbit"):
        _push_qbittorrent(dl_url, dl_user, dl_pass, magnet, savepath, zh)
    elif dl_type in ("motrix", "motrix2", "aria2"):
        _push_motrix(dl_url, dl_pass, magnet, zh)
    else:
        emit_error(_t(zh,
                      f"暂不支持下载器类型 {dl_type}，可选 qbittorrent 或 motrix。",
                      f"Unsupported downloader type: {dl_type}. Use qbittorrent or motrix."))


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


# ─── Motrix ────────────────────────────────────────────────────────────────
# 桌面版与 Server 版是两套通道，插件按探测结果走，用户只填「地址 + 密钥」：
#   桌面版 → POST {base}/jsonrpc              aria2 JSON-RPC（密钥见 高级 → RPC）
#   Server → POST {base}/rpc/<kind>/<name>    Bearer operator-token
# 不读 endpoint.json / settings.json：那是别的软件的私有状态，里面的 localToken
# 还是鉴权凭据，插件去翻等于翻密码本（用户 2026-11-09 明确拒绝）。代价是密钥
# 得用户自己复制一次；好处是两套 token 都持久化，配一次长期有效。
# 保存目录两边都不用配：aria2 不传 dir 就用全局默认，Server 的目录从
# query:getSettings 读 —— 都是 Motrix 自己的设置，插件不替用户猜。

def _aria2_call(base, secret, method, params, timeout=15):
    args = (["token:" + secret] if secret else []) + list(params)
    status, body, _ = _post_json(
        base + "/jsonrpc",
        {"jsonrpc": "2.0", "id": PLUGIN_ID, "method": method, "params": args},
        timeout=timeout,
    )
    try:
        obj = json.loads(body)
    except ValueError:
        return status, None, body[:200]
    if obj.get("error"):
        err = obj["error"]
        # aria2 给 {"code":..,"message":..}，但别的服务可能直接塞字符串
        if isinstance(err, dict):
            return status or 500, None, err.get("message") or str(err)
        return status or 500, None, str(err)
    return status, obj.get("result"), ""


def _rpc_call(base, secret, name, args, timeout=15):
    """name 形如 command:createTask，路径是 /rpc/<kind>/<name>。

    响应是裸 JSON（listTasks 直接给数组，createTask 给 {outcome,...}），
    没有 {"result": ...} 外壳 —— 和 aria2 不一样。
    """
    kind = name.split(":", 1)[0]
    status, body, _ = _post_json(
        f"{base}/rpc/{kind}/{name}", {"args": args},
        headers={"Authorization": "Bearer " + secret}, timeout=timeout,
    )
    try:
        obj = json.loads(body)
    except ValueError:
        return status, None, body[:200]
    if isinstance(obj, dict) and obj.get("error"):
        return status or 500, None, str(obj["error"])[:200]
    return status, obj, ""


def _motrix_probe(base, secret):
    """返回 (kind, version, why)。kind = "aria2" | "web" | ""。"""
    status, res, err = _aria2_call(base, secret, "aria2.getVersion", [], timeout=10)
    if status == 200 and isinstance(res, dict):
        return "aria2", res.get("version") or "", ""
    # auth/status 比 listTasks 轻，任务多的时候不会拖慢
    status, body, _ = http_request(
        base + "/rpc/auth/status",
        headers={"Authorization": "Bearer " + secret}, timeout=10,
    )
    try:
        obj = json.loads(body)
    except ValueError:
        obj = {}
    if status == 200 and obj.get("authed"):
        return "web", "", ""
    return "", "", (err or body[:120] or f"HTTP {status}")


def _push_motrix(base_url, secret, magnet, zh=True):
    kind, _ver, why = _motrix_probe(base_url, secret)
    if not kind:
        emit_error(_t(zh,
                      f"连不上 Motrix（{why}）。桌面版地址填 http://127.0.0.1:16800，密钥在 高级 → RPC。",
                      f"Can't reach Motrix ({why}). Desktop: use http://127.0.0.1:16800 and the key from Advanced → RPC."))
        return

    if kind == "aria2":
        status, res, err = _aria2_call(base_url, secret, "aria2.addUri", [[magnet]])
        if res:
            log_info(f"Pushed magnet to Motrix: {magnet[:60]}...")
            emit_result({"mode": "push_download", "ok": True, "message": "Pushed to downloader"})
            return
        # 同一磁力重复推送：aria2 报 already registered，对用户来说任务已在队列里
        low = (err or "").lower()
        if "already registered" in low or "duplicate" in low:
            emit_result({"mode": "push_download", "ok": True,
                         "message": "Already in downloader"})
            return
        emit_error(_t(zh, f"Motrix 添加任务失败：{err}", f"Motrix add failed: {err}"))
        return

    # Server：createTask 的 saveDir 是必填，用 Motrix 自己的默认目录
    save_dir = ""
    _, settings, _ = _rpc_call(base_url, secret, "query:getSettings", [{}])
    if isinstance(settings, dict):
        save_dir = ((settings.get("app") or {}).get("defaultSaveDir") or "").strip()
    if not save_dir:
        emit_error(_t(zh,
                      "读不到 Motrix 的默认下载目录，请先在 Motrix 里设置一个。",
                      "Couldn't read Motrix's default download folder — set one in Motrix first."))
        return
    task = {"type": "bt", "payload": {"kind": "magnet", "uri": magnet}, "saveDir": save_dir}
    status, res, err = _rpc_call(base_url, secret, "command:createTask", [task])
    outcome = (res or {}).get("outcome") if isinstance(res, dict) else ""
    if outcome in ("created", "conflict"):
        log_info(f"Pushed magnet to Motrix server ({outcome}): {magnet[:60]}...")
        emit_result({"mode": "push_download", "ok": True,
                     "message": "Pushed to downloader" if outcome == "created" else "Already in downloader"})
        return
    emit_error(_t(zh, f"Motrix 添加任务失败：{err or res}",
                  f"Motrix add failed: {err or res}"))


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


def _test_motrix(url, secret, zh=True):
    item = {"key": "motrix", "label": "Motrix", "ok": False, "detail": "", "hint": ""}
    if not url:
        item["detail"] = _t(zh, "RPC 地址未填写", "RPC address is missing")
        item["hint"] = _t(zh, "桌面版填 http://127.0.0.1:16800，服务端填 Web 地址",
                          "Desktop: http://127.0.0.1:16800. Server: the Web UI address")
        return item
    kind, ver, why = _motrix_probe(url, secret)
    host = _host_of(url)
    if kind == "aria2":
        item["ok"] = True
        item["detail"] = f"{host} · aria2 {ver or '?'}"
        item["hint"] = _t(zh, "桌面版，保存目录用 Motrix 的默认设置",
                          "Desktop build; downloads use Motrix's default folder")
        return item
    if kind == "web":
        item["ok"] = True
        item["detail"] = _t(zh, f"{host} · 服务端", f"{host} · server")
        _, settings, _ = _rpc_call(url, secret, "query:getSettings", [{}])
        save_dir = ""
        if isinstance(settings, dict):
            save_dir = ((settings.get("app") or {}).get("defaultSaveDir") or "")
        if save_dir:
            item["hint"] = _t(zh, f"默认保存路径 {save_dir}", f"Default save path {save_dir}")
        return item
    item["detail"] = _t(zh, f"连不上 {host}", f"Can't reach {host}")
    item["hint"] = (why or "")[:150]
    return item


def _test_downloader(cfg, zh=True):
    dl_type = (cfg.get("downloaderType") or "qbittorrent").strip().lower()
    url = (cfg.get("downloaderUrl") or "").strip().rstrip("/")
    user = (cfg.get("downloaderUsername") or "").strip()
    pwd = (cfg.get("downloaderPassword") or "").strip()

    if dl_type in ("motrix", "motrix2", "aria2"):
        return _test_motrix(url, pwd, zh)

    item = {"key": "qbittorrent", "label": "qBittorrent", "ok": False, "detail": "", "hint": ""}
    if dl_type not in ("qbittorrent", "qb", "qbit"):
        item["detail"] = _t(zh, f"暂不支持 {dl_type}", f"{dl_type} is not supported")
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


# ─── Whisparr ──────────────────────────────────────────────────────────────
# 只对 stashdb 源开放（前端判断），因为 Whisparr 那边靠 stash_id 反查 TPDB
# 元数据；javstash 的 ID 它不认，加进去只会得到一条空壳记录。
# 加片必须带 qualityProfileId + rootFolderPath（实测缺任一项 400）：根目录取第
# 一个；质量档案由用户在发现页设置里选，没选则回退到 Any / id 最小。
# 重复添加返回 400 + MovieExistsValidator，对用户来说等于「已经加过」。

def _whisparr_cfg(cfg):
    return ((cfg.get("whisparrUrl") or "").strip().rstrip("/"),
            (cfg.get("whisparrApiKey") or "").strip())


def _whisparr_req(base, key, method, path, payload=None, timeout=25):
    headers = {"X-Api-Key": key}
    if payload is None:
        return http_request(base + path, headers=headers, timeout=timeout)
    return _post_json(base + path, payload, headers=headers, timeout=timeout)


def _whisparr_err(status, body, zh):
    """400 的 body 是 [{propertyName,errorMessage,errorCode}]，翻成一句话。"""
    detail = ""
    try:
        parsed = json.loads(body)
    except ValueError:
        parsed = None
    if isinstance(parsed, list):
        parts = []
        for e in parsed[:3]:
            if not isinstance(e, dict):
                continue
            msg = (e.get("errorMessage") or "").strip()
            prop = (e.get("propertyName") or "").strip()
            # Whisparr 把 propertyName 填成 "Path" 之类的字面量，拼上去反而更难读
            if prop and prop.lower() != "path" and prop not in msg:
                parts.append(f"{prop}: {msg}")
            else:
                parts.append(msg)
        detail = "; ".join(p for p in parts if p)
    elif isinstance(parsed, dict):
        detail = parsed.get("message") or ""
    detail = detail or (body or "")[:160]
    if status == 401:
        return _t(zh, "Whisparr 的 API Key 不对", "Whisparr rejected the API key")
    return _t(zh, f"Whisparr 返回 {status}：{detail}",
              f"Whisparr returned {status}: {detail}")


def _whisparr_find(base, key, stash_id):
    """按 stashId 查已添加的影片。返回 (movie|None, (status, body)|None)。"""
    q = urllib.parse.quote(stash_id, safe="")
    status, body, _ = _whisparr_req(base, key, "GET", f"/api/v3/movie?stashId={q}")
    if status != 200:
        return None, (status, body)
    try:
        arr = json.loads(body)
    except ValueError:
        return None, (status, body)
    if isinstance(arr, list) and arr:
        return arr[0], None
    return None, None


def _whisparr_profiles_fetch(base, key):
    """GET /qualityprofile → (profiles, err)，profiles 按 id 升序。

    档案 id 就是发现页设置里存的值；插件不替用户挑档案。
    """
    status, body, _ = _whisparr_req(base, key, "GET", "/api/v3/qualityprofile")
    if status != 200:
        return [], (status, body)
    try:
        arr = json.loads(body) or []
    except ValueError:
        return [], (status, body)
    out = []
    for p in arr:
        if not isinstance(p, dict) or p.get("id") is None:
            continue
        out.append({"id": p.get("id"), "name": (p.get("name") or "").strip()})
    out.sort(key=lambda x: x["id"])
    return out, None


def do_whisparr_profiles(stash, zh=True):
    """发现页设置用：列出可选的质量档案。没配置 Whisparr 时 configured=False。"""
    base, key = _whisparr_cfg(stash.get_plugin_config())
    if not base or not key:
        emit_result({"mode": "whisparr_profiles", "configured": False, "profiles": []})
        return
    profiles, err = _whisparr_profiles_fetch(base, key)
    if err:
        emit_result({"mode": "whisparr_profiles", "configured": True, "ok": False,
                     "profiles": [], "error": _whisparr_err(err[0], err[1], zh)})
        return
    emit_result({"mode": "whisparr_profiles", "configured": True, "ok": True,
                 "profiles": profiles})


def do_whisparr_status(stash, stash_id, zh=True):
    base, key = _whisparr_cfg(stash.get_plugin_config())
    if not base or not key:
        emit_result({"mode": "whisparr", "configured": False})
        return
    if not stash_id:
        emit_result({"mode": "whisparr", "configured": True, "ok": False,
                     "message": _t(zh, "这条场景没有 stash-box ID", "This scene has no stash-box ID")})
        return
    movie, err = _whisparr_find(base, key, stash_id)
    if err:
        emit_result({"mode": "whisparr", "configured": True, "ok": False,
                     "message": _whisparr_err(err[0], err[1], zh)})
        return
    emit_result({"mode": "whisparr", "configured": True, "ok": True,
                 "exists": bool(movie),
                 "has_file": bool((movie or {}).get("hasFile"))})


def do_push_whisparr(stash, stash_id, title, year, profile_id, zh=True):
    base, key = _whisparr_cfg(stash.get_plugin_config())
    if not base or not key:
        emit_error(_t(zh, "Whisparr 未配置。设置里填 URL 和 API Key。",
                      "Whisparr is not configured — set the URL and API key."))
        return
    if not stash_id:
        emit_error(_t(zh, "这条场景没有 stash-box ID，无法交给 Whisparr。",
                      "This scene has no stash-box ID, so Whisparr can't match it."))
        return

    movie, err = _whisparr_find(base, key, stash_id)
    if err:
        emit_error(_whisparr_err(err[0], err[1], zh))
        return
    if movie:
        emit_result({"mode": "whisparr", "ok": True, "exists": True,
                     "message": _t(zh, "已在 Whisparr 里", "Already in Whisparr")})
        return

    status, body, _ = _whisparr_req(base, key, "GET", "/api/v3/rootfolder")
    folders = []
    if status == 200:
        try:
            folders = json.loads(body) or []
        except ValueError:
            folders = []
    if not folders:
        emit_error(_t(zh, "Whisparr 里没有根目录。先在 Whisparr 设置 → 媒体管理 里加一个。",
                      "No root folder in Whisparr. Add one under Settings → Media Management."))
        return
    root = (folders[0].get("path") or "")

    profiles, perr = _whisparr_profiles_fetch(base, key)
    if perr:
        emit_error(_whisparr_err(perr[0], perr[1], zh))
        return
    if not profiles:
        emit_error(_t(zh, "Whisparr 里没有质量档案。", "No quality profile in Whisparr."))
        return
    # 档案由发现页设置指定（值 = 档案 id）。没指定就回退：先找名字叫 Any 的，
    # 再退到 id 最小的那个。指定了但已不存在（用户改名/删档）也走同一回退，
    # 并在结果里说明用了哪个，免得他以为设置生效了。
    wanted = str(profile_id or "").strip()
    chosen = next((p for p in profiles if str(p["id"]) == wanted), None) if wanted else None
    missing = wanted if (wanted and not chosen) else ""
    if not chosen:
        chosen = next((p for p in profiles if p["name"].lower() == "any"), None) or profiles[0]

    payload = {
        "title": title or stash_id,
        "stashId": stash_id,
        "foreignId": stash_id,
        "monitored": True,
        "qualityProfileId": chosen["id"],
        "rootFolderPath": root,
        "addOptions": {"searchForMovie": True},
    }
    if year:
        try:
            payload["year"] = int(year)
        except (TypeError, ValueError):
            pass

    status, body, _ = _whisparr_req(base, key, "POST", "/api/v3/movie", payload)
    if status in (200, 201, 202):
        log_info(f"Sent scene {stash_id} to Whisparr (profile {chosen['id']} {chosen['name']})")
        if missing:
            msg = _t(zh, "未找到档案 " + missing + "，已用「" + chosen["name"] + "」发送",
                         "Profile " + missing + " not found — sent with " + chosen["name"])
        else:
            msg = _t(zh, "已发送到 Whisparr（" + chosen["name"] + "）",
                         "Sent to Whisparr (" + chosen["name"] + ")")
        emit_result({"mode": "whisparr", "ok": True, "exists": False,
                     "profile": chosen, "fallback": bool(missing),
                     "message": msg})
        return
    # 并发或重复点：校验器比查一次快，按「已在里面」处理
    if "MovieExistsValidator" in (body or ""):
        emit_result({"mode": "whisparr", "ok": True, "exists": True,
                     "message": _t(zh, "已在 Whisparr 里", "Already in Whisparr")})
        return
    emit_error(_whisparr_err(status, body, zh))


def _test_whisparr(cfg, zh=True):
    item = {"key": "whisparr", "label": "Whisparr", "ok": False, "detail": "", "hint": ""}
    base, key = _whisparr_cfg(cfg)
    # 没配不算失败：这是可选集成，配了才会出现发送按钮。但也别挂绿勾 ——
    # 绿勾意味着「测过了、通的」，未配置只是「用不上」，前端按三态渲染成短横线。
    if not base or not key:
        item["ok"] = True
        item["state"] = "skip"
        item["detail"] = _t(zh, "未配置（可选）", "Not configured (optional)")
        item["hint"] = _t(zh, "填 URL 与 API Key 后，stashdb 场景弹窗会出现发送按钮",
                          "Fill in the URL and API key to get the send button on stashdb scenes")
        return item
    status, body, _ = _whisparr_req(base, key, "GET", "/api/v3/system/status")
    if status != 200:
        item["detail"] = _whisparr_err(status, body, zh)
        return item
    ver = ""
    try:
        ver = (json.loads(body) or {}).get("version") or ""
    except ValueError:
        pass
    item["ok"] = True
    item["detail"] = f"{_host_of(base)} · Whisparr {ver or '?'}"
    status, body, _ = _whisparr_req(base, key, "GET", "/api/v3/rootfolder")
    root = ""
    if status == 200:
        try:
            arr = json.loads(body) or []
            root = (arr[0].get("path") or "") if arr else ""
        except (ValueError, IndexError, AttributeError):
            root = ""
    if root:
        item["hint"] = _t(zh, f"根目录 {root}", f"Root folder {root}")
    else:
        item["hint"] = _t(zh, "还没有根目录，发送会失败", "No root folder yet — sending will fail")
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
    items = [_test_jackett(cfg, zh), _test_downloader(cfg, zh), _test_whisparr(cfg, zh)]
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
            query = _safe_text(stash.get_arg("query", ""))
            if not query:
                emit_error(_t(zh, "没有搜索关键词。", "No search query provided."))
            else:
                do_search(stash, query, zh)
        elif mode == "push_download":
            magnet = _safe_text(stash.get_arg("magnet", ""))
            savepath = _safe_text(stash.get_arg("savepath", ""))
            do_push_download(stash, magnet, savepath, zh)
        elif mode == "whisparr_status":
            do_whisparr_status(stash, _safe_text(stash.get_arg("stash_id", "")), zh)
        elif mode == "whisparr_push":
            do_push_whisparr(
                stash,
                _safe_text(stash.get_arg("stash_id", "")),
                _safe_text(stash.get_arg("title", "")),
                _safe_text(stash.get_arg("year", "")),
                _safe_text(stash.get_arg("profile", "")),
                zh,
            )
        elif mode == "whisparr_profiles":
            do_whisparr_profiles(stash, zh)
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
