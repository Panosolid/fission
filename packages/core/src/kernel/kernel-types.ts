// Shapes of the values the WASM kernel returns (see kernel/src/lib.rs).

export interface DisplayMesh {
  positions: number[];
  normals: number[];
  indices: number[];
  triangle_faces: number[];
  edge_lines: number[];
}

export interface BodyView {
  mesh: DisplayMesh;
  volume: number;
  area: number;
  vertices: number;
  edges: number;
  faces: number;
  errors: string[];
}

/**
 * A profile in the form the kernel takes (ProfileIn in kernel/src/lib.rs):
 * loops of corners [x0, y0, x1, y1, …] with one bulge per corner (0
 * straight, ±1 a half circle; tan of a quarter of the arc's turn), or circles.
 */
export type Loop =
  | { path: { corners: number[]; bulges: number[] } }
  | { circle: { center: [number, number]; radius: number } };

export interface Outline {
  outer: Loop;
  holes: Loop[];
}
