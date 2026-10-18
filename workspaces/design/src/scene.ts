// Every body the timeline builds, drawn at once (step 24d3b). The bodies'
// display meshes are joined into one, each body's faces and edges numbered
// after the previous bodies', so the viewport draws, picks and highlights
// them as it did one body; a picked face or edge maps back to its body and
// the kernel's index there, and so to its stable name (naming.ts), which
// already carries the feature that built it.

import type { BodyView, DisplayMesh, GeometryReference } from "@fission/core";
import type { BodyNames } from "./naming.ts";
import { designReference, readDesignReference, resolveReference } from "./references.ts";

/** One built body: the feature that built it, the kernel's view of it, and its faces' and edges' names. */
export interface ShownBody {
  feature: string;
  view: BodyView;
  names: BodyNames;
}

/** The bodies shown, in build order, and their joined mesh. */
export interface Scene {
  bodies: readonly ShownBody[];
  mesh: DisplayMesh;
  /** The joined index of each body's face 0 and edge 0. */
  faceStart: readonly number[];
  edgeStart: readonly number[];
}

/**
 * Joins the bodies' display meshes: positions and normals one after
 * another, each body's triangle corners moved past the previous bodies'
 * points, its faces and edges past their faces and edges. Bad input
 * throws: a mesh whose lists disagree in length, or that names a point,
 * face or edge its body does not have (it would be drawn as another
 * body's).
 */
export function joinBodies(bodies: readonly ShownBody[]): Scene {
  const mesh: DisplayMesh = { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] };
  const faceStart: number[] = [];
  const edgeStart: number[] = [];
  let faces = 0;
  let edges = 0;
  for (const { feature, view } of bodies) {
    const m = view.mesh;
    const points = m.positions.length / 3;
    const bad = (why: string) => new Error(`the body ${feature} built has a display mesh ${why}`);
    if (!Number.isInteger(points) || m.normals.length !== m.positions.length) throw bad("whose points and normals disagree");
    if (m.indices.length !== 3 * m.triangle_faces.length || m.edge_lines.length !== 6 * m.edge_line_edges.length) throw bad("whose lists disagree in length");
    if (m.indices.some((i) => !(Number.isInteger(i) && i >= 0 && i < points))) throw bad("with a triangle corner it has no point for");
    if (m.triangle_faces.some((f) => !(Number.isInteger(f) && f >= 0 && f < view.faces))) throw bad("with a triangle on a face it does not have");
    if (m.edge_line_edges.some((e) => !(Number.isInteger(e) && e >= 0 && e < view.edges))) throw bad("with a line on an edge it does not have");
    const first = mesh.positions.length / 3;
    faceStart.push(faces);
    edgeStart.push(edges);
    append(mesh.positions, m.positions, 0);
    append(mesh.normals, m.normals, 0);
    append(mesh.indices, m.indices, first);
    append(mesh.triangle_faces, m.triangle_faces, faces);
    append(mesh.edge_lines, m.edge_lines, 0);
    append(mesh.edge_line_edges, m.edge_line_edges, edges);
    faces += view.faces;
    edges += view.edges;
  }
  return { bodies, mesh, faceStart, edgeStart };
}

/** Adds `from` to the end of `to`, each plus `by` (a loop: a big mesh would overflow push's argument list). */
function append(to: number[], from: readonly number[], by: number) {
  for (const x of from) to.push(x + by);
}

/** Which body a joined face or edge index is on, and its kernel index there; null past the last body. */
export function sceneHit(scene: Scene, kind: "face" | "edge", index: number): { body: number; index: number } | null {
  if (!Number.isInteger(index) || index < 0) throw new Error(`a ${kind} reference needs a kernel index (a whole number ≥ 0), got ${index}`);
  const starts = kind === "face" ? scene.faceStart : scene.edgeStart;
  for (let b = scene.bodies.length - 1; b >= 0; b--) {
    if (index < starts[b]) continue;
    const local = index - starts[b];
    const count = kind === "face" ? scene.bodies[b].view.faces : scene.bodies[b].view.edges;
    return local < count ? { body: b, index: local } : null;
  }
  return null;
}

/** The reference for a joined face or edge index: its body's name for it; null when it has none. */
export function sceneReference(kind: "face" | "edge", scene: Scene, index: number): GeometryReference | null {
  const hit = sceneHit(scene, kind, index);
  return hit === null ? null : designReference(kind, scene.bodies[hit.body].names, hit.index);
}

/** The shown body a reference is on (by the feature its name holds), or -1. */
export function bodyOf(scene: Scene, ref: GeometryReference): number {
  const r = readDesignReference(ref);
  if (r === null) return -1;
  return scene.bodies.findIndex((b) => (r.kind === "body" ? b.feature === r.featureId : b.names.feature === r.featureId));
}

/** The joined index of the face or edge a reference names; null when no shown body has it. */
export function resolveInScene(ref: GeometryReference, scene: Scene): number | null {
  const b = bodyOf(scene, ref);
  if (b < 0) return null;
  const i = resolveReference(ref, scene.bodies[b].names);
  if (i === null) return null;
  return i + (ref.kind === "face" ? scene.faceStart[b] : scene.edgeStart[b]);
}
