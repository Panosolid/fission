// Browser check of typed sizes while drawing (sketch feel SF4): no boxes
// until a line has its start; then Length and Angle boxes by the pointer
// with the live size; a digit typed with nothing focused starts the
// Length box, which locks with a padlock (the preview keeps the length
// and turns with the pointer); Tab goes to Angle, Enter places the point
// and keeps typing going, so a 10 mm square typed side by side closes
// exactly on its first corner as four undo steps; a click with the
// length locked lands at that length; a bad size shows why and locks
// nothing; Escape in a box empties it without ending the line, and a
// second Escape ends it; letters typed in a box never reach the tool keys.
// The rectangle's Width and Height the same way. At 375 px with taps: the
// boxes whole on screen, a line typed by length and angle. Screenshots
// at 1280 and 375 px go to E2E_SHOTS when set. The arcs too: the hint by
// the pointer at each click ("Specify next point", "Place point on arc"),
// a 3-point arc's end typed by length and angle with no boxes for its
// point on the arc, a centre arc's start typed by radius and angle and its
// end by a typed 270° arc angle the way the pointer went (the preview first),
// and at 375 px with taps the boxes and hint whole on screen. Run with `npm run e2e`
// (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { TOP, clickPlane, screenPoint } from "./sketch-screen.mjs";

const server = await preview({ preview: { port: 4203, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4203/";
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

const data = (page, key) => page.evaluate((k) => document.querySelector("#viewport").dataset[k] ?? "", key);
const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(() => assert.fail(`${what}: timed out`));
const shown = (key) => async (page, want) => until(page, ([k, w]) => document.querySelector("#viewport").dataset[k] === w, [key, want], `${key} "${want}"`).catch(async (e) => assert.fail(`${e.message} (shown: "${await data(page, key)}")`));
const points = shown("sketchPoints");
const previewIs = shown("sketchPreview");
const boxesShown = (page) => page.isVisible("#typed-entry");
const focused = (page) => page.evaluate(() => document.activeElement?.id ?? "");
const locked = (page, field) => page.isVisible(`label[data-field=${field}] .typed-entry-lock`);
/** Moves the mouse over sketch point (x, y) looking down on the box. */
async function hover(page, [x, y]) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], TOP);
  await page.mouse.move(p.x, p.y);
}
/** The preview's one segment as numbers [[ax, ay], [bx, by]]. */
async function segment(page) {
  const text = await data(page, "sketchPreview");
  return text.split(" ").map((p) => p.split(",").map(Number));
}
const undoLabel = (page) => page.getAttribute("#undo", "title");

/** A sketch on the ground plane looked at from the top (as the other sketch checks), on a 1 mm grid with Snap to grid ticked, so hovers and clicks land on exact millimetres. */
async function sketch(page, tap = false) {
  await (tap ? page.tap("#create-sketch") : page.click("#create-sketch"));
  await (tap ? page.tap("#sketch-plane-XY") : page.click("#sketch-plane-XY"));
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await (tap ? page.tap("#sketch-grid-snap") : page.check("#sketch-grid-snap"));
  // A 1 mm grid, so a hover lands on whole millimetres; then nothing focused, as after drawing.
  await page.fill("#sketch-grid", "1");
  await page.$eval("#sketch-grid", (e) => (e.dispatchEvent(new Event("change")), e.blur()));
  await page.locator("#viewport canvas").scrollIntoViewIfNeeded(); // filling the grid box scrolls a phone's page
  await page.waitForTimeout(600); // the camera's damping settles on the plane
}

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed = true;
    console.error(`not ok - ${name}\n  ${e.stack ?? e}`);
  }
}

await check("1280 px: a 10 mm square typed side by side closes on its first corner", async () => {
  const page = await fresh();
  await sketch(page);
  await hover(page, [20, 5]);
  assert.equal(await boxesShown(page), false, "no boxes before the line has its start");
  await clickPlane(page, [0, 0]);
  await points(page, "0,0");
  await hover(page, [20, 0]);
  await previewIs(page, "0,0 20,0");
  assert.equal(await boxesShown(page), true, "the boxes show once the line has its start");
  assert.equal(await page.getAttribute("#typed-length", "placeholder"), "20", "the live length");
  assert.equal(await page.getAttribute("#typed-angle", "placeholder"), "0", "the live angle");
  // Regression (Firefox sketch session): with nothing typed, a click where the boxes are goes through them to the sketch.
  const under = async () => page.evaluate(() => {
    const r = document.querySelector("#typed-entry").getBoundingClientRect();
    const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return e?.closest("#typed-entry") ? "BOXES" : e?.tagName;
  });
  assert.equal(await under(), "CANVAS", "the boxes let clicks through while nothing is typed");
  // Boxes by the pointer: their corner within 60 px of it.
  const box = await page.locator("#viewport canvas").boundingBox();
  const at = screenPoint(box, [20, 0, 0], TOP);
  const b = await page.locator("#typed-entry").boundingBox();
  assert.ok(Math.abs(b.x - at.x) < 60 && Math.abs(b.y - at.y) < 60, `boxes at ${b.x},${b.y}, pointer at ${at.x},${at.y}`);
  // A digit with nothing focused starts the Length box; the length locks with its padlock.
  assert.equal(await locked(page, "length"), false);
  await page.keyboard.press("1");
  assert.equal(await focused(page), "typed-length");
  await page.keyboard.press("0");
  assert.equal(await page.inputValue("#typed-length"), "10");
  assert.equal(await locked(page, "length"), true, "padlock on the typed length");
  assert.equal(await under(), "BOXES", "while typing, the boxes take clicks");
  await previewIs(page, "0,0 10,0");
  // The pointer turns the locked length: straight up gives (0, 10).
  await hover(page, [0, 30]);
  await previewIs(page, "0,0 0,10");
  // Tab to Angle, 0: the line turns back to the x axis whatever the pointer.
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), "typed-angle");
  await page.keyboard.type("0");
  assert.equal(await locked(page, "angle"), true);
  await previewIs(page, "0,0 10,0");
  if (shots) await page.screenshot({ path: `${shots}/typed-entry-1280.png` });
  await page.keyboard.press("Enter");
  await points(page, "0,0 10,0");
  assert.match(await undoLabel(page), /^Undo Draw line/);
  // Enter empties the boxes and keeps typing going for the next side.
  assert.equal(await focused(page), "typed-length");
  assert.equal(await page.inputValue("#typed-length"), "");
  assert.equal(await locked(page, "length"), false);
  for (const angle of ["90", "180"]) {
    await page.keyboard.type("10");
    await page.keyboard.press("Tab");
    await page.keyboard.type(angle);
    await page.keyboard.press("Enter");
  }
  await points(page, "0,0 10,0 10,10 0,10");
  // The last side: 10 at 270° lands on (0, 0) exactly, joins the first point and ends the chain.
  await page.keyboard.type("10");
  await page.keyboard.press("Tab");
  await page.keyboard.type("270");
  await page.keyboard.press("Enter");
  await previewIs(page, "");
  await points(page, "0,0 10,0 10,10 0,10");
  assert.equal(await data(page, "sketchLines"), "4");
  await until(page, () => /closed/i.test(document.querySelector("#sketch-status")?.textContent ?? ""), null, "the status says the outline is closed");
  assert.equal(await boxesShown(page), false, "the chain ended: no boxes");
  // Four undo steps, one per line.
  for (let i = 0; i < 4; i++) await page.click("#undo");
  await points(page, "");
  await page.close();
});

await check("1280 px: a click with the length locked, a bad size, Escape twice, letters in a box", async () => {
  const page = await fresh();
  await sketch(page);
  await clickPlane(page, [0, 0]);
  await hover(page, [3, 4]);
  await previewIs(page, "0,0 3,4");
  // 15 toward (3, 4): |(3, 4)| = 5, so 15/5 = 3 times it: (9, 12).
  await page.keyboard.type("15");
  await previewIs(page, "0,0 9,12");
  await clickPlane(page, [3, 4]);
  await points(page, "0,0 9,12");
  assert.equal(await page.inputValue("#typed-length"), "", "the click used the length and emptied the box");
  // A bad length: red with the reason, no padlock, the preview follows the pointer.
  await hover(page, [20, 12]);
  await previewIs(page, "9,12 20,12");
  await page.keyboard.type("1..");
  assert.equal(await page.getAttribute("#typed-length", "aria-invalid"), "true");
  assert.equal(await locked(page, "length"), false);
  assert.match(await page.textContent("label[data-field=length] .typed-entry-error"), /isn't a length/);
  await previewIs(page, "9,12 20,12");
  // Letters go into the box, never to the tool keys: R does not switch to the rectangle.
  await page.keyboard.type("r");
  assert.equal(await page.inputValue("#typed-length"), "1..r");
  assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "true");
  // Escape in a box empties it and leaves it, the line still going; a second Escape ends the line.
  await page.keyboard.press("Escape");
  assert.equal(await page.inputValue("#typed-length"), "");
  assert.notEqual(await focused(page), "typed-length");
  assert.equal(await boxesShown(page), true, "the line is still going");
  await hover(page, [20, 20]);
  await previewIs(page, "9,12 20,20");
  await page.keyboard.press("Escape");
  await previewIs(page, "");
  assert.equal(await boxesShown(page), false);
  await page.close();
});

await check("1280 px: a rectangle typed 20 × 5 down and to the right", async () => {
  const page = await fresh();
  await sketch(page);
  await page.keyboard.press("r");
  await clickPlane(page, [30, 30]);
  await hover(page, [35, 20]);
  assert.deepEqual(await page.$$eval(".typed-entry-name", (e) => e.map((x) => x.textContent)), ["Width", "Height"]);
  assert.equal(await page.getAttribute("#typed-width", "placeholder"), "5");
  assert.equal(await page.getAttribute("#typed-height", "placeholder"), "10");
  await page.keyboard.type("20");
  await page.keyboard.press("Tab");
  await page.keyboard.type("5");
  // Corner (30, 30), pointer down-right: (30 + 20, 30 − 5) = (50, 25).
  await page.keyboard.press("Enter");
  await points(page, "30,30 50,30 50,25 30,25");
  assert.match(await undoLabel(page), /^Undo Draw rectangle/);
  assert.equal(await boxesShown(page), false);
  await page.close();
});

await check("375 px with taps: the boxes on screen, a line typed by length and angle", async () => {
  const page = await fresh(375, true);
  await sketch(page, true);
  await clickPlane(page, [20, 15], TOP, true);
  await points(page, "20,15");
  assert.equal(await boxesShown(page), true);
  const b = await page.locator("#typed-entry").boundingBox();
  const v = await page.locator("#viewport").boundingBox();
  assert.ok(b.x >= 0 && b.x + b.width <= 375, `boxes inside the screen's width: ${b.x} to ${b.x + b.width}`);
  assert.ok(b.y >= v.y && b.y + b.height <= v.y + v.height + 1, "boxes inside the view");
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scroll <= 375, `no sideways scroll (${scroll} px)`);
  await page.locator("#typed-length").tap();
  await page.keyboard.type("25");
  await page.locator("#typed-angle").tap();
  await page.keyboard.type("90");
  if (shots) await page.screenshot({ path: `${shots}/typed-entry-375.png` });
  await page.keyboard.press("Enter");
  await points(page, "20,15 20,40");
  await page.close();
});

const hintIs = (page, want) => until(page, (w) => { const h = document.getElementById("sketch-hint"); return h && !h.hidden && h.textContent === w; }, want, `hint "${want}"`).catch(async (e) => assert.fail(`${e.message} (shown: "${await page.textContent("#sketch-hint")}", hidden ${await page.$eval("#sketch-hint", (h) => h.hidden)})`));
const previewCount = (page, n, what) => until(page, (w) => (document.querySelector("#viewport").dataset.sketchPreview ?? "").split(" | ").length === w, n, what);

await check("1280 px: a 3-point arc, its end typed 20 mm at 0°, then a point on the arc with no boxes", async () => {
  const page = await fresh();
  await sketch(page);
  await page.keyboard.press("a");
  await hover(page, [3, 3]);
  await hintIs(page, "Place start point");
  assert.equal(await boxesShown(page), false);
  await clickPlane(page, [0, 0]);
  await points(page, "0,0");
  await hover(page, [6, 8]);
  await hintIs(page, "Specify next point");
  assert.deepEqual(await page.$$eval(".typed-entry-name", (e) => e.map((x) => x.textContent)), ["Length", "Angle"]);
  assert.equal(await page.getAttribute("#typed-length", "placeholder"), "10", "the live length to (6, 8)");
  await page.keyboard.type("20");
  await page.keyboard.press("Tab");
  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  // Start (0, 0), end 20 along 0°: (20, 0), whatever the pointer.
  await points(page, "0,0 20,0");
  assert.equal(await boxesShown(page), false, "no boxes for the point on the arc");
  await hover(page, [10, 10]);
  await hintIs(page, "Place point on arc");
  // Through (10, 10): the half circle round (10, 0), 32 segments.
  await previewCount(page, 32, "the half circle's preview");
  if (shots) await page.screenshot({ path: `${shots}/arc-3point-1280.png` });
  await clickPlane(page, [10, 10]);
  // Counter-clockwise from (20, 0) over the top to (0, 0) round (10, 0): ids start, end, centre.
  await points(page, "20,0 0,0 10,0");
  assert.match(await undoLabel(page), /^Undo Draw arc/);
  await hintIs(page, "Place start point");
  await page.close();
});

await check("1280 px: a centre arc, its start typed radius 10 at 90°, its end typed 270° the way the pointer went", async () => {
  const page = await fresh();
  await sketch(page);
  await page.click("#sketch-create");
  await page.hover("#sketch-menu-group-arc");
  await page.click("#sketch-menu-centre");
  await hover(page, [21, 12]);
  await hintIs(page, "Place centre point");
  await clickPlane(page, [20, 10]);
  await points(page, "20,10");
  await hover(page, [25, 12]);
  await hintIs(page, "Place start point");
  assert.deepEqual(await page.$$eval(".typed-entry-name", (e) => e.map((x) => x.textContent)), ["Radius", "Angle"]);
  await page.keyboard.type("10");
  await page.keyboard.press("Tab");
  await page.keyboard.type("90");
  await page.keyboard.press("Enter");
  // 10 along 90° from (20, 10): (20, 20).
  await points(page, "20,10 20,20");
  // A little counter-clockwise from straight up (to the left), then 270 typed: three quarters that way.
  await hover(page, [19, 20]);
  await hover(page, [17, 19]);
  await hintIs(page, "Place end point");
  assert.deepEqual(await page.$$eval(".typed-entry-name", (e) => e.map((x) => x.textContent)), ["Arc angle"]);
  await page.keyboard.type("270");
  assert.equal(await locked(page, "sweep"), true, "the padlock");
  await previewCount(page, 50, "three quarters: 48 segments and two radius lines");
  if (shots) await page.screenshot({ path: `${shots}/arc-centre-typed-1280.png` });
  await page.keyboard.press("Enter");
  // 270° counter-clockwise from 90° is 360°: the end at (30, 10).
  await points(page, "20,20 30,10 20,10");
  assert.match(await undoLabel(page), /^Undo Draw centre arc/);
  await page.close();
});

await check("375 px with taps: an arc's end typed, the boxes and hint on screen", async () => {
  const page = await fresh(375, true);
  await sketch(page, true);
  await page.keyboard.press("a");
  await clickPlane(page, [10, 10], TOP, true);
  await points(page, "10,10");
  await hintIs(page, "Specify next point");
  for (const sel of ["#typed-entry", "#sketch-hint"]) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 375, `${sel} inside the screen's width: ${b.x} to ${b.x + b.width}`);
  }
  const t = await page.locator("#typed-entry").boundingBox();
  const h = await page.locator("#sketch-hint").boundingBox();
  assert.ok(h.y + h.height <= t.y || t.y + t.height <= h.y, "the hint and the boxes don't overlap");
  await page.locator("#typed-length").tap();
  await page.keyboard.type("20");
  await page.locator("#typed-angle").tap();
  await page.keyboard.type("0");
  if (shots) await page.screenshot({ path: `${shots}/arc-typed-375.png` });
  await page.keyboard.press("Enter");
  await points(page, "10,10 30,10");
  await clickPlane(page, [20, 20], TOP, true);
  await points(page, "30,10 10,10 20,10");
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scroll <= 375, `no sideways scroll (${scroll} px)`);
  await page.close();
});

await browser.close();
await server.close();
if (errors.length) {
  console.error(`page errors:\n${errors.join("\n")}`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
