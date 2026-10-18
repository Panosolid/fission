// Browser check of the timeline's item menu (step 24f3): the default box,
// then a 10 × 10 square sketched beside it at x 50 to 60 and extruded by
// 10, so the timeline is Box, Sketch 1, Extrude 1. From the timeline bar
// (a right-click on an item with the mouse; at 375 px a tap on the item,
// then its ⋯) and from the browser's Timeline rows (a right-click, or the
// row's ⋯): Suppress and Unsuppress, Move the marker here, Delete (at once
// when nothing is built from the item, asking first when something is), a
// failed item red in the bar and the browser, and (24f4) a design with no
// body: both solids suppressed, or every item deleted, shown as an empty
// view with the panel saying so, a width typed then adding a new box at the
// marker. After every edit: the bar's flags, the undo
// step's name, and pixel probes on both bodies' top faces (a suppressed or
// rolled-back body's pixels show the background, its return shows it
// again); one Undo and one Redo for each. Pixels are probed through the
// app's own camera (`?test-hooks`), projected here by the pinhole sums of
// navigation.mjs, since a body leaving may refit the view. Screenshots go
// to E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4211, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4211/?test-hooks";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => assert.fail(`${what}: timed out`));

async function fresh(width, touch) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url + "#design");
  await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box");
  return page;
}

// The pinhole camera, as navigation.mjs works it: forward = unit(target −
// position), right = unit(forward × up), the screen's up = right × forward;
// a 45° vertical field of view.
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const T = Math.tan(Math.PI / 8);
/** Where model point `p` is on the canvas, as a fraction of its width and height from the top left. */
function onCanvas(cam, box, p) {
  const forward = unit(sub(cam.target, cam.position));
  const right = unit(cross(forward, cam.up));
  const up = cross(right, forward);
  const v = sub(p, cam.position);
  const aspect = box.width / box.height;
  const nx = dot(v, right) / (dot(v, forward) * T * aspect);
  const ny = dot(v, up) / (dot(v, forward) * T);
  return [(nx + 1) / 2, (1 - ny) / 2];
}

/** The canvas's colour at each model point, through the camera the app has now (a frame or two after it settles), after its top left corner's. */
async function colours(page, points) {
  await page.waitForTimeout(250);
  const cam = await page.evaluate(() => window.fissionTest.camera());
  const box = await page.locator("#viewport canvas").boundingBox();
  const at = [[0.01, 0.01], ...points.map((p) => onCanvas(cam, box, p))];
  for (const [fx, fy] of at) assert.ok(fx > 0 && fx < 1 && fy > 0 && fy < 1, `a probe off the canvas: ${fx}, ${fy}`);
  return page.evaluate((spots) => {
    const src = document.querySelector("#viewport canvas");
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    return spots.map(([fx, fy]) => Array.from(ctx.getImageData(Math.floor(src.width * fx), Math.floor(src.height * fy), 1, 1).data.slice(0, 3)));
  }, at);
}

// Where the square goes, as in bodies.mjs: beside the box at 1280 px (x 50
// to 60, extruded 10: 10 · 10 · 10 = 1,000 mm³); behind it at 375 px, where
// the view is narrow and tall, extruded 30 so its top shows over the box
// (10 · 10 · 30 = 3,000 mm³). The top faces' middles: the box's (20, 15,
// 20); the square's (55, 5, 10) or (15, 45, 30). "Drawn" is: not the
// background, sampled in the canvas's top left corner, which the framed
// bodies never reach (a model point under the floor can be behind the box).
const LAYOUTS = {
  1280: { corners: [[50, 0], [60, 10]], distance: 10, volume: "1,000 mm³", top: [55, 5, 10] },
  375: { corners: [[10, 40], [20, 50]], distance: 30, volume: "3,000 mm³", top: [15, 45, 30] },
};
const BOX_TOP = [20, 15, 20];
const differs = (a, b) => a.some((x, i) => Math.abs(x - b[i]) > 12);
async function drawn(page, layout) {
  const [empty, box, square] = await colours(page, [BOX_TOP, layout.top]);
  return { box: differs(box, empty), square: differs(square, empty) };
}

const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));
const undoTitle = (page) => page.evaluate(() => document.getElementById("undo").title);
const undoIs = (page, step) => until(page, (w) => document.getElementById("undo").title === w, `Undo ${step} (Ctrl+Z)`, `the undo step "${step}"`);

/** The bar's items: id and flags, with the marker as "|" where it stands. */
const bar = (page) =>
  page.$$eval("#timeline .timeline-bar > li", (lis) =>
    lis
      .filter((li) => !li.classList.contains("timeline-bar-more-slot"))
      .map((li) => (li.classList.contains("timeline-bar-marker") ? "|" : [li.dataset.item, li.dataset.suppressed && "suppressed", li.dataset.rolledBack && "rolled back", li.dataset.failed && "failed"].filter(Boolean).join(" "))),
  );
/** The browser's Timeline rows marked red as failed. */
const redRows = (page) => page.$$eval('#browser [data-node="timeline"] .tree-row.timeline-menu-failed', (rows) => rows.map((r) => r.dataset.node));

/** Sketches the layout's 10 × 10 square by the rectangle tool and extrudes it: Sketch 1 (sketch-2) and Extrude 1 (feature-11). */
async function addSquare(page, tap, layout) {
  await press(page, "#create-sketch", tap);
  await press(page, "#sketch-plane-XY", tap);
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
  await press(page, "#sketch-tool-rectangle", tap);
  for (const p of layout.corners) await clickPlane(page, p, TOP, tap);
  await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "the square closed");
  await press(page, "#sketch-extrude", tap);
  await page.fill("#extrude-distance", String(layout.distance));
  await press(page, "#extrude-ok", tap);
  // The panel shows the last body.
  await until(page, (v) => document.querySelector("#volume")?.textContent === v, layout.volume, "the square's body");
  await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
  await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
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
  for (const { width, tap } of [{ width: 1280, tap: false }, { width: 375, tap: true }]) {
    await check(`the timeline's item menu from the bar and the browser: suppress, the marker, delete, failed red, no body (24f4); one undo step each, pixels probed (${width} px${tap ? ", taps" : ""})`, async () => {
      const page = await fresh(width, tap);
      const layout = LAYOUTS[width];
      const V = layout.volume;
      await addSquare(page, tap, layout);
      const menuOpen = () => page.evaluate(() => document.getElementById("row-menu").open);
      /** Item `id`'s menu from the bar: a right-click, or a tap on the item and then its ⋯. */
      const barMenu = async (id) => {
        const item = page.locator(`#timeline [data-item="${id}"]`);
        await item.scrollIntoViewIfNeeded();
        if (tap) {
          await item.tap();
          await page.tap(`#timeline [data-more="${id}"]`);
        } else await item.click({ button: "right" });
        await until(page, () => document.getElementById("row-menu").open, null, `${id}'s menu from the bar`);
      };
      /** The browser open (a drawer at phone width), every group unfolded. */
      const browserOpen = async () => {
        if ((await page.isVisible("#browser-toggle")) && (await page.getAttribute("#browser-toggle", "aria-expanded")) !== "true") await press(page, "#browser-toggle", tap);
        await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
      };
      const browserClosed = async () => {
        if ((await page.isVisible("#browser-toggle")) && (await page.getAttribute("#browser-toggle", "aria-expanded")) === "true") await press(page, "#browser-toggle", tap);
      };
      /** Item `id`'s menu from its row in the browser's Timeline group: a right-click, or the row's ⋯. */
      const rowMenu = async (id) => {
        await browserOpen();
        const row = page.locator(`#browser [data-node="timeline"] .tree-row[data-node="${id}"]`);
        await row.scrollIntoViewIfNeeded();
        if (tap) await page.tap(`#browser [data-node="timeline"] [data-more="${id}"]`);
        else await row.click({ button: "right" });
        await until(page, () => document.getElementById("row-menu").open, null, `${id}'s menu from the browser`);
      };
      /** Chooses an entry; the browser drawer is closed after it unless a box is to ask first. */
      const choose = async (action, asks = false) => {
        await press(page, `#row-menu-${action}`, tap);
        await until(page, () => !document.getElementById("row-menu").open, null, "the menu closed");
        if (!asks) await browserClosed();
      };
      const state = async () => ({ bar: await bar(page), drawn: await drawn(page, layout), volume: await page.textContent("#volume"), red: await redRows(page) });
      const undo = async () => press(page, "#undo", tap);
      const redo = async () => press(page, "#redo", tap);

      // Everything built: the marker after Extrude 1; both bodies drawn.
      const all = { bar: ["feature-1", "sketch-2", "feature-11", "|"], drawn: { box: true, square: true }, volume: V, red: [] };
      assert.deepEqual(await state(), all);

      // 1. Suppress Extrude 1 from the bar: the square goes, the box stays and is the part (24,000 mm³).
      await barMenu("feature-11");
      assert.deepEqual(
        await page.$$eval("#row-menu button", (bs) => bs.map((b) => [b.id, b.disabled, b.getAttribute("aria-label")])),
        [
          ["row-menu-marker", true, "Move the marker to just after Extrude 1"],
          ["row-menu-suppress", false, "Suppress Extrude 1"],
          ["row-menu-delete", false, "Delete Extrude 1"],
        ],
      );
      assert.equal(await page.textContent("#row-menu-marker .delete-ask-off"), "The marker is already here");
      const menuBox = await page.locator("#row-menu").boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0 && menuBox.y + menuBox.height <= 800, `the menu fits the screen: ${JSON.stringify(menuBox)}`);
      if (shots) await page.screenshot({ path: `${shots}/bar-menu-${width}.png` });
      await choose("suppress");
      await undoIs(page, "Suppress Extrude 1");
      await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box is the part");
      const suppressed = { bar: ["feature-1", "sketch-2", "feature-11 suppressed", "|"], drawn: { box: true, square: false }, volume: "24,000 mm³", red: [] };
      assert.deepEqual(await state(), suppressed);
      // One undo step: Undo brings it back, Redo takes it again.
      await undo();
      await undoIs(page, "Extrude Sketch 1");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "undone");
      assert.deepEqual(await state(), all);
      await redo();
      await undoIs(page, "Suppress Extrude 1");
      assert.deepEqual(await state(), suppressed);
      // Unsuppress from the browser's Timeline row.
      await rowMenu("feature-11");
      assert.equal(await page.textContent("#row-menu-unsuppress"), "Unsuppress");
      await choose("unsuppress");
      await undoIs(page, "Unsuppress Extrude 1");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "unsuppressed");
      assert.deepEqual(await state(), all);

      // 2. Move the marker here on Sketch 1, from the bar: Extrude 1 after it is rolled back, the square not drawn.
      await barMenu("sketch-2");
      await choose("marker");
      await undoIs(page, "Move the rollback marker");
      await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "rolled back");
      const rolled = { bar: ["feature-1", "sketch-2", "|", "feature-11 rolled back"], drawn: { box: true, square: false }, volume: "24,000 mm³", red: [] };
      assert.deepEqual(await state(), rolled);
      await undo();
      await undoIs(page, "Unsuppress Extrude 1");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "undone");
      assert.deepEqual(await state(), all);
      await redo();
      await undoIs(page, "Move the rollback marker");
      assert.deepEqual(await state(), rolled);
      // And back to the end from Extrude 1's row in the browser.
      await rowMenu("feature-11");
      await choose("marker");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "everything built");
      assert.deepEqual(await state(), all);

      // 3. Suppress Sketch 1: Extrude 1, built from it, fails: red on the bar and in the browser, its body gone.
      await barMenu("sketch-2");
      await choose("suppress");
      await undoIs(page, "Suppress Sketch 1");
      await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "the box is the part");
      await browserOpen();
      const failing = { bar: ["feature-1", "sketch-2 suppressed", "feature-11 failed", "|"], drawn: { box: true, square: false }, volume: "24,000 mm³", red: ["feature-11"] };
      assert.deepEqual(await state(), failing);
      assert.equal(await page.getAttribute('#timeline [data-item="feature-11"]', "title"), `3. Extrude Sketch 1 by ${layout.distance} mm (failed)`);
      if (shots) await page.screenshot({ path: `${shots}/failed-red-${width}.png` });
      await browserClosed();
      await undo();
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "undone");
      assert.deepEqual(await state(), all);

      // 4. Suppress the box: the square alone; then suppressing Extrude 1 leaves no body (24f4): on, and the view is empty.
      await rowMenu("feature-1");
      await choose("suppress");
      await undoIs(page, "Suppress Feature 1 (box)");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "the square is the part");
      const squareOnly = { bar: ["feature-1 suppressed", "sketch-2", "feature-11", "|"], drawn: { box: false, square: true }, volume: V, red: [] };
      assert.deepEqual(await state(), squareOnly);
      await barMenu("feature-11");
      assert.equal(await page.isDisabled("#row-menu-suppress"), false);
      assert.equal(await page.locator("#row-menu-suppress .delete-ask-off").count(), 0, "no reason it is off");
      await choose("suppress");
      await undoIs(page, "Suppress Extrude 1");
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing on screen");
      const noBody = { bar: ["feature-1 suppressed", "sketch-2", "feature-11 suppressed", "|"], drawn: { box: false, square: false }, volume: "—", red: [] };
      assert.deepEqual(await state(), noBody);
      // The panel says there is no body, how to add one, and shows no error; no shape is pressed.
      assert.equal(await page.textContent("#intent"), "No body: nothing in the timeline builds");
      assert.equal(await page.isVisible("#no-part"), true);
      assert.equal(await page.textContent("#error"), "");
      assert.deepEqual(await page.$$eval('#toolbar [data-op="set_part"][aria-pressed="true"]', (bs) => bs.length), 0);
      if (shots) await page.screenshot({ path: `${shots}/no-body-${width}.png` });
      // The toolbar's STL has nothing to save, and says why.
      if (await page.isVisible('#toolbar [data-op="export_stl"]')) {
        await press(page, '#toolbar [data-op="export_stl"]', tap);
        await until(page, () => document.querySelector("#action-note")?.textContent === "There is no body to download: nothing in the timeline builds.", null, "STL with no body");
      }
      // One undo step each way.
      await undo();
      await undoIs(page, "Suppress Feature 1 (box)");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "the square back");
      assert.deepEqual(await state(), squareOnly);
      assert.equal(await page.isVisible("#no-part"), false);
      await redo();
      await undoIs(page, "Suppress Extrude 1");
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing on screen again");
      assert.deepEqual(await state(), noBody);
      // A width typed adds a new box at the marker (the end): feature-12, 45 × 30 × 20 = 27,000 mm³, drawn where the box was.
      await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
      await page.fill("#width", "45");
      await until(page, () => document.querySelector("#volume")?.textContent === "27,000 mm³", null, "the new box");
      await undoIs(page, "Change width");
      assert.deepEqual(await state(), { bar: ["feature-1 suppressed", "sketch-2", "feature-11 suppressed", "feature-12", "|"], drawn: { box: true, square: false }, volume: "27,000 mm³", red: [] });
      // The new box is framed (a new shape), so the camera stays there once it is undone: the box's top may now
      // sit over a grid line, not the plain background, so its pixel is checked to have left the box's colour.
      const [, boxColour] = await colours(page, [BOX_TOP]);
      await undo();
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "the new box undone");
      const { drawn: _, ...rest } = await state();
      const { drawn: __, ...want } = noBody;
      assert.deepEqual(rest, want);
      const [, boxNow, squareNow] = await colours(page, [BOX_TOP, layout.top]);
      assert.ok(differs(boxNow, boxColour), `the box's pixel ${boxNow} is still its colour ${boxColour}`);
      // A top face is lit the same whichever body it is, so the square's spot must not show it either.
      assert.ok(differs(squareNow, boxColour), `the square's pixel ${squareNow} shows a top face`);
      await undo();
      await undo();
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "undone");
      assert.deepEqual(await state(), all);

      // 5. Delete Extrude 1 from the bar: nothing is built from it, so it goes at once, one undo step.
      await barMenu("feature-11");
      await choose("delete");
      await undoIs(page, "Delete Extrude 1");
      await until(page, () => document.querySelector("#volume")?.textContent === "24,000 mm³", null, "deleted");
      assert.equal(await page.evaluate(() => document.getElementById("delete-ask").open), false, "nothing asked");
      assert.deepEqual(await state(), { bar: ["feature-1", "sketch-2", "|"], drawn: { box: true, square: false }, volume: "24,000 mm³", red: [] });
      await undo();
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "undone");
      assert.deepEqual(await state(), all);

      // 6. Delete Sketch 1 from its Timeline row: Extrude 1 is built from it, so the box asks first; Cancel changes nothing.
      const step = await undoTitle(page);
      await rowMenu("sketch-2");
      await choose("delete", true);
      await until(page, () => document.getElementById("delete-ask").open, null, "the box asks");
      assert.equal(await page.textContent("#delete-ask-heading"), "Delete Sketch 1?");
      await press(page, "#delete-ask-cancel", tap);
      await browserClosed();
      assert.deepEqual(await state(), all);
      assert.equal(await undoTitle(page), step, "nothing recorded");
      assert.equal(await menuOpen(), false);

      // 7. Every item deleted, last first (24f4): an empty timeline and an empty view; three Undos give everything back.
      for (const [id, step] of [["feature-11", "Delete Extrude 1"], ["sketch-2", "Delete Sketch 1"], ["feature-1", "Delete Feature 1 (box)"]]) {
        await barMenu(id);
        await choose("delete");
        await undoIs(page, step);
      }
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing left");
      assert.deepEqual(await state(), { bar: ["|"], drawn: { box: false, square: false }, volume: "—", red: [] });
      if (shots) await page.screenshot({ path: `${shots}/emptied-${width}.png` });
      for (let k = 0; k < 3; k++) await undo();
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "all back");
      assert.deepEqual(await state(), all);

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
  console.log(`${failed} timeline check(s) failed`);
  process.exit(1);
}
