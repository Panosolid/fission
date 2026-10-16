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

/**
 * What the viewport draws in the selection colour (step 17d): the whole
 * body, and faces and edges by kernel index. Indices the body on screen
 * does not have draw nothing. Analysis overlays stay visible under it.
 */
export interface ViewportHighlight {
  body: boolean;
  faces: readonly number[];
  edges: readonly number[];
}

/** Nothing highlighted. */
export const NO_HIGHLIGHT: ViewportHighlight = Object.freeze({ body: false, faces: [], edges: [] });

/** The standard views: "home" (three-quarter, the default), "top", "front", "right". */
export type ViewName = "home" | "top" | "front" | "right";

export interface SharedViewport {
  /** The element the viewport fills. */
  readonly element: HTMLElement;
  showBody(mesh: DisplayMesh): void;
  /** Sphere around the current body (radius 0 if none). */
  bodyFraming(): Framing;
  /** Frames the current body; returns what it framed (null if none). */
  fit(): Framing | null;
  /** Turns the camera to a standard view framing the current body; returns what it framed (null if none). */
  setView(name: ViewName): Framing | null;
  /** Frames the selection (as last shown) from the current direction; null, camera untouched, when nothing is selected. */
  fitSelection(): Framing | null;
  /** Paints an analysis overlay on the current body (replaces one with the same id). */
  setOverlay(overlay: AnalysisOverlay): void;
  clearOverlay(id: string): void;
  /** Draws the selection; it stays (across new bodies) until the next call. The shown workspace sets it and puts back NO_HIGHLIGHT on hide. */
  showSelection(highlight: ViewportHighlight): void;
  /**
   * Called on every click in the viewport; the shown workspace sets it and
   * puts back null on hide. While it is set, the face or edge under the
   * pointer is drawn hovered.
   */
  onPick: ((pick: ViewportPick) => void) | null;
}
