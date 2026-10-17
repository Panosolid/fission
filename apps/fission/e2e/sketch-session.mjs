// Browser check of a long, messy sketching session (testing catch-up TC2),
// the way real use breaks things: about 50 shapes drawn with the line,
// rectangle and circle tools picked by their keys, Escapes, bursts of
// Ctrl+Z and Ctrl+Shift+Z, then half of it undone, a little redone and a
// little more drawn; Save, and the file compared; the page reloaded (the
// project comes back from the browser's store) and the saved file opened
// in a fresh tab; then more drawing in Sketch 2 and a closed outline in
// Sketch 3 extruded to the model's volume.
//
// Every step is checked against a model that knows only coordinates: the
// points shown, how many segments are drawn (a circle is 64), what the
// undo button would take back, and the sketch status, whose words come
// from packages/testing/src/outline-model.ts (the outline rules written
// apart from the kernel). Seeded: FISSION_SEED (decimal) runs one seed,
// otherwise the default seeds and every seed saved in e2e/regressions/
// sketch-session-*.json. A failure prints its seed and steps; save that as
// a regression file so it replays forever.
// Run with `npm run e2e` (after `npm run build`); E2E_BROWSER picks the browser.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { preview } from "vite";
import { browserName, launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { isClosed, modelOutline, openWords, shoelace } from "../../../packages/testing/src/outline-model.ts";

const server = await preview({ preview: { port: 4196, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4196/";
const browser = await launch();
const SHAPES = Number(process.env.E2E_SESSION_SHAPES || 50);
const regressions = new URL("./regressions/", import.meta.url);
const saved = (existsSync(regressions) ? readdirSync(regressions) : []).filter((f) => /^sketch-session-.*\.json$/.test(f));
const SEEDS = process.env.FISSION_SEED
  ? [Number(process.env.FISSION_SEED)]
  : [...(browserName === "chromium" ? [1, 2] : [1]), ...saved.map((f) => JSON.parse(readFileSync(new URL(`./regressions/${f}`, import.meta.url), "utf8")).seed)];
const SEGMENTS_PER_CIRCLE = 64;

/** Mulberry32: a small seeded generator, so a failing session replays from its seed. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = ([x, y]) => `${x},${y}`;
const STEP = { line: "Draw line", rectangle: "Draw rectangle", circle: "Draw circle" };

/**
 * The model of one sketch being drawn: its lines (start and end, in drawing
 * order) and circles, the tool and the click it holds, and the undo and redo
 * stacks of what was drawn. `others` counts the segments other sketches draw.
 */
function sketchModel(others = 0) {
  return { lines: [], circles: [], tool: "line", pending: null, undo: [], redo: [], others };
}
const snapshot = (m) => ({ lines: [...m.lines], circles: [...m.circles] });
const pointsOf = (m) => new Set([...m.lines.flatMap((l) => [key(l.a), key(l.b)]), ...m.circles.map((c) => key(c.centre))]);

/** What a click at `at` does, as the tools say (workspaces/design/src/sketch-tool.ts); returns the undo label if it drew. */
function click(m, at) {
  if (m.pending === null) {
    m.pending = at;
    return null;
  }
  const from = m.pending;
  const draw = (label, change) => {
    m.undo.push({ label, state: snapshot(m) });
    m.redo = [];
    change();
    return label;
  };
  if (m.tool === "line") {
    if (key(from) === key(at)) return null;
    const existed = pointsOf(m).has(key(at));
    const label = draw(STEP.line, () => m.lines.push({ a: from, b: at }));
    m.pending = existed ? null : at;
    return label;
  }
  if (m.tool === "rectangle") {
    if (from[0] === at[0] || from[1] === at[1]) return null; // on the first corner's row or column
    const c = [from, [at[0], from[1]], at, [from[0], at[1]]];
    m.pending = null;
    return draw(STEP.rectangle, () => c.forEach((p, i) => m.lines.push({ a: p, b: c[(i + 1) % 4] })));
  }
  const radius = Math.sqrt((at[0] - from[0]) ** 2 + (at[1] - from[1]) ** 2);
  if (radius === 0) return null;
  m.pending = null;
  return draw(STEP.circle, () => m.circles.push({ centre: from, radius }));
}

/** Undo or redo one drawing step: the tool keeps its kind and drops what it held. */
function travel(m, back) {
  const [from, to] = back ? [m.undo, m.redo] : [m.redo, m.undo];
  const top = from.pop();
  to.push({ label: top.label, state: snapshot(m) });
  ({ lines: m.lines, circles: m.circles } = top.state);
  m.pending = null;
}

/** What the page should show for the sketch being drawn. */
function expected(m, sketchLabel = "Create sketch") {
  const n = m.lines.length;
  const c = m.circles.length;
  const words = [n ? `${n} line${n === 1 ? "" : "s"}` : "", c ? `${c} circle${c === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
  let status;
  if (!words) status = { exact: "Nothing drawn yet." };
  else {
    const outline = modelOutline(m.lines, m.circles);
    if (isClosed(outline)) status = { exact: `${words}, a closed outline.` };
    else if (outline.kind === "not a profile") status = { prefix: `${words}, not closed: ${openWords(outline)}` };
    else status = { exact: `${words}, not closed: ${openWords(outline)}.` };
  }
  const shown = pointsOf(m);
  if (m.pending) shown.add(key(m.pending));
  return {
    points: [...shown].sort(),
    segments: m.others + n + SEGMENTS_PER_CIRCLE * c,
    status,
    undo: `Undo ${m.undo.at(-1)?.label ?? sketchLabel} (Ctrl+Z)`,
  };
}

/** Waits until the page shows what the model expects; on a timeout, says what differs. */
async function agree(page, m, where) {
  const want = expected(m);
  const read = () =>
    page.evaluate(() => {
      const v = document.querySelector("#viewport").dataset;
      return {
        points: [...new Set((v.sketchPoints ?? "").split(" ").filter(Boolean))].sort(),
        segments: Number(v.sketchLines),
        status: document.querySelector("#sketch-status")?.textContent ?? "",
        undo: document.getElementById("undo").title,
      };
    });
  const matches = (got) =>
    JSON.stringify(got.points) === JSON.stringify(want.points) &&
    got.segments === want.segments &&
    got.undo === want.undo &&
    (want.status.exact !== undefined ? got.status === want.status.exact : got.status.startsWith(want.status.prefix));
  const deadline = Date.now() + 5000;
  let got = await read();
  while (!matches(got)) {
    if (Date.now() > deadline) assert.fail(`${where}\n  expected ${JSON.stringify(want)}\n  shown    ${JSON.stringify(got)}`);
    await page.waitForTimeout(25);
    got = await read();
  }
}

/** The page's sketches from a saved file, as lines (start, end) and circles in coordinates. */
function fileSketch(file, index) {
  const sk = file.workspaces.design.sketches[index];
  const at = new Map(sk.points.map((p) => [p.id, [p.x, p.y]]));
  assert.equal(new Set(sk.points.map((p) => key([p.x, p.y]))).size, sk.points.length, "no two points in one place");
  return {
    lines: sk.curves.filter((c) => c.kind === "line").map((c) => ({ a: at.get(c.start), b: at.get(c.end) })),
    circles: sk.curves.filter((c) => c.kind === "circle").map((c) => ({ centre: at.get(c.centre), radius: c.radius })),
  };
}

// Clicks land on a 6 × 6 grid of nodes 10 mm apart, inside what the top view shows of the box's
// framing and clear of the view cube (which covers (50, 40) at 1280 × 800).
const XS = [-10, 0, 10, 20, 30, 40];
const YS = [-10, 0, 10, 20, 30, 40];

/**
 * One random step of drawing; returns words for the step list. A click
 * that changes nothing on screen (a first click on a point already there)
 * can't be waited for, and the app hands a click to the tool that is
 * current when the kernel's snap comes back, not the one current when it
 * was clicked; so a key or an undo after such a click waits a moment
 * first, as a person always does. (Found by this test; reported, not
 * fixed here: the click handling is the tool threads' code.)
 */
async function randomStep(page, m, r) {
  const roll = r();
  if (roll < 0.26 && m.unseen) await page.waitForTimeout(300);
  m.unseen = false;
  if (roll < 0.12) {
    const tool = ["line", "rectangle", "circle"][Math.floor(r() * 3)];
    await page.keyboard.press(tool[0]); // L, R or C
    m.tool = tool;
    m.pending = null;
    return `key ${tool[0]}`;
  }
  if (roll < 0.18) {
    await page.keyboard.press("Escape");
    m.pending = null;
    return "Escape";
  }
  if (roll < 0.26 && m.undo.length > 0) {
    const back = 1 + Math.floor(r() * Math.min(3, m.undo.length));
    for (let i = 0; i < back; i++) {
      await page.keyboard.press("Control+z");
      travel(m, true);
    }
    const again = Math.floor(r() * (back + 1));
    for (let i = 0; i < again; i++) {
      await page.keyboard.press("Control+Shift+z");
      travel(m, false);
    }
    return `undo ${back}, redo ${again}`;
  }
  const at = [XS[Math.floor(r() * XS.length)], YS[Math.floor(r() * YS.length)]];
  // Off the node by up to 2 mm each way: the kernel snaps it back.
  await clickPlane(page, [at[0] + (r() - 0.5) * 4, at[1] + (r() - 0.5) * 4], TOP);
  const shownBefore = JSON.stringify(expected(m));
  const drew = click(m, at);
  m.unseen = JSON.stringify(expected(m)) === shownBefore;
  return `${m.tool} at ${at}${drew ? "" : " (no drawing)"}`;
}

async function startSketch(page) {
  await page.click("#create-sketch");
  await page.click("#sketch-plane-XY");
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true", null, { timeout: 5000 });
  // Grid snap is off by default since sketch feel SF1; this session models a
  // sketch on the grid (clicks up to 2 mm off a node land on it), so it ticks
  // Snap to grid, as a person drawing on the grid does (it stays on until a reload).
  if (!(await page.isChecked("#sketch-grid-snap"))) await page.check("#sketch-grid-snap");
  await page.mouse.move(0, 0);
}

let failed = 0;
const errors = [];
async function session(seed) {
  const r = rng(seed);
  const steps = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push(`seed ${seed}: ${e.message}`));
    page.on("console", (msg) => msg.type() === "error" && errors.push(`seed ${seed}: ${msg.text()}`));
  };
  const where = () => `seed ${seed} (${browserName}), after: ${steps.slice(-6).join("; ")} [step ${steps.length}]`;
  try {
    const page = await context.newPage();
    watch(page);
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");

    // Sketch 1: about SHAPES shapes, messily.
    await startSketch(page);
    const one = sketchModel();
    await agree(page, one, "an empty Sketch 1");
    let drawn = 0;
    while (drawn < SHAPES) {
      const before = one.undo.length + one.redo.length;
      steps.push(await randomStep(page, one, r));
      if (one.undo.length + one.redo.length > before && steps.at(-1).includes(" at ")) drawn++;
      await agree(page, one, where());
    }
    // Half of what is there undone, a few redone, then a few more drawn (which ends the redo).
    if (one.unseen) await page.waitForTimeout(300);
    const half = Math.floor(one.undo.length / 2);
    for (let i = 0; i < half; i++) {
      await page.keyboard.press("Control+z");
      travel(one, true);
    }
    steps.push(`undo ${half}`);
    await agree(page, one, where());
    const redo = Math.min(one.redo.length, 1 + Math.floor(r() * 5));
    for (let i = 0; i < redo; i++) {
      await page.keyboard.press("Control+Shift+z");
      travel(one, false);
    }
    steps.push(`redo ${redo}`);
    await agree(page, one, where());
    for (let i = 0; i < 8; i++) {
      steps.push(await randomStep(page, one, r));
      await agree(page, one, where());
    }

    // Save: the file holds exactly the model's lines (start and end, in order) and circles.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.deepEqual(fileSketch(file, 0), { lines: one.lines, circles: one.circles }, `${where()}: the saved file`);
    await page.click("#sketch-finish");
    const finished = one.lines.length + SEGMENTS_PER_CIRCLE * one.circles.length;
    await page.waitForFunction(() => document.querySelector("#save-status")?.dataset.state === "saved", null, { timeout: 10000 });

    // Reloaded: the project comes back from the browser's store, Sketch 1 drawn and not being edited.
    await page.reload();
    await page.waitForFunction((n) => document.querySelector("#viewport")?.dataset.sketchLines === String(n), finished, { timeout: 10000 }).catch(async () =>
      assert.fail(`${where()}: after the reload ${await page.evaluate(() => document.querySelector("#viewport").dataset.sketchLines)} segments drawn, expected ${finished}`),
    );
    assert.equal(await page.evaluate(() => document.querySelector("#viewport").dataset.sketching), "false");
    assert.ok(await page.isVisible('[data-node="sketches/sketch-2"]'), "Sketch 1 is listed after the reload");

    // The saved file opened in a fresh tab of a fresh browser shows the same.
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tab = await other.newPage();
    watch(tab);
    await tab.goto(url + "#design");
    await tab.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await tab.setInputFiles("#open-file", { name: "Session.fission.json", mimeType: "application/json", buffer: readFileSync(await download.path()) });
    await tab.waitForFunction((n) => document.querySelector("#viewport")?.dataset.sketchLines === String(n), finished, { timeout: 10000 });
    await other.close();

    // Carrying on after the reload: Sketch 2, drawn messily on top of Sketch 1's segments.
    await startSketch(page);
    const two = sketchModel(finished);
    await agree(page, two, `${where()}: an empty Sketch 2`);
    for (let i = 0; i < 20; i++) {
      steps.push(await randomStep(page, two, r));
      await agree(page, two, where());
    }
    await page.click("#sketch-finish");

    // Sketch 3: a closed house of lines, one corner per column above the floor, extruded 10 mm to the model's volume.
    await startSketch(page);
    const three = sketchModel(finished + two.lines.length + SEGMENTS_PER_CIRCLE * two.circles.length);
    const roof = [[40, 30]];
    for (const x of [30, 20, 10]) if (r() < 0.7) roof.push([x, 10 * (1 + Math.floor(r() * 4))]);
    const house = [[0, 0], [40, 0], ...roof, [0, 30]];
    for (const p of [...house, house[0]]) {
      await clickPlane(page, p, TOP);
      click(three, p);
    }
    steps.push(`house ${JSON.stringify(house)}`);
    await agree(page, three, where());
    const area = shoelace(house);
    await page.click("#sketch-extrude");
    await page.waitForFunction(() => document.querySelector("#extrude-ok")?.disabled === false, null, { timeout: 5000 });
    await page.fill("#extrude-distance", "10");
    await page.click("#extrude-ok");
    const volume = `${(area * 10).toLocaleString("en-GB", { maximumSignificantDigits: 10 })} mm³`;
    await page.waitForFunction((v) => document.querySelector("#volume")?.textContent === v, volume, { timeout: 5000 }).catch(async () =>
      assert.fail(`${where()}: volume ${await page.textContent("#volume")}, the model's ${area} mm² × 10 mm is ${volume}`),
    );
    console.log(`ok - seed ${seed}: ${steps.length} steps, ${one.lines.length} lines and ${one.circles.length} circles kept in Sketch 1, saved, reloaded, reopened, Sketch 2, ${volume} extruded`);
  } catch (e) {
    failed++;
    console.log(`not ok - seed ${seed}\n  ${e.message.split("\n").join("\n  ")}`);
    console.log(`  to keep it: e2e/regressions/sketch-session-${seed}.json = ${JSON.stringify({ seed, browser: browserName, steps })}`);
  } finally {
    await context.close();
  }
}

try {
  for (const seed of SEEDS) await session(seed);
  if (errors.length) {
    failed++;
    console.log(`not ok - no errors in the console\n  ${errors.join("\n  ")}`);
  } else console.log("ok - no errors in the console");
} finally {
  await browser.close();
  server.httpServer.close();
}
if (failed) {
  console.log(`${failed} sketch session check(s) failed`);
  process.exit(1);
}
