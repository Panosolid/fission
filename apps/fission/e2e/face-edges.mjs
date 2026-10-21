// Browser check of snapping onto a face's edges (step 26f, the owner's
// answer Q4): in a sketch on a 40 × 30 × 20 box's top, the pointer near
// the top's back right corner shows "edge endpoint 40,30" and near the
// right edge's middle "edge midpoint 40,15", and nothing two snap reaches
// off; the face's edges are not drawn into the sketch. A circle of radius
// 5 centred on the corner (its rim drawn there, pixel probes, the same
// probes 1 mm in failing); then, out of the sketch, the box typed 60
// wide: opened again, the circle's centre is at (60, 30) and its rim is
// drawn round it, not round (40, 30). Points on screen come from the
// app's own camera (?test-hooks) through the pinhole sums worked here, as
// face-sketch.mjs does. 1280 px with a mouse (hover, then click) and
// 375 px with taps (the tap itself snaps). Screenshots go to E2E_SHOTS
// when set. Run with `npm run e2e` (after `npm run build`); Firefox and
// WebKit in CI (`e2e:engines`).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4196, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4196/?test-hooks";
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
const shown = (page, key, want) => until(page, ([k, w]) => document.querySelector("#viewport").dataset[k] === w, [key, want], `${key} "${want}"`).catch(async (e) => assert.fail(`${e.message} (shown: "${await data(page, key)}")`));
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
/** Millimetres per screen pixel on the plane the camera looks straight down at: the view's height spans 2 · distance · tan(22.5°). */
async function mmPerPixel(page) {
  const cam = await camera(page);
  const d = sub(cam.position, cam.target);
  return (2 * Math.sqrt(dot(d, d)) * T) / (await canvasBox(page)).height;
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
/** Moves the mouse over the world point `p`. */
async function hover(page, p) {
  const s = toScreen(await camera(page), await canvasBox(page), p);
  await page.mouse.move(s.x, s.y);
}

/** The WebGL canvas's own pixels (it keeps its drawing buffer). */
async function canvasImage(page) {
  const u = await page.evaluate(() => document.querySelector("#viewport canvas").toDataURL("image/png"));
  return decodePng(Buffer.from(u.slice(u.indexOf(",") + 1), "base64"));
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
/**
 * The circle of radius 5 round (cx, cy) on the top (z = 20), by pixel
 * probes: its rim's blue at the four diagonal points c + 5 · (±0.6, ±0.8)
 * (off the box's edges, which run through the corner it is centred on),
 * and none 1 mm inside the rim there, c + 4 · (±0.6, ±0.8): the drawing
 * moved or shrunk by 1 mm fails it.
 */
async function circleDrawn(page, [cx, cy], what) {
  const img = await canvasImage(page);
  for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const rim = [cx + 5 * 0.6 * sx, cy + 5 * 0.8 * sy, 20];
    const inside = [cx + 4 * 0.6 * sx, cy + 4 * 0.8 * sy, 20];
    assert.ok(await lineNear(page, img, rim), `${what}: the rim's blue at [${rim}]`);
    assert.equal(await lineNear(page, img, inside), false, `${what}: no blue 1 mm inside the rim, at [${inside}]`);
  }
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
    await check(`${width} px${tap ? " with taps" : ""}: on the box's top the pointer snaps onto the top's corner and an edge's middle; a circle centred on the corner is drawn there, and after the box is typed 60 wide it is centred on (60, 30)`, async () => {
      const page = await fresh(width, tap);
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the top");
      await settle(page);
      // The face's edges are not drawn into the sketch: it has no lines.
      assert.equal(await data(page, "sketchLines"), "0");
      await press(page, "#sketch-tool-circle", tap);
      // Half a snap reach (SNAP_PIXELS = 10 px) from the corner, down and left on screen: the corner is shown and taken.
      const half = 5 * (await mmPerPixel(page));
      const nearCorner = [40 - half * 0.6, 30 - half * 0.8, 20];
      if (!tap) {
        await hover(page, nearCorner);
        await shown(page, "sketchSnap", "edge endpoint 40,30");
        await shot(page, `face-edges-corner-snap-${width}`);
        // The right edge's middle, half a reach to its right.
        await hover(page, [40 + half, 15, 20]);
        await shown(page, "sketchSnap", "edge midpoint 40,15");
        // Two reaches from the corner, along the top's diagonal (away from both edges and every middle): nothing.
        const far = 20 * (await mmPerPixel(page));
        await hover(page, [40 - far * 0.8, 30 - far * 0.6, 20]);
        await shown(page, "sketchSnap", "");
      }
      await at(page, nearCorner, tap);
      // The centre exactly on the corner; the rim through (35, 30): left of it, clear of the typed boxes that float right of and below a
      // tap (and of the view cube, top right at 375 px).
      await shown(page, "sketchPoints", "40,30");
      await at(page, [35, 30, 20], tap);
      await until(page, () => document.querySelector("#undo").title.startsWith("Undo Draw circle"), null, "Draw circle recorded");
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await circleDrawn(page, [40, 30], "drawn round the corner");
      await shot(page, `face-edges-circle-${width}`);
      await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
      await press(page, "#finish-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
      // The box 60 wide, typed: the corner moves to (60, 30), and the circle's centre with it.
      await page.fill("#width", "60");
      await until(page, () => document.querySelector("#volume")?.textContent === "36,000 mm³", null, "60 × 30 × 20 = 36,000 mm³");
      const item = page.locator('#timeline [data-item="sketch-2"]');
      await item.scrollIntoViewIfNeeded();
      if (tap) {
        const b = await item.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      } else await item.dblclick();
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "Sketch 1 open again");
      await settle(page);
      assert.equal(await data(page, "sketchPoints"), "60,30", "the centre followed the corner");
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await circleDrawn(page, [60, 30], "drawn round the moved corner");
      // Not round where it was: the old rim's points are on the top's face now, no blue there.
      const img = await canvasImage(page);
      for (const p of [[43, 34, 20], [37, 26, 20]]) assert.equal(await lineNear(page, img, p), false, `no rim left at [${p}]`);
      await shot(page, `face-edges-followed-${width}`);
      await page.context().close();
    });
  }
  assert.deepEqual(errors, [], "no page errors");
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed > 0) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
