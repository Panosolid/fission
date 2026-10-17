// Shapes of the values the WASM kernel returns (see kernel/src/lib.rs).

export interface DisplayMesh {
  positions: number[];
  normals: number[];
  indices: number[];
  triangle_faces: number[];
  edge_lines: number[];
  /** B-rep edge index of each segment in `edge_lines` (one per pair of points). */
  edge_line_edges: number[];
}

export interface BodyView {
  mesh: DisplayMesh;
  volume: number;
  area: number;
  vertices: number;
  edges: number;
  faces: number;
  /** Each face's surface type by kernel face index: "plane", "cylinder", "sphere". */
  face_types: string[];
  /** Each edge's curve type by kernel edge index: "line", "circle". */
  edge_types: string[];
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

/** A straight sketch line from a to b, in the sketch plane's x and y (mm); LineIn in kernel/src/lib.rs. */
export interface SketchLine {
  a: [number, number];
  b: [number, number];
}

/** A sketch circle round `centre` with radius `radius`, in the sketch plane's x and y (mm); CircleIn in kernel/src/lib.rs. */
export interface SketchCircle {
  centre: [number, number];
  radius: number;
}

/**
 * A sketch arc from `start` to `end`, counter-clockwise round `centre`, in
 * the sketch plane's x and y (mm); ArcIn in kernel/src/lib.rs. The centre
 * must be midway between the ends (within the kernel's LINEAR).
 */
export interface SketchArc {
  start: [number, number];
  end: [number, number];
  centre: [number, number];
}

/**
 * What a sketch's lines, circles and arcs make (SketchOutlineOut in
 * kernel/src/lib.rs): the one closed outline, ready for make_extrude (a
 * path, or a circle when the sketch is one circle), or why there is none
 * yet, in words.
 */
export type SketchOutline = { closed: Outline } | { open: string };

/** What to build, as the kernel's BodySpec (kernel/src/lib.rs). */
export type BodySpec =
  | { box: { width: number; depth: number; height: number } }
  | { cylinder: { radius: number; height: number } }
  | { sphere: { radius: number } }
  | { extrude: { profile: Outline; distance: number } };

/** A binary STL file from the kernel. */
export interface StlFile {
  bytes: Uint8Array<ArrayBuffer>;
  /** Largest rounding of any corner to single precision (mm). */
  rounding: number;
  /** Set when that rounding is more than the smallest feature. */
  warning: string | null;
}
