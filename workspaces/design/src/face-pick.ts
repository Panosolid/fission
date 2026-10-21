// Where Create sketch puts a new sketch (step 26d): a click while the
// planes are offered picks an origin plane or a face of a body on screen
// (the viewport hands over the nearer, never an edge). A flat face with a
// name of its own gets a sketch on it, with the frame the naming model's
// rule 8 gives it (face-sketch.ts `drawnOnFace`); a curved face is refused
// in words (the owner's answer Q5: Fusion offers no sketch on a curved
// face), and so is a face whose name another face shares, since a sketch
// on it could not follow it (the face it names would be a guess).

import type { ViewportPick } from "@fission/core";
import { SKETCH_PLANES, type SketchPlane } from "./document.ts";
import { drawnOnFace, faceFeature, type SketchPlacement } from "./face-sketch.ts";
import { designReference } from "./references.ts";
import { sceneHit, type Scene } from "./scene.ts";

/** What a click on a curved face says (Q5). */
export const CURVED_FACE = "Sketches go on flat faces or planes, and this face is curved: pick a flat face or a plane.";

/** What a click on a face with no name of its own says. */
export const UNNAMED_FACE = "This face has no name of its own (another face shares it), so a sketch on it could not follow it: pick another face or a plane.";

/** Where a click puts the new sketch: an origin plane, a flat face (its name, its feature and the frame it is drawn with), or nowhere with the words why. */
export type SketchSpot =
  | { kind: "plane"; plane: SketchPlane }
  | { kind: "face"; face: { plane: string; feature: string }; drawn: SketchPlacement }
  | { kind: "refused"; message: string };

/**
 * Where a click while the planes are offered puts the new sketch: the
 * origin plane it names, or the face it hit on the bodies on screen
 * (`scene`, whose joined numbering the pick uses) when that face is flat
 * and has a name; refused with words for a curved face or one with no
 * name. Null when it hit nothing a sketch could go on (empty space, a
 * plane that is not an origin plane, a face of no body on screen).
 */
export function sketchSpot(pick: ViewportPick, scene: Scene | null): SketchSpot | null {
  if (pick.plane != null) return (SKETCH_PLANES as readonly string[]).includes(pick.plane) ? { kind: "plane", plane: pick.plane as SketchPlane } : null;
  if (pick.face === null || scene === null || !Number.isInteger(pick.face) || pick.face < 0) return null;
  const hit = sceneHit(scene, "face", pick.face);
  if (hit === null) return null;
  const body = scene.bodies[hit.body];
  const drawn = drawnOnFace(body.view, hit.index);
  if (drawn === null) return { kind: "refused", message: CURVED_FACE };
  const ref = designReference("face", body.names, hit.index);
  const feature = ref === null ? null : faceFeature(ref.id);
  if (ref === null || feature !== body.feature) return { kind: "refused", message: UNNAMED_FACE };
  return { kind: "face", face: { plane: ref.id, feature }, drawn };
}

/** The faces of the bodies on screen a sketch can go on (joined numbering, for the viewport to light): the flat ones with a name of their own. */
export function sketchableFaces(scene: Scene | null): number[] {
  if (scene === null) return [];
  const faces: number[] = [];
  scene.bodies.forEach((body, b) => {
    for (let i = 0; i < body.view.faces; i++) if (sketchSpot({ face: scene.faceStart[b] + i, shift: false }, scene)?.kind === "face") faces.push(scene.faceStart[b] + i);
  });
  return faces;
}
