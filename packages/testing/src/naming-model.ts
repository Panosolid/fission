// A model of what a sketch on a face does when the features before it are
// edited (step 25a, topological naming; the face sketch itself is step 26 and
// the cut is booleans' 44/48), written apart from Design so it can be the
// oracle for both. docs/progress/cad.md, "Naming test plan (25a)".
//
// Its world is the owner's Fusion test (2026-10-18, answers 1 to 7 in
// docs/progress/cad.md): a polygon sketched on XY, extruded into a body; a
// circle sketched on one of that body's caps; and a feature built from the
// circle: a cut into the body (Fusion's answers) or a new body (what step 26
// can build before booleans). Any number of these items can be in the
// document, but every face sketch is on a cap of an extrude of an XY sketch.
//
// The rules, each from one of Ben's answers:
// 1. A sketch on a face holds the face by its name (feature and cap). Its
//    height follows the face; its own frame stays the world's XY frame seen
//    on that plane, so editing the outline under it never moves the circle
//    across the face (answer 1: the 40 × 30 rectangle becomes 60 × 30 and
//    the hole stays put; answer 5: a longer extrude carries the sketch up).
// 2. A face sketch keeps the side it was drawn from: its normal is the face's
//    outward normal when it was drawn and never flips after. A cut goes
//    against that normal by its depth, so flipping the extrude under it
//    leaves the cut pointing away from the body (answer 2: "No target
//    body"; the body stays).
// 3. A cut builds when its circle and its body overlap with some area and
//    some height, however little (answer 3: the hypotenuse through the hole
//    cuts the hole in half, no error), and fails "no target body" when they
//    only touch or don't meet (answers 2 and 6; touching is decided exactly
//    on the whole-mm grid, never by a tolerance). The body it cuts is the one
//    its sketch's face belonged to when it was made (`target`), as Fusion
//    keeps a cut's bodies.
// 4. Deleting a feature something is built on asks first and takes with it
//    the cuts into its body; a sketch on one of its faces stays, held at its
//    last placement with a "plane lost" warning naming the face (answer 4).
//    Deleting a sketch a feature uses asks first too, and the feature keeps
//    its last shape with a warning (the 24 rule, docs/progress/cad.md,
//    "Decided by Ben (2026-10-17)").
// 5. An item never moves before what it is built from (its sketch, its
//    sketch's face, its cut's body) nor after what is built from it (answer
//    7: none of the four items of Ben's chain could be dragged).
// 6. A name that matches no face is "plane lost"; one that matches two is
//    "plane ambiguous". Both keep the last placement with the warning: the
//    model never guesses (the owner's rule for 25a).
//
// Everything is exact or closed form: corners, circle centres, radii,
// distances and depths are whole mm, every yes-or-no question (does the
// circle meet the outline, do the heights overlap, is the circle wholly
// inside) is decided in integers, and an area is the disc-polygon formula
// below, checked against inscribed and circumscribed polygons in the tests.
//
// `faults` plants the bugs the tests use to prove each check can fail;
// real code never passes any.

import { polygonValid, shoelace, type Point } from "./timeline-model.ts";

export type Cap = "start" | "end";

/** A face a sketch can be on: an extrude's cap, by name. */
export interface CapName {
  feature: string;
  role: Cap;
}

export type Vec3 = readonly [number, number, number];

/** Where a sketch lies: the world point its (0, 0) lands on, and which way (±Z) it faces. */
export interface Placement {
  origin: Vec3;
  normal: 1 | -1;
}

/** A face sketch's circle, as a feature kept it when its sketch was deleted. */
export interface Tool {
  centre: Point;
  radius: number;
  placement: Placement;
}

/** Where the face was when the sketch was drawn on it; only the planted bugs read it. */
export interface Drawn {
  z: number;
  centroid: readonly [number, number];
}

export type NamingItem =
  | { id: string; kind: "sketch"; corners: Point[] }
  /** `kept`: the last placement, while the face is lost or ambiguous. */
  | { id: string; kind: "face-sketch"; face: CapName; normal: 1 | -1; centre: Point; radius: number; drawn: Drawn; kept?: Placement }
  /** `kept`: the sketch's corners just before it was deleted. */
  | { id: string; kind: "extrude"; sketch: string; distance: number; kept?: Point[] }
  | { id: string; kind: "face-extrude"; sketch: string; distance: number; kept?: Tool }
  | { id: string; kind: "cut"; sketch: string; target: string; depth: number; kept?: Tool };

export interface NamingDoc {
  nextId: number;
  items: NamingItem[];
}

export type NamingWarning =
  | { cause: "plane-lost" | "plane-ambiguous"; face: CapName }
  | { cause: "deleted-input"; input: string };

export type NamingResult =
  | { kind: "sketch"; placement: Placement; warning?: NamingWarning }
  /** An extrude or a face extrude: the volume of the body it made, before any cut. */
  | { kind: "solid"; volume: number; warning?: NamingWarning }
  | { kind: "cut"; status: "built"; removed: number; warning?: NamingWarning }
  | { kind: "cut"; status: "failed"; cause: "no-target-body"; warning?: never };

/** A rebuild: the items in order, each one's result, and each body's volume after every cut into it, by the feature that made it. */
export interface NamingRebuild {
  order: string[];
  results: Record<string, NamingResult>;
  bodies: Record<string, number>;
}

export type RefuseCause = "before-dependency" | "after-dependent";

export type NamingOp =
  | { op: "add-sketch"; corners: Point[] }
  | { op: "add-extrude"; sketch: string; distance: number }
  | { op: "add-face-sketch"; face: CapName; centre: Point; radius: number }
  | { op: "add-cut"; sketch: string; depth: number }
  | { op: "add-face-extrude"; sketch: string; distance: number }
  | { op: "set-corners"; sketch: string; corners: Point[] }
  | { op: "move-corner"; sketch: string; corner: number; to: Point }
  | { op: "set-distance"; item: string; value: number }
  | { op: "set-circle"; sketch: string; centre: Point; radius: number }
  | { op: "set-depth"; item: string; value: number }
  | { op: "delete"; item: string }
  | { op: "reorder"; item: string; to: number }
  | { op: "undo" }
  | { op: "redo" };

export type NamingApplied = { kind: "done"; ids: string[] } | { kind: "unchanged" } | { kind: "refused"; cause: RefuseCause };

/** What deleting an item will do: ask first or not, and every item it removes, in timeline order. */
export interface DeletePlan {
  ask: boolean;
  removes: string[];
}

/** Bugs to plant; each is caught by a check named in test/naming-model.test.ts and test/naming-session.test.ts. */
export type NamingFault =
  | "frame-follows-face"
  | "plane-stays-put"
  | "normal-follows-face"
  | "bite-fails"
  | "empty-cut-builds"
  | "delete-keeps-dependents"
  | "delete-takes-sketch"
  | "delete-no-ask"
  | "lost-plane-silent"
  | "lost-plane-moves"
  | "ambiguous-picks-first"
  | "reorder-ignores-plane";

export const NAMING_FAULTS: readonly NamingFault[] = [
  "frame-follows-face",
  "plane-stays-put",
  "normal-follows-face",
  "bite-fails",
  "empty-cut-builds",
  "delete-keeps-dependents",
  "delete-takes-sketch",
  "delete-no-ask",
  "lost-plane-silent",
  "lost-plane-moves",
  "ambiguous-picks-first",
  "reorder-ignores-plane",
];

export const capKey = (c: CapName): string => `${c.feature}/${c.role}`;

const XY: Placement = { origin: [0, 0, 0], normal: 1 };

// ------------------------------------------------------------ disc and polygon

type P2 = readonly [number, number];
const cross2 = (a: P2, b: P2) => a[0] * b[1] - a[1] * b[0];
const dot2 = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];

/**
 * The signed area of the disc of radius r round the origin inside the
 * triangle (origin, a, b), positive when a → b goes counter-clockwise. The
 * side a → b is cut where it crosses the circle; a piece inside the circle
 * adds its triangle with the origin, a piece outside adds the sector it
 * spans, r²θ/2.
 */
function discTriangle(a: P2, b: P2, r: number): number {
  const d: P2 = [b[0] - a[0], b[1] - a[1]];
  const A = dot2(d, d);
  const B = 2 * dot2(a, d);
  const C = dot2(a, a) - r * r;
  const ts = [0];
  const disc = B * B - 4 * A * C;
  if (disc > 0) {
    const s = Math.sqrt(disc);
    for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) if (t > 0 && t < 1) ts.push(t);
  }
  ts.push(1);
  let sum = 0;
  for (let k = 0; k + 1 < ts.length; k++) {
    const p: P2 = [a[0] + ts[k] * d[0], a[1] + ts[k] * d[1]];
    const q: P2 = [a[0] + ts[k + 1] * d[0], a[1] + ts[k + 1] * d[1]];
    const m: P2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    sum += dot2(m, m) < r * r ? cross2(p, q) / 2 : (r * r * Math.atan2(cross2(p, q), dot2(p, q))) / 2;
  }
  return sum;
}

/** The area of a disc inside a simple polygon (either way round): the sum of `discTriangle` over its sides. */
export function discPolygonArea(centre: P2, radius: number, corners: readonly P2[]): number {
  let sum = 0;
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    sum += discTriangle([a[0] - centre[0], a[1] - centre[1]], [b[0] - centre[0], b[1] - centre[1]], radius);
  }
  return Math.abs(sum);
}

/** Exactly (whole numbers only): is the point inside the polygon or on its outline? */
export function pointInPolygon(p: Point, corners: readonly Point[]): boolean {
  let inside = false;
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    const onSide = c === 0 && Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
    if (onSide) return true;
    if (a[1] > p[1] !== b[1] > p[1]) {
      // The side crosses the horizontal line through p; count it when the
      // crossing is right of p, decided by the side's turn without dividing.
      const right = b[1] > a[1] ? c > 0 : c < 0;
      if (right) inside = !inside;
    }
  }
  return inside;
}

/**
 * Exactly (whole numbers only): does the open disc meet the polygon's inside,
 * so the overlap has an area? Yes when the centre is inside or on the
 * outline, or a side passes nearer the centre than r; a side exactly r away
 * only touches. The distance from c to side a → b, squared, is |c − a|² or
 * |c − b|² past an end, else cross(b − a, c − a)² / |b − a|²; compared
 * without dividing, every number stays a whole number well under 2⁵³.
 */
export function discMeetsPolygon(centre: Point, radius: number, corners: readonly Point[]): boolean {
  if (radius <= 0) return false;
  if (pointInPolygon(centre, corners)) return true;
  const r2 = radius * radius;
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    const d = [b[0] - a[0], b[1] - a[1]];
    const w = [centre[0] - a[0], centre[1] - a[1]];
    const t = d[0] * w[0] + d[1] * w[1];
    const len2 = d[0] * d[0] + d[1] * d[1];
    if (t <= 0) {
      if (w[0] * w[0] + w[1] * w[1] < r2) return true;
    } else if (t >= len2) {
      const v = [centre[0] - b[0], centre[1] - b[1]];
      if (v[0] * v[0] + v[1] * v[1] < r2) return true;
    } else {
      const c = d[0] * w[1] - d[1] * w[0];
      if (c * c < r2 * len2) return true;
    }
  }
  return false;
}

/** Exactly: is the closed disc wholly inside the polygon (centre inside, every side at least r away)? */
export function discInsidePolygon(centre: Point, radius: number, corners: readonly Point[]): boolean {
  if (!pointInPolygon(centre, corners)) return false;
  const r2 = radius * radius;
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    const d = [b[0] - a[0], b[1] - a[1]];
    const w = [centre[0] - a[0], centre[1] - a[1]];
    const t = d[0] * w[0] + d[1] * w[1];
    const len2 = d[0] * d[0] + d[1] * d[1];
    const dist2Times = t <= 0 ? (w[0] * w[0] + w[1] * w[1]) * len2 : t >= len2 ? ((centre[0] - b[0]) ** 2 + (centre[1] - b[1]) ** 2) * len2 : (d[0] * w[1] - d[1] * w[0]) ** 2;
    if (dist2Times < r2 * len2) return false;
  }
  return true;
}

/**
 * How near the polygon's outline comes to being tangent to the circle or
 * having a corner on it: the least of |d − r| over every corner's distance d
 * from the centre and every side's distance d from it where the nearest
 * point is inside the side. A side crossing the circle steeply keeps it
 * large; a shallow crossing (a sliver bite), a side grazing the circle from
 * inside or out, or a corner on the circle makes it small.
 */
export function clearance(centre: P2, radius: number, corners: readonly P2[]): number {
  let least = Infinity;
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k];
    const b = corners[(k + 1) % corners.length];
    const d: P2 = [b[0] - a[0], b[1] - a[1]];
    const w: P2 = [centre[0] - a[0], centre[1] - a[1]];
    least = Math.min(least, Math.abs(Math.sqrt(dot2(w, w)) - radius));
    const t = dot2(w, d) / dot2(d, d);
    if (t > 0 && t < 1) least = Math.min(least, Math.abs(Math.abs(cross2(d, w)) / Math.sqrt(dot2(d, d)) - radius));
  }
  return least;
}

/**
 * How far every side and corner must stay from a cut's circle for the
 * random sessions to use the configuration: 0.1 mm, a hundred times the
 * kernel's MIN_FEATURE (1 µm). The model only predicts a cut it is sure the
 * kernel decides the same way: no hole wall a sliver from the outline, no
 * circle tangent to a side or through a corner. Those nasty cases are in
 * the hand-worked tests, where the model's exact answer is the expected one.
 */
export const CLEAR_MM = 0.1;

/** Is a cut's circle clear of the outline (`CLEAR_MM`) and not swallowing it whole (some corner beyond the circle)? */
export function clearCut(centre: P2, radius: number, corners: readonly P2[]): boolean {
  const beyond = corners.some((c) => Math.sqrt((c[0] - centre[0]) ** 2 + (c[1] - centre[1]) ** 2) >= radius + CLEAR_MM);
  return beyond && clearance(centre, radius, corners) >= CLEAR_MM;
}

function centroid(corners: readonly Point[]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < corners.length; k++) {
    const p = corners[k];
    const q = corners[(k + 1) % corners.length];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c;
    cx += (p[0] + q[0]) * c;
    cy += (p[1] + q[1]) * c;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// ------------------------------------------------------------ rebuild

/** A cap built so far in a rebuild: its name, height, outward normal and outline. */
export interface CapFace {
  name: CapName;
  z: number;
  outward: 1 | -1;
  corners: readonly Point[];
}

type FaceSketch = Extract<NamingItem, { kind: "face-sketch" }>;

/**
 * Where a face sketch lies, given the caps built before it: on the one cap
 * with its name (rules 1 and 2), or at its last placement with a warning
 * when no cap or two caps have that name (rule 6).
 */
export function placeOn(faces: readonly CapFace[], s: FaceSketch, faults: ReadonlySet<NamingFault> = new Set()): { placement: Placement; warning?: NamingWarning; matches: number } {
  const key = capKey(s.face);
  const matches = faces.filter((f) => capKey(f.name) === key);
  if (matches.length === 1 || (matches.length > 1 && faults.has("ambiguous-picks-first"))) {
    const f = matches[0];
    const z = faults.has("plane-stays-put") ? s.drawn.z : f.z;
    const normal = faults.has("normal-follows-face") ? f.outward : s.normal;
    let ox = 0;
    let oy = 0;
    if (faults.has("frame-follows-face")) {
      const c = centroid(f.corners);
      [ox, oy] = [c[0] - s.drawn.centroid[0], c[1] - s.drawn.centroid[1]];
    }
    return { placement: { origin: [ox, oy, z], normal }, matches: 1 };
  }
  const placement = faults.has("lost-plane-moves") ? XY : (s.kept ?? XY);
  const cause = matches.length === 0 ? "plane-lost" : "plane-ambiguous";
  return { placement, matches: matches.length, ...(faults.has("lost-plane-silent") ? {} : { warning: { cause, face: { ...s.face } } }) };
}

interface Evaluated {
  rebuild: NamingRebuild;
  /** How many caps each face sketch's name matched. */
  matches: Record<string, number>;
  faces: CapFace[];
}

function evaluate(doc: NamingDoc, faults: ReadonlySet<NamingFault>): Evaluated {
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  const results: Record<string, NamingResult> = {};
  const bodies: Record<string, number> = {};
  const solids = new Map<string, { corners: readonly Point[]; lo: number; hi: number }>();
  const faces: CapFace[] = [];
  const matches: Record<string, number> = {};
  const toolOf = (item: Extract<NamingItem, { kind: "cut" | "face-extrude" }>): { tool: Tool; warning?: NamingWarning } => {
    const s = byId.get(item.sketch);
    const placed = results[item.sketch];
    if (s?.kind === "face-sketch" && placed?.kind === "sketch") return { tool: { centre: s.centre, radius: s.radius, placement: placed.placement } };
    if (item.kept === undefined) throw new Error(`${item.id}: its sketch ${item.sketch} is gone and nothing was kept`);
    return { tool: item.kept, warning: { cause: "deleted-input", input: item.sketch } };
  };
  for (const item of doc.items) {
    switch (item.kind) {
      case "sketch":
        results[item.id] = { kind: "sketch", placement: XY };
        break;
      case "extrude": {
        const s = byId.get(item.sketch);
        const corners = s?.kind === "sketch" ? s.corners : item.kept;
        if (corners === undefined) throw new Error(`${item.id}: its sketch ${item.sketch} is gone and nothing was kept`);
        const d = item.distance;
        const out: 1 | -1 = d > 0 ? 1 : -1;
        const volume = shoelace(corners) * Math.abs(d);
        faces.push({ name: { feature: item.id, role: "start" }, z: 0, outward: out === 1 ? -1 : 1, corners }, { name: { feature: item.id, role: "end" }, z: d, outward: out, corners });
        solids.set(item.id, { corners, lo: Math.min(0, d), hi: Math.max(0, d) });
        bodies[item.id] = volume;
        results[item.id] = { kind: "solid", volume, ...(s?.kind === "sketch" ? {} : { warning: { cause: "deleted-input" as const, input: item.sketch } }) };
        break;
      }
      case "face-sketch": {
        const p = placeOn(faces, item, faults);
        matches[item.id] = p.matches;
        results[item.id] = { kind: "sketch", placement: p.placement, ...(p.warning ? { warning: p.warning } : {}) };
        break;
      }
      case "face-extrude": {
        const { tool, warning } = toolOf(item);
        const volume = Math.PI * tool.radius * tool.radius * Math.abs(item.distance);
        bodies[item.id] = volume;
        results[item.id] = { kind: "solid", volume, ...(warning ? { warning } : {}) };
        break;
      }
      case "cut": {
        const { tool, warning } = toolOf(item);
        const body = solids.get(item.target);
        const { origin, normal } = tool.placement;
        // The circle's centre on the world grid: whole mm unless a planted bug moved the frame.
        const centre: Point = [origin[0] + tool.centre[0], origin[1] + tool.centre[1]];
        const ends = [origin[2], origin[2] - normal * item.depth];
        const height = body ? Math.min(body.hi, Math.max(...ends)) - Math.max(body.lo, Math.min(...ends)) : 0;
        const meets = body !== undefined && height > 0 && discMeetsPolygon(centre, tool.radius, body.corners);
        const whole = body !== undefined && discInsidePolygon(centre, tool.radius, body.corners);
        if (body === undefined || (!meets && !faults.has("empty-cut-builds")) || (faults.has("bite-fails") && !whole)) {
          results[item.id] = { kind: "cut", status: "failed", cause: "no-target-body" };
          break;
        }
        const removed = meets ? discPolygonArea(centre, tool.radius, body.corners) * height : 0;
        bodies[item.target] -= removed;
        results[item.id] = { kind: "cut", status: "built", removed, ...(warning ? { warning } : {}) };
        break;
      }
    }
  }
  return { rebuild: { order: doc.items.map((i) => i.id), results, bodies }, matches, faces };
}

/** Rebuilds the document: every item's result and every body's volume. */
export const rebuildNaming = (doc: NamingDoc, faults: ReadonlySet<NamingFault> = new Set()): NamingRebuild => evaluate(doc, faults).rebuild;

// ------------------------------------------------------------ edits

/** What an item is built from, of the items still in the document (rule 5). */
export function namingDeps(doc: NamingDoc, item: NamingItem, faults: ReadonlySet<NamingFault> = new Set()): string[] {
  const here = (ids: string[]) => ids.filter((id) => doc.items.some((i) => i.id === id));
  switch (item.kind) {
    case "sketch":
      return [];
    case "face-sketch":
      return faults.has("reorder-ignores-plane") ? [] : here([item.face.feature]);
    case "extrude":
    case "face-extrude":
      return here([item.sketch]);
    case "cut":
      return here([item.sketch, item.target]);
  }
}

/** What deleting `id` does (rule 4): it asks when anything is built from it, and takes the cuts into its body with it. */
export function planDelete(doc: NamingDoc, id: string, faults: ReadonlySet<NamingFault> = new Set()): DeletePlan {
  const ask = doc.items.some((i) => namingDeps(doc, i).includes(id));
  const goes = (i: NamingItem) =>
    i.id === id ||
    (!faults.has("delete-keeps-dependents") && i.kind === "cut" && i.target === id) ||
    (faults.has("delete-takes-sketch") && i.kind === "face-sketch" && i.face.feature === id);
  return { ask: ask && !faults.has("delete-no-ask"), removes: doc.items.filter(goes).map((i) => i.id) };
}

export interface NamingModel {
  doc: NamingDoc;
  undo: string[];
  redo: string[];
  faults: ReadonlySet<NamingFault>;
}

export const createNamingModel = (faults: Iterable<NamingFault> = []): NamingModel => ({ doc: { nextId: 1, items: [] }, undo: [], redo: [], faults: new Set(faults) });

const snapshot = (d: NamingDoc) => JSON.stringify(d);

/** Applies one edit, recording one undo step (a whole-document snapshot) when it changed the document. */
export function applyNaming(m: NamingModel, op: NamingOp): NamingApplied {
  if (op.op === "undo" || op.op === "redo") {
    const [from, to] = op.op === "undo" ? [m.undo, m.redo] : [m.redo, m.undo];
    const back = from.pop();
    if (back === undefined) return { kind: "unchanged" };
    to.push(snapshot(m.doc));
    m.doc = JSON.parse(back);
    return { kind: "done", ids: [] };
  }
  const before = snapshot(m.doc);
  const doc: NamingDoc = JSON.parse(before);
  const r = edit(doc, op, m.faults);
  if (r.kind === "refused") return r;
  settle(m.doc, doc, m.faults);
  if (snapshot(doc) === before) return { kind: "unchanged" };
  m.undo.push(before);
  m.redo = [];
  m.doc = doc;
  return r;
}

/**
 * After an edit, every face sketch whose face is gone or ambiguous keeps the
 * placement it had just before (and forgets it once its face is back), and
 * every feature whose sketch was deleted keeps that sketch's last shape.
 */
function settle(before: NamingDoc, doc: NamingDoc, faults: ReadonlySet<NamingFault>) {
  const was = evaluate(before, faults);
  const old = new Map(before.items.map((i) => [i.id, i]));
  const live = new Set(doc.items.map((i) => i.id));
  for (const item of doc.items) {
    if (item.kind === "sketch" || item.kind === "face-sketch" || live.has(item.sketch) || item.kept !== undefined) continue;
    const s = old.get(item.sketch);
    const r = was.rebuild.results[item.sketch];
    if (item.kind === "extrude" && s?.kind === "sketch") item.kept = s.corners;
    if (item.kind !== "extrude" && s?.kind === "face-sketch" && r?.kind === "sketch") item.kept = { centre: s.centre, radius: s.radius, placement: r.placement };
  }
  const now = evaluate(doc, faults);
  for (const item of doc.items) {
    if (item.kind !== "face-sketch") continue;
    if (now.matches[item.id] === 1) delete item.kept;
    else if (item.kept === undefined) {
      const r = was.rebuild.results[item.id];
      if (r?.kind === "sketch") item.kept = r.placement;
    }
  }
}

function find(doc: NamingDoc, id: string): NamingItem {
  const item = doc.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function edit(doc: NamingDoc, op: Exclude<NamingOp, { op: "undo" | "redo" }>, faults: ReadonlySet<NamingFault>): NamingApplied {
  const newId = (prefix: string) => `${prefix}-${doc.nextId++}`;
  const add = (item: NamingItem): NamingApplied => {
    doc.items.push(item);
    return { kind: "done", ids: [item.id] };
  };
  switch (op.op) {
    case "add-sketch":
      if (!polygonValid(op.corners)) throw new Error("not a valid outline");
      return add({ id: newId("sketch"), kind: "sketch", corners: op.corners.map((p) => [p[0], p[1]]) });
    case "add-extrude":
      if (find(doc, op.sketch).kind !== "sketch" || op.distance === 0) throw new Error("an extrude needs an XY sketch and a distance");
      return add({ id: newId("extrude"), kind: "extrude", sketch: op.sketch, distance: op.distance });
    case "add-face-sketch": {
      const face = evaluate(doc, new Set()).faces.filter((f) => capKey(f.name) === capKey(op.face));
      if (face.length !== 1) throw new Error(`no single face ${capKey(op.face)} to sketch on`);
      const [f] = face;
      const drawn = { z: f.z, centroid: centroid(f.corners) };
      return add({ id: newId("sketch"), kind: "face-sketch", face: { ...op.face }, normal: f.outward, centre: [op.centre[0], op.centre[1]], radius: op.radius, drawn });
    }
    case "add-cut":
    case "add-face-extrude": {
      const s = find(doc, op.sketch);
      if (s.kind !== "face-sketch") throw new Error(`${op.sketch} is not on a face`);
      if (op.op === "add-cut") return add({ id: newId("cut"), kind: "cut", sketch: s.id, target: s.face.feature, depth: op.depth });
      return add({ id: newId("extrude"), kind: "face-extrude", sketch: s.id, distance: op.distance });
    }
    case "set-corners":
    case "move-corner": {
      const s = find(doc, op.sketch);
      if (s.kind !== "sketch") throw new Error(`${op.sketch} has no corners`);
      const corners = op.op === "set-corners" ? op.corners.map((p): Point => [p[0], p[1]]) : s.corners.map((p, k): Point => (k === op.corner ? [op.to[0], op.to[1]] : p));
      if (!polygonValid(corners)) throw new Error("not a valid outline");
      s.corners = corners;
      return { kind: "done", ids: [] };
    }
    case "set-distance": {
      const item = find(doc, op.item);
      if ((item.kind !== "extrude" && item.kind !== "face-extrude") || op.value === 0) throw new Error(`${op.item}: no distance ${op.value}`);
      item.distance = op.value;
      return { kind: "done", ids: [] };
    }
    case "set-circle": {
      const s = find(doc, op.sketch);
      if (s.kind !== "face-sketch" || op.radius <= 0) throw new Error(`${op.sketch}: no circle of radius ${op.radius}`);
      s.centre = [op.centre[0], op.centre[1]];
      s.radius = op.radius;
      return { kind: "done", ids: [] };
    }
    case "set-depth": {
      const item = find(doc, op.item);
      if (item.kind !== "cut" || op.value <= 0) throw new Error(`${op.item}: no depth ${op.value}`);
      item.depth = op.value;
      return { kind: "done", ids: [] };
    }
    case "delete": {
      find(doc, op.item);
      const gone = new Set(planDelete(doc, op.item, faults).removes);
      doc.items = doc.items.filter((i) => !gone.has(i.id));
      return { kind: "done", ids: [] };
    }
    case "reorder": {
      const k = doc.items.findIndex((i) => i.id === op.item);
      if (k < 0) throw new Error(`no item ${op.item}`);
      const [item] = doc.items.splice(k, 1);
      doc.items.splice(op.to, 0, item);
      const at = (id: string) => doc.items.findIndex((i) => i.id === id);
      if (namingDeps(doc, item, faults).some((d) => at(d) > op.to)) return { kind: "refused", cause: "before-dependency" };
      if (doc.items.some((i, j) => j < op.to && namingDeps(doc, i, faults).includes(item.id))) return { kind: "refused", cause: "after-dependent" };
      return { kind: "done", ids: [] };
    }
  }
}
