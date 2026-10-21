// A simple model of Design's timeline (steps 24-25), written apart from
// Design's code, for the seeded random timeline sessions to check the real
// rebuild against (docs/progress/cad.md, "Timeline test plan").
//
// The model is the specification: an ordered list of items (sketches,
// extrudes, box, cylinder and sphere presets), each with an id from a
// counter that is never reused, a suppressed flag, and a rollback marker.
// A rebuild walks the list and says, for every item, whether it was built,
// suppressed, rolled back or failed (and why), and for every solid item its
// body: volume, and each face by its permanent name with that face's area
// and centroid. Names are tied to geometry on purpose: a name set alone
// can't see two names swapped between faces.
//
// Everything here is plain arithmetic on small integers and closed-form
// formulas, so it cannot share a mistake with the kernel:
// - Sketches are on XY, corners on the 1 mm grid within ±60 mm. A polygon
//   is valid (the kernel's profile rules, ops/profile.rs check_profile)
//   exactly when no corner doubles back and no two sides that are not
//   neighbours touch; both are decided with exact integer orientation
//   tests. Why that matches the kernel's MIN_FEATURE (1 µm) clearance
//   rule: on this grid two sides that don't touch are at least
//   1 / (longest side) ≥ 1 / 170 mm ≈ 6 µm apart (an integer cross product
//   that isn't 0 is at least 1), and a corner that turns but doesn't
//   double back leaves its neighbours at least that far apart too; a
//   turning corner's unit cross product is at least 1 / 170² ≈ 3.5e-5,
//   far above the kernel's ANGULAR (1e-9) cusp test.
// - Circles and slots (two lines and two half circles) have whole-mm
//   sizes of at least 1 mm, so they are always valid outlines.
//
// The timeline's rules (decided by the owner, 2026-10-17, from trying the
// reference app; docs/progress/cad.md; change the model and the plan
// together):
// - An extrude that loses its sketch (the sketch deleted, or its outline
//   broken: a curve deleted, a corner moved so it crosses itself) keeps its
//   last shape, built with a warning naming the sketch and why ("kept"
//   below, step 24d2). Its last shape is the sketch as it was just before
//   the edit that lost it, extruded by the extrude's distance now; the
//   faces keep that sketch's curve names. Once the sketch makes an outline
//   again the extrude builds from it and forgets the kept shape. With no
//   kept shape (the sketch was already broken when the extrude was made, or
//   when it was lost) it fails with the cause; nothing is deleted silently.
// - Suppressing an item greys every item built on it, all the way down,
//   with no warning (Ben's Fusion answer Q3, step 26e; until 26e an
//   extrude of a suppressed sketch failed with "suppressed-input"). A
//   greyed item says which suppressed item greys it (`by`).
//
// Sketches on a face (step 26e: the timeline's rules on a face sketch,
// the naming model's rules 6 to 9 on the faces these sessions make): a
// sketch may be drawn on the top of a box or cylinder or the end cap of an
// extrude, every one flat and facing +Z, so by rule 8 its frame is XY
// lifted to the face (the nearest origin plane, turned not at all; its
// origin the face plane's nearest point to the world's origin) and its
// corners read in world x and y. It follows its face's height as earlier
// items change; when its face is gone (its feature deleted, or failed) it
// stays at the height it last had ("held", kept by `settle`, judged with
// nothing suppressed and no marker) with "plane-lost", and an extrude of
// it is built there saying its source is lost (rule 7). It is built on
// its face's feature, so it can't move before it, and it is greyed while
// that feature is suppressed or greyed. An extrude of it starts on the
// face and goes up: its body is the XY one lifted by the face's height.
// - New items go in just after the marker, and the marker moves onto them.
// - Deleting the item the marker is on moves the marker to the item before
//   it ("start" if there is none).
//
// `faults` plants the bugs the session tests use to prove the harness
// catches them (timeline-session.ts); real code never passes any.

/** A point on the sketch grid, in whole mm. */
export type Point = readonly [number, number];

/**
 * A sketch's shape. A polygon's curves are its sides, side k from corner k
 * to corner k + 1. A slot is centres `at` and `at` + (length, 0) with
 * `radius`: curves bottom line, right half circle, top line, left half
 * circle. A circle is one curve.
 */
export type ModelShape =
  | { kind: "polygon"; corners: Point[] }
  | { kind: "circle"; centre: Point; radius: number }
  | { kind: "slot"; at: Point; length: number; radius: number };

export type PresetKind = "box" | "cylinder" | "sphere";

/** The faces a sketch can be drawn on here (26e): a box's or cylinder's top, an extrude's end cap. */
export type CapRole = "top" | "end";

/**
 * Where a sketch on a face is (26e): the face's feature and role, the
 * height it was drawn at, and the height it holds while its face is lost
 * (left out while the face is there).
 */
export interface OnFace {
  feature: string;
  role: CapRole;
  drawn: number;
  held?: number;
}

export type ModelItem =
  /** `curves[k]` is curve k's id, or null once it is deleted; `on` for a sketch on a face (26e). */
  | { id: string; kind: "sketch"; shape: ModelShape; curves: (string | null)[]; suppressed: boolean; on?: OnFace }
  /** `kept`: the sketch as it was before the edit that lost it, while it is lost (the owner's rule above). */
  | { id: string; kind: "extrude"; sketch: string; distance: number; suppressed: boolean; kept?: Kept }
  | { id: string; kind: "box"; width: number; depth: number; height: number; suppressed: boolean }
  | { id: string; kind: "cylinder"; diameter: number; height: number; suppressed: boolean }
  | { id: string; kind: "sphere"; diameter: number; suppressed: boolean };

/** An extrude's last shape: its sketch's shape and curve ids just before the sketch was lost, and the height it lay at when that was a face sketch (26e). */
export interface Kept {
  shape: ModelShape;
  curves: string[];
  lift?: number;
}

/** null: everything is built; "start": nothing is; an id: built up to and including that item. */
export type Marker = string | null;

export interface ModelDoc {
  nextId: number;
  items: ModelItem[];
  marker: Marker;
}

/**
 * The proposed naming scheme (decided for good at 24b): a face is named by
 * the feature that made it, its role in that feature and, for a face swept
 * from a sketch curve, that curve's id. An extrude's caps are "start" (on
 * the sketch plane) and "end"; a box's faces are named by their outward
 * direction (bottom −Z, top +Z, front −Y, back +Y, left −X, right +X); a
 * cylinder has bottom, top and side; a sphere's two halves are upper and
 * lower.
 */
export type FaceRole = "start" | "end" | "side" | "bottom" | "top" | "front" | "back" | "left" | "right" | "upper" | "lower";

export interface FaceName {
  feature: string;
  role: FaceRole;
  curve?: string;
}

export type Vec3 = readonly [number, number, number];

export interface ModelFace {
  name: FaceName;
  area: number;
  centroid: Vec3;
}

/**
 * An edge is named by the two faces it joins (step 24c). Two sides of an
 * extrude can meet at more than one corner (a half disc's line and arc meet
 * at both ends), so between two sides the order says which corner:
 * `faces[0]` is the side before the corner going round the loop with the
 * solid on the left, seen from the end cap (counter-clockwise round an
 * outline), and `ordered` is true. Every other edge joins two faces that
 * meet only there, so its pair is a set, kept sorted by `facePart`.
 */
export interface EdgeName {
  feature: string;
  faces: readonly [FaceName, FaceName];
  ordered: boolean;
}

/** An edge with its length and centroid (the mean point along it: a line's middle, a circle's centre). */
export interface ModelEdge {
  name: EdgeName;
  length: number;
  centroid: Vec3;
}

export interface ModelBody {
  volume: number;
  faces: ModelFace[];
  edges: ModelEdge[];
}

export type FailCause = "deleted-input" | "failed-input" | "open-outline" | "invalid-outline";

/** Why an extrude is built from its kept shape: its sketch is gone, or makes no outline. */
export type LostCause = "deleted-input" | "open-outline" | "invalid-outline";

/** An extrude built from its kept shape, and why (the owner's rule: the warning names the sketch). */
export interface KeptWarning {
  cause: LostCause;
  input: string;
}

export type ItemResult =
  /**
   * A sketch on a face says the height it lies at (`lift`) and, while held
   * there, "plane-lost"; an extrude of a held sketch names it as its lost
   * `source` (26e).
   */
  | { status: "built"; body?: ModelBody; warning?: KeptWarning; lift?: number; plane?: "plane-lost"; source?: string }
  | { status: "suppressed" }
  /** Built on a suppressed item (`by`), directly or through others: off, with no warning (Q3, 26e). */
  | { status: "greyed"; by: string }
  | { status: "rolled-back" }
  | { status: "failed"; cause: FailCause; input?: string };

/** A rebuild: the items in build order and each one's result. */
export interface Rebuild {
  order: string[];
  results: Record<string, ItemResult>;
}

export type RefuseCause = "before-dependency" | "after-dependent";

/** An edit with its targets named: what the session runner hands the model and the code under test. */
export type ConcreteOp =
  | { op: "add-sketch"; shape: ModelShape }
  /** A sketch drawn on a built face (26e): a box's or cylinder's top, an extrude's end. */
  | { op: "add-face-sketch"; shape: ModelShape; face: FaceName }
  | { op: "add-extrude"; sketch: string; distance: number }
  | { op: "add-preset"; kind: PresetKind; sizes: number[] }
  | { op: "set-size"; item: string; key: SizeKey; value: number }
  | { op: "move-corner"; sketch: string; corner: number; to: Point }
  | { op: "delete-curve"; sketch: string; curve: string }
  | { op: "redraw-curve"; sketch: string; index: number }
  | { op: "delete-item"; item: string }
  | { op: "reorder"; item: string; to: number }
  | { op: "suppress"; item: string; on: boolean }
  | { op: "marker"; at: Marker }
  | { op: "undo" }
  | { op: "redo" };

/** What an edit did: "done" with the ids it made (an item's, then its curves' in order), "unchanged", or refused. */
export type Applied = { kind: "done"; ids: string[] } | { kind: "unchanged" } | { kind: "refused"; cause: RefuseCause };

export type SizeKey = "distance" | "width" | "depth" | "height" | "diameter" | "radius" | "length";

/** Bugs to plant (timeline-session.test.ts); see `MODEL_FAULTS`. */
export type ModelFault =
  | "reorder-past-dependency"
  | "build-suppressed"
  | "ignore-marker"
  | "reuse-ids"
  | "side-names-by-list"
  | "stale-extrude-cache"
  | "cascade-delete"
  | "keep-redo"
  | "save-drops-suppressed"
  | "resolve-falls-back"
  | "edit-leaks"
  | "sphere-one-name"
  | "rebuild-drifts"
  | "resolve-last-body-only"
  | "save-stamps"
  | "uprights-as-given"
  | "cap-edges-swapped"
  | "end-edges-named-start"
  | "lost-sketch-fails"
  | "kept-not-forgotten"
  | "save-drops-kept"
  | "warning-dropped"
  | "full-replay"
  | "body-kept-by-item"
  | "suppress-fails-dependents"
  | "greyed-warns"
  | "lost-plane-not-held"
  | "face-sketch-unbound";

export const MODEL_FAULTS: readonly ModelFault[] = [
  "reorder-past-dependency",
  "build-suppressed",
  "ignore-marker",
  "reuse-ids",
  "side-names-by-list",
  "stale-extrude-cache",
  "cascade-delete",
  "keep-redo",
  "save-drops-suppressed",
  "resolve-falls-back",
  "edit-leaks",
  "sphere-one-name",
  "rebuild-drifts",
  "resolve-last-body-only",
  "save-stamps",
  "uprights-as-given",
  "cap-edges-swapped",
  "end-edges-named-start",
  "lost-sketch-fails",
  "kept-not-forgotten",
  "save-drops-kept",
  "warning-dropped",
  "full-replay",
  "body-kept-by-item",
  "suppress-fails-dependents",
  "greyed-warns",
  "lost-plane-not-held",
  "face-sketch-unbound",
];

/** "item-3/side:curve-5": a face name as one string, for maps and messages. */
export const faceKey = (n: FaceName): string => `${n.feature}/${n.role}${n.curve === undefined ? "" : `:${n.curve}`}`;

/** A face name without its feature: "side:curve-5", "top". */
export const facePart = (n: FaceName): string => `${n.role}${n.curve === undefined ? "" : `:${n.curve}`}`;

/** The name of the edge joining faces a and b of one feature: in that order when `ordered`, else as a set (sorted). */
export function edgeName(a: FaceName, b: FaceName, ordered: boolean): EdgeName {
  const faces: [FaceName, FaceName] = ordered || facePart(a) <= facePart(b) ? [a, b] : [b, a];
  return { feature: a.feature, faces, ordered };
}

/** "item-3/side:curve-5>side:curve-6", "item-3/side:curve-5+start": an edge name as one string. */
export const edgeKey = (n: EdgeName): string => `${n.feature}/${facePart(n.faces[0])}${n.ordered ? ">" : "+"}${facePart(n.faces[1])}`;

/** The ids an item reads: an extrude its sketch, a sketch on a face that face's feature (26e). */
export const dependsOn = (item: ModelItem): string[] => (item.kind === "extrude" ? [item.sketch] : item.kind === "sketch" && item.on ? [item.on.feature] : []);

export const emptyDoc = (): ModelDoc => ({ nextId: 1, items: [], marker: null });

// ---------------------------------------------------------------- geometry

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
/** Whether q is on the closed segment a–b, given that a, b and q are collinear. */
const within = (a: Point, b: Point, q: Point) => Math.min(a[0], b[0]) <= q[0] && q[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= q[1] && q[1] <= Math.max(a[1], b[1]);

/** Whether the closed segments a–b and c–d share any point (exact for integer corners). */
export function segmentsTouch(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = sign(cross(c, d, a));
  const d2 = sign(cross(c, d, b));
  const d3 = sign(cross(a, b, c));
  const d4 = sign(cross(a, b, d));
  if (d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/**
 * Whether a polygon on the integer grid is an outline the kernel accepts:
 * at least 3 corners, no corner doubling back (which also rules out a side
 * of length 0), and no two sides that are not neighbours touching.
 */
export function polygonValid(corners: readonly Point[]): boolean {
  const n = corners.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const [a, b, c] = [corners[i], corners[(i + 1) % n], corners[(i + 2) % n]];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    // At b the outline doubles back when c is on the ray from b towards a.
    const back = cross(b, a, c) === 0 && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0;
    if (back) return false;
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours across the closing corner
      if (segmentsTouch(corners[i], corners[(i + 1) % n], corners[j], corners[(j + 1) % n])) return false;
    }
  return true;
}

/** Signed shoelace area, positive counter-clockwise. */
export function shoelace(corners: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < corners.length; i++) {
    const [a, b] = [corners[i], corners[(i + 1) % corners.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** A polygon's area centroid (the standard formula over the shoelace terms). */
function polygonCentroid(corners: readonly Point[]): [number, number] {
  const A = shoelace(corners);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < corners.length; i++) {
    const [a, b] = [corners[i], corners[(i + 1) % corners.length]];
    const t = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * t;
    cy += (a[1] + b[1]) * t;
  }
  return [cx / (6 * A), cy / (6 * A)];
}

/** How many curves a shape has. */
export const curveCount = (s: ModelShape): number => (s.kind === "polygon" ? s.corners.length : s.kind === "circle" ? 1 : 4);

/** The area a closed outline encloses. */
export function outlineArea(s: ModelShape): number {
  if (s.kind === "polygon") return Math.abs(shoelace(s.corners));
  if (s.kind === "circle") return Math.PI * s.radius * s.radius;
  return 2 * s.radius * s.length + Math.PI * s.radius * s.radius;
}

function outlineCentroid(s: ModelShape): [number, number] {
  if (s.kind === "polygon") return polygonCentroid(s.corners);
  if (s.kind === "circle") return [s.centre[0], s.centre[1]];
  return [s.at[0] + s.length / 2, s.at[1]];
}

/**
 * The side face swept from curve k over a height d: its area and centroid.
 * A line's side is a rectangle (centroid at its middle, half way up). A
 * half circle's side is half a cylinder: area π r d, centroid 2r/π from
 * the axis towards the bulge (the mean of r cos θ over −π/2…π/2 is 2r/π).
 * A circle's side is a whole cylinder centred on its axis.
 */
function sideFace(s: ModelShape, k: number, d: number): { area: number; centroid: Vec3 } {
  if (s.kind === "polygon") {
    const [a, b] = [s.corners[k], s.corners[(k + 1) % s.corners.length]];
    const len = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    return { area: len * d, centroid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / 2] };
  }
  if (s.kind === "circle") return { area: 2 * Math.PI * s.radius * d, centroid: [s.centre[0], s.centre[1], d / 2] };
  const [x, y, L, r] = [s.at[0], s.at[1], s.length, s.radius];
  if (k === 0) return { area: L * d, centroid: [x + L / 2, y - r, d / 2] };
  if (k === 2) return { area: L * d, centroid: [x + L / 2, y + r, d / 2] };
  const off = (2 * r) / Math.PI;
  return { area: Math.PI * r * d, centroid: [k === 1 ? x + L + off : x - off, y, d / 2] };
}

function extrudeBody(id: string, s: ModelShape, curves: readonly string[], d: number, faults: ReadonlySet<ModelFault>): ModelBody {
  const area = outlineArea(s);
  const [cx, cy] = outlineCentroid(s);
  const sides = curves.map((c, k) => ({ name: { feature: id, role: "side" as const, curve: c }, ...sideFace(s, k, d) }));
  // Planted bug: names handed out in curve-list order to faces in the
  // kernel's walk order, which runs counter-clockwise, so a clockwise
  // polygon gets every side's name on the wrong face.
  if (faults.has("side-names-by-list") && s.kind === "polygon" && shoelace(s.corners) < 0)
    for (let k = 0; k < sides.length; k++) sides[k] = { ...sides[k], ...sideFace(s, sides.length - 1 - k, d) };
  const start: FaceName = { feature: id, role: "start" };
  const end: FaceName = { feature: id, role: "end" };
  return {
    volume: area * d,
    faces: [{ name: start, area, centroid: [cx, cy, 0] }, { name: end, area, centroid: [cx, cy, d] }, ...sides],
    edges: extrudeEdges(s, sides.map((f) => f.name), start, end, d, faults),
  };
}

/**
 * An extrude's edges: each curve's edge in the start cap (z = 0) and in the
 * end cap (z = d), with the length and centroid of that curve (a line's
 * middle; a half circle's centroid 2r/π from its centre towards its bulge,
 * the mean of r cos θ over −π/2…π/2; a circle's centre); and an upright
 * of length d at each corner, centred half way up, its sides in order
 * going counter-clockwise round the outline. A polygon's corner k ends side
 * k − 1 and starts side k as drawn, so a clockwise polygon's uprights list
 * side k first. A slot runs counter-clockwise as drawn: bottom line,
 * right half circle, top line, left half circle.
 */
function extrudeEdges(s: ModelShape, sides: readonly FaceName[], start: FaceName, end: FaceName, d: number, faults: ReadonlySet<ModelFault>): ModelEdge[] {
  const curves: { length: number; at: [number, number] }[] = [];
  const corners: { at: Point; before: number; after: number }[] = [];
  if (s.kind === "polygon") {
    const n = s.corners.length;
    const ccw = shoelace(s.corners) > 0 || faults.has("uprights-as-given");
    for (let k = 0; k < n; k++) {
      const [a, b] = [s.corners[k], s.corners[(k + 1) % n]];
      curves.push({ length: Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2), at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
      const prev = (k + n - 1) % n;
      corners.push({ at: a, before: ccw ? prev : k, after: ccw ? k : prev });
    }
  } else if (s.kind === "circle") {
    curves.push({ length: 2 * Math.PI * s.radius, at: [s.centre[0], s.centre[1]] });
  } else {
    const [x, y, L, r] = [s.at[0], s.at[1], s.length, s.radius];
    const off = (2 * r) / Math.PI;
    curves.push({ length: L, at: [x + L / 2, y - r] }, { length: Math.PI * r, at: [x + L + off, y] }, { length: L, at: [x + L / 2, y + r] }, { length: Math.PI * r, at: [x - off, y] });
    const at: Point[] = [[x + L, y - r], [x + L, y + r], [x, y + r], [x, y - r]];
    for (let k = 0; k < 4; k++) corners.push({ at: at[k], before: k, after: (k + 1) % 4 });
  }
  // Planted bugs: "cap-edges-swapped" puts each curve's start-cap edge at the end cap's height and back;
  // "uprights-as-given" (above) orders a clockwise polygon's uprights as drawn.
  const [z0, z1] = faults.has("cap-edges-swapped") ? [d, 0] : [0, d];
  return [
    ...curves.flatMap((c, k): ModelEdge[] => [
      { name: edgeName(start, sides[k], false), length: c.length, centroid: [c.at[0], c.at[1], z0] },
      // Planted bug ("end-edges-named-start"): the end cap's edges named after the start cap.
      { name: edgeName(faults.has("end-edges-named-start") ? start : end, sides[k], false), length: c.length, centroid: [c.at[0], c.at[1], z1] },
    ]),
    ...corners.map((c): ModelEdge => ({ name: edgeName(sides[c.before], sides[c.after], true), length: d, centroid: [c.at[0], c.at[1], d / 2] })),
  ];
}

/** A preset's body. The box has a corner at the origin and the opposite one at (w, d, h); the cylinder and sphere are on the Z axis, the cylinder standing on z = 0, the sphere centred on the origin (kernel/src/ops/primitives.rs). */
function presetBody(item: Extract<ModelItem, { kind: PresetKind }>, faults: ReadonlySet<ModelFault>): ModelBody {
  const f = (role: FaceRole, area: number, centroid: Vec3): ModelFace => ({ name: { feature: item.id, role }, area, centroid });
  const e = (a: FaceRole, b: FaceRole, length: number, centroid: Vec3): ModelEdge => ({ name: edgeName({ feature: item.id, role: a }, { feature: item.id, role: b }, false), length, centroid });
  if (item.kind === "box") {
    const [w, d, h] = [item.width, item.depth, item.height];
    // Edges: the bottom's and the top's four sides, and the four uprights.
    return {
      volume: w * d * h,
      faces: [
        f("bottom", w * d, [w / 2, d / 2, 0]),
        f("top", w * d, [w / 2, d / 2, h]),
        f("front", w * h, [w / 2, 0, h / 2]),
        f("back", w * h, [w / 2, d, h / 2]),
        f("left", d * h, [0, d / 2, h / 2]),
        f("right", d * h, [w, d / 2, h / 2]),
      ],
      edges: [
        ...(["bottom", "top"] as const).flatMap((cap) => {
          const z = cap === "bottom" ? 0 : h;
          return [e(cap, "front", w, [w / 2, 0, z]), e(cap, "back", w, [w / 2, d, z]), e(cap, "left", d, [0, d / 2, z]), e(cap, "right", d, [w, d / 2, z])];
        }),
        e("front", "left", h, [0, 0, h / 2]),
        e("front", "right", h, [w, 0, h / 2]),
        e("back", "left", h, [0, d, h / 2]),
        e("back", "right", h, [w, d, h / 2]),
      ],
    };
  }
  const r = item.diameter / 2;
  const rim = 2 * Math.PI * r;
  if (item.kind === "cylinder") {
    const h = item.height;
    return {
      volume: Math.PI * r * r * h,
      faces: [f("bottom", Math.PI * r * r, [0, 0, 0]), f("top", Math.PI * r * r, [0, 0, h]), f("side", 2 * Math.PI * r * h, [0, 0, h / 2])],
      edges: [e("bottom", "side", rim, [0, 0, 0]), e("top", "side", rim, [0, 0, h])],
    };
  }
  // A hemisphere's surface centroid is r/2 from the centre (Archimedes: equal heights, equal areas, so the mean height is half way).
  // Planted bug ("sphere-one-name"): both halves named upper.
  const lower = faults.has("sphere-one-name") ? "upper" : "lower";
  return {
    volume: (4 / 3) * Math.PI * r ** 3,
    faces: [f("upper", 2 * Math.PI * r * r, [0, 0, r / 2]), f(lower, 2 * Math.PI * r * r, [0, 0, -r / 2])],
    edges: [e("upper", lower, rim, [0, 0, 0])],
  };
}

// ---------------------------------------------------------------- rebuild

type SketchItem = Extract<ModelItem, { kind: "sketch" }>;

/**
 * Why a sketch makes no outline to extrude, or null when it makes one. Its
 * curves join where their ends meet, so a deleted curve, or two corners
 * that aren't neighbours in one place (four ends meeting: a branch), leave
 * no single loop: "open-outline". A loop that touches or crosses itself,
 * doubles back or has a side of length 0 is "invalid-outline".
 */
export function outlineProblem(s: Pick<SketchItem, "shape" | "curves">): LostCause | null {
  if (s.curves.some((c) => c === null)) return "open-outline";
  if (s.shape.kind !== "polygon") return null;
  const cs = s.shape.corners;
  const n = cs.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) if (!(i === 0 && j === n - 1) && cs[i][0] === cs[j][0] && cs[i][1] === cs[j][1]) return "open-outline";
  return polygonValid(cs) ? null : "invalid-outline";
}

/**
 * Rebuilds the document from scratch: every item in order, nothing after
 * the marker, suppressed items skipped, an item built on a suppressed or
 * greyed one greyed (26e), an item whose input is missing or failed failed
 * with that cause.
 */
export function rebuild(doc: ModelDoc, faults: ReadonlySet<ModelFault> = new Set()): Rebuild {
  const results: Record<string, ItemResult> = {};
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  let rolled = doc.marker === "start" && !faults.has("ignore-marker");
  for (const item of doc.items) {
    if (rolled) results[item.id] = { status: "rolled-back" };
    else if (item.suppressed && !faults.has("build-suppressed")) results[item.id] = { status: "suppressed" };
    else results[item.id] = build(item, byId, results, faults);
    if (doc.marker === item.id && !faults.has("ignore-marker")) rolled = true;
  }
  return { order: doc.items.map((i) => i.id), results };
}

/** Greyed by what greys `input` (26e, Q3): `id` itself when it is suppressed, else whatever greys it; null when it is on. */
const greyedBy = (input: ItemResult | undefined, id: string): string | null => (input?.status === "suppressed" ? id : input?.status === "greyed" ? input.by : null);

function build(item: ModelItem, byId: Map<string, ModelItem>, done: Record<string, ItemResult>, faults: ReadonlySet<ModelFault>): ItemResult {
  if (item.kind === "sketch") return placeSketch(item, done, faults);
  if (item.kind !== "extrude") return { status: "built", body: presetBody(item, faults) };
  const sketch = byId.get(item.sketch);
  if (sketch === undefined) return lost(item, "deleted-input", faults);
  const input = done[item.sketch];
  // Only reachable with "reorder-past-dependency" planted: the sketch comes later.
  if (input === undefined) return { status: "failed", cause: "failed-input", input: item.sketch };
  const by = greyedBy(input, item.sketch);
  // Planted bug: the rule before 26e, an extrude of a suppressed sketch failing rather than greyed.
  if (by !== null) return faults.has("suppress-fails-dependents") && input.status === "suppressed" ? { status: "failed", cause: "failed-input", input: item.sketch } : { status: "greyed", by };
  if (input.status !== "built") return { status: "failed", cause: "failed-input", input: item.sketch };
  if (sketch.kind !== "sketch") throw new Error(`${item.id} extrudes ${sketch.id}, which is not a sketch`);
  // Rule 7: built where its held sketch lies, saying its source is lost.
  const source = input.plane ? { source: item.sketch } : {};
  const problem = outlineProblem(sketch);
  if (problem !== null) return { ...lost(item, problem, faults), ...source };
  // Planted bug: the kept shape is used even once the sketch makes an outline again.
  if (faults.has("kept-not-forgotten") && item.kept) return { ...lost(item, "open-outline", faults), ...source };
  return { status: "built", body: lifted(extrudeBody(item.id, sketch.shape, sketch.curves as string[], item.distance, faults), input.lift), ...source };
}

/** An extrude whose sketch is lost: its kept shape (where it lay) with a warning, or failed with the cause when it has none. */
function lost(item: Extract<ModelItem, { kind: "extrude" }>, cause: LostCause, faults: ReadonlySet<ModelFault>): ItemResult {
  if (item.kept === undefined) return { status: "failed", cause, input: item.sketch };
  const body = lifted(extrudeBody(item.id, item.kept.shape, item.kept.curves, item.distance, faults), item.kept.lift);
  // Planted bug: the kept shape is built, but nothing says so.
  return faults.has("warning-dropped") ? { status: "built", body } : { status: "built", body, warning: { cause, input: item.sketch } };
}

/** A body moved up by `z` (an extrude of a sketch on a face, 26e): every face's and edge's centroid; volumes, areas and lengths stay. */
function lifted(body: ModelBody, z: number | undefined): ModelBody {
  if (z === undefined) return body;
  const up = (c: Vec3): Vec3 => [c[0], c[1], c[2] + z];
  return { volume: body.volume, faces: body.faces.map((f) => ({ ...f, centroid: up(f.centroid) })), edges: body.edges.map((e) => ({ ...e, centroid: up(e.centroid) })) };
}

/**
 * A sketch's result. On XY, built. On a face (26e): greyed while its
 * face's feature is suppressed or greyed (Q3); else at the height of the
 * face its name finds on that feature's body; else held at its last height
 * (or where it was drawn, when it holds none) with "plane-lost".
 */
function placeSketch(item: SketchItem, done: Record<string, ItemResult>, faults: ReadonlySet<ModelFault>): ItemResult {
  if (item.on === undefined) return { status: "built" };
  const on = done[item.on.feature];
  const by = greyedBy(on, item.on.feature);
  // Planted bug ("greyed-warns"): a sketch on a suppressed feature says its plane is lost instead of being greyed.
  if (by !== null && !faults.has("greyed-warns")) return { status: "greyed", by };
  if (on?.status === "built" && on.body) {
    const face = on.body.faces.find((f) => f.name.role === item.on!.role);
    if (face) return { status: "built", lift: face.centroid[2] };
  }
  return { status: "built", lift: item.on.held ?? item.on.drawn, plane: "plane-lost" };
}

/**
 * The owner's rule, after an edit from `before` to `doc`: an extrude whose
 * sketch is lost now (gone, or no outline; suppression and the marker
 * don't count) keeps the sketch as it was in `before`, if it made an
 * outline there and the extrude has no kept shape yet; an extrude whose
 * sketch makes an outline forgets its kept shape.
 */
function settle(before: ModelDoc, doc: ModelDoc, faults: ReadonlySet<ModelFault>): void {
  const sketchIn = (d: ModelDoc, id: string) => d.items.find((i): i is SketchItem => i.id === id && i.kind === "sketch");
  // Where each face sketch lay in `before` with nothing suppressed and no marker (26e).
  let was: Rebuild | undefined;
  const liftBefore = (id: string) => {
    was ??= rebuild(opened(before), faults);
    const r = was.results[id];
    return r?.status === "built" ? r.lift : undefined;
  };
  for (const item of doc.items) {
    if (item.kind !== "extrude") continue;
    const now = sketchIn(doc, item.sketch);
    if (now !== undefined && outlineProblem(now) === null) {
      if (!faults.has("kept-not-forgotten")) delete item.kept;
      continue;
    }
    const sketch = sketchIn(before, item.sketch);
    if (item.kept !== undefined || sketch === undefined || outlineProblem(sketch) !== null || faults.has("lost-sketch-fails")) continue;
    const lift = sketch.on ? liftBefore(sketch.id) : undefined;
    item.kept = { shape: JSON.parse(JSON.stringify(sketch.shape)), curves: [...(sketch.curves as string[])], ...(lift === undefined ? {} : { lift }) };
  }
  // A face sketch whose face is gone (with nothing suppressed and no marker) holds the height it had in `before`, if it
  // holds none yet; one whose face is there forgets it (the naming model's `settle`).
  if (!doc.items.some((i) => i.kind === "sketch" && i.on)) return;
  const now = rebuild(opened(doc), faults);
  for (const item of doc.items) {
    if (item.kind !== "sketch" || item.on === undefined) continue;
    const r = now.results[item.id];
    if (r?.status !== "built" || r.plane === undefined) delete item.on.held;
    // Planted bug ("lost-plane-not-held"): nothing is held, so a lost sketch goes back to where it was drawn.
    else if (item.on.held === undefined && !faults.has("lost-plane-not-held")) {
      const lift = liftBefore(item.id);
      if (lift !== undefined) item.on.held = lift;
    }
  }
}

/** The document with nothing suppressed and no marker: where everything would be, which is what a face sketch holds when its face goes. */
function opened(doc: ModelDoc): ModelDoc {
  const d = clone(doc);
  for (const i of d.items) i.suppressed = false;
  d.marker = null;
  return d;
}

/**
 * What each built body is made from (step 24e), for checking that a
 * rebuild builds only what changed. `spec`: everything the body is built
 * from, its item's id left out (two presets of one size, or two extrudes of
 * one sketch by one distance, are one build): a preset's kind and sizes, an
 * extrude's distance and the shape it is built from (its sketch's, or its
 * kept shape while the sketch is lost) with that shape's curve ids, which
 * decide its side names. `shape`: the solid alone, the polygon's corners
 * sorted, so the same solid drawn from another corner or with other curve
 * ids has the same one. A body cache keyed by what it builds from must
 * build at least the bodies whose `shape` the last rebuild didn't hold and
 * at most those whose `spec` it didn't.
 */
export function bodyKeys(doc: ModelDoc, r: Rebuild): Map<string, { spec: string; shape: string }> {
  const out = new Map<string, { spec: string; shape: string }>();
  const byId = new Map(doc.items.map((i) => [i.id, i]));
  const solid = (s: ModelShape) =>
    JSON.stringify(s.kind === "polygon" ? { kind: s.kind, corners: [...s.corners].map((c) => [...c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) } : s);
  for (const id of r.order) {
    const res = r.results[id];
    const item = byId.get(id);
    if (res.status !== "built" || res.body === undefined || item === undefined) continue;
    if (item.kind === "extrude") {
      const from = res.warning ? item.kept : (byId.get(item.sketch) as SketchItem | undefined);
      if (from === undefined) throw new Error(`harness: ${id} is built from nothing`);
      // Where it is built (26e): its kept shape's height, or its sketch's now; null on XY.
      const sketch = r.results[item.sketch];
      const lift = (res.warning ? item.kept?.lift : sketch?.status === "built" ? sketch.lift : undefined) ?? null;
      out.set(id, {
        spec: JSON.stringify(["extrude", from.shape, from.curves, item.distance, lift]),
        shape: JSON.stringify(["extrude", solid(from.shape), item.distance, lift]),
      });
    } else if (item.kind !== "sketch") {
      const { id: _, suppressed: __, ...sizes } = item;
      out.set(id, { spec: JSON.stringify(sizes), shape: JSON.stringify(sizes) });
    }
  }
  return out;
}

/** The fewest and the most bodies a cache holding `before`'s bodies must build to give `after` (see `bodyKeys`). */
export function buildBounds(before: Iterable<{ spec: string; shape: string }>, after: Iterable<{ spec: string; shape: string }>): { least: number; most: number } {
  const had = [...before];
  const now = [...after];
  const fresh = (k: "spec" | "shape") => new Set(now.map((x) => x[k]).filter((x) => !had.some((h) => h[k] === x))).size;
  return { least: fresh("shape"), most: fresh("spec") };
}

// ---------------------------------------------------------------- edits

const clone = (d: ModelDoc): ModelDoc => JSON.parse(JSON.stringify(d));
const snapshot = (d: ModelDoc) => JSON.stringify(d);

/** The index new items go in at: just after the marker, or at the end. */
export function insertAt(doc: ModelDoc): number {
  if (doc.marker === null) return doc.items.length;
  if (doc.marker === "start") return 0;
  return doc.items.findIndex((i) => i.id === doc.marker) + 1;
}

/** The sizes an item has that a typed value can change. */
export function sizeKeys(item: ModelItem): SizeKey[] {
  switch (item.kind) {
    case "extrude":
      return ["distance"];
    case "box":
      return ["width", "depth", "height"];
    case "cylinder":
      return ["diameter", "height"];
    case "sphere":
      return ["diameter"];
    case "sketch":
      return item.shape.kind === "circle" ? ["radius"] : item.shape.kind === "slot" ? ["length", "radius"] : [];
  }
}

/**
 * The model's state and its undo history (two stacks of whole-document
 * snapshots, the rule of docs/document-model.md section 4: every edit that
 * changes the document is one step; one that changes nothing records
 * nothing and keeps the redo).
 */
export interface TimelineModel {
  doc: ModelDoc;
  undo: string[];
  redo: string[];
  faults: ReadonlySet<ModelFault>;
}

export const createModel = (faults: Iterable<ModelFault> = []): TimelineModel => ({ doc: emptyDoc(), undo: [], redo: [], faults: new Set(faults) });

function newId(doc: ModelDoc, prefix: string, faults: ReadonlySet<ModelFault>): string {
  if (faults.has("reuse-ids")) {
    // Planted bug: "the largest id + 1" instead of the counter.
    const used = doc.items.flatMap((i) => [i.id, ...(i.kind === "sketch" ? i.curves.filter((c): c is string => c !== null) : [])]);
    const n = Math.max(0, ...used.map((u) => Number(u.split("-")[1]))) + 1;
    doc.nextId = Math.max(doc.nextId, n + 1);
    return `${prefix}-${n}`;
  }
  return `${prefix}-${doc.nextId++}`;
}

/** Applies one edit to the model, recording an undo step when it changed the document. */
export function applyOp(m: TimelineModel, op: ConcreteOp): Applied {
  if (op.op === "undo" || op.op === "redo") {
    const [from, to] = op.op === "undo" ? [m.undo, m.redo] : [m.redo, m.undo];
    const back = from.pop();
    if (back === undefined) return { kind: "unchanged" };
    to.push(snapshot(m.doc));
    m.doc = JSON.parse(back);
    return { kind: "done", ids: [] };
  }
  const before = snapshot(m.doc);
  const doc = clone(m.doc);
  const r = edit(doc, op, m.faults);
  if (r.kind === "refused") return r;
  settle(m.doc, doc, m.faults);
  if (snapshot(doc) === before) return { kind: "unchanged" };
  m.undo.push(before);
  if (!m.faults.has("keep-redo")) m.redo = [];
  m.doc = doc;
  return r;
}

function find(doc: ModelDoc, id: string): ModelItem {
  const item = doc.items.find((i) => i.id === id);
  if (item === undefined) throw new Error(`no item ${id}`);
  return item;
}

function sketchOf(doc: ModelDoc, id: string): SketchItem {
  const item = find(doc, id);
  if (item.kind !== "sketch") throw new Error(`${id} is not a sketch`);
  return item;
}

function insert(doc: ModelDoc, item: ModelItem) {
  doc.items.splice(insertAt(doc), 0, item);
  if (doc.marker !== null) doc.marker = item.id;
}

function edit(doc: ModelDoc, op: Exclude<ConcreteOp, { op: "undo" | "redo" }>, faults: ReadonlySet<ModelFault>): Applied {
  switch (op.op) {
    case "add-sketch": {
      const item: SketchItem = { id: newId(doc, "item", faults), kind: "sketch", shape: JSON.parse(JSON.stringify(op.shape)), curves: [], suppressed: false };
      insert(doc, item);
      for (let k = 0; k < curveCount(op.shape); k++) item.curves.push(newId(doc, "curve", faults));
      return { kind: "done", ids: [item.id, ...(item.curves as string[])] };
    }
    case "add-face-sketch": {
      // Drawn at the face's height now (the session only picks a face a built body has, before where it goes in).
      const res = rebuild(doc, faults).results[op.face.feature];
      const face = res?.status === "built" ? res.body?.faces.find((f) => faceKey(f.name) === faceKey(op.face)) : undefined;
      if (face === undefined || (op.face.role !== "top" && op.face.role !== "end")) throw new Error(`no flat face ${faceKey(op.face)} to sketch on`);
      const on: OnFace = { feature: op.face.feature, role: op.face.role, drawn: face.centroid[2] };
      const item: SketchItem = { id: newId(doc, "item", faults), kind: "sketch", shape: JSON.parse(JSON.stringify(op.shape)), curves: [], suppressed: false, on };
      insert(doc, item);
      for (let k = 0; k < curveCount(op.shape); k++) item.curves.push(newId(doc, "curve", faults));
      return { kind: "done", ids: [item.id, ...(item.curves as string[])] };
    }
    case "add-extrude": {
      const id = newId(doc, "item", faults);
      insert(doc, { id, kind: "extrude", sketch: op.sketch, distance: op.distance, suppressed: false });
      return { kind: "done", ids: [id] };
    }
    case "add-preset": {
      const id = newId(doc, "item", faults);
      const [a, b, c] = op.sizes;
      const item: ModelItem =
        op.kind === "box"
          ? { id, kind: "box", width: a, depth: b, height: c, suppressed: false }
          : op.kind === "cylinder"
            ? { id, kind: "cylinder", diameter: a, height: b, suppressed: false }
            : { id, kind: "sphere", diameter: a, suppressed: false };
      insert(doc, item);
      return { kind: "done", ids: [id] };
    }
    case "set-size": {
      const item = find(doc, op.item);
      if (!sizeKeys(item).includes(op.key)) throw new Error(`${op.item} has no ${op.key}`);
      if (item.kind === "sketch") (item.shape as Record<string, unknown>)[op.key] = op.value;
      else (item as Record<string, unknown>)[op.key] = op.value;
      // Planted bug: a distance typed for one extrude lands on the first one too.
      const first = doc.items.find((i) => i.kind === "extrude");
      if (faults.has("edit-leaks") && item.kind === "extrude" && first?.kind === "extrude") first.distance = op.value;
      return { kind: "done", ids: [] };
    }
    case "move-corner": {
      const s = sketchOf(doc, op.sketch);
      if (s.shape.kind !== "polygon") throw new Error(`${op.sketch} has no corners`);
      s.shape.corners[op.corner] = op.to;
      return { kind: "done", ids: [] };
    }
    case "delete-curve": {
      const s = sketchOf(doc, op.sketch);
      const k = s.curves.indexOf(op.curve);
      if (k < 0) throw new Error(`${op.sketch} has no curve ${op.curve}`);
      s.curves[k] = null;
      return { kind: "done", ids: [] };
    }
    case "redraw-curve": {
      const s = sketchOf(doc, op.sketch);
      if (s.curves[op.index] !== null) throw new Error(`${op.sketch} curve ${op.index} is not deleted`);
      const id = newId(doc, "curve", faults);
      s.curves[op.index] = id;
      return { kind: "done", ids: [id] };
    }
    case "delete-item": {
      const k = doc.items.findIndex((i) => i.id === op.item);
      if (k < 0) throw new Error(`no item ${op.item}`);
      if (doc.marker === op.item) doc.marker = k === 0 ? "start" : doc.items[k - 1].id;
      doc.items.splice(k, 1);
      // Planted bug: the items that used it vanish with it, silently.
      if (faults.has("cascade-delete")) doc.items = doc.items.filter((i) => !dependsOn(i).includes(op.item));
      return { kind: "done", ids: [] };
    }
    case "reorder": {
      const k = doc.items.findIndex((i) => i.id === op.item);
      const [item] = doc.items.splice(k, 1);
      doc.items.splice(op.to, 0, item);
      if (!faults.has("reorder-past-dependency")) {
        const at = (id: string) => doc.items.findIndex((i) => i.id === id);
        // Planted bug ("face-sketch-unbound"): a sketch on a face isn't held to its face's feature (answer 7).
        const deps = (i: ModelItem) => (faults.has("face-sketch-unbound") && i.kind === "sketch" ? [] : dependsOn(i));
        if (deps(item).some((d) => at(d) > op.to)) return { kind: "refused", cause: "before-dependency" };
        if (doc.items.some((i, j) => j < op.to && deps(i).includes(item.id))) return { kind: "refused", cause: "after-dependent" };
      }
      return { kind: "done", ids: [] };
    }
    case "suppress":
      find(doc, op.item).suppressed = op.on;
      return { kind: "done", ids: [] };
    case "marker":
      doc.marker = op.at;
      return { kind: "done", ids: [] };
  }
}

/** The face a name points at in a rebuild, or null when no built body has it. */
export function resolveFace(r: Rebuild, name: FaceName): ModelFace | null {
  const key = faceKey(name);
  for (const id of r.order) {
    const res = r.results[id];
    if (res.status !== "built" || res.body === undefined) continue;
    const f = res.body.faces.find((x) => faceKey(x.name) === key);
    if (f) return f;
  }
  return null;
}
