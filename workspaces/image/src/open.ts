// Opening a file (G1b): the header is read and checked first, so a file
// that is too large or damaged is refused before anything decodes it; then
// the browser decodes the pixels, and the decoded width and height must
// match what the header said. The decoder is passed in, so this runs in
// tests without a browser.

import { createImageDocument, type ImageDocument, type Pixels } from "./document.ts";
import { ImageError } from "./errors.ts";
import { readPhysicalSize, type PhysicalSize } from "./physical-size.ts";

/** Turns a file's bytes into RGBA pixels (the browser's createImageBitmap in the app). */
export type Decoder = (bytes: Uint8Array, format: PhysicalSize["format"]) => Promise<Pixels>;

let opened = 0;

/** Reads the header, decodes and makes a one-layer document; every refusal is an ImageError with its own message. */
export async function openImage(bytes: Uint8Array, name: string, decode: Decoder): Promise<ImageDocument> {
  const size = readPhysicalSize(bytes); // checks the pixel limits before anything is decoded
  let pixels: Pixels;
  try {
    pixels = await decode(bytes, size.format);
  } catch (e) {
    if (e instanceof ImageError) throw e;
    throw new ImageError("damaged", `The headers look right, but the browser could not decode the picture in this ${size.format.toUpperCase()} file.`);
  }
  return createImageDocument(`image-${++opened}`, name, pixels, size);
}
