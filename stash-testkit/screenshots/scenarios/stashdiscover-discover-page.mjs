// 场景：stashDiscover 发现页全量截图（总览/演员/工作室/关注/弹窗）
// 用法: node stashdiscover-discover-page.mjs
import { createSession } from "../capture.mjs";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "../../..", "docs");
const s = await createSession({ port: 9333, width: 1600, height: 1000, dsf: 2 });
await s.loginIfNeeded();
await s.gotoDiscoverPage();
await s.waitFor("document.querySelectorAll('.ssd-dp-page img').length > 5", 120000);
await s.ev("new Promise(r=>setTimeout(r,2500))");
await s.injectAnon();

// 1) 总览
await s.shot(path.join(OUT, "stashdiscover-01-overview.png"), { full: true });

// 2) 演员钻取
await s.ev("document.querySelectorAll('.ssd-dp-mini')[0]?.click()");
await s.waitFor("!!document.querySelector('.ssd-dp-pfhead')", 20000);
await s.ev("new Promise(r=>setTimeout(r,1800))");
await s.shot(path.join(OUT, "stashdiscover-02-performer.png"));

// 3) 关注（先关注几个有新发布的演员）
for (let i = 0; i < 3; i++) {
  await s.clickTab("总览");
  await s.ev(`document.querySelectorAll('.ssd-dp-mini')[${i}]?.click()`);
  await s.waitFor("!!document.querySelector('.ssd-dp-pfhead')", 20000);
  await s.ev(`[...document.querySelectorAll('.ssd-dp-page .ssd-dp-btn')].find(e=>e.textContent.includes('关注')&&!e.textContent.includes('已关注'))?.click()`);
}
await s.clickTab("关注");
await s.waitFor("document.querySelectorAll('.ssd-dp-fgrp-head').length>0", 20000);
await s.ev("document.querySelector('.ssd-dp-fgrp-head')?.click()");
await s.ev("new Promise(r=>setTimeout(r,1500))");
await s.shot(path.join(OUT, "stashdiscover-03-follow.png"));

// 4) 工作室
await s.clickTab("工作室");
await s.waitFor("!!document.querySelector('.ssd-dp-grpchip')", 20000);
await s.ev("document.querySelector('.ssd-dp-grpchip')?.click()");
await s.waitFor("!!document.querySelector('.ssd-dp-pfhead--studio')", 20000);
await s.ev("new Promise(r=>setTimeout(r,1500))");
await s.shot(path.join(OUT, "stashdiscover-04-studio.png"));

// 5) 场景详情弹窗
await s.clickTab("总览");
await s.ev("document.querySelector('.scene-card .card-section-title')?.click()");
await s.waitFor("!!document.querySelector('.ssd-modal')", 20000);
await s.ev("new Promise(r=>setTimeout(r,1500))");
await s.shot(path.join(OUT, "stashdiscover-05-scene-modal.png"));

s.close();
