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
// marker. 24f5: the marker moved by the four playback buttons, dragged with
// the mouse, and tapped between items at 375 px; rolled-back items greyed
// in the bar and the browser; refused while a sketch it would roll back is
// edited. After every edit: the bar's flags, the undo
// step's name, and pixel probes on both bodies' top faces (a suppressed or
// rolled-back body's pixels show the background, its return shows it
// again); one Undo and one Redo for each. Pixels are probed through the
// app's own camera (`?test-hooks`), projected here by the pinhole sums of
// navigation.mjs, since a body leaving may refit the view. Screenshots go
// to E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { browserName, launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4211, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4211/?test-hooks";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => assert.fail(`${what}: timed out`));

// TEMPORARY (24f6, Firefox at 375 px): the pointer, mouse and touch events a failing drag hold saw, added to its message.
const EVENTS = ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture", "mousedown", "mousemove", "mouseup", "touchstart", "touchmove", "touchend", "touchcancel", "dragstart", "selectstart", "click"];
async function heard(page, fn) {
  await page.evaluate((types) => {
    window.__heard = [];
    if (window.__listening) return;
    window.__listening = true;
    for (const t of types)
      document.addEventListener(t, (e) => window.__heard.push(`${t}/${e.pointerType ?? "-"}/${e.buttons ?? "-"}/${e.defaultPrevented ? "p" : ""}/${String(e.target?.className || e.target?.nodeName).slice(0, 24)}@${Math.round(e.clientX ?? -1)}`), { capture: true });
  }, EVENTS);
  try {
    return await fn();
  } catch (e) {
    const log = await page.evaluate(() => window.__heard.join(" ")).catch(() => "?");
    e.message += `\n  events: ${log}\n  touch: ${await page.evaluate(() => [navigator.maxTouchPoints, "ontouchstart" in window, matchMedia("(pointer: coarse)").matches].join(","))}`;
    throw e;
  }
}

async function fresh(width, touch) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  const page = await context.newPage();
  // A fresh store once per tab: a reload (step 8 below) keeps what the app saved.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("store-cleared")) return;
    indexedDB.deleteDatabase("fission");
    sessionStorage.setItem("store-cleared", "1");
  });
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

/**
 * Clicks (or taps) model point (x, y, 0) where the app's own camera puts it,
 * after checking nothing but the canvas is there. For a view clickPlane's
 * fixed one can't know: Look at on an empty design centres on the origin.
 */
async function clickModel(page, [x, y], tap) {
  const cam = await page.evaluate(() => window.fissionTest.camera());
  const box = await page.locator("#viewport canvas").boundingBox();
  const [fx, fy] = onCanvas(cam, box, [x, y, 0]);
  const p = { x: box.x + fx * box.width, y: box.y + fy * box.height };
  const on = await page.evaluate(([px, py]) => {
    const e = document.elementFromPoint(px, py);
    return e?.tagName === "CANVAS" && e.closest("#viewport") ? "canvas" : e ? e.id || e.className || e.tagName : "nothing";
  }, [p.x, p.y]);
  assert.equal(on, "canvas", `(${x}, ${y}) is under ${on} on screen, not the canvas`);
  if (tap) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}

/**
 * Sketches the layout's 10 × 10 square by the rectangle tool and extrudes it: Sketch 1 (sketch-2) and Extrude 1
 * (feature-11) on the starting box's design. `live`: click through the app's camera (clickModel), not clickPlane's.
 */
async function addSquare(page, tap, layout, live = false) {
  await press(page, "#create-sketch", tap);
  await press(page, "#sketch-plane-XY", tap);
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
  await press(page, "#sketch-tool-rectangle", tap);
  for (const p of layout.corners) await (live ? clickModel(page, p, tap) : clickPlane(page, p, TOP, tap));
  await until(page, (w) => document.querySelector("#viewport").dataset.sketchPoints?.startsWith(w), layout.corners[0].join(","), "the square's first corner where it was clicked");
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

      // 8. Emptied again (three Redos), the page reloaded: the empty design comes back from the browser's store as it
      // was, not refused (until 24f4 a design with no body could not be opened). Then a sketch drawn on it and
      // extruded is the one body, framed; one Undo empties it again.
      for (let k = 0; k < 3; k++) await redo();
      await undoIs(page, "Delete Feature 1 (box)");
      await until(page, () => document.querySelector("#save-status")?.dataset.state === "saved", null, "the empty design saved");
      await page.reload();
      await until(page, () => document.querySelector("#viewport")?.dataset.shape === "none", null, "the empty design reopened");
      assert.deepEqual(await bar(page), ["|"]);
      // Opened, not replaced by a new project with a message (the app's way with a stored project it can't read).
      assert.equal(await page.textContent("#file-status"), "");
      assert.equal(await page.textContent("#intent"), "No body: nothing in the timeline builds");
      assert.equal(await page.textContent("#volume"), "—");
      assert.equal(await page.textContent("#error"), "");
      assert.equal(await undoTitle(page), "Nothing to undo", "a reload starts a fresh history");
      const fits = Number(await page.evaluate(() => document.querySelector("#viewport").dataset.fits ?? 0));
      // Ids go on from the saved counter (12): Sketch 1 is sketch-12, its four corners and four lines 13 to 20, Extrude 1 feature-21.
      await addSquare(page, tap, layout, true);
      await undoIs(page, "Extrude Sketch 1");
      assert.deepEqual(await bar(page), ["sketch-12", "feature-21", "|"]);
      assert.equal(await page.textContent("#volume"), V);
      assert.deepEqual(await redRows(page), []);
      // Framed alone, so the box's old spot may be off the canvas: only the square's top is probed.
      const [empty, squareTop] = await colours(page, [layout.top]);
      assert.ok(differs(squareTop, empty), `the square's top ${squareTop} shows the background ${empty}`);
      assert.equal(await page.textContent("#intent"), `Extrude Sketch 1 by ${layout.distance} mm`);
      assert.ok(Number(await page.evaluate(() => document.querySelector("#viewport").dataset.fits)) > fits, "the new body is framed");
      await undo();
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "the extrude undone");
      assert.deepEqual(await bar(page), ["sketch-12", "|"]);
      assert.equal(await page.textContent("#volume"), "—");

      if (width === 375) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
      await page.context().close();
    });

    await check(`the rollback marker (24f5): the four buttons, dragged with the mouse${tap ? ", a tap between items" : ""}; rolled-back items greyed in the bar and the browser; one undo step each, pixels probed (${width} px)`, async () => {
      const page = await fresh(width, tap);
      const layout = LAYOUTS[width];
      const V = layout.volume;
      await addSquare(page, tap, layout);
      const greyRows = () => page.$$eval('#browser [data-node="timeline"] .tree-row.timeline-menu-rolled-back', (rows) => rows.map((r) => r.dataset.node));
      const state = async () => ({ bar: await bar(page), drawn: await drawn(page, layout), volume: await page.textContent("#volume"), grey: await greyRows() });
      /** Each button: [which, off ("true") or on (null)], in the bar's order. */
      const buttons = () => page.$$eval("#timeline .timeline-marker-buttons [data-button]", (bs) => bs.map((b) => [b.dataset.button, b.getAttribute("aria-disabled")]));
      const button = (b) => press(page, `#timeline [data-button="${b}"]`, tap);
      const undo = async () => press(page, "#undo", tap);
      const redo = async () => press(page, "#redo", tap);
      const MOVE = "Move the rollback marker";
      const settled = (want) => until(page, (w) => document.querySelector("#volume")?.textContent === w, want, `the panel showing ${want}`);

      // The states the marker gives, worked out from the timeline Box, Sketch 1, Extrude 1: after Extrude 1 (place 3)
      // everything is built; after Sketch 1 (2) the square is not; after the box (1) neither is the sketch; at the start
      // (0) nothing is built, the view empty. Rolled-back items are greyed in the bar and their browser rows.
      const all = { bar: ["feature-1", "sketch-2", "feature-11", "|"], drawn: { box: true, square: true }, volume: V, grey: [] };
      const atSketch = { bar: ["feature-1", "sketch-2", "|", "feature-11 rolled back"], drawn: { box: true, square: false }, volume: "24,000 mm³", grey: ["feature-11"] };
      const atBox = { bar: ["feature-1", "|", "sketch-2 rolled back", "feature-11 rolled back"], drawn: { box: true, square: false }, volume: "24,000 mm³", grey: ["sketch-2", "feature-11"] };
      const atStart = { bar: ["|", "feature-1 rolled back", "sketch-2 rolled back", "feature-11 rolled back"], drawn: { box: false, square: false }, volume: "—", grey: ["feature-1", "sketch-2", "feature-11"] };
      assert.deepEqual(await state(), all);
      assert.deepEqual(await buttons(), [["start", null], ["back", null], ["forward", "true"], ["end", "true"]]);
      assert.equal(await page.getAttribute('#timeline [data-button="end"]', "title"), "Go to the end: The marker is already at the end");

      // 1. Step back: after Sketch 1. One undo step each way.
      await button("back");
      await undoIs(page, MOVE);
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atSketch);
      assert.deepEqual(await buttons(), [["start", null], ["back", null], ["forward", null], ["end", null]]);
      // The browser's row greyed (24f5), as its item on the bar is.
      assert.equal(await page.$eval('#browser [data-node="timeline"] .tree-row[data-node="feature-11"]', (r) => getComputedStyle(r).opacity), "0.45");
      assert.equal(await page.$eval('#browser [data-node="timeline"] .tree-row[data-node="sketch-2"]', (r) => getComputedStyle(r).opacity), "1");
      await undo();
      await undoIs(page, "Extrude Sketch 1");
      await settled(V);
      assert.deepEqual(await state(), all);
      await redo();
      await undoIs(page, MOVE);
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atSketch);

      // 2. Go to the start: nothing built, the view empty; start and back off.
      await button("start");
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing on screen");
      assert.deepEqual(await state(), atStart);
      assert.deepEqual(await buttons(), [["start", "true"], ["back", "true"], ["forward", null], ["end", null]]);
      if (shots) await page.screenshot({ path: `${shots}/marker-start-${width}.png` });
      // An off button changes nothing (forced: Playwright won't press an aria-disabled one).
      await (tap ? page.tap('#timeline [data-button="back"]', { force: true }) : page.click('#timeline [data-button="back"]', { force: true }));
      await page.waitForTimeout(150);
      assert.deepEqual(await bar(page), atStart.bar);
      await undo();
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atSketch);
      await redo();
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing on screen again");
      assert.deepEqual(await state(), atStart);

      // 3. Step forward: after the box. 4. Go to the end: everything.
      await button("forward");
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atBox);
      await button("end");
      await settled(V);
      assert.deepEqual(await state(), all);
      assert.equal(await undoTitle(page), `Undo ${MOVE} (Ctrl+Z)`);

      // 5. The marker dragged with the mouse, from the end to between the box and Sketch 1: drawn there while dragged,
      // the items after it greyed, and one undo step when let go. The drop place is worked out from where the items are.
      const boxOf = (id) => page.locator(`#timeline [data-item="${id}"]`).boundingBox();
      const markerBox = () => page.locator("#timeline .timeline-bar-marker").boundingBox();
      const gapX = async (a, b) => ((await boxOf(a)).x + (await boxOf(a)).width + (await boxOf(b)).x) / 2;
      const drag = async (toX, { hold } = {}) => {
        const m = await markerBox();
        const y = m.y + m.height / 2;
        await heard(page, async () => {
          await page.mouse.move(m.x + m.width / 2, y);
          await page.mouse.down();
          await page.mouse.move(toX, y, { steps: 8 });
          if (hold) await hold();
        });
        await page.mouse.up();
      };
      await drag(await gapX("feature-1", "sketch-2"), {
        hold: async () => {
          assert.deepEqual(await bar(page), atBox.bar, "while dragged the marker stands where it would drop");
          assert.equal(await page.$eval("#timeline .timeline-bar", (l) => l.dataset.dragging), "true");
          if (shots) await page.screenshot({ path: `${shots}/marker-drag-${width}.png` });
        },
      });
      await undoIs(page, MOVE);
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atBox);
      await undo();
      await settled(V);
      assert.deepEqual(await state(), all);
      await redo();
      await settled("24,000 mm³");
      assert.deepEqual(await state(), atBox);
      // Dragged to the left of the box's middle: the start.
      const b1 = await boxOf("feature-1");
      await drag(b1.x + b1.width * 0.25);
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "dragged to the start");
      assert.deepEqual(await state(), atStart);
      // Dragged past the last item's middle: the end.
      const b3 = await boxOf("feature-11");
      await drag(b3.x + b3.width * 0.75);
      await settled(V);
      assert.deepEqual(await state(), all);
      // A press on the marker that moves 3 px (under 5) is no drag: nothing recorded.
      const before = await undoTitle(page);
      const m = await markerBox();
      await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
      await page.mouse.down();
      await page.mouse.move(m.x + m.width / 2 - 3, m.y + m.height / 2, { steps: 3 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual(await bar(page), all.bar);
      assert.equal(await undoTitle(page), before);
      // Four Undos go back through the three drags and Go to the end, so the press added no step.
      for (const want of [atStart, atBox, all, atBox]) {
        await undo();
        await settled(want.volume);
        if (want === atStart) await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "undone to the start");
        assert.deepEqual(await state(), want);
      }

      if (tap) {
        // 6. Taps between items on a touch screen: the gap's middle, which is the row itself, not an item.
        const tapGap = async (x) => {
          const box = await boxOf("feature-1");
          const y = box.y + box.height / 2;
          assert.equal(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.className, [x, y]), "timeline-bar", "a gap is the row, not an item");
          await page.touchscreen.tap(x, y);
        };
        await tapGap(await gapX("sketch-2", "feature-11"));
        await undoIs(page, MOVE);
        await settled("24,000 mm³");
        assert.deepEqual(await state(), atSketch);
        if (shots) await page.screenshot({ path: `${shots}/marker-tap-${width}.png` });
        await undo();
        await settled("24,000 mm³");
        assert.deepEqual(await state(), atBox);
        await redo();
        await settled("24,000 mm³");
        assert.deepEqual(await state(), atSketch);
        // A tap on an item picks it (its ⋯ shows) and moves nothing.
        await page.tap('#timeline [data-item="feature-1"]');
        await until(page, () => document.querySelector('#timeline [data-more="feature-1"]'), null, "the ⋯");
        assert.deepEqual((await bar(page)), atSketch.bar);
        // Just past the last item (the gap after it): the end.
        const b = await boxOf("feature-11");
        await tapGap(b.x + b.width + 3);
        await settled(V);
        assert.deepEqual((await state()).bar, all.bar);
      }

      if (!tap) {
        await button("end");
        await settled(V);
      }
      assert.deepEqual(await state(), all);
      // 7. While a new sketch is edited (Sketch 2, last), going to the start would roll it back: off, with why, and
      // a drag there is refused with the same words; stepping back to just after it is still allowed.
      await press(page, "#create-sketch", tap);
      await press(page, "#sketch-plane-XY", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
      const words = "The marker can't go before Sketch 2 while it is being edited: finish the sketch first";
      assert.equal(await page.getAttribute('#timeline [data-button="start"]', "aria-disabled"), "true");
      assert.equal(await page.getAttribute('#timeline [data-button="start"]', "title"), `Go to the start: ${words}`);
      const step = await undoTitle(page);
      const bb = await boxOf("feature-1");
      await drag(bb.x + 2);
      await until(page, (w) => document.querySelector("#error")?.textContent === w, words, "the refusal shown");
      assert.equal(await undoTitle(page), step, "nothing recorded");
      assert.equal(await page.evaluate(() => document.querySelector("#viewport").dataset.sketching), "true", "still sketching");
      assert.deepEqual(await bar(page), ["feature-1", "sketch-2", "feature-11", "sketch-12", "|"], "the marker drawn back where it is");

      if (width === 375) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
      await page.context().close();
    });

    await check(`dragging an item to a new place (24f6): moved, refused before what it is built from or after what is built from it, the line and the words while dragged; the browser's Timeline rows select their body; one undo step each, pixels probed (${width} px${tap ? ", a finger on the picked item" : ""})`, async () => {
      const page = await fresh(width, tap);
      const layout = LAYOUTS[width];
      const V = layout.volume;
      await addSquare(page, tap, layout);
      const state = async () => ({ bar: await bar(page), drawn: await drawn(page, layout), volume: await page.textContent("#volume") });
      const undo = async () => press(page, "#undo", tap);
      const redo = async () => press(page, "#redo", tap);
      const settled = (want) => until(page, (w) => document.querySelector("#volume")?.textContent === w, want, `the panel showing ${want}`);
      const boxOf = (id) => page.locator(`#timeline [data-item="${id}"]`).boundingBox();
      const line = () => page.$eval("#timeline .timeline-reorder-line", (l) => [l.dataset.place, l.dataset.state]).catch(() => null);
      const note = () => page.$eval("#timeline .timeline-reorder-note", (n) => (n.hidden ? "" : n.textContent)).catch(() => null);
      // The finger drags only in Chromium, through its DevTools touch input (Playwright has no touch drag);
      // Firefox and WebKit drag with the mouse at phone width too.
      const finger = tap && browserName === "chromium" ? await page.context().newCDPSession(page) : null;
      /**
       * Item `id` dragged to the client x `to()` gives with the mouse, or with a finger after a tap has picked it
       * (measured once picked: its ⋯ beside it moves the items after it); `hold` runs while it is held there.
       */
      const drag = async (id, to, { hold } = {}) => {
        if (finger) {
          if (!(await page.$(`#timeline [data-more="${id}"]`))) await page.tap(`#timeline [data-item="${id}"]`);
          await until(page, (i) => document.querySelector(`#timeline [data-item="${i}"]`)?.classList.contains("timeline-reorder-picked"), id, `${id} picked`);
        }
        const b = await boxOf(id);
        const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
        const toX = await to();
        if (finger) {
          await finger.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          for (let k = 1; k <= 8; k++) await finger.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + ((toX - x) * k) / 8, y }] });
          if (hold) await hold();
          await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await heard(page, async () => {
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(toX, y, { steps: 8 });
            if (hold) await hold();
          });
          await page.mouse.up();
        }
      };
      const past = (id) => async () => ((b) => b.x + b.width * 0.75)(await boxOf(id));
      const before = (id) => async () => ((b) => b.x + b.width * 0.25)(await boxOf(id));

      // Box, Sketch 1, Extrude 1 (built from Sketch 1), everything built; the panel shows the last body, the square.
      const all = { bar: ["feature-1", "sketch-2", "feature-11", "|"], drawn: { box: true, square: true }, volume: V };
      assert.deepEqual(await state(), all);

      // 1. The box dragged past Extrude 1's middle: place 3, the end. While held, a blue line past Extrude 1 and no words.
      // Let go: Sketch 1, Extrude 1, box, one undo step; both bodies still drawn, the box now the last body in the panel.
      await drag("feature-1", past("feature-11"), {
        hold: async () => {
          assert.deepEqual(await line(), ["3", "moves"]);
          assert.equal(await note(), "");
          assert.equal(await page.$eval('#timeline [data-item="feature-1"]', (li) => li.classList.contains("timeline-reorder-dragged")), true);
          if (shots) await page.screenshot({ path: `${shots}/reorder-drag-${width}.png` });
        },
      });
      const MOVE_BOX = "Move Feature 1 (box) in the timeline";
      await undoIs(page, MOVE_BOX);
      await settled("24,000 mm³");
      const moved = { bar: ["sketch-2", "feature-11", "feature-1", "|"], drawn: { box: true, square: true }, volume: "24,000 mm³" };
      assert.deepEqual(await state(), moved);
      assert.equal(await line(), null, "the line gone");
      // The browser's Timeline rows in the new order, numbered again.
      assert.deepEqual(await page.$$eval('#browser [data-node="timeline"] .tree-row', (rs) => rs.map((r) => r.textContent)), ["1. Sketch 1 on the XY plane", `2. Extrude Sketch 1 by ${layout.distance} mm`, "3. Box: 40 × 30 × 20 mm"]);
      await undo();
      await settled(V);
      assert.deepEqual(await state(), all);
      await redo();
      await undoIs(page, MOVE_BOX);
      await settled("24,000 mm³");
      assert.deepEqual(await state(), moved);

      // 2. Extrude 1 dragged before Sketch 1 (place 0): while held, the line red and the reorder's words above the bar,
      // inside the screen. Let go: refused, the same words in the error line, nothing recorded, nothing moved.
      const BEFORE = "Extrude 1 can't go before Sketch 1: it is built from Sketch 1";
      await drag("feature-11", before("sketch-2"), {
        hold: async () => {
          assert.deepEqual(await line(), ["0", "refused"]);
          assert.equal(await note(), BEFORE);
          const n = await page.locator("#timeline .timeline-reorder-note").boundingBox();
          assert.ok(n.x >= 0 && n.x + n.width <= width && n.y >= 0, `the words fit the screen: ${JSON.stringify(n)}`);
          const t = await page.locator("#timeline").boundingBox();
          assert.ok(n.y + n.height <= t.y + 1, "the words stand above the bar");
          if (shots) await page.screenshot({ path: `${shots}/reorder-refused-${width}.png` });
        },
      });
      await until(page, (w) => document.querySelector("#error")?.textContent === w, BEFORE, "the refusal shown");
      assert.equal(await undoTitle(page), `Undo ${MOVE_BOX} (Ctrl+Z)`, "nothing recorded");
      assert.deepEqual(await state(), moved);
      assert.equal(await note(), null, "the words gone once let go");

      // 3. Sketch 1 dragged past Extrude 1 (place 2): refused, Extrude 1 is built from it.
      const AFTER = "Sketch 1 can't go after Extrude 1: Extrude 1 is built from it";
      await drag("sketch-2", past("feature-11"), { hold: async () => assert.deepEqual([await line(), await note()], [["2", "refused"], AFTER]) });
      await until(page, (w) => document.querySelector("#error")?.textContent === w, AFTER, "the refusal shown");
      assert.equal(await undoTitle(page), `Undo ${MOVE_BOX} (Ctrl+Z)`, "nothing recorded");
      assert.deepEqual(await state(), moved);

      // 4. A drag past the marker rolls the item back. Undone to the start order, the marker stepped back after Sketch 1
      // (Extrude 1 rolled back), the box dragged to the end: Sketch 1, marker, Extrude 1, box: nothing built, the view
      // empty. One Undo brings the box back.
      await undo();
      await settled(V);
      await press(page, '#timeline [data-button="back"]', tap);
      await settled("24,000 mm³");
      assert.deepEqual(await bar(page), ["feature-1", "sketch-2", "|", "feature-11 rolled back"]);
      await drag("feature-1", past("feature-11"));
      await undoIs(page, MOVE_BOX);
      await until(page, () => document.querySelector("#viewport").dataset.shape === "none", null, "nothing on screen");
      assert.deepEqual(await state(), { bar: ["sketch-2", "|", "feature-11 rolled back", "feature-1 rolled back"], drawn: { box: false, square: false }, volume: "—" });
      await undo();
      await settled("24,000 mm³");
      assert.deepEqual(await state(), { bar: ["feature-1", "sketch-2", "|", "feature-11 rolled back"], drawn: { box: true, square: false }, volume: "24,000 mm³" });
      await press(page, '#timeline [data-button="end"]', tap);
      await settled(V);
      assert.deepEqual(await state(), all);

      // 5. A press on an item that moves 3 px (under 5) is no drag: it picks the item, nothing recorded.
      if (!tap) {
        const step = await undoTitle(page);
        const b = await boxOf("sketch-2");
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.mouse.down();
        await page.mouse.move(b.x + b.width / 2 + 3, b.y + b.height / 2, { steps: 3 });
        await page.mouse.up();
        await until(page, () => document.querySelector('#timeline [data-more="sketch-2"]'), null, "the item picked");
        assert.equal(await undoTitle(page), step);
        assert.deepEqual(await bar(page), all.bar);
      }

      // 6. A finger on an item that isn't picked scrolls the row and drags nothing.
      if (finger) {
        await page.tap('#timeline [data-item="sketch-2"]'); // pick Sketch 1, so the box is not picked
        await until(page, () => document.querySelector('#timeline [data-more="sketch-2"]'), null, "Sketch 1 picked");
        const step = await undoTitle(page);
        const b = await boxOf("feature-1");
        const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
        await finger.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (let k = 1; k <= 8; k++) await finger.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 10 * k, y }] });
        assert.equal(await line(), null, "no drag");
        await finger.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(150);
        assert.equal(await undoTitle(page), step);
        assert.deepEqual(await bar(page), ["feature-1", "sketch-2", "feature-11", "|"]);
      }

      // 7. The browser's Timeline rows select their body (24f6): the box's row selects Body 1 (its row lit too) and only
      // the box's faces; Sketch 1's row selects nothing (sketches are not selectable yet).
      if ((await page.isVisible("#browser-toggle")) && (await page.getAttribute("#browser-toggle", "aria-expanded")) !== "true") await press(page, "#browser-toggle", tap);
      await page.evaluate(() => document.querySelectorAll("#browser details").forEach((d) => (d.open = true)));
      const boxRow = '#browser [data-node="timeline"] .tree-row[data-node="feature-1"]';
      assert.equal(await page.$eval(boxRow, (r) => r.tagName), "BUTTON");
      assert.equal(await page.$eval('#browser [data-node="timeline"] .tree-row[data-node="sketch-2"]', (r) => r.tagName), "SPAN");
      await press(page, boxRow, tap);
      await until(page, () => document.querySelector('#browser .tree-row[data-node="body-1"]')?.getAttribute("aria-current") === "true", null, "Body 1 lit");
      assert.equal(await page.getAttribute(boxRow, "aria-current"), "true");
      assert.equal(await page.getAttribute('#browser [data-node="timeline"] .tree-row[data-node="feature-11"]', "aria-current"), null);
      assert.equal(await page.getAttribute('#browser .tree-row[data-node="body-2"]', "aria-current"), null);
      assert.equal(await page.textContent("#volume"), "24,000 mm³", "the panel shows the selected body");
      if (shots) await page.screenshot({ path: `${shots}/row-selects-${width}.png` });

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
