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

// Edges (step 17c): an edge is picked when the pointer is within
// `EDGE_PICK_PX` of its drawn line on screen and nothing hides that spot;
// an edge wins over the face behind it.

/** How close (CSS pixels) the pointer must come to an edge's line to pick it. Exactly this far is a miss. */
export const EDGE_PICK_PX = 5;

/**
 * Relative slack when asking whether a face hides a point of an edge: a face
 * hit closer than `distance × (1 − EDGE_DEPTH_SLACK)` hides it. The faces
 * either side of an edge contain it, so a ray to the edge meets them at the
 * edge's own distance up to f32 rounding (~1e-7 relative); 1e-3 leaves room
 * for that and for the depth offset that draws edges on top of faces, yet
 * at 100 mm from the camera a face 0.1 mm in front still hides an edge.
 */
export const EDGE_DEPTH_SLACK = 1e-3;

/** A segment near the pointer: its number, where along it (0 at its first point, 1 at its second) and how far from the pointer, in pixels. */
export interface SegmentNear {
  segment: number;
  t: number;
  distance: number;
}

/**
 * Segments whose on-screen line passes within `radius` pixels of `p`, nearest
 * first (ties keep segment order). `screen` holds x, y per endpoint, two
 * endpoints per segment; a NaN coordinate marks an endpoint that cannot be
 * drawn (behind the camera), and its segment is skipped.
 */
export function segmentsNear(screen: ArrayLike<number>, p: { x: number; y: number }, radius = EDGE_PICK_PX): SegmentNear[] {
  const near: SegmentNear[] = [];
  for (let s = 0; 4 * s + 3 < screen.length; s++) {
    const [ax, ay, bx, by] = [screen[4 * s], screen[4 * s + 1], screen[4 * s + 2], screen[4 * s + 3]];
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    const [dx, dy] = [bx - ax, by - ay];
    const len2 = dx * dx + dy * dy;
    // Closest point on the segment: project p onto the line, clamp to the ends.
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
    const distance = Math.hypot(ax + t * dx - p.x, ay + t * dy - p.y);
    if (distance < radius) near.push({ segment: s, t, distance });
  }
  return near.sort((a, b) => a.distance - b.distance || a.segment - b.segment);
}

/** The kernel edge index of segment `segment` (from `edge_line_edges`), or null when the index is outside the mesh. */
export function edgeOfSegment(segmentEdges: ArrayLike<number>, segment: number): number | null {
  return faceOfTriangle(segmentEdges, segment);
}

/**
 * Whether a point `pointDistance` from the camera is in view, given the
 * distance to the first face a ray towards it meets (null: none).
 */
export function unhidden(pointDistance: number, firstHit: number | null): boolean {
  return firstHit === null || firstHit >= pointDistance * (1 - EDGE_DEPTH_SLACK);
}
