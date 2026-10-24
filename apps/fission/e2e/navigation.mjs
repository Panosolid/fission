// Browser check of moving the camera by hand (sketch feel SF3a, the
// owner's bindings): the scroll wheel and a pinch zoom toward the pointer, middle-drag
// pans, Shift+middle-drag orbits, the right button moves nothing (kept for a
// menu), dragging the view cube orbits, and the navigation bar along the
// bottom (Orbit, Pan and Zoom for the left button, Fit, Look at, Home and
// the standard views). Every move is checked against the camera worked out
// here from the pinhole picture, apart from the app: the point grabbed must
// stay under (or follow) the pointer to within a pixel. The bar at 375 px
// with taps. Screenshots at 1280 and 375 px go to E2E_SHOTS when set. Run
// with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4191, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4191/?test-hooks";
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
  await startWithBox(page); // a new project starts empty (U0c): the 40 × 30 × 20 box, inserted
  await settle(page);
  return page;
}
const camera = (page) => page.evaluate(() => window.fissionTest.camera());
/** Waits for the camera's damping to finish: two reads 100 ms apart within a nanometre (each frame's re-aim jitters in the last bits). */
async function settle(page) {
  let last = null;
  // Damping eases out over a second or more where frames are slow (software graphics in CI).
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(100);
    const now = await camera(page);
    if (last && [...now.position, ...now.target].every((x, k) => Math.abs(x - [...last.position, ...last.target][k]) < 1e-6)) return;
    last = now;
  }
  throw new Error(`the camera never settled: ${JSON.stringify(last)} then ${JSON.stringify(await camera(page))}`);
}
const canvasBox = (page) => page.locator("#viewport canvas").boundingBox();

// The pinhole camera, worked here: forward = unit(target − position), right
// = unit(forward × up), the screen's up = right × forward; a 45° fov.
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => a.map((x) => x / Math.sqrt(dot(a, a)));
const T = Math.tan(Math.PI / 8);
function frame(cam) {
  const forward = unit(sub(cam.target, cam.position));
  const right = unit(cross(forward, cam.up));
  return { forward, right, up: cross(right, forward), distance: Math.sqrt(dot(sub(cam.target, cam.position), sub(cam.target, cam.position))) };
}
/** Where a world point is on screen (client pixels). */
function toScreen(cam, box, p) {
  const { forward, right, up } = frame(cam);
  const v = sub(p, cam.position);
  const aspect = box.width / box.height;
  const nx = dot(v, right) / (dot(v, forward) * T * aspect);
  const ny = dot(v, up) / (dot(v, forward) * T);
  return [box.x + ((nx + 1) / 2) * box.width, box.y + ((1 - ny) / 2) * box.height];
}
/** The point of the plane through the target, square to the view, under a screen point. */
function underPointer(cam, box, [x, y]) {
  const { forward, right, up, distance } = frame(cam);
  const aspect = box.width / box.height;
  const nx = ((x - box.x) / box.width) * 2 - 1;
  const ny = 1 - ((y - box.y) / box.height) * 2;
  const ray = forward.map((f, i) => f + nx * T * aspect * right[i] + ny * T * up[i]);
  return cam.position.map((c, i) => c + distance * ray[i]);
}
const closeTo = (a, b, eps, what) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) <= eps), `${what}: [${a.map((x) => x.toFixed(3))}] vs [${b.map((x) => x.toFixed(3))}]`);

/** A drag with one mouse button in 10 steps; `keys` held throughout. */
async function drag(page, [x, y], [dx, dy], button = "left", keys = []) {
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.move(x, y);
  await page.mouse.down({ button });
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up({ button });
  for (const k of keys) await page.keyboard.up(k);
  await settle(page);
}

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.message}`);
  }
}

await check("the bar: one slim strip centred along the bottom of the view, Orbit lit, Look at off with no sketch", async () => {
  const page = await fresh();
  try {
    const labels = await page.$$eval("#viewport #view-controls button", (bs) => bs.map((b) => b.getAttribute("aria-label")));
    assert.deepEqual(labels, ["Orbit", "Pan", "Zoom", "Fit", "Look at", "Home", "Top", "Front", "Right", "Full screen"]); // Full screen from SF3d
    const bar = await page.locator("#view-controls").boundingBox();
    const view = await page.locator("#viewport").boundingBox();
    assert.ok(Math.abs(bar.x + bar.width / 2 - (view.x + view.width / 2)) <= 1, `centred: ${JSON.stringify(bar)} in ${JSON.stringify(view)}`);
    assert.ok(view.y + view.height - (bar.y + bar.height) <= 10 && bar.height <= 40, `slim, along the bottom: ${JSON.stringify(bar)}`);
    assert.equal(await page.getAttribute("#view-controls [data-nav=orbit]", "aria-pressed"), "true");
    assert.equal(await page.getAttribute("#view-controls [data-nav=pan]", "aria-pressed"), "false");
    assert.equal(await page.isDisabled("[data-view=look-at]"), true);
    if (shots) await page.screenshot({ path: `${shots}/navigation-1280.png` });
  } finally {
    await page.context().close();
  }
});

await check("the wheel zooms toward the pointer: the point under it stays to within a pixel, the distance ×e^(±0.002·px)", async () => {
  const page = await fresh();
  try {
    const box = await canvasBox(page);
    for (const [fx, fy, deltaY] of [[0.3, 0.35, -300], [0.75, 0.7, 200], [0.5, 0.5, -100]]) {
      const at = [box.x + fx * box.width, box.y + fy * box.height];
      const before = await camera(page);
      const grabbed = underPointer(before, box, at);
      await page.mouse.move(...at);
      await page.mouse.wheel(0, deltaY);
      await settle(page);
      const after = await camera(page);
      closeTo(toScreen(after, box, grabbed), at, 1, `the point under (${fx}, ${fy}) stays`);
      const ratio = frame(after).distance / frame(before).distance;
      assert.ok(Math.abs(ratio - Math.exp(deltaY * 0.002)) < 1e-6, `distance ×${ratio}, want ×${Math.exp(deltaY * 0.002)}`);
      closeTo(frame(after).forward, frame(before).forward, 1e-9, "no turn");
    }
    // A trackpad pinch is a wheel turn with Ctrl held: five times the rate.
    const before = await camera(page);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 20);
    await page.keyboard.up("Control");
    await settle(page);
    const ratio = frame(await camera(page)).distance / frame(before).distance;
    assert.ok(Math.abs(ratio - Math.exp(20 * 0.002 * 5)) < 1e-6, `pinch ×${ratio}`);
    // The page itself never scrolled.
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  } finally {
    await page.context().close();
  }
});

await check("middle-drag pans: the grabbed point follows the pointer; it never picks; Shift+middle orbits; the right button does nothing", async () => {
  const page = await fresh();
  try {
    const box = await canvasBox(page);
    const at = [box.x + 0.4 * box.width, box.y + 0.45 * box.height];
    let before = await camera(page);
    const grabbed = underPointer(before, box, at);
    await drag(page, at, [120, -60], "middle");
    let after = await camera(page);
    closeTo(toScreen(after, box, grabbed), [at[0] + 120, at[1] - 60], 1, "the grabbed point follows");
    closeTo(frame(after).forward, frame(before).forward, 1e-9, "no turn");
    assert.equal(await page.evaluate(() => document.body.dataset.selection ?? ""), "", "the press picked nothing");

    before = after;
    await drag(page, at, [100, 0], "middle", ["Shift"]);
    after = await camera(page);
    closeTo(after.target, before.target, 1e-6, "orbit keeps the target");
    assert.ok(Math.abs(frame(after).distance / frame(before).distance - 1) < 1e-6, "and the distance");
    assert.ok(dot(frame(after).forward, frame(before).forward) < 0.99, "and turns");

    before = after;
    await drag(page, at, [150, 80], "right");
    closeTo((await camera(page)).position, before.position, 1e-3, "right-drag leaves the camera");
  } finally {
    await page.context().close();
  }
});

await check("an orbit stops when the button is let go: no spin after a fast Shift+middle flick, and the sketch grid holds still (25a5 monkey seed 3)", async () => {
  const page = await fresh();
  try {
    // The monkey's steps: a sketch on XY, then a fast Shift+middle flick
    // across most of the view in 5 moves. With the old easing the camera
    // reached the same end pose (under the plane: the flick's upward part
    // tips it past the horizon) but only seconds after the release, frame
    // by frame, so longest where frames are slow, and the grid's spacing
    // followed it on the way (1, 10, 100 mm and back).
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketchGrid);
    await settle(page);
    const box = await canvasBox(page);
    await page.keyboard.down("Shift");
    await page.mouse.move(box.x + 0.914 * box.width, box.y + 0.516 * box.height);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(box.x + 0.229 * box.width, box.y + 0.2 * box.height, { steps: 5 });
    await page.mouse.up({ button: "middle" });
    await page.keyboard.up("Shift");
    await page.waitForTimeout(150); // a frame or two after the release
    const released = await camera(page);
    const grid = await page.evaluate(() => document.querySelector("#viewport").dataset.sketchGrid);
    for (const wait of [300, 1000]) {
      await page.waitForTimeout(wait);
      closeTo((await camera(page)).position, released.position, 1e-6, `${wait} ms more after the release, the camera is where it was let go`);
      assert.equal(await page.evaluate(() => document.querySelector("#viewport").dataset.sketchGrid), grid, "the grid holds still");
    }
  } finally {
    await page.context().close();
  }
});

await check("the bar's Pan and Zoom make the left button pan and zoom; Orbit gives it back", async () => {
  const page = await fresh();
  try {
    const box = await canvasBox(page);
    const at = [box.x + 0.6 * box.width, box.y + 0.4 * box.height];
    await page.click("#view-controls [data-nav=pan]");
    assert.equal(await page.getAttribute("#view-controls [data-nav=pan]", "aria-pressed"), "true");
    assert.equal(await page.getAttribute("#view-controls [data-nav=orbit]", "aria-pressed"), "false");
    assert.equal(await page.getAttribute("#viewport", "data-nav"), "pan");
    let before = await camera(page);
    const grabbed = underPointer(before, box, at);
    await drag(page, at, [-90, 70]);
    let after = await camera(page);
    closeTo(toScreen(after, box, grabbed), [at[0] - 90, at[1] + 70], 1, "left-drag pans");
    // A click in Pan mode picks nothing (the body is under the middle).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await page.evaluate(() => document.body.dataset.selection ?? ""), "");

    await page.click("#view-controls [data-nav=zoom]");
    before = await camera(page);
    const point = underPointer(before, box, at);
    await drag(page, at, [0, -100]);
    after = await camera(page);
    const ratio = frame(after).distance / frame(before).distance;
    assert.ok(Math.abs(ratio - Math.exp(-0.2)) < 1e-6, `dragging up 100 px zooms in ×e^−0.2, got ×${ratio}`);
    closeTo(toScreen(after, box, point), at, 1, "toward where it was pressed");

    await page.click("#view-controls [data-nav=orbit]");
    before = await camera(page);
    await drag(page, at, [80, 0]);
    after = await camera(page);
    assert.ok(dot(frame(after).forward, frame(before).forward) < 0.99, "left-drag orbits again");
  } finally {
    await page.context().close();
  }
});

await check("dragging the view cube orbits: 100 px is half a turn round Z, the target and distance stay, and it is not a click", async () => {
  const page = await fresh();
  try {
    const cube = await page.locator("#viewport .view-cube").boundingBox();
    const before = await camera(page);
    const at = [cube.x + cube.width / 2, cube.y + cube.height / 2];
    await drag(page, at, [50, 0]);
    const after = await camera(page);
    closeTo(after.target, before.target, 1e-6, "the target stays");
    const o0 = sub(before.position, before.target), o1 = sub(after.position, after.target);
    const turn = Math.atan2(o1[1], o1[0]) - Math.atan2(o0[1], o0[0]);
    const want = -Math.PI / 2; // 50 px of 100 px per half turn, the other way round Z
    const wrapped = Math.atan2(Math.sin(turn - want), Math.cos(turn - want));
    assert.ok(Math.abs(wrapped) < 1e-6, `turned ${turn}, want ${want}`);
    assert.ok(Math.abs(o1[2] - o0[2]) < 1e-6, "no tilt on a level drag");
    assert.ok(Math.abs(frame(after).distance - frame(before).distance) < 1e-6, "the distance stays");
  } finally {
    await page.context().close();
  }
});

await check("Fit and Home after zooming in; Look at turns on in a sketch and looks straight at it after an orbit", async () => {
  const page = await fresh();
  try {
    const home = await camera(page);
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.wheel(0, -600);
    await settle(page);
    await page.click("[data-view=fit]");
    await settle(page);
    closeTo((await camera(page)).position, home.position, 1e-6, "Fit with nothing selected frames the body from home");
    await page.mouse.wheel(0, 300);
    await page.click("[data-view=home]");
    await settle(page);
    closeTo((await camera(page)).position, home.position, 1e-6, "Home");

    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
    await page.waitForFunction(() => !document.querySelector("[data-view=look-at]").disabled);
    // Looking straight down, a sideways orbit only spins round Z and dragging down is already at the pole; drag up to tilt.
    // In the middle of the view: clear of the floating browser on the left (SF3d) and the sketch's floating properties on the right (U0b).
    await drag(page, [box.x + box.width / 2, box.y + 300], [0, -60], "middle", ["Shift"]);
    assert.ok(Math.abs(frame(await camera(page)).forward[2] + 1) > 1e-3, `orbited away from straight down: ${JSON.stringify(await camera(page))}`);
    await page.click("[data-view=look-at]");
    await settle(page);
    // Within 1e-5: straight down is kept a hair off the pole so the orbit stays defined (orbitSafeOffset).
    closeTo(frame(await camera(page)).forward, [0, 0, -1], 1e-5, "straight down onto the XY plane");
    closeTo(frame(await camera(page)).up, [0, 1, 0], 1e-5, "its y axis up");
    await page.click("#sketch-finish");
    await page.waitForFunction(() => document.querySelector("[data-view=look-at]").disabled);
  } finally {
    await page.context().close();
  }
});

await check("phone width 375 px: the bar is whole on screen, clear of Undo and Redo, taps change the mode, no sideways scroll", async () => {
  const page = await fresh(375, true);
  try {
    const rect = (sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
    const bar = await rect("#view-controls");
    const port = await rect("#viewport");
    assert.ok(bar.left >= port.left && bar.right <= port.right && bar.bottom <= port.bottom, `inside the view: ${JSON.stringify(bar)}`);
    for (const id of ["undo", "redo"]) {
      const b = await rect(`#${id}`);
      assert.ok(b.right <= bar.left || b.left >= bar.right || b.bottom <= bar.top || b.top >= bar.bottom, `${id} clear of the bar`);
    }
    for (const b of await page.$$eval("#view-controls button", (els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      assert.ok(b.left >= 0 && b.right <= 375 && b.height >= 24 && b.width >= 24, JSON.stringify(b));
    }
    await page.tap("#view-controls [data-nav=pan]");
    assert.equal(await page.getAttribute("#viewport", "data-nav"), "pan");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
    if (shots) await page.screenshot({ path: `${shots}/navigation-375.png` });
  } finally {
    await page.context().close();
  }
});

assert.deepEqual(errors, [], "no page errors");
await browser.close();
await server.close();
if (failed) process.exit(1);
console.log("PASS navigation");
