// Browser check of sketch snapping (snap.ts): hovering near a line's
// midpoint shows the snap and a click lands there exactly, off the grid;
// drawing on from it, the pointer near its column snaps the line vertical,
// near one point's row and another's column it closes a corner, and near
// an endpoint it lands on it and ends the chain. The same at 375 px wide
// with taps (no hover, the tap itself snaps). Screenshots at 1280 and
// 375 px go to E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4185, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4185/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const errors = [];
const shots = process.env.E2E_SHOTS;

async function fresh(width = 1280, touch = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

// Looking straight down on the 40 × 30 × 20 box from (0, 0, 0), framed about its centre (as sketch-tool.mjs).
const TOP = { toward: [0, 0, 1], up: [0, 1, 0], centre: [20, 15, 10], radius: Math.sqrt(2900) / 2 };

/** Where a model point is on screen for a view framing the box (45° fov, fit distance r / sin(half fov)). */
function screenPoint(box, [px, py, pz], view) {
  const n = Math.hypot(...view.toward);
  const dir = view.toward.map((d) => d / n);
  const aspect = box.width / box.height;
  const half = aspect < 1 ? Math.atan(Math.tan(Math.PI / 8) * aspect) : Math.PI / 8;
  const dist = view.radius / Math.sin(half);
  const cam = view.centre.map((c, i) => c + dir[i] * dist);
  const fwd = dir.map((d) => -d);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const right = unit(cross(fwd, view.up));
  const up = cross(right, fwd);
  const v = [px - cam[0], py - cam[1], pz - cam[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const t = Math.tan(Math.PI / 8);
  const ndcX = dot(v, right) / (dot(v, fwd) * t * aspect);
  const ndcY = dot(v, up) / (dot(v, fwd) * t);
  return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
}

const data = (page, key) => page.evaluate((k) => document.querySelector("#viewport").dataset[k] ?? "", key);
const until = (page, fn, arg, what) =>
  page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => assert.fail(`${what}: timed out`));
const shown = (key, want) => (page) => until(page, ([k, w]) => document.querySelector("#viewport").dataset[k] === w, [key, want], `${key} "${want}"`).catch(async (e) => assert.fail(`${e.message} (shown: "${await data(page, key)}")`));
const points = (page, want) => shown("sketchPoints", want)(page);
const snap = (page, want) => shown("sketchSnap", want)(page);
const preview_ = (page, want) => shown("sketchPreview", want)(page);

/** Model mm per screen pixel looking down (the view's height spans 2·dist·tan(22.5°), or its width at phone width). */
async function mmPerPixel(page) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const a = screenPoint(box, [0, 0, 0], TOP);
  const b = screenPoint(box, [10, 0, 0], TOP);
  return 10 / (b.x - a.x);
}

async function hover(page, [x, y]) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], TOP);
  await page.mouse.move(p.x, p.y);
}
async function at(page, [x, y], tap = false) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], TOP);
  if (tap) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

async function startSketch(page, tap = false) {
  await (tap ? page.tap("#create-sketch") : page.click("#create-sketch"));
  await (tap ? page.tap("#sketch-plane-XY") : page.click("#sketch-plane-XY"));
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

try {
  await check("snapping at 1280 px: a midpoint, vertical from the chain's point, a corner from a column and a row, an endpoint ending the chain", async () => {
    const page = await fresh();
    await startSketch(page);
    const px = await mmPerPixel(page);
    // 10 px of reach is this many mm here; every offset below is under half of it, and under a grid step.
    const off = 0.4 * 10 * px;
    // A line (0, 0) → (30, 0) on the grid, then Escape: its midpoint (15, 0) is off the 10 mm grid.
    await at(page, [0, 0]);
    await at(page, [30, 0]);
    await points(page, "0,0 30,0");
    await page.keyboard.press("Escape");
    // Hovering near (15, 0) shows the midpoint snap; the grid alone would say (10, 0) or (20, 0).
    await hover(page, [15 + off, off]);
    await snap(page, "midpoint 15,0");
    if (shots) await page.screenshot({ path: `${shots}/snap-midpoint-1280.png` });
    await at(page, [15 + off, off]);
    await points(page, "0,0 30,0 15,0");
    // Up from (15, 0), a little off its column: x lines up at 15, y is the grid's 20. The rubber band is vertical.
    await hover(page, [15 - off, 19]);
    await snap(page, "vertical from 15,0");
    await preview_(page, "15,0 15,20");
    if (shots) await page.screenshot({ path: `${shots}/snap-vertical-1280.png` });
    await at(page, [15 - off, 19]);
    await points(page, "0,0 30,0 15,0 15,20");
    // Near (30, 20): x lines up with (30, 0), y with (15, 20), which the grid's (30, 20) also is.
    await hover(page, [30 + off, 20 - off]);
    await snap(page, "vertical from 30,0 and horizontal from 15,20");
    await at(page, [30 + off, 20 - off]);
    await points(page, "0,0 30,0 15,0 15,20 30,20");
    // Near (30, 0): the endpoint. The click lands on it and the chain ends there.
    await hover(page, [30 - off, off]);
    await snap(page, "endpoint 30,0");
    if (shots) await page.screenshot({ path: `${shots}/snap-endpoint-1280.png` });
    await at(page, [30 - off, off]);
    await until(page, () => document.querySelector("#viewport").dataset.sketchLines === "4", null, "four lines");
    await points(page, "0,0 30,0 15,0 15,20 30,20");
    await preview_(page, "");
    // Off everything, on the grid: no snap shown.
    await hover(page, [-10, 35]);
    await snap(page, "");
    await page.context().close();
  });

  await check("snapping at 375 px with taps: a tap near a midpoint lands on it, a tap near the chain's column goes vertical", async () => {
    const page = await fresh(375, true);
    await startSketch(page, true);
    const off = 0.4 * 10 * (await mmPerPixel(page));
    for (const p of [[0, 0], [30, 0]]) await at(page, p, true);
    await points(page, "0,0 30,0");
    await page.keyboard.press("Escape");
    await at(page, [15 + off, -off], true);
    await points(page, "0,0 30,0 15,0");
    await at(page, [15 + off, 19], true);
    await points(page, "0,0 30,0 15,0 15,20");
    assert.equal(await data(page, "sketchLines"), "2");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/snap-375.png`, fullPage: true });
    await page.context().close();
  });

  await check("no errors in the console", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} snapping check(s) failed`);
  process.exit(1);
}
