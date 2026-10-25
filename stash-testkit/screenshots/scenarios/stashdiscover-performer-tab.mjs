// 场景：stashDiscover 演员详情页「发现」tab 截图
// 用法: node stashdiscover-performer-tab.mjs [performerId]
import { createSession } from "../capture.mjs";
import path from "node:path";

const pid = process.argv[2] || "136";
const outDir = path.join(import.meta.dirname, "../../..", "docs");

const s = await createSession({ port: 9333, width: 1600, height: 1000, dsf: 2 });
await s.loginIfNeeded();
await s.navigate(`http://localhost:9999/performers/${pid}`);
await s.waitFor("!!document.querySelector('.performer')", 60000);

// 点「发现」tab（插件注入：.nav-item.ssd-tab > a.ssd-nav-link）
await s.waitFor("!!document.querySelector('a.ssd-nav-link')", 30000);
const clicked = await s.ev(`(() => {
  const a = document.querySelector('a.ssd-nav-link');
  if (!a) return 'no-tab';
  a.click();
  return 'ok';
})()`);
console.log("tab click:", clicked);

// 等待场景卡片渲染
try { await s.waitFor("document.querySelectorAll('.scene-card').length > 0", 45000); } catch { /* 无数据也继续 */ }
await s.ev("new Promise(r=>setTimeout(r,2500))");

await s.injectAnon();
await s.ev("new Promise(r=>setTimeout(r,1500))");

// 截「发现」tab 区域（优先截整个页面，包含演员头部 + tab + 场景）
await s.shot(path.join(outDir, `stashdiscover-performer-${pid}-discover-tab.png`), { full: true });

s.close();
