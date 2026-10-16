import type { ViewName } from "@fission/core";
import type { Framing } from "./framing.ts";

type Vec3 = [number, number, number];

export type { ViewName };

/** The standard views. "home" is the three-quarter view fit() has always used. */
export const VIEW_NAMES: readonly ViewName[] = ["home", "top", "front", "right"];

/** Where the camera sits, what it looks at, and which way is up on screen. */
export interface ViewBasis {
  position: Vec3;
  target: Vec3;
  up: Vec3;
}

/** Direction from the target to the camera, and the screen's up, per view (Z is up in the model). */
const VIEWS: Record<ViewName, { towardCamera: Vec3; up: Vec3 }> = {
  home: { towardCamera: [0.6, -0.8, 0.55], up: [0, 0, 1] },
  top: { towardCamera: [0, 0, 1], up: [0, 1, 0] }, // looking down −Z, +Y up on screen
  front: { towardCamera: [0, -1, 0], up: [0, 0, 1] }, // from −Y looking along +Y, +X to the right
  right: { towardCamera: [1, 0, 0], up: [0, 0, 1] }, // from +X looking along −X, +Y to the right
};

/**
 * The camera for a standard view of a framed sphere: it looks at the centre
 * from `radius / sin(fov / 2)` away, the distance at which the sphere just
 * fits the vertical field of view (vertical fov in degrees).
 */
export function viewBasis(name: ViewName, framing: Framing, fovDeg = 45): ViewBasis {
  const { towardCamera, up } = VIEWS[name];
  const n = Math.hypot(...towardCamera);
  const dist = framing.radius / Math.sin((fovDeg * Math.PI) / 360);
  const target: Vec3 = [...framing.centre];
  const position = target.map((c, i) => c + (towardCamera[i] / n) * dist) as Vec3;
  return { position, target, up: [...up] };
}
