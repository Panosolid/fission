// Browser check of the step-26 bug hunt's fixes (26g), at 1280 px with a
// mouse and 375 px with taps. A circle of radius 5 round (20, 15) on the
// 40 × 30 × 20 box's top; the box typed 40 high (the circle goes up to
// z = 40); then:
//   - Sphere: the box has no flat face now, so the circle's plane is lost
//     and it is drawn red where it last was, z = 40, not where it was
//     first drawn, z = 20 (pixel probes on the rim at both heights, from
//     the front view); one Undo brings the box back;
//   - the marker stepped back onto the box: the sketch is after it, so it
//     is not drawn at all (no lines), and forward again it is;
//   - the circle extruded 10 (the extrude is the part, "Extrude by 10"),
//     then the marker at the start: nothing builds, and the size boxes are
//     a fresh box's 40, 30, 20, not 10 as a height.
// Points on screen come from the app's own camera (?test-hooks) through
// the pinhole sums face-sketch.mjs works out. Screenshots go to E2E_SHOTS
// when set. Run with `npm run e2e` (after `npm run build`); Firefox and
// WebKit in CI (`e2e:engines`).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4197, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4197/?test-hooks";
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
const top = (page) => page.evaluate(() => (window.scrollTo(0, 0), (document.getElementById("workspace").scrollTop = 0)));

// The pinhole camera (navigation.mjs's sums): forward = unit(target − position), right = unit(forward × up), the screen's up =
// right × forward; a 45° vertical field of view.
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const T = Math.tan(Math.PI / 8);
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
async function canvasImage(page) {
  const u = await page.evaluate(() => document.querySelector("#viewport canvas").toDataURL("image/png"));
  return decodePng(Buffer.from(u.slice(u.indexOf(",") + 1), "base64"));
}
/** A lost sketch's red (0xff6b6b, drawn 1 px wide and smoothed: red well above blue) within 2 px of the world point `p`. */
async function redNear(page, img, p) {
  const box = await canvasBox(page);
  const s = toScreen(await camera(page), box, p);
  const [cx, cy] = [Math.round(s.x - box.x), Math.round(s.y - box.y)];
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const i = 4 * ((cy + dy) * img.width + cx + dx);
      if (img.data[i] >= 150 && img.data[i] - img.data[i + 2] >= 60) return true;
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
/** The toolbar's shape button `label`. */
const shapeButton = (page, label, tap) => (tap ? page.getByRole("button", { name: label, exact: true }).tap() : page.getByRole("button", { name: label, exact: true }).click());
/** A playback button on the timeline bar. */
const playback = (page, b, tap) => press(page, `#timeline [data-button="${b}"]`, tap);

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
    await check(`${width} px${tap ? " with taps" : ""}: a face sketch lost by a shape change stays where it last was; one after the marker isn't drawn; with nothing built the size boxes are a box's`, async () => {
      const page = await fresh(width, tap);
      // ---- A circle of radius 5 round (20, 15) on the top, from the top view; its rim through (15, 15), left of the centre, clear of
      // the typed boxes that float right of and below a tap.
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the top");
      await settle(page);
      await press(page, "#sketch-tool-circle", tap);
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketchPoints === "20,15", null, "the centre at (20, 15)");
      await at(page, [15, 15, 20], tap);
      await until(page, () => document.querySelector("#undo").title.startsWith("Undo Draw circle"), null, "Draw circle recorded");
      await top(page);
      await press(page, "#finish-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "the sketch finished");
      // ---- The box 40 high: 40 · 30 · 40 = 48,000 mm³, the circle on its top at z = 40.
      await page.fill("#height", "40");
      await until(page, () => document.querySelector("#volume")?.textContent === "48,000 mm³", null, "40 × 30 × 40 = 48,000 mm³");
      // ---- Sphere: no flat face, the circle's plane lost: drawn red, at z = 40 (where it last was), not z = 20 (where it was drawn).
      await top(page);
      await shapeButton(page, "Sphere", tap);
      await until(page, () => Number(document.querySelector("#viewport").dataset.sketchLost) > 0, null, "the circle drawn lost");
      // The front view: the sphere (⌀40 round the origin) in the middle, the circle at z = 40 an ellipse above it (the camera is
      // level with the sphere's centre), at z = 20 one level with the sphere's top.
      await press(page, '[data-view="front"]', tap);
      await settle(page);
      await page.waitForTimeout(200);
      await shot(page, `face-hunt-lost-${width}`);
      const img = await canvasImage(page);
      // The rim's points at (20, 15) + 5 · (−0.6, −0.8), (0, −1) and (−1, 0) at each height: its front and left, away from the
      // view cube (top right at 375 px).
      const rim = (z) => [[17, 11, z], [20, 10, z], [15, 15, z]];
      for (const p of rim(40)) assert.ok(await redNear(page, img, p), `red at [${p}], where the circle last was`);
      for (const p of rim(20)) assert.equal(await redNear(page, img, p), false, `no red at [${p}], where it was first drawn`);
      // One Undo: the box again, the circle found on its top, nothing lost.
      await top(page);
      await press(page, "#undo", tap);
      await until(page, () => document.querySelector("#volume")?.textContent === "48,000 mm³", null, "the box back");
      await until(page, () => document.querySelector("#viewport").dataset.sketchLost === "0" && Number(document.querySelector("#viewport").dataset.sketchLines) > 0, null, "the circle found again");
      // ---- The marker back onto the box: the sketch is after it and isn't drawn; forward again, it is.
      await playback(page, "back", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketchLines === "0", null, "nothing drawn after the marker");
      await shot(page, `face-hunt-rolled-${width}`);
      await playback(page, "forward", tap);
      await until(page, () => Number(document.querySelector("#viewport").dataset.sketchLines) > 0, null, "drawn again");
      // ---- The circle extruded 10 (Edit Sketch from its timeline item, then Extrude): the part, "Extrude by 10".
      const item = page.locator('#timeline [data-item="sketch-2"]');
      await item.scrollIntoViewIfNeeded();
      if (tap) {
        const b = await item.boundingBox();
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
        await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      } else await item.dblclick();
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "Sketch 1 open again");
      await top(page);
      await press(page, "#sketch-extrude", tap);
      await page.fill("#extrude-distance", "10");
      await press(page, "#extrude-ok", tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching !== "true", null, "extruded");
      await until(page, () => document.querySelector("#height")?.value === "10", null, "the panel shows the extrude's 10");
      // ---- The marker at the start: nothing builds, and the boxes are a fresh box's, not 10 as its height.
      await playback(page, "start", tap);
      await until(page, () => !document.querySelector("#no-part").hidden, null, "no body");
      assert.deepEqual(await page.$$eval("#width, #depth, #height", (els) => els.map((e) => e.value)), ["40", "30", "20"]);
      await shot(page, `face-hunt-no-body-${width}`);
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
