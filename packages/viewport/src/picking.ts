// Turning a pointer press and release into a pick (step 17b). Pure, so the
// rules are unit-tested without a browser; viewer.ts does the raycast.

/** A press and release closer than this many CSS pixels is a click; further apart, the camera was dragged. */
export const CLICK_SLOP_PX = 4;

/** True when the pointer moved less than `CLICK_SLOP_PX` between press and release. */
export function isClick(down: { x: number; y: number }, up: { x: number; y: number }): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) < CLICK_SLOP_PX;
}

/**
 * The kernel face index of the display mesh's triangle `triangle` (from
 * `triangle_faces`), or null when nothing usable was hit: no triangle, or an
 * index outside the mesh (a stale hit on a mesh that was just replaced).
 */
export function faceOfTriangle(triangleFaces: ArrayLike<number>, triangle: number | null | undefined): number | null {
  if (triangle == null || !Number.isInteger(triangle) || triangle < 0 || triangle >= triangleFaces.length) return null;
  return triangleFaces[triangle];
}
