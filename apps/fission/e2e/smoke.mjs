// Browser smoke test: serves the built app, drives it like a user and checks
// what is on screen. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { preview } from "vite";

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4174/";
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
// The app opens the project it autosaved last (19c); the checks on `page`
// each expect a fresh app, so every load of it forgets what was stored.
// IndexedDB runs requests on one database in order, so this delete comes
// before the app's own open. The autosave check uses a page of its own.
await page.addInitScript(() => indexedDB.deleteDatabase("fission"));

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const text = (id) => page.textContent(`#${id}`);
const setSize = async (id, value) => {
  await page.fill(`#${id}`, String(value));
};

// Where a point of the default 40×30×20 box lands on screen, worked out
// here from the framing in viewer.ts fit() rather than asked of the viewer:
// the box is framed as a sphere at its centre (20, 15, 10) with
// r = √(40² + 30² + 20²)/2 = √2900/2, the camera sits r / sin(22.5°) away
// along (0.6, −0.8, 0.55), looks at the centre with Z up, fov 45°. On a
// canvas taller than wide the sphere is fitted to the narrower horizontal
// field of view instead: half-angle atan(tan 22.5° × width / height).
// `box` is the canvas's bounding box. `view` names another direction to
// the camera and screen-up (the standard views of views.ts), and another
// framed sphere (Fit on a selection).
const HOME = { toward: [0.6, -0.8, 0.55], up: [0, 0, 1], centre: [20, 15, 10], radius: Math.sqrt(2900) / 2 };
const TOP = { ...HOME, toward: [0, 0, 1], up: [0, 1, 0] }; // looking down −Z, +Y up on screen
const FRONT = { ...HOME, toward: [0, -1, 0] }; // from −Y, +X to the right
const RIGHT = { ...HOME, toward: [1, 0, 0] }; // from +X, +Y to the right
function screenPoint(box, [px, py, pz], view = HOME) {
  const { centre } = view;
  const n = Math.hypot(...view.toward);
  const dir = view.toward.map((d) => d / n);
  const aspect = box.width / box.height;
  const half = aspect < 1 ? Math.atan(Math.tan(Math.PI / 8) * aspect) : Math.PI / 8;
  const dist = view.radius / Math.sin(half);
  const cam = centre.map((c, i) => c + dir[i] * dist);
  const fwd = dir.map((d) => -d);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = (a) => a.map((x) => x / Math.hypot(...a));
  const right = unit(cross(fwd, view.up));
  const up = cross(right, fwd);
  const v = [px - cam[0], py - cam[1], pz - cam[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const t = Math.tan(Math.PI / 8);
  const ndcX = dot(v, right) / (dot(v, fwd) * t * (box.width / box.height));
  const ndcY = dot(v, up) / (dot(v, fwd) * t);
  return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
}

/** RGB of the canvas pixel at a fraction of its width/height. */
const pixel = (fx, fy) =>
  page.evaluate(
    ([fx, fy]) => {
      const src = document.querySelector("#viewport canvas");
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      return Array.from(ctx.getImageData(Math.floor(src.width * fx), Math.floor(src.height * fy), 1, 1).data.slice(0, 3));
    },
    [fx, fy],
  );

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

try {
  await page.goto(url);
  // The panel appears once the app has looked for a stored project (19c), so wait for it to exist too.
  await page.waitForFunction(() => (document.querySelector("#status")?.textContent ?? "…") !== "…").catch(async (e) => {
    // Say what the page did say, so a browser that never starts (another engine in CI) can be diagnosed from the log.
    const shown = await page.evaluate(() => ({ status: document.querySelector("#status")?.textContent, file: document.querySelector("#file-status")?.textContent, body: document.body.innerText.slice(0, 300) }));
    throw new Error(`${e.message}\n  the page shows ${JSON.stringify(shown)}\n  console errors: ${JSON.stringify(consoleErrors)}`);
  });

  /**
   * The browser floats over the view's top-left corner (SF3d), where this
   * 1000 px window draws the left of the part, so the checks that click the
   * part fold it first, as a person would; `clickRow` opens it for a row's
   * click and folds it again.
   */
  const FOLD = "#browser .browser-fold";
  const foldBrowser = async (open) => {
    if ((await page.$eval(FOLD, (d) => d.open)) !== open) await page.click(`${FOLD} > summary`);
  };
  async function clickRow(node, shift = false) {
    await foldBrowser(true);
    await page.click(`#browser [data-node=${node}]`, { modifiers: shift ? ["Shift"] : [] });
    await foldBrowser(false);
  }

  await check("default 40×30×20 box shows hand-worked numbers", async () => {
    // V = 40·30·20 = 24000; A = 2(40·30 + 30·20 + 40·20) = 5200.
    assert.equal(await text("volume"), "24,000 mm³");
    assert.equal(await text("area"), "5,200 mm²");
    assert.equal(await text("topology"), "8 V · 12 E · 6 F");
    assert.equal(await text("status"), "valid");
    assert.equal(await text("intent"), "Box: 40 × 30 × 20 mm");
    assert.equal(await text("provenance"), "Feature 1 (box) was made in Design.");
  });

  await check("no Downstream section shows while no workspace makes anything from the design (X4b)", async () => {
    assert.equal(await page.$$eval("#properties #downstream", (els) => els.length), 1, "the section is in the panel");
    assert.equal(await page.isVisible("#properties #downstream"), false);
    assert.equal(await page.$$eval(".downstream-chip", (els) => els.length), 0);
  });

  await check("the box is actually drawn", async () => {
    await page.waitForTimeout(300);
    const background = [0x14, 0x16, 0x1a];
    const centre = await pixel(0.5, 0.5);
    const corner = await pixel(0.02, 0.02);
    assert.deepEqual(corner, background, "corner should be empty background");
    assert.notDeepEqual(centre, background, "centre of the view should show the body");
  });

  await foldBrowser(false);
  await check("clicking faces and edges selects them: click, Shift-click, drag, empty space, Escape, hidden edges", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const screen = (p) => screenPoint(box, p);
    const selection = () => page.evaluate(() => document.body.dataset.selection ?? "");
    // Kernel face order for a box (primitives.rs): −Z, +Z, −Y, +Y, −X, +X.
    const top = screen([20, 15, 20]); // centre of the +Z face: face 1
    const front = screen([20, 0, 10]); // centre of the −Y face: face 2
    await page.mouse.click(top.x, top.y);
    assert.equal(await selection(), "face:feature-1/top", "a click on the top face selects face 1");
    await page.keyboard.down("Shift");
    await page.mouse.click(front.x, front.y);
    await page.keyboard.up("Shift");
    assert.equal(await selection(), "face:feature-1/top face:feature-1/front", "Shift-click adds the front face");
    // A press that moves 30 px is the camera orbiting, not a pick: nothing changes.
    await page.mouse.move(front.x, front.y);
    await page.mouse.down();
    await page.mouse.move(front.x + 30, front.y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await selection(), "face:feature-1/top face:feature-1/front", "a drag does not pick");
    await page.mouse.click(box.x + 0.02 * box.width, box.y + 0.98 * box.height); // bottom left: the browser floats over the top left (SF3d)
    assert.equal(await selection(), "", "a click on empty space clears");
    await page.mouse.click(top.x, top.y);
    await page.keyboard.press("Escape");
    assert.equal(await selection(), "", "Escape clears");
    // The drag above turned the camera; re-frame it (a shape change re-fits)
    // so the hand-worked screen positions hold again. The drag's orbit eases
    // out over many frames (damping): a second's wait checks fit() stopped it
    // rather than letting the camera drift off the framing (a flaky failure
    // of the upright pick below before 17d).
    await page.click("#toolbar [data-shape=cylinder]");
    await page.click("#toolbar [data-shape=box]");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "box");
    await page.waitForTimeout(1000);
    await page.keyboard.press("Escape");
    // Edges (17c). Kernel edge order for a box (primitives.rs): the −Z face
    // makes edges 0–3, the +Z face 4–7 (first 4: corner 4 (0,0,20) to 5
    // (40,0,20), the top front edge), the −Y face adds 8: corner 1 (40,0,0)
    // to 5 (40,0,20), the front right upright, and 9.
    const topFront = screen([20, 0, 20]);
    const upright = screen([40, 0, 10]);
    await page.mouse.click(topFront.x, topFront.y);
    assert.equal(await selection(), "edge:feature-1/front+top", "a click on the top front edge selects edge 4");
    await page.keyboard.down("Shift");
    await page.mouse.click(upright.x + 2, upright.y); // 2 px off the line still picks it
    await page.keyboard.up("Shift");
    assert.equal(await selection(), "edge:feature-1/front+top edge:feature-1/front+right", "Shift-click adds the upright");
    // 3 px from the top front edge, towards the top face's middle: the edge still wins over the face.
    const inward = { x: top.x - topFront.x, y: top.y - topFront.y };
    const along = (d) => ({ x: topFront.x + (inward.x / Math.hypot(inward.x, inward.y)) * d, y: topFront.y + (inward.y / Math.hypot(inward.x, inward.y)) * d });
    await page.mouse.click(along(3).x, along(3).y);
    assert.equal(await selection(), "edge:feature-1/front+top", "3 px off the edge picks the edge");
    // 20 px in is well inside the top face.
    await page.mouse.click(along(20).x, along(20).y);
    assert.equal(await selection(), "face:feature-1/top", "20 px off the edge picks the face");
    // The back left edge along the floor, corner 0 (0,0,0) to 2 (0,30,0)
    // (edge 0), is hidden: going from its middle (0,15,0) towards the
    // camera, along (0.6,−0.8,0.55), y reaches 0 after 15/0.8 = 18.75 steps,
    // at x = 11.25, z = 10.3, inside the front face and over 10 mm from its
    // edges, so the line of sight leaves through the −Y face (face 2).
    const hidden = screen([0, 15, 0]);
    await page.mouse.click(hidden.x, hidden.y);
    assert.equal(await selection(), "face:feature-1/front", "a hidden edge is not picked; the face in front is");
    await page.keyboard.press("Escape");
    // Put the camera back where fit() left it for the checks below.
    await page.click("#toolbar [data-shape=cylinder]");
    await page.click("#toolbar [data-shape=box]");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "box");
  });

  await check("the selection is drawn: faces and edges in the selection colour, hover, Body 1, and the properties agree", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const at = (p) => screenPoint(box, p);
    const colourAt = async (p) => {
      await page.waitForTimeout(200); // a frame or two to paint
      const s = at(p);
      return pixel((s.x - box.x) / box.width, (s.y - box.y) / box.height);
    };
    // How green a pixel is: the selection colour is green, the body grey-blue.
    const green = ([r, g, b]) => g - (r + b) / 2;
    const away = () => page.mouse.move(box.x + 2, box.y + box.height - 2); // empty space, below the floating browser: nothing hovered
    const viewport = (key) => page.$eval("#viewport", (el, k) => el.dataset[k], key);
    const listed = () => page.$$eval("#selection-list li", (els) => els.map((e) => e.textContent));
    const lit = () => page.$$eval("#browser [aria-current=true]", (els) => els.map((e) => e.dataset.node));
    const top = [20, 15, 20]; // face 1 (see the picking check)
    const front = [20, 0, 10]; // face 2
    await away();
    const plainTop = await colourAt(top);
    const plainFront = await colourAt(front);
    assert.deepEqual(await listed(), []);
    assert.equal(await page.isVisible("#selection-empty"), true);

    await page.mouse.click(at(top).x, at(top).y);
    await away();
    const selectedTop = await colourAt(top);
    assert.ok(green(selectedTop) > green(plainTop) + 40, `selected top face ${selectedTop} is green, was ${plainTop}`);
    assert.deepEqual(await colourAt(front), plainFront, "the front face is not selected");
    assert.equal(await viewport("highlight"), "faces 1 edges ");
    assert.deepEqual(await listed(), ["Top face · plane face:feature-1/top"]);
    assert.deepEqual(await lit(), []);

    // Hover: the front face lights up less than a selected one, and goes back on leaving.
    await page.mouse.move(at(front).x, at(front).y);
    const hoveredFront = await colourAt(front);
    assert.equal(await viewport("hover"), "face 2");
    assert.ok(green(hoveredFront) > green(plainFront) + 10, `hovered front ${hoveredFront}, plain ${plainFront}`);
    await away();
    assert.equal(await viewport("hover"), "");
    assert.deepEqual(await colourAt(front), plainFront, "leaving the face ends the hover");

    // An edge: the top front edge (edge 4) and its curve type.
    await page.mouse.click(at([20, 0, 20]).x, at([20, 0, 20]).y);
    await away();
    assert.equal(await viewport("highlight"), "faces  edges 4");
    assert.deepEqual(await listed(), ["Edge of Front and Top · line edge:feature-1/front+top"]);
    assert.deepEqual(await colourAt(top), plainTop, "the face is no longer selected");

    // Body 1 in the browser selects the whole body: every face tinted, its row lit.
    await clickRow("body-1");
    assert.equal(await viewport("highlight"), "body faces  edges ");
    assert.ok(green(await colourAt(front)) > green(plainFront) + 40, "the body's front face is tinted too");
    assert.deepEqual(await lit(), ["body-1"]);
    assert.deepEqual(await listed(), ["Body 1 · solid body:feature-1"]);
    // Shift-click a face adds it beside the body; a plain click replaces it and unlights the row.
    await page.keyboard.down("Shift");
    await page.mouse.click(at(top).x, at(top).y);
    await page.keyboard.up("Shift");
    assert.deepEqual(await listed(), ["Body 1 · solid body:feature-1", "Top face · plane face:feature-1/top"]);
    await page.mouse.click(at(top).x, at(top).y);
    assert.deepEqual(await lit(), []);
    await page.keyboard.press("Escape");
    await away();
    assert.deepEqual(await colourAt(top), plainTop, "Escape takes the colour away");
    assert.equal(await page.isVisible("#selection-empty"), true);
    await clickRow("body-1");
    await page.screenshot({ path: "e2e/selection.png" });
    await page.keyboard.press("Escape");
  });

  // 17e, by name since step 24c: a face or edge is kept while the rebuilt
  // body has one of that name, however the kernel numbers it.
  const selected = () => page.evaluate(() => document.body.dataset.selection ?? "");
  const pickTopAndEdge = async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const top = screenPoint(box, [20, 15, 20]); // face 1, as in the picking check
    const topFront = screenPoint(box, [20, 0, 20]); // edge 4
    await page.mouse.click(top.x, top.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(topFront.x, topFront.y);
    await page.keyboard.up("Shift");
    await page.mouse.move(box.x + 2, box.y + 2);
    assert.equal(await selected(), "face:feature-1/top edge:feature-1/front+top");
  };

  await check("the selection survives a resize, and a change of shape drops its faces and edges with a note", async () => {
    await pickTopAndEdge();
    await setSize("width", 44);
    // V = 44·30·20 = 26400: the box rebuilt, still 8 V · 12 E · 6 F.
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "26,400 mm³");
    assert.equal(await selected(), "face:feature-1/top edge:feature-1/front+top", "a resize keeps face 1 and edge 4");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.highlight), "faces 1 edges 4");
    assert.equal(await page.isVisible("#selection-note"), false);
    await clickRow("body-1", true);
    // A cylinder (the same feature, changed) has a top but no front: the
    // box's top stays selected, now the cylinder's top (kernel face 1 again),
    // the top front edge goes with a note; the body stays.
    await page.click("#toolbar [data-shape=cylinder]");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "cylinder");
    assert.equal(await selected(), "face:feature-1/top body:feature-1");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.highlight), "body faces 1 edges ");
    assert.equal(await page.isVisible("#selection-note"), true);
    assert.equal(await page.textContent("#selection-note"), "Taken out of the selection: Edge of Front and Top. The edit took them off the body, so they could not be followed.");
    await page.screenshot({ path: "e2e/selection-dropped.png" });
    await page.keyboard.press("Escape");
    assert.equal(await page.isVisible("#selection-note"), false, "the next change of selection retires the note");
    // Back to the 40 mm box, framed afresh by the change of shape, for the hand-worked positions.
    await setSize("width", 40);
    await page.click("#toolbar [data-shape=box]");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  });

  await check("the selection survives switching workspaces", async () => {
    await pickTopAndEdge();
    await page.click("[data-workspace=laser]");
    assert.equal(await page.isVisible(".placeholder h2"), true);
    assert.equal(await selected(), "face:feature-1/top edge:feature-1/front+top", "kept while Laser is shown");
    await page.click("[data-workspace=design]");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    assert.equal(await selected(), "face:feature-1/top edge:feature-1/front+top");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.highlight), "faces 1 edges 4");
    assert.deepEqual(await page.$$eval("#selection-list li", (els) => els.map((e) => e.textContent)), ["Top face · plane face:feature-1/top", "Edge of Front and Top · line edge:feature-1/front+top"]);
    assert.equal(await page.isVisible("#selection-note"), false);
    await page.keyboard.press("Escape");
  });

  await check("the View buttons turn the camera to each view, and Fit frames the selection", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const selection = () => page.evaluate(() => document.body.dataset.selection ?? "");
    const sample = async (view, p) => {
      const s = screenPoint(box, p, view);
      return pixel((s.x - box.x) / box.width, (s.y - box.y) / box.height);
    };
    // The body is lit grey-blue, far brighter than the background
    // (0x14, 0x16, 0x1a) and the grid lines on it.
    const isBody = ([r, g, b]) => r + g + b > 3 * 80;
    const clickView = async (name) => {
      await page.click(`#view-controls [data-view=${name}]`);
      await page.mouse.move(box.x + 2, box.y + 2); // nothing hovered
      await page.waitForTimeout(200); // a frame or two to paint
    };
    const pickAt = async (view, p, expected) => {
      const s = screenPoint(box, p, view);
      await page.mouse.click(s.x, s.y);
      assert.equal(await selection(), expected, `pick at ${p}`);
      await page.keyboard.press("Escape");
    };
    // The group sits over the viewport, not in the workspace toolbar (the navigation bar, SF3a; e2e/navigation.mjs checks the rest).
    assert.deepEqual(await page.$$eval("#viewport #view-controls button", (bs) => bs.map((b) => b.getAttribute("aria-label"))), ["Orbit", "Pan", "Zoom", "Fit", "Look at", "Home", "Top", "Front", "Right", "Full screen"]);
    assert.equal(await page.$("#toolbar #view-controls"), null);

    // Top: the camera looks straight down at the centre (20, 15, 10), so
    // the top face's centre (20, 15, 20) is on the canvas centre and the
    // 40 × 30 face, all at one depth, shows as a rectangle 4 : 3 (same
    // scale across and up at one depth), the side faces hidden behind it.
    await clickView("top");
    const c = screenPoint(box, [20, 15, 20], TOP);
    assert.ok(Math.abs(c.x - (box.x + box.width / 2)) < 0.5 && Math.abs(c.y - (box.y + box.height / 2)) < 0.5);
    const [l, r, t, b] = [[0, 15, 20], [40, 15, 20], [20, 30, 20], [20, 0, 20]].map((p) => screenPoint(box, p, TOP));
    assert.ok(Math.abs((r.x - l.x) / (b.y - t.y) - 4 / 3) < 1e-9, "40 : 30 on screen");
    assert.ok(t.y < b.y, "+Y is up on screen");
    for (const p of [[1, 15, 20], [39, 15, 20], [20, 29, 20], [20, 1, 20], [1, 1, 20], [39, 29, 20]]) assert.ok(isBody(await sample(TOP, p)), `top: ${p} is on the face`);
    // Just outside the face's edges (2 mm past, at the face's depth): the
    // ray there passes the box and meets the floor, not the body.
    for (const p of [[-2, 15, 20], [42, 15, 20], [20, 32, 20], [20, -2, 20]]) assert.ok(!isBody(await sample(TOP, p)), `top: ${p} is off the box`);
    await page.screenshot({ path: "e2e/view-top.png" });
    await pickAt(TOP, [20, 15, 20], "face:feature-1/top");

    // Front: from −Y with Z up. The camera looks at (20, 15, 10) along +Y,
    // and the front face's centre (20, 0, 10) lies on that line of sight,
    // so it is on the canvas centre; (40, 0, 10) is right of it, (20, 0, 20) above.
    await clickView("front");
    const fc = screenPoint(box, [20, 0, 10], FRONT);
    assert.ok(Math.abs(fc.x - (box.x + box.width / 2)) < 0.5 && Math.abs(fc.y - (box.y + box.height / 2)) < 0.5);
    assert.ok(screenPoint(box, [40, 0, 10], FRONT).x > fc.x && screenPoint(box, [20, 0, 20], FRONT).y < fc.y);
    for (const p of [[1, 0, 10], [39, 0, 10], [20, 0, 19], [20, 0, 1]]) assert.ok(isBody(await sample(FRONT, p)), `front: ${p} is on the face`);
    for (const p of [[-2, 0, 10], [42, 0, 10]]) assert.ok(!isBody(await sample(FRONT, p)), `front: ${p} is off the box`);
    await pickAt(FRONT, [20, 0, 10], "face:feature-1/front");
    await pickAt(FRONT, [35, 0, 10], "face:feature-1/front");

    // Right: from +X, Z up, +Y to the right: the 30 × 20 +X face (face 5).
    await clickView("right");
    assert.ok(screenPoint(box, [40, 30, 10], RIGHT).x > screenPoint(box, [40, 0, 10], RIGHT).x, "+Y to the right");
    for (const p of [[40, 1, 10], [40, 29, 10]]) assert.ok(isBody(await sample(RIGHT, p)), `right: ${p} is on the face`);
    for (const p of [[40, -2, 10], [40, 32, 10]]) assert.ok(!isBody(await sample(RIGHT, p)), `right: ${p} is off the box`);
    await pickAt(RIGHT, [40, 15, 10], "face:feature-1/right");
    await pickAt(RIGHT, [40, 25, 5], "face:feature-1/right");

    // Home brings back the view every other check's positions assume.
    await clickView("home");
    await pickAt(HOME, [20, 15, 20], "face:feature-1/top");

    // Fit with the top face selected frames that face from the current
    // (home) direction: a sphere at (20, 15, 20) with r = √(40² + 30²)/2
    // = 25, nearer than the body's √2900/2 ≈ 26.93, so the face fills more.
    const TOP_FACE = { ...HOME, centre: [20, 15, 20], radius: 25 };
    const tc = screenPoint(box, [20, 15, 20], HOME);
    await page.mouse.click(tc.x, tc.y);
    assert.equal(await selection(), "face:feature-1/top");
    await clickView("fit");
    await page.screenshot({ path: "e2e/view-fit-face.png" });
    const fitted = screenPoint(box, [20, 15, 20], TOP_FACE);
    assert.ok(Math.abs(fitted.x - (box.x + box.width / 2)) < 0.5 && Math.abs(fitted.y - (box.y + box.height / 2)) < 0.5);
    // Points 0.5 mm in from the near and far corners, placed by the new
    // framing (the left and right corners fall past a canvas this narrow:
    // fit() frames the sphere to the vertical field of view only).
    for (const p of [[20, 15, 20], [39.5, 0.5, 20], [0.5, 29.5, 20]]) assert.ok(isBody(await sample(TOP_FACE, p)), `fit: ${p} is on the face`);
    await page.keyboard.press("Escape");
    await page.mouse.click(fitted.x, fitted.y);
    assert.equal(await selection(), "face:feature-1/top", "picking works in the fitted view");
    // Nothing selected: Fit frames the whole body from home, as fit() does.
    await page.keyboard.press("Escape");
    await clickView("top");
    await clickView("fit");
    await pickAt(HOME, [20, 15, 20], "face:feature-1/top");
    await pickAt(HOME, [20, 0, 10], "face:feature-1/front");
  });

  await check("the view cube turns the camera like the View buttons and never picks", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const cube = await page.locator("#viewport .view-cube").boundingBox();
    const selection = () => page.evaluate(() => document.body.dataset.selection ?? "");
    const settle = async () => {
      await page.mouse.move(box.x + 2, box.y + box.height - 2); // nothing hovered, off the cube
      await page.waitForTimeout(200);
    };
    const canvasImage = () => page.evaluate(() => document.querySelector("#viewport canvas").toDataURL());
    // Where a point of the cube (−1…1) lands on screen for a camera looking
    // along −toward with Z up: the cube's camera is orthographic with a
    // half-height of 1.9 cube units over half the element's height, so a
    // point lands at (p·right, p·up) × (height/2)/1.9 from the element's centre.
    const cubePoint = (p, toward) => {
      const unit = (a) => a.map((x) => x / Math.hypot(...a));
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const fwd = unit(toward).map((d) => -d);
      const right = unit(cross(fwd, [0, 0, 1]));
      const up = cross(right, fwd);
      const k = cube.height / 2 / 1.9;
      return { x: cube.x + cube.width / 2 + dot(p, right) * k, y: cube.y + cube.height / 2 - dot(p, up) * k };
    };
    assert.ok(cube.x + cube.width <= box.x + box.width && cube.y >= box.y, "the cube is inside the viewport");
    assert.ok(cube.x > box.x + box.width / 2 && cube.y < box.y + box.height / 2, "the cube sits in the top-right corner");

    // A face is selected; clicking the cube must not pick (which would change it).
    const top = screenPoint(box, [20, 15, 20]);
    await page.mouse.click(top.x, top.y);
    assert.equal(await selection(), "face:feature-1/top");

    // The screen from the Top button, for comparison (whole canvas, cube included).
    await page.click("#view-controls [data-view=top]");
    await settle();
    const fromButton = await canvasImage();
    await page.click("#view-controls [data-view=home]");
    await settle();
    assert.ok((await canvasImage()) !== fromButton, "home and top differ on screen");

    // Home looks along −(0.6, −0.8, 0.55)/1.14127: the top face's centre (0, 0, 1)
    // has p·right = 0 (right = (0.8, 0.6, 0)) and p·up = √(1 − 0.4819²) = 0.8762,
    // so it is 0.8762 × 48/1.9 = 22.1 px above the centre of a 96 px cube.
    const topFace = cubePoint([0, 0, 1], HOME.toward);
    assert.ok(Math.abs(topFace.y - (cube.y + cube.height / 2 - 0.8762 * (cube.height / 2 / 1.9))) < 0.5);
    await page.mouse.move(topFace.x, topFace.y);
    await page.waitForFunction(() => document.querySelector("#viewport .view-cube").dataset.hover === "top");
    await page.mouse.click(topFace.x, topFace.y);
    await settle();
    assert.ok((await canvasImage()) === fromButton, "the cube's Top gives the Top button's camera");
    assert.equal(await selection(), "face:feature-1/top", "the cube click did not pick");

    await page.click("#view-controls [data-view=home]");
    await settle();
    // A corner: (0.8, −0.8, 1) is in the top face's top-front-right corner square (both past 0.6).
    const corner = cubePoint([0.8, -0.8, 1], HOME.toward);
    await page.mouse.move(corner.x, corner.y);
    await page.waitForFunction(() => document.querySelector("#viewport .view-cube").dataset.hover === "top-front-right");
    await page.mouse.click(corner.x, corner.y);
    await settle();
    // The camera now looks from (1, −1, 1): the top face and the front face pick where that view puts them.
    const CORNER = { ...HOME, toward: [1, -1, 1] };
    await page.keyboard.press("Escape");
    for (const [p, expected] of [[[20, 15, 20], "face:feature-1/top"], [[20, 0, 10], "face:feature-1/front"]]) {
      const s = screenPoint(box, p, CORNER);
      await page.mouse.click(s.x, s.y);
      assert.equal(await selection(), expected, `corner view: pick at ${p}`);
      await page.keyboard.press("Escape");
    }
    // A press that drags on the cube orbits (SF3a; e2e/navigation.mjs checks the angle) and picks nothing.
    await settle();
    const before = await canvasImage();
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down();
    await page.mouse.move(corner.x - 40, corner.y + 30, { steps: 5 });
    await page.mouse.up();
    await settle();
    assert.ok((await canvasImage()) !== before, "a drag on the cube orbits");
    assert.equal(await selection(), "", "and picks nothing");
    await page.click("#view-controls [data-view=home]");
    await settle();
  });

  await check("the camera survives switching workspaces and a rebuild that does not re-frame", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const canvasImage = () => page.evaluate(() => document.querySelector("#viewport canvas").toDataURL());
    const settle = async () => {
      await page.mouse.move(box.x + 2, box.y + box.height - 2); // nothing hovered
      await page.waitForTimeout(200);
    };
    await page.click("#view-controls [data-view=front]");
    await settle();
    const front = await canvasImage();
    // Laser shows the same viewport; back in Design the camera is where it was.
    await page.click("[data-workspace=laser]");
    await page.click("[data-workspace=design]");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    await settle();
    assert.ok((await canvasImage()) === front, "Front is kept across a workspace switch");
    // 41 mm and back: two rebuilds well inside the framed sphere, so neither re-frames.
    const radius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);
    await setSize("width", 41);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,600 mm³"); // 41·30·20
    await setSize("width", 40);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await settle();
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.framedRadius), radius, "not re-framed");
    assert.ok((await canvasImage()) === front, "Front is kept across rebuilds");
    // Still Front: (20, 0, 10) picks the front face.
    const s = screenPoint(box, [20, 0, 10], FRONT);
    await page.mouse.click(s.x, s.y);
    assert.equal(await page.evaluate(() => document.body.dataset.selection ?? ""), "face:feature-1/front");
    await page.keyboard.press("Escape");
    await page.click("#view-controls [data-view=home]");
    await settle();
  });

  await check("editing a size rebuilds the body", async () => {
    await setSize("width", 100);
    // V = 100·30·20 = 60000.
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "60,000 mm³");
  });

  await check("bad input shows an error instead of crashing", async () => {
    await setSize("width", 0);
    await page.waitForFunction(() => document.querySelector("#error").textContent.includes("width must be"));
    // The old numbers stay on screen, but marked out of date, never shown as current.
    assert.equal(await page.$eval("#stats", (el) => el.dataset.stale), "true");
    assert.equal(await page.isVisible("#stale-note"), true);
    await setSize("width", 40);
    await page.waitForFunction(() => document.querySelector("#error").textContent === "");
    assert.equal(await text("volume"), "24,000 mm³");
    assert.equal(await page.$eval("#stats", (el) => el.dataset.stale), "false");
    assert.equal(await page.isVisible("#stale-note"), false);
  });

  await check("the kernel runs in a Web Worker, not on the main thread", async () => {
    const workers = page.workers();
    assert.equal(workers.length, 1, "expected exactly one worker");
    // The page itself must not have loaded the wasm module.
    const wasmOnPage = await page.evaluate(() =>
      performance.getEntriesByType("resource").some((r) => r.name.endsWith(".wasm")),
    );
    assert.equal(wasmOnPage, false, "main thread fetched the .wasm file");
  });

  await check("a burst of edits ends showing the last one", async () => {
    // Type 20 widths as fast as possible; replies may race, but the screen
    // must end on the last: 77 × 30 × 20 = 46200.
    for (let w = 1; w <= 20; w++) await setSize("width", w);
    await setSize("width", 77);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "46,200 mm³");
    await page.waitForTimeout(300);
    assert.equal(await text("volume"), "46,200 mm³");
    await setSize("width", 40);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  });

  await check("a 1 µm cube is measured and framed", async () => {
    // 0.001³ = 1e-9 mm³ and 6 · 0.001² = 6e-6 mm²: never shown as 0.
    for (const id of ["width", "depth", "height"]) await setSize(id, 0.001);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "1 × 10⁻⁹ mm³");
    assert.equal(await text("area"), "6 × 10⁻⁶ mm²");
    // The camera re-framed on it: radius = half the diagonal = √3·0.001/2
    // ≈ 8.66e-4 (float32 mesh positions, so compare to 1e-6 relative).
    const r = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(r - Math.sqrt(3) * 0.001 / 2) < 1e-9, `framed radius ${r}`);
    await page.waitForTimeout(300);
    assert.notDeepEqual(await pixel(0.5, 0.5), [0x14, 0x16, 0x1a], "the cube should fill the centre of the view");
    await page.screenshot({ path: "e2e/tiny-cube.png" });
    // Back to 40 × 30 × 20, one size at a time, re-framing whenever the body
    // reaches past 1.5× the framed radius:
    // 40 × 0.001 × 0.001: r ≈ 20, far beyond 1.5 × 8.66e-4 → re-frame, r0 = 20 at (20, 0, 0).
    // 40 × 30 × 0.001: r = √(1600 + 900)/2 = 25, centre moved 15; 15 + 25 = 40 > 30 → re-frame.
    // 40 × 30 × 20: r = √2900/2 ≈ 26.93, centre moved 10; 36.93 ≤ 37.5 → kept, r0 = 25.
    for (const [id, v] of [["width", 40], ["depth", 30], ["height", 20]]) await setSize(id, v);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    const back = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(back - 25) < 1e-4, `framed radius ${back}`);
  });

  /** The number shown in a stats field, e.g. "21,484.26 mm³" → 21484.26. */
  const shown = async (id) => Number((await text(id)).split(" ")[0].replaceAll(",", ""));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${what}: shown ${a}, expected ${b}`);
  const pick = async (kind, volumeNot) => {
    await page.click(`#toolbar [data-shape=${kind}]`);
    await page.waitForFunction(
      ([k, v]) => document.querySelector("#viewport").dataset.shape === k && document.querySelector("#volume")?.textContent !== v,
      [kind, volumeNot],
    );
    // The toolbar shows the shape on screen pressed, and only that one.
    assert.deepEqual(await page.$$eval("#toolbar [aria-pressed=true]", (els) => els.map((e) => e.dataset.shape)), [kind]);
  };

  await check("L-bracket extrusion shows hand-worked numbers", async () => {
    // 40 × 30 outline with arms 0.3 thick: 1200 − 28·21 = 612 mm²; the
    // perimeter equals the rectangle's, 140. Extruded 20: V = 612·20 =
    // 12240, S = 2·612 + 140·20 = 4024. Six corners: 12 V, 18 E, 8 F.
    await pick("l-bracket", "24,000 mm³");
    assert.equal(await text("volume"), "12,240 mm³");
    assert.equal(await text("area"), "4,024 mm²");
    assert.equal(await text("topology"), "12 V · 18 E · 8 F");
    assert.equal(await text("status"), "valid");
    assert.equal(await text("height-label"), "Extrude by");
    // The part is feature #1 of the timeline, and knows what it is and where it came from.
    assert.equal(await text("intent"), "Extrude: L-bracket profile 40 × 30 mm, by 20 mm");
    assert.equal(await text("provenance"), "Feature 1 (extrude) comes from L-bracket profile in Design.");
    // A new shape is framed: r = √(40² + 30² + 20²)/2 ≈ 26.93.
    const r = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(r - Math.sqrt(2900) / 2) < 1e-4, `framed radius ${r}`);
    await page.waitForTimeout(300);
    assert.notDeepEqual(await pixel(0.5, 0.5), [0x14, 0x16, 0x1a], "the bracket should be drawn");
    await page.screenshot({ path: "e2e/l-bracket.png" });
  });

  await check("the browser lists the timeline, Body 1 and the origin; Body 1 selects the body", async () => {
    await foldBrowser(true);
    // The L-bracket part from the check above: feature #1 with its intent.
    const rows = async (group) => page.$$eval(`#browser [data-node=${group}] .tree-row`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(await rows("timeline"), ["1. Extrude: L-bracket profile 40 × 30 mm, by 20 mm"]);
    assert.deepEqual(await rows("bodies"), ["Body 1"]);
    assert.deepEqual(await rows("origin"), ["XY plane", "XZ plane", "YZ plane", "X axis", "Y axis", "Z axis"]);
    const current = () => page.$$eval("#browser [aria-current=true]", (els) => els.map((e) => e.dataset.node));
    assert.deepEqual(await current(), []);
    await page.click("#browser [data-node=body-1]");
    assert.deepEqual(await current(), ["body-1"]);
    // Origin rows select nothing until sketches need them (step 21).
    await page.click("#browser [data-node=origin-z]");
    assert.deepEqual(await current(), ["body-1"]);
    // Folding a group keeps it folded when an edit rebuilds the tree.
    await page.click("#browser [data-node=origin] summary");
    await setSize("height", 21);
    await page.waitForFunction(() => document.querySelector("#browser [data-node=feature-1]").textContent.endsWith("by 21 mm"));
    assert.equal(await page.$eval("#browser [data-node=origin]", (el) => el.open), false);
    assert.deepEqual(await current(), ["body-1"], "the body stays selected through the edit");
    await page.click("#browser [data-node=origin] summary");
    await setSize("height", 20);
    await page.screenshot({ path: "e2e/browser.png" });
    await page.keyboard.press("Escape");
  });

  await check("plate with two round holes: area minus the holes, times the distance", async () => {
    // The numbers shown are exact (from the B-rep, not the mesh). Holes of
    // radius 0.15·30 = 4.5: profile 1200 − 2·π·4.5² = 1200 − 40.5π,
    // perimeters 140 + 2·2π·4.5 = 140 + 18π. Extruded 20:
    // V = 20(1200 − 40.5π), S = 2(1200 − 40.5π) + 20(140 + 18π).
    // Square 8 V, 12 E, 4 sides; each circle 2 V, 2 E, 1 side; 2 caps:
    // 12 V, 16 E, 8 F (genus 2).
    await pick("plate", "12,240 mm³");
    near(await shown("volume"), 20 * (1200 - 40.5 * Math.PI), "volume");
    near(await shown("area"), 2 * (1200 - 40.5 * Math.PI) + 20 * (140 + 18 * Math.PI), "area");
    assert.equal(await text("topology"), "12 V · 16 E · 8 F");
    assert.equal(await text("status"), "valid");
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/plate.png" });
  });

  await check("cylinder primitive: diameter from the width", async () => {
    // Diameter 40 so r = 20, height 20: V = π·400·20 = 8000π, A = 2·400π +
    // 2π·20·20 = 1600π. 2 V, 2 E, 3 F. The depth box is hidden (a
    // cylinder has no depth).
    await pick("cylinder", await text("volume"));
    near(await shown("volume"), 8000 * Math.PI, "volume");
    near(await shown("area"), 1600 * Math.PI, "area");
    assert.equal(await text("topology"), "2 V · 2 E · 3 F");
    assert.equal(await text("width-label"), "Diameter");
    assert.equal(await page.isVisible("#depth-row"), false);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/cylinder.png" });
  });

  await check("sphere primitive: diameter from the width", async () => {
    // Diameter 40 so r = 20: V = 4/3·π·8000, A = 4π·400 = 1600π. One
    // vertex and the equator edge between two hemispheres. Neither depth
    // nor height applies.
    await pick("sphere", await text("volume"));
    near(await shown("volume"), (32000 / 3) * Math.PI, "volume");
    near(await shown("area"), 1600 * Math.PI, "area");
    assert.equal(await text("topology"), "1 V · 1 E · 2 F");
    assert.equal(await page.isVisible("#depth-row"), false);
    assert.equal(await page.isVisible("#height-row"), false);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/sphere.png" });
  });

  await check("slot with round ends", async () => {
    // 40 × 30: straight sides 10 long, ends half circles of radius 15.
    // Profile 10·30 + π·15² = 300 + 225π, perimeter 2·10 + 2π·15 = 20 + 30π.
    // V = 20(300 + 225π), S = 2(300 + 225π) + 20(20 + 30π).
    // 4 corners: 8 V, 12 E, 4 sides + 2 caps.
    await pick("slot", await text("volume"));
    near(await shown("volume"), 20 * (300 + 225 * Math.PI), "volume");
    near(await shown("area"), 2 * (300 + 225 * Math.PI) + 20 * (20 + 30 * Math.PI), "area");
    assert.equal(await text("topology"), "8 V · 12 E · 6 F");
    assert.equal(await text("status"), "valid");
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/slot.png" });
  });

  await check("star extrusion", async () => {
    // Ten corners alternating R = 15 and r = 6, 36° apart: 10 triangles of
    // ½·R·r·sin 36°, so A = 5·15·6·sin 36°, V = 20·A. 20 V, 30 E, 12 F.
    await pick("star", await text("volume"));
    near(await shown("volume"), 5 * 15 * 6 * Math.sin(Math.PI / 5) * 20, "volume");
    assert.equal(await text("topology"), "20 V · 30 E · 12 F");
    await page.waitForTimeout(300);
    await page.screenshot({ path: "e2e/star.png" });
  });

  await check("an outline with walls under 1 µm shows the kernel's reason", async () => {
    // Plate 0.008 × 0.008: holes of radius 0.15·0.008 = 0.0012 (a legal
    // radius) centred 0.002 from the edge, leaving a 0.0008 mm wall, below
    // the 0.001 mm minimum feature.
    await page.click("#toolbar [data-shape=plate]");
    for (const id of ["width", "depth"]) await setSize(id, 0.008);
    await page.waitForFunction(() => document.querySelector("#error").textContent.includes("features must be at least"));
    for (const [id, v] of [["width", 40], ["depth", 30]]) await setSize(id, v);
    await page.waitForFunction(() => document.querySelector("#error").textContent === "");
    await page.click("#toolbar [data-shape=box]");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  });

  /** Clicks the toolbar's STL button (or `button`); returns the file's name and its triangles (f32 corners). */
  const downloadStl = async (button = "#toolbar [data-op=export_stl]") => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click(button)]);
    const bytes = readFileSync(await dl.path());
    const n = bytes.readUInt32LE(80);
    const tris = [];
    for (let t = 0; t < n; t++) {
      const at = 84 + 50 * t + 12;
      const p = (k) => [0, 1, 2].map((i) => bytes.readFloatLE(at + 12 * k + 4 * i));
      tris.push([p(0), p(1), p(2)]);
    }
    return { name: dl.suggestedFilename(), size: bytes.length, header: bytes.subarray(0, 12).toString("latin1"), tris };
  };
  /** Volume enclosed by triangles (divergence theorem: Σ a·(b×c)/6). */
  const stlVolume = (tris) =>
    tris.reduce((v, [a, b, c]) => v + (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);

  await check("the STL button saves the box as a binary STL with hand-worked contents", async () => {
    await page.click("#toolbar [data-shape=box]");
    await page.fill("#width", "40");
    await page.fill("#depth", "30");
    await page.fill("#height", "20");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    const f = await downloadStl();
    // 12 triangles: 84 + 12 × 50 = 684 bytes. Corners 0/40, 0/30, 0/20 are
    // exact in single precision, so the volume is exactly 40 × 30 × 20.
    assert.equal(f.name, "fission-box.stl");
    assert.equal(f.header, "Fission STL:");
    assert.equal(f.size, 684);
    assert.equal(f.tris.length, 12);
    assert.equal(stlVolume(f.tris), 24000);
    assert.equal(await text("action-note"), "");
  });

  await check("a selected body offers Download STL from the action registry, and it saves the same file", async () => {
    // Verbs, not apps (X1): nothing selected, no verbs; Body 1 selected,
    // the registry's Download STL; it gives the hand-worked box file above.
    const verbs = () => page.$$eval("#selection-actions button", (bs) => bs.map((b) => [b.textContent, b.dataset.action]));
    assert.equal(await page.isVisible("#selection-actions"), false);
    await page.click("#browser [data-node=body-1]");
    await page.waitForFunction(() => document.body.dataset.selection === "body:feature-1");
    assert.deepEqual(await verbs(), [["Download STL", "design.download-stl"]]);
    assert.equal(await page.isVisible("#selection-actions"), true);
    const f = await downloadStl("#selection-actions [data-action='design.download-stl']");
    assert.equal(f.name, "fission-box.stl");
    assert.equal(f.size, 684);
    assert.equal(stlVolume(f.tris), 24000); // 40 × 30 × 20, exact in single precision
    assert.equal(await text("action-note"), "");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.body.dataset.selection === "");
    assert.deepEqual(await verbs(), []);
    assert.equal(await page.isVisible("#selection-actions"), false);
  });

  await check("a cylinder's STL is the prism the viewer shows", async () => {
    await page.click("#toolbar [data-shape=cylinder]");
    await page.fill("#width", "40");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "cylinder");
    const f = await downloadStl();
    // n sides: 2n side triangles + 2 caps of n − 2 = 4n − 4 triangles, so
    // n = (count + 4) / 4. The prism over the inscribed n-gon of r = 20,
    // h = 20 has V = (n/2) r² sin(2π/n) h (single-precision corners: ~1e-6).
    const n = (f.tris.length + 4) / 4;
    assert.ok(Number.isInteger(n) && n >= 3, `${f.tris.length} triangles`);
    const expected = (n / 2) * 400 * Math.sin((2 * Math.PI) / n) * 20;
    assert.ok(Math.abs(stlVolume(f.tris) - expected) <= 1e-6 * expected, `${stlVolume(f.tris)} vs ${expected}`);
    assert.equal(f.name, "fission-cylinder.stl");
  });

  await check("a part too big for single precision is exported with a warning", async () => {
    // A 999,999.3 mm cube (just inside the 1 km limit): the far corners round
    // to 999,999.3125 in single precision (spacing 1/16 there), 0.0125 mm
    // off, over the 1 µm smallest feature. A cube, so its faces are big
    // enough on screen to see the overlay.
    await page.click("#toolbar [data-shape=box]");
    for (const id of ["width", "depth", "height"]) await page.fill(`#${id}`, "999999.3");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "box" && document.querySelector("#status").textContent === "valid");
    const f = await downloadStl();
    assert.equal(f.tris.length, 12);
    assert.match(await text("action-note"), /single-precision numbers: this part's corners move by up to 1\.250e-2 mm/);
    // The analysis overlay marks the part itself, with a legend.
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.overlays), "design.stl-precision");
    assert.equal(await page.textContent(".overlay-legend"), "Too big for an accurate STL");
    // Count amber pixels: red well above blue (the plain part is blue-grey,
    // the background dark).
    await page.waitForTimeout(300);
    const amber = () =>
      page.evaluate(() => {
        const src = document.querySelector("#viewport canvas");
        const c = document.createElement("canvas");
        [c.width, c.height] = [src.width, src.height];
        const ctx = c.getContext("2d");
        ctx.drawImage(src, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 2] + 40) n++;
        return n;
      });
    assert.ok((await amber()) > 10000, `the part should be painted amber (${await amber()} px)`);
    await page.screenshot({ path: "e2e/stl-overlay.png" });
    for (const [id, v] of [["width", 40], ["depth", 30], ["height", 20]]) await page.fill(`#${id}`, String(v));
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    // Editing the part clears the overlay: it described the part before the edit.
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.overlays), "");
    assert.equal(await page.isVisible(".overlay-legend"), false);
    await page.waitForTimeout(300);
    // Only the red X axis line is left (a few dozen pixels).
    assert.ok((await amber()) < 1000, `nothing amber once the overlay is cleared (${await amber()} px)`);
    await downloadStl();
    assert.equal(await text("action-note"), ""); // the warning goes once the part fits again
  });

  await check("the switcher lists the ten workspaces, Design first, Design and Image working", async () => {
    const tabs = await page.$$eval("#workspaces [role=tab]", (ts) => ts.map((t) => [t.textContent, t.classList.contains("soon")]));
    assert.deepEqual(tabs, [
      ["Design", false],
      ["Render", true],
      ["Simulate", true],
      ["Manufacture", true],
      ["Laser", true],
      ["Slice", true],
      ["Circuit", true],
      ["Vector", true],
      ["Image", false],
      ["Layout", true],
    ]);
    assert.equal(await page.getAttribute("[data-workspace=design]", "aria-selected"), "true");
  });

  await check("each placeholder workspace says what it will do and 'Coming soon', and keeps the viewport", async () => {
    // Back to a known body, then remember the camera's view of it.
    await page.click("#toolbar [data-shape=box]");
    await page.fill("#width", "40");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await page.waitForTimeout(300); // let orbit damping settle
    const radius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);
    const before = await pixel(0.5, 0.5);
    for (const [id, title] of [["render", "Render"], ["simulate", "Simulate"], ["manufacture", "Manufacture"], ["laser", "Laser"], ["slice", "Slice"], ["circuit", "Circuit"], ["vector", "Vector"], ["layout", "Layout"]]) {
      await page.click(`[data-workspace=${id}]`);
      assert.equal(await page.textContent(".placeholder h2"), title);
      assert.equal(await page.textContent(".placeholder .coming-soon"), "Coming soon");
      assert.match(await page.textContent(".placeholder .starts-after"), /^Work starts after CAD step \d+/);
      assert.equal(await page.$eval("body", (b) => b.dataset.activeWorkspace), id);
      assert.equal(new URL(page.url()).hash, `#${id}`);
      await page.screenshot({ path: `e2e/workspace-${id}.png` });
    }
    // The body and camera stayed put the whole time.
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.framedRadius), radius);
    assert.deepEqual(await pixel(0.5, 0.5), before);
  });

  await check("the community page promises free sharing only", async () => {
    await page.click("#community");
    assert.equal(await page.textContent(".placeholder h2"), "Community");
    assert.match(await page.textContent(".placeholder"), /Everything here is free: no paid models, no payments\./);
    assert.equal(await page.getAttribute("#community", "aria-pressed"), "true");
    await page.screenshot({ path: "e2e/community.png" });
  });

  await check("back in Design the part, its numbers and the camera are as they were", async () => {
    const radius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);
    await page.click("[data-workspace=design]");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    assert.equal(await page.inputValue("#width"), "40");
    assert.equal(await page.getAttribute("#toolbar [data-shape=box]", "aria-pressed"), "true");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.framedRadius), radius);
    assert.equal(await page.textContent("#browser [data-node=feature-1]"), "1. Box: 40 × 30 × 20 mm");
    await page.screenshot({ path: "e2e/workspace-design.png" });
  });

  await check("opening a workspace link goes straight to it", async () => {
    await page.goto(`${url}#laser`);
    assert.equal(await page.textContent(".placeholder h2"), "Laser");
    assert.equal(await page.getAttribute("[data-workspace=laser]", "aria-selected"), "true");
  });

  await check("the assistant is optional, off, and follows the active workspace", async () => {
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    // Off by default: nothing is sent anywhere.
    assert.equal(await page.textContent("#assistant-toggle"), "AI off");
    assert.equal(await page.isVisible("#assistant"), false);
    await page.click("#assistant-toggle");
    assert.equal(await page.isDisabled("#ai-ask-button"), true, "nothing to ask with until a provider is chosen");
    assert.match(await page.textContent("#ai-status-detail"), /Nothing is sent anywhere/);
    assert.match(await page.textContent("#assistant"), /Planned in Design.*Plain-English commands/s);
    // The settings list the four providers and say which keep data local.
    assert.equal(await page.locator("#assistant [data-provider]").count(), 4);
    assert.match(await page.textContent('[data-provider="ollama"]'), /stays on your machine.*OLLAMA_ORIGINS/s);
    assert.match(await page.textContent('[data-provider="api-key"]'), /sends your request to the provider.*Consumer chat subscriptions can't be used/s);
    await page.screenshot({ path: "e2e/assistant.png" });
    // Switching workspace keeps the panel and changes what it lists.
    await page.click('[data-workspace="laser"]');
    assert.match(await page.textContent("#assistant"), /Planned in Laser.*finger-joint boxes/s);
    assert.doesNotMatch(await page.textContent("#assistant"), /Planned in Design/);
    await page.click("#assistant-toggle");
    assert.equal(await page.isVisible("#assistant"), false);
    await page.click('[data-workspace="design"]');
  });

  await check("desktop: focus moves top bar, toolbar, browser, View buttons, Split, properties; panel toggles hidden", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    assert.equal(await page.isVisible("#panel-toggles"), false);
    assert.equal(await page.isVisible("#browser"), true);
    assert.equal(await page.isVisible("#properties"), true);
    // Tab from the top of the page and note which region each stop is in;
    // the regions must come in reading order, each once.
    const regions = [];
    for (let i = 0; i < 120 && regions.at(-1) !== "properties"; i++) {
      await page.keyboard.press("Tab");
      const region = await page.evaluate(() => document.activeElement?.closest("#topbar, #toolbar, #browser, #view-controls, #split-toggle, #properties")?.id ?? "other");
      if (region !== regions.at(-1)) regions.push(region);
    }
    // The View buttons and Split sit over the viewport, between the browser and properties.
    assert.deepEqual(regions, ["topbar", "toolbar", "browser", "view-controls", "split-toggle", "properties"]);
    await page.screenshot({ path: "e2e/design-1280.png" });
  });

  await check("phone width: no sideways scroll, browser and properties fold behind toggles", async () => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    // The canvas keeps the size it was drawn at until the viewer's resize
    // observer runs (a frame after layout), so measure only once it has
    // followed the viewport to phone width; before that it can stick out.
    await page.waitForFunction(() => {
      const v = document.querySelector("#viewport");
      const c = v?.querySelector("canvas");
      return c && v.clientWidth > 0 && Math.abs(c.getBoundingClientRect().width - v.clientWidth) < 1;
    });
    const overflow = () =>
      page.evaluate(() =>
        ["html", "body", "#topbar", "#workspace", "#panel-toggles"]
          .map((s) => document.querySelector(s))
          .filter((el) => el.scrollWidth > el.clientWidth)
          .map((el) => `${el.id || el.tagName}: ${el.scrollWidth} > ${el.clientWidth}`),
      );
    assert.deepEqual(await overflow(), []);
    // The viewport keeps the full width and a fixed share of the height;
    // properties start open below it, browser closed.
    const box = await page.$eval("#viewport", (el) => el.getBoundingClientRect().toJSON());
    assert.equal(box.width, 375);
    assert.ok(Math.abs(box.height - 0.55 * 740) < 1, `viewport height ${box.height}`);
    assert.equal(await page.isVisible("#browser"), false);
    assert.equal(await page.isVisible("#properties"), true);
    assert.equal(await page.getAttribute("#browser-toggle", "aria-expanded"), "false");
    await page.screenshot({ path: "e2e/design-375.png" });
    await page.$eval("#workspace", (el) => el.scrollTo(0, el.scrollHeight));
    await page.screenshot({ path: "e2e/design-375-scrolled.png" });
    await page.click("#browser-toggle");
    assert.equal(await page.getAttribute("#browser-toggle", "aria-expanded"), "true");
    assert.equal(await page.textContent("#browser [data-node=feature-1]"), "1. Box: 40 × 30 × 20 mm");
    await page.click("#properties-toggle");
    assert.equal(await page.isVisible("#properties"), false);
    assert.deepEqual(await overflow(), []);
    await page.screenshot({ path: "e2e/design-375-browser.png" });
    // Editing still works with the panel reopened.
    await page.click("#properties-toggle");
    await setSize("width", 50);
    // V = 50·30·20 = 30000.
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
    // A placeholder fills only properties: no browser toggle, its page shows.
    await page.click("[data-workspace=laser]");
    assert.equal(await page.isVisible("#browser-toggle"), false);
    assert.equal(await page.isVisible(".placeholder h2"), true);
    assert.deepEqual(await overflow(), []);
    await page.screenshot({ path: "e2e/laser-375.png" });
    await page.click("[data-workspace=design]");
    await page.setViewportSize({ width: 1000, height: 640 });
  });

  await check("phone width: a tap selects a face", async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    phone.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await phone.goto(url + "#design");
      await phone.waitForFunction(() => document.querySelector("#viewport")?.dataset.shape === "box");
      const box = await phone.locator("#viewport canvas").boundingBox();
      const top = screenPoint(box, [20, 15, 20]); // face 1 (framed to the narrower, horizontal fov)
      await phone.touchscreen.tap(top.x, top.y);
      assert.equal(await phone.evaluate(() => document.body.dataset.selection ?? ""), "face:feature-1/top");
      await phone.screenshot({ path: "e2e/design-375-tap.png" });
      // A tap on empty space clears, as a click does.
      await phone.touchscreen.tap(box.x + 4, box.y + 4);
      assert.equal(await phone.evaluate(() => document.body.dataset.selection ?? ""), "");
    } finally {
      await phone.close();
    }
  });

  await check("phone width: View buttons and cube reachable, clear of the panel toggles; a tap on the cube turns the view", async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    phone.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await phone.goto(url + "#design");
      await phone.waitForFunction(() => document.querySelector("#viewport")?.dataset.shape === "box");
      const rect = (sel) => phone.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
      const [viewport, cube, buttons, toggles] = await Promise.all(["#viewport", "#viewport .view-cube", "#view-controls", "#panel-toggles"].map(rect));
      const inside = (a, b) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;
      const apart = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      assert.ok(inside(cube, viewport) && inside(buttons, viewport), "cube and buttons over the viewport");
      assert.ok(apart(cube, toggles) && apart(buttons, toggles), "neither covers the panel toggles");
      assert.ok(apart(cube, buttons), "the cube and the View buttons do not overlap");
      assert.ok(toggles.bottom <= viewport.top, "the toggles sit above the viewport");
      // Every View button is whole on screen and at least 24 px tall to tap.
      for (const b of await phone.$$eval("#view-controls button", (els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        assert.ok(b.left >= 0 && b.right <= 375 && b.height >= 24, JSON.stringify(b));
      }
      const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
      assert.equal(wide, 375, "no sideways scroll");
      const image = () => phone.evaluate(() => document.querySelector("#viewport canvas").toDataURL());
      const settle = () => phone.waitForTimeout(250);
      await phone.tap("#view-controls [data-view=top]");
      await settle();
      const fromButton = await image();
      await phone.tap("#view-controls [data-view=home]");
      await settle();
      assert.ok((await image()) !== fromButton, "home and top differ on screen");
      // The cube's Top face in home: 22.1 px above the centre of the 96 px cube (as on the desktop).
      const k = cube.height / 2 / 1.9;
      await phone.touchscreen.tap(cube.left + cube.width / 2, cube.top + cube.height / 2 - 0.8762 * k);
      await settle();
      assert.ok((await image()) === fromButton, "a tap on the cube's Top gives the Top button's camera");
      assert.equal(await phone.evaluate(() => document.body.dataset.selection ?? ""), "", "the tap did not pick");
      await phone.screenshot({ path: "e2e/design-375-top.png" });
    } finally {
      await phone.close();
    }
  });

  await check("phone width: focus moves top bar, toolbar, panel toggles, Undo and Redo, View buttons, properties", async () => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
    // Tab from the top and note each region and how far down the page it is drawn.
    const tabRegions = async () => {
      // Start on the page's first focusable element (in the top bar), whatever was clicked last.
      await page.evaluate(() => document.querySelector("#topbar :is(a[href], button, input, select)").focus());
      const regions = [{ id: "topbar", top: 0 }];
      for (let i = 0; i < 120 && regions.at(-1)?.id !== "properties"; i++) {
        await page.keyboard.press("Tab");
        const r = await page.evaluate(() => {
          const el = document.activeElement?.closest("#topbar, #toolbar, #panel-toggles, #browser, #undo-redo, #view-controls, #properties");
          return el ? { id: el.id, top: el.getBoundingClientRect().top + document.querySelector("#workspace").scrollTop } : { id: "other", top: -1 };
        });
        if (r.id !== regions.at(-1)?.id) regions.push(r);
      }
      return regions;
    };
    const ids = (regions) => regions.map((r) => r.id);
    const downward = (regions) => regions.every((r, i) => i === 0 || r.top >= regions[i - 1].top);
    if ((await page.getAttribute("#browser-toggle", "aria-expanded")) === "true") await page.click("#browser-toggle");
    let regions = await tabRegions();
    assert.deepEqual(ids(regions), ["topbar", "toolbar", "panel-toggles", "undo-redo", "view-controls", "properties"], "browser folded: no stops in it");
    assert.ok(downward(regions), JSON.stringify(regions));
    // Opened, the browser sits under its toggle, above the viewport, so focus still moves down the screen.
    await page.click("#browser-toggle");
    await page.screenshot({ path: "e2e/design-375-browser-open.png" });
    regions = await tabRegions();
    assert.deepEqual(ids(regions), ["topbar", "toolbar", "panel-toggles", "browser", "undo-redo", "view-controls", "properties"]);
    assert.ok(downward(regions), JSON.stringify(regions));
    await page.click("#browser-toggle");
    await page.setViewportSize({ width: 1000, height: 640 });
  });

  await check("Save, reload, Open: the saved part and its numbers come back, re-framed", async () => {
    await page.goto(url + "#design");
    await page.reload(); // the same URL keeps the page, so start from a fresh app
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await setSize("width", 50);
    // V = 50·30·20 = 30000.
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    assert.equal(download.suggestedFilename(), "Untitled.fission.json");
    const saved = "e2e/saved.fission.json";
    await download.saveAs(saved);
    const file = JSON.parse(readFileSync(saved, "utf8"));
    assert.equal(file.formatVersion, 2);
    assert.deepEqual(file.workspaces.design.timeline.features[0].intent.parameters, { width: 50, depth: 30, height: 20 });
    // A fresh app shows the default 40 × 30 × 20 box again.
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await page.setInputFiles("#open-file", saved);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
    assert.equal(await page.inputValue("#width"), "50");
    assert.equal(await page.textContent("#browser [data-node=feature-1]"), "1. Box: 50 × 30 × 20 mm");
    assert.equal(await text("intent"), "Box: 50 × 30 × 20 mm");
    assert.equal(await text("file-status"), "");
    // Re-framed on the opened part: r = √(50² + 30² + 20²)/2 = √3800/2 ≈ 30.82.
    const r = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(r - Math.sqrt(3800) / 2) < 1e-6, `framed radius ${r}`);
    // Editing the opened part works as usual: 50·30·25 = 37500.
    await setSize("height", 25);
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "37,500 mm³");
    await page.screenshot({ path: "e2e/opened-file.png" });
  });

  await check("a file that is not a project is refused with its message, keeping the open part", async () => {
    await page.setInputFiles("#open-file", { name: "half.fission.json", mimeType: "application/json", buffer: Buffer.from('{"formatVersion": 2, "name": "Cut') });
    await page.waitForFunction(() => document.querySelector("#file-status").textContent !== "");
    assert.match(await text("file-status"), /^Couldn't open “half\.fission\.json”: not a Fission project: the file is not valid JSON/); // the same words as a drop (X6)
    await page.setInputFiles("#open-file", { name: "new.fission.json", mimeType: "application/json", buffer: Buffer.from('{"formatVersion": 99}') });
    await page.waitForFunction(() => /newer Fission/.test(document.querySelector("#file-status").textContent));
    assert.equal(await text("volume"), "37,500 mm³");
    assert.equal(await page.inputValue("#height"), "25");
  });

  await check("autosave: edit the width, wait for Saved, reload, the same part and numbers come back", async () => {
    const kept = await browser.newPage({ viewport: { width: 1000, height: 640 } }); // its own storage, kept across reloads
    kept.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await kept.goto(url + "#design");
      await kept.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      // A new browser: the default part is stored as a new project.
      await kept.waitForFunction(() => document.querySelector("#save-status").dataset.state === "saved");
      assert.equal(await kept.textContent("#save-status"), "Saved");
      const id = await kept.evaluate(() => document.body.dataset.projectId);
      await kept.fill("#width", "50");
      assert.equal(await kept.textContent("#save-status"), "Saving…", "not saved until things are quiet");
      // V = 50·30·20 = 30000.
      await kept.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
      await kept.waitForFunction(() => document.querySelector("#save-status").dataset.state === "saved");
      await kept.reload();
      await kept.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
      assert.equal(await kept.inputValue("#width"), "50");
      assert.equal(await kept.textContent("#browser [data-node=feature-1]"), "1. Box: 50 × 30 × 20 mm");
      assert.equal(await kept.textContent("#area"), "6,200 mm²"); // A = 2(50·30 + 30·20 + 50·20) = 2·3100
      assert.equal(await kept.evaluate(() => document.body.dataset.projectId), id, "the same stored project");
      assert.equal(await kept.textContent("#save-status"), "Saved");
      // Opening a file makes a new stored project; the autosaved one is kept.
      await kept.setInputFiles("#open-file", "e2e/saved.fission.json");
      await kept.waitForFunction((old) => document.body.dataset.projectId !== old, id);
      await kept.waitForFunction(() => document.querySelector("#save-status").dataset.state === "saved");
      const stored = await kept.evaluate(async () => {
        const db = await new Promise((ok, no) => Object.assign(indexedDB.open("fission"), { onsuccess: (e) => ok(e.target.result), onerror: no }));
        const store = db.transaction(db.objectStoreNames[0]).objectStore(db.objectStoreNames[0]);
        const keys = await new Promise((ok) => (store.getAllKeys().onsuccess = (e) => ok(e.target.result)));
        db.close();
        return keys.filter((k) => String(k).startsWith("project/")).length;
      });
      assert.equal(stored, 2);
    } finally {
      await kept.close();
    }
  });

  // Reads IndexedDB keys in a page, straight from the database (not through the app).
  const storedKeys = (p) =>
    p.evaluate(async () => {
      const db = await new Promise((ok, no) => Object.assign(indexedDB.open("fission"), { onsuccess: (e) => ok(e.target.result), onerror: no }));
      const store = db.transaction("kv").objectStore("kv");
      const keys = await new Promise((ok) => (store.getAllKeys().onsuccess = (e) => ok(e.target.result)));
      db.close();
      return keys.map(String);
    });

  await check("phone width: the workspace tabs keep the top bar; Save, Open, AI and Community are behind Menu", async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 } });
    phone.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await phone.addInitScript(() => indexedDB.deleteDatabase("fission"));
      await phone.goto(url + "#design");
      await phone.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      const rect = (sel) => phone.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
      const visible = (sel) => phone.$eval(sel, (el) => el.getBoundingClientRect().width > 0);
      // 19a left Save/Open squeezing the tabs to 6 px; now at least three whole tabs show.
      const nav = await rect("#workspaces");
      const tabs = await phone.$$eval("#workspaces [role=tab]", (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
      const whole = tabs.filter((t) => t.left >= nav.left - 0.5 && t.right <= nav.right + 0.5);
      assert.ok(whole.length >= 3, `${whole.length} whole tabs in ${nav.width} px`);
      for (const id of ["save", "open", "assistant-toggle", "community"]) assert.equal(await visible(`#${id}`), false, `${id} folded away`);
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll");
      // Menu shows all four, inside the screen.
      await phone.click("#menu-toggle");
      assert.equal(await phone.getAttribute("#menu-toggle", "aria-expanded"), "true");
      for (const id of ["save", "open", "assistant-toggle", "community"]) {
        const b = await rect(`#${id}`);
        assert.ok(b.width > 0 && b.left >= 0 && b.right <= 375 && b.height >= 32, `${id} ${JSON.stringify(b)}`);
      }
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll with the menu open");
      await phone.screenshot({ path: "e2e/design-375-menu.png" });
      // Escape closes it and puts focus back on Menu.
      await phone.keyboard.press("Escape");
      assert.equal(await visible("#save"), false);
      assert.equal(await phone.evaluate(() => document.activeElement?.id), "menu-toggle");
      // From the keyboard: Enter opens it and Tab moves into it, Save first.
      await phone.keyboard.press("Enter");
      await phone.keyboard.press("Tab");
      assert.equal(await phone.evaluate(() => document.activeElement?.id), "save");
      // Choosing an item does it and closes the menu.
      const [download] = await Promise.all([phone.waitForEvent("download"), phone.keyboard.press("Enter")]);
      assert.equal(download.suggestedFilename(), "Untitled.fission.json");
      assert.equal(await phone.getAttribute("#menu-toggle", "aria-expanded"), "false");
      // A tap elsewhere closes it too.
      await phone.click("#menu-toggle");
      await phone.mouse.click(180, 400);
      assert.equal(await visible("#save"), false);
      // A workspace far along the tabs is scrolled into view when chosen.
      await phone.goto(url + "#layout");
      await phone.waitForFunction(() => document.body.dataset.activeWorkspace === "layout");
      const layout = await rect("#workspaces [data-workspace=layout]");
      const nav2 = await rect("#workspaces");
      assert.ok(layout.left >= nav2.left - 0.5 && layout.right <= nav2.right + 0.5, `Layout tab ${JSON.stringify(layout)} in ${JSON.stringify(nav2)}`);
      await phone.screenshot({ path: "e2e/layout-375.png" });
    } finally {
      await phone.close();
    }
  });

  await check("wide screen: every tab, Save, Open, AI and Community in one row, no Menu", async () => {
    const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    wide.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await wide.addInitScript(() => indexedDB.deleteDatabase("fission"));
      await wide.goto(url + "#design");
      await wide.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
      const rect = (sel) => wide.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
      assert.equal((await rect("#menu-toggle")).width, 0, "no Menu");
      const bar = await rect("#topbar");
      assert.equal(bar.height, 44, "one row");
      const nav = await rect("#workspaces");
      for (const t of await wide.$$eval("#workspaces [role=tab]", (els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        assert.ok(t.right <= nav.right + 0.5, "every tab shows");
      }
      // Again in DejaVu Sans, the wide font CI's Linux uses for system-ui: the
      // row once fitted locally and overflowed there (20b's Undo/Redo).
      await wide.addStyleTag({ content: "html, body { font-family: 'DejaVu Sans' !important; }" });
      const navDejaVu = await rect("#workspaces");
      for (const t of await wide.$$eval("#workspaces [role=tab]", (els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
        assert.ok(t.right <= navDejaVu.right + 0.5, "every tab shows in DejaVu Sans");
      }
      assert.equal((await rect("#topbar")).height, 44, "one row in DejaVu Sans");
      for (const id of ["save", "open", "save-status", "assistant-toggle", "community"]) {
        const b = await rect(`#${id}`);
        assert.ok(b.width > 0 && b.right <= 1280 && b.top >= bar.top && b.bottom <= bar.bottom, id);
      }
      await wide.screenshot({ path: "e2e/design-1280.png" });
    } finally {
      await wide.close();
    }
  });

  await check("a stored project that no longer opens starts a new project with a message, readable at phone width", async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 } }); // its own storage, kept across reloads
    phone.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await phone.goto(url + "#design");
      await phone.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
      const id = await phone.evaluate(() => document.body.dataset.projectId);
      // Cut the stored project short, as a crash in the middle of a write might.
      await phone.evaluate(async (id) => {
        const db = await new Promise((ok, no) => Object.assign(indexedDB.open("fission"), { onsuccess: (e) => ok(e.target.result), onerror: no }));
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put('{"formatVersion": 2, "name": "Untit', `project/${id}`);
        await new Promise((ok) => (tx.oncomplete = ok));
        db.close();
      }, id);
      await phone.reload();
      // Not a blank app: the default part, and the message in full.
      await phone.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      const message = await phone.textContent("#file-status");
      assert.match(message, new RegExp(`^Couldn't open the last project \\(can't open the stored project "${id}": not a Fission project: the file is not valid JSON.*\\), so a new one was started\\. The old one is still kept in this browser\\.$`));
      const notice = await phone.$eval("#file-notice", (el) => ({ ...el.getBoundingClientRect().toJSON(), cut: el.scrollWidth > el.clientWidth }));
      assert.ok(notice.width > 0 && notice.left >= 0 && notice.right <= 375 && !notice.cut, JSON.stringify(notice));
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll");
      await phone.screenshot({ path: "e2e/design-375-notice.png" });
      // A new stored project; the unreadable one is left as it was.
      await phone.waitForFunction(() => document.querySelector("#save-status").dataset.state === "saved");
      const fresh = await phone.evaluate(() => document.body.dataset.projectId);
      assert.notEqual(fresh, id);
      assert.deepEqual((await storedKeys(phone)).filter((k) => k.startsWith("project/")).sort(), [`project/${id}`, `project/${fresh}`].sort());
      // Dismiss hides the message; the next start opens the new project without one.
      await phone.click("#file-dismiss");
      assert.equal((await phone.$eval("#file-notice", (el) => el.getBoundingClientRect().height)), 0);
      await phone.reload();
      await phone.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved");
      assert.equal(await phone.evaluate(() => document.body.dataset.projectId), fresh);
      assert.equal(await phone.textContent("#file-status"), "");
    } finally {
      await phone.close();
    }
  });

  await check("storage full is reported in words at phone width, and the next change saves again", async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 } });
    phone.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      // Every write fails the way a full disk does, until the test lets it through.
      await phone.addInitScript(() => {
        indexedDB.deleteDatabase("fission");
        window.__full = true;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (!window.__full) return put.apply(this, args);
          const request = { error: new DOMException("The quota has been exceeded.", "QuotaExceededError"), onerror: null, onsuccess: null };
          setTimeout(() => request.onerror?.());
          return request;
        };
      });
      await phone.goto(url + "#design");
      await phone.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "error");
      const words = await phone.textContent("#save-status");
      assert.match(words, /^Not saved: browser storage is full: can't save "project\/.+" \(use Save to keep your work as a file\)$/);
      const shown = await phone.$eval("#save-status", (el) => ({ ...el.getBoundingClientRect().toJSON(), size: getComputedStyle(el).fontSize, cut: el.scrollWidth > el.clientWidth }));
      assert.ok(shown.width > 0 && shown.left >= 0 && shown.right <= 375 && shown.size === "12px" && !shown.cut, JSON.stringify(shown));
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll");
      await phone.screenshot({ path: "e2e/design-375-storage-full.png" });
      // Space is freed; the next change saves.
      await phone.evaluate(() => (window.__full = false));
      await phone.fill("#width", "50");
      await phone.waitForFunction(() => document.querySelector("#save-status").dataset.state === "saved");
      assert.ok((await storedKeys(phone)).some((k) => k.startsWith("project/")));
    } finally {
      await phone.close();
    }
  });

  await check("a browser that can't keep projects still opens the app and can Save a file", async () => {
    const bare = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    bare.on("pageerror", (e) => consoleErrors.push(e.message));
    try {
      await bare.addInitScript(() => delete window.indexedDB);
      await bare.goto(url + "#design");
      await bare.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      assert.equal(await bare.evaluate(() => typeof indexedDB), "undefined", "the test really took storage away");
      assert.match(await bare.textContent("#file-status"), /^Projects can't be kept in this browser \(IndexedDB is not available\)\. Use Save to keep your work as a file\.$/);
      // Nothing pretends to autosave.
      await bare.fill("#width", "50");
      await bare.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
      assert.equal(await bare.textContent("#save-status"), "");
      const [download] = await Promise.all([bare.waitForEvent("download"), bare.click("#save")]);
      assert.equal(download.suggestedFilename(), "Untitled.fission.json");
    } finally {
      await bare.close();
    }
  });

  await check("split view: Design beside a placeholder, own panels and cameras, one selection, Close split restores one view", async () => {
    const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    wide.on("pageerror", (e) => consoleErrors.push(e.message));
    wide.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    try {
      await wide.addInitScript(() => indexedDB.deleteDatabase("fission"));
      await wide.goto(url + "#design");
      await wide.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
      const canvasOf = (sel) => `${sel} > canvas`;
      const image = (sel) => wide.evaluate((s) => document.querySelector(s).toDataURL(), canvasOf(sel));
      const pixelAt = (sel, x, y) =>
        wide.evaluate(
          ([s, x, y]) => {
            const src = document.querySelector(s);
            const r = src.getBoundingClientRect();
            const c = document.createElement("canvas");
            c.width = src.width;
            c.height = src.height;
            const g = c.getContext("2d");
            g.drawImage(src, 0, 0);
            const k = src.width / r.width; // device pixels per CSS pixel
            return Array.from(g.getImageData(Math.floor((x - r.x) * k), Math.floor((y - r.y) * k), 1, 1).data.slice(0, 3));
          },
          [canvasOf(sel), x, y],
        );
      const isBody = ([r, g, b]) => r + g + b > 3 * 80; // lit grey-blue, far brighter than the background
      const selected = () => wide.evaluate(() => document.body.dataset.selection ?? "");
      const settle = () => wide.waitForTimeout(300); // orbit damping settles, a frame or two paints
      const box = (sel) => wide.locator(canvasOf(sel)).boundingBox();

      // One workspace to start: no second pane, one canvas drawing the scene.
      assert.equal(await wide.isVisible("#split"), false);
      assert.equal((await wide.$$("#viewport > canvas, #split-viewport > canvas")).length, 1);
      await wide.click("#split-toggle");
      await wide.waitForFunction(() => document.body.dataset.split === "render");
      // Render (the first workspace that is not Design) in the second pane's
      // own properties; Design keeps its panels in the first pane.
      assert.equal(await wide.textContent("#split-properties .placeholder h2"), "Render");
      assert.equal(await wide.textContent("#properties #status"), "valid");
      assert.equal(await wide.$("#properties .placeholder"), null);
      assert.equal(await wide.$eval("body", (b) => b.dataset.activeWorkspace), "design");
      assert.equal(await wide.getAttribute("#split-toggle", "aria-pressed"), "true");
      // The choice offers every workspace but Design, Render chosen.
      assert.deepEqual(await wide.$$eval("#split-choice option", (os) => os.map((o) => o.value)), ["render", "simulate", "manufacture", "laser", "slice", "circuit", "vector", "image", "layout"]);
      assert.equal(await wide.$eval("#split-choice", (s) => s.value), "render");
      await settle();

      // Both views draw the body: each starts at home on the same box, so the
      // box's centre (20, 15, 10) lands at each canvas's own screenPoint.
      const [mainBox, splitBox] = [await box("#viewport"), await box("#split-viewport")];
      // The second view is framed for its own size: taller than wide, so the
      // framed sphere fits the narrower horizontal field of view and the
      // box, inside the sphere, stops short of the left and right edges.
      for (const fx of [0.01, 0.99]) {
        const p = { x: splitBox.x + fx * splitBox.width, y: splitBox.y + splitBox.height / 2 };
        assert.ok(!isBody(await pixelAt("#split-viewport", p.x, p.y)), `the whole box fits the second view (at ${fx} of its width)`);
      }
      assert.ok(mainBox.width > 300 && splitBox.width > 300, `room for both: ${mainBox.width}, ${splitBox.width}`);
      assert.ok(mainBox.x + mainBox.width <= splitBox.x + 0.5, "side by side, Design's on the left");
      for (const [sel, b] of [["#viewport", mainBox], ["#split-viewport", splitBox]]) {
        const c = screenPoint(b, [20, 15, 10]);
        assert.ok(isBody(await pixelAt(sel, c.x, c.y)), `${sel} draws the body`);
        assert.deepEqual(await pixelAt(sel, b.x + 3, b.y + b.height - 3), [0x14, 0x16, 0x1a], `${sel} corner is background`);
      }
      assert.equal(await wide.evaluate(() => document.documentElement.scrollWidth), 1280, "no sideways scroll");
      await wide.screenshot({ path: "e2e/split-1280.png" });

      // Cameras are independent: Top in the second pane turns only its view.
      const mainBefore = await image("#viewport");
      const splitBefore = await image("#split-viewport");
      await wide.click("#split-viewport .view-controls [data-view=top]");
      await settle();
      assert.notEqual(await image("#split-viewport"), splitBefore, "the second view turned");
      assert.equal(await image("#viewport"), mainBefore, "the first view did not");
      // From the top the box's top face centre (20, 15, 20) is under TOP's screenPoint in the second view.
      const topInSplit = screenPoint(splitBox, [20, 15, 20], TOP);
      assert.ok(isBody(await pixelAt("#split-viewport", topInSplit.x, topInSplit.y)), "top view of the body");

      // One selection: a face picked in the first view shows in both, and a
      // click in the second view picks the same shared body.
      const topInMain = screenPoint(mainBox, [20, 15, 20]);
      await wide.mouse.click(topInMain.x, topInMain.y);
      assert.equal(await selected(), "face:feature-1/top");
      assert.equal(await wide.$eval("#viewport", (el) => el.dataset.highlight), "faces 1 edges ");
      assert.equal(await wide.$eval("#split-viewport", (el) => el.dataset.highlight), "faces 1 edges ");
      await wide.keyboard.press("Escape");
      assert.equal(await selected(), "");
      await wide.mouse.click(topInSplit.x, topInSplit.y);
      assert.equal(await selected(), "face:feature-1/top", "picked through the second view");
      assert.equal(await wide.$eval("#viewport", (el) => el.dataset.highlight), "faces 1 edges ");
      await wide.keyboard.press("Escape");

      // Choosing another workspace for the second pane keeps its camera.
      const splitTop = await image("#split-viewport");
      await wide.selectOption("#split-choice", "slice");
      await wide.waitForFunction(() => document.body.dataset.split === "slice");
      assert.equal(await wide.textContent("#split-properties .placeholder h2"), "Slice");
      await settle();
      assert.equal(await image("#split-viewport"), splitTop, "the second camera stayed on Top");

      // Choosing the second pane's workspace in the switcher swaps the panes:
      // Slice in the first, Design (its panels, its picking) in the second.
      await wide.click("[data-workspace=slice]");
      await wide.waitForFunction(() => document.body.dataset.split === "design");
      assert.equal(await wide.$eval("body", (b) => b.dataset.activeWorkspace), "slice");
      assert.equal(await wide.textContent("#properties .placeholder h2"), "Slice");
      assert.equal(await wide.textContent("#split-properties #status"), "valid");
      assert.equal(await wide.$eval("#split-viewport", (el) => el.dataset.shape), "box");
      assert.deepEqual(await wide.$$eval("#split-choice option", (os) => os.map((o) => o.value)).then((v) => v.includes("slice")), false);
      await wide.mouse.click(topInMain.x, topInMain.y);
      assert.equal(await selected(), "face:feature-1/top", "Design picks from either view while it is in the second pane");
      await wide.keyboard.press("Escape");
      await wide.click("[data-workspace=design]");
      await wide.waitForFunction(() => document.body.dataset.split === "slice");
      assert.equal(await wide.textContent("#properties #status"), "valid");

      // Close split: one view again, its canvas gone, the first view untouched.
      const mainNow = await image("#viewport");
      await wide.click("#split-close");
      assert.equal(await wide.isVisible("#split"), false);
      assert.equal(await wide.$("#split-viewport > canvas"), null);
      assert.equal(await wide.$("#split-viewport .view-controls"), null);
      assert.equal(await wide.$eval("#split-properties", (el) => el.childElementCount), 0, "the second workspace emptied its slots");
      assert.equal(await wide.$eval("body", (b) => b.dataset.split), "");
      assert.equal(await wide.getAttribute("#split-toggle", "aria-pressed"), "false");
      assert.equal(await wide.evaluate(() => document.activeElement?.id), "split-toggle", "focus back on Split");
      await settle();
      const full = await box("#viewport");
      assert.ok(full.width > mainBox.width + 200, "the first view has the room back");
      const c = screenPoint(full, [20, 15, 10]);
      assert.ok(isBody(await pixelAt("#viewport", c.x, c.y)), "still draws the body");
      assert.notEqual(await image("#viewport"), mainNow, "redrawn at the new size");

      // Too narrow for two: a window shrinking under 900 px closes the split, and phones never offer it.
      await wide.click("#split-toggle");
      await wide.waitForFunction(() => document.body.dataset.split === "render");
      await wide.setViewportSize({ width: 860, height: 800 });
      await wide.waitForFunction(() => document.body.dataset.split === "");
      assert.equal(await wide.$("#split-viewport > canvas"), null);
      assert.equal(await wide.isVisible("#split-toggle"), false);
      await wide.setViewportSize({ width: 375, height: 740 });
      assert.equal(await wide.isVisible("#split-toggle"), false);
      assert.equal(await wide.evaluate(() => document.documentElement.scrollWidth), 375, "no sideways scroll");
    } finally {
      await wide.close();
    }
  });

  await check("change notes (X5b): none in normal use; one from another workspace shows in its pane, opens its chain, follows the graph and dismisses", async () => {
    // The app as users get it has no test hook.
    assert.equal(await page.evaluate(() => "fissionTest" in window), false);
    const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    wide.on("pageerror", (e) => consoleErrors.push(e.message));
    wide.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    try {
      await wide.addInitScript(() => indexedDB.deleteDatabase("fission"));
      await wide.goto(url + "?test-hooks#design");
      const valid = () => wide.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
      await valid();
      const notesIn = (pane) => wide.$$eval(`${pane} .notes-strip .change-note`, (els) => els.map((e) => e.querySelector(".note-text").textContent));
      // Today nothing outside Design reads the design, so an edit makes no note.
      await wide.fill("#width", "41");
      await valid();
      await wide.waitForTimeout(50);
      assert.deepEqual(await notesIn("#viewport"), []);
      assert.equal(await wide.isVisible("#viewport .notes-strip"), false, "an empty strip takes no room");

      // Stand in Slice's print plate reading the part, as P2's estimate will.
      await wide.evaluate(() => window.fissionTest.graph.set({ id: "e2e.plate", label: "Print plate", workspace: "slice", cost: "expensive" }, ["feature-1"]));
      await wide.fill("#width", "42");
      await valid();
      await wide.waitForTimeout(50);
      // The note is about Slice, which is not on screen: Design's pane shows none.
      assert.deepEqual(await notesIn("#viewport"), []);
      const text = "Print plate out of date: you changed the box in Design. Rerun it in Slice.";
      // Slice beside Design: the note shows over Slice's pane.
      await wide.click("#split-toggle");
      await wide.selectOption("#split-choice", "slice");
      await wide.waitForFunction(() => document.body.dataset.split === "slice");
      await wide.waitForSelector("#split-viewport .change-note");
      assert.deepEqual(await notesIn("#split-viewport"), [text]);
      assert.deepEqual(await notesIn("#viewport"), []);
      assert.equal(await wide.getAttribute("#split-viewport .change-note", "role"), "status");
      // Why? opens the chain from the cause to the result.
      await wide.click("#split-viewport .change-note summary");
      assert.deepEqual(await wide.$$eval("#split-viewport .change-note li", (li) => li.map((l) => l.textContent)), ["Box: 42 × 30 × 20 mm in Design", "Print plate in Slice"]);
      assert.equal(await wide.isVisible("#split-viewport .change-note li"), true);
      await wide.screenshot({ path: "e2e/change-note.png" });
      // The plate is rebuilt (the graph marks it fresh): the same note says so, its chain still open.
      await wide.evaluate(() => window.fissionTest.graph.markFresh("e2e.plate"));
      await wide.waitForFunction(() => document.querySelector("#split-viewport .change-note")?.dataset.state === "updated");
      assert.deepEqual(await notesIn("#split-viewport"), ["Print plate updated: you changed the box in Design."]);
      assert.equal(await wide.isVisible("#split-viewport .change-note li"), true, "a redraw keeps Why? open");
      // × dismisses it, for good.
      await wide.click("#split-viewport .note-dismiss");
      await wide.waitForFunction(() => !document.querySelector(".change-note"));
      assert.equal(await wide.evaluate(() => window.fissionTest.notes.current(window.fissionTest.graph).length), 0);
      // A newer edit is a new cause: a new note, which the old dismissal doesn't hide.
      await wide.fill("#width", "43");
      await valid();
      await wide.waitForSelector("#split-viewport .change-note");
      assert.deepEqual(await notesIn("#split-viewport"), [text]);
      // Close split: Slice is off screen, so is its note; showing Slice brings it back.
      await wide.click("#split-close");
      await wide.waitForFunction(() => !document.querySelector(".change-note"));
      await wide.click("#workspaces [data-workspace=slice]");
      await wide.waitForSelector("#viewport .change-note");
      assert.deepEqual(await notesIn("#viewport"), [text]);
    } finally {
      await wide.close();
    }
  });

  await check("no errors in the browser console", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
