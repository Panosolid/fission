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
//   (0, 0) lands, which way it faces, and any plane warning naming its
//   face), each solid's volume, each cut's removed volume or failure, and
//   every body's volume after its cuts;
// - saving and opening changes none of that.
// `FUSION_CASES` add the owner's own answers, hand-worked, on top: the
// subject must agree with the model and with the numbers written there.

import { seeded, type SeededRandom } from "./index.ts";
import { close } from "./timeline-session.ts";
import { polygonValid, type Point } from "./timeline-model.ts";
import {
  applyNaming,
  capKey,
  clearCut,
  createNamingModel,
  discInsidePolygon,
  discMeetsPolygon,
  planDelete,
  rebuildNaming,
  type Cap,
  type DeletePlan,
  type NamingApplied,
  type NamingDoc,
  type NamingFault,
  type NamingOp,
  type NamingRebuild,
  type NamingResult,
  type NamingWarning,
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

/** The owner's test part, before any edit: an outline on XY extruded, a circle on one of its caps, and a cut (or a new body) from it. */
export interface Setup {
  corners: Point[];
  distance: number;
  cap: Cap;
  centre: Point;
  radius: number;
  /** The cut's depth, or the new body's distance when the subject can't cut. */
  depth: number;
}

/** The setup as edits. The model's ids are fixed by its counter: sketch-1, extrude-2, sketch-3, then cut-4 or extrude-4. */
export function setupOps(s: Setup, cuts: boolean): NamingOp[] {
  return [
    { op: "add-sketch", corners: s.corners },
    { op: "add-extrude", sketch: "sketch-1", distance: s.distance },
    { op: "add-face-sketch", face: { feature: "extrude-2", role: s.cap }, centre: s.centre, radius: s.radius },
    cuts ? { op: "add-cut", sketch: "sketch-3", depth: s.depth } : { op: "add-face-extrude", sketch: "sketch-3", distance: s.depth },
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
const warnKey = (w: NamingWarning | undefined) => (w === undefined ? "none" : w.cause === "deleted-input" ? `${w.cause}:${w.input}` : `${w.cause}:${capKey(w.face)}`);

function resultDiff(id: string, want: NamingResult, got: NamingResult | undefined): string | null {
  if (got === undefined) return `${id}: missing`;
  if (got.kind !== want.kind) return `${id}: a ${got.kind}, not a ${want.kind}`;
  if (warnKey(got.warning as NamingWarning | undefined) !== warnKey(want.warning as NamingWarning | undefined))
    return `${id}: warning ${warnKey(got.warning as NamingWarning | undefined)}, want ${warnKey(want.warning as NamingWarning | undefined)}`;
  if (want.kind === "sketch" && got.kind === "sketch") {
    if (got.placement.normal !== want.placement.normal) return `${id}: faces ${got.placement.normal}, want ${want.placement.normal}`;
    if (!vecClose(got.placement.origin, want.placement.origin)) return `${id}: origin ${got.placement.origin}, want ${want.placement.origin}`;
  }
  if (want.kind === "solid" && got.kind === "solid" && !close(got.volume, want.volume)) return `${id}: volume ${got.volume}, want ${want.volume}`;
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
    w === undefined ? undefined : w.cause === "deleted-input" ? { cause: w.cause, input: to(w.input) } : { cause: w.cause, face: { feature: to(w.face.feature), role: w.face.role } };
  const results: Record<string, NamingResult> = {};
  for (const [id, res] of Object.entries(r.results)) {
    const w = warning((res as { warning?: NamingWarning }).warning);
    results[to(id)] = { ...res, ...(w ? { warning: w } : {}) } as NamingResult;
  }
  return { order: r.order.map(to), results, bodies: Object.fromEntries(Object.entries(r.bodies).map(([id, v]) => [to(id), v])) };
}

function renamedOp(op: NamingOp, to: (id: string) => string): NamingOp {
  const o = JSON.parse(JSON.stringify(op)) as Record<string, unknown>;
  for (const k of ["sketch", "item"]) if (typeof o[k] === "string") o[k] = to(o[k] as string);
  if (op.op === "add-face-sketch") o.face = { feature: to(op.face.feature), role: op.face.role };
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
    const c: Point = [tool.placement.origin[0] + tool.centre[0], tool.placement.origin[1] + tool.centre[1]];
    if (res?.kind === "cut" && res.status === "built") out.push(discInsidePolygon(c, tool.radius, corners) ? "cut:whole" : "cut:bite");
    else out.push(discMeetsPolygon(c, tool.radius, corners) ? "cut:no-target-height" : "cut:no-target-outside");
  }
  return out;
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
    }
    const first = await subject.read();
    const again = await subject.read();
    if (JSON.stringify(first) !== JSON.stringify(again)) throw fail("read twice", "two reads differ");
    const want = rebuildNaming(model.doc);
    last = renamed(first, mod);
    const d = namingDiff(want, last);
    if (d) throw fail("rebuild", d);
    for (const item of model.doc.items) {
      const res = want.results[item.id];
      if (item.kind === "face-sketch") count(counts, res.warning ? `sketch:${res.warning.cause}` : "sketch:followed");
      if (res.kind !== "sketch" && res.warning) count(counts, `${res.kind}:kept`);
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
  | { op: "reorder"; pick: number; to: number }
  | { op: "undo" }
  | { op: "redo" }
  | { op: "save-open" };

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
      return { op, pick: r.next() };
    case "reorder":
      return { op, pick: r.next(), to: r.next() };
    default:
      return { op };
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
      if (applyNaming(m, op).kind === "done" && !clearDoc(m.doc)) return null;
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
    case "reorder": {
      const item = pickOf(doc.items, step.pick);
      return item ? edit({ op: "reorder", item: item.id, to: Math.min(doc.items.length - 1, Math.floor(step.to * doc.items.length)) }) : null;
    }
    case "undo":
    case "redo":
      return edit({ op: step.op });
    case "save-open":
      return { kind: "save-open" };
  }
}

/** A random setup the model is sure of: a rectangle or triangle, a distance either way, either cap, and a circle clear of the outline (`clearCut`) that meets it or not. */
export function randomSetup(r: SeededRandom): Setup {
  for (;;) {
    const corners = randomOutline(r);
    const s: Setup = { corners, distance: nonZero(r, 40), cap: r.next() < 0.5 ? "end" : "start", centre: across(corners, [r.next(), r.next()]), radius: radiusOf(r), depth: int(r, 1, 45) };
    if (clearCut(s.centre, s.radius, corners)) return s;
  }
}

export interface NamingSession {
  setup: Setup;
  steps: RandomStep[];
}

export function randomNamingSession(seed: bigint, steps: number): NamingSession {
  const r = seeded(seed);
  const setup = randomSetup(r);
  return { setup, steps: Array.from({ length: steps }, () => randomStep(r)) };
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

/** Cuts a failing session to a 1-minimal list of steps failing the same check (no single step can be dropped). */
export async function shrinkNaming(make: () => NamingSubject, session: NamingSession): Promise<NamingSession> {
  const first = await namingFailureOf(make, session);
  if (first === null) return session;
  const same = async (steps: RandomStep[]) => (await namingFailureOf(make, { setup: session.setup, steps }))?.check === first.check;
  let cur = [...session.steps];
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
  sketch?: { id: string; origin: Vec3; normal: 1 | -1; warning?: "plane-lost" | "plane-ambiguous" };
  cut?: { id: string; removed: number } | { id: string; failed: true };
  bodies: Record<string, number>;
}

export interface FusionCase {
  /** Which of the owner's answers (docs/progress/cad.md, "Naming test plan (25a)") it encodes. */
  answer: number;
  title: string;
  /** Whether it needs a cut (booleans), or holds for a subject that makes the circle a new body. */
  cuts: boolean;
  setup: Setup;
  steps: NamingStep[];
  expect: Expect;
}

/** What differs between a read (model ids) and a case's hand-worked answer, or null. */
export function expectDiff(r: NamingRebuild, e: Expect): string | null {
  if (r.order.join() !== e.order.join()) return `order [${r.order}], want [${e.order}]`;
  if (e.sketch) {
    const s = r.results[e.sketch.id];
    if (s?.kind !== "sketch") return `${e.sketch.id} is not a sketch`;
    if (s.placement.normal !== e.sketch.normal) return `${e.sketch.id} faces ${s.placement.normal}, want ${e.sketch.normal}`;
    if (!vecClose(s.placement.origin, e.sketch.origin)) return `${e.sketch.id} at ${s.placement.origin}, want ${e.sketch.origin}`;
    const w = s.warning?.cause;
    if (w !== e.sketch.warning) return `${e.sketch.id} warning ${w ?? "none"}, want ${e.sketch.warning ?? "none"}`;
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
const PI = Math.PI;

const op = (o: NamingOp, want?: NamingApplied["kind"] | RefuseCause): NamingStep => ({ kind: "op", op: o, ...(want ? { want } : {}) });
const FULL = ["sketch-1", "extrude-2", "sketch-3", "cut-4"];

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
    answer: 1,
    title: "the rectangle made 60 × 30: the hole stays on the top face and stays put",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // The sketch's frame is the world's: its (0, 0) stays over the origin, at
    // the top's height 20, so the circle is still at (20, 15), wholly inside
    // the wider rectangle: 250π removed from 60 · 30 · 20 = 36000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 36000 - 250 * PI } },
  },
  {
    answer: 2,
    title: "the first extrude flipped downward: the cut finds no target body and the body stays",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: -20 }, "done")],
    // The body is now z from −20 to 0 and its end cap is the bottom, at −20.
    // The sketch follows the end cap down but keeps facing +Z, the side it
    // was drawn from, so the cut goes from −20 down to −30: it only touches
    // the body's bottom, no height in common, "no target body". The body is
    // whole: 40 · 30 · 20 = 24000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, -20], normal: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 24000 } },
  },
  {
    answer: 3,
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
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", removed: 125 * PI }, bodies: { "extrude-2": 12000 - 125 * PI } },
  },
  {
    answer: 4,
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
    expect: { order: ["sketch-1", "sketch-3"], sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1, warning: "plane-lost" }, bodies: {} },
  },
  {
    answer: 4,
    title: "undo after deleting the first extrude brings back the body, the hole and the sketch's plane",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "delete", item: "extrude-2" }, "done"), op({ op: "undo" }, "done"), { kind: "save-open" }],
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 24000 - 250 * PI } },
  },
  {
    answer: 5,
    title: "the first extrude made 35 long: the hole's sketch moves up with the top face",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: 35 }, "done")],
    // The top is at 35; the cut goes 35 down to 25, all inside: 250π removed
    // from 40 · 30 · 35 = 42000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 35], normal: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 42000 - 250 * PI } },
  },
  {
    answer: 6,
    title: "the outline made 10 × 30 so the hole falls outside: no target body, the body stays",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 10, 30) }, "done")],
    // The circle spans x 15 to 25, all past x = 10: no area in common.
    // The body: 10 · 30 · 20 = 6000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 6000 } },
  },
  {
    answer: 6,
    title: "nasty: the outline's side exactly tangent to the hole (15 × 30): touching only, no target body",
    cuts: true,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 15, 30) }, "done")],
    // The side x = 15 is exactly r = 5 from the centre (20, 15): the circle
    // touches it at one point, decided in whole numbers: the side (15, 0) to
    // (15, 30) has cross((0, 30), (5, 15))² = 150² = 22500 = r² · |side|² =
    // 25 · 900, not less, so no area; no tolerance is involved. The body: 15 · 30 · 20 = 9000.
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", failed: true }, bodies: { "extrude-2": 9000 } },
  },
  {
    answer: 6,
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
      sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 },
      cut: { id: "cut-4", removed: (25 * Math.acos(0.8) - 12) * 10 },
      bodies: { "extrude-2": 9600 - (25 * Math.acos(0.8) - 12) * 10 },
    },
  },
  {
    answer: 7,
    title: "every drag in the four-item chain is refused, and dragging an item to its own place changes nothing",
    cuts: true,
    setup: BEN,
    steps: chainDrags("cut-4"),
    expect: { order: FULL, sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, cut: { id: "cut-4", removed: 250 * PI }, bodies: { "extrude-2": 24000 - 250 * PI } },
  },
  // ---- the same part with the circle extruded 10 up as a new body (step 26, before booleans)
  {
    answer: 1,
    title: "new body: the rectangle made 60 × 30, the circle's body stays put on the top",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-corners", sketch: "sketch-1", corners: rect(0, 0, 60, 30) }, "done")],
    // A cylinder of radius 5 and height 10: 250π; the base 36000.
    expect: { order: ["sketch-1", "extrude-2", "sketch-3", "extrude-4"], sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, bodies: { "extrude-2": 36000, "extrude-4": 250 * PI } },
  },
  {
    answer: 2,
    title: "new body: the first extrude flipped, the sketch follows the end cap down and still faces up",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: -20 }, "done")],
    // The sketch at z = −20 facing +Z; its body goes up from −20 to −10,
    // inside the base (bodies may overlap until booleans join them).
    expect: { order: ["sketch-1", "extrude-2", "sketch-3", "extrude-4"], sketch: { id: "sketch-3", origin: [0, 0, -20], normal: 1 }, bodies: { "extrude-2": 24000, "extrude-4": 250 * PI } },
  },
  {
    answer: 4,
    title: "new body: the first extrude deleted asks first, and only it goes; the sketch stays with its plane lost and its body is built there",
    cuts: false,
    setup: BEN,
    steps: [{ kind: "plan", item: "extrude-2", want: { ask: true, removes: ["extrude-2"] } }, op({ op: "delete", item: "extrude-2" }, "done")],
    // The model's rule, extended from answer 4 (a question for the owner
    // before step 26): only cuts into its body go with it; the new body is
    // built from the sketch held at z = 20.
    expect: { order: ["sketch-1", "sketch-3", "extrude-4"], sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1, warning: "plane-lost" }, bodies: { "extrude-4": 250 * PI } },
  },
  {
    answer: 5,
    title: "new body: the first extrude made 35 long, the sketch moves up with the top",
    cuts: false,
    setup: BEN,
    steps: [op({ op: "set-distance", item: "extrude-2", value: 35 }, "done")],
    expect: { order: ["sketch-1", "extrude-2", "sketch-3", "extrude-4"], sketch: { id: "sketch-3", origin: [0, 0, 35], normal: 1 }, bodies: { "extrude-2": 42000, "extrude-4": 250 * PI } },
  },
  {
    answer: 7,
    title: "new body: every drag in the chain is refused",
    cuts: false,
    setup: BEN,
    steps: chainDrags("extrude-4"),
    expect: { order: ["sketch-1", "extrude-2", "sketch-3", "extrude-4"], sketch: { id: "sketch-3", origin: [0, 0, 20], normal: 1 }, bodies: { "extrude-2": 24000, "extrude-4": 250 * PI } },
  },
];
