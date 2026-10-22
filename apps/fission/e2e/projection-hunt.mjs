// Browser checks from the step-27e bug hunt (projected edges), each failing
// before its fix, at 1280 px and at 375 px with taps:
// - a line drawn from a projected point (an upright of the box seen end on
//   from the ground plane) shares that point, and the project then could
//   not be opened again: Redo and a reload each refused it ("made point-n,
//   which is not … a point no curve is drawn from"). Now Undo, Redo and a
//   reload bring it back as it was.
// - a rectangle traced over the box's top projected into a sketch on it
//   made four ends meet at every corner, so the sketch said "not closed";
//   now it is "a closed outline", and it extrudes.
// The helpers are projection.mjs's. Run with `npm run e2e` after `npm run
// build`; Firefox and WebKit in CI (`e2e:engines`).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4234, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4234/?test-hooks";
const browser = await launch();
const errors = [];
/** Every context a check opened, closed when it ends, passed or failed, so a failed one's page can't go on erroring into the next. */
const contexts = [];
const shots = process.env.E2E_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

async function fresh(width = 1280, touch = false) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: touch });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // A store of its own, emptied once, so a reload later finds what autosave kept.
  await page.goto(url + "#design");
  await page.evaluate(() => new Promise((r) => { localStorage.clear(); const q = indexedDB.deleteDatabase("fission"); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

const data = (page, key) => page.evaluate((k) => document.querySelector("#viewport").dataset[k] ?? "", key);
const until = (page, fn, arg, what) => page.waitForFunction(fn, arg, { timeout: 8000 }).catch(async () => assert.fail(`${what}: timed out`));
const shown = (page, key, want) => until(page, ([k, w]) => document.querySelector("#viewport").dataset[k] === w, [key, want], `${key} "${want}"`).catch(async (e) => assert.fail(`${e.message} (shown: "${await data(page, key)}")`));
const camera = (page) => page.evaluate(() => window.fissionTest.camera());
const canvasBox = (page) => page.locator("#viewport canvas").boundingBox();
const press = (page, sel, tap) => (tap ? page.tap(sel) : page.click(sel));
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

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
/**
 * The projected colour (0xc77dff: red 199, green 125, blue 255), whole or
 * blended into the dark background where a thin line straddles pixels,
 * within 1 px of the world point `p`: blue and red both well above green.
 * The sketch's blue (0x6cc4ff) has red below green, the grid and the body
 * are grey, and the red axis has blue below green.
 */
async function violetNear(page, img, p) {
  const box = await canvasBox(page);
  const s = toScreen(await camera(page), box, p);
  const [cx, cy] = [Math.round(s.x - box.x), Math.round(s.y - box.y)];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const i = 4 * ((cy + dy) * img.width + cx + dx);
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (b - g >= 50 && r - g >= 25) return true;
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
/** Finish Sketch (scrolled to the top first: at 375 px the bar is above the fold after a tap). */
async function finish(page, tap) {
  await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
  await press(page, "#finish-sketch", tap);
  await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
}
/** The sketch opened again from its timeline row (a double click, or two taps). */
async function reopen(page, tap, id = "sketch-2") {
  await until(page, () => document.querySelector("#viewport").dataset.rebuilding !== "true", null, "rebuilt");
  await frames(page);
  const item = page.locator(`#timeline [data-item="${id}"]`);
  await item.scrollIntoViewIfNeeded();
  if (tap) {
    const b = await item.boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  } else await item.dblclick();
  await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "the sketch open again");
  await settle(page);
}
/** The mouse off the canvas (a mouse run), so nothing it lit stays lit; then two frames. */
async function pointerAway(page) {
  await page.mouse.move(0, 0);
  await frames(page);
}
/** The edges' four middles, and a point 1 mm inside the face from each, on the top (z = 20) of a box `w` wide. */
const middles = (w) => [[w / 2, 0], [w, 15], [w / 2, 30], [0, 15]];
const inside = (w) => [[w / 2, 1], [w - 1, 15], [w / 2, 29], [1, 15]];
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
/** Violet along each projected edge's middle, and none 1 mm inside the face from it. */
async function edgesDrawn(page, w, what) {
  const img = await canvasImage(page);
  for (const [x, y] of middles(w)) if (!(await violetNear(page, img, [x, y, 20]))) assert.fail(`${what}: violet on the edge at (${x}, ${y}); ${await colours(page, img, [x, y, 20])}`);
  for (const [x, y] of inside(w)) assert.equal(await violetNear(page, img, [x, y, 20]), false, `${what}: no violet 1 mm inside, at (${x}, ${y})`);
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
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
}
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
const status = (page) => page.evaluate(() => document.querySelector("#sketch-status")?.textContent ?? "");
/** The Project tool, by P (mouse) or its button (taps). */
async function projectTool(page, tap) {
  if (tap) await press(page, "#sketch-tool-project", tap);
  else await page.keyboard.press("p");
  await shown(page, "sketchPicks", "true");
}
/** Another sketch tool by its button (taps) or key. */
async function tool(page, name, key, tap) {
  if (tap) await press(page, `#sketch-tool-${name}`, tap);
  else await page.keyboard.press(key);
}

try {
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px${tap ? " with taps" : ""}: a line drawn from an upright projected as a point survives Undo, Redo and a reload`, async () => {
      const page = await fresh(width, tap);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await press(page, "#sketch-plane-XY", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on XY");
      await settle(page);
      // Turned to the home view so the box's uprights can be clicked; the front right one, (40, 0, 0) to (40, 0, 20).
      await press(page, '[data-view="home"]', tap);
      await settle(page);
      await projectTool(page, tap);
      if (!tap) {
        await hover(page, [40, 0, 10]);
        await until(page, () => (document.querySelector("#viewport").dataset.hover ?? "").startsWith("edge "), null, "the upright lit");
      }
      await at(page, [40, 0, 10], tap);
      await shown(page, "sketchProjected", "1");
      assert.equal(await data(page, "sketchPoints"), "40,0", "seen end on: one point at (40, 0)");
      // Looking down again, a line from that point (the snap shares it) to (20, 10).
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await tool(page, "line", "l", tap);
      await at(page, [40, 0, 0], tap);
      await at(page, [20, 10, 0], tap);
      await shown(page, "sketchLines", "1");
      // Two points, not three: the line's start is the projected point itself, not a new one on top of it. (Its free end is
      // where the click landed, which in WebKit is not always the whole pixel asked for, so only the shared one is checked.)
      const points = (await data(page, "sketchPoints")).split(" ");
      assert.ok(points.length === 2 && points.includes("40,0"), `the line starts on the projected point itself: ${points}`);
      await shot(page, `projection-hunt-point-${width}`);
      await finish(page, tap);
      // Undo the line and Redo it: the project goes through save and open each time.
      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+Shift+z");
      await until(page, () => document.querySelector("#undo").title.startsWith("Undo"), null, "redone");
      assert.equal(await page.evaluate(() => document.querySelector("#error")?.textContent ?? ""), "", "no error after Redo");
      // Reloaded once autosave has kept it and the kernel is idle (WebKit reports fetches a reload cuts off as page errors).
      await until(page, () => document.querySelector("#viewport").dataset.rebuilding !== "true", null, "rebuilt");
      await page.waitForTimeout(1500);
      await page.reload();
      await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      await reopen(page, tap);
      assert.equal(await data(page, "sketchProjected"), "1", "the projection back after the reload");
      assert.equal(await data(page, "sketchLines"), "1", "the line back after the reload");
    });
    await check(`${width} px${tap ? " with taps" : ""}: a rectangle traced over the box's top projected into a sketch on it is a closed outline, and extrudes`, async () => {
      const page = await fresh(width, tap);
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the top");
      await settle(page);
      await projectTool(page, tap);
      await at(page, [20, 15, 20], tap);
      await shown(page, "sketchProjected", "4");
      // The rectangle tool, from corner (0, 0) to (40, 30): each corner lands on the projected ones.
      await tool(page, "rectangle", "r", tap);
      await at(page, [0, 0, 20], tap);
      await at(page, [40, 30, 20], tap);
      await shown(page, "sketchLines", "4");
      await until(page, () => /a closed outline/.test(document.querySelector("#sketch-status")?.textContent ?? ""), null, "a closed outline").catch(async (e) => assert.fail(`${e.message}: "${await status(page)}"`));
      await shot(page, `projection-hunt-traced-${width}`);
      // Extrude from the sketch panel, 10 mm: the panel says it closes, and the new body is 40 · 30 · 10 = 12,000 mm³.
      await page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));
      await press(page, "#sketch-extrude", tap);
      await until(page, () => /makes a closed outline/.test(document.querySelector("#extrude-status")?.textContent ?? ""), null, "the extrude panel says it closes");
      await page.press("#extrude-distance", "Enter");
      await until(page, () => document.querySelector("#volume")?.textContent === "12,000 mm³", null, "the traced rectangle extruded 10: 12,000 mm³").catch(async (e) => assert.fail(`${e.message} (shown: ${await page.textContent("#volume")})`));
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
