// Random edit/undo/redo sessions on the one history (step 20a), on a real
// project: Design's real part document, captured with projectToJson and put
// back with projectFromJson and Design's own reader, as the shell does. Each
// step is checked against a simple model of the rules kept as two stacks
// (what undo would put back, what redo would), written independently of the
// history's one-list-and-a-pointer code. Seeded: the same seed gives the
// same session.
//
// The part has a sketch (step 21b): its edits (draw a line, draw a circle
// (22b), draw an arc (23a), delete a curve, move a point) are steps of
// their own. The model keeps the sketch as its lines' end coordinates, its
// circles' centre coordinates and radii and its arcs' start, end and
// centre coordinates only, no point ids: every point is at its own place
// (new points never land on a used one), so a coordinate names a point,
// and moving one moves every line end, circle centre and arc point there.
//
// Extruding the sketch (step 21d) puts "Extrude n" in at the marker as one
// step; its typed distance merges like a size. A width typed while the
// part is an extrude puts a new box in at the marker, with a new id.
//
// The timeline edits (step 24e3) are steps of their own, named as the app
// names them: delete an item (the marker on it moving to the one before,
// or the start; a deleted sketch's extrude stays and builds nothing, as
// this test has no kernel to keep its shape), move an item (refused before
// what it is built from or after what is built from it, recording
// nothing), suppress or unsuppress one, and move the rollback marker. The
// model keeps the timeline as items in order (a box and its width, the
// sketch, an extrude and its sketch and distance, each suppressed or not)
// and the marker, and works out the part (the last solid item that builds)
// itself, by the rules written in its own words below. An edit the model
// says leaves nothing built (which this Fission can't open yet) must leave
// Design's `lastFeature` with nothing either; it is then not made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, emptyProject, projectFromJson, projectToJson, type Feature, type Project } from "@fission/core";
import {
  addSketch,
  curvePoints,
  deleteCurve,
  deleteItem,
  designWorkspace,
  DISTANCE_STEP,
  drawArc,
  drawCircle,
  drawLine,
  extrudeSketch,
  extrudeStep,
  isSketchExtrude,
  isSketchItem,
  itemName,
  lastFeature,
  moveMarker,
  movePoint,
  partDocument,
  reorderItem,
  setExtrudeDistance,
  shapeOf,
  SKETCH_STEPS,
  suppressItem,
  TIMELINE_STEPS,
  withPart,
  type DesignDocument,
} from "@fission/design";
import { seeded, type SeededRandom } from "../src/index.ts";

const SEEDS = [0x5eedn, 1n, 2n, 3n, 0xdeadbeefn];
const LIMIT = 8; // small, so the oldest steps are dropped often
const MERGE = 1000;
const KEYS = ["width", "depth", undefined] as const;

const pick = <T>(r: SeededRandom, xs: readonly T[]): T => xs[Math.floor(r.next() * xs.length)];
/** A fresh project: a w × 30 × 20 box and an empty Sketch 1. */
const projectWith = (w: number): Project => ({ ...emptyProject(), workspaces: { design: addSketch(partDocument("box", w, 30, 20)).doc } });
const designOf = (p: Project) => p.workspaces.design as DesignDocument;
/** The same project with the part's width changed (a box in place; after an extrude, a new box), its sketch kept. */
const withWidth = (p: Project, w: number): Project => ({ ...p, workspaces: { design: withPart(designOf(p), "box", w, 30, 20) } });

/**
 * A sketch curve by its places: a line as [id, x1, y1, x2, y2], a circle
 * as [id, cx, cy, r], an arc as [id, sx, sy, ex, ey, cx, cy].
 */
type Line = [string, number, number, number, number] | [string, number, number, number] | [string, number, number, number, number, number, number];
/** The places a curve's points are at: a line's two ends, a circle's centre, an arc's start, end and centre. */
const placesOf = (c: Line): string[] => (c.length === 4 ? [`${c[1]},${c[2]}`] : Array.from({ length: (c.length - 1) / 2 }, (_, k) => `${c[1 + 2 * k]},${c[2 + 2 * k]}`));

/** A timeline item as the model keeps it. */
type Item = { id: string; kind: "box"; size: number; off: boolean } | { id: string; kind: "sketch"; off: boolean } | { id: string; kind: "extrude"; sketch: string; size: number; off: boolean };

/**
 * The model's state: the timeline's items in order, the marker ("start",
 * an item's id, or null for everything built), the sketch's id (null once
 * deleted) and its curves in drawing order, and the part, which the model
 * works out (`partOf`) and the project's is read by Design's lastFeature.
 * As text, so states compare with ===.
 */
interface Model {
  items: Item[];
  marker: string | null;
  sketch: string | null;
  lines: Line[];
}
const state = (m: Model) => JSON.stringify({ part: partOf(m), ...m });
const parse = (s: string): Model => {
  const { part: _, ...m } = JSON.parse(s);
  return m;
};

// ---- The model's timeline rules, written from the owner's rules (docs/progress/cad.md, 24d1 and 24e), not from Design's code.

/** Whether an item builds: not suppressed, not after the marker, and an extrude's sketch there and building. */
function buildsIn(m: Model, item: Item): boolean {
  const at = m.items.indexOf(item);
  if (item.off || m.marker === "start") return false;
  if (m.marker !== null && at > m.items.findIndex((i) => i.id === m.marker)) return false;
  if (item.kind !== "extrude") return true;
  const sketch = m.items.find((i) => i.id === item.sketch);
  return sketch !== undefined && buildsIn(m, sketch);
}
/** The part: the last solid item (not a sketch) that builds; null when none does. */
function partOf(m: Model): string | null {
  return [...m.items].reverse().find((i) => i.kind !== "sketch" && buildsIn(m, i))?.id ?? null;
}
const partItem = (m: Model) => m.items.find((i) => i.id === partOf(m))!;
/** Where a new item goes in: just after the marker, first at the start, else last; the marker, if there is one, moves onto it. */
function insert(m: Model, item: Item): Model {
  const items = [...m.items];
  const at = m.marker === null ? items.length : m.marker === "start" ? 0 : items.findIndex((i) => i.id === m.marker) + 1;
  items.splice(at, 0, item);
  return { ...m, items, marker: m.marker === null ? null : item.id };
}
const clone = (m: Model): Model => JSON.parse(JSON.stringify(m));

/** The project's state, read the same way: what the model must match. */
function stateOf(p: Project): string {
  const doc = designOf(p);
  // No kernel here, so no shape is ever kept (that needs the kernel's outline: settleKept, tested in packages/testing's timeline sessions).
  assert.equal(doc.kept, undefined, "a kept shape with no kernel to keep it");
  const items = doc.timeline.features.map((f): Item => {
    if (isSketchItem(f)) return { id: f.id, kind: "sketch", off: f.suppressed };
    if (isSketchExtrude(f)) return { id: f.id, kind: "extrude", sketch: f.intent.parameters.sketch as string, size: f.intent.parameters.distance as number, off: f.suppressed };
    const { shape, sizes } = shapeOf(doc, f);
    assert.equal(shape, "box", `${f.id} is a ${shape}`);
    return { id: f.id, kind: "box", size: sizes.width, off: f.suppressed };
  });
  assert.ok(doc.sketches.length <= 1, "more than one sketch");
  const sketch = doc.sketches[0];
  const lines = !sketch
    ? []
    : (() => {
        const at = new Map(sketch.points.map((q) => [q.id, [q.x, q.y]]));
        // No point is left that no curve uses, and no two points share a place.
        const ends = new Set(sketch.curves.flatMap(curvePoints));
        assert.deepEqual(new Set(sketch.points.map((q) => q.id)), ends, "a point no curve uses");
        assert.equal(new Set(sketch.points.map((q) => `${q.x},${q.y}`)).size, sketch.points.length, "two points at one place");
        return sketch.curves.map(
          (c): Line => (c.kind === "line" ? [c.id, ...at.get(c.start)!, ...at.get(c.end)!] : c.kind === "circle" ? [c.id, ...at.get(c.centre)!, c.radius] : [c.id, ...at.get(c.start)!, ...at.get(c.end)!, ...at.get(c.centre)!]) as Line,
        );
      })();
  return JSON.stringify({ part: lastFeature(doc).id, items, marker: doc.timeline.marker ?? null, sketch: sketch?.id ?? null, lines });
}

interface Undo {
  before: string;
  label: string;
  key: string | undefined;
  at: number;
}

function session(seed: bigint, steps: number) {
  const r = seeded(seed);
  let project = projectWith(40);
  let t = 0;
  let failRestore = false;
  const h = createHistory({
    capture: () => projectToJson(project),
    restore: (text) => {
      if (failRestore) throw new Error("restore failed");
      project = projectFromJson(text, [designWorkspace]);
      // The remounted workspace reports a change: never a step. It can tell it is a restore.
      assert.equal(h.restoring(), true);
      assert.equal(h.record("remount", "width"), false);
    },
    limit: LIMIT,
    mergeMs: MERGE,
    now: () => t,
  });

  /** The model of a fresh project: the box feature-1 and the sketch the project's addSketch made. */
  const fresh = (w: number): Model => {
    const id = designOf(project).sketches[0].id;
    return { items: [{ id: "feature-1", kind: "box", size: w, off: false }, { id, kind: "sketch", off: false }], marker: null, sketch: id, lines: [] };
  };
  // The model.
  let present = state(fresh(40));
  let undos: Undo[] = [];
  let redos: { after: string; label: string }[] = [];
  let lastWasRecord = false;
  const now = () => parse(present);
  /** Every id in a state undo can go back to: an item's or a curve's. */
  const usedIds = () => new Set([present, ...undos.map((u) => u.before)].flatMap((s) => [...parse(s).items.map((i) => i.id), ...parse(s).lines.map(([id]) => id)]));
  /** A new id: in no state undo can go back to. */
  const isNew = (id: string, at: string) => assert.ok(!usedIds().has(id), `${at}: ${id} was used before`);
  /** A box width to go back to: the part's when it is a box, else a new one. */
  const boxWidth = (s: string) => {
    const part = partItem(parse(s));
    return part.kind === "box" ? part.size : 1 + Math.floor(r.next() * 20);
  };
  /**
   * The model after the part got width `w`: the same box when the part is
   * one, else a new box (its id read from the project, checked new) put in
   * at the marker.
   */
  const boxPart = (m: Model, w: number, at: string): Model => {
    const part = partItem(m);
    if (part.kind === "box") return { ...m, items: m.items.map((i) => (i === part ? { ...part, size: w } : i)) };
    const made = lastFeature(designOf(project)).id;
    isNew(made, at);
    return insert(m, { id: made, kind: "box", size: w, off: false });
  };
  /** A place no point of the sketch is at, on a 0.1 mm grid. */
  const freePlace = (): [number, number] => {
    const used = new Set(now().lines.flatMap(placesOf));
    for (;;) {
      const xy: [number, number] = [Math.floor(r.next() * 1001 - 500) / 10, Math.floor(r.next() * 1001 - 500) / 10];
      if (!used.has(`${xy[0]},${xy[1]}`)) return xy;
    }
  };
  /** Records a step that is never merged, in the model too. */
  const recordStep = (label: string, after: Model, at: string) => {
    assert.equal(h.record(label), true, at);
    redos = [];
    undos.push({ before: present, label, key: undefined, at: t });
    if (undos.length > LIMIT) {
      undos.shift();
      counts.dropped++;
    }
    present = state(after);
    lastWasRecord = true;
  };
  /** After every step: the project is the model's, and so is what undo and redo would do. */
  const check = (at: string) => {
    assert.equal(stateOf(project), present, at);
    assert.equal(h.canUndo(), undos.length > 0, at);
    assert.equal(h.canRedo(), redos.length > 0, at);
    assert.equal(h.undoLabel(), undos.length ? undos[undos.length - 1].label : null, at);
    assert.equal(h.redoLabel(), redos.length ? redos[redos.length - 1].label : null, at);
  };
  const counts = {
    draws: 0, chained: 0, circles: 0, centred: 0, arcs: 0, arcsChained: 0, deletes: 0, moves: 0, extrudes: 0, extrudesRefused: 0, sketchesAdded: 0, distances: 0, edits: 0, merged: 0, foldedAway: 0, same: 0, dropped: 0, undos: 0, redos: 0, empty: 0, failed: 0, nasty: 0, resets: 0, walks: 0, amends: 0, amendedAway: 0, steps: 0, stepsFailed: 0, stepsEmpty: 0,
    // Step 24e3: the timeline edits.
    itemsDeleted: 0, sketchDeleted: 0, markerMovedBack: 0, reorders: 0, reorderedInPlace: 0, refusedBefore: 0, refusedAfter: 0, suppressed: 0, unsuppressed: 0, markers: 0, markersSame: 0, nothingBuilt: 0, partNotLast: 0,
  };

  for (let i = 0; i < steps; i++) {
    const at = `seed ${seed} step ${i}`;
    t += Math.floor(r.next() * 2 * MERGE);
    const n = r.next();
    if (n < 0.06) {
      // One labelled step with several changes inside (an ownership
      // hand-over, an accepted AI command, step 20c): 1–3 recorded edits,
      // sometimes back to where it started, sometimes failing part way.
      const label = pick(r, ["Hand Width to Laser", "AI: resize"]);
      const inner = 1 + Math.floor(r.next() * 3);
      const widths = Array.from({ length: inner }, () => 1 + Math.floor(r.next() * 20));
      const part = partItem(now());
      if (r.next() < 0.2 && part.kind === "box") widths.push(part.size); // ends where it began
      const fails = r.next() < 0.2;
      const run = () => {
        for (const [j, w] of widths.entries()) {
          project = withWidth(project, w);
          assert.equal(h.record(`inner ${j}`, pick(r, KEYS)), false, `${at}: folded into the step`);
          if (fails && j === widths.length - 1) throw new Error("command refused");
        }
      };
      if (fails) {
        assert.throws(() => h.step(label, run), /command refused/, at);
        counts.stepsFailed++; // put back, nothing recorded, the model is unchanged
      } else {
        h.step(label, run);
        const after = state(boxPart(now(), widths[widths.length - 1], at));
        if (after === present) counts.stepsEmpty++; // nothing recorded, the redo kept
        else {
          redos = [];
          undos.push({ before: present, label, key: undefined, at: t });
          if (undos.length > LIMIT) {
            undos.shift();
            counts.dropped++;
          }
          present = after;
          lastWasRecord = false; // a step never merges with what follows
          counts.steps++;
        }
      }
    } else if (n < 0.18) {
      // A sketch edit, one undo step each, never merged: draw a line (from a
      // new place or chained from a point), draw a circle (round a new place
      // or a point already there), draw an arc (from a new place or a point
      // already there, to a new place, round a new place: the kernel judges
      // whether the centre is midway, which this test doesn't), delete a
      // curve, move a point, or extrude the sketch (open or not: the kernel
      // judges the outline when it builds, which this test doesn't; refused
      // when the sketch is after the marker). With the sketch deleted, a new
      // one is made first, as its own step.
      const m = now();
      const doc = designOf(project);
      if (m.sketch === null) {
        const made = addSketch(doc);
        isNew(made.id, at);
        project = { ...project, workspaces: { design: made.doc } };
        recordStep(SKETCH_STEPS.create, { ...insert(m, { id: made.id, kind: "sketch", off: false }), sketch: made.id, lines: [] }, at);
        counts.sketchesAdded++;
      } else {
        const sketch = doc.sketches[0];
        const { lines } = m;
        // An extrude is refused while the sketch is after the marker: tried more often then, so that path is reached.
        const late = m.marker !== null && m.items.findIndex((x) => x.id === m.sketch) > (m.marker === "start" ? -1 : m.items.findIndex((x) => x.id === m.marker));
        const kind = late && r.next() < 0.6 ? "extrude" : lines.length === 0 ? pick(r, ["draw", "circle", "arc"] as const) : pick(r, ["draw", "draw", "circle", "arc", "delete", "move", "extrude"] as const);
        let after: Model;
        let label: string = kind === "extrude" ? extrudeStep(doc, sketch.id) : SKETCH_STEPS[kind];
        if (kind === "draw") {
          const chain = sketch.points.length > 0 && r.next() < 0.5;
          const start = chain ? pick(r, sketch.points) : null;
          const from = start ? start.id : freePlace();
          const fromXY = start ? [start.x, start.y] : (from as [number, number]);
          const others = sketch.points.filter((q) => q !== start);
          const end = others.length > 0 && r.next() < 0.2 ? pick(r, others) : null;
          const to = end ? end.id : freePlace();
          const toXY = end ? [end.x, end.y] : (to as [number, number]);
          const drawn = drawLine(doc, sketch.id, from, to);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = { ...m, lines: [...lines, [drawn.id, fromXY[0], fromXY[1], toXY[0], toXY[1]]] };
          counts.draws++;
          if (chain) counts.chained++;
        } else if (kind === "circle") {
          const shared = sketch.points.length > 0 && r.next() < 0.3 ? pick(r, sketch.points) : null;
          const centre = shared ? shared.id : freePlace();
          const [cx, cy] = shared ? [shared.x, shared.y] : (centre as [number, number]);
          const radius = (1 + Math.floor(r.next() * 200)) / 10;
          const drawn = drawCircle(doc, sketch.id, centre, radius);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = { ...m, lines: [...lines, [drawn.id, cx, cy, radius]] };
          counts.circles++;
          if (shared) counts.centred++;
        } else if (kind === "arc") {
          const shared = sketch.points.length > 0 && r.next() < 0.4 ? pick(r, sketch.points) : null;
          const start = shared ? shared.id : freePlace();
          const startXY = shared ? [shared.x, shared.y] : (start as [number, number]);
          let end = freePlace();
          let centre = freePlace();
          while (centre[0] === end[0] && centre[1] === end[1]) centre = freePlace();
          while (!shared && ((end[0] === startXY[0] && end[1] === startXY[1]) || (centre[0] === startXY[0] && centre[1] === startXY[1]))) [end, centre] = [freePlace(), freePlace()];
          const drawn = drawArc(doc, sketch.id, start, end, centre);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = { ...m, lines: [...lines, [drawn.id, startXY[0], startXY[1], end[0], end[1], centre[0], centre[1]]] };
          counts.arcs++;
          if (shared) counts.arcsChained++;
        } else if (kind === "delete") {
          const [gone] = pick(r, lines);
          project = { ...project, workspaces: { design: deleteCurve(doc, sketch.id, gone) } };
          after = { ...m, lines: lines.filter(([id]) => id !== gone) };
          counts.deletes++;
        } else if (kind === "extrude") {
          const d = 1 + Math.floor(r.next() * 20);
          // The sketch must come before where the extrude goes in (at the marker).
          const place = m.marker === null ? m.items.length : m.marker === "start" ? 0 : m.items.findIndex((x) => x.id === m.marker) + 1;
          if (m.items.findIndex((x) => x.id === m.sketch) >= place) {
            assert.throws(() => extrudeSketch(doc, sketch.id, d), /comes after the rollback marker/, at);
            counts.extrudesRefused++;
            check(at);
            continue;
          }
          const extruded = extrudeSketch(doc, sketch.id, d);
          isNew(extruded.id, at);
          project = { ...project, workspaces: { design: extruded.doc } };
          after = insert(m, { id: extruded.id, kind: "extrude", sketch: sketch.id, size: d, off: false });
          counts.extrudes++;
        } else {
          const p = pick(r, sketch.points);
          const [x, y] = freePlace();
          project = { ...project, workspaces: { design: movePoint(doc, sketch.id, p.id, x, y) } };
          const move = (a: number, b: number) => (a === p.x && b === p.y ? [x, y] : [a, b]);
          after = { ...m, lines: lines.map((c) => (c.length === 4 ? [c[0], ...move(c[1], c[2]), c[3]] : [c[0], ...Array.from({ length: (c.length - 1) / 2 }, (_, k) => move(c[1 + 2 * k] as number, c[2 + 2 * k] as number)).flat()]) as Line) };
          counts.moves++;
        }
        recordStep(label, after, at);
      }
    } else if (n < 0.3) {
      // A timeline edit (24e3), one undo step each, named as the app names
      // it. The model's answer first; then Design's.
      const m = now();
      const doc = designOf(project);
      const edit = pick(r, ["delete", "reorder", "reorder", "reorder", "suppress", "marker"] as const);
      // Mostly any item; sometimes the one each edit's rarer paths need: the item the marker is on (a delete moves the
      // marker back), an extrude or a sketch (a reorder can be refused), a suppressed item (unsuppress).
      const linked = m.items.filter((x) => x.kind === "extrude" || m.items.some((y) => y.kind === "extrude" && y.sketch === x.id));
      const wanted = { delete: m.items.filter((x) => x.id === m.marker), reorder: linked, suppress: m.items.filter((x) => x.off), marker: [] }[edit];
      const item = wanted.length > 0 && r.next() < 0.6 ? pick(r, wanted) : pick(r, m.items);
      const feature = doc.timeline.features.find((f) => f.id === item.id) as Feature;
      const name = itemName(feature);
      let after: Model;
      let next: DesignDocument;
      let label: string;
      if (edit === "delete") {
        // Only that item goes; the marker on it moves to the one before, or the start; the sketch's curves go with it.
        const k = m.items.indexOf(item);
        after = { ...clone(m), items: m.items.filter((x) => x !== item) };
        if (m.marker === item.id) after.marker = k === 0 ? "start" : m.items[k - 1].id;
        if (item.kind === "sketch") Object.assign(after, { sketch: null, lines: [] });
        next = deleteItem(doc, item.id);
        label = TIMELINE_STEPS.delete(name);
      } else if (edit === "reorder") {
        // To place `to` of the new order. Refused when the item would come before the item it is built from, or after one built from it.
        // The two ends are where refusals are: an extrude first comes before its sketch, a used sketch last after its extrude.
        const to = r.next() < 0.4 ? (item.kind === "extrude" ? 0 : m.items.length - 1) : Math.floor(r.next() * m.items.length);
        const items = m.items.filter((x) => x !== item);
        items.splice(to, 0, item);
        const place = (id: string) => items.findIndex((x) => x.id === id);
        const before = item.kind === "extrude" && place(item.sketch) > to;
        const afterUser = items.some((x, j) => j < to && x.kind === "extrude" && x.sketch === item.id);
        const got = reorderItem(doc, item.id, to);
        if (before || afterUser) {
          assert.ok("refused" in got, `${at}: moving ${item.id} to ${to} was not refused`);
          assert.equal(got.refused, before ? "before-dependency" : "after-dependent", at);
          // Nothing changed, so nothing to record.
          assert.equal(h.record("refused"), false, at);
          counts[before ? "refusedBefore" : "refusedAfter"]++;
          check(at);
          continue;
        }
        assert.ok("doc" in got, `${at}: moving ${item.id} to ${to} was refused (${"message" in got ? got.message : ""})`);
        after = { ...m, items };
        next = got.doc;
        label = TIMELINE_STEPS.reorder(name);
        counts[m.items.indexOf(item) === to ? "reorderedInPlace" : "reorders"]++;
      } else if (edit === "suppress") {
        const on = !item.off;
        after = { ...m, items: m.items.map((x) => (x === item ? { ...x, off: on } : x)) };
        next = suppressItem(doc, item.id, on);
        label = (on ? TIMELINE_STEPS.suppress : TIMELINE_STEPS.unsuppress)(name);
      } else {
        const to = r.next() < 0.2 ? "start" : r.next() < 0.3 ? null : item.id;
        after = { ...m, marker: to };
        next = moveMarker(doc, to);
        label = TIMELINE_STEPS.marker;
      }
      if (partOf(after) === null) {
        // Nothing would build, which this Fission can't open: Design must agree, and the edit isn't made.
        assert.throws(() => lastFeature(next), /builds no body|has no part/, `${at}: the model says ${edit} of ${item.id} leaves nothing built`);
        counts.nothingBuilt++;
        check(at);
        continue;
      }
      project = { ...project, workspaces: { design: next } };
      if (state(after) === present) {
        // At its own place, or the marker where it was: the same document, no step.
        assert.equal(h.record(label), false, at);
        if (edit === "marker") counts.markersSame++;
      } else {
        recordStep(label, after, at);
        if (edit === "delete") {
          counts.itemsDeleted++;
          if (item.kind === "sketch") counts.sketchDeleted++;
          if (m.marker === item.id) counts.markerMovedBack++;
        } else if (edit === "suppress") counts[item.off ? "unsuppressed" : "suppressed"]++;
        else if (edit === "marker") counts.markers++;
      }
      // The part isn't always the last item: the marker or a suppression can leave later items out.
      if (partOf(after) !== after.items.filter((x) => x.kind !== "sketch").at(-1)?.id) counts.partNotLast++;
    } else if (n < 0.58) {
      // An edit: mostly a new width, sometimes the same, sometimes back to
      // the one before; on an extrude, half the time a typed distance (the
      // height box, merged like the sizes), else a width (a new box).
      const m = now();
      const part = partItem(m);
      const extrude = part.kind === "extrude" && r.next() < 0.5 ? part : null;
      const key = extrude ? "height" : pick(r, KEYS);
      const label = extrude ? DISTANCE_STEP : key ? `Change ${key}` : "Change shape";
      let next: string;
      if (extrude) {
        const d = r.next() < 0.1 ? extrude.size : 1 + Math.floor(r.next() * 20);
        project = { ...project, workspaces: { design: setExtrudeDistance(designOf(project), d) } };
        next = state({ ...m, items: m.items.map((x) => (x === extrude ? { ...extrude, size: d } : x)) });
        counts.distances++;
      } else {
        const w = r.next() < 0.1 ? boxWidth(present) : r.next() < 0.3 && undos.length ? boxWidth(undos[undos.length - 1].before) : 1 + Math.floor(r.next() * 20);
        project = withWidth(project, w);
        next = state(boxPart(m, w, at));
      }
      const recorded = h.record(label, key);
      if (next === present) {
        assert.equal(recorded, false, at);
        counts.same++;
      } else {
        assert.equal(recorded, true, at);
        redos = [];
        const top = undos[undos.length - 1];
        if (lastWasRecord && top && key !== undefined && top.key === key && t - top.at < MERGE) {
          if (next === top.before) {
            undos.pop();
            lastWasRecord = false;
            counts.foldedAway++;
          } else {
            Object.assign(top, { label, at: t });
            counts.merged++;
          }
        } else {
          undos.push({ before: present, label, key, at: t });
          if (undos.length > LIMIT) {
            undos.shift();
            counts.dropped++;
          }
          lastWasRecord = true;
          counts.edits++;
        }
        present = next;
      }
    } else if (n < 0.62) {
      // A change nobody made (a workspace filling in a default when first
      // shown): taken into the present, not a step; back to the state before
      // the present step, that step goes. The redo stays. A default fills in
      // a size, never adds a feature: on an extrude it is the distance (a box
      // there would take a new id the redo's older counter could hand out
      // again, which no workspace's default ever does).
      const m = now();
      const part = partItem(m);
      const before = undos.length ? partItem(parse(undos[undos.length - 1].before)) : null;
      const back = r.next() < 0.3 && before?.kind === part.kind && before.id === part.id ? before.size : null;
      const value = r.next() < 0.1 ? part.size : (back ?? 1 + Math.floor(r.next() * 20));
      if (part.kind === "extrude") project = { ...project, workspaces: { design: setExtrudeDistance(designOf(project), value) } };
      else project = withWidth(project, value);
      const next = state({ ...m, items: m.items.map((x) => (x === part ? { ...part, size: value } : x)) });
      assert.equal(h.amend(), next !== present, at);
      if (next !== present) {
        if (undos.length && undos[undos.length - 1].before === next) {
          undos.pop();
          counts.amendedAway++;
        } else counts.amends++;
        present = next;
        lastWasRecord = false;
      }
    } else if (n < 0.65) {
      // A width a file can't hold: refused while capturing, nothing moves.
      const keep = project;
      project = withWidth(project, NaN);
      assert.throws(() => h.record("Change width", "width"), /can't save/, at);
      project = keep;
      counts.nasty++;
    } else if (n < 0.81) {
      failRestore = r.next() < 0.1;
      const expected = undos.length ? undos[undos.length - 1] : null;
      if (failRestore && expected) {
        assert.throws(() => h.undo(), /restore failed/, at);
        counts.failed++;
      } else {
        assert.equal(h.undo(), expected?.label ?? null, at);
        if (expected) {
          undos.pop();
          redos.push({ after: present, label: expected.label });
          present = expected.before;
          lastWasRecord = false;
          counts.undos++;
        } else counts.empty++;
      }
      failRestore = false;
    } else if (n < 0.97) {
      const expected = redos.length ? redos[redos.length - 1] : null;
      assert.equal(h.redo(), expected?.label ?? null, at);
      if (expected) {
        redos.pop();
        undos.push({ before: present, label: expected.label, key: undefined, at: t });
        present = expected.after;
        lastWasRecord = false;
        counts.redos++;
      } else counts.empty++;
    } else if (n < 0.985) {
      // Undo all the way back and redo all the way forward: exactly as many steps as the model holds.
      let back = 0;
      while (h.undo() !== null) back++;
      assert.equal(back, undos.length, `${at}: undo depth`);
      let fwd = 0;
      while (h.redo() !== null) fwd++;
      assert.equal(fwd, undos.length + redos.length, `${at}: redo depth`);
      // Now everything is undoable and nothing redoable; the newest step is the last redone.
      for (let d = redos.pop(); d; d = redos.pop()) {
        undos.push({ before: present, label: d.label, key: undefined, at: t });
        present = d.after;
      }
      lastWasRecord = false;
      counts.walks++;
    } else {
      // A file opened: a fresh start.
      const w = 1 + Math.floor(r.next() * 20);
      project = projectWith(w);
      present = state(fresh(w));
      h.reset();
      undos = [];
      redos = [];
      lastWasRecord = false;
      counts.resets++;
    }
    check(at);
  }
  return counts;
}

test("random edit/undo/redo sessions on a real project match the model at every step", () => {
  for (const seed of SEEDS) {
    const c = session(seed, 4_000);
    // Every path must be reached, or the test proves nothing.
    for (const [k, n] of Object.entries(c)) assert.ok(n > 5, `seed ${seed}: only ${n} ${k}`);
  }
});

test("the same seed gives the same session", () => {
  assert.deepEqual(session(7n, 500), session(7n, 500));
});
