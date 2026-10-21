// Design's timeline in the project-wide dependency graph.

import type { ChangeNotes, DependencyGraph, Feature } from "@fission/core";
import { buildingItems, isSketchExtrude, isSketchItem, keptOf, partFeature, type DesignDocument } from "./document.ts";

/** Graph id of the part's mass properties and mesh: cheap, rebuilt at once after every change. */
export const PART_VIEW = "design.part-view";

/** What the user did, as a change note says it: "you changed the box". */
export function changeWords(kind: string, removed = false): string {
  const thing = ({ extrude: "extrusion" } as Record<string, string>)[kind] ?? kind;
  return `you ${removed ? "removed" : "changed"} the ${thing}`;
}

/** What a note calls a timeline item: a sketch or an extrude of one by its name ("Sketch 2", "Extrude 1"), a preset by its kind ("the box"). */
export function itemCalled(f: Feature): string {
  if (isSketchItem(f) || isSketchExtrude(f)) return f.provenance.self.label;
  return changeWords(f.intent.type).slice("you changed ".length);
}

/**
 * The words for what one edit did as a whole (25c2), for the results it
 * changed without the user touching them: an extrude rolled back by the
 * marker, rebuilt from its kept shape, or left out with its suppressed
 * sketch; and the part's view when the part is another feature now. The
 * first that applies: an item removed, added, suppressed or unsuppressed,
 * or changed; the marker moved; the items put in another order.
 */
function editWords(doc: DesignDocument, before: DesignDocument, removed: readonly Feature[], direct: readonly { words: string }[]): string {
  if (removed.length > 0) return `you removed ${itemCalled(removed[0])}`;
  if (direct.length > 0) return direct[0].words;
  if (before.timeline.marker !== doc.timeline.marker) return "you moved the timeline marker";
  return "you reordered the timeline";
}

/**
 * Puts the document's profiles and features in the project graph, with the
 * part's view reading the last feature, and marks downstream of whatever
 * differs from `before` out of date. Each change and removal is recorded in
 * `notes` with its words, so a result in another workspace that it updates
 * gets a note naming it.
 *
 * On a timeline (25c2) an item also differs when whether it builds does
 * (the marker moved past it, it or its sketch suppressed or unsuppressed)
 * or the shape it keeps for a lost sketch does: a result built from it is
 * out of date even though the item itself is as it was. A note names the
 * item ("you suppressed Extrude 1", "you changed Sketch 2"); one about a
 * result the edit changed only through the build names the edit ("you
 * moved the timeline marker"). Those are recorded first, so where a result
 * has both causes its note names what the user touched.
 */
export function syncGraph(graph: DependencyGraph, doc: DesignDocument, before: DesignDocument | null, notes: ChangeNotes): void {
  // A sketch's item and its content are one node: drawing a line changes the sketch.
  // Sketches are found by id through a Map, not a search per item (security audit S2).
  const sketchesOf = (d: DesignDocument) => new Map(d.sketches.map((s) => [s.id, s] as const));
  const buildingOf = (d: DesignDocument) => new Set([...buildingItems(d)].map((f) => f.id));
  /** What the user wrote for the item: the item, and a sketch's content. */
  const own = (sketches: Map<string, unknown>, x: { id: string }) => (sketches.has(x.id) ? [x, sketches.get(x.id)] : x);
  /** What the build makes of it: whether it builds, and an extrude's kept shape. */
  const built = (d: DesignDocument, building: Set<string>, f: Feature) => [building.has(f.id), keptOf(d, f) ?? null];
  const beforeSketches = before ? sketchesOf(before) : new Map();
  const nowSketches = sketchesOf(doc);
  const beforeBuilding = before ? buildingOf(before) : new Set<string>();
  const nowBuilding = buildingOf(doc);
  const oldOwn = new Map<string, string>(before ? [...before.profiles, ...before.timeline.features].map((x) => [x.id, JSON.stringify(own(beforeSketches, x))]) : []);
  const oldItems = new Map<string, Feature>(before ? before.timeline.features.map((f) => [f.id, f]) : []);
  const ownDiffers = (x: { id: string }) => oldOwn.get(x.id) !== JSON.stringify(own(nowSketches, x));
  const direct: { id: string; label: string; words: string }[] = [];
  const derived: { id: string; label: string }[] = [];
  for (const p of doc.profiles) {
    graph.set({ id: p.id, label: `Profile ${p.id}`, workspace: "design", cost: "cheap" });
    if (ownDiffers(p)) direct.push({ id: p.id, label: `Profile ${p.id}`, words: changeWords("profile") });
  }
  // An input no longer in the document (an extrude's deleted sketch) is not read: the extrude builds from its kept shape (24d2).
  const present = new Set([...doc.profiles, ...doc.timeline.features].map((x) => x.id));
  for (const f of doc.timeline.features) {
    graph.set({ id: f.id, label: f.intent.summary, workspace: "design", cost: "cheap" }, f.dependsOn.filter((d) => present.has(d)));
    const was = oldItems.get(f.id);
    if (!was) direct.push({ id: f.id, label: f.intent.summary, words: `you added ${itemCalled(f)}` });
    else if (ownDiffers(f))
      direct.push({ id: f.id, label: f.intent.summary, words: was.suppressed !== f.suppressed ? `you ${f.suppressed ? "suppressed" : "unsuppressed"} ${itemCalled(f)}` : `you changed ${itemCalled(f)}` });
    else if (JSON.stringify(built(before!, beforeBuilding, was)) !== JSON.stringify(built(doc, nowBuilding, f))) derived.push({ id: f.id, label: f.intent.summary });
  }
  // A design with no body (24f4): the numbers read nothing.
  const part = partFeature(doc);
  graph.set({ id: PART_VIEW, label: "Volume, area and mesh", workspace: "design", cost: "cheap" }, part === null ? [] : [part.id]);
  // Profiles and features that are gone (their readers were re-pointed above).
  const now = new Set([...doc.profiles, ...doc.timeline.features].map((x) => x.id));
  const removed = before ? before.timeline.features.filter((f, i, all) => !now.has(f.id) && all.findIndex((x) => x.id === f.id) === i) : [];
  // A feature the user touched names the edit before a profile it changed with it.
  const profiles = new Set(doc.profiles.map((p) => p.id));
  const cause = before ? editWords(doc, before, removed, [...direct.filter((d) => !profiles.has(d.id)), ...direct.filter((d) => profiles.has(d.id))]) : "";
  for (const c of derived) notes.record({ node: c.id, label: c.label, workspace: "design", change: cause }, graph.changed(c.id), graph);
  for (const c of direct) notes.record({ node: c.id, label: c.label, workspace: "design", change: c.words }, graph.changed(c.id), graph);
  // The part itself is another feature now, or none (a marker move, a suppress, a delete; 24f4): what reads the part's view is out of date, even when the feature it read did not change.
  const was = before && partFeature(before);
  if (before && (was?.id ?? null) !== (part?.id ?? null)) notes.record({ node: PART_VIEW, label: "Volume, area and mesh", workspace: "design", change: cause }, graph.changed(PART_VIEW), graph);
  const items = new Map(removed.map((f) => [f.id, f] as const));
  for (const id of oldOwn.keys()) {
    const node = graph.node(id);
    if (now.has(id) || !node) continue;
    const f = items.get(id);
    notes.record({ node: id, label: node.label, workspace: "design", change: f ? `you removed ${itemCalled(f)}` : changeWords("profile", true) }, graph.remove(id), graph);
  }
}
