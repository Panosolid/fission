// Browser smoke test: serves the built app, drives it like a user and checks
// what is on screen. Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
    assert.equal(await text("intent"), "Box: 40 × 30 × 20 mm");
    assert.equal(await text("provenance"), "Feature 1 (box) was made in Design.");
  });

  await check("the box is actually drawn", async () => {
    await page.waitForTimeout(300);
    const background = [0x14, 0x16, 0x1a];
    const centre = await pixel(0.5, 0.5);
    const corner = await pixel(0.02, 0.02);
    assert.deepEqual(corner, background, "corner should be empty background");
    assert.notDeepEqual(centre, background, "centre of the view should show the body");
  });

  await check("clicking faces selects them: click, Shift-click, drag, empty space, Escape", async () => {
    // Where a point of the box lands on screen, worked out here from the
    // framing in viewer.ts fit() rather than asked of the viewer: the
    // 40×30×20 box is framed as a sphere at its centre (20, 15, 10) with
    // r = √(40² + 30² + 20²)/2 = √2900/2, the camera sits r / sin(22.5°)
    // away along (0.6, −0.8, 0.55), looks at the centre with Z up, fov 45°.
    const box = await page.locator("#viewport canvas").boundingBox();
    const screen = ([px, py, pz]) => {
      const n = Math.hypot(0.6, -0.8, 0.55);
      const dir = [0.6 / n, -0.8 / n, 0.55 / n];
      const centre = [20, 15, 10];
      const dist = Math.sqrt(2900) / 2 / Math.sin(Math.PI / 8);
      const cam = centre.map((c, i) => c + dir[i] * dist);
      const fwd = dir.map((d) => -d);
      const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const unit = (a) => a.map((x) => x / Math.hypot(...a));
      const right = unit(cross(fwd, [0, 0, 1]));
      const up = cross(right, fwd);
      const v = [px - cam[0], py - cam[1], pz - cam[2]];
      const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const t = Math.tan(Math.PI / 8);
      const ndcX = dot(v, right) / (dot(v, fwd) * t * (box.width / box.height));
      const ndcY = dot(v, up) / (dot(v, fwd) * t);
      return { x: box.x + ((ndcX + 1) / 2) * box.width, y: box.y + ((1 - ndcY) / 2) * box.height };
    };
    const selection = () => page.evaluate(() => document.body.dataset.selection ?? "");
    // Kernel face order for a box (primitives.rs): −Z, +Z, −Y, +Y, −X, +X.
    const top = screen([20, 15, 20]); // centre of the +Z face: face 1
    const front = screen([20, 0, 10]); // centre of the −Y face: face 2
    await page.mouse.click(top.x, top.y);
    assert.equal(await selection(), "face:feature-1/1", "a click on the top face selects face 1");
    await page.keyboard.down("Shift");
    await page.mouse.click(front.x, front.y);
    await page.keyboard.up("Shift");
    assert.equal(await selection(), "face:feature-1/1 face:feature-1/2", "Shift-click adds the front face");
    // A press that moves 30 px is the camera orbiting, not a pick: nothing changes.
    await page.mouse.move(front.x, front.y);
    await page.mouse.down();
    await page.mouse.move(front.x + 30, front.y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await selection(), "face:feature-1/1 face:feature-1/2", "a drag does not pick");
    await page.mouse.click(box.x + 0.02 * box.width, box.y + 0.02 * box.height);
    assert.equal(await selection(), "", "a click on empty space clears");
    await page.mouse.click(top.x, top.y);
    await page.keyboard.press("Escape");
    assert.equal(await selection(), "", "Escape clears");
    // Put the camera back where fit() left it for the checks below.
    await page.click("#toolbar [data-shape=cylinder]");
    await page.click("#toolbar [data-shape=box]");
    await page.waitForFunction(() => document.querySelector("#viewport").dataset.shape === "box");
  });

  await check("editing a size rebuilds the body", async () => {
    await setSize("width", 100);
    // V = 100·30·20 = 60000.
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "60,000 mm³");
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
    await page.click(`#toolbar [data-shape=${kind}]`);
    await page.waitForFunction(
      ([k, v]) => document.querySelector("#viewport").dataset.shape === k && document.querySelector("#volume").textContent !== v,
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

  await check("the browser lists the timeline, Body 1 and the origin; a click highlights one row", async () => {
    // The L-bracket part from the check above: feature #1 with its intent.
    const rows = async (group) => page.$$eval(`#browser [data-node=${group}] .tree-row`, (els) => els.map((e) => e.textContent));
    assert.deepEqual(await rows("timeline"), ["1. Extrude: L-bracket profile 40 × 30 mm, by 20 mm"]);
    assert.deepEqual(await rows("bodies"), ["Body 1"]);
    assert.deepEqual(await rows("origin"), ["XY plane", "XZ plane", "YZ plane", "X axis", "Y axis", "Z axis"]);
    const current = () => page.$$eval("#browser [aria-current=true]", (els) => els.map((e) => e.dataset.node));
    assert.deepEqual(await current(), []);
    await page.click("#browser [data-node=body-1]");
    assert.deepEqual(await current(), ["body-1"]);
    await page.click("#browser [data-node=origin-z]");
    assert.deepEqual(await current(), ["origin-z"]);
    // Folding a group keeps it folded when an edit rebuilds the tree.
    await page.click("#browser [data-node=origin] summary");
    await setSize("height", 21);
    await page.waitForFunction(() => document.querySelector("#browser [data-node=feature-1]").textContent.endsWith("by 21 mm"));
    assert.equal(await page.$eval("#browser [data-node=origin]", (el) => el.open), false);
    assert.deepEqual(await current(), ["origin-z"]);
    await page.click("#browser [data-node=origin] summary");
    await setSize("height", 20);
    await page.screenshot({ path: "e2e/browser.png" });
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
  });

  /** Clicks the toolbar's STL button; returns the file's name and its triangles (f32 corners). */
  const downloadStl = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#toolbar [data-op=export_stl]")]);
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    const f = await downloadStl();
    // 12 triangles: 84 + 12 × 50 = 684 bytes. Corners 0/40, 0/30, 0/20 are
    // exact in single precision, so the volume is exactly 40 × 30 × 20.
    assert.equal(f.name, "fission-box.stl");
    assert.equal(f.header, "Fission STL:");
    assert.equal(f.size, 684);
    assert.equal(f.tris.length, 12);
    assert.equal(stlVolume(f.tris), 24000);
    assert.equal(await text("stl-note"), "");
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
    assert.match(await text("stl-note"), /single-precision numbers: this part's corners move by up to 1\.250e-2 mm/);
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    // Editing the part clears the overlay: it described the part before the edit.
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.overlays), "");
    assert.equal(await page.isVisible(".overlay-legend"), false);
    await page.waitForTimeout(300);
    // Only the red X axis line is left (a few dozen pixels).
    assert.ok((await amber()) < 1000, `nothing amber once the overlay is cleared (${await amber()} px)`);
    await downloadStl();
    assert.equal(await text("stl-note"), ""); // the warning goes once the part fits again
  });

  await check("the switcher lists the nine workspaces, Design first and working", async () => {
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
      ["Image", true],
    ]);
    assert.equal(await page.getAttribute("[data-workspace=design]", "aria-selected"), "true");
  });

  await check("each placeholder workspace says what it will do and 'Coming soon', and keeps the viewport", async () => {
    // Back to a known body, then remember the camera's view of it.
    await page.click("#toolbar [data-shape=box]");
    await page.fill("#width", "40");
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "24,000 mm³");
    await page.waitForTimeout(300); // let orbit damping settle
    const radius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);
    const before = await pixel(0.5, 0.5);
    for (const [id, title] of [["render", "Render"], ["simulate", "Simulate"], ["manufacture", "Manufacture"], ["laser", "Laser"], ["slice", "Slice"], ["circuit", "Circuit"], ["vector", "Vector"], ["image", "Image"]]) {
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
    assert.match(await page.textContent("#assistant"), /Coming soon/);
    assert.match(await page.textContent("#ai-status-detail"), /Nothing is sent anywhere/);
    assert.match(await page.textContent("#assistant"), /In Design.*Plain-English commands/s);
    // The settings list the four providers and say which keep data local.
    assert.equal(await page.locator("#assistant [data-provider]").count(), 4);
    assert.match(await page.textContent('[data-provider="ollama"]'), /stays on your machine.*OLLAMA_ORIGINS/s);
    assert.match(await page.textContent('[data-provider="api-key"]'), /sends your request to the provider.*Consumer chat subscriptions can't be used/s);
    await page.screenshot({ path: "e2e/assistant.png" });
    // Switching workspace keeps the panel and changes what it lists.
    await page.click('[data-workspace="laser"]');
    assert.match(await page.textContent("#assistant"), /In Laser.*finger-joint boxes/s);
    assert.doesNotMatch(await page.textContent("#assistant"), /In Design/);
    await page.click("#assistant-toggle");
    assert.equal(await page.isVisible("#assistant"), false);
    await page.click('[data-workspace="design"]');
  });

  await check("desktop: focus moves top bar, toolbar, browser, properties; panel toggles hidden", async () => {
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
      const region = await page.evaluate(() => document.activeElement?.closest("#topbar, #toolbar, #browser, #properties")?.id ?? "other");
      if (region !== regions.at(-1)) regions.push(region);
    }
    assert.deepEqual(regions, ["topbar", "toolbar", "browser", "properties"]);
    await page.screenshot({ path: "e2e/design-1280.png" });
  });

  await check("phone width: no sideways scroll, browser and properties fold behind toggles", async () => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(url + "#design");
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "valid");
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
    await page.waitForFunction(() => document.querySelector("#volume").textContent === "30,000 mm³");
    // A placeholder fills only properties: no browser toggle, its page shows.
    await page.click("[data-workspace=laser]");
    assert.equal(await page.isVisible("#browser-toggle"), false);
    assert.equal(await page.isVisible(".placeholder h2"), true);
    assert.deepEqual(await overflow(), []);
    await page.screenshot({ path: "e2e/laser-375.png" });
    await page.click("[data-workspace=design]");
    await page.setViewportSize({ width: 1000, height: 640 });
  });

  await check("no errors in the browser console", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
