// What the Image panels show, as plain data: the browser's layer rows and
// the properties' size rows. Pure functions of the document, so they are
// tested without a page; workspace.ts puts them on screen.

import { formatQuantity as fmt } from "@fission/ui";
import { physicalSize, type ImageDocument } from "./document.ts";
import { ImageError } from "./errors.ts";
import { mmPerPixelToDpi } from "./physical-size.ts";

export interface LayerRow {
  id: string;
  name: string;
  visible: boolean;
}

/** The browser's rows: the document's layers, top first; none with nothing open. */
export function layerRows(doc: ImageDocument | null): LayerRow[] {
  return doc ? [...doc.layers].reverse().map((l) => ({ id: l.id, name: l.name, visible: l.visible })) : [];
}

export interface SizeView {
  pixels: string;
  size: string;
  /** For the editable inputs: plain numbers, ten significant figures. */
  dpi: string;
  mmPerPixel: string;
  /** Where the size came from, in words. */
  source: string;
}

const plain = (n: number) => String(+n.toPrecision(10));

/** The properties' size rows for an open document. */
export function sizeView(doc: ImageDocument): SizeView {
  const { widthMm, heightMm } = physicalSize(doc);
  const source = doc.sizeSource === "file" ? "From the file" : doc.sizeSource === "user" ? "Set by you" : `Assumed: ${doc.sizeNote ?? "the file gives no size"}`;
  return {
    pixels: `${doc.width} × ${doc.height} px`,
    size: `${fmt(widthMm)} × ${fmt(heightMm)} mm`,
    dpi: plain(mmPerPixelToDpi(doc.mmPerPixel)),
    mmPerPixel: plain(doc.mmPerPixel),
    source,
  };
}

/** The layer's brightness as a whole percent for the slider (-100 to +100), and its label ("+20 %", "0 %", "-35 %"). */
export function brightnessView(doc: ImageDocument, layerId: string): { percent: number; label: string } {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) throw new ImageError("invalid-input", `There is no layer ${JSON.stringify(layerId)}.`);
  const amount = layer.adjustments.find((a) => a.type === "brightness")?.amount ?? 0;
  const percent = Math.round(amount * 100);
  return { percent, label: `${percent > 0 ? "+" : percent < 0 ? "\u2212" : ""}${Math.abs(percent)} %` };
}

/** The slider's value as a brightness amount (-1 to +1); anything but a whole percent from -100 to +100 is refused. */
export function parseBrightnessInput(text: string): number {
  const t = text.trim();
  const n = t === "" ? NaN : Number(t);
  if (!Number.isInteger(n) || n < -100 || n > 100) throw new ImageError("invalid-input", `Brightness must be a whole percent from -100 to +100, not ${JSON.stringify(text)}.`);
  return n / 100;
}

/** Reads a number the user typed into DPI or mm per pixel; anything that is not a positive number is refused with a message. */
export function parseSizeInput(text: string, what: "DPI" | "mm per pixel"): number {
  const t = text.trim();
  const n = t === "" ? NaN : Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new ImageError("invalid-size", `${what} must be a positive number, not ${JSON.stringify(text)}.`);
  return n;
}

/** Said under the size until images join the project file (roadmap G6). */
export const NOT_SAVED_NOTE = "Not saved with the project yet: this image is gone when the page is closed or reloaded.";
