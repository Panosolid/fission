import type { Framing } from "@fission/core";

export type { Framing };

/** How far a body may reach past the framed sphere before re-framing. */
export const FIT_SLACK = 1.5;

/**
 * Whether the camera should re-frame: the first body; a body that no longer
 * fits comfortably in the framed sphere (its own sphere reaches past 1.5×
 * the framed radius, because it grew or moved); or one that shrank more
 * than tenfold and would be a speck. Smaller edits keep the user's view.
 */
export function needsRefit(last: Framing | null, now: Framing): boolean {
  if (!(now.radius > 0)) return false;
  if (last === null) return true;
  const shift = Math.hypot(...now.centre.map((c, i) => c - last.centre[i]));
  return shift + now.radius > FIT_SLACK * last.radius || now.radius < 0.1 * last.radius;
}
