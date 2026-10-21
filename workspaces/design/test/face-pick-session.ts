// Step 26d: seeded sessions of clicks while Create sketch offers the
// planes, on random scenes, checked against a plain model written here
// apart from Design. Each scene is one to three bodies (refind-session.ts
// `randomBody`: boxes with a face sometimes given another's role,
// cylinders, extrudes whose sides' curves may repeat or be unknown), each
// flat face given an outward normal (along an axis either way, on a 45°
// or three-way tie, or anywhere) and a point of its plane; a cylinder's
// side is curved. Each click names an origin plane, a plane that isn't
// one, nothing, a joined face index (in range or past the last body), or
// a nonsense index. The model:
// - an origin plane (XY, XZ, YZ) is that plane; any other plane, no face,
//   or a face past the last body is nothing;
// - a curved face is refused with CURVED_FACE;
// - a flat face whose name another face shares (or that has none) is
//   refused with UNNAMED_FACE;
// - any other flat face gets a sketch on it named "face:<feature>/<part>",
//   with the frame of rule 8 worked out here by axis and angle (Rodrigues'
//   formula with the angle's sine and cosine, where Design's `turned` uses
//   none), so the two ways must agree to rounding;
// and `sketchableFaces` lists exactly the faces the model sketches on.
// The subject is the functions checked, so a planted copy can stand in
// (face-pick-planted.test.ts).

import type { BodyView, ViewportPick } from "@fission/core";
import * as FacePick from "../src/face-pick.ts";
import * as Naming from "../src/naming.ts";
import type { Scene } from "../src/scene.ts";
import { mulberry32, randomBody, type ModelBody } from "./refind-session.ts";

export interface Subject {
  sketchSpot: typeof FacePick.sketchSpot;
  sketchableFaces: typeof FacePick.sketchableFaces;
}

/** Design's own functions. */
export const REAL: Subject = { ...FacePick };

type Vec3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.sqrt(dot(a, a));
const unitOf = (a: readonly number[]): Vec3 => [a[0] / norm(a), a[1] / norm(a), a[2] / norm(a)];

/** The model's frame for a flat face: rule 8, worked by axis and angle. */
export function modelFrame(outward: Vec3, point: Vec3): { origin: Vec3; x: Vec3; normal: Vec3; side: 1 | -1 } {
  const planes: { x: Vec3; n: Vec3 }[] = [
    { x: [1, 0, 0], n: [0, 0, 1] }, // XY
    { x: [1, 0, 0], n: [0, -1, 0] }, // XZ
    { x: [0, 1, 0], n: [1, 0, 0] }, // YZ
  ];
  // The most nearly parallel origin plane; a tie goes to the first in that order.
  let best = planes[0];
  for (const p of planes.slice(1)) if (Math.abs(dot(outward, p.n)) > Math.abs(dot(outward, best.n))) best = p;
  const side: 1 | -1 = dot(outward, best.n) < 0 ? -1 : 1;
  const u = unitOf(outward);
  const n: Vec3 = [side * u[0], side * u[1], side * u[2]];
  // Turn best.x about the axis best.n × n by the angle between them (Rodrigues: x cosθ + (k × x) sinθ + k (k · x)(1 − cosθ)).
  const axis = cross(best.n, n);
  const sin = norm(axis);
  const cos = dot(best.n, n);
  let x: Vec3 = best.x;
  if (sin > 0) {
    const k = unitOf(axis);
    const kx = cross(k, best.x);
    const kd = dot(k, best.x);
    x = [0, 1, 2].map((i) => best.x[i] * cos + kx[i] * sin + k[i] * kd * (1 - cos)) as Vec3;
  }
  const along = dot(point, n);
  return { origin: [n[0] * along, n[1] * along, n[2] * along], x: unitOf(x), normal: n, side };
}

/** A random outward normal: along an axis either way, on a 45° tie, on a three-way tie, or anywhere. */
function randomNormal(r: () => number): Vec3 {
  const s = () => (r() < 0.5 ? -1 : 1);
  const kind = r();
  if (kind < 0.4) {
    const v: Vec3 = [0, 0, 0];
    v[Math.floor(r() * 3)] = s();
    return v;
  }
  if (kind < 0.55) {
    const v: Vec3 = [0, 0, 0];
    const i = Math.floor(r() * 3);
    v[i] = s() * Math.SQRT1_2;
    v[(i + 1 + Math.floor(r() * 2)) % 3] = s() * Math.SQRT1_2;
    return v;
  }
  if (kind < 0.62) return unitOf([s(), s(), s()]);
  for (;;) {
    const v: Vec3 = [2 * r() - 1, 2 * r() - 1, 2 * r() - 1];
    if (norm(v) > 0.1) return unitOf(v);
  }
}

/** A model body with flat faces given normals and points of their planes; a cylinder's side is curved. */
interface SessionBody extends ModelBody {
  curved: boolean[];
}

function bodyWithFaces(r: () => number, feature: string): SessionBody {
  const b = randomBody(r, feature);
  const isCylinder = b.view.faces === 3 && b.faces[2] === "side";
  const curved = b.faces.map((_, i) => isCylinder && i === 2);
  const normals = curved.map((c) => (c ? null : randomNormal(r)));
  const centroids = curved.map(() => [1000 * r() - 500, 1000 * r() - 500, 1000 * r() - 500]);
  const view = { ...b.view, face_normals: normals, face_centroids: centroids } as BodyView;
  return { ...b, view, curved };
}

/** The scene Design draws for these bodies (meshes left empty: nothing here draws). */
function sceneOf(bodies: readonly SessionBody[]): Scene {
  let f = 0;
  const faceStart: number[] = [];
  const shown = bodies.map((b, i) => {
    faceStart.push(f);
    f += b.view.faces;
    return { feature: b.feature, place: i + 1, view: b.view, names: Naming.nameBody(b.feature, b.view, (_, piece) => b.curves[piece] ?? null) };
  });
  return { bodies: shown, mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] }, faceStart, edgeStart: bodies.map(() => 0) };
}

type ModelSpot = { kind: "plane"; plane: string } | { kind: "refused"; message: string } | { kind: "face"; plane: string; feature: string; frame: ReturnType<typeof modelFrame> } | null;

/** The model's answer for a click. */
function modelSpot(bodies: readonly SessionBody[], pick: ViewportPick): ModelSpot {
  if (pick.plane != null) return ["XY", "XZ", "YZ"].includes(pick.plane) ? { kind: "plane", plane: pick.plane } : null;
  if (pick.face === null || !Number.isInteger(pick.face) || pick.face < 0) return null;
  let start = 0;
  for (const b of bodies) {
    const i = pick.face - start;
    start += b.view.faces;
    if (i >= b.view.faces) continue;
    if (b.curved[i]) return { kind: "refused", message: FacePick.CURVED_FACE };
    const part = b.faces[i];
    if (part === null || b.faces.filter((p) => p === part).length > 1) return { kind: "refused", message: FacePick.UNNAMED_FACE };
    return { kind: "face", plane: `face:${encodeURIComponent(b.feature)}/${part}`, feature: b.feature, frame: modelFrame(b.view.face_normals[i]!, b.view.face_centroids[i] as Vec3) };
  }
  return null;
}

const near = (a: readonly number[], b: readonly number[], eps: number) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

/** What a session reached, so the test can say every case came up. */
export type Reached = Record<string, number>;

/** Feature ids, some with characters a name escapes. */
const FEATURES = ["feature-1", "feature-7", "feature:2", "feature/3", "box 4"];

/**
 * One seeded session: `scenes` random scenes, `clicks` random clicks on
 * each, every answer checked against the model; throws with the seed, the
 * scene and the click at the first difference.
 */
export function runFacePickSession(s: Subject, seed: number, scenes = 30, clicks = 40): Reached {
  const r = mulberry32(seed);
  const reached: Reached = {};
  const hit = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  for (let sc = 0; sc < scenes; sc++) {
    const count = 1 + Math.floor(r() * 3);
    const features = [...FEATURES].sort(() => r() - 0.5).slice(0, count);
    const bodies = features.map((f) => bodyWithFaces(r, f));
    const scene = sceneOf(bodies);
    const total = bodies.reduce((n, b) => n + b.view.faces, 0);
    const fail = (why: string, pick?: ViewportPick) => new Error(`face pick session seed ${seed}, scene ${sc}${pick ? `, click ${JSON.stringify(pick)}` : ""}: ${why}\nbodies: ${JSON.stringify(bodies.map((b) => ({ feature: b.feature, faces: b.faces, normals: b.view.face_normals })))}`);
    // The faces offered to light: exactly the ones the model sketches on.
    const want = [...Array(total).keys()].filter((i) => modelSpot(bodies, { face: i, shift: false })?.kind === "face");
    const got = s.sketchableFaces(scene);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw fail(`sketchableFaces differs from the model: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    if (s.sketchableFaces(null).length !== 0) throw fail("sketchableFaces offers faces with no scene");
    for (let c = 0; c < clicks; c++) {
      const kind = r();
      const pick: ViewportPick =
        kind < 0.1 ? { face: null, plane: ["XY", "XZ", "YZ", "AB", ""][Math.floor(r() * 5)], shift: false }
        : kind < 0.15 ? { face: null, shift: false }
        : kind < 0.2 ? { face: [total, total + 3, -1, 1.5, NaN][Math.floor(r() * 5)], shift: r() < 0.5 }
        : { face: Math.floor(r() * total), edge: null, plane: null, shift: r() < 0.5 };
      const m = modelSpot(bodies, pick);
      const g = s.sketchSpot(pick, scene);
      hit(m === null ? "nothing" : m.kind === "refused" ? (m.message === FacePick.CURVED_FACE ? "curved" : "unnamed") : m.kind === "face" ? `face side ${m.frame.side}` : "plane");
      if (m === null || g === null || m.kind !== g.kind) {
        if (m === null && g === null) continue;
        throw fail(`sketchSpot differs from the model: ${JSON.stringify(g)} vs ${JSON.stringify(m)}`, pick);
      }
      if (m.kind === "plane" && g.kind === "plane" && m.plane !== g.plane) throw fail(`sketchSpot differs from the model: plane ${g.plane} vs ${m.plane}`, pick);
      if (m.kind === "refused" && g.kind === "refused" && m.message !== g.message) throw fail(`sketchSpot differs from the model: refused "${g.message}" vs "${m.message}"`, pick);
      if (m.kind === "face" && g.kind === "face") {
        if (g.face.plane !== m.plane || g.face.feature !== m.feature) throw fail(`sketchSpot differs from the model: on ${g.face.plane} of ${g.face.feature} vs ${m.plane} of ${m.feature}`, pick);
        const p = g.drawn.plane;
        const e = m.frame;
        // Doubles, worked two ways: to rounding (origins up to ~870 mm out).
        if (g.drawn.side !== e.side || !near(p.normal, e.normal, 1e-14) || !near(p.xAxis, e.x, 1e-12) || !near(p.origin, e.origin, 1e-11)) {
          throw fail(`the frame differs from the model: ${JSON.stringify(g.drawn)} vs ${JSON.stringify(e)}`, pick);
        }
        // What the frame promises, apart from how either worked it out: the sketch's side faces outward,
        // its axes unit and square (within the kernel's FRAME_SQUARE, 64 ulps), its origin on the face's plane.
        const body = bodies.find((b) => b.feature === m.feature)!;
        const face = (pick.face as number) - scene.faceStart[bodies.indexOf(body)];
        const outward = body.view.face_normals[face]!;
        const point = body.view.face_centroids[face];
        if (Math.abs(g.drawn.side * dot(p.normal, outward) - 1) > 1e-14) throw fail(`the sketch does not face out of the body: ${JSON.stringify(g.drawn)}`, pick);
        if (Math.abs(dot(p.origin, p.normal) - dot(point, p.normal)) > 1e-10) throw fail(`the frame's origin is off the face's plane: ${JSON.stringify(g.drawn)}`, pick);
        const ulps = 64 * Number.EPSILON;
        if (Math.abs(norm(p.normal) - 1) > ulps || Math.abs(norm(p.xAxis) - 1) > ulps || Math.abs(dot(p.normal, p.xAxis)) > ulps) throw fail(`the frame is not unit and square: ${JSON.stringify(p)}`, pick);
      }
    }
  }
  return reached;
}
