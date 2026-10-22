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

import type { NamingFault } from "../src/naming-model.ts";
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
   * test/history-fuzz.test.ts; "naming", journeys/naming.journey.ts (step
   * 26c: Design against the naming model on the real kernel).
   */
  run: ("timeline" | "history" | "naming")[];
  /** The timeline session's failing check, or text in history-fuzz's or the naming journey's failure. */
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
    caught: "a new id is already in use",
    why: "the timeline sessions only see a reused id when the newest id is deleted and then a new one taken; in Design points, extrudes and presets take ids too, so in 12 × 150 steps the newest is rarely a curve that gets deleted. history-fuzz deletes and draws on one sketch for 4,000 steps and catches it. From 26e (face sketches in the sessions' random steps) the timeline sessions reach a reused id first and their fresh-id check catches it",
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
    caught: "the rebuild differs from a rebuild from scratch",
    why: "the stale body is wrong against both the model and a rebuild from scratch; with 26e's random steps the first session to meet it fails the from-scratch check first (recorded from planted/run.ts, 2026-10-22)",
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
    edits: [{ file: NAMING, find: '    if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '    if (r.role !== "side" || r.piece === undefined) return r.role === "lower" ? "upper" : r.role;' }],
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
    caught: "the rebuild differs from a rebuild from scratch",
    why: "the drifted volume is off against both the model and a rebuild from scratch; with 26e's random steps the first session to meet it fails the from-scratch check first (recorded from planted/run.ts, 2026-10-22)",
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
    edits: [{ file: NAMING, find: '    if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '    if (r.role !== "side" || r.piece === undefined) return r.role === "start" ? "end" : r.role === "end" ? "start" : r.role;' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "end-edges-named-start": {
    what: "nameBody names an extrude's end cap as its start",
    edits: [{ file: NAMING, find: '    if (r.role !== "side" || r.piece === undefined) return r.role;', replace: '    if (r.role !== "side" || r.piece === undefined) return r.role === "end" ? "start" : r.role;' }],
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
      { file: REBUILD, find: "      if (await makesOutline(kernel, after, sketch)) continue;", replace: "      if (keptOf(after, f) === undefined && (await makesOutline(kernel, after, sketch))) continue;" },
      {
        file: REBUILD,
        find: "  const lost = (cause: LostCause, message: string, curves: string[]) => keptSpec(keptOf(doc, f), distance, flip, { cause, sketch: sketchId, message, curves }, kernel);",
        replace:
          '  const lost = (cause: LostCause, message: string, curves: string[]) => keptSpec(keptOf(doc, f), distance, flip, { cause, sketch: sketchId, message, curves }, kernel);\n  if (keptOf(doc, f) !== undefined) return await lost("open-outline", "kept", []);',
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
  // 26e: the timeline's rules on a face sketch, and the greying unified.
  "suppress-fails-dependents": {
    what: "an extrude of a suppressed sketch fails, as before 26e, instead of being greyed (Q3)",
    edits: [{ file: REBUILD, find: '    if (item !== undefined && input?.status === "suppressed") return { status: "greyed", by: sketchId };', replace: '    if (item !== undefined && input?.status === "suppressed") return { status: "failed", cause: "failed-input", input: sketchId, message: "suppressed" };' }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "greyed-warns": {
    what: "a sketch on a suppressed feature's face is held with its plane lost instead of greyed",
    edits: [{ file: REBUILD, find: '  if (on?.status === "suppressed") return { status: "greyed", by: featureId };', replace: "" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "lost-plane-not-held": {
    what: "settleKept never holds a lost face sketch's placement, so it goes back to where it was drawn",
    edits: [{ file: REBUILD, find: "      else if (held === undefined) keep = (await wasAt(content.id))?.plane;", replace: "      else if (held === undefined) keep = undefined;" }],
    run: ["timeline"],
    caught: "the rebuild differs from the model",
  },
  "face-sketch-unbound": {
    what: "reorderItem lets a sketch move before the feature whose face it is on (answer 7), and that feature after it",
    edits: [
      { file: EDITS, find: "  const from = features.find((f) => item.dependsOn.includes(f.id) && place(f.id) > to);", replace: "  const from = features.find((f) => !isSketchItem(item) && item.dependsOn.includes(f.id) && place(f.id) > to);" },
      { file: EDITS, find: "  const user = features.find((f, j) => j < to && f.dependsOn.includes(id));", replace: "  const user = features.find((f, j) => j < to && !isSketchItem(f) && f.dependsOn.includes(id));" },
    ],
    run: ["timeline"],
    caught: "outcome differs from the model",
  },
};

const FACE = "workspaces/design/src/face-sketch.ts";
const SKETCH = "workspaces/design/src/sketch.ts";
const ASK = "workspaces/design/src/delete-ask.ts";
const EDGES = "workspaces/design/src/face-edges.ts";

/** A plant in Design's sketch on a face (step 26c), and the naming model's bug it is the same mistake as, when it is one. */
export interface NamingPlant extends Plant {
  fault?: NamingFault;
}

/**
 * Bugs planted in Design's sketch on a face (step 26c): the naming model's
 * own bugs (NAMING_FAULTS) where Design can make the same mistake, and
 * mistakes only Design can make. `caught` is text in the naming journey's
 * first failure (the test's title, then its words). The model's bugs left
 * out have no counterpart in Design yet: the cut's (bite-fails,
 * empty-cut-builds, delete-keeps-dependents), side-by-index (Design's
 * lines are ids, never places), suppress-greys-all-after (Design greys by
 * what an item is built from, never by place), frame-follows-face (Design
 * never keeps a face's middle), and ambiguous-picks-first (no Design
 * outline names two faces alike: rebuild's `sharedBy`).
 */
export const NAMING_PLANTS: Record<string, NamingPlant> = {
  "plane-stays-put": {
    fault: "plane-stays-put",
    what: "a face sketch stays on the plane it was drawn on, whatever its face does",
    edits: [{ file: REBUILD, find: "const placement = { plane: frameNow(squared(p.frame)!, outward, view.face_centroids[face]), side: p.side };", replace: "const placement = { plane: squared(p.frame)!, side: p.side };" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "normal-follows-face": {
    fault: "normal-follows-face",
    what: "a face sketch's side is worked out again from its face, so it flips with the face",
    edits: [
      {
        file: REBUILD,
        find: "const placement = { plane: frameNow(squared(p.frame)!, outward, view.face_centroids[face]), side: p.side };",
        replace: "const placement = { plane: frameNow(squared(p.frame)!, outward, view.face_centroids[face]), side: frameNow(squared(p.frame)!, outward, view.face_centroids[face]).normal.reduce((a, x, k) => a + x * outward[k], 0) < 0 ? -1 : 1 };",
      },
    ],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "frame-not-turned": {
    fault: "frame-not-turned",
    what: "a face sketch's frame keeps the axes it was drawn with when its face turns (the model's fault: only its origin moves)",
    edits: [{ file: FACE, find: "xAxis: turned(drawn.xAxis, drawn.normal, n), normal: n })!;", replace: "xAxis: drawn.xAxis, normal: drawn.normal })!;" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "origin-at-corner": {
    fault: "origin-at-corner",
    what: "a face sketch's origin is the point of the face it was given, not where the world's origin meets the plane",
    edits: [{ file: FACE, find: "  return squared({ origin: scale(n, dot(point, n)), xAxis: turned(drawn.xAxis, drawn.normal, n), normal: n })!;", replace: "  return squared({ origin: [...point] as Vec3, xAxis: turned(drawn.xAxis, drawn.normal, n), normal: n })!;" }],
    run: ["naming"],
    caught: "hand-worked: a box's top",
    why: "the hand-worked box top (origin (0,0,20), not the face's middle) comes before the Fusion answers",
  },
  "lost-plane-silent": {
    fault: "lost-plane-silent",
    what: "a face sketch held at its last placement says nothing",
    edits: [{ file: REBUILD, find: "side: p.side }, plane: { cause, face: plane, message: planeWords(cause, f.provenance.self.label) } };", replace: "side: p.side } };" }],
    run: ["naming"],
    caught: "hand-worked: a sketch on a cylinder's flat top",
    why: "the hand-worked file naming a cylinder's side comes before the Fusion answers",
  },
  "lost-plane-moves": {
    fault: "lost-plane-moves",
    what: "a face sketch whose face is lost goes back to where it was drawn, not where it last was",
    edits: [{ file: REBUILD, find: "placement: { plane: squared(p.held ?? p.frame)!, side: p.side }", replace: "placement: { plane: squared(p.frame)!, side: p.side }" }],
    run: ["naming"],
    caught: "seeded:",
    why: "in each Fusion case the face is lost where it was drawn; the seeded sessions move it first",
  },
  "source-lost-silent": {
    fault: "source-lost-silent",
    what: "an extrude of a held face sketch says nothing",
    edits: [{ file: REBUILD, find: "...made, ...(source ? { source } : {}) };", replace: "...made };" }],
    run: ["naming"],
    caught: "hand-worked: a sketch on a cylinder's flat top",
    why: "the hand-worked file naming a cylinder's side comes before the Fusion answers",
  },
  "extrude-ignores-side": {
    fault: "extrude-ignores-side",
    what: "an extrude of a face sketch goes along the frame's normal, whichever way the sketch faces",
    edits: [{ file: REBUILD, find: "  const back = (at.side === -1) !== flip;", replace: "  const back = flip;" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "reorder-ignores-plane": {
    fault: "reorder-ignores-plane",
    what: "a face sketch doesn't depend on its face's feature, so it can be dragged before it",
    edits: [{ file: SKETCH, find: "{ plane: face.plane }, [face.feature], [{", replace: "{ plane: face.plane }, [], [{" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "delete-takes-sketch": {
    fault: "delete-takes-sketch",
    what: "deleting a feature deletes the sketches on its faces too",
    edits: [{ file: EDITS, find: "  const features = all.filter((f) => f !== item);", replace: '  const features = all.filter((f) => f !== item && !(f.intent.type === "sketch" && f.dependsOn.includes(id)));' }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "delete-no-ask": {
    fault: "delete-no-ask",
    what: "deleting a feature a sketch is on doesn't ask first",
    edits: [{ file: ASK, find: "  const users = before.timeline.features.filter((f) => f.dependsOn.includes(id));", replace: '  const users = before.timeline.features.filter((f) => f.dependsOn.includes(id) && f.intent.type !== "sketch");' }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "suppress-keeps-dependents": {
    fault: "suppress-keeps-dependents",
    what: "a sketch on a suppressed feature's face is held with its plane lost, not greyed",
    edits: [{ file: REBUILD, find: '  if (on?.status === "suppressed") return { status: "greyed", by: featureId };', replace: "" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "greyed-loses-hold": {
    fault: "greyed-loses-hold",
    what: "settling judges held placements with suppression on, so a face redrawn away while greyed is never held",
    edits: [{ file: REBUILD, find: "  const features = doc.timeline.features.map((f) => (f.suppressed ? { ...f, suppressed: false } : f));", replace: "  const features = doc.timeline.features;" }],
    run: ["naming"],
    caught: "seeded:",
    why: "Design falls back to the frame as drawn when nothing is held, which in the Fusion case Q3 is where the hold would be; the seeded sessions move the face before suppressing",
  },
  "greyed-extrude-fails": {
    what: "an extrude of a greyed sketch fails (red) instead of greying with it",
    edits: [{ file: REBUILD, find: '    if (item !== undefined && input?.status === "greyed") return { status: "greyed", by: input.by };', replace: "" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "flip-ignored": {
    what: "Flip does nothing on a sketch on XY",
    edits: [{ file: REBUILD, find: "  if (at === null) return { extrude: flip ? { profile, distance, flip: true } : { profile, distance } };", replace: "  if (at === null) return { extrude: { profile, distance } };" }],
    run: ["naming"],
    caught: "hand-worked: a 40 × 30 rectangle on XZ and on YZ",
    why: "the hand-worked XY flip comes first in the journey",
  },
  "kept-lies-flat": {
    what: "an extrude keeping a deleted sketch that was not on XY keeps its points only, so it is laid on XY",
    edits: [{ file: REBUILD, find: "        next[f.id] = placement ? { points: was.points, curves: was.curves, placement } : { points: was.points, curves: was.curves };", replace: "        next[f.id] = placement ? { points: was.points, curves: was.curves } : { points: was.points, curves: was.curves };" }],
    run: ["naming"],
    caught: "hand-worked: the XZ sketch deleted",
    why: "the hand-worked XZ delete comes first in the journey; the seeded sessions catch it too (a face sketch deleted under its cylinder)",
  },
  "held-never-forgotten": {
    what: "a held placement is kept after the face comes back, so a later loss holds an old place",
    edits: [{ file: REBUILD, find: "      if (r.plane === undefined) keep = undefined;", replace: "      if (r.plane === undefined) keep = keep;" }],
    run: ["naming"],
    caught: "hand-worked: a box's top sketched on",
    why: "the model's sessions never bring a lost face's name back, except by Undo, which restores the snapshot; the box made a sphere and back does",
  },
  // ---- Step 26f: points pinned to a face's edges (Q4). ----
  "pin-stays-put": {
    fault: "pin-stays-put",
    what: "a pinned point is never moved: the rebuild and the settle leave it where it was drawn",
    edits: [{ file: REBUILD, find: "    if (\"at\" in now) pinned.push({ point: pin.point, at: now.at });", replace: "    if (\"at\" in now) continue;" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "lost-pin-silent": {
    fault: "lost-pin-silent",
    what: "a pinned point whose edge is gone stays put without a word",
    edits: [{ file: REBUILD, find: "  if (n === 0) return { pinned };", replace: "  if (n >= 0) return { pinned };" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "lost-pin-moves": {
    fault: "lost-pin-moves",
    what: "a pinned point whose edge is gone is sent to the sketch's origin",
    edits: [{ file: REBUILD, find: "    else held[now.cause]++;", replace: "    else (held[now.cause]++, pinned.push({ point: pin.point, at: [0, 0] }));" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "pin-survives-move": {
    fault: "pin-survives-move",
    what: "a pinned point moved by hand keeps its pin, so the next settle puts it back on the edge",
    edits: [{ file: SKETCH, find: "  return withSketch(doc, sketch.pins ? withPins(moved, sketch.pins.filter((p) => p.point !== pointId)) : moved);", replace: "  return withSketch(doc, moved);" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "pin-wrong-end": {
    fault: "pin-wrong-end",
    what: "a corner is found at the far end of one of the edges it is named by",
    edits: [{ file: EDGES, find: "    if (v >= 0) return { at: inSketch(view.vertex_points[v], plane) };", replace: "    if (v >= 0) { const e = view.edge_vertices.findIndex(([a, b]) => a === v && b !== v); return { at: inSketch(view.vertex_points[e >= 0 ? view.edge_vertices[e][1] : v], plane) }; }" }],
    run: ["naming"],
    caught: "Fusion answers",
  },
  "pin-ordered-corner": {
    what: "a corner is named with naming.ts's order of the side edges meeting there (27a's plan for 27b), so a corner moved across the outline (turning it over) loses its pin",
    edits: [{ file: EDGES, find: "  return names.edges[e] === null ? null : (names.ends?.[e] ?? unordered(names.edges[e]));", replace: "  return names.edges[e];" }],
    run: ["naming"],
    caught: "seeded",
  },
  // ---- Step 27b: a half disc's corners named by the ends of the curves meeting there. ----
  "corner-unordered": {
    what: "a corner is named as 26f named it, the sides' order left out, so a half disc's two corners share a name and neither is offered",
    edits: [{ file: EDGES, find: "  return names.edges[e] === null ? null : (names.ends?.[e] ?? unordered(names.edges[e]));", replace: "  return unordered(names.edges[e]);" }],
    run: ["naming"],
    caught: "half-disc: 27b regression",
    why: "the naming model's outlines are polygons, whose corners the unordered names tell apart; only the half disc's journey has two curves meeting at both ends",
  },
  "corner-order-as-given": {
    what: "a corner's ends are read off the kernel's order of its two sides as if it were always the outline's own, so an outline the kernel turned round (drawn clockwise, or flipped) names each corner by the far ends",
    edits: [{ file: NAMING, find: "    const [first, second] = inOrder ? pair : [pair[1], pair[0]];", replace: "    const [first, second] = pair;" }],
    run: ["naming"],
    caught: "seeded",
    why: "a corner moved across the outline turns it clockwise under a corner's pin (seed 2509 here; seed 2550, kept in test/regressions/naming, found it while 27b was written)",
  },
  "two-piece-flip-ignored": {
    what: "a two-piece outline's order is worked out from its area alone, so a flipped half disc names each corner by the other's ends",
    edits: [{ file: NAMING, find: "twoInOrder: twiceArea(outline.outer.path) > 0 !== flip", replace: "twoInOrder: twiceArea(outline.outer.path) > 0" }],
    run: ["naming"],
    caught: "half-disc: 27b, hand-worked: flipping",
    why: "the naming model's outlines are polygons, read off the body itself",
  },
  "piece-way-ignored": {
    what: "a corner's ends ignore which way the outline runs each curve, so a curve run backwards is named by its wrong end",
    edits: [{ file: NAMING, find: "    const [ra, rb] = [ways.reversed(a), ways.reversed(b)];", replace: "    const [ra, rb] = [false as boolean | null, false as boolean | null];" }],
    run: ["naming"],
    caught: "half-disc: 27b, hand-worked: a crescent",
    why: "the naming sessions draw every outline's lines head to tail, so the outline never runs one backwards",
  },
  "old-name-forgotten": {
    what: "a pin saved by 0.26, its corner's sides unordered, is never found again",
    edits: [{ file: EDGES, find: '    if (!pin.name.includes("@")) {', replace: "    if (false) {" }],
    run: ["naming"],
    caught: "half-disc: 27b, hand-worked: a file from 0.26",
    why: "the sessions only pin with names Design gives now",
  },
  "middle-ordered": {
    what: "the middle of an edge between two sides is offered under naming.ts's ordered name, so a flipped half disc sends its pin to the other upright",
    edits: [{ file: EDGES, find: "      const middle = edge === null ? null : (names.ends?.[e] ?? edge);", replace: "      const middle = edge;" }],
    run: ["naming"],
    caught: "half-disc: 27b, hand-worked: flipping",
    why: "the naming model pins only on caps, which have no upright edges",
  },
  "pin-not-settled": {
    what: "neither the settle nor the app writes a pinned point's new place into the sketch, so what is drawn and saved stays behind what is built",
    edits: [{ file: REBUILD, find: "  const to = new Map(r.pinned.map((p) => [p.point, p.at]));", replace: "  const to = new Map<string, SketchXY>();" }],
    run: ["naming"],
    caught: "seeded",
  },
};
