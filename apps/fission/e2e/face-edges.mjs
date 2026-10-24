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
// 375 px with taps (the tap itself snaps; the circle is probed after the
// sketch is finished and opened again, which clears the tap's marks in
// every engine). Step 27b: a half disc (a file opened, its line (50, 0)
// to (70, 0) and the arc over it round (60, 0), extruded 10) has both
// its top corners offered, "edge endpoint 70,0" and "edge endpoint 50,0"
// (26f offered neither: they shared a name), each with a circle centred
// there and pinned; saved, its radius made 14 in the file and opened
// again, the circles are centred on (74, 0) and (46, 0), each on its own
// corner. Step 27c: a sketch on the XY plane snaps onto the box's corner
// (40, 30) (its bottom one, on XY, of the two seen there), pinned to
// Feature 1 and depending on it, and follows it when the box is typed 60
// wide; a sketch on the half disc's top (z = 10) snaps at (40, 30) onto
// the other body's upright's middle (on its plane, before the corners 10
// mm off it) and follows it when the box is made 60 wide in the file.
// Screenshots go to E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`); Firefox and
// WebKit in CI (`e2e:engines`).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";
import { pinProperties } from "./properties.mjs";

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
  await pinProperties(page); // the size boxes are in the panel, folded at the start on a wide screen (U0b)
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
/** No snap or preview shown, then two frames so the canvas shows it (as sketch-pixels.mjs waits). */
async function unmarked(page) {
  await shown(page, "sketchSnap", "");
  await shown(page, "sketchPreview", "");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
/**
 * Clears what the mouse leaves drawn (the snap marker and its guides
 * where it last was): onto the canvas and off it to the page's corner
 * (the canvas hears it leave), then nothing marked. Mouse runs only: in
 * a touch page Firefox gives the canvas no pointer events for
 * Playwright's mouse, so a tap's marks never clear this way (CI on
 * #235, twice); the tap runs finish the sketch and open it again
 * instead (`closeAndReopen`).
 */
async function pointerAway(page) {
  // The canvas's middle (its corners are under the View buttons and the view cube at 375 px), checked to be the canvas.
  const box = await canvasBox(page);
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  const on = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.tagName ?? "nothing", [x, y]);
  if (on !== "CANVAS") throw new Error(`the canvas's middle is under ${on}`);
  await page.mouse.move(x, y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.mouse.move(0, 0);
  await unmarked(page);
}
/** Finish Sketch (scrolled to the top first: at 375 px the bar is above the fold after a tap). */
async function finish(page, tap) {
  await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
  await press(page, "#finish-sketch", tap);
  await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
}
/** Sketch 1 (or the sketch `id`) opened again from its timeline row (a double click, or two taps), the camera still. */
async function reopen(page, tap, id = "sketch-2") {
  // The rebuild done and a frame drawn first: the timeline is drawn again with new elements when a rebuild comes back (0.26.11).
  await until(page, () => document.querySelector("#viewport").dataset.rebuilding !== "true", null, "rebuilt");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const item = page.locator(`#timeline [data-item="${id}"]`);
  await item.scrollIntoViewIfNeeded();
  if (tap) {
    const b = await item.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  } else await item.dblclick();
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "Sketch 1 open again");
  await settle(page);
}
/** A tap's marks gone with the sketch: finished, opened again, nothing marked (the circle is drawn blue only while open). */
async function closeAndReopen(page, id = "sketch-2") {
  await finish(page, true);
  await reopen(page, true, id);
  await unmarked(page);
}
/** The canvas colours in the 3 × 3 square round the world point `p`, for a failure's message. */
async function colours(page, img, p) {
  const box = await canvasBox(page);
  const s = toScreen(await camera(page), box, p);
  const [cx, cy] = [Math.round(s.x - box.x), Math.round(s.y - box.y)];
  const out = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const i = 4 * ((cy + dy) * img.width + cx + dx);
      out.push(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
    }
  return `canvas (${cx}, ${cy}) of ${img.width} × ${img.height}: ${out.join(" ")}`;
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
    if (!(await lineNear(page, img, rim))) assert.fail(`${what}: the rim's blue at [${rim}]; ${await colours(page, img, rim)}`);
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

/** Feature 1, the 40 × 30 × 20 box; Sketch 1 on XY, the line (50, 0) → (70, 0) and the arc from (70, 0) counter-clockwise round (60, 0) back; Extrude 1 by 10. */
/** The project saved (Save, behind Menu at 375 px), as JSON. */
async function saveFile(page, tap) {
  if (!(await page.isVisible("#save"))) await press(page, "#menu-toggle", tap);
  const [download] = await Promise.all([page.waitForEvent("download"), press(page, "#save", tap)]);
  return JSON.parse(readFileSync(await download.path(), "utf8"));
}
/** Waits for the part's volume to read like `pattern`, saying what it read on failure. */
const volumeLike = (page, pattern, what) =>
  until(page, (p) => new RegExp(p).test(document.querySelector("#volume")?.textContent ?? ""), pattern.source, what).catch(async (e) => assert.fail(`${e.message} (volume: "${await page.textContent("#volume")}")`));
const HALF_DISC = {"version":3,"nextId":9,"profiles":[],"sketches":[{"id":"sketch-2","points":[{"id":"point-3","x":50,"y":0},{"id":"point-4","x":70,"y":0},{"id":"point-6","x":60,"y":0}],"curves":[{"id":"line-5","kind":"line","start":"point-3","end":"point-4"},{"id":"arc-7","kind":"arc","start":"point-4","end":"point-3","centre":"point-6"}],"constraints":[]}],"timeline":{"features":[{"id":"feature-1","intent":{"type":"box","parameters":{"width":40,"depth":30,"height":20},"summary":"Box: 40 × 30 × 20 mm"},"provenance":{"self":{"workspace":"design","id":"feature-1","label":"Feature 1 (box)"},"from":[]},"dependsOn":[],"suppressed":false},{"id":"sketch-2","intent":{"type":"sketch","parameters":{"plane":"XY"},"summary":"Sketch 1 on the XY plane"},"provenance":{"self":{"workspace":"design","id":"sketch-2","label":"Sketch 1"},"from":[]},"dependsOn":[],"suppressed":false},{"id":"feature-8","intent":{"type":"extrude","parameters":{"sketch":"sketch-2","distance":10},"summary":"Extrude Sketch 1 by 10 mm"},"provenance":{"self":{"workspace":"design","id":"feature-8","label":"Extrude 1"},"from":[{"workspace":"design","id":"sketch-2","label":"Sketch 1"}]},"dependsOn":["sketch-2"],"suppressed":false}]}};

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
      await (tap ? closeAndReopen(page) : pointerAway(page));
      await circleDrawn(page, [40, 30], "drawn round the corner");
      await shot(page, `face-edges-circle-${width}`);
      await finish(page, tap);
      // The box 60 wide, typed: the corner moves to (60, 30), and the circle's centre with it.
      await page.fill("#width", "60");
      await until(page, () => document.querySelector("#volume")?.textContent === "36,000 mm³", null, "60 × 30 × 20 = 36,000 mm³");
      await reopen(page, tap);
      assert.equal(await data(page, "sketchPoints"), "60,30", "the centre followed the corner");
      // Opened from the timeline: a tap run hasn't touched the canvas since it finished; a mouse run's pointer may still be over it.
      await (tap ? unmarked(page) : pointerAway(page));
      await circleDrawn(page, [60, 30], "drawn round the moved corner");
      // Not round where it was: the old rim's points are on the top's face now, no blue there.
      const img = await canvasImage(page);
      for (const p of [[43, 34, 20], [37, 26, 20]]) assert.equal(await lineNear(page, img, p), false, `no rim left at [${p}]`);
      await shot(page, `face-edges-followed-${width}`);
      await page.context().close();
    });
  }
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px${tap ? " with taps" : ""}: a half disc's two top corners are both offered and each pinned, and each circle follows its own corner when the radius is made 14 (27b)`, async () => {
      const page = await fresh(width, tap);
      const project = await saveFile(page, tap);
      project.workspaces.design = structuredClone(HALF_DISC);
      const open = (p) => page.setInputFiles("#open-file", { name: "half-disc.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(p)) });
      await open(project);
      // The part is the half disc, its volume worked from the exact body: ½ π 10² · 10 = 500π = 1,570.796327 mm³.
      await volumeLike(page, /^1,570\.796327 mm³$/, "the half disc");
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      // The half disc's top, z = 10, well inside it.
      await at(page, [60, 4, 10], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the half disc's top");
      await settle(page);
      await press(page, "#sketch-tool-circle", tap);
      const half = 5 * (await mmPerPixel(page));
      // Half a snap reach inside each corner, up the arc's side: Q (70, 0) then P (50, 0), each shown as its own corner.
      for (const [x, inward] of [[70, -1], [50, 1]]) {
        const near = [x + inward * half * 0.6, half * 0.8, 10];
        if (!tap) {
          await hover(page, near);
          await shown(page, "sketchSnap", `edge endpoint ${x},0`);
          if (x === 70) await shot(page, `half-disc-corner-snap-${width}`);
        }
        await at(page, near, tap);
        await until(page, (w) => (document.querySelector("#viewport").dataset.sketchPoints ?? "").endsWith(w), `${x},0`, `a centre on (${x}, 0)`);
        // The rim through (x, −3): below the half disc, clear of its corners' snaps. Drawn once the click has landed (the kernel
        // may answer late, E2E_KERNEL_DELAY): more lines drawn than before it (a finished circle's), recorded as Draw circle.
        const lines = Number(await data(page, "sketchLines"));
        await at(page, [x, -3, 10], tap);
        await until(page, (n) => Number(document.querySelector("#viewport").dataset.sketchLines) > n && document.querySelector("#undo").title.startsWith("Undo Draw circle"), lines, "the circle drawn");
      }
      assert.equal(await data(page, "sketchPoints"), "70,0 50,0");
      await (tap ? closeAndReopen(page, "sketch-9") : pointerAway(page));
      await shot(page, `half-disc-circles-${width}`);
      await finish(page, tap);
      // Saved (both pins in it), the half disc made radius 14 in the file: P to (46, 0), Q to (74, 0), the centre at (60, 0).
      const file = await saveFile(page, tap);
      const design = file.workspaces.design;
      const pins = design.sketches.find((x) => x.id === "sketch-9").pins;
      assert.equal(pins.length, 2, `both centres pinned: ${JSON.stringify(design.sketches.find((x) => x.id === "sketch-9"))}`);
      assert.notEqual(pins[0].name, pins[1].name, "each to a corner of its own");
      for (const pt of design.sketches.find((x) => x.id === "sketch-2").points) if (pt.y === 0 && pt.x !== 60) pt.x = pt.x < 60 ? 46 : 74;
      await open(file);
      await volumeLike(page, /^3,078\.760801 mm³$/, "the half disc of radius 14: ½ π 14² · 10 = 980π = 3,078.760801 mm³");
      await reopen(page, tap, "sketch-9");
      assert.equal(await data(page, "sketchPoints"), "74,0 46,0", "each centre followed its own corner");
      await shot(page, `half-disc-followed-${width}`);
      await page.context().close();
    });
  }
  /**
   * A circle of radius 5 drawn with its centre clicked half a snap reach in from the world point `corner` (down and left on screen,
   * on the sketch's plane at height `z`), its rim through `rim`: the centre lands on (cx, cy), recorded as Draw circle.
   */
  async function circleOn(page, tap, [cx, cy], z, label, rim) {
    await press(page, "#sketch-tool-circle", tap);
    const half = 5 * (await mmPerPixel(page));
    const near = [cx - half * 0.6, cy - half * 0.8, z];
    if (!tap) {
      await hover(page, near);
      await shown(page, "sketchSnap", label);
    }
    await at(page, near, tap);
    await until(page, (w) => (document.querySelector("#viewport").dataset.sketchPoints ?? "").endsWith(w), `${cx},${cy}`, `a centre on (${cx}, ${cy})`);
    const lines = Number(await data(page, "sketchLines"));
    await at(page, rim, tap);
    await until(page, (n) => Number(document.querySelector("#viewport").dataset.sketchLines) > n && document.querySelector("#undo").title.startsWith("Undo Draw circle"), lines, "the circle drawn");
  }
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px${tap ? " with taps" : ""}: a sketch on the XY plane snaps onto the box's corner (27c); its circle is pinned to Feature 1, which it then depends on, and follows the corner to (60, 30)`, async () => {
      const page = await fresh(width, tap);
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await press(page, "#sketch-plane-XY", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on XY");
      await settle(page);
      // The box's back right corners (40, 30, 0) and (40, 30, 20) are one place seen from above; the bottom one is on XY, so it is taken.
      await circleOn(page, tap, [40, 30], 0, "edge endpoint 40,30", [35, 30, 0]);
      assert.equal(await data(page, "sketchPoints"), "40,30");
      if (!tap) await pointerAway(page);
      await shot(page, `body-pins-xy-${width}`);
      await finish(page, tap);
      const file = await saveFile(page, tap);
      const design = file.workspaces.design;
      const item = design.timeline.features.find((f) => f.id === "sketch-2");
      assert.deepEqual(item.dependsOn, ["feature-1"], "the sketch depends on the box it is pinned to");
      const pins = design.sketches.find((s) => s.id === "sketch-2").pins;
      assert.equal(pins.length, 1);
      assert.equal(pins[0].feature, "feature-1", `pinned to the box: ${JSON.stringify(pins)}`);
      assert.equal(pins[0].kind, "endpoint");
      // The bottom one, where the back (y = 30), right (x = 40) and bottom (z = 0) faces meet, not the top's.
      assert.equal(pins[0].name, "back+bottom&back+right&bottom+right", "the corner on XY");
      // The box 60 wide, typed: the corner, seen from above, moves to (60, 30), and the circle's centre with it.
      await page.fill("#width", "60");
      await until(page, () => document.querySelector("#volume")?.textContent === "36,000 mm³", null, "60 × 30 × 20 = 36,000 mm³");
      await reopen(page, tap);
      assert.equal(await data(page, "sketchPoints"), "60,30", "the centre followed the box's corner");
      await shot(page, `body-pins-xy-followed-${width}`);
      await page.context().close();
    });
  }
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px${tap ? " with taps" : ""}: a sketch on the half disc's top snaps onto the other body's upright's middle on its plane (27c), and follows it when the box is made 60 wide in the file`, async () => {
      const page = await fresh(width, tap);
      const project = await saveFile(page, tap);
      project.workspaces.design = structuredClone(HALF_DISC);
      const open = (p) => page.setInputFiles("#open-file", { name: "half-disc.fission.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(p)) });
      await open(project);
      await volumeLike(page, /^1,570\.796327 mm³$/, "the half disc");
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await at(page, [60, 4, 10], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the half disc's top");
      await settle(page);
      // The box's back right upright, on a body the sketch is not on, seen from above at (40, 30): its corners (40, 30, 0) and
      // (40, 30, 20) are 10 mm off the sketch's plane (z = 10), its middle (40, 30, 10) is on it, so the middle is taken. The rim
      // through (35, 30) on the sketch's plane.
      await circleOn(page, tap, [40, 30], 10, "edge midpoint 40,30", [35, 30, 10]);
      assert.equal(await data(page, "sketchPoints"), "40,30");
      if (!tap) await pointerAway(page);
      await shot(page, `body-pins-other-body-${width}`);
      await finish(page, tap);
      const file = await saveFile(page, tap);
      const design = file.workspaces.design;
      const item = design.timeline.features.find((f) => f.id === "sketch-9");
      assert.deepEqual(item.dependsOn, ["feature-8", "feature-1"], "on the half disc's face, pinned to the box");
      const pin = design.sketches.find((s) => s.id === "sketch-9").pins[0];
      assert.equal(pin.feature, "feature-1");
      assert.equal(pin.kind, "midpoint", `the upright's middle, on the sketch's plane: ${JSON.stringify(pin)}`);
      // The box made 60 wide in the file and opened: the half disc is the same (its volume), the centre follows the box's corner.
      design.timeline.features.find((f) => f.id === "feature-1").intent.parameters.width = 60;
      await open(file);
      await until(page, () => document.querySelector("#viewport").dataset.rebuilding !== "true", null, "rebuilt");
      await volumeLike(page, /^1,570\.796327 mm³$/, "the half disc, unchanged");
      await reopen(page, tap, "sketch-9");
      assert.equal(await data(page, "sketchPoints"), "60,30", "the centre followed the other body's corner");
      await shot(page, `body-pins-other-body-followed-${width}`);
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
