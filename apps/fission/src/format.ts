const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/**
 * A measured quantity for display, to 10 significant figures: grouped
 * digits between 0.001 and 1e12 ("15,600", "0.5"), powers of ten outside
 * that ("1 × 10⁻⁹"), so a tiny value is never rounded to 0. Ten figures
 * hide the last-digit rounding noise of a double.
 */
export function formatQuantity(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e-3 && a < 1e12) return n.toLocaleString("en-GB", { maximumSignificantDigits: 10 });
  const [mantissa, exp] = n.toExponential(9).split("e");
  const m = String(+mantissa);
  const e = String(+exp).replace("-", "⁻").replace(/\d/g, (d) => SUPERSCRIPT[+d]);
  return `${m} × 10${e}`;
}

/** A sphere around a body: what the camera frames. */
export interface Framing {
  centre: [number, number, number];
  radius: number;
}

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
