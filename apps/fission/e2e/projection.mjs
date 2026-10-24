// Browser check of the Project tool (step 27d): in a sketch on a 40 × 30 ×
// 20 box's top, Project (P at 1280 px, its button with taps at 375 px)
// lights what is under the pointer and a click on the top face takes its
// four edges into the sketch: four projected edges, each with its own two
// ends at the top's corners (0, 0), (40, 0), (40, 30) and (0, 30), drawn in
// the projected colour (violet, 0xc77dff, red well above the sketch's blue)
// along each edge's middle, and none 1 mm inside the face. A second click
// on the face adds nothing and says so. Out of the sketch, the box typed 60
// wide: opened again, the projected edges have followed the top's corners
// to (60, 0) and (60, 30), violet along the moved right edge and none where
// it was. Points on screen come from the app's own camera (?test-hooks)
// through the pinhole sums (face-edges.mjs). Screenshots go to E2E_SHOTS
// when set. Run with `npm run e2e` (after `npm run build`); Firefox and
// WebKit in CI (`e2e:engines`).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";
import { decodePng } from "./png.mjs";
import { preview } from "vite";
import { pinProperties } from "./properties.mjs";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4233, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4233/?test-hooks";
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
  await startWithBox(page); // a new project starts empty (U0c): the 40 × 30 × 20 box, inserted
  await pinProperties(page); // the size boxes are in the panel, folded at the start on a wide screen (U0b)
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
}
const shot = async (page, name) => shots && page.screenshot({ path: `${shots}/${name}.png` });

try {
  for (const [width, tap] of [[1280, false], [375, true]]) {
    await check(`${width} px${tap ? " with taps" : ""}: Project takes the box's top's four edges into a sketch on it, drawn violet; again adds nothing; with the box typed 60 wide they follow its corners`, async () => {
      const page = await fresh(width, tap);
      await press(page, '[data-view="top"]', tap);
      await settle(page);
      await press(page, "#create-sketch", tap);
      await until(page, () => document.querySelector("#viewport").dataset.planes === "XY, XZ, YZ", null, "planes offered");
      await at(page, [20, 15, 20], tap);
      await until(page, () => document.querySelector("#viewport").dataset.sketching === "true", null, "sketching on the top");
      await settle(page);
      assert.equal(await data(page, "sketchPicks"), "false", "no picks before Project");
      if (tap) await press(page, "#sketch-tool-project", tap);
      else await page.keyboard.press("p");
      await shown(page, "sketchPicks", "true");
      if (!tap) {
        // Lit under the pointer as a hover is (the top face, then its right edge), before anything is projected.
        await hover(page, [20, 15, 20]);
        await until(page, () => (document.querySelector("#viewport").dataset.hover ?? "").startsWith("face "), null, "the face lit under the pointer");
        await shot(page, `projection-hover-${width}`);
      }
      // A click inside the top face: every edge of it, four lines, each with its own two ends at the top's corners.
      await at(page, [20, 15, 20], tap);
      await shown(page, "sketchProjected", "4");
      assert.equal(await data(page, "sketchLines"), "0", "none of the sketch's own");
      const corners = (await data(page, "sketchPoints")).split(" ").sort();
      assert.deepEqual(corners, ["0,0", "0,0", "0,30", "0,30", "40,0", "40,0", "40,30", "40,30"]);
      await until(page, () => document.querySelector("#undo").title.startsWith("Undo Project"), null, "one undo step, Project");
      if (!tap) await pointerAway(page);
      await frames(page);
      await shot(page, `projection-edges-${width}`);
      await edgesDrawn(page, 40, "projected");
      // Again on the same face: nothing added, and the panel says why.
      await at(page, [20, 15, 20], tap);
      await until(page, () => /projected into this sketch already/.test(document.querySelector("#sketch-grid-error")?.textContent ?? ""), null, "the note that it is there already");
      assert.equal(await data(page, "sketchProjected"), "4");
      await finish(page, tap);
      // The box 60 wide, typed: the top's corners move to (60, 0) and (60, 30), and the projected edges with them.
      await page.fill("#width", "60");
      await until(page, () => document.querySelector("#volume")?.textContent === "36,000 mm³", null, "60 × 30 × 20 = 36,000 mm³");
      await reopen(page, tap);
      assert.deepEqual((await data(page, "sketchPoints")).split(" ").sort(), ["0,0", "0,0", "0,30", "0,30", "60,0", "60,0", "60,30", "60,30"], "followed the corners");
      if (!tap) await pointerAway(page);
      await frames(page);
      await shot(page, `projection-followed-${width}`);
      await edgesDrawn(page, 60, "followed");
      const img = await canvasImage(page);
      assert.equal(await violetNear(page, img, [40, 15, 20]), false, "nothing left along the old right edge");
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
