// Browser check that Design draws every body (step 24d3b): the default
// 40 × 30 × 20 box, then a 10 × 10 square sketched beside it at x 50 to 60
// and extruded by 10 (a second body, 24d1). Both are drawn (pixel probes on
// each top face), the view frames both, the browser's Bodies group lists
// Body 1 and Body 2, a click on either top face selects that body's face by
// its stable name, and Body 2's row tints only its own faces. The same at
// 375 px with taps. Screenshots go to E2E_SHOTS when set. Run with
// `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { clickPlane, screenPoint, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4205, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4205/";
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

const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));

/** Clicks (or taps) a model point as `view` sees it. */
async function at(page, p, view, tap) {
  const box = await page.locator("#viewport canvas").boundingBox();
  const s = screenPoint(box, p, view);
  const on = await page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y);
    return e?.tagName === "CANVAS" && e.closest("#viewport") ? "canvas" : e ? e.id || e.className || e.tagName : "nothing";
  }, [s.x, s.y]);
  if (on !== "canvas") throw new Error(`(${p}) is under ${on} on screen, not the canvas`);
  if (tap) await page.touchscreen.tap(s.x, s.y);
  else await page.mouse.click(s.x, s.y);
}

/** The colour of the canvas at a model point as `view` sees it. */
async function colourAt(page, p, view) {
  await page.waitForTimeout(200); // a frame or two to paint
  const box = await page.locator("#viewport canvas").boundingBox();
  const s = screenPoint(box, p, view);
  return page.evaluate(
    ([fx, fy]) => {
      const src = document.querySelector("#viewport canvas");
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      return Array.from(ctx.getImageData(Math.floor(src.width * fx), Math.floor(src.height * fy), 1, 1).data.slice(0, 3));
    },
    [(s.x - box.x) / box.width, (s.y - box.y) / box.height],
  );
}

// The canvas background and the body's grey-blue differ in every channel;
// the body colour is BASE_COLOUR (0x9a, 0xa7, 0xb8) lit, so "a body is
// here" is: not the background colour sampled in an empty corner.
const differs = (a, b) => a.some((x, i) => Math.abs(x - b[i]) > 12);
const green = ([r, g, b]) => g - (r + b) / 2;

const selection = (page) => page.evaluate(() => document.body.dataset.selection ?? "");
const bodyRows = (page) => page.$$eval('[data-node="bodies"] .tree-row', (rows) => rows.map((r) => `${r.dataset.node} ${r.textContent.trim()}`));

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

// The square sits where the sketch's top view shows it: beside the box at
// 1280 px; behind it at 375 px, where the view is narrow and tall (and the
// bottom of the screen is the navigation bar), extruded taller than the box
// so its top shows over it.
// Each layout's framing worked out by hand: the bounds' centre, and half
// their diagonal for the radius.
const LAYOUTS = [
  // [0, 60] × [0, 30] × [0, 20]: centre (30, 15, 10), radius √(60² + 30² + 20²)/2 = 35.
  // Body 2: 10 · 10 · 10 = 1,000 mm³.
  { width: 1280, tap: false, square: [[50, 0], [60, 0], [60, 10], [50, 10]], distance: 10, volume: "1,000 mm³", centre: [30, 15, 10], radius: 35, top2: [55, 5, 10] },
  // [0, 40] × [0, 50] × [0, 30]: centre (20, 25, 15), radius √(40² + 50² + 30²)/2 = √5000/2.
  // Body 2: 10 · 10 · 30 = 3,000 mm³; its top's middle (15, 45, 30) seen
  // along (0.6, −0.8, 0.55) passes y = 30 at z = 30 + 15/0.8 · 0.55 ≈ 40,
  // above the box, so it is in sight.
  { width: 375, tap: true, square: [[10, 40], [20, 40], [20, 50], [10, 50]], distance: 30, volume: "3,000 mm³", centre: [20, 25, 15], radius: Math.sqrt(5000) / 2, top2: [15, 45, 30] },
];

for (const { width, tap, square, distance, volume, centre, radius: want, top2 } of LAYOUTS) {
  await check(`two bodies drawn, framed, listed and picked (${width} px${tap ? ", taps" : ""})`, async () => {
    const page = await fresh(width, tap);
    // A 10 × 10 square by the rectangle tool: two opposite corners on the grid.
    await press(page, "#create-sketch", tap);
    await press(page, "#sketch-plane-XY", tap);
    await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching");
    await page.check("#sketch-grid-snap");
    await page.evaluate(() => (document.getElementById("workspace").scrollTop = 0));
    await press(page, "#sketch-tool-rectangle", tap);
    for (const p of [square[0], square[2]]) await clickPlane(page, p, TOP, tap);
    await until(page, () => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.", null, "the square closed");
    await press(page, "#sketch-extrude", tap);
    await page.fill("#extrude-distance", String(distance));
    await press(page, "#extrude-ok", tap);
    // The panel shows the part, the last body (LAYOUTS).
    await until(page, (v) => document.querySelector("#volume")?.textContent === v, volume, `the second body, ${volume}`);
    await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");

    // The panels may have scrolled the page at phone width: back to the top.
    await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
    // Framed on both (LAYOUTS).
    const radius = Number(await page.evaluate(() => document.querySelector("#viewport").dataset.framedRadius));
    assert.ok(Math.abs(radius - want) < 1e-6, `framed radius ${radius}, want ${want}`);
    const view = { toward: [0.6, -0.8, 0.55], up: [0, 0, 1], centre, radius: want };
    if (shots) await page.screenshot({ path: `${shots}/bodies-${width}.png` });

    // Both drawn: each top face's middle is not the background, sampled at
    // 60 mm under the middle of the floor, where no body is.
    const empty = await colourAt(page, [centre[0], centre[1], -60], view);
    const box1 = await colourAt(page, [20, 15, 20], view);
    const box2 = await colourAt(page, top2, view);
    assert.ok(differs(box1, empty), `body 1's top ${box1} looks like the background ${empty}`);
    assert.ok(differs(box2, empty), `body 2's top ${box2} looks like the background ${empty}`);

    // A click on each top face selects that body's top by name: the box is
    // feature-1; the extrude is the newest feature, after the sketch.
    await at(page, [20, 15, 20], view, tap);
    await until(page, () => document.body.dataset.selection === "face:feature-1/top", null, `body 1's top (got ${await selection(page)})`);
    await at(page, top2, view, tap);
    const picked = await selection(page);
    assert.match(picked, /^face:feature-\d+\/end$/, "body 2's top is its extrude's end cap");
    assert.notEqual(picked.split("/")[0], "face:feature-1");

    // Listed in build order, in the browser (a drawer at phone width,
    // opened for the rows and closed again before looking at the canvas).
    const fold = async (open) => {
      if (await page.isVisible("#browser-toggle")) {
        if ((await page.getAttribute("#browser-toggle", "aria-expanded")) !== String(open)) await press(page, "#browser-toggle", tap);
      } else if ((await page.$eval("#browser .browser-fold", (d) => d.open)) !== open) await press(page, "#browser .browser-fold > summary", tap);
    };
    await fold(true);
    await page.evaluate(() => document.querySelector('#browser [data-node="bodies"]')?.closest("details")?.setAttribute("open", ""));
    assert.deepEqual(await bodyRows(page), ["body-1 Body 1", "body-2 Body 2"]);

    // Body 2's row tints its faces, not body 1's.
    await press(page, '#browser [data-node="body-2"]', tap);
    await until(page, () => document.body.dataset.selection?.startsWith("body:"), null, "Body 2 selected");
    await fold(false);
    assert.notEqual(await selection(page), "body:feature-1");
    const lit1 = await colourAt(page, [20, 15, 20], view);
    const lit2 = await colourAt(page, top2, view);
    assert.ok(green(lit2) > green(box2) + 20, `body 2 tinted: ${lit2} vs ${box2}`);
    assert.ok(Math.abs(green(lit1) - green(box1)) < 6, `body 1 untouched: ${lit1} vs ${box1}`);
    if (shots) await page.screenshot({ path: `${shots}/bodies-${width}-selected.png` });
    if (width === 375) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways scrolling");
    await page.context().close();
  });
}

assert.deepEqual(errors, [], "no page errors");
await browser.close();
await server.close();
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
