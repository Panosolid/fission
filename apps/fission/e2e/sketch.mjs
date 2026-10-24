// Browser check of saved sketches (step 21b): a project file holding a
// sketch opens with the sketch as a timeline row and a row of the Sketches
// group; changing the part keeps it, Undo puts the part back and keeps it,
// and Save writes it back unchanged. A version 1 file (before sketches)
// still opens. A file whose part extrudes a one-circle sketch (step 22b)
// opens as a cylinder of πr²h; one with a pie slice of a line, an arc and
// a line (step 23a) draws the arc and extrudes to a quarter of one. Screenshots at 1280 and 375 px wide go to
// E2E_SHOTS when set.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launch } from "./browser.mjs";
import { preview } from "vite";
import { pinProperties } from "./properties.mjs";

const server = await preview({ preview: { port: 4182, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4182/";
const browser = await launch();
const errors = [];
const shots = process.env.E2E_SHOTS;

async function fresh(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  await pinProperties(page); // the size boxes are in the panel, folded at the start on a wide screen (U0b)
  return page;
}

/** A 40 × 30 × 20 box and Sketch 1, a 3-4-5 triangle drawn as a chain, written by hand as docs/project-format.md describes. */
const sketch = {
  id: "sketch-2",
  points: [
    { id: "point-3", x: 0, y: 0 },
    { id: "point-4", x: 4, y: 0 },
    { id: "point-6", x: 0, y: 3 },
  ],
  curves: [
    { id: "line-5", kind: "line", start: "point-3", end: "point-4" },
    { id: "line-7", kind: "line", start: "point-4", end: "point-6" },
    { id: "line-8", kind: "line", start: "point-6", end: "point-3" },
  ],
  constraints: [],
};
const project = {
  formatVersion: 2,
  name: "Sketched",
  units: { length: "mm" },
  materials: [],
  links: [],
  workspaces: {
    design: {
      version: 2,
      nextId: 9,
      profiles: [],
      sketches: [sketch],
      timeline: {
        features: [
          {
            id: "feature-1",
            intent: { type: "box", parameters: { width: 40, depth: 30, height: 20 }, summary: "Box: 40 × 30 × 20 mm" },
            provenance: { self: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
          {
            id: "sketch-2",
            intent: { type: "sketch", parameters: { plane: "XY" }, summary: "Sketch 1 on the XY plane" },
            provenance: { self: { workspace: "design", id: "sketch-2", label: "Sketch 1" }, from: [] },
            dependsOn: [],
            suppressed: false,
          },
        ],
      },
    },
  },
};

const rows = (page, group) => page.$$eval(`#browser [data-node=${group}] .tree-row`, (els) => els.map((e) => e.textContent));
const open = (page, name, text) => page.setInputFiles("#open-file", { name, mimeType: "application/json", buffer: Buffer.from(text) });

let failed = false;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n  ${e.stack ?? e}`);
  }
}

try {
  for (const width of [1280, 375])
    await check(`a file with a sketch opens, keeps it through an edit, Undo and Save (${width} px)`, async () => {
      const page = await fresh(width);
      try {
        await open(page, "Sketched.fission.json", JSON.stringify(project));
        await page.waitForFunction(() => document.querySelector("#browser [data-node='sketches/sketch-2']"));
        assert.deepEqual(await rows(page, "timeline"), ["1. Box: 40 × 30 × 20 mm", "2. Sketch 1 on the XY plane"]);
        assert.deepEqual(await rows(page, "sketches"), ["Sketch 1"]);
        // On a phone the browser is a panel opened by its button; the rows must be there to see.
        if (width < 700) await page.click("#browser-toggle");
        assert.equal(await page.isVisible("#browser [data-node='sketches/sketch-2']"), true);
        if (shots) await page.screenshot({ path: `${shots}/sketch-${width}.png` });
        // The panel edits the part; the sketch stays where it is.
        if (width === 1280) {
          await page.fill("#width", "50");
          await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³"); // 50 · 30 · 20
          assert.deepEqual(await rows(page, "timeline"), ["1. Box: 50 × 30 × 20 mm", "2. Sketch 1 on the XY plane"]);
          await page.click("#viewport");
          await page.keyboard.press("Control+z");
          await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
          assert.deepEqual(await rows(page, "sketches"), ["Sketch 1"]);
          // Save writes the sketch back as it was opened.
          const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
          const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
          assert.deepEqual(saved.workspaces.design.sketches, [sketch]);
          assert.equal(saved.workspaces.design.nextId, 9);
        }
      } finally {
        await page.close();
      }
    });

  await check("a version 1 file (before sketches) opens with an empty Sketches group", async () => {
    const page = await fresh();
    try {
      const v1 = structuredClone(project);
      const { nextId: _, sketches: __, ...design } = v1.workspaces.design;
      v1.workspaces.design = { ...design, version: 1, timeline: { features: [design.timeline.features[0]] } };
      v1.workspaces.design.timeline.features[0].intent = { type: "box", parameters: { width: 50, depth: 30, height: 20 }, summary: "Box: 50 × 30 × 20 mm" };
      await open(page, "Old.fission.json", JSON.stringify(v1));
      await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "30,000 mm³");
      assert.deepEqual(await rows(page, "sketches"), []);
      assert.deepEqual(await rows(page, "timeline"), ["1. Box: 50 × 30 × 20 mm"]);
    } finally {
      await page.close();
    }
  });

  await check("a file whose part extrudes a sketch of one circle opens as a cylinder of πr²h, and saves it unchanged (22b)", async () => {
    const page = await fresh();
    try {
      // Sketch 1: one circle of radius 10 round (5, -5), extruded 10 mm, as docs/project-format.md describes.
      const circled = structuredClone(project);
      const design = circled.workspaces.design;
      const sketch = { id: "sketch-2", points: [{ id: "point-3", x: 5, y: -5 }], curves: [{ id: "circle-4", kind: "circle", centre: "point-3", radius: 10 }], constraints: [] };
      design.sketches = [sketch];
      design.nextId = 6;
      design.timeline.features = [
        design.timeline.features[1],
        {
          id: "feature-5",
          intent: { type: "extrude", parameters: { sketch: "sketch-2", distance: 10 }, summary: "Extrude: Sketch 1 by 10 mm" },
          provenance: { self: { workspace: "design", id: "feature-5", label: "Extrude 1" }, from: [{ workspace: "design", id: "sketch-2", label: "Sketch 1" }] },
          dependsOn: ["sketch-2"],
          suppressed: false,
        },
      ];
      await open(page, "Circled.fission.json", JSON.stringify(circled));
      // V = π·10²·10 = 1000π = 3141.59… mm³; A = 2·π·10² + 2π·10·10 = 400π = 1256.64… mm².
      await page.waitForFunction(() => /^[1-9][0-9,.]* mm³$/.test(document.querySelector("#volume")?.textContent ?? "") && document.querySelector("#volume").textContent !== "24,000 mm³");
      const shown = async (id) => Number((await page.textContent(id)).replace(/[^0-9.]/g, ""));
      const [volume, area] = [await shown("#volume"), await shown("#area")];
      assert.ok(Math.abs(volume - 1000 * Math.PI) <= 1e-6, `volume ${volume}`); // shown to six decimals
      assert.ok(Math.abs(area - 400 * Math.PI) <= 1e-6, `area ${area}`);
      assert.deepEqual(await rows(page, "sketches"), ["Sketch 1"]);
      if (shots) await page.screenshot({ path: `${shots}/sketch-circle-1280.png` });
      const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
      const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
      assert.deepEqual(saved.workspaces.design.sketches, [sketch]);
    } finally {
      await page.close();
    }
  });

  /** Sketch 1: a pie slice, (0,0) → (30,0), the quarter arc round (0,0) to (0,30), back to (0,0), as docs/project-format.md describes. */
  const pie = {
    id: "sketch-2",
    points: [
      { id: "point-3", x: 0, y: 0 },
      { id: "point-4", x: 30, y: 0 },
      { id: "point-6", x: 0, y: 30 },
    ],
    curves: [
      { id: "line-5", kind: "line", start: "point-3", end: "point-4" },
      { id: "arc-7", kind: "arc", start: "point-4", end: "point-6", centre: "point-3" },
      { id: "line-8", kind: "line", start: "point-6", end: "point-3" },
    ],
    constraints: [],
  };
  for (const width of [1280, 375])
    await check(`a file with an arc in a sketch draws it, and extruded it is a quarter of πr²h, saved unchanged (23a, ${width} px)`, async () => {
      const page = await fresh(width);
      try {
        const drawn = structuredClone(project);
        drawn.workspaces.design.sketches = [pie];
        await open(page, "Pie.fission.json", JSON.stringify(drawn));
        // Two lines and the quarter arc's ⌈64/4⌉ = 16 segments.
        await page.waitForFunction(() => document.querySelector("[data-sketch-lines]")?.dataset.sketchLines === "18");
        assert.deepEqual(await rows(page, "sketches"), ["Sketch 1"]);
        if (shots) await page.screenshot({ path: `${shots}/sketch-arc-${width}.png` });
        // Extruded 10 mm: V = ¼π·30²·10 = 2250π ≈ 7068.58 mm³. A = the two
        // quarter discs 2·225π, the flat sides 2·30·10 = 600 and the curved
        // side ¼·2π·30·10 = 150π: 600π + 600 ≈ 2484.96 mm².
        const extruded = structuredClone(drawn);
        const design = extruded.workspaces.design;
        design.nextId = 10;
        design.timeline.features = [
          design.timeline.features[1],
          {
            id: "feature-9",
            intent: { type: "extrude", parameters: { sketch: "sketch-2", distance: 10 }, summary: "Extrude: Sketch 1 by 10 mm" },
            provenance: { self: { workspace: "design", id: "feature-9", label: "Extrude 1" }, from: [{ workspace: "design", id: "sketch-2", label: "Sketch 1" }] },
            dependsOn: ["sketch-2"],
            suppressed: false,
          },
        ];
        await open(page, "Pie extruded.fission.json", JSON.stringify(extruded));
        await page.waitForFunction(() => /^[1-9][0-9,.]* mm³$/.test(document.querySelector("#volume")?.textContent ?? "") && document.querySelector("#volume").textContent !== "24,000 mm³");
        const shown = async (id) => Number((await page.textContent(id)).replace(/[^0-9.]/g, ""));
        const [volume, area] = [await shown("#volume"), await shown("#area")];
        assert.ok(Math.abs(volume - 2250 * Math.PI) <= 1e-6, `volume ${volume}`); // shown to six decimals
        assert.ok(Math.abs(area - (600 * Math.PI + 600)) <= 1e-6, `area ${area}`);
        if (shots) await page.screenshot({ path: `${shots}/sketch-arc-extruded-${width}.png` });
        // Save (behind Menu at phone width, checked once at desktop width) writes the arc back as it was opened.
        if (width === 1280) {
          const [download] = await Promise.all([page.waitForEvent("download"), page.click("#save")]);
          const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
          assert.deepEqual(saved.workspaces.design.sketches, [pie]);
        }
      } finally {
        await page.close();
      }
    });

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("sketch checks passed");
