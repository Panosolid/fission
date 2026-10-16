import { test } from "node:test";
import assert from "node:assert/strict";
import { createImageDocument, setBrightness, setDpi, setLayerVisible } from "../src/document.ts";
import { brightnessView, layerRows, parseBrightnessInput, parseSizeInput, sizeView } from "../src/panels.ts";
import { readPhysicalSize } from "../src/physical-size.ts";
import { idat, iend, ihdr, phys, png, refusal } from "./helpers.ts";

const pixels = (w: number, h: number) => ({ width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4) });
const docFrom = (bytes: Uint8Array) => {
  const size = readPhysicalSize(bytes);
  return createImageDocument("img", "test.png", pixels(size.width, size.height), size);
};

test("the size rows of a 200 × 100 PNG at 254 DPI", () => {
  // 10000 px/m = 10 px/mm: 0.1 mm per pixel, 25.4 / 0.1 = 254 DPI, 20 × 10 mm.
  const v = sizeView(docFrom(png(ihdr(200, 100), phys(10000, 10000, 1), idat(), iend())));
  assert.deepEqual(v, { pixels: "200 × 100 px", size: "20 × 10 mm", dpi: "254", mmPerPixel: "0.1", source: "From the file" });
});

test("a file with no size says the size is assumed, and why", () => {
  // 96 DPI: 25.4 / 96 = 0.26458333… mm per pixel; 200 px → 52.916666… mm, 100 px → 26.458333… mm (ten figures).
  const v = sizeView(docFrom(png(ihdr(200, 100), idat(), iend())));
  assert.equal(v.size, "52.91666667 × 26.45833333 mm");
  assert.equal(v.dpi, "96");
  assert.equal(v.mmPerPixel, "0.2645833333");
  assert.match(v.source, /^Assumed: .+, so 96 DPI is assumed\.$/);
});

test("a DPI the user sets is shown as set by them", () => {
  // 300 DPI: 25.4 / 300 = 0.0846666… mm per pixel; 200 px → 16.93333… mm.
  const doc = setDpi(docFrom(png(ihdr(200, 100), idat(), iend())), 300);
  const v = sizeView(doc);
  assert.equal(v.source, "Set by you");
  assert.equal(v.dpi, "300");
  assert.equal(v.mmPerPixel, "0.08466666667");
  assert.equal(v.size, "16.93333333 × 8.466666667 mm");
});

test("the layer rows: none with nothing open, then the one layer and whether it shows", () => {
  assert.deepEqual(layerRows(null), []);
  const doc = docFrom(png(ihdr(2, 2), idat(), iend()));
  assert.deepEqual(layerRows(doc), [{ id: "img-layer-1", name: "Layer 1", visible: true }]);
  assert.deepEqual(layerRows(setLayerVisible(doc, "img-layer-1", false))[0].visible, false);
});

test("typed sizes: positive numbers are read, anything else is refused with its own message", () => {
  assert.equal(parseSizeInput("254", "DPI"), 254);
  assert.equal(parseSizeInput(" 0.1 ", "mm per pixel"), 0.1);
  assert.equal(parseSizeInput("1e-3", "mm per pixel"), 0.001);
  for (const bad of ["", "  ", "abc", "0", "-5", "Infinity", "NaN"]) {
    const r = refusal(() => parseSizeInput(bad, "DPI"));
    assert.equal(r.code, "invalid-size", bad);
    assert.equal(r.message, `DPI must be a positive number, not ${JSON.stringify(bad)}.`);
  }
});

test("the Brightness label: a plus or minus sign, a whole percent, and 0 % with no sign", () => {
  const doc = docFrom(png(ihdr(2, 2), idat(), iend()));
  const id = doc.layers[0].id;
  assert.deepEqual(brightnessView(doc, id), { percent: 0, label: "0 %" }, "no adjustment: 0 %");
  assert.deepEqual(brightnessView(setBrightness(doc, id, 0.2), id), { percent: 20, label: "+20 %" });
  assert.deepEqual(brightnessView(setBrightness(doc, id, -0.35), id), { percent: -35, label: "\u221235 %" });
  assert.deepEqual(brightnessView(setBrightness(doc, id, 1), id), { percent: 100, label: "+100 %" });
  assert.equal(refusal(() => brightnessView(doc, "nope")).code, "invalid-input");
});

test("the slider's value: whole percents from -100 to +100, and nothing else", () => {
  // 20 % is an amount of 20 / 100 = 0.2; the ends are exactly -1 and +1.
  assert.equal(parseBrightnessInput("20"), 0.2);
  assert.equal(parseBrightnessInput("-100"), -1);
  assert.equal(parseBrightnessInput("100"), 1);
  assert.equal(parseBrightnessInput("0"), 0);
  for (const bad of ["101", "-101", "20.5", "", " ", "abc", "NaN", "Infinity"]) {
    assert.equal(refusal(() => parseBrightnessInput(bad)).code, "invalid-input", JSON.stringify(bad));
  }
});
