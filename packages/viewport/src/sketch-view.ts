// The maths of drawing a sketch (step 21c): a sketch plane's 2D frame in
// model space, where a ray from the camera meets the plane, and the lines
// of the grid drawn on it. Snapping to the grid is the kernel's
// (snap_to_grid); these only place what is drawn and where the pointer is.

import type { Plane, SketchXY } from "@fission/core";

type Vec3 = [number, number, number];

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The plane's y axis: normal × xAxis, so (xAxis, y, normal) is right-handed. */
export function yAxisOf(plane: Plane): Vec3 {
  return cross(plane.normal, plane.xAxis);
}

/** A point of the plane's 2D frame in model space: origin + x·xAxis + y·(normal × xAxis). */
export function toWorld(plane: Plane, [x, y]: SketchXY): Vec3 {
  const v = yAxisOf(plane);
  const o = plane.origin;
  const u = plane.xAxis;
  return [o[0] + x * u[0] + y * v[0], o[1] + x * u[1] + y * v[1], o[2] + x * u[2] + y * v[2]];
}

/**
 * Where the ray from `from` along `dir` meets the plane, in the plane's
 * frame; null when the ray runs along the plane (n·dir = 0), points away
 * from it or starts on it (t ≤ 0), or the point is not finite.
 * t = n·(origin − from) / n·dir, the point from + t·dir, then its x and y
 * are its offsets from the origin along the two (unit) axes.
 */
export function rayOnPlane(from: readonly number[], dir: readonly number[], plane: Plane): SketchXY | null {
  const n = plane.normal;
  const along = dot(n, dir);
  if (along === 0) return null;
  const o = plane.origin;
  const t = dot(n, [o[0] - from[0], o[1] - from[1], o[2] - from[2]]) / along;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  const offset = [from[0] + t * dir[0] - o[0], from[1] + t * dir[1] - o[1], from[2] + t * dir[2] - o[2]];
  const x = dot(offset, plane.xAxis);
  const y = dot(offset, yAxisOf(plane));
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Minor grid lines are never drawn closer together than this on screen (px), so the grid never turns into a grey haze. */
export const GRID_MIN_PIXELS = 8;
/** Every this many minor lines is a major one. */
export const GRID_MAJOR = 10;
/** The most minor lines drawn each way from the grid's centre (a very large screen gets a grid that stops short). */
export const MAX_GRID_LINES = 300;

/** 10^e written as a short decimal (1e-3 is 0.001 exactly as typed, not 10 ** −3's 0.0010000000000000002). */
const tenTo = (e: number) => Number(`1e${e}`);

/**
 * The minor grid spacing for a pixel size on the plane (mm per pixel):
 * the smallest spacing at least GRID_MIN_PIXELS pixels apart, from
 * `step` × 10^k (k ≥ 0) when points snap to a grid of `step` (so every line
 * drawn is one a click can land on), else from the powers of ten. Null for
 * a pixel or step that is not a positive finite number, or no spacing in
 * reach of a double.
 */
export function gridSpacing(pixel: number, step: number | null = null): number | null {
  if (!(pixel > 0) || !Number.isFinite(pixel)) return null;
  if (step !== null && (!(step > 0) || !Number.isFinite(step))) return null;
  const want = GRID_MIN_PIXELS * pixel;
  const base = step ?? 1;
  // want / base can round a hair under a power of ten (log10 then guesses one too few), so check the guess.
  let e = Math.ceil(Math.log10(want / base));
  if (step !== null) e = Math.max(0, e);
  if (base * tenTo(e) < want) e += 1;
  const spacing = base * tenTo(e);
  return Number.isFinite(spacing) && spacing > 0 ? spacing : null;
}

/**
 * How strongly the minor lines are drawn, 0 to 1, from how far apart they
 * are on screen: log10(px / GRID_MIN_PIXELS), so none at GRID_MIN_PIXELS
 * apart and full at GRID_MAJOR times that. Zooming in past full makes the
 * spacing GRID_MAJOR times finer: the full minor lines become the major
 * ones and new minor lines start at none, so the grid never jumps.
 */
export function minorStrength(px: number): number {
  if (!(px > 0)) return 0;
  return Math.min(1, Math.max(0, Math.log10(px / GRID_MIN_PIXELS) / Math.log10(GRID_MAJOR)));
}

/** What the sketch grid draws, in the plane's frame. */
export interface SketchGrid {
  minor: number;
  major: number;
  /** minorStrength of the minor spacing. */
  strength: number;
  /** The grid's lines; the two through the origin are left out, `axes` draws them. */
  lines: { a: SketchXY; b: SketchXY; major: boolean }[];
  /** How far the lines run, in the plane's frame: x from, x to, y from, y to. */
  bounds: [number, number, number, number];
  /** The red x axis (y = 0) and green y axis (x = 0) across the grid, or null when the grid doesn't reach it. */
  axes: { x: [SketchXY, SketchXY] | null; y: [SketchXY, SketchXY] | null };
}

/**
 * The grid around `centre` (where the view's centre meets the plane) for
 * a pixel size there: minor lines `gridSpacing(pixel, step)` apart at
 * whole multiples of it, a major line every GRID_MAJOR; the centre moves
 * to the nearest major line, so panning keeps lines where they were. It
 * reaches `reachPx` pixels (at the centre's pixel size) past the centre
 * each way, plus half a major spacing for the move, at most
 * MAX_GRID_LINES minor lines each way. Null when there is no spacing.
 */
export function sketchGrid(centre: SketchXY, pixel: number, reachPx: number, step: number | null = null): SketchGrid | null {
  const minor = gridSpacing(pixel, step);
  if (minor === null || !centre.every(Number.isFinite) || !(reachPx > 0)) return null;
  const major = GRID_MAJOR * minor;
  const n = Math.min(MAX_GRID_LINES, Math.ceil((reachPx * pixel + major / 2) / minor));
  // The centre as a whole number of minor spacings, on a major line.
  const [cx, cy] = centre.map((c) => GRID_MAJOR * Math.round(c / major));
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cy)) return null;
  const at = (i: number) => i * minor;
  const [x0, x1, y0, y1] = [at(cx - n), at(cx + n), at(cy - n), at(cy + n)];
  const lines: SketchGrid["lines"] = [];
  for (let k = -n; k <= n; k++) {
    const i = cx + k;
    const j = cy + k;
    if (i !== 0) lines.push({ a: [at(i), y0], b: [at(i), y1], major: i % GRID_MAJOR === 0 });
    if (j !== 0) lines.push({ a: [x0, at(j)], b: [x1, at(j)], major: j % GRID_MAJOR === 0 });
  }
  return {
    minor,
    major,
    strength: minorStrength(minor / pixel),
    lines,
    bounds: [x0, x1, y0, y1],
    axes: { x: y0 <= 0 && 0 <= y1 ? [[x0, 0], [x1, 0]] : null, y: x0 <= 0 && 0 <= x1 ? [[0, y0], [0, y1]] : null },
  };
}

/**
 * How big a screen pixel is on the plane at the pointer (mm), for snapping
 * within a few pixels: from where the pointer meets the plane to where the
 * points one pixel right of it and one pixel below it do, the further of
 * the two (under perspective a pixel is longer one way when the plane is
 * seen at a slant). Undefined when any of them misses the plane.
 */
export function pixelSize(at: SketchXY | null, right: SketchXY | null, down: SketchXY | null): number | undefined {
  if (!at || !right || !down) return undefined;
  const far = (p: SketchXY) => Math.sqrt((p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2);
  const size = Math.max(far(right), far(down));
  return size > 0 && Number.isFinite(size) ? size : undefined;
}
