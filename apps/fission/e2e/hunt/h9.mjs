// Bar edits while a sketch is being edited.
import * as H from "./lib.mjs";
import { clickPlane, TOP } from "../sketch-screen.mjs";
const env = await H.start(4249);
const show = async (page, what) => console.log(what.padEnd(40), "|", await H.bar(page), "|", await H.volume(page), "| sketching:", await page.evaluate(() => document.querySelector("#viewport").dataset.sketching), "|", (await H.undoTitle(page)).replace(" (Ctrl+Z)", ""), "| err:", await H.errLine(page), "| status:", await page.evaluate(() => document.querySelector("#sketch-status")?.textContent));
const startSketch = async (page) => {
  await page.click("#create-sketch"); await page.click("#sketch-plane-XY");
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
};
try {
  const scenarios = {
    "drag edited sketch to the start": async (page) => { await H.dragItemTo(page, "sketch-12", await H.gapPageX(page, 0)); },
    "drag box after edited sketch": async (page) => { await H.dragItemTo(page, "feature-1", await H.gapPageX(page, 4)); },
    "suppress box from bar": async (page) => { await page.click('#timeline [data-item="feature-1"]', { button: "right" }); await page.click("#row-menu-suppress"); await H.settle(page); },
    "step back": async (page) => { await page.click('#timeline [data-button="back"]', { force: true }); await H.settle(page); },
    "drag marker to start": async (page) => { const m = await H.markerBox(page); await H.mouseDrag(page, m.x + m.width / 2, m.y + m.height / 2, await H.gapPageX(page, 0), m.y + m.height / 2); await H.settle(page); },
    "delete extrude 1 from bar": async (page) => { await page.click('#timeline [data-item="feature-11"]', { button: "right" }); await page.click("#row-menu-delete"); await H.settle(page); },
    "edited sketch menu": async (page) => { await page.click('#timeline [data-item="sketch-12"]', { button: "right" }); await page.waitForTimeout(200); console.log("   entries:", await page.$$eval("#row-menu button", (b) => b.map((x) => x.id + (x.disabled ? "(off)" : "")).join(" "))); await page.keyboard.press("Escape"); },
  };
  for (const [name, fn] of Object.entries(scenarios)) {
    const page = await H.fresh(env);
    await H.addSquare(page);
    await startSketch(page);
    await page.click("#sketch-tool-line");
    await clickPlane(page, [5, 35], TOP); await clickPlane(page, [15, 35], TOP); await clickPlane(page, [15, 45], TOP);
    await H.settle(page);
    await show(page, `${name}: drawing`);
    await fn(page);
    await show(page, `${name}: after`);
    // still able to carry on drawing? click once more then finish
    const after = await H.save(page);
    const sk = H.design(after).sketches.find((s) => s.id === "sketch-12");
    console.log("   sketch-12 curves in file:", sk ? sk.curves.length : "gone", "| errors:", page.errors);
    await page.context().close();
  }
} finally { await env.browser.close(); await env.server.close(); }
