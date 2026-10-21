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
// says leaves nothing built is made like any other (24f4), and Design's
// `partFeature` must then be none too; a width typed then adds a new box
// at the marker, and a default filling in a size has none to fill.
//
// Step 25b2 adds the step 25 edits. Edit feature (25a2) changes any solid
// item's size, not only the part's (a box's width, an extrude's distance),
// as one step "Edit <item>" that never merges; the same size gives the same
// document and records nothing. The model keeps several sketches, each with
// its own curves: a new sketch goes in at the marker (when none can be
// opened, and now and then besides), and drawing, deleting and moving go
// into a sketch the app lets you open (Edit Sketch, 25a3: not suppressed,
// not after the marker), mostly the newest, sometimes an earlier one with
// extrudes built from it. Opening a sketch records nothing; each edit in it
// is its own step, as before.
//
// Step 26e: a new sketch is sometimes drawn on a box's top (`addFaceSketch`,
// the box built and before where it goes in), built on that box: it can't
// move before it, nor the box after it; suppressing the box greys it and
// everything built on it (Q3), as suppressing a sketch greys its extrudes;
// a greyed sketch can't be opened; deleting the box leaves it held where it
// was, still built (Q1), so its extrude builds and can be the part.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, emptyProject, projectFromJson, projectToJson, type Feature, type Project } from "@fission/core";
import {
  addFaceSketch,
  addSketch,
  curvePoints,
  deleteCurve,
  deleteItem,
  designWorkspace,
  DISTANCE_STEP,
  drawArc,
  drawCircle,
  drawLine,
  editFeature,
  editStep,
  extrudeSketch,
  extrudeStep,
  faceFeature,
  facePlane,
  isFacePlane,
  isSketchExtrude,
  isSketchItem,
  itemName,
  moveMarker,
  movePoint,
  partDocument,
  partFeature,
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
type Item = { id: string; kind: "box"; size: number; off: boolean } | { id: string; kind: "sketch"; off: boolean; on?: string } | { id: string; kind: "extrude"; sketch: string; size: number; off: boolean };

/**
 * The model's state: the timeline's items in order, the marker ("start",
 * an item's id, or null for everything built), the sketches in the order
 * they were made, each with its curves in drawing order (25b2: several),
 * and the part, which the model works out (`partOf`) and the project's is
 * read by Design's partFeature. As text, so states compare with ===.
 */
interface Model {
  items: Item[];
  marker: string | null;
  sketches: { id: string; lines: Line[] }[];
}
const state = (m: Model) => JSON.stringify({ part: partOf(m), ...m });
const parse = (s: string): Model => {
  const { part: _, ...m } = JSON.parse(s);
  return m;
};

// ---- The model's timeline rules, written from the owner's rules (docs/progress/cad.md, 24d1 and 24e), not from Design's code.

/** What an item is built on (26e): an extrude its sketch, a sketch on a face the box it is on; undefined when that is gone or there is none. */
const inputOf = (m: Model, item: Item): Item | undefined => m.items.find((i) => i.id === (item.kind === "extrude" ? item.sketch : item.kind === "sketch" ? item.on : undefined));
/** Whether an item is greyed (26e, Q3): something it is built on, directly or through others, is suppressed. */
function greyed(m: Model, item: Item): boolean {
  const input = inputOf(m, item);
  return input !== undefined && (input.off || greyed(m, input));
}
/**
 * Whether an item builds: not suppressed, not after the marker, not greyed,
 * and an extrude's sketch there and building. A sketch on a face whose box
 * is gone still builds, held where it was (26e, Q1).
 */
function buildsIn(m: Model, item: Item): boolean {
  const at = m.items.indexOf(item);
  if (item.off || m.marker === "start" || greyed(m, item)) return false;
  if (m.marker !== null && at > m.items.findIndex((i) => i.id === m.marker)) return false;
  if (item.kind !== "extrude") return true;
  const sketch = inputOf(m, item);
  return sketch !== undefined && buildsIn(m, sketch);
}
/** The part: the last solid item (not a sketch) that builds; null when none does. */
function partOf(m: Model): string | null {
  return [...m.items].reverse().find((i) => i.kind !== "sketch" && buildsIn(m, i))?.id ?? null;
}
/** The part's item, or undefined when nothing builds (24f4). */
const partItem = (m: Model): Item | undefined => m.items.find((i) => i.id === partOf(m));
/** Where a new item goes in: just after the marker, first at the start, else last; the marker, if there is one, moves onto it. */
function insert(m: Model, item: Item): Model {
  const items = [...m.items];
  const at = m.marker === null ? items.length : m.marker === "start" ? 0 : items.findIndex((i) => i.id === m.marker) + 1;
  items.splice(at, 0, item);
  return { ...m, items, marker: m.marker === null ? null : item.id };
}
const clone = (m: Model): Model => JSON.parse(JSON.stringify(m));
/** Where a new item goes in (as `insert`): an extrude there can only use a sketch before it. */
const insertPlace = (m: Model) => (m.marker === null ? m.items.length : m.marker === "start" ? 0 : m.items.findIndex((i) => i.id === m.marker) + 1);
/** Whether sketch `id` comes at or after where a new item goes in, so an extrude of it is refused. */
const isLate = (m: Model, id: string) => m.items.findIndex((i) => i.id === id) >= insertPlace(m);
/** Whether sketch `id` can be opened to draw in (Edit Sketch, 25a3, the item menu's rule): not suppressed or greyed (26e), not after the marker. */
function canOpen(m: Model, id: string): boolean {
  const at = m.items.findIndex((i) => i.id === id);
  if (at < 0 || m.items[at].off || greyed(m, m.items[at]) || m.marker === "start") return false;
  return m.marker === null || at <= m.items.findIndex((i) => i.id === m.marker);
}
/** The model with sketch `id`'s curves replaced. */
const withLines = (m: Model, id: string, lines: Line[]): Model => ({ ...m, sketches: m.sketches.map((k) => (k.id === id ? { id, lines } : k)) });

/** The project's state, read the same way: what the model must match. */
function stateOf(p: Project): string {
  const doc = designOf(p);
  // No kernel here, so no shape is ever kept (that needs the kernel's outline: settleKept, tested in packages/testing's timeline sessions).
  assert.equal(doc.kept, undefined, "a kept shape with no kernel to keep it");
  const items = doc.timeline.features.map((f): Item => {
    if (isSketchItem(f)) {
      const on = isFacePlane(f.intent.parameters.plane) ? faceFeature(f.intent.parameters.plane as string) : null;
      return on === null ? { id: f.id, kind: "sketch", off: f.suppressed } : { id: f.id, kind: "sketch", off: f.suppressed, on };
    }
    if (isSketchExtrude(f)) return { id: f.id, kind: "extrude", sketch: f.intent.parameters.sketch as string, size: f.intent.parameters.distance as number, off: f.suppressed };
    const { shape, sizes } = shapeOf(doc, f);
    assert.equal(shape, "box", `${f.id} is a ${shape}`);
    return { id: f.id, kind: "box", size: sizes.width, off: f.suppressed };
  });
  const sketches = doc.sketches.map((sketch) => {
    const at = new Map(sketch.points.map((q) => [q.id, [q.x, q.y]]));
    // No point is left that no curve uses, and no two points of one sketch share a place.
    const ends = new Set(sketch.curves.flatMap(curvePoints));
    assert.deepEqual(new Set(sketch.points.map((q) => q.id)), ends, `${sketch.id}: a point no curve uses`);
    assert.equal(new Set(sketch.points.map((q) => `${q.x},${q.y}`)).size, sketch.points.length, `${sketch.id}: two points at one place`);
    const lines = sketch.curves.map(
      (c): Line => (c.kind === "line" ? [c.id, ...at.get(c.start)!, ...at.get(c.end)!] : c.kind === "circle" ? [c.id, ...at.get(c.centre)!, c.radius] : [c.id, ...at.get(c.start)!, ...at.get(c.end)!, ...at.get(c.centre)!]) as Line,
    );
    return { id: sketch.id, lines };
  });
  return JSON.stringify({ part: partFeature(doc)?.id ?? null, items, marker: doc.timeline.marker ?? null, sketches });
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
    return { items: [{ id: "feature-1", kind: "box", size: w, off: false }, { id, kind: "sketch", off: false }], marker: null, sketches: [{ id, lines: [] }] };
  };
  // The model.
  let present = state(fresh(40));
  let undos: Undo[] = [];
  let redos: { after: string; label: string }[] = [];
  let lastWasRecord = false;
  const now = () => parse(present);
  /** Every id in a state undo can go back to: an item's or a curve's. */
  const usedIds = () => new Set([present, ...undos.map((u) => u.before)].flatMap((s) => [...parse(s).items.map((i) => i.id), ...parse(s).sketches.flatMap((k) => k.lines.map(([id]) => id))]));
  /** A new id: in no state undo can go back to. */
  const isNew = (id: string, at: string) => assert.ok(!usedIds().has(id), `${at}: ${id} was used before`);
  /** A box width to go back to: the part's when it is a box, else a new one. */
  const boxWidth = (s: string) => {
    const part = partItem(parse(s));
    return part?.kind === "box" ? part.size : 1 + Math.floor(r.next() * 20);
  };
  /**
   * The model after the part got width `w`: the same box when the part is
   * one, else (an extrude, or no part at all: 24f4) a new box (its id read
   * from the project, checked new) put in at the marker.
   */
  const boxPart = (m: Model, w: number, at: string): Model => {
    const part = partItem(m);
    if (part?.kind === "box") return { ...m, items: m.items.map((i) => (i === part ? { ...part, size: w } : i)) };
    if (part === undefined) counts.boxIntoEmpty++;
    const made = partFeature(designOf(project))!.id;
    isNew(made, at);
    return insert(m, { id: made, kind: "box", size: w, off: false });
  };
  /** A place no point of sketch `id` is at, on a 0.1 mm grid. */
  const freePlace = (id: string): [number, number] => {
    const used = new Set(now().sketches.find((k) => k.id === id)!.lines.flatMap(placesOf));
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
    // 26e: the states face sketches reach, counted so each is shown reached.
    const m = parse(present);
    if (m.items.some((x) => x.kind === "sketch" && x.on !== undefined && greyed(m, x))) counts.faceGreyed++;
    if (m.items.some((x) => x.kind === "extrude" && !x.off && inputOf(m, x)?.off)) counts.extrudeGreyed++;
    if (m.items.some((x) => x.kind === "sketch" && x.on !== undefined && inputOf(m, x) === undefined && buildsIn(m, x))) counts.faceHeld++;
    if (m.items.some((x) => x.kind === "extrude" && buildsIn(m, x) && (inputOf(m, x) as { on?: string } | undefined)?.on !== undefined)) counts.faceExtrudeBuilds++;
  };
  const counts = {
    draws: 0, chained: 0, circles: 0, centred: 0, arcs: 0, arcsChained: 0, deletes: 0, moves: 0, extrudes: 0, extrudesRefused: 0, sketchesAdded: 0, distances: 0, edits: 0, merged: 0, foldedAway: 0, same: 0, dropped: 0, undos: 0, redos: 0, empty: 0, failed: 0, nasty: 0, resets: 0, walks: 0, amends: 0, amendedAway: 0, steps: 0, stepsFailed: 0, stepsEmpty: 0,
    // Step 24e3: the timeline edits.
    itemsDeleted: 0, sketchDeleted: 0, markerMovedBack: 0, reorders: 0, reorderedInPlace: 0, refusedBefore: 0, refusedAfter: 0, suppressed: 0, unsuppressed: 0, markers: 0, markersSame: 0, nothingBuilt: 0, partNotLast: 0,
    // Step 24f4: a design with no body.
    boxIntoEmpty: 0, amendsNoBody: 0, stepsOnEmpty: 0, deletedAll: 0,
    // Step 25b2: several sketches, Edit Sketch on an earlier one, Edit feature on any solid item.
    moreSketches: 0, earlierSketch: 0, sketchWithExtrude: 0, featureEdits: 0, featureEditsSame: 0, featureEditsNotPart: 0, featureEditsExtrude: 0, featureEditsUnbuilt: 0,
    // Step 26e: sketches on a box's top, refused reorders round them, greyed by a suppressed box (and extrudes by a
    // suppressed sketch), held once their box is deleted, and their extrudes building.
    faceSketches: 0, refusedFace: 0, faceGreyed: 0, extrudeGreyed: 0, faceHeld: 0, faceExtrudeBuilds: 0,
  };

  for (let i = 0; i < steps; i++) {
    const at = `seed ${seed} step ${i}`;
    if (parse(present).items.length === 0) counts.stepsOnEmpty++;
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
      if (r.next() < 0.2 && part?.kind === "box") widths.push(part.size); // ends where it began
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
      // curve, move a point, or extrude a sketch (open or not: the kernel
      // judges the outline when it builds, which this test doesn't; refused
      // when the sketch is after the marker). Drawing, deleting and moving go
      // into a sketch the app lets you open (25b2: canOpen), mostly the
      // newest, sometimes an earlier one; with none to open (deleted,
      // suppressed or rolled back), a new one is made first, as its own
      // step, and now and then a second or third one besides.
      const m = now();
      const doc = designOf(project);
      const open = m.sketches.filter((k) => canOpen(m, k.id));
      if (open.length === 0 || (m.sketches.length < 3 && r.next() < 0.08)) {
        // 26e: sometimes on a box's top, a box that builds and comes before where the sketch goes in (as Create sketch offers).
        const boxes = m.items.filter((x, k) => x.kind === "box" && buildsIn(m, x) && k < insertPlace(m));
        const box = boxes.length > 0 && r.next() < 0.4 ? pick(r, boxes) : null;
        const made = box ? addFaceSketch(doc, { plane: facePlane(box.id, "top"), feature: box.id }, { plane: { origin: [0, 0, 20], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 1 }) : addSketch(doc);
        isNew(made.id, at);
        project = { ...project, workspaces: { design: made.doc } };
        const item: Item = box ? { id: made.id, kind: "sketch", off: false, on: box.id } : { id: made.id, kind: "sketch", off: false };
        recordStep(SKETCH_STEPS.create, { ...insert(m, item), sketches: [...m.sketches, { id: made.id, lines: [] }] }, at);
        counts.sketchesAdded++;
        if (box) counts.faceSketches++;
        if (m.sketches.length > 0) counts.moreSketches++;
      } else {
        let target = r.next() < 0.6 ? open[open.length - 1] : pick(r, open);
        // An extrude is refused while its sketch is after the marker: tried more often then, so that path is reached.
        const late = m.sketches.filter((k) => isLate(m, k.id));
        const kind = late.length > 0 && r.next() < 0.3 ? "extrude" : target.lines.length === 0 ? pick(r, ["draw", "circle", "arc"] as const) : pick(r, ["draw", "draw", "circle", "arc", "delete", "move", "extrude"] as const);
        if (kind === "extrude" && late.length > 0 && r.next() < 0.6) target = pick(r, late);
        const sketch = doc.sketches.find((k) => k.id === target.id)!;
        const { lines } = target;
        if (kind !== "extrude") {
          if (target.id !== m.sketches[m.sketches.length - 1].id) counts.earlierSketch++;
          if (m.items.some((x) => x.kind === "extrude" && x.sketch === target.id)) counts.sketchWithExtrude++;
        }
        const free = () => freePlace(target.id);
        let after: Model;
        let label: string = kind === "extrude" ? extrudeStep(doc, sketch.id) : SKETCH_STEPS[kind];
        if (kind === "draw") {
          const chain = sketch.points.length > 0 && r.next() < 0.5;
          const start = chain ? pick(r, sketch.points) : null;
          const from = start ? start.id : free();
          const fromXY = start ? [start.x, start.y] : (from as [number, number]);
          const others = sketch.points.filter((q) => q !== start);
          const end = others.length > 0 && r.next() < 0.2 ? pick(r, others) : null;
          const to = end ? end.id : free();
          const toXY = end ? [end.x, end.y] : (to as [number, number]);
          const drawn = drawLine(doc, sketch.id, from, to);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = withLines(m, target.id, [...lines, [drawn.id, fromXY[0], fromXY[1], toXY[0], toXY[1]]]);
          counts.draws++;
          if (chain) counts.chained++;
        } else if (kind === "circle") {
          const shared = sketch.points.length > 0 && r.next() < 0.3 ? pick(r, sketch.points) : null;
          const centre = shared ? shared.id : free();
          const [cx, cy] = shared ? [shared.x, shared.y] : (centre as [number, number]);
          const radius = (1 + Math.floor(r.next() * 200)) / 10;
          const drawn = drawCircle(doc, sketch.id, centre, radius);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = withLines(m, target.id, [...lines, [drawn.id, cx, cy, radius]]);
          counts.circles++;
          if (shared) counts.centred++;
        } else if (kind === "arc") {
          const shared = sketch.points.length > 0 && r.next() < 0.4 ? pick(r, sketch.points) : null;
          const start = shared ? shared.id : free();
          const startXY = shared ? [shared.x, shared.y] : (start as [number, number]);
          let end = free();
          let centre = free();
          while (centre[0] === end[0] && centre[1] === end[1]) centre = free();
          while (!shared && ((end[0] === startXY[0] && end[1] === startXY[1]) || (centre[0] === startXY[0] && centre[1] === startXY[1]))) [end, centre] = [free(), free()];
          const drawn = drawArc(doc, sketch.id, start, end, centre);
          isNew(drawn.id, at);
          project = { ...project, workspaces: { design: drawn.doc } };
          after = withLines(m, target.id, [...lines, [drawn.id, startXY[0], startXY[1], end[0], end[1], centre[0], centre[1]]]);
          counts.arcs++;
          if (shared) counts.arcsChained++;
        } else if (kind === "delete") {
          const [gone] = pick(r, lines);
          project = { ...project, workspaces: { design: deleteCurve(doc, sketch.id, gone) } };
          after = withLines(m, target.id, lines.filter(([id]) => id !== gone));
          counts.deletes++;
        } else if (kind === "extrude") {
          const d = 1 + Math.floor(r.next() * 20);
          // The sketch must come before where the extrude goes in (at the marker).
          if (isLate(m, sketch.id)) {
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
          const [x, y] = free();
          project = { ...project, workspaces: { design: movePoint(doc, sketch.id, p.id, x, y) } };
          const move = (a: number, b: number) => (a === p.x && b === p.y ? [x, y] : [a, b]);
          after = withLines(m, target.id, lines.map((c) => (c.length === 4 ? [c[0], ...move(c[1], c[2]), c[3]] : [c[0], ...Array.from({ length: (c.length - 1) / 2 }, (_, k) => move(c[1 + 2 * k] as number, c[2 + 2 * k] as number)).flat()]) as Line));
          counts.moves++;
        }
        recordStep(label, after, at);
      }
    } else if (n < 0.3) {
      // A timeline edit (24e3), one undo step each, named as the app names
      // it. The model's answer first; then Design's.
      const m = now();
      const doc = designOf(project);
      // Everything deleted (24f4): no item to edit.
      if (m.items.length === 0) {
        check(at);
        continue;
      }
      const edit = pick(r, ["delete", "reorder", "reorder", "reorder", "suppress", "marker", "edit", "edit"] as const);
      // Edit feature (25a2) takes a solid item: with none (only sketches), nothing to edit.
      const solids = m.items.filter((x) => x.kind !== "sketch");
      if (edit === "edit" && solids.length === 0) {
        check(at);
        continue;
      }
      // Mostly any item; sometimes the one each edit's rarer paths need: the item the marker is on (a delete moves the
      // marker back), an extrude or a sketch (a reorder can be refused), a suppressed item (unsuppress).
      const linked = m.items.filter((x) => x.kind === "extrude" || m.items.some((y) => y.kind === "extrude" && y.sketch === x.id));
      // A delete also often takes the last item (24f4): deleting from the end empties the timeline, and the states with no body come up often.
      const ends = r.next() < 0.5 ? [m.items[m.items.length - 1]] : m.items.filter((x) => x.id === m.marker);
      const wanted = { delete: ends, reorder: linked, suppress: m.items.filter((x) => x.off), marker: [], edit: solids }[edit];
      // An edit takes an extrude half the time when there is one: extrudes are fewer than boxes.
      const extrudes = solids.filter((x) => x.kind === "extrude");
      const item = edit === "edit" ? pick(r, extrudes.length > 0 && r.next() < 0.5 ? extrudes : solids) : wanted.length > 0 && r.next() < 0.6 ? pick(r, wanted) : pick(r, m.items);
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
        if (item.kind === "sketch") after.sketches = after.sketches.filter((k) => k.id !== item.id);
        next = deleteItem(doc, item.id);
        label = TIMELINE_STEPS.delete(name);
      } else if (edit === "reorder") {
        // To place `to` of the new order. Refused when the item would come before the item it is built from, or after one built from it.
        // The two ends are where refusals are: an extrude first comes before its sketch, a used sketch last after its extrude.
        const to = r.next() < 0.4 ? (item.kind === "extrude" ? 0 : m.items.length - 1) : Math.floor(r.next() * m.items.length);
        const items = m.items.filter((x) => x !== item);
        items.splice(to, 0, item);
        const place = (id: string) => items.findIndex((x) => x.id === id);
        // 26e: a sketch on a box's top is built on that box (answer 7).
        const builtOn = (x: Item) => (x.kind === "extrude" ? x.sketch : x.kind === "sketch" ? x.on : undefined);
        const before = builtOn(item) !== undefined && place(builtOn(item)!) > to;
        const afterUser = items.some((x, j) => j < to && builtOn(x) === item.id);
        if ((before || afterUser) && (item.kind === "box" || (item.kind === "sketch" && item.on !== undefined))) counts.refusedFace++;
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
      } else if (edit === "edit") {
        // Edit feature on any solid item, the part or not, built or not: a box's width, an extrude's distance (its
        // height box); sometimes the size it has, which gives the same document back and records nothing.
        const solid = item as Extract<Item, { size: number }>;
        const size = r.next() < 0.15 ? solid.size : 1 + Math.floor(r.next() * 20);
        next = editFeature(doc, item.id, solid.kind === "box" ? { width: size } : { height: size });
        after = { ...m, items: m.items.map((x) => (x === item ? { ...solid, size } : x)) };
        label = editStep(doc, item.id);
        assert.equal(label, TIMELINE_STEPS.edit(name), at);
        if (size === solid.size) assert.equal(next, doc, `${at}: an Edit feature that changes nothing gave a new document`);
      } else {
        const to = r.next() < 0.2 ? "start" : r.next() < 0.3 ? null : item.id;
        after = { ...m, marker: to };
        next = moveMarker(doc, to);
        label = TIMELINE_STEPS.marker;
      }
      // Nothing built (24f4): made like any other edit; check() then compares Design's part, none, with the model's.
      if (partOf(after) === null) counts.nothingBuilt++;
      project = { ...project, workspaces: { design: next } };
      if (state(after) === present) {
        // At its own place, or the marker where it was: the same document, no step.
        assert.equal(h.record(label), false, at);
        if (edit === "marker") counts.markersSame++;
        if (edit === "edit") counts.featureEditsSame++;
      } else {
        recordStep(label, after, at);
        if (edit === "delete") {
          counts.itemsDeleted++;
          if (item.kind === "sketch") counts.sketchDeleted++;
          if (m.marker === item.id) counts.markerMovedBack++;
        } else if (edit === "suppress") counts[item.off ? "unsuppressed" : "suppressed"]++;
        else if (edit === "marker") counts.markers++;
        else if (edit === "edit") {
          counts.featureEdits++;
          if (item.id !== partOf(m)) counts.featureEditsNotPart++;
          if (item.kind === "extrude") counts.featureEditsExtrude++;
          if (!buildsIn(m, item)) counts.featureEditsUnbuilt++;
        }
      }
      // The part isn't always the last item: the marker or a suppression can leave later items out.
      if (partOf(after) !== after.items.filter((x) => x.kind !== "sketch").at(-1)?.id) counts.partNotLast++;
    } else if (n < 0.58) {
      // An edit: mostly a new width, sometimes the same, sometimes back to
      // the one before; on an extrude, half the time a typed distance (the
      // height box, merged like the sizes), else a width (a new box).
      const m = now();
      const part = partItem(m);
      const extrude = part?.kind === "extrude" && r.next() < 0.5 ? part : null;
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
      // No part (24f4): no size to fill in, so nothing changes.
      if (part === undefined) {
        assert.equal(h.amend(), false, at);
        counts.amendsNoBody++;
        check(at);
        continue;
      }
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
    } else if (n < 0.99) {
      // Every item deleted, last first, each its own step (24f4): the empty timeline, which later steps then build on.
      for (let m = now(); m.items.length > 0; m = now()) {
        const item = m.items[m.items.length - 1];
        const k = m.items.length - 1;
        const after: Model = { ...clone(m), items: m.items.slice(0, k) };
        if (m.marker === item.id) after.marker = k === 0 ? "start" : m.items[k - 1].id;
        if (item.kind === "sketch") after.sketches = after.sketches.filter((k) => k.id !== item.id);
        const doc = designOf(project);
        const name = itemName(doc.timeline.features.find((f) => f.id === item.id)!);
        project = { ...project, workspaces: { design: deleteItem(doc, item.id) } };
        recordStep(TIMELINE_STEPS.delete(name), after, at);
        check(at);
      }
      assert.deepEqual(designOf(project).timeline.features, [], at);
      assert.deepEqual(designOf(project).profiles, [], at);
      counts.deletedAll++;
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
    const c = session(seed, 5_000);
    if (process.env.FISSION_COUNTS) console.log(seed, JSON.stringify({ nothingBuilt: c.nothingBuilt, boxIntoEmpty: c.boxIntoEmpty, amendsNoBody: c.amendsNoBody, stepsOnEmpty: c.stepsOnEmpty, deletedAll: c.deletedAll, moreSketches: c.moreSketches, earlierSketch: c.earlierSketch, sketchWithExtrude: c.sketchWithExtrude, featureEdits: c.featureEdits, featureEditsSame: c.featureEditsSame, featureEditsNotPart: c.featureEditsNotPart, featureEditsExtrude: c.featureEditsExtrude, featureEditsUnbuilt: c.featureEditsUnbuilt }));
    // Every path must be reached, or the test proves nothing.
    for (const [k, n] of Object.entries(c)) assert.ok(n > 5, `seed ${seed}: only ${n} ${k}`);
  }
});

test("the same seed gives the same session", () => {
  assert.deepEqual(session(7n, 500), session(7n, 500));
});

test("Edit feature on an early item and Edit Sketch on an earlier sketch, by hand (25b2)", () => {
  // A 40 × 30 × 20 box, Sketch 1 with one line, Extrude 1 of it (10 mm), then Sketch 2 with one line.
  let doc = partDocument("box", 40, 30, 20);
  const s1 = addSketch(doc);
  doc = drawLine(s1.doc, s1.id, [0, 0], [10, 0]).doc;
  const e1 = extrudeSketch(doc, s1.id, 10);
  const s2 = addSketch(e1.doc);
  doc = drawLine(s2.doc, s2.id, [5, 5], [5, 15]).doc;
  let project: Project = { ...emptyProject(), workspaces: { design: doc } };
  const h = createHistory({ capture: () => projectToJson(project), restore: (text) => void (project = projectFromJson(text, [designWorkspace])), limit: LIMIT, mergeMs: MERGE, now: () => 0 });
  const box = () => shapeOf(designOf(project), designOf(project).timeline.features[0]).sizes;
  const extrude = () => designOf(project).timeline.features.find((f) => f.id === e1.id)!.intent.parameters.distance;
  const lines = (id: string) => designOf(project).sketches.find((s) => s.id === id)!.curves.length;

  // Edit feature on the box (not the part, which is Extrude 1, the last solid): width 40 → 55, one step named for the box.
  project = { ...project, workspaces: { design: editFeature(designOf(project), "feature-1", { width: 55 }) } };
  assert.equal(h.record(editStep(doc, "feature-1")), true);
  assert.equal(h.undoLabel(), "Edit Feature 1 (box)");
  assert.deepEqual(box(), { width: 55, depth: 30, height: 20 });
  assert.equal(partFeature(designOf(project))!.id, e1.id);
  // The same width again: the same document, nothing recorded.
  assert.equal(editFeature(designOf(project), "feature-1", { width: 55 }), designOf(project));
  assert.equal(h.record("Edit Feature 1 (box)"), false);
  // Extrude 1's distance 10 → 4 through Edit feature (its height box): a second step; the box keeps 55.
  project = { ...project, workspaces: { design: editFeature(designOf(project), e1.id, { height: 4 }) } };
  assert.equal(h.record(editStep(designOf(project), e1.id)), true);
  assert.deepEqual([box().width, extrude()], [55, 4]);

  // Edit Sketch on Sketch 1 (before Extrude 1 and Sketch 2): a second line drawn there is one step; Sketch 2 keeps its one line.
  project = { ...project, workspaces: { design: drawLine(designOf(project), s1.id, [10, 0], [10, 8]).doc } };
  assert.equal(h.record(SKETCH_STEPS.draw), true);
  assert.deepEqual([lines(s1.id), lines(s2.id)], [2, 1]);

  // Undo takes back the line, then the distance, then the width, each alone; Redo puts them back in order.
  assert.equal(h.undo(), SKETCH_STEPS.draw);
  assert.deepEqual([lines(s1.id), lines(s2.id), extrude(), box().width], [1, 1, 4, 55]);
  assert.equal(h.undo(), "Edit Extrude 1");
  assert.deepEqual([extrude(), box().width], [10, 55]);
  assert.equal(h.undo(), "Edit Feature 1 (box)");
  assert.deepEqual([extrude(), box().width], [10, 40]);
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), "Edit Feature 1 (box)");
  assert.equal(h.redo(), "Edit Extrude 1");
  assert.equal(h.redo(), SKETCH_STEPS.draw);
  assert.deepEqual([lines(s1.id), lines(s2.id), extrude(), box().width], [2, 1, 4, 55]);
});
