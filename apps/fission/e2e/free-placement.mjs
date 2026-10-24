// Browser check of free placement (sketch feel SF1): with grid snap off,
// as a new sketch starts, clicks land where you click (within half a
// pixel, as short decimals), not on the 10 mm grid; a click back near the
// first point still closes the outline exactly; a 3-point arc drawn freely
// is accepted; ticking Snap to grid puts clicks back on the grid, and the
// tool keys still work straight after ticking it (regression: the tickbox
// counted as a text field, so L, R, C and A did nothing). The same at
// 375 px with taps. Screenshots at 1280 and 375 px go to E2E_SHOTS when
// set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4187, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4187/";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

async function fresh(width = 1280, touch = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  // window.kernelDelay (ms) holds back every snap_to_grid request, so a key can be pressed while a click is snapped.
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      const wait = window.kernelDelay ?? 0;
      if (wait > 0 && message?.op === "snap_to_grid") return void setTimeout(() => send.call(this, message, ...rest), wait);
      return send.call(this, message, ...rest);
    };
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await startWithBox(page); // a new project starts empty (U0c): the 40 × 30 × 20 box, inserted
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

const statusIs = (page, want) => until(page, (w) => document.querySelector("#sketch-status")?.textContent === w, want, `status "${want}"`);
const statusStarts = (page, prefix) => until(page, (w) => document.querySelector("#sketch-status")?.textContent.startsWith(w), prefix, `status "${prefix}…"`);
/** The edited sketch's points as numbers. */
const pointList = async (page) => (await data(page, "sketchPoints")).split(" ").filter(Boolean).map((p) => p.split(",").map(Number));
/** Waits until the sketch has `n` points and returns them. */
async function nPoints(page, n) {
  await until(page, (k) => document.querySelector("#viewport").dataset.sketchPoints.split(" ").filter(Boolean).length === k, n, `${n} points`);
  return pointList(page);
}

async function startSketch(page, tap = false) {
  await (tap ? page.tap("#create-sketch") : page.click("#create-sketch"));
  await (tap ? page.tap("#sketch-plane-XY") : page.click("#sketch-plane-XY"));
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
}

/** Model of where a free click lands: within half of 10^k mm (the largest power of ten no bigger than a pixel) of the click, on a whole number of them. */
function assertFree(got, want, px, what) {
  const spacing = Number(`1e${Math.floor(Math.log10(px))}`);
  for (const k of [0, 1]) {
    // A few pixels of slack: the browser rounds the pointer to whole CSS pixels, and the click is that far from `want`.
    assert.ok(Math.abs(got[k] - want[k]) <= 1.5 * px, `${what}: ${got} is not where ${want} was clicked (pixel ${px} mm)`);
    assert.ok(Math.abs(got[k] / spacing - Math.round(got[k] / spacing)) < 1e-6, `${what}: ${got[k]} is not a whole number of ${spacing} mm`);
  }
  assert.ok(got.some((c) => Math.abs(c / 10 - Math.round(c / 10)) > 1e-9), `${what}: ${got} is on the 10 mm grid`);
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
  await check("free placement at 1280 px: Snap to grid starts off, clicks land where clicked, a click near the start closes the triangle", async () => {
    const page = await fresh();
    await startSketch(page);
    assert.equal(await page.isChecked("#sketch-grid-snap"), false, "grid snap starts off");
    assert.match(await page.textContent("#sketch-snap-help"), /where you click/);
    assert.doesNotMatch(await page.textContent("#sketch-help"), /grid/i);
    const px = await mmPerPixel(page);
    const corners = [[3.7, 2.3], [33.4, 6.1], [17.2, 26.9]];
    for (const [i, c] of corners.entries()) {
      await at(page, c);
      const pts = await nPoints(page, i + 1);
      assertFree(pts[i], c, px, `corner ${i + 1}`);
    }
    await statusStarts(page, "2 lines, not closed: ");
    const [first] = await pointList(page);
    // Back near the first point, 4 pixels off: it lands on it exactly (an endpoint snap) and closes.
    await at(page, [first[0] + 4 * px, first[1] - 4 * px]);
    await statusIs(page, "3 lines, a closed outline.");
    assert.equal((await pointList(page)).length, 3, "closing made no new point");
    assert.equal(await data(page, "sketchPreview"), "", "the chain ended");
    if (shots) await page.screenshot({ path: `${shots}/free-triangle-1280.png` });
    await page.context().close();
  });

  await check("a 3-point arc drawn freely: three clicks off the grid make one arc", async () => {
    const page = await fresh();
    await startSketch(page);
    await page.keyboard.press("a");
    const px = await mmPerPixel(page);
    // The end well off the start's row: within 10 px of it, it would line up level with the start (a snap, as meant).
    await at(page, [2.3, 3.1]);
    await at(page, [26.8, 7.9]);
    const box = await page.locator("#viewport canvas").boundingBox();
    const bend = screenPoint(box, [14.6, 11.7, 0], TOP);
    await page.mouse.move(bend.x, bend.y);
    await until(page, () => document.querySelector("#viewport").dataset.sketchPreview.split("|").length > 4, null, "the arc's preview");
    if (shots) await page.screenshot({ path: `${shots}/free-arc-preview-1280.png` });
    await at(page, [14.6, 11.7]);
    await statusStarts(page, "1 arc, not closed: ");
    // Its start, end and centre, the ends where they were clicked (the arc runs counter-clockwise, so they may swap).
    const pts = await nPoints(page, 3);
    for (const want of [[2.3, 3.1], [26.8, 7.9]]) {
      const got = pts.find((p) => Math.abs(p[0] - want[0]) <= 2 * px);
      assert.ok(got, `no end near ${want}: ${JSON.stringify(pts)}`);
      assertFree(got, want, px, `the end at ${want}`);
    }
    await page.context().close();
  });

  await check("Snap to grid: ticked, clicks land on the 10 mm grid, and R works straight after ticking (regression)", async () => {
    const page = await fresh();
    await startSketch(page);
    await page.check("#sketch-grid-snap");
    // Focus is on the tickbox: R must still choose the rectangle.
    await page.keyboard.press("r");
    await until(page, () => document.querySelector("#sketch-tool-rectangle")?.getAttribute("aria-pressed") === "true", null, "R chose Rectangle after ticking");
    await at(page, [3.7, 2.3]);
    await at(page, [33.4, 26.1]);
    await until(page, () => document.querySelector("#viewport").dataset.sketchPoints === "0,0 30,0 30,30 0,30", null, "a rectangle on the grid");
    // Unticked again: the next click lands where it is.
    await page.uncheck("#sketch-grid-snap");
    await page.keyboard.press("l");
    const px = await mmPerPixel(page);
    await at(page, [43.7, 12.3]);
    const pts = await nPoints(page, 5);
    assertFree(pts[4], [43.7, 12.3], px, "after unticking");
    await page.context().close();
  });

  await check("free placement at 375 px with taps: taps land where tapped, the tickbox row is 44 px tall, nothing wider than the screen", async () => {
    const page = await fresh(375, true);
    await startSketch(page, true);
    const px = await mmPerPixel(page);
    const corners = [[4.1, 2.7], [31.3, 5.9], [16.6, 24.2]];
    for (const [i, c] of corners.entries()) {
      await at(page, c, true);
      assertFree((await nPoints(page, i + 1))[i], c, px, `tap ${i + 1}`);
    }
    const [first] = await pointList(page);
    await at(page, [first[0] + 4 * px, first[1] + 4 * px], true);
    await statusIs(page, "3 lines, a closed outline.");
    const row = await page.locator(".sketch-grid-snap").boundingBox();
    assert.ok(row.height >= 44, `the Snap to grid row is ${row.height} px tall`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/free-triangle-375.png`, fullPage: true });
    await page.context().close();
  });

  await check("no errors in the console", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) process.exit(1);
