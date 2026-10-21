// Body views as the kernel gives them, written out by hand for Design's
// unit tests (the journeys check the same numbers on the real kernel).
import type { BodyView } from "@fission/core";
import type { BodyNames } from "../src/naming.ts";
import type { Scene } from "../src/scene.ts";

/**
 * A box (make_box, primitives.rs). Corner k is at (k & 1, k & 2, k & 4)
 * scaled by the sizes; faces in order bottom (−Z), top, front (−Y), back,
 * left (−X), right, their corners [0,2,3,1], [4,5,7,6], [0,1,5,4],
 * [2,6,7,3], [0,4,6,2], [1,3,7,5] counter-clockwise from outside. Edges are
 * made as the faces are walked, each new pair of corners the next edge from
 * its lower corner: bottom 0-2, 2-3, 1-3, 0-1 (edges 0-3); top 4-5, 5-7,
 * 6-7, 4-6 (4-7); front 1-5, 0-4 (8, 9); back 2-6, 3-7 (10, 11). So edge 4,
 * 4-5, is the top front edge and edge 8 the front right upright. Each
 * edge's faces: first the one that walks it from its lower corner (the
 * bottom walks 0→2, so edge 0 is [bottom, left]).
 */
export const BOX_VIEW = {
  vertices: 8,
  edges: 12,
  faces: 6,
  face_types: Array(6).fill("plane"),
  edge_types: Array(12).fill("line"),
  face_roles: [{ role: "bottom" }, { role: "top" }, { role: "front" }, { role: "back" }, { role: "left" }, { role: "right" }],
  edge_faces: [
    [0, 4],
    [0, 3],
    [5, 0],
    [2, 0],
    [1, 2],
    [1, 5],
    [3, 1],
    [4, 1],
    [2, 5],
    [4, 2],
    [3, 4],
    [5, 3],
  ],
} as BodyView;

/**
 * A cylinder (make_cylinder): faces bottom, top, side; edges the bottom rim
 * (the side walks it forwards) and the top rim (the top walks it forwards).
 */
export const CYLINDER_VIEW = {
  vertices: 2,
  edges: 2,
  faces: 3,
  face_types: ["plane", "plane", "cylinder"],
  edge_types: ["circle", "circle"],
  face_roles: [{ role: "bottom" }, { role: "top" }, { role: "side" }],
  edge_faces: [
    [2, 0],
    [1, 2],
  ],
} as BodyView;

/**
 * BOX_VIEW of a w × d × h box with its corners, edge ends, middles and
 * centres (step 26f), as make_box gives them (checked against the kernel's
 * view of a 40 × 30 × 20 box): corner k at (k & 1 ? w : 0, k & 2 ? d : 0,
 * k & 4 ? h : 0), the edges' corners as BOX_VIEW's comment lists them.
 */
export function boxView(w: number, d: number, h: number): BodyView {
  const vertex_points = Array.from({ length: 8 }, (_, k): [number, number, number] => [k & 1 ? w : 0, k & 2 ? d : 0, k & 4 ? h : 0]);
  const edge_vertices: [number, number][] = [[0, 2], [2, 3], [1, 3], [0, 1], [4, 5], [5, 7], [6, 7], [4, 6], [1, 5], [0, 4], [2, 6], [3, 7]];
  const mid = ([a, b]: [number, number]): [number, number, number] => [(vertex_points[a][0] + vertex_points[b][0]) / 2, (vertex_points[a][1] + vertex_points[b][1]) / 2, (vertex_points[a][2] + vertex_points[b][2]) / 2];
  return { ...BOX_VIEW, vertex_points, edge_vertices, edge_middles: edge_vertices.map(mid), edge_centres: edge_vertices.map(() => null) };
}

/** CYLINDER_VIEW of radius r and height h with its points (26f): each rim closed on its one vertex (r, 0, z), centred on the axis. */
export function cylinderView(r: number, h: number): BodyView {
  return { ...CYLINDER_VIEW, vertex_points: [[r, 0, 0], [r, 0, h]], edge_vertices: [[0, 0], [1, 1]], edge_middles: [[-r, 0, 0], [-r, 0, h]], edge_centres: [[0, 0, 0], [0, 0, h]] };
}

/** A scene of one body, as `joinBodies` gives it, without its mesh (these views have none): numbering as the kernel's. */
export function onlyBody(view: BodyView, names: BodyNames): Scene {
  return { bodies: [{ feature: names.feature, place: 1, view, names }], mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] }, faceStart: [0], edgeStart: [0] };
}
