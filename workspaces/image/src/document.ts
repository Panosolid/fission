// One image document: its pixels, its physical size and its layers (one
// for now). Edits return a new document and never change the old one or
// the original pixels, so undo (step 20) can keep snapshots and links can
// always rebuild from the original. Not saved with the project yet: images
// join the project file at roadmap G3.

import type { ImageRep } from "@fission/core";
import { type Adjustment, applyAdjustments, checkAdjustment } from "./adjust.ts";
import { ImageError } from "./errors.ts";
import { checkMmPerPixel, checkPixelSize } from "./limits.ts";
import { dpiToMmPerPixel, type PhysicalSize } from "./physical-size.ts";

/** Decoded pixels: RGBA, 8 bits per channel, not premultiplied, row by row from the top. */
export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface ImageLayer {
  id: string;
  name: string;
  visible: boolean;
  /** The original pixels, never changed. */
  pixels: Pixels;
  /** Applied in order whenever the layer is shown. */
  adjustments: readonly Adjustment[];
}

export interface ImageDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Physical size of one (square) pixel. */
  mmPerPixel: number;
  /** Where the size came from: the file, an assumption, or the user. */
  sizeSource: "file" | "assumed" | "user";
  /** Why the size was assumed; null otherwise. */
  sizeNote: string | null;
  layers: readonly ImageLayer[];
}

function checkPixels(pixels: Pixels): void {
  checkPixelSize(pixels.width, pixels.height);
  if (pixels.rgba.length !== pixels.width * pixels.height * 4) {
    throw new ImageError("invalid-input", `${pixels.width} × ${pixels.height} pixels need ${pixels.width * pixels.height * 4} bytes of RGBA, not ${pixels.rgba.length}.`);
  }
}

/** A new document of one visible layer, from decoded pixels and the size read from the file's header. */
export function createImageDocument(id: string, name: string, pixels: Pixels, size: PhysicalSize): ImageDocument {
  checkPixels(pixels);
  if (pixels.width !== size.width || pixels.height !== size.height) {
    throw new ImageError("damaged", `The file's header says ${size.width} × ${size.height} pixels but it decoded to ${pixels.width} × ${pixels.height}.`);
  }
  checkMmPerPixel(size.mmPerPixel, pixels.width, pixels.height);
  const layer: ImageLayer = { id: `${id}-layer-1`, name: "Layer 1", visible: true, pixels, adjustments: [] };
  return { id, name, width: pixels.width, height: pixels.height, mmPerPixel: size.mmPerPixel, sizeSource: size.source, sizeNote: size.note, layers: [layer] };
}

/** The user sets the size of one pixel. */
export function setMmPerPixel(doc: ImageDocument, mmPerPixel: number): ImageDocument {
  checkMmPerPixel(mmPerPixel, doc.width, doc.height);
  return { ...doc, mmPerPixel, sizeSource: "user", sizeNote: null };
}

/** The user sets the density in dots per inch. */
export function setDpi(doc: ImageDocument, dpi: number): ImageDocument {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new ImageError("invalid-size", `DPI must be a positive number, not ${dpi}.`);
  return setMmPerPixel(doc, dpiToMmPerPixel(dpi));
}

/** Width and height in mm. */
export function physicalSize(doc: ImageDocument): { widthMm: number; heightMm: number } {
  return { widthMm: doc.width * doc.mmPerPixel, heightMm: doc.height * doc.mmPerPixel };
}

function updateLayer(doc: ImageDocument, layerId: string, change: (layer: ImageLayer) => ImageLayer): ImageDocument {
  if (!doc.layers.some((l) => l.id === layerId)) throw new ImageError("invalid-input", `There is no layer ${JSON.stringify(layerId)}.`);
  return { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? change(l) : l)) };
}

export function setLayerVisible(doc: ImageDocument, layerId: string, visible: boolean): ImageDocument {
  return updateLayer(doc, layerId, (l) => ({ ...l, visible }));
}

/** Sets the layer's brightness (-1 to +1); 0 removes the adjustment. */
export function setBrightness(doc: ImageDocument, layerId: string, amount: number): ImageDocument {
  const adjustment: Adjustment = { type: "brightness", amount };
  checkAdjustment(adjustment);
  return updateLayer(doc, layerId, (l) => {
    const others = l.adjustments.filter((a) => a.type !== "brightness");
    return { ...l, adjustments: amount === 0 ? others : [...others, adjustment] };
  });
}

/** The pixels to show: each visible layer with its adjustments. A hidden layer is fully transparent. Never changes the originals. */
export function composite(doc: ImageDocument): Pixels {
  const rgba = new Uint8ClampedArray(doc.width * doc.height * 4);
  // One layer for now (G1); the stack and blend modes come at G4.
  if (doc.layers.length !== 1) throw new ImageError("unsupported", "Only one layer can be shown for now.");
  const [layer] = doc.layers;
  if (layer.visible) applyAdjustments(layer.pixels.rgba, layer.adjustments, rgba);
  return { width: doc.width, height: doc.height, rgba };
}

/** What Image hands to other workspaces: the shown pixels with their physical size. */
export function toImageRep(doc: ImageDocument): ImageRep {
  const { width, height, rgba } = composite(doc);
  return { kind: "image", width, height, mmPerPixel: doc.mmPerPixel, rgba };
}
