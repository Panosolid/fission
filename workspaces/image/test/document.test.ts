import { test } from "node:test";
import assert from "node:assert/strict";
import { composite, createImageDocument, physicalSize, setBrightness, setDpi, setLayerVisible, setMmPerPixel, toImageRep, type Pixels } from "../src/document.ts";
import { readPhysicalSize } from "../src/physical-size.ts";
import { idat, iend, ihdr, phys, png, refusal } from "./helpers.ts";

function grey(width: number, height: number, value: number): Pixels {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([value, value, value, 255], i);
  return { width, height, rgba };
}

const open = (pixels: Pixels, pixelsPerMetre = 10000) =>
  createImageDocument("img-1", "test.png", pixels, readPhysicalSize(png(ihdr(pixels.width, pixels.height), phys(pixelsPerMetre, pixelsPerMetre, 1), idat(), iend())));

test("a new document is one visible layer at the file's size", () => {
  const doc = open(grey(200, 100, 128));
  assert.equal(doc.layers.length, 1);
  assert.equal(doc.layers[0].visible, true);
  assert.equal(doc.sizeSource, "file");
  // 10000 pixels per metre: 0.1 mm a pixel, so 200 × 100 pixels are 20 × 10 mm.
  assert.deepEqual(physicalSize(doc), { widthMm: 20, heightMm: 10 });
});

test("the user can set the size, by DPI or mm per pixel", () => {
  const doc = open(grey(200, 100, 128));
  // 127 DPI: 25.4 / 127 = 0.2 mm a pixel, so 200 pixels are 40 mm.
  const byDpi = setDpi(doc, 127);
  assert.equal(physicalSize(byDpi).widthMm, 40);
  assert.equal(byDpi.sizeSource, "user");
  assert.equal(byDpi.sizeNote, null);
  assert.equal(physicalSize(setMmPerPixel(doc, 0.5)).heightMm, 50);
  assert.equal(doc.mmPerPixel, 0.1, "the old document is unchanged");
  assert.equal(refusal(() => setDpi(doc, 0)).message, "DPI must be a positive number, not 0.");
  assert.equal(refusal(() => setMmPerPixel(doc, 1e7)).code, "invalid-size");
});

test("a decoded image that disagrees with its header is refused", () => {
  const size = readPhysicalSize(png(ihdr(4, 4), iend()));
  assert.deepEqual(refusal(() => createImageDocument("a", "a", grey(4, 3, 0), size)), { code: "damaged", message: "The file's header says 4 × 4 pixels but it decoded to 4 × 3." });
  assert.match(refusal(() => createImageDocument("a", "a", { width: 4, height: 4, rgba: new Uint8ClampedArray(60) }, size)).message, /need 64 bytes of RGBA, not 60/);
});

test("brightness is non-destructive: the original pixels never change, and 0 % gives them back exactly", () => {
  const doc = open(grey(3, 2, 128));
  const id = doc.layers[0].id;
  const brighter = setBrightness(doc, id, 0.2);
  // 128 + round(0.2 × 255) = 128 + 51 = 179.
  assert.deepEqual([...composite(brighter).rgba.slice(0, 4)], [179, 179, 179, 255]);
  assert.deepEqual([...brighter.layers[0].pixels.rgba.slice(0, 4)], [128, 128, 128, 255], "original kept");
  // Even after clipping at +100 %, going back to 0 restores every value.
  const back = setBrightness(setBrightness(brighter, id, 1), id, 0);
  assert.deepEqual(back.layers[0].adjustments, []);
  assert.deepEqual(composite(back).rgba, grey(3, 2, 128).rgba);
  // Setting it twice replaces it, never stacks.
  assert.deepEqual(setBrightness(brighter, id, -0.1).layers[0].adjustments, [{ type: "brightness", amount: -0.1 }]);
  assert.equal(refusal(() => setBrightness(doc, "nope", 0.1)).message, 'There is no layer "nope".');
  assert.equal(refusal(() => setBrightness(doc, id, 2)).code, "invalid-input");
});

test("a hidden layer shows nothing (fully transparent)", () => {
  const doc = open(grey(2, 2, 200));
  const hidden = setLayerVisible(doc, doc.layers[0].id, false);
  assert.ok(composite(hidden).rgba.every((v) => v === 0));
  assert.deepEqual(composite(setLayerVisible(hidden, doc.layers[0].id, true)).rgba, grey(2, 2, 200).rgba);
});

test("Image hands other workspaces the shown pixels with their physical size", () => {
  const doc = setBrightness(open(grey(2, 1, 100)), "img-1-layer-1", 0.2);
  const rep = toImageRep(doc);
  assert.equal(rep.kind, "image");
  assert.equal(rep.mmPerPixel, 0.1);
  assert.deepEqual([rep.width, rep.height], [2, 1]);
  assert.deepEqual([...rep.rgba], [151, 151, 151, 255, 151, 151, 151, 255]); // 100 + 51
});
