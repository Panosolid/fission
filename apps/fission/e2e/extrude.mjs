// Browser check of Extrude (step 21d): a rectangle drawn in Sketch 1, then
// Extrude from the sketch panel: the panel offers that sketch, says it is
// closed, refuses a distance the kernel refuses (nothing recorded), and OK
// makes the part a 40 × 30 × 10 solid (12,000 mm³) as one undo step, framed
// in the 3D view, with only "Extrude by" in the parameters; a typed
// distance rebuilds it; Undo and Redo; a preset after it; an open sketch
// and no sketch at all keep OK off and say why; Escape cancels. The same at
// 375 px wide with taps. A lost sketch's extrude keeps its last shape with
// a warning (24d2), opened from a file until sketches can be edited after
// an extrude; deleting the sketch from the browser (24e4) asks first, then
// shows the same kept shape and warning, at 1280 px and at 375 px with taps.
// With the box and an extrude both shown (25c1), the toolbar's STL holds
// both bodies in one file, Body 1's row downloads the box alone (it is not
// the part), and both rows selected download both, at 1280 and 375 px.
// Screenshots go to E2E_SHOTS when set. Run with
// `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4184, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4184/";
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
  // On the grid: grid snap is off by default since SF1, and Firefox's clicks land on whole pixels, 0.1 mm off.
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0)); // ticking it scrolled the panel into view at phone width
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

/** The browser's Timeline rows, in build order, as shown. */
const timelineRows = (page) => page.$$eval('[data-node="timeline"] .tree-row', (rows) => rows.map((r) => r.textContent.trim()));

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
    assert.equal(await undoTitle(page), "Undo Extrude Sketch 1 (Ctrl+Z)");
    // The extrude is a new body (24d1): the box stays in the timeline before it.
    assert.deepEqual(await timelineRows(page), ["1. Box: 40 × 30 × 20 mm", "2. Sketch 1 on the XY plane", "3. Extrude Sketch 1 by 10 mm"]);
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
    // A preset after it is a new feature after it (24d1: nothing is replaced), keeping the sizes in the boxes
    // (the height box held the distance): a 40 × 30 × 10 box, the same 12,000 mm³ but a box, shown as the part
    // until every body is drawn (24d3). Undo takes it out again.
    await page.click('[data-op="set_part"][data-shape="box"]');
    await until(page, () => document.querySelector("#intent")?.textContent === "Box: 40 × 30 × 10 mm", null, "the box");
    assert.equal(await undoTitle(page), "Undo Change shape to Box (Ctrl+Z)");
    assert.deepEqual(await timelineRows(page), ["1. Box: 40 × 30 × 20 mm", "2. Sketch 1 on the XY plane", "3. Extrude Sketch 1 by 10 mm", "4. Box: 40 × 30 × 10 mm"]);
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

  await check("a lost sketch's extrude keeps its last shape with a warning, red on its timeline rows; with no kept shape it fails with the kernel's reason (24d2)", async () => {
    const page = await fresh();
    await drawn(page, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]]);
    await status(page, "4 lines, a closed outline.");
    await page.click("#sketch-extrude");
    await page.press("#extrude-distance", "Enter");
    await volume(page, "12,000 mm³");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    const saved = JSON.parse(await download.path().then((p) => import("node:fs").then((fs) => fs.readFileSync(p, "utf8"))));
    /** Opens `saved` with its design changed by `edit`, as a file from outside. */
    const open = async (edit) => {
      const project = structuredClone(saved);
      edit(project.workspaces.design);
      await page.setInputFiles("#open-file", { name: "kept.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
    };
    const design = saved.workspaces.design;
    const sketch = design.sketches[0];
    const extrude = design.timeline.features.find((f) => f.intent.parameters?.sketch === sketch.id);
    const lines = sketch.curves.filter((c) => c.kind === "line");
    assert.equal(lines.length, 4, "the rectangle's four lines");
    const kept = { [extrude.id]: { points: sketch.points, curves: sketch.curves } };
    const warning = () => page.evaluate(() => { const w = document.querySelector("#kept-warning"); return w.hidden ? null : w.textContent; });
    const red = () => page.$$eval(".tree-row.kept", (rows) => rows.map((r) => r.dataset.node));

    // One side deleted, the rectangle kept: the part is still 40 · 30 · 10 = 12,000 mm³, with the kernel's reason in the warning.
    await open((d) => {
      d.sketches[0].curves = sketch.curves.filter((c) => c.id !== lines[0].id);
      d.kept = kept;
    });
    await until(page, () => !document.querySelector("#kept-warning").hidden, null, "the warning");
    await volume(page, "12,000 mm³");
    assert.match(await warning(), /^Extrude 1 keeps its last shape\. Sketch 1 has no closed outline: .*not joined/);
    assert.equal(await page.textContent("#error"), "");
    assert.deepEqual((await red()).sort(), [extrude.id, sketch.id].sort(), "the extrude's and the sketch's timeline rows are red");
    if (shots) await page.screenshot({ path: `${shots}/extrude-kept-1280.png` });
    // A distance typed while lost: the kept rectangle by 25 mm, 1200 · 25 = 30,000 mm³, still warned.
    await page.fill("#height", "25");
    await volume(page, "30,000 mm³");
    assert.match(await warning(), /^Extrude 1 keeps its last shape\./);

    // The sketch deleted outright: the same part, the warning says so.
    await open((d) => {
      d.timeline.features = d.timeline.features.filter((f) => f.id !== sketch.id);
      d.sketches = [];
      d.kept = kept;
    });
    await until(page, (w) => document.querySelector("#kept-warning").textContent === w, "Extrude 1 keeps its last shape. Sketch 1 was deleted.", "the deleted warning");
    await volume(page, "12,000 mm³");
    assert.deepEqual(await red(), [extrude.id], "only the extrude's row: the sketch has none");

    // The same side deleted with nothing kept (the shape was never closed when it was lost): no part, the kernel's reason, no warning.
    await open((d) => (d.sketches[0].curves = sketch.curves.filter((c) => c.id !== lines[0].id)));
    await until(page, () => /^Sketch 1 has no closed outline: .*not joined/.test(document.querySelector("#error").textContent), null, "the reason");
    assert.equal(await warning(), null);
    assert.deepEqual(await red(), []);

    // The sketch whole again: built from it, nothing kept, no warning.
    await open(() => {});
    await volume(page, "12,000 mm³");
    await until(page, () => document.querySelector("#error").textContent === "", null, "no error");
    assert.equal(await warning(), null);
    assert.deepEqual(await red(), []);
    await page.context().close();
  });

  for (const { width, tap } of [{ width: 1280, tap: false }, { width: 375, tap: true }]) {
    await check(`deleting a sketch from the browser: an unused one goes at once; a used one asks first, Cancel and Escape change nothing, then its extrude keeps its last shape with the warning, one undo step (24e4, ${width} px${tap ? ", taps" : ""})`, async () => {
      const page = await fresh(width, tap);
      const press = (sel) => (tap ? page.tap(sel) : page.click(sel));
      const top = () => page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
      /** The browser drawer open at phone width (its toggle), every group unfolded. */
      const browserOpen = async () => {
        if ((await page.isVisible("#browser-toggle")) && (await page.getAttribute("#browser-toggle", "aria-expanded")) !== "true") await press("#browser-toggle");
        await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
      };
      const sketchRows = () => page.$$eval('#browser [data-node^="sketches/"].tree-row', (rows) => rows.map((r) => `${r.dataset.node} ${r.textContent.trim()}`));
      const warning = () => page.evaluate(() => { const w = document.querySelector("#kept-warning"); return w.hidden ? null : w.textContent; });
      const red = () => page.$$eval(".tree-row.kept", (rows) => rows.map((r) => r.dataset.node));
      const open = () => page.evaluate(() => ({ menu: document.getElementById("row-menu").open, ask: document.getElementById("delete-ask").open }));
      /** The row menu for a sketch row: a right-click on the row with a mouse, its ⋯ button with taps. */
      const menu = async (node) => {
        await browserOpen();
        const row = page.locator(`#browser .tree-row[data-node="${node}"]`);
        await row.scrollIntoViewIfNeeded();
        if (tap) await page.tap(`#browser [data-more="${node}"]`);
        else await row.click({ button: "right" });
        await until(page, () => document.getElementById("row-menu").open, null, "the row menu");
      };
      const state = async () => ({ volume: await page.textContent("#volume"), sketches: await sketchRows(), warning: await warning(), red: await red(), undo: await undoTitle(page), open: await open() });

      // Sketch 1 (sketch-2): a 40 × 30 rectangle, extruded by the default 10: 40 · 30 · 10 = 12,000 mm³ (Extrude 1, feature-11).
      await drawn(page, [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]], tap);
      await status(page, "4 lines, a closed outline.");
      await press("#sketch-extrude");
      await page.press("#extrude-distance", "Enter");
      await volume(page, "12,000 mm³");
      // Sketch 2 (sketch-12), left empty: nothing is built from it.
      await top();
      await press("#create-sketch");
      await press("#sketch-plane-XY");
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
      await top();
      await press("#finish-sketch");
      await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "finished");
      await browserOpen();
      assert.deepEqual(await sketchRows(), ["sketches/sketch-2 Sketch 1", "sketches/sketch-12 Sketch 2"]);

      // The unused sketch: Delete in its menu takes it at once, no box, one undo step.
      await menu("sketches/sketch-12");
      assert.equal(await page.getAttribute("#row-menu-delete", "aria-label"), "Delete Sketch 2");
      await press("#row-menu-delete");
      await until(page, () => !document.querySelector('#browser [data-node="sketches/sketch-12"]'), null, "Sketch 2 gone");
      assert.deepEqual(await open(), { menu: false, ask: false }, "nothing asked");
      assert.equal(await undoTitle(page), "Undo Delete Sketch 2 (Ctrl+Z)");
      const before = await state();
      assert.deepEqual(before, { volume: "12,000 mm³", sketches: ["sketches/sketch-2 Sketch 1"], warning: null, red: [], undo: "Undo Delete Sketch 2 (Ctrl+Z)", open: { menu: false, ask: false } });

      // The used sketch asks first, with what happens to Extrude 1.
      const ask = async () => {
        await menu("sketches/sketch-2");
        await press("#row-menu-delete");
        await until(page, () => document.getElementById("delete-ask").open, null, "the box");
      };
      await ask();
      assert.equal(await page.textContent("#delete-ask-heading"), "Delete Sketch 1?");
      assert.equal(await page.textContent("#delete-ask-words"), "Extrude 1 is built from Sketch 1. If you delete it, Extrude 1 keeps its last shape and shows a warning. Undo brings Sketch 1 back.");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "delete-ask-cancel", "Cancel has the focus");
      const box = await page.locator("#delete-ask").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `the box fits the screen: ${box.x} to ${box.x + box.width} of ${width}`);
      if (shots) await page.screenshot({ path: `${shots}/delete-ask-${width}.png` });
      // Cancel: nothing changes.
      await press("#delete-ask-cancel");
      assert.deepEqual(await state(), before);
      // Escape, with the rectangle tool's key pressed in the box first: nothing changes, no tool chosen behind it.
      await ask();
      await page.keyboard.press("r");
      await page.keyboard.press("Escape");
      await until(page, () => !document.getElementById("delete-ask").open, null, "closed by Escape");
      assert.deepEqual(await state(), before);
      assert.equal(await data(page, "sketching"), "false");
      // Escape in the menu closes only the menu.
      await menu("sketches/sketch-2");
      await page.keyboard.press("Escape");
      await until(page, () => !document.getElementById("row-menu").open, null, "the menu closed by Escape");
      assert.deepEqual(await state(), before);

      // Confirmed: Sketch 1 gone, Extrude 1 keeps the rectangle (still 12,000 mm³) with the warning, its timeline row red.
      await ask();
      await press("#delete-ask-confirm");
      await until(page, (w) => document.querySelector("#kept-warning").textContent === w && !document.querySelector("#kept-warning").hidden, "Extrude 1 keeps its last shape. Sketch 1 was deleted.", "the deleted warning");
      await volume(page, "12,000 mm³");
      await browserOpen();
      const after = await state();
      assert.deepEqual(after, { volume: "12,000 mm³", sketches: [], warning: "Extrude 1 keeps its last shape. Sketch 1 was deleted.", red: ["feature-11"], undo: "Undo Delete Sketch 1 (Ctrl+Z)", open: { menu: false, ask: false } });
      assert.equal(await page.textContent("#error"), "");
      await top();
      await page.locator("#kept-warning").scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: `${shots}/delete-kept-${width}.png`, fullPage: tap });
      if (width === 375) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");

      // One undo step: Undo brings Sketch 1 back and the warning goes; Redo deletes it again, warned.
      await top();
      await press("#undo");
      await until(page, () => !!document.querySelector('#browser [data-node="sketches/sketch-2"]') && document.querySelector("#kept-warning").hidden, null, "undone");
      await volume(page, "12,000 mm³");
      assert.deepEqual(await state(), before);
      await press("#redo");
      await until(page, () => !document.querySelector("#kept-warning").hidden, null, "redone");
      await browserOpen();
      assert.deepEqual(await state(), after);
      await page.context().close();
    });
  }

  // Two bodies (25c1): the default box and an extrude over it. Every corner
  // is a whole number of mm, exact in single precision, so the volumes are
  // exact. At 1280 px a 40 × 30 rectangle by 10: 12 triangles (6 faces of
  // 2), 12,000 mm³. At 375 px a right triangle 30 × 20 by 10 (on screen
  // there, as above): 1 triangle per cap and 2 per side, 2 + 6 = 8;
  // ½ · 30 · 20 · 10 = 3,000 mm³. The box: 12 triangles, 24,000 mm³.
  for (const { width, tap, pts, tris, vol, volText } of [
    { width: 1280, tap: false, pts: [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]], tris: 12, vol: 12000, volText: "12,000 mm³" },
    { width: 375, tap: true, pts: [[0, 0], [30, 0], [30, 20], [0, 0]], tris: 8, vol: 3000, volText: "3,000 mm³" },
  ]) {
    await check(`two bodies: the toolbar's STL holds both in one file, Body 1 downloads alone, both selected download both (25c1, ${width} px${tap ? ", taps" : ""})`, async () => {
      const page = await fresh(width, tap);
      const press = (sel) => (tap ? page.tap(sel) : page.click(sel));
      await drawn(page, pts, tap);
      await statusStarts(page, `${pts.length - 1} lines, a closed outline`);
      await press("#sketch-extrude");
      await press("#extrude-ok");
      await volume(page, volText);
      /** Presses a button that saves an STL; its name, triangle count and volume (Σ a·(b×c)/6). */
      const stl = async (sel) => {
        const [dl] = await Promise.all([page.waitForEvent("download"), press(sel)]);
        const bytes = readFileSync(await dl.path());
        const n = bytes.readUInt32LE(80);
        assert.equal(bytes.length, 84 + 50 * n, "84 bytes then 50 for each triangle");
        let six = 0;
        for (let t = 0; t < n; t++) {
          const p = (k, i) => bytes.readFloatLE(84 + 50 * t + 12 + 12 * k + 4 * i);
          six += p(0, 0) * (p(1, 1) * p(2, 2) - p(1, 2) * p(2, 1)) + p(0, 1) * (p(1, 2) * p(2, 0) - p(1, 0) * p(2, 2)) + p(0, 2) * (p(1, 0) * p(2, 1) - p(1, 1) * p(2, 0));
        }
        return [dl.suggestedFilename(), n, six / 6];
      };
      assert.deepEqual(await stl("#toolbar [data-op=export_stl]"), ["fission-2-bodies.stl", 12 + tris, 24000 + vol]);
      // The browser (a drawer at phone width): Body 1's row, then Shift for Body 2 as well.
      const openBrowser = async () => {
        if (await page.isVisible("#browser-toggle")) {
          if ((await page.getAttribute("#browser-toggle", "aria-expanded")) !== "true") await press("#browser-toggle");
        }
        await page.evaluate(() => document.querySelector('#browser [data-node="bodies"]')?.closest("details")?.setAttribute("open", ""));
      };
      await openBrowser();
      await press('#browser [data-node="body-1"]');
      await until(page, () => document.body.dataset.selection === "body:feature-1", null, "Body 1 selected");
      const verb = "#selection-actions [data-action='design.download-stl']";
      await openBrowser();
      assert.deepEqual(await stl(verb), ["fission-box.stl", 12, 24000]);
      await openBrowser();
      await page.click('#browser [data-node="body-2"]', { modifiers: ["Shift"] });
      await until(page, () => document.body.dataset.selection?.split(" ").length === 2, null, "both bodies selected");
      assert.deepEqual(await stl(verb), ["fission-2-bodies.stl", 12 + tris, 24000 + vol]);
      assert.equal(await page.textContent("#action-note"), "");
      if (shots) await page.screenshot({ path: `${shots}/two-body-stl-${width}.png`, fullPage: true });
      if (width === 375) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
      await page.context().close();
    });
  }

  await check("no errors in the console", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} extrude check(s) failed`);
  process.exit(1);
}
