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
import type { ActionRegistry } from "./actions.ts";
import type { ChangeNotes } from "./change-notes.ts";
import type { CommandSpec } from "./commands.ts";
import type { DownstreamRegistry } from "./downstream.ts";
import type { DependencyGraph } from "./graph.ts";
import type { ShortcutSpec } from "./shortcuts.ts";
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
  /** Call after changing `project`, so the shell can autosave it. */
  projectChanged(): void;
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
  /** The one action registry: the verbs every workspace offers for what is selected. */
  actions: ActionRegistry;
  /** The one downstream registry: what other workspaces make from the design, shown as chips in Design's properties panel. */
  downstream: DownstreamRegistry;
  /**
   * The project's change notes (docs/integration.md, principle 9). Whoever
   * calls graph.changed or graph.remove for a user's edit also records it
   * here with the cause's words; the shell shows the notes about the
   * workspaces on screen over their viewports.
   */
  changeNotes: ChangeNotes;
  /** Opens workspace `id`: beside this one when a split is open, else in place of it. */
  openWorkspace(id: WorkspaceId): void;
  /** A workspace's title as the user sees it ("Slice"). */
  workspaceTitle(id: WorkspaceId): string;
}

/**
 * A workspace the shell has mounted (X7, docs/integration.md principle 10).
 * The slots stay the workspace's own between sleep and wake; the shell
 * takes them off screen and puts them back, so a sleeping workspace never
 * has to empty or refill them.
 */
export interface MountedWorkspace {
  /**
   * Going off screen: stop listening to the viewport (onPick back to null),
   * keys and the selection, and take back what it drew in the viewport.
   * Work finishing while asleep must not draw; it waits for wake.
   * Leave out when the workspace listens to nothing (placeholders).
   */
  sleep?(): void;
  /** Back on screen: listen again and redraw what may have changed meanwhile (the selection, the graph, the viewport). */
  wake?(): void;
  /**
   * Runs the plugin's shortcut `id` (X7b): the shell calls it only while
   * this workspace is on screen, with the key press or clipboard event.
   * Return false to decline (nothing to copy): the browser then does what
   * it would have done. A workspace never listens to the keyboard itself.
   */
  shortcut?(id: string, event: Event): boolean | void;
  /** Gone for good (a project opened, its pane closed): stops listening if awake, and empties every slot it filled. */
  unmount(): void;
}

export interface WorkspacePlugin {
  id: WorkspaceId;
  title: string;
  /** One line: what this workspace is for. */
  summary: string;
  /** Placeholders say so; the shell marks them in the switcher. */
  status: "working" | "placeholder";
  /**
   * Shows the workspace in ctx's layout slots, the first time it is opened
   * in a pane. The shell keeps it warm after that (X7): switching away puts
   * it to sleep and keeps its slots as they are, off screen; switching back
   * wakes it, so nothing is built twice and nothing typed is lost.
   */
  mount(ctx: WorkspaceContext): MountedWorkspace;
  /** What it can hand to other workspaces, and take from them. Placeholders declare nothing. */
  representations: { produces: RepresentationKind[]; accepts: RepresentationKind[] };
  /** Registers its producers with the shared registry; called once at start-up. */
  registerRepresentations?(registry: RepresentationRegistry, kernel: KernelCalls): void;
  /** Registers the verbs it offers on a selection (actions.ts); called once at start-up. Placeholders register none. */
  registerActions?(registry: ActionRegistry): void;
  /** Registers the summaries it makes from the design (downstream.ts), shown as chips in Design; called once at start-up. Placeholders register none. */
  registerDownstream?(registry: DownstreamRegistry): void;
  /**
   * Brings its own part of a loaded project (project.workspaces[id]) up to
   * the version this build writes; throws a clear error for data it can't read.
   */
  readData?(data: unknown): unknown;
  /** The actions a user can take here, as data: the panel, scripts and the AI assistant all go through these. */
  commands: readonly CommandSpec[];
  /**
   * Its keys (X7b), in the one shortcut table (shortcuts.ts): the keys its
   * own users already know, which may differ from another workspace's. The
   * shell runs them through the mounted workspace's `shortcut`.
   */
  shortcuts?: readonly ShortcutSpec[];
  toolbar?(): ToolbarItem[];
  overlays?(): ViewportOverlay[];
}
