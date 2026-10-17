// Browser check of seeing what you draw (sketch feel SF2): picking the
// ground plane looks straight at it; the body goes see-through while the
// sketch is edited and solid again after Finish sketch (pixel probes on its
// top face); a red x axis and a green y axis run through the origin (pixel
// probes across each); the grid's spacing is the smallest power of ten at
// least 8 px apart and follows the zoom; with Snap to grid ticked the grid
// drawn is the snap grid's; after orbiting, Look at puts the camera back
// square onto the sketch. The same at 375 px with taps. Screenshots at
// 1280 and 375 px go to E2E_SHOTS when set. Run with `npm run e2e` (after
// `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4188, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4188/";
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

// Look At on the ground plane with the 40 × 30 × 20 box: the box's sphere (centre (20, 15, 10), radius √2900 / 2)
// moved down onto the plane, (20, 15, 0), seen from fitDistance + 10 straight above, which is where the top view
// of the box puts the camera too (fitDistance above the centre at height 10).
const LOOK = { target: [20, 15, 0], radius: Math.sqrt(2900) / 2, lift: 10 };

/** The camera's distance from the plane and the half-angle that fits the sphere (45° fov, the narrower one on a tall view). */
function lookCamera(box) {
  const aspect = box.width / box.height;
  const half = aspect < 1 ? Math.atan(Math.tan(Math.PI / 8) * aspect) : Math.PI / 8;
  return { height: LOOK.radius / Math.sin(half) + LOOK.lift, aspect };
}

/** Where a point on the ground plane is on screen, looking straight down at LOOK. */
function screenPoint(box, [x, y]) {
  const { height, aspect } = lookCamera(box);
  const t = Math.tan(Math.PI / 8);
  const ndcX = (x - LOOK.target[0]) / (height * t * aspect);
  const ndcY = (y - LOOK.target[1]) / (height * t);
  return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
}

/** mm per CSS pixel on the plane in that view: the view's height spans 2 · height · tan(22.5°). */
const mmPerPixel = (box) => (2 * lookCamera(box).height * Math.tan(Math.PI / 8)) / box.height;

/** The rule the grid must follow, worked here apart from the app: the smallest power of ten at least 8 pixels apart. */
function expectedMinor(pixel) {
  let e = Math.floor(Math.log10(8 * pixel)) - 1;
  while (Number(`1e${e}`) < 8 * pixel) e++;
  return Number(`1e${e}`);
}

const data = (page, key) => page.evaluate((k) => document.querySelector("#viewport").dataset[k] ?? "", key);
const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(async () => assert.fail(`${what}: timed out`));
const shown = (page, key, test, what) =>
  until(page, ([k, src]) => new RegExp(src).test(document.querySelector("#viewport").dataset[k] ?? ""), [key, test.source], what).catch(async (e) => assert.fail(`${e.message} (shown: "${await data(page, key)}")`));
/** The grid's spacings as the viewport says them ("minor 1 major 10 strength 0.13"). */
async function gridShown(page) {
  const m = /^minor (\S+) major (\S+) strength (\S+)$/.exec(await data(page, "sketchGrid"));
  assert.ok(m, `no grid shown: "${await data(page, "sketchGrid")}"`);
  return { minor: Number(m[1]), major: Number(m[2]), strength: Number(m[3]) };
}

/** The canvas's pixels round a point on screen (CSS pixels), w × h of them, as [r, g, b] each. */
function pixels(page, { x, y }, w = 1, h = 1) {
  return page.evaluate(
    ({ x, y, w, h }) => {
      const c = document.querySelector("#viewport canvas");
      const r = c.getBoundingClientRect();
      const s = c.width / r.width;
      const t = document.createElement("canvas");
      t.width = c.width;
      t.height = c.height;
      const g = t.getContext("2d");
      g.drawImage(c, 0, 0);
      const d = g.getImageData(Math.round((x - r.x) * s - (w * s) / 2), Math.round((y - r.y) * s - (h * s) / 2), Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))).data;
      const out = [];
      for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
      return out;
    },
    { x, y, w, h },
  );
}
/** How much redder than green and blue a pixel is, the most across a strip; the same for green. */
const reddest = (list) => Math.max(...list.map(([r, g, b]) => r - Math.max(g, b)));
const greenest = (list) => Math.max(...list.map(([r, g, b]) => g - Math.max(r, b)));
const brightness = (list) => list.reduce((s, [r, g, b]) => s + (r + g + b) / 3, 0) / list.length;
/** A few frames for the camera's damping and the grid to settle. */
const settle = (page) => page.waitForTimeout(400);

async function startSketch(page, tap = false) {
  await (tap ? page.tap("#create-sketch") : page.click("#create-sketch"));
  await (tap ? page.tap("#sketch-plane-XY") : page.click("#sketch-plane-XY"));
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
  await settle(page);
}

/** The axes and the faded body, probed: the x axis (y = 0) red, the y axis (x = 0) green, the top face see-through. Returns the face's brightness. */
async function probeSketchView(page, what) {
  const box = await page.locator("#viewport canvas").boundingBox();
  // Across the x axis at x = 30 (inside the box's top face, so over the faded body) and x = −5 (off the body),
  // a 1 × 7 strip: the line is a pixel thick and the browser may round its row either way.
  for (const x of [30, -5]) {
    const p = screenPoint(box, [x, 0]);
    assert.ok(reddest(await pixels(page, p, 1, 7)) > 50, `${what}: no red x axis at (${x}, 0)`);
    assert.ok(greenest(await pixels(page, p, 1, 7)) < 30, `${what}: (${x}, 0) is green`);
  }
  for (const y of [20, -4]) {
    const p = screenPoint(box, [0, y]);
    assert.ok(greenest(await pixels(page, p, 7, 1)) > 50, `${what}: no green y axis at (0, ${y})`);
  }
  // Half way between two axes, nowhere near an axis: neither colour.
  const off = screenPoint(box, [25.5, 18.5]);
  assert.ok(reddest(await pixels(page, off, 3, 3)) < 30 && greenest(await pixels(page, off, 3, 3)) < 30, `${what}: an axis colour off the axes`);
  return brightness(await pixels(page, off, 5, 5));
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
  await check("sketching at 1280 px: looked at square, red and green axes through the origin, the body see-through, solid again after Finish sketch", async () => {
    const page = await fresh();
    await startSketch(page);
    assert.equal(await data(page, "bodyFaded"), "true");
    assert.equal(await data(page, "sketchAxes"), "x y");
    const faded = await probeSketchView(page, "1280");
    if (shots) await page.screenshot({ path: `${shots}/sketch-view-1280.png` });
    await page.click("#sketch-finish");
    await settle(page);
    assert.equal(await data(page, "bodyFaded"), "false");
    assert.equal(await data(page, "sketchAxes"), "", "the sketch's axes go with it");
    assert.equal(await data(page, "sketchGrid"), "", "the sketch's grid goes with it");
    const solid = brightness(await pixels(page, screenPoint(await page.locator("#viewport canvas").boundingBox(), [25.5, 18.5]), 5, 5));
    // The face is light grey solid; at 30 % over the dark background it is well under 60 % as bright.
    assert.ok(faded < 0.6 * solid, `the body is not see-through while sketching: ${faded.toFixed(0)} against ${solid.toFixed(0)} solid`);
    await page.context().close();
  });

  await check("the grid at 1280 px: the smallest power of ten 8 px apart, coarser zoomed out and back when zoomed in, the snap grid's when snapping", async () => {
    const page = await fresh();
    await startSketch(page);
    const box = await page.locator("#viewport canvas").boundingBox();
    const pixel = mmPerPixel(box);
    const start = await gridShown(page);
    assert.equal(start.minor, expectedMinor(pixel), `pixel ${pixel} mm`);
    assert.equal(start.major, 10 * start.minor);
    // Strength from the spacing on screen: log10(minor / pixel / 8).
    assert.ok(Math.abs(start.strength - Math.log10(start.minor / pixel / 8)) < 0.02, `strength ${start.strength}`);
    // Zoom out a long way (four 400 px turns: e^(4 · 400 · 0.002) = ×24.5, SF3a's wheel): the minor spacing grows by powers of ten.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 400);
    await settle(page);
    await shown(page, "sketchGrid", /^minor (10|100|1000|10000) /, "a coarser grid zoomed out");
    const out = await gridShown(page);
    assert.ok(out.minor >= 10 * start.minor, `zoomed out the minor spacing is ${out.minor}, was ${start.minor}`);
    // Look at frames the sketch again: the first spacing comes back.
    await page.click("#sketch-look-at");
    await settle(page);
    assert.deepEqual(await gridShown(page), start);
    // Snap to grid 10 mm: the lines drawn are the snap grid's, 10 apart (1 mm lines would be closer than the clicks can land).
    await page.check("#sketch-grid-snap");
    await shown(page, "sketchGrid", /^minor 10 major 100 /, "the snap grid");
    await page.fill("#sketch-grid", "2.5");
    await page.press("#sketch-grid", "Enter");
    await shown(page, "sketchGrid", /^minor 2\.5 major 25 /, "a 2.5 mm snap grid");
    await page.uncheck("#sketch-grid-snap");
    await shown(page, "sketchGrid", new RegExp(`^minor ${start.minor} `), "powers of ten again");
    await page.context().close();
  });

  await check("Look at after orbiting puts the camera back square onto the sketch", async () => {
    const page = await fresh();
    await startSketch(page);
    const box = await page.locator("#viewport canvas").boundingBox();
    // Orbit: a drag sideways turns the view about Z, so the x axis no longer runs where it did.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 + 120, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1200); // the damping runs out
    const p = screenPoint(box, [30, 0]);
    assert.ok(reddest(await pixels(page, p, 1, 7)) < 30, "orbiting left the x axis where it was, so this check could not fail");
    await page.click("#sketch-look-at");
    await settle(page);
    await probeSketchView(page, "after Look at");
    await page.context().close();
  });

  await check("sketching at 375 px with taps: the same axes, faded body and grid; Look at is a 44 px button; nothing wider than the screen", async () => {
    const page = await fresh(375, true);
    await startSketch(page, true);
    assert.equal(await data(page, "bodyFaded"), "true");
    await probeSketchView(page, "375");
    const box = await page.locator("#viewport canvas").boundingBox();
    assert.equal((await gridShown(page)).minor, expectedMinor(mmPerPixel(box)));
    const look = await page.locator("#sketch-look-at").boundingBox();
    assert.ok(look.height >= 44, `Look at is ${look.height} px tall`);
    await page.tap("#sketch-look-at");
    await settle(page);
    await probeSketchView(page, "375 after Look at");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    if (shots) await page.screenshot({ path: `${shots}/sketch-view-375.png`, fullPage: true });
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
