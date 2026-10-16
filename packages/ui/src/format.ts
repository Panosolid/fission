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
