// Design's timeline as a `TimelineSubject` on the real kernel (step 24d2),
// for the seeded timeline sessions (timeline-session.ts) to check against
// the model (timeline-model.ts).
//
// Each model edit is done with Design's own functions where Design has
// them: sketches drawn with drawLine, drawArc and drawCircle (a polygon as
// a chain of lines, side k from corner k to corner k + 1; a slot as its
// bottom line, right half circle, top line and left half circle; a
// circle), corners and slot sizes moved with movePoint, curves deleted
// with deleteCurve and drawn again between the same corners, extrudes,
// presets and their sizes. Edits Design gets at 24e (suppress, the marker,
// deleting an item, reordering) and a circle's radius (no edit yet) are
// written into the data as a later Fission would. After every edit Design's
// `settleKept` applies the owner's rule, and the undo history is whole
// snapshots, as the app's is.
//
// A rebuild is Design's `rebuildTimeline` on the body store, read back as
// the model's terms: each body's volume, each face by Design's name
// (`nameBody`) with the kernel's area and centroid, each edge by its two
// faces with its length and centroid measured on the display mesh (so
// compared with `edgeMatches`, within EDGE_SLACK). `faults` plants bugs in
// Design's side to prove the checks catch them.

import { emptyProject, projectFromJson, projectToJson, type BodyView, type Feature, type KernelCalls } from "@fission/core";
import {
  addSketch,
  BodyCache,
  changePreset,
  deleteCurve,
  drawArc,
  drawCircle,
  drawLine,
  extrudeSketch,
  insertPreset,
  isSketchExtrude,
  movePoint,
  nameBody,
  outlineCurves,
  partDocument,
  readDesignDocument,
  rebuildTimeline,
  setExtrudeDistance,
  settleKept,
  shapeOf,
  type DesignDocument,
  type LineEnd,
  type SketchCurve,
  type TimelineBuild,
} from "@fission/design";
import { edgeName, faceKey, type Applied, type ConcreteOp, type FaceName, type FaceRole, type ItemResult, type ModelBody, type ModelShape, type Point, type Rebuild } from "./timeline-model.ts";
import type { EdgeClose, TimelineSubject } from "./timeline-session.ts";

/** Each edge's length and centroid (the mean point along it), measured on the display mesh's edge lines. */
export function edgeGeometry(view: BodyView): { length: number; centroid: number[] }[] {
  const out = Array.from({ length: view.edges }, () => ({ length: 0, sum: [0, 0, 0] }));
  const at = view.mesh.edge_lines;
  view.mesh.edge_line_edges.forEach((e, s) => {
    const p = at.slice(6 * s, 6 * s + 3);
    const q = at.slice(6 * s + 3, 6 * s + 6);
    const len = Math.sqrt((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2);
    out[e].length += len;
    for (let k = 0; k < 3; k++) out[e].sum[k] += (len * (p[k] + q[k])) / 2;
  });
  return out.map((o) => ({ length: o.length, centroid: o.sum.map((x) => x / o.length) }));
}

/**
 * How far an edge measured on the display mesh may be from the model's:
 * its chords sag inside a curve by at most DISPLAY_CHORD (0.01 mm,
 * kernel/src/tolerance.rs; the cap of 256 chords a turn sags less below a
 * radius of 133 mm, more than any shape here), which moves the centroid by
 * at most that, plus the f32 rounding of each point (2⁻²⁴ of 100 mm, ~6e-6
 * mm). Each chord is shorter than its arc by (θ/3) × its sag, θ the chord's
 * turn, so over a whole circle (2π) the length falls short by at most
 * 2π/3 × 0.01 ≈ 0.021 mm.
 */
export const EDGE_SLACK = { centroid: 0.0101, length: 0.022 };

/** Whether a mesh-measured edge matches the model's within EDGE_SLACK. */
export const edgeMatches: EdgeClose = (got, want) => {
  const off = Math.sqrt(got.centroid.reduce((s, x, k) => s + (x - want.centroid[k]) ** 2, 0));
  return Math.abs(got.length - want.length) <= EDGE_SLACK.length && off <= EDGE_SLACK.centroid;
};

/** Bugs planted in Design's side, each caught by its check (journeys/timeline.journey.ts). */
export type DesignFault =
  /** No kept shapes: the rule before 24d2. */
  | "no-settle"
  /** Rebuilds always build afresh and never free: caught by body_count, not the session. */
  | "leak-bodies"
  /** The file forgets the kept shapes. */
  | "save-drops-kept"
  /** Bodies are read once per feature id, so an edit to a sketch doesn't reach its extrude. */
  | "cache-by-feature";

export const DESIGN_FAULTS: readonly DesignFault[] = ["no-settle", "leak-bodies", "save-drops-kept", "cache-by-feature"];

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
/** The messages a design with no body is refused with until 24d3 shows one. */
const NOTHING_BUILT = /Design data (builds no body|has no part|has no timeline)/;

/** The model's shape and curve ids of each sketch, by Design id: how model curve k and corner k are found in Design's sketch. */
type Meta = Record<string, { shape: ModelShape; curves: (string | null)[] }>;

interface State {
  doc: DesignDocument;
  meta: Meta;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const save = (doc: DesignDocument) => projectToJson({ ...emptyProject("Timeline"), workspaces: { design: doc } });

/** A slot's six points by role, with where each is: ends a, b (bottom), t1, t2 (top), centres c1 (right), c0 (left). */
function slotPlaces(s: Extract<ModelShape, { kind: "slot" }>): Record<"a" | "b" | "t1" | "t2" | "c1" | "c0", Point> {
  const [x, y] = s.at;
  const { length: l, radius: r } = s;
  return { a: [x, y - r], b: [x + l, y - r], t1: [x + l, y + r], t2: [x, y + r], c1: [x + l, y], c0: [x, y] };
}

export interface DesignSubject extends TimelineSubject {
  readonly kernel: KernelCalls;
  /** Frees every body the subject keeps. */
  dispose(): Promise<void>;
}

/** Design's timeline on `kernel`, starting from a 40 × 30 × 20 box (Design always has a part), with bugs planted. */
export function designSubject(kernel: KernelCalls, faults: Iterable<DesignFault> = []): DesignSubject {
  const fs = new Set(faults);
  let state: State = { doc: partDocument("box", 40, 30, 20), meta: {} };
  let undo: string[] = [];
  let redo: string[] = [];
  let cache = new BodyCache(kernel);
  const bodies = new Map<string, ModelBody>();

  const curveOf = (doc: DesignDocument, sketch: string, id: string | null): SketchCurve | undefined =>
    id === null ? undefined : doc.sketches.find((s) => s.id === sketch)?.curves.find((c) => c.id === id);

  /** The point at corner k of a polygon sketch: side k's start, else side k − 1's end; null when both sides are gone. */
  function cornerPoint(meta: Meta, doc: DesignDocument, sketch: string, k: number): string | null {
    const m = meta[sketch];
    const n = m.curves.length;
    const side = curveOf(doc, sketch, m.curves[k]);
    if (side?.kind === "line") return side.start;
    const before = curveOf(doc, sketch, m.curves[(k + n - 1) % n]);
    return before?.kind === "line" ? before.end : null;
  }

  /** A slot's point by role, from whichever of its curves is still there. */
  function slotPoint(meta: Meta, doc: DesignDocument, sketch: string, role: keyof ReturnType<typeof slotPlaces>): string | null {
    const c = meta[sketch].curves.map((id) => curveOf(doc, sketch, id));
    const pick = (k: number, end: "start" | "end" | "centre") => {
      const x = c[k] as Record<string, string> | undefined;
      return x?.[end] ?? null;
    };
    switch (role) {
      case "a":
        return pick(0, "start") ?? pick(3, "end");
      case "b":
        return pick(0, "end") ?? pick(1, "start");
      case "t1":
        return pick(1, "end") ?? pick(2, "start");
      case "t2":
        return pick(2, "end") ?? pick(3, "start");
      case "c1":
        return pick(1, "centre");
      case "c0":
        return pick(3, "centre");
    }
  }

  const at = (id: string | null, p: Point): LineEnd => id ?? [p[0], p[1]];

  /** Draws curve k of a sketch's shape: a polygon's side, a slot's piece, the circle. */
  function drawCurve(meta: Meta, doc: DesignDocument, sketch: string, k: number): { doc: DesignDocument; id: string } {
    const shape = meta[sketch].shape;
    if (shape.kind === "circle") return drawCircle(doc, sketch, [shape.centre[0], shape.centre[1]], shape.radius);
    if (shape.kind === "polygon") {
      const n = shape.corners.length;
      return drawLine(doc, sketch, at(cornerPoint(meta, doc, sketch, k), shape.corners[k]), at(cornerPoint(meta, doc, sketch, (k + 1) % n), shape.corners[(k + 1) % n]));
    }
    const p = slotPlaces(shape);
    const pt = (role: keyof typeof p) => at(slotPoint(meta, doc, sketch, role), p[role]);
    if (k === 0) return drawLine(doc, sketch, pt("a"), pt("b"));
    if (k === 1) return drawArc(doc, sketch, pt("b"), pt("t1"), pt("c1"));
    if (k === 2) return drawLine(doc, sketch, pt("t1"), pt("t2"));
    return drawArc(doc, sketch, pt("t2"), pt("a"), pt("c0"));
  }

  const write = (doc: DesignDocument, features: Feature[], marker: string | undefined): DesignDocument => {
    const { marker: _, ...rest } = doc.timeline;
    return { ...doc, timeline: marker === undefined ? { ...rest, features } : { ...rest, features, marker } };
  };

  /** The edit on Design's side: the new state and the ids it made, or a refusal. */
  function edit(s: State, op: Exclude<ConcreteOp, { op: "undo" | "redo" }>): { state: State; made: string[] } | Applied {
    let doc = s.doc;
    const meta = clone(s.meta);
    switch (op.op) {
      case "add-sketch": {
        const made = addSketch(doc);
        doc = made.doc;
        const count = op.shape.kind === "polygon" ? op.shape.corners.length : op.shape.kind === "slot" ? 4 : 1;
        const curves: (string | null)[] = Array.from({ length: count }, () => null);
        meta[made.id] = { shape: clone(op.shape), curves };
        for (let k = 0; k < count; k++) {
          const c = drawCurve(meta, doc, made.id, k);
          doc = c.doc;
          curves[k] = c.id;
        }
        return { state: { doc, meta }, made: [made.id, ...(curves as string[])] };
      }
      case "add-extrude": {
        const e = extrudeSketch(doc, op.sketch, op.distance);
        return { state: { doc: e.doc, meta }, made: [e.id] };
      }
      case "add-preset": {
        const [a, b, c] = op.sizes;
        const p = op.kind === "box" ? insertPreset(doc, "box", a, b, c) : op.kind === "cylinder" ? insertPreset(doc, "cylinder", a, a, b) : insertPreset(doc, "sphere", a, a, a);
        return { state: { doc: p.doc, meta }, made: [p.id] };
      }
      case "set-size": {
        const f = doc.timeline.features.find((x) => x.id === op.item)!;
        if (isSketchExtrude(f)) return { state: { doc: setExtrudeDistance(doc, op.value, op.item), meta }, made: [] };
        const m = meta[op.item];
        if (m !== undefined) {
          (m.shape as Record<string, unknown>)[op.key] = op.value;
          if (m.shape.kind === "circle") {
            // A circle's radius has no edit yet: written into the data.
            const sketches = doc.sketches.map((x) => (x.id === op.item ? { ...x, curves: x.curves.map((c) => (c.kind === "circle" ? { ...c, radius: op.value } : c)) } : x));
            return { state: { doc: { ...doc, sketches }, meta }, made: [] };
          }
          if (m.shape.kind === "slot") {
            const places = slotPlaces(m.shape);
            for (const role of Object.keys(places) as (keyof typeof places)[]) {
              const pid = slotPoint(meta, doc, op.item, role);
              if (pid !== null) doc = movePoint(doc, op.item, pid, places[role][0], places[role][1]);
            }
            return { state: { doc, meta }, made: [] };
          }
          throw new Error(`harness: a polygon sketch has no size`);
        }
        const { shape, sizes } = shapeOf(doc, f);
        if (shape === "sketch-extrude") throw new Error("harness: a preset read as an extrude");
        const key = op.key === "diameter" ? "width" : op.key;
        const z = { width: 0, depth: 0, height: 0, ...sizes, [key]: op.value };
        return { state: { doc: changePreset(doc, op.item, shape, z.width, shape === "box" ? z.depth : z.width, shape === "sphere" ? z.width : z.height), meta }, made: [] };
      }
      case "move-corner": {
        const pid = cornerPoint(meta, doc, op.sketch, op.corner);
        if (pid === null) throw new Error(`harness: corner ${op.corner} of ${op.sketch} is gone`);
        const m = meta[op.sketch];
        if (m.shape.kind === "polygon") m.shape.corners[op.corner] = op.to;
        return { state: { doc: movePoint(doc, op.sketch, pid, op.to[0], op.to[1]), meta }, made: [] };
      }
      case "delete-curve": {
        const m = meta[op.sketch];
        m.curves[m.curves.indexOf(op.curve)] = null;
        return { state: { doc: deleteCurve(doc, op.sketch, op.curve), meta }, made: [] };
      }
      case "redraw-curve": {
        const c = drawCurve(meta, doc, op.sketch, op.index);
        meta[op.sketch].curves[op.index] = c.id;
        return { state: { doc: c.doc, meta }, made: [c.id] };
      }
      case "delete-item": {
        // Written into the data until 24e: the item goes (a sketch with its content); the marker moves to the item before.
        const features = doc.timeline.features;
        const k = features.findIndex((f) => f.id === op.item);
        const marker = doc.timeline.marker === op.item ? (k === 0 ? "start" : features[k - 1].id) : doc.timeline.marker;
        doc = write(doc, features.filter((f) => f.id !== op.item), marker);
        return { state: { doc: { ...doc, sketches: doc.sketches.filter((x) => x.id !== op.item) }, meta }, made: [] };
      }
      case "reorder": {
        // Written into the data until 24e, refused as the model refuses.
        const features = [...doc.timeline.features];
        const k = features.findIndex((f) => f.id === op.item);
        const [item] = features.splice(k, 1);
        features.splice(op.to, 0, item);
        const place = (id: string) => features.findIndex((f) => f.id === id);
        if (item.dependsOn.some((d) => place(d) > op.to)) return { kind: "refused", cause: "before-dependency" };
        if (features.some((f, j) => j < op.to && f.dependsOn.includes(item.id))) return { kind: "refused", cause: "after-dependent" };
        return { state: { doc: write(doc, features, doc.timeline.marker), meta }, made: [] };
      }
      case "suppress":
        return { state: { doc: write(doc, doc.timeline.features.map((f): Feature => (f.id === op.item ? { ...f, suppressed: op.on } : f)), doc.timeline.marker), meta }, made: [] };
      case "marker":
        return { state: { doc: write(doc, doc.timeline.features, op.at === null ? undefined : op.at), meta }, made: [] };
    }
  }

  /** The rebuild in the model's terms. */
  async function read(build: TimelineBuild, from: BodyCache, keep: boolean): Promise<Rebuild> {
    const results: Record<string, ItemResult> = {};
    for (const id of build.order) {
      const r = build.results[id];
      if (r.status === "suppressed" || r.status === "rolled-back") results[id] = { status: r.status };
      else if (r.status === "failed") results[id] = { status: "failed", cause: r.cause as never, input: r.input };
      else if (r.body === undefined) results[id] = { status: "built" };
      else {
        // Planted bug ("cache-by-feature"): a body read once per feature id, so later edits never reach it.
        const key = fs.has("cache-by-feature") ? id : `${id}|${r.body}|${JSON.stringify(r.curves ?? null)}`;
        let body = keep ? bodies.get(key) : undefined;
        if (body === undefined) {
          body = measure(id, await from.view(r.body), r.spec && "extrude" in r.spec ? outlineCurves(r.spec.extrude.profile, r.curves) : () => null);
          if (keep) bodies.set(key, body);
        }
        results[id] = r.warning ? { status: "built", body, warning: { cause: r.warning.cause, input: r.warning.sketch } } : { status: "built", body };
      }
    }
    return { order: build.order, results };
  }

  async function rebuild(): Promise<Rebuild> {
    if (fs.has("leak-bodies")) cache = new BodyCache(kernel);
    return read(await rebuildTimeline(state.doc, cache, kernel), cache, true);
  }

  return {
    kernel,
    initial: [{ op: { op: "add-preset", kind: "box", sizes: [40, 30, 20] }, ids: ["feature-1"] }],
    async apply(op) {
      const before = JSON.stringify(state);
      // The harness's own record counts too: a deleted circle's radius changes nothing in Design's data until it is drawn again.
      const was = save(state.doc) + JSON.stringify(state.meta);
      if (op.op === "undo" || op.op === "redo") {
        const [from, onto] = op.op === "undo" ? [undo, redo] : [redo, undo];
        const back = from.pop();
        if (back === undefined) return { kind: "unchanged" };
        onto.push(before);
        state = JSON.parse(back);
        return { kind: "done", ids: [] };
      }
      const r = edit(state, op);
      if ("kind" in r) {
        state = JSON.parse(before);
        return r;
      }
      const doc = fs.has("no-settle") ? r.state.doc : await settleKept(kernel, state.doc, r.state.doc);
      if (save(doc) + JSON.stringify(r.state.meta) === was) {
        state = JSON.parse(before);
        return { kind: "unchanged" };
      }
      undo.push(before);
      redo = [];
      state = { doc, meta: r.state.meta };
      return { kind: "done", ids: r.made };
    },
    rebuild,
    async rebuildFromScratch() {
      const fresh = new BodyCache(kernel);
      try {
        return await read(await rebuildTimeline(state.doc, fresh, kernel), fresh, false);
      } finally {
        await fresh.clear();
      }
    },
    save() {
      if (!fs.has("save-drops-kept")) return save(state.doc);
      const { kept: _, ...rest } = state.doc;
      return save(rest);
    },
    open(text) {
      let doc: DesignDocument;
      try {
        doc = projectFromJson(text, DESIGN).workspaces.design as DesignDocument;
      } catch (e) {
        if (NOTHING_BUILT.test(String(e))) return "nothing built";
        throw e;
      }
      state = { doc, meta: state.meta };
      undo = [];
      redo = [];
    },
    async resolve(name) {
      const r = await rebuild();
      const key = faceKey(name);
      for (const id of r.order) {
        const res = r.results[id];
        if (res.status === "built" && res.body) {
          const f = res.body.faces.find((x) => faceKey(x.name) === key);
          if (f) return f.name;
        }
      }
      return null;
    },
    async dispose() {
      await cache.clear();
    },
  };
}

/** A face name part from Design ("side:line-4", "top") as the model's FaceName; an unnamed face gets a name no model face has. */
function faceName(feature: string, part: string | null, index: number): FaceName {
  if (part === null) return { feature, role: "side", curve: `unnamed face ${index}` };
  const [role, curve] = part.split(":");
  return curve === undefined ? { feature, role: role as FaceRole } : { feature, role: role as FaceRole, curve: decodeURIComponent(curve) };
}

/** A body's volume, faces and edges in the model's terms, named as Design names them. */
function measure(feature: string, view: BodyView, curveOf: (boundary: number, piece: number) => string | null): ModelBody {
  const names = nameBody(feature, view, curveOf);
  const edges = edgeGeometry(view);
  return {
    volume: view.volume,
    faces: names.faces.map((part, f) => ({ name: faceName(feature, part, f), area: view.face_areas[f], centroid: view.face_centroids[f] })),
    edges: names.edges.map((part, e) => {
      const m = part === null ? null : /^(.*?)([>+])(.*)$/.exec(part);
      const name = m
        ? edgeName(faceName(feature, m[1], -1), faceName(feature, m[3], -1), m[2] === ">")
        : edgeName(faceName(feature, null, e), faceName(feature, null, e), false);
      return { name, length: edges[e].length, centroid: edges[e].centroid as [number, number, number] };
    }),
  };
}
