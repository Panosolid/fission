// Lengths as people write them ("4 cm", "1.5 inches", "25") and the
// millimetres they mean. The millimetres are worked out from the text, so
// what the example says and what its command holds can't drift apart.

import type { SeededRandom } from "@fission/testing";

export type Unit = "mm" | "cm" | "m" | "in" | "none";

/** Millimetres per unit as a fraction (25.4 = 254/10), so conversions are one rounding. A bare number is mm, as the system prompt says. */
const MM_PER: Record<Unit, [number, number]> = { mm: [1, 1], cm: [10, 1], m: [1000, 1], in: [254, 10], none: [1, 1] };

const NAMES: Record<Unit, { short: string[]; one: string; many: string }> = {
  mm: { short: [" mm", "mm"], one: "millimetre", many: "millimetres" },
  cm: { short: [" cm", "cm"], one: "centimetre", many: "centimetres" },
  m: { short: [" m"], one: "metre", many: "metres" },
  in: { short: [" in", '"'], one: "inch", many: "inches" },
  none: { short: [""], one: "", many: "" },
};

export interface Length {
  /** As written in the prompt, e.g. "1.5 inches". */
  text: string;
  /** The number as written, e.g. "1.5". */
  number: string;
  unit: Unit;
  /** What it means in millimetres. */
  mm: number;
}

/**
 * The millimetres a written number in a unit means, rounded once to 12
 * significant figures: 0.1 in is 2.54 mm exactly, not 0.1 × 25.4 =
 * 2.5400000000000005. Every value the generator writes has at most 6.
 */
export function toMm(number: string, unit: Unit): number {
  const [num, den] = MM_PER[unit];
  return Number(((Number(number) * num) / den).toPrecision(12));
}

/** Writes a number without float noise: 0.30000000000000004 → "0.3". */
export function numberText(v: number): string {
  return String(Number(v.toFixed(4)));
}

export const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];

/** A length written in a unit, in one of the ways people write it. */
export function lengthIn(number: string, unit: Unit, r?: SeededRandom): Length {
  const n = NAMES[unit];
  const word = Number(number) === 1 ? n.one : n.many;
  const text = unit === "none" ? number : r && r.next() < 0.3 ? `${number} ${word}` : `${number}${r ? pick(r, n.short) : n.short[0]}`;
  return { text, number, unit, mm: toMm(number, unit) };
}

/** The unit alone, written after a list of numbers ("40 by 30 by 20 mm"); nothing for a bare number. */
export function unitAfter(unit: Unit, r: SeededRandom): string {
  if (unit === "none") return "";
  return r.next() < 0.3 ? ` ${NAMES[unit].many}` : pick(r, NAMES[unit].short.filter((s) => s !== '"'));
}

/** A unit for one prompt: mostly mm, as makers mostly write. */
export function randomUnit(r: SeededRandom): Unit {
  const n = r.next();
  return n < 0.55 ? "mm" : n < 0.75 ? "cm" : n < 0.9 ? "in" : n < 0.95 ? "m" : "none";
}

/**
 * A size a maker might ask for in this unit, as written: whole and half
 * millimetres up to 300, half centimetres up to 40, quarter inches up to
 * 12, and 5 cm steps of a metre up to 2. Spread evenly on a log scale so
 * small and large parts both appear.
 */
export function randomSize(r: SeededRandom, unit: Unit): string {
  const logPick = (lo: number, hi: number) => lo * (hi / lo) ** r.next();
  switch (unit) {
    case "mm":
    case "none": {
      const steps = r.next() < 0.2 ? 2 : 1; // halves now and then
      return numberText(Math.max(1, Math.round(logPick(1, 300) * steps)) / steps);
    }
    case "cm":
      return numberText(Math.max(1, Math.round(logPick(1, 80))) / 2);
    case "in":
      return numberText(Math.max(1, Math.round(logPick(1, 48))) / 4);
    case "m":
      return numberText(Math.max(2, Math.round(logPick(2, 40))) / 20);
  }
}

/** A random length in a unit. */
export function randomLength(r: SeededRandom, unit: Unit): Length {
  return lengthIn(randomSize(r, unit), unit, r);
}
