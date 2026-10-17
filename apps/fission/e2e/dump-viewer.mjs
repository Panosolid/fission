// Browser check of the kernel's failure-dump viewer: writes two dumps with
// the kernel's `dump_demo` example (a box with a corner lifted off its
// edges, and the same box untouched), opens each page straight from disk
// and checks what is drawn. Run with `npm run e2e`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./browser.mjs";

const dir = mkdtempSync(join(tmpdir(), "fission-dumps-"));
const kernel = resolve(import.meta.dirname, "../../../kernel");
execFileSync("cargo", ["run", "--quiet", "--example", "dump_demo", "--", dir], { cwd: kernel, stdio: "inherit" });

const browser = await launch();
let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS ${name}`);
};

/** Opens a dump page offline and returns what it shows. */
async function open(name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  const requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => r.url().startsWith("file:") || requests.push(r.url()));
  await page.goto(pathToFileURL(join(dir, name, "index.html")).href);
  await page.waitForFunction(() => document.body.dataset.triangles !== undefined);
  // Pixels that are clearly red: the problem colour, and nothing else
  // on the page is (bodies are grey, blue, purple and orange).
  const countRed = () =>
    page.evaluate(() => {
      const c = document.querySelector("canvas");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i] > 2.5 * d[i + 1] && d[i] > 2.5 * d[i + 2]) n++;
      return n;
    });
  return { page, errors, requests, countRed, info: await page.textContent("#info") };
}

const broken = await open("broken");
const brokenRed = await broken.countRed();
const brokenTriangles = await broken.page.evaluate(() => document.body.dataset.triangles);
check("broken box: page runs without errors or network requests", () => {
  assert.deepEqual(broken.errors, []);
  assert.deepEqual(broken.requests, []);
});
check("broken box: lists its problems and the note", () => {
  assert.match(broken.info, /corner lifted 10 mm/);
  assert.match(broken.info, /3 problem\(s\)/);
  assert.match(broken.info, /mm off edge/);
});
check("broken box: 12 triangles drawn, problems in red", () => {
  assert.equal(brokenTriangles, "12");
  assert.ok(brokenRed > 200, `only ${brokenRed} red pixels`);
});

const valid = await open("valid");
const validRed = await valid.countRed();
check("valid box: no problems and nothing red", () => {
  assert.deepEqual(valid.errors, []);
  assert.match(valid.info, /valid/);
  assert.equal(validRed, 0);
});

// Hiding the faces leaves only lines: the red edges and corner stay.
await broken.page.click("#faces");
const hiddenTriangles = await broken.page.evaluate(() => document.body.dataset.triangles);
const hiddenRed = await broken.countRed();
check("hide faces: no triangles, red marks still drawn", () => {
  assert.equal(hiddenTriangles, "0");
  assert.ok(hiddenRed > 50, `only ${hiddenRed} red pixels`);
});

await browser.close();
rmSync(dir, { recursive: true, force: true });
console.log(`dump viewer: ${passed} checks passed`);
