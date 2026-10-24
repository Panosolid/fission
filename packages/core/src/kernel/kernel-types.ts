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
  /** The smallest axis-aligned box round the body in the world, [low, high] corners (mm), exact for lines, circles and arcs (step 28a). */
  bounds: [[number, number, number], [number, number, number]];
  vertices: number;
  edges: number;
  faces: number;
  /** Each face's surface type by kernel face index: "plane", "cylinder", "sphere". */
  face_types: string[];
  /** Each edge's curve type by kernel edge index: "line", "circle". */
  edge_types: string[];
  /** What each face is in the operation that made it, by kernel face index (null for a body built by hand). */
  face_roles: (FaceRole | null)[];
  /** Each face's exact area (mm²) and centroid [x, y, z] (mm), by kernel face index. */
  face_areas: number[];
  face_centroids: [number, number, number][];
  /**
   * Each planar face's outward unit normal [x, y, z] in the world, by kernel
   * face index; null for a curved face (step 26b). With the face's centroid,
   * which lies on it, it is the face's plane, exact (the display mesh's
   * normals are single precision).
   */
  face_normals: ([number, number, number] | null)[];
  /**
   * The two faces each edge joins, by kernel edge index (step 24c): first
   * the face running the edge forwards, then the one running it backwards;
   * null for an edge not used exactly once each way (only in a body that
   * failed validation). An extrude's edge between two sides lists first the
   * side before it going round the loop with the solid on the left
   * (counter-clockwise round the outline seen from the end cap).
   */
  edge_faces: ([number, number] | null)[];
  /**
   * Each vertex's point [x, y, z] in the world, exact (step 26f): what a
   * sketch point snapped to a face's corner lands on and follows (the
   * display mesh's edge lines are single precision, micrometres off).
   */
  vertex_points: [number, number, number][];
  /** Each edge's start and end vertex, by kernel edge index; the same vertex twice for a closed edge (a whole circle). */
  edge_vertices: [number, number][];
  /** The point halfway along each edge's parameter in the world: a line's midpoint, an arc's middle. Meaningless for a closed edge. */
  edge_middles: [number, number, number][];
  /** Each circular edge's centre in the world; null for a line. */
  edge_centres: ([number, number, number] | null)[];
  /** The largest tolerance (mm) any vertex or edge of the body carries (step 31a): LINEAR, 1e-5, for every body the kernel makes until intersections grow them. */
  tolerance: number;
  errors: string[];
}

/**
 * A face's role (FaceRoleOut in kernel/src/lib.rs): an extrude's "start" and
 * "end" caps and the "side" of piece `piece` of profile loop `boundary` (0 the
 * outer loop; numbered as the profile was given, so through Outline.pieces a
 * side names the sketch curve it came from); a box's "bottom", "top",
 * "front" (−Y), "back", "left" (−X), "right"; a cylinder's "bottom", "top"
 * and "side" (no boundary or piece); a sphere's "upper" and "lower".
 */
export interface FaceRole {
  role: "start" | "end" | "side" | "bottom" | "top" | "front" | "back" | "left" | "right" | "upper" | "lower";
  boundary?: number;
  piece?: number;
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
  /**
   * From sketch_outline only (make_extrude ignores it): the sketch curve
   * each piece of `outer` came from, in order, by its index in the list
   * given, and whether the outline runs it backwards.
   */
  pieces?: OutlinePiece[];
}

/** A piece of an outline's source (PieceOut in kernel/src/lib.rs). */
export interface OutlinePiece {
  curve: "line" | "arc" | "circle";
  index: number;
  reversed: boolean;
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
export type SketchOutline =
  | { closed: Outline }
  /**
   * `invalid`: only when the curves close up but break the profile rules
   * (crossing, touching, doubling back): the sketch's lines, arcs and
   * circles the rules name, by index (possibly none). Decide by it, never
   * by the words in `open`.
   */
  | { open: string; invalid?: KernelInput[] };

/** What to build, as the kernel's BodySpec (kernel/src/lib.rs). */
export type BodySpec =
  | { box: { width: number; depth: number; height: number } }
  | { cylinder: { radius: number; height: number } }
  | { sphere: { radius: number } }
  | { extrude: { profile: Outline; distance: number; frame?: Frame; flip?: boolean } };

/**
 * Where a sketch's plane is, for an extrude built on it (step 26b,
 * kernel/src/ops/place.rs): world origin, x axis and normal, the axes unit
 * and square to each other within 64 ulps (FRAME_SQUARE; anything else is
 * refused, naming "origin", "x" or "normal"). Its y axis is normal × x, so
 * sketch (u, v) is world origin + u·x + v·y and the extrude goes along the
 * normal; with `flip` it goes the other way from the same plane, its start
 * cap still on the plane. Without a frame an extrude is on XY, going up.
 */
export interface Frame {
  origin: [number, number, number];
  x: [number, number, number];
  normal: [number, number, number];
}

/** A binary STL file from the kernel. */
export interface StlFile {
  bytes: Uint8Array<ArrayBuffer>;
  /** Largest rounding of any corner to single precision (mm). */
  rounding: number;
  /** Set when that rounding is more than the smallest feature. */
  warning: string | null;
}

/** A body the kernel keeps between calls (kernel/src/store.rs): a whole number from 1, never reused. Free it with body_free. */
export type BodyHandle = number;

/** What kind of failure a kernel call had (ErrorKind in kernel/src/api_error.rs). */
export type KernelErrorKind =
  /** The kernel refuses an input; the user's to fix. */
  | "invalid-input"
  /** A result failed validation: a kernel bug. */
  | "invalid-result"
  /** The call was malformed (wrong form, a handle that isn't a whole number from 1): the app's bug. */
  | "bad-request"
  /** A body handle the kernel doesn't hold: freed, or never made. */
  | "unknown-body"
  /** The kernel already holds its most bodies (MAX_LIVE_BODIES); free some. */
  | "too-many-bodies"
  /** Any other kernel failure (including a crash): a kernel bug. */
  | "internal";

/**
 * Which input a failure is about (Input in kernel/src/ops/mod.rs), so the app
 * can point at it without reading the message. Indices count from 0, as the
 * app's lists do; a profile loop's `boundary` is 0 for the outer loop and k
 * for hole k − 1, numbered as FaceRole numbers them.
 */
export type KernelInput =
  | { input: "param"; name: string }
  | { input: "profile" }
  | { input: "loop"; boundary: number }
  | { input: "piece"; boundary: number; piece: number }
  | { input: "sketch" }
  | { input: "line"; index: number }
  | { input: "arc"; index: number }
  | { input: "circle"; index: number };

/** A failed kernel call in plain data, as it crosses from the worker. */
export interface KernelFailure {
  kind: KernelErrorKind;
  inputs: KernelInput[];
  message: string;
}
