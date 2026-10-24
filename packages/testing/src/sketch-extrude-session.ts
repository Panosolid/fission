// Seeded sketch-and-extrude sessions on the real kernel: a simulated user
// draws closed shapes with Design's own tools (line chains, 3-point arcs,
// rectangles, circles; corners on a grid or placed freely, closing clicks
// landing on the first corner exactly, as the endpoint snap puts them),
// then extrudes them, types new distances, moves corners, deletes and
// redraws sides, swaps in a preset, saves and opens the file again. After
// every step the part is built the way Design builds it and checked
// against a model kept here, written apart from Design and the kernel:
// - each shape is its corners and, per side, the sagitta of its arc (0 a
//   line), signed to the right of the drawing direction;
// - area = |shoelace + Σ ±r²(φ − sin φ)/2| (each arc's circular segment,
//   added when it bulges to the right, as a counter-clockwise loop's
//   outside is), with r = (h² + s²)/(2|s|) and φ = 4·atan(|s|/h) from the
//   half chord h and sagitta s, not from the centre Design works out;
// - volume = area × distance, surface area = 2·area + perimeter × distance;
// - n sides give 2n vertices, 3n edges and n + 2 faces (a circle 2, 2, 3);
// - a sketch with a side deleted is refused, in the kernel's words.
// The model only predicts shapes it is sure of: a loop is used only when
// its sides, sampled finely, stay clear of each other by a margin larger
// than the sampling error (`clearlySimple`), and no corner is near a cusp
// or near straight. Anything else is drawn again from the next numbers.
//
// Until booleans (steps 35-39) an extrude replaces the part, so that is
// what the model expects; "Join" gets its own model when step 39 lands.
//
// A session is fixed by its seed: `runSession(kernel, { seed, steps })`
// replays it exactly, and a failure names the seed and the steps so far.
// `FAULTS` are planted bugs (a Design bug or a kernel bug, simulated in
// the driver) that the journey shows each check catching.

import { emptyProject, projectFromJson, projectToJson, type BodyHandle, type BodySpec, type BodyView, type KernelCalls, type Outline } from "@fission/core";
import {
  addSketch,
  buildSpec,
  clickAt,
  deleteCurve,
  designWorkspace,
  extrudeSketch,
  featureSpec,
  lastFeature,
  movePoint,
  partDocument,
  pointAt,
  setExtrudeDistance,
  startTool,
  switchTool,
  withPart,
  type DesignDocument,
  type SketchTool,
} from "@fission/design";
import { seeded, type SeededRandom } from "./index.ts";

type XY = readonly [number, number];

/** A closed loop as the model keeps it: corners in drawing order and each side's sagitta (side i runs from corner i to i + 1). */
export interface LoopShape {
  kind: "loop";
  corners: XY[];
  sagitta: number[];
}
export interface CircleShape {
  kind: "circle";
  centre: XY;
  through: XY;
}
export type Shape = LoopShape | CircleShape;

/** Planted bugs, each standing in for a real one in Design or the kernel. */
export const FAULTS = {
  /** The 3-point arc's third click lands mirrored across the chord, as if arcThrough picked the wrong side. */
  arcOtherSide: "the arc tool bends the other way",
  /** A typed distance is dropped, as if the panel never stored it. */
  distanceDropped: "a typed extrude distance is lost",
  /** The click closing a loop lands 1 µm off the first corner, as if the endpoint snap missed it. */
  closeMissed: "the closing click misses the first corner",
  /** The kernel's volume is 2e-9 too big: just past the comparer's 1e-9. */
  volumeOff: "the kernel's volume is off by 2e-9",
  /** Saving and opening the file loses the last side of every sketch. */
  saveLosesSide: "saving loses a sketch's last side",
} as const;
export type Fault = keyof typeof FAULTS;

/** How close the kernel's volume and area must be to the model's, relative. */
export const MATCH_REL = 1e-9;

export const matches = (got: number, want: number): boolean => Math.abs(got - want) <= MATCH_REL * Math.max(1, Math.abs(want));

// ---------------------------------------------------------------------------
// The model

/** Half chord h, radius r and turn φ of an arc of sagitta s over a chord of half length h; φ = 4·atan(|s|/h) (the inscribed angle at the chord's end is half the turn, and tan of a quarter turn is s/h). */
export function arcOf(a: XY, b: XY, s: number): { h: number; r: number; phi: number } {
  const h = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) / 2;
  return { h, r: (h * h + s * s) / (2 * Math.abs(s)), phi: 4 * Math.atan(Math.abs(s) / h) };
}

/** The point an arc of sagitta s passes through midway: the chord's middle moved s to the right of a → b. */
export function apex(a: XY, b: XY, s: number): [number, number] {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.sqrt(dx * dx + dy * dy);
  return [(a[0] + b[0]) / 2 + (dy / len) * s, (a[1] + b[1]) / 2 - (dx / len) * s];
}

/** The model's numbers for a shape: area, perimeter, and the vertices, edges and faces of its extrusion. */
export function measureShape(shape: Shape): { area: number; perimeter: number; vertices: number; edges: number; faces: number } {
  if (shape.kind === "circle") {
    const r = Math.sqrt((shape.through[0] - shape.centre[0]) ** 2 + (shape.through[1] - shape.centre[1]) ** 2);
    return { area: Math.PI * r * r, perimeter: 2 * Math.PI * r, vertices: 2, edges: 2, faces: 3 };
  }
  const { corners: c, sagitta } = shape;
  const n = c.length;
  let twice = 0;
  let segments = 0;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [c[i], c[(i + 1) % n]];
    twice += a[0] * b[1] - b[0] * a[1];
    const s = sagitta[i];
    if (s === 0) {
      perimeter += Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      continue;
    }
    const { r, phi } = arcOf(a, b, s);
    // A bulge to the right of a → b adds to a counter-clockwise loop's area
    // and takes from a clockwise one's; either way it adds to the signed
    // area (shoelace positive counter-clockwise), so the sign is s's.
    segments += Math.sign(s) * (r * r * (phi - Math.sin(phi))) / 2;
    perimeter += r * phi;
  }
  return { area: Math.abs(twice / 2 + segments), perimeter, vertices: 2 * n, edges: 3 * n, faces: n + 2 };
}

/** A side as short straight pieces, with the largest gap between them and the true curve. */
function sampled(a: XY, b: XY, s: number): { pts: XY[]; error: number } {
  if (s === 0) return { pts: [a, b], error: 0 };
  const { r, phi } = arcOf(a, b, s);
  const k = 2 + Math.ceil(phi / 0.05);
  // The centre: r − |s| from the chord's middle, on the side away from the bulge.
  const m = apex(a, b, 0);
  const p = apex(a, b, s);
  const [ux, uy] = [(m[0] - p[0]) / Math.abs(s), (m[1] - p[1]) / Math.abs(s)];
  const centre: XY = [p[0] + ux * r, p[1] + uy * r];
  const t0 = Math.atan2(a[1] - centre[1], a[0] - centre[0]);
  // A bulge to the right of a → b curves left all the way round: counter-clockwise round the centre.
  const ccw = s > 0;
  const pts: XY[] = [a];
  for (let j = 1; j < k; j++) {
    const t = t0 + (ccw ? 1 : -1) * (phi * j) / k;
    pts.push([centre[0] + r * Math.cos(t), centre[1] + r * Math.sin(t)]);
  }
  pts.push(b);
  return { pts, error: r * (1 - Math.cos(phi / (2 * k))) };
}

const normalise = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

function segmentDistance(p: XY, q: XY, r: XY, s: XY): number {
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const [d1, d2, d3, d4] = [cross(r, s, p), cross(r, s, q), cross(p, q, r), cross(p, q, s)];
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const toSeg = (x: XY, a: XY, b: XY) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((x[0] - a[0]) * dx + (x[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.sqrt((a[0] + t * dx - x[0]) ** 2 + (a[1] + t * dy - x[1]) ** 2);
  };
  return Math.min(toSeg(p, r, s), toSeg(q, r, s), toSeg(r, p, q), toSeg(s, p, q));
}

/**
 * Whether a loop is certainly one the kernel takes: no corner near a cusp
 * (turning less than 0.1 rad short of straight back) or near straight on
 * (turning under 0.02 rad, which would make two faces in one plane), no
 * arc turning more than 5 rad, and every two sides, as fine straight
 * pieces, further apart than 1e-3 of the loop's size plus the pieces'
 * own gap to the true curves (next-door sides: away from the corner they
 * share, past their first piece).
 */
export function clearlySimple(shape: LoopShape): boolean {
  const { corners: c, sagitta } = shape;
  const n = c.length;
  const sides = c.map((a, i) => sampled(a, c[(i + 1) % n], sagitta[i]));
  if (sagitta.some((s, i) => s !== 0 && arcOf(c[i], c[(i + 1) % n], s).phi > 5)) return false;
  const xs = sides.flatMap((s) => s.pts.map((p) => p[0]));
  const ys = sides.flatMap((s) => s.pts.map((p) => p[1]));
  const size = Math.sqrt((Math.max(...xs) - Math.min(...xs)) ** 2 + (Math.max(...ys) - Math.min(...ys)) ** 2);
  const error = Math.max(...sides.map((s) => s.error));
  const margin = 1e-3 * size + 2 * error;
  // Side i's direction where it starts or ends: its chord's, turned by half
  // the arc's turn, towards its bulge at the start and away at the end (an
  // arc bulging to the right curves left).
  const way = (i: number, end: boolean) => {
    const [a, b] = [c[i], c[(i + 1) % n]];
    const chord = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (sagitta[i] === 0) return chord;
    const half = (Math.sign(sagitta[i]) * arcOf(a, b, sagitta[i]).phi) / 2;
    return end ? chord + half : chord - half;
  };
  for (let i = 0; i < n; i++) {
    // The turn at corner i + 1, from side i's way in to side i + 1's way
    // out: the arcs' true tangents, not their first and last pieces, which
    // are off by half a piece's turn (up to 0.025 rad). Measured on the
    // pieces, a line and an arc turning 4.2e-5 rad passed the near-straight
    // guard; the arc came parallel to the line r·4.2e-5 = 7e-4 mm past their
    // corner, and the kernel refused them as closer than 1 µm (issue #140).
    const turn = Math.abs(normalise(way((i + 1) % n, false) - way(i, true) + Math.PI) - Math.PI);
    if (turn > Math.PI - 0.1 || turn < 0.02) return false;
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const [p, q] = [sides[i].pts, sides[j].pts];
      // Next-door sides touch at their shared corner, so the two pieces
      // that meet there are not compared; every other pair is. Two pieces
      // from one point meet nowhere else unless they double back, which
      // the turn check refuses, and curves leaving a corner at least 0.1
      // rad apart only meet again ~0.1 r out, far past the few-error
      // reach of their pieces' sag. (Leaving out an arc's whole first piece
      // instead, as before, hid two arcs crossing 1.5 mm from their 6°
      // corner, inside the 2.5 mm piece; issue #140.)
      const last = (pts: XY[]) => pts.length - 2;
      const meet = (u: number, v: number) => (j === i + 1 && u === last(p) && v === 0) || (i === 0 && j === n - 1 && u === 0 && v === last(q));
      for (let u = 0; u + 1 < p.length; u++)
        for (let v = 0; v + 1 < q.length; v++) if (!meet(u, v) && segmentDistance(p[u], p[u + 1], q[v], q[v + 1]) <= margin) return false;
    }
  return true;
}

// ---------------------------------------------------------------------------
// Random shapes and clicks

/** A corner: on a random grid (snapped by the kernel, as Design snaps clicks) half the time, else placed freely. */
async function placer(kernel: KernelCalls, r: SeededRandom): Promise<(x: number, y: number) => Promise<XY>> {
  const grid = [0, 0.5, 1, 2.5, 10][Math.floor(r.next() * 5)];
  if (grid === 0) return async (x, y) => [x, y];
  return async (x, y) => (await kernel.call("snap_to_grid", x, y, grid)) as XY;
}

/** A star-shaped loop round a random centre, some sides bent into arcs either way, drawn from any corner in either direction. */
async function randomLoop(kernel: KernelCalls, r: SeededRandom): Promise<LoopShape> {
  for (;;) {
    const place = await placer(kernel, r);
    const n = 3 + Math.floor(r.next() * 6);
    const centre: XY = [(r.next() - 0.5) * 800, (r.next() - 0.5) * 800];
    const size = 5 + r.next() * 60;
    let t = r.next() * 2 * Math.PI;
    const w = Array.from({ length: n }, () => 0.3 + r.next());
    const sum = w.reduce((a, b) => a + b, 0);
    const corners: XY[] = [];
    for (const g of w) {
      t += (g / sum) * 2 * Math.PI;
      const radius = size * (0.4 + 0.6 * r.next());
      corners.push(await place(centre[0] + radius * Math.cos(t), centre[1] + radius * Math.sin(t)));
    }
    const arcs = r.next() < 0.7;
    const sagitta = corners.map((a, i) => {
      if (!arcs || r.next() < 0.5) return 0;
      const b = corners[(i + 1) % n];
      const h = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) / 2;
      // Bulging outwards (to the right of a counter-clockwise loop) up to
      // past a half circle, or inwards up to a third of the half chord.
      return r.next() < 0.6 ? h * (0.05 + 1.4 * r.next()) : -h * (0.05 + 0.3 * r.next());
    });
    let shape: LoopShape = { kind: "loop", corners, sagitta };
    if (r.next() < 0.5) shape = reversedLoop(shape);
    shape = rotatedLoop(shape, Math.floor(r.next() * n));
    if (clearlySimple(shape)) return shape;
  }
}

/** The same loop drawn the other way round: corners reversed, each sagitta to the right of the new direction, so negated. */
export function reversedLoop(s: LoopShape): LoopShape {
  const n = s.corners.length;
  return { kind: "loop", corners: [...s.corners].reverse(), sagitta: s.corners.map((_, i) => -s.sagitta[n - 2 - i < 0 ? n - 1 : n - 2 - i]) };
}

/** The same loop started from corner k. */
const rotatedLoop = (s: LoopShape, k: number): LoopShape => ({ kind: "loop", corners: [...s.corners.slice(k), ...s.corners.slice(0, k)], sagitta: [...s.sagitta.slice(k), ...s.sagitta.slice(0, k)] });

async function randomRectangle(kernel: KernelCalls, r: SeededRandom): Promise<{ a: XY; c: XY }> {
  for (;;) {
    const place = await placer(kernel, r);
    const a = await place((r.next() - 0.5) * 800, (r.next() - 0.5) * 800);
    const c = await place(a[0] + (r.next() - 0.5) * 120, a[1] + (r.next() - 0.5) * 120);
    if (Math.abs(c[0] - a[0]) > 0.5 && Math.abs(c[1] - a[1]) > 0.5) return { a, c };
  }
}

async function randomCircle(kernel: KernelCalls, r: SeededRandom): Promise<CircleShape> {
  for (;;) {
    const place = await placer(kernel, r);
    const centre = await place((r.next() - 0.5) * 800, (r.next() - 0.5) * 800);
    const angle = r.next() * 2 * Math.PI;
    const radius = 1 + r.next() * 60;
    const through = await place(centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle));
    if (Math.sqrt((through[0] - centre[0]) ** 2 + (through[1] - centre[1]) ** 2) > 0.5) return { kind: "circle", centre, through };
  }
}

/** A distance as typed: tenths, hundredths, or any number, 0.5 to 200 mm. */
const typedDistance = (r: SeededRandom): number => {
  const d = 0.5 + r.next() * 199.5;
  const pick = r.next();
  return pick < 0.4 ? Math.round(d * 10) / 10 : pick < 0.7 ? Math.round(d * 100) / 100 : d;
};

// ---------------------------------------------------------------------------
// Driving Design's tools

interface Driver {
  doc: DesignDocument;
  fault?: Fault;
}

function click(d: Driver, tool: SketchTool, at: XY): SketchTool {
  const done = clickAt(d.doc, tool, [at[0], at[1]]);
  d.doc = done.doc;
  return done.tool;
}

/** Side i of a loop, drawn with the line tool (two clicks) or the 3-point arc tool (start, end, then the apex). */
function drawSide(d: Driver, sketch: string, shape: LoopShape, i: number, closing: boolean) {
  const n = shape.corners.length;
  const a = shape.corners[i];
  let b = shape.corners[(i + 1) % n];
  if (closing && d.fault === "closeMissed") b = [b[0] + 0.001, b[1]];
  const s = shape.sagitta[i];
  if (s === 0) {
    let tool = click(d, startTool("line", sketch), a);
    tool = click(d, tool, b);
    return;
  }
  let tool = click(d, startTool("arc", sketch), a);
  tool = click(d, tool, b);
  click(d, tool, apex(a, b, d.fault === "arcOtherSide" ? -s : s));
}

/** A loop drawn as a user chains it: line clicks carry on from the last point; an arc side switches to the arc tool and back. */
function drawLoop(d: Driver, sketch: string, shape: LoopShape) {
  const n = shape.corners.length;
  let tool: SketchTool = startTool("line", sketch);
  for (let i = 0; i < n; i++) {
    const a = shape.corners[i];
    let b = shape.corners[(i + 1) % n];
    if (i === n - 1 && d.fault === "closeMissed") b = [b[0] + 0.001, b[1]];
    if (shape.sagitta[i] === 0) {
      if (tool.kind !== "line" || tool.from === null) tool = click(d, switchTool(d.doc, tool, "line"), a);
      tool = click(d, tool, b);
    } else {
      tool = click(d, switchTool(d.doc, tool, "arc"), a);
      tool = click(d, tool, b);
      tool = click(d, tool, apex(a, b, d.fault === "arcOtherSide" ? -shape.sagitta[i] : shape.sagitta[i]));
    }
  }
}

function sketchOf(doc: DesignDocument, id: string) {
  const s = doc.sketches.find((x) => x.id === id);
  if (!s) throw new Error(`no sketch ${id}`);
  return s;
}

/** The curve between corners i and i + 1 of a loop, found by its two point ids. */
function sideCurve(doc: DesignDocument, sketch: string, shape: LoopShape, i: number): string {
  const sk = sketchOf(doc, sketch);
  const n = shape.corners.length;
  const ends = [pointAt(sk, [shape.corners[i][0], shape.corners[i][1]]), pointAt(sk, [shape.corners[(i + 1) % n][0], shape.corners[(i + 1) % n][1]])];
  const curve = sk.curves.find((c) => c.kind !== "circle" && ends.includes(c.start) && ends.includes(c.end) && c.start !== c.end);
  if (!curve) throw new Error(`no curve joins corners ${i} and ${i + 1}`);
  return curve.id;
}

const reopened = (doc: DesignDocument, fault?: Fault): DesignDocument => {
  const back = projectFromJson(projectToJson({ ...emptyProject("Sessions"), workspaces: { design: doc } }), [designWorkspace]).workspaces.design as DesignDocument;
  if (fault !== "saveLosesSide") return back;
  return { ...back, sketches: back.sketches.map((s) => ({ ...s, curves: s.curves.length > 1 ? s.curves.slice(0, -1) : s.curves })) };
};

// ---------------------------------------------------------------------------
// Sessions

type Part = { kind: "box"; w: number; d: number; h: number } | { kind: "extrude"; sketch: string; d: number };

interface ModelSketch {
  id: string;
  shape: Shape;
  /** The side deleted, if one is. */
  gap: number | null;
}

export interface SessionResult {
  seed: bigint;
  /** What each step did, in words. */
  ops: string[];
  built: number;
  refused: number;
  /** How many built bodies had arcs in them. */
  curved: number;
  /** The first failure: where (seed, step and what it did) and what was wrong. */
  failure?: string;
  /** What was wrong alone, the same for every failure of one kind. */
  problem?: string;
}

/** One line per built extrude for the OpenCascade oracle (prototypes/oracle/sketch_extrude.py). */
export interface OracleLine {
  shape: { Extrude: { outer: unknown; holes: unknown[]; dist: number } };
  fission_volume: number;
  fission_area: number;
  fission_faces: number;
  model_volume: number;
  model_area: number;
  context: string;
  /** The built body's STEP file (step 29b3, `body_step`), or why the kernel wouldn't write it. */
  step: string | null;
  step_refused: string | null;
}

/** The kernel's outline in the oracle's terms: a path of corners and bulges, or a circle. */
function oracleRing(loop: Outline["outer"]): unknown {
  if ("circle" in loop) return { Circle: { c: loop.circle.center, r: loop.circle.radius } };
  const pts: number[][] = [];
  for (let i = 0; i < loop.path.corners.length; i += 2) pts.push([loop.path.corners[i], loop.path.corners[i + 1]]);
  return { Path: { pts, bulges: loop.path.bulges } };
}

/** A session of `steps` steps from `seed`, checked after every step. Stops at the first failure and says what it was. */
export async function runSession(kernel: KernelCalls, options: { seed: bigint; steps: number; fault?: Fault; oracle?: (line: OracleLine) => void }): Promise<SessionResult> {
  const { seed, steps, fault, oracle } = options;
  const r = seeded(seed);
  const d: Driver = { doc: partDocument("box", 20, 20, 20), fault };
  const sketches: ModelSketch[] = [];
  let part = { kind: "box", w: 20, d: 20, h: 20 } as Part;
  const result: SessionResult = { seed, ops: [], built: 0, refused: 0, curved: 0 };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
  for (let step = 0; step < steps; step++) {
    const roll = r.next();
    const loops = sketches.filter((s) => s.shape.kind === "loop") as (ModelSketch & { shape: LoopShape })[];
    let op: string;
    if (sketches.length === 0 || roll < 0.25) {
      const made = addSketch(d.doc);
      d.doc = made.doc;
      const kind = r.next();
      let shape: Shape;
      if (kind < 0.55) {
        shape = await randomLoop(kernel, r);
        drawLoop(d, made.id, shape);
        op = `draw ${shape.corners.length} sides (${shape.sagitta.filter((s) => s !== 0).length} arcs)`;
      } else if (kind < 0.75) {
        const { a, c } = await randomRectangle(kernel, r);
        let tool = click(d, startTool("rectangle", made.id), a);
        tool = click(d, tool, c);
        shape = { kind: "loop", corners: [a, [c[0], a[1]], c, [a[0], c[1]]], sagitta: [0, 0, 0, 0] };
        op = `draw a rectangle ${a} to ${c}`;
      } else {
        shape = await randomCircle(kernel, r);
        let tool = click(d, startTool("circle", made.id), shape.centre);
        tool = click(d, tool, shape.through);
        op = `draw a circle round ${shape.centre} through ${shape.through}`;
      }
      sketches.push({ id: made.id, shape, gap: null });
    } else if (roll < 0.45) {
      const s = pick(sketches);
      const dist = typedDistance(r);
      d.doc = extrudeSketch(d.doc, s.id, dist).doc;
      part = { kind: "extrude", sketch: s.id, d: dist };
      op = `extrude ${s.id} by ${dist}`;
    } else if (roll < 0.55 && part.kind === "extrude") {
      const dist = typedDistance(r);
      if (fault !== "distanceDropped") d.doc = setExtrudeDistance(d.doc, dist);
      part = { ...part, d: dist };
      op = `type distance ${dist}`;
    } else if (roll < 0.68 && loops.length) {
      // Move a corner whose two sides are both lines (moving an arc's end
      // without its centre is refused, which the sketch tests cover).
      const s = pick(loops);
      const n = s.shape.corners.length;
      const k = Math.floor(r.next() * n);
      const free = s.gap === null && s.shape.sagitta[k] === 0 && s.shape.sagitta[(k + n - 1) % n] === 0;
      const to: XY = [s.shape.corners[k][0] + (r.next() - 0.5) * 10, s.shape.corners[k][1] + (r.next() - 0.5) * 10];
      const corners = s.shape.corners.map((c, i) => (i === k ? to : c));
      const moved: LoopShape = { ...s.shape, corners };
      if (free && clearlySimple(moved)) {
        const id = pointAt(sketchOf(d.doc, s.id), [s.shape.corners[k][0], s.shape.corners[k][1]])!;
        d.doc = movePoint(d.doc, s.id, id, to[0], to[1]);
        s.shape = moved;
        op = `move corner ${k} of ${s.id} to ${to}`;
      } else op = "move nothing (no free corner)";
    } else if (roll < 0.78 && loops.length) {
      const s = pick(loops);
      if (s.gap === null) {
        s.gap = Math.floor(r.next() * s.shape.corners.length);
        d.doc = deleteCurve(d.doc, s.id, sideCurve(d.doc, s.id, s.shape, s.gap));
        op = `delete side ${s.gap} of ${s.id}`;
      } else {
        drawSide(d, s.id, s.shape, s.gap, true);
        op = `draw side ${s.gap} of ${s.id} again`;
        s.gap = null;
      }
    } else if (roll < 0.83) {
      const [w, dd, h] = [1 + r.next() * 80, 1 + r.next() * 80, 1 + r.next() * 80];
      d.doc = withPart(d.doc, "box", w, dd, h);
      part = { kind: "box", w, d: dd, h };
      op = `box ${w} × ${dd} × ${h}`;
    } else {
      d.doc = reopened(d.doc, fault);
      op = "save and open again";
    }
    result.ops.push(op);
    const context = `seed ${seed}, step ${step} (${op})`;
    const failure = await check(kernel, d.doc, part, sketches, result, context, fault, oracle);
    if (failure) {
      result.failure = `${context}: ${failure}`;
      result.problem = failure;
      return result;
    }
  }
  return result;
}

/** Builds the part as Design does and compares it with the model; the failure in words, or null. */
async function check(
  kernel: KernelCalls,
  doc: DesignDocument,
  part: Part,
  sketches: ModelSketch[],
  result: SessionResult,
  context: string,
  fault?: Fault,
  oracle?: (line: OracleLine) => void,
): Promise<string | null> {
  const spec = await featureSpec(kernel, doc, lastFeature(doc)).then(
    (s) => ({ ok: s }),
    (e: Error) => ({ refused: e.message }),
  );
  if (part.kind === "box") {
    if ("refused" in spec) return `the box was refused: ${spec.refused}`;
    const body = await buildSpec(kernel, spec.ok);
    const want = part.w * part.d * part.h;
    if (!matches(body.volume, want)) return `box volume ${body.volume}, expected ${want}`;
    result.built++;
    return null;
  }
  const s = sketches.find((x) => x.id === part.sketch)!;
  if (s.gap !== null) {
    if ("ok" in spec) return `${s.id} has side ${s.gap} deleted, but its extrude was built`;
    if (!/has no closed outline: /.test(spec.refused)) return `refused for another reason: ${spec.refused}`;
    result.refused++;
    return null;
  }
  if ("refused" in spec) return `refused: ${spec.refused}`;
  let body: BodyView;
  try {
    body = await buildSpec(kernel, spec.ok);
  } catch (e) {
    return `the kernel refused the extrude: ${(e as Error).message}`;
  }
  if (fault === "volumeOff") body = { ...body, volume: body.volume * (1 + 2e-9) };
  const m = measureShape(s.shape);
  const [volume, area] = [m.area * part.d, 2 * m.area + m.perimeter * part.d];
  const problems: string[] = [];
  if (!matches(body.volume, volume)) problems.push(`volume ${body.volume}, model ${volume}`);
  if (!matches(body.area, area)) problems.push(`area ${body.area}, model ${area}`);
  const [v, e, f] = [body.vertices, body.edges, body.faces];
  if (v !== m.vertices || e !== m.edges || f !== m.faces) problems.push(`${v} V ${e} E ${f} F, model ${m.vertices} V ${m.edges} E ${m.faces} F`);
  if (body.errors.length) problems.push(`invalid: ${body.errors.join("; ")}`);
  if (problems.length) return problems.join("; ");
  result.built++;
  if (s.shape.kind === "circle" || s.shape.sagitta.some((x) => x !== 0)) result.curved++;
  if (oracle && "extrude" in spec.ok) {
    const { profile, distance } = spec.ok.extrude;
    const { step, step_refused } = await stepFile(kernel, spec.ok);
    oracle({
      shape: { Extrude: { outer: oracleRing(profile.outer), holes: profile.holes.map(oracleRing), dist: distance } },
      fission_volume: body.volume,
      fission_area: body.area,
      fission_faces: body.faces,
      model_volume: volume,
      model_area: area,
      context,
      step,
      step_refused,
    });
  }
  return null;
}

/** The body `spec` builds as a STEP file, from a body kept just for it (and freed), or why the kernel refused. */
async function stepFile(kernel: KernelCalls, spec: BodySpec): Promise<{ step: string | null; step_refused: string | null }> {
  let handle: BodyHandle | undefined;
  try {
    handle = await kernel.call("body_build", spec);
    return { step: await kernel.call("body_step", handle), step_refused: null };
  } catch (e) {
    return { step: null, step_refused: e instanceof Error ? e.message : String(e) };
  } finally {
    if (handle !== undefined) await kernel.call("body_free", handle);
  }
}

/** The seed of session i of a run started from `seed` (each session replays on its own from its seed). */
export const sessionSeed = (seed: bigint, i: number): bigint => (seed * 1_000_003n + BigInt(i)) & ((1n << 64n) - 1n);
