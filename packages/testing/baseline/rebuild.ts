// "20 features with arcs, edit the first" (step 24d3c, health check
// 2026-10-17 risk 5): what one sketch edit costs the app once a part has
// grown, for tests/baseline.json (packages/testing/baseline/app.ts measures
// it; journeys/rebuild-baseline.journey.ts hand-works it and plants the
// bugs it must catch).
//
// The part: the app's starting box and 20 sketches on XY, each a 20 × 10
// outline with three rounded corners (radius 3, three arcs) and one square
// corner, extruded by 10, side by side 30 mm apart. The edit: the first
// sketch's square corner moved along x, as a Move point click does, then
// what the app does after a sketch click: `settleKept`, `rebuildTimeline`
// on the one `BodyCache`, and every built body's view and names (what
// Design draws). Only the first extrude's spec changes, so a working cache
// builds one body; the other 20 keep theirs.

import type { BodyView, KernelCalls } from "@fission/core";
import { addSketch, BodyCache, drawArc, drawLine, extrudeSketch, movePoint, nameBody, outlineCurves, partDocument, pointAt, rebuildTimeline, settleKept, type DesignDocument } from "@fission/design";

export const FEATURES = 20;
export const WIDTH = 20;
export const HEIGHT = 10;
export const RADIUS = 3;
export const DISTANCE = 10;
export const SPACING = 30;

/**
 * Bugs the baseline must catch, planted on purpose (journeys/rebuild-
 * baseline.journey.ts, and by hand with FISSION_BASELINE_FAULT in app.ts):
 * - "full-replay": every body built again on every edit (the cache
 *   emptied first), the slowdown risk 5 is about;
 * - "outline-twice": every sketch's outline asked of the kernel once more
 *   per edit, a smaller waste that only the call count shows;
 * - "slow": the same calls, but the edit kept busy for 1.5 times as long
 *   again as its own work took (2.5 times in all), a slowdown only the
 *   time shows.
 */
export const REBUILD_FAULTS = ["full-replay", "outline-twice", "slow"] as const;
export type RebuildFault = (typeof REBUILD_FAULTS)[number];

export interface RebuildPart {
  doc: DesignDocument;
  /** The first sketch and its square corner's point id: what the edit moves. */
  sketch: string;
  corner: string;
}

/**
 * The part. Each outline runs counter-clockwise from the square corner at
 * (x, 0): a line to (x + 17, 0), an arc round (x + 17, 3) to (x + 20, 3), a
 * line up to (x + 20, 7), an arc round (x + 17, 7) to (x + 17, 10), a line
 * to (x + 3, 10), an arc round (x + 3, 7) to (x, 7), and a line down to the
 * corner.
 */
export function rebuildPart(): RebuildPart {
  let doc = partDocument("box", 40, 30, 20);
  let first: { sketch: string; corner: string } | undefined;
  for (let i = 0; i < FEATURES; i++) {
    const x = i * SPACING;
    const made = addSketch(doc);
    doc = made.doc;
    const s = made.id;
    const at = (p: readonly [number, number]) => pointAt(doc.sketches.find((k) => k.id === s)!, p) ?? p;
    const line = (a: readonly [number, number], b: readonly [number, number]) => (doc = drawLine(doc, s, at(a), at(b)).doc);
    const arc = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (doc = drawArc(doc, s, at(a), at(b), at(c)).doc);
    const r = RADIUS, w = WIDTH, h = HEIGHT;
    line([x, 0], [x + w - r, 0]);
    arc([x + w - r, 0], [x + w, r], [x + w - r, r]);
    line([x + w, r], [x + w, h - r]);
    arc([x + w, h - r], [x + w - r, h], [x + w - r, h - r]);
    line([x + w - r, h], [x + r, h]);
    arc([x + r, h], [x, h - r], [x + r, h - r]);
    line([x, h - r], [x, 0]);
    doc = extrudeSketch(doc, s, DISTANCE).doc;
    first ??= { sketch: s, corner: pointAt(doc.sketches.find((k) => k.id === s)!, [0, 0])! };
  }
  return { doc, ...first! };
}

/** The part with the first sketch's square corner at (-shift, 0). */
export const editFirst = (part: RebuildPart, shift: number): DesignDocument => movePoint(part.doc, part.sketch, part.corner, -shift, 0);

/** A kernel that counts its calls, all of them and body_build alone. */
export function countingKernel(kernel: KernelCalls): KernelCalls & { calls: number; builds: number } {
  const k = {
    calls: 0,
    builds: 0,
    call: ((op: string, ...args: unknown[]) => {
      k.calls++;
      if (op === "body_build") k.builds++;
      return (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
  return k;
}

/**
 * One edit from `before` to `after` as the app makes it: the kept shapes
 * settled, the timeline rebuilt on `cache`, and every built body's view and
 * names, in build order.
 */
export async function showEdit(kernel: KernelCalls, cache: BodyCache, before: DesignDocument, after: DesignDocument, fault?: RebuildFault): Promise<{ doc: DesignDocument; views: BodyView[] }> {
  const start = performance.now();
  const doc = await settleKept(kernel, before, after);
  if (fault === "full-replay") await cache.clear();
  if (fault === "outline-twice") await settleKept(kernel, before, after);
  const build = await rebuildTimeline(doc, cache, kernel);
  const views: BodyView[] = [];
  for (const id of build.order) {
    const r = build.results[id];
    if (r.status !== "built" || r.body === undefined || r.spec === undefined) continue;
    const view = await cache.view(r.body);
    nameBody(id, view, "extrude" in r.spec ? outlineCurves(r.spec.extrude.profile, r.curves) : () => null);
    views.push(view);
  }
  if (fault === "slow") for (const end = performance.now() + 1.5 * (performance.now() - start); performance.now() < end; );
  return { doc, views };
}

export { BodyCache };
