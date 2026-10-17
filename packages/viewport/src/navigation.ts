// Moving the camera by hand (sketch feel SF3a): zoom toward the cursor and
// pan that keeps the grabbed point under the pointer. Plain vectors and
// numbers, no Three.js, so the maths is tested on its own.
//
// The focus plane is the plane through the orbit target square to the
// view direction: what the camera is looking at. Its point under the
// cursor is the one a zoom or a pan holds still on screen.

export type Vec3 = [number, number, number];

/** A perspective camera: where it is, what it looks at, and its screen's up (any vector not along the view; only its part square to the view counts). */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/** The camera's lens: vertical field of view in degrees, and the canvas's width / height. */
export interface Lens {
  fov: number;
  aspect: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.sqrt(dot(a, a)));

/** The camera's unit frame: forward (camera → target), right, the screen's up, and the distance to the target. */
export function cameraFrame(pose: CameraPose): { forward: Vec3; right: Vec3; up: Vec3; distance: number } {
  const toTarget = sub(pose.target, pose.position);
  const distance = Math.sqrt(dot(toTarget, toTarget));
  const forward = scale(toTarget, 1 / distance);
  const right = unit(cross(forward, pose.up));
  return { forward, right, up: cross(right, forward), distance };
}

/**
 * The point of the focus plane under a cursor at normalised device
 * coordinates (−1…1 across the canvas, +y up). The ray through the cursor
 * is forward + x·t·aspect·right + y·t·up with t = tan(fov/2); its forward
 * part is 1, so it meets the focus plane, `distance` ahead, at distance
 * times that vector from the camera.
 */
export function focusPoint(pose: CameraPose, ndc: readonly [number, number], lens: Lens): Vec3 {
  const { forward, right, up, distance } = cameraFrame(pose);
  const t = Math.tan((lens.fov * Math.PI) / 360);
  const ray = add(forward, add(scale(right, ndc[0] * t * lens.aspect), scale(up, ndc[1] * t)));
  return add(pose.position, scale(ray, distance));
}

/**
 * Zoom toward the cursor: the camera and its target both scale about the
 * focus point P under the cursor by `factor` (the new distance to the
 * target over the old; below 1 zooms in). Scaling about P keeps the
 * direction from the camera to P, so P stays under the cursor, and the
 * camera keeps its direction, so nothing turns.
 */
export function zoomAt(pose: CameraPose, ndc: readonly [number, number], lens: Lens, factor: number): CameraPose {
  const p = focusPoint(pose, ndc, lens);
  return { position: add(p, scale(sub(pose.position, p), factor)), target: add(p, scale(sub(pose.target, p), factor)), up: pose.up };
}

/**
 * Millimetres on the focus plane per screen pixel: the canvas's height
 * spans 2·distance·tan(fov/2) there.
 */
export function focusPixel(distance: number, fovDegrees: number, heightPx: number): number {
  return (2 * distance * Math.tan((fovDegrees * Math.PI) / 360)) / heightPx;
}

/**
 * Pan by a pointer move of (dx, dy) screen pixels (+y down, as client
 * coordinates run): the camera and target move together, opposite to the
 * pointer, so the focus plane's point under the pointer follows it exactly.
 */
export function panBy(pose: CameraPose, dx: number, dy: number, lens: Lens, heightPx: number): CameraPose {
  const { right, up, distance } = cameraFrame(pose);
  const mm = focusPixel(distance, lens.fov, heightPx);
  const move = add(scale(right, -dx * mm), scale(up, dy * mm));
  return { position: add(pose.position, move), target: add(pose.target, move), up: pose.up };
}

/** How fast the wheel zooms: the distance changes by e^(ZOOM_PER_PIXEL · pixels scrolled); one 100 px notch is ×1.22. */
export const ZOOM_PER_PIXEL = 0.002;
/** Pinch (a trackpad pinch arrives as a wheel event with Ctrl held) sends small deltas, so it counts this many times more. */
export const PINCH_BOOST = 5;
/** A wheel's line and page modes in pixels (WheelEvent.deltaMode 1 and 2). */
export const LINE_PX = 16;
export const PAGE_PX = 800;
/** One event never zooms by more than this either way, so a fast flick or a broken delta can't throw the camera away. */
export const MAX_STEP = 4;

/**
 * The zoom factor for one wheel event: scrolling away from you (deltaY
 * below 0) zooms in. A delta that isn't a finite number zooms nothing.
 */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  if (!Number.isFinite(deltaY)) return 1;
  const px = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1);
  const factor = Math.exp(px * ZOOM_PER_PIXEL * (pinch ? PINCH_BOOST : 1));
  return Math.min(MAX_STEP, Math.max(1 / MAX_STEP, factor));
}

/** The zoom factor for a drag in Zoom mode: dragging up (dy below 0) zooms in, at the wheel's rate. */
export function dragZoomFactor(dy: number): number {
  return wheelFactor(dy, 0, false);
}

/** Keeps a zoom inside the view's allowed distances: the factor that lands `distance` within [min, max]. */
export function clampZoom(distance: number, factor: number, min: number, max: number): number {
  const wanted = distance * factor;
  if (wanted < min) return min / distance;
  if (wanted > max) return max / distance;
  return factor;
}

/** What a left-button drag does: orbit (the default), pan or zoom; picked on the navigation bar. */
export type NavMode = "orbit" | "pan" | "zoom";
export const NAV_MODES: readonly NavMode[] = ["orbit", "pan", "zoom"];

/**
 * What a press starts, from its button and Shift: middle pans and
 * Shift+middle orbits (whatever the mode), left does the mode's move. The
 * right button moves nothing: it is kept for a menu (owner's answer,
 * 2026-10-17).
 */
export function dragAction(button: number, shift: boolean, mode: NavMode): NavMode | null {
  if (button === 1) return shift ? "orbit" : "pan";
  if (button === 0) return mode;
  return null;
}

/** How close to straight down or straight up an orbit may tilt (radians), as OrbitControls keeps it: exactly at the pole the view's turn is undefined. */
export const POLE_EPS = 1e-6;

/**
 * Orbit about the target with Z up (the kernel's up): the camera's
 * direction from the target in spherical angles, θ round Z from +X and φ
 * down from +Z, turned by dTheta and tilted by dPhi, φ kept within
 * [POLE_EPS, π − POLE_EPS]. The distance and the target stay.
 */
export function orbitBy(pose: CameraPose, dTheta: number, dPhi: number): CameraPose {
  const o = sub(pose.position, pose.target);
  const r = Math.sqrt(dot(o, o));
  const theta = Math.atan2(o[1], o[0]) + dTheta;
  const phi = Math.min(Math.PI - POLE_EPS, Math.max(POLE_EPS, Math.acos(Math.max(-1, Math.min(1, o[2] / r))) + dPhi));
  const s = Math.sin(phi);
  return { position: add(pose.target, [r * s * Math.cos(theta), r * s * Math.sin(theta), r * Math.cos(phi)]), target: pose.target, up: [0, 0, 1] };
}

/** Dragging the view cube orbits half a turn per this many pixels (about the cube's own width, so the cube follows the pointer roughly). */
export const CUBE_HALF_TURN_PX = 100;

/**
 * The orbit for a drag of (dx, dy) pixels on the view cube: as OrbitControls
 * turns for a drag on the view, the scene follows the pointer: right turns
 * the camera the other way round Z (θ falls), down tilts it up toward the
 * top (φ falls).
 */
export function cubeDragAngles(dx: number, dy: number): { dTheta: number; dPhi: number } {
  const k = Math.PI / CUBE_HALF_TURN_PX;
  return { dTheta: -dx * k, dPhi: -dy * k };
}
