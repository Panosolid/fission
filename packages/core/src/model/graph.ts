// The project-wide dependency graph: what depends on what, across every
// workspace. When something changes, everything downstream of it is
// marked out of date. Cheap results (mass properties, previews, print
// estimates) are rebuilt straight away in the background (the kernel's Web
// Worker); expensive ones (simulations, toolpaths, renders) wait for the
// user to click rerun. A stale result is never shown without its mark.

import type { WorkspaceId } from "./project.ts";

export type Cost = "cheap" | "expensive";

export interface GraphNode {
  id: string;
  label: string;
  workspace: WorkspaceId;
  /** How a stale result is brought up to date: at once ("cheap") or on a rerun click ("expensive"). */
  cost: Cost;
}

/** What one change set off. */
export interface Staleness {
  /** Marked out of date; rebuild now, in the background. */
  updateNow: string[];
  /** Marked out of date; wait for the user's rerun. */
  awaitingRerun: string[];
}

export class DependencyGraph {
  private nodes = new Map<string, GraphNode>();
  /** id → the ids it reads. */
  private inputs = new Map<string, string[]>();
  private staleIds = new Set<string>();

  /**
   * Adds or replaces a node. Its inputs must already be in the graph, and
   * no cycle may form: a result can't depend on itself.
   */
  set(node: GraphNode, dependsOn: string[] = []): void {
    for (const d of dependsOn) {
      if (!this.nodes.has(d)) throw new Error(`${node.label} depends on ${d}, which is not in the project`);
      if (d === node.id || this.upstreamOf(d).has(node.id)) throw new Error(`${node.label} would depend on itself through ${d}`);
    }
    this.nodes.set(node.id, node);
    this.inputs.set(node.id, [...dependsOn]);
  }

  /** Removes a node; anything still reading it is marked out of date and keeps a dangling input, reported by missingInputs(). */
  remove(id: string): Staleness {
    const result = this.changed(id);
    this.nodes.delete(id);
    this.inputs.delete(id);
    this.staleIds.delete(id);
    return result;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** The node with this id, or undefined. */
  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Ids `id` reads, directly or through others. */
  upstreamOf(id: string): Set<string> {
    const seen = new Set<string>();
    const walk = (x: string) => {
      for (const d of this.inputs.get(x) ?? []) if (!seen.has(d)) (seen.add(d), walk(d));
    };
    walk(id);
    return seen;
  }

  /** Ids that read `id`, directly or through others. */
  downstreamOf(id: string): Set<string> {
    const seen = new Set<string>();
    const walk = (x: string) => {
      for (const [n, ins] of this.inputs) if (ins.includes(x) && !seen.has(n)) (seen.add(n), walk(n));
    };
    walk(id);
    return seen;
  }

  /** `id` changed: marks everything downstream out of date and says what to rebuild now. */
  changed(id: string): Staleness {
    const result: Staleness = { updateNow: [], awaitingRerun: [] };
    for (const n of this.downstreamOf(id)) {
      this.staleIds.add(n);
      (this.nodes.get(n)!.cost === "cheap" ? result.updateNow : result.awaitingRerun).push(n);
    }
    return result;
  }

  isStale(id: string): boolean {
    return this.staleIds.has(id);
  }

  /** A result was rebuilt from its current inputs. */
  markFresh(id: string): void {
    this.staleIds.delete(id);
  }

  stale(): string[] {
    return [...this.staleIds];
  }

  /** Inputs that were removed while something still reads them: show these as warnings, never drop them. */
  missingInputs(): { id: string; missing: string }[] {
    const out: { id: string; missing: string }[] = [];
    for (const [id, ins] of this.inputs) for (const d of ins) if (!this.nodes.has(d)) out.push({ id, missing: d });
    return out;
  }
}
