// The hunt's findings replayed in the engine E2E_BROWSER names (twice each), plus a drag-accuracy sweep.
import { readFileSync } from "node:fs";
import * as H from "./lib.mjs";
const env = await H.start(4260);
const eng = H.browserName;
const touchOK = eng !== "firefox"; // Playwright's Firefox sends no pointer events on a touch page
const T = JSON.parse(readFileSync(new URL("./template.json", import.meta.url), "utf8"));
const out = (...a) => console.log(`[${eng}]`, ...a);
const btn = (page, b, tap) => (tap ? page.tap(`#timeline [data-button="${b}"]`, { force: true }) : page.click(`#timeline [data-button="${b}"]`, { force: true }));
async function step(name, fn) { try { await fn(); } catch (e) { out(`${name}: HUNT SCRIPT ERROR ${e.message.split("\n")[0]}`); } }
try {
  for (const run of [1, 2]) {
    await step("F1", async () => {
      const page = await H.fresh(env);
      await H.addSquare(page);
      await page.click('#timeline [data-item="sketch-2"]', { button: "right" }); await page.click("#row-menu-marker"); await H.settle(page);
      const before = await H.bar(page);
      await H.dragItemTo(page, "feature-1", await H.gapPageX(page, 2));
      out(`F1 #${run} drop Box in the marker's gap: ${before}  ->  ${await H.bar(page)} | bodies ${(await H.bodyRows(page)).join(",")}`);
      await page.context().close();
    });
    for (const mid of ["escape", "far", "rightclick"]) await step("F2", async () => {
      const page = await H.fresh(env);
      await H.addSquare(page);
      const b = await H.itemBox(page, "feature-1"); const x0 = b.x + b.width / 2, y0 = b.y + b.height / 2; const x1 = await H.gapPageX(page, 3);
      await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x1, y0, { steps: 10 });
      if (mid === "escape") await page.keyboard.press("Escape");
      if (mid === "far") await page.mouse.move(x1, 150, { steps: 5 });
      if (mid === "rightclick") { await page.mouse.down({ button: "right" }); await page.mouse.up({ button: "right" }); }
      await page.mouse.up(); await H.settle(page);
      out(`F2 #${run} ${mid} during an item drag, then release: ${await H.bar(page)} | menu open ${await page.evaluate(() => document.getElementById("row-menu").open)}`);
      await page.context().close();
    });
    await step("F3", async () => {
      const page = await H.fresh(env);
      await H.addSquare(page);
      await btn(page, "start"); await H.settle(page);
      const before = await H.bar(page);
      await page.reload(); await page.waitForFunction(() => document.querySelector("#timeline li[data-item]"), null, { timeout: 20000 }); await H.settle(page);
      out(`F3 #${run} reload while "Saving…": ${before}  ->  ${await H.bar(page)}`);
      await page.context().close();
    });
    await step("F4", async () => {
      const tap = touchOK;
      const page = await H.fresh(env, 375, tap);
      const T2 = JSON.parse(JSON.stringify(T)); const d = T2.workspaces.design; const box = d.timeline.features[0];
      for (let i = 0; i < 9; i++) { const id = `feature-${12 + i}`; d.timeline.features.push({ ...JSON.parse(JSON.stringify(box)), id, intent: { ...box.intent, parameters: { width: 5 + i, depth: 5, height: 5 }, summary: `Box: ${5 + i} × 5 × 5 mm` }, provenance: { from: [], self: { id, label: `Feature ${4 + i} (box)`, workspace: "design" } } }); }
      d.nextId = 30;
      await H.openText(page, JSON.stringify(T2));
      await page.$eval("#timeline .timeline-bar", (l) => (l.scrollLeft = 1000));
      const s0 = await page.$eval("#timeline .timeline-bar", (l) => l.scrollLeft);
      if (tap) await page.tap('#timeline [data-item="feature-19"]'); else await page.click('#timeline [data-item="feature-19"]');
      await H.settle(page);
      const s1 = await page.$eval("#timeline .timeline-bar", (l) => l.scrollLeft);
      const vis = await page.evaluate(() => { const e = document.querySelector('#timeline [data-more="feature-19"]'); const l = document.querySelector("#timeline .timeline-bar").getBoundingClientRect(); if (!e) return "absent"; const r = e.getBoundingClientRect(); return r.right <= l.right + 1 && r.left >= l.left - 1 ? "in view" : "out of view"; });
      out(`F4 #${run} 375 px, row scrolled to ${s0}, pick the last item: scroll ${s1}, its ⋯ ${vis}`);
      await page.context().close();
    });
    await step("F5", async () => {
      const tap = touchOK;
      const page = await H.fresh(env, 375, tap);
      await H.addSquare(page, [[10, 40], [20, 50]], 10, tap);
      if (tap) { await page.tap("#create-sketch"); await page.tap("#sketch-plane-XY"); } else { await page.click("#create-sketch"); await page.click("#sketch-plane-XY"); }
      await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
      await btn(page, "start", tap); await page.waitForTimeout(400);
      const e = await page.evaluate(() => { const e = document.getElementById("error"); const r = e.getBoundingClientRect(); return { text: e.textContent, top: Math.round(r.top), h: innerHeight }; });
      out(`F5 #${run} 375 px refused Go to start while sketching: "${e.text}" at y ${e.top} of a ${e.h} px screen`);
      await page.context().close();
    });
  }
  // Drag-accuracy sweep: the marker dragged to each gap and each item dragged to each place, against barEdit's rules by hand.
  await step("S", async () => {
    const page = await H.fresh(env);
    await H.addSquare(page);
    let bad = 0, n = 0;
    for (let p = 0; p <= 3; p++) {
      const m = await H.markerBox(page); const x = await H.gapPageX(page, p);
      await H.mouseDrag(page, m.x + m.width / 2, m.y + m.height / 2, x, m.y + m.height / 2); await H.settle(page);
      const got = (await H.bar(page)).split("  ").indexOf("|"); n++;
      if (got !== p) { bad++; out(`S marker to gap ${p}: landed at ${got}`); }
      await btn(page, "end"); await H.settle(page);
    }
    out(`S marker sweep: ${n - bad}/${n} landed where dropped; errors ${JSON.stringify(page.errors)}`);
    await page.context().close();
  });
} finally { await env.browser.close(); await env.server.close(); }
