// Does the bar keep its scroll after a pick or an edit at phone width?
import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4247);
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
const d = T.workspaces.design; const box = d.timeline.features[0];
for (let i = 0; i < 9; i++) { const id = `feature-${12 + i}`; d.timeline.features.push({ ...JSON.parse(JSON.stringify(box)), id, intent: { ...box.intent, parameters: { width: 5 + i, depth: 5, height: 5 }, summary: `Box: ${5 + i} × 5 × 5 mm` }, provenance: { from: [], self: { id, label: `Feature ${4 + i} (box)`, workspace: "design" } } }); }
d.nextId = 30;
const scroll = (page) => page.$eval("#timeline .timeline-bar", (l) => l.scrollLeft);
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return "absent"; const r = e.getBoundingClientRect(); const l = document.querySelector("#timeline .timeline-bar").getBoundingClientRect(); return r.left >= l.left - 1 && r.right <= l.right + 1 ? "in view" : `out of view (x ${Math.round(r.left)}, bar ${Math.round(l.left)}-${Math.round(l.right)})`; }, sel);
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env, 375, true);
    await H.openText(page, JSON.stringify(T));
    await page.$eval("#timeline .timeline-bar", (l) => (l.scrollLeft = 1000));
    console.log(`run ${run}: scrolled to`, await scroll(page));
    await page.tap('#timeline [data-item="feature-19"]');
    await H.settle(page);
    console.log(`  after tapping feature-19 to pick it: scroll`, await scroll(page), "| its ⋯", await visible(page, '#timeline [data-more="feature-19"]'), "| the item", await visible(page, '#timeline [data-item="feature-19"]'));
    await page.$eval("#timeline .timeline-bar", (l) => (l.scrollLeft = 1000));
    await page.click('#timeline [data-button="back"]');
    await H.settle(page);
    console.log(`  after Step back: scroll`, await scroll(page), "| marker", await visible(page, "#timeline .timeline-bar-marker"));
    await page.context().close();
  }
  // desktop width with many items, mouse
  const page = await H.fresh(env, 1280, false);
  const T2 = JSON.parse(JSON.stringify(T)); const d2 = T2.workspaces.design;
  for (let i = 0; i < 30; i++) { const id = `feature-${40 + i}`; d2.timeline.features.push({ ...JSON.parse(JSON.stringify(box)), id, intent: { ...box.intent, parameters: { width: 5 + i, depth: 5, height: 5 }, summary: `Box: ${5 + i} × 5 × 5 mm` }, provenance: { from: [], self: { id, label: `Feature ${13 + i} (box)`, workspace: "design" } } }); }
  d2.nextId = 80;
  await H.openText(page, JSON.stringify(T2));
  const [sl, sw, cw] = await page.$eval("#timeline .timeline-bar", (l) => [l.scrollLeft, l.scrollWidth, l.clientWidth]);
  console.log("desktop 42 items: scrollWidth", sw, "clientWidth", cw);
  await page.$eval("#timeline .timeline-bar", (l) => (l.scrollLeft = 1e5));
  await page.click('#timeline [data-item="feature-69"]');
  await H.settle(page);
  console.log("  after clicking the last item: scroll", await scroll(page), "| its ⋯", await visible(page, '#timeline [data-more="feature-69"]'));
} finally { await env.browser.close(); await env.server.close(); }
