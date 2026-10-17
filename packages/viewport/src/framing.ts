import type { DisplayMesh, Framing } from "@fission/core";

export type { Framing };

/** How far a body may reach past the framed sphere before re-framing. */
export const FIT_SLACK = 1.5;

/**
 * Whether the camera should re-frame: the first body; a body that no longer
 * fits comfortably in the framed sphere (its own sphere reaches past 1.5×
 * the framed radius, because it grew or moved); or one that shrank more
 * than tenfold and would be a speck. Smaller edits keep the user's view.
 */
export function needsRefit(last: Framing | null, now: Framing): boolean {
  if (!(now.radius > 0)) return false;
  if (last === null) return true;
  const shift = Math.hypot(...now.centre.map((c, i) => c - last.centre[i]));
  return shift + now.radius > FIT_SLACK * last.radius || now.radius < 0.1 * last.radius;
}

/**
 * Sphere around the selected faces' triangles and edges' segments of a
 * display mesh: the centre of their bounding box and half its diagonal, as
 * the viewer frames a whole body. Radius 0 when nothing listed is in the mesh.
 */
export function selectionFraming(
  mesh: Pick<DisplayMesh, "positions" | "indices" | "triangle_faces" | "edge_lines" | "edge_line_edges">,
  faces: readonly number[],
  edges: readonly number[],
): Framing {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const add = (points: readonly number[], i: number) => {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], points[3 * i + k]);
      hi[k] = Math.max(hi[k], points[3 * i + k]);
    }
  };
  const faceSet = new Set(faces);
  mesh.triangle_faces.forEach((face, t) => {
    if (faceSet.has(face)) for (let j = 0; j < 3; j++) add(mesh.positions, mesh.indices[3 * t + j]);
  });
  const edgeSet = new Set(edges);
  mesh.edge_line_edges.forEach((edge, s) => {
    if (edgeSet.has(edge)) [2 * s, 2 * s + 1].forEach((i) => add(mesh.edge_lines, i));
  });
  if (!(lo[0] <= hi[0])) return { centre: [0, 0, 0], radius: 0 };
  const centre = lo.map((l, k) => (l + hi[k]) / 2) as [number, number, number];
  return { centre, radius: Math.hypot(...hi.map((h, k) => h - lo[k])) / 2 };
}

/** The sphere Look At frames when there is nothing to frame (no body, nothing drawn): 50 mm round the plane's origin. */
export const LOOK_AT_EMPTY_RADIUS = 50;

/**
 * What Look At frames: the box around `points` (the body's bounding-box
 * corners and the edited sketch's ends, model space), as its centre and
 * half its diagonal like a body is framed; with no points, or all of them
 * in one place, LOOK_AT_EMPTY_RADIUS round `fallback` (the plane's origin)
 * or round that one place.
 */
export function lookAtFraming(points: readonly (readonly number[])[], fallback: readonly number[]): Framing {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    if (!p.every(Number.isFinite)) continue;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p[k]);
      hi[k] = Math.max(hi[k], p[k]);
    }
  }
  if (!(lo[0] <= hi[0])) return { centre: [fallback[0], fallback[1], fallback[2]], radius: LOOK_AT_EMPTY_RADIUS };
  const centre = lo.map((l, k) => (l + hi[k]) / 2) as [number, number, number];
  const radius = Math.sqrt(hi.reduce((s, h, k) => s + (h - lo[k]) ** 2, 0)) / 2;
  return { centre, radius: radius > 0 ? radius : LOOK_AT_EMPTY_RADIUS };
}
