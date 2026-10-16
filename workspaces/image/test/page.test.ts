// The Image page in a real DOM (happy-dom stands in for the browser), with
// a fake viewport that records what it was asked to show and a fake decoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSelection, DependencyGraph, emptyProject, historyNotBuilt, RepresentationRegistry, type ImageRep, type KernelCalls, type SharedViewport, type WorkspaceContext } from "@fission/core";
import { mountImage, resetImageWorkspace } from "../src/workspace.ts";
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

test("with nothing open: an Open button, no layers, an invitation, and no image in the viewport", () => {
  resetImageWorkspace();
  const f = fake();
  const hide = mountImage(f.ctx, decodeAs(1, 1));
  assert.equal(f.ctx.toolbar.querySelector("#image-open")!.textContent, "Open…");
  assert.equal(f.ctx.browser.querySelector("#layers-empty")!.textContent, "No image open");
  assert.equal(hidden(f.ctx, "image-empty"), false);
  assert.equal(hidden(f.ctx, "image-size"), true);
  assert.equal(f.ctx.viewport.onPick, null, "nothing to pick in an image yet");
  assert.deepEqual(f.log, ["clear"]);
  hide();
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
