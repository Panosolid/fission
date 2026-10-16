// DRAFT: will change as the real workspaces are built.
//
// The workspace plugin API. The app shell owns the one viewport, the
// project, the selection and the history; a workspace adds its tools,
// panels and viewport overlays and saves its own part of the project.

import type { KernelClient } from "../kernel/kernel-client";
import type { History, Selection } from "./session.ts";
import type { Project, WorkspaceId } from "./project.ts";
import type { SharedViewport } from "./viewport.ts";

export interface ToolbarItem {
  id: string;
  label: string;
  run(): void;
}

export interface ViewportOverlay {
  id: string;
  /** Called when the overlay should draw (e.g. load arrows, toolpaths). */
  draw(): void;
}

/** What the shell hands a workspace when it is shown. */
export interface WorkspaceContext {
  project: Project;
  kernel: KernelClient;
  selection: Selection;
  history: History;
  /** The panel element the workspace fills (the viewport stays shared). */
  panel: HTMLElement;
  viewport: SharedViewport;
}

export interface WorkspacePlugin {
  id: WorkspaceId;
  title: string;
  /** One line: what this workspace is for. */
  summary: string;
  /** Placeholders say so; the shell marks them in the switcher. */
  status: "working" | "placeholder";
  /** Shows the workspace in ctx.panel. Returns a function that hides it again. */
  mount(ctx: WorkspaceContext): () => void;
  toolbar?(): ToolbarItem[];
  overlays?(): ViewportOverlay[];
  /** Its own part of the project file. */
  save?(): unknown;
  load?(data: unknown): void;
}
