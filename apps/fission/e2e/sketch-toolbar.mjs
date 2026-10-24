// Browser check of the sketch's own toolbar (sketch feel SF3b): picking a
// plane swaps the modelling buttons for the sketch's (a Create menu listing
// every tool with its key, the tools as buttons, Extrude kept, a big green
// Finish Sketch at the far right); the menu chooses a tool, opens with the
// tool in use focused, moves by arrow keys and closes on Escape without
// ending what is being drawn; Finish Sketch leaves the sketch with the
// camera at the home view (worked out here by hand), not the view from
// before the sketch, from the toolbar and from the panel alike; Cancel at
// the plane prompt moves no camera; Undo inside a sketch keeps its
// toolbar. The same at 375 px with taps: all six tools on screen and 44
// px tall, the menu whole on screen. Screenshots at 1280 and 375 px go to
// E2E_SHOTS when set. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { TOP, clickPlane } from "./sketch-screen.mjs";
import { startWithBox } from "./start.mjs";

const server = await preview({ preview: { port: 4193, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4193/?test-hooks";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;
const TOOLS = ["line", "rectangle", "circle", "arc", "centre", "tangent"];

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
/** Waits for the camera's damping to finish: two reads 100 ms apart within a nanometre. */
async function settle(page) {
  let last = null;
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(100);
    const now = await camera(page);
    if (last && [...now.position, ...now.target].every((x, k) => Math.abs(x - [...last.position, ...last.target][k]) < 1e-6)) return;
    last = now;
  }
  throw new Error(`the camera never settled: ${JSON.stringify(last)}`);
}
const visible = (page, sel) => page.isVisible(sel);
const sketching = (page, on) => page.waitForFunction((w) => document.querySelector("#viewport").dataset.sketching === String(w), on);
const points = (page, want) => page.waitForFunction((w) => document.querySelector("#viewport").dataset.sketchPoints === w, want, { timeout: 5000 });
const closeTo = (a, b, eps, what) => assert.ok(a.every((x, i) => Math.abs(x - b[i]) <= eps), `${what}: [${a.map((x) => x.toFixed(4))}] vs [${b.map((x) => x.toFixed(4))}]`);
const rect = (page, sel) => page.$eval(sel, (el) => el.getBoundingClientRect().toJSON());

/**
 * The home view of the default 40 × 30 × 20 box, worked by hand: framed
 * about its centre (20, 15, 10) at radius half its diagonal, √(40² + 30² +
 * 20²) / 2 = √2900 / 2 = 26.926 mm; from the direction (0.6, −0.8, 0.55),
 * whose length is √1.3025 = 1.14127, so the unit direction is (0.52573,
 * −0.70097, 0.48192); at the fit distance r / sin(22.5°) = 26.926 /
 * 0.38268 = 70.362 mm for a 45° field of view on a canvas wider than tall.
 * Camera = centre + 70.362 × direction = (56.992, −34.322, 43.909).
 */
const HOME_POSITION = [56.992, -34.322, 43.909];
const HOME_TARGET = [20, 15, 10];

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

await check("the hand-worked home view is the one the app starts at (so the later checks compare against a real home)", async () => {
  const page = await fresh();
  try {
    const cam = await camera(page);
    closeTo(cam.position, HOME_POSITION, 2e-3, "the start camera");
    closeTo(cam.target, HOME_TARGET, 1e-6, "the start target");
  } finally {
    await page.context().close();
  }
});

await check("picking a plane swaps the modelling buttons for the sketch's toolbar: Create menu and tools first, Extrude kept, Finish Sketch at the far right", async () => {
  const page = await fresh();
  try {
    assert.equal(await visible(page, "#finish-sketch"), false, "no Finish Sketch while modelling");
    assert.equal(await visible(page, "#sketch-create"), false);
    assert.equal(await visible(page, "#insert"), true);
    await page.click("#create-sketch");
    // While picking a plane the toolbar is still the modelling one.
    assert.equal(await visible(page, "#create-sketch"), true);
    assert.equal(await visible(page, "#finish-sketch"), false);
    await page.click("#sketch-plane-XY");
    await sketching(page, true);
    for (const sel of ["#create-sketch", "#insert", "[data-op=export_stl]"]) assert.equal(await visible(page, sel), false, `${sel} hidden while sketching`);
    for (const sel of ["#sketch-create", "#extrude", "#finish-sketch", ...TOOLS.map((t) => `#sketch-tool-${t}`)]) assert.equal(await visible(page, sel), true, `${sel} shown while sketching`);
    // Order along the bar: Create, then the tools, Extrude, Finish Sketch last and flush right.
    const xs = [];
    for (const sel of ["#sketch-create", ...TOOLS.map((t) => `#sketch-tool-${t}`), "#extrude", "#finish-sketch"]) xs.push((await rect(page, sel)).left);
    assert.deepEqual([...xs].sort((a, b) => a - b), xs, `left to right: ${xs.map(Math.round)}`);
    const bar = await rect(page, "#toolbar");
    const finish = await rect(page, "#finish-sketch");
    // The toolbar's padding is 12 px each side.
    assert.ok(Math.abs(bar.right - 12 - finish.right) <= 1, `Finish Sketch flush right: ends at ${finish.right}, the bar at ${bar.right}`);
    assert.ok(finish.left - (await rect(page, "#extrude")).right > 200, "a wide gap before Finish Sketch, so it stands apart");
    const look = await page.$eval("#finish-sketch", (el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).fontWeight]);
    assert.deepEqual(look, ["rgb(31, 95, 63)", "600"], "Finish Sketch is the green, bold button");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "true", "a sketch starts with Line");
    assert.equal(await page.textContent("#finish-sketch"), "✓ Finish Sketch");
    if (shots) await page.screenshot({ path: `${shots}/sketch-toolbar-1280.png` });
  } finally {
    await page.context().close();
  }
});

await check("the Create menu: every tool with its key, the tool in use ticked and focused, a row chooses it, arrows and Enter, Escape closes without ending the rectangle", async () => {
  const page = await fresh();
  try {
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await sketching(page, true);
    await settle(page);
    await page.click("#sketch-create");
    assert.equal(await visible(page, "#sketch-create-menu"), true);
    assert.equal(await page.getAttribute("#sketch-create", "aria-expanded"), "true");
    const rows = await page.$$eval("#sketch-create-menu [role=menuitemradio]", (els) => els.map((e) => [e.querySelector("span").textContent, e.querySelector("kbd").textContent, e.getAttribute("aria-checked")]));
    // The three arcs sit in the Arc row's own menu (centre-arc.mjs checks it opening).
    assert.deepEqual(rows, [["Line", "L", "true"], ["Rectangle", "R", "false"], ["Circle", "C", "false"], ["3-point arc", "A", "false"], ["Centre arc", "", "false"], ["Tangent arc", "T", "false"], ["Project", "P", "false"]]);
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-line");
    // The menu hangs under its button, over the view.
    const button = await rect(page, "#sketch-create");
    const menu = await rect(page, "#sketch-create-menu");
    assert.ok(Math.abs(menu.left - button.left) <= 1 && menu.top >= button.bottom && menu.top - button.bottom <= 4, `under its button: ${JSON.stringify(menu)}`);
    const onTop = await page.evaluate(() => {
      const r = document.getElementById("sketch-menu-circle").getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#sketch-menu-circle") !== null;
    });
    assert.ok(onTop, "nothing covers the menu's rows");
    await page.click("#sketch-menu-rectangle");
    assert.equal(await visible(page, "#sketch-create-menu"), false, "a choice closes the menu");
    assert.equal(await page.getAttribute("#sketch-tool-rectangle", "aria-pressed"), "true");
    assert.equal(await page.getAttribute("#sketch-tool-line", "aria-pressed"), "false");
    assert.match(await page.textContent("#sketch-help"), /^Click one corner, then the opposite corner/);
    // Arrows: from Rectangle (row 1) Down twice is the Arc row (row 3); Enter opens the arcs on 3-point arc, and Enter chooses it.
    await page.click("#sketch-create");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-rectangle");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-group-arc");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-menu-arc");
    await page.keyboard.press("Enter");
    assert.equal(await page.getAttribute("#sketch-tool-arc", "aria-pressed"), "true", "Enter chose 3-point arc");
    assert.equal(await visible(page, "#sketch-create-menu"), false);
    // Rectangle by its button; the first corner at (0, 0) on the grid.
    await page.click("#sketch-tool-rectangle");
    await page.check("#sketch-grid-snap");
    await clickPlane(page, [1, -1], TOP);
    await points(page, "0,0");
    await page.click("#sketch-create");
    await page.keyboard.press("Escape");
    assert.equal(await visible(page, "#sketch-create-menu"), false, "Escape closed the menu");
    assert.equal(await page.evaluate(() => document.activeElement.id), "sketch-create", "the focus is back on the menu's button");
    await clickPlane(page, [21, 9], TOP);
    await points(page, "0,0 20,0 20,10 0,10");
    // Escape with the menu open but the focus left on its button (opened by a click, then the pointer moved off): still only the menu closes.
    await clickPlane(page, [31, 21], TOP);
    await points(page, "0,0 20,0 20,10 0,10 30,20");
    await page.click("#sketch-create");
    await page.focus("#sketch-create");
    await page.keyboard.press("Escape");
    assert.equal(await visible(page, "#sketch-create-menu"), false);
    await clickPlane(page, [39, 29], TOP);
    await points(page, "0,0 20,0 20,10 0,10 30,20 40,20 40,30 30,30");
    // A press elsewhere closes the menu.
    await page.click("#sketch-create");
    await page.mouse.click(5, 790);
    assert.equal(await visible(page, "#sketch-create-menu"), false, "a press elsewhere closed it");
  } finally {
    await page.context().close();
  }
});

await check("Finish Sketch on the toolbar: back to modelling at the home view, not the Front view from before the sketch", async () => {
  const page = await fresh();
  try {
    await page.click("[data-view=front]");
    await settle(page);
    const front = await camera(page);
    assert.ok(Math.abs(front.position[0] - HOME_POSITION[0]) > 10, "Front is well away from home");
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await sketching(page, true);
    await settle(page);
    for (const p of [[0, 0], [30, 0], [30, 20], [0, 0]]) await clickPlane(page, p, TOP);
    await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "3 lines, a closed outline.");
    await page.click("#finish-sketch");
    await sketching(page, false);
    await settle(page);
    const cam = await camera(page);
    closeTo(cam.position, HOME_POSITION, 2e-3, "the camera after Finish Sketch");
    closeTo(cam.target, HOME_TARGET, 1e-6, "its target");
    // The camera's own up, square to the view and leaning toward Z: z − (z·f) f
    // with f = −(0.52573, −0.70097, 0.48192), z·f = −0.48192, gives
    // (−0.25336, 0.33781, 0.76775), of length 0.87621: (−0.28916, 0.38554, 0.87621).
    closeTo(cam.up, [-0.28916, 0.38554, 0.87621], 1e-4, "up toward Z");
    assert.equal(await visible(page, "#sketch-panel"), false);
    assert.equal(await visible(page, "#finish-sketch"), false);
    assert.equal(await visible(page, "#sketch-create"), false);
    assert.equal(await visible(page, "#create-sketch"), true, "the modelling buttons are back");
    assert.equal(await visible(page, "#insert"), true);
    assert.equal(await page.evaluate(() => document.querySelector("#viewport").dataset.sketchLines), "3", "the sketch stays drawn");
    if (shots) await page.screenshot({ path: `${shots}/sketch-toolbar-finished-1280.png` });
  } finally {
    await page.context().close();
  }
});

await check("the panel's Finish sketch goes home too; Cancel at the plane prompt leaves the camera where it was", async () => {
  const page = await fresh();
  try {
    await page.click("[data-view=right]");
    await settle(page);
    const right = await camera(page);
    await page.click("#create-sketch");
    await page.click("#sketch-cancel");
    await settle(page);
    closeTo((await camera(page)).position, right.position, 1e-6, "Cancel at the prompt keeps the Right view");
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await sketching(page, true);
    await page.click("#sketch-finish");
    await sketching(page, false);
    await settle(page);
    closeTo((await camera(page)).position, HOME_POSITION, 2e-3, "the panel's Finish sketch");
  } finally {
    await page.context().close();
  }
});

await check("Undo inside a sketch keeps the sketch's toolbar and its tool; Extrude from it leaves the sketch for the Extrude panel", async () => {
  const page = await fresh();
  try {
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await sketching(page, true);
    await settle(page);
    await page.click("#sketch-tool-circle");
    await page.check("#sketch-grid-snap");
    await clickPlane(page, [10, 10], TOP);
    await clickPlane(page, [10, 20], TOP);
    await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "1 circle, a closed outline.");
    await page.click("#undo");
    await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "Nothing drawn yet.");
    assert.equal(await visible(page, "#finish-sketch"), true, "still the sketch's toolbar after Undo");
    assert.equal(await visible(page, "#create-sketch"), false);
    assert.equal(await page.getAttribute("#sketch-tool-circle", "aria-pressed"), "true", "still the circle tool");
    assert.equal(await page.getAttribute("#sketch-menu-circle", "aria-checked"), "true", "ticked in the menu too");
    await page.click("#redo");
    await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "1 circle, a closed outline.");
    await page.click("#extrude");
    await page.waitForFunction(() => document.querySelector("#extrude-status")?.textContent === "Sketch 1 makes a closed outline.");
    assert.equal(await visible(page, "#finish-sketch"), false, "Extrude left the sketch");
    assert.equal(await visible(page, "#create-sketch"), true);
  } finally {
    await page.context().close();
  }
});

await check("at 375 px with taps: all six tools on screen and 44 px tall, the menu whole on screen, Finish Sketch reached by the bar's scroll goes home, no sideways page scroll", async () => {
  const page = await fresh(375, true);
  try {
    await page.tap("#create-sketch");
    await page.tap("#sketch-plane-XY");
    await sketching(page, true);
    for (const sel of ["#sketch-create", ...TOOLS.map((t) => `#sketch-tool-${t}`)]) {
      const b = await rect(page, sel);
      assert.ok(b.height >= 44, `${sel} is ${b.height} px tall, at least 44 to tap`);
      assert.ok(b.left >= 0 && b.right <= 375, `${sel} on screen without scrolling: ${b.left}..${b.right}`);
    }
    await page.tap("#sketch-create");
    const menu = await rect(page, "#sketch-create-menu");
    assert.ok(menu.left >= 0 && menu.right <= 375 && menu.bottom <= 800, `the menu on screen: ${JSON.stringify(menu)}`);
    for (const t of ["line", "rectangle", "circle", "group-arc"]) assert.ok((await rect(page, `#sketch-menu-${t}`)).height >= 44, `the ${t} row is 44 px tall`);
    if (shots) await page.screenshot({ path: `${shots}/sketch-toolbar-menu-375.png` });
    await page.tap("#sketch-menu-circle");
    assert.equal(await page.getAttribute("#sketch-tool-circle", "aria-pressed"), "true");
    assert.equal(await visible(page, "#sketch-create-menu"), false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways page scroll");
    const finish = await rect(page, "#finish-sketch");
    assert.ok(finish.height >= 44, `Finish Sketch is ${finish.height} px tall`);
    await page.tap("#finish-sketch"); // scrolled into view inside the bar first
    await sketching(page, false);
    await settle(page);
    const cam = await camera(page);
    closeTo(cam.target, HOME_TARGET, 1e-6, "home's target at 375 px");
    // Narrower than tall here, so the fit distance differs; the direction is home's: (0.52573, −0.70097, 0.48192).
    const d = cam.position.map((x, i) => x - cam.target[i]);
    const n = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
    closeTo(d.map((x) => x / n), [0.52573, -0.70097, 0.48192], 1e-4, "home's direction at 375 px");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 375), "no sideways page scroll after");
    if (shots) await page.screenshot({ path: `${shots}/sketch-toolbar-375.png` });
  } finally {
    await page.context().close();
  }
});

assert.deepEqual(errors, [], "no page errors");
await browser.close();
await server.close();
if (failed) process.exit(1);
console.log("PASS sketch toolbar");
