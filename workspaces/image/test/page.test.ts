// The Image page in a real DOM (happy-dom stands in for the browser), with
// a fake viewport that records what it was asked to show and a fake decoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelection, DependencyGraph, emptyProject, historyNotBuilt, RepresentationRegistry, type ImageRep, type KernelCalls, type SharedViewport, type WorkspaceContext } from "@fission/core";
import { mountImage, openImageFile, resetImageWorkspace } from "../src/workspace.ts";
import { imageWorkspace } from "../src/index.ts";
import type { Decoder } from "../src/open.ts";
import { idat, iend, ihdr, phys, png } from "./helpers.ts";

const { Window } = await import("happy-dom");
const settle = () => new Promise((r) => setTimeout(r, 0));

interface Fake {
  ctx: WorkspaceContext;
  shown: ImageRep[];
  log: string[];
  failShow: string | null;
}

function fake(): Fake {
  const doc = new Window().document as unknown as Document;
  const el = () => doc.createElement("div") as unknown as HTMLElement;
  const f: Fake = { shown: [], log: [], failShow: null, ctx: null! };
  const viewport: SharedViewport = {
    element: el(),
    showBody() {},
    bodyFraming: () => ({ centre: [0, 0, 0], radius: 0 }),
    fit: () => (f.log.push("fit"), null),
    setView: () => null,
    fitSelection: () => null,
    setOverlay() {},
    clearOverlay() {},
    showSelection() {},
    onPick: () => {},
    showImage(rep) {
      if (rep === null) return void f.log.push("empty"); // Image's own empty view
      if (f.failShow) throw new Error(f.failShow);
      f.shown.push(rep);
      f.log.push("show");
    },
    clearImage: () => f.log.push("clear"),
  };
  f.ctx = {
    project: emptyProject(),
    projectChanged() {},
    kernel: { call: (() => Promise.reject(new Error("no kernel"))) as KernelCalls["call"] },
    selection: createSelection(),
    history: historyNotBuilt,
    graph: new DependencyGraph(),
    toolbar: el(),
    browser: el(),
    properties: el(),
    viewport,
    representations: new RepresentationRegistry(),
  };
  return f;
}

const decodeAs = (w: number, h: number): Decoder => async () => ({ width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4) });

/** Picks `bytes` in the page's file input, as the file picker would. */
async function pick(ctx: WorkspaceContext, bytes: Uint8Array, name = "plate.png") {
  const input = ctx.toolbar.querySelector("#image-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [{ name, arrayBuffer: async () => bytes.slice().buffer }] });
  input.dispatchEvent(new (ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("change"));
  for (let i = 0; i < 5; i++) await settle();
}

const text = (ctx: WorkspaceContext, id: string) => ctx.properties.querySelector(`#${id}`)!.textContent;
const hidden = (ctx: WorkspaceContext, id: string) => (ctx.properties.querySelector(`#${id}`) as HTMLElement).hidden;
// 254 DPI = 10000 px/m: 0.1 mm per pixel.
const plate = png(ihdr(200, 100), phys(10000, 10000, 1), idat(), iend());

test("with nothing open: an Open button, no layers, an invitation, and Image's own empty view (never Design's body)", () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(1, 1));
  assert.equal(f.ctx.toolbar.querySelector("#image-open")!.textContent, "Open…");
  assert.equal(f.ctx.browser.querySelector("#layers-empty")!.textContent, "No image open");
  assert.equal(hidden(f.ctx, "image-empty"), false);
  assert.equal(hidden(f.ctx, "image-size"), true);
  assert.equal(f.ctx.viewport.onPick, null, "nothing to pick in an image yet");
  assert.deepEqual(f.log, ["empty"]); // showImage(null), not clearImage, which would give back Design's body
  hide();
  assert.deepEqual(f.log, ["empty", "clear"], "hiding gives the view back");
});

test("opening a 200 × 100 PNG at 254 DPI shows it at 20 × 10 mm, lists its layer and says it is not saved", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(200, 100));
  await pick(f.ctx, plate);
  assert.equal(f.shown.length, 1);
  assert.deepEqual([f.shown[0].width, f.shown[0].height], [200, 100]);
  assert.ok(Math.abs(f.shown[0].mmPerPixel - 0.1) < 1e-12);
  assert.deepEqual(f.log.slice(-2), ["show", "fit"], "framed on the new image");
  assert.equal(f.ctx.browser.querySelector("#layer-list [data-node]")!.textContent, "Layer 1");
  assert.equal(text(f.ctx, "image-pixels"), "200 × 100 px");
  assert.equal(text(f.ctx, "image-mm"), "20 × 10 mm");
  assert.equal(text(f.ctx, "image-source"), "From the file");
  assert.equal((f.ctx.properties.querySelector("#image-dpi") as HTMLInputElement).value, "254");
  assert.equal(hidden(f.ctx, "image-not-saved"), false);
  assert.match(text(f.ctx, "image-not-saved")!, /^Not saved with the project yet/);
  assert.equal(text(f.ctx, "image-error"), "");
  hide();
});

test("typing a DPI resizes the sheet; a bad one is refused with its message and the size stays", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(200, 100));
  await pick(f.ctx, plate);
  const dpi = f.ctx.properties.querySelector("#image-dpi") as HTMLInputElement;
  const change = (el: HTMLInputElement, v: string) => {
    el.value = v;
    el.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("change"));
  };
  // 127 DPI: 25.4 / 127 = 0.2 mm per pixel, so 40 × 20 mm.
  change(dpi, "127");
  assert.equal(text(f.ctx, "image-mm"), "40 × 20 mm");
  assert.equal(text(f.ctx, "image-source"), "Set by you");
  assert.ok(Math.abs(f.shown.at(-1)!.mmPerPixel - 0.2) < 1e-12);
  change(dpi, "0");
  assert.equal(text(f.ctx, "image-error"), 'DPI must be a positive number, not "0".');
  assert.equal(text(f.ctx, "image-mm"), "40 × 20 mm");
  assert.equal(dpi.value, "127", "the input goes back to the document's size");
  // mm per pixel 0.5: 100 × 50 mm, and the message goes.
  change(f.ctx.properties.querySelector("#image-mmpp") as HTMLInputElement, "0.5");
  assert.equal(text(f.ctx, "image-mm"), "100 × 50 mm");
  assert.equal(text(f.ctx, "image-error"), "");
  hide();
});

test("a damaged file shows its message and no image", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(100, 200)); // decodes to a different size than its header
  await pick(f.ctx, plate);
  assert.equal(text(f.ctx, "image-error"), "The file's header says 200 × 100 pixels but it decoded to 100 × 200.");
  assert.equal(f.shown.length, 0);
  assert.equal(f.log.at(-1), "empty", "still Image's empty view");
  assert.equal(hidden(f.ctx, "image-size"), true);
  hide();
});

test("an image the screen's graphics can't hold shows the viewport's message instead", async () => {
  resetImageWorkspace();
  const f = fake();
  f.failShow = "This image is 200 × 100 pixels, but this screen's graphics can show at most 64 pixels along a side.";
  const hide = mountImage(f.ctx, decodeAs(200, 100));
  await pick(f.ctx, plate);
  assert.equal(text(f.ctx, "image-error"), f.failShow);
  assert.equal(f.ctx.browser.querySelector("#layers-empty")!.textContent, "No image open");
  hide();
});

test("the image is kept across a switch away and back; hiding gives the viewport back and empties every slot", async () => {
  resetImageWorkspace();
  const f = fake();
  let hide = mountImage(f.ctx, decodeAs(200, 100));
  await pick(f.ctx, plate);
  hide();
  assert.equal(f.log.at(-1), "clear");
  assert.equal(f.ctx.toolbar.childNodes.length + f.ctx.browser.childNodes.length + f.ctx.properties.childNodes.length, 0);
  hide = mountImage(f.ctx, decodeAs(200, 100));
  assert.equal(f.shown.length, 2, "shown again on return");
  assert.equal(text(f.ctx, "image-mm"), "20 × 10 mm");
  hide();
});

test("a file that finishes decoding after the page is hidden writes nothing", async () => {
  resetImageWorkspace();
  const f = fake();
  let release!: () => void;
  const slow: Decoder = (bytes, format) => new Promise((r) => (release = () => r(decodeAs(200, 100)(bytes, format))));
  const hide = mountImage(f.ctx, slow);
  const picked = pick(f.ctx, plate);
  await settle();
  hide();
  release();
  await picked;
  assert.equal(f.shown.length, 0);
  assert.equal(f.ctx.properties.childNodes.length, 0);
  // And it was not kept for next time either.
  const again = mountImage(f.ctx, decodeAs(1, 1));
  assert.equal(f.shown.length, 0);
  again();
});

// A 2 × 1 PNG decoded as 50 % grey (128) on the left and white on the right, fully opaque.
const greyPlate = png(ihdr(2, 1), idat(), iend());
const decodeGrey: Decoder = async () => ({ width: 2, height: 1, rgba: new Uint8ClampedArray([128, 128, 128, 255, 255, 255, 255, 255]) });

test("Brightness at +20 % shows 50 % grey as 179 at once, without moving the camera; back to 0 % gives the original", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeGrey);
  assert.equal(hidden(f.ctx, "image-adjust"), true, "no slider with nothing open");
  await pick(f.ctx, greyPlate);
  assert.equal(hidden(f.ctx, "image-adjust"), false);
  const slider = f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement;
  assert.deepEqual([slider.min, slider.max, slider.step, slider.value], ["-100", "100", "1", "0"]);
  assert.deepEqual(amount(f), ["0", "0 %"]);
  const fits = f.log.filter((l) => l === "fit").length;
  slider.value = "20";
  slider.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
  // +20 % is an offset of round(0.2 × 255) = 51: grey 128 + 51 = 179; white 255 + 51 clips to 255; alpha stays 255.
  assert.deepEqual([...f.shown.at(-1)!.rgba], [179, 179, 179, 255, 255, 255, 255, 255]);
  assert.deepEqual(amount(f), ["20", "+20 %"], "the box follows the slider");
  assert.equal(f.log.filter((l) => l === "fit").length, fits, "a live edit keeps the camera");
  slider.value = "0";
  slider.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
  assert.deepEqual([...f.shown.at(-1)!.rgba], [128, 128, 128, 255, 255, 255, 255, 255], "non-destructive");
  assert.deepEqual(amount(f), ["0", "0 %"]);
  hide();
});

/** The number box's value and the slider's spoken value ("+20 %"). */
const amount = (f: Fake) => [
  (f.ctx.properties.querySelector("#image-brightness-number") as HTMLInputElement).value,
  f.ctx.properties.querySelector("#image-brightness")!.getAttribute("aria-valuetext"),
];

/** Types `value` into the Brightness box and enters it (a change event, as Enter or leaving the box gives). */
function typeBrightness(f: Fake, value: string) {
  const box = f.ctx.properties.querySelector("#image-brightness-number") as HTMLInputElement;
  box.value = value;
  box.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("change"));
}

test("an exact Brightness typed in the box: 37 % shows 50 % grey as 222 and moves the slider; the camera stays", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeGrey);
  await pick(f.ctx, greyPlate);
  const box = f.ctx.properties.querySelector("#image-brightness-number") as HTMLInputElement;
  assert.deepEqual([box.type, box.min, box.max, box.step], ["number", "-100", "100", "1"], "the slider's range and step");
  const fits = f.log.filter((l) => l === "fit").length;
  typeBrightness(f, "37");
  // +37 % is an offset of round(0.37 × 255) = round(94.35) = 94: grey 128 + 94 = 222; white clips at 255.
  assert.deepEqual([...f.shown.at(-1)!.rgba], [222, 222, 222, 255, 255, 255, 255, 255]);
  assert.equal((f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement).value, "37", "the slider follows the box");
  assert.deepEqual(amount(f), ["37", "+37 %"]);
  assert.equal(text(f.ctx, "image-error"), "");
  assert.equal(f.log.filter((l) => l === "fit").length, fits, "an exact edit keeps the camera");
  // The ends are allowed: −100 % is an offset of −255, so 128 − 255 clips to 0; +100 % clips to 255.
  typeBrightness(f, "-100");
  assert.deepEqual([...f.shown.at(-1)!.rgba], [0, 0, 0, 255, 0, 0, 0, 255]);
  typeBrightness(f, "100");
  assert.deepEqual([...f.shown.at(-1)!.rgba], [255, 255, 255, 255, 255, 255, 255, 255]);
  assert.equal(text(f.ctx, "image-error"), "");
  hide();
});

test("a typed Brightness outside -100…+100, not whole, or empty is refused with the slider's message; both go back to the image's value", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeGrey);
  await pick(f.ctx, greyPlate);
  typeBrightness(f, "20");
  for (const bad of ["101", "-101", "150", "12.5", ""]) {
    typeBrightness(f, bad);
    assert.equal(text(f.ctx, "image-error"), `Brightness must be a whole percent from -100 to +100, not ${JSON.stringify(bad)}.`, bad);
    assert.deepEqual(amount(f), ["20", "+20 %"], `after ${JSON.stringify(bad)} the box and slider show the image's value`);
    assert.equal((f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement).value, "20");
    assert.deepEqual([...f.shown.at(-1)!.rgba], [179, 179, 179, 255, 255, 255, 255, 255], "the image stays at +20 %");
  }
  // A good value afterwards clears the message.
  typeBrightness(f, "0");
  assert.equal(text(f.ctx, "image-error"), "");
  assert.deepEqual([...f.shown.at(-1)!.rgba], [128, 128, 128, 255, 255, 255, 255, 255]);
  hide();
});

test("a slider value outside -100…+100 is refused with its message and the image stays as it was", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeGrey);
  await pick(f.ctx, greyPlate);
  const slider = f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement;
  // A range input clamps what is typed into it, so the bad value is forced past it, as a script could.
  Object.defineProperty(slider, "value", { configurable: true, get: () => "150", set() {} });
  slider.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
  assert.equal(text(f.ctx, "image-error"), 'Brightness must be a whole percent from -100 to +100, not "150".');
  assert.deepEqual([...f.shown.at(-1)!.rgba], [128, 128, 128, 255, 255, 255, 255, 255]);
  hide();
});

test("Hide on the layer shows nothing (fully transparent) and Show brings it back with its brightness; the camera stays", async () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeGrey);
  await pick(f.ctx, greyPlate);
  const win = f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis;
  const slider = f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement;
  slider.value = "20";
  slider.dispatchEvent(new win.Event("input"));
  const fits = f.log.filter((l) => l === "fit").length;
  const eye = () => f.ctx.browser.querySelector("#layer-list .layer-visibility") as HTMLButtonElement;
  assert.deepEqual([eye().textContent, eye().getAttribute("aria-label"), eye().getAttribute("aria-pressed")], ["Hide", "Hide Layer 1", "false"]);
  eye().click();
  assert.deepEqual([...f.shown.at(-1)!.rgba], [0, 0, 0, 0, 0, 0, 0, 0], "hidden: every pixel transparent");
  assert.deepEqual([eye().textContent, eye().getAttribute("aria-label"), eye().getAttribute("aria-pressed")], ["Show", "Show Layer 1", "true"]);
  assert.equal(f.ctx.browser.querySelector("#layer-list li")!.className, "layer-hidden");
  assert.deepEqual(amount(f), ["20", "+20 %"], "hiding keeps the brightness");
  eye().click();
  assert.deepEqual([...f.shown.at(-1)!.rgba], [179, 179, 179, 255, 255, 255, 255, 255]);
  assert.equal(f.log.filter((l) => l === "fit").length, fits, "neither toggle moves the camera");
  hide();
});

test("brightness and visibility are kept across a switch away and back", async () => {
  resetImageWorkspace();
  const f = fake();
  let hide = mountImage(f.ctx, decodeGrey);
  await pick(f.ctx, greyPlate);
  const slider = f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement;
  slider.value = "-30";
  slider.dispatchEvent(new (f.ctx.toolbar.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
  (f.ctx.browser.querySelector("#layer-list .layer-visibility") as HTMLButtonElement).click();
  hide();
  hide = mountImage(f.ctx, decodeGrey);
  assert.equal((f.ctx.properties.querySelector("#image-brightness") as HTMLInputElement).value, "-30");
  assert.deepEqual(amount(f), ["-30", "\u221230 %"]);
  assert.equal((f.ctx.browser.querySelector("#layer-list .layer-visibility") as HTMLButtonElement).textContent, "Show");
  assert.deepEqual([...f.shown.at(-1)!.rgba], [0, 0, 0, 0, 0, 0, 0, 0]);
  hide();
});

// X6: a PNG or JPEG dropped or pasted anywhere comes here through the importer the workspace registers.
test("a dropped file opens through the importer: the page shows it once mounted; a damaged one shows its message", async () => {
  const registry = new RepresentationRegistry();
  imageWorkspace.registerRepresentations!(registry, fake().ctx.kernel);
  const importer = registry.importerFor("png");
  assert.ok(importer && importer === registry.importerFor("jpeg"));
  assert.equal(importer.workspace, "image");
  resetImageWorkspace();
  await openImageFile("plate.png", plate, decodeAs(200, 100));
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(1, 1));
  assert.equal(f.shown.length, 1);
  assert.equal(text(f.ctx, "image-mm"), "20 × 10 mm"); // 200 × 100 px at 0.1 mm per pixel
  hide();
  // The same file decoding to the wrong size is refused and the page says why; the image already open stays, as with Open.
  await openImageFile("plate.png", plate, decodeAs(100, 200));
  const g = fake();
  const hide2 = mountImage(g.ctx, decodeAs(1, 1));
  assert.equal(text(g.ctx, "image-error"), "The file's header says 200 × 100 pixels but it decoded to 100 × 200.");
  assert.equal(g.shown.length, 1);
  hide2();
});
