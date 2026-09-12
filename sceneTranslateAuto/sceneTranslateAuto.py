#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Scene Translate Auto v1.2.0: 自动翻译场景标题/简介为目标语言（sceneTranslate 的无 UI 版本）。

- 钩子 Scene.Create.Post / Scene.Update.Post：预检（语言启发式 + 番号/长度过滤）通过后，
  写入 pending 队列并 spawn 单例后台 worker 处理（hook 保持零网络、毫秒级返回）。
- 任务 "Full Scan & Translate"（手动触发）：全库分页扫描存量场景，按 batchSize 分组并发翻译 + 限速 + 断点续扫（缓存跳过）。
- 语言判断：番号全文匹配跳过；含日文假名判日文；含 CJK 无假名判已译（中文）；含谚文判韩语；
  含西里尔文判俄语；含阿拉伯文判阿拉伯语；含拉丁扩展变音符判拉丁语族（法/德/西/葡/意共用）；
  纯 ASCII 判英文；其余 other。目标语言支持 zh-CN/zh-TW/en/ja/ko/ru/ar/fr/de/es/pt/it。
  翻译后复检：结果已是目标语言且与原文不同才写回（防循环主防线）。
- 写回仅 title/details 字段（sceneUpdate / galleryUpdate），code（番号）字段绝不写。
- 图库同步：worker 处理场景时顺带翻译其关联 galleries 的 title/details（按图库自身语言判断，
  已译/手动编辑过的图库不碰；galleryUpdate 写回不触发本插件 hook，无循环）。由 Stash 设置页
  gallerySync 开关控制（默认开）。
- 标准库 only。引擎密钥与限速等参数在插件目录 config.json；引擎/语言/并发在 Stash 插件页。
"""

import sys
import json
import os
import re
import time
import random
import hashlib
import datetime
import threading
import subprocess
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(PLUGIN_DIR, "config.json")
STATE_DIR = os.path.join(PLUGIN_DIR, "auto_state")
PENDING_DIR = os.path.join(STATE_DIR, "pending")
LOG = os.path.join(PLUGIN_DIR, "scene_translate_auto.log")
PID_FILE = os.path.join(STATE_DIR, "worker.pid")
CACHE_FILE = os.path.join(STATE_DIR, "translated_cache.json")
DEAD_FILE = os.path.join(STATE_DIR, "dead_letter.jsonl")

# ─── 默认配置（config.json 覆盖；引擎/语言/开关/并发由 Stash 插件页覆盖）──────────
DEFAULTS = {
    "googleApiKey": "",
    "microsoftApiKey": "",
    "microsoftRegion": "global",
    "baiduAppId": "",
    "baiduSecret": "",
    "openaiApiKey": "",
    "openaiModel": "gpt-4o-mini",
    "openaiBaseUrl": "",
    "deeplApiKey": "",
    "deeplFreeApi": False,
    "deeplBaseUrl": "",
    "rateLimits": {"google_free": 3, "google_api": 3, "microsoft": 2, "baidu": 1, "openai": 2, "deepl": 2},
    "batchSize": 10,
    "gallerySync": True,
    "codePattern": r"[A-Za-z]{2,10}[-_ ]?\d{2,6}",
    "minLength": 4,
    "cacheHours": 24,
    # Stash 插件页默认（GraphQL 未读到设置时兜底）
    "translateTool": "google_free",
    "targetLanguage": "zh-CN",
    "scanAllConcurrency": 3,
}

# ─── JSON with Comments Parser（与 translateProxy.py 一致）─────────────────────

def strip_json_comments(text):
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
        if c == "\\" and in_string:
            result.append(c)
            escape_next = True
            i += 1
            continue
        if c == '"':
            in_string = not in_string
            result.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < len(text) and text[i + 1] == "/" and not in_string:
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        result.append(c)
        i += 1
    return "".join(result)


def load_config_json():
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.loads(strip_json_comments(f.read()))
    except Exception as e:
        log("config load error: %s" % e)
        return {}


# ─── 配置合并 ──────────────────────────────────────────────────────────────────

# config.json engines 分区块字段 → 平铺设置字段的显式映射（引擎密钥分区配置）
ENGINE_FIELD_MAP = {
    "google_api": {"apiKey": "googleApiKey"},
    "microsoft": {"apiKey": "microsoftApiKey", "region": "microsoftRegion"},
    "baidu": {"appId": "baiduAppId", "secret": "baiduSecret"},
    "openai": {"apiKey": "openaiApiKey", "model": "openaiModel", "baseUrl": "openaiBaseUrl"},
    "deepl": {"apiKey": "deeplApiKey", "freeApi": "deeplFreeApi", "baseUrl": "deeplBaseUrl"},
}


def merged_settings(stash_cfg):
    s = dict(DEFAULTS)
    s["rateLimits"] = dict(DEFAULTS["rateLimits"])
    file_cfg = load_config_json()
    for k, v in file_cfg.items():
        if k == "engines":
            continue
        if isinstance(v, dict) and isinstance(s.get(k), dict):
            s[k].update(v)
        else:
            s[k] = v
    # engines 分区块展开为平铺（分区配置优先于平铺兼容字段）
    engines = file_cfg.get("engines")
    if isinstance(engines, dict):
        for eng, fields in ENGINE_FIELD_MAP.items():
            blk = engines.get(eng)
            if isinstance(blk, dict):
                for src, dst in fields.items():
                    if src in blk and blk[src] not in (None, ""):
                        s[dst] = blk[src]
    if stash_cfg:
        for k in ("translateTool", "targetLanguage", "scanAllConcurrency", "gallerySync"):
            if k in stash_cfg and stash_cfg[k] not in (None, ""):
                s[k] = stash_cfg[k]
    return s


# ─── 日志 ─────────────────────────────────────────────────────────────────────

def log(msg):
    line = "%s [sta-backend] %s" % (datetime.datetime.now().isoformat(), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass


# ─── GraphQL ──────────────────────────────────────────────────────────────────

def make_gql(conn):
    scheme = conn.get("Scheme", "http")
    host = conn.get("Host") or "localhost"
    if host in ("0.0.0.0", ""):
        host = "localhost"
    port = conn.get("Port", 9999)
    url = "%s://%s:%s/graphql" % (scheme, host, port)
    cookie = conn.get("SessionCookie") or {}
    ck = cookie.get("Value")
    ck_name = cookie.get("Name", "session")
    cfg_dir = conn.get("Dir") or ""
    _api_key_state = {"loaded": False, "key": None}

    def _load_api_key():
        if _api_key_state["loaded"] or not cfg_dir:
            return
        _api_key_state["loaded"] = True
        try:
            with open(os.path.join(cfg_dir, "config.yml"), "r", encoding="utf-8") as f:
                for line in f:
                    m = re.match(r"^\s*api_key:\s*[\"']?([A-Za-z0-9._~-]+)", line)
                    if m:
                        _api_key_state["key"] = m.group(1)
                        return
        except Exception:
            pass

    def _call(headers, query, variables, timeout):
        data = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        req = Request(url, data=data, headers=headers)
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    def gql(query, variables=None, timeout=90):
        headers = {"Content-Type": "application/json"}
        if ck:
            headers["Cookie"] = "%s=%s" % (ck_name, ck)
        try:
            j = _call(headers, query, variables, timeout)
        except Exception:
            _load_api_key()
            if _api_key_state["key"]:
                j = _call({"Content-Type": "application/json", "ApiKey": _api_key_state["key"]},
                          query, variables, timeout)
            else:
                raise
        if j.get("errors"):
            raise RuntimeError(j["errors"])
        return j["data"]

    return gql


Q_PLUGINS = "query { configuration { plugins } }"
Q_SCENE = ("query($id: ID!){ findScene(id:$id){ id title details "
           "galleries { id title details } } }")
Q_SCENES_PAGE = ("query($filter: FindFilterType!, $scene_filter: SceneFilterType){ "
                 "findScenes(filter: $filter, scene_filter: $scene_filter){ count scenes{ "
                 "id title details galleries { id title details } } } }")
M_SCENE_UPDATE = "mutation($i: SceneUpdateInput!){ sceneUpdate(input:$i){ id title details } }"
M_GALLERY_UPDATE = "mutation($i: GalleryUpdateInput!){ galleryUpdate(input:$i){ id title details } }"


def read_stash_plugin_config(gql):
    try:
        data = gql(Q_PLUGINS)
        plugins = ((data or {}).get("configuration") or {}).get("plugins") or {}
        return plugins.get("sceneTranslateAuto") or {}
    except Exception:
        return {}


def find_scene(gql, sid):
    try:
        data = gql(Q_SCENE, {"id": str(sid)})
        return ((data or {}).get("findScene")) or {}
    except Exception as e:
        log("findScene %s error: %s" % (sid, e))
        return {}


def update_scene(gql, sid, fields):
    gql(M_SCENE_UPDATE, {"i": {"id": str(sid), **fields}})


# ─── 语言检测（启发式，无网络）────────────────────────────────────────────────

def classify(text, code_pattern):
    t = (text or "").strip()
    if not t:
        return "empty"
    try:
        if re.fullmatch(code_pattern, t):
            return "code"
    except Exception:
        pass
    if re.search(r"[\u3040-\u30ff]", t):
        return "ja"
    if re.search(r"[\u4e00-\u9fff]", t):
        return "zh"
    if re.search(r"[\uAC00-\uD7AF]", t):
        return "ko"                    # 韩语：谚文音节（字符独立，零误判）
    if re.search(r"[\u0400-\u04FF]", t):
        return "ru"                    # 俄语：西里尔文（字符独立，零误判）
    if re.search(r"[\u0600-\u06FF]", t):
        return "ar"                    # 阿拉伯语
    # 拉丁扩展变音符区（法/德/西/葡/意共用，无法区分彼此）
    if re.search(r"[\u00C0-\u017F\u1E9E\u00BF\u00A1]", t):
        return "latin_ext"
    letters = sum(1 for c in t if c.isascii() and c.isalpha())
    if letters and letters / len(t) > 0.5:
        return "en"
    return "other"


def needs_translation(text, target_lang, code_pattern, min_length):
    if not text or not text.strip():
        return False
    if len(text.strip()) < min_length:
        return False
    cls = classify(text, code_pattern)
    if cls in ("empty", "code"):
        return False
    tl = (target_lang or "zh-CN").lower()
    if tl.startswith("zh"):
        if cls in ("ja", "en", "ko", "ru", "latin_ext", "ar", "other"):
            return True
        # 番号 + 汉字（无假名）：JAV 标题高频形态（如 ABC-123 美少女），视为日文需翻译
        if cls == "zh":
            try:
                if re.search(code_pattern, text):
                    return True
            except Exception:
                pass
        return False
    if tl.startswith("en"):
        return cls in ("ja", "zh", "ko", "ru", "latin_ext", "ar", "other")
    if tl.startswith("ja"):
        return cls in ("zh", "en", "ko", "ru", "latin_ext", "ar", "other")
    if tl.startswith("ko"):
        return cls in ("zh", "ja", "en", "ru", "latin_ext", "ar", "other")
    if tl.startswith("ru"):
        return cls in ("zh", "ja", "en", "ko", "latin_ext", "ar", "other")
    if tl.startswith("ar"):
        return cls in ("zh", "ja", "en", "ko", "ru", "latin_ext", "other")
    # 拉丁扩展语族（法/德/西/葡/意）：含变音符视为已译（跳过）；纯 ASCII 英文/其他语种需翻译
    if tl in ("fr", "de", "es", "pt", "it"):
        return cls in ("zh", "ja", "ko", "ru", "ar", "en", "other")
    return True


def is_target_language(text, target_lang, code_pattern):
    """复检判据（与预检 needs_translation 分离）：文本是否已是目标语言。
    番号不影响判定（ABC-123 中文标题 → 已是中文）。"""
    cls = classify(text, code_pattern)
    if cls in ("empty", "code"):
        return True
    tl = (target_lang or "zh-CN").lower()
    if tl.startswith("zh"):
        return cls == "zh"
    if tl.startswith("en"):
        return cls == "en"
    if tl.startswith("ja"):
        return cls == "ja"
    if tl.startswith("ko"):
        return cls == "ko"
    if tl.startswith("ru"):
        return cls == "ru"
    if tl.startswith("ar"):
        return cls == "ar"
    # 拉丁扩展语族（法/德/西/葡/意）：含变音符即视为已是目标语言
    if tl in ("fr", "de", "es", "pt", "it") and cls == "latin_ext":
        return True
    return False


def protect_codes(text, code_pattern):
    """提取番号 token 换成字母占位符（避免控制字符被翻译 API 丢弃），翻译后原样还原。"""
    tokens = []

    def repl(m):
        tokens.append(m.group(0))
        return "__STACODE%d__" % (len(tokens) - 1)

    try:
        return re.sub(code_pattern, repl, text), tokens
    except Exception:
        return text, tokens


def restore_codes(text, tokens):
    for i, tok in enumerate(tokens):
        text = text.replace("__STACODE%d__" % i, tok)
    return text


def ensure_codes(text, tokens):
    """兜底：占位符被翻译引擎丢弃时，把缺失的番号补回文本开头（防番号丢失）。"""
    missing = [t for t in tokens if t and t not in text]
    if missing:
        return (" ".join(missing) + " " + text).strip()
    return text


# ─── 翻译引擎（多段/单条，逻辑源自 translateProxy.py）────────────────────────

class TranslateError(Exception):
    pass


def google_free_translate_multi(texts, target_lang):
    url = "https://translate.googleapis.com/translate_a/single?" + urlencode(
        [("client", "gtx"), ("sl", "auto"), ("tl", target_lang), ("dt", "t")] +
        [("q", t) for t in texts])
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            segs = data[0] if data and isinstance(data[0], list) else None
            if not segs:
                return list(texts)
            # 多 q：外层每段对应一个 q，内层是该 q 的分段
            if isinstance(segs[0], list) and segs[0] and isinstance(segs[0][0], list):
                out = []
                for q_segs in segs:
                    out.append("".join(s[0] for s in q_segs if isinstance(s, list) and s and s[0]))
                if len(out) == len(texts):
                    return out
            # 单 q 扁平
            return ["".join(s[0] for s in segs if isinstance(s, list) and s and s[0])]
        except Exception as e:
            if attempt < 2:
                time.sleep(1)
            else:
                raise TranslateError("Google free translate failed: %s" % e)
    return list(texts)


def google_api_translate_multi(texts, target_lang, api_key):
    if not api_key:
        raise TranslateError("Google API Key is required")
    url = "https://translation.googleapis.com/language/translate/v2?key=%s" % api_key
    body = json.dumps({"q": texts, "source": "auto", "target": target_lang, "format": "text"}).encode("utf-8")
    req = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [t["translatedText"] for t in data["data"]["translations"]]


def microsoft_translate_multi(texts, target_lang, api_key, region="global"):
    if not api_key:
        raise TranslateError("Microsoft API Key is required")
    url = "https://api.cognitive.microsofttranslator.com/translate?" + urlencode(
        {"api-version": "3.0", "from": "auto", "to": target_lang})
    body = json.dumps([{"text": t} for t in texts]).encode("utf-8")
    headers = {"Ocp-Apim-Subscription-Key": api_key, "Content-Type": "application/json"}
    if region and region != "global":
        headers["Ocp-Apim-Subscription-Region"] = region
    req = Request(url, data=body, headers=headers)
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [r["translations"][0]["text"] for r in data]


def deepl_translate_multi(texts, target_lang, api_key, free_api=False, base_url=""):
    lang_map = {
        "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT", "en": "EN", "ja": "JA", "ko": "KO",
        "fr": "FR", "de": "DE", "es": "ES", "ru": "RU", "pt": "PT-BR", "it": "IT", "ar": "AR",
    }
    deepl_lang = lang_map.get(target_lang, target_lang.split("-")[0].upper())
    if base_url:
        url = base_url.rstrip("/")
        body = json.dumps({"text": texts, "source_lang": "auto", "target_lang": deepl_lang}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = "Bearer %s" % api_key
        req = Request(url, data=body, headers=headers)
    else:
        if not api_key:
            raise TranslateError("DeepL API Key is required")
        official_lang_map = {
            "zh-CN": "ZH", "zh-TW": "ZH", "en": "EN", "ja": "JA", "ko": "KO",
            "fr": "FR", "de": "DE", "es": "ES", "ru": "RU", "pt": "PT", "it": "IT", "ar": "AR",
        }
        official_lang = official_lang_map.get(target_lang, target_lang.split("-")[0].upper())
        base = "https://api-free.deepl.com" if free_api else "https://api.deepl.com"
        url = "%s/v2/translate" % base
        body = json.dumps({"text": texts, "target_lang": official_lang}).encode("utf-8")
        req = Request(url, data=body, headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "translations" in data:
        return [t["text"] for t in data["translations"]]
    if "message" in data:
        raise TranslateError("DeepL error: %s" % data["message"])
    raise TranslateError("DeepL unexpected response: %s" % data)


def baidu_translate(text, target_lang, app_id, secret_key):
    if not app_id or not secret_key:
        raise TranslateError("Baidu App ID and Secret Key are required")
    salt = str(random.randint(32768, 65536))
    sign_str = app_id + text + salt + secret_key
    sign = hashlib.md5(sign_str.encode("utf-8")).hexdigest()
    lang_map = {
        "zh-CN": "zh", "zh-TW": "cht", "en": "en", "ja": "jp", "ko": "kor",
        "fr": "fra", "de": "de", "es": "spa", "ru": "ru", "pt": "pt", "it": "it", "ar": "ara",
    }
    to_lang = lang_map.get(target_lang, target_lang.split("-")[0].lower())
    params = urlencode({"q": text, "from": "auto", "to": to_lang,
                        "appid": app_id, "salt": salt, "sign": sign})
    url = "https://fanyi-api.baidu.com/api/trans/vip/translate?%s" % params
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error_code" in data:
        raise TranslateError("Baidu error: %s - %s" % (data["error_code"], data.get("error_msg", "")))
    return data["trans_result"][0]["dst"]


def openai_translate(text, target_lang, api_key, model="", base_url=""):
    if not api_key:
        raise TranslateError("OpenAI API Key is required")
    url = (base_url.rstrip("/") if base_url else "https://api.openai.com") + "/v1/chat/completions"
    body = json.dumps({
        "model": model or "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "You are a professional translator. Translate the following text from auto to %s. Output ONLY the translated text, nothing else. Preserve the original formatting and line breaks." % target_lang},
            {"role": "user", "content": text},
        ],
        "temperature": 0.3,
    }).encode("utf-8")
    req = Request(url, data=body, headers={
        "Authorization": "Bearer %s" % api_key,
        "Content-Type": "application/json",
    })
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"].strip()


def dispatch_translate_multi(texts, target_lang, engine, settings):
    if not texts:
        return []
    if engine == "google_free":
        return google_free_translate_multi(texts, target_lang)
    if engine == "google_api":
        return google_api_translate_multi(texts, target_lang, settings.get("googleApiKey", ""))
    if engine == "microsoft":
        return microsoft_translate_multi(texts, target_lang, settings.get("microsoftApiKey", ""),
                                         settings.get("microsoftRegion", "global"))
    if engine == "deepl":
        return deepl_translate_multi(texts, target_lang, settings.get("deeplApiKey", ""),
                                     settings.get("deeplFreeApi", False), settings.get("deeplBaseUrl", ""))
    out = []
    for t in texts:
        if engine == "baidu":
            out.append(baidu_translate(t, target_lang, settings.get("baiduAppId", ""),
                                       settings.get("baiduSecret", "")))
        elif engine == "openai":
            out.append(openai_translate(t, target_lang, settings.get("openaiApiKey", ""),
                                        settings.get("openaiModel", ""), settings.get("openaiBaseUrl", "")))
        else:
            raise TranslateError("Unknown translation engine: %s" % engine)
    return out


# ─── 限速器（令牌桶，线程安全）───────────────────────────────────────────────

class RateLimiter:
    def __init__(self, qps):
        self._interval = (1.0 / qps) if qps and qps > 0 else 0.0
        self._lock = threading.Lock()
        self._next = 0.0

    def acquire(self):
        if self._interval <= 0:
            return
        with self._lock:
            now = time.time()
            wait = self._next - now
            if wait > 0:
                time.sleep(wait)
            self._next = max(now, self._next) + self._interval


def qps_for(settings):
    engine = settings.get("translateTool") or "google_free"
    rl = settings.get("rateLimits") or {}
    try:
        return float(rl.get(engine, 2))
    except Exception:
        return 2.0


# ─── 缓存 / dead-letter ──────────────────────────────────────────────────────

_cache_lock = threading.Lock()


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_cache(cache):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with _cache_lock:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
    except Exception as e:
        log("cache save error: %s" % e)


def cache_hit(cache, sid, title, details, cache_hours):
    e = cache.get(str(sid))
    if not e:
        return False
    if e.get("title") != (title or "") or e.get("details") != (details or ""):
        return False
    try:
        at = float(e.get("at", 0))
    except Exception:
        return False
    return (time.time() - at) <= (cache_hours or 24) * 3600


def log_dead(sid, reason):
    try:
        os.makedirs(os.path.dirname(DEAD_FILE), exist_ok=True)
        with open(DEAD_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": datetime.datetime.now().isoformat(),
                                "scene_id": str(sid), "reason": str(reason)},
                               ensure_ascii=False) + "\n")
    except Exception:
        pass


# ─── 单实体翻译 + 写回 ───────────────────────────────────────────────────────

def translate_entity(gql, kind, eid, title, details, settings, cache, limiter):
    """翻译单实体 title/details（kind: scene|gallery，eid 为该实体 id）。
    成功写回返回 {field: new_value}；无需处理返回 None。
    缓存键区分实体：scene 用裸 id，gallery 用 'g:'+id（互不冲突）。"""
    title = (title or "").strip()
    details = (details or "").strip()
    target = settings.get("targetLanguage") or "zh-CN"
    code_pat = settings.get("codePattern") or DEFAULTS["codePattern"]
    min_len = 0
    try:
        min_len = int(settings.get("minLength") or 0)
    except Exception:
        pass
    title_need = needs_translation(title, target, code_pat, min_len)
    details_need = needs_translation(details, target, code_pat, min_len)
    if not title_need and not details_need:
        return None
    ckey = ("g:" if kind == "gallery" else "") + str(eid)
    with _cache_lock:
        if cache_hit(cache, ckey, title, details, settings.get("cacheHours") or 24):
            return None
    texts, fields = [], []
    if title_need:
        texts.append(title)
        fields.append("title")
    if details_need:
        texts.append(details)
        fields.append("details")
    protected, tokens = [], []
    for t in texts:
        p, toks = protect_codes(t, code_pat)
        protected.append(p)
        tokens.append(toks)
    engine = settings.get("translateTool") or "google_free"
    limiter.acquire()
    try:
        translated = dispatch_translate_multi(protected, target, engine, settings)
    except Exception as e:
        raise RuntimeError("translate failed [%s]: %s" % (engine, e))
    restored = [ensure_codes(restore_codes(tr or "", toks), toks)
                for tr, toks in zip(translated, tokens)]
    updates = {}
    for f, orig, new in zip(fields, texts, restored):
        new = (new or "").strip()
        # 只写回「已是目标语言」且「与原文不同」的结果（防循环 + 防引擎原样/半吊子返回）
        if new and new != orig and is_target_language(new, target, code_pat):
            updates[f] = new
    if not updates:
        return None
    if kind == "gallery":
        gql(M_GALLERY_UPDATE, {"i": {"id": str(eid), **updates}})
    else:
        update_scene(gql, str(eid), updates)
    with _cache_lock:
        cache[ckey] = {"at": time.time(), "title": title, "details": details}
    return updates


# ─── pending 队列 + 单例 worker ──────────────────────────────────────────────

def enqueue_task(conn, sid):
    os.makedirs(PENDING_DIR, exist_ok=True)
    tf = os.path.join(PENDING_DIR, "%s.json" % sid)
    try:
        with open(tf, "w", encoding="utf-8") as f:
            json.dump({"scene_id": str(sid), "server_connection": conn}, f)
    except Exception as e:
        log("enqueue error: %s" % e)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def spawn_worker():
    """单例 worker：pid 锁原子创建，已有存活 worker 则不再 spawn。"""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
    except Exception:
        pass
    try:
        if os.path.exists(PID_FILE):
            try:
                with open(PID_FILE, "r", encoding="utf-8") as f:
                    pid = int(f.read().strip())
            except Exception:
                pid = 0
            if pid and pid_alive(pid):
                return False
            os.unlink(PID_FILE)
    except OSError:
        pass
    try:
        fd = os.open(PID_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode("utf-8"))
        os.close(fd)
    except OSError:
        return False
    log_path = os.path.join(STATE_DIR, "worker.log")
    script = os.path.abspath(__file__)
    args = [sys.executable, script, "--mode", "worker"]
    try:
        log_fh = open(log_path, "a", encoding="utf-8")
        if os.name == "nt":
            subprocess.Popen(args, creationflags=0x00000008 | 0x00000200, close_fds=True,
                             cwd=os.path.dirname(script), stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=log_fh)
        else:
            subprocess.Popen(args, start_new_session=True, close_fds=True,
                             cwd=os.path.dirname(script), stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=log_fh)
        log_fh.close()
    except Exception as e:
        try:
            log_fh.close()
        except Exception:
            pass
        try:
            os.unlink(PID_FILE)
        except OSError:
            pass
        log("worker spawn error: %s" % e)
        return False
    return True


def process_task(conn, sid, settings, limiter):
    gql = make_gql(conn)
    scene = find_scene(gql, sid)
    if not scene:
        log("scene %s not found, dropped" % sid)
        return
    cache = load_cache()
    updates = translate_entity(gql, "scene", sid, scene.get("title"), scene.get("details"),
                               settings, cache, limiter)
    if updates:
        log("scene %s translated: %s" % (sid, ",".join(updates.keys())))
    g_ok = 0
    if settings.get("gallerySync"):
        for g in scene.get("galleries") or []:
            gid = g.get("id")
            if not gid:
                continue
            try:
                gu = translate_entity(gql, "gallery", gid, g.get("title"), g.get("details"),
                                      settings, cache, limiter)
                if gu:
                    g_ok += 1
                    log("gallery %s translated: %s" % (gid, ",".join(gu.keys())))
            except Exception as e:
                log("gallery %s error: %s" % (gid, e))
                log_dead("g:%s" % gid, e)
    if updates or g_ok:
        save_cache(cache)
    if not updates and not g_ok:
        log("scene %s nothing to translate" % sid)


def worker_main():
    try:
        with open(PID_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
    settings = None
    limiter = None
    processed = 0
    while True:
        try:
            files = sorted(f for f in os.listdir(PENDING_DIR) if f.endswith(".json")) \
                if os.path.isdir(PENDING_DIR) else []
        except OSError:
            files = []
        if not files:
            break
        for fn in files:
            tf = os.path.join(PENDING_DIR, fn)
            try:
                with open(tf, "r", encoding="utf-8") as f:
                    task = json.load(f)
            except Exception as e:
                log("task read error %s: %s" % (fn, e))
                try:
                    os.unlink(tf)
                except OSError:
                    pass
                continue
            sid = task.get("scene_id")
            conn = task.get("server_connection") or {}
            try:
                if settings is None:
                    gql0 = make_gql(conn)
                    stash_cfg = read_stash_plugin_config(gql0)
                    settings = merged_settings(stash_cfg)
                    limiter = RateLimiter(qps_for(settings))
                process_task(conn, sid, settings, limiter)
                processed += 1
            except Exception as e:
                log("scene %s error: %s" % (sid, e))
                log_dead(sid, e)
            try:
                os.unlink(tf)
            except OSError:
                pass
    try:
        with open(PID_FILE, "r", encoding="utf-8") as f:
            cur = f.read().strip()
        if cur == str(os.getpid()):
            os.unlink(PID_FILE)
    except OSError:
        pass
    log("worker finished, processed %d task(s)" % processed)


# ─── Hook 路径 ───────────────────────────────────────────────────────────────

def handle_hook(payload):
    ctx = ((payload.get("args") or {}).get("hookContext")) or {}
    sid = ctx.get("id")
    htype = ctx.get("type", "")
    if not sid or "Scene." not in htype:
        print(json.dumps({"output": "skip (not scene hook)"}))
        return
    conn = payload.get("server_connection") or {}
    gql = make_gql(conn)
    settings = merged_settings(read_stash_plugin_config(gql))
    scene = find_scene(gql, sid)
    if not scene:
        print(json.dumps({"output": "skip (scene not found)"}))
        return
    title = (scene.get("title") or "").strip()
    details = (scene.get("details") or "").strip()
    target = settings.get("targetLanguage") or "zh-CN"
    code_pat = settings.get("codePattern") or DEFAULTS["codePattern"]
    min_len = 0
    try:
        min_len = int(settings.get("minLength") or 0)
    except Exception:
        pass
    need = needs_translation(title, target, code_pat, min_len) or \
        needs_translation(details, target, code_pat, min_len)
    if not need:
        # 场景无需翻译时仍检查关联图库（场景已译但图库日文 → 入队补齐）；gallerySync 关闭时跳过
        if settings.get("gallerySync"):
            for g in scene.get("galleries") or []:
                if needs_translation((g.get("title") or "").strip(), target, code_pat, min_len) or \
                   needs_translation((g.get("details") or "").strip(), target, code_pat, min_len):
                    need = True
                    break
    if not need:
        print(json.dumps({"output": "skip (already in target language or nothing to translate)"}))
        return
    enqueue_task(conn, sid)
    if not spawn_worker():
        log("worker already running, task queued")
    print(json.dumps({"output": "enqueued scene %s for translation" % sid}))


# ─── Scan All 路径 ───────────────────────────────────────────────────────────

def scan_all(payload):
    conn = payload.get("server_connection") or {}
    gql = make_gql(conn)
    stash_cfg = read_stash_plugin_config(gql)
    settings = merged_settings(stash_cfg)
    target = settings.get("targetLanguage") or "zh-CN"
    code_pat = settings.get("codePattern") or DEFAULTS["codePattern"]
    min_len = 0
    try:
        min_len = int(settings.get("minLength") or 0)
    except Exception:
        pass
    batch = 1
    try:
        batch = max(1, int(settings.get("batchSize") or 1))
    except Exception:
        pass
    concurrency = 3
    try:
        concurrency = max(1, int(stash_cfg.get("scanAllConcurrency") or settings.get("scanAllConcurrency") or 3))
    except Exception:
        pass
    limiter = RateLimiter(qps_for(settings))
    cache = load_cache()

    # 1) 分页收集需要翻译的场景
    needed = []
    page = 1
    per_page = 500
    total = None
    while True:
        try:
            data = gql(Q_SCENES_PAGE, {"filter": {"per_page": per_page, "page": page}})
        except Exception as e:
            log("scan_all page %d error: %s" % (page, e))
            break
        fnd = ((data or {}).get("findScenes")) or {}
        scenes = fnd.get("scenes") or []
        if total is None:
            total = fnd.get("count") or 0
        if not scenes:
            break
        for sc in scenes:
            sid = str(sc.get("id"))
            title = (sc.get("title") or "").strip()
            details = (sc.get("details") or "").strip()
            galleries = [g for g in (sc.get("galleries") or []) if g and g.get("id")] \
                if settings.get("gallerySync") else []
            gal_need = [g for g in galleries
                        if needs_translation((g.get("title") or "").strip(), target, code_pat, min_len) or
                           needs_translation((g.get("details") or "").strip(), target, code_pat, min_len)]
            if not needs_translation(title, target, code_pat, min_len) and \
               not needs_translation(details, target, code_pat, min_len) and not gal_need:
                continue
            with _cache_lock:
                if cache_hit(cache, sid, title, details, settings.get("cacheHours") or 24):
                    # 场景已缓存（此前已译/跳过）：仅当有图库需翻译才继续处理
                    if not gal_need:
                        continue
                    needed.append((sid, title, details, gal_need))
                    continue
            needed.append((sid, title, details, galleries))
        page += 1
        if total is not None and (page - 1) * per_page >= total:
            break
    log("scan_all: %d scenes need translation (page %d, total %s)" % (len(needed), page - 1, total))

    # 2) 按 batchSize 分组并发翻译
    # 批量合并翻译按 batchSize 分组提交（每组一次 API 调用）；并发线程共享令牌桶限速
    ok = 0
    failed = 0
    _prog_lock = threading.Lock()
    done_count = [0]

    def work_batch(items):
        nonlocal ok, failed
        try:
            updates_list = []
            for sid, title, details, galleries in items:
                u = translate_entity(gql, "scene", sid, title, details, settings, cache, limiter)
                if u:
                    updates_list.append((sid, u))
                for g in galleries or []:
                    gid = g.get("id")
                    if not gid:
                        continue
                    try:
                        gu = translate_entity(gql, "gallery", gid, g.get("title"), g.get("details"),
                                              settings, cache, limiter)
                        if gu:
                            updates_list.append(("g:%s" % gid, gu))
                            log("scan_all gallery %s translated: %s" % (gid, ",".join(gu.keys())))
                    except Exception as e:
                        log("scan_all gallery %s error: %s" % (gid, e))
                        log_dead("g:%s" % gid, e)
            with _prog_lock:
                ok += len(updates_list)
                done_count[0] += len(items)
        except Exception as e:
            with _prog_lock:
                failed += len(items)
                done_count[0] += len(items)
            for sid, _, _, galleries in items:
                log_dead(sid, e)
                for g in galleries or []:
                    if g and g.get("id"):
                        log_dead("g:%s" % g.get("id"), e)
            log("batch error: %s" % e)
        finally:
            with _prog_lock:
                n = done_count[0]
            if n % 50 == 0 or n == len(needed):
                save_cache(cache)
                log("scan_all progress: %d/%d (ok=%d failed=%d)" % (n, len(needed), ok, failed))

    batches = [needed[i:i + batch] for i in range(0, len(needed), batch)] if batch > 1 else [[x] for x in needed]
    pool = ThreadPoolExecutor(max_workers=concurrency)
    for b in batches:
        pool.submit(work_batch, b)
    pool.shutdown()
    save_cache(cache)
    log("scan_all done: needed=%d ok=%d failed=%d" % (len(needed), ok, failed))
    return {"needed": len(needed), "done": ok, "failed": failed}


# ─── 入口 ────────────────────────────────────────────────────────────────────

def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--mode" and len(argv) > 1 and argv[1] == "worker":
        worker_main()
        return
    try:
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
        payload = json.loads(raw)
    except Exception as e:
        log("input parse error: %s" % e)
        print(json.dumps({"output": "no input"}))
        return
    args = payload.get("args") or {}
    mode = args.get("mode") or payload.get("mode") or "hook"
    if mode == "scan_all":
        try:
            r = scan_all(payload)
            log("scan_all task result: %s" % r)
            print(json.dumps({"output": r}))
        except Exception as e:
            log("scan_all error: %s" % e)
            print(json.dumps({"output": "error", "error": str(e)}))
    else:
        try:
            handle_hook(payload)
        except Exception as e:
            log("hook error: %s" % e)
            print(json.dumps({"output": "hook error", "error": str(e)}))


if __name__ == "__main__":
    main()
