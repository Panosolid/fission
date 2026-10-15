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
