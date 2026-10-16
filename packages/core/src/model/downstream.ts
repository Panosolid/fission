// Downstream results while designing (docs/integration.md, principle 4):
// a downstream workspace registers a short summary of what it makes from
// the design ("Print: 2 h 14 m · 38 g", "Laser: 6 min · 1 sheet"), and
// Design's properties panel shows each one as a chip that previews on
// hover and leads to its workspace on click. Each summary is a node of the
// dependency graph, so whether it is up to date comes from the graph, never
// from the workspace: a result the graph marks out of date is never shown
// as current. Cheap results are rebuilt in the background ("updating");
// expensive ones wait for the user's rerun ("needs rerun").

import type { Cost, DependencyGraph } from "./graph.ts";
import type { WorkspaceId } from "./project.ts";

/** What a downstream workspace registers: one result it makes from the design. */
export interface DownstreamSource {
  /** Unique, prefixed by the workspace: "slice.print-estimate". */
  id: string;
  /** The workspace that makes the result; clicking the chip goes there. */
  workspace: WorkspaceId;
  /** What it is, as the chip starts: "Print". */
  label: string;
  /** The dependency-graph node this result is; its cost and freshness come from there. */
  node: string;
  /** The last result, as the chip shows it ("2 h 14 m · 38 g"); undefined until it has been worked out once. */
  value(): string | undefined;
  /** One line shown on hover: what the result is of and what it says in full. */
  preview(): string;
}

/**
 * fresh: worked out from the current design. updating: out of date (or not
 * worked out yet) and being rebuilt in the background. needs-rerun: out of
 * date (or never run) and waiting for the user's rerun. missing: its graph
 * node isn't in the project, so nothing it says can be trusted.
 */
export type DownstreamState = "fresh" | "updating" | "needs-rerun" | "missing";

/** One chip's worth: everything the UI kit needs, as plain values. */
export interface DownstreamSummary {
  id: string;
  label: string;
  /** The last result; undefined when there is none yet (or its node is missing). */
  value: string | undefined;
  /** From the graph node; undefined when the node is missing. */
  cost: Cost | undefined;
  state: DownstreamState;
  preview: string;
  /** Where a click on the chip goes. */
  target: WorkspaceId;
}

const ID = /^[a-z]+\.[a-z0-9-]+$/;

export class DownstreamRegistry {
  private sources: DownstreamSource[] = [];

  /**
   * Adds a summary. A repeated id, an id not prefixed by its workspace, an
   * empty label or no graph node is refused. Design makes the design, so it
   * has nothing downstream of itself to register.
   */
  register(source: DownstreamSource): void {
    if (!ID.test(source.id) || !source.id.startsWith(`${source.workspace}.`))
      throw new Error(`downstream summary id ${JSON.stringify(source.id)} must be "${source.workspace}.<name>" in lower case`);
    if (source.workspace === "design") throw new Error(`downstream summary ${source.id}: Design is upstream of everything, so it registers no downstream summaries`);
    if (this.sources.some((s) => s.id === source.id)) throw new Error(`downstream summary ${source.id} is already registered`);
    if (source.label.trim() === "") throw new Error(`downstream summary ${source.id} needs a label`);
    if (source.node === "") throw new Error(`downstream summary ${source.id} needs the graph node it is`);
    this.sources.push(source);
  }

  /** How many are registered. */
  get size(): number {
    return this.sources.length;
  }

  /**
   * The chips to show in `viewer`'s panel, in registration order: every
   * summary from another workspace, its state read from the graph now.
   * A workspace's own results are on its own page, not chips.
   */
  summaries(viewer: WorkspaceId, graph: DependencyGraph): DownstreamSummary[] {
    return this.sources.filter((s) => s.workspace !== viewer).map((s) => summarize(s, graph));
  }
}

/** One source's chip, with its state from the graph. */
export function summarize(source: DownstreamSource, graph: DependencyGraph): DownstreamSummary {
  const base = { id: source.id, label: source.label, preview: source.preview(), target: source.workspace };
  const node = graph.node(source.node);
  if (!node) return { ...base, value: undefined, cost: undefined, state: "missing" };
  const value = source.value();
  const current = value !== undefined && !graph.isStale(source.node);
  const state: DownstreamState = current ? "fresh" : node.cost === "cheap" ? "updating" : "needs-rerun";
  return { ...base, value, cost: node.cost, state };
}
