// Magic-moment journeys in the browser (X8, docs/integration.md "Measuring
// the magic"): each ready journey in `MAGIC_JOURNEYS` (packages/testing) is
// walked like a user would, counting every real click on the page and timing
// from the first click to the result; `judge` gives the verdict against the
// journey's click and time limits. Journeys waiting for a workspace are
// listed as PENDING and never pass.
// Then each journey is compared with its baseline in tests/baseline.json
// (X8b, `compareToBaseline`): an extra click always fails; a slowest walk more
// than 15% over fails only with JOURNEY_NIGHTLY=1 (the nightly run), since
// one PR run's time is too noisy to judge. JOURNEY_REPORT=<file> writes the
// baseline lines there for the nightly summary.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { launch } from "./browser.mjs";
import { clickPlane, TOP } from "./sketch-screen.mjs";
import { preview } from "vite";
import { MAGIC_JOURNEYS, baselineLine, compareToBaseline, judge, parseBaselines, reportLine } from "../../../packages/testing/src/magic.ts";

/** Walks per journey; the slowest one is judged, so a limit holds every time. */
const WALKS = 5;
const NIGHTLY = process.env.JOURNEY_NIGHTLY === "1";
const baselines = parseBaselines(JSON.parse(readFileSync(new URL("../../../tests/baseline.json", import.meta.url), "utf8")).journeys);

const server = await preview({ preview: { port: 4180, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4180/";
const browser = await launch();
const errors = [];

async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    indexedDB.deleteDatabase("fission");
    // The click counter: every click a person makes (trusted), seen first on
    // the window. Clicks the app makes itself (an anchor for a download) are
    // untrusted, so they don't count.
    window.journeyClicks = 0;
    window.addEventListener("click", (e) => e.isTrusted && window.journeyClicks++, { capture: true });
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  return page;
}

const clicks = (page) => page.evaluate(() => window.journeyClicks);
const volume = (page, text) => page.waitForFunction((t) => document.querySelector("#volume")?.textContent === t, text);

/** Volume enclosed by binary STL triangles (divergence theorem: Σ a·(b×c)/6). */
function stlVolume(bytes) {
  const n = bytes.readUInt32LE(80);
  let v = 0;
  for (let t = 0; t < n; t++) {
    const at = 84 + 50 * t + 12;
    const [a, b, c] = [0, 1, 2].map((k) => [0, 1, 2].map((i) => bytes.readFloatLE(at + 12 * k + 4 * i)));
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/**
 * "Design: shape to STL", from a cylinder on screen: click Box, click the
 * width and type 50, click STL. Returns the clicks counted on the page, the
 * milliseconds from the first click to the file, and the file.
 * `extraClick` adds a needless click (the deliberate break).
 */
async function designShapeToStl(page, { extraClick = false } = {}) {
  // Set-up, not part of the journey: a cylinder on screen, counter at zero.
  await page.click("#toolbar [data-shape=cylinder]");
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "cylinder");
  await page.evaluate(() => (window.journeyClicks = 0));

  const t0 = performance.now();
  await page.click("#toolbar [data-shape=box]"); // pick a shape
  await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "box");
  if (extraClick) await page.click("#toolbar [data-shape=box]");
  await page.click("#width"); // change a size
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("50");
  await volume(page, "30,000 mm³"); // 50 × 30 × 20
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#toolbar [data-op=export_stl]")]); // Download STL
  const path = await download.path();
  const ms = performance.now() - t0;
  return { clicks: await clicks(page), ms, name: download.suggestedFilename(), bytes: readFileSync(path) };
}

/**
 * "Design: sketch to STL" (step 25c4), from the default box: Create Sketch,
 * the ground plane, the rectangle tool, its corners (0, 0) and (40, 30),
 * Extrude, OK at its 10 mm, and STL, which saves every body shown: the box
 * and the extrude. Set-up, not counted: a fresh page (the one passed in is
 * left alone), and Snap to grid ticked in a sketch that Undo then takes
 * back, so the corners are exact.
 */
async function designSketchToStl() {
  // Set-up: a page of its own, as a reload would bring back the autosaved design.
  const page = await fresh();
  try {
    // Snap to grid lives in the sketch panel and lasts for the page: tick it in a sketch, then Undo that sketch.
    await page.click("#create-sketch");
    await page.click("#sketch-plane-XY");
    await page.check("#sketch-grid-snap");
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching !== "true" && document.getElementById("undo").title === "Nothing to undo");
    await page.evaluate(() => (window.journeyClicks = 0));

    const t0 = performance.now();
    await page.click("#create-sketch"); // start a sketch on the ground
    await page.click("#sketch-plane-XY");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.sketching === "true");
    await page.click("#sketch-tool-rectangle"); // draw a rectangle
    for (const corner of [[0, 0], [40, 30]]) await clickPlane(page, corner, TOP);
    await page.waitForFunction(() => document.querySelector("#sketch-status")?.textContent === "4 lines, a closed outline.");
    await page.click("#sketch-extrude"); // extrude it
    await page.waitForFunction(() => document.querySelector("#extrude-status")?.textContent.startsWith("Sketch 1 makes a closed outline."));
    await page.click("#extrude-ok");
    await volume(page, "12,000 mm³"); // 40 × 30 × 10
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#toolbar [data-op=export_stl]")]); // Download STL
    const path = await download.path();
    const ms = performance.now() - t0;
    return { clicks: await clicks(page), ms, name: download.suggestedFilename(), bytes: readFileSync(path) };
  } finally {
    await page.context().close();
  }
}

const WALKERS = { "Design: shape to STL": designShapeToStl, "Design: sketch to STL": designSketchToStl };

/**
 * The file each journey makes, worked by hand; every corner is a whole
 * number of mm, exact in single precision. A 50 × 30 × 20 box is 12
 * triangles, 84 + 50 · 12 = 684 bytes, 30,000 mm³. The box and the
 * extruded 40 × 30 rectangle are 12 + 12 triangles, 84 + 50 · 24 = 1284
 * bytes, 24,000 + 12,000 = 36,000 mm³ (overlapping volumes add).
 */
const FILES = {
  "Design: shape to STL": { name: "fission-box.stl", length: 684, volume: 30000 },
  "Design: sketch to STL": { name: "fission-2-bodies.stl", length: 1284, volume: 36000 },
};

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

const measured = {};
try {
  for (const journey of MAGIC_JOURNEYS) {
    if (journey.status !== "ready") {
      // Pending: listed, never walked, never passing.
      console.log(reportLine(journey, judge(journey, null)));
      continue;
    }
    await check(`journey "${journey.name}" within ${journey.clickLimit} clicks and ${journey.secondsLimit} s, ${WALKS} walks`, async () => {
      const walk = WALKERS[journey.name];
      assert.ok(walk, `no walker for ready journey "${journey.name}"`);
      const page = await fresh();
      try {
        const runs = [];
        for (let i = 0; i < WALKS; i++) {
          const run = await walk(page);
          // The result is the right file (FILES).
          const want = FILES[journey.name];
          assert.equal(run.name, want.name);
          assert.equal(run.bytes.length, want.length);
          assert.equal(stlVolume(run.bytes), want.volume);
          runs.push(run);
        }
        const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
        const worst = { clicks: Math.max(...runs.map((r) => r.clicks)), ms: ms.at(-1) };
        measured[journey.name] = { clicks: worst.clicks, medianMs: ms[Math.floor(ms.length / 2)], slowestMs: worst.ms };
        console.log(`  clicks ${runs.map((r) => r.clicks).join(", ")}; times ${runs.map((r) => (r.ms / 1000).toFixed(2)).join(", ")} s`);
        const verdict = judge(journey, worst);
        console.log(`  ${reportLine(journey, verdict)}`);
        assert.equal(verdict.kind, "pass", reportLine(journey, verdict));
      } finally {
        await page.close();
      }
    });
  }

  await check("the counter counts every click and only clicks a person makes: Design's walks are exactly 3 and 8", async () => {
    const page = await fresh();
    try {
      // Box, the width field, STL: 3 clicks worked out from the steps. The app's
      // own anchor click for the download is untrusted and adds nothing.
      assert.equal((await designShapeToStl(page)).clicks, 3);
      await page.evaluate(() => document.querySelector("#toolbar [data-shape=cylinder]").click()); // a script's click
      assert.equal(await clicks(page), 3);
      // The sketch's walk: Create Sketch, the plane, the rectangle tool, two corners, Extrude, OK, STL: 8.
      assert.equal((await designSketchToStl()).clicks, 8);
    } finally {
      await page.close();
    }
  });

  await check("deliberate breaks fail: one needless click, or a time limit too tight", async () => {
    const journey = MAGIC_JOURNEYS.find((j) => j.name === "Design: shape to STL");
    const page = await fresh();
    try {
      const run = await designShapeToStl(page, { extraClick: true });
      assert.equal(run.clicks, 4);
      assert.deepEqual(judge(journey, run).kind, "fail");
      assert.match(reportLine(journey, judge(journey, run)), /^FAIL .*4 clicks, limit 3/);
      const tight = { ...journey, secondsLimit: run.ms / 1000 / 1.1 }; // the walk takes 1.1× the limit
      assert.equal(judge(tight, { clicks: 3, ms: run.ms }).kind, "fail");
    } finally {
      await page.close();
    }
  });

  await check("deliberate breaks are flagged against the baseline: one extra click, a slowest walk 16.5% over", async () => {
    const journey = MAGIC_JOURNEYS.find((j) => j.name === "Design: shape to STL");
    const base = baselines.get(journey.name);
    const page = await fresh();
    try {
      const run = await designShapeToStl(page, { extraClick: true });
      const extra = compareToBaseline(journey, { clicks: run.clicks, slowestMs: run.ms }, { ...base, slowestMs: run.ms });
      assert.equal(extra.kind, "flag");
      assert.deepEqual(extra.flags.map((f) => f.kind), ["clicks"]);
      // A real walk against baselines that put it at 0.9× and 1.1× of the 15% margin.
      const walked = { clicks: 3, slowestMs: run.ms };
      assert.equal(compareToBaseline(journey, walked, { clicks: 3, slowestMs: run.ms / 1.135 }).kind, "ok");
      const slow = compareToBaseline(journey, walked, { clicks: 3, slowestMs: run.ms / 1.165 });
      assert.deepEqual(slow.kind === "flag" && slow.flags.map((f) => f.kind), ["time"]);
    } finally {
      await page.close();
    }
  });

  const lines = [];
  await check(`against tests/baseline.json: no extra click${NIGHTLY ? ", slowest walk at most 15% over" : " (time judged nightly only)"}`, async () => {
    const bad = [];
    for (const journey of MAGIC_JOURNEYS) {
      const m = journey.status === "ready" ? (measured[journey.name] ?? null) : null;
      const b = baselines.get(journey.name);
      const c = compareToBaseline(journey, m && { clicks: m.clicks, slowestMs: m.slowestMs }, b);
      lines.push(baselineLine(journey, m, b, c));
      if (c.kind === "flag" && c.flags.some((f) => f.kind !== "time" || NIGHTLY)) bad.push(lines.at(-1));
    }
    console.log(lines.map((l) => `  ${l}`).join("\n"));
    assert.deepEqual(bad, []);
  });
  if (process.env.JOURNEY_REPORT) {
    mkdirSync(dirname(process.env.JOURNEY_REPORT), { recursive: true });
    writeFileSync(process.env.JOURNEY_REPORT, lines.join("\n") + "\n");
  }

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
console.log(`journey numbers: ${JSON.stringify(measured)}`);
if (failed) process.exit(1);
console.log("journey checks passed");
