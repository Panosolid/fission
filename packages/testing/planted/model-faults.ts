// Each of the timeline model's planted bugs (MODEL_FAULTS, timeline-model.ts)
// written as the same mistake in the real code (step 24e3): Design's
// timeline edits, rebuild, naming and data, and core's history and file
// writer. `run.ts` plants one at a time by editing the source in place,
// runs the check that should catch it (Design's seeded timeline sessions on
// the real kernel, or history-fuzz for the one history), puts the file back
// and records which check failed. `test/planted.test.ts` (in `npm test`)
// keeps this table honest: every fault has a plant, and every text it
// replaces is still in its file exactly once, so a plant can't silently stop
// applying when the code moves on.
//
// `caught` is the check that caught it when planted by hand. Where Design
// guards against the mistake itself, a different check catches it than the
// model's (`CAUGHT_BY` in test/timeline-session.test.ts); `why` says so.

import type { ModelFault } from "../src/timeline-model.ts";

export interface Edit {
  /** From the repository root. */
  file: string;
  find: string;
  replace: string;
}

export interface Plant {
  /** The mistake, in Design's terms. */
  what: string;
  edits: Edit[];
  /**
   * The checks to run, in order, until one fails: "timeline", Design's
   * seeded sessions against the model (12 seeds × 150 steps); "history",
   * test/history-fuzz.test.ts.
   */
  run: ("timeline" | "history")[];
  /** The timeline session's failing check, or text in history-fuzz's failure. */
  caught: string;
  /** Why the check differs from the model's own, when it does. */
  why?: string;
}

const EDITS = "workspaces/design/src/timeline-edits.ts";
const REBUILD = "workspaces/design/src/rebuild.ts";
const NAMING = "workspaces/design/src/naming.ts";
const DOCUMENT = "workspaces/design/src/document.ts";

export const PLANTS: Record<ModelFault, Plant> = {
  "reorder-past-dependency": {
    what: "reorderItem lets an item move before the item it is built from",
    edits: [{ file: EDITS, find: "  if (from) return { refused:", replace: "  if (from && false) return { refused:" }],
    run: ["timeline"],
    caught: "outcome differs from the model",
  },
  "build-suppressed": {
    what: "rebuildTimeline builds suppressed items",
    edits: [{ file: REBUILD, find: '    else if (f.suppressed) results[f.id] = { status: "suppressed" };', replace: '    else if (f.suppressed && false) results[f.id] = { status: "suppressed" };' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "ignore-marker": {
    what: "rebuildTimeline ignores the rollback marker",
    edits: [
      { file: REBUILD, find: '  let rolled = marker === "start";', replace: "  let rolled = false;" },
      { file: REBUILD, find: "    if (marker === f.id) rolled = true;", replace: "" },
    ],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "reuse-ids": {
    what: "sketch ids are the largest id in use + 1, not the counter, so a deleted curve's id comes back",
    edits: [
      {
        file: "workspaces/design/src/sketch.ts",
        find: "  return [`${prefix}-${doc.nextId}`, { ...doc, nextId: doc.nextId + 1 }];",
        replace:
          '  const used = [...doc.timeline.features.map((f) => f.id), ...doc.sketches.flatMap((s) => [...s.points, ...s.curves].map((x) => x.id))];\n  const n = Math.max(0, ...used.map((u) => Number(u.split("-").pop()))) + 1;\n  return [`${prefix}-${n}`, { ...doc, nextId: Math.max(doc.nextId, n + 1) }];',
      },
    ],
    run: ["timeline", "history"],
    caught: "history-fuzz",
    why: "the timeline sessions only see a reused id when the newest id is deleted and then a new one taken; in Design points, extrudes and presets take ids too, so in 12 × 150 steps the newest is rarely a curve that gets deleted. history-fuzz deletes and draws on one sketch for 4,000 steps and catches it",
  },
  "side-names-by-list": {
    what: "outlineCurves names a side by its place in the outline instead of the curve its piece came from",
    edits: [{ file: NAMING, find: "(curves[p.curve][p.index] ?? null)", replace: "(curves[p.curve][piece] ?? null)" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "stale-extrude-cache": {
    what: "BodyCache keys an extrude's body by its distance alone, so an edit to its sketch doesn't reach it",
    edits: [{ file: REBUILD, find: "    const key = JSON.stringify(spec);", replace: '    const key = JSON.stringify("extrude" in spec ? spec.extrude.distance : spec);' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
    why: "the session compares with the model before it rebuilds from scratch, and the stale body is wrong against both",
  },
  "cascade-delete": {
    what: "deleteItem also deletes the items built from it",
    edits: [{ file: EDITS, find: "  const features = all.filter((f) => f !== item);", replace: "  const features = all.filter((f) => f !== item && !f.dependsOn.includes(id));" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "keep-redo": {
    what: "the history keeps the steps that could be redone when a new step is recorded",
    edits: [
      { file: "packages/core/src/model/history.ts", find: "      entries.length = index + 1; // nothing to redo after a new step", replace: "" },
      { file: "packages/core/src/model/history.ts", find: "        entries.push({ snapshot, label, mergeKey, at: t });", replace: "        entries.splice(index + 1, 0, { snapshot, label, mergeKey, at: t });" },
    ],
    run: ["history"],
    caught: "history-fuzz",
    why: "Design's timeline sessions keep their own undo stacks; the one history is core's, which history-fuzz checks",
  },
  "save-drops-suppressed": {
    what: "opening a file forgets which items are suppressed",
    edits: [{ file: DOCUMENT, find: "  return d as DesignDocument;", replace: "  for (const f of d.timeline.features) f.suppressed = false;\n  return d as DesignDocument;" }],
    run: ["timeline"],
    caught: "save and open changed the rebuild",
  },
  "resolve-falls-back": {
    what: "resolveReference falls back to face 0 when a name is gone",
    edits: [{ file: "workspaces/design/src/references.ts", find: "  return i < 0 ? null : i;", replace: "  return i < 0 ? 0 : i;" }],
    run: ["timeline"],
    caught: "a broken reference resolved to another face",
  },
  "edit-leaks": {
    what: "Edit feature (editFeature, step 25a2) also gives the first extrude the distance typed for another",
    edits: [
      {
        file: "workspaces/design/src/feature-edit.ts",
        find: '  if (now.shape === "sketch-extrude") return setExtrudeDistance(doc, sizes.height!, id);',
        replace: '  if (now.shape === "sketch-extrude") return setExtrudeDistance(setExtrudeDistance(doc, sizes.height!, doc.timeline.features.find(isSketchExtrude)!.id), sizes.height!, id);',
      },
    ],
    run: ["timeline"],
    caught: "an edit changed an item that doesn't depend on it",
  },
  "sphere-one-name": {
    what: "nameBody names a sphere's lower half as its upper",
    edits: [{ file: NAMING, find: '      if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '      if (r.role !== "side" || r.piece === undefined) return r.role === "lower" ? "upper" : r.role;' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
    why: "Design drops a name two faces share (naming.ts onlyOnce), so both halves lose their names instead of sharing one",
  },
  "rebuild-drifts": {
    what: "shownBodies keeps a counter between rebuilds and every other body's volume is a thousandth out",
    edits: [
      {
        file: "workspaces/design/src/scene.ts",
        find: "    const view = await cache.view(r.body);",
        replace: "    const real = await cache.view(r.body);\n    const g = globalThis as { drift?: number };\n    const view = (g.drift = (g.drift ?? 0) + 1) % 2 === 0 ? { ...real, volume: real.volume * 1.001 } : real;",
      },
    ],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
    why: "the session compares the first rebuild with the model before it rebuilds a second time, and the drifted volume is already off",
  },
  "resolve-last-body-only": {
    what: "bodyOf looks only at the last body shown, as while there was one body",
    edits: [
      {
        file: "workspaces/design/src/scene.ts",
        find: '  return scene.bodies.findIndex((b) => (r.kind === "body" ? b.feature === r.featureId : b.names.feature === r.featureId));',
        replace: '  const last = scene.bodies.length - 1;\n  const b = scene.bodies[last];\n  return b && (r.kind === "body" ? b.feature === r.featureId : b.names.feature === r.featureId) ? last : -1;',
      },
    ],
    run: ["timeline"],
    caught: "a reference was lost",
  },
  "save-stamps": {
    what: "each save writes a counter into the file",
    edits: [
      {
        file: "packages/core/src/model/project.ts",
        find: '  return JSON.stringify(sorted(project, "project"), null, 2) + "\\n";',
        replace: '  const g = globalThis as { saves?: number };\n  return JSON.stringify(sorted({ ...project, saved: (g.saves = (g.saves ?? 0) + 1) }, "project"), null, 2) + "\\n";',
      },
    ],
    run: ["timeline"],
    caught: "outcome differs from the model",
    why: "Design's subject tells an edit that changed nothing by its saved file, so a file that changes on every save turns an unchanged edit into a done one, before any save-and-open step",
  },
  "uprights-as-given": {
    what: "nameBody orders the edge between two sides by name, not by the way round the outline",
    edits: [{ file: NAMING, find: "      if (isSide(pair[0]) && isSide(pair[1])) return `${a}>${b}`;", replace: "      if (isSide(pair[0]) && isSide(pair[1])) return a <= b ? `${a}>${b}` : `${b}>${a}`;" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "cap-edges-swapped": {
    what: "nameBody swaps an extrude's start and end caps",
    edits: [{ file: NAMING, find: '      if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '      if (r.role !== "side" || r.piece === undefined) return r.role === "start" ? "end" : r.role === "end" ? "start" : r.role;' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "end-edges-named-start": {
    what: "nameBody names an extrude's end cap as its start",
    edits: [{ file: NAMING, find: '      if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '      if (r.role !== "side" || r.piece === undefined) return r.role === "end" ? "start" : r.role;' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
    why: "Design drops a name two faces share (naming.ts onlyOnce), so both caps and their edges lose their names instead of sharing them",
  },
  "lost-sketch-fails": {
    what: "settleKept never keeps a lost sketch's shape (the rule before 24d2)",
    edits: [{ file: REBUILD, find: "    else if (was !== undefined && (await makesOutline(kernel, before, sketch)))", replace: "    else if (false && was !== undefined && (await makesOutline(kernel, before, sketch)))" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "kept-not-forgotten": {
    what: "settleKept never forgets a kept shape and extrudeSpec builds from it even when the sketch is whole again",
    edits: [
      { file: REBUILD, find: "    if (await makesOutline(kernel, after, sketch)) continue;", replace: "    if (keptOf(after, f) === undefined && (await makesOutline(kernel, after, sketch))) continue;" },
      {
        file: REBUILD,
        find: "  const lost = (cause: LostCause, message: string, curves: string[]) => keptSpec(keptOf(doc, f), distance, { cause, sketch: sketchId, message, curves }, kernel);",
        replace:
          '  const lost = (cause: LostCause, message: string, curves: string[]) => keptSpec(keptOf(doc, f), distance, { cause, sketch: sketchId, message, curves }, kernel);\n  if (keptOf(doc, f) !== undefined) return await lost("open-outline", "kept", []);',
      },
    ],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "save-drops-kept": {
    what: "opening a file forgets the extrudes' kept shapes",
    edits: [{ file: DOCUMENT, find: "  return d as DesignDocument;", replace: "  delete d.kept;\n  return d as DesignDocument;" }],
    run: ["timeline"],
    caught: "save and open changed the rebuild",
  },
  "warning-dropped": {
    what: "an extrude built from its kept shape carries no warning",
    edits: [{ file: REBUILD, find: "curves: idsOf(kept), warning };", replace: "curves: idsOf(kept) };" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "full-replay": {
    what: "rebuildTimeline empties the body cache first, so every body is built again",
    edits: [{ file: REBUILD, find: "  const { features, marker } = doc.timeline;", replace: "  await cache.clear();\n  const { features, marker } = doc.timeline;" }],
    run: ["timeline"],
    caught: "an edit rebuilt bodies that didn't change",
  },
  "body-kept-by-item": {
    what: "rebuildTimeline reuses a feature's last body while the feature's own data is unchanged, so an edit to its sketch never reaches it",
    edits: [
      {
        file: REBUILD,
        find: "    else results[f.id] = await buildFeature(doc, f, results, cache, kernel, index);",
        replace: [
          "    else {",
          "      const g = globalThis as { prev?: WeakMap<object, Map<string, { k: string; r: FeatureResult }>> };",
          "      const prev = (g.prev ??= new WeakMap());",
          "      if (!prev.has(cache)) prev.set(cache, new Map());",
          "      const k = JSON.stringify(f);",
          "      const old = prev.get(cache)!.get(f.id);",
          "      const held = old?.r.status === \"built\" && [...(cache as unknown as { bodies: Map<string, { handle: unknown }> }).bodies.values()].some((b) => b.handle === (old.r as { body?: unknown }).body);",
          "      results[f.id] = old && old.k === k && held ? old.r : await buildFeature(doc, f, results, cache, kernel, index);",
          "      prev.get(cache)!.set(f.id, { k, r: results[f.id] });",
          "    }",
        ].join("\n"),
      },
    ],
    run: ["timeline"],
    caught: "the rebuild differs from a rebuild from scratch",
    why: "the reused body is wrong, which the comparison with a rebuild from scratch sees before the build count is checked",
  },
};
