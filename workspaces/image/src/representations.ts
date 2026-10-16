// What Image hands to other workspaces, through the one representation
// registry in core (docs/integration-map.md, rows 14-18): each layer as an
// Image, its pixels with their physical size, so Laser, Render, Slice and
// Vector never ask "how big is this?".
//
// A receiver holds a handle, never a copy: the handle reads the open image
// each time it is delivered, so an edit in Image (Brightness, a new DPI)
// reaches every receiver on its next delivery, and a layer that is gone
// is refused with a message instead of handing over stale pixels.

import type { ImageRep, Producer, Producible, RepresentationRegistry } from "@fission/core";
import { applyAdjustments } from "./adjust.ts";
import type { ImageDocument } from "./document.ts";
import { ImageError } from "./errors.ts";
import { checkMmPerPixel, checkPixelSize } from "./limits.ts";

/** One layer of the open image, handed over by id. */
export interface ImageLayerHandle extends Producible {
  type: "image.layer";
  /** The open image now, or null when none is open. */
  document(): ImageDocument | null;
}

/** The layers other workspaces can take, as live handles on whatever image `current` returns. */
export function imageObjects(current: () => ImageDocument | null): ImageLayerHandle[] {
  const doc = current();
  if (!doc) return [];
  return doc.layers.map((l) => ({ type: "image.layer", id: l.id, document: current }));
}

/**
 * A layer's pixels with its adjustments, at the image's mm per pixel.
 * Hide is a viewing choice inside Image, so a hidden layer still hands
 * over its pixels: an engraving must not vanish because the layer was
 * hidden while editing another. The pixels are a fresh copy each time,
 * so a receiver can never change the original.
 */
export const imageLayerProducer: Producer = (object) => {
  const doc = (object as ImageLayerHandle).document();
  if (!doc) throw new ImageError("invalid-input", "No image is open, so there is no layer to hand over.");
  const layer = doc.layers.find((l) => l.id === object.id);
  if (!layer) throw new ImageError("invalid-input", `The layer ${JSON.stringify(object.id)} is no longer in the image.`);
  const rgba = new Uint8ClampedArray(layer.pixels.rgba.length);
  applyAdjustments(layer.pixels.rgba, layer.adjustments, rgba);
  const rep: ImageRep = { kind: "image", width: layer.pixels.width, height: layer.pixels.height, mmPerPixel: doc.mmPerPixel, rgba };
  checkImageRep(rep);
  return rep;
};

/** Refuses an Image that is not whole: the same limits as opening a file, and RGBA bytes for every pixel. */
export function checkImageRep(rep: ImageRep): void {
  checkPixelSize(rep.width, rep.height);
  if (!(rep.rgba instanceof Uint8ClampedArray) || rep.rgba.length !== rep.width * rep.height * 4) {
    throw new ImageError("invalid-input", `${rep.width} × ${rep.height} pixels need ${rep.width * rep.height * 4} bytes of RGBA, not ${rep.rgba?.length}.`);
  }
  checkMmPerPixel(rep.mmPerPixel, rep.width, rep.height);
}

/** Says what Image produces and which files it opens. */
export function registerImage(registry: RepresentationRegistry, open: (name: string, bytes: Uint8Array) => Promise<void>): void {
  registry.registerProducer("image.layer", "image", imageLayerProducer);
  // A PNG or JPEG dropped or pasted anywhere opens here (X6).
  registry.registerImporter({ formats: ["png", "jpeg"], workspace: "image", open });
}
