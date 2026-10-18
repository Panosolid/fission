// Browser check of the timeline's item menu (step 24f3): the default box,
// then a 10 × 10 square sketched beside it at x 50 to 60 and extruded by
// 10, so the timeline is Box, Sketch 1, Extrude 1. From the timeline bar
// (a right-click on an item with the mouse; at 375 px a tap on the item,
// then its ⋯) and from the browser's Timeline rows (a right-click, or the
// row's ⋯): Suppress and Unsuppress, Move the marker here, Delete (at once
// when nothing is built from the item, asking first when something is), an
// entry that would leave no body shown off with why, and a failed item red
// in the bar and the browser. After every edit: the bar's flags, the undo
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
    await check(`the timeline's item menu from the bar and the browser: suppress, the marker, delete, an entry off, failed red; one undo step each, pixels probed (${width} px${tap ? ", taps" : ""})`, async () => {
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

      // 4. Suppress the box: the square alone; then suppressing Extrude 1 would leave no body, so it is off and says why.
      await rowMenu("feature-1");
      await choose("suppress");
      await undoIs(page, "Suppress Feature 1 (box)");
      await until(page, (v) => document.querySelector("#volume")?.textContent === v, V, "the square is the part");
      assert.deepEqual((await state()).drawn, { box: false, square: true });
      await barMenu("feature-11");
      assert.equal(await page.isDisabled("#row-menu-suppress"), true);
      assert.equal(await page.textContent("#row-menu-suppress .delete-ask-off"), "This would leave no body, and Fission can't show a design with no body yet");
      if (shots) await page.screenshot({ path: `${shots}/entry-off-${width}.png` });
      await page.keyboard.press("Escape");
      await until(page, () => !document.getElementById("row-menu").open, null, "the menu closed by Escape");
      assert.equal(await undoTitle(page), "Undo Suppress Feature 1 (box) (Ctrl+Z)");
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
