import type { CornerView, ViewName } from "@fission/core";
import type { Framing } from "./framing.ts";

type Vec3 = [number, number, number];

export type { CornerView, ViewName };

/** The eight corners of the view cube, as (x, y, z) signs: front is −Y, right is +X, top is +Z. */
const CORNERS: Record<CornerView, Vec3> = {
  "top-front-left": [-1, -1, 1],
  "top-front-right": [1, -1, 1],
  "top-back-left": [-1, 1, 1],
  "top-back-right": [1, 1, 1],
  "bottom-front-left": [-1, -1, -1],
  "bottom-front-right": [1, -1, -1],
  "bottom-back-left": [-1, 1, -1],
  "bottom-back-right": [1, 1, -1],
};

/** Direction from the target to the camera, and the screen's up, per view (Z is up in the model). */
const VIEWS: Record<ViewName, { towardCamera: Vec3; up: Vec3 }> = {
  home: { towardCamera: [0.6, -0.8, 0.55], up: [0, 0, 1] },
  top: { towardCamera: [0, 0, 1], up: [0, 1, 0] }, // looking down −Z, +Y up on screen
  bottom: { towardCamera: [0, 0, -1], up: [0, -1, 0] }, // looking up +Z, the front (−Y) at the top of the screen, +X to the right
  front: { towardCamera: [0, -1, 0], up: [0, 0, 1] }, // from −Y looking along +Y, +X to the right
  back: { towardCamera: [0, 1, 0], up: [0, 0, 1] }, // from +Y looking along −Y, −X to the right
  left: { towardCamera: [-1, 0, 0], up: [0, 0, 1] }, // from −X looking along +X, −Y to the right
  right: { towardCamera: [1, 0, 0], up: [0, 0, 1] }, // from +X looking along −X, +Y to the right
  ...(Object.fromEntries(Object.entries(CORNERS).map(([name, d]) => [name, { towardCamera: d, up: [0, 0, 1] }])) as Record<CornerView, { towardCamera: Vec3; up: Vec3 }>),
};

/** Every view: home, the six faces, the eight corners. */
export const VIEW_NAMES = Object.keys(VIEWS) as readonly ViewName[];

/** Direction from the target to the camera for a view (not normalised; corners are (±1, ±1, ±1)). */
export function viewDirection(name: ViewName): Vec3 {
  return [...VIEWS[name].towardCamera];
}

/** Where the camera sits, what it looks at, and which way is up on screen. */
export interface ViewBasis {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/**
 * How far from a sphere's centre a camera must sit for the sphere to just
 * fit the narrower of its two fields of view: `radius / sin(half-angle)`,
 * where the half-angle is half the vertical fov (degrees), or on a canvas
 * taller than wide (aspect = width / height < 1) the horizontal half-angle
 * atan(tan(fov / 2) × aspect).
 */
export function fitDistance(radius: number, fovDeg: number, aspect = 1): number {
  const half = (fovDeg * Math.PI) / 360;
  const narrower = aspect < 1 ? Math.atan(Math.tan(half) * aspect) : half;
  return radius / Math.sin(narrower);
}

/**
 * The camera for a standard view of a framed sphere: it looks at the centre
 * from `fitDistance` away, so the sphere just fits the canvas whatever its
 * shape (vertical fov in degrees, aspect = width / height).
 */
export function viewBasis(name: ViewName, framing: Framing, fovDeg = 45, aspect = 1): ViewBasis {
  const { towardCamera, up } = VIEWS[name];
  const n = Math.hypot(...towardCamera);
  const dist = fitDistance(framing.radius, fovDeg, aspect);
  const target: Vec3 = [...framing.centre];
  const position = target.map((c, i) => c + (towardCamera[i] / n) * dist) as Vec3;
  return { position, target, up: [...up] };
}

/**
 * The camera's offset from its target, made safe for an orbit about Z:
 * straight up or down the orbit cannot tell the camera's roll, so the offset
 * is nudged by 1e-6 of its length so that Z, seen from there, points along
 * the view's up on screen. Looking down, that is a step against up (the
 * camera leans back from the top of the screen); looking up, a step along it.
 */
export function orbitSafeOffset(offset: Vec3, up: Vec3): Vec3 {
  const dist = Math.hypot(...offset);
  if (Math.hypot(offset[0], offset[1]) !== 0 || dist === 0) return [...offset];
  const s = -1e-6 * offset[2]; // −1e-6·dist looking down, +1e-6·dist looking up
  return [offset[0] + s * up[0], offset[1] + s * up[1], offset[2] + s * up[2]];
}

/**
 * How far from a face's centre (the cube spans −1…1) a hit counts as its
 * corner: the outer 0.4 of each half-side, both ways, is a corner square.
 */
export const CUBE_CORNER = 0.6;

/**
 * The view a click on the view cube asks for, from the hit point on the
 * cube's surface (cube coordinates −1…1, model axes): the face the point is
 * on, or the corner when both of its other coordinates are at least
 * CUBE_CORNER out. Null for a point that is not on the cube's surface.
 */
export function cubeView(p: readonly number[]): ViewName | null {
  if (p.length !== 3 || !p.every(Number.isFinite)) return null;
  const abs = p.map(Math.abs);
  const k = abs.indexOf(Math.max(...abs));
  if (Math.abs(abs[k] - 1) > 1e-3) return null; // inside or outside the cube, not on it
  const sign = (i: number) => (p[i] < 0 ? -1 : 1);
  if ([0, 1, 2].every((i) => i === k || abs[i] >= CUBE_CORNER)) {
    return `${sign(2) > 0 ? "top" : "bottom"}-${sign(1) < 0 ? "front" : "back"}-${sign(0) < 0 ? "left" : "right"}`;
  }
  const faces: [ViewName, ViewName][] = [["left", "right"], ["front", "back"], ["bottom", "top"]];
  return faces[k][sign(k) < 0 ? 0 : 1];
}
