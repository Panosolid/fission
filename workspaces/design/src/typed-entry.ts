// Typed sizes while drawing (sketch feel SF4): once a line has its start
// or a rectangle its first corner, boxes follow the pointer with the size
// it would draw. Typing a number in one locks that size (a padlock shows),
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
import type { SketchTool } from "./sketch-tool.ts";

/** The boxes a tool shows: a line's length and angle, a rectangle's width and height. */
export type TypedField = "length" | "angle" | "width" | "height";

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
 * decimal is an angle; only its remainder matters. One too big to be a
 * number is refused.
 */
export function readAngle(text: string): Reading {
  const t = text.trim().replace(/\s*(°|deg)$/i, "");
  if (!DECIMAL.test(t)) return { error: `"${text.trim()}" isn't an angle: type degrees from the x axis, like 30 or -45.` };
  const deg = Number(t);
  // 309 digits or more read as Infinity, whose remainder is NaN (security re-check N2).
  if (!Number.isFinite(deg)) return { error: "That number is too big for an angle: type degrees from the x axis, like 30 or -45." };
  return { value: turnDegrees(deg) };
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

/** The boxes the tool shows now: a line's once it has a start, a rectangle's once it has a first corner, none otherwise (circles and arcs come later). */
export function typedFields(tool: SketchTool): TypedField[] {
  if (tool.kind === "line" && tool.from !== null) return ["length", "angle"];
  if (tool.kind === "rectangle" && tool.corner !== null) return ["width", "height"];
  return [];
}

/** The tool's anchor: a line's start (its point id looked up) or a rectangle's first corner; null when the tool shows no boxes. */
export function anchorOf(doc: DesignDocument, tool: SketchTool): SketchXY | null {
  if (tool.kind === "rectangle") return tool.corner;
  if (tool.kind !== "line" || tool.from === null) return null;
  if (typeof tool.from !== "string") return tool.from;
  const id = tool.from;
  const p = doc.sketches.find((s) => s.id === tool.sketch)?.points.find((x) => x.id === id);
  return p ? [p.x, p.y] : null;
}

/** Where the tool would place its next point with these locks: the pointer, or what the locks make of it; null when there is no answer. */
export function aimOf(doc: DesignDocument, tool: SketchTool, pointer: SketchXY | null, locks: Locks): SketchXY | null {
  const anchor = anchorOf(doc, tool);
  if (!anchor) return pointer;
  return tool.kind === "line" ? lineEnd(anchor, pointer, locks) : rectangleCorner(anchor, pointer, locks);
}

/** What each box shows while not typed in: the size the aim would draw (a line's length and angle, a rectangle's width and height). */
export function liveValues(anchor: SketchXY, aim: SketchXY, tool: SketchTool): Locks {
  if (tool.kind === "rectangle") return { width: Math.abs(aim[0] - anchor[0]), height: Math.abs(aim[1] - anchor[1]) };
  return { length: lengthOf(anchor, aim), angle: angleOf(anchor, aim) };
}

/** A size as a box shows it: at most 3 decimals (µm), no trailing zeros, "-0" as "0". */
export function shownValue(v: number): string {
  const s = String(Math.round(v * 1000) / 1000);
  return s === "-0" ? "0" : s;
}

/** Why a click with locks placed nothing: the pointer was on the start, or behind a locked angle. */
export const NO_AIM = "Move the pointer the way the line should go: with a typed size, the pointer picks the direction (ahead of the start for a typed angle).";
