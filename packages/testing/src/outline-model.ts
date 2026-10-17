// A simple model of what a sketch's lines and circles make (the kernel's
// sketch_outline, kernel/src/sketch.rs), written separately from it to
// check it: for drawings on a whole-number grid, where two ends join only
// when their coordinates are equal and every test can be exact (products of
// whole numbers below 2^53). Used by the mixed-tool journey on the real
// kernel (journeys/sketch-mixed.journey.ts) and by the browser's long
// sketch session (apps/fission/e2e/sketch-session.mjs), which compares it
// with the sketch status the app shows.
//
// Test-only: the app never uses it (2D curve maths lives in the kernel).
//
// The rules, in the kernel's order:
// 1. Nothing drawn: empty. Only circles: one is a closed circle outline,
//    more are that many loops.
// 2. Every line end must meet exactly one other end. The first end (line
//    i's start is end 2i, its end 2i + 1, lines in drawing order) that
//    meets none is a loose end; one where three or more ends meet is a
//    branch, with the number of ends there.
// 3. The lines' loops plus the circles: more than one is "separate loops".
// 4. One loop of lines must be a simple polygon: at least three corners,
//    no corner where the outline turns straight back on itself, and no two
//    sides that aren't neighbours touching or crossing. Corners where the
//    outline goes straight on are fine.

export type XY = readonly [number, number];
export interface ModelLine {
  a: XY;
  b: XY;
}
export interface ModelCircle {
  centre: XY;
  radius: number;
}

export type ModelOutline =
  | { kind: "empty" }
  | { kind: "loose"; at: XY }
  | { kind: "branch"; at: XY; ends: number }
  | { kind: "loops"; loops: number }
  | { kind: "not a profile"; corners: XY[]; why: string }
  | { kind: "closed"; corners: XY[]; area: number }
  | { kind: "circle"; area: number };

const key = ([x, y]: XY) => `${x},${y}`;
/** The sign of the turn a → b → c: positive left, negative right, 0 in line. Exact for whole numbers. */
const turn = (a: XY, b: XY, c: XY) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
/** Whether p, known to be in line with a and b, lies between them (ends included). */
const between = (a: XY, b: XY, p: XY) => Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);

/** Whether the closed segments ab and cd share any point (crossing, touching, or overlapping). */
export function segmentsMeet(a: XY, b: XY, c: XY, d: XY): boolean {
  const [d1, d2, d3, d4] = [turn(c, d, a), turn(c, d, b), turn(a, b, c), turn(a, b, d)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && between(c, d, a)) || (d2 === 0 && between(c, d, b)) || (d3 === 0 && between(a, b, c)) || (d4 === 0 && between(a, b, d));
}

/** Shoelace area: ½ |Σ x_i y_{i+1} − x_{i+1} y_i|. */
export const shoelace = (pts: readonly XY[]) => Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;

/** Why a closed loop of corners isn't a simple polygon, or null when it is. */
export function notSimple(corners: readonly XY[]): string | null {
  const n = corners.length;
  if (n < 3) return `${n} corners`;
  for (let i = 0; i < n; i++) {
    const [p, c, q] = [corners[(i + n - 1) % n], corners[i], corners[(i + 1) % n]];
    const dot = (c[0] - p[0]) * (q[0] - c[0]) + (c[1] - p[1]) * (q[1] - c[1]);
    if (turn(p, c, q) === 0 && dot < 0) return `turns back at (${key(c)})`;
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the start
      if (segmentsMeet(corners[i], corners[(i + 1) % n], corners[j], corners[(j + 1) % n])) return `sides ${i} and ${j} meet`;
    }
  return null;
}

/** What the model says these lines and circles make. Coordinates must be whole numbers. */
export function modelOutline(lines: readonly ModelLine[], circles: readonly ModelCircle[]): ModelOutline {
  for (const l of lines) for (const v of [...l.a, ...l.b]) if (!Number.isInteger(v)) throw new Error(`the model takes whole-number coordinates, got ${v}`);
  if (lines.length === 0) {
    if (circles.length === 0) return { kind: "empty" };
    if (circles.length === 1) return { kind: "circle", area: Math.PI * circles[0].radius ** 2 };
    return { kind: "loops", loops: circles.length };
  }
  const ends = lines.flatMap((l) => [l.a, l.b]);
  const at = new Map<string, number[]>();
  ends.forEach((p, e) => at.set(key(p), [...(at.get(key(p)) ?? []), e]));
  for (const [e, p] of ends.entries()) {
    const here = at.get(key(p))!.length;
    if (here === 1) return { kind: "loose", at: p };
    if (here > 2) return { kind: "branch", at: p, ends: here };
  }
  // Every end has one partner: walk the loops.
  const partner = (e: number) => at.get(key(ends[e]))!.find((o) => o !== e)!;
  const seen = new Array<boolean>(lines.length).fill(false);
  let loops = circles.length;
  let first: XY[] = [];
  for (let start = 0; start < lines.length; start++) {
    if (seen[start]) continue;
    loops++;
    const corners: XY[] = [];
    let e = 2 * start; // entering line `start` at its start
    while (!seen[e >> 1]) {
      seen[e >> 1] = true;
      corners.push(ends[e]);
      e = partner(e ^ 1); // leave by the other end, into the line joined there
    }
    if (start === 0) first = corners;
  }
  if (loops > 1) return { kind: "loops", loops };
  const why = notSimple(first);
  return why ? { kind: "not a profile", corners: first, why } : { kind: "closed", corners: first, area: shoelace(first) };
}

/** The kernel's words for an open sketch, as the app shows them; for "not a profile" only their start (the rest is the profile check's reason). */
export function openWords(m: ModelOutline): string {
  switch (m.kind) {
    case "empty":
      return "the sketch has no lines or circles yet";
    case "loose":
      return `the line end at (${m.at[0]}, ${m.at[1]}) is not joined to another line`;
    case "branch":
      return `${m.ends} line ends meet at (${m.at[0]}, ${m.at[1]}); every corner of an outline joins exactly two`;
    case "loops":
      return `the sketch makes ${m.loops} separate loops; for now a sketch makes one outline`;
    case "not a profile":
      return "the lines close up but are not a valid outline: ";
    default:
      throw new Error(`a ${m.kind} outline is not open`);
  }
}

/** Whether the model calls it closed (a polygon or a lone circle). */
export const isClosed = (m: ModelOutline) => m.kind === "closed" || m.kind === "circle";

/**
 * Checks the kernel's answer (`{ closed }` or `{ open: why }`) against the
 * model's; throws saying how they differ. A closed polygon's corners must
 * be the model's, as a set (the kernel may start the loop elsewhere).
 */
export function compareOutline(model: ModelOutline, kernel: { closed: unknown } | { open: string }, where = ""): void {
  const fail = (m: string) => {
    throw new Error(`${where}${where ? ": " : ""}${m}; the model says ${JSON.stringify(model)}, the kernel ${JSON.stringify(kernel)}`);
  };
  if (!isClosed(model)) {
    if (!("open" in kernel)) return fail("the kernel closed it");
    const words = openWords(model);
    const ok = model.kind === "not a profile" ? kernel.open.startsWith(words) : kernel.open === words;
    if (!ok) fail("different reasons");
    return;
  }
  if (!("closed" in kernel)) return fail("the kernel left it open");
  const outer = (kernel.closed as { outer: { path?: { corners: number[] }; circle?: { center: XY; radius: number } } }).outer;
  if (model.kind === "closed") {
    if (!outer.path) return fail("the kernel made a circle");
    const c = outer.path.corners;
    const got = JSON.stringify(Array.from({ length: c.length / 2 }, (_, i) => key([c[2 * i], c[2 * i + 1]])).sort());
    const want = JSON.stringify(model.corners.map(key).sort());
    if (got !== want) fail(`different corners: ${got} vs ${want}`);
  } else if (!outer.circle) fail("the kernel made a path");
}
