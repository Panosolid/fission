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
//   another face;
// - saving and opening changes neither the rebuild nor the saved text.
// Until step 24b the only subject is the model itself (`modelSubject`),
// with bugs planted through `faults` to show each check can fail; 24d plugs
// in Design's real timeline on the real kernel.

import { seeded, type SeededRandom } from "./index.ts";
import {
  applyOp,
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
  | { op: "hold-ref"; pick: number };

/** A timeline implementation under test. Ids in and out are its own; the harness maps the model's onto them. */
export interface TimelineSubject {
  apply(op: ConcreteOp): Applied;
  rebuild(): Rebuild;
  /** A rebuild that ignores any cache; leave it out when there is none. */
  rebuildFromScratch?(): Rebuild;
  save(): string;
  /** Opens saved text, with a fresh undo history, as opening a file does. */
  open(text: string): void;
  /** The name of the face this name resolves to now, or null when it resolves to none. */
  resolve(name: FaceName): FaceName | null;
}

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
];
const TOTAL = WEIGHTS.reduce((s, [, w]) => s + w, 0);

/** One random step. */
export function randomOp(r: SeededRandom): SessionOp {
  let x = r.next() * TOTAL;
  const [kind] = WEIGHTS.find(([, w]) => (x -= w) < 0) ?? WEIGHTS[0];
  switch (kind) {
    case "add-sketch":
      return { op: kind, shape: randomShape(r) };
    case "add-extrude":
      return { op: kind, pick: r.next(), distance: int(r, 1, 50) };
    case "add-preset": {
      const k = pick(r, ["box", "cylinder", "sphere"] as const);
      return { op: kind, kind: k, sizes: Array.from({ length: k === "box" ? 3 : k === "cylinder" ? 2 : 1 }, () => int(r, 1, 60)) };
    }
    case "set-size":
      return { op: kind, pick: r.next(), value: int(r, 1, 60) };
    case "move-corner":
      return { op: kind, pick: r.next(), to: [int(r, -60, 60), int(r, -60, 60)] };
    case "reorder":
      return { op: kind, pick: r.next(), to: r.next() };
    case "undo":
    case "redo":
    case "save-open":
      return { op: kind };
    default:
      return { op: kind, pick: r.next() };
  }
}

/** A seeded session's steps: the same seed gives the same steps. */
export const randomSession = (seed: bigint, steps: number): SessionOp[] => {
  const r = seeded(seed);
  return Array.from({ length: steps }, () => randomOp(r));
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
  }
}

// ---------------------------------------------------------------- comparing

const sameName = (a: FaceName, b: FaceName) => faceKey(a) === faceKey(b);

/** The first difference between two items' results, or null. */
function resultDiff(a: ItemResult, b: ItemResult): string | null {
  if (a.status !== b.status) return `${a.status} vs ${b.status}`;
  if (a.status === "failed" && b.status === "failed" && (a.cause !== b.cause || a.input !== b.input)) return `failed (${a.cause} ${a.input}) vs (${b.cause} ${b.input})`;
  if (a.status !== "built" || b.status !== "built") return null;
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
    if (!close(e.length, g.length)) return `${edgeKey(e.name)} length ${e.length} vs ${g.length}`;
    if (!e.centroid.every((x, k) => close(x, g.centroid[k]))) return `${edgeKey(e.name)} centroid (${e.centroid.join(", ")}) vs (${g.centroid.join(", ")})`;
  }
  return null;
}

/** The first difference between two rebuilds, or null. */
export function rebuildDiff(a: Rebuild, b: Rebuild): string | null {
  if (a.order.join() !== b.order.join()) return `order [${a.order.join(", ")}] vs [${b.order.join(", ")}]`;
  for (const id of a.order) {
    const d = resultDiff(a.results[id], b.results[id]);
    if (d !== null) return `${id}: ${d}`;
  }
  return null;
}

/** A model rebuild with every id swapped for the subject's. */
const nameTo = (n: FaceName, to: (id: string) => string): FaceName =>
  n.curve === undefined ? { feature: to(n.feature), role: n.role } : { feature: to(n.feature), role: n.role, curve: to(n.curve) };

function translateRebuild(r: Rebuild, to: (id: string) => string): Rebuild {
  const results: Record<string, ItemResult> = {};
  for (const id of r.order) {
    const res = r.results[id];
    results[to(id)] =
      res.status === "failed"
        ? { ...res, input: res.input === undefined ? undefined : to(res.input) }
        : res.status === "built" && res.body
          ? {
              status: "built",
              body: {
                volume: res.body.volume,
                faces: res.body.faces.map((f) => ({ ...f, name: nameTo(f.name, to) })),
                edges: res.body.edges.map((e) => ({ ...e, name: edgeName(nameTo(e.name.faces[0], to), nameTo(e.name.faces[1], to), e.name.ordered) })),
              },
            }
          : res;
  }
  return { order: r.order.map(to), results };
}

function translateOp(op: ConcreteOp, to: (id: string) => string): ConcreteOp {
  switch (op.op) {
    case "add-extrude":
      return { ...op, sketch: to(op.sketch) };
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
const idsOf = (doc: ModelDoc): string[] => doc.items.flatMap((i) => [i.id, ...(i.kind === "sketch" ? i.curves.filter((c): c is string => c !== null) : [])]);

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

/** Runs the steps on a fresh model and the subject, checking every step; throws a TimelineFailure at the first check that fails. */
export function runSession(subject: TimelineSubject, steps: readonly SessionOp[]): SessionCounts {
  const model: TimelineModel = createModel();
  const ids = new Map<string, string>(); // model id → subject id
  const to = (id: string) => {
    const s = ids.get(id);
    if (s === undefined) throw new Error(`harness: no subject id for ${id}`);
    return s;
  };
  const counts: SessionCounts = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  let refs: FaceName[] = [];
  let prev: Rebuild = subject.rebuild();

  steps.forEach((step, i) => {
    const fail = (check: string, detail: string): never => {
      throw new TimelineFailure(check, i, step, detail);
    };
    const resolved = resolveStep(model.doc, step);
    if (resolved === null) return void count("skipped");
    let edited: string | null = null;
    if (resolved.kind === "save-open") {
      const text = subject.save();
      const before = subject.rebuild();
      subject.open(text);
      const d = rebuildDiff(before, subject.rebuild());
      if (d !== null) fail("save and open changed the rebuild", d);
      if (subject.save() !== text) fail("saving again changed the file", "the second save differs from the first");
      model.undo = [];
      model.redo = [];
      count("op:save-open");
    } else if (resolved.kind === "hold-ref") {
      refs = [...refs.filter((n) => !sameName(n, resolved.name)), resolved.name].slice(-MAX_REFS);
      count("op:hold-ref");
    } else {
      const op = resolved.op;
      const subjectOp = translateOp(op, to);
      const want = applyOp(model, op);
      const got = subject.apply(subjectOp);
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

    const now = subject.rebuild();
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

    const d2 = rebuildDiff(now, subject.rebuild());
    if (d2 !== null) fail("rebuilding twice differs", d2);
    if (subject.rebuildFromScratch) {
      const d3 = rebuildDiff(now, subject.rebuildFromScratch());
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
    const d4 = rebuildDiff(now, translateRebuild(expected, to));
    if (d4 !== null) fail("the rebuild differs from the model", d4);

    for (const ref of refs) {
      const there = resolveFace(expected, ref) !== null;
      const name = nameTo(ref, to);
      const found = subject.resolve(name);
      if (there && (found === null || !sameName(found, name))) fail("a reference was lost", `${faceKey(name)} resolved to ${found ? faceKey(found) : "nothing"}`);
      if (!there && found !== null) fail("a broken reference resolved to another face", `${faceKey(name)} resolved to ${faceKey(found)}`);
      const owner = expected.results[ref.feature];
      count(there ? "ref:kept" : owner?.status === "built" ? "ref:missing-on-built-feature" : "ref:missing");
    }

    for (const id of expected.order) {
      const r = expected.results[id];
      count(`status:${r.status}`);
      if (r.status === "failed") count(`cause:${r.cause}`);
    }
    prev = now;
  });
  return counts;
}

/** The first failure in `steps` on a fresh subject, or null. */
export function failureOf(make: () => TimelineSubject, steps: readonly SessionOp[]): TimelineFailure | null {
  try {
    runSession(make(), steps);
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
export function shrinkSession(make: () => TimelineSubject, steps: readonly SessionOp[]): SessionOp[] {
  const first = failureOf(make, steps);
  if (first === null) return [...steps];
  const same = (s: readonly SessionOp[]) => failureOf(make, s)?.check === first.check;
  let cur = steps.slice(0, first.step + 1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = cur.length - 1; k >= 0; k--) {
      const shorter = [...cur.slice(0, k), ...cur.slice(k + 1)];
      if (same(shorter)) {
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
  const now = (): Rebuild => {
    const r = rebuild(m.doc, fs);
    // Planted bug: every other rebuild's volumes off by a thousandth (state kept between rebuilds).
    if (fs.has("rebuild-drifts") && calls++ % 2 === 1)
      for (const id of r.order) {
        const res = r.results[id];
        if (res.status === "built" && res.body) r.results[id] = { status: "built", body: { ...res.body, volume: res.body.volume * 1.001 } };
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
    rebuild: now,
    rebuildFromScratch: () => rebuild(m.doc, fs),
    save() {
      const doc: ModelDoc = JSON.parse(JSON.stringify(m.doc));
      // Planted bug: the file forgets which items are suppressed.
      if (fs.has("save-drops-suppressed")) for (const i of doc.items) i.suppressed = false;
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
