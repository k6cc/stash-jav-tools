# -*- coding: utf-8 -*-
"""javstash 探测工具（连接实例时验证番号/演员/直抓）。

用法（相对本仓库）：
  python tests/javstashAutofill/probe_javstash.py --code CWP-98        # 番号场景查询命中
  python tests/javstashAutofill/probe_javstash.py --performer "Yua Mikami"  # 演员名称刮削
  python tests/javstashAutofill/probe_javstash.py --fetch <uuid>      # 按 id 直抓（findPerformer）

要点（已知坑 14/16/17）：
- Stash 服务端 scrape 走自家 stash-box 配置，source 只传 stash_box_endpoint（传 api_key 会 422）；
- 直抓需镜像 Stash 客户端头 ApiKey + User-Agent: stash/1.0.0，否则 403；urls 是 [URL!]! 需子选择；
- javstash 限流敏感：单请求 + 长 timeout(45s) + 请求间隙 sleep。
"""
import sys, os, json, time, urllib.request, urllib.error, ssl, argparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from stash_client import Stash

JAV = "https://javstash.org/graphql"
PERF_Q = ("name aliases gender birth_date death_date ethnicity country hair_color eye_color height "
          "band_size cup_size waist_size hip_size career_start_year career_end_year breast_type "
          "tattoos{ location description } piercings{ location description } urls{ url } images{ url }")


def get_api_key(s):
    """老版本 stashBoxes 在 configuration.general 下，新版本在 configuration 下。"""
    def match(boxes):
        for b in boxes or []:
            if (b.get("endpoint") or "").strip().rstrip("/") == JAV:
                return (b.get("api_key") or "").strip()
        return None
    try:
        cfg = s.call("{ configuration { general { stashBoxes { endpoint api_key } } } }")["configuration"]
        k = match(cfg["general"]["stashBoxes"])
        if k: return k
    except Exception:
        pass
    try:
        cfg = s.call("{ configuration { stashBoxes { endpoint api_key } } }")["configuration"]
        return match(cfg["stashBoxes"])
    except Exception:
        return None


def direct_fetch(stash_id, timeout=45):
    """findPerformer(id) 直抓（绕过名称匹配）。"""
    s = Stash()
    key = get_api_key(s)
    if not key:
        print("no api_key for", JAV); return None
    q = "query($id:ID!){ findPerformer(id:$id){ %s } }" % PERF_Q
    req = urllib.request.Request(JAV, data=json.dumps({"query": q, "variables": {"id": stash_id}}).encode(),
                                 headers={"Content-Type": "application/json",
                                          "ApiKey": key, "User-Agent": "stash/1.0.0"})
    sslctx = ssl.create_default_context(); sslctx.check_hostname = False; sslctx.verify_mode = ssl.CERT_NONE
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=sslctx) as r:
            j = json.loads(r.read())
        if j.get("errors"):
            print("graphql errors:", j["errors"]); return None
        p = (j.get("data") or {}).get("findPerformer")
        print("OK in %.1fs:" % (time.time() - t0), json.dumps(p, ensure_ascii=False)[:500])
        return p
    except urllib.error.HTTPError as e:
        print("HTTP %s in %.1fs:" % (e.code, time.time() - t0), e.read().decode()[:400]); return None
    except Exception as e:
        print("ERR in %.1fs:" % (time.time() - t0), e); return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", help="番号场景查询（scrapeSingleScene）")
    ap.add_argument("--performer", help="演员名称刮削（scrapeSinglePerformer）")
    ap.add_argument("--fetch", help="按 javstash UUID 直抓（findPerformer）")
    a = ap.parse_args()
    s = Stash()
    if a.fetch:
        direct_fetch(a.fetch); return
    if a.code:
        q = ("query($s:ScraperSourceInput!,$i:ScrapeSingleSceneInput!){ scrapeSingleScene(source:$s,input:$i){"
             " code title remote_site_id performers{ name remote_site_id } } }")
        r = s.call(q, {"s": {"stash_box_endpoint": JAV}, "i": {"query": a.code}})
        hits = r.get("scrapeSingleScene") or []
        print(a.code, "->", json.dumps([(h.get("code"), h.get("title")) for h in hits], ensure_ascii=False)[:400])
        return
    if a.performer:
        q = ("query($s:ScraperSourceInput!,$i:ScrapeSinglePerformerInput!){ scrapeSinglePerformer(source:$s,input:$i){"
             " name aliases remote_site_id birthdate measurements } }")
        r = s.call(q, {"s": {"stash_box_endpoint": JAV}, "i": {"query": a.performer}})
        hits = r.get("scrapeSinglePerformer") or []
        print(a.performer, "->", json.dumps(hits, ensure_ascii=False)[:500])
        return
    ap.print_help()


if __name__ == "__main__":
    main()
