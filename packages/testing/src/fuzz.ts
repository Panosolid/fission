// Random and malformed inputs for fuzzing the command layer, from a seed.

import type { SeededRandom } from "./index.ts";

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];

/** Numbers a model might send: good ones, edge cases and nonsense. */
function randomValue(r: SeededRandom): unknown {
  const n = r.next();
  if (n < 0.45) return 10 ** (r.next() * 12 - 6); // 1e-6 … 1e6 mm: in and out of the modelling range
  if (n < 0.55) return pick(r, [0, -0, -1, -40, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER]);
  if (n < 0.62) return pick(r, [NaN, Infinity, -Infinity]);
  if (n < 0.7) return pick(r, ["40", "", "forty", "40mm"]);
  if (n < 0.78) return pick(r, [null, undefined, true, [], {}, [40], { value: 40 }]);
  return Math.round(r.next() * 1000) / 10;
}

/** A command-shaped object, sometimes right, often subtly or badly wrong. */
export function randomCommand(r: SeededRandom): unknown {
  if (r.next() < 0.05) return pick(r, [null, 42, "set_part", [], [{ op: "set_part" }]]);
  const c: Record<string, unknown> = { op: r.next() < 0.9 ? "set_part" : pick(r, ["hole", "SET_PART", "", 7, null]) };
  if (r.next() < 0.97) c.shape = r.next() < 0.85 ? pick(r, ["box", "cylinder", "sphere", "l-bracket", "plate", "slot", "star"]) : pick(r, ["cube", "Box", 3, null]);
  for (const k of ["width", "depth", "height"]) if (r.next() < 0.95) c[k] = randomValue(r);
  if (r.next() < 0.05) c[pick(r, ["colour", "__proto__", "x"])] = 1;
  return c;
}

/** Answer texts: valid JSON lists, truncated JSON, prose, junk. */
export function randomText(r: SeededRandom): string {
  const n = r.next();
  const list = JSON.stringify({ commands: Array.from({ length: Math.floor(r.next() * 4) }, () => randomCommand(r)) });
  if (n < 0.5) return list;
  if (n < 0.7) return list.slice(0, Math.floor(r.next() * list.length));
  if (n < 0.85) return pick(r, ["Sure! I made the box bigger.", "", "{}", "null", '{"commands": "box"}', "```json\n{}\n```"]);
  return Array.from({ length: Math.floor(r.next() * 40) }, () => String.fromCharCode(Math.floor(r.next() * 0x3000))).join("");
}
