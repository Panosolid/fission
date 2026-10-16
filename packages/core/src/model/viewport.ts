// DRAFT: will change as the real workspaces are built.
//
// The one 3D viewport every workspace draws into (@fission/viewport
// implements it). Switching workspaces keeps it, so the camera stays put.

import type { DisplayMesh } from "../kernel/kernel-types.ts";
import type { AnalysisOverlay } from "./overlay.ts";
import type { ImageRep } from "./representation.ts";

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

/** A corner of the view cube: an isometric view from that corner (front is −Y, right is +X). */
export type CornerView = `${"top" | "bottom"}-${"front" | "back"}-${"left" | "right"}`;

/** The standard views: "home" (three-quarter, the default), the six faces of the view cube and its eight corners. */
export type ViewName = "home" | "top" | "bottom" | "front" | "back" | "left" | "right" | CornerView;

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
  /**
   * Shows an image as a flat sheet at its real size in mm, lying on the XY
   * plane with its centre at the origin and its top towards +Y, in a
   * top-down 2D view (pan and zoom, no orbit; the standard views and fit
   * all frame the sheet). The body is hidden meanwhile. A second call
   * replaces the image and keeps the camera. Throws a readable Error when
   * the screen's graphics can't hold an image that large. Null shows the
   * same 2D view with nothing in it (a workspace with no image open yet):
   * the background only, never the body.
   */
  showImage(image: ImageRep | null): void;
  /** Leaves the 2D view, removing any image, and gives back the body and the 3D camera as they were before showImage. Does nothing when no image is shown. */
  clearImage(): void;
}
