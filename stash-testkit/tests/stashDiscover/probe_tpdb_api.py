"""TPDB REST API 语义探针 —— 插件 TPDB 分支的唯一事实来源。

stashDiscover 对 TPDB 走 REST 而不是 stash-box GraphQL，其中几条语义只能实测确认，
改 TPDB 适配层（stashDiscover.js 的 tpdb* 函数）前先跑一遍，别凭直觉拼参数：

  - 批量过滤是 deepObject：`performers[整数_id]=x`，**值被忽略、只认键**；多键 OR 合并
  - 键必须是整数 `_id`/`id`，uuid 当键返回 0 条
  - `per_page` 硬顶 100；`total` 封顶 10000，`page > 100` 数据错乱
  - 没有批量解析 uuid 的接口（`ids[]=` / `ids=a,b` / `uuid[]=` 全被忽略）

用法（key 默认从本地 Stash 的 stash-box 配置读，也可 --key 直给）：

    python probe_tpdb_api.py batch          # 批量 OR / 分页上限 / date+orderBy 组合
    python probe_tpdb_api.py ids            # uuid → 整数 id、parent 与站点级、批量解析有无
    python probe_tpdb_api.py stab -n 10     # 连续请求耗时与失败率（判断"慢"是不是网络）
    python probe_tpdb_api.py all

只读探针，不改源站数据。
"""
import argparse
import json
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://api.theporndb.net"
DEFAULT_CONFIG = r"E:/stashAPP/config.yml"


def load_key(path, explicit=None):
    if explicit:
        return explicit
    txt = Path(path).read_text(encoding="utf-8")
    i = txt.lower().find("theporndb")
    if i < 0:
        raise SystemExit("config.yml 里找不到 theporndb 的 stash-box 配置，用 --key 指定")
    m = re.search(r"api_?key:\s*(\S+)", txt[max(0, i - 600): i + 600], re.I)
    if not m:
        raise SystemExit("找到 theporndb 但没有 api key 字段，用 --key 指定")
    return m.group(1).strip()


class Client:
    def __init__(self, key):
        self.headers = {"Accept": "application/json", "Authorization": "Bearer " + key}

    def get(self, path, timeout=40):
        """返回 (status, body, 秒)；body 为 dict 或错误文本。status=-1 表示异常。"""
        t0 = time.time()
        try:
            req = urllib.request.Request(BASE + path, headers=self.headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return resp.status, json.loads(raw), time.time() - t0
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")[:200], time.time() - t0
        except Exception as e:  # noqa: BLE001
            return -1, repr(e)[:200], time.time() - t0


def total(body):
    return (body.get("meta") or {}).get("total") if isinstance(body, dict) else None


def rows(body):
    return body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), list) else []


def seed(cli, n=8):
    """拿一批最新场景，抽出演员 parent uuid 与站点 uuid 作后续探针的样本。"""
    st, j, _ = cli.get("/scenes?per_page=%d&orderBy=recently_created" % n)
    if st != 200:
        raise SystemExit("seed 失败: %s %s" % (st, j))
    perfs, sites = [], []
    for sc in rows(j):
        for p in sc.get("performers") or []:
            par = p.get("parent") or {}
            if par.get("id") and par["id"] not in [x["uuid"] for x in perfs]:
                perfs.append({"uuid": par["id"], "name": p.get("name")})
        site = sc.get("site") or {}
        if site.get("uuid") and site["uuid"] not in sites:
            sites.append(site["uuid"])
    return perfs, sites


def cmd_batch(cli, args):
    perfs, _ = seed(cli, args.seed)
    print("样本演员:", [(p["name"], p["uuid"][:8]) for p in perfs[:3]])
    if len(perfs) < 2:
        raise SystemExit("seed 里的演员不足 2 个，加大 --seed")

    ids = []
    print("\n=== A. 单条子资源 total 与批量单键 total 是否一致 ===")
    for p in perfs[:2]:
        _, single, _ = cli.get("/performers/%s/scenes?per_page=1" % p["uuid"])
        _, detail, _ = cli.get("/performers/" + p["uuid"])
        d = (detail.get("data") or detail) if isinstance(detail, dict) else {}
        iid = d.get("_id")
        if iid is None:
            print("  %-20s 拿不到 _id，跳过" % p["name"][:20])
            continue
        ids.append(iid)
        _, batch, _ = cli.get("/scenes?performers[%s]=x&per_page=1" % iid)
        print("  %-20s 子资源=%-6s 批量(%s)=%-6s 一致=%s"
              % (p["name"][:20], total(single), iid, total(batch), total(single) == total(batch)))

    print("\n=== B. 多键批量是 OR 合并（total 相加）===")
    if len(ids) >= 2:
        q = "&".join("performers[%s]=x" % i for i in ids)
        _, one, _ = cli.get("/scenes?performers[%s]=x&per_page=1" % ids[0])
        _, two, _ = cli.get("/scenes?performers[%s]=x&per_page=1" % ids[1])
        _, both, _ = cli.get("/scenes?%s&per_page=1" % q)
        s = (total(one) or 0) + (total(two) or 0)
        print("  %s + %s = %s ；两键批量 total=%s ；相加成立=%s"
              % (total(one), total(two), s, total(both), s == total(both)))
        print("  值给任意字符串仍返回条数 ⇒ 只认键:", end=" ")
        _, weird, _ = cli.get("/scenes?%s=%s&per_page=1" % ("performers[%s]" % ids[0], "not-an-int"))
        print("total=%s" % total(weird))

    print("\n=== C. per_page 上限 ===")
    for pp in (100, 200):
        _, j, dt = cli.get("/scenes?per_page=%d&page=1" % pp)
        print("  per_page=%-3d 实际返回=%-4s %.2fs" % (pp, len(rows(j)), dt))

    print("\n=== D. date + orderBy 能否同时生效 ===")
    if ids:
        since = time.strftime("%Y-%m-%d", time.localtime(time.time() - 180 * 86400))
        path = ("/scenes?performers[%s]=x&per_page=100&page=1&orderBy=recently_released"
                "&date=%s&date_operation=%%3E" % (ids[0], since))
        _, j, dt = cli.get(path)
        dates = [(sc.get("date") or "")[:10] for sc in rows(j)]
        bad = [d for d in dates if d and d <= since]
        print("  since=%s 返回=%s 条 %.2fs 最早=%s 越界条数=%s"
              % (since, len(dates), dt, min(dates) if dates else "-", len(bad)))


def cmd_ids(cli, args):
    perfs, sites = seed(cli, args.seed)
    print("=== A. parent 演员 uuid → 整数 _id ===")
    for p in perfs[:2]:
        st, j, dt = cli.get("/performers/" + p["uuid"])
        d = (j.get("data") or j) if isinstance(j, dict) else {}
        print("  %-20s %s _id=%-8s is_parent=%-5s %.2fs"
              % (p["name"][:20], st, d.get("_id"), d.get("is_parent"), dt))

    print("\n=== B. 站点级演员（is_parent=false）单条 404 ===")
    st, j, _ = cli.get("/performers?per_page=20")
    child = None
    for p in rows(j):
        if p.get("is_parent") is False:
            child = p
            break
    if not child:
        print("  本页样本里没有站点级记录，跳过（不影响结论：插件已按 is_parent 过滤）")
    else:
        st2, j2, _ = cli.get("/performers/%s/scenes?per_page=1" % child.get("id"))
        print("  %-20s 单条子资源 → %s %s" % (child.get("name", "")[:20], st2, str(j2)[:80]))

    print("\n=== C. 站点 uuid → 整数 id ===")
    if sites:
        st, j, dt = cli.get("/sites/" + sites[0])
        d = (j.get("data") or j) if isinstance(j, dict) else {}
        print("  %s → %s id=%-8s %.2fs" % (sites[0][:8], st, d.get("id"), dt))

    print("\n=== D. 有没有批量解析 uuid 的写法（有则首屏可省 N 次请求）===")
    if len(perfs) >= 2:
        u1, u2 = perfs[0]["uuid"], perfs[1]["uuid"]
        for label, path in (
            ("ids[]=", "/performers?ids[]=%s&ids[]=%s&per_page=5" % (u1, u2)),
            ("ids=a,b", "/performers?ids=%s,%s&per_page=5" % (u1, u2)),
            ("uuid[]=", "/performers?uuid[]=%s&uuid[]=%s&per_page=5" % (u1, u2)),
            ("performer_ids[]=", "/performers?performer_ids[]=%s&performer_ids[]=%s&per_page=5" % (u1, u2)),
        ):
            st, j, _ = cli.get(path)
            print("  %-18s %s 返回=%-3s %s" % (label, st, len(rows(j)),
                                             [x.get("name") for x in rows(j)][:3]))
        st, j, _ = cli.get("/performers?per_page=5")
        print("  %-18s %s 返回=%-3s %s（默认列表 = 参数被忽略）"
              % ("无参数（对照）", st, len(rows(j)), [x.get("name") for x in rows(j)][:3]))


def cmd_stab(cli, args):
    perfs, _ = seed(cli, 4)
    ids = []
    for p in perfs[:2]:
        _, j, _ = cli.get("/performers/" + p["uuid"])
        d = (j.get("data") or j) if isinstance(j, dict) else {}
        if d.get("_id") is not None:
            ids.append(d["_id"])
    if not ids:
        raise SystemExit("拿不到整数 id")
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - args.days * 86400))
    q = "&".join("performers[%s]=x" % i for i in ids)
    path = "/scenes?%s&per_page=100&page=1&orderBy=recently_released&date=%s&date_operation=%%3E" % (q, since)
    print("%d 位演员 / %d 天窗口，连续请求 %d 次：" % (len(ids), args.days, args.n))
    times, fails = [], 0
    for i in range(args.n):
        st, j, dt = cli.get(path, timeout=args.timeout)
        if st == 200:
            times.append(dt)
            print("  %2d  %s %6.2fs rows=%s" % (i + 1, st, dt, len(rows(j))))
        else:
            fails += 1
            print("  %2d  %s %6.2fs %s" % (i + 1, st, dt, str(j)[:80]))
    if times:
        print("耗时 min=%.2fs median=%.2fs max=%.2fs 失败=%d/%d"
              % (min(times), statistics.median(times), max(times), fails, args.n))
    else:
        print("全部失败：先排除代理/网络，再怀疑代码")


def main():
    ap = argparse.ArgumentParser(description="TPDB REST API 语义探针")
    ap.add_argument("cmd", choices=["batch", "ids", "stab", "all"])
    ap.add_argument("-n", type=int, default=10, help="stab 请求次数")
    ap.add_argument("--days", type=int, default=180, help="stab 的时间窗口天数")
    ap.add_argument("--seed", type=int, default=8, help="seed 拉取场景数")
    ap.add_argument("--timeout", type=int, default=40)
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--key", default=None, help="直接给 api key（默认读 config.yml）")
    args = ap.parse_args()

    cli = Client(load_key(args.config, args.key))
    if args.cmd in ("batch", "all"):
        print("### batch\n")
        cmd_batch(cli, args)
        print()
    if args.cmd in ("ids", "all"):
        print("### ids\n")
        cmd_ids(cli, args)
        print()
    if args.cmd in ("stab", "all"):
        print("### stab\n")
        cmd_stab(cli, args)


if __name__ == "__main__":
    main()
