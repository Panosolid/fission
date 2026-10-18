// Seeded sessions on Design's timeline data (step 24d1), checked against
// the timeline model (timeline-model.ts) after every step.
//
// 24d1 changes only the data: every solid feature is kept as its own body,
// presets are features with counter ids, and the rollback marker is saved.
// So these sessions use the timeline sessions' own random steps
// (timeline-session.ts) that Design's document functions can do today:
// add a sketch (drawn with Design's line, circle and arc functions), an
// extrude or a preset, change a size, undo, redo, save and open. Suppression
// and the marker have no edit in Design until 24e, so they are written into
// the data as a later Panoshape would, and must open. After every step:
// - the items in order, with their kinds, inputs, sizes, suppressed flags
//   and the marker, are the model's (ids mapped through the edits' new ids);
// - every new id is one no state undo or redo can reach held, ids are
//   unique and the counter is above them all;
// - Design's part (`partFeature`) is the model's last solid item that
//   builds, or none when the model builds nothing;
// - save, open and save again is byte-identical, and opening gives the same
//   document, a document with nothing built too (24f4: it opens with no body).
// 24d2 replaces this with Design's timeline as a full `TimelineSubject` on
// the real kernel; `DATA_FAULTS` are planted bugs proving each check fails.

import { emptyProject, projectFromJson, projectToJson } from "@fission/core";
import {
  addSketch,
  changePreset,
  drawArc,
  drawCircle,
  drawLine,
  extrudeSketch,
  idNumber,
  insertPreset,
  isSketchExtrude,
  isSketchItem,
  partDocument,
  partFeature,
  readDesignDocument,
  setExtrudeDistance,
  shapeOf,
  type DesignDocument,
} from "@fission/design";
import type { Feature } from "@fission/core";
import { applyOp, createModel, rebuild, type ConcreteOp, type ModelDoc, type ModelShape, type TimelineModel } from "./timeline-model.ts";
import { resolveStep, TimelineFailure, type SessionCounts, type SessionOp } from "./timeline-session.ts";

/** Bugs planted on the Design side, each caught by its own check. */
export type DataFault =
  /** An extrude replaces the part, as before 24d1. */
  | "extrude-replaces"
  /** A new item goes last whatever the marker says. */
  | "insert-ignores-marker"
  /** Saving forgets the marker. */
  | "save-drops-marker"
  /** The part ignores suppression. */
  | "part-ignores-suppressed"
  /** A preset whose size changes becomes a new feature with a new id. */
  | "preset-edit-new-id"
  /** A distance typed for one extrude lands on the part instead. */
  | "distance-to-part";

export const DATA_FAULTS: readonly DataFault[] = ["extrude-replaces", "insert-ignores-marker", "save-drops-marker", "part-ignores-suppressed", "preset-edit-new-id", "distance-to-part"];

/** The checks each planted bug must fail (a lost marker fails the round trip). */
export const DATA_FAULT_CHECK: Record<DataFault, readonly string[]> = {
  "extrude-replaces": ["items differ from the model"],
  "insert-ignores-marker": ["items differ from the model"],
  "save-drops-marker": ["save and open changed the document"],
  "part-ignores-suppressed": ["the part differs from the model"],
  "preset-edit-new-id": ["items differ from the model"],
  "distance-to-part": ["items differ from the model"],
};

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];

/** One item as both sides describe it: kind, input, sizes, suppressed. */
type Row = string;

/** Draws a model shape into a Design sketch: a polygon as a closed chain of lines, a circle, a slot as two lines and two half circles. */
function drawShape(doc: DesignDocument, sketchId: string, shape: ModelShape): DesignDocument {
  const points = () => doc.sketches.find((s) => s.id === sketchId)!.points;
  const lastPoint = () => points().at(-1)!.id;
  if (shape.kind === "circle") return drawCircle(doc, sketchId, [shape.centre[0], shape.centre[1]], shape.radius).doc;
  if (shape.kind === "polygon") {
    const [first, ...rest] = shape.corners;
    doc = drawLine(doc, sketchId, [first[0], first[1]], [rest[0][0], rest[0][1]]).doc;
    const start = points()[0].id;
    for (const c of rest.slice(1)) doc = drawLine(doc, sketchId, lastPoint(), [c[0], c[1]]).doc;
    return drawLine(doc, sketchId, lastPoint(), start).doc;
  }
  const [x, y] = shape.at;
  const { length: l, radius: r } = shape;
  doc = drawLine(doc, sketchId, [x, y - r], [x + l, y - r]).doc;
  const [a, b] = points().map((p) => p.id);
  doc = drawArc(doc, sketchId, b, [x + l, y + r], [x + l, y]).doc;
  const c = points().at(-2)!.id; // the arc's end (then its centre)
  doc = drawLine(doc, sketchId, c, [x, y + r]).doc;
  return drawArc(doc, sketchId, lastPoint(), a, [x, y]).doc;
}

const modelRow = (doc: ModelDoc, i: number): Row => {
  const item = doc.items[i];
  const what =
    item.kind === "sketch"
      ? "sketch"
      : item.kind === "extrude"
        ? `extrude ${item.sketch} by ${item.distance}`
        : item.kind === "box"
          ? `box ${item.width} ${item.depth} ${item.height}`
          : item.kind === "cylinder"
            ? `cylinder ${item.diameter} ${item.height}`
            : `sphere ${item.diameter}`;
  return `${item.id}: ${what}${item.suppressed ? " (suppressed)" : ""}`;
};

/** The id of the model's last solid item that builds, or null. */
function modelPart(doc: ModelDoc): string | null {
  const r = rebuild(doc);
  const solid = [...doc.items].reverse().find((i) => i.kind !== "sketch" && r.results[i.id].status === "built");
  return solid?.id ?? null;
}

/** A document as sorted text, so key order (an opened file's keys are sorted) and -0 (saved as 0) don't count as changes. */
const canonical = (d: DesignDocument) => projectToJson({ ...emptyProject("Timeline"), workspaces: { design: d } });

const idsIn = (doc: DesignDocument): string[] => [
  ...doc.profiles.map((p) => p.id),
  ...doc.timeline.features.map((f) => f.id),
  ...doc.sketches.flatMap((s) => [...s.points.map((p) => p.id), ...s.curves.map((c) => c.id)]),
];

/** A Design document for this run, its undo and redo stacks of whole snapshots (as the app's history keeps). */
interface Side {
  doc: DesignDocument;
  undo: string[];
  redo: string[];
}

/**
 * Runs one session on Design's data and the model; throws a
 * TimelineFailure at the first check that fails, else returns how often
 * each kind of step happened.
 */
export function runDataSession(steps: readonly SessionOp[], faults: Iterable<DataFault> = []): SessionCounts {
  const fs = new Set(faults);
  const model: TimelineModel = createModel();
  // Both start from a 40 × 30 × 20 box: Design always has a part to show.
  applyOp(model, { op: "add-preset", kind: "box", sizes: [40, 30, 20] });
  model.undo = [];
  const side: Side = { doc: partDocument("box", 40, 30, 20), undo: [], redo: [] };
  const ids = new Map<string, string>([[model.doc.items[0].id, "feature-1"]]); // model id → Design id
  const back = () => new Map([...ids].map(([m, d]) => [d, m]));
  const to = (id: string) => ids.get(id) ?? `unmapped ${id}`;
  const counts: SessionCounts = {};
  const count = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  const save = (doc: DesignDocument): string => {
    const d = fs.has("save-drops-marker") ? { ...doc, timeline: { features: doc.timeline.features } } : doc;
    return projectToJson({ ...emptyProject("Timeline"), workspaces: { design: d } });
  };
  const part = (doc: DesignDocument): string | null => {
    if (fs.has("part-ignores-suppressed")) {
      const { features, marker } = doc.timeline;
      const end = marker === undefined ? features.length : marker === "start" ? 0 : features.findIndex((f) => f.id === marker) + 1;
      return [...features.slice(0, end)].reverse().find((f) => !isSketchItem(f))?.id ?? null;
    }
    return partFeature(doc)?.id ?? null;
  };
  /** Puts a new item last, as the planted bug does. */
  const last = (doc: DesignDocument, id: string): DesignDocument => {
    if (!fs.has("insert-ignores-marker")) return doc;
    const item = doc.timeline.features.find((f) => f.id === id)!;
    return { ...doc, timeline: { ...doc.timeline, features: [...doc.timeline.features.filter((f) => f !== item), item], marker: doc.timeline.marker } };
  };

  /** The edit on Design's side: the new document and the ids it made for the model's (item first). */
  function edit(doc: DesignDocument, op: Exclude<ConcreteOp, { op: "undo" | "redo" }>): { doc: DesignDocument; made: string[] } {
    switch (op.op) {
      case "add-sketch": {
        const s = addSketch(doc);
        return { doc: last(drawShape(s.doc, s.id, op.shape), s.id), made: [s.id] };
      }
      case "add-extrude": {
        const old = part(doc);
        const e = extrudeSketch(doc, to(op.sketch), op.distance);
        // Planted bug: the old part goes, as before 24d1.
        const replaced = fs.has("extrude-replaces") && old !== null ? { ...e.doc, timeline: { ...e.doc.timeline, features: e.doc.timeline.features.filter((f) => f.id !== old) } } : e.doc;
        return { doc: last(replaced, e.id), made: [e.id] };
      }
      case "add-preset": {
        const [a, b, c] = op.sizes;
        const p = op.kind === "box" ? insertPreset(doc, "box", a, b, c) : op.kind === "cylinder" ? insertPreset(doc, "cylinder", a, a, b) : insertPreset(doc, "sphere", a, a, a);
        return { doc: last(p.doc, p.id), made: [p.id] };
      }
      case "set-size": {
        const id = to(op.item);
        const f = doc.timeline.features.find((x) => x.id === id)!;
        if (isSketchExtrude(f)) {
          // Planted bug: the distance goes to the part when the part is an extrude.
          const at = partFeature(doc);
          const wrong = fs.has("distance-to-part") && at !== null && isSketchExtrude(at);
          return { doc: wrong ? setExtrudeDistance(doc, op.value) : setExtrudeDistance(doc, op.value, id), made: [] };
        }
        const { shape, sizes } = shapeOf(doc, f);
        if (shape === "sketch-extrude") throw new Error("harness: a preset read as an extrude");
        const key = op.key === "diameter" ? "width" : op.key;
        const s = { width: 0, depth: 0, height: 0, ...sizes, [key]: op.value };
        const next = changePreset(doc, id, shape, s.width, shape === "box" ? s.depth : s.width, shape === "sphere" ? s.width : s.height);
        if (!fs.has("preset-edit-new-id") || canonical(next) === canonical(doc)) return { doc: next, made: [] };
        // Planted bug: the changed preset takes the counter's next id.
        const fresh = `feature-${next.nextId}`;
        const features = next.timeline.features.map((x) => (x.id === id ? { ...x, id: fresh } : x));
        const marker = next.timeline.marker === id ? fresh : next.timeline.marker;
        return { doc: { ...next, nextId: next.nextId + 1, timeline: marker === undefined ? { features } : { features, marker } }, made: [] };
      }
      case "suppress": {
        // Written into the data, as a later Panoshape would (Design's suppress edit is 24e).
        const id = to(op.item);
        return { doc: { ...doc, timeline: { ...doc.timeline, features: doc.timeline.features.map((f): Feature => (f.id === id ? { ...f, suppressed: op.on } : f)) } }, made: [] };
      }
      case "marker": {
        const { marker: _, ...rest } = doc.timeline;
        return { doc: { ...doc, timeline: op.at === null ? rest : { ...rest, marker: op.at === "start" ? "start" : to(op.at) } }, made: [] };
      }
      default:
        throw new Error(`harness: Design has no ${op.op} edit until 24e`);
    }
  }

  steps.forEach((step, i) => {
    const fail = (check: string, detail: string): never => {
      throw new TimelineFailure(check, i, step, detail);
    };
    if (["move-corner", "delete-curve", "redraw-curve", "delete-item", "reorder", "hold-ref"].includes(step.op)) return void count("skipped");
    const resolved = resolveStep(model.doc, step);
    if (resolved === null || (resolved.kind === "edit" && resolved.op.op === "set-size" && model.doc.items.find((x) => x.id === (resolved.op as { item: string }).item)?.kind === "sketch"))
      return void count("skipped");
    if (resolved.kind === "save-open") {
      const text = save(side.doc);
      try {
        side.doc = projectFromJson(text, DESIGN).workspaces.design as DesignDocument;
      } catch (e) {
        return fail("a saved document was refused", String(e));
      }
      side.undo = [];
      side.redo = [];
      model.undo = [];
      model.redo = [];
      count("op:save-open");
      if (partFeature(side.doc) === null) count("save-open:nothing-built");
    } else if (resolved.kind === "edit") {
      const op = resolved.op;
      const want = applyOp(model, op);
      let made: string[] = [];
      const before = JSON.stringify(side.doc);
      const was = canonical(side.doc);
      if (op.op === "undo" || op.op === "redo") {
        const [from, onto] = op.op === "undo" ? [side.undo, side.redo] : [side.redo, side.undo];
        const t = from.pop();
        if (t !== undefined) {
          onto.push(before);
          side.doc = JSON.parse(t);
        }
      } else {
        const r = edit(side.doc, op);
        made = r.made;
        if (canonical(r.doc) !== was) {
          side.undo.push(before);
          side.redo = [];
          side.doc = r.doc;
        }
      }
      const changed = canonical(side.doc) !== was;
      if ((want.kind === "done") !== changed) fail("outcome differs from the model", `Design ${changed ? "changed" : "did not change"} the document, the model ${want.kind}`);
      if (want.kind === "refused") fail("outcome differs from the model", `the model refused ${op.op}, which Design has no refusal for yet`);
      // New ids: none in a state undo or redo can still reach (after the edit, as the model judges it).
      if (want.kind === "done" && op.op !== "undo" && op.op !== "redo") {
        const reachable = new Set([...side.undo, ...side.redo].flatMap((t) => idsIn(JSON.parse(t))));
        const old = new Set(idsIn(JSON.parse(before)));
        for (const id of idsIn(side.doc)) if (!old.has(id) && reachable.has(id)) fail("a new id is already in use", `${id} is in a state undo or redo can reach`);
        if (want.ids.length > 0 && made.length > 0) ids.set(want.ids[0], made[0]);
      }
      count(`op:${op.op}`);
    }

    // The items, in order, are the model's.
    const rev = back();
    const name = (id: string) => rev.get(id) ?? `Design's ${id}`;
    const design = side.doc.timeline.features.map((f): Row => {
      const p = f.intent.parameters;
      const what = isSketchItem(f)
        ? "sketch"
        : isSketchExtrude(f)
          ? `extrude ${name(p.sketch as string)} by ${p.distance}`
          : f.intent.type === "box"
            ? `box ${p.width} ${p.depth} ${p.height}`
            : f.intent.type === "cylinder"
              ? `cylinder ${p.diameter} ${p.height}`
              : `sphere ${p.diameter}`;
      return `${name(f.id)}: ${what}${f.suppressed ? " (suppressed)" : ""}`;
    });
    const wantRows = model.doc.items.map((_, k) => modelRow(model.doc, k));
    const marker = side.doc.timeline.marker;
    const designMarker = marker === undefined ? null : marker === "start" ? "start" : name(marker);
    if (JSON.stringify(design) !== JSON.stringify(wantRows) || designMarker !== model.doc.marker)
      fail("items differ from the model", `Design [${design.join("; ")}] marker ${designMarker}, model [${wantRows.join("; ")}] marker ${model.doc.marker}`);
    // Ids unique, the counter above them all.
    const all = idsIn(side.doc);
    const dup = all.find((id, k) => all.indexOf(id) !== k);
    if (dup !== undefined) fail("an id is used twice", dup);
    const high = all.find((id) => (idNumber(id) ?? 0) >= side.doc.nextId);
    if (high !== undefined) fail("the counter is not above every id", `${high}, nextId ${side.doc.nextId}`);
    // The part is the model's last solid item that builds.
    const want = modelPart(model.doc);
    const got = part(side.doc);
    if ((got === null ? null : name(got)) !== want) fail("the part differs from the model", `Design ${got === null ? "none" : name(got)}, model ${want ?? "none"}`);
    // Saved and opened: the same document, the same text again; nothing built too (24f4).
    if (want === null) count("nothing-built");
    const text = save(side.doc);
    let opened: DesignDocument;
    try {
      opened = projectFromJson(text, DESIGN).workspaces.design as DesignDocument;
    } catch (e) {
      return fail("a saved document was refused", String(e));
    }
    if (canonical(opened) !== canonical(side.doc)) fail("save and open changed the document", `${canonical(side.doc)} became ${canonical(opened)}`);
    if (save(opened) !== text) fail("save and open changed the document", "the second save differs from the first");
  });
  return counts;
}

/** The first failure of a session, or null. */
export function dataFailure(steps: readonly SessionOp[], faults: Iterable<DataFault> = []): TimelineFailure | null {
  try {
    runDataSession(steps, faults);
    return null;
  } catch (e) {
    if (e instanceof TimelineFailure) return e;
    throw e;
  }
}
