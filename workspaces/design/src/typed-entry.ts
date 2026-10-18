// Typed sizes while drawing (sketch feel SF4): once a line has its start
// or a rectangle its first corner, boxes follow the pointer with the size
// it would draw. The arcs too: a 3-point arc's end and a tangent arc's end
// by length and angle from their start, a centre arc's start by radius
// and angle from its centre, and its end by how far round it goes (the
// arc angle; the pointer picks which way). A 3-point arc's third click,
// a point the arc passes through, has no boxes. Typing a number in one locks that size (a padlock shows),
// and the mouse then only chooses what is left: with a line's length
// locked the pointer picks the direction, with its angle locked too
// nothing is left and the end is fixed. Tab goes to the next box, Enter
// places the point as a click would. The workspace runs the boxes
// (typed-boxes.ts); this file is the maths, as pure functions.
//
// Locked values are exact intent: the end they give is never rounded to
// the pointer's pixel or snapped, so a typed 10 mm line is 10 mm to
// within one rounding of its coordinates, not to within a pixel.

import type { SketchXY } from "@fission/core";
import type { DesignDocument } from "./document.ts";
import type { CentreArcTool, SketchTool } from "./sketch-tool.ts";
import { sweep } from "./centre-arc.ts";

/** The boxes a tool shows: a line's length and angle, a rectangle's width and height, a centre arc's radius and angle, then its arc angle (`sweep`). */
export type TypedField = "length" | "angle" | "width" | "height" | "radius" | "sweep";

/** The values typed and accepted so far, each locking its size; absent ones follow the pointer. */
export type Locks = Partial<Record<TypedField, number>>;

/**
 * The kernel's smallest piece and largest size (kernel/src/tolerance.rs
 * MIN_FEATURE = 1e-3 mm, MAX_SIZE = 1e6 mm): a typed length outside them
 * would only be refused later by the outline check, so the box says so
 * at once.
 */
export const MIN_TYPED = 1e-3;
export const MAX_TYPED = 1e6;

/** What a box's text means: a number, or why not. */
export type Reading = { value: number } | { error: string };

/** A plain decimal: digits with at most one point, an optional sign; no exponent, no hex, no "Infinity". */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** A length typed in a box: a decimal of mm ("12.5", "12.5 mm"), from MIN_TYPED to MAX_TYPED. */
export function readLength(text: string): Reading {
  const t = text.trim().replace(/\s*mm$/i, "");
  if (!DECIMAL.test(t)) return { error: `"${text.trim()}" isn't a length: type a number of mm, like 25 or 12.5.` };
  const value = Number(t);
  if (value <= 0) return { error: "A length must be more than 0 mm." };
  if (value < MIN_TYPED) return { error: `A length must be at least ${MIN_TYPED} mm, the smallest piece the modeller keeps.` };
  if (value > MAX_TYPED) return { error: `A length can be at most ${MAX_TYPED} mm (1 km), the largest size the modeller works at.` };
  return { value };
}

/**
 * An angle typed in a box, in degrees counter-clockwise from the sketch's
 * x axis ("30", "-45", "30°", "30 deg"), turned into [0, 360). Any finite
 * decimal is an angle; only its remainder matters.
 */
export function readAngle(text: string): Reading {
  const t = text.trim().replace(/\s*(°|deg)$/i, "");
  if (!DECIMAL.test(t)) return { error: `"${text.trim()}" isn't an angle: type degrees from the x axis, like 30 or -45.` };
  return { value: turnDegrees(Number(t)) };
}

/**
 * How far round a centre arc goes, typed in degrees ("90", "270°"): more
 * than 0 and less than 360, since an arc can't be a whole turn (that is a
 * circle). No sign: the pointer picks which way round.
 */
export function readSweep(text: string): Reading {
  const t = text.trim().replace(/\s*(°|deg)$/i, "");
  if (!DECIMAL.test(t)) return { error: `"${text.trim()}" isn't an angle: type how far round the arc goes in degrees, like 90 or 270.` };
  const value = Number(t);
  if (value <= 0) return { error: "An arc must go round more than 0°: the pointer picks which way." };
  if (value >= 360) return { error: "An arc must go round less than 360°: a whole turn is a circle." };
  return { value };
}

/** Degrees into [0, 360): −90 is 270, 360 is 0, 405 is 45. */
export function turnDegrees(deg: number): number {
  const r = deg % 360;
  const d = r < 0 ? r + 360 : r;
  // −1e-17 % 360 + 360 rounds to 360 itself, and −0 stays −0: both are the angle 0.
  return d === 360 || d === 0 ? 0 : d;
}

/**
 * The unit direction at `deg` degrees from the x axis. The four quarter
 * turns are exact ((1, 0), (0, 1), (−1, 0), (0, −1)), never cos(π/2)'s
 * 6.1e-17, so a line typed at 90° is exactly upright and a square typed
 * side by side closes exactly on its first corner.
 */
export function direction(deg: number): SketchXY {
  const d = turnDegrees(deg);
  if (d === 0) return [1, 0];
  if (d === 90) return [0, 1];
  if (d === 180) return [-1, 0];
  if (d === 270) return [0, -1];
  const r = (d * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

/** The angle from a to b in degrees in [0, 360), as the angle box shows it; 0 when they are the same point. */
export function angleOf(a: SketchXY, b: SketchXY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return 0;
  return turnDegrees((Math.atan2(dy, dx) * 180) / Math.PI);
}

/** The distance from a to b, √(dx² + dy²) (plain sqrt, as sketch-tool.ts's `distance`, not Math.hypot). */
export const lengthOf = (a: SketchXY, b: SketchXY): number => Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);

/**
 * Where a line from `start` ends with these locks and the pointer at `p`,
 * or null when the pointer gives no answer:
 * - nothing locked: the pointer;
 * - the length L: along the pointer's direction, start + (p − start)·L/|p − start|,
 *   null on the start itself (no direction). Each coordinate is worked as
 *   (dx·L)/|d|, the product first: for a pointer and length on a grid the
 *   product is exact and the one division rounds correctly, so a 3-4-5
 *   pointer with L = 3 gives (9/5, 12/5) to the nearest double, where
 *   (dx/|d|)·L and dx·(L/|d|) round twice and land an ulp off (1.7999999999999998);
 *   a pointer lined up with the start's row or column (snap.ts) gives an
 *   exactly level or upright line;
 * - the angle θ: the pointer's distance along θ, start + u·((p − start)·u),
 *   null when that is not ahead of the start;
 * - both: start + L·u, whatever the pointer (it may be null).
 */
export function lineEnd(start: SketchXY, p: SketchXY | null, locks: Locks): SketchXY | null {
  const L = locks.length, a = locks.angle;
  if (L !== undefined && a !== undefined) {
    const u = direction(a);
    return [start[0] + L * u[0], start[1] + L * u[1]];
  }
  if (!p) return null;
  const dx = p[0] - start[0], dy = p[1] - start[1];
  if (a !== undefined) {
    const u = direction(a);
    const t = dx * u[0] + dy * u[1];
    return t > 0 ? [start[0] + t * u[0], start[1] + t * u[1]] : null;
  }
  if (L === undefined) return p;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return null;
  return [start[0] + (dx * L) / d, start[1] + (dy * L) / d];
}

/**
 * A rectangle's opposite corner from `corner` with these locks and the
 * pointer at `p`: a locked width W puts it at corner.x ± W, on the
 * pointer's side (right when level with the corner), and a locked height
 * the same along y; the pointer gives the rest. Null without a pointer
 * unless both are locked.
 */
export function rectangleCorner(corner: SketchXY, p: SketchXY | null, locks: Locks): SketchXY | null {
  const W = locks.width, H = locks.height;
  if (!p && (W === undefined || H === undefined)) return null;
  const side = (from: number, to: number | undefined) => (to === undefined || to >= from ? 1 : -1);
  const x = W === undefined ? p![0] : corner[0] + side(corner[0], p?.[0]) * W;
  const y = H === undefined ? p![1] : corner[1] + side(corner[1], p?.[1]) * H;
  return [x, y];
}

/** The boxes the tool shows now: a line's, a 3-point arc's (for its end) and a tangent arc's once they have a start, a rectangle's once it has a first corner, a centre arc's radius and angle once it has a centre and its arc angle once it has a start; none otherwise (a 3-point arc's third click and circles have none). */
export function typedFields(tool: SketchTool): TypedField[] {
  if ((tool.kind === "line" || tool.kind === "tangent") && tool.from !== null) return ["length", "angle"];
  if (tool.kind === "rectangle" && tool.corner !== null) return ["width", "height"];
  if (tool.kind === "arc" && tool.start !== null && tool.end === null) return ["length", "angle"];
  if (tool.kind === "centre" && tool.centre !== null) return tool.start === null ? ["radius", "angle"] : ["sweep"];
  return [];
}

/** Where a point id of the tool's sketch is, or null when it is gone (after an undo, say). */
function pointOf(doc: DesignDocument, sketch: string, id: string): SketchXY | null {
  const p = doc.sketches.find((s) => s.id === sketch)?.points.find((x) => x.id === id);
  return p ? [p.x, p.y] : null;
}

/** The tool's anchor, what its boxes measure from: a line's or tangent arc's start (its point id looked up), a rectangle's first corner, a 3-point arc's start until its end is down, a centre arc's centre; null when the tool shows no boxes. */
export function anchorOf(doc: DesignDocument, tool: SketchTool): SketchXY | null {
  if (tool.kind === "rectangle") return tool.corner;
  if (tool.kind === "arc") return tool.end === null ? tool.start : null;
  if (tool.kind === "centre") return tool.centre;
  if (tool.kind === "circle" || tool.from === null) return null;
  return typeof tool.from === "string" ? pointOf(doc, tool.sketch, tool.from) : tool.from;
}

/**
 * The end of a centre arc from `s` round `c` by `deg` degrees,
 * counter-clockwise above 0: c + R(deg)(s − c), the start's offset turned
 * by the rotation with the cosine and sine of `direction` (exact at the
 * quarter turns, so 90° from (10, 0) round the origin is (0, 10) exactly).
 */
export function centreEnd(c: SketchXY, s: SketchXY, deg: number): SketchXY {
  const [vx, vy] = [s[0] - c[0], s[1] - c[1]];
  const [cos, sin] = direction(deg);
  return [c[0] + (vx * cos - vy * sin), c[1] + (vx * sin + vy * cos)];
}

/**
 * The way a centre arc goes with the pointer at `p`: +1 counter-clockwise,
 * −1 clockwise, from the sweep the pointer has made (centre-arc.ts
 * `sweep`, this point included; with no pointer, the sweep so far).
 */
function wayRound(tool: CentreArcTool, p: SketchXY | null): 1 | -1 {
  const swept = p && tool.centre && tool.start ? sweep(tool.centre, tool.start, tool.swept, p) : tool.swept;
  return swept >= 0 ? 1 : -1;
}

/** Where the tool would place its next point with these locks: the pointer, or what the locks make of it; null when there is no answer. */
export function aimOf(doc: DesignDocument, tool: SketchTool, pointer: SketchXY | null, locks: Locks): SketchXY | null {
  const anchor = anchorOf(doc, tool);
  if (!anchor) return pointer;
  if (tool.kind === "rectangle") return rectangleCorner(anchor, pointer, locks);
  if (tool.kind !== "centre") return lineEnd(anchor, pointer, locks);
  if (tool.start === null) return lineEnd(anchor, pointer, { length: locks.radius, angle: locks.angle });
  return locks.sweep === undefined ? pointer : centreEnd(anchor, tool.start, wayRound(tool, pointer) * locks.sweep);
}

/**
 * The tool a click with these locks goes to: itself, except a centre arc
 * with its arc angle typed, whose sweep becomes that angle the way the
 * pointer goes round (in radians, as `sweep` keeps it), so the click at
 * `aimOf`'s end draws that much arc whichever way the pointer last
 * unwrapped (a typed 270° with the pointer a little way round is 270°,
 * not the 90° the other way). The preview draws from the same tool.
 */
export function withLocks<T extends SketchTool>(tool: T, locks: Locks, pointer: SketchXY | null): T {
  if (tool.kind !== "centre" || tool.start === null || locks.sweep === undefined) return tool;
  return { ...tool, swept: (wayRound(tool, pointer) * locks.sweep * Math.PI) / 180 };
}

/** What each box shows while not typed in: the size the aim would draw (a line's length and angle, a rectangle's width and height, a centre arc's radius and angle, then its arc angle, how far round the arc the aim makes goes). */
export function liveValues(anchor: SketchXY, aim: SketchXY, tool: SketchTool): Locks {
  if (tool.kind === "rectangle") return { width: Math.abs(aim[0] - anchor[0]), height: Math.abs(aim[1] - anchor[1]) };
  if (tool.kind === "centre" && tool.start !== null) {
    const way = wayRound(tool, aim);
    const turn = way * (angleOf(anchor, aim) - angleOf(anchor, tool.start));
    return { sweep: turnDegrees(turn) };
  }
  if (tool.kind === "centre") return { radius: lengthOf(anchor, aim), angle: angleOf(anchor, aim) };
  return { length: lengthOf(anchor, aim), angle: angleOf(anchor, aim) };
}

/** A size as a box shows it: at most 3 decimals (µm), no trailing zeros, "-0" as "0". */
export function shownValue(v: number): string {
  const s = String(Math.round(v * 1000) / 1000);
  return s === "-0" ? "0" : s;
}

/** Why a click with locks placed nothing: the pointer was on the start, or behind a locked angle. */
export const NO_AIM = "Move the pointer the way the point should go: with a typed size, the pointer picks the direction (ahead of the start for a typed angle).";
