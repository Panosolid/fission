// Design's sketch on a face as a `NamingSubject` on the real kernel (step
// 26c), for the naming harness (naming-session.ts) to check against the
// model (naming-model.ts): every one of Ben's Fusion answers that holds
// without a cut, and seeded sessions.
//
// Each model edit is made with Design's own functions, as the app's would
// be: an outline drawn with addSketch and drawLine as a chain (line k from
// corner k to corner k + 1, each corner one shared point), moved with
// movePoint and, with another number of corners, deleted with deleteCurve
// and drawn again with new lines; extrudes with extrudeSketch, a negative
// distance being Design's Flip (setExtrudeFlip) of the distance's size; a
// circle on a face drawn with addFaceSketch, its frame worked out by
// drawnOnFace on the face the scene shows (found by its name with
// findInScene, as a pick would land), and drawCircle; the timeline edits
// with deleteItem, reorderItem and suppressItem. A circle's radius (no edit
// yet) is written into the data. After every edit Design's `settleKept`
// keeps and forgets shapes and held placements, on a cache of its own; the
// undo history is whole snapshots, as the app's is.
//
// A read is Design's `rebuildTimeline` on the body store, in the model's
// terms: each sketch item's placement and plane warning, each extrude's
// volume and centroid from the bodies the scene shows (`shownBodies`; a
// prism's centroid is halfway between its caps' centroids, the kernel's
// exact face centroids), its kept-shape or source-lost warning, and which
// items are suppressed or greyed. `faults` plants bugs in the subject to
// prove the checks catch them; bugs in Design's own code are planted by
// planted/run.ts (planted/model-faults.ts, `NAMING_PLANTS`).

import { emptyProject, projectFromJson, projectToJson, type BodyView, type KernelCalls, type StableId } from "@fission/core";
import {
  addFaceSketch,
  addSketch,
  BodyCache,
  deleteCurve,
  deleteItem,
  drawCircle,
  drawLine,
  drawnOnFace,
  extrudeSketch,
  faceFeature,
  facePlane,
  findInScene,
  joinBodies,
  movePoint,
  pinNewPoints,
  planDelete,
  readDesignDocument,
  readDesignReference,
  rebuildTimeline,
  reorderItem,
  sceneHit,
  setExtrudeDistance,
  setExtrudeFlip,
  settleKept,
  shownBodies,
  sketchEdgeTargets,
  suppressItem,
  type DesignDocument,
  type EdgeTarget,
  type LineEnd,
  type TimelineBuild,
} from "@fission/design";
import type { Point } from "./timeline-model.ts";
import type { FaceName, NamingApplied, NamingOp, NamingRebuild, NamingResult, NamingWarning, PinName, Vec3 } from "./naming-model.ts";
import type { NamingSubject } from "./naming-session.ts";

/** Bugs planted in the subject's side, each caught by a check (journeys/naming.journey.ts). */
export type NamingDesignFault =
  /** No settle: no kept shapes and no held placements, the rule before 24d2. */
  | "no-settle"
  /** The file forgets where face sketches were drawn. */
  | "save-drops-face"
  /** Rebuilds never free a body (caught by body_count, not the session). */
  | "leak-bodies";

export const NAMING_DESIGN_FAULTS: readonly NamingDesignFault[] = ["no-settle", "save-drops-face", "leak-bodies"];

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const save = (doc: DesignDocument) => projectToJson({ ...emptyProject("Naming"), workspaces: { design: doc } });

/** The harness's record of each sketch it drew: an outline's corner points and lines in order, or a face sketch's circle and its centre. */
type Meta = Record<string, { corners: string[]; lines: string[] } | { circle: string; centre: string }>;

interface State {
  doc: DesignDocument;
  meta: Meta;
}

export interface NamingDesignSubject extends NamingSubject {
  /** Frees every body the subject keeps. */
  dispose(): Promise<void>;
}

/** A prism's centroid: halfway between its two caps' centroids (any straight extrude, a cylinder too), from the kernel's exact face centroids. */
export function prismCentroid(view: BodyView): Vec3 {
  const cap = (role: "start" | "end") => {
    const f = view.face_roles.findIndex((r) => r?.role === role);
    if (f < 0) throw new Error(`the body has no ${role} cap`);
    return view.face_centroids[f];
  };
  const [a, b] = [cap("start"), cap("end")];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

/** A face sketch's plane in the model's terms: its feature, and its cap or the line its side was swept from. */
export function faceNameOf(plane: string): FaceName {
  const r = readDesignReference({ kind: "face", id: plane as StableId });
  const feature = faceFeature(plane);
  if (r === null || feature === null) throw new Error(`${plane} is not a face's name`);
  const [role, line] = r.part!.split(":");
  if (role === "side" && line !== undefined) return { feature, role: "side", line: decodeURIComponent(line) };
  if (role === "start" || role === "end") return { feature, role };
  throw new Error(`${plane} names a face the model has no name for`);
}

/** The plane a model face name is, as Design writes it. */
const planeOfFace = (f: FaceName) => facePlane(encodeURIComponent(f.feature), f.role === "side" ? `side:${encodeURIComponent(f.line)}` : f.role);

/**
 * Whether target `t` is the model's pin on cap `face` (rule 10): a corner's
 * vertex is named by the edges meeting there, among them the cap's edges
 * along both lines; a side's middle by the cap's edge along its line
 * (face-edges.ts; an edge between a cap and a side is "<cap>+side:<line>"
 * or "side:<line>+<cap>", sorted).
 */
function pinMatches(t: EdgeTarget, face: FaceName, pin: PinName): boolean {
  if (face.role === "side") return false;
  const capEdge = (line: string) => [face.role, `side:${encodeURIComponent(line)}`].sort().join("+");
  if (pin.at === "middle") return t.kind === "midpoint" && t.name === capEdge(pin.line);
  const parts = t.name.split("&");
  return t.kind === "endpoint" && parts.includes(capEdge(pin.before)) && parts.includes(capEdge(pin.after));
}

/** Design on `kernel` as a subject without cuts (the circle extruded as a new body), with bugs planted. */
export function namingDesignSubject(kernel: KernelCalls, faults: Iterable<NamingDesignFault> = []): NamingDesignSubject {
  const fs = new Set(faults);
  let state: State = { doc: { version: 3, nextId: 1, profiles: [], sketches: [], timeline: { features: [] } }, meta: {} };
  let undo: string[] = [];
  let redo: string[] = [];
  let cache = new BodyCache(kernel);

  async function build(doc: DesignDocument): Promise<TimelineBuild> {
    if (fs.has("leak-bodies")) cache = new BodyCache(kernel);
    return rebuildTimeline(doc, cache, kernel);
  }

  /** Draws an outline as a chain: line k from corner k to corner k + 1, each corner one point. */
  function drawOutline(doc: DesignDocument, sketch: string, corners: readonly Point[]): { doc: DesignDocument; corners: string[]; lines: string[] } {
    const points: string[] = [];
    const lines: string[] = [];
    for (let k = 0; k < corners.length; k++) {
      const from: LineEnd = points[k] ?? [corners[k][0], corners[k][1]];
      const to: LineEnd = k + 1 === corners.length ? points[0] : [corners[k + 1][0], corners[k + 1][1]];
      const drawn = drawLine(doc, sketch, from, to);
      doc = drawn.doc;
      const line = doc.sketches.find((s) => s.id === sketch)!.curves.find((c) => c.id === drawn.id)!;
      if (line.kind !== "line") throw new Error("harness: drawLine drew no line");
      points[k] = line.start;
      if (k + 1 < corners.length) points[k + 1] = line.end;
      lines.push(drawn.id);
    }
    return { doc, corners: points, lines };
  }

  async function edit(s: State, op: Exclude<NamingOp, { op: "undo" | "redo" }>): Promise<{ state: State; made: string[] } | NamingApplied> {
    let doc = s.doc;
    const meta: Meta = JSON.parse(JSON.stringify(s.meta));
    switch (op.op) {
      case "add-sketch": {
        const made = addSketch(doc);
        const o = drawOutline(made.doc, made.id, op.corners);
        meta[made.id] = { corners: o.corners, lines: o.lines };
        return { state: { doc: o.doc, meta }, made: [made.id, ...o.lines] };
      }
      case "add-extrude":
      case "add-face-extrude": {
        const e = extrudeSketch(doc, op.sketch, Math.abs(op.distance), op.distance < 0);
        return { state: { doc: e.doc, meta }, made: [e.id] };
      }
      case "add-face-sketch": {
        // As a pick lands: the face found by its name on the scene the app draws, its frame worked out from the kernel's face.
        const plane = planeOfFace(op.face);
        const b = await build(doc);
        const scene = joinBodies(await shownBodies(doc, b, cache));
        const found = findInScene({ kind: "face", id: plane as StableId }, scene);
        if (found.status !== "found") throw new Error(`harness: no single face ${plane} to sketch on (${found.status})`);
        const hit = sceneHit(scene, "face", found.index)!;
        const drawn = drawnOnFace(scene.bodies[hit.body].view, hit.index);
        if (drawn === null) throw new Error(`harness: ${plane} is curved`);
        const made = addFaceSketch(doc, { plane, feature: op.face.feature }, drawn);
        // Step 26f: a pinned centre lands where the snap would put it, on the target the app offers, and is pinned as a click there is.
        const targets = op.pin ? await edgeTargetsOf(made.doc, made.id) : [];
        const target = op.pin ? targets.find((t) => pinMatches(t, op.face, op.pin!)) : undefined;
        if (op.pin && target === undefined) throw new Error(`harness: Design offers no ${JSON.stringify(op.pin)} on ${plane}`);
        const c = drawCircle(made.doc, made.id, target ? target.at : [op.centre[0], op.centre[1]], op.radius);
        const circle = c.doc.sketches.find((x) => x.id === made.id)!.curves.find((x) => x.id === c.id)!;
        if (circle.kind !== "circle") throw new Error("harness: drawCircle drew no circle");
        meta[made.id] = { circle: c.id, centre: circle.centre };
        return { state: { doc: pinNewPoints(made.doc, c.doc, made.id, targets), meta }, made: [made.id] };
      }
      case "add-cut":
      case "set-depth":
        throw new Error("harness: Design has no cut until booleans (44/48)");
      case "set-corners":
      case "move-corner": {
        const m = meta[op.sketch];
        if (!("corners" in m)) throw new Error(`harness: ${op.sketch} is not an outline`);
        const corners: Point[] = op.op === "set-corners" ? op.corners : [];
        if (op.op === "move-corner") {
          doc = movePoint(doc, op.sketch, m.corners[op.corner], op.to[0], op.to[1]);
          return { state: { doc, meta }, made: [] };
        }
        if (corners.length === m.corners.length) {
          corners.forEach((p, k) => (doc = movePoint(doc, op.sketch, m.corners[k], p[0], p[1])));
          return { state: { doc, meta }, made: [] };
        }
        // Another number of corners: the outline drawn again, with new lines.
        for (const line of m.lines) doc = deleteCurve(doc, op.sketch, line);
        const o = drawOutline(doc, op.sketch, corners);
        meta[op.sketch] = { corners: o.corners, lines: o.lines };
        return { state: { doc: o.doc, meta }, made: o.lines };
      }
      case "set-distance":
        doc = setExtrudeFlip(setExtrudeDistance(doc, Math.abs(op.value), op.item), op.value < 0, op.item);
        return { state: { doc, meta }, made: [] };
      case "set-circle": {
        const m = meta[op.sketch];
        if (!("circle" in m)) throw new Error(`harness: ${op.sketch} has no circle`);
        doc = movePoint(doc, op.sketch, m.centre, op.centre[0], op.centre[1]);
        // A circle's radius has no edit yet: written into the data, as a later Panosolid would.
        const sketches = doc.sketches.map((x) => (x.id === op.sketch ? { ...x, curves: x.curves.map((c) => (c.id === m.circle && c.kind === "circle" ? { ...c, radius: op.radius } : c)) } : x));
        return { state: { doc: { ...doc, sketches }, meta }, made: [] };
      }
      case "suppress":
        return { state: { doc: suppressItem(doc, op.item, op.on), meta }, made: [] };
      case "delete":
        return { state: { doc: deleteItem(doc, op.item), meta }, made: [] };
      case "reorder": {
        const r = reorderItem(doc, op.item, op.to);
        if ("refused" in r) return { kind: "refused", cause: r.refused };
        return { state: { doc: r.doc, meta }, made: [] };
      }
    }
  }

  /** What a pointer on sketch `id` may snap to on its face's edges, as the app works it out: on the scene drawn, where the rebuild placed the sketch. */
  async function edgeTargetsOf(doc: DesignDocument, id: string): Promise<EdgeTarget[]> {
    const b = await build(doc);
    const scene = joinBodies(await shownBodies(doc, b, cache));
    const r = b.results[id];
    return sketchEdgeTargets(doc, id, scene, r?.status === "built" ? r.placement?.plane : undefined);
  }

  /** The rebuild in the model's terms, bodies read from the scene the app draws. */
  async function read(): Promise<NamingRebuild> {
    const doc = state.doc;
    const b = await build(doc);
    const views = new Map((await shownBodies(doc, b, cache)).map((s) => [s.feature, s.view]));
    const results: Record<string, NamingResult> = {};
    const bodies: Record<string, number> = {};
    for (const id of b.order) {
      const r = b.results[id];
      if (r.status === "suppressed" || r.status === "greyed") results[id] = { kind: r.status };
      else if (r.status === "rolled-back") throw new Error(`harness: ${id} is rolled back, but the harness never moves the marker`);
      else if (r.status === "failed") results[id] = { kind: "solid", volume: Number.NaN, centroid: [Number.NaN, Number.NaN, Number.NaN], warning: { cause: "deleted-input", input: `failed: ${r.message}` } };
      else if (r.placement !== undefined) {
        const p = r.placement.plane;
        // A pin's warning in the model's terms by its cause (the harness compares no more); "point-ambiguous" never matches the model, which has none.
        const warning: NamingWarning | undefined = r.plane ? { cause: r.plane.cause, face: faceNameOf(r.plane.face) } : r.points ? ({ cause: r.points.cause, pin: { at: "middle", line: "" } } as NamingWarning) : undefined;
        results[id] = { kind: "sketch", placement: { origin: p.origin, x: p.xAxis, normal: p.normal, side: r.placement.side }, ...(warning ? { warning } : {}) };
      } else {
        const view = views.get(id);
        if (view === undefined) throw new Error(`harness: ${id} built a body the scene doesn't show`);
        const warning: NamingWarning | undefined = r.warning ? { cause: "deleted-input", input: r.warning.sketch } : r.source ? { cause: "source-lost", input: r.source.sketch } : undefined;
        results[id] = { kind: "solid", volume: view.volume, centroid: prismCentroid(view), ...(warning ? { warning } : {}) };
        bodies[id] = view.volume;
      }
    }
    return { order: b.order, results, bodies };
  }

  return {
    cuts: false,
    async apply(op) {
      const before = JSON.stringify(state);
      if (op.op === "undo" || op.op === "redo") {
        const [from, onto] = op.op === "undo" ? [undo, redo] : [redo, undo];
        const back = from.pop();
        if (back === undefined) return { kind: "unchanged" };
        onto.push(before);
        state = JSON.parse(back);
        return { kind: "done", ids: [] };
      }
      const r = await edit(state, op);
      if ("kind" in r) return r;
      const doc = fs.has("no-settle") ? r.state.doc : await settleKept(kernel, state.doc, r.state.doc, cache);
      if (save(doc) === save(state.doc)) return { kind: "unchanged" };
      undo.push(before);
      redo = [];
      state = { doc, meta: r.state.meta };
      return { kind: "done", ids: r.made };
    },
    async planDelete(item) {
      const plan = await planDelete(kernel, state.doc, item);
      const left = new Set(plan.next.timeline.features.map((f) => f.id));
      return { ask: plan.ask !== null, removes: state.doc.timeline.features.filter((f) => !left.has(f.id)).map((f) => f.id) };
    },
    read,
    saveOpen() {
      let doc = state.doc;
      // Planted bug: the file forgets where each face sketch was drawn, so it opens drawn on the ground plane.
      if (fs.has("save-drops-face")) doc = { ...doc, sketches: doc.sketches.map((s) => (s.face ? { ...s, face: { frame: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: s.face.side } } : s)) };
      state = { doc: projectFromJson(save(doc), DESIGN).workspaces.design as DesignDocument, meta: state.meta };
    },
    async dispose() {
      await cache.clear();
    },
  };
}
