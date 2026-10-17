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

/** How far the grid reaches each way from the plane's origin (mm), unless that would take more than MAX_GRID_LINES lines each way. */
export const GRID_REACH = 200;
export const MAX_GRID_LINES = 100;
/** Every this many lines is drawn brighter. */
export const GRID_MAJOR = 10;

/**
 * The grid's lines in the plane's frame: n = min(MAX_GRID_LINES,
 * ceil(GRID_REACH / spacing)) lines each side of each axis, so 2n + 1
 * lines across and 2n + 1 up, each running from −n·spacing to n·spacing.
 * `major` marks every GRID_MAJOR-th line (the axes included).
 */
export function gridLines(spacing: number): { a: SketchXY; b: SketchXY; major: boolean }[] {
  if (!(spacing > 0) || !Number.isFinite(spacing)) return [];
  const n = Math.min(MAX_GRID_LINES, Math.ceil(GRID_REACH / spacing));
  const end = n * spacing;
  const lines: { a: SketchXY; b: SketchXY; major: boolean }[] = [];
  for (let k = -n; k <= n; k++) {
    const at = k * spacing;
    const major = k % GRID_MAJOR === 0;
    lines.push({ a: [at, -end], b: [at, end], major }, { a: [-end, at], b: [end, at], major });
  }
  return lines;
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
