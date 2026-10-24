// The Image workspace's limits. The physical ones mirror the kernel's
// modelling range in kernel/src/tolerance.rs (LINEAR = 10 nm is the smallest
// length it tells apart, MAX_SIZE = 1 km the largest part), so an image can
// always become geometry; a test reads tolerance.rs to keep them equal.

import { ImageError } from "./errors.ts";

/** Smallest pixel, in mm: the kernel's LINEAR tolerance (10 nm). */
export const MIN_MM_PER_PIXEL = 1e-5;
/** Largest physical width or height, in mm: the kernel's MAX_SIZE (1 km). */
export const MAX_SIZE_MM = 1e6;
/** Most pixels along one side. */
export const MAX_SIDE = 16384;
/**
 * Most pixels in one image: 8192 × 8192. Each pixel is 4 bytes, and the
 * original and the adjusted copy are both kept, so this is about 512 MB at
 * worst; more would crash a browser tab instead of showing a message.
 */
export const MAX_PIXELS = 8192 * 8192;

/** Refuses a pixel size before anything is allocated for it. */
export function checkPixelSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new ImageError("damaged", `An image must be at least 1 × 1 pixels; this one says ${width} × ${height}.`);
  }
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new ImageError("too-large", `${width} × ${height} pixels is too large: at most ${MAX_SIDE} pixels along a side.`);
  }
  if (width * height > MAX_PIXELS) {
    const mp = (width * height / 1e6).toFixed(1);
    throw new ImageError("too-large", `${width} × ${height} pixels (${mp} megapixels) is too large: at most ${(MAX_PIXELS / 1e6).toFixed(1)} megapixels.`);
  }
}

/** Refuses a physical size the kernel could not model. */
export function checkMmPerPixel(mmPerPixel: number, width: number, height: number): void {
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    throw new ImageError("invalid-size", `A pixel's size must be a positive number of mm, not ${mmPerPixel}.`);
  }
  if (mmPerPixel < MIN_MM_PER_PIXEL) {
    throw new ImageError("invalid-size", `${mmPerPixel} mm per pixel is smaller than the smallest size SpindleLabs models (${MIN_MM_PER_PIXEL} mm, 10 nm).`);
  }
  const side = Math.max(width, height) * mmPerPixel;
  if (side > MAX_SIZE_MM) {
    throw new ImageError("invalid-size", `At ${mmPerPixel} mm per pixel the image would be ${side} mm across, larger than the largest size SpindleLabs models (${MAX_SIZE_MM} mm, 1 km).`);
  }
}
