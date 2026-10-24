// Seeded random timeline sessions (steps 24-25): the harness that checks a
// timeline implementation (the "subject") against the model in
// timeline-model.ts, step by step.
//
// A session is a list of steps whose targets are fractions, picked against
// the document as it is when the step runs ("the 0.37th sketch"), so every
// list replays and any step can be dropped when shrinking. Each step runs
// on the model and on the subject, then the harness checks:
// - the edit's outcome (done, unchanged, refused and why) is the model's;
// - every new id is one no state that undo or redo can reach holds;
// - rebuilding twice gives the same result, and so does a rebuild from
//   scratch when the subject has a cache;
// - the rebuild is the model's: build order, each item's status and cause,
//   each body's volume, each face by name with its area and centroid, and
//   each edge by name (its two faces, step 24c) with its length and
//   centroid;
// - no two faces in the document share a name, nor two edges;
// - an edit to one item changes nothing that doesn't depend on it (checked
//   on the subject alone, without the model);
// - every face reference held earlier resolves to the face with that name
//   when the model still has it, and to nothing when it doesn't, never to
//   another face, nor to "two or more faces" (step 25a4: the model's names
//   are unique, so such an answer is a naming bug);
// - saving and opening changes neither the rebuild nor the saved text;
// - when the subject counts the bodies its rebuild builds (`builds`, step
//   24e), the first rebuild after each step builds no fewer than the bodies
//   whose solid the last rebuild didn't hold and no more than those whose
//   inputs it didn't (`buildBounds`): an edit rebuilds what it changed and
//   nothing else.
// The model itself runs as a subject (`modelSubject`), with bugs planted
// through `faults` to show each check can fail; from 24d2 Design's real
// timeline on the real kernel runs too (journeys/timeline.journey.ts), so a
// subject's answers may be promises.

import { seeded, type SeededRandom } from "./index.ts";
import { LANDED } from "./landed.ts";
import {
  applyOp,
  bodyKeys,
  buildBounds,
  createModel,
  dependsOn,
  edgeKey,
  edgeName,
  faceKey,
  insertAt,
  outlineProblem,
  rebuild,
  resolveFace,
  sizeKeys,
  type Applied,
  type ConcreteOp,
  type FaceName,
  type ItemResult,
  type ModelDoc,
  type ModelFault,
  type ModelShape,
  type Point,
  type PresetKind,
  type Rebuild,
  type TimelineModel,
} from "./timeline-model.ts";

/** One random step. `pick` and `to` are fractions in [0, 1), resolved against the document when the step runs. */
export type SessionOp =
  | { op: "add-sketch"; shape: ModelShape }
  /** 26e: a sketch on the `pick`th face a sketch can go on (a box's or cylinder's top, an extrude's end, of a body built before where it goes in). */
  | { op: "add-face-sketch"; pick: number; shape: ModelShape }
  | { op: "add-extrude"; pick: number; distance: number }
  | { op: "add-preset"; kind: PresetKind; sizes: number[] }
  | { op: "set-size"; pick: number; value: number }
  | { op: "move-corner"; pick: number; to: Point }
  | { op: "delete-curve"; pick: number }
  | { op: "redraw-curve"; pick: number }
  | { op: "delete-item"; pick: number }
  | { op: "reorder"; pick: number; to: number }
  | { op: "suppress"; pick: number }
  | { op: "marker"; pick: number }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "save-open" }
  | { op: "hold-ref"; pick: number }
  | WaitingOp;

/** The operations a boolean move can ask for (35b: union, subtract, intersect). */
export type BooleanKind = "join" | "cut" | "intersect";

/**
 * A move the session bots gain when its step lands (`WAITING_MOVES`, step
 * 30d). Until then `randomOp` never draws one, and a session that meets one
 * stops with a `WaitingMoveError`, so a step turned on before the model and
 * Design can answer its moves fails loudly instead of passing quietly.
 */
export type WaitingOp =
  /** 35: a Combine of the `target`th body shown with the `tool`th other one; the tool kept or used up. */
  | { op: "add-combine"; target: number; tool: number; operation: BooleanKind; keep: boolean }
  /** 35: the `pick`th Combine's operation changed, an edit early in the timeline that every later feature must survive. */
  | { op: "set-combine"; pick: number; operation: BooleanKind }
  /** 39: an extrude of the `pick`th sketch that joins, cuts or intersects the bodies it overlaps. */
  | { op: "add-extrude-into"; pick: number; distance: number; operation: BooleanKind }
  /** 39: the `pick`th extrude's operation changed, a new body included. */
  | { op: "set-extrude-operation"; pick: number; operation: BooleanKind | "new-body" };

/** One waiting move: when it turns on, how often it is drawn, and what the model and Design must answer once it does. */
export interface WaitingMove {
  op: WaitingOp["op"];
  /** The step that turns it on (in `LANDED`, landed.ts). */
  from: string;
  /** Its weight among `WEIGHTS` once on. */
  weight: number;
  /** What the user does in Design, as the step's panel will have it. */
  does: string;
  /** What the timeline model and the harness must answer, from the decisions already made; the step's thread writes it into timeline-model.ts and timeline-design.ts. */
  model: string;
  draw(r: SeededRandom): WaitingOp;
}

const BOOLEAN_KINDS: readonly BooleanKind[] = ["join", "cut", "intersect"];

/**
 * The moves Combine (35) and Extrude's operations (39) bring to the
 * timeline sessions, written before either exists, as the golden models
 * waiting for those steps are (golden.ts, `from`). The naming sessions
 * already model the owner's cut cases (naming-session.ts, `cuts`), which run
 * on Design from 39b.
 */
export const WAITING_MOVES: readonly WaitingMove[] = [
  {
    op: "add-combine",
    from: "35",
    weight: 6,
    does: "Combine (35f): pick a target body and a tool body among those shown before where the new item goes, Join, Cut or Intersect, Keep tools off unless asked; a new timeline item built on both.",
    model:
      "The result is the boolean of the two bodies as they are built at that point (35b), so its volume is the exact one of the two inputs' shapes; a result touching itself along an edge or at a corner fails with its places (B0 decision 2), an intersect of parts that only touch or miss gives no body, a cut that leaves pieces gives one body per piece (decision 3), and a face thinner than MIN_FEATURE fails naming it (decision 6). A body with a curved face (cylinder, sphere, arc sides) is refused naming the face until 37/38a, and faces lying on each other until 36a. The target keeps its row and is shown from the Combine on (34a rule 1); a tool is used up unless kept. Editing, suppressing, deleting or moving either input rebuilds the Combine, and deleting one asks first (timeline rules).",
    draw: (r) => ({ op: "add-combine", target: r.next(), tool: r.next(), operation: pick(r, BOOLEAN_KINDS), keep: r.next() < 0.25 }),
  },
  {
    op: "set-combine",
    from: "35",
    weight: 3,
    does: "Edit a Combine and change its operation (Join to Cut, say).",
    model: "The Combine's result is redone with the new operation and everything after it rebuilds against it; held references to faces the new result no longer has resolve to nothing, never to another face (25a4).",
    draw: (r) => ({ op: "set-combine", pick: r.next(), operation: pick(r, BOOLEAN_KINDS) }),
  },
  {
    op: "add-extrude-into",
    from: "39",
    weight: 8,
    does: "Extrude a sketch with Join, Cut or Intersect (39a): the bodies it overlaps when made are the ones it changes, kept by body id.",
    model:
      "The extrude's own body, then the boolean with each body it overlaps when made (Fusion check F4: a body made later in its path is not changed, even with the extrude dragged after it). \"No target body\" when it overlaps none (Ben's answers 2 and 6); a cut that would leave a body with nothing fails with words and changes nothing (F3); the rest as add-combine.",
    draw: (r) => ({ op: "add-extrude-into", pick: r.next(), distance: int(r, 1, 50), operation: pick(r, BOOLEAN_KINDS) }),
  },
  {
    op: "set-extrude-operation",
    from: "39",
    weight: 4,
    does: "Edit an extrude and change its operation, New body included.",
    model: "As add-extrude-into with the new operation, against the bodies the extrude was made with; to New body, the bodies it had changed come back as they were.",
    draw: (r) => ({ op: "set-extrude-operation", pick: r.next(), operation: pick(r, [...BOOLEAN_KINDS, "new-body"] as const) }),
  },
];

/** A waiting move met in a session: its step is in `LANDED` but the model doesn't know it yet. */
export class WaitingMoveError extends Error {
  constructor(op: WaitingOp) {
    const m = WAITING_MOVES.find((w) => w.op === op.op)!;
    super(`the session move ${op.op} waits for step ${m.from}: teach timeline-model.ts and timeline-design.ts what it does (WAITING_MOVES: ${m.model})`);
  }
}

type Maybe<T> = T | Promise<T>;

/** A timeline implementation under test. Ids in and out are its own; the harness maps the model's onto them. */
export interface TimelineSubject {
  /** What the subject holds before the first step (Design always has a part), as edits and the ids each made, run on the model first. */
  readonly initial?: readonly { op: ConcreteOp; ids: string[] }[];
  apply(op: ConcreteOp): Maybe<Applied>;
  rebuild(): Maybe<Rebuild>;
  /** A rebuild that ignores any cache; leave it out when there is none. */
  rebuildFromScratch?(): Maybe<Rebuild>;
  save(): Maybe<string>;
  /** Opens saved text, with a fresh undo history, as opening a file does; a document with nothing built too (Design from 24f4). */
  open(text: string): Maybe<void>;
  /**
   * The name of the face this name resolves to now, null when it resolves
   * to none, or "shared" when the subject finds two or more faces with it
   * and so resolves it to none of them (step 25a4).
   */
  resolve(name: FaceName): Maybe<FaceName | null | "shared">;
  /**
   * How many bodies `rebuild` has built so far (step 24e), when it keeps
   * them between rebuilds; a rebuild from scratch doesn't count. Leave it
   * out when there is nothing to count.
   */
  builds?(): Maybe<number>;
}

/** How the harness compares edges with the model's: to MATCH_REL unless the subject measures them on the display mesh (`edgeMatches` in the journeys). */
export type EdgeClose = (got: { length: number; centroid: readonly number[] }, want: { length: number; centroid: readonly number[] }) => boolean;

/**
 * Relative tolerance for volumes, areas and centroid coordinates, with a
 * floor of 1 mm: |a − b| ≤ MATCH_REL × max(1, |a|, |b|). It is the kernel's
 * MASS_PROPS_REL (kernel/src/tolerance.rs), the accuracy it promises for
 * volume and area; it changes only with that constant.
 */
export const MATCH_REL = 1e-6;

export const close = (a: number, b: number): boolean => Math.abs(a - b) <= MATCH_REL * Math.max(1, Math.abs(a), Math.abs(b));

/** A check that failed, at a step. */
export class TimelineFailure extends Error {
  readonly check: string;
  readonly step: number;
  constructor(check: string, step: number, op: SessionOp, detail: string) {
    super(`step ${step} ${JSON.stringify(op)}: ${check}: ${detail}`);
    this.check = check;
    this.step = step;
  }
}

/** How often each kind of thing happened in a session, e.g. "status:rolled-back", "refused:after-dependent", "ref:missing". */
export type SessionCounts = Record<string, number>;

// ---------------------------------------------------------------- random steps

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
const int = (r: SeededRandom, lo: number, hi: number) => lo + Math.floor(r.next() * (hi - lo + 1));

/**
 * A random sketch shape: a polygon of 3 to 6 corners round a point, on the
 * 1 mm grid (rounding sometimes makes one that crosses itself, which is
 * wanted: such a sketch can't be extruded until it is fixed), half of them
 * clockwise; or a circle; or a slot.
 */
export function randomShape(r: SeededRandom): ModelShape {
  const n = r.next();
  if (n < 0.6) {
    const count = int(r, 3, 6);
    const [cx, cy] = [int(r, -20, 20), int(r, -20, 20)];
    const angles = Array.from({ length: count }, () => r.next() * 2 * Math.PI).sort((a, b) => a - b);
    const corners = angles.map((a): Point => {
      const radius = int(r, 10, 40);
      return [Math.round(cx + radius * Math.cos(a)), Math.round(cy + radius * Math.sin(a))];
    });
    if (r.next() < 0.5) corners.reverse();
    return { kind: "polygon", corners };
  }
  if (n < 0.8) return { kind: "circle", centre: [int(r, -40, 40), int(r, -40, 40)], radius: int(r, 1, 30) };
  return { kind: "slot", at: [int(r, -40, 20), int(r, -40, 40)], length: int(r, 1, 40), radius: int(r, 1, 20) };
}

const WEIGHTS: [SessionOp["op"], number][] = [
  ["add-sketch", 10],
  ["add-extrude", 12],
  ["add-preset", 6],
  ["set-size", 14],
  ["move-corner", 10],
  ["delete-curve", 5],
  ["redraw-curve", 7],
  ["delete-item", 4],
  ["reorder", 10],
  ["suppress", 6],
  ["marker", 6],
  ["undo", 7],
  ["redo", 6],
  ["save-open", 2],
  ["hold-ref", 8],
  ["add-face-sketch", 8],
];

/**
 * One random step. The waiting moves whose step is in `landed` join the
 * draw after `WEIGHTS`; with none landed, every seed draws exactly the
 * steps it drew before they were written.
 */
export function randomOp(r: SeededRandom, landed: ReadonlySet<string> = LANDED): SessionOp {
  const on = WAITING_MOVES.filter((m) => landed.has(m.from));
  const weights: [SessionOp["op"], number][] = [...WEIGHTS, ...on.map((m): [SessionOp["op"], number] => [m.op, m.weight])];
  let x = r.next() * weights.reduce((s, [, w]) => s + w, 0);
  const [kind] = weights.find(([, w]) => (x -= w) < 0) ?? weights[0];
  const waiting = on.find((m) => m.op === kind);
  if (waiting) return waiting.draw(r);
  const base = kind as Exclude<SessionOp["op"], WaitingOp["op"]>;
  switch (base) {
    case "add-sketch":
      return { op: base, shape: randomShape(r) };
    case "add-face-sketch":
      return { op: base, pick: r.next(), shape: randomShape(r) };
    case "add-extrude":
      return { op: base, pick: r.next(), distance: int(r, 1, 50) };
    case "add-preset": {
      const k = pick(r, ["box", "cylinder", "sphere"] as const);
      return { op: base, kind: k, sizes: Array.from({ length: k === "box" ? 3 : k === "cylinder" ? 2 : 1 }, () => int(r, 1, 60)) };
    }
    case "set-size":
      return { op: base, pick: r.next(), value: int(r, 1, 60) };
    case "move-corner":
      return { op: base, pick: r.next(), to: [int(r, -60, 60), int(r, -60, 60)] };
    case "reorder":
      return { op: base, pick: r.next(), to: r.next() };
    case "undo":
    case "redo":
    case "save-open":
      return { op: base };
    default:
      return { op: base, pick: r.next() };
  }
}

/** A seeded session's steps: the same seed gives the same steps. */
export const randomSession = (seed: bigint, steps: number, landed: ReadonlySet<string> = LANDED): SessionOp[] => {
  const r = seeded(seed);
  return Array.from({ length: steps }, () => randomOp(r, landed));
};

// ---------------------------------------------------------------- resolving steps

type Resolved = { kind: "edit"; op: ConcreteOp } | { kind: "save-open" } | { kind: "hold-ref"; name: FaceName } | null;

const choose = <T>(xs: readonly T[], f: number): T | undefined => (xs.length ? xs[Math.floor(f * xs.length)] : undefined);

/** The step's targets in the model's ids, or null when nothing in the document fits (the step is skipped). */
export function resolveStep(doc: ModelDoc, step: SessionOp): Resolved {
  const sketches = doc.items.flatMap((i) => (i.kind === "sketch" ? [i] : []));
  const edit = (op: ConcreteOp | undefined): Resolved => (op === undefined ? null : { kind: "edit", op });
  switch (step.op) {
    case "add-sketch":
      return edit({ op: "add-sketch", shape: step.shape });
    case "add-face-sketch": {
      // As in the app: a flat face of a body shown, before where the new item goes (26e: the faces facing +Z).
      const built = rebuild(doc);
      const before = new Set(doc.items.slice(0, insertAt(doc)).map((i) => i.id));
      const faces = built.order.flatMap((id) => {
        const res = built.results[id];
        return before.has(id) && res.status === "built" && res.body ? res.body.faces.filter((f) => f.name.role === "top" || f.name.role === "end").map((f) => f.name) : [];
      });
      const face = choose(faces, step.pick);
      return edit(face && { op: "add-face-sketch", shape: step.shape, face });
    }
    case "add-preset":
      return edit({ op: "add-preset", kind: step.kind, sizes: step.sizes });
    case "add-extrude": {
      // As in the app: only a built sketch with a closed outline, before where the new item goes.
      const built = rebuild(doc).results;
      const before = new Set(doc.items.slice(0, insertAt(doc)).map((i) => i.id));
      const s = choose(
        sketches.filter((x) => before.has(x.id) && built[x.id].status === "built" && outlineProblem(x) === null),
        step.pick,
      );
      return edit(s && { op: "add-extrude", sketch: s.id, distance: step.distance });
    }
    case "set-size": {
      const c = choose(
        doc.items.flatMap((i) => sizeKeys(i).map((key) => ({ item: i.id, key }))),
        step.pick,
      );
      return edit(c && { op: "set-size", ...c, value: step.value });
    }
    case "move-corner": {
      const c = choose(
        sketches.flatMap((s) => {
          if (s.shape.kind !== "polygon") return [];
          const n = s.shape.corners.length;
          // A corner both of whose sides are deleted is gone from the sketch.
          return s.shape.corners.flatMap((_, k) => (s.curves[k] !== null || s.curves[(k + n - 1) % n] !== null ? [{ s, k }] : []));
        }),
        step.pick,
      );
      if (c === undefined || c.s.shape.kind !== "polygon") return null;
      // New places never land on a corner already there (points join only when drawn onto one).
      if (c.s.shape.corners.some((p) => p[0] === step.to[0] && p[1] === step.to[1])) return null;
      return edit({ op: "move-corner", sketch: c.s.id, corner: c.k, to: step.to });
    }
    case "delete-curve": {
      const c = choose(
        sketches.flatMap((s) => s.curves.flatMap((curve) => (curve === null ? [] : [{ sketch: s.id, curve }]))),
        step.pick,
      );
      return edit(c && { op: "delete-curve", ...c });
    }
    case "redraw-curve": {
      const c = choose(
        sketches.flatMap((s) => s.curves.flatMap((curve, index) => (curve === null ? [{ sketch: s.id, index }] : []))),
        step.pick,
      );
      return edit(c && { op: "redraw-curve", ...c });
    }
    case "delete-item": {
      const i = choose(doc.items, step.pick);
      return edit(i && { op: "delete-item", item: i.id });
    }
    case "reorder": {
      const i = choose(doc.items, step.pick);
      return edit(i && { op: "reorder", item: i.id, to: Math.floor(step.to * doc.items.length) });
    }
    case "suppress": {
      const i = choose(doc.items, step.pick);
      return edit(i && { op: "suppress", item: i.id, on: !i.suppressed });
    }
    case "marker":
      // Half the time back to the end, so most of a session builds.
      return edit({ op: "marker", at: step.pick < 0.5 ? null : (choose(["start", ...doc.items.map((i) => i.id)], 2 * step.pick - 1) ?? null) });
    case "undo":
    case "redo":
      return edit({ op: step.op });
    case "save-open":
      return { kind: "save-open" };
    case "hold-ref": {
      const r = rebuild(doc);
      const faces = r.order.flatMap((id) => {
        const res = r.results[id];
        return res.status === "built" && res.body ? res.body.faces.map((f) => f.name) : [];
      });
      const name = choose(faces, step.pick);
      return name ? { kind: "hold-ref", name } : null;
    }
    case "add-combine":
    case "set-combine":
    case "add-extrude-into":
    case "set-extrude-operation":
      throw new WaitingMoveError(step);
  }
}

// ---------------------------------------------------------------- comparing

const sameName = (a: FaceName, b: FaceName) => faceKey(a) === faceKey(b);

/** The first difference between two items' results, or null. */
const exactEdges: EdgeClose = (a, b) => close(a.length, b.length) && a.centroid.every((x, k) => close(x, b.centroid[k]));

function resultDiff(a: ItemResult, b: ItemResult, edgeClose: EdgeClose = exactEdges): string | null {
  if (a.status !== b.status) return `${a.status} vs ${b.status}`;
  if (a.status === "failed" && b.status === "failed" && (a.cause !== b.cause || a.input !== b.input)) return `failed (${a.cause} ${a.input}) vs (${b.cause} ${b.input})`;
  if (a.status === "greyed" && b.status === "greyed" && a.by !== b.by) return `greyed by ${a.by} vs ${b.by}`;
  if (a.status !== "built" || b.status !== "built") return null;
  const warned = (r: typeof a) => (r.warning ? `kept, warning ${r.warning.cause} ${r.warning.input}` : "no warning");
  if (warned(a) !== warned(b)) return `${warned(a)} vs ${warned(b)}`;
  // 26e: where a face sketch lies, whether it is held, and an extrude's lost source.
  const placed = (r: typeof a) => (r.lift === undefined ? "on XY" : `at z ${r.lift}${r.plane ? `, ${r.plane}` : ""}`);
  if ((a.lift === undefined) !== (b.lift === undefined) || a.plane !== b.plane || (a.lift !== undefined && !close(a.lift, b.lift!))) return `${placed(a)} vs ${placed(b)}`;
  if (a.source !== b.source) return `source lost ${a.source ?? "no"} vs ${b.source ?? "no"}`;
  if (!a.body || !b.body) return a.body || b.body ? `a body vs ${a.body ? "none" : "a body"}` : null;
  if (!close(a.body.volume, b.body.volume)) return `volume ${a.body.volume} vs ${b.body.volume}`;
  const keysA = a.body.faces.map((f) => faceKey(f.name)).sort();
  const keysB = b.body.faces.map((f) => faceKey(f.name)).sort();
  if (keysA.join() !== keysB.join()) return `faces [${keysA.join(", ")}] vs [${keysB.join(", ")}]`;
  for (const f of a.body.faces) {
    const g = b.body.faces.find((x) => sameName(x.name, f.name))!;
    if (!close(f.area, g.area)) return `${faceKey(f.name)} area ${f.area} vs ${g.area}`;
    if (!f.centroid.every((x, k) => close(x, g.centroid[k]))) return `${faceKey(f.name)} centroid (${f.centroid.join(", ")}) vs (${g.centroid.join(", ")})`;
  }
  const edgesA = a.body.edges.map((e) => edgeKey(e.name)).sort();
  const edgesB = b.body.edges.map((e) => edgeKey(e.name)).sort();
  if (edgesA.join() !== edgesB.join()) return `edges [${edgesA.join(", ")}] vs [${edgesB.join(", ")}]`;
  for (const e of a.body.edges) {
    const g = b.body.edges.find((x) => edgeKey(x.name) === edgeKey(e.name))!;
    if (!edgeClose(e, g)) return `${edgeKey(e.name)} length ${e.length} vs ${g.length}, centroid (${e.centroid.join(", ")}) vs (${g.centroid.join(", ")})`;
  }
  return null;
}

/** The first difference between two rebuilds, or null. */
export function rebuildDiff(a: Rebuild, b: Rebuild, edgeClose?: EdgeClose): string | null {
  if (a.order.join() !== b.order.join()) return `order [${a.order.join(", ")}] vs [${b.order.join(", ")}]`;
  for (const id of a.order) {
    const d = resultDiff(a.results[id], b.results[id], edgeClose);
    if (d !== null) return `${id}: ${d}`;
  }
  return null;
}

/** A model rebuild with every id swapped for the subject's. */
const nameTo = (n: FaceName, to: (id: string) => string): FaceName =>
  n.curve === undefined ? { feature: to(n.feature), role: n.role } : { feature: to(n.feature), role: n.role, curve: to(n.curve) };

function translateRebuild(r: Rebuild, to: (id: string) => string): Rebuild {
  const results: Record<string, ItemResult> = {};
  for (const id of r.order) results[to(id)] = translateResult(r.results[id], to);
  return { order: r.order.map(to), results };
}

function translateResult(res: ItemResult, to: (id: string) => string): ItemResult {
  if (res.status === "failed") return { ...res, input: res.input === undefined ? undefined : to(res.input) };
  if (res.status === "greyed") return { status: "greyed", by: to(res.by) };
  if (res.status !== "built") return res;
  const { warning, source, body, ...rest } = res;
  return {
    ...rest,
    ...(warning && { warning: { cause: warning.cause, input: to(warning.input) } }),
    ...(source !== undefined && { source: to(source) }),
    ...(body && {
      body: {
        volume: body.volume,
        faces: body.faces.map((f) => ({ ...f, name: nameTo(f.name, to) })),
        edges: body.edges.map((e) => ({ ...e, name: edgeName(nameTo(e.name.faces[0], to), nameTo(e.name.faces[1], to), e.name.ordered) })),
      },
    }),
  };
}

function translateOp(op: ConcreteOp, to: (id: string) => string): ConcreteOp {
  switch (op.op) {
    case "add-extrude":
      return { ...op, sketch: to(op.sketch) };
    case "add-face-sketch":
      return { ...op, face: nameTo(op.face, to) };
    case "set-size":
    case "delete-item":
    case "reorder":
    case "suppress":
      return { ...op, item: to(op.item) };
    case "move-corner":
    case "redraw-curve":
      return { ...op, sketch: to(op.sketch) };
    case "delete-curve":
      return { ...op, sketch: to(op.sketch), curve: to(op.curve) };
    case "marker":
      return { ...op, at: op.at === null || op.at === "start" ? op.at : to(op.at) };
    default:
      return op;
  }
}

/** Every id a document holds: items and their curves. */
const idsOf = (doc: ModelDoc): string[] =>
  doc.items.flatMap((i) => [i.id, ...(i.kind === "sketch" ? i.curves.filter((c): c is string => c !== null) : i.kind === "extrude" && i.kept ? i.kept.curves : [])]);

/** The items that depend on `id`, directly or through others, and `id` itself. */
function dependents(doc: ModelDoc, id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of doc.items)
      if (!out.has(i.id) && dependsOn(i).some((d) => out.has(d))) {
        out.add(i.id);
        grew = true;
      }
  }
  return out;
}

const editedItem = (op: ConcreteOp): string | null =>
  op.op === "set-size" ? op.item : op.op === "move-corner" || op.op === "delete-curve" || op.op === "redraw-curve" ? op.sketch : null;

// ---------------------------------------------------------------- running

/** How many face references a session holds at once. */
const MAX_REFS = 8;

/**
 * Held references checked against the model, for the naming success rate
 * (25b4, packages/testing/baseline/naming.ts): with a tally, a reference
 * resolved otherwise than the model says (lost, moved, or found on two
 * faces) is counted as missed instead of failing the session.
 */
export interface RefTally {
  checked: number;
  missed: number;
}

/**
 * What a session reached, for Tier 3's simulated-user numbers (step 30d,
 * sim-numbers.ts). Counted as the session goes, each before the checks it
 * stands for, so a session that fails has counted the step it failed at;
 * counting never changes what fails.
 */
export interface SessionNumbers {
  /** Steps run (not skipped), each followed by a rebuild checked against the model. */
  rebuilds: number;
  /** Of those, the rebuilds in which the model has a feature failed: the user's doing (a deleted sketch, an open outline), shown on its row with words. */
  withFailedFeature: number;
  /** Held references checked against the model. */
  references: number;
  /** Rebuilds from scratch, timed (when the subject has one): features built → [rebuilds, fastest ms, total ms]. */
  timing: Record<number, [number, number, number]>;
}

export const emptySessionNumbers = (): SessionNumbers => ({ rebuilds: 0, withFailedFeature: 0, references: 0, timing: {} });

/**
 * Runs the steps on a fresh model and the subject, checking every step;
 * throws a TimelineFailure at the first check that fails. `edgeClose`
 * compares edges with the model's (exact by default); `tally` counts the
 * reference checks instead of failing on them (RefTally); `numbers` counts
 * what the session reached (SessionNumbers).
 */
export async function runSession(subject: TimelineSubject, steps: readonly SessionOp[], edgeClose?: EdgeClose, tally?: RefTally, numbers?: SessionNumbers): Promise<SessionCounts> {
  const model: TimelineModel = createModel();
  const ids = new Map<string, string>(); // model id → subject id
  for (const { op, ids: made } of subject.initial ?? []) {
    const want = applyOp(model, op);
    if (want.kind !== "done" || want.ids.length !== made.length) throw new Error(`harness: the subject's starting edit ${JSON.stringify(op)} is not one the model does`);
    want.ids.forEach((id, k) => ids.set(id, made[k]));
  }
  model.undo = [];
  const to = (id: string) => {
    const s = ids.get(id);
    if (s === undefined) throw new Error(`harness: no subject id for ${id}`);
    return s;
  };
  const counts: SessionCounts = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let refs: FaceName[] = [];
  let prev: Rebuild = await subject.rebuild();
  let held = [...bodyKeys(model.doc, rebuild(model.doc)).values()];
  let built = subject.builds ? await subject.builds() : 0;

  for (const [i, step] of steps.entries()) {
    const fail = (check: string, detail: string): never => {
      throw new TimelineFailure(check, i, step, detail);
    };
    const resolved = resolveStep(model.doc, step);
    if (resolved === null) {
      count("skipped");
      continue;
    }
    if (numbers) numbers.rebuilds++;
    let edited: string | null = null;
    if (resolved.kind === "save-open") {
      const text = await subject.save();
      const before = await subject.rebuild();
      await subject.open(text);
      const d = rebuildDiff(before, await subject.rebuild());
      if (d !== null) fail("save and open changed the rebuild", d);
      if ((await subject.save()) !== text) fail("saving again changed the file", "the second save differs from the first");
      model.undo = [];
      model.redo = [];
      count("op:save-open");
      // Nothing built opens like anything else (24f4).
      const r = rebuild(model.doc);
      if (!r.order.some((id) => r.results[id].status === "built" && r.results[id].body !== undefined)) count("save-open:nothing-built");
    } else if (resolved.kind === "hold-ref") {
      refs = [...refs.filter((n) => !sameName(n, resolved.name)), resolved.name].slice(-MAX_REFS);
      count("op:hold-ref");
    } else {
      const op = resolved.op;
      const subjectOp = translateOp(op, to);
      const want = applyOp(model, op);
      const got = await subject.apply(subjectOp);
      // After the edit: what undo and redo can still reach (an id undone and then dropped from redo may come back).
      const reachable = new Set(
        [...model.undo, ...model.redo]
          .map((t): ModelDoc => JSON.parse(t))
          .flatMap(idsOf)
          .flatMap((id) => (ids.has(id) ? [ids.get(id)!] : [])),
      );
      if (want.kind !== got.kind || (want.kind === "refused" && got.kind === "refused" && want.cause !== got.cause))
        fail("outcome differs from the model", `${JSON.stringify(got)}, model ${JSON.stringify(want)}`);
      if (want.kind === "done" && got.kind === "done") {
        if (want.ids.length !== got.ids.length) fail("outcome differs from the model", `new ids [${got.ids.join(", ")}], model [${want.ids.join(", ")}]`);
        for (const [k, id] of got.ids.entries()) {
          if (reachable.has(id)) fail("a new id is already in use", `${id} is in a state undo or redo can reach`);
          ids.set(want.ids[k], id);
        }
      }
      count(want.kind === "refused" ? `refused:${want.cause}` : `${want.kind === "done" ? "op" : "unchanged"}:${op.op}`);
      if (want.kind === "done") edited = editedItem(op);
    }

    const now = await subject.rebuild();
    const builtNow = subject.builds ? (await subject.builds()) - built : 0;
    const names = now.order.flatMap((id) => {
      const r = now.results[id];
      return r.status === "built" && r.body ? r.body.faces.map((f) => faceKey(f.name)) : [];
    });
    const dup = names.find((n, k) => names.indexOf(n) !== k);
    if (dup !== undefined) fail("two faces share a name", dup);
    const edgeNames = now.order.flatMap((id) => {
      const r = now.results[id];
      return r.status === "built" && r.body ? r.body.edges.map((e) => edgeKey(e.name)) : [];
    });
    const dupEdge = edgeNames.find((n, k) => edgeNames.indexOf(n) !== k);
    if (dupEdge !== undefined) fail("two edges share a name", dupEdge);

    const d2 = rebuildDiff(now, await subject.rebuild());
    if (d2 !== null) fail("rebuilding twice differs", d2);
    if (subject.rebuildFromScratch) {
      const t = performance.now();
      const scratch = await subject.rebuildFromScratch();
      if (numbers) {
        const ms = performance.now() - t;
        const n = scratch.order.filter((id) => scratch.results[id].status === "built").length;
        const [k, fastest, total] = numbers.timing[n] ?? [0, Infinity, 0];
        numbers.timing[n] = [k + 1, Math.min(fastest, ms), total + ms];
      }
      const d3 = rebuildDiff(now, scratch);
      if (d3 !== null) fail("the rebuild differs from a rebuild from scratch", d3);
    }
    if (edited !== null) {
      const touched = new Set([...dependents(model.doc, edited)].map(to));
      for (const id of now.order)
        if (!touched.has(id) && prev.results[id] !== undefined) {
          const d = resultDiff(prev.results[id], now.results[id]);
          if (d !== null) fail("an edit changed an item that doesn't depend on it", `${id}: ${d}`);
        }
    }

    const expected = rebuild(model.doc);
    if (numbers && expected.order.some((id) => expected.results[id].status === "failed")) numbers.withFailedFeature++;
    const d4 = rebuildDiff(now, translateRebuild(expected, to), edgeClose);
    if (d4 !== null) fail("the rebuild differs from the model", d4);

    for (const ref of refs) {
      const there = resolveFace(expected, ref) !== null;
      const name = nameTo(ref, to);
      const found = await subject.resolve(name);
      if (numbers) numbers.references++;
      // The model's names are unique (checked above), so a name the subject finds on two faces is always wrong here.
      if (tally) {
        tally.checked++;
        if (found === "shared" || (there ? found === null || !sameName(found, name) : found !== null)) tally.missed++;
      } else if (found === "shared") fail("a reference resolved to more than one face", `${faceKey(name)} matched two or more faces, model ${there ? "one" : "none"}`);
      else if (there && (found === null || !sameName(found, name))) fail("a reference was lost", `${faceKey(name)} resolved to ${found ? faceKey(found) : "nothing"}`);
      else if (!there && found !== null) fail("a broken reference resolved to another face", `${faceKey(name)} resolved to ${faceKey(found)}`);
      const owner = expected.results[ref.feature];
      count(there ? "ref:kept" : owner?.status === "built" ? "ref:missing-on-built-feature" : "ref:missing");
    }

    const keys = [...bodyKeys(model.doc, expected).values()];
    if (subject.builds) {
      const { least, most } = buildBounds(held, keys);
      if (builtNow > most) fail("an edit rebuilt bodies that didn't change", `${builtNow} bodies built, at most ${most} changed`);
      if (builtNow < least) fail("an edit kept a body whose shape changed", `${builtNow} bodies built, ${least} new shapes`);
      count(builtNow === 0 ? "builds:none" : builtNow === most ? "builds:most" : "builds:some");
      built = await subject.builds();
    }
    held = keys;

    for (const id of expected.order) {
      const r = expected.results[id];
      count(`status:${r.status}`);
      if (r.status === "failed") count(`cause:${r.cause}`);
      if (r.status === "built" && r.warning) count(`warning:${r.warning.cause}`);
      // 26e: sketches on a face followed, held, and what is built from a held one.
      if (r.status === "built" && r.lift !== undefined) count(r.plane ? `plane:${r.plane}` : "plane:followed");
      if (r.status === "built" && r.source !== undefined) count("source-lost");
    }
    prev = now;
  }
  return counts;
}

/** The first failure in `steps` on a fresh subject, or null. */
export async function failureOf(make: () => TimelineSubject, steps: readonly SessionOp[], edgeClose?: EdgeClose): Promise<TimelineFailure | null> {
  try {
    await runSession(make(), steps, edgeClose);
    return null;
  } catch (e) {
    if (e instanceof TimelineFailure) return e;
    throw e;
  }
}

/**
 * The failing steps cut down: up to the failing step, then with single
 * steps dropped for as long as the same check still fails, so no one step
 * can be removed from the result (1-minimal).
 */
export async function shrinkSession(make: () => TimelineSubject, steps: readonly SessionOp[], edgeClose?: EdgeClose): Promise<SessionOp[]> {
  const first = await failureOf(make, steps, edgeClose);
  if (first === null) return [...steps];
  const same = async (s: readonly SessionOp[]) => (await failureOf(make, s, edgeClose))?.check === first.check;
  let cur = steps.slice(0, first.step + 1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = cur.length - 1; k >= 0; k--) {
      const shorter = [...cur.slice(0, k), ...cur.slice(k + 1)];
      if (await same(shorter)) {
        cur = shorter;
        changed = true;
      }
    }
  }
  return cur;
}

// ---------------------------------------------------------------- the model as a subject

/**
 * The model run as a subject, with planted bugs. With no faults it passes
 * every check (it is the model), so the session tests use it to show that
 * each planted bug is caught by the check meant for it.
 */
export function modelSubject(faults: Iterable<ModelFault> = []): TimelineSubject {
  const fs: ReadonlySet<ModelFault> = new Set(faults);
  let m = createModel(fs);
  // Planted bug ("stale-extrude-cache"): an extrude's body kept by its own
  // id and distance, so an edit to its sketch doesn't reach it.
  const cache = new Map<string, ItemResult>();
  let calls = 0;
  let saves = 0;
  // Bodies "built": the model's own cache of what each body is built from, as Design's BodyCache keeps them by spec.
  let builds = 0;
  let holding = new Map<string, string>();
  const count = (r: Rebuild) => {
    const keys = bodyKeys(m.doc, r);
    // Planted bug ("body-kept-by-item"): bodies kept by item id, so a changed item keeps its old body.
    const key = (id: string, k: { spec: string }) => (fs.has("body-kept-by-item") ? id : k.spec);
    const now = new Map([...keys].map(([id, k]) => [key(id, k), id]));
    // Planted bug ("full-replay"): the cache emptied before every rebuild.
    for (const k of now.keys()) if (fs.has("full-replay") || !holding.has(k)) builds++;
    holding = now;
  };
  const now = (): Rebuild => {
    const r = rebuild(m.doc, fs);
    // Planted bug: every other rebuild's volumes off by a thousandth (state kept between rebuilds).
    if (fs.has("rebuild-drifts") && calls++ % 2 === 1)
      for (const id of r.order) {
        const res = r.results[id];
        if (res.status === "built" && res.body) r.results[id] = { ...res, body: { ...res.body, volume: res.body.volume * 1.001 } };
      }
    if (fs.has("stale-extrude-cache"))
      for (const item of m.doc.items) {
        if (item.kind !== "extrude" || r.results[item.id].status !== "built") continue;
        const key = `${item.id}:${item.distance}`;
        const hit = cache.get(key);
        if (hit) r.results[item.id] = hit;
        else cache.set(key, r.results[item.id]);
      }
    return r;
  };
  return {
    apply: (op) => applyOp(m, op),
    rebuild() {
      const r = now();
      count(rebuild(m.doc));
      return r;
    },
    builds: () => builds,
    rebuildFromScratch: () => rebuild(m.doc, fs),
    save() {
      const doc: ModelDoc = JSON.parse(JSON.stringify(m.doc));
      // Planted bug: the file forgets which items are suppressed.
      if (fs.has("save-drops-suppressed")) for (const i of doc.items) i.suppressed = false;
      // Planted bug: the file forgets the extrudes' kept shapes.
      if (fs.has("save-drops-kept")) for (const i of doc.items) if (i.kind === "extrude") delete i.kept;
      // Planted bug: each save stamps a counter into the file.
      return JSON.stringify(fs.has("save-stamps") ? { ...doc, saved: ++saves } : doc);
    },
    open(text) {
      const { saved: _, ...doc } = JSON.parse(text);
      m = { ...createModel(fs), doc };
    },
    resolve(name) {
      const r = now();
      // Planted bug: only the last body built is searched (as while there was one body).
      if (fs.has("resolve-last-body-only")) {
        const last = [...r.order].reverse().find((id) => r.results[id].status === "built" && (r.results[id] as { body?: unknown }).body);
        r.order = last === undefined ? [] : [last];
      }
      const f = resolveFace(r, name);
      if (f) return f.name;
      // Planted bug: a name that is gone falls back to another face of the same feature.
      const res = r.results[name.feature];
      if (fs.has("resolve-falls-back") && res?.status === "built" && res.body) return res.body.faces[0].name;
      return null;
    },
  };
}
