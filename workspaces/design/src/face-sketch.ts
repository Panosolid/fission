// Sketches on a body's flat face (step 26c; the owner's answers Q1 to Q6,
// docs/progress/cad.md, "Sketch on a face test plan (26a)"). The rules are
// the naming model's (packages/testing/src/naming-model.ts, rules 1, 2, 6,
// 7 and 8), the oracle Design is checked against on the real kernel
// (packages/testing/journeys/naming.journey.ts):
//
// - The sketch item names its face as a reference does
//   ("face:feature-2/end", "face:feature-2/side:line-4"; references.ts);
//   its content keeps the frame it was drawn with and its side, and holds
//   a placement (`held`) only while that name finds no face or two.
// - Its coordinates are the world's (Q2): the frame is the origin plane
//   (XY, then XZ, then YZ on a tie) most nearly parallel to the face when
//   drawn, turned onto the face the shortest way, its origin where the
//   world's origin meets the face's plane square on. On a back or bottom
//   face the frame's normal points into the body and the sketch faces
//   against it (side −1), so its x and y still read as the world's.
// - On every rebuild the frame turns with the face the shortest way from
//   the frame as drawn (never from the last one: two shortest turns are
//   not one), keeping the side of the face its normal was on.
//
// Every frame is worked out in doubles and squared up (unit axes, x square
// to the normal) before the kernel sees it: the kernel refuses a frame off
// by more than 64 ulps (FRAME_SQUARE, kernel/src/tolerance.rs).

import type { BodyView, Feature, GeometryReference, Plane, StableId } from "@fission/core";
import { readDesignReference } from "./references.ts";

type Vec3 = [number, number, number];

/** Where a sketch lies: its frame, and which way it faces against the frame's normal (+1 along it, −1 against). */
export interface SketchPlacement {
  plane: Plane;
  side: 1 | -1;
}

/** Why a face sketch is held at its last placement: its face's name finds no face, or two. */
export type PlaneCause = "plane-lost" | "plane-ambiguous";

/** A face sketch's plane warning: the cause, the face's name (the sketch item's `plane`), and words for the app. */
export interface PlaneWarning {
  cause: PlaneCause;
  face: string;
  message: string;
}

/**
 * Where a sketch on a face was drawn, kept with its content (document.ts
 * `Sketch.face`; its timeline item's `plane` names the face): the frame as
 * drawn, its side, and the placement it holds while the face is lost.
 */
export interface SketchFace {
  frame: Plane;
  side: 1 | -1;
  held?: Plane;
}

/** The origin planes in the order a tie is broken (sketch.ts PLANES; the model's ORIGIN_FRAMES). */
const ORIGIN_FRAMES: readonly { x: Vec3; normal: Vec3 }[] = [
  { x: [1, 0, 0], normal: [0, 0, 1] },
  { x: [1, 0, 0], normal: [0, -1, 0] },
  { x: [0, 1, 0], normal: [1, 0, 0] },
];

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// `+ 0` turns −0 into 0, so a frame written to a file reads back equal.
const scale = (a: readonly number[], k: number): Vec3 => [a[0] * k + 0, a[1] * k + 0, a[2] * k + 0];
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit = (a: readonly number[]): Vec3 => scale(a, 1 / Math.sqrt(dot(a, a)));
const sign = (x: number): 1 | -1 => (x < 0 ? -1 : 1);

/**
 * `v` turned by the shortest rotation taking unit `from` to unit `to`
 * (Rodrigues without the angle: with c = from · to and w = from × to,
 * R v = c v + w × v + (w · v) w / (1 + c)); only used with c ≥ 0, so
 * 1 + c ≥ 1 and nothing is divided by a small number.
 */
export function turned(v: readonly number[], from: readonly number[], to: readonly number[]): Vec3 {
  const c = dot(from, to);
  const w = cross(from, to);
  return add(add(scale(v, c), cross(w, v)), scale(w, dot(w, v) / (1 + c)));
}

/**
 * The frame squared up in doubles: the normal made unit, x made square to
 * it (its part along the normal taken off) and unit. Null when the normal
 * is nothing or x lies along it, so no frame can be made (a hand-edited
 * file); anything else comes out within a few ulps of unit and square.
 */
export function squared(p: Plane): Plane | null {
  const nn = dot(p.normal, p.normal);
  if (!(nn > 0) || !Number.isFinite(nn)) return null;
  const n = unit(p.normal);
  const x = add(p.xAxis, scale(n, -dot(p.xAxis, n)));
  const xx = dot(x, x);
  if (!(xx > 0) || !Number.isFinite(xx)) return null;
  return { origin: [p.origin[0] + 0, p.origin[1] + 0, p.origin[2] + 0], xAxis: unit(x), normal: n };
}

/**
 * The frame a sketch drawn on a flat face gets (rule 8), from the face's
 * outward unit normal and a point of its plane (the kernel's face_normals
 * and face_centroids): the origin plane whose normal is most nearly along
 * the face's (the largest |outward · normal|; a tie goes to the first of
 * XY, XZ, YZ), its normal turned onto the face the shortest way on the
 * origin plane's side; its origin the plane's nearest point to the
 * world's origin. `side` is +1 when the face looks along that normal.
 */
export function drawnFrame(outward: readonly number[], point: readonly number[]): SketchPlacement {
  let best = ORIGIN_FRAMES[0];
  for (const f of ORIGIN_FRAMES) if (Math.abs(dot(outward, f.normal)) > Math.abs(dot(outward, best.normal))) best = f;
  const side = sign(dot(outward, best.normal));
  const normal = scale(unit(outward), side);
  const plane = squared({ origin: scale(normal, dot(point, normal)), xAxis: turned(best.x, best.normal, normal), normal })!;
  return { plane, side };
}

/**
 * The frame a sketch drawn on face `face` of a built body gets
 * (`drawnFrame` on the kernel's exact face_normals and face_centroids);
 * null for a curved face, which can't be sketched on (Q5).
 */
export function drawnOnFace(view: BodyView, face: number): SketchPlacement | null {
  const outward = view.face_normals[face];
  return outward ? drawnFrame(outward, view.face_centroids[face]) : null;
}

/**
 * Where the frame drawn as `drawn` lies now that its face's outward unit
 * normal is `outward` and `point` is on its plane (rule 8): the normal is
 * ±outward, on the side the drawn normal was (exactly square, the outward
 * one), x turned the shortest way from the drawn frame's, and the origin
 * the plane's nearest point to the world's origin.
 */
export function frameNow(drawn: Plane, outward: readonly number[], point: readonly number[]): Plane {
  const n = scale(unit(outward), sign(dot(drawn.normal, outward)));
  return squared({ origin: scale(n, dot(point, n)), xAxis: turned(drawn.xAxis, drawn.normal, n), normal: n })!;
}

/** Whether a sketch item's plane is a face's name, not an origin plane. */
export const isFacePlane = (plane: unknown): plane is string => typeof plane === "string" && plane.startsWith("face:");

/** Whether a timeline item is a sketch on a face. */
export const isFaceSketch = (f: Feature): boolean => f.intent.type === "sketch" && isFacePlane(f.intent.parameters.plane);

/** The reference a face sketch's plane names its face with. */
export const faceReference = (plane: string): GeometryReference => ({ kind: "face", id: plane as StableId });

/**
 * The id of the feature whose face a face sketch's plane names (names
 * escape ids with encodeURIComponent, naming.ts), or null when the plane
 * is not a face reference Design makes.
 */
export function faceFeature(plane: string): string | null {
  const r = readDesignReference(faceReference(plane));
  if (r === null || r.kind !== "face") return null;
  try {
    return decodeURIComponent(r.featureId);
  } catch {
    return null;
  }
}

/** The plane of a face as a sketch's `plane` names it: "face:" + the feature's escaped id + "/" + the face's part ("end", "side:line-4"). */
export const facePlane = (escapedFeature: string, part: string): string => `face:${escapedFeature}/${part}`;

/** The kernel's frame for a plane: its origin, x axis and normal. */
export const frameOf = (p: Plane): { origin: Vec3; x: Vec3; normal: Vec3 } => ({ origin: [...p.origin], x: [...p.xAxis], normal: [...p.normal] });

/** The words for a face sketch's plane warning, naming the sketch and the face it held. */
export function planeWords(cause: PlaneCause, sketchLabel: string): string {
  return cause === "plane-lost"
    ? `${sketchLabel}'s face is gone, so its plane is lost: it stays where it was`
    : `${sketchLabel}'s face is now more than one face, so its plane is ambiguous: it stays where it was rather than guess`;
}
