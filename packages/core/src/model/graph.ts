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
  /** id → the ids that read it, the other way round from `inputs`, so finding readers doesn't search every node (security audit S2). */
  private readers = new Map<string, Set<string>>();
  /** id → when it first entered `inputs`: readers are walked in that order, the order `inputs` iterates in. */
  private order = new Map<string, number>();
  private added = 0;
  private staleIds = new Set<string>();
  private listeners = new Set<() => void>();

  /**
   * Calls `listener` after every change to the graph (a node set or removed,
   * something marked out of date or fresh), so whatever shows state read
   * from it (the change notes) can redraw. Returns a function that stops it.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /**
   * Adds or replaces a node. Its inputs must already be in the graph, and
   * no cycle may form: a result can't depend on itself.
   */
  set(node: GraphNode, dependsOn: string[] = []): void {
    for (const d of dependsOn) {
      if (!this.nodes.has(d)) throw new Error(`${node.label} depends on ${d}, which is not in the project`);
      // Only an id something reads can be upstream of d: a new id nothing reads skips the walk, so a long chain is built in linear time.
      if (d === node.id || (this.readers.has(node.id) && this.upstreamOf(d).has(node.id))) throw new Error(`${node.label} would depend on itself through ${d}`);
    }
    this.nodes.set(node.id, node);
    this.unlink(node.id);
    if (!this.order.has(node.id)) this.order.set(node.id, this.added++);
    this.inputs.set(node.id, [...dependsOn]);
    for (const d of dependsOn) {
      const r = this.readers.get(d);
      if (r) r.add(node.id);
      else this.readers.set(d, new Set([node.id]));
    }
    this.notify();
  }

  /** Removes a node; anything still reading it is marked out of date and keeps a dangling input, reported by missingInputs(). */
  remove(id: string): Staleness {
    const result = this.changed(id);
    this.nodes.delete(id);
    this.unlink(id);
    this.inputs.delete(id);
    this.order.delete(id);
    this.staleIds.delete(id);
    this.notify();
    return result;
  }

  /** Takes `id` out of the readers of what it reads now. */
  private unlink(id: string): void {
    for (const d of this.inputs.get(id) ?? []) {
      const r = this.readers.get(d);
      r?.delete(id);
      if (r?.size === 0) this.readers.delete(d);
    }
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** The node with this id, or undefined. */
  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Ids `id` reads, directly or through others, depth first; no recursion, so a long chain can't overflow the stack. */
  upstreamOf(id: string): Set<string> {
    return this.walk(id, (x) => this.inputs.get(x) ?? []);
  }

  /** Depth first from `id` through `next`, each id once, in the order found. */
  private walk(id: string, next: (x: string) => readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [{ list: next(id), at: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.at === top.list.length) {
        stack.pop();
        continue;
      }
      const n = top.list[top.at++];
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push({ list: next(n), at: 0 });
    }
    return seen;
  }

  /**
   * Ids that read `id`, directly or through others, depth first with each
   * id's readers in the order they entered the graph. Time in proportion
   * to what it finds, through `readers`, and no recursion, so a long chain
   * can't overflow the stack (security audit S2).
   */
  downstreamOf(id: string): Set<string> {
    return this.walk(id, (x) => [...(this.readers.get(x) ?? [])].sort((a, b) => this.order.get(a)! - this.order.get(b)!));
  }

  /**
   * The shortest chain by which `to` reads `from`: [from, …, to], each id
   * read by the next. Ties go to inputs in the order they were given, so
   * the answer is the same every time. Undefined when `to` doesn't read
   * `from`. Still works when `from` was removed, because what read it keeps
   * the dangling input.
   */
  path(from: string, to: string): string[] | undefined {
    if (from === to) return undefined;
    // Breadth-first from `to` back through inputs; next[x] is the id x feeds on the way to `to`.
    const next = new Map<string, string>();
    const queue = [to];
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i];
      for (const d of this.inputs.get(x) ?? []) {
        if (d === to || next.has(d)) continue;
        next.set(d, x);
        if (d === from) {
          const chain = [from];
          for (let y = from; y !== to; ) chain.push((y = next.get(y)!));
          return chain;
        }
        queue.push(d);
      }
    }
    return undefined;
  }

  /** `id` changed: marks everything downstream out of date and says what to rebuild now. */
  changed(id: string): Staleness {
    const result: Staleness = { updateNow: [], awaitingRerun: [] };
    for (const n of this.downstreamOf(id)) {
      this.staleIds.add(n);
      (this.nodes.get(n)!.cost === "cheap" ? result.updateNow : result.awaitingRerun).push(n);
    }
    if (result.updateNow.length + result.awaitingRerun.length > 0) this.notify();
    return result;
  }

  isStale(id: string): boolean {
    return this.staleIds.has(id);
  }

  /** A result was rebuilt from its current inputs. */
  markFresh(id: string): void {
    if (this.staleIds.delete(id)) this.notify();
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
