// Browser check that sketches are drawn where the maths says (testing
// catch-up TC3): the numbers can be right while the picture is wrong, so
// this looks at the canvas's pixels.
//
// 1. Pixel probes, in every browser: a rectangle, a chain of two lines and
//    a circle are drawn by clicks; along each, where sketch-screen.mjs puts
//    it on screen, there must be sketch-line pixels (blue: blue minus red
//    at least BLUE, which the line colour 0x6cc4ff and any blend of it at
//    least a third strong pass, and the grid, box, points and preview
//    don't); 8 px to either side, away from every other curve, there must
//    be none. The same probes for the drawing moved 1 mm must fail, so
//    they can.
// 2. Golden images, Chromium only (other engines draw lines a little
//    differently): the canvas while drawing and after Finish, compared
//    with e2e/screenshots/*.png: at most MAX_PIXELS pixels may differ by
//    more than CHANNEL in any channel, the view cube's corner left out (its
//    label's text depends on the fonts). The same image moved 2 px must fail.
//    E2E_UPDATE_SHOTS=1 rewrites the files; a failure writes the actual
//    and a diff image (red where different) next to them as *.actual.png
//    and *.diff.png, for CI to keep.
// Run with `npm run e2e` (after `npm run build`); E2E_BROWSER picks the browser.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { preview } from "vite";
import { browserName, launch } from "./browser.mjs";
import { compareImages, decodePng, encodePng } from "./png.mjs";
import { clickPlane, screenPoint, TOP } from "./sketch-screen.mjs";

const server = await preview({ preview: { port: 4193, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4193/";
const browser = await launch();
const update = process.env.E2E_UPDATE_SHOTS === "1";
const shotsDir = new URL("./screenshots/", import.meta.url);

const BLUE = 60;
/** Golden-image tolerance: a pixel differs past CHANNEL (of 255) in any channel; at most MAX_PIXELS may. */
const CHANNEL = 32;
const MAX_PIXELS = 50;
/** The view cube, drawn into the canvas's top right corner with text from the fonts installed: left out (the smoke test checks it). Measured from the right edge, so a wider view (SF3d) still leaves out the cube. */
const ignoreFor = (width) => [{ x: width - 120, y: 0, width: 120, height: 120 }];

// The drawing, in sketch millimetres: clear of the view cube, the box's edges and each other.
const RECT = [[10, 10], [30, 20]];
const CHAIN = [[-10, -10], [40, -10], [50, 10]];
const CIRCLE = { centre: [0, 30], through: [10, 30] };
/** Every curve as sample points in mm: lines from t = 0.15 to 0.85 (clear of the corner dots), the circle all round. */
function curves(shift = 0) {
  const s = ([x, y]) => [x + shift, y];
  const [a, c] = RECT;
  const rect = [a, [c[0], a[1]], c, [a[0], c[1]]];
  const lines = [...rect.map((p, i) => [p, rect[(i + 1) % 4]]), [CHAIN[0], CHAIN[1]], [CHAIN[1], CHAIN[2]]];
  const r = CIRCLE.through[0] - CIRCLE.centre[0];
  const out = lines.map(([p, q]) => ({ name: `line ${p} → ${q}`, at: (t) => s([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]), ts: Array.from({ length: 15 }, (_, i) => 0.15 + (0.7 * i) / 14) }));
  out.push({ name: `circle round ${CIRCLE.centre}, r ${r}`, at: (t) => s([CIRCLE.centre[0] + r * Math.cos(2 * Math.PI * t), CIRCLE.centre[1] + r * Math.sin(2 * Math.PI * t)]), ts: Array.from({ length: 24 }, (_, i) => i / 24) });
  return out;
}

const isLine = (img, x, y) => {
  const i = 4 * (y * img.width + x);
  return img.data[i + 2] - img.data[i] >= BLUE;
};
/** Whether a sketch-line pixel is within 1 px (a 3 × 3 square) of canvas point (x, y). */
const lineNear = (img, x, y) => {
  const [cx, cy] = [Math.round(x), Math.round(y)];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (isLine(img, cx + dx, cy + dy)) return true;
  return false;
};

/** The probes' failures for the drawing as `curves(shift)` places it: lines missing where they should be, or found where none should be. */
function probe(img, box, shift = 0) {
  const toCanvas = ([x, y]) => {
    const p = screenPoint(box, [x, y, 0], TOP);
    return [p.x - box.x, p.y - box.y];
  };
  const all = curves(shift);
  // Every curve's points on screen, finely, to keep the "none here" probes away from all of them.
  const dense = all.flatMap((c) => Array.from({ length: 200 }, (_, i) => toCanvas(c.at(i / 199))));
  const misses = [];
  for (const c of all)
    for (const t of c.ts) {
      const [x, y] = toCanvas(c.at(t));
      if (!lineNear(img, x, y)) misses.push(`${c.name}: no line at t = ${t.toFixed(2)}, (${x.toFixed(1)}, ${y.toFixed(1)}) px`);
      // 8 px to each side, square to the curve.
      const [x2, y2] = toCanvas(c.at(t + 0.001));
      const len = Math.hypot(x2 - x, y2 - y);
      for (const side of [-8, 8]) {
        const [px, py] = [x + (side * -(y2 - y)) / len, y + (side * (x2 - x)) / len];
        if (dense.some(([qx, qy]) => Math.hypot(qx - px, qy - py) < 6)) continue;
        if (lineNear(img, px, py)) misses.push(`${c.name}: a line 8 px off it at t = ${t.toFixed(2)}, (${px.toFixed(1)}, ${py.toFixed(1)}) px`);
      }
    }
  return misses;
}

/** Compares a canvas image with its golden file (or writes it); returns the failure, or null. */
function golden(name, img) {
  const file = new URL(`${name}.png`, shotsDir);
  if (update || !existsSync(file)) {
    if (!update) return `${name}.png is missing: run with E2E_UPDATE_SHOTS=1 to write it, and look at it before committing`;
    mkdirSync(shotsDir, { recursive: true });
    writeFileSync(file, encodePng(img));
    console.log(`  wrote e2e/screenshots/${name}.png`);
    return null;
  }
  const want = decodePng(readFileSync(file));
  const result = compareImages(want, img, { channel: CHANNEL, maxPixels: MAX_PIXELS, ignore: ignoreFor(want.width) });
  if (result.ok) return null;
  writeFileSync(new URL(`${name}.actual.png`, shotsDir), encodePng(img));
  // In CI, the actual image in the log too, so a baseline from the CI browser can be taken from it.
  if (process.env.CI) console.log(`BEGIN ${name}.actual.png base64\n${encodePng(img).toString("base64")}\nEND ${name}.actual.png`);
  if (result.diff) writeFileSync(new URL(`${name}.diff.png`, shotsDir), encodePng(result.diff));
  return `${name}: ${result.sizes ?? `${result.differing} pixels differ by more than ${CHANNEL}`} (at most ${MAX_PIXELS}); see e2e/screenshots/${name}.actual.png and .diff.png`;
}

/** The WebGL canvas's own pixels (it keeps its drawing buffer), without the buttons and view cube over it. */
async function canvasImage(page) {
  const url = await page.evaluate(() => document.querySelector("#viewport canvas").toDataURL("image/png"));
  return decodePng(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}

/** The image moved `dx` px to the right (the left columns repeated), for the must-fail check. */
function moved(img, dx) {
  const data = Buffer.alloc(img.data.length);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) img.data.copy(data, 4 * (y * img.width + x), 4 * (y * img.width + Math.max(0, x - dx)), 4 * (y * img.width + Math.max(0, x - dx)) + 4);
  return { width: img.width, height: img.height, data };
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

const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url + "#design");
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  // The canvas's size comes from the bars above it, whose height follows the fonts installed (CI's are
  // a pixel shorter): pin them, so the canvas is 1280 × 678 everywhere (980 × 678 before U0b floated the properties, 760 × 710 before SF3d) and the golden images line up.
  await page.addStyleTag({ content: "#topbar, #toolbar { height: 45px !important; min-height: 0 !important; overflow: hidden; }" });
  await page.click("#create-sketch");
  await page.click("#sketch-plane-XY");
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
  // The drawing is on the grid: grid snap is off by default since SF1, and Firefox's clicks land on whole pixels.
  await page.check("#sketch-grid-snap");
  await page.mouse.move(0, 0);
  // Each tool's clicks are waited for before the next key: a key pressed while a click is still being
  // snapped would take that click (see the TC2 finding in docs/progress/cad.md).
  const segments = (n) => page.waitForFunction((k) => document.querySelector("#viewport").dataset.sketchLines === k, String(n), { timeout: 5000 });
  await page.keyboard.press("r");
  for (const p of RECT) await clickPlane(page, p);
  await segments(4);
  await page.keyboard.press("l");
  for (const p of CHAIN) await clickPlane(page, p);
  await segments(6);
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await clickPlane(page, CIRCLE.centre);
  await clickPlane(page, CIRCLE.through);
  // 4 + 2 lines and a circle of 64 segments; then the pointer off the canvas, so no preview is drawn.
  await segments(70);
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketchPreview === "");
  const box = await page.locator("#viewport canvas").boundingBox();
  // Two frames, so the last drawing is on screen.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const editing = await canvasImage(page);

  await check(`${browserName}: every line and the circle are drawn where the maths puts them, and nothing beside them`, () => {
    const misses = probe(editing, box);
    assert.deepEqual(misses, [], `${misses.length} probe(s) failed:\n${misses.slice(0, 10).join("\n")}`);
  });
  await check(`${browserName}: the probes catch the same drawing moved 1 mm (they can fail)`, () => {
    const misses = probe(editing, box, 1);
    assert.ok(misses.length >= 20, `only ${misses.length} probes noticed a 1 mm move`);
  });

  if (browserName === "chromium") {
    await check("chromium: the canvas while drawing matches its golden image", () => {
      const why = golden("sketch-editing-chromium", editing);
      assert.equal(why, null, why);
    });
    await check("chromium: the golden image comparison catches the canvas moved 2 px (it can fail)", () => {
      const want = decodePng(readFileSync(new URL("sketch-editing-chromium.png", shotsDir)));
      const r = compareImages(want, moved(editing, 2), { channel: CHANNEL, maxPixels: MAX_PIXELS, ignore: ignoreFor(want.width) });
      assert.ok(!r.ok && r.differing > 10 * MAX_PIXELS, `a 2 px move changed only ${r.differing} pixels`);
    });
    await page.click("#sketch-finish");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "false");
    await page.mouse.move(0, 0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const finished = await canvasImage(page);
    await check("chromium: the canvas after Finish sketch matches its golden image", () => {
      const why = golden("sketch-finished-chromium", finished);
      assert.equal(why, null, why);
    });
  }
  await check("no errors in the console", () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} sketch pixel check(s) failed`);
  process.exit(1);
}
