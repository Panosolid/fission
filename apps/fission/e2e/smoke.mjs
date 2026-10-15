// Browser smoke test: serves the built app, drives it like a user and checks
// what is on screen. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4174/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const text = (id) => page.textContent(`#${id}`);
const setSize = async (id, value) => {
  await page.fill(`#${id}`, String(value));
};

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
  await page.waitForFunction(() => document.querySelector("#status")?.textContent !== "…");

  await check("default 40×30×20 box shows hand-worked numbers", async () => {
    // V = 40·30·20 = 24000; A = 2(40·30 + 30·20 + 40·20) = 5200.
    assert.equal(await text("volume"), "24,000 mm³");
    assert.equal(await text("area"), "5,200 mm²");
    assert.equal(await text("topology"), "8 V · 12 E · 6 F");
    assert.equal(await text("status"), "valid");
  });

  await check("the box is actually drawn", async () => {
    await page.waitForTimeout(300);
    const background = [0x14, 0x16, 0x1a];
    const centre = await pixel(0.5, 0.5);
    const corner = await pixel(0.02, 0.02);
    assert.deepEqual(corner, background, "corner should be empty background");
    assert.notDeepEqual(centre, background, "centre of the view should show the body");
  });

  await check("editing a size rebuilds the body", async () => {
    await setSize("width", 100);
    // V = 100·30·20 = 60000.
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "60,000 mm³");
  });

  await check("bad input shows an error instead of crashing", async () => {
    await setSize("width", 0);
    await page.waitForFunction(() => document.querySelector("#error").textContent.includes("width must be"));
    await setSize("width", 40);
    await page.waitForFunction(() => document.querySelector("#error").textContent === "");
    assert.equal(await text("volume"), "24,000 mm³");
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "46,200 mm³");
    await page.waitForTimeout(300);
    assert.equal(await text("volume"), "46,200 mm³");
    await setSize("width", 40);
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
  });

  await check("a 1 µm cube is measured and framed", async () => {
    // 0.001³ = 1e-9 mm³ and 6 · 0.001² = 6e-6 mm²: never shown as 0.
    for (const id of ["width", "depth", "height"]) await setSize(id, 0.001);
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "1 × 10⁻⁹ mm³");
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    const back = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(back - 25) < 1e-4, `framed radius ${back}`);
  });

  /** The number shown in a stats field, e.g. "21,484.26 mm³" → 21484.26. */
  const shown = async (id) => Number((await text(id)).split(" ")[0].replaceAll(",", ""));
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${what}: shown ${a}, expected ${b}`);
  const pick = async (kind, volumeNot) => {
    await page.selectOption("#shape", kind);
    await page.waitForFunction(
      ([k, v]) => document.querySelector("#viewport").dataset.shape === k && document.querySelector("#volume").textContent !== v,
      [kind, volumeNot],
    );
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
    // A new shape is framed: r = √(40² + 30² + 20²)/2 ≈ 26.93.
    const r = Number(await page.$eval("#viewport", (el) => el.dataset.framedRadius));
    assert.ok(Math.abs(r - Math.sqrt(2900) / 2) < 1e-4, `framed radius ${r}`);
    await page.waitForTimeout(300);
    assert.notDeepEqual(await pixel(0.5, 0.5), [0x14, 0x16, 0x1a], "the bracket should be drawn");
    await page.screenshot({ path: "e2e/l-bracket.png" });
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
    await page.selectOption("#shape", "plate");
    for (const id of ["width", "depth"]) await setSize(id, 0.008);
    await page.waitForFunction(() => document.querySelector("#error").textContent.includes("features must be at least"));
    for (const [id, v] of [["width", 40], ["depth", 30]]) await setSize(id, v);
    await page.waitForFunction(() => document.querySelector("#error").textContent === "");
    await page.selectOption("#shape", "box");
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
  });

  await check("the switcher lists the six workspaces, Design first and working", async () => {
    const tabs = await page.$$eval("#workspaces [role=tab]", (ts) => ts.map((t) => [t.textContent, t.classList.contains("soon")]));
    assert.deepEqual(tabs, [
      ["Design", false],
      ["Render", true],
      ["Simulate", true],
      ["Manufacture", true],
      ["Laser", true],
      ["Slice", true],
    ]);
    assert.equal(await page.getAttribute("[data-workspace=design]", "aria-selected"), "true");
  });

  await check("each placeholder workspace says what it will do and 'Coming soon', and keeps the viewport", async () => {
    // Back to a known body, then remember the camera's view of it.
    await page.selectOption("#shape", "box");
    await page.fill("#width", "40");
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    await page.waitForTimeout(300); // let orbit damping settle
    const radius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);
    const before = await pixel(0.5, 0.5);
    for (const [id, title] of [["render", "Render"], ["simulate", "Simulate"], ["manufacture", "Manufacture"], ["laser", "Laser"], ["slice", "Slice"]]) {
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    assert.equal(await page.inputValue("#width"), "40");
    assert.equal(await page.inputValue("#shape"), "box");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.framedRadius), radius);
    await page.screenshot({ path: "e2e/workspace-design.png" });
  });

  await check("opening a workspace link goes straight to it", async () => {
    await page.goto(`${url}#laser`);
    assert.equal(await page.textContent(".placeholder h2"), "Laser");
    assert.equal(await page.getAttribute("[data-workspace=laser]", "aria-selected"), "true");
  });

  await check("no errors in the browser console", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
