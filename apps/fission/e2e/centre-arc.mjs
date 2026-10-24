// Browser check of the three arc tools under one Arc row of the sketch's
// Create menu, and of the centre arc: the Arc row opens its own menu on
// hover and by keys, Centre arc chosen from it; a centre, a start and a
// pointer swept counter-clockwise past half a turn draw three quarters of
// a circle (the preview first), closed by two lines and extruded to 750π
// mm³ worked by hand; the note for a start on the centre; Escape drops
// the clicks; and at 375 px with taps (no hover) the shorter way round,
// with the Arc menu whole on screen and its rows 44 px tall. Screenshots
// go to E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { TOP, clickPlane, screenPoint } from "./sketch-screen.mjs";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4196, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4196/";
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
  await startWithBox(page); // a new project starts empty (U0c): the 40 × 30 × 20 box, inserted
  return page;
}

const data = (page, key) => page.evaluate((k) => document.querySelector("#viewport").dataset[k] ?? "", key);
const until = (page, fn, arg, what) =>
  page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => {
    const shown = await page.evaluate(() => `status "${document.querySelector("#sketch-status")?.textContent}", note "${document.querySelector("#sketch-grid-error")?.textContent}"`);
    assert.fail(`${what}: timed out; the page shows ${shown}`);
  });
const points = async (page, want) => until(page, (w) => document.querySelector("#viewport").dataset.sketchPoints === w, want, `points ${want} (shown: ${await data(page, "sketchPoints")})`);
const previewCount = (page, n, what) => until(page, (w) => (document.querySelector("#viewport").dataset.sketchPreview ?? "").split(" | ").length === w, n, what);
const rect = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
/** Moves the mouse over a point of the ground plane, seen from the top. */
async function hover(page, [x, y]) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const p = screenPoint(box, [x, y, 0], TOP);
  await page.mouse.move(p.x, p.y);
}

/** Into a sketch on the ground plane with grid snap ticked, so clicks land on the 10 mm grid. */
async function startSketch(page, tap = false) {
  await (tap ? page.tap("#create-sketch") : page.click("#create-sketch"));
  await (tap ? page.tap("#sketch-plane-XY") : page.click("#sketch-plane-XY"));
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0)); // ticking it scrolled the panel into view at phone width
}

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

await check("the Arc row: hover opens the three arcs beside it, another row closes them, keys open them too", async () => {
  const page = await fresh();
  try {
    await startSketch(page);
    await page.click("#sketch-create");
    assert.equal(await page.isVisible("#sketch-arc-menu"), false, "the arcs wait for their row");
    const rows = await page.$$eval("#sketch-create-menu > button", (els) => els.map((e) => e.textContent));
    assert.deepEqual(rows, ["LineL", "RectangleR", "CircleC", "Arc▸", "ProjectP"], "Line, Rectangle, Circle, Arc, then Project");
    await page.hover("#sketch-menu-group-arc");
    await until(page, () => !document.getElementById("sketch-arc-menu").hidden, null, "the arcs open on hover");
    const sub = await page.$$eval("#sketch-arc-menu [role=menuitemradio]", (els) => els.map((e) => [e.querySelector("span").textContent, e.querySelector("kbd").textContent]));
    assert.deepEqual(sub, [["3-point arc", "A"], ["Centre arc", ""], ["Tangent arc", "T"]]);
    const row = await rect(page, "#sketch-menu-group-arc");
    const menu = await rect(page, "#sketch-arc-menu");
    assert.ok(menu.left >= row.right && menu.left - row.right <= 4 && Math.abs(menu.top - row.top) <= 6, `beside the Arc row: ${JSON.stringify(menu)} vs ${JSON.stringify(row)}`);
    const onTop = await page.evaluate(() => {
      const r = document.getElementById("sketch-menu-centre").getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#sketch-menu-centre") !== null;
    });
    assert.ok(onTop, "nothing covers the arcs' rows");
    if (shots) await page.screenshot({ path: `${shots}/arc-menu-1280.png` });
    await page.hover("#sketch-menu-circle");
    await until(page, () => document.getElementById("sketch-arc-menu").hidden, null, "another row closes the arcs");
    // Keys: End to Project (the last row), Up to Arc, Right opens it on its first row, Down twice is Tangent arc, Enter chooses it.
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-project");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-arc");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute("#sketch-tool-tangent", "aria-pressed"), "true", "Enter chose Tangent arc");
    assert.equal(await page.isVisible("#sketch-create-menu"), false);
  } finally {
    await page.context().close();
  }
});

await check("a centre arc swept counter-clockwise past half a turn: three quarters, closed by two lines, extruded to 750π mm³", async () => {
  const page = await fresh();
  try {
    await startSketch(page);
    await page.click("#sketch-create");
    await page.hover("#sketch-menu-group-arc");
    await page.click("#sketch-menu-centre");
    assert.equal(await page.getAttribute("#sketch-tool-centre", "aria-pressed"), "true");
    assert.match(await page.textContent("#sketch-help"), /^Click the centre, then the start, then where the arc ends/);
    // A start on the centre says why nothing happens.
    await clickPlane(page, [20, 10]);
    await points(page, "20,10");
    await clickPlane(page, [20, 10]);
    await until(page, () => /^An arc needs a radius/.test(document.querySelector("#sketch-grid-error").textContent), null, "the no-radius note");
    await clickPlane(page, [30, 10]);
    await points(page, "20,10 30,10");
    // Round counter-clockwise: up, left, then down. At (10, 10) the preview is the half circle (32 segments) and its two radius lines.
    await hover(page, [20, 20]);
    await previewCount(page, 18, "a quarter: 16 segments and two radius lines");
    await hover(page, [10, 10]);
    await previewCount(page, 34, "a half: 32 segments and two radius lines");
    await hover(page, [20, 0]);
    await previewCount(page, 50, "three quarters: 48 segments and two radius lines");
    if (shots) await page.screenshot({ path: `${shots}/centre-arc-preview-1280.png` });
    await clickPlane(page, [20, 0]);
    // Counter-clockwise from (30, 10) to (20, 0) round (20, 10): ids start, end, centre.
    await points(page, "30,10 20,0 20,10");
    await until(page, () => document.querySelector("#sketch-status").textContent.startsWith("1 arc, not closed"), null, "one arc");
    assert.equal(await page.evaluate(() => document.getElementById("undo").title), "Undo Draw centre arc (Ctrl+Z)");
    // Close it: (20, 0) → (20, 10) → (30, 10).
    await page.keyboard.press("l");
    for (const p of [[20, 0], [20, 10]]) await clickPlane(page, p);
    await until(page, () => document.querySelector("#sketch-status").textContent.startsWith("1 line and 1 arc"), null, "one line");
    for (const p of [[20, 10], [30, 10]]) await clickPlane(page, p);
    await until(page, () => document.querySelector("#sketch-status").textContent === "2 lines and 1 arc, a closed outline.", null, "closed");
    // Three quarters of a disc of radius 10: ¾·π·10² = 75π mm², × 10 mm = 750π = 2356.19449… mm³.
    await page.click("#sketch-extrude");
    await until(page, () => document.querySelector("#extrude-ok")?.disabled === false, null, "Extrude's OK on");
    await page.fill("#extrude-distance", "10");
    await page.click("#extrude-ok");
    await until(page, () => Math.abs(parseFloat(document.querySelector("#volume").textContent.replace(/,/g, "")) - 750 * Math.PI) < 1e-4, null, "750π mm³");
    if (shots) await page.screenshot({ path: `${shots}/centre-arc-extruded-1280.png` });
  } finally {
    await page.context().close();
  }
});

await check("Escape drops the centre and start", async () => {
  const page = await fresh();
  try {
    await startSketch(page);
    await page.click("#sketch-tool-centre");
    await clickPlane(page, [20, 10]);
    await clickPlane(page, [30, 10]);
    await points(page, "20,10 30,10");
    await page.keyboard.press("Escape");
    await points(page, "");
  } finally {
    await page.context().close();
  }
});

await check("at 375 px with taps: the Arc menu on screen with 44 px rows, and a tap with no hover takes the shorter way round", async () => {
  const page = await fresh(375, true);
  try {
    await startSketch(page, true);
    for (const id of ["arc", "centre", "tangent"]) {
      const b = await rect(page, `#sketch-tool-${id}`);
      assert.ok(b.height >= 44 && b.left >= 0 && b.right <= 375, `#sketch-tool-${id} on screen and 44 px: ${JSON.stringify(b)}`);
    }
    await page.tap("#sketch-create");
    await page.tap("#sketch-menu-group-arc");
    const menu = await rect(page, "#sketch-arc-menu");
    assert.ok(menu.left >= 0 && menu.right <= 375 && menu.bottom <= 800, `the arcs on screen: ${JSON.stringify(menu)}`);
    for (const id of ["arc", "centre", "tangent"]) assert.ok((await rect(page, `#sketch-menu-${id}`)).height >= 44, `the ${id} row is 44 px tall`);
    if (shots) await page.screenshot({ path: `${shots}/arc-menu-375.png` });
    await page.tap("#sketch-menu-centre");
    assert.equal(await page.getAttribute("#sketch-tool-centre", "aria-pressed"), "true");
    // (20, 0) is a quarter clockwise from (30, 10) round (20, 10): the arc is kept counter-clockwise from (20, 0) to (30, 10).
    // At phone width the typed boxes sit under the last tap, their left edge pinned at 175 px (200 px in from the
    // right), so they cover (20, 0) whatever was tapped: after the centre, the radius and angle rows reach down to
    // (20, −5) too; once the start is placed only the sweep row is left, which ends above it. So each tap waits for
    // the boxes the tap before it brings (the kernel snaps a tap first, and Chrome 156 hands the tap over late), or
    // the end's tap would land on the angle box, and the end is tapped further out on the same ray, (20, −5), which
    // lands on the circle at (20, 0) exactly: (20, 10) + (0, −15)·10/15.
    await clickPlane(page, [20, 10], TOP, true);
    await until(page, () => !!document.querySelector("#typed-radius"), null, "the centre placed: the radius and angle boxes");
    await clickPlane(page, [30, 10], TOP, true);
    await until(page, () => !!document.querySelector("#typed-sweep"), null, "the start placed: the sweep box");
    await clickPlane(page, [20, -5], TOP, true);
    await points(page, "20,0 30,10 20,10");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways page scroll");
    if (shots) await page.screenshot({ path: `${shots}/centre-arc-375.png` });
  } finally {
    await page.context().close();
  }
});

assert.deepEqual(errors, [], "no page errors");
await browser.close();
await server.close();
if (failed) process.exit(1);
console.log("PASS centre arc");
