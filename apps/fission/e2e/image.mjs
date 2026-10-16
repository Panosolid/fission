// Browser check of the Image workspace (G1b, G1c, G1d): opening a PNG shows it at
// its real size in the shared viewport, seen from above, with pan and zoom
// and no orbit; switching back to Design gives back the body and its camera;
// Brightness changes the colours on screen at once and Hide shows nothing;
// at 1280 and 375 px it fits, focus goes in reading order, and a too-large
// or damaged file shows its message.
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
/** The viewport's background, 0x14161a (packages/viewport/src/viewer.ts). */
const BACKGROUND = [20, 22, 26];
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

  // Only the header is read before refusing, so a PNG that is just an IHDR
  // saying 20000 × 10 is enough: 20000 > 16384 pixels along a side.
  const headerOnly = (w, h) => {
    const full = makePng(1, 1, () => [0, 0, 0, 255], null);
    const ihdr = Buffer.from(full.subarray(8, 8 + 25));
    ihdr.writeUInt32BE(w, 8);
    ihdr.writeUInt32BE(h, 12);
    ihdr.writeUInt32BE(crc32(ihdr.subarray(4, 21)), 21);
    return Buffer.concat([full.subarray(0, 8), ihdr, full.subarray(full.length - 12)]);
  };

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

/** The grey sheet's extent on screen: pixels clearly lighter than the background (20, 22, 26), along the middle row and column. */
const sheetOnScreenGrey = () =>
  page.evaluate(() => {
    const src = document.querySelector("#viewport canvas");
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const isSheet = (x, y) => d[4 * (y * c.width + x)] > 60;
    const cy = Math.floor(c.height / 2);
    const cx = Math.floor(c.width / 2);
    const xs = [...Array(c.width).keys()].filter((x) => isSheet(x, cy));
    const ys = [...Array(c.height).keys()].filter((y) => isSheet(cx, y));
    return { left: xs[0], right: xs.at(-1), top: ys[0], bottom: ys.at(-1) };
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
    // Image's own empty 2D view: no body, grid or view cube from Design.
    await settle();
    assert.ok(designCentre.some((c, i) => Math.abs(c - BACKGROUND[i]) > 20), `the body's centre ${designCentre} should differ from the background`);
    near(await pixel(0.5, 0.5), BACKGROUND, "the empty view's centre (Design's body was there)");
    assert.equal(await page.isVisible(".view-cube"), false);
    assert.equal(await page.$eval("#viewport", (el) => el.dataset.image ?? null), "none");
    await page.screenshot({ path: "e2e/image-empty.png" });
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

  // A plain 50 % grey image (128, 128, 128), 200 × 100 at 254 DPI.
  const grey = makePng(200, 100, () => [128, 128, 128, 255], 10000);
  await page.setInputFiles("#image-file", { name: "grey.png", mimeType: "image/png", buffer: grey });
  await page.waitForFunction(() => document.querySelector("#image-mm")?.textContent === "20 × 10 mm");
  await settle();

  await check("50 % grey shows as 128 grey, and Brightness +20 % shows it as 179 at once, the camera unmoved", async () => {
    near(await pixel(0.5, 0.5), [128, 128, 128], "before");
    const before = await sheetOnScreenGrey();
    await page.$eval("#image-brightness", (el) => {
      el.value = "20";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.inputValue("#image-brightness-number"), "20", "the box follows the slider");
    await page.waitForTimeout(100);
    // +20 % is an offset of round(0.2 × 255) = 51 on each channel: 128 + 51 = 179.
    near(await pixel(0.5, 0.5), [179, 179, 179], "at +20 %");
    assert.deepEqual(await sheetOnScreenGrey(), before, "the sheet did not move or change size");
  });

  await check("the slider moves by keyboard too: Home goes to −100 % (black), End to +100 % (white)", async () => {
    await page.focus("#image-brightness");
    await page.keyboard.press("Home");
    assert.equal(await page.inputValue("#image-brightness-number"), "-100");
    await page.waitForTimeout(100);
    near(await pixel(0.5, 0.5), [0, 0, 0], "at -100 %");
    await page.keyboard.press("End");
    assert.equal(await page.inputValue("#image-brightness-number"), "100");
    await page.waitForTimeout(100);
    near(await pixel(0.5, 0.5), [255, 255, 255], "at +100 %");
    await page.$eval("#image-brightness", (el) => {
      el.value = "20";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });

  await check("an exact Brightness typed in the box: 37 then Enter shows 222 grey and moves the slider; 150 is refused and both go back", async () => {
    await page.fill("#image-brightness-number", "37");
    await page.press("#image-brightness-number", "Enter");
    await page.waitForTimeout(100);
    // +37 % is an offset of round(0.37 × 255) = round(94.35) = 94: 128 + 94 = 222.
    near(await pixel(0.5, 0.5), [222, 222, 222], "at +37 %");
    assert.equal(await page.inputValue("#image-brightness"), "37", "the slider follows the box");
    assert.equal(await page.textContent("#image-error"), "");
    await page.fill("#image-brightness-number", "150");
    await page.press("#image-brightness-number", "Enter");
    await page.waitForFunction(() => document.querySelector("#image-error").textContent !== "");
    assert.equal(await page.textContent("#image-error"), 'Brightness must be a whole percent from -100 to +100, not "150".');
    assert.equal(await page.inputValue("#image-brightness-number"), "37");
    assert.equal(await page.inputValue("#image-brightness"), "37");
    near(await pixel(0.5, 0.5), [222, 222, 222], "unchanged after 150");
    await page.$eval("#image-brightness", (el) => {
      el.value = "20";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    assert.equal(await page.textContent("#image-error"), "");
  });

  await page.screenshot({ path: "e2e/image-brightness.png" });

  await check("Hide on the layer shows the empty viewport's dark background; Show brings it back at +20 %", async () => {
    await page.click("#layer-list .layer-visibility");
    await page.waitForTimeout(100);
    assert.equal(await page.textContent("#layer-list .layer-visibility"), "Show");
    // The hidden layer's row is dimmed (styles/image.css reaches the page).
    assert.equal(await page.$eval("#layer-list .layer-hidden .tree-row", (el) => getComputedStyle(el).opacity), "0.5");
    near(await pixel(0.5, 0.5), [20, 22, 26], "hidden");
    await page.click("#layer-list .layer-visibility");
    await page.waitForTimeout(100);
    assert.equal(await page.textContent("#layer-list .layer-visibility"), "Hide");
    near(await pixel(0.5, 0.5), [179, 179, 179], "shown again");
  });

  await check("a file too large to open, and one with a damaged header, each show their message", async () => {
    await page.setInputFiles("#image-file", { name: "wide.png", mimeType: "image/png", buffer: headerOnly(20000, 10) });
    await page.waitForFunction(() => document.querySelector("#image-error")?.textContent !== "");
    assert.equal(await page.textContent("#image-error"), "20000 × 10 pixels is too large: at most 16384 pixels along a side.");
    // 9000 × 9000 = 81 megapixels, over 8192² = 67.1 megapixels, though each side is under 16384.
    await page.setInputFiles("#image-file", { name: "big.png", mimeType: "image/png", buffer: headerOnly(9000, 9000) });
    await page.waitForFunction(() => document.querySelector("#image-error")?.textContent.startsWith("9000"));
    assert.equal(await page.textContent("#image-error"), "9000 × 9000 pixels (81.0 megapixels) is too large: at most 67.1 megapixels.");
    // One byte of the IHDR changed after its CRC was written: the CRC check refuses it.
    const flipped = makePng(200, 100, quarters, 10000);
    flipped[20] ^= 1;
    await page.setInputFiles("#image-file", { name: "flipped.png", mimeType: "image/png", buffer: flipped });
    await page.waitForFunction(() => /damaged|CRC/i.test(document.querySelector("#image-error")?.textContent ?? ""));
    // The grey image that was open stays open.
    assert.equal(await page.textContent("#image-mm"), "20 × 10 mm");
  });

  /** A fresh page at a given size with the four-quarter plate open in Image. */
  const withPlate = async (options) => {
    const p = await browser.newPage(options);
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(url + "#image");
    await p.waitForSelector("#image-open");
    await p.setInputFiles("#image-file", { name: "plate.png", mimeType: "image/png", buffer: plate });
    await p.waitForFunction(() => document.querySelector("#image-mm")?.textContent === "20 × 10 mm");
    await p.waitForTimeout(400);
    return p;
  };
  /** Tabs from the top bar; gives the regions in the order focus visits them, and each stop's control. */
  const focusOrder = async (p, last) => {
    // Start from the top bar's first control, wherever focus was before (a tap leaves it in the browser).
    await p.focus("#topbar button");
    const regions = ["topbar"];
    const stops = [];
    for (let i = 0; i < 120 && !(regions.at(-1) === "properties" && stops.at(-1) === last); i++) {
      await p.keyboard.press("Tab");
      const stop = await p.evaluate(() => {
        const el = document.activeElement;
        return { region: el?.closest("#topbar, #toolbar, #panel-toggles, #browser, #view-controls, #split-toggle, #properties")?.id ?? "other", id: el?.id || el?.className || el?.tagName };
      });
      stops.push(stop.id);
      if (stop.region !== regions.at(-1)) regions.push(stop.region);
    }
    return { regions, stops };
  };
  /** Elements wider than their box: anything here means a sideways scroll. */
  const overflow = (p) =>
    p.evaluate(() =>
      ["html", "body", "#topbar", "#workspace", "#panel-toggles", "#browser", "#properties", "#image-size", "#image-size-inputs", "#image-adjust"]
        .map((s) => document.querySelector(s))
        .filter((el) => el && el.scrollWidth > el.clientWidth)
        .map((el) => `${el.id || el.tagName}: ${el.scrollWidth} > ${el.clientWidth}`),
    );

  await check("1280 px: focus moves top bar, toolbar (Open), browser (Hide), View buttons, Split, properties (DPI, mm per pixel, Brightness box, slider)", async () => {
    const p = await withPlate({ viewport: { width: 1280, height: 800 } });
    try {
      assert.deepEqual(await overflow(p), []);
      const { regions, stops } = await focusOrder(p, "image-brightness");
      assert.deepEqual(regions, ["topbar", "toolbar", "browser", "view-controls", "split-toggle", "properties"]);
      assert.ok(stops.includes("image-open"), `Open is reachable: ${stops}`);
      assert.ok(stops.includes("layer-visibility"), `Hide is reachable: ${stops}`);
      const props = stops.slice(stops.indexOf("image-dpi"));
      assert.deepEqual(props, ["image-dpi", "image-mmpp", "image-brightness-number", "image-brightness"]);
      await p.screenshot({ path: "e2e/image-1280.png" });
    } finally {
      await p.close();
    }
  });

  await check("375 px: no sideways scroll; the sheet, size, DPI and Brightness fit; the layer folds behind Browser; focus goes down the column", async () => {
    const p = await withPlate({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
    try {
      assert.deepEqual(await overflow(p), []);
      const rect = (sel) => p.$eval(sel, (el) => el.getBoundingClientRect().toJSON());
      // Every properties control lies inside the 375 px screen.
      for (const sel of ["#image-dpi", "#image-mmpp", "#image-brightness", "#image-brightness-number", "#image-not-saved"]) {
        const r = await rect(sel);
        assert.ok(r.left >= 0 && r.right <= 375, `${sel} spans ${r.left}..${r.right}`);
      }
      // The slider keeps a usable width: at least half the screen.
      assert.ok((await rect("#image-brightness")).width >= 375 / 2, "Brightness slider too narrow");
      // The sheet is framed in the narrow viewport: 2:1, width-limited, 1 / 1.1 of it.
      const vp = await rect("#viewport");
      assert.equal(vp.width, 375);
      // The four quarters land the right way up in the phone's viewport too.
      const at = (fx, fy) =>
        p.evaluate(
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
      near(await at(0.4, 0.48), RED, "top-left");
      near(await at(0.6, 0.48), GREEN, "top-right");
      near(await at(0.4, 0.52), BLUE, "bottom-left");
      near(await at(0.6, 0.52), WHITE, "bottom-right");
      await p.screenshot({ path: "e2e/image-375.png" });
      await p.$eval("#workspace", (el) => el.scrollTo(0, el.scrollHeight));
      await p.screenshot({ path: "e2e/image-375-scrolled.png" });
      // The layer row is behind the Browser toggle, closed at first.
      assert.equal(await p.isVisible("#layer-list"), false);
      await p.click("#browser-toggle");
      assert.equal(await p.isVisible("#layer-list .layer-visibility"), true);
      assert.deepEqual(await overflow(p), []);
      await p.$eval("#workspace", (el) => el.scrollTo(0, 0));
      await p.screenshot({ path: "e2e/image-375-browser.png" });
      // A long refusal wraps inside the screen.
      await p.setInputFiles("#image-file", { name: "wide.png", mimeType: "image/png", buffer: headerOnly(20000, 10) });
      await p.waitForFunction(() => document.querySelector("#image-error")?.textContent !== "");
      assert.deepEqual(await overflow(p), []);
      const err = await rect("#image-error");
      assert.ok(err.left >= 0 && err.right <= 375, `the message spans ${err.left}..${err.right}`);
      await p.$eval("#image-error", (el) => el.scrollIntoView());
      await p.screenshot({ path: "e2e/image-375-error.png" });
      // Tap Hide works at phone width.
      await p.tap("#layer-list .layer-visibility");
      assert.equal(await p.textContent("#layer-list .layer-visibility"), "Show");
      await p.tap("#layer-list .layer-visibility");
      // Focus from the top follows the column as drawn.
      await p.$eval("#workspace", (el) => el.scrollTo(0, 0));
      const { regions } = await focusOrder(p, "image-brightness");
      assert.deepEqual(regions, ["topbar", "toolbar", "panel-toggles", "browser", "view-controls", "properties"]);
    } finally {
      await p.close();
    }
  });

  await check("split view: Image beside Design shows its empty view, then the image, in its own pane while Design's pane keeps the body", async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    p.on("pageerror", (e) => errors.push(e.message));
    try {
      await p.goto(url + "#design");
      await p.waitForFunction(() => document.querySelector("#volume")?.textContent === "24,000 mm³");
      await p.waitForTimeout(400);
      const at = (sel, fx, fy) =>
        p.evaluate(
          ([sel, fx, fy]) => {
            const src = document.querySelector(`${sel} > canvas`);
            const c = document.createElement("canvas");
            c.width = src.width;
            c.height = src.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(src, 0, 0);
            return Array.from(ctx.getImageData(Math.floor(src.width * fx), Math.floor(src.height * fy), 1, 1).data.slice(0, 3));
          },
          [sel, fx, fy],
        );
      const isBody = ([r, g, b]) => r + g + b > 3 * 80; // the lit body, far brighter than the background
      await p.click("#split-toggle");
      await p.selectOption("#split-choice", "image");
      await p.waitForSelector("#split-toolbar #image-open");
      // Image's pane with nothing open is its own empty view; Design's pane keeps the body.
      await p.waitForTimeout(400);
      near(await at("#split-viewport", 0.5, 0.5), BACKGROUND, "the empty Image pane's centre");
      assert.equal(await p.isVisible("#split-viewport .view-cube"), false);
      assert.equal(await p.$eval("#split-viewport", (el) => el.dataset.image), "none");
      assert.ok(isBody(await at("#viewport", 0.5, 0.5)), "Design's pane lost the body to an empty Image pane");
      assert.equal(await p.isVisible("#viewport .view-cube"), true);
      await p.setInputFiles("#split-toolbar #image-file", { name: "plate.png", mimeType: "image/png", buffer: plate });
      await p.waitForFunction(() => document.querySelector("#split-properties #image-mm")?.textContent === "20 × 10 mm");
      await p.waitForTimeout(400);
      assert.equal(await p.$eval("#split-viewport", (el) => el.dataset.image), "200 x 100 px, 20 x 10 mm");
      assert.equal(await p.$eval("#viewport", (el) => el.dataset.image ?? null), null);
      // The image pane: the four quarters, the right way up, framed top-down.
      near(await at("#split-viewport", 0.4, 0.48), RED, "split top-left");
      near(await at("#split-viewport", 0.6, 0.52), WHITE, "split bottom-right");
      // Design's pane: the body still at its centre, with its view cube; no image there.
      assert.ok(isBody(await at("#viewport", 0.5, 0.5)), "Design's pane lost the body");
      assert.equal(await p.isVisible("#viewport .view-cube"), true);
      assert.equal(await p.isVisible("#split-viewport .view-cube"), false);
      await p.screenshot({ path: "e2e/image-split.png" });
      // Choosing another workspace for the pane takes the image away; Design is untouched.
      await p.selectOption("#split-choice", "render");
      await p.waitForFunction(() => document.querySelector("#split-viewport")?.dataset.image === undefined);
      assert.ok(isBody(await at("#viewport", 0.5, 0.5)), "Design's pane after the image went");
    } finally {
      await p.close();
    }
  });

  await check("no page errors", async () => assert.deepEqual(errors, []));
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
if (failed) process.exit(1);
console.log("image checks passed");
