// Split view (X3): each workspace on screen gets a SharedViewport of its
// own over one view of the one viewer. Scene methods (body, selection,
// overlays) go to the viewer, so every view draws the same thing; camera
// methods (fit, setView, fitSelection, lookAt) and an image (showImage, clearImage)
// go to that pane's view only.
import type { AnalysisOverlay, DisplayMesh, Framing, ImageRep, OriginPlane, Plane, SharedViewport, SketchDrawing, SketchPointer, ViewName, ViewportHighlight, ViewportPick } from "@fission/core";

/** What a pane needs of its view: the element it fills and its camera. */
export interface PaneCamera {
  readonly element: HTMLElement;
  fit(): Framing | null;
  setView(name: ViewName): Framing | null;
  fitSelection(): Framing | null;
  lookAt(plane: Plane, side?: 1 | -1): Framing | null;
  showImage(image: ImageRep | null): void;
  clearImage(): void;
}

type PickHandler = (pick: ViewportPick) => void;
type SketchHandler = (pointer: SketchPointer) => void;

/**
 * Returns a maker of panes over `scene` (the Viewer). The viewer has one
 * pick handler; each pane sets its own, and the viewer uses the one set
 * most recently by a pane that still has one. So one pane clearing its
 * handler on hide never takes away another pane's (a click in any view
 * then picks for the workspace that still listens).
 */
export function paneViewports(scene: SharedViewport): (view: PaneCamera) => SharedViewport {
  const pickers = new Map<object, PickHandler>(); // in the order they were set
  const sketchers = new Map<object, SketchHandler>(); // the same rule for the sketch pointer
  const sync = () => {
    scene.onPick = [...pickers.values()].at(-1) ?? null;
    scene.onSketchPointer = [...sketchers.values()].at(-1) ?? null;
  };
  return (view) => {
    const key = {};
    return {
      element: view.element,
      showBody: (mesh: DisplayMesh) => scene.showBody(mesh),
      bodyFraming: () => scene.bodyFraming(),
      fit: () => view.fit(),
      setView: (name: ViewName) => view.setView(name),
      fitSelection: () => view.fitSelection(),
      lookAt: (plane: Plane, side?: 1 | -1) => view.lookAt(plane, side),
      showImage: (image: ImageRep | null) => view.showImage(image),
      clearImage: () => view.clearImage(),
      setOverlay: (overlay: AnalysisOverlay) => scene.setOverlay(overlay),
      clearOverlay: (id: string) => scene.clearOverlay(id),
      showSelection: (highlight: ViewportHighlight) => scene.showSelection(highlight),
      showSketches: (drawings: readonly SketchDrawing[]) => scene.showSketches(drawings),
      showPlanes: (planes: readonly OriginPlane[], faces?: readonly number[]) => scene.showPlanes(planes, faces),
      get onSketchPointer() {
        return sketchers.get(key) ?? null;
      },
      set onSketchPointer(handler: SketchHandler | null) {
        sketchers.delete(key);
        if (handler) sketchers.set(key, handler);
        sync();
      },
      get onPick() {
        return pickers.get(key) ?? null;
      },
      set onPick(handler: PickHandler | null) {
        pickers.delete(key); // a new handler moves to the end
        if (handler) pickers.set(key, handler);
        sync();
      },
    };
  };
}
