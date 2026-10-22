// Seeded sessions and Ben's Fusion cases for the naming model (step 25a's
// harness; naming-model.ts is the oracle). A subject (`NamingSubject`) is
// anything that builds the owner's test part: the model itself now, with bugs
// planted to prove each check fails; Design's sketch on a face from step 26
// (a subject without cuts: the circle becomes a new body); and Design with
// booleans' cut (44/48), which runs every case.
//
// Each step runs on the model and the subject, then the harness checks:
// - the edit's outcome (done, unchanged, refused and why) is the model's;
// - a delete's plan (does it ask, what does it remove) is the model's, asked
//   before the delete is made;
// - reading twice gives the same answer;
// - the rebuild is the model's: order, each sketch's placement (where its
//   (0, 0) lands, its frame, which way it faces, and any plane warning
//   naming its face), each solid's volume and centroid and any warning,
//   each cut's removed volume or failure, which items are suppressed or
//   greyed, and every body's volume after its cuts;
// - saving and opening changes none of that.
// `FUSION_CASES` add the owner's own answers, hand-worked, on top: the
// subject must agree with the model and with the numbers written there.

import { seeded, type SeededRandom } from "./index.ts";
import { close } from "./timeline-session.ts";
import { polygonValid, type Point } from "./timeline-model.ts";
import {
  applyNaming,
  clearCut,
  createNamingModel,
  discInsidePolygon,
  discMeetsPolygon,
  edgeAt,
  faceKeyOf,
  namingFaces,
  planDelete,
  rebuildNaming,
  worldOf,
  type Cap,
  type FaceName,
  type DeletePlan,
  type EdgeName,
  type NamingItem,
  type NamingApplied,
  type NamingDoc,
  type NamingFault,
  type NamingOp,
  type NamingRebuild,
  type NamingResult,
  type NamingWarning,
  type PinName,
  type Placement,
  type RefuseCause,
  type Vec3,
} from "./naming-model.ts";

type Maybe<T> = T | Promise<T>;

/** The code under test. Ids in its ops and answers are its own; the harness maps them to the model's. */
export interface NamingSubject {
  /** Whether it can cut into a body (booleans); without, the circle is extruded as a new body. */
  readonly cuts: boolean;
  apply(op: NamingOp): Maybe<NamingApplied>;
  planDelete(item: string): Maybe<DeletePlan>;
  read(): Maybe<NamingRebuild>;
  saveOpen?(): Maybe<void>;
}

/** The owner's test part, before any edit: an outline on XY extruded, a circle on one of its faces, and a cut (or a new body) from it. */
export interface Setup {
  corners: Point[];
  distance: number;
  /** A cap, or the side swept from the outline's k-th line (corner k to k + 1; step 26, new bodies only). */
  cap: Cap | { side: number };
  centre: Point;
  radius: number;
  /** The cut's depth, or the new body's distance when the subject can't cut. */
  depth: number;
  /** On a cap, the circle's centre snapped onto a corner or a side's middle and pinned there (rule 10, step 26f); `centre` is then that point. */
  pin?: PinName;
  /** Step 27: a second outline on XY extruded before the face sketch (sketch-3, extrude-4), so its edges can be pinned to and projected (rule 13). */
  other?: { corners: Point[]; distance: number };
}

/** The face a setup's circle is on, in the model's ids. */
export const setupFace = (cap: Setup["cap"]): FaceName => (typeof cap === "string" ? { feature: "extrude-2", role: cap } : { feature: "extrude-2", role: "side", line: `line-${cap.side + 1}` });

/**
 * The setup as edits. The model's ids are fixed by its counters: sketch-1
 * (lines line-1 onwards, the k-th from corner k − 1), extrude-2, sketch-3,
 * then cut-4 or extrude-4; with a second outline (step 27), that is
 * sketch-3 and extrude-4, the face sketch sketch-5, then cut-6 or extrude-6.
 */
export function setupOps(s: Setup, cuts: boolean): NamingOp[] {
  const other: NamingOp[] = s.other ? [{ op: "add-sketch", corners: s.other.corners }, { op: "add-extrude", sketch: "sketch-3", distance: s.other.distance }] : [];
  const sketch = s.other ? "sketch-5" : "sketch-3";
  return [
    { op: "add-sketch", corners: s.corners },
    { op: "add-extrude", sketch: "sketch-1", distance: s.distance },
    ...other,
    { op: "add-face-sketch", face: setupFace(s.cap), centre: s.centre, radius: s.radius, ...(s.pin ? { pin: s.pin } : {}) },
    cuts ? { op: "add-cut", sketch, depth: s.depth } : { op: "add-face-extrude", sketch, distance: s.depth },
  ];
}

/** A step with its targets named by model id; `want` is a hand-worked answer the subject must also give. */
export type NamingStep =
  | { kind: "op"; op: NamingOp; want?: NamingApplied["kind"] | RefuseCause }
  | { kind: "plan"; item: string; want?: DeletePlan }
  | { kind: "save-open" };

export class NamingFailure extends Error {
  readonly step: number;
  readonly check: string;
  constructor(step: number, check: string, detail: string) {
    super(`step ${step}, ${check}: ${detail}`);
    this.step = step;
    this.check = check;
  }
}

export type NamingCounts = Record<string, number>;

// ------------------------------------------------------------ comparing

const vecClose = (a: Vec3, b: Vec3) => a.every((x, k) => close(x, b[k]));
// A pin's warning by its cause alone: a sketch has at most one pin, and a subject names it its own way. Held projections by their ids (step 27).
const warnKey = (w: NamingWarning | undefined) =>
  w === undefined ? "none" : "input" in w ? `${w.cause}:${w.input}` : "face" in w ? `${w.cause}:${faceKeyOf(w.face)}` : "projections" in w ? `${w.cause}:${w.projections}` : w.cause;
const pointsClose = (a: readonly Point[], b: readonly Point[]) => a.length === b.length && a.every((p, k) => close(p[0], b[k][0]) && close(p[1], b[k][1]));
/** What differs between two sketches' projected edges (rule 12; none is an empty list), or null. */
function projectedDiff(got: { id: string; at: Point[] }[] = [], want: { id: string; at: Point[] }[] = []): string | null {
  const ids = (l: { id: string }[]) => l.map((q) => q.id).join();
  if (ids(got) !== ids(want)) return `projections [${ids(got)}], want [${ids(want)}]`;
  const k = want.findIndex((q, j) => !pointsClose(got[j].at, q.at));
  return k < 0 ? null : `${want[k].id} at ${JSON.stringify(got[k].at)}, want ${JSON.stringify(want[k].at)}`;
}
/** What differs between two placements, or null. */
function placementDiff(got: Placement, want: Placement): string | null {
  if (got.side !== want.side) return `faces ${got.side} along its normal, want ${want.side}`;
  if (!vecClose(got.origin, want.origin)) return `origin ${got.origin}, want ${want.origin}`;
  if (!vecClose(got.x, want.x)) return `x axis ${got.x}, want ${want.x}`;
  if (!vecClose(got.normal, want.normal)) return `normal ${got.normal}, want ${want.normal}`;
  return null;
}

function resultDiff(id: string, want: NamingResult, got: NamingResult | undefined): string | null {
  if (got === undefined) return `${id}: missing`;
  if (got.kind !== want.kind) return `${id}: a ${got.kind}, not a ${want.kind}`;
  if (warnKey(got.warning) !== warnKey(want.warning)) return `${id}: warning ${warnKey(got.warning)}, want ${warnKey(want.warning)}`;
  if (want.kind === "sketch" && got.kind === "sketch") {
    const d = placementDiff(got.placement, want.placement) ?? projectedDiff(got.projected, want.projected);
    if (d) return `${id}: ${d}`;
  }
  if (want.kind === "solid" && got.kind === "solid") {
    if (!close(got.volume, want.volume)) return `${id}: volume ${got.volume}, want ${want.volume}`;
    if (!vecClose(got.centroid, want.centroid)) return `${id}: centroid ${got.centroid}, want ${want.centroid}`;
  }
  if (want.kind === "cut" && got.kind === "cut") {
    if (got.status !== want.status) return `${id}: ${got.status}, want ${want.status}`;
    if (want.status === "built" && got.status === "built" && !close(got.removed, want.removed)) return `${id}: removed ${got.removed}, want ${want.removed}`;
  }
  return null;
}

/** What differs between two rebuilds (both in model ids), or null. */
export function namingDiff(want: NamingRebuild, got: NamingRebuild): string | null {
  if (got.order.join() !== want.order.join()) return `order [${got.order}], want [${want.order}]`;
  for (const id of want.order) {
    const d = resultDiff(id, want.results[id], got.results[id]);
    if (d) return d;
  }
  const keys = (r: NamingRebuild) => Object.keys(r.bodies).sort().join();
  if (keys(got) !== keys(want)) return `bodies [${keys(got)}], want [${keys(want)}]`;
  for (const [id, v] of Object.entries(want.bodies)) if (!close(got.bodies[id], v)) return `body ${id}: ${got.bodies[id]} mm³, want ${v}`;
  return null;
}

/** Renames every id in a rebuild. */
function renamed(r: NamingRebuild, to: (id: string) => string): NamingRebuild {
  const warning = (w: NamingWarning | undefined): NamingWarning | undefined =>
    w === undefined
      ? undefined
      : "input" in w
        ? { cause: w.cause, input: to(w.input) }
        : "face" in w
          ? { cause: w.cause, face: renamedFace(w.face, to) }
          : "projections" in w
            ? { cause: w.cause, projections: w.projections.map(to) }
            : w;
  const results: Record<string, NamingResult> = {};
  for (const [id, res] of Object.entries(r.results)) {
    const w = warning(res.warning);
    const projected = res.kind === "sketch" && res.projected ? { projected: res.projected.map((q) => ({ id: to(q.id), at: q.at })) } : {};
    results[to(id)] = { ...res, ...(w ? { warning: w } : {}), ...projected } as NamingResult;
  }
  return { order: r.order.map(to), results, bodies: Object.fromEntries(Object.entries(r.bodies).map(([id, v]) => [to(id), v])) };
}

/** A face's name with its feature's (and side's line's) id renamed. */
const renamedFace = (f: FaceName, to: (id: string) => string): FaceName => (f.role === "side" ? { feature: to(f.feature), role: "side", line: to(f.line) } : { feature: to(f.feature), role: f.role });

/** A pin with its lines' (and from step 27 its feature's) ids renamed. */
function renamedPin(p: PinName, to: (id: string) => string): PinName {
  if (p.at === "upright") return { at: "upright", before: to(p.before), after: to(p.after), feature: to(p.feature) };
  const on = p.feature === undefined ? {} : { feature: to(p.feature), ...(p.cap ? { cap: p.cap } : {}) };
  return p.at === "middle" ? { at: "middle", line: to(p.line), ...on } : { at: "corner", before: to(p.before), after: to(p.after), ...on };
}

/** A projected edge's name with its feature's and lines' ids renamed (rule 12). */
const renamedEdge = (e: EdgeName, to: (id: string) => string): EdgeName =>
  e.at === "cap-edge" ? { feature: to(e.feature), at: "cap-edge", cap: e.cap, line: to(e.line) } : { feature: to(e.feature), at: "upright", before: to(e.before), after: to(e.after) };

function renamedOp(op: NamingOp, to: (id: string) => string): NamingOp {
  const o = JSON.parse(JSON.stringify(op)) as Record<string, unknown>;
  for (const k of ["sketch", "item", "projection"]) if (typeof o[k] === "string") o[k] = to(o[k] as string);
  if (op.op === "add-face-sketch") o.face = renamedFace(op.face, to);
  if ((op.op === "add-face-sketch" || op.op === "set-circle") && op.pin) o.pin = renamedPin(op.pin, to);
  if (op.op === "project") o.edge = renamedEdge(op.edge, to);
  return o as NamingOp;
}

// ------------------------------------------------------------ running

/** How a cut came out, for the coverage counts: whole hole, a bite, or no target because of height or because the circle misses. */
function cutCases(doc: NamingDoc, r: NamingRebuild): string[] {
  const out: string[] = [];
  for (const item of doc.items) {
    if (item.kind !== "cut") continue;
    const res = r.results[item.id];
    const s = doc.items.find((i) => i.id === item.sketch);
    const placed = r.results[item.sketch];
    const tool = s?.kind === "face-sketch" && placed?.kind === "sketch" ? { centre: s.centre, radius: s.radius, placement: placed.placement } : item.kept;
    const base = doc.items.find((i) => i.id === item.target);
    const bs = base?.kind === "extrude" ? doc.items.find((i) => i.id === base.sketch) : undefined;
    const corners = bs?.kind === "sketch" ? bs.corners : base?.kind === "extrude" ? base.kept : undefined;
    if (!tool || !corners) continue;
    const at = worldOf(tool.placement, tool.centre[0], tool.centre[1]);
    const c: Point = [at[0], at[1]];
    if (res?.kind === "suppressed" || res?.kind === "greyed") continue;
    if (res?.kind === "cut" && res.status === "built") out.push(discInsidePolygon(c, tool.radius, corners) ? "cut:whole" : "cut:bite");
    else out.push(discMeetsPolygon(c, tool.radius, corners) ? "cut:no-target-height" : "cut:no-target-outside");
  }
  return out;
}

const isOff = (r: NamingResult | undefined) => r?.kind === "suppressed" || r?.kind === "greyed";

/** The features face sketch `s` names by its pin and projections only (rule 13), not its face's. */
const refsOf = (s: NamingDoc["items"][number]): string[] =>
  s.kind !== "face-sketch" ? [] : [...(s.pin?.feature ? [s.pin.feature] : []), ...(s.projections ?? []).map((q) => q.edge.feature)].filter((f) => f !== s.face.feature);

/** Whether moving `item` is refused only because of what a pin or a projection names: it is such a sketch, or such a feature. */
function refRefused(doc: NamingDoc, item: string): boolean {
  const it = doc.items.find((i) => i.id === item);
  return it !== undefined && (refsOf(it).length > 0 || doc.items.some((i) => refsOf(i).includes(item)));
}

/** Whether deleting `item` asks only because a pin or a projection names it: nothing else is built on it. */
function askedForRef(doc: NamingDoc, item: string): boolean {
  const named = doc.items.some((i) => refsOf(i).includes(item));
  const builtOn = doc.items.some((i) => (i.kind === "face-sketch" && i.face.feature === item) || ((i.kind === "extrude" || i.kind === "face-extrude" || i.kind === "cut") && i.sketch === item) || (i.kind === "cut" && i.target === item));
  return named && !builtOn;
}

function count(counts: NamingCounts, what: string) {
  counts[what] = (counts[what] ?? 0) + 1;
}

/**
 * Builds the setup on the model and the subject, then runs the steps,
 * checking each one (see the top of this file). Throws a `NamingFailure`
 * naming the step and the check; returns how often each case was reached
 * and the subject's last read in the model's ids.
 */
export async function runNaming(subject: NamingSubject, setup: Setup, steps: readonly NamingStep[]): Promise<{ counts: NamingCounts; last: NamingRebuild }> {
  const model = createNamingModel();
  const toSubject = new Map<string, string>();
  const toModel = new Map<string, string>();
  const sub = (id: string) => toSubject.get(id) ?? `unknown:${id}`;
  const mod = (id: string) => toModel.get(id) ?? `unknown:${id}`;
  const counts: NamingCounts = {};
  /** Each face sketch's centre after the last step, to count a pinned one moving; each projected edge's place, to count one following (step 27). */
  const centres = new Map<string, Point>();
  const projectedAt = new Map<string, string>();
  let last: NamingRebuild = { order: [], results: {}, bodies: {} };
  const all: NamingStep[] = [...setupOps(setup, subject.cuts).map((op): NamingStep => ({ kind: "op", op, want: "done" })), ...steps];
  for (let n = 0; n < all.length; n++) {
    const step = all[n];
    const fail = (check: string, detail: string) => new NamingFailure(n, check, detail);
    if (step.kind === "plan") {
      const want = planDelete(model.doc, step.item);
      const got = await subject.planDelete(sub(step.item));
      const shown = (p: DeletePlan) => `ask ${p.ask}, removes [${p.removes}]`;
      const gotModel = { ask: got.ask, removes: got.removes.map(mod) };
      if (shown(gotModel) !== shown(want)) throw fail("delete plan", `${shown(gotModel)}, want ${shown(want)}`);
      if (step.want && shown(gotModel) !== shown(step.want)) throw fail("hand-worked plan", `${shown(gotModel)}, want ${shown(step.want)}`);
      count(counts, want.ask ? "plan:ask" : "plan:quiet");
    } else if (step.kind === "save-open") {
      const before = renamed(await subject.read(), mod);
      if (subject.saveOpen) await subject.saveOpen();
      const d = namingDiff(before, renamed(await subject.read(), mod));
      if (d) throw fail("save and open", d);
      count(counts, "save-open");
    } else {
      const { op } = step;
      const beforeOp: NamingDoc = JSON.parse(JSON.stringify(model.doc));
      if (op.op === "delete") {
        const want = planDelete(model.doc, op.item);
        const got = await subject.planDelete(sub(op.item));
        const gotRemoves = got.removes.map(mod).join();
        if (got.ask !== want.ask || gotRemoves !== want.removes.join()) throw fail("delete plan", `ask ${got.ask}, removes [${gotRemoves}], want ask ${want.ask}, removes [${want.removes}]`);
        count(counts, want.ask ? "delete:ask" : "delete:quiet");
      }
      const want = applyNaming(model, op);
      const got = await subject.apply(renamedOp(op, sub));
      const outcome = (a: NamingApplied) => (a.kind === "refused" ? a.cause : a.kind);
      if (outcome(got) !== outcome(want)) throw fail("outcome", `${outcome(got)}, want ${outcome(want)} for ${JSON.stringify(op)}`);
      if (step.want && outcome(got) !== step.want) throw fail("hand-worked outcome", `${outcome(got)}, want ${step.want}`);
      if (want.kind === "done" && got.kind === "done") {
        if (got.ids.length !== want.ids.length) throw fail("outcome", `made ${got.ids.length} ids, want ${want.ids.length}`);
        want.ids.forEach((id, k) => {
          toSubject.set(id, got.ids[k]);
          toModel.set(got.ids[k], id);
        });
      }
      count(counts, `op:${op.op}:${outcome(want)}`);
      // Step 27 (rule 13): a reorder refused because of what a pin or a projection names.
      if (op.op === "reorder" && want.kind === "refused" && refRefused(beforeOp, op.item)) count(counts, "reorder:refused-by-ref");
      if (op.op === "delete" && askedForRef(beforeOp, op.item)) count(counts, "delete:ask-by-ref");
    }
    const first = await subject.read();
    const again = await subject.read();
    if (JSON.stringify(first) !== JSON.stringify(again)) throw fail("read twice", "two reads differ");
    const want = rebuildNaming(model.doc);
    last = renamed(first, mod);
    const d = namingDiff(want, last);
    if (d) throw fail("rebuild", d);
    const faces = namingFaces(model.doc);
    for (const item of model.doc.items) {
      const res = want.results[item.id];
      if (res.kind === "suppressed" || res.kind === "greyed") {
        count(counts, `off:${res.kind}`);
        // Step 27 (rule 13): greyed only by a feature its pin or a projection names.
        if (item.kind === "face-sketch" && res.kind === "greyed" && !isOff(want.results[item.face.feature])) count(counts, "off:greyed-by-ref");
        continue;
      }
      if (item.kind === "face-sketch" && res.kind === "sketch") {
        count(counts, res.warning ? `sketch:${res.warning.cause}` : item.face.role === "side" ? "sketch:side" : "sketch:followed");
        // Rule 10: a pin followed, and followed somewhere new since the last step.
        if (item.pin && !res.warning) count(counts, `pin:${item.pin.at}`);
        // Step 27 (rule 11): a pin on another extrude, or on another face of its own.
        if (item.pin?.feature !== undefined && !res.warning) count(counts, item.pin.feature !== item.face.feature ? "pin:other-feature" : "pin:other-face");
        // Rule 12: each projected edge followed (a line or a point), and followed somewhere new.
        for (const q of item.projections ?? []) {
          const held = res.warning?.cause === "projection-lost" && res.warning.projections.includes(q.id);
          if (!held && (!res.warning || res.warning.cause === "projection-lost")) count(counts, q.at.length === 1 ? "projection:point" : "projection:line");
          if (q.edge.feature !== item.face.feature) count(counts, "projection:other-feature");
          const key = JSON.stringify(q.at);
          if (projectedAt.has(q.id) && projectedAt.get(q.id) !== key) count(counts, "projection:moved");
          projectedAt.set(q.id, key);
        }
        const was = centres.get(item.id);
        if (item.pin && was && (was[0] !== item.centre[0] || was[1] !== item.centre[1])) count(counts, "pin:moved");
        centres.set(item.id, item.centre);
        const p = res.placement;
        const face = faces.find((f) => faceKeyOf(f.name) === faceKeyOf(item.face));
        if (!res.warning && !vecClose(p.x, item.drawn.x)) count(counts, "sketch:turned");
        if (!res.warning && face && p.side * (p.normal[0] * face.outward[0] + p.normal[1] * face.outward[1] + p.normal[2] * face.outward[2]) < 0) count(counts, "sketch:facing-in");
      }
      if (res.kind !== "sketch" && res.warning) count(counts, res.warning.cause === "source-lost" ? `${res.kind}:source-lost` : `${res.kind}:kept`);
      if (item.kind === "extrude" && item.distance < 0) count(counts, "extrude:flipped");
    }
    for (const c of cutCases(model.doc, want)) count(counts, c);
  }
  return { counts, last };
}

// ------------------------------------------------------------ random sessions

/** A session step whose targets are fractions, picked against the document when it runs, so any step can be dropped when shrinking. */
export type RandomStep =
  | { op: "set-corners"; corners: Point[] }
  | { op: "move-corner"; corner: number; to: Point }
  | { op: "set-distance"; pick: number; value: number }
  /** The centre as fractions across the base outline's bounds, 5 mm wider each way, so most circles meet it. */
  | { op: "set-circle"; at: [number, number]; radius: number }
  | { op: "set-depth"; value: number }
  | { op: "delete"; pick: number }
  | { op: "plan"; pick: number }
  /** Turns a feature's suppression the other way (step 26, rule 9). */
  | { op: "suppress"; pick: number }
  | { op: "reorder"; pick: number; to: number }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "save-open" }
  // Step 27, drawn from a stream of their own (`randomNamingSession`'s `step27`):
  /** Another outline on XY (at most three), then extruded: more bodies to pin to and project from. */
  | { op: "add-outline"; corners: Point[] }
  | { op: "extrude-outline"; pick: number; distance: number }
  /** A sketch or extrude after the face sketch, moved to just before it, so the sketch can name it (rule 13). */
  | { op: "reorder-early"; pick: number }
  /** The circle snapped onto a corner (kind < 0.4), a cap edge's middle (< 0.75) or an upright's middle of an extrude before it (rule 11). */
  | { op: "pin"; pick: number; kind: number; cap: number; line: number; radius: number }
  /** A cap edge (kind < 0.7) or an upright of an extrude before it projected into the face sketch (rule 12). */
  | { op: "project"; pick: number; kind: number; cap: number; line: number }
  | { op: "unproject"; pick: number }
  /** A feature the face sketch's pin or a projection names, deleted (rule 13: it asks first). */
  | { op: "delete-ref"; pick: number }
  /** An edge the face sketch already holds, projected again (rule 12: nothing changes). */
  | { op: "project-again"; pick: number }
  /** A drag across a link (rule 13): the face sketch before a feature it names, or such a feature after the sketch. */
  | { op: "reorder-across"; pick: number; way: number }
  /** A corner of an outline other than the first moved, or that outline redrawn. */
  | { op: "move-other"; pick: number; corner: number; to: Point }
  | { op: "redraw-other"; pick: number; corners: Point[] };

const int = (r: SeededRandom, lo: number, hi: number) => lo + Math.floor(r.next() * (hi - lo + 1));
/** A circle's radius: mostly small, so whole holes are as common as bites and misses. */
const radiusOf = (r: SeededRandom) => (r.next() < 0.6 ? int(r, 1, 5) : int(r, 1, 15));
const nonZero = (r: SeededRandom, most: number) => (r.next() < 0.5 ? -1 : 1) * int(r, 1, most);

/** A rectangle or a triangle on the grid, always a valid outline. */
export function randomOutline(r: SeededRandom): Point[] {
  for (;;) {
    if (r.next() < 0.5) {
      const x = int(r, -40, 20);
      const y = int(r, -40, 20);
      const w = int(r, 5, 60);
      const h = int(r, 5, 60);
      return [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ];
    }
    const t: Point[] = [0, 1, 2].map((): Point => [int(r, -40, 40), int(r, -40, 40)]);
    const twice = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0]);
    if (Math.abs(twice) >= 100 && polygonValid(t)) return t;
  }
}

const WEIGHTS: [RandomStep["op"], number][] = [
  ["set-corners", 10],
  ["move-corner", 10],
  ["set-distance", 12],
  ["set-circle", 10],
  ["set-depth", 6],
  ["delete", 4],
  ["plan", 4],
  ["suppress", 6],
  ["reorder", 10],
  ["undo", 10],
  ["redo", 6],
  ["save-open", 4],
];

function randomStep(r: SeededRandom): RandomStep {
  let x = r.next() * WEIGHTS.reduce((s, [, w]) => s + w, 0);
  let op: RandomStep["op"] = WEIGHTS[0][0];
  for (const [o, w] of WEIGHTS) {
    op = o;
    if ((x -= w) < 0) break;
  }
  switch (op) {
    case "set-corners":
      return { op, corners: randomOutline(r) };
    case "move-corner":
      return { op, corner: r.next(), to: [int(r, -50, 50), int(r, -50, 50)] };
    case "set-distance":
      return { op, pick: r.next(), value: nonZero(r, 40) };
    case "set-circle":
      return { op, at: [r.next(), r.next()], radius: radiusOf(r) };
    case "set-depth":
      return { op, value: int(r, 1, 45) };
    case "delete":
    case "plan":
    case "suppress":
      return { op, pick: r.next() };
    case "reorder":
      return { op, pick: r.next(), to: r.next() };
    default:
      return { op: op as "undo" | "redo" | "save-open" };
  }
}

const WEIGHTS_27: [RandomStep["op"], number][] = [
  ["add-outline", 5],
  ["extrude-outline", 6],
  ["reorder-early", 6],
  ["pin", 8],
  ["project", 10],
  ["unproject", 3],
  ["delete-ref", 4],
  ["project-again", 2],
  ["reorder-across", 3],
  ["move-other", 9],
  ["redraw-other", 3],
];

/** A step 27 step (rules 11 to 13), from its own stream; with `pinsOnly`, never a projection (for Design from 27c, before 27d's projections). */
function randomStep27(r: SeededRandom, pinsOnly: boolean): RandomStep {
  const weights = pinsOnly ? WEIGHTS_27.filter(([o]) => o !== "project" && o !== "unproject" && o !== "project-again") : WEIGHTS_27;
  let x = r.next() * weights.reduce((s, [, w]) => s + w, 0);
  let op: RandomStep["op"] = weights[0][0];
  for (const [o, w] of weights) {
    op = o;
    if ((x -= w) < 0) break;
  }
  switch (op) {
    case "add-outline":
      return { op, corners: randomOutline(r) };
    case "extrude-outline":
      return { op, pick: r.next(), distance: nonZero(r, 40) };
    case "reorder-early":
    case "unproject":
    case "delete-ref":
    case "project-again":
      return { op, pick: r.next() };
    case "reorder-across":
      return { op, pick: r.next(), way: r.next() };
    case "pin":
      return { op, pick: r.next(), kind: r.next(), cap: r.next(), line: r.next(), radius: radiusOf(r) };
    case "project":
      return { op, pick: r.next(), kind: r.next(), cap: r.next(), line: r.next() };
    case "move-other":
      return { op, pick: r.next(), corner: r.next(), to: [int(r, -50, 50), int(r, -50, 50)] };
    default:
      return { op: "redraw-other", pick: r.next(), corners: randomOutline(r) };
  }
}

/** Every cut in the document has its circle clear of its body's outline (`clearCut`), so the model is sure of its answer. */
function clearDoc(doc: NamingDoc): boolean {
  const r = rebuildNaming(doc);
  for (const item of doc.items) {
    if (item.kind !== "cut") continue;
    const s = doc.items.find((i) => i.id === item.sketch);
    const placed = r.results[item.sketch];
    const tool = s?.kind === "face-sketch" && placed?.kind === "sketch" ? { centre: s.centre, radius: s.radius, placement: placed.placement } : item.kept;
    const base = doc.items.find((i) => i.id === item.target);
    const bs = base?.kind === "extrude" ? doc.items.find((i) => i.id === base.sketch) : undefined;
    const corners = bs?.kind === "sketch" ? bs.corners : base?.kind === "extrude" ? base.kept : undefined;
    if (!tool || !corners) continue;
    if (!clearCut([tool.placement.origin[0] + tool.centre[0], tool.placement.origin[1] + tool.centre[1]], tool.radius, corners)) return false;
  }
  return true;
}

/**
 * No sketch on a side is on a face turned exactly a right angle from where
 * it was drawn (outward normals square, decided in whole numbers): there
 * rule 8's choice of side is a tie the model breaks by rule, but a kernel's
 * rounded normals could break either way. The tie itself is hand-worked in
 * test/naming-model.test.ts.
 */
function clearSides(doc: NamingDoc): boolean {
  const faces = namingFaces(doc);
  for (const item of doc.items) {
    if (item.kind !== "face-sketch" || item.face.role !== "side") continue;
    const face = faces.find((f) => faceKeyOf(f.name) === faceKeyOf(item.face));
    const o = item.drawn.outward;
    if (face && o[0] * face.outward[0] + o[1] * face.outward[1] + o[2] * face.outward[2] === 0) return false;
  }
  return true;
}

/** A grid point at fractions `f` across the outline's bounds, 5 mm wider each way. */
function across(corners: readonly Point[], f: readonly [number, number]): Point {
  const at = (k: 0 | 1) => {
    const lo = Math.min(...corners.map((p) => p[k])) - 5;
    const hi = Math.max(...corners.map((p) => p[k])) + 5;
    return Math.round(lo + f[k] * (hi - lo));
  };
  return [at(0), at(1)];
}

const pickOf = <T>(xs: readonly T[], f: number): T | undefined => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : undefined);

/** A random step made concrete against the model's document, or null when it has nothing to act on or would leave a cut the model isn't sure of. */
export function resolveRandom(doc: NamingDoc, step: RandomStep): NamingStep | null {
  const kind = (k: string) => doc.items.filter((i) => i.kind === k);
  const edit = (op: NamingOp | null): NamingStep | null => {
    if (op === null) return null;
    if (op.op !== "undo" && op.op !== "redo") {
      const m = createNamingModel();
      m.doc = JSON.parse(JSON.stringify(doc));
      if (applyNaming(m, op).kind === "done" && !(clearDoc(m.doc) && clearSides(m.doc))) return null;
    }
    return { kind: "op", op };
  };
  switch (step.op) {
    case "set-corners": {
      const s = kind("sketch")[0];
      return s ? edit({ op: "set-corners", sketch: s.id, corners: step.corners }) : null;
    }
    case "move-corner": {
      const s = kind("sketch")[0];
      if (s?.kind !== "sketch") return null;
      const k = Math.min(s.corners.length - 1, Math.floor(step.corner * s.corners.length));
      const moved = s.corners.map((p, j): Point => (j === k ? step.to : p));
      return polygonValid(moved) ? edit({ op: "move-corner", sketch: s.id, corner: k, to: step.to }) : null;
    }
    case "set-distance": {
      const item = pickOf(doc.items.filter((i) => i.kind === "extrude" || i.kind === "face-extrude"), step.pick);
      return item ? edit({ op: "set-distance", item: item.id, value: step.value }) : null;
    }
    case "set-circle": {
      const s = kind("face-sketch")[0];
      const base = kind("sketch")[0];
      const corners = base?.kind === "sketch" ? base.corners : kind("extrude").map((e) => (e.kind === "extrude" ? e.kept : undefined))[0];
      return s && corners ? edit({ op: "set-circle", sketch: s.id, centre: across(corners, step.at), radius: step.radius }) : null;
    }
    case "set-depth": {
      const c = kind("cut")[0];
      return c ? edit({ op: "set-depth", item: c.id, value: step.value }) : null;
    }
    case "delete": {
      const item = pickOf(doc.items, step.pick);
      return item ? edit({ op: "delete", item: item.id }) : null;
    }
    case "plan": {
      const item = pickOf(doc.items, step.pick);
      return item ? { kind: "plan", item: item.id } : null;
    }
    case "suppress": {
      const item = pickOf(
        doc.items.filter((i): i is Extract<typeof i, { kind: "extrude" | "face-extrude" | "cut" }> => i.kind === "extrude" || i.kind === "face-extrude" || i.kind === "cut"),
        step.pick,
      );
      return item ? edit({ op: "suppress", item: item.id, on: !item.suppressed }) : null;
    }
    case "reorder": {
      const item = pickOf(doc.items, step.pick);
      return item ? edit({ op: "reorder", item: item.id, to: Math.min(doc.items.length - 1, Math.floor(step.to * doc.items.length)) }) : null;
    }
    case "undo":
    case "redo":
      return edit({ op: step.op });
    case "save-open":
      return { kind: "save-open" };
    case "add-outline":
      return kind("sketch").length < 3 ? edit({ op: "add-sketch", corners: step.corners }) : null;
    case "extrude-outline": {
      const s = pickOf(
        kind("sketch").filter((x) => !doc.items.some((i) => i.kind === "extrude" && i.sketch === x.id)),
        step.pick,
      );
      return s ? edit({ op: "add-extrude", sketch: s.id, distance: step.distance }) : null;
    }
    case "reorder-early": {
      const s = kind("face-sketch")[0];
      if (s === undefined) return null;
      const at = doc.items.indexOf(s);
      const ok = (i: NamingItem) => i.kind === "sketch" || (i.kind === "extrude" && doc.items.findIndex((j) => j.id === i.sketch) < at);
      const item = pickOf(doc.items.slice(at + 1).filter(ok), step.pick);
      return item ? edit({ op: "reorder", item: item.id, to: at }) : null;
    }
    case "pin":
    case "project": {
      // On the face sketch while it is on a cap, built, and on a face found (rule 13: of the extrudes before it, with lines).
      const s = kind("face-sketch")[0];
      if (s?.kind !== "face-sketch" || !onFoundCap(doc, s)) return null;
      const at = doc.items.indexOf(s);
      const f = pickOf(
        doc.items.slice(0, at).filter((i) => i.kind === "extrude" && outlineLines(doc, i.id) !== null),
        step.pick,
      );
      if (f === undefined) return null;
      const lines = outlineLines(doc, f.id)!;
      const n = lines.length;
      const j = Math.min(n - 1, Math.floor(step.line * n));
      const cap: Cap = step.cap < 0.5 ? "start" : "end";
      const [before, after] = [lines[(j + n - 1) % n], lines[j]];
      if (step.op === "project") {
        const edge: EdgeName = step.kind < 0.7 ? { feature: f.id, at: "cap-edge", cap, line: lines[j] } : { feature: f.id, at: "upright", before, after };
        return edit({ op: "project", sketch: s.id, edge });
      }
      const pin: PinName = step.kind < 0.4 ? { at: "corner", before, after, feature: f.id, cap } : step.kind < 0.75 ? { at: "middle", line: lines[j], feature: f.id, cap } : { at: "upright", before, after, feature: f.id };
      return edit({ op: "set-circle", sketch: s.id, centre: [0, 0], radius: step.radius, pin });
    }
    case "unproject": {
      const s = kind("face-sketch")[0];
      const q = s?.kind === "face-sketch" ? pickOf(s.projections ?? [], step.pick) : undefined;
      return q ? edit({ op: "unproject", sketch: s.id, projection: q.id }) : null;
    }
    case "project-again": {
      const s = kind("face-sketch")[0];
      const q = s?.kind === "face-sketch" ? pickOf(s.projections ?? [], step.pick) : undefined;
      if (s?.kind !== "face-sketch" || q === undefined || !onFoundCap(doc, s)) return null;
      const before = doc.items.findIndex((i) => i.id === q.edge.feature) < doc.items.indexOf(s);
      return before && edgeAt(doc, q.edge) !== null ? edit({ op: "project", sketch: s.id, edge: q.edge }) : null;
    }
    case "reorder-across": {
      const s = kind("face-sketch")[0];
      const f = s ? pickOf([...new Set(refsOf(s))].filter((id) => doc.items.some((i) => i.id === id)), step.pick) : undefined;
      if (!s || !f) return null;
      const [at, fat] = [doc.items.indexOf(s), doc.items.findIndex((i) => i.id === f)];
      return step.way < 0.5 ? edit({ op: "reorder", item: s.id, to: fat }) : edit({ op: "reorder", item: f, to: at });
    }
    case "delete-ref": {
      const s = kind("face-sketch")[0];
      const f = s ? pickOf([...new Set(refsOf(s))].filter((id) => doc.items.some((i) => i.id === id)), step.pick) : undefined;
      return f ? edit({ op: "delete", item: f }) : null;
    }
    case "move-other":
    case "redraw-other": {
      const s = pickOf(kind("sketch").slice(1), step.pick);
      if (s?.kind !== "sketch") return null;
      if (step.op === "redraw-other") return edit({ op: "set-corners", sketch: s.id, corners: step.corners });
      const k = Math.min(s.corners.length - 1, Math.floor(step.corner * s.corners.length));
      const moved = s.corners.map((p, j): Point => (j === k ? step.to : p));
      return polygonValid(moved) ? edit({ op: "move-corner", sketch: s.id, corner: k, to: step.to }) : null;
    }
  }
}

/** Whether face sketch `s` is on a cap, built, and on a face found: where a pin or a projection can be made (rule 13). */
function onFoundCap(doc: NamingDoc, s: Extract<NamingItem, { kind: "face-sketch" }>): boolean {
  const res = rebuildNaming(doc).results[s.id];
  return s.face.role !== "side" && res?.kind === "sketch" && !(res.warning !== undefined && "face" in res.warning);
}

/** An extrude's outline's line ids: its sketch's, or those kept when the sketch was deleted; null with none. */
function outlineLines(doc: NamingDoc, feature: string): readonly string[] | null {
  const f = doc.items.find((i) => i.id === feature);
  if (f?.kind !== "extrude") return null;
  const s = doc.items.find((i) => i.id === f.sketch);
  return s?.kind === "sketch" ? s.lines : (f.keptLines ?? null);
}

/**
 * A random setup the model is sure of: a rectangle or triangle, a distance
 * either way, either cap, and a circle clear of the outline (`clearCut`)
 * that meets it or not; without cuts, half of them on a side instead
 * (never one at exactly 45° between two origin planes, where rule 8's
 * choice is a tie a kernel's rounded normal could break either way); from
 * 26f, given `pins`, two in five on a cap with the centre pinned to a
 * corner or a side's middle (rule 10).
 */
export function randomSetup(r: SeededRandom, cuts = true, pins?: SeededRandom): Setup {
  for (;;) {
    const corners = randomOutline(r);
    const k = int(r, 0, corners.length - 1);
    const onSide = !cuts && r.next() < 0.5;
    const cap: Setup["cap"] = onSide ? { side: k } : r.next() < 0.5 ? "end" : "start";
    const s: Setup = { corners, distance: nonZero(r, 40), cap, centre: across(corners, [r.next(), r.next()]), radius: radiusOf(r), depth: int(r, 1, 45) };
    const [a, b] = [corners[k], corners[(k + 1) % corners.length]];
    if (onSide && Math.abs(b[0] - a[0]) === Math.abs(b[1] - a[1])) continue;
    // Step 26f: on a cap, two in five circles snapped onto a corner or a side's middle (from `pins`, a stream of its own, so the sessions without it are as they were).
    if (!onSide && pins && pins.next() < 0.4) {
      const n = corners.length;
      const j = int(pins, 0, n - 1);
      const line = (i: number) => `line-${((i + n) % n) + 1}`;
      if (pins.next() < 0.5) {
        s.pin = { at: "corner", before: line(j - 1), after: line(j) };
        s.centre = [corners[j][0], corners[j][1]];
      } else {
        const [a, b] = [corners[j], corners[(j + 1) % n]];
        s.pin = { at: "middle", line: line(j) };
        s.centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
    }
    if (onSide || clearCut(s.centre, s.radius, corners)) return s;
  }
}

export interface NamingSession {
  setup: Setup;
  steps: RandomStep[];
}

/**
 * A seeded session; `cuts` as the subject's, since only a subject without
 * cuts gets setups on a side. With `step27` (a subject that pins to any
 * extrude's edges, "pins", and projects them too, "all": rules 11 to 13),
 * the setup has a second body before the face sketch and two steps in five
 * are step 27's, from a stream of their own; without, the sessions are 26's.
 */
export function randomNamingSession(seed: bigint, steps: number, cuts = true, step27: false | "pins" | "all" = false): NamingSession {
  const r = seeded(seed);
  const setup = randomSetup(r, cuts, seeded(seed ^ 0x26fn));
  const r27 = seeded(seed ^ 0x27an);
  if (step27) setup.other = { corners: randomOutline(r27), distance: nonZero(r27, 40) };
  return { setup, steps: Array.from({ length: steps }, () => (step27 && r27.next() < 0.4 ? randomStep27(r27, step27 === "pins") : randomStep(r))) };
}

/** Runs a random session: each step resolved against the model's document as it stands, then checked like any other. */
export async function runNamingSession(subject: NamingSubject, session: NamingSession): Promise<NamingCounts> {
  // Resolve against a model replaying the same steps, so a step's targets are
  // the ones the checking run will see.
  const m = createNamingModel();
  for (const op of setupOps(session.setup, subject.cuts)) applyNaming(m, op);
  const concrete: NamingStep[] = [];
  for (const step of session.steps) {
    const c = resolveRandom(m.doc, step);
    if (c === null) continue;
    if (c.kind === "op") applyNaming(m, c.op);
    concrete.push(c);
  }
  const { counts } = await runNaming(subject, session.setup, concrete);
  counts.skipped = session.steps.length - concrete.length;
  return counts;
}

/** The failure a session hits, or null. */
export async function namingFailureOf(make: () => NamingSubject, session: NamingSession): Promise<NamingFailure | null> {
  try {
    await runNamingSession(make(), session);
    return null;
  } catch (e) {
    if (e instanceof NamingFailure) return e;
    throw e;
  }
}

/**
 * Cuts a failing session to a list of steps failing the same check from
 * which no single step and no two steps can be dropped. Pairs too, since a
 * step's targets are fractions picked against the document as it stands:
 * two steps that only steer a later pick onto the same target (step 27's
 * second projection of one edge) go only together.
 */
export async function shrinkNaming(make: () => NamingSubject, session: NamingSession): Promise<NamingSession> {
  const first = await namingFailureOf(make, session);
  if (first === null) return session;
  const same = async (steps: RandomStep[]) => (await namingFailureOf(make, { setup: session.setup, steps }))?.check === first.check;
  let cur = [...session.steps];
  const singles = async () => {
    let changed = false;
    for (let k = cur.length - 1; k >= 0; k--) {
      const shorter = [...cur.slice(0, k), ...cur.slice(k + 1)];
      if (await same(shorter)) {
        cur = shorter;
        changed = true;
      }
    }
    return changed;
  };
  const pairs = async () => {
    for (let j = cur.length - 1; j > 0; j--)
      for (let k = j - 1; k >= 0; k--) {
        const shorter = cur.filter((_, i) => i !== j && i !== k);
        if (await same(shorter)) {
          cur = shorter;
          return true;
        }
      }
    return false;
  };
  while ((await singles()) || (await pairs()));
  return { setup: session.setup, steps: cur };
}

// ------------------------------------------------------------ the model as a subject

/** The model run as a subject, with planted bugs; with none it passes every check. */
export function namingModelSubject(faults: Iterable<NamingFault> = [], cuts = true): NamingSubject {
  const fs: ReadonlySet<NamingFault> = new Set(faults);
  let m = createNamingModel(fs);
  return {
    cuts,
    apply: (op) => applyNaming(m, op),
    planDelete: (item) => planDelete(m.doc, item, fs),
    read: () => rebuildNaming(m.doc, fs),
    saveOpen: () => {
      const doc = JSON.parse(JSON.stringify(m.doc));
      m = { ...m, doc };
    },
  };
}

// ------------------------------------------------------------ Ben's answers

/** What a case's last read must show, worked out by hand (model ids). Bodies are listed whole: every body and its volume after its cuts. */
export interface Expect {
  order: string[];
  /** A sketch's placement; `x` and `normal` are the world's XY frame's unless given. */
  /** `projected`: its projected edges (step 27), checked when given ([] for none). */
  sketch?: { id: string; origin: Vec3; x?: Vec3; normal?: Vec3; side: 1 | -1; warning?: "plane-lost" | "plane-ambiguous" | "point-lost" | "projection-lost"; projected?: { id: string; at: Point[] }[] };
  cut?: { id: string; removed: number } | { id: string; failed: true };
  bodies: Record<string, number>;
  /** New bodies' centroids (before any cut) and the warning the feature that made each one shows, none unless given. */
  solids?: Record<string, { centroid: Vec3; warning?: "deleted-input" | "source-lost" }>;
  /** Items that must be off: suppressed themselves, or greyed by what they are built on (step 26, Q3). */
  off?: Record<string, "suppressed" | "greyed">;
}

export interface FusionCase {
  /**
   * Which of the owner's answers it encodes: "1" to "7" from 25a (docs/progress/cad.md, "Naming test plan (25a)"), "Q1" to "Q4" from step 26 ("Sketch on a face test plan (26a)");
   * from step 27, "R11" to "R13", the model's rules 11 to 13 (Fusion's projected geometry as the harness reads it; "Projected edges test plan (27a)").
   */
  answer: string;
  title: string;
  /** Whether it needs a cut (booleans), or holds for a subject that makes the circle a new body. */
  cuts: boolean;
  /** For step 27's cases, the substep from which Design runs it: 27c (pins on any extrude's edges) or 27d (projected edges). */
  from?: "27c" | "27d";
  setup: Setup;
  steps: NamingStep[];
  expect: Expect;
}

/** What differs between a read (model ids) and a case's hand-worked answer, or null. */
export function expectDiff(r: NamingRebuild, e: Expect): string | null {
  if (r.order.join() !== e.order.join()) return `order [${r.order}], want [${e.order}]`;
  if (e.sketch) {
    const s = r.results[e.sketch.id];
    if (s?.kind !== "sketch") return `${e.sketch.id} is ${s?.kind ?? "missing"}, not a sketch`;
    const want: Placement = { origin: e.sketch.origin, x: e.sketch.x ?? [1, 0, 0], normal: e.sketch.normal ?? [0, 0, 1], side: e.sketch.side };
    const d = placementDiff(s.placement, want);
    if (d) return `${e.sketch.id}: ${d}`;
    const w = s.warning?.cause;
    if (w !== e.sketch.warning) return `${e.sketch.id} warning ${w ?? "none"}, want ${e.sketch.warning ?? "none"}`;
    const p = e.sketch.projected && projectedDiff(s.projected, e.sketch.projected);
    if (p) return `${e.sketch.id}: ${p}`;
  }
  if (e.cut) {
    const c = r.results[e.cut.id];
    if (c?.kind !== "cut") return `${e.cut.id} is not a cut`;
    if ("failed" in e.cut) {
      if (c.status !== "failed") return `${e.cut.id} built, want "no target body"`;
    } else if (c.status !== "built") return `${e.cut.id} failed, want ${e.cut.removed} mm³ removed`;
    else if (!close(c.removed, e.cut.removed)) return `${e.cut.id} removed ${c.removed}, want ${e.cut.removed}`;
    else if (c.warning) return `${e.cut.id} warns ${c.warning.cause}, want no warning`;
  }
  for (const [id, want] of Object.entries(e.solids ?? {})) {
    const got = r.results[id];
    if (got?.kind !== "solid") return `${id} is ${got?.kind ?? "missing"}, not a solid`;
    if (!vecClose(got.centroid, want.centroid)) return `${id}: centroid ${got.centroid}, want ${want.centroid}`;
    if (got.warning?.cause !== want.warning) return `${id} warning ${got.warning?.cause ?? "none"}, want ${want.warning ?? "none"}`;
  }
  for (const [id, want] of Object.entries(e.off ?? {})) if (r.results[id]?.kind !== want) return `${id} is ${r.results[id]?.kind ?? "missing"}, want ${want}`;
  // Nothing else is off.
  for (const [id, res] of Object.entries(r.results)) if ((res.kind === "suppressed" || res.kind === "greyed") && e.off?.[id] === undefined) return `${id} is ${res.kind}, want it on`;
  const keys = Object.keys(r.bodies).sort().join();
  if (keys !== Object.keys(e.bodies).sort().join()) return `bodies [${keys}], want [${Object.keys(e.bodies).sort()}]`;
  for (const [id, v] of Object.entries(e.bodies)) if (!close(r.bodies[id], v)) return `body ${id}: ${r.bodies[id]} mm³, want ${v}`;
  return null;
}

/** Runs a case on a subject: every step checked against the model, then the last read against the hand-worked answer. */
export async function runFusionCase(subject: NamingSubject, c: FusionCase): Promise<void> {
  const { last } = await runNaming(subject, c.setup, c.steps);
  const d = expectDiff(last, c.expect);
  if (d) throw new NamingFailure(c.steps.length + 4, "hand-worked answer", `answer ${c.answer} (${c.title}): ${d}`);
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * The owner's part (answers, 2026-10-18): a 40 × 30 rectangle on XY with a
 * corner at the origin, extruded 20 up; a circle of radius 5 at (20, 15) on
 * the top cap; a cut 10 deep. The depth is the harness's choice (Ben didn't
 * give one): a blind hole, so a hole of the whole circle removes
 * π · 5² · 10 = 250π mm³ and leaves 40 · 30 · 20 − 250π = 24000 − 250π.
 */
export const BEN: Setup = { corners: rect(0, 0, 40, 30), distance: 20, cap: "end", centre: [20, 15], radius: 5, depth: 10 };
/**
 * Ben's part with the circle's centre snapped onto the top's back right
 * corner (40, 30) instead (Q4, step 26f): corner 2, where line 2 (the
 * right side, (40, 0) → (40, 30)) ends and line 3 (the back) starts.
 */
export const PINNED: Setup = { ...BEN, centre: [40, 30], pin: { at: "corner", before: "line-2", after: "line-3" } };
const PI = Math.PI;

const op = (o: NamingOp, want?: NamingApplied["kind"] | RefuseCause): NamingStep => ({ kind: "op", op: o, ...(want ? { want } : {}) });
/**
 * Step 27's second body, before the face sketch so it can be named (rule
 * 13): a 60..80 × 0..10 rectangle (sketch-5, lines 5 to 8: line 5 along
 * y = 0 from (60, 0), line 6 up x = 80, line 7 back along y = 10, line 8
 * down x = 60) extruded 5 (extrude-6: 200 · 5 = 1000, middle (70, 5, 2.5)),
 * both dragged to just after Extrude 2.
 */
const OTHER_BODY: NamingStep[] = [
  op({ op: "add-sketch", corners: rect(60, 0, 80, 10) }, "done"),
  op({ op: "add-extrude", sketch: "sketch-5", distance: 5 }, "done"),
  op({ op: "reorder", item: "sketch-5", to: 2 }, "done"),
  op({ op: "reorder", item: "extrude-6", to: 3 }, "done"),
];
const ORDER_27 = ["sketch-1", "extrude-2", "sketch-5", "extrude-6", "sketch-3", "extrude-4"];
const FULL = ["sketch-1", "extrude-2", "sketch-3", "cut-4"];
const NEW = ["sketch-1", "extrude-2", "sketch-3", "extrude-4"];
/** Ben's part with a new body, unedited: the base and the cylinder on its top, both on, nothing warning. */
const BASE_NEW: Expect = {
  order: NEW,
  sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
  bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
  solids: { "extrude-2": { centroid: [20, 15, 10] }, "extrude-4": { centroid: [20, 15, 25] } },
};

/** Every drag in Ben's four-item chain (answer 7), worked out by hand. `to` is the place in the list without the item. */
function chainDrags(last: string): NamingStep[] {
  const [s1, e2, s3, x4] = ["sketch-1", "extrude-2", "sketch-3", last];
  return [
    // Sketch 1 after Extrude 2 or later: Extrude 2 is built from it.
    op({ op: "reorder", item: s1, to: 1 }, "after-dependent"),
    op({ op: "reorder", item: s1, to: 2 }, "after-dependent"),
    op({ op: "reorder", item: s1, to: 3 }, "after-dependent"),
    // Extrude 2 before Sketch 1 (its sketch), or after Sketch 3 (on its cap).
    op({ op: "reorder", item: e2, to: 0 }, "before-dependency"),
    op({ op: "reorder", item: e2, to: 2 }, "after-dependent"),
    op({ op: "reorder", item: e2, to: 3 }, "after-dependent"),
    // Sketch 3 before Extrude 2 (the face it is on), or after the feature built from it.
    op({ op: "reorder", item: s3, to: 0 }, "before-dependency"),
    op({ op: "reorder", item: s3, to: 1 }, "before-dependency"),
    op({ op: "reorder", item: s3, to: 3 }, "after-dependent"),
    // The last feature before Sketch 3, its sketch.
    op({ op: "reorder", item: x4, to: 0 }, "before-dependency"),
    op({ op: "reorder", item: x4, to: 1 }, "before-dependency"),
    op({ op: "reorder", item: x4, to: 2 }, "before-dependency"),
    // Each to its own place: nothing changes, no undo step.
    op({ op: "reorder", item: s1, to: 0 }, "unchanged"),
    op({ op: "reorder", item: e2, to: 1 }, "unchanged"),
    op({ op: "reorder", item: s3, to: 2 }, "unchanged"),
    op({ op: "reorder", item: x4, to: 3 }, "unchanged"),
  ];
}

/** The owner's answers 1 to 7 with the cut, then the ones that hold for a new body (step 26, before booleans), each worked out by hand. */
export const FUSION_CASES: readonly FusionCase[] = [
  {
    answer: "1",
    title: "the rectangle made 60 × 30: the hole stays on the top face and stays put",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // The sketch's frame is the world's: its (0, 0) stays over the origin, at
    // the top's height 20, so the circle is still at (20, 15), wholly inside
    // the wider rectangle: 250π removed from 60 · 30 · 20 = 36000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 36000 - 250 * PI } },
  },
  {
    answer: "2",
    title: "the first extrude flipped downward: the cut finds no target body and the body stays",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: -20 }, "done")],
    // The body is now z from −20 to 0 and its end cap is the bottom, at −20.
    // The sketch follows the end cap down but keeps facing +Z, the side it
    // was drawn from, so the cut goes from −20 down to −30: it only touches
    // the body's bottom, no height in common, "no target body". The body is
    // whole: 40 · 30 · 20 = 24000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, -20], side: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 24000 } },
  },
  {
    answer: "3",
    title: "the rectangle made a triangle whose long side runs through the hole: the hole is cut in half, no error",
    cuts: true,
    setup: BEN,
    steps: [
      op(
        {
          op: "set-corners",
          sketch: "sketch-1",
          corners: [
            [0, 0],
            [40, 0],
            [0, 30],
          ],
        },
        "done",
      ),
    ],
    // The long side, (40, 0) to (0, 30), is 3x + 4y = 120; the centre gives
    // 3 · 20 + 4 · 15 = 120, on it, so half the circle is inside: 25π / 2 ·
    // 10 = 125π removed from the triangle's 40 · 30 / 2 · 20 = 12000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 125 * PI }, bodies: { "extrude-2": 12000 - 125 * PI } },
  },
  {
    answer: "4",
    title: "the first extrude deleted: it asks first, the body and the cut go, the sketch stays with its plane lost",
    cuts: true,
    setup: BEN,
    steps: [
      // Extrude 2 has Sketch 3 on its cap and Cut 4 in its body: it asks, and
      // the cut goes with it; the sketch on its face stays.
      { kind: "plan", item: "extrude-2", want: { ask: true, removes: ["extrude-2", "cut-4"] } },
      // Nothing is built from Cut 4: no question, just it.
      { kind: "plan", item: "cut-4", want: { ask: false, removes: ["cut-4"] } },
      // Cut 4 is built from Sketch 3: it asks, and the cut keeps its last shape (the 24 rule).
      { kind: "plan", item: "sketch-3", want: { ask: true, removes: ["sketch-3"] } },
      op({ op: "delete", item: "extrude-2" }, "done"),
    ],
    // Sketch 3 is held where it last was, the top at z = 20 facing +Z, with
    // the warning naming the lost face; no body is left.
    expect: { order: ["sketch-1", "sketch-3"], sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "plane-lost" }, bodies: {} },
  },
  {
    answer: "4",
    title: "undo after deleting the first extrude brings back the body, the hole and the sketch's plane",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "delete", item: "extrude-2" }, "done"), op({ op: "undo" }, "done"), { kind: "save-open" }],
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 24000 - 250 * PI } },
  },
  {
    answer: "5",
    title: "the first extrude made 35 long: the hole's sketch moves up with the top face",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: 35 }, "done")],
    // The top is at 35; the cut goes 35 down to 25, all inside: 250π removed
    // from 40 · 30 · 35 = 42000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 35], side: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 42000 - 250 * PI } },
  },
  {
    answer: "6",
    title: "the outline made 10 × 30 so the hole falls outside: no target body, the body stays",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 10, 30) }, "done")],
    // The circle spans x 15 to 25, all past x = 10: no area in common.
    // The body: 10 · 30 · 20 = 6000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 6000 } },
  },
  {
    answer: "6",
    title: "nasty: the outline's side exactly tangent to the hole (15 × 30): touching only, no target body",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 15, 30) }, "done")],
    // The side x = 15 is exactly r = 5 from the centre (20, 15): the circle
    // touches it at one point, decided in whole numbers: the side (15, 0) to
    // (15, 30) has cross((0, 30), (5, 15))² = 150² = 22500 = r² · |side|² =
    // 25 · 900, not less, so no area; no tolerance is involved. The body: 15 · 30 · 20 = 9000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 9000 } },
  },
  {
    answer: "6",
    title: "nasty: one grid step further (16 × 30) the side takes a 1 mm sliver of the hole: built",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 16, 30) }, "done")],
    // The circle reaches 1 mm past x = 16, a segment of height h = 1 of a
    // circle of r = 5: r² acos((r − h) / r) − (r − h) √(2rh − h²) =
    // 25 acos(0.8) − 4 · 3 = 25 acos(0.8) − 12 ≈ 4.0875 mm², times 10 deep;
    // the body: 16 · 30 · 20 = 9600 less that.
    expect: {
      order: FULL,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      cut: { id: "cut-4", removed: (25 * Math.acos(0.8) - 12) * 10 },
      bodies: { "extrude-2": 9600 - (25 * Math.acos(0.8) - 12) * 10 },
    },
  },
  {
    answer: "7",
    title: "every drag in the four-item chain is refused, and dragging an item to its own place changes nothing",
    cuts: true,
    setup: BEN,
    steps: chainDrags("cut-4"),
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 24000 - 250 * PI } },
  },
  // ---- the same part with the circle extruded 10 up as a new body (step 26, before booleans)
  //
  // Centroids, worked by hand: the base 40 × 30 × 20 has its middle at (20,
  // 15, 10); the cylinder of radius 5 and height 10 on the top (z 20 to 30)
  // at (20, 15, 25), volume π · 5² · 10 = 250π.
  {
    answer: "1",
    title: "new body: the rectangle made 60 × 30, the circle's body stays put on the top",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // The base 36000 with its middle at (30, 15, 10); the cylinder unmoved.
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [30, 15, 10] }, "extrude-4": { centroid: [20, 15, 25] } },
    },
  },
  {
    answer: "2",
    title: "new body: the first extrude flipped, the sketch follows the end cap down and still faces up",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: -20 }, "done")],
    // The sketch at z = −20 facing +Z; its body goes up from −20 to −10,
    // middle (20, 15, −15), inside the base (−20 to 0, middle at −10;
    // bodies may overlap until booleans join them).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, -20], side: 1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [20, 15, -10] }, "extrude-4": { centroid: [20, 15, -15] } },
    },
  },
  {
    answer: "Q1",
    title: "new body: the first extrude deleted asks first, and only it goes; the sketch stays with its plane lost, the cylinder stays built there saying its source is lost",
    cuts: false,
    setup: BEN,
    steps: [{ kind: "plan", item: "extrude-2", want: { ask: true, removes: ["extrude-2"] } }, op({ op: "delete", item: "extrude-2" }, "done")],
    // Ben's Q1 (2026-10-19): only cuts into its body go with it; the
    // cylinder is built from the sketch held at z = 20 (Fusion's cached
    // geometry), so it is where it was, (20, 15, 25), with "source lost".
    expect: {
      order: ["sketch-1", "sketch-3", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "plane-lost" },
      bodies: { "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [20, 15, 25], warning: "source-lost" } },
    },
  },
  {
    answer: "Q1",
    title: "new body: undo after deleting the first extrude brings back the base, the sketch's plane and the cylinder without a warning",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "delete", item: "extrude-2" }, "done"), op({ op: "undo" }, "done"), { kind: "save-open" }],
    expect: BASE_NEW,
  },
  {
    answer: "5",
    title: "new body: the first extrude made 35 long, the sketch moves up with the top",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: 35 }, "done")],
    // The base 42000, middle (20, 15, 17.5); the cylinder 35 to 45, middle at 40.
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 35], side: 1 },
      bodies: { "extrude-2": 42000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [20, 15, 17.5] }, "extrude-4": { centroid: [20, 15, 40] } },
    },
  },
  {
    answer: "7",
    title: "new body: every drag in the chain is refused",
    cuts: false,
    setup: BEN,
    steps: chainDrags("extrude-4"),
    expect: BASE_NEW,
  },
  // ---- Q2 (Ben, 2026-10-19): a sketch on a side reads in world coordinates
  //
  // Ben's rectangle goes (0, 0), (40, 0), (40, 30), (0, 30), counter-
  // clockwise, so line k (corner k to k + 1) sweeps the side facing
  // (dy, −dx): line 1 the front (y = 0, facing −Y), line 2 the right (x =
  // 40, +X), line 3 the back (y = 30, +Y), line 4 the left (x = 0, −X).
  {
    answer: "Q2",
    title: "a sketch on the front side has the front plane's frame: x along world X, y up world Z",
    cuts: false,
    setup: { ...BEN, cap: { side: 0 }, centre: [20, 10] },
    steps: [],
    // Facing −Y: of the origin planes' normals (+Z, −Y, +X) the front
    // plane's −Y is along it (|(0, −40, 0) · (0, −1, 0)| = 40, the others 0),
    // the same way (side +1). The plane y = 0 holds the origin, so the frame
    // is the front plane's own: x = X, normal −Y, y = −Y × X = Z. The circle
    // at (20, 10) is world (20, 0, 10); its body goes 10 out along −Y:
    // middle (20, −5, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 0], x: [1, 0, 0], normal: [0, -1, 0], side: 1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [20, -5, 10] } },
    },
  },
  {
    answer: "Q2",
    title: "a sketch on the back side still reads world X and Z, facing against the frame's normal",
    cuts: false,
    setup: { ...BEN, cap: { side: 2 }, centre: [20, 10] },
    steps: [],
    // Facing +Y, (0, 40, 0): again the front plane's −Y is the nearest
    // normal, but the other way (40 · −1 < 0), so side −1 and the frame
    // stays the front plane's (x = X, y = Z): coordinates still the world's.
    // The origin is where y = 30 meets the origin square on, (0, 30, 0); the
    // circle is world (20, 30, 10) and its body goes out along +Y (−1 ×
    // −Y): middle (20, 35, 10). (A frame that faced out would mirror x.)
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 30, 0], x: [1, 0, 0], normal: [0, -1, 0], side: -1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [20, 35, 10] } },
    },
  },
  {
    answer: "Q2",
    title: "sketches on the right and left sides have the side plane's frame: x along world Y, y up world Z",
    cuts: false,
    setup: { ...BEN, cap: { side: 1 }, centre: [15, 10] },
    steps: [],
    // Facing +X, (30, 0, 0): the side plane's +X, same way. Origin (40, 0,
    // 0); x = Y, y = X × Y = Z; the circle (15, 10) is world (40, 15, 10),
    // its body 40 to 50 along X: middle (45, 15, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [40, 0, 0], x: [0, 1, 0], normal: [1, 0, 0], side: 1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [45, 15, 10] } },
    },
  },
  {
    answer: "Q2",
    title: "the left side: the side plane's frame at x = 0, facing against it",
    cuts: false,
    setup: { ...BEN, cap: { side: 3 }, centre: [15, 10] },
    steps: [],
    // Facing −X, (−30, 0, 0): side −1, frame unchanged, origin (0, 0, 0);
    // the circle is world (0, 15, 10), its body 0 to −10 along X: middle
    // (−5, 15, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 0], x: [0, 1, 0], normal: [1, 0, 0], side: -1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [-5, 15, 10] } },
    },
  },
  {
    answer: "Q2",
    title: "a sketch on the bottom cap reads world X and Y and faces down",
    cuts: false,
    setup: { ...BEN, cap: "start" },
    steps: [],
    // Facing −Z: the ground plane's normal +Z the other way, side −1, frame
    // XY at z = 0. The circle (20, 15) is world (20, 15, 0); its body goes
    // down 10: middle (20, 15, −5).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 0], side: -1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [20, 15, -5] } },
    },
  },
  {
    answer: "Q2",
    title: "the front side turned by moving a corner: the sketch turns with it the shortest way, its origin where the world's meets the new plane",
    cuts: false,
    setup: { ...BEN, cap: { side: 0 }, centre: [20, 10] },
    steps: [op({ op: "move-corner", sketch: "sketch-1", corner: 0, to: [0, -10] }, "done")],
    // Line 1 now runs (0, −10) to (40, 0): dx = 40, dy = 10, facing (10,
    // −40, 0), n = (1, −4, 0)/√17; drawn facing (0, −40, 0), and 40 · 40 >
    // 0, so the normal stays on the outside. Turning −Y onto n about Z:
    // cos = 4/√17, sin = 1/√17, so X turns to x = (4, 1, 0)/√17, along the
    // line, and y = n × x = (0, 0, (1 · 1 + 4 · 4)/17) = Z. The plane holds
    // (0, −10, 0): (0, −10, 0) · n = 40/√17, so the origin is 40/√17 · n =
    // (40/17, −160/17, 0). The circle (20, 10) is origin + 20 x + 10 Z and
    // its body's middle 5 n further: x part 40/17 + 80/√17 + 5/√17 = 40/17
    // + 85/√17, y part −160/17 + 20/√17 − 20/√17 = −160/17, z 10. The base:
    // shoelace (400 + 1200 + 1200 + 0)/2 = 1400, × 20 = 28000, middle
    // (160000/8400, 104000/8400, 10) = (400/21, 260/21, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [40 / 17, -160 / 17, 0], x: [4 / Math.sqrt(17), 1 / Math.sqrt(17), 0], normal: [1 / Math.sqrt(17), -4 / Math.sqrt(17), 0], side: 1 },
      bodies: { "extrude-2": 28000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [400 / 21, 260 / 21, 10] }, "extrude-4": { centroid: [40 / 17 + 85 / Math.sqrt(17), -160 / 17, 10] } },
    },
  },
  {
    answer: "Q2",
    title: "the outline redrawn as a triangle: the right side's line is gone, so its sketch's plane is lost and the cylinder stays where it was",
    cuts: false,
    setup: { ...BEN, cap: { side: 1 }, centre: [15, 10] },
    steps: [
      op(
        {
          op: "set-corners",
          sketch: "sketch-1",
          corners: [
            [0, 0],
            [40, 0],
            [0, 30],
          ],
        },
        "done",
      ),
    ],
    // Three corners instead of four is a new outline with new lines, so no
    // face is named for line 2 any more (never the triangle's second side,
    // which is another line): held on the right side's plane, its body where
    // it was, (45, 15, 10), with "source lost". The base: 40 · 30 / 2 · 20 =
    // 12000, middle (40/3, 10, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [40, 0, 0], x: [0, 1, 0], normal: [1, 0, 0], side: 1, warning: "plane-lost" },
      bodies: { "extrude-2": 12000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [40 / 3, 10, 10] }, "extrude-4": { centroid: [45, 15, 10], warning: "source-lost" } },
    },
  },
  // ---- Q3 (Ben, 2026-10-19): suppressing the first extrude greys what is built on it, with no warning
  {
    answer: "Q3",
    title: "new body: Extrude 2 suppressed greys the sketch on its top and the cylinder, with no warning",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "suppress", item: "extrude-2", on: true }, "done")],
    expect: { order: NEW, bodies: {}, off: { "extrude-2": "suppressed", "sketch-3": "greyed", "extrude-4": "greyed" } },
  },
  {
    answer: "Q3",
    title: "with the cut: Extrude 2 suppressed greys the sketch and the cut",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "suppress", item: "extrude-2", on: true }, "done")],
    expect: { order: FULL, bodies: {}, off: { "extrude-2": "suppressed", "sketch-3": "greyed", "cut-4": "greyed" } },
  },
  {
    answer: "Q3",
    title: "new body: suppressed and back on, through save and open, everything is as it was and nothing warns",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "suppress", item: "extrude-2", on: true }, "done"), { kind: "save-open" }, op({ op: "suppress", item: "extrude-2", on: false }, "done"), op({ op: "suppress", item: "extrude-2", on: false }, "unchanged")],
    expect: BASE_NEW,
  },
  {
    answer: "Q3",
    title: "new body: only what is built on the suppressed extrude greys; a body drawn after it apart stays",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "add-sketch", corners: rect(50, 0, 60, 10) }, "done"), op({ op: "add-extrude", sketch: "sketch-5", distance: 5 }, "done"), op({ op: "suppress", item: "extrude-2", on: true }, "done")],
    // Sketch 5 and Extrude 6 aren't built on Extrude 2: the 10 × 10 × 5
    // block, 500 mm³, middle (55, 5, 2.5), stays.
    expect: {
      order: [...NEW, "sketch-5", "extrude-6"],
      bodies: { "extrude-6": 500 },
      solids: { "extrude-6": { centroid: [55, 5, 2.5] } },
      off: { "extrude-2": "suppressed", "sketch-3": "greyed", "extrude-4": "greyed" },
    },
  },
  {
    answer: "Q3",
    title: "new body: the suppressed extrude deleted: its top's sketch, no longer greyed, is held where it would have been, plane lost, and the cylinder comes back saying its source is lost",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "suppress", item: "extrude-2", on: true }, "done"), op({ op: "delete", item: "extrude-2" }, "done")],
    // While greyed the sketch had no place; with nothing suppressed it was
    // on the top at 20, so that is the placement it keeps (rule 9).
    expect: {
      order: ["sketch-1", "sketch-3", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "plane-lost" },
      bodies: { "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [20, 15, 25], warning: "source-lost" } },
    },
  },
  {
    answer: "Q3",
    title: "new body: the outline redrawn as a triangle while Extrude 2 is suppressed: back on, the right side's sketch is held where it was, plane lost",
    cuts: false,
    setup: { ...BEN, cap: { side: 1 }, centre: [15, 10] },
    steps: [
      op({ op: "suppress", item: "extrude-2", on: true }, "done"),
      op(
        {
          op: "set-corners",
          sketch: "sketch-1",
          corners: [
            [0, 0],
            [40, 0],
            [0, 30],
          ],
        },
        "done",
      ),
      op({ op: "suppress", item: "extrude-2", on: false }, "done"),
    ],
    // While greyed the right side (line 2) was only off; the triangle has
    // new lines, so with nothing suppressed it is gone: the sketch keeps
    // the right side's plane from before the redraw (origin (40, 0, 0), x
    // along Y, normal X, as in the side case above), never the ground
    // plane a lost sketch with nothing held falls back to. The cylinder is
    // where it was, (45, 15, 10), saying its source is lost; the triangle
    // 40 · 30 / 2 · 20 = 12000, middle (40/3, 10, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [40, 0, 0], x: [0, 1, 0], normal: [1, 0, 0], side: 1, warning: "plane-lost" },
      bodies: { "extrude-2": 12000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [40 / 3, 10, 10] }, "extrude-4": { centroid: [45, 15, 10], warning: "source-lost" } },
    },
  },

  // ---- Q4 (step 26f): a centre snapped onto the top's corner, or a side's middle, follows it. ----
  {
    answer: "Q4",
    title: "new body: a circle's centre snapped to the top's corner follows it when the rectangle is made 60 × 30",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // The corner between line 2 (the right side, (40, 0) → (40, 30)) and
    // line 3 (the back) is corner 2 of the outline; the edit moves it to
    // (60, 30) keeping both lines, so the centre goes there: the cylinder's
    // middle is (60, 30, 20 + 10 / 2) = (60, 30, 25). The base is
    // 60 · 30 · 20 = 36000, its middle (30, 15, 10).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [30, 15, 10] }, "extrude-4": { centroid: [60, 30, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: a pinned corner moved by hand to (50, 40) takes the centre with it",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "move-corner", sketch: "sketch-1", corner: 2, to: [50, 40] }, "done")],
    // Corner 2 is the pinned one. The base (0, 0), (40, 0), (50, 40),
    // (0, 30): twice its area by the shoelace is 0 + 40·40 − 50·0 +
    // 50·30 − 0·40 + 0 = 3100, so 1550 · 20 = 31000. The cylinder's middle
    // is (50, 40, 25).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 31000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [50, 40, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: the first extrude made 35 long carries the pinned centre up with the top",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "set-distance", item: "extrude-2", value: 35 }, "done")],
    // The corner is still (40, 30) seen from above, now at z = 35: the
    // sketch's origin (0, 0, 35) and the cylinder 35 to 45, middle
    // (40, 30, 40). The base 40 · 30 · 35 = 42000, middle (20, 15, 17.5).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 35], side: 1 },
      bodies: { "extrude-2": 42000, "extrude-4": 250 * PI },
      solids: { "extrude-2": { centroid: [20, 15, 17.5] }, "extrude-4": { centroid: [40, 30, 40] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: the rectangle redrawn as a triangle loses the pinned corner: the centre stays, the sketch warns",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [40, 0], [0, 30]] }, "done")],
    // Three corners: a new outline with new lines (line 5 onwards), so no
    // corner sits between lines 2 and 3 any more. The centre stays at
    // (40, 30), the cylinder at (40, 30, 25), and the sketch, still on the
    // top (the cap keeps its name), says its point is lost; the cylinder's
    // sketch still makes an outline, so it has no warning. The triangle
    // 40 · 30 / 2 · 20 = 12000.
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "point-lost" },
      bodies: { "extrude-2": 12000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [40, 30, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: undo after losing the corner brings the pin back without a warning, through save and open",
    cuts: false,
    setup: PINNED,
    steps: [
      op({ op: "set-corners", sketch: "sketch-1", corners: [[0, 0], [40, 0], [0, 30]] }, "done"),
      op({ op: "undo" }, "done"),
      { kind: "save-open" },
      op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done"),
    ],
    // Back to the rectangle with lines 1 to 4, the pin finds its corner
    // again, and still follows it after the file is saved and opened:
    // (60, 30, 25) as in the first Q4 case.
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [60, 30, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: a centre snapped to the middle of the front edge stays in its middle when the rectangle is made 60 × 30",
    cuts: false,
    setup: { ...BEN, centre: [20, 0], pin: { at: "middle", line: "line-1" } },
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // Line 1 runs (0, 0) → (60, 0) now, its middle (30, 0): the cylinder's
    // middle (30, 0, 25).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [30, 0, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: a pinned circle moved by hand is pinned no longer, so the next edit leaves it where it was put",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "set-circle", sketch: "sketch-3", centre: [10, 10], radius: 5 }, "done"), op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // (10, 10) is free, so the 60 × 30 edit leaves it there: (10, 10, 25).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [10, 10, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: the corner moved while the first extrude is suppressed: on again, the centre is at the corner's new place",
    cuts: false,
    setup: PINNED,
    steps: [
      op({ op: "suppress", item: "extrude-2", on: true }, "done"),
      op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done"),
      op({ op: "suppress", item: "extrude-2", on: false }, "done"),
    ],
    // Pins are judged with nothing suppressed (as holds are), so the greyed
    // sketch's centre went with the corner to (60, 30): (60, 30, 25).
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 36000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [60, 30, 25] } },
    },
  },
  {
    answer: "Q4",
    title: "new body: the first extrude deleted loses the plane, which says it all: no point warning, the cylinder stays",
    cuts: false,
    setup: PINNED,
    steps: [op({ op: "delete", item: "extrude-2" }, "done")],
    // As Q1: plane lost, the cylinder held at (40, 30, 25) saying its source is lost.
    expect: {
      order: ["sketch-1", "sketch-3", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "plane-lost" },
      bodies: { "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [40, 30, 25], warning: "source-lost" } },
    },
  },
  {
    answer: "Q4",
    title: "a hole on the top's corner bites a quarter out, and follows the corner to 60 × 30",
    cuts: true,
    setup: PINNED,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // A circle of radius 5 round a right-angled corner has a quarter of it
    // inside: π · 5² / 4 · 10 = 62.5π removed, from 36000 after the edit.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 62.5 * PI }, bodies: { "extrude-2": 36000 - 62.5 * PI } },
  },
  // ---------------------------------------------------------- step 27 (rules 11 to 13)
  {
    answer: "R11",
    title: "new body: a centre snapped onto another body's corner follows that body's outline",
    cuts: false,
    from: "27c",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "set-circle", sketch: "sketch-3", centre: [0, 0], radius: 5, pin: { at: "corner", before: "line-6", after: "line-7", feature: "extrude-6", cap: "end" } }, "done"),
      op({ op: "move-corner", sketch: "sketch-5", corner: 2, to: [90, 20] }, "done"),
    ],
    // Corner 2 of the 60..80 × 0..10 rectangle, where line 6 ends and line 7
    // starts, is (80, 10); the top's frame is the world's (rule 8), so seen
    // straight down the centre lands on (80, 10), then goes with the corner to
    // (90, 20): the cylinder's middle 20 + 10 / 2 = 25 up, (90, 20, 25). The
    // moved outline (60, 0), (80, 0), (90, 20), (60, 10) has area
    // ½ |0 + 1600 − 300 − 600| = 350, so the second body is 350 · 5 = 1750.
    expect: {
      order: ORDER_27,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI, "extrude-6": 1750 },
      solids: { "extrude-4": { centroid: [90, 20, 25] } },
    },
  },
  {
    answer: "R11",
    title: "new body: a centre snapped onto its own body's bottom corner, then an upright's middle, seen from the top",
    cuts: false,
    from: "27c",
    setup: BEN,
    steps: [
      op({ op: "set-circle", sketch: "sketch-3", centre: [0, 0], radius: 5, pin: { at: "corner", before: "line-2", after: "line-3", feature: "extrude-2", cap: "start" } }, "done"),
      op({ op: "set-distance", item: "extrude-2", value: 35 }, "done"),
      op({ op: "set-circle", sketch: "sketch-3", centre: [0, 0], radius: 5, pin: { at: "upright", before: "line-1", after: "line-2", feature: "extrude-2" } }, "done"),
      op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done"),
    ],
    // The bottom's back right corner (40, 30, 0) seen down from the top is
    // (40, 30); the top goes to 35. Then the upright at corner 1 (after
    // line 1, before line 2) runs from (40, 0, 0) to (40, 0, 35): its middle
    // seen from the top is (40, 0), and the 60-wide rectangle takes it to
    // (60, 0). The cylinder: (60, 0, 35 + 5) = (60, 0, 40); the base
    // 60 · 30 · 35 = 63000.
    expect: {
      order: NEW,
      sketch: { id: "sketch-3", origin: [0, 0, 35], side: 1 },
      bodies: { "extrude-2": 63000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [60, 0, 40] } },
    },
  },
  {
    answer: "R11",
    title: "a hole snapped onto the back right upright bites a quarter out of the corner, and follows it to 60 × 30",
    cuts: true,
    from: "27c",
    setup: BEN,
    steps: [
      op({ op: "set-circle", sketch: "sketch-3", centre: [0, 0], radius: 5, pin: { at: "upright", before: "line-2", after: "line-3", feature: "extrude-2" } }, "done"),
      op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done"),
    ],
    // The upright at corner 2 is over (40, 30), then (60, 30): a quarter of
    // the circle inside the right-angled corner, π · 5² / 4 · 10 = 62.5π
    // removed from 60 · 30 · 20 = 36000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1 }, cut: { id: "cut-4", removed: 62.5 * PI }, bodies: { "extrude-2": 36000 - 62.5 * PI } },
  },
  {
    answer: "R12",
    title: "new body: another body's edge projected follows it, an upright projects to one point, and projecting it again adds nothing",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "upright", before: "line-5", after: "line-6" } }, "done"),
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "unchanged"),
      op({ op: "move-corner", sketch: "sketch-5", corner: 1, to: [85, 0] }, "done"),
    ],
    // Line 6 runs from corner 1 (80, 0) to corner 2 (80, 10); the top's edge
    // along it, seen straight down, is that segment (projection-9: the 9th
    // of the line counter, after lines 1 to 8). The upright at corner 1 runs
    // straight down the sketch's normal, so it is the point (80, 0)
    // (projection-10). Corner 1 moved to (85, 0) takes both: the edge from
    // (85, 0) to (80, 10), the point to (85, 0). The second body:
    // (60, 0), (85, 0), (80, 10), (60, 10), area ½ |0 + 850 + 200 − 600| = 225,
    // · 5 = 1125.
    expect: {
      order: ORDER_27,
      sketch: {
        id: "sketch-3",
        origin: [0, 0, 20],
        side: 1,
        projected: [
          { id: "projection-9", at: [[85, 0], [80, 10]] },
          { id: "projection-10", at: [[85, 0]] },
        ],
      },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI, "extrude-6": 1125 },
      solids: { "extrude-4": { centroid: [20, 15, 25] } },
    },
  },
  {
    answer: "R12",
    title: "new body: the other body's outline redrawn as a triangle loses the projected edge: it stays where it was, the sketch warns",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      op({ op: "set-corners", sketch: "sketch-5", corners: [[60, 0], [80, 0], [70, 10]] }, "done"),
    ],
    // Three corners is a new outline with new lines (10 to 12), so no edge
    // runs along line 6 any more: projection-9 is held at (80, 0) to
    // (80, 10) and named in the warning. The triangle: ½ · 20 · 10 = 100,
    // · 5 = 500. The circle and its cylinder are untouched.
    expect: {
      order: ORDER_27,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "projection-lost", projected: [{ id: "projection-9", at: [[80, 0], [80, 10]] }] },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI, "extrude-6": 500 },
      solids: { "extrude-4": { centroid: [20, 15, 25] } },
    },
  },
  {
    answer: "R12",
    title: "new body: undo after losing the projected edge finds it again, with no warning, through save and open",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      op({ op: "set-corners", sketch: "sketch-5", corners: [[60, 0], [80, 0], [70, 10]] }, "done"),
      { kind: "save-open" },
      op({ op: "undo" }, "done"),
      { kind: "save-open" },
    ],
    // Back to the rectangle with lines 5 to 8: line 6's edge is (80, 0) to (80, 10) again.
    expect: {
      order: ORDER_27,
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, projected: [{ id: "projection-9", at: [[80, 0], [80, 10]] }] },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI, "extrude-6": 1000 },
      solids: { "extrude-4": { centroid: [20, 15, 25] }, "extrude-6": { centroid: [70, 5, 2.5] } },
    },
  },
  {
    answer: "R13",
    title: "new body: deleting a body a projection names asks first; the sketch stays, its projection held",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      { kind: "plan", item: "extrude-6", want: { ask: true, removes: ["extrude-6"] } },
      op({ op: "delete", item: "extrude-6" }, "done"),
    ],
    // Only the projection is built on Extrude 6, so it asks, and takes
    // nothing else; the edge is gone, so projection-9 stays at (80, 0) to
    // (80, 10) with the warning. Sketch 5 stays (only its extrude went).
    expect: {
      order: ["sketch-1", "extrude-2", "sketch-5", "sketch-3", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "projection-lost", projected: [{ id: "projection-9", at: [[80, 0], [80, 10]] }] },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
    },
  },
  {
    answer: "R13",
    title: "new body: deleting the body a pinned centre is on asks first; the centre stays where it was, the sketch warns",
    cuts: false,
    from: "27c",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "set-circle", sketch: "sketch-3", centre: [0, 0], radius: 5, pin: { at: "middle", line: "line-5", feature: "extrude-6", cap: "end" } }, "done"),
      { kind: "plan", item: "extrude-6", want: { ask: true, removes: ["extrude-6"] } },
      op({ op: "delete", item: "extrude-6" }, "done"),
    ],
    // Line 5's middle, (60 + 80) / 2 = 70 along y = 0: (70, 0); held there
    // after the delete, so the cylinder is at (70, 0, 25).
    expect: {
      order: ["sketch-1", "extrude-2", "sketch-5", "sketch-3", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, warning: "point-lost" },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI },
      solids: { "extrude-4": { centroid: [70, 0, 25] } },
    },
  },
  {
    answer: "R13",
    title: "new body: suppressing the body a projection names greys the sketch and the cylinder built from it, with no warning",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      op({ op: "suppress", item: "extrude-6", on: true }, "done"),
    ],
    // Q3 through the projection: Extrude 6 off, Sketch 3 greyed by it, Extrude 4 by Sketch 3; only the base is built.
    expect: { order: ORDER_27, bodies: { "extrude-2": 24000 }, off: { "extrude-6": "suppressed", "sketch-3": "greyed", "extrude-4": "greyed" } },
  },
  {
    answer: "R13",
    title: "new body: a drag across a projection's link is refused either way, and allowed once the projection is removed",
    cuts: false,
    from: "27d",
    setup: BEN,
    steps: [
      ...OTHER_BODY,
      op({ op: "project", sketch: "sketch-3", edge: { feature: "extrude-6", at: "cap-edge", cap: "end", line: "line-6" } }, "done"),
      // Sketch 3 to place 2 would put it before Extrude 6 (at 4), which it projects from.
      op({ op: "reorder", item: "sketch-3", to: 2 }, "before-dependency"),
      // Extrude 6 to place 4 would put it after Sketch 3 (at 3), which projects from it.
      op({ op: "reorder", item: "extrude-6", to: 4 }, "after-dependent"),
      op({ op: "unproject", sketch: "sketch-3", projection: "projection-9" }, "done"),
      op({ op: "reorder", item: "sketch-3", to: 2 }, "done"),
    ],
    // With the projection gone Sketch 3 is built on Extrude 2 alone, so it may go straight after it.
    expect: {
      order: ["sketch-1", "extrude-2", "sketch-3", "sketch-5", "extrude-6", "extrude-4"],
      sketch: { id: "sketch-3", origin: [0, 0, 20], side: 1, projected: [] },
      bodies: { "extrude-2": 24000, "extrude-4": 250 * PI, "extrude-6": 1000 },
    },
  },
];
