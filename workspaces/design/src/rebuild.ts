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

import { KernelError, type BodyHandle, type BodySpec, type BodyView, type Feature, type KernelCalls, type KernelInput, type Outline } from "@fission/core";
import { isSketchExtrude, isSketchItem, keptOf, specOf, type DesignDocument, type KeptShape, type Sketch } from "./document.ts";
import { sketchCurves } from "./sketch.ts";

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
  /** A sketch item, or a solid feature with its body (and, for an extrude of a sketch, the curves it was built from). */
  | { status: "built"; body?: BodyHandle; spec?: BodySpec; curves?: CurveIds; warning?: KeptWarning }
  | { status: "suppressed" }
  | { status: "rolled-back" }
  /**
   * `cause` the model's (an input lost, suppressed or failed) or "error":
   * the kernel refused something that isn't the sketch (a distance) or
   * isn't built yet (a sketch on another plane). `curves`: the sketch
   * curves at fault, when the kernel named them.
   */
  | { status: "failed"; cause: LostCause | "suppressed-input" | "failed-input" | "error"; input?: string; message: string; curves?: string[] };

export interface TimelineBuild {
  order: string[];
  results: Record<string, FeatureResult>;
}

/**
 * Bodies kept in the kernel by spec: the same spec gives the same handle
 * without building again, and `keepOnly` frees every other one. One cache
 * per document view; `clear` frees all of it.
 */
export class BodyCache {
  private bodies = new Map<string, { handle: BodyHandle; view?: Promise<BodyView> }>();
  private kernel: KernelCalls;
  constructor(kernel: KernelCalls) {
    this.kernel = kernel;
  }

  /** The body for `spec`, built once. */
  async body(spec: BodySpec): Promise<BodyHandle> {
    const key = JSON.stringify(spec);
    const hit = this.bodies.get(key);
    if (hit) return hit.handle;
    const handle = await this.kernel.call("body_build", spec);
    this.bodies.set(key, { handle });
    return handle;
  }

  /** A kept body's view, asked of the kernel once. */
  view(handle: BodyHandle): Promise<BodyView> {
    const entry = [...this.bodies.values()].find((b) => b.handle === handle);
    if (!entry) throw new Error(`body ${handle} is not in this cache`);
    entry.view ??= this.kernel.call("body_view", handle);
    return entry.view;
  }

  /** Frees every body but these. */
  async keepOnly(handles: Iterable<BodyHandle>): Promise<void> {
    const keep = new Set(handles);
    for (const [key, b] of this.bodies)
      if (!keep.has(b.handle)) {
        this.bodies.delete(key);
        await this.kernel.call("body_free", b.handle);
      }
  }

  clear(): Promise<void> {
    return this.keepOnly([]);
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
async function outlineOf(kernel: KernelCalls, content: KeptShape): Promise<{ outline: Outline } | { lost: "open-outline" | "invalid-outline"; message: string; curves: string[] }> {
  const ids = idsOf(content);
  const c = sketchCurves({ id: "", points: content.points, curves: content.curves, constraints: [] });
  try {
    const out = await kernel.call("sketch_outline", c.lines, c.circles, c.arcs);
    if ("closed" in out) return { outline: out.closed };
    if (out.invalid) return { lost: "invalid-outline", message: out.open, curves: namedCurves(out.invalid, ids) };
    return { lost: "open-outline", message: out.open, curves: [] };
  } catch (e) {
    // A curve the kernel refuses outright (a line of length 0): the outline is invalid there.
    if (e instanceof KernelError && e.kind === "invalid-input" && namedCurves(e.inputs, ids).length > 0) return { lost: "invalid-outline", message: e.message, curves: namedCurves(e.inputs, ids) };
    throw e;
  }
}

/** A sketch's content as it is now, or undefined when it is gone. */
const contentOf = (doc: DesignDocument, id: string): Sketch | undefined => doc.sketches.find((s) => s.id === id);

/** Whether a sketch makes an outline now (suppression and the marker don't count): the owner's "lost" is its opposite. */
async function makesOutline(kernel: KernelCalls, doc: DesignDocument, sketchId: string): Promise<boolean> {
  const content = contentOf(doc, sketchId);
  return content !== undefined && "outline" in (await outlineOf(kernel, content));
}

/**
 * The document after an edit from `before` to `after`, with the owner's
 * rule applied: an extrude whose sketch is lost in `after` keeps the
 * sketch's points and curves from `before` (if it made an outline there
 * and the extrude has no kept shape yet); one whose sketch makes an
 * outline forgets its kept shape. The same rule as the model's `settle`.
 */
export async function settleKept(kernel: KernelCalls, before: DesignDocument, after: DesignDocument): Promise<DesignDocument> {
  const next: Record<string, KeptShape> = {};
  for (const f of after.timeline.features) {
    if (!isSketchExtrude(f)) continue;
    const sketch = f.intent.parameters.sketch as string;
    if (await makesOutline(kernel, after, sketch)) continue;
    const had = keptOf(after, f);
    const was = contentOf(before, sketch);
    if (had !== undefined) next[f.id] = had;
    else if (was !== undefined && (await makesOutline(kernel, before, sketch))) next[f.id] = { points: was.points, curves: was.curves };
  }
  const { kept: old, ...rest } = after;
  if (JSON.stringify(old ?? {}) === JSON.stringify(next)) return after;
  return Object.keys(next).length === 0 ? rest : { ...rest, kept: next };
}

/**
 * Rebuilds every feature in order with bodies from `cache`, then frees
 * every body no feature holds. Sketch items build no body; a solid
 * feature's result is its handle or why it has none.
 */
export async function rebuildTimeline(doc: DesignDocument, cache: BodyCache, kernel: KernelCalls): Promise<TimelineBuild> {
  const results: Record<string, FeatureResult> = {};
  const { features, marker } = doc.timeline;
  let rolled = marker === "start";
  for (const f of features) {
    if (rolled) results[f.id] = { status: "rolled-back" };
    else if (f.suppressed) results[f.id] = { status: "suppressed" };
    else results[f.id] = await buildFeature(doc, f, results, cache, kernel);
    if (marker === f.id) rolled = true;
  }
  await cache.keepOnly(Object.values(results).flatMap((r) => (r.status === "built" && r.body !== undefined ? [r.body] : [])));
  return { order: features.map((f) => f.id), results };
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function buildFeature(doc: DesignDocument, f: Feature, done: Record<string, FeatureResult>, cache: BodyCache, kernel: KernelCalls): Promise<FeatureResult> {
  if (isSketchItem(f)) return { status: "built" };
  try {
    if (!isSketchExtrude(f)) {
      const spec = specOf(doc, f);
      return { status: "built", body: await cache.body(spec), spec };
    }
    const sketchId = f.intent.parameters.sketch as string;
    const distance = f.intent.parameters.distance as number;
    const item = doc.timeline.features.find((x) => x.id === sketchId);
    const lost = (cause: LostCause, message: string, curves: string[]) => keptBody(keptOf(doc, f), sketchId, distance, { cause, sketch: sketchId, message, curves }, cache, kernel);
    if (item === undefined) return await lost("deleted-input", `${sketchId} was deleted`, []);
    const input = done[sketchId];
    if (input?.status === "suppressed") return { status: "failed", cause: "suppressed-input", input: sketchId, message: `${item.provenance.self.label} is suppressed` };
    if (input?.status !== "built") return { status: "failed", cause: "failed-input", input: sketchId, message: `${item.provenance.self.label} is not built` };
    // The kernel extrudes along +Z: a sketch on XZ or YZ needs placing, which comes with sketches on other planes (step 26).
    if (item.intent.parameters.plane !== "XY") return { status: "failed", cause: "error", message: `${item.provenance.self.label} is on the ${item.intent.parameters.plane} plane, and only sketches on the XY plane can be extruded so far` };
    const content = contentOf(doc, sketchId)!;
    const out = await outlineOf(kernel, content);
    if (!("outline" in out)) return await lost(out.lost, out.message, out.curves);
    const spec: BodySpec = { extrude: { profile: out.outline, distance } };
    return { status: "built", body: await cache.body(spec), spec, curves: idsOf(content) };
  } catch (e) {
    return { status: "failed", cause: "error", message: words(e) };
  }
}

/** An extrude whose sketch is lost: its kept shape with the warning, or failed with the cause when it has none. */
async function keptBody(kept: KeptShape | undefined, sketch: string, distance: number, warning: KeptWarning, cache: BodyCache, kernel: KernelCalls): Promise<FeatureResult> {
  if (kept === undefined) return { status: "failed", cause: warning.cause, input: sketch, message: warning.message, curves: warning.curves };
  const out = await outlineOf(kernel, kept);
  // A kept shape made an outline when it was kept; one that doesn't (a hand-edited file) fails the extrude with the kernel's words.
  if (!("outline" in out)) return { status: "failed", cause: "error", message: `the kept shape makes no outline: ${out.message}` };
  const spec: BodySpec = { extrude: { profile: out.outline, distance } };
  return { status: "built", body: await cache.body(spec), spec, curves: idsOf(kept), warning };
}
