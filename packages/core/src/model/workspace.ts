// The public Workspace API. Every workspace, ours included, is a plugin
// built against this and nothing else: no private shortcuts (a test in
// packages/testing checks workspaces import only package entry points).
// An outside developer could add a workspace that follows the same
// integration rules. Version WORKSPACE_API_VERSION; documented in
// docs/integration.md. Parts marked DRAFT will change as the real
// workspaces are built.
//
// The shell owns the one viewport, the project, the selection, the
// history, the dependency graph and the representation registry; a
// workspace fills the three layout slots around the viewport (toolbar
// above, browser left, properties right), keeps its data in
// project.workspaces[id], and says what it can hand to and take from
// other workspaces.

import type { KernelCalls } from "../kernel/kernel-client.ts";
import type { CommandSpec } from "./commands.ts";
import type { DependencyGraph } from "./graph.ts";
import type { RepresentationKind, RepresentationRegistry } from "./representation.ts";
import type { History, Selection } from "./session.ts";
import type { Project, WorkspaceId } from "./project.ts";
import type { SharedViewport } from "./viewport.ts";

export interface ToolbarItem {
  id: string;
  label: string;
  run(): void;
}

/** DRAFT: 3D things a workspace draws in the viewport (load arrows, toolpaths). Colours on faces go through SharedViewport.setOverlay. */
export interface ViewportOverlay {
  id: string;
  draw(): void;
}

export const WORKSPACE_API_VERSION = 1;

/** What the shell hands a workspace when it is shown. */
export interface WorkspaceContext {
  project: Project;
  kernel: KernelCalls;
  selection: Selection;
  history: History;
  /** The project-wide dependency graph: what depends on what, and what is out of date. */
  graph: DependencyGraph;
  /** The strip above the viewport, for the workspace's tools. Empty when shown; leave it empty on hide. */
  toolbar: HTMLElement;
  /** The panel left of the viewport: what the workspace holds (timeline, bodies). Empty when shown; leave it empty on hide. */
  browser: HTMLElement;
  /** The panel right of the viewport: details of what is being edited; placeholders show their page here. Empty when shown; leave it empty on hide. */
  properties: HTMLElement;
  viewport: SharedViewport;
  /** The one conversion layer between workspaces. */
  representations: RepresentationRegistry;
}

export interface WorkspacePlugin {
  id: WorkspaceId;
  title: string;
  /** One line: what this workspace is for. */
  summary: string;
  /** Placeholders say so; the shell marks them in the switcher. */
  status: "working" | "placeholder";
  /** Shows the workspace in ctx's layout slots. Returns a function that hides it again and empties every slot it filled. */
  mount(ctx: WorkspaceContext): () => void;
  /** What it can hand to other workspaces, and take from them. Placeholders declare nothing. */
  representations: { produces: RepresentationKind[]; accepts: RepresentationKind[] };
  /** Registers its producers with the shared registry; called once at start-up. */
  registerRepresentations?(registry: RepresentationRegistry, kernel: KernelCalls): void;
  /**
   * Brings its own part of a loaded project (project.workspaces[id]) up to
   * the version this build writes; throws a clear error for data it can't read.
   */
  readData?(data: unknown): unknown;
  /** The actions a user can take here, as data: the panel, scripts and the AI assistant all go through these. */
  commands: readonly CommandSpec[];
  toolbar?(): ToolbarItem[];
  overlays?(): ViewportOverlay[];
}
