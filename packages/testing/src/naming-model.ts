// A model of what a sketch on a face does when the features before it are
// edited (step 25a, topological naming; the face sketch itself is step 26 and
// the cut is booleans' 44/48), written apart from Design so it can be the
// oracle for both. docs/progress/cad.md, "Naming test plan (25a)" and "Sketch
// on a face test plan (26a)".
//
// Its world is the owner's Fusion test (2026-10-18, answers 1 to 7 in
// docs/progress/cad.md): a polygon sketched on XY, extruded into a body; a
// circle sketched on one of that body's faces (a cap, or from step 26 a side);
// and a feature built from the circle: a cut into the body (Fusion's answers)
// or a new body (what step 26 can build before booleans). Any number of these
// items can be in the document, but every face sketch is on a face of an
// extrude of an XY sketch.
//
// The rules, each from one of Ben's answers:
// 1. A sketch on a face holds the face by its name (feature and cap, or
//    feature and the outline line a side was swept from). It lies on the
//    face's plane; on a cap its own frame stays the world's XY frame seen on
//    that plane, so editing the outline under it never moves the circle
//    across the face (answer 1: the 40 × 30 rectangle becomes 60 × 30 and
//    the hole stays put; answer 5: a longer extrude carries the sketch up).
// 2. A face sketch keeps the side it was drawn from: it faces the face's
//    outward normal when drawn and never flips after. A cut goes against
//    that way by its depth, so flipping the extrude under it leaves the cut
//    pointing away from the body (answer 2: "No target body"; the body
//    stays).
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
// Step 26 (Ben's answers of 2026-10-19, Q1 to Q3):
// 7. A feature built from a face sketch whose plane is lost or ambiguous
//    keeps its body, built at the sketch's held placement, and says its
//    source is lost (Q1: the new-body cylinder stays when Extrude 1 is
//    deleted, with "plane lost" on the sketch and "source lost" on it).
// 8. A face sketch's coordinates are the world's (Q2). Its frame is the
//    origin plane (XY, then XZ, then YZ) most nearly parallel to the face
//    when it was drawn, turned onto the face the shortest way, with its
//    origin where the world's origin meets the face's plane square on; so on
//    a face parallel to an origin plane, sketch (x, y) reads as world (x, y),
//    (x, z) or (y, z), whichever way the face looks. When a later edit turns
//    the face (a side whose corner moved), the frame turns with it the
//    shortest way, keeping the face side its normal was on (the normal of
//    the plane nearer the one drawn; a face turned exactly a right angle
//    takes its outward side); the sketch's own side against that normal
//    (rule 2) never changes. A side's frame is then (along the side, up).
// 9. Suppressing a feature greys every item built on it, all the way down,
//    with no warning (Q3); nothing else changes, and unsuppressing brings
//    them back as they were.
// Step 26f (Q4: a face's edges are not drawn into its sketch, but a point
// can be snapped to them, and then follows them):
// 10. A circle on a cap may have its centre pinned to one of the cap's
//    corners (named by the two outline lines it sits between, the one
//    ending there and the one starting there) or to the middle of one of
//    its sides (named by the line it was swept from). After every edit the
//    centre goes where that corner or middle is now, judged with nothing
//    suppressed (as rule 9's holds are); when the name finds nothing (the
//    outline redrawn with new lines) the centre stays where it was and the
//    sketch warns "point lost". A sketch whose plane is lost or ambiguous
//    is not judged (the plane's warning says it all). Moving the circle
//    takes the pin away.
// Not here: curved faces (refused by Design, Q5), pins on a side face
// (Design's own tests have them; the model's numbers stay whole only on
// caps), a sketch on a cut's floor (Q6) and a split face
// (the piece holding the sketch's origin, else the largest, always warned),
// which need booleans' cut.
//
// Everything is exact or closed form: corners, circle centres, radii,
// distances and depths are whole mm, every yes-or-no question (does the
// circle meet the outline, do the heights overlap, is the circle wholly
// inside, which origin plane is nearest, which side a turned face keeps) is
// decided in integers, and an area is the disc-polygon formula below,
// checked against inscribed and circumscribed polygons in the tests.
//
// `faults` plants the bugs the tests use to prove each check can fail;
// real code never passes any.

import { polygonValid, shoelace, type Point } from "./timeline-model.ts";

export type Cap = "start" | "end";

/** A face a sketch can be on, by name: an extrude's cap, or the side swept from one line of its outline (step 26). */
export type FaceName = { feature: string; role: Cap } | { feature: string; role: "side"; line: string };

export type Vec3 = readonly [number, number, number];

/**
 * Where a sketch lies: its frame (the world point its (0, 0) lands on, its
 * x axis and its normal, unit vectors; its y is normal × x) and which way it
 * faces against that normal (rule 2): +1 along it, −1 against.
 */
export interface Placement {
  origin: Vec3;
  x: Vec3;
  normal: Vec3;
  side: 1 | -1;
}

/**
 * What a face sketch's circle centre is pinned to (rule 10): the cap's
 * corner between line `before` (ending there) and line `after` (starting
 * there), or the middle of the cap's edge along line `line`.
 */
export type PinName = { at: "corner"; before: string; after: string } | { at: "middle"; line: string };

export const pinKeyOf = (p: PinName): string => (p.at === "corner" ? `corner:${p.before}>${p.after}` : `middle:${p.line}`);

/** A face sketch's circle, as a feature kept it when its sketch was deleted. */
export interface Tool {
  centre: Point;
  radius: number;
  placement: Placement;
}

/**
 * The face as the sketch was drawn on it: its outward normal as whole
 * numbers (so the side a turned face keeps is decided exactly), the frame's
 * x axis and normal then, and, for the planted bugs only, where its
 * origin was and the face's middle.
 */
export interface Drawn {
  outward: Vec3;
  x: Vec3;
  normal: Vec3;
  origin: Vec3;
  centroid: readonly [number, number];
}

export type NamingItem =
  /** `lines`: each side's line id, the k-th from corner k to corner k + 1. */
  | { id: string; kind: "sketch"; corners: Point[]; lines: string[] }
  /** `kept`: the last placement, while the face is lost or ambiguous. */
  | { id: string; kind: "face-sketch"; face: FaceName; side: 1 | -1; centre: Point; radius: number; drawn: Drawn; kept?: Placement; pin?: PinName }
  /** `kept`, `keptLines`: the sketch's corners and line ids just before it was deleted, so its sides keep their names. */
  | { id: string; kind: "extrude"; sketch: string; distance: number; suppressed?: true; kept?: Point[]; keptLines?: string[] }
  | { id: string; kind: "face-extrude"; sketch: string; distance: number; suppressed?: true; kept?: Tool }
  | { id: string; kind: "cut"; sketch: string; target: string; depth: number; suppressed?: true; kept?: Tool };

export interface NamingDoc {
  nextId: number;
  /** The next outline line's number: lines are counted apart from items, so items keep the ids of 25a. */
  nextLine: number;
  items: NamingItem[];
}

export type NamingWarning =
  | { cause: "plane-lost" | "plane-ambiguous"; face: FaceName }
  /** Rule 10: a pinned centre whose corner or middle is gone, held where it was. */
  | { cause: "point-lost"; pin: PinName }
  | { cause: "deleted-input" | "source-lost"; input: string };

export type NamingResult =
  | { kind: "sketch"; placement: Placement; warning?: NamingWarning }
  /** An extrude or a face extrude: the volume and centroid of the body it made, before any cut. */
  | { kind: "solid"; volume: number; centroid: Vec3; warning?: NamingWarning }
  | { kind: "cut"; status: "built"; removed: number; warning?: NamingWarning }
  | { kind: "cut"; status: "failed"; cause: "no-target-body"; warning?: never }
  /** Suppressed itself, or greyed because something it is built on is (rule 9); never a warning. */
  | { kind: "suppressed" | "greyed"; warning?: never };

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
  /** With `pin`, the centre lands on that corner or middle of the cap (`centre` is not used) and is pinned there (rule 10). */
  | { op: "add-face-sketch"; face: FaceName; centre: Point; radius: number; pin?: PinName }
  | { op: "add-cut"; sketch: string; depth: number }
  | { op: "add-face-extrude"; sketch: string; distance: number }
  /** Same number of corners: each corner moved, every line kept; another number: the outline redrawn with new lines. */
  | { op: "set-corners"; sketch: string; corners: Point[] }
  | { op: "move-corner"; sketch: string; corner: number; to: Point }
  | { op: "set-distance"; item: string; value: number }
  | { op: "set-circle"; sketch: string; centre: Point; radius: number }
  | { op: "set-depth"; item: string; value: number }
  | { op: "suppress"; item: string; on: boolean }
  | { op: "delete"; item: string }
  | { op: "reorder"; item: string; to: number }
  | { op: "undo" }
  | { op: "redo" };

/** `ids`: what an edit made, in order: an item's id, then (for an outline) its line ids; a redrawn outline's new line ids. */
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
  | "reorder-ignores-plane"
  // Step 26:
  | "frame-not-turned"
  | "origin-at-corner"
  | "source-lost-silent"
  | "extrude-ignores-side"
  | "side-by-index"
  | "suppress-keeps-dependents"
  | "suppress-greys-all-after"
  // Step 26c:
  | "greyed-loses-hold"
  // Step 26f:
  | "pin-stays-put"
  | "lost-pin-silent"
  | "lost-pin-moves"
  | "pin-wrong-end"
  | "pin-survives-move";

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
  "frame-not-turned",
  "origin-at-corner",
  "source-lost-silent",
  "extrude-ignores-side",
  "side-by-index",
  "suppress-keeps-dependents",
  "suppress-greys-all-after",
  "greyed-loses-hold",
  "pin-stays-put",
  "lost-pin-silent",
  "lost-pin-moves",
  "pin-wrong-end",
  "pin-survives-move",
];

export const faceKeyOf = (f: FaceName): string => (f.role === "side" ? `${f.feature}/side:${f.line}` : `${f.feature}/${f.role}`);

/** The ground plane's frame, facing up. */
export const XY_PLACEMENT: Placement = { origin: [0, 0, 0], x: [1, 0, 0], normal: [0, 0, 1], side: 1 };

/** The origin planes' frames (Design's sketch.ts PLANES), in the order a tie between them is broken: x along `x`, y along normal × x. */
export const ORIGIN_FRAMES: readonly { name: "XY" | "XZ" | "YZ"; x: Vec3; normal: Vec3 }[] = [
  { name: "XY", x: [1, 0, 0], normal: [0, 0, 1] },
  { name: "XZ", x: [1, 0, 0], normal: [0, -1, 0] },
  { name: "YZ", x: [0, 1, 0], normal: [1, 0, 0] },
];

const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// `+ 0` turns −0 into 0, so a frame read back from a file (or written by hand) compares equal.
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k + 0, a[1] * k + 0, a[2] * k + 0];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const unit3 = (a: Vec3): Vec3 => scale3(a, 1 / Math.sqrt(dot3(a, a)));
const sign = (x: number): 1 | -1 => (x < 0 ? -1 : 1);

/** A sketch point's place in the world: origin + u x + v y, with y = normal × x. */
export function worldOf(p: Placement, u: number, v: number): Vec3 {
  return add3(p.origin, add3(scale3(p.x, u), scale3(cross3(p.normal, p.x), v)));
}

/**
 * The vector `v` turned by the shortest rotation taking unit `from` to unit
 * `to` (Rodrigues, written without the angle: with c = from · to and
 * w = from × to, R v = c v + w × v + (w · v) w / (1 + c)); only used with
 * c ≥ 0, where 1 + c ≥ 1 keeps it well away from dividing by nothing.
 */
export function turned(v: Vec3, from: Vec3, to: Vec3): Vec3 {
  const c = dot3(from, to);
  const w = cross3(from, to);
  return add3(add3(scale3(v, c), cross3(w, v)), scale3(w, dot3(w, v) / (1 + c)));
}

/**
 * The frame a sketch drawn on a face with outward normal `outward` (whole
 * numbers) gets (rule 8): the origin plane whose normal is most nearly along
 * it (the largest |outward · normal|, whole numbers so a tie is exact, and
 * broken in ORIGIN_FRAMES' order), turned onto the face the shortest way,
 * the normal on the origin plane's side; `side` is +1 when the face looks
 * along that normal, −1 when against it.
 */
export function drawnFrame(outward: Vec3): { x: Vec3; normal: Vec3; side: 1 | -1 } {
  let best = ORIGIN_FRAMES[0];
  for (const f of ORIGIN_FRAMES) if (Math.abs(dot3(outward, f.normal)) > Math.abs(dot3(outward, best.normal))) best = f;
  const side = sign(dot3(outward, best.normal));
  const normal = scale3(unit3(outward), side);
  return { x: turned(best.x, best.normal, normal), normal, side };
}

/**
 * Where the frame drawn on a face lies now that the face's outward normal is
 * `outward` (whole numbers) and a point of its plane is `point` (rule 8):
 * the normal is ±outward, the one on the drawn normal's side (decided in
 * whole numbers from the drawn face's outward normal; exactly square to it,
 * the outward one), the x axis turned the shortest way with it, and the
 * origin the plane's nearest point to the world's origin, (point · n) n.
 */
export function frameNow(drawn: Drawn, drawnSide: 1 | -1, outward: Vec3, point: Vec3, faults: ReadonlySet<NamingFault> = new Set()): Omit<Placement, "side"> {
  // The drawn normal is drawnSide × (the drawn outward normal), so its side of the new face is the sign of drawnSide (drawn.outward · outward).
  const keep = sign(drawnSide * dot3(drawn.outward, outward) === 0 ? 1 : drawnSide * dot3(drawn.outward, outward));
  const n = scale3(unit3(outward), keep);
  const x = faults.has("frame-not-turned") ? drawn.x : turned(drawn.x, drawn.normal, n);
  return { origin: scale3(n, dot3(point, n)), x, normal: faults.has("frame-not-turned") ? drawn.normal : n };
}

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

/**
 * A face built so far in a rebuild: its name; a point of its plane (a cap's
 * first corner at its height, a side's first end at z = 0); its outward
 * normal as whole numbers; its outline (a cap's corners, a side's two ends)
 * and its middle, seen from above.
 */
export interface ModelFace {
  name: FaceName;
  point: Vec3;
  outward: Vec3;
  corners: readonly Point[];
  centroid: readonly [number, number];
}

type FaceSketch = Extract<NamingItem, { kind: "face-sketch" }>;

/**
 * Where a face sketch lies, given the faces built before it: on the one face
 * with its name (rules 1, 2 and 8), or at its last placement with a warning
 * when no face or two faces have that name (rule 6).
 */
export function placeOn(faces: readonly ModelFace[], s: FaceSketch, faults: ReadonlySet<NamingFault> = new Set()): { placement: Placement; warning?: NamingWarning; matches: number } {
  const key = faceKeyOf(s.face);
  const matches = faces.filter((f) => faceKeyOf(f.name) === key);
  if (matches.length === 1 || (matches.length > 1 && faults.has("ambiguous-picks-first"))) {
    const f = matches[0];
    const frame = frameNow(s.drawn, s.side, f.outward, f.point, faults);
    let origin = frame.origin;
    if (faults.has("plane-stays-put")) origin = s.drawn.origin;
    if (faults.has("origin-at-corner")) origin = f.point;
    if (faults.has("frame-follows-face")) origin = [origin[0] + f.centroid[0] - s.drawn.centroid[0], origin[1] + f.centroid[1] - s.drawn.centroid[1], origin[2]];
    const side = faults.has("normal-follows-face") ? sign(dot3(frame.normal, f.outward)) : s.side;
    return { placement: { ...frame, origin, side }, matches: 1 };
  }
  const placement = faults.has("lost-plane-moves") ? XY_PLACEMENT : (s.kept ?? XY_PLACEMENT);
  const cause = matches.length === 0 ? "plane-lost" : "plane-ambiguous";
  return { placement, matches: matches.length, ...(faults.has("lost-plane-silent") ? {} : { warning: { cause, face: { ...s.face } } }) };
}

interface Evaluated {
  rebuild: NamingRebuild;
  /** How many faces each face sketch's name matched (absent while it is greyed). */
  matches: Record<string, number>;
  faces: ModelFace[];
}

/** Twice a polygon's signed area, positive counter-clockwise: whole numbers, so its sign is exact. */
const twiceArea = (corners: readonly Point[]) => 2 * shoelace(corners);

/** An extrude's faces: its caps at 0 and d, and a side for each named line, each facing out. */
function extrudeFaces(feature: string, corners: readonly Point[], lines: readonly string[] | undefined, d: number): ModelFace[] {
  const up: 1 | -1 = d > 0 ? 1 : -1;
  const mid = centroid(corners);
  const faces: ModelFace[] = [
    { name: { feature, role: "start" }, point: [corners[0][0], corners[0][1], 0], outward: [0, 0, -up], corners, centroid: mid },
    { name: { feature, role: "end" }, point: [corners[0][0], corners[0][1], d], outward: [0, 0, up], corners, centroid: mid },
  ];
  // The side from a to b faces (dy, −dx) when the outline goes counter-clockwise, (−dy, dx) when clockwise.
  const ccw = twiceArea(corners) > 0 ? 1 : -1;
  corners.forEach((a, k) => {
    const b = corners[(k + 1) % corners.length];
    const line = lines?.[k];
    if (line === undefined) return;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    faces.push({ name: { feature, role: "side", line }, point: [a[0], a[1], 0], outward: [ccw * dy, -ccw * dx, 0], corners: [a, b], centroid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  });
  return faces;
}

/**
 * Where a pin on a cap of feature `face.feature` is now (rule 10): the
 * corner of its outline (the sketch's, or the shape kept when the sketch
 * was deleted) between line `before` and line `after`, or the middle of
 * line `line`'s side; null when its lines are gone (or the feature is, or
 * the face is a side). On a cap, sketch (x, y) is world (x, y) (rule 8),
 * so these are whole or half millimetres.
 */
export function pinAt(doc: NamingDoc, face: FaceName, pin: PinName, faults: ReadonlySet<NamingFault> = new Set()): Point | null {
  const f = doc.items.find((i) => i.id === face.feature);
  if (face.role === "side" || f?.kind !== "extrude") return null;
  const s = doc.items.find((i) => i.id === f.sketch);
  const [corners, lines] = s?.kind === "sketch" ? [s.corners, s.lines] : [f.kept, f.keptLines];
  if (corners === undefined || lines === undefined) return null;
  const n = corners.length;
  if (pin.at === "middle") {
    const k = lines.indexOf(pin.line);
    if (k < 0) return null;
    const [a, b] = [corners[k], corners[(k + 1) % n]];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  // Corner k is where line k − 1 ends and line k starts.
  const k = lines.findIndex((l, j) => l === pin.after && lines[(j + n - 1) % n] === pin.before);
  if (k < 0) return null;
  const c = corners[faults.has("pin-wrong-end") ? (k + 1) % n : k];
  return [c[0], c[1]];
}

const isFeature = (i: NamingItem): i is Extract<NamingItem, { kind: "extrude" | "face-extrude" | "cut" }> => i.kind === "extrude" || i.kind === "face-extrude" || i.kind === "cut";

function evaluate(doc: NamingDoc, faults: ReadonlySet<NamingFault>): Evaluated {
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  const results: Record<string, NamingResult> = {};
  const bodies: Record<string, number> = {};
  const solids = new Map<string, { corners: readonly Point[]; lo: number; hi: number }>();
  const faces: ModelFace[] = [];
  const matches: Record<string, number> = {};
  const off = new Set<string>();
  const toolOf = (item: Extract<NamingItem, { kind: "cut" | "face-extrude" }>): { tool: Tool; warning?: NamingWarning } => {
    const s = byId.get(item.sketch);
    const placed = results[item.sketch];
    if (s?.kind === "face-sketch" && placed?.kind === "sketch") {
      // Rule 7: built where its sketch is held, saying its source is lost.
      // Only a plane's warning: a lost pin leaves the sketch where it was, its outline as good as ever (rule 10).
      const lost = placed.warning !== undefined && "face" in placed.warning && !faults.has("source-lost-silent");
      return { tool: { centre: s.centre, radius: s.radius, placement: placed.placement }, ...(lost ? { warning: { cause: "source-lost" as const, input: item.sketch } } : {}) };
    }
    if (item.kept === undefined) throw new Error(`${item.id}: its sketch ${item.sketch} is gone and nothing was kept`);
    return { tool: item.kept, warning: { cause: "deleted-input", input: item.sketch } };
  };
  for (const item of doc.items) {
    // Rule 9: greyed when anything it is built on is suppressed or greyed.
    const greyed = faults.has("suppress-keeps-dependents") ? false : faults.has("suppress-greys-all-after") ? off.size > 0 : namingDeps(doc, item).some((d) => off.has(d));
    const suppressed = isFeature(item) && item.suppressed === true;
    if (suppressed || greyed) {
      off.add(item.id);
      results[item.id] = { kind: suppressed ? "suppressed" : "greyed" };
      continue;
    }
    switch (item.kind) {
      case "sketch":
        results[item.id] = { kind: "sketch", placement: XY_PLACEMENT };
        break;
      case "extrude": {
        const s = byId.get(item.sketch);
        const corners = s?.kind === "sketch" ? s.corners : item.kept;
        if (corners === undefined) throw new Error(`${item.id}: its sketch ${item.sketch} is gone and nothing was kept`);
        const d = item.distance;
        // |area|: a clockwise outline is no smaller a body.
        const volume = Math.abs(shoelace(corners)) * Math.abs(d);
        faces.push(...extrudeFaces(item.id, corners, s?.kind === "sketch" ? s.lines : item.keptLines, d));
        solids.set(item.id, { corners, lo: Math.min(0, d), hi: Math.max(0, d) });
        bodies[item.id] = volume;
        const c = centroid(corners);
        results[item.id] = { kind: "solid", volume, centroid: [c[0], c[1], d / 2], ...(s?.kind === "sketch" ? {} : { warning: { cause: "deleted-input" as const, input: item.sketch } }) };
        break;
      }
      case "face-sketch": {
        const p = placeOn(faces, item, faults);
        matches[item.id] = p.matches;
        // Rule 10: a pin judged only on a face found; one whose corner or middle is gone warns.
        const lostPin = p.warning === undefined && item.pin !== undefined && pinAt(doc, item.face, item.pin, faults) === null && !faults.has("lost-pin-silent");
        const warning: NamingWarning | undefined = p.warning ?? (lostPin ? { cause: "point-lost", pin: { ...item.pin! } } : undefined);
        results[item.id] = { kind: "sketch", placement: p.placement, ...(warning ? { warning } : {}) };
        break;
      }
      case "face-extrude": {
        const { tool, warning } = toolOf(item);
        const volume = Math.PI * tool.radius * tool.radius * Math.abs(item.distance);
        // The cylinder goes the way the sketch faces (rule 2), its middle half the distance along.
        const p = tool.placement;
        const way = faults.has("extrude-ignores-side") ? p.normal : scale3(p.normal, p.side);
        const centroidAt = add3(worldOf(p, tool.centre[0], tool.centre[1]), scale3(way, item.distance / 2));
        bodies[item.id] = volume;
        results[item.id] = { kind: "solid", volume, centroid: centroidAt, ...(warning ? { warning } : {}) };
        break;
      }
      case "cut": {
        const { tool, warning } = toolOf(item);
        const body = solids.get(item.target);
        const p = tool.placement;
        // The circle's centre on the world grid (caps only: rule 8 makes a cap's frame the world's XY, so whole mm unless a planted bug moved it).
        const at = worldOf(p, tool.centre[0], tool.centre[1]);
        const centre: Point = [at[0], at[1]];
        const ends = [p.origin[2], p.origin[2] - p.side * p.normal[2] * item.depth];
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

/** Every face the document builds, in order (no faults): what a sketch can be put on. */
export const namingFaces = (doc: NamingDoc): ModelFace[] => evaluate(doc, new Set()).faces;

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

export const createNamingModel = (faults: Iterable<NamingFault> = []): NamingModel => ({ doc: { nextId: 1, nextLine: 1, items: [] }, undo: [], redo: [], faults: new Set(faults) });

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

/** The document with nothing suppressed: what every item would be, which is what a greyed item keeps when its input goes. */
function unsuppressed(doc: NamingDoc): NamingDoc {
  const d: NamingDoc = JSON.parse(snapshot(doc));
  for (const i of d.items) if (isFeature(i)) delete i.suppressed;
  return d;
}

/**
 * After an edit, every face sketch whose face is gone or ambiguous keeps the
 * placement it had just before (and forgets it once its face is back), and
 * every feature whose sketch was deleted keeps that sketch's last shape.
 * Both are judged with nothing suppressed: a greyed sketch's face is not
 * gone, only off, so it keeps nothing while its face is there; but a face
 * taken away while greyed (its outline redrawn under a suppressed extrude)
 * is gone, and the sketch keeps where it was before that edit, never
 * where a lost sketch would fall back to (step 26c). What it had "just
 * before" is where it would have been with nothing suppressed, the same
 * for every item that was built.
 */
function settle(before: NamingDoc, doc: NamingDoc, faults: ReadonlySet<NamingFault>) {
  const was = evaluate(unsuppressed(before), faults);
  const old = new Map(before.items.map((i) => [i.id, i]));
  const live = new Set(doc.items.map((i) => i.id));
  for (const item of doc.items) {
    if (item.kind === "sketch" || item.kind === "face-sketch" || live.has(item.sketch) || item.kept !== undefined) continue;
    const s = old.get(item.sketch);
    const r = was.rebuild.results[item.sketch];
    if (item.kind === "extrude" && s?.kind === "sketch") {
      item.kept = s.corners;
      item.keptLines = s.lines;
    }
    if (item.kind !== "extrude" && s?.kind === "face-sketch" && r?.kind === "sketch") item.kept = { centre: s.centre, radius: s.radius, placement: r.placement };
  }
  const now = evaluate(faults.has("greyed-loses-hold") ? doc : unsuppressed(doc), faults);
  for (const item of doc.items) {
    if (item.kind !== "face-sketch" || now.rebuild.results[item.id]?.kind !== "sketch") continue;
    if (now.matches[item.id] === 1) delete item.kept;
    else if (item.kept === undefined) {
      const r = was.rebuild.results[item.id];
      if (r?.kind === "sketch") item.kept = r.placement;
    }
    // Rule 10: a pinned centre goes where its corner or middle is now, on a face found; else it stays (planted: back to the origin).
    if (item.pin === undefined || now.matches[item.id] !== 1) continue;
    const at = pinAt(doc, item.face, item.pin, faults);
    if (at !== null && !faults.has("pin-stays-put")) item.centre = at;
    if (at === null && faults.has("lost-pin-moves")) item.centre = [0, 0];
  }
}

function find(doc: NamingDoc, id: string): NamingItem {
  const item = doc.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function edit(doc: NamingDoc, op: Exclude<NamingOp, { op: "undo" | "redo" }>, faults: ReadonlySet<NamingFault>): NamingApplied {
  const newId = (prefix: string) => `${prefix}-${doc.nextId++}`;
  const newLines = (n: number) => Array.from({ length: n }, () => `line-${doc.nextLine++}`);
  const add = (item: NamingItem, more: string[] = []): NamingApplied => {
    doc.items.push(item);
    return { kind: "done", ids: [item.id, ...more] };
  };
  switch (op.op) {
    case "add-sketch": {
      if (!polygonValid(op.corners)) throw new Error("not a valid outline");
      const lines = newLines(op.corners.length);
      return add({ id: newId("sketch"), kind: "sketch", corners: op.corners.map((p) => [p[0], p[1]]), lines }, lines);
    }
    case "add-extrude":
      if (find(doc, op.sketch).kind !== "sketch" || op.distance === 0) throw new Error("an extrude needs an XY sketch and a distance");
      return add({ id: newId("extrude"), kind: "extrude", sketch: op.sketch, distance: op.distance });
    case "add-face-sketch": {
      const face = namingFaces(doc).filter((f) => faceKeyOf(f.name) === faceKeyOf(op.face));
      if (face.length !== 1) throw new Error(`no single face ${faceKeyOf(op.face)} to sketch on`);
      const [f] = face;
      const frame = drawnFrame(f.outward);
      const drawn: Drawn = { outward: f.outward, x: frame.x, normal: frame.normal, origin: scale3(frame.normal, dot3(f.point, frame.normal)), centroid: f.centroid };
      // Rule 10: snapped onto a corner or a middle, the centre lands exactly there and is pinned.
      const pinned = op.pin && pinAt(doc, op.face, op.pin);
      if (op.pin && !pinned) throw new Error(`no ${pinKeyOf(op.pin)} on ${faceKeyOf(op.face)} to pin to`);
      const centre: Point = pinned ?? [op.centre[0], op.centre[1]];
      return add({ id: newId("sketch"), kind: "face-sketch", face: { ...op.face }, side: frame.side, centre, radius: op.radius, drawn, ...(op.pin ? { pin: { ...op.pin } } : {}) });
    }
    case "add-cut":
    case "add-face-extrude": {
      const s = find(doc, op.sketch);
      if (s.kind !== "face-sketch") throw new Error(`${op.sketch} is not on a face`);
      if (op.op === "add-face-extrude") return add({ id: newId("extrude"), kind: "face-extrude", sketch: s.id, distance: op.distance });
      if (s.face.role === "side") throw new Error(`${op.sketch}: a cut from a side face is not modelled until booleans' cut`);
      return add({ id: newId("cut"), kind: "cut", sketch: s.id, target: s.face.feature, depth: op.depth });
    }
    case "set-corners":
    case "move-corner": {
      const s = find(doc, op.sketch);
      if (s.kind !== "sketch") throw new Error(`${op.sketch} has no corners`);
      const corners = op.op === "set-corners" ? op.corners.map((p): Point => [p[0], p[1]]) : s.corners.map((p, k): Point => (k === op.corner ? [op.to[0], op.to[1]] : p));
      if (!polygonValid(corners)) throw new Error("not a valid outline");
      const redrawn = corners.length !== s.corners.length;
      s.corners = corners;
      if (!redrawn) return { kind: "done", ids: [] };
      // A different number of corners is a new outline: new lines, so the old sides' names are gone (planted: kept by place).
      const fresh = newLines(corners.length);
      s.lines = faults.has("side-by-index") ? fresh.map((id, k) => s.lines[k] ?? id) : fresh;
      return { kind: "done", ids: [...s.lines] };
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
      // Moved, the centre is pinned no longer (rule 10).
      if (!faults.has("pin-survives-move")) delete s.pin;
      return { kind: "done", ids: [] };
    }
    case "set-depth": {
      const item = find(doc, op.item);
      if (item.kind !== "cut" || op.value <= 0) throw new Error(`${op.item}: no depth ${op.value}`);
      item.depth = op.value;
      return { kind: "done", ids: [] };
    }
    case "suppress": {
      const item = find(doc, op.item);
      if (!isFeature(item)) throw new Error(`${op.item}: only a feature is suppressed here`);
      if (op.on) item.suppressed = true;
      else delete item.suppressed;
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
