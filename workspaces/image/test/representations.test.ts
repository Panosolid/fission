// Image hands each layer to other workspaces as an Image (G2a): through the
// one registry, at its physical size, as a live handle, never a copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RepresentationRegistry, type ImageRep } from "@fission/core";
import { createImageDocument, setBrightness, setDpi, setLayerVisible, type ImageDocument, type Pixels } from "../src/document.ts";
import { MAX_SIZE_MM, MIN_MM_PER_PIXEL } from "../src/limits.ts";
import { readPhysicalSize } from "../src/physical-size.ts";
import { checkImageRep, imageLayerProducer, imageObjects, registerImage, type ImageLayerHandle } from "../src/representations.ts";
import { currentImageObjects, openImageFile, resetImageWorkspace } from "../src/workspace.ts";
import { imageWorkspace } from "../src/index.ts";
import { random } from "./fuzz-check.ts";
import { idat, iend, ihdr, phys, png, refusal } from "./helpers.ts";

/** Pixels from a list of grey values, one per pixel, fully opaque. */
function greys(width: number, height: number, values: number[]): Pixels {
  const rgba = new Uint8ClampedArray(width * height * 4);
  values.forEach((v, i) => rgba.set([v, v, v, 255], i * 4));
  return { width, height, rgba };
}

const file = (w: number, h: number) => png(ihdr(w, h), phys(10000, 10000, 1), idat(), iend());
const open = (pixels: Pixels) => createImageDocument("img-1", "test.png", pixels, readPhysicalSize(file(pixels.width, pixels.height)));

function registry(): RepresentationRegistry {
  const r = new RepresentationRegistry();
  registerImage(r, async () => {});
  return r;
}

/** A handle on a document held in a variable the test can change, as the workspace holds the open image. */
function holder(doc: ImageDocument | null) {
  const box = { doc };
  return { box, handles: () => imageObjects(() => box.doc) };
}

test("a layer arrives as an Image at its physical size, with its Brightness applied (worked by hand)", async () => {
  const { handles } = holder(setBrightness(open(greys(2, 1, [100, 240])), "img-1-layer-1", 0.2));
  const [layer] = handles();
  assert.equal(layer.type, "image.layer");
  const { representation, note } = await registry().deliver(layer, ["image"]);
  const rep = representation as ImageRep;
  // +20 %: the offset is round(0.2 × 255) = round(51) = 51.
  // 100 + 51 = 151; 240 + 51 = 291, clipped to 255. Alpha stays 255.
  assert.deepEqual([...rep.rgba], [151, 151, 151, 255, 255, 255, 255, 255]);
  // pHYs 10000 pixels per metre: 1000 mm / 10000 = 0.1 mm a pixel, so 2 × 1 pixels are 0.2 × 0.1 mm.
  assert.equal(rep.mmPerPixel, 0.1);
  assert.deepEqual([rep.width, rep.height], [2, 1]);
  // An image has nothing more exact to give, so nothing was lost and there is no note.
  assert.equal(note, null);
});

test("the handle is live: an edit in Image reaches the next delivery", async () => {
  const { box, handles } = holder(open(greys(1, 1, [128])));
  const [layer] = handles();
  const r = registry();
  assert.equal(((await r.deliver(layer, ["image"])).representation as ImageRep).mmPerPixel, 0.1);
  // 127 DPI: 25.4 mm / 127 = 0.2 mm a pixel.
  box.doc = setBrightness(setDpi(box.doc!, 127), "img-1-layer-1", -0.5);
  const rep = (await r.deliver(layer, ["image"])).representation as ImageRep;
  // 25.4 / 127 in doubles is 0.19999999999999998, the same division Image does, so compare to it exactly.
  assert.equal(rep.mmPerPixel, 25.4 / 127);
  assert.ok(Math.abs(rep.mmPerPixel - 0.2) < 1e-15);
  // −50 %: round(−127.5) = −127 (Math.round rounds halves up), 128 − 127 = 1.
  assert.equal(rep.rgba[0], 1);
});

test("a hidden layer still hands over its pixels; Hide is only a view inside Image", async () => {
  const { handles } = holder(setLayerVisible(open(greys(1, 1, [77])), "img-1-layer-1", false));
  const rep = (await registry().deliver(handles()[0], ["image"])).representation as ImageRep;
  assert.deepEqual([...rep.rgba], [77, 77, 77, 255]);
});

test("each delivery is a fresh copy: a receiver changing it never changes the original", async () => {
  const doc = open(greys(1, 1, [50]));
  const { handles } = holder(doc);
  const r = registry();
  const first = (await r.deliver(handles()[0], ["image"])).representation as ImageRep;
  first.rgba[0] = 200;
  assert.equal(doc.layers[0].pixels.rgba[0], 50, "the original pixels");
  assert.equal(((await r.deliver(handles()[0], ["image"])).representation as ImageRep).rgba[0], 50, "the next delivery");
});

test("a layer that is gone, or no image at all, is refused with its message", () => {
  const { box, handles } = holder(open(greys(1, 1, [0])));
  const [layer] = handles();
  box.doc = createImageDocument("img-2", "other.png", greys(1, 1, [0]), readPhysicalSize(file(1, 1)));
  assert.deepEqual(refusal(() => imageLayerProducer(layer)), { code: "invalid-input", message: 'The layer "img-1-layer-1" is no longer in the image.' });
  box.doc = null;
  assert.deepEqual(refusal(() => imageLayerProducer(layer)), { code: "invalid-input", message: "No image is open, so there is no layer to hand over." });
  assert.deepEqual(handles(), [], "no image, nothing to take");
});

test("a target that takes no images is told what an image layer can be", async () => {
  const { handles } = holder(open(greys(1, 1, [0])));
  await assert.rejects(registry().deliver(handles()[0], ["solid", "outline"]), {
    message: "a image.layer can be an image, but the target only takes an exact solid or an exact outline",
  });
});

test("checkImageRep refuses each way an Image can be broken", () => {
  const ok = (): ImageRep => ({ kind: "image", width: 2, height: 1, mmPerPixel: 0.1, rgba: new Uint8ClampedArray(8) });
  checkImageRep(ok());
  assert.deepEqual(refusal(() => checkImageRep({ ...ok(), rgba: new Uint8ClampedArray(7) })), { code: "invalid-input", message: "2 × 1 pixels need 8 bytes of RGBA, not 7." });
  assert.equal(refusal(() => checkImageRep({ ...ok(), rgba: new Uint8Array(8) as unknown as Uint8ClampedArray })).code, "invalid-input");
  assert.equal(refusal(() => checkImageRep({ ...ok(), width: 0, rgba: new Uint8ClampedArray(0) })).code, "damaged");
  assert.equal(refusal(() => checkImageRep({ ...ok(), width: 1.5 })).code, "damaged");
  assert.equal(refusal(() => checkImageRep({ ...ok(), width: 20000, rgba: new Uint8ClampedArray(80000) })).code, "too-large");
  for (const bad of [0, -0.1, Number.NaN, Infinity]) assert.equal(refusal(() => checkImageRep({ ...ok(), mmPerPixel: bad })).code, "invalid-size", String(bad));
});

test("the pixel size limits hold at 0.9× and 1.1×", () => {
  const rep = (mmPerPixel: number): ImageRep => ({ kind: "image", width: 1000, height: 1, mmPerPixel, rgba: new Uint8ClampedArray(4000) });
  // The smallest pixel is 1e-5 mm (10 nm): 1.1× passes, 0.9× is refused.
  checkImageRep(rep(MIN_MM_PER_PIXEL * 1.1));
  assert.equal(refusal(() => checkImageRep(rep(MIN_MM_PER_PIXEL * 0.9))).code, "invalid-size");
  // The widest image is 1e6 mm (1 km): 1000 pixels at 1000 mm each is exactly that; 0.9× passes, 1.1× is refused.
  checkImageRep(rep((MAX_SIZE_MM / 1000) * 0.9));
  assert.equal(refusal(() => checkImageRep(rep((MAX_SIZE_MM / 1000) * 1.1))).code, "invalid-size");
});

test("seeded: every delivered pixel matches a simple model of Brightness (seed 2026)", async () => {
  const rnd = random(2026);
  const r = registry();
  for (let n = 0; n < 200; n++) {
    const w = 1 + Math.floor(rnd() * 6), h = 1 + Math.floor(rnd() * 6);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = Math.floor(rnd() * 256);
    const amount = Math.round((rnd() * 2 - 1) * 100) / 100;
    const doc = setBrightness(createImageDocument("m", "m.png", { width: w, height: h, rgba }, readPhysicalSize(file(w, h))), "m-layer-1", amount);
    const rep = (await r.deliver(imageObjects(() => doc)[0], ["image"])).representation as ImageRep;
    // The model: each colour channel plus round(amount × 255), clipped to 0–255; alpha untouched.
    const offset = Math.round(amount * 255);
    const model = [...rgba].map((v, i) => (i % 4 === 3 ? v : Math.min(255, Math.max(0, v + offset))));
    assert.deepEqual([...rep.rgba], model, `case ${n}: ${w} × ${h} at ${amount}`);
    assert.equal(rep.mmPerPixel, 0.1);
  }
});

test("the workspace plugin registers the producer, and the open image's layers can be taken", async () => {
  resetImageWorkspace();
  const r = new RepresentationRegistry();
  imageWorkspace.registerRepresentations!(r, { call: (() => Promise.reject(new Error("no kernel"))) as never });
  assert.deepEqual(r.produces("image.layer"), ["image"]);
  assert.deepEqual(imageWorkspace.representations.produces, ["image"]);
  assert.equal(r.importerFor("png")?.workspace, "image");
  assert.deepEqual(currentImageObjects(), []);
  await openImageFile("a.png", file(3, 2), async () => greys(3, 2, [9, 9, 9, 9, 9, 9]));
  const [layer] = currentImageObjects() as ImageLayerHandle[];
  const rep = (await r.deliver(layer, ["image"])).representation as ImageRep;
  assert.deepEqual([rep.width, rep.height, rep.mmPerPixel, rep.rgba[0]], [3, 2, 0.1, 9]);
  resetImageWorkspace();
  await assert.rejects(r.deliver(layer, ["image"]), { message: "No image is open, so there is no layer to hand over." });
});
