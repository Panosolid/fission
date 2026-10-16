// Design's timeline in the project-wide dependency graph.

import type { DependencyGraph } from "@fission/core";
import { lastFeature, type DesignDocument } from "./document.ts";

/** Graph id of the part's mass properties and mesh: cheap, rebuilt at once after every change. */
export const PART_VIEW = "design.part-view";

/**
 * Puts the document's profiles and features in the project graph, with the
 * part's view reading the last feature, and marks downstream of whatever
 * differs from `before` out of date.
 */
export function syncGraph(graph: DependencyGraph, doc: DesignDocument, before: DesignDocument | null): void {
  const changed: string[] = [];
  const old = new Map<string, unknown>([...(before?.profiles ?? []), ...(before?.timeline.features ?? [])].map((x) => [x.id, x]));
  const differs = (x: { id: string }) => JSON.stringify(old.get(x.id)) !== JSON.stringify(x);
  for (const p of doc.profiles) {
    graph.set({ id: p.id, label: `Profile ${p.id}`, workspace: "design", cost: "cheap" });
    if (differs(p)) changed.push(p.id);
  }
  for (const f of doc.timeline.features) {
    graph.set({ id: f.id, label: f.intent.summary, workspace: "design", cost: "cheap" }, f.dependsOn);
    if (differs(f)) changed.push(f.id);
  }
  graph.set({ id: PART_VIEW, label: "Volume, area and mesh", workspace: "design", cost: "cheap" }, [lastFeature(doc).id]);
  for (const id of changed) graph.changed(id);
  // Profiles and features that are gone (their readers were re-pointed above).
  const now = new Set([...doc.profiles, ...doc.timeline.features].map((x) => x.id));
  for (const id of old.keys()) if (!now.has(id) && graph.has(id)) graph.remove(id);
}

