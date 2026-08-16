#!/usr/bin/env python3
"""Scene Translate Proxy Server

A lightweight HTTP proxy that forwards translation requests from the browser
to external translation APIs, bypassing CORS restrictions.

Usage:
  python translateProxy.py [--port 9998] [--config config.json]

Config file (config.json) supports // comments for documentation.
API keys are never sent to the browser — the proxy handles them server-side.

Endpoints:
  GET  /config    - Return browser-safe config (engine, targetLang)
  POST /translate - Translate text (JSON: {text, targetLang, engine, ...})
  GET  /status    - Check proxy status and configuration
  POST /shutdown  - Gracefully shut down the proxy server
"""

import sys
import json
import hashlib
import random
import re
import time
import argparse
import os
import signal
import socket
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.parse import urlencode



# ─── JSON with Comments Parser ─────────────────────────────────────────────

def strip_json_comments(text):
    """Remove // single-line comments from JSON text.
    Handles // outside of quoted strings only."""
    result = []
    in_string = False
    escape_next = False
    i = 0
    while i < len(text):
        c = text[i]
        if escape_next:
            result.append(c)
            escape_next = False
            i += 1
            continue
        if c == '\\' and in_string:
            result.append(c)
            escape_next = True
            i += 1
            continue
        if c == '"':
            in_string = not in_string
            result.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < len(text) and text[i + 1] == '/' and not in_string:
            while i < len(text) and text[i] != '\n':
                i += 1
            continue
        result.append(c)
        i += 1
    return ''.join(result)


def load_json_with_comments(path):
    """Load a JSON file that may contain // comments."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    cleaned = strip_json_comments(text)
    return json.loads(cleaned)


# ─── Settings ────────────────────────────────────────────────────────────────

DEFAULT_SETTINGS = {
    "proxyPort": 9998,
    "targetLanguage": "zh-CN",
    "translateTool": "google_free",
    "idleTimeout": 600,
    "googleApiKey": "",
    "microsoftApiKey": "",
    "microsoftRegion": "",
    "baiduAppId": "",
    "baiduSecret": "",
    "openaiApiKey": "",
    "openaiModel": "",
    "openaiBaseUrl": "",
    "deeplApiKey": "",
    "deeplFreeApi": False,
    "deeplBaseUrl": "",
}

_settings = dict(DEFAULT_SETTINGS)
_settings_path = ""

# ─── Idle Timeout ────────────────────────────────────────────────────────────

_last_active_time = time.time()
_idle_timer_lock = threading.Lock()


def reset_idle_timer():
    """Reset the idle timeout timer. Called on translate requests and restarts."""
    global _last_active_time
    with _idle_timer_lock:
        _last_active_time = time.time()


def get_idle_timeout():
    """Get idle timeout in seconds. 0 or negative means disabled."""
    timeout = _settings.get("idleTimeout", 600)
    return int(timeout) if timeout else 0


def start_lifecycle_monitor(server, stash_port):
    check_interval = 10

    def monitor():
        while True:
            time.sleep(check_interval)
            if stash_port is not None and not is_stash_alive_tcp(stash_port):
                log("Stash server closed, shutting down proxy...")
                server.shutdown()
                break
            # 每轮读取最新 idleTimeout（浏览器翻译请求会动态更新 _settings）
            timeout = get_idle_timeout()
            if timeout > 0:
                with _idle_timer_lock:
                    idle = time.time() - _last_active_time
                if idle >= timeout:
                    log(f"Idle for {int(idle)}s, shutting down proxy...")
                    server.shutdown()
                    break

    threading.Thread(target=monitor, daemon=True).start()
    if stash_port:
        log(f"Monitoring Stash on port {stash_port}")
    log(f"Idle timeout: {get_idle_timeout()}s (updated dynamically by browser)")


def load_settings(path):
    """Load settings from a JSON config file (supports // comments).
    Config is loaded once at startup; restart the proxy to reload."""
    global _settings, _settings_path
    _settings_path = path
    if path and os.path.exists(path):
        try:
            saved = load_json_with_comments(path)
            for k, v in saved.items():
                if v is not None and v != "" and k in _settings:
                    _settings[k] = v
            log(f"Settings loaded from {path}")
        except Exception as e:
            log(f"Warning: Failed to load settings from {path}: {e}")
    env_map = {
        "BAIDU_APP_ID": "baiduAppId",
        "BAIDU_SECRET": "baiduSecret",
        "GOOGLE_API_KEY": "googleApiKey",
        "MICROSOFT_API_KEY": "microsoftApiKey",
        "MICROSOFT_REGION": "microsoftRegion",
        "OPENAI_API_KEY": "openaiApiKey",
        "OPENAI_MODEL": "openaiModel",
        "OPENAI_BASE_URL": "openaiBaseUrl",
        "DEEPL_API_KEY": "deeplApiKey",
        "DEEPL_BASE_URL": "deeplBaseUrl",
    }
    for env_key, settings_key in env_map.items():
        val = os.environ.get(env_key, "")
        if val:
            _settings[settings_key] = val


# ─── Translation Engines ────────────────────────────────────────────────────

class TranslateError(Exception):
    pass


def google_free_translate(text, target_lang):
    """Google Translate free endpoint."""
    url = (
        "https://translate.googleapis.com/translate_a/single?"
        + urlencode({"client": "gtx", "sl": "auto", "tl": target_lang, "dt": "t", "q": text})
    )
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                translated = ""
                if data and isinstance(data, list):
                    for segment in data[0]:
                        if segment and isinstance(segment, list) and len(segment) > 0:
                            translated += segment[0]
                return translated or text
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
            else:
                raise TranslateError(f"Google free translate failed: {e}")
    return text


def google_api_translate(text, target_lang, api_key):
    """Google Cloud Translation API."""
    if not api_key:
        raise TranslateError("Google API Key is required")
    url = f"https://translation.googleapis.com/language/translate/v2?key={api_key}"
    body = json.dumps({"q": text, "source": "auto", "target": target_lang, "format": "text"}).encode("utf-8")
    req = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data["data"]["translations"][0]["translatedText"]


def microsoft_translate(text, target_lang, api_key, region="global"):
    """Microsoft Translator API."""
    if not api_key:
        raise TranslateError("Microsoft API Key is required")
    url = "https://api.cognitive.microsofttranslator.com/translate?" + urlencode({
        "api-version": "3.0", "from": "auto", "to": target_lang
    })
    body = json.dumps([{"text": text}]).encode("utf-8")
    headers = {"Ocp-Apim-Subscription-Key": api_key, "Content-Type": "application/json"}
    if region and region != "global":
        headers["Ocp-Apim-Subscription-Region"] = region
    req = Request(url, data=body, headers=headers)
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data[0]["translations"][0]["text"]


def baidu_translate(text, target_lang, app_id, secret_key):
    """Baidu Translate API."""
    if not app_id or not secret_key:
        raise TranslateError("Baidu App ID and Secret Key are required")
    salt = str(random.randint(32768, 65536))
    sign_str = app_id + text + salt + secret_key
    sign = hashlib.md5(sign_str.encode("utf-8")).hexdigest()
    lang_map = {
        "zh-CN": "zh", "zh-TW": "cht", "en": "en", "ja": "jp",
        "ko": "kor", "fr": "fra", "de": "de", "es": "spa",
        "ru": "ru", "pt": "pt", "it": "it", "ar": "ara",
    }
    to_lang = lang_map.get(target_lang, target_lang.split("-")[0].lower())
    params = urlencode({
        "q": text, "from": "auto", "to": to_lang,
        "appid": app_id, "salt": salt, "sign": sign,
    })
    url = f"https://fanyi-api.baidu.com/api/trans/vip/translate?{params}"
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        if "error_code" in data:
            raise TranslateError(f"Baidu error: {data['error_code']} - {data.get('error_msg', '')}")
        return data["trans_result"][0]["dst"]


def openai_translate(text, target_lang, api_key, model="", base_url=""):
    """OpenAI-compatible API."""
    if not api_key:
        raise TranslateError("OpenAI API Key is required")
    url = (base_url.rstrip("/") if base_url else "https://api.openai.com") + "/v1/chat/completions"
    body = json.dumps({
        "model": model or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": f"You are a professional translator. Translate the following text from auto to {target_lang}. Output ONLY the translated text, nothing else. Preserve the original formatting and line breaks."},
            {"role": "user", "content": text},
        ],
        "temperature": 0.3,
    }).encode("utf-8")
    req = Request(url, data=body, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"].strip()


def deepl_translate(text, target_lang, api_key, free_api=False, base_url=""):
    lang_map = {
        "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT", "en": "EN", "ja": "JA",
        "ko": "KO", "fr": "FR", "de": "DE", "es": "ES",
        "ru": "RU", "pt": "PT-BR", "it": "IT", "ar": "AR",
    }
    deepl_lang = lang_map.get(target_lang, target_lang.split("-")[0].upper())
    if base_url:
        url = base_url.rstrip("/")
        body = json.dumps({"text": text, "source_lang": "auto", "target_lang": deepl_lang}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = Request(url, data=body, headers=headers)
    else:
        if not api_key:
            raise TranslateError("DeepL API Key is required")
        official_lang_map = {
            "zh-CN": "ZH", "zh-TW": "ZH", "en": "EN", "ja": "JA",
            "ko": "KO", "fr": "FR", "de": "DE", "es": "ES",
            "ru": "RU", "pt": "PT", "it": "IT", "ar": "AR",
        }
        official_lang = official_lang_map.get(target_lang, target_lang.split("-")[0].upper())
        base = "https://api-free.deepl.com" if free_api else "https://api.deepl.com"
        url = f"{base}/v2/translate"
        body = urlencode({"auth_key": api_key, "text": text, "target_lang": official_lang}).encode("utf-8")
        req = Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        if "data" in data and isinstance(data.get("data"), str):
            return data["data"]
        if "translations" in data:
            return data["translations"][0]["text"]
        if "message" in data:
            raise TranslateError(f"DeepL error: {data['message']}")
        raise TranslateError(f"DeepL unexpected response: {data}")


def dispatch_translate(text, target_lang, engine, settings):
    """Dispatch translation to the appropriate engine."""
    if engine == "google_free":
        return google_free_translate(text, target_lang)
    elif engine == "google_api":
        return google_api_translate(text, target_lang, settings.get("googleApiKey", ""))
    elif engine == "microsoft":
        return microsoft_translate(text, target_lang, settings.get("microsoftApiKey", ""), settings.get("microsoftRegion", "global"))
    elif engine == "baidu":
        return baidu_translate(text, target_lang, settings.get("baiduAppId", ""), settings.get("baiduSecret", ""))
    elif engine == "openai":
        return openai_translate(text, target_lang, settings.get("openaiApiKey", ""), settings.get("openaiModel", ""), settings.get("openaiBaseUrl", ""))
    elif engine == "deepl":
        return deepl_translate(text, target_lang, settings.get("deeplApiKey", ""), settings.get("deeplFreeApi", False), settings.get("deeplBaseUrl", ""))
    else:
        raise TranslateError(f"Unknown translation engine: {engine}")


# ─── HTTP Handler ────────────────────────────────────────────────────────────

class TranslateProxyHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the translate proxy."""

    def log_message(self, format, *args):
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/config":
            self._handle_config()
        elif self.path == "/status":
            self._handle_status()
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        if self.path == "/translate":
            self._handle_translate()
        elif self.path == "/shutdown":
            self._handle_shutdown()
        else:
            self._send_json({"error": "Not found"}, 404)

    def _read_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            return {}
        raw = self.rfile.read(content_length)
        return json.loads(raw.decode("utf-8"))

    def _handle_shutdown(self):
        self._send_json({"status": "shutting_down"})
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def _handle_config(self):
        self._send_json({
            "translateTool": _settings.get("translateTool", "google_free"),
            "targetLanguage": _settings.get("targetLanguage", "zh-CN"),
        })

    def _handle_translate(self):
        reset_idle_timer()
        try:
            body = self._read_body()
        except Exception as e:
            self._send_json({"error": f"Invalid request body: {e}"}, 400)
            return

        # 浏览器每次翻译请求都会传 Stash 插件页的 idleTimeout，动态更新代理计时
        idle_timeout = body.get("idleTimeout")
        if idle_timeout is not None:
            try:
                new_timeout = int(idle_timeout)
                if new_timeout != _settings.get("idleTimeout"):
                    _settings["idleTimeout"] = new_timeout
                    log(f"Idle timeout updated from browser: {new_timeout}s")
            except (ValueError, TypeError):
                pass

        text = body.get("text", "")
        # 翻译引擎 / 目标语言由浏览器从 Stash 插件页传入，不再读 config.json
        target_lang = body.get("targetLang") or "zh-CN"
        engine = body.get("engine") or "google_free"

        req_settings = dict(_settings)
        for key in ("googleApiKey", "microsoftApiKey", "microsoftRegion",
                     "baiduAppId", "baiduSecret", "openaiApiKey", "openaiModel",
                     "openaiBaseUrl", "deeplApiKey", "deeplFreeApi", "deeplBaseUrl"):
            if key in body and body[key]:
                req_settings[key] = body[key]

        if not text or not text.strip():
            self._send_json({"translatedText": text})
            return

        try:
            start = time.time()
            translated = dispatch_translate(text, target_lang, engine, req_settings)
            elapsed = round(time.time() - start, 2)
            log(f"Translated [{engine}] {len(text)} chars -> {len(translated)} chars ({elapsed}s)")
            self._send_json({
                "translatedText": translated,
                "engine": engine,
                "targetLang": target_lang,
                "elapsed": elapsed,
            })
        except TranslateError as e:
            log(f"Translation error [{engine}]: {e}")
            self._send_json({"error": str(e), "engine": engine}, 400)
        except Exception as e:
            log(f"Unexpected error [{engine}]: {e}")
            self._send_json({"error": f"Internal error: {e}", "engine": engine}, 500)

    def _handle_status(self):
        engines_status = {
            "google_free": {"available": True, "needsKey": False},
            "google_api": {"available": bool(_settings.get("googleApiKey")), "needsKey": True},
            "microsoft": {"available": bool(_settings.get("microsoftApiKey")), "needsKey": True},
            "baidu": {"available": bool(_settings.get("baiduAppId") and _settings.get("baiduSecret")), "needsKey": True},
            "openai": {"available": bool(_settings.get("openaiApiKey")), "needsKey": True},
            "deepl": {"available": bool(_settings.get("deeplApiKey")), "needsKey": True},
        }
        idle_timeout = get_idle_timeout()
        idle_info = None
        if idle_timeout > 0:
            with _idle_timer_lock:
                idle_elapsed = int(time.time() - _last_active_time)
            idle_info = {
                "timeout": idle_timeout,
                "elapsed": idle_elapsed,
                "remaining": max(0, idle_timeout - idle_elapsed),
            }
        self._send_json({
            "status": "running",
            "version": "2.6.0",
            "currentEngine": _settings.get("translateTool", "google_free"),
            "currentLang": _settings.get("targetLanguage", "zh-CN"),
            "engines": engines_status,
            "idle": idle_info,
        })


# ─── Logging ────────────────────────────────────────────────────────────────

def log(message):
    print(str(message), file=sys.stderr, flush=True)


# ─── Process Lifecycle ──────────────────────────────────────────────────────

_stash_port = None

def is_proxy_running(port):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        result = s.connect_ex(("127.0.0.1", port))
        s.close()
        return result == 0
    except Exception:
        return False


def shutdown_proxy_via_http(port):
    try:
        req = Request(f"http://127.0.0.1:{port}/shutdown", data=b"", method="POST")
        with urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("status") == "shutting_down"
    except Exception:
        return False


def is_stash_alive_tcp(port):
    if port is None:
        return True
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        result = s.connect_ex(("127.0.0.1", port))
        s.close()
        return result == 0
    except Exception:
        return False


def detect_stash_port(stash_input=None):
    if stash_input:
        try:
            port = stash_input.get("server_connection", {}).get("Port")
            if port and is_stash_alive_tcp(port):
                return int(port)
        except Exception:
            pass
    for port in (9999, 8080):
        if is_stash_alive_tcp(port):
            return port
    return None


def kill_proxy_on_port(port):
    """Find and kill the process listening on the given port.
    Works on Windows (netstat + taskkill) and Linux (ss + kill).
    Returns True if a process was killed.
    """
    killed = False
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["netstat", "-ano", "|", "findstr", f":{port}"],
                capture_output=True, text=True, shell=True, timeout=5
            )
            for line in result.stdout.splitlines():
                parts = line.strip().split()
                if len(parts) >= 5 and "LISTENING" in line:
                    pid = parts[-1]
                    if pid.isdigit():
                        subprocess.run(["taskkill", "/F", "/PID", pid],
                                       capture_output=True, timeout=5)
                        killed = True
                        log(f"Killed old proxy process (PID {pid})")
                        break
        except Exception:
            pass
    else:
        try:
            result = subprocess.run(
                ["ss", "-tlnp", f"sport = :{port}"],
                capture_output=True, text=True, timeout=5
            )
            stdout = result.stdout
            if not stdout:
                result = subprocess.run(
                    ["netstat", "-tlnp"],
                    capture_output=True, text=True, timeout=5
                )
                stdout = result.stdout
            for line in stdout.splitlines():
                if f":{port}" in line:
                    m = re.search(r'pid=(\d+)', line)
                    if not m:
                        m = re.search(r'(\d+)/[^/\s]+$', line.strip())
                    if m:
                        pid = int(m.group(1))
                        os.kill(pid, signal.SIGTERM)
                        killed = True
                        log(f"Killed old proxy process (PID {pid})")
                        break
        except Exception:
            pass
    return killed


def spawn_background_process(args_without_detach):
    """Re-launch this script as a background child process."""
    cmd = [sys.executable] + args_without_detach

    if os.name == "nt":
        CREATE_NEW_PROCESS_GROUP = 0x200
        CREATE_NO_WINDOW = 0x08000000
        subprocess.Popen(
            cmd,
            creationflags=CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        subprocess.Popen(
            cmd,
            start_new_session=True,
            close_fds=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    log("Proxy launched in background (child process)")


def wait_for_proxy(port, max_wait=15):
    for i in range(max_wait * 5):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                s.close()
                break
            s.close()
        except Exception:
            pass
        time.sleep(0.2)
    else:
        return False
    try:
        req = Request(f"http://127.0.0.1:{port}/status")
        with urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("status") == "running"
    except Exception:
        return True


# ─── Main ────────────────────────────────────────────────────────────────────

def read_stash_input():
    try:
        if sys.stdin.isatty():
            return None
        raw = sys.stdin.read()
        if not raw or not raw.strip():
            return None
        data = json.loads(raw)
        result = data.get("args", {})
        if "server_connection" in data:
            result["server_connection"] = data["server_connection"]
        return result if result else None
    except Exception:
        return None


def main():
    parser = argparse.ArgumentParser(description="Scene Translate Proxy Server")
    parser.add_argument("--port", type=int, default=0, help="Port to listen on (default: from config or 9998)")
    parser.add_argument("--config", default="", help="Path to config.json (supports // comments)")
    parser.add_argument("--detach", action="store_true", help="Run as detached background process (for Stash task)")
    parser.add_argument("--restart", action="store_true", help="Restart: kill existing proxy before starting (for Stash task)")
    parser.add_argument("--stash-port", type=int, default=0, help="Stash server port (for GraphQL sync)")
    args = parser.parse_args()

    # Check if called by Stash with task args via stdin
    stash_args = read_stash_input()
    if stash_args and stash_args.get("restart"):
        args.restart = True

    if not args.config:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        default_path = os.path.join(script_dir, "config.json")
        if os.path.exists(default_path):
            args.config = default_path

    load_settings(args.config)

    port = args.port or int(_settings.get("proxyPort", 9998))

    # ── Launcher mode (exec or task): start background child and exit ──
    # Stash exec/task should not run the server directly — spawn a background
    # child process instead, so Stash doesn't wait for us or kill us.
    if not args.detach:
        if is_proxy_running(port):
            if args.restart:
                log(f"Restart requested, shutting down proxy on port {port}...")
                if not shutdown_proxy_via_http(port):
                    log("HTTP shutdown failed, force killing...")
                    kill_proxy_on_port(port)
                for _ in range(25):
                    time.sleep(0.2)
                    if not is_proxy_running(port):
                        break
                else:
                    if is_proxy_running(port):
                        log(f"Warning: Could not confirm old proxy stopped on port {port}")
            else:
                log(f"Proxy already running on port {port}")
                return

        if is_proxy_running(port):
            log(f"Proxy still running on port {port}, cannot start")
            return

        child_args = [os.path.abspath(__file__), "--detach"]
        if args.port:
            child_args += ["--port", str(args.port)]
        if args.config:
            child_args += ["--config", args.config]
        # 传递 Stash 端口给子进程（用于代理生命周期监控：Stash 关闭时自动退出）
        detected_port = detect_stash_port(stash_args)
        if detected_port:
            child_args += ["--stash-port", str(detected_port)]
        spawn_background_process(child_args)

        if wait_for_proxy(port, max_wait=15):
            log(f"Proxy started successfully on port {port}")
        else:
            log(f"Warning: Proxy may not have started on port {port}")
        return

    # ── Detach mode: run the proxy server in background ──
    if is_proxy_running(port):
        log(f"Proxy already running on port {port}, exiting")
        return

    global _stash_port
    _stash_port = args.stash_port or detect_stash_port(stash_args)
    if _stash_port:
        log(f"Detected Stash on port {_stash_port}")
    else:
        log("No Stash port detected (idle timeout only)")

    server = HTTPServer(("127.0.0.1", port), TranslateProxyHandler)

    def shutdown(signum, frame):
        log("Shutting down proxy server...")
        server.shutdown()

    signal.signal(signal.SIGINT, shutdown)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, shutdown)

    log(f"")
    log(f"  Scene Translate Proxy v2.6.0")
    log(f"  http://127.0.0.1:{port}")
    log(f"  Engine/Target: supplied per-request from Stash plugin UI")
    if args.config:
        log(f"  Config: {args.config} (proxyPort + API keys)")
    log(f"")

    start_lifecycle_monitor(server, _stash_port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log("Proxy server stopped.")


if __name__ == "__main__":
    main()
