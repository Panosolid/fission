// DRAFT: will change as the real workspaces are built.
//
// The one 3D viewport every workspace draws into (@fission/viewport
// implements it). Switching workspaces keeps it, so the camera stays put.

import type { DisplayMesh } from "../kernel/kernel-types.ts";
import type { AnalysisOverlay } from "./overlay.ts";
import type { ImageRep, Plane } from "./representation.ts";

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
  /**
   * The offered origin plane clicked (showPlanes), by id; absent or null
   * when none was. While planes are offered a click picks the body's face
   * under the pointer whenever there is one (never an edge), else the
   * nearest offered plane: the planes are drawn behind the body (step 26d).
   */
  plane?: string | null;
  shift: boolean;
}

/** A point in a sketch plane's own 2D frame, in mm. */
export type SketchXY = readonly [number, number];

/**
 * A sketch as the viewport draws it (step 21c): its lines in its plane's
 * frame (x along `xAxis`, y along normal × xAxis), drawn over the body.
 * The sketch being edited also has its grid (spacing in mm), its points
 * and what the tool would draw at the pointer (the line tool's rubber
 * band, a rectangle's four sides), empty when it would draw nothing,
 * and where the pointer snapped (Design's snap.ts): its marks, drawn over
 * everything, and the snap in words ("endpoint 10,0"), absent on the grid.
 * `gridSnap` says points snap to the grid (sketch feel SF1), so the grid
 * drawn is the snapping one's multiples; without it the grid drawn is
 * powers of ten, adapting to the zoom (SF2).
 */
export interface SketchDrawing {
  plane: Plane;
  /**
   * Which way the sketch faces against its plane's normal (step 26d): −1
   * for a sketch on a back or bottom face, whose frame keeps the world's
   * axes (so its normal points into the body) and which is looked at from
   * the other side; absent means +1.
   */
  side?: 1 | -1;
  lines: readonly (readonly [SketchXY, SketchXY])[];
  /**
   * A finished sketch whose plane is lost (step 26e: its face is gone, so
   * it stays where it was): drawn red, as the reference app draws a lost
   * profile. Absent means drawn as usual.
   */
  lost?: true;
  editing?: { grid: number; gridSnap?: boolean; points: readonly SketchXY[]; preview: readonly (readonly [SketchXY, SketchXY])[]; snap?: { label: string; marks: readonly (readonly [SketchXY, SketchXY])[] } };
}

/** An origin plane drawn small at the origin to be picked (Create sketch); one not offered is drawn faint and can't be clicked. */
export interface OriginPlane {
  id: string;
  plane: Plane;
  offered: boolean;
}

/**
 * The pointer over the sketch being edited: where it meets the sketch's
 * plane in its frame, or null (off the view, or looking along the plane),
 * and how big a screen pixel is on the plane there (mm), for snapping
 * within a few pixels; absent when the viewport can't tell.
 */
export interface SketchPointer {
  kind: "move" | "click";
  at: SketchXY | null;
  pixel?: number;
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
  /** Sphere around the current body and the finished sketches drawn, lost ones too (radius 0 if none); what fit frames. */
  bodyFraming(): Framing;
  /** Frames the current body; returns what it framed (null if none). */
  fit(): Framing | null;
  /** Turns the camera to a standard view framing the current body; returns what it framed (null if none). */
  setView(name: ViewName): Framing | null;
  /** Frames the selection (as last shown) from the current direction; null, camera untouched, when nothing is selected. */
  fitSelection(): Framing | null;
  /**
   * Look At (sketch feel SF2): the camera square onto the plane, its y axis
   * up on screen, framing the body and the edited sketch (or 50 mm round
   * the plane's origin when there is neither); returns what it framed. The
   * camera is on the side the normal points to, or the other side for
   * `side` −1 (a sketch on a back or bottom face, step 26d), with up on
   * screen then the plane's y or −y, whichever the standard view looking
   * that way has nearer its up (a bottom face is seen as the bottom view
   * sees it, the front at the top).
   */
  lookAt(plane: Plane, side?: 1 | -1): Framing | null;
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
  /** Draws these sketches (replacing the ones drawn before); an empty list draws none. While one is being edited the ground grid gives way to its own. */
  showSketches(drawings: readonly SketchDrawing[]): void;
  /**
   * Draws the origin planes small at the origin for picking (a click on an
   * offered one picks it); an empty list takes them away. `faces` (step
   * 26d) are the body's faces that can be picked as well (by index, as
   * picks give them): while planes are shown, the pointer lights only an
   * offered plane or one of these faces, never an edge.
   */
  showPlanes(planes: readonly OriginPlane[], faces?: readonly number[]): void;
  /**
   * While set and a sketch is being edited (showSketches), clicks and
   * hovers over the viewport come here instead of onPick, with where they
   * meet that sketch's plane. The shown workspace sets it and puts back
   * null on hide.
   */
  onSketchPointer: ((pointer: SketchPointer) => void) | null;
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
