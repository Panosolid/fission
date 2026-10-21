// Browser check of picking where a sketch goes (step 26d): Create sketch
// offers the three origin planes and every flat face of the bodies shown;
// the face or plane under the pointer lights, a face winning over a plane
// in front of it (the planes are drawn behind the body; pixel probes);
// a click on the box's top makes a sketch there, looked at straight down,
// with its grid and axes, the box faded, drawn on with the same clicks
// and snaps as the ground plane (pixel probes on its lines), and extruded
// out of the box; the bottom, picked from the bottom view, is looked at
// from below (outside the box) and its sketch extruded down; a cylinder's
// round side is refused in words and nothing is recorded; the front plane
// from its button. Points on screen come from the app's own camera (the
// ?test-hooks camera) through the pinhole sums worked here, so a click
// lands on the model point it names. 1280 px with a mouse and 375 px with
// taps. Then the timeline's rules on a face sketch (26e): suppressing the
// box greys what is on it, a drag across the face's link is refused in
// words, deleting the box asks and leaves the sketch and its extrude
// warned, the sketch's lines red. Screenshots go to E2E_SHOTS when set. Run with `npm run e2e`
// (after `npm run build`).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launch, browserName } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4195, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4195/?test-hooks";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

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
const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 8000 }).catch(async () => assert.fail(`${what}: timed out`));
const camera = (page) => page.evaluate(() => window.fissionTest.camera());
const canvasBox = (page) => page.locator("#viewport canvas").boundingBox();
const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));

// The pinhole camera, worked here apart from the app (navigation.mjs's sums): forward = unit(target − position),
// right = unit(forward × up), the screen's up = right × forward; a 45° vertical field of view.
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const T = Math.tan(Math.PI / 8);
/** Where a world point is on screen (client pixels) for the camera `cam` and the canvas at `box`. */
function toScreen(cam, box, p) {
  const forward = unit(sub(cam.target, cam.position));
  const right = unit(cross(forward, cam.up));
  const up = cross(right, forward);
  const v = sub(p, cam.position);
  const aspect = box.width / box.height;
  const nx = dot(v, right) / (dot(v, forward) * T * aspect);
  const ny = dot(v, up) / (dot(v, forward) * T);
  return { x: box.x + ((nx + 1) / 2) * box.width, y: box.y + ((1 - ny) / 2) * box.height };
}

/** Clicks (or taps) the world point `p` as the camera sees it now; fails if something is over the canvas there. */
async function at(page, p, tap = false) {
  const s = toScreen(await camera(page), await canvasBox(page), p);
  const on = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y);
    return e?.tagName === "CANVAS" && e.closest("#viewport") ? "canvas" : e ? e.id || e.className || e.tagName : "nothing";
  }, [s.x, s.y]);
  if (on !== "canvas") throw new Error(`[${p}] is under ${on} on screen, not the canvas`);
  if (tap) await page.touchscreen.tap(s.x, s.y);
  else await page.mouse.click(s.x, s.y);
}

/** Moves the mouse over the world point `p`, and waits a few frames (hover is looked up once a frame). */
async function hover(page, p) {
  const s = toScreen(await camera(page), await canvasBox(page), p);
  await page.mouse.move(s.x, s.y);
  await page.waitForTimeout(150);
}

/** The WebGL canvas's own pixels (it keeps its drawing buffer). */
async function canvasImage(page) {
  const u = await page.evaluate(() => document.querySelector("#viewport canvas").toDataURL("image/png"));
  return decodePng(Buffer.from(u.slice(u.indexOf(",") + 1), "base64"));
}
/** The canvas pixel under the world point `p`, [r, g, b] (canvas pixels are CSS pixels at device scale 1). */
async function pixelAt(page, p) {
  const box = await canvasBox(page);
  const s = toScreen(await camera(page), box, p);
  const img = await canvasImage(page);
  const [x, y] = [Math.round(s.x - box.x), Math.round(s.y - box.y)];
  const i = 4 * (y * img.width + x);
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}
/** A sketch line's blue (0x6cc4ff: blue well above red) within 1 px of the world point `p`. */
async function lineNear(page, img, p) {
  const box = await canvasBox(page);
  const s = toScreen(await camera(page), box, p);
  const [cx, cy] = [Math.round(s.x - box.x), Math.round(s.y - box.y)];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const i = 4 * ((cy + dy) * img.width + cx + dx);
      if (img.data[i + 2] - img.data[i] >= 80) return true;
    }
  return false;
}

/** Waits until the camera holds still (two reads 100 ms apart within a nanometre). */
async function settle(page) {
  let last = null;
  for (let i = 0; i < 100; i++) {
    await page.waitForTimeout(100);
    const now = await camera(page);
    if (last && [...now.position, ...now.target].every((x, k) => Math.abs(x - [...last.position, ...last.target][k]) < 1e-6)) return now;
    last = now;
  }
  throw new Error("the camera never settled");
}

/** Create sketch from the toolbar, the planes and faces on offer. */
async function createSketch(page, tap = false) {
  await press(page, "#create-sketch", tap);
  await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
}

/**
 * A closed rectangle on the sketch's plane through four world corners
 * (grid snap on, so each lands exactly): with a mouse, the line tool round
 * them, the last click on the first corner; with taps, the rectangle tool
 * from the third corner to the first (the typed boxes float right of and
 * below the last tap, so the second tap goes up and left of it).
 */
async function rectangle(page, corners, tap = false) {
  await page.check("#sketch-grid-snap");
  await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0)); // ticking it scrolled the panel into view at phone width
  if (!tap) for (const p of [...corners, corners[0]]) await at(page, p);
  else {
    await page.tap("#sketch-tool-rectangle");
    for (const p of [corners[2], corners[0]]) await at(page, p, true);
  }
}

/** Extrude from the sketch panel by `distance`, OK. */
async function extrude(page, distance, tap = false) {
  await press(page, "#sketch-extrude", tap);
  await page.fill("#extrude-distance", String(distance));
  await press(page, "#extrude-ok", tap);
}

const near = (a, b, eps, what) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) <= eps), `${what}: [${a.map((x) => x.toFixed(4))}] vs [${b}]`);

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
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

try {
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px: Create sketch offers XY, XZ, YZ and the box's six faces; a face under the pointer lights over a plane in front of it, then a click on the top makes a sketch there, looked at straight down, grid and axes on it, the box faded`, async () => {
      const page = await fresh(width, tap);
      await settle(page);
      await createSketch(page, tap);
      assert.equal(await data(page, "pickFaces"), "0 1 2 3 4 5");
      for (const id of ["XY", "XZ", "YZ"]) assert.equal(await page.isDisabled(`#sketch-plane-${id}`), false, `${id} button on`);
      if (!tap) {
        // From the home view (in front, above) the front plane's square rises past the box's front edge, in front of
        // the top's middle (20, 15, 20); the planes are drawn behind the body and a face wins, so the top lights.
        await hover(page, [20, 15, 20]);
        assert.equal(await data(page, "hover"), "face 1");
        assert.equal(await data(page, "hoverPlane"), "");
        // Pixel probe: that point of the front plane, in front of the top, shows the box, not the plane's blue.
        const [r, , b] = await pixelAt(page, [20, 15, 20]);
        assert.ok(b - r < 60, `the top, not the plane, is drawn there: rgb ${r}, ${b}`);
      }
      // From the top view nothing is in front of the top.
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      if (!tap) {
        // The top's middle: kernel face 1 (make_box: bottom, top, front, back, left, right) lights.
        await page.mouse.move(0, 0);
        await page.waitForTimeout(150);
        const before = await pixelAt(page, [20, 15, 20]);
        await hover(page, [20, 15, 20]);
        assert.equal(await data(page, "hover"), "face 1");
        assert.equal(await data(page, "hoverPlane"), "");
        const lit = await pixelAt(page, [20, 15, 20]);
        assert.ok(lit.some((c, i) => Math.abs(c - before[i]) > 20), `the top lights: ${before} then ${lit}`);
        await shot(page, `pick-face-hover-${width}`);
        // The ground plane beside the box, (35, 38, 0) (its square runs to 1.6 × the framing radius, about 43 mm): the plane lights, no face.
        await hover(page, [30, 38, 0]);
        assert.equal(await data(page, "hoverPlane"), "XY");
        assert.equal(await data(page, "hover"), "");
      }
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
      assert.equal(await page.textContent("#sketch-name"), "Sketch 1");
      assert.equal(await data(page, "planes"), "", "the planes go");
      const cam = await settle(page);
      // Straight down onto z = 20 (Look At, planeViewBasis): the target on the top, the camera right above it, Y up on screen.
      near(cam.target.slice(2), [20], 1e-6, "target on the top");
      near(unit(sub(cam.position, cam.target)), [0, 0, 1], 1e-5, "looking straight down");
      assert.equal(await data(page, "bodyFaded"), "true");
      assert.equal(await data(page, "sketchAxes"), "x y");
      assert.match(await data(page, "sketchGrid"), /^minor /);
      // Corners on the 10 mm grid; with taps the rectangle tool goes from (10, 10) to (30, 20), above the first tap on screen.
      await rectangle(page, [[30, 20, 20], [10, 20, 20], [10, 10, 20], [30, 10, 20]], tap);
      await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "closed");
      assert.deepEqual((await data(page, "sketchPoints")).split(" ").sort(), ["10,10", "10,20", "30,10", "30,20"]);
      // Pixel probes: the sketch's blue on each side's middle, none in the rectangle's middle.
      const img = await canvasImage(page);
      for (const p of [[20, 10, 20], [30, 15, 20], [20, 20, 20], [10, 15, 20]]) assert.ok(await lineNear(page, img, p), `a sketch line at [${p}]`);
      assert.equal(await lineNear(page, img, [20, 15, 20]), false, "no line in the middle");
      await shot(page, `top-sketch-${width}`);
      await extrude(page, 10, tap);
      // The part shown is the new block: 20 · 10 · 10 = 2,000 mm³.
      await until(page, () => document.querySelector("#volume")?.textContent === "2,000 mm³", null, "2,000 mm³");
      await shot(page, `top-extruded-${width}`);
      await page.context().close();
    });
  }

  await check("1280 px: the bottom, picked from the bottom view, is looked at from below (outside the box), drawn in the world's x and y, and extruded down", async () => {
    const page = await fresh();
    // Orbit under the box: a left-drag 150 px up turns the camera down past the ground (OrbitControls, Orbit mode).
    const box = await canvasBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 15 * k);
    await page.mouse.up();
    const under = await settle(page);
    assert.ok(under.position[2] < 0, `the camera went under the box: ${under.position}`);
    await createSketch(page);
    await hover(page, [20, 15, 0]);
    assert.equal(await data(page, "hover"), "face 0", "the bottom lights");
    await at(page, [20, 15, 0]);
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    const cam = await settle(page);
    // Side −1: the camera below the box, looking up, as the bottom view does: the front (−Y) at the top, +X to the right.
    assert.ok(cam.position[2] < -10, `the camera is below the box: ${cam.position}`);
    near(unit(sub(cam.position, cam.target)), [0, 0, -1], 1e-5, "looking straight up");
    near(cam.target.slice(2), [0], 1e-6, "target on the bottom");
    const canvas = await canvasBox(page);
    const [left, right] = [toScreen(cam, canvas, [0, 15, 0]), toScreen(cam, canvas, [40, 15, 0])];
    const [front, back] = [toScreen(cam, canvas, [20, 0, 0]), toScreen(cam, canvas, [20, 30, 0])];
    assert.ok(left.x < right.x && front.y < back.y, "+X to the right, the front at the top");
    await rectangle(page, [[10, 10, 0], [30, 10, 0], [30, 20, 0], [10, 20, 0]]);
    await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "closed");
    assert.equal(await data(page, "sketchPoints"), "10,10 30,10 30,20 10,20", "the world's x and y");
    const img = await canvasImage(page);
    for (const p of [[20, 10, 0], [30, 15, 0], [20, 20, 0], [10, 15, 0]]) assert.ok(await lineNear(page, img, p), `a sketch line at [${p}]`);
    await shot(page, "bottom-sketch-1280");
    // The navigation bar's Look at turns the same way.
    await page.click('[data-view="home"]');
    await page.click('[data-view="look-at"]');
    const again = await settle(page);
    assert.ok(again.position[2] < -10, `Look at again from below: ${again.position}`);
    await extrude(page, 10);
    // The new block below the box: 20 · 10 · 10 = 2,000 mm³.
    await until(page, () => document.querySelector("#volume")?.textContent === "2,000 mm³", null, "2,000 mm³");
    await page.context().close();
  });

  await check("1280 px: a cylinder's round side does not light and is refused in words, nothing recorded; its flat top is offered", async () => {
    const page = await fresh();
    await page.click("#toolbar [data-shape=cylinder]");
    await until(page, () => document.querySelector("#viewport").dataset.shape === "cylinder", null, "a cylinder");
    await settle(page);
    const undoBefore = await page.evaluate(() => document.getElementById("undo").title);
    await createSketch(page);
    // Kernel faces bottom 0, top 1, side 2: only the caps are offered.
    assert.equal(await data(page, "pickFaces"), "0 1");
    const r = Number(await page.inputValue("#width")) / 2;
    const h = Number(await page.inputValue("#height"));
    // The side's point nearest the home camera (it looks from (0.6, −0.8, …)): out along (0.6, −0.8) by r, halfway up.
    const side = [0.6 * r, -0.8 * r, h / 2];
    await hover(page, side);
    assert.equal(await data(page, "hover"), "", "the round side does not light");
    await at(page, side);
    await until(page, () => !document.getElementById("sketch-pick-error")?.hidden, null, "the refusal");
    assert.match(await page.textContent("#sketch-pick-error"), /curved/);
    assert.equal(await data(page, "sketching"), "false");
    assert.equal(await data(page, "planes"), "XY, XZ, YZ", "the planes stay");
    assert.equal(await page.evaluate(() => document.getElementById("undo").title), undoBefore, "nothing recorded");
    await shot(page, "curved-refused-1280");
    await hover(page, [0, 0, h]);
    assert.equal(await data(page, "hover"), "face 1", "the top lights");
    await page.context().close();
  });

  await check("375 px, taps: the front plane from its button is looked at from the front, a rectangle tapped on it and extruded", async () => {
    const page = await fresh(375, true);
    await createSketch(page, true);
    await page.tap("#sketch-plane-XZ");
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    const cam = await settle(page);
    near(unit(sub(cam.position, cam.target)), [0, -1, 0], 1e-5, "looking from the front");
    // Beside the box (x 0..40), on the front plane: x along X, y along Z.
    // Above the box (z 0..20), on the front plane: x along X, y along Z.
    // Taps from (30, 30) to (10, 40): the rectangle tool's corners, up and left on screen.
    await rectangle(page, [[10, 0, 40], [30, 0, 40], [30, 0, 30], [10, 0, 30]], true);
    await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "closed");
    assert.deepEqual((await data(page, "sketchPoints")).split(" ").sort(), ["10,30", "10,40", "30,30", "30,40"]);
    await shot(page, "front-plane-375");
    await extrude(page, 5, true);
    // The new block: 20 · 10 · 5 = 1,000 mm³.
    await until(page, () => document.querySelector("#volume")?.textContent === "1,000 mm³", null, "1,000 mm³");
    await page.context().close();
  });
  // Playwright's Firefox gives the mouse of a touch page no pointer events, so the bar can't be dragged there with it
  // (timeline.mjs's note): in Firefox the 375 px check uses the mouse on a page without touch.
  for (const [width, tap] of [[1280, false], [375, browserName !== "firefox"]]) {
    await check(`${width} px${tap ? ", taps" : ""}: the timeline's rules on a face sketch (26e): the box suppressed greys the sketch and its extrude, no warning; the sketch dragged before the box refused in words; the box deleted asks, then both stay warned red, the sketch's lines red (pixel probed), one undo step`, async () => {
      const page = await fresh(width, tap);
      await settle(page);
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await createSketch(page, tap);
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
      await settle(page);
      await rectangle(page, [[30, 20, 20], [10, 20, 20], [10, 10, 20], [30, 10, 20]], tap);
      await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "closed");
      await extrude(page, 10, tap);
      await until(page, () => document.querySelector("#volume")?.textContent === "2,000 mm³", null, "2,000 mm³");
      const ids = await page.$$eval("#timeline [data-item]", (lis) => lis.map((li) => li.dataset.item));
      assert.equal(ids.length, 3);
      const [box, sketch, ext] = ids;
      /** Each bar item's flags: s suppressed, g greyed, w warned, f failed. */
      const flags = () => page.$$eval("#timeline [data-item]", (lis) => lis.map((li) => [li.dataset.item, (li.dataset.suppressed ? "s" : "") + (li.dataset.greyed ? "g" : "") + (li.dataset.warned ? "w" : "") + (li.dataset.failed ? "f" : "")]));
      const titleOf = (id) => page.getAttribute(`#timeline [data-item="${id}"]`, "title");
      const rowClasses = (id) => page.$eval(`#browser [data-node="timeline"] .tree-row[data-node="${id}"]`, (r) => [...r.classList].filter((c) => c === "kept" || c.startsWith("timeline-menu")).join(" "));
      const menu = async (id) => {
        const item = page.locator(`#timeline [data-item="${id}"]`);
        await item.scrollIntoViewIfNeeded();
        if (tap) {
          await item.tap();
          await page.tap(`#timeline [data-more="${id}"]`);
        } else await item.click({ button: "right" });
        await until(page, () => document.getElementById("row-menu").open, null, `${id}'s menu`);
      };
      const choose = async (action) => {
        await press(page, `#row-menu-${action}`, tap);
        await until(page, () => !document.getElementById("row-menu").open, null, "the menu closed");
      };
      const lostLines = () => data(page, "sketchLost");
      /** The canvas's pixels within 6 of the lost red, (255, 107, 107): the X axis (229, 83, 75) and the box's greys and blues are well clear. */
      const lostRed = async () => {
        const img = await canvasImage(page);
        let n = 0;
        for (let i = 0; i < img.data.length; i += 4) if (img.data[i] >= 249 && Math.abs(img.data[i + 1] - 107) <= 6 && Math.abs(img.data[i + 2] - 107) <= 6) n++;
        return n;
      };
      const all = [[box, ""], [sketch, ""], [ext, ""]];
      assert.deepEqual(await flags(), all);
      assert.equal(await lostLines(), "0");
      assert.equal(await lostRed(), 0, "no lost red yet");

      // 1. The box suppressed: the sketch and its extrude greyed (faded, dashed), saying the box is why, no warning (Q3); the sketch not drawn.
      await menu(box);
      await choose("suppress");
      await until(page, () => document.querySelector("#timeline [data-item][data-greyed]"), null, "greyed");
      assert.deepEqual(await flags(), [[box, "s"], [sketch, "g"], [ext, "g"]]);
      assert.match(await titleOf(sketch), /\(greyed: Feature 1 \(box\) is suppressed\)$/);
      assert.match(await titleOf(ext), /\(greyed: Feature 1 \(box\) is suppressed\)$/);
      assert.equal(await page.$eval(`#timeline [data-item="${sketch}"]`, (li) => getComputedStyle(li).opacity), "0.6", "faded");
      assert.equal(await page.$eval(`#timeline [data-item="${sketch}"]`, (li) => getComputedStyle(li).borderTopStyle), "dashed");
      assert.equal(await rowClasses(sketch), "timeline-menu timeline-menu-greyed");
      assert.equal(await rowClasses(ext), "timeline-menu timeline-menu-greyed");
      assert.equal(await page.isVisible("#kept-warning"), false, "no warning");
      assert.equal(await data(page, "sketchLines"), "0", "the greyed sketch isn't drawn");
      // Edit Sketch is off for the greyed sketch, with why.
      await menu(sketch);
      assert.equal(await page.isDisabled("#row-menu-edit-sketch"), true);
      assert.equal(await page.textContent("#row-menu-edit-sketch .delete-ask-off"), "Sketch 1 is greyed: Feature 1 (box) is suppressed, unsuppress it first");
      await shot(page, `face-greyed-${width}`);
      await page.keyboard.press("Escape");
      await until(page, () => !document.getElementById("row-menu").open, null, "the menu closed");
      await press(page, "#undo", tap);
      await until(page, () => !document.querySelector("#timeline [data-item][data-greyed]"), null, "greyed no more");
      assert.deepEqual(await flags(), all);
      await until(page, () => document.querySelector("#volume")?.textContent === "2,000 mm³", null, "built again");

      // 2. The sketch dragged before the box: refused while held and let go, in the face's words; nothing recorded.
      const undoBefore = await page.evaluate(() => document.getElementById("undo").title);
      const WORDS = "Sketch 1 can't go before Feature 1 (box): it is drawn on a face of Feature 1 (box)";
      const b = await page.locator(`#timeline [data-item="${sketch}"]`).boundingBox();
      const to = await page.locator(`#timeline [data-item="${box}"]`).boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width * 0.25, b.y + b.height / 2, { steps: 8 });
      assert.equal(await page.$eval("#timeline .timeline-reorder-note", (n) => n.textContent), WORDS);
      await shot(page, `face-drag-refused-${width}`);
      await page.mouse.up();
      await until(page, (w) => document.querySelector("#error")?.textContent === w, WORDS, "the refusal shown");
      assert.equal(await page.evaluate(() => document.getElementById("undo").title), undoBefore, "nothing recorded");
      assert.deepEqual(await page.$$eval("#timeline [data-item]", (lis) => lis.map((li) => li.dataset.item)), ids, "nothing moved");

      // 3. The box deleted: asked first, naming what stays; then the block stays at z 20 to 30, the sketch and the extrude warned red.
      await menu(box);
      await choose("delete");
      await until(page, () => document.getElementById("delete-ask").open, null, "the box asks");
      assert.equal(await page.textContent("#delete-ask-heading"), "Delete Feature 1 (box)?");
      assert.equal(await page.textContent("#delete-ask-words"), "Sketch 1 is drawn on a face of Feature 1 (box). If you delete it, Sketch 1 stays where it is and shows its plane is lost, and what is built from it, Extrude 1, stays where it is and shows its source is lost. Undo brings Feature 1 (box) back.");
      const ask = await page.locator("#delete-ask").boundingBox();
      assert.ok(ask.x >= 0 && ask.x + ask.width <= width, `the box fits the screen: ${JSON.stringify(ask)}`);
      await shot(page, `face-delete-ask-${width}`);
      await press(page, "#delete-ask-confirm", tap);
      await until(page, () => document.querySelectorAll("#timeline [data-item]").length === 2, null, "the box gone");
      // The volume was 2,000 mm³ before too (the part is the block), so wait for the rebuild's warnings themselves.
      await until(page, () => document.querySelectorAll("#timeline [data-item][data-warned]").length === 2, null, "the rebuild's warnings");
      assert.equal(await page.textContent("#volume"), "2,000 mm³", "the block stays");
      const LOST = "Sketch 1's face is gone, so its plane is lost: it stays where it was.";
      const SOURCE = "Extrude 1's source is lost: Sketch 1's plane is lost, so it stays where it was.";
      const deleted = async () => {
        assert.deepEqual(await flags(), [[sketch, "w"], [ext, "w"]]);
        assert.match(await titleOf(sketch), new RegExp(`\\(warning: ${LOST.replace(/[()'.]/g, "\\$&")}\\)$`));
        assert.equal(await page.textContent("#kept-warning"), `${LOST} ${SOURCE}`);
        assert.equal(await page.isVisible("#kept-warning"), true);
        assert.equal(await rowClasses(sketch), "kept");
        assert.equal(await rowClasses(ext), "kept");
        const red = await page.$eval(`#timeline [data-item="${sketch}"]`, (li) => getComputedStyle(li).color);
        const [r, g, bl] = red.match(/\d+/g).map(Number);
        assert.ok(r - bl >= 80 && r - g >= 80, `the bar item's words red: ${red}`);
        assert.equal(await lostLines(), "4", "the sketch's lines drawn as lost");
      };
      await deleted();
      // Pixel probe: the lost red (0xff6b6b, drawn unlit) on screen now, and none of it once undone.
      // From the home view (in front, above), where the block's front and right bottom edges, on the sketch, show.
      await press(page, '[data-view="home"]', tap);
      await settle(page);
      assert.ok((await lostRed()) >= 20, `the sketch's lines drawn red: ${await lostRed()} pixels`);
      await shot(page, `face-deleted-${width}`);
      // One undo step brings the box back, nothing warned or red; redo deletes it again.
      assert.equal(await page.evaluate(() => document.getElementById("undo").title), "Undo Delete Feature 1 (box) (Ctrl+Z)");
      await press(page, "#undo", tap);
      await until(page, () => document.querySelectorAll("#timeline [data-item]").length === 3, null, "the box back");
      await until(page, () => !document.querySelector("#timeline [data-item][data-warned]"), null, "no warnings");
      assert.deepEqual(await flags(), all);
      assert.equal(await page.isVisible("#kept-warning"), false);
      assert.equal(await lostLines(), "0");
      assert.equal(await lostRed(), 0, "no red once the box is back");
      await press(page, "#redo", tap);
      await until(page, () => document.querySelectorAll("#timeline [data-item][data-warned]").length === 2, null, "deleted again");
      await deleted();
      await page.context().close();
    });
  }
} finally {
  await browser.close();
  server.httpServer.close();
}
if (errors.length) {
  failed++;
  console.log(`not ok - page errors:\n  ${errors.join("\n  ")}`);
}
console.log(failed ? `${failed} face sketch check(s) failed (${browserName})` : `face sketch checks passed (${browserName})`);
process.exit(failed ? 1 : 0);
