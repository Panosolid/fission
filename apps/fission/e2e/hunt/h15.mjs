import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4263);
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
try {
  for (const run of [1, 2]) {
    const page = await H.fresh(env);
    await H.addSquare(page);
    // a few bar edits so there is history: suppress box, step back, step forward, unsuppress
    for (const b of ["back", "back", "forward", "start", "end"]) { await page.click(`#timeline [data-button="${b}"]`, { force: true }); await H.settle(page); }
    const before = await H.save(page);
    const t = Date.now();
    for (let i = 0; i < 8; i++) await page.click('#timeline [data-button="back"]', { force: true, noWaitAfter: true });
    for (let i = 0; i < 8; i++) await page.click('#timeline [data-button="forward"]', { force: true, noWaitAfter: true });
    await H.settle(page);
    console.log(`#${run} 8 back + 8 forward fast: ${await H.bar(page)} | rows ${(await H.bodyRows(page)).join(",")} k ${await H.bodyCount(page)} | vol ${await H.volume(page)} | ${await H.undoTitle(page)}`);
    for (let i = 0; i < 30; i++) await page.keyboard.press("Control+z");
    for (let i = 0; i < 30; i++) await page.keyboard.press("Control+Shift+z");
    await H.settle(page, 15000);
    const after = await H.save(page);
    const a = H.design(after), b = H.design(before);
    console.log(`   30 undo + 30 redo: ${await H.bar(page)} | k ${await H.bodyCount(page)} rows ${(await H.bodyRows(page)).length} | vol ${await H.volume(page)} | ${await H.undoTitle(page)} | errors ${page.errors.length}`);
    await page.context().close();
  }
  // 150 boxes: timings
  const big = JSON.parse(JSON.stringify(T)); const d = big.workspaces.design; const box = d.timeline.features[0];
  for (let i = 0; i < 147; i++) { const id = `feature-${100 + i}`; d.timeline.features.push({ ...JSON.parse(JSON.stringify(box)), id, intent: { ...box.intent, parameters: { width: 5 + (i % 30), depth: 5 + (i % 7), height: 5 }, summary: `Box` }, provenance: { from: [], self: { id, label: `Feature ${4 + i} (box)`, workspace: "design" } } }); }
  d.nextId = 400;
  const page = await H.fresh(env);
  let t = Date.now(); await H.openText(page, JSON.stringify(big)); console.log(`150 items: open+build ${Date.now() - t} ms, k ${await H.bodyCount(page)}`);
  t = Date.now(); await page.click('#timeline [data-button="back"]'); await H.settle(page); console.log(`  step back ${Date.now() - t} ms (incl. 400ms settle)`);
  t = Date.now(); await page.click('#timeline [data-button="start"]'); await H.settle(page); console.log(`  to start ${Date.now() - t} ms`);
  t = Date.now(); await page.click('#timeline [data-button="end"]'); await H.settle(page, 30000); console.log(`  to end ${Date.now() - t} ms`);
  console.log(`  page width ${await page.evaluate(() => document.documentElement.scrollWidth)}, bar ${JSON.stringify(await page.$eval("#timeline .timeline-bar", (l) => [l.scrollWidth, l.clientWidth]))}, errors ${page.errors.length}`);
} finally { await env.browser.close(); await env.server.close(); }
