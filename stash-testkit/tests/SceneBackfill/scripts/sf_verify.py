# -*- coding: utf-8 -*-
"""SceneBackfill 一键验收：走 5 项只读检查 + state.json 状态机巡检。

替代 NOTES「一次完整验证」里的人工 5 步：selftest / 规则回读 / 下载器连接 /
守护心跳 / 状态机巡检。默认不改任何数据（不存规则、不启停守护、不写 state），
适合每次发版前跑一遍。

用法：
  python tests/SceneBackfill/scripts/sf_verify.py
  python tests/SceneBackfill/scripts/sf_verify.py --skip selftest,progress
  python tests/SceneBackfill/scripts/sf_verify.py --with-worker-start   # 额外拉起守护并等心跳
  python tests/SceneBackfill/scripts/sf_verify.py --data-root E:/stashAPP/plugin-data

退出码：0 全部 PASS/WARN；1 有 FAIL。
"""
import json
import os
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))
from stash_client import Stash  # noqa: E402

PLUGIN = "SceneBackfill"
Q = 'mutation($id:ID!,$a:Map!){runPluginOperation(plugin_id:$id,args:$a)}'
STATUSES = {"captured", "matched", "low_confidence", "no_result",
            "pushed", "downloaded", "importing", "imported", "ignored"}
RESULTS = []


def op(s, args):
    data = s.gql(Q, {"id": PLUGIN, "a": args})
    if data.get("errors"):
        raise RuntimeError(json.dumps(data["errors"], ensure_ascii=False)[:300])
    return data["data"]["runPluginOperation"]


def record(name, level, detail):
    RESULTS.append((name, level, detail))
    width = sum(2 if ord(c) > 127 else 1 for c in name)
    print("[%s] %-5s %s" % (name + " " * max(1, 11 - width), level, detail))


def read_state(root):
    path = os.path.join(root, PLUGIN, "state.json")
    if not os.path.isfile(path):
        return None, path
    for _ in range(3):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f), path
        except (json.JSONDecodeError, OSError):
            time.sleep(0.3)
    return None, path


def check_state(root):
    st, path = read_state(root)
    if st is None:
        return record("state 巡检", "WARN", "读不到 state.json：%s" % path)
    scenes = st.get("scenes") or {}
    counts = Counter((r or {}).get("status") or "?" for r in scenes.values())
    issues = []
    for sid, rec in scenes.items():
        if not isinstance(rec, dict):
            issues.append("%s: 记录不是对象" % sid)
            continue
        status = rec.get("status") or "?"
        if status not in STATUSES:
            issues.append("%s: 未知状态 %r" % (sid, status))
        if status in ("pushed", "downloaded", "importing"):
            h = (rec.get("chosen") or {}).get("hash")
            if not h:
                issues.append("%s: %s 缺 chosen.hash" % (sid, status))
        if str(rec.get("id") or sid) != str(sid):
            issues.append("%s: 记录 id=%r 与键不一致" % (sid, rec.get("id")))
    daemon = st.get("daemon") or {}
    if daemon.get("stopping") and not int(daemon.get("pid") or 0):
        issues.append("daemon.stopping 残留但 pid=0（下次启动会立刻自退）")
    dist = " ".join("%s=%d" % (k, v) for k, v in counts.most_common())
    if issues:
        print("    问题 %d 条：" % len(issues))
        for line in issues[:8]:
            print("      - " + line)
        record("state 巡检", "FAIL", "%d scenes · %s" % (len(scenes), dist))
    else:
        record("state 巡检", "PASS", "%d scenes · %s" % (len(scenes), dist))


def check_selftest(s):
    try:
        out = op(s, {"mode": "selftest", "lang": "zh"})
    except Exception as e:
        return record("selftest", "FAIL", "调用失败：%s" % e)
    checks = out.get("checks") or []
    bad = [c for c in checks if not c.get("ok")]
    detail = "v%s · %s · %d/%d" % (
        out.get("version") or "?", out.get("downloader") or "?",
        len(checks) - len(bad), len(checks))
    if bad:
        print("    未通过：" + "; ".join(
            "%s(%s)" % (c.get("label") or c.get("key"), c.get("detail") or "") for c in bad))
        record("selftest", "FAIL", detail)
    else:
        record("selftest", "PASS", detail)


def check_rules(s):
    try:
        out = op(s, {"mode": "rules", "lang": "zh"})
    except Exception as e:
        return record("rules 回读", "FAIL", "调用失败：%s" % e)
    rules, errors = out.get("rules") or {}, out.get("errors") or []
    missing = [k for k in ("text", "fileSelect", "fileExclude", "unknown") if k not in rules]
    if errors or missing:
        record("rules 回读", "FAIL", "errors=%s missing=%s" % (errors, missing))
    else:
        record("rules 回读", "PASS", "无解析错误 · unknown=%s" % rules.get("unknown"))


def check_progress(s):
    try:
        out = op(s, {"mode": "progress", "lang": "zh"})
    except Exception as e:
        return record("下载器连接", "FAIL", "调用失败：%s" % e)
    conn = out.get("conn") or {}
    if not conn.get("ok"):
        return record("下载器连接", "FAIL", conn.get("error") or "conn.ok=false")
    record("下载器连接", "PASS",
           "%s · %d 行" % (conn.get("qbVersion") or "?", len(out.get("torrents") or [])))


def check_worker(s, start):
    if start:
        try:
            op(s, {"mode": "worker", "action": "start"})
        except Exception as e:
            return record("守护进程", "FAIL", "启动失败：%s" % e)
        deadline = time.time() + 120
        while time.time() < deadline:
            d = (op(s, {"mode": "worker", "action": "status"}).get("daemon") or {})
            if d.get("alive"):
                break
            time.sleep(3)
    else:
        d = (op(s, {"mode": "worker", "action": "status"}).get("daemon") or {})
    if d.get("alive"):
        record("守护进程", "PASS", "alive · pid=%s · ago=%ss" % (d.get("pid"), d.get("ago")))
    elif d.get("stopping"):
        record("守护进程", "WARN", "正在停止 · pid=%s" % d.get("pid"))
    else:
        record("守护进程", "WARN", "未运行（不一定是问题；--with-worker-start 可拉起）")


def main(argv):
    argv = argv[1:]
    root = "E:/stashAPP/plugin-data"
    skip, start = set(), False
    if "--data-root" in argv:
        root = argv[argv.index("--data-root") + 1]
    if "--skip" in argv:
        skip = {x.strip() for x in argv[argv.index("--skip") + 1].split(",") if x.strip()}
    start = "--with-worker-start" in argv

    s = Stash()
    steps = [("selftest", lambda: check_selftest(s)), ("state", lambda: check_state(root)),
             ("rules", lambda: check_rules(s)), ("progress", lambda: check_progress(s)),
             ("worker", lambda: check_worker(s, start))]
    for name, fn in steps:
        if name in skip:
            record(name, "SKIP", "")
            continue
        try:
            fn()
        except Exception as e:  # 单步异常不拖垮整轮验收
            record(name, "FAIL", "%s: %s" % (type(e).__name__, e))

    pass_n = sum(1 for _, lvl, _ in RESULTS if lvl == "PASS")
    fail_n = sum(1 for _, lvl, _ in RESULTS if lvl == "FAIL")
    warn_n = sum(1 for _, lvl, _ in RESULTS if lvl == "WARN")
    print("\n汇总: %d PASS / %d WARN / %d FAIL" % (pass_n, warn_n, fail_n))
    return 1 if fail_n else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
