// Design's timeline in the project-wide dependency graph.

import type { ChangeNotes, DependencyGraph } from "@fission/core";
import { lastFeature, type DesignDocument } from "./document.ts";

/** Graph id of the part's mass properties and mesh: cheap, rebuilt at once after every change. */
export const PART_VIEW = "design.part-view";

/** What the user did, as a change note says it: "you changed the box". */
export function changeWords(kind: string, removed = false): string {
  const thing = ({ extrude: "extrusion" } as Record<string, string>)[kind] ?? kind;
  return `you ${removed ? "removed" : "changed"} the ${thing}`;
}

/**
 * Puts the document's profiles and features in the project graph, with the
 * part's view reading the last feature, and marks downstream of whatever
 * differs from `before` out of date. Each change and removal is recorded in
 * `notes` with its words, so a result in another workspace that it updates
 * gets a note naming it.
 */
export function syncGraph(graph: DependencyGraph, doc: DesignDocument, before: DesignDocument | null, notes: ChangeNotes): void {
  const changed: { id: string; label: string; kind: string }[] = [];
  // A sketch's item and its content are one node: drawing a line changes the sketch.
  const content = (d: DesignDocument, x: { id: string }) => (d.sketches.some((s) => s.id === x.id) ? [x, d.sketches.find((s) => s.id === x.id)] : x);
  const old = new Map<string, unknown>(before ? [...before.profiles, ...before.timeline.features].map((x) => [x.id, content(before, x)]) : []);
  const differs = (x: { id: string }) => JSON.stringify(old.get(x.id)) !== JSON.stringify(content(doc, x));
  for (const p of doc.profiles) {
    graph.set({ id: p.id, label: `Profile ${p.id}`, workspace: "design", cost: "cheap" });
    if (differs(p)) changed.push({ id: p.id, label: `Profile ${p.id}`, kind: "profile" });
  }
  for (const f of doc.timeline.features) {
    graph.set({ id: f.id, label: f.intent.summary, workspace: "design", cost: "cheap" }, f.dependsOn);
    if (differs(f)) changed.push({ id: f.id, label: f.intent.summary, kind: f.intent.type });
  }
  graph.set({ id: PART_VIEW, label: "Volume, area and mesh", workspace: "design", cost: "cheap" }, [lastFeature(doc).id]);
  for (const c of changed) notes.record({ node: c.id, label: c.label, workspace: "design", change: changeWords(c.kind) }, graph.changed(c.id), graph);
  // Profiles and features that are gone (their readers were re-pointed above).
  const now = new Set([...doc.profiles, ...doc.timeline.features].map((x) => x.id));
  for (const id of old.keys()) {
    const node = graph.node(id);
    if (now.has(id) || !node) continue;
    const kind = before?.timeline.features.find((f) => f.id === id)?.intent.type ?? "profile";
    notes.record({ node: id, label: node.label, workspace: "design", change: changeWords(kind, true) }, graph.remove(id), graph);
  }
}

