// node_tpdb_harness.js —— 在 Node 里直接加载 stashDiscover.js 的 TPDB 适配层，跑真实 TPDB。
//
// 这条路的价值：脱离 UI 独立验证适配层——不用起调试 Chrome、不用点按钮，直接跑插件的
// tpdb* 函数，只看请求与结果；签名与前端一致（fetch / localStorage 打桩），验的是同一份代码。
// 单跑某个用例用 --only，改适配层后先在这里过一遍再去点界面。
//
// 用法：
//   node stash-testkit/tests/stashDiscover/node_tpdb_harness.js
//   node .../node_tpdb_harness.js --src <插件 js> --config <config.yml> --only batchTwo,ghost
//
// 需要走代理时设 HTTPS_PROXY（Node 的 fetch 不读环境代理，这里自带 CONNECT 隧道）；
// 能直连时留空即可。TPDB_DEBUG=1 打印每次请求的状态码与耗时。
//
// 依赖插件源码里的两处标记：`var TPDB_RE = ` 与 `  // TPDB 演员列表`。
// 改适配层时若动了这两行，同步改下面的 START_MARK / END_MARK。

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const https = require("https");
const tls = require("tls");

const HERE = __dirname;
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SRC = arg("src", path.resolve(HERE, "../../../stashDiscover/stashDiscover.js"));
const CONFIG = arg("config", "E:/stashAPP/config.yml");
const PROXY = arg("proxy", process.env.HTTPS_PROXY || process.env.https_proxy || "");
const ONLY = (arg("only", "") || "").split(",").filter(Boolean);

const START_MARK = "var TPDB_RE = ";
const END_MARK = "  // TPDB 演员列表";

function proxyFetch(url, opts) {
  opts = opts || {};
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const px = new URL(PROXY);
    const connect = http.request({
      host: px.hostname,
      port: Number(px.port || 80),
      method: "CONNECT",
      path: u.hostname + ":443",
      headers: { Host: u.hostname + ":443" },
    });
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error("CONNECT " + res.statusCode)); return; }
      const tlsSocket = tls.connect({ socket: socket, servername: u.hostname });
      const cleanup = () => { try { tlsSocket.destroy(); } catch (_) {} };
      const r = https.request({
        host: u.hostname,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
        createConnection: () => tlsSocket,
      }, (resp) => {
        let buf = "";
        resp.setEncoding("utf8");
        resp.on("data", (d) => { buf += d; });
        resp.on("end", () => {
          cleanup();
          if (process.env.TPDB_DEBUG) console.error("[GET]", resp.statusCode, Date.now() - t0, url);
          resolve({
            ok: resp.statusCode >= 200 && resp.statusCode < 300,
            status: resp.statusCode,
            json: async () => JSON.parse(buf),
            text: async () => buf,
          });
        });
      });
      r.on("error", (e) => { cleanup(); reject(e); });
      if (opts.signal) opts.signal.addEventListener("abort", () => { cleanup(); reject(new Error("aborted")); });
      r.end();
    });
    connect.on("error", reject);
    connect.end();
  });
}

const doFetch = (url, opts) => (PROXY ? proxyFetch(url, opts) : fetch(url, opts));

function loadAdapter() {
  const src = fs.readFileSync(SRC, "utf8");
  const i = src.indexOf(START_MARK);
  const j = src.indexOf(END_MARK);
  if (i < 0 || j < 0 || j <= i) {
    throw new Error("在 " + SRC + " 里找不到 TPDB 适配层标记，改过 START_MARK / END_MARK？");
  }
  const chunk = src.slice(i, j);

  const store = {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, URL, fetch: doFetch, encodeURIComponent,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    BOX_TIMEOUT_MS: 28000,
    BOX_SCENE_FIELDS: "",
    ssdError: (kind, msg) => { const e = new Error(msg || kind); e.ssdKind = kind; return e; },
    callBoxGQL: () => Promise.reject(new Error("not used by TPDB branch")),
  };
  sandbox.window = sandbox;
  sandbox.__out = {};

  const wrapped = chunk +
    "\n;Object.assign(__out, {callBoxSceneList, TPDB_MAX_PAGES_BATCH, tpdbResolveIds, tpdbResolvePerformer});";
  vm.createContext(sandbox);
  vm.runInContext(wrapped, sandbox, { filename: "stashDiscover-tpdb.js" });
  return { api: sandbox.__out, store };
}

function loadKey() {
  const cfg = fs.readFileSync(CONFIG, "utf8");
  const m = cfg.match(/api_?key:\s*(\S+)\s*[\r\n]+\s*endpoint:\s*https:\/\/theporndb\.net/i);
  if (!m) throw new Error("config.yml 里没找到 theporndb 的 api key");
  return m[1];
}

const { api, store } = loadAdapter();
const { callBoxSceneList } = api;
const box = { endpoint: "https://theporndb.net/graphql", apiKey: loadKey(), name: "theporndb" };

// 站点级演员记录（Emma Reed 在某厂牌下的个人页，is_parent:false）。
// 打 /performers/{uuid} 和 /performers/{uuid}/scenes 都是 404，用来验名字回退。
const SITE_LEVEL_UUID = "bf020063-768f-4cab-8bff-e3d8d14d3980";

const pick = (list, extra) => Object.assign({
  performers: { value: list, modifier: "INCLUDES" },
  per_page: 100, page: 1, direction: "DESC",
}, extra || {});
const since = () => {
  const d = new Date(Date.now() - 180 * 86400000);
  return d.toISOString().slice(0, 10);
};

const CASES = {
  // 种子里抽 parent uuid 与站点 uuid
  async seed() {
    const r = await callBoxSceneList(box, { per_page: 8, page: 1, direction: "DESC" });
    const scenes = r.scenes || [];
    const uuids = [], studioIds = [];
    scenes.forEach((sc) => {
      (sc.performers || []).forEach((p) => {
        const id = p.performer && p.performer.id;
        if (id && uuids.indexOf(id) < 0) uuids.push(id);
      });
      if (sc.studio && sc.studio.id && studioIds.indexOf(sc.studio.id) < 0) studioIds.push(sc.studio.id);
    });
    if (!uuids.length) throw new Error("seed 场景里没有演员，后续用例无样本");
    return { count: r.count, uuids, studioIds };
  },
  // 单演员无窗口：走 tpdbIdPage
  async singleNoWindow(seed) {
    return brief(await callBoxSceneList(box, pick([seed.uuids[0]])));
  },
  // 单演员带窗口：走 tpdbSinceScenes（批量单键）
  async singleWindow(seed) {
    return brief(await callBoxSceneList(box, pick([seed.uuids[0]], { date: { value: since(), modifier: "GREATER_THAN" } })));
  },
  // 核心：一次请求覆盖两个演员（旧实现是两个子资源请求）
  async batchTwo(seed) {
    return brief(await callBoxSceneList(box, pick(seed.uuids.slice(0, 2), { date: { value: since(), modifier: "GREATER_THAN" } })));
  },
  async batchFive(seed) {
    return brief(await callBoxSceneList(box, pick(seed.uuids.slice(0, 5), { date: { value: since(), modifier: "GREATER_THAN" } })));
  },
  // 幽灵 uuid 必须进 skipped，不能整块抛错（论坛三块总览一起红的根因）
  async ghost() {
    return brief(await callBoxSceneList(box, pick(["00000000-0000-0000-0000-000000000000"], { date: { value: since(), modifier: "GREATER_THAN" } })));
  },
  // 部分成功：真 id 的结果照常返回
  async mixed(seed) {
    return brief(await callBoxSceneList(box, pick([seed.uuids[0], "00000000-0000-0000-0000-000000000000"], { date: { value: since(), modifier: "GREATER_THAN" } })));
  },
  // 缓存热跑：resolve 阶段应 0 请求（看耗时与 cacheSize）
  async warmRerun(seed) {
    const r = brief(await callBoxSceneList(box, pick(seed.uuids.slice(0, 2), { date: { value: since(), modifier: "GREATER_THAN" } })));
    r.cacheSize = Object.keys(JSON.parse(store["ssd.tpdb.intIds"] || "{}")).length;
    return r;
  },
  async batchStudios(seed) {
    return brief(await callBoxSceneList(box, {
      studios: { value: seed.studioIds.slice(0, 2), modifier: "INCLUDES" },
      per_page: 100, page: 1, direction: "DESC",
      date: { value: since(), modifier: "GREATER_THAN" },
    }));
  },
  // 父站点（ManyVids id=5502）：自身 0 条，场景全挂在 2.6 万个子站点上。
  // 用 sites[<id>] 精确匹配只能得到 0 条，必须走 site_operation。
  async studioParent() {
    return brief(await callBoxSceneList(box, {
      studios: { value: ["1edfe032-9128-4340-a5ac-bf91619583e5"], modifier: "INCLUDES" },
      per_page: 100, page: 1, direction: "DESC",
    }));
  },
  async studioParentWindow() {
    return brief(await callBoxSceneList(box, {
      studios: { value: ["1edfe032-9128-4340-a5ac-bf91619583e5"], modifier: "INCLUDES" },
      per_page: 100, page: 1, direction: "DESC",
      date: { value: since(), modifier: "GREATER_THAN" },
    }));
  },
  // 子站点（Manyvids: Lizzy Maestro id=75219）：自身 563 条。
  // 修父站点时不能把它的结果膨胀成整个 network。
  async studioChild() {
    return brief(await callBoxSceneList(box, {
      studios: { value: ["830325e3-b9f4-493d-b601-2a94bd51c4c5"], modifier: "INCLUDES" },
      per_page: 100, page: 1, direction: "DESC",
    }));
  },
  // 单演员 DESC 现在直接打 /performers/{uuid}/scenes，不该再写整数缓存
  //（resolveCalls 必须为 0，否则说明又退回了「先解析再查」）
  async subresourceNoResolve(seed) {
    const before = Object.keys(JSON.parse(store["ssd.tpdb.intIds"] || "{}")).length;
    const r = brief(await callBoxSceneList(box, pick([seed.uuids[0]])));
    const after = Object.keys(JSON.parse(store["ssd.tpdb.intIds"] || "{}")).length;
    return Object.assign(r, { resolveCalls: after - before });
  },
  // 站点级编号（is_parent:false）：/performers/{uuid} 与 /performers/{uuid}/scenes 都是 404。
  // 有名字时回退到同名 parent，没有名字才进 skipped。
  async nameFallbackSiteLevel() {
    const id = await api.tpdbResolvePerformer(box, SITE_LEVEL_UUID, "Emma Reed", 28000);
    return { intId: id, fallback: id != null };
  },
  async nameFallbackNoHint() {
    const id = await api.tpdbResolvePerformer(box, SITE_LEVEL_UUID, "", 28000);
    return { intId: id };
  },
};

function brief(r) {
  return {
    count: r.count,
    scenes: (r.scenes || []).length,
    skipped: (r.skipped || []).length,
    truncated: !!r.truncated,
  };
}

(async () => {
  const out = { src: SRC, proxy: PROXY ? "on" : "off", cases: {} };
  let seedData = null;
  for (const name of ["seed"].concat(Object.keys(CASES).filter((k) => k !== "seed"))) {
    if (ONLY.length && name !== "seed" && ONLY.indexOf(name) < 0) continue;
    const t0 = Date.now();
    try {
      const r = name === "seed" ? await CASES.seed() : await CASES[name](seedData);
      if (name === "seed") seedData = r;
      out.cases[name] = Object.assign({ ms: Date.now() - t0 }, r);
    } catch (e) {
      out.cases[name] = { ms: Date.now() - t0, error: (e && e.message) || String(e) };
    }
    if (!seedData) { console.error("seed 失败，后续用例无样本"); break; }
  }
  console.log(JSON.stringify(out, null, 1));
  const failed = Object.keys(out.cases).filter((k) => out.cases[k].error);
  if (failed.length) {
    console.error("有失败用例: " + failed.join(", "));
    process.exit(2);
  }
})();
