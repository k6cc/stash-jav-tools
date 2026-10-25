// screenshots/capture.mjs
// 可复用的 Stash 插件 UI 截图框架。用法与占位符规范见同目录 NOTES.md。
//
// 用法（在场景脚本中）：
//   import { createSession } from "./capture.mjs";
//   const s = await createSession({ port: 9333, width: 1600, height: 1000, dsf: 2 });
//   await s.loginIfNeeded();          // 可选：登录 Stash（需 creds.json）
//   await s.gotoDiscoverPage();       // 或 s.navigate("/performers/123")
//   await s.injectAnon();              // 注入占位符
//   await s.shot("out/01-overview.png", { full: true });
//   await s.close();

import fs from "node:fs";
import path from "node:path";

const CREDS_FILE = path.join(import.meta.dirname, "creds.json");

export async function createSession(opts = {}) {
  const port = opts.port ?? 9333;
  const width = opts.width ?? 1600;
  const height = opts.height ?? 1000;
  const dsf = opts.dsf ?? 2;

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target — start Chrome with --remote-debugging-port");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.result));
    return r.result.value;
  };

  const waitFor = async (expr, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await sleep(400);
    }
    throw new Error("timeout waiting: " + expr);
  };

  const shot = async (file, opts = {}) => {
    await ev("window.scrollTo(0,0)");
    await sleep(500);
    const params = { format: "png", captureBeyondViewport: !!opts.full };
    if (opts.full) {
      const h = await ev("Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)");
      const w = await ev("document.documentElement.clientWidth");
      params.clip = { x: 0, y: 0, width: w, height: Math.ceil(h), scale: 1 };
    }
    const r = await send("Page.captureScreenshot", params);
    const buf = Buffer.from(r.data, "base64");
    const dir = path.dirname(file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, buf);
    console.log("shot:", file, buf.length + " bytes");
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false });

  return {
    ws, send, ev, waitFor, shot,
    navigate: async (url) => { await send("Page.navigate", { url }); },
    clickTab: async (label) => {
      await ev(`(() => { const t=[...document.querySelectorAll('.ssd-dp-tab')].find(e=>e.textContent.trim()==='${label}'); if(!t) return 'no-tab'; t.click(); return 'ok'; })()`);
      await sleep(1800);
    },
    loginIfNeeded: async () => {
      const creds = loadCreds();
      if (!creds) return false;
      const title = await ev("document.title");
      if (title !== "Login") return true;
      await ev(`(() => {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value");
          d.set.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const u = document.querySelector("input[name=username], input#username");
        const p = document.querySelector("input[name=password], input#password");
        if (!u || !p) return false;
        set(u, ${JSON.stringify(creds.username)});
        set(p, ${JSON.stringify(creds.password)});
        const b = document.querySelector('button[type="submit"], input[type="submit"]');
        if (b) b.click();
        return true;
      })()`);
      await waitFor("!location.pathname.startsWith('/login')", 30000);
      return true;
    },
    gotoDiscoverPage: async () => {
      await send("Page.navigate", { url: "http://localhost:9999/plugins/stashDiscover" });
      await waitFor("!!document.querySelector('.ssd-dp-page')", 90000);
    },
    injectAnon: async (anonPath) => {
      const code = fs.readFileSync(anonPath || path.join(import.meta.dirname, "anon-stash.js"), "utf8");
      await ev(code);
      await sleep(1200);
    },
    close: () => { ws.close(); process.exit(0); },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadCreds() {
  if (!fs.existsSync(CREDS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, "utf8")); } catch { return null; }
}
