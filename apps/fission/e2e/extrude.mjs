// Browser check of Extrude (step 21d): a rectangle drawn in Sketch 1, then
// Extrude from the sketch panel: the panel offers that sketch, says it is
// closed, refuses a distance the kernel refuses (nothing recorded), and OK
// makes the part a 40 × 30 × 10 solid (12,000 mm³) as one undo step, framed
// in the 3D view, with only "Extrude by" in the parameters; a typed
// distance rebuilds it; Undo and Redo; a preset after it; an open sketch
// and no sketch at all keep OK off and say why; Escape cancels. The same at
// 375 px wide with taps. Screenshots go to E2E_SHOTS when set. Run with
// `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4184, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4184/";
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

// The 40 × 30 × 20 box from (0, 0, 0): framed about its centre, radius half its diagonal.
const HOME = { toward: [0.6, -0.8, 0.55], up: [0, 0, 1], centre: [20, 15, 10], radius: Math.sqrt(2900) / 2 };
const TOP = { ...HOME, toward: [0, 0, 1], up: [0, 1, 0] };

/** Where a model point is on screen for a view framing the box (the same sums as smoke.mjs: 45° fov, fit distance r / sin(half fov)). */
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
const undoTitle = (page) => page.evaluate(() => document.getElementById("undo").title);
const until = (page, fn, arg, what) =>
  page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => assert.fail(`${what}: timed out`));
/** Waits until the edited sketch shows these points (the kernel snaps each click first). */
const points = (page, want) => until(page, (w) => document.querySelector("#viewport").dataset.sketchPoints === w, want, `points ${want}`);
/** Waits until the status starts with `prefix` (the rest is the kernel's reason). */
const statusStarts = (page, prefix) => until(page, (w) => document.querySelector("#sketch-status")?.textContent.startsWith(w), prefix, `status "${prefix}…"`);
const status = (page, want) => until(page, (w) => document.querySelector("#sketch-status")?.textContent === w, want, `status "${want}"`);

/** Clicks (or taps) at a point of the ground plane, z = 0, as seen from `view`. */
async function at(page, [x, y], view, tap = false) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], view);
  if (tap) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

const volume = async (page, want) => until(page, (w) => document.querySelector("#volume")?.textContent === w, want, `volume ${want} (shown: ${await page.textContent("#volume")}, ${await undoTitle(page)})`);
const extrudeStatus = (page, want) => until(page, (w) => document.querySelector("#extrude-status")?.textContent.startsWith(w), want, `extrude status "${want}…"`);

/** Create sketch on the ground plane, then a closed chain through these points (grid 10), seen from above. */
async function drawn(page, pts, tap = false) {
  if (tap) await page.tap("#create-sketch");
  else await page.click("#create-sketch");
  if (tap) await page.tap("#sketch-plane-XY");
  else await page.click("#sketch-plane-XY");
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  for (const p of pts) await at(page, p, TOP, tap);
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
  await check("Extrude from the sketch panel: a closed rectangle becomes a 40 × 30 × 10 solid, one undo step; a refused distance records nothing", async () => {
    const page = await fresh();
    await drawn(page, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]);
    await status(page, "4 lines, a closed outline.");
    const fitsBefore = Number(await data(page, "fits"));
    await page.click("#sketch-extrude");
    // Extrude finishes the sketch and offers it.
    assert.equal(await data(page, "sketching"), "false", "the sketch is finished");
    assert.equal(await page.isVisible("#sketch-panel"), false);
    assert.equal(await page.isVisible("#extrude-panel"), true);
    assert.equal(await page.inputValue("#extrude-sketch"), "sketch-2");
    assert.equal(await page.inputValue("#extrude-distance"), "10");
    await extrudeStatus(page, "Sketch 1 makes a closed outline.");
    assert.equal(await page.isEnabled("#extrude-ok"), true);
    if (shots) await page.screenshot({ path: `${shots}/extrude-panel-1280.png` });
    // 0 mm is no solid: the kernel says why, the panel stays, nothing is recorded.
    await page.fill("#extrude-distance", "0");
    await page.click("#extrude-ok");
    await until(page, () => !document.querySelector("#extrude-error").hidden, null, "a refused distance");
    assert.match(await page.textContent("#extrude-error"), /extrude distance must be between/);
    assert.equal(await undoTitle(page), "Undo Draw line (Ctrl+Z)");
    assert.equal(await page.textContent("#volume"), "24,000 mm³", "the box is still the part");
    // 10 mm, Enter: 40 · 30 · 10 = 12,000 mm³; area 2(1200) + 2(400) + 2(300) = 3,800 mm².
    await page.fill("#extrude-distance", "10");
    await page.press("#extrude-distance", "Enter");
    await volume(page, "12,000 mm³");
    assert.equal(await page.textContent("#area"), "3,800 mm²");
    assert.equal(await page.textContent("#topology"), "8 V · 12 E · 6 F");
    assert.equal(await page.isVisible("#extrude-panel"), false);
    assert.equal(await undoTitle(page), "Undo Replace the part with Extrude of Sketch 1 (Ctrl+Z)");
    assert.equal(await page.textContent("#intent"), "Extrude Sketch 1 by 10 mm");
    assert.match(await page.textContent("#provenance"), /Sketch 1/);
    // Only the distance is a parameter: the sketch gives the outline.
    assert.equal(await page.isVisible("#width"), false);
    assert.equal(await page.isVisible("#depth"), false);
    assert.equal(await page.textContent("#height-label"), "Extrude by");
    assert.equal(await page.inputValue("#height"), "10");
    // A new part: framed again in the 3D view, not left looking straight down.
    assert.equal(Number(await data(page, "fits")), fitsBefore + 1, "framed once");
    assert.equal(await data(page, "shape"), "sketch-extrude");
    assert.ok(await page.isVisible('[data-node="sketches/sketch-2"]'), "the sketch stays in the browser");
    if (shots) await page.screenshot({ path: `${shots}/extrude-done-1280.png` });

    // A typed distance rebuilds it: 1200 · 25 = 30,000 mm³, one "Change extrude distance" step.
    await page.fill("#height", "25");
    await volume(page, "30,000 mm³");
    assert.equal(await undoTitle(page), "Undo Change extrude distance (Ctrl+Z)");
    assert.equal(await page.textContent("#intent"), "Extrude Sketch 1 by 25 mm");
    // Undo (out of the box: in it, Ctrl+Z is the field's own): 10 mm, then the box and the sketch as drawn; Redo puts the extrude back.
    await page.locator("#height").blur();
    await page.keyboard.press("Control+z");
    await volume(page, "12,000 mm³");
    await page.keyboard.press("Control+z");
    await volume(page, "24,000 mm³");
    assert.equal(await page.isVisible("#width"), true, "the box's sizes are back");
    assert.equal(await data(page, "sketchLines"), "4", "the sketch is still drawn");
    await page.keyboard.press("Control+Shift+z");
    await volume(page, "12,000 mm³");
    assert.equal(await page.textContent("#height-label"), "Extrude by");
    // A preset after it replaces it, keeping the sizes in the boxes (the height box held the distance):
    // a 40 × 30 × 10 box, the same 12,000 mm³ but a box. Undo brings the extrude back.
    await page.click('[data-op="set_part"][data-shape="box"]');
    await until(page, () => document.querySelector("#intent")?.textContent === "Box: 40 × 30 × 10 mm", null, "the box");
    assert.equal(await undoTitle(page), "Undo Change shape to Box (Ctrl+Z)");
    assert.equal(await page.isVisible("#width"), true);
    await page.keyboard.press("Control+z");
    await until(page, () => document.querySelector("#intent")?.textContent === "Extrude Sketch 1 by 10 mm", null, "the extrude again");
    assert.equal(await page.textContent("#height-label"), "Extrude by");
    await page.context().close();
  });

  await check("an open sketch can't be extruded: OK stays off with the kernel's reason; no sketch at all says so; Escape and Cancel leave", async () => {
    const page = await fresh();
    await page.click("#extrude");
    await extrudeStatus(page, "There is no sketch to extrude yet: draw one with Create sketch.");
    assert.equal(await page.isDisabled("#extrude-ok"), true);
    assert.equal(await page.isDisabled("#extrude-sketch"), true);
    await page.click("#extrude-cancel");
    assert.equal(await page.isVisible("#extrude-panel"), false);
    await drawn(page, [[0, 0], [40, 0], [40, 30]]);
    await statusStarts(page, "2 lines, not closed: ");
    await page.click("#extrude"); // the toolbar's, while drawing: offers the sketch being drawn
    await extrudeStatus(page, "Sketch 1 can't be extruded: it doesn't make one closed outline (");
    assert.match(await page.textContent("#extrude-status"), /not joined to another line/);
    assert.equal(await page.isDisabled("#extrude-ok"), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#extrude-panel"), false);
    assert.equal(await undoTitle(page), "Undo Draw line (Ctrl+Z)", "nothing recorded");
    assert.equal(await page.textContent("#volume"), "24,000 mm³");
    await page.context().close();
  });

  await check("at 375 px wide with taps: a triangle extruded from the toolbar, controls 44 px tall, nothing wider than the screen", async () => {
    const page = await fresh(375, true);
    await drawn(page, [[0, 0], [30, 0], [30, 20], [0, 0]], true);
    await status(page, "3 lines, a closed outline.");
    await page.tap("#extrude");
    await extrudeStatus(page, "Sketch 1 makes a closed outline.");
    for (const id of ["#extrude-ok", "#extrude-cancel", "#extrude-distance", "#extrude-sketch"]) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box.height >= 44, `${id} is ${box.height} px tall, at least 44 to tap`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/extrude-panel-375.png`, fullPage: true });
    // ½ · 30 · 20 = 300 mm², by 10 mm: 3,000 mm³.
    await page.tap("#extrude-ok");
    await volume(page, "3,000 mm³");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling after");
    if (shots) await page.screenshot({ path: `${shots}/extrude-done-375.png`, fullPage: true });
    await page.tap("#undo");
    await volume(page, "24,000 mm³");
    await page.context().close();
  });

  await check("no errors in the console", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} extrude check(s) failed`);
  process.exit(1);
}
