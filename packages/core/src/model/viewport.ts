// DRAFT: will change as the real workspaces are built.
//
// The one 3D viewport every workspace draws into (@fission/viewport
// implements it). Switching workspaces keeps it, so the camera stays put.

import type { DisplayMesh } from "../kernel/kernel-types.ts";
import type { AnalysisOverlay } from "./overlay.ts";

/** A sphere around a body: what the camera frames. */
export interface Framing {
  centre: [number, number, number];
  radius: number;
}

/**
 * What a click (not a camera drag) in the viewport hit: the kernel index of
 * the body's edge within a few pixels of the pointer (step 17c), else of the
 * face under it, or neither for empty space; and whether Shift was held. An
 * edge wins over the face behind it, so at most one of the two is set. The
 * workspace on show decides what that selects.
 */
export interface ViewportPick {
  face: number | null;
  /** Absent or null when no edge was picked. */
  edge?: number | null;
  shift: boolean;
}

export interface SharedViewport {
  /** The element the viewport fills. */
  readonly element: HTMLElement;
  showBody(mesh: DisplayMesh): void;
  /** Sphere around the current body (radius 0 if none). */
  bodyFraming(): Framing;
  /** Frames the current body; returns what it framed (null if none). */
  fit(): Framing | null;
  /** Paints an analysis overlay on the current body (replaces one with the same id). */
  setOverlay(overlay: AnalysisOverlay): void;
  clearOverlay(id: string): void;
  /** Called on every click in the viewport; the shown workspace sets it and puts back null on hide. */
  onPick: ((pick: ViewportPick) => void) | null;
}
