// The guide's B-rep example: an L-shaped bracket with a rounded inside
// corner and a hole through its base, written out face by face, edge by
// edge, vertex by vertex, the way the kernel's B-rep holds a body
// (kernel/src/topology.rs). The B-rep chapter explodes it; tests check its
// counts against the Euler–Poincaré rule the kernel's validation uses.
//
// Sizes are scene units. x runs across (−W to W); the side profile lies in
// (z, y): z from the back (0) to the front (D), y up.
//
//   y
//   2.6 P6──P5
//       │   │
//   1.35│   P4╮          the corner P3–P4 is a quarter circle of radius R
//   1   │     ╰P3────P2  round (T + R, H1 + R)
//       │             │
//   0   P0───────────P1
//       0   0.8 1.15  2   z

export type Vec3 = [number, number, number];

export const W = 1.5;
export const D = 2;
export const H1 = 1;
export const T = 0.8;
export const H2 = 2.6;
export const R = 0.35;
/** The hole through the base: radius and where its axis crosses the base (x = 0). */
export const HOLE_R = 0.32;
export const HOLE_Z = 1.5;

/** The side profile's corners, in (z, y). */
export const PROFILE: [number, number][] = [
  [0, 0],
  [D, 0],
  [D, H1],
  [T + R, H1],
  [T, H1 + R],
  [T, H2],
  [0, H2],
];
const FILLET_CENTRE: [number, number] = [T + R, H1 + R];

export interface BEdge {
  name: string;
  start: number;
  end: number;
  /** Points along the edge (start to end), for drawing. */
  points: Vec3[];
}

export interface BFace {
  name: string;
  /** Each loop lists its edges; the first loop is the outer one. */
  loops: number[][];
  /** Which way the face moves when the bracket comes apart (its outward side). */
  explode: Vec3;
}

export interface Bracket {
  vertices: Vec3[];
  edges: BEdge[];
  faces: BFace[];
}

const profilePoint = (x: number, i: number): Vec3 => [x, PROFILE[i][1], PROFILE[i][0]];

/** Points along profile segment k (from corner k to k + 1) at side x: a line, or for k = 3 the quarter circle. */
export function segmentPoints(x: number, k: number, steps = 12): Vec3[] {
  if (k !== 3) return [profilePoint(x, k), profilePoint(x, (k + 1) % 7)];
  const out: Vec3[] = [];
  // From P3 (straight below the centre, angle −90°) to P4 (straight behind it, angle −180°).
  for (let s = 0; s <= steps; s++) {
    const a = -Math.PI / 2 - (Math.PI / 2) * (s / steps);
    out.push([x, FILLET_CENTRE[1] + R * Math.sin(a), FILLET_CENTRE[0] + R * Math.cos(a)]);
  }
  out[0] = profilePoint(x, 3);
  out[steps] = profilePoint(x, 4);
  return out;
}

/** A full circle at height y round the hole's axis, starting and ending at its seam (x = HOLE_R). */
export function holeCircle(y: number, steps = 48): Vec3[] {
  const out: Vec3[] = [];
  for (let s = 0; s <= steps; s++) {
    const a = (2 * Math.PI * s) / steps;
    out.push([HOLE_R * Math.cos(a), y, HOLE_Z + HOLE_R * Math.sin(a)]);
  }
  out[steps] = out[0];
  return out;
}

const SEGMENT_NAMES = ["bottom", "front", "base top", "rounded corner", "upright front", "top", "back"];
const SEGMENT_OUT: Vec3[] = [
  [0, -1, 0],
  [0, 0, 1],
  [0, 1, 0.25],
  [0, 0.75, 0.75],
  [0, 0.25, 1],
  [0, 1, 0],
  [0, 0, -1],
];

/**
 * The bracket's B-rep. Vertices 0–6 are the profile's corners on the left
 * side (x = −W), 7–13 on the right, 14 and 15 the seams of the hole's
 * bottom and top circles. Edges: 7 round the left side, 7 round the right,
 * 7 running across (one per corner), the hole's two circles and its seam.
 */
export function bracket(): Bracket {
  const vertices: Vec3[] = [];
  for (const x of [-W, W]) for (let i = 0; i < 7; i++) vertices.push(profilePoint(x, i));
  vertices.push([HOLE_R, 0, HOLE_Z], [HOLE_R, H1, HOLE_Z]);

  const edges: BEdge[] = [];
  for (const [side, x, base] of [["left", -W, 0], ["right", W, 7]] as const)
    for (let k = 0; k < 7; k++) edges.push({ name: `${side} ${SEGMENT_NAMES[k]}`, start: base + k, end: base + ((k + 1) % 7), points: segmentPoints(x, k) });
  for (let i = 0; i < 7; i++) edges.push({ name: `across ${i}`, start: i, end: 7 + i, points: [vertices[i], vertices[7 + i]] });
  const holeBottom = edges.push({ name: "hole bottom", start: 14, end: 14, points: holeCircle(0) }) - 1;
  const holeTop = edges.push({ name: "hole top", start: 15, end: 15, points: holeCircle(H1) }) - 1;
  const seam = edges.push({ name: "hole seam", start: 14, end: 15, points: [vertices[14], vertices[15]] }) - 1;

  const faces: BFace[] = [
    { name: "left side", loops: [[0, 1, 2, 3, 4, 5, 6]], explode: [-1, 0, 0] },
    { name: "right side", loops: [[7, 8, 9, 10, 11, 12, 13]], explode: [1, 0, 0] },
  ];
  for (let k = 0; k < 7; k++) {
    const loop = [k, 14 + ((k + 1) % 7), 7 + k, 14 + k];
    const loops = k === 0 ? [loop, [holeBottom]] : k === 2 ? [loop, [holeTop]] : [loop];
    faces.push({ name: SEGMENT_NAMES[k], loops, explode: SEGMENT_OUT[k] });
  }
  faces.push({ name: "hole", loops: [[holeBottom, seam, holeTop, seam]], explode: [0, -0.55, 0] });
  return { vertices, edges, faces };
}

/** How many times each edge is used by the faces' loops (a closed solid uses each exactly twice). */
export function edgeUses(b: Bracket): number[] {
  const uses = b.edges.map(() => 0);
  for (const f of b.faces) for (const loop of f.loops) for (const e of loop) uses[e]++;
  return uses;
}

/** V − E + F − (inner loops), which is 2 − 2 × (holes through the solid) for one closed skin. */
export function eulerPoincare(b: Bracket): number {
  const rings = b.faces.reduce((n, f) => n + f.loops.length - 1, 0);
  return b.vertices.length - b.edges.length + b.faces.length - rings;
}

/**
 * How far apart the bracket is at scroll progress p: together until 0.15,
 * apart by 0.15–0.6 (eased, so it starts and ends gently), fully apart after.
 */
export function explodeAmount(p: number): number {
  const s = Math.min(1, Math.max(0, (p - 0.15) / 0.45));
  return s * s * (3 - 2 * s);
}
