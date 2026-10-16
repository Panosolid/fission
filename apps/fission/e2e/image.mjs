// Browser check of the Image workspace (G1b): opening a PNG shows it at its
// real size in the shared viewport, seen from above, with pan and zoom and
// no orbit; switching back to Design gives back the body and its camera.
// The test image is made here: 200 × 100 pixels at 254 DPI (10 px per mm),
// in four coloured quarters, so where each colour lands on screen shows the
// image is the right way up and the right shape.
// Run with `npm run e2e` (after `npm run build`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright";
import { preview } from "vite";

/** A PNG: 8-bit RGBA, `pixel(x, y)` gives [r, g, b, a]; `ppm` pixels per metre in a pHYs chunk (none if null). */
function makePng(width, height, pixel, ppm) {
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type, data) => {
    const body = Buffer.from([...Buffer.from(type, "ascii"), ...data]);
    return Buffer.from([...be32(data.length), ...body, ...be32(crc32(body))]);
  };
  const rows = [];
  for (let y = 0; y < height; y++) {
    rows.push(0); // filter: none
    for (let x = 0; x < width; x++) rows.push(...pixel(x, y));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    ...(ppm === null ? [] : [chunk("pHYs", [...be32(ppm), ...be32(ppm), 1])]),
    chunk("IDAT", [...deflateSync(Buffer.from(rows))]),
    chunk("IEND", []),
  ]);
}

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
// Top-left red, top-right green, bottom-left blue, bottom-right white (rows run from the top).
const quarters = (x, y) => [...(y < 50 ? (x < 100 ? RED : GREEN) : x < 100 ? BLUE : WHITE), 255];
const plate = makePng(200, 100, quarters, 10000); // 10000 px/m = 254 DPI
// The same headers with the picture data cut short: the header reader accepts it, the browser can't decode it.
const broken = (() => {
  const good = makePng(200, 100, quarters, 10000);
  const idat = good.indexOf("IDAT") - 4;
  const len = good.readUInt32BE(idat);
  const cut = Buffer.from(good);
  // Keep the chunk's length and CRC honest over garbage, so only the decode fails.
  const data = Buffer.alloc(len, 0x55);
  data.copy(cut, idat + 8);
  const crc = crc32(Buffer.concat([Buffer.from("IDAT"), data]));
  cut.writeUInt32BE(crc, idat + 8 + len);
  return cut;
})();

const server = await preview({ preview: { port: 4175, strictPort: true }, logLevel: "error" });
const url = "http://localhost:4175/";
const sandboxChromium = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(existsSync(sandboxChromium) ? { executablePath: sandboxChromium } : {});
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
await page.addInitScript(() => indexedDB.deleteDatabase("fission"));
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

/** RGB of the canvas pixel at a fraction of its width and height. */
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
const near = (got, want, what) => assert.ok(got.every((c, i) => Math.abs(c - want[i]) <= 3), `${what}: got ${got}, want ${want}`);

/** The sheet's extent on screen in canvas pixels: the first and last non-background pixels along the middle row and column. */
const sheetOnScreen = () =>
  page.evaluate(() => {
    const src = document.querySelector("#viewport canvas");
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    // The image's colours are all fully saturated or white; the background is dark grey.
    const isSheet = (x, y) => Math.max(...d.slice(4 * (y * c.width + x), 4 * (y * c.width + x) + 3)) > 200;
    const cy = Math.floor(c.height / 2);
    const cx = Math.floor(c.width / 2);
    const xs = [...Array(c.width).keys()].filter((x) => isSheet(x, cy));
    const ys = [...Array(c.height).keys()].filter((y) => isSheet(cx, y));
    return { width: xs.at(-1) - xs[0] + 1, height: ys.at(-1) - ys[0] + 1, canvas: [c.width, c.height] };
  });

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

const settle = () => page.waitForTimeout(400); // orbit damping eases out

try {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
  await settle();
  const designCentre = await pixel(0.5, 0.5);
  const designRadius = await page.$eval("#viewport", (el) => el.dataset.framedRadius);

  await page.click("[data-workspace=image]");

  await check("Image opens empty: an Open button, no layers, and the Design body hidden", async () => {
    assert.equal(await page.textContent("#image-open"), "Open…");
    assert.equal(await page.textContent("#layers-empty"), "No image open");
    assert.equal(await page.isVisible("#image-empty"), true);
    // Nothing shown, so the 3D view is as it was.
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.image ?? null), null);
  });

  await page.setInputFiles("#image-file", { name: "plate.png", mimeType: "image/png", buffer: plate });
  await page.waitForFunction(() => document.querySelector("#image-mm")?.textContent !== "");

  await check("a 200 × 100 PNG at 254 DPI reads 20 × 10 mm, with its layer and the not-saved note", async () => {
    // 10000 px/m = 10 px/mm: 200 / 10 = 20 mm, 100 / 10 = 10 mm; 25.4 × 10 = 254 DPI.
    assert.equal(await page.textContent("#image-pixels"), "200 × 100 px");
    assert.equal(await page.textContent("#image-mm"), "20 × 10 mm");
    assert.equal(await page.textContent("#image-source"), "From the file");
    assert.equal(await page.inputValue("#image-dpi"), "254");
    assert.equal(await page.inputValue("#image-mmpp"), "0.1");
    assert.equal(await page.textContent("#layer-list [data-node]"), "Layer 1");
    assert.match(await page.textContent("#image-not-saved"), /^Not saved with the project yet/);
    assert.equal(await page.textContent("#image-error"), "");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.image), "200 x 100 px, 20 x 10 mm");
  });

  await settle();
  await page.screenshot({ path: "e2e/image-open.png" });

  await check("the image is on screen the right way up: red top-left, green top-right, blue bottom-left, white bottom-right", async () => {
    near(await pixel(0.4, 0.45), RED, "top-left");
    near(await pixel(0.6, 0.45), GREEN, "top-right");
    near(await pixel(0.4, 0.55), BLUE, "bottom-left");
    near(await pixel(0.6, 0.55), WHITE, "bottom-right");
  });

  await check("it is drawn at its real proportions, framed with a 10 % margin, and the view cube is hidden", async () => {
    const s = await sheetOnScreen();
    // 20 × 10 mm is twice as wide as tall. The canvas is wider than tall but
    // less than 2:1, so the width decides: the sheet spans 1 / 1.1 of it.
    assert.ok(Math.abs(s.width / s.height - 2) < 0.03, `on screen ${s.width} × ${s.height} px, want 2:1`);
    assert.ok(Math.abs(s.width - s.canvas[0] / 1.1) <= 3, `${s.width} px wide, want ${s.canvas[0] / 1.1}`);
    assert.equal(await page.isVisible(".view-cube"), false);
  });

  await check("dragging pans instead of orbiting, and the wheel zooms", async () => {
    const box = await page.locator("#viewport canvas").boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    const before = await sheetOnScreen();
    // Drag right by a fifth of the canvas: the sheet moves right, so the pixel
    // just right of the centre line (green before) now shows the red quarter.
    near(await pixel(0.55, 0.45), GREEN, "before the drag");
    await page.mouse.move(...at(0.5, 0.5));
    await page.mouse.down();
    await page.mouse.move(...at(0.6, 0.5), { steps: 5 });
    await page.mouse.move(...at(0.7, 0.5), { steps: 5 });
    await page.mouse.up();
    await settle();
    near(await pixel(0.55, 0.45), RED, "after dragging right");
    // An orbit would have tilted the sheet and changed its shape on screen; a pan keeps it.
    const after = await sheetOnScreen();
    assert.ok(Math.abs(after.height - before.height) <= 2, `height ${before.height} → ${after.height} px`);
    // Back to the framing, then zoom in: a point outside the sheet becomes part of it.
    await page.click("[data-view=fit]");
    await settle();
    near(await pixel(0.5, 0.2), [20, 22, 26], "background above the sheet");
    await page.mouse.move(...at(0.5, 0.5));
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
    await settle();
    const zoomed = await sheetOnScreen();
    assert.ok(zoomed.height > before.height * 1.5, `zooming in grows the sheet: ${before.height} → ${zoomed.height} px`);
  });

  await check("Home and Top frame the image from above, the same as Fit", async () => {
    await page.click("[data-view=fit]");
    await settle();
    const fit = await sheetOnScreen();
    for (const view of ["home", "top", "front"]) {
      await page.click(`[data-view=${view}]`);
      await settle();
      assert.deepEqual(await sheetOnScreen(), fit, view);
    }
  });

  await check("typing 127 DPI makes it 40 × 20 mm", async () => {
    // 25.4 / 127 = 0.2 mm per pixel: 200 × 0.2 = 40, 100 × 0.2 = 20.
    await page.fill("#image-dpi", "127");
    await page.press("#image-dpi", "Enter");
    await page.waitForFunction(() => document.querySelector("#image-mm")?.textContent === "40 × 20 mm");
    assert.equal(await page.textContent("#image-source"), "Set by you");
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.image), "200 x 100 px, 40 x 20 mm");
  });

  await check("back in Design the body and its camera are as they were, with orbit and the view cube", async () => {
    await page.click("[data-workspace=design]");
    await page.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
    await settle();
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.image ?? null), null);
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.framedRadius), designRadius);
    assert.deepEqual(await pixel(0.5, 0.5), designCentre);
    assert.equal(await page.isVisible(".view-cube"), true);
  });

  await check("returning to Image shows the same image again", async () => {
    await page.click("[data-workspace=image]");
    await page.waitForFunction(() => document.querySelector("#image-mm")?.textContent === "40 × 20 mm");
    await settle();
    near(await pixel(0.4, 0.45), RED, "top-left");
  });

  await check("a file the browser can't decode, and one that is not an image, each show their message", async () => {
    await page.setInputFiles("#image-file", { name: "broken.png", mimeType: "image/png", buffer: broken });
    await page.waitForFunction(() => document.querySelector("#image-error")?.textContent !== "");
    assert.equal(await page.textContent("#image-error"), "The headers look right, but the browser could not decode the picture in this PNG file.");
    await page.setInputFiles("#image-file", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await page.waitForFunction(() => document.querySelector("#image-error")?.textContent === "This file is not a PNG or JPEG image.");
    // The image that was open stays open.
    assert.equal(await page.textContent("#image-mm"), "40 × 20 mm");
  });

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("image checks passed");
