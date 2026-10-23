// The golden models on the real kernel (step 28; src/golden.ts has the
// format and the comparer): the files in tests/golden opened through
// today's reader, rebuilt through Design's own rebuild and measured as the
// expectations are written, then checked against them and through a save
// and reopen. Shared by journeys/golden.journey.ts (every pull request),
// baseline/golden.ts (rebuild time and success for tests/baseline.json)
// and nightly/golden.ts (step 28b, the nightly run).

import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { projectFromJson, projectToJson, type GeometryReference, type KernelCalls, type Project, type StableId } from "@fission/core";
import { BodyCache, bodyRows, designWorkspace, findInScene, isFaceSketch, joinBodies, rebuildTimeline, shownBodies, type DesignDocument } from "@fission/design";
import { bodyTolerance, compare, plan, planeGap, readExpect, shellCount, type GoldenExpect, type Measured, type Vec3 } from "./golden.ts";

export const GOLDEN_DIR = new URL("../../../tests/golden/", import.meta.url);

/** Every expectation in tests/golden, by file name. */
export const goldenExpects = (): GoldenExpect[] =>
  readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".expect.json"))
    .sort()
    .map((f) => readExpect(readFileSync(new URL(f, GOLDEN_DIR), "utf8"), f));

/** The models that have a project file, by name. */
export const goldenFiles = (): string[] =>
  readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".panosolid.json"))
    .map((f) => f.slice(0, -".panosolid.json".length))
    .sort();

/** The expectations of the models that build today (`plan`: the rest wait for their step). */
export function buildable(): GoldenExpect[] {
  const all = goldenExpects();
  const runs = plan(all, goldenFiles());
  return all.filter((e) => runs.find((r) => r.model === e.model)?.run === "build");
}

export const openGolden = (model: string): Project => projectFromJson(readFileSync(new URL(`${model}.panosolid.json`, GOLDEN_DIR), "utf8"), [designWorkspace]);
export const goldenDesign = (model: string) => openGolden(model).workspaces.design as DesignDocument;

const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A rebuild of `doc` through Design on `calls`, measured as the expectations are written, and how long the rebuild took. */
export async function measureGolden(doc: DesignDocument, calls: KernelCalls): Promise<{ got: Measured; ms: number }> {
  const cache = new BodyCache(calls);
  try {
    const start = performance.now();
    const build = await rebuildTimeline(doc, cache, calls);
    const shown = await shownBodies(doc, build, cache);
    const ms = performance.now() - start;
    const scene = joinBodies(shown);
    const trouble: string[] = [];
    const failures: Measured["failed"] = [];
    const failed = new Set<string>();
    for (const id of build.order) {
      const r = build.results[id];
      if (r.status === "failed") {
        failed.add(id);
        failures.push({ item: id, message: r.message });
      } else if (r.status !== "built") trouble.push(`${id} is ${r.status}`);
      else for (const w of [r.warning, r.plane, r.source, r.points, r.projections]) if (w) trouble.push(`${id} warns: ${w.message}`);
    }
    const rows = bodyRows(doc, failed);
    const bodies = shown.map((s) => {
      const v = s.view;
      return {
        body: rows.find((r) => r.feature.id === s.feature)?.label ?? "no row",
        item: s.feature,
        volume: v.volume,
        area: v.area,
        faces: v.faces,
        edges: v.edges,
        vertices: v.vertices,
        shells: shellCount(v),
        box: v.bounds,
        tolerance: bodyTolerance(v),
        gap: planeGap(v),
        errors: v.errors,
      };
    });
    const sketches = doc.timeline.features.filter(isFaceSketch).map((f) => {
      const face = f.intent.parameters.plane as string;
      const found = findInScene({ kind: "face", id: face as StableId } as GeometryReference, scene);
      let normal: Vec3 | null = null;
      let centroid: Vec3 | null = null;
      if (found.status === "found") {
        const b = shown.findIndex((_, i) => found.index >= scene.faceStart[i] && (i + 1 === shown.length || found.index < scene.faceStart[i + 1]));
        const i = found.index - scene.faceStart[b];
        normal = shown[b].view.face_normals[i] ?? null;
        centroid = shown[b].view.face_centroids[i];
      }
      const r = build.results[f.id];
      const p = r?.status === "built" ? r.placement : undefined;
      return {
        sketch: f.id,
        face,
        found: found.status === "found" ? 1 : found.status === "shared" ? found.count : 0,
        normal,
        centroid,
        placed: p ? { normal: p.plane.normal.map((c) => c * p.side) as Vec3, origin: p.plane.origin } : null,
      };
    });
    const pins = doc.sketches.flatMap((s) =>
      (s.pins ?? []).map((pin) => {
        const r = build.results[s.id];
        const p = r?.status === "built" ? r.placement : undefined;
        const xy = r?.status === "built" ? r.pinned?.find((q) => q.point === pin.point)?.at : undefined;
        let at: Vec3 | null = null;
        if (p && xy) {
          const { origin, xAxis, normal } = p.plane;
          const y = cross(normal, xAxis);
          at = [0, 1, 2].map((k) => origin[k] + xy[0] * xAxis[k] + xy[1] * y[k]) as Vec3;
        }
        return { sketch: s.id, point: pin.point, kind: pin.kind, name: pin.name, ...(pin.feature !== undefined ? { feature: pin.feature } : {}), at };
      }),
    );
    return { got: { bodies, sketches, pins, trouble, failed: failures }, ms };
  } finally {
    await cache.clear();
  }
}

/**
 * One golden model checked on `calls`: every way its rebuild differs from
 * the hand-worked answers (`compare`), and whether a save and reopen gives
 * the same document; empty `problems` when it matches. A rebuild that
 * throws is a problem too, never a crash of the run.
 */
export async function checkGolden(want: GoldenExpect, calls: KernelCalls): Promise<{ problems: string[]; got: Measured | null; ms: number }> {
  try {
    const doc = goldenDesign(want.model);
    const { got, ms } = await measureGolden(doc, calls);
    const problems = compare(want, got);
    const again = projectFromJson(projectToJson(openGolden(want.model)), [designWorkspace]).workspaces.design;
    if (!isDeepStrictEqual(again, doc)) problems.push("a save and reopen changed it");
    return { problems, got, ms };
  } catch (e) {
    return { problems: [`the rebuild threw: ${e instanceof Error ? e.message : String(e)}`], got: null, ms: NaN };
  }
}

const shown = (x: unknown) => (Object.is(x, -0) ? "-0" : typeof x === "number" ? String(x) : JSON.stringify(x));

/** Where two measurements of one model first differ, as a path ("bodies[0].volume: 1 then 2"), or null when they are the same. */
export function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return `${path || "the whole answer"}: ${shown(a)} then ${shown(b)}`;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
    if (d !== null) return d;
  }
  return null;
}
