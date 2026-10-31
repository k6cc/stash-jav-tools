// 429 限流退避探针（用户 2026-10-31）：
//   1 两次 429 后成功 → 三次请求，结果正常，耗时 ≈ 2s + 4s
//   2 Retry-After: 120 → 不重试，立刻抛 ratelimit
//   3 连续 429 三次 → 抛 ratelimit，message 含 "retried 2x"，不超预算
//   4 HTTP 500 → 仍走 blocked，不重试（既有行为不变）
//   5 被 429 打过的源下一个请求至少隔 1s（惩罚期节流）
// 全程 mock fetch，不打真实网络。每个用例用不同 endpoint，避免惩罚期互相污染。
//
// 跑法：
//   cd E:/stashAPP/devtools
//   MSYS_NO_PATHCONV=1 python stash_dev.py eval "$(cat \
//     /e/Temp/stash-jav-tools/stash-testkit/tests/stashDiscover/scripts/probe_429_backoff.js)" \
//     --path / --timeout 180
(async () => {
  const out = { cases: [], warns: [] };
  const origFetch = window.fetch;
  const origWarn = console.warn;
  console.warn = (...a) => out.warns.push(a.join(" "));

  const jsonOk = () => new Response(JSON.stringify({ data: { ok: 1 } }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  const errRes = (status, ra) => new Response("rate limited", {
    status, headers: ra == null ? {} : { "Retry-After": String(ra) },
  });

  // steps: 依次返回的响应；最后一个重复使用
  function mockSteps(steps) {
    let i = 0;
    window.fetch = async () => {
      const s = steps[Math.min(i++, steps.length - 1)];
      return s === "ok" ? jsonOk() : errRes(s.status, s.ra);
    };
    return () => i;
  }

  async function run(name, endpoint, steps, expect) {
    const count = mockSteps(steps);
    const t0 = Date.now();
    let err = null, data = null;
    try {
      data = await SSD.callBoxGQL(endpoint, "k", "query{x}", null, 3000);
    } catch (e) { err = e; }
    const ms = Date.now() - t0;
    const row = {
      name, expect,
      calls: count(), ms,
      kind: err ? err.ssdKind : null,
      msg: err ? String(err.message).slice(0, 80) : null,
      ok: data ? data.ok : null,
    };
    out.cases.push(row);
    return row;
  }

  try {
    // 1 两次 429（无 Retry-After）→ 200：退避 2s + 4s
    await run("two-429-then-ok", "https://m1.example/graphql",
      [{ status: 429 }, { status: 429 }, "ok"], "calls=3 ok=1 ms≈6000");
    // 4 500 不重试（放在 429 用例前，避免被惩罚期拖慢）
    await run("500-no-retry", "https://m4.example/graphql",
      [{ status: 500 }], "calls=1 kind=blocked");
    // 2 Retry-After 120 超上限：不重试
    await run("retry-after-over-cap", "https://m2.example/graphql",
      [{ status: 429, ra: 120 }], "calls=1 kind=ratelimit ms<1000");
    // 3 连续 429 耗尽重试
    await run("exhaust-retries", "https://m3.example/graphql",
      [{ status: 429 }], "calls=3 kind=ratelimit msg含retried 2x");
    // 5 惩罚期：同一 endpoint 先 429，再正常请求应至少等 1s
    const ep = "https://m5.example/graphql";
    await run("penalty-primer", ep, [{ status: 429, ra: 120 }], "calls=1");
    const t1 = Date.now();
    mockSteps(["ok"]);
    await SSD.callBoxGQL(ep, "k", "query{x}", null, 3000);
    out.penaltyGapMs = Date.now() - t1;
    // 6 未被打过的源零排队：连发 3 次应几乎不耗时（同时验证 m5 的惩罚没串到别的源）
    const ep6 = "https://m6.example/graphql";
    mockSteps(["ok"]);
    const t6 = Date.now();
    for (let i = 0; i < 3; i++) await SSD.callBoxGQL(ep6, "k", "query{x}", null, 3000);
    out.noPenaltyMs = Date.now() - t6;
  } catch (e) {
    out.fatal = String((e && e.message) || e);
  } finally {
    window.fetch = origFetch;
    console.warn = origWarn;
  }

  // 判定
  out.verdict = out.cases.map((c) => {
    let pass = false;
    if (c.name === "two-429-then-ok") pass = c.calls === 3 && c.ok === 1 && c.ms >= 5500 && c.ms < 9000;
    if (c.name === "500-no-retry") pass = c.calls === 1 && c.kind === "blocked";
    if (c.name === "retry-after-over-cap") pass = c.calls === 1 && c.kind === "ratelimit" && c.ms < 1000;
    if (c.name === "exhaust-retries") pass = c.calls === 3 && c.kind === "ratelimit" && /retried 2x/.test(c.msg || "");
    if (c.name === "penalty-primer") pass = c.calls === 1;
    return { name: c.name, pass };
  });
  out.penaltyPass = out.penaltyGapMs >= 900;
  out.noPenaltyPass = out.noPenaltyMs < 200;
  out.allPass = out.verdict.every((v) => v.pass) && out.penaltyPass && out.noPenaltyPass && !out.fatal;
  return JSON.stringify(out, null, 2);
})()
