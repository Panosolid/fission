// Browser check of the sketch tool (step 21c): Create sketch asks for a
// plane with the origin planes drawn at the origin (only the ground plane
// offered), a click on it makes Sketch 1 and looks straight down; clicks
// draw a chain of lines snapped to the grid, closing back on the first
// point; Ctrl+Z undoes one drawn line and you stay in the sketch; the grid
// size is typeable and a bad one is refused with the kernel's reason;
// Escape ends a chain; Finish sketch leaves it drawn. The same at 375 px
// wide with taps. The rectangle tool (step 22a): R or its button, two
// corners make four lines as one undo step, a corner on the first one's
// row draws nothing and says why, Escape drops the first corner, L goes
// back to lines; extruded it is a box of the hand-worked volume; the same
// at 375 px. Screenshots at 1280 and 375 px go to E2E_SHOTS when set.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4183, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4183/";
const browser = await launch();
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
const points = async (page, want) => until(page, (w) => document.querySelector("#viewport").dataset.sketchPoints === w, want, `points ${want} (shown: ${await data(page, "sketchPoints")})`);
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
  await check("Create sketch asks for a plane: the origin planes are drawn, only the ground plane is offered, Escape cancels", async () => {
    const page = await fresh();
    await page.click("#create-sketch");
    assert.equal(await page.isVisible("#sketch-prompt"), true);
    assert.equal(await data(page, "planes"), "XY, XZ (not offered), YZ (not offered)");
    assert.equal(await page.isDisabled("#sketch-plane-XZ"), true);
    assert.equal(await page.isDisabled("#sketch-plane-YZ"), true);
    assert.equal(await page.isEnabled("#sketch-plane-XY"), true);
    if (shots) await page.screenshot({ path: `${shots}/sketch-pick-1280.png` });
    // A click on the box picks nothing while choosing a plane.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#sketch-panel"), false, "Escape leaves the prompt");
    assert.equal(await data(page, "planes"), "", "the planes go");
    assert.equal(await undoTitle(page), "Nothing to undo", "cancelling made no sketch");
    await page.context().close();
  });

  await check("a click on the ground plane makes Sketch 1 (one undo step), looks straight down with a grid; clicks draw a closed rectangle", async () => {
    const page = await fresh();
    await page.click("#create-sketch");
    // The ground plane's square runs from the origin to (1.6r, 1.6r), r ≈ 27 mm the framing radius: (10, 38) is on it, clear of the box.
    await at(page, [10, 38], HOME);
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    assert.equal(await page.textContent("#sketch-name"), "Sketch 1");
    assert.equal(await undoTitle(page), "Undo Create sketch (Ctrl+Z)");
    assert.equal(await data(page, "planes"), "", "the planes go once one is picked");
    assert.ok(await page.isVisible('[data-node="sketches/sketch-2"]'), "the browser lists it");
    await status(page, "Nothing drawn yet.");
    // Each click a little off a grid node lands on the node (grid 10).
    await at(page, [1.5, -2], TOP);
    await points(page, "0,0");
    // Hovering shows the rubber band from the last point to the snapped pointer.
    const box = await page.locator("#viewport canvas").boundingBox();
    const hover = screenPoint(box, [38, 3, 0], TOP);
    await page.mouse.move(hover.x, hover.y);
    await until(page, () => document.querySelector("#viewport").dataset.sketchPreview === "0,0 40,0", null, "preview to (40, 0)");
    for (const p of [[38, 3], [41, 28], [-3, 31]]) await at(page, p, TOP);
    await points(page, "0,0 40,0 40,30 0,30");
    await statusStarts(page, "3 lines, not closed: ");
    await at(page, [2, 2], TOP); // back on the first point: closes, and the chain ends
    await status(page, "4 lines, a closed outline.");
    assert.equal(await data(page, "sketchLines"), "4");
    assert.equal(await data(page, "sketchPreview"), "", "the chain ended");
    assert.equal(await undoTitle(page), "Undo Draw line (Ctrl+Z)");
    if (shots) await page.screenshot({ path: `${shots}/sketch-draw-1280.png` });

    // Ctrl+Z takes back one line, and you are still in the sketch; Ctrl+Shift+Z puts it back.
    await page.keyboard.press("Control+z");
    await statusStarts(page, "3 lines, not closed: ");
    assert.equal(await data(page, "sketchLines"), "3");
    assert.equal(await page.isVisible("#sketch-name"), true, "still in the sketch after Undo");
    assert.equal(await data(page, "sketching"), "true");
    await page.keyboard.press("Control+Shift+z");
    await status(page, "4 lines, a closed outline.");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await status(page, "Nothing drawn yet.");
    await page.keyboard.press("Control+z"); // the sketch itself
    await until(page, () => document.querySelector("#sketch-panel")?.hidden === true, null, "the sketch is gone, so is the tool");
    assert.equal(await page.$('[data-node="sketches/sketch-2"]'), null);
    assert.equal(await undoTitle(page), "Nothing to undo");
    await page.context().close();
  });

  await check("the grid size is typeable; a refused one keeps the grid and says why; Escape ends a chain; Finish sketch leaves it drawn", async () => {
    const page = await fresh();
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.fill("#sketch-grid", "0");
    await page.press("#sketch-grid", "Enter");
    await until(page, () => !document.querySelector("#sketch-grid-error").hidden, null, "a refused grid");
    assert.match(await page.textContent("#sketch-grid-error"), /grid spacing must be between/);
    await page.fill("#sketch-grid", "2.5");
    await page.press("#sketch-grid", "Enter");
    await until(page, () => document.querySelector("#sketch-grid-error").hidden, null, "the grid taken");
    // Grid 2.5: (6, 1.4) → (5, 2.5); (13.6, 1) → (12.5, 0). The kernel gives the typed decimals.
    await at(page, [6, 1.4], TOP);
    await at(page, [13.6, 1], TOP);
    await points(page, "5,2.5 12.5,0");
    await page.keyboard.press("Escape"); // ends the chain: the next click only starts one
    await at(page, [20, 20], TOP);
    await points(page, "5,2.5 12.5,0 20,20");
    assert.equal(await data(page, "sketchLines"), "1", "Escape ended the chain: no line to (20, 20)");
    await page.click("#sketch-finish");
    assert.equal(await page.isVisible("#sketch-panel"), false);
    assert.equal(await data(page, "sketching"), "false");
    assert.equal(await data(page, "sketchLines"), "1", "the sketch stays drawn");
    // Back to modelling: a click on the box selects again.
    await page.keyboard.press("Escape");
    await page.context().close();
  });

  await check("at 375 px wide with taps: the prompt, the plane, a closed triangle, Undo, and nothing wider than the screen", async () => {
    const page = await fresh(375, true);
    await page.tap("#create-sketch");
    assert.equal(await page.isVisible("#sketch-prompt"), true);
    if (shots) await page.screenshot({ path: `${shots}/sketch-pick-375.png` });
    await page.tap("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    for (const p of [[0, 0], [30, 0], [30, 20], [0, 0]]) await at(page, p, TOP, true);
    await status(page, "3 lines, a closed outline.");
    const finish = await page.locator("#sketch-finish").boundingBox();
    assert.ok(finish.height >= 44, `Finish is ${finish.height} px tall, at least 44 to tap`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/sketch-draw-375.png`, fullPage: true });
    await page.tap("#undo");
    await statusStarts(page, "2 lines, not closed: ");
    await page.context().close();
  });

  await check("the rectangle tool: R, two corners make four lines as one undo step, a corner on the row says why, Escape, L, extruded 10 mm is 12,000 mm³", async () => {
    const page = await fresh();
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "true", "Line is the tool a sketch starts with");
    await page.mouse.move(0, 0);
    await page.keyboard.press("r");
    assert.equal(await page.getAttribute("#sketch-tool-rectangle", "aria-pressed"), "true", "R chose Rectangle");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "false");
    assert.match(await page.textContent("#sketch-help"), /^Click one corner, then the opposite corner/);
    // Pressed looks pressed (sketch.css, the toolbar's pressed colours), the other not.
    const fill = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).backgroundColor, id);
    assert.deepEqual([await fill("sketch-tool-rectangle"), await fill("sketch-tool-line")], ["rgb(35, 56, 79)", "rgb(38, 42, 49)"]);
    // Corner (0, 0), then the pointer at (38, 31) snaps to (40, 30): the preview is the four sides.
    await at(page, [1.5, -2], TOP);
    await points(page, "0,0");
    const box = await page.locator("#viewport canvas").boundingBox();
    const hover = screenPoint(box, [38, 31, 0], TOP);
    await page.mouse.move(hover.x, hover.y);
    await until(page, () => document.querySelector("#viewport").dataset.sketchPreview === "0,0 40,0 | 40,0 40,30 | 40,30 0,30 | 0,30 0,0", null, "the rectangle's preview");
    // A second corner on the first one's row: nothing drawn, and the reason under the grid.
    await at(page, [30, 2], TOP);
    await until(page, () => !document.querySelector("#sketch-grid-error").hidden, null, "the row note");
    assert.match(await page.textContent("#sketch-grid-error"), /^A rectangle needs a width and a height/);
    assert.equal(await data(page, "sketchLines"), "0");
    await at(page, [41, 29], TOP);
    await status(page, "4 lines, a closed outline.");
    assert.equal(await page.isHidden("#sketch-grid-error"), true, "the note goes once a rectangle is drawn");
    await points(page, "0,0 40,0 40,30 0,30");
    assert.equal(await undoTitle(page), "Undo Draw rectangle (Ctrl+Z)");
    if (shots) await page.screenshot({ path: `${shots}/sketch-rectangle-1280.png` });
    // One Ctrl+Z takes the whole rectangle back, staying in the sketch with the rectangle tool.
    await page.keyboard.press("Control+z");
    await status(page, "Nothing drawn yet.");
    assert.equal(await page.getAttribute("#sketch-tool-rectangle", "aria-pressed"), "true", "still the rectangle tool after Undo");
    await page.keyboard.press("Control+Shift+z");
    await status(page, "4 lines, a closed outline.");
    await page.keyboard.press("Control+z");
    await status(page, "Nothing drawn yet.");
    // Two clicks after the Undo draw a rectangle again: the tool really is still Rectangle, not only its button.
    await at(page, [1.5, -2], TOP);
    await at(page, [41, 29], TOP);
    await status(page, "4 lines, a closed outline.");
    // Escape drops a first corner: the next click is a first corner again.
    await at(page, [20, 40], TOP);
    await points(page, "0,0 40,0 40,30 0,30 20,40");
    await page.keyboard.press("Escape");
    await points(page, "0,0 40,0 40,30 0,30");
    assert.equal(await data(page, "sketchPreview"), "");
    // L goes back to lines; typing r in the grid box doesn't switch tools.
    await page.keyboard.press("l");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "true", "L chose Line");
    await page.focus("#sketch-grid");
    await page.keyboard.press("r");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "true", "a key typed in a field is the field's");
    // Extruded 10 mm: 40 · 30 · 10 = 12,000 mm³.
    await page.click("#sketch-extrude");
    await until(page, () => document.querySelector("#extrude-ok")?.disabled === false, null, "Extrude's OK on");
    await page.fill("#extrude-distance", "10");
    await page.click("#extrude-ok");
    await until(page, () => document.querySelector("#volume")?.textContent === "12,000 mm³", null, "12,000 mm³");
    // Outside a sketch R does nothing to Design.
    await page.mouse.move(0, 0);
    await page.keyboard.press("r");
    assert.equal(await page.isVisible("#sketch-panel"), false);
    await page.context().close();
  });

  await check("the rectangle tool at 375 px with taps: the tool buttons fit and are 44 px, two taps make a closed rectangle", async () => {
    const page = await fresh(375, true);
    await page.tap("#create-sketch");
    await page.tap("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.tap("#sketch-tool-rectangle");
    const button = await page.locator("#sketch-tool-rectangle").boundingBox();
    assert.ok(button.height >= 44, `Rectangle is ${button.height} px tall, at least 44 to tap`);
    for (const p of [[0, 0], [30, 20]]) await at(page, p, TOP, true);
    await status(page, "4 lines, a closed outline.");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/sketch-rectangle-375.png`, fullPage: true });
    await page.context().close();
  });

  await check("the circle tool: C, a centre then a point on the circle as one undo step, the preview, a click on the centre says why, Escape, extruded 10 mm is 4000π mm³", async () => {
    const page = await fresh();
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.mouse.move(0, 0);
    await page.keyboard.press("c");
    assert.equal(await page.getAttribute("#sketch-tool-circle", "aria-pressed"), "true", "C chose Circle");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "false");
    assert.equal(await page.getAttribute("#sketch-tool-circle", "title"), "Circle (C)");
    assert.match(await page.textContent("#sketch-help"), /^Click the centre, then a point on the circle/);
    // The centre (1.5, −2) snaps to (0, 0); the pointer at (19, 1) snaps to (20, 0): the preview is a circle of radius 20 in 64 sides.
    await at(page, [1.5, -2], TOP);
    await points(page, "0,0");
    const box = await page.locator("#viewport canvas").boundingBox();
    const hover = screenPoint(box, [19, 1, 0], TOP);
    await page.mouse.move(hover.x, hover.y);
    await until(page, () => (document.querySelector("#viewport").dataset.sketchPreview ?? "").split(" | ").length === 64, null, "the circle's preview");
    const preview = (await data(page, "sketchPreview")).split(" | ");
    assert.equal(preview[0].split(" ")[0], "20,0", "the preview starts at the east point, centre + (20, 0)");
    // A second click on the centre: nothing drawn, and the reason under the grid.
    await at(page, [0.5, 0.5], TOP);
    await until(page, () => !document.querySelector("#sketch-grid-error").hidden, null, "the centre note");
    assert.match(await page.textContent("#sketch-grid-error"), /^A circle needs a radius/);
    assert.equal(await data(page, "sketchLines"), "0");
    await at(page, [19, 1], TOP);
    await status(page, "1 circle, a closed outline.");
    assert.equal(await page.isHidden("#sketch-grid-error"), true, "the note goes once a circle is drawn");
    assert.equal(await data(page, "sketchLines"), "64", "the circle drawn as 64 segments");
    await points(page, "0,0");
    assert.equal(await undoTitle(page), "Undo Draw circle (Ctrl+Z)");
    if (shots) await page.screenshot({ path: `${shots}/sketch-circle-1280.png` });
    // One Ctrl+Z takes the circle back (and its centre), staying in the sketch with the circle tool; Ctrl+Shift+Z puts it back.
    await page.keyboard.press("Control+z");
    await status(page, "Nothing drawn yet.");
    await points(page, "");
    assert.equal(await page.getAttribute("#sketch-tool-circle", "aria-pressed"), "true", "still the circle tool after Undo");
    await page.keyboard.press("Control+Shift+z");
    await status(page, "1 circle, a closed outline.");
    // Escape drops a centre: the next click is a centre again.
    await at(page, [30, 40], TOP);
    await points(page, "0,0 30,40");
    await page.keyboard.press("Escape");
    await points(page, "0,0");
    assert.equal(await data(page, "sketchPreview"), "");
    // A rectangle beside it: the status counts both, and the kernel says why it doesn't close.
    await page.keyboard.press("r");
    await at(page, [30, 30], TOP);
    await at(page, [40, 40], TOP);
    await statusStarts(page, "4 lines and 1 circle, not closed: ");
    await page.keyboard.press("Control+z");
    await status(page, "1 circle, a closed outline.");
    // Extruded 10 mm: π · 20² · 10 = 4000π = 12,566.3706143… mm³, shown to ten figures.
    await page.click("#sketch-extrude");
    await until(page, () => document.querySelector("#extrude-ok")?.disabled === false, null, "Extrude's OK on");
    await page.fill("#extrude-distance", "10");
    await page.click("#extrude-ok");
    await until(page, () => document.querySelector("#volume")?.textContent === "12,566.37061 mm³", null, "4000π mm³");
    if (shots) await page.screenshot({ path: `${shots}/sketch-circle-extruded-1280.png` });
    // Outside a sketch C does nothing to Design.
    await page.mouse.move(0, 0);
    await page.keyboard.press("c");
    assert.equal(await page.isVisible("#sketch-panel"), false);
    await page.context().close();
  });

  await check("the circle tool at 375 px with taps: three tool buttons fit and are 44 px, two taps make a closed circle", async () => {
    const page = await fresh(375, true);
    await page.tap("#create-sketch");
    await page.tap("#sketch-plane-XY");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.tap("#sketch-tool-circle");
    for (const id of ["sketch-tool-line", "sketch-tool-rectangle", "sketch-tool-circle"]) {
      const b = await page.locator(`#${id}`).boundingBox();
      assert.ok(b.height >= 44, `${id} is ${b.height} px tall, at least 44 to tap`);
      assert.ok(b.x >= 0 && b.x + b.width <= 375, `${id} fits across the screen`);
    }
    for (const p of [[10, 10], [10, 30]]) await at(page, p, TOP, true);
    await status(page, "1 circle, a closed outline.");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/sketch-circle-375.png`, fullPage: true });
    await page.context().close();
  });

  await check("no errors in the console", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} sketch tool check(s) failed`);
  process.exit(1);
}
