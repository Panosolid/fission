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

  await check("no errors in the browser console", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} finally {
  await browser.close();
  server.httpServer.close();
}

process.exit(failed ? 1 : 0);
