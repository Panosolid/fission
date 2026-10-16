// Adjustments: data on a layer, applied to a copy of the original pixels
// whenever the image is shown, so the original is never changed and setting
// an adjustment back to zero gives exactly the original (non-destructive).

import { ImageError } from "./errors.ts";

/**
 * Brightness: a simple offset on each colour channel, what a Brightness
 * slider does in every photo editor (owner's decision, 2026-10-16). `amount`
 * runs from -1 (black) to +1 (white); the offset is round(amount × 255),
 * added to red, green and blue in the stored (sRGB) values and clipped to
 * 0–255; alpha is untouched. A physically based Exposure in linear light is
 * a separate adjustment later (roadmap G4).
 */
export interface Brightness {
  type: "brightness";
  amount: number;
}

export type Adjustment = Brightness;

export function checkAdjustment(adjustment: Adjustment): void {
  if (adjustment.type !== "brightness") throw new ImageError("invalid-input", `Unknown adjustment ${JSON.stringify((adjustment as { type: unknown }).type)}.`);
  const a = adjustment.amount;
  if (!Number.isFinite(a) || a < -1 || a > 1) {
    throw new ImageError("invalid-input", `Brightness must be between -100 % and +100 %, not ${a * 100} %.`);
  }
}

/** The integer added to each channel. Math.round rounds halves up (76.5 → 77), so the result never depends on the array's own rounding. */
export function brightnessOffset(amount: number): number {
  return Math.round(amount * 255);
}

/** Applies adjustments in order to RGBA pixels, writing into `out` (which may be `rgba` itself). */
export function applyAdjustments(rgba: Uint8ClampedArray, adjustments: readonly Adjustment[], out: Uint8ClampedArray): void {
  if (out.length !== rgba.length) throw new ImageError("invalid-input", "The output must have as many pixels as the input.");
  if (out !== rgba) out.set(rgba);
  for (const adjustment of adjustments) {
    checkAdjustment(adjustment);
    const offset = brightnessOffset(adjustment.amount);
    if (offset === 0) continue;
    for (let i = 0; i < out.length; i += 4) {
      // Uint8ClampedArray clips to 0–255 on write; the sum is already an integer.
      out[i] = out[i] + offset;
      out[i + 1] = out[i + 1] + offset;
      out[i + 2] = out[i + 2] + offset;
    }
  }
}
