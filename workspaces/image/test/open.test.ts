import { test } from "node:test";
import assert from "node:assert/strict";
import { openImage, type Decoder } from "../src/open.ts";
import { physicalSize, type Pixels } from "../src/document.ts";
import { idat, iend, ihdr, phys, png, refusal } from "./helpers.ts";

/** A decoder that returns blank pixels of the given size and counts its calls. */
function fakeDecoder(width: number, height: number) {
  const calls: string[] = [];
  const decode: Decoder = async (_bytes, format) => {
    calls.push(format);
    return { width, height, rgba: new Uint8ClampedArray(width * height * 4) } satisfies Pixels;
  };
  return { decode, calls };
}

/** Like `refusal`, for a promise. */
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return refusal(() => {
      throw e;
    });
  }
  throw new Error("expected an ImageError, but the promise resolved");
}

// 254 DPI = 10000 pixels per metre (pHYs unit 1) = 10 px per mm, so one pixel is 0.1 mm.
const file200x100 = png(ihdr(200, 100), phys(10000, 10000, 1), idat(), iend());

test("a 200 × 100 PNG at 254 DPI opens as one layer, 20 × 10 mm", async () => {
  const { decode, calls } = fakeDecoder(200, 100);
  const doc = await openImage(file200x100, "plate.png", decode);
  // 200 px × 0.1 mm = 20 mm wide; 100 px × 0.1 mm = 10 mm tall.
  const { widthMm, heightMm } = physicalSize(doc);
  assert.ok(Math.abs(widthMm - 20) < 1e-12 && Math.abs(heightMm - 10) < 1e-12, `${widthMm} × ${heightMm}`);
  assert.equal(doc.name, "plate.png");
  assert.equal(doc.sizeSource, "file");
  assert.equal(doc.layers.length, 1);
  assert.deepEqual(calls, ["png"]);
});

test("each opened image gets its own id", async () => {
  const a = await openImage(file200x100, "a.png", fakeDecoder(200, 100).decode);
  const b = await openImage(file200x100, "b.png", fakeDecoder(200, 100).decode);
  assert.notEqual(a.id, b.id);
});

test("pixels that decode to a different size than the header says are refused", async () => {
  const r = await refused(openImage(file200x100, "x.png", fakeDecoder(100, 200).decode));
  assert.equal(r.code, "damaged");
  assert.equal(r.message, "The file's header says 200 × 100 pixels but it decoded to 100 × 200.");
});

test("a file too large for the limits is refused before anything decodes it", async () => {
  const { decode, calls } = fakeDecoder(16385, 1);
  const r = await refused(openImage(png(ihdr(16385, 1), idat(), iend()), "wide.png", decode));
  assert.equal(r.code, "too-large");
  assert.deepEqual(calls, [], "the decoder was never called");
  // The largest side that is allowed still opens.
  const ok = fakeDecoder(16384, 1);
  await openImage(png(ihdr(16384, 1), idat(), iend()), "edge.png", ok.decode);
  assert.deepEqual(ok.calls, ["png"]);
});

test("a file that is not an image is refused before anything decodes it", async () => {
  const { decode, calls } = fakeDecoder(1, 1);
  const r = await refused(openImage(new TextEncoder().encode("hello"), "notes.txt", decode));
  assert.equal(r.code, "not-an-image");
  assert.deepEqual(calls, []);
});

test("the browser failing to decode good-looking headers is reported as damaged, with the format", async () => {
  const decode: Decoder = async () => {
    throw new DOMException("The source image could not be decoded.", "InvalidStateError");
  };
  const r = await refused(openImage(file200x100, "x.png", decode));
  assert.equal(r.code, "damaged");
  assert.equal(r.message, "The headers look right, but the browser could not decode the picture in this PNG file.");
});
