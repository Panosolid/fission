// The timeline rebuilt on the kernel's body store (step 24d2): every
// feature in order, each solid one's result a body handle or the reason it
// has none. A body is never changed in place, so a feature whose spec is
// the same as last time keeps its handle (`BodyCache`), and handles no
// feature holds any more are freed.
//
// The owner's rule (docs/progress/cad.md, packages/testing/src/
// timeline-model.ts, the model this is checked against): an extrude whose
// sketch is lost (deleted, or making no outline) builds from its kept
// shape, the sketch as it was just before the edit that lost it, with a
// warning naming the sketch; with no kept shape it fails with the cause.
// `settleKept` keeps and forgets those shapes after every edit. Causes and
// the curves at fault come from the kernel's `kind` and `inputs` (and
// sketch_outline's `invalid`), never from its words.
//
// Step 26e: suppressing an item greys everything built on it, all the way
// down, with no warning (Q3): an extrude of a suppressed sketch is greyed
// too, where until 26e it failed.
//
// Step 26c: a sketch item's result says where it lies (`placement`); a
// sketch on a face is placed on its face as built just before it (rule 8,
// face-sketch.ts), or held at its last placement with a plane warning when
// the face's name finds no face or two (rule 6), and greyed while its
// face's feature is suppressed or greyed (Q3). An extrude of a sketch not
// on XY, or flipped, is built placed (the kernel's frame and flip, 26b);
// one whose face sketch is held says its source is lost (rule 7).
// `settleKept` also keeps and forgets the held placements, judged with
// nothing suppressed and no marker, as the naming model's `settle` does.

import { KernelError, type BodyHandle, type BodySpec, type BodyView, type Feature, type KernelCalls, type KernelInput, type Outline, type Plane, type SketchXY } from "@fission/core";
import { buildingItems, isSketchExtrude, isSketchItem, keptOf, specOf, type DesignDocument, type KeptShape, type Sketch, type SketchPlane } from "./document.ts";
import { faceFeature, faceReference, frameNow, frameOf, isFaceSketch, planeWords, squared, type PlaneWarning, type SketchPlacement } from "./face-sketch.ts";
import { pinNow, pointWords, type PointWarning } from "./face-edges.ts";
import { featureNames, type BodyNames } from "./naming.ts";
import { resolveReference, sharedBy } from "./references.ts";
import { planeOf, sketchCurves } from "./sketch.ts";

/** Why an extrude's sketch gives it no outline (the model's causes). */
export type LostCause = "deleted-input" | "open-outline" | "invalid-outline";

/** The sketch's curve ids by kind, in the order sketchCurves lists them: how an outline's pieces name their curves. */
export interface CurveIds {
  line: string[];
  arc: string[];
  circle: string[];
}

/** An extrude built from its kept shape: which sketch, why, the kernel's words, and the curves it named. */
export interface KeptWarning {
  cause: LostCause;
  sketch: string;
  message: string;
  curves: string[];
}

export type FeatureResult =
  /**
   * A sketch item with where it lies (`placement`) and, for a sketch on a
   * face held at its last placement, why (`plane`); or a solid feature with
   * its body (and, for an extrude of a sketch, the curves it was built
   * from, and `source` when its sketch is held: rule 7).
   */
  | {
      status: "built";
      body?: BodyHandle;
      spec?: BodySpec;
      curves?: CurveIds;
      warning?: KeptWarning;
      placement?: SketchPlacement;
      plane?: PlaneWarning;
      source?: PlaneWarning & { sketch: string };
      /** A face sketch's pinned points that found their edge, where they are now (26f), and why the others are held. */
      pinned?: { point: string; at: SketchXY }[];
      points?: PointWarning;
    }
  | { status: "suppressed" }
  /** Built on a suppressed item (`by`), directly or through others (Q3; from 26e an extrude of a suppressed sketch too): off, with no warning, until it is unsuppressed. */
  | { status: "greyed"; by: string }
  | { status: "rolled-back" }
  /**
   * `cause` the model's (an input lost or failed) or "error":
   * the kernel refused something that isn't the sketch (a distance) or
   * isn't built yet (a sketch on another plane). `curves`: the sketch
   * curves at fault, when the kernel named them.
   */
  | { status: "failed"; cause: LostCause | "failed-input" | "error"; input?: string; message: string; curves?: string[] };

export interface TimelineBuild {
  order: string[];
  results: Record<string, FeatureResult>;
}

/**
 * Bodies kept in the kernel by spec: the same spec gives the same handle
 * without building again, and `keepOnly` frees every other one. One cache
 * per document view; `clear` frees all of it. Uses of it may overlap
 * (`using`: the app's rebuilds and its settling, 26g): nothing is freed
 * while one runs, so none frees a body another is using.
 */
const CLOSED = "Design was closed, so nothing more is built";

export class BodyCache {
  private bodies = new Map<string, { handle: BodyHandle; view?: Promise<BodyView> }>();
  /** Each kept body's key by its handle, so `view` finds it in one step (security audit S2). */
  private keys = new Map<BodyHandle, string>();
  /** Bodies asked of the kernel and not answered yet: the same spec asked again waits for the same answer, so asking ahead never builds twice. */
  private building = new Map<string, Promise<BodyHandle>>();
  /** Set by `close`: nothing more is built, and a body answered after it is freed at once, not kept. */
  private closed = false;
  /** Uses running now (`using`): while any is, `keepOnly` only says what to keep, and the last to end frees the rest. */
  private uses = 0;
  /** The bodies the last `keepOnly` kept (none before the first). */
  private wanted = new Set<BodyHandle>();
  private kernel: KernelCalls;
  constructor(kernel: KernelCalls) {
    this.kernel = kernel;
  }

  /** The body for `spec`, built once. */
  async body(spec: BodySpec): Promise<BodyHandle> {
    if (this.closed) throw new Error(CLOSED);
    const key = JSON.stringify(spec);
    const hit = this.bodies.get(key);
    if (hit) return hit.handle;
    const asked = this.building.get(key);
    if (asked) return asked;
    const build = this.kernel.call("body_build", spec).then((handle) => {
      if (this.closed) {
        // Asked before Design closed (a rebuild asks for every body at once): the kernel would keep it forever.
        void this.kernel.call("body_free", handle).catch(() => {});
        throw new Error(CLOSED);
      }
      this.bodies.set(key, { handle });
      this.keys.set(handle, key);
      return handle;
    });
    this.building.set(key, build);
    try {
      return await build;
    } finally {
      this.building.delete(key);
    }
  }

  /** A kept body's view, asked of the kernel once. */
  view(handle: BodyHandle): Promise<BodyView> {
    const key = this.keys.get(handle);
    const entry = key === undefined ? undefined : this.bodies.get(key);
    if (!entry) throw new Error(`body ${handle} is not in this cache`);
    entry.view ??= this.kernel.call("body_view", handle);
    return entry.view;
  }

  /** Frees every body but these: now, or once the last use running ends. */
  async keepOnly(handles: Iterable<BodyHandle>): Promise<void> {
    this.wanted = new Set(handles);
    await this.freeUnwanted();
  }

  /**
   * `use`, its bodies kept until it ends: then, with no other use running,
   * every body the last `keepOnly` didn't keep is freed (all it built
   * itself, unless a `keepOnly` kept them meanwhile).
   */
  async using<T>(use: () => Promise<T>): Promise<T> {
    this.uses++;
    try {
      return await use();
    } finally {
      this.uses--;
      await this.freeUnwanted();
    }
  }

  private async freeUnwanted(): Promise<void> {
    for (const [key, b] of this.bodies) {
      // A use began while the kernel freed the last one: its bodies (and these) wait for it to end.
      if (this.uses > 0) return;
      if (this.wanted.has(b.handle)) continue;
      this.bodies.delete(key);
      this.keys.delete(b.handle);
      await this.kernel.call("body_free", b.handle);
    }
  }

  clear(): Promise<void> {
    return this.keepOnly([]);
  }

  /** Design is gone for good: frees every body, and every one still being built once it is answered. */
  close(): Promise<void> {
    this.closed = true;
    return this.clear();
  }

  get size(): number {
    return this.bodies.size;
  }
}

const idsOf = (content: Pick<Sketch, "curves">): CurveIds => ({
  line: content.curves.filter((c) => c.kind === "line").map((c) => c.id),
  arc: content.curves.filter((c) => c.kind === "arc").map((c) => c.id),
  circle: content.curves.filter((c) => c.kind === "circle").map((c) => c.id),
});

/** The sketch curves a kernel answer names (line, arc and circle inputs), as ids. */
const namedCurves = (inputs: readonly KernelInput[], ids: CurveIds): string[] =>
  inputs.flatMap((i) => (i.input === "line" || i.input === "arc" || i.input === "circle" ? (ids[i.input][i.index] ?? []) : []));

/** What a sketch's points and curves make: the outline, or why there is none, from the kernel's fields. */
async function outlineOf(kernel: KernelCalls, content: KeptShape): Promise<{ outline: Outline } | { lost: "open-outline" | "invalid-outline"; message: string; curves: string[]; refused?: true }> {
  const ids = idsOf(content);
  const c = sketchCurves({ id: "", points: content.points, curves: content.curves, constraints: [] });
  try {
    const out = await kernel.call("sketch_outline", c.lines, c.circles, c.arcs);
    if ("closed" in out) return { outline: out.closed };
    if (out.invalid) return { lost: "invalid-outline", message: out.open, curves: namedCurves(out.invalid, ids) };
    return { lost: "open-outline", message: out.open, curves: [] };
  } catch (e) {
    // A curve the kernel refuses outright (a line of length 0): the outline is invalid there.
    if (e instanceof KernelError && e.kind === "invalid-input" && namedCurves(e.inputs, ids).length > 0) return { lost: "invalid-outline", message: e.message, curves: namedCurves(e.inputs, ids), refused: true };
    throw e;
  }
}

/** A sketch's content as it is now, or undefined when it is gone. */
const contentOf = (doc: DesignDocument, id: string): Sketch | undefined => doc.sketches.find((s) => s.id === id);

/** A document's timeline items and sketches by id (each id's first), so a rebuild looks each up in one step (security audit S2). */
export interface DocIndex {
  items: Map<string, Feature>;
  sketches: Map<string, Sketch>;
}

export function indexOf(doc: DesignDocument): DocIndex {
  const items = new Map<string, Feature>();
  for (const f of doc.timeline.features) if (!items.has(f.id)) items.set(f.id, f);
  const sketches = new Map<string, Sketch>();
  for (const s of doc.sketches) if (!sketches.has(s.id)) sketches.set(s.id, s);
  return { items, sketches };
}

/**
 * `kernel` with the outline of every sketch an extrude in `docs` uses (and
 * every kept shape) asked at once, before anything waits on one: asked one
 * after another, each waited a round trip to the kernel's worker, which a
 * busy page stretches to a frame, so a big file took minutes (security
 * audit S2). The same curves asked again get the same answer; the kernel's
 * work is the same, only the waiting goes.
 */
function outlinesAtOnce(kernel: KernelCalls, docs: DesignDocument[]): KernelCalls {
  const asked = new Map<string, ReturnType<KernelCalls["call"]>>();
  const ask = (args: unknown[]) => {
    const key = JSON.stringify(args);
    let answer = asked.get(key);
    if (answer === undefined) {
      answer = (kernel.call as (op: string, ...a: unknown[]) => ReturnType<KernelCalls["call"]>)("sketch_outline", ...args);
      answer.catch(() => {}); // a refusal is read by whoever asks for it; one nobody asks for is not an error
      asked.set(key, answer);
    }
    return answer;
  };
  const curvesOf = (content: KeptShape) => {
    const c = sketchCurves({ id: "", points: content.points, curves: content.curves, constraints: [] });
    return [c.lines, c.circles, c.arcs];
  };
  for (const doc of docs) {
    const { sketches } = indexOf(doc);
    for (const f of doc.timeline.features) {
      if (!isSketchExtrude(f)) continue;
      const content = sketches.get(f.intent.parameters.sketch as string);
      if (content !== undefined) ask(curvesOf(content));
      const kept = keptOf(doc, f);
      if (kept !== undefined) ask(curvesOf(kept));
    }
  }
  return { call: ((op: string, ...args: unknown[]) => (op === "sketch_outline" ? ask(args) : (kernel.call as (op: string, ...a: unknown[]) => unknown)(op, ...args))) as KernelCalls["call"] };
}

/** Whether a sketch makes an outline now (suppression and the marker don't count): the owner's "lost" is its opposite. */
async function makesOutline(kernel: KernelCalls, doc: DesignDocument, sketchId: string): Promise<boolean> {
  const content = contentOf(doc, sketchId);
  return content !== undefined && "outline" in (await outlineOf(kernel, content));
}

/**
 * The document after an edit from `before` to `after`, with the owner's
 * rule applied: an extrude whose sketch is lost in `after` keeps the
 * sketch's points and curves from `before` (if it made an outline there
 * and the extrude has no kept shape yet), and where it lay when not on XY;
 * one whose sketch makes an outline forgets its kept shape. From step 26c
 * a sketch on a face whose name finds no face or two in `after` holds the
 * placement it had in `before` (if it holds none yet), and forgets it once
 * its face is back; from 26f, each point pinned to its face's edge goes
 * where that edge is now, judged the same way (`followPins`), and stays
 * where it was when the edge is gone. The same rules as the model's `settle`: suppression
 * and the marker don't count, so a greyed sketch keeps nothing while its
 * face is there, and one whose face went while it was greyed keeps where
 * it was. `after` itself when nothing changes.
 *
 * Placing face sketches builds bodies: on `cache` when given (it may be
 * the one drawn from, even while it rebuilds: bodies built already are
 * reused, and the ones this settle built and no rebuild keeps are freed
 * after, `BodyCache.using`), else on one of its own, freed after.
 */
export async function settleKept(calls: KernelCalls, before: DesignDocument, after: DesignDocument, cache?: BodyCache): Promise<DesignDocument> {
  // Every outline `after` needs asked at once; `before`'s, needed only for a sketch just lost, as they come.
  const kernel = outlinesAtOnce(calls, [after]);
  const bodies = cache ?? new BodyCache(calls);
  const placed = (doc: DesignDocument) => placeOpen(doc, bodies, kernel);
  let was: Promise<Record<string, FeatureResult>> | undefined;
  /** Where a face sketch lay in `before` with nothing suppressed and no marker. */
  const wasAt = async (id: string) => {
    was ??= placed(before);
    const r = (await was)[id];
    return r?.status === "built" ? r.placement : undefined;
  };
  return bodies.using(async () => {
    const beforeItems = indexOf(before).items;
    const next: Record<string, KeptShape> = {};
    for (const f of after.timeline.features) {
      if (!isSketchExtrude(f)) continue;
      const sketch = f.intent.parameters.sketch as string;
      if (await makesOutline(kernel, after, sketch)) continue;
      const had = keptOf(after, f);
      const was = contentOf(before, sketch);
      if (had !== undefined) next[f.id] = had;
      else if (was !== undefined && (await makesOutline(kernel, before, sketch))) {
        const item = beforeItems.get(sketch)!;
        const placement = isFaceSketch(item) ? await wasAt(sketch) : (originPlacement(item) ?? undefined);
        next[f.id] = placement ? { points: was.points, curves: was.curves, placement } : { points: was.points, curves: was.curves };
      }
    }
    const { kept: old, ...rest } = after;
    let doc = after;
    if (JSON.stringify(old ?? {}) !== JSON.stringify(next)) doc = Object.keys(next).length === 0 ? rest : { ...rest, kept: next };
    const faces = doc.timeline.features.filter(isFaceSketch).length;
    if (faces === 0) return doc;
    // Held placements and followed points, decided on the document with its kept shapes settled, pass after pass on the
    // design the last pass made, until nothing changes: a sketch held, or a point followed, moves what is built on it, so
    // a sketch on that (and its points) is placed right only on the next pass (hunt 26g: one pass placed them on the
    // body built at the held sketch's first-drawn frame). Each pass settles one more sketch of a chain, so at most one
    // per face sketch, and a last to see nothing change.
    for (let pass = 0; pass <= faces; pass++) {
      const now = await placed(doc);
      let changed = false;
      const sketches: Sketch[] = [];
      for (const content of doc.sketches) {
        const r = now[content.id];
        if (content.face === undefined || r?.status !== "built") {
          sketches.push(content);
          continue;
        }
        const { held, ...face } = content.face;
        let keep = held;
        if (r.plane === undefined) keep = undefined;
        else if (held === undefined) keep = (await wasAt(content.id))?.plane;
        changed ||= keep !== held;
        const settled = keep === held ? content : { ...content, face: keep ? { ...face, held: keep } : face };
        // Step 26f: each pinned point that found its edge goes where the edge is now; one that didn't stays where it was.
        const followed = followedSketch(settled, r);
        changed ||= followed !== settled;
        sketches.push(followed);
      }
      if (!changed) return doc;
      doc = { ...doc, sketches };
    }
    return doc;
  });
}

/**
 * Every item of `doc` up to its last sketch on a face, built with nothing
 * suppressed and no marker, without freeing anything: where each face
 * sketch would lie with everything on (none for a document without one).
 */
async function placeOpen(doc: DesignDocument, cache: BodyCache, kernel: KernelCalls): Promise<Record<string, FeatureResult>> {
  const last = doc.timeline.features.filter(isFaceSketch).at(-1);
  if (last === undefined) return {};
  const features = doc.timeline.features.map((f) => (f.suppressed ? { ...f, suppressed: false } : f));
  return (await buildTimeline({ ...doc, timeline: { features, marker: last.id } }, cache, kernel)).results;
}

/**
 * Rebuilds every feature in order with bodies from `cache`, then frees
 * every body no feature holds. Sketch items build no body; a solid
 * feature's result is its handle or why it has none.
 */
export async function rebuildTimeline(doc: DesignDocument, cache: BodyCache, calls: KernelCalls): Promise<TimelineBuild> {
  return cache.using(async () => {
    const build = await buildTimeline(doc, cache, calls);
    await cache.keepOnly(handlesOf(build.results));
    return build;
  });
}

/** The bodies a rebuild's results hold. */
const handlesOf = (results: Record<string, FeatureResult>): BodyHandle[] => Object.values(results).flatMap((r) => (r.status === "built" && r.body !== undefined ? [r.body] : []));

/** `rebuildTimeline` without freeing anything: every result, its bodies in `cache` with whatever else is there. */
async function buildTimeline(doc: DesignDocument, cache: BodyCache, calls: KernelCalls): Promise<TimelineBuild> {
  const kernel = outlinesAtOnce(calls, [doc]);
  const index = indexOf(doc);
  bodiesAtOnce(doc, cache, kernel, index);
  // No prototype: every id is an entry, even one named like an object's own (results["__proto__"], re-check N1).
  const results: Record<string, FeatureResult> = Object.create(null);
  const { features, marker } = doc.timeline;
  let rolled = marker === "start";
  for (const f of features) {
    if (rolled) results[f.id] = { status: "rolled-back" };
    else if (f.suppressed) results[f.id] = { status: "suppressed" };
    else results[f.id] = await buildFeature(doc, f, results, cache, kernel, index);
    if (marker === f.id) rolled = true;
  }
  return { order: features.map((f) => f.id), results };
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Asks the kernel for every body the loop below will build, at once and
 * in timeline order, without waiting: built one after another, each waited
 * a round trip, so a big file took minutes (security audit S2). Only the
 * items that build (`buildingItems`) with a spec that reads are asked, the
 * very bodies `buildFeature` asks for, so nothing extra is built; the loop
 * then finds each one asked or answered (`BodyCache.body`). A refusal is
 * read there, with its words.
 */
function bodiesAtOnce(doc: DesignDocument, cache: BodyCache, kernel: KernelCalls, index: DocIndex): void {
  const building = buildingItems(doc);
  for (const f of doc.timeline.features) {
    if (isSketchItem(f) || !building.has(f)) continue;
    // A sketch on a face is placed on its face as built, so its extrude waits for the loop.
    const on = isSketchExtrude(f) ? index.items.get(f.intent.parameters.sketch as string) : undefined;
    if (on !== undefined && isFaceSketch(on)) continue;
    const ask = isSketchExtrude(f)
      ? extrudeSpec(kernel, doc, f, index, on && originPlacement(on)).then((made) => ("status" in made ? undefined : cache.body(made.spec)))
      : Promise.resolve().then(() => cache.body(specOf(doc, f)));
    ask.catch(() => {});
  }
}

/** Where a sketch on an origin plane lies; null for XY, where an extrude is built as before 26c, with no frame. */
const originPlacement = (item: Feature): SketchPlacement | null => (item.intent.parameters.plane === "XY" ? null : { plane: planeOf(item.intent.parameters.plane as SketchPlane), side: 1 });

const XY_PLACEMENT: SketchPlacement = { plane: planeOf("XY"), side: 1 };

/**
 * A sketch item's result: where it lies. On an origin plane, that plane.
 * On a face (rule 8): greyed while the face's feature is suppressed or
 * greyed (Q3); else the face its name finds on that feature's body, as
 * built just before, with the frame drawn turned onto it (`frameNow`);
 * else held (the placement kept by `settleKept`, or the frame as drawn
 * when a file has none) with "plane lost" (no face of that name, the
 * feature gone or not built, or the face no longer flat) or "plane
 * ambiguous" (two or more faces would have the name; never one of them).
 */
async function placeSketch(f: Feature, done: Record<string, FeatureResult>, cache: BodyCache, index: DocIndex): Promise<FeatureResult> {
  if (!isFaceSketch(f)) return { status: "built", placement: originPlacement(f) ?? XY_PLACEMENT };
  const plane = f.intent.parameters.plane as string;
  const p = index.sketches.get(f.id)!.face!;
  const featureId = faceFeature(plane)!;
  const on = done[featureId];
  if (on?.status === "suppressed") return { status: "greyed", by: featureId };
  if (on?.status === "greyed") return { status: "greyed", by: on.by };
  let cause: PlaneWarning["cause"] = "plane-lost";
  if (on?.status === "built" && on.body !== undefined && on.spec !== undefined) {
    const view = await cache.view(on.body);
    const names = featureNames(featureId, { spec: on.spec, curves: on.curves }, view);
    const ref = faceReference(plane);
    const face = resolveReference(ref, names);
    const outward = face === null ? null : view.face_normals[face];
    if (face !== null && outward) {
      const placement = { plane: frameNow(squared(p.frame)!, outward, view.face_centroids[face]), side: p.side };
      return { status: "built", placement, ...followPins(f, index, view, names, placement.plane) };
    }
    if (sharedBy(ref, names) > 1) cause = "plane-ambiguous";
  }
  return { status: "built", placement: { plane: squared(p.held ?? p.frame)!, side: p.side }, plane: { cause, face: plane, message: planeWords(cause, f.provenance.self.label) } };
}

/**
 * A face sketch's pinned points on its face's body as built now (step 26f,
 * Q4): each found one where its vertex or edge is now (`pinned`; the
 * sketch's content in `index` takes those places, so the extrude built
 * from it uses them), each one not found left where it was, counted in a
 * warning ("point-lost" when any lost its edge, else "point-ambiguous").
 * Nothing for a sketch without pins.
 */
/** Sketch `content` with each of its pinned points where `r` (its result in a rebuild) found it (26f), or `content` itself when none moved. */
export function followedSketch(content: Sketch, r: FeatureResult | undefined): Sketch {
  if (r?.status !== "built" || !r.pinned) return content;
  const to = new Map(r.pinned.map((p) => [p.point, p.at]));
  if (!content.points.some((p) => to.has(p.id) && (to.get(p.id)![0] !== p.x || to.get(p.id)![1] !== p.y))) return content;
  return { ...content, points: content.points.map((p) => (to.has(p.id) ? { ...p, x: to.get(p.id)![0], y: to.get(p.id)![1] } : p)) };
}

/**
 * `doc` with every pinned point where `build` (a rebuild of `doc`) found
 * it (26f), or `doc` itself when none moved: what the app takes into the
 * edit's undo step once the edit has rebuilt, so the sketch is drawn, and
 * a point whose edge goes later held, where the point followed to.
 */
export function followedDoc(doc: DesignDocument, build: TimelineBuild): DesignDocument {
  let moved = false;
  const sketches = doc.sketches.map((s) => {
    const next = followedSketch(s, build.results[s.id]);
    moved ||= next !== s;
    return next;
  });
  return moved ? { ...doc, sketches } : doc;
}

function followPins(f: Feature, index: DocIndex, view: BodyView, names: BodyNames, plane: Plane): { pinned?: { point: string; at: SketchXY }[]; points?: PointWarning } {
  const content = index.sketches.get(f.id)!;
  if (!content.pins) return {};
  const pinned: { point: string; at: SketchXY }[] = [];
  const held = { "point-lost": 0, "point-ambiguous": 0 };
  for (const pin of content.pins) {
    const now = pinNow(pin, view, names, plane);
    if ("at" in now) pinned.push({ point: pin.point, at: now.at });
    else held[now.cause]++;
  }
  const at = new Map(pinned.map((p) => [p.point, p.at]));
  if (content.points.some((p) => at.has(p.id) && (at.get(p.id)![0] !== p.x || at.get(p.id)![1] !== p.y)))
    index.sketches.set(f.id, { ...content, points: content.points.map((p) => (at.has(p.id) ? { ...p, x: at.get(p.id)![0], y: at.get(p.id)![1] } : p)) });
  const n = held["point-lost"] + held["point-ambiguous"];
  if (n === 0) return { pinned };
  const label = f.provenance.self.label;
  const words = (["point-lost", "point-ambiguous"] as const).filter((c) => held[c] > 0).map((c) => pointWords(c, held[c], label));
  return { pinned, points: { cause: held["point-lost"] > 0 ? "point-lost" : "point-ambiguous", points: n, message: words.join(". ") } };
}

async function buildFeature(doc: DesignDocument, f: Feature, done: Record<string, FeatureResult>, cache: BodyCache, kernel: KernelCalls, index: DocIndex): Promise<FeatureResult> {
  try {
    if (isSketchItem(f)) return await placeSketch(f, done, cache, index);
    if (!isSketchExtrude(f)) {
      const spec = specOf(doc, f);
      return { status: "built", body: await cache.body(spec), spec };
    }
    const sketchId = f.intent.parameters.sketch as string;
    const item = index.items.get(sketchId);
    const input = done[sketchId];
    // Q3, unified in 26e: built on a suppressed sketch, or on one greyed, it is greyed too, with no warning.
    if (item !== undefined && input?.status === "suppressed") return { status: "greyed", by: sketchId };
    if (item !== undefined && input?.status === "greyed") return { status: "greyed", by: input.by };
    if (item !== undefined && input?.status !== "built") return { status: "failed", cause: "failed-input", input: sketchId, message: `${item.provenance.self.label} is not built` };
    // A face sketch's placement is the rebuild's; an origin plane's, extrudeSpec's own.
    const placed = item !== undefined && isFaceSketch(item) && input?.status === "built" ? input.placement : undefined;
    const made = await extrudeSpec(kernel, doc, f, index, placed);
    if ("status" in made) return made;
    const lost = input?.status === "built" ? input.plane : undefined;
    const source = lost && { ...lost, sketch: sketchId, message: `${f.provenance.self.label}'s source is lost: ${item!.provenance.self.label}'s plane is ${lost.cause === "plane-lost" ? "lost" : "ambiguous"}, so it stays where it was` };
    return { status: "built", body: await cache.body(made.spec), ...made, ...(source ? { source } : {}) };
  } catch (e) {
    return { status: "failed", cause: "error", message: words(e) };
  }
}

/** What an extrude of a sketch is built from, and the warning when that is its kept shape. */
export interface ExtrudeSpec {
  spec: BodySpec;
  curves: CurveIds;
  warning?: KeptWarning;
}

/**
 * An extrude of a sketch's spec by the owner's rule: its sketch's outline
 * now, else its kept shape with a warning, else failed with the cause.
 * Suppression and the marker are the timeline's (`rebuildTimeline`); this
 * is the one place the rule is applied, so Design's view, the Extrude
 * panel and what other workspaces are handed (`featureSpec`) all agree.
 */
export async function extrudeSpec(
  kernel: KernelCalls,
  doc: DesignDocument,
  f: Feature,
  index: DocIndex = indexOf(doc),
  placed?: SketchPlacement | null,
): Promise<ExtrudeSpec | Extract<FeatureResult, { status: "failed" }>> {
  const sketchId = f.intent.parameters.sketch as string;
  const distance = f.intent.parameters.distance as number;
  const flip = f.intent.parameters.flip === true;
  const item = index.items.get(sketchId);
  const lost = (cause: LostCause, message: string, curves: string[]) => keptSpec(keptOf(doc, f), distance, flip, { cause, sketch: sketchId, message, curves }, kernel);
  // The extrude's provenance names the sketch it was made from, so a deleted one is still called by its label.
  if (item === undefined) return await lost("deleted-input", `${f.provenance.from.find((r) => r.id === sketchId)?.label ?? sketchId} was deleted`, []);
  const content = index.sketches.get(sketchId)!;
  const out = await outlineOf(kernel, content);
  // A curve the kernel refused is named in its own words ("line 1 must be …"), as before 24d2; an outline that doesn't close says whose.
  if (!("outline" in out)) return await lost(out.lost, out.refused ? out.message : `${item.provenance.self.label} has no closed outline: ${out.message}`, out.curves);
  // Where the sketch lies: given by the rebuild, an origin plane's, or (asked from outside a rebuild) its face's as the timeline builds it.
  const at = placed !== undefined ? placed : isFaceSketch(item) ? await placementOf(kernel, doc, sketchId) : originPlacement(item);
  return { spec: placedSpec(out.outline, distance, at, flip), curves: idsOf(content) };
}

/**
 * An extrude's spec: on XY (`at` null) as before 26c, with no frame unless
 * flipped; else in the sketch's frame (squared up, face-sketch.ts), going
 * the way the sketch faces (rule 2), the other way when flipped.
 */
function placedSpec(profile: Outline, distance: number, at: SketchPlacement | null, flip: boolean): BodySpec {
  if (at === null) return { extrude: flip ? { profile, distance, flip: true } : { profile, distance } };
  const back = (at.side === -1) !== flip;
  return { extrude: { profile, distance, frame: frameOf(squared(at.plane)!), ...(back ? { flip: true } : {}) } };
}

/**
 * Where a sketch lies in `doc` as its timeline builds up to it (for an
 * extrude asked for outside a rebuild: featureSpec, the Extrude panel's
 * check), built on a cache of its own that is freed after.
 */
async function placementOf(kernel: KernelCalls, doc: DesignDocument, sketchId: string): Promise<SketchPlacement> {
  const cache = new BodyCache(kernel);
  try {
    const r = (await buildTimeline({ ...doc, timeline: { ...doc.timeline, marker: sketchId } }, cache, kernel)).results[sketchId];
    if (r?.status !== "built" || r.placement === undefined) throw new Error(`${sketchId} is not built, so it lies nowhere`);
    return r.placement;
  } finally {
    await cache.clear();
  }
}

/** An extrude whose sketch is lost: its kept shape with the warning, or failed with the cause when it has none. */
async function keptSpec(kept: KeptShape | undefined, distance: number, flip: boolean, warning: KeptWarning, kernel: KernelCalls): Promise<ExtrudeSpec | Extract<FeatureResult, { status: "failed" }>> {
  if (kept === undefined) return { status: "failed", cause: warning.cause, input: warning.sketch, message: warning.message, curves: warning.curves };
  const out = await outlineOf(kernel, kept);
  // A kept shape made an outline when it was kept; one that doesn't (a hand-edited file) fails the extrude with the kernel's words.
  if (!("outline" in out)) return { status: "failed", cause: "error", message: `the kept shape makes no outline: ${out.message}` };
  return { spec: placedSpec(out.outline, distance, kept.placement ?? null, flip), curves: idsOf(kept), warning };
}
