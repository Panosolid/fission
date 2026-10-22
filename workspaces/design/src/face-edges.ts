// A face's edges in a sketch drawn on it (step 26f; the owner's answer Q4,
// docs/progress/cad.md): they are not drawn into the sketch, but the
// pointer snaps onto their ends, their middles and the centres of round
// ones, and a sketch point that lands on one is pinned there, so it follows
// that edge when an earlier feature changes, and is held where it was, with
// a warning, when the edge is gone.
//
// Names, like the faces' and edges' of naming.ts, never the kernel's
// indices: an edge's end is a vertex, named by every edge that meets there
// ("end+side:line-4&end+side:line-5&side:line-4@end+side:line-5@start",
// the edges' names sorted and joined by "&", which encodeURIComponent
// never leaves in an id), so a corner keeps its name while the lines it
// sits between are the same lines, however they move. An edge between two
// sides is named there by which end of each side's curve meets at it
// (naming.ts `ends`, step 27b), not by naming.ts's "A>B": that order is the
// way round the outline goes, which a corner moved across the outline, a
// flipped extrude or two arcs swapping bulges turns over without the
// corner being any other. So the two corners of an outline of only two
// curves (a half disc, a crescent) have a name each and can each be pinned
// (26f left the order out, "A+B", so those two shared a name and neither
// could be; a pin saved with such a name is still found when one corner
// has it). The middle of such an edge is named the same way; any other
// middle, and a centre, by its edge. A name two vertices (or edges) would
// share finds none of them and says so: a pin is never moved to one of
// two (the owner's rule for 25a).
//
// Every point comes from the kernel's exact vertex_points, edge_middles and
// edge_centres (26f), placed into the sketch through the frame the sketch
// lies in now: x = (p − origin) · xAxis, y = (p − origin) · (normal ×
// xAxis). The snap and the rebuild work a pin's place out with this one
// function, so a pinned point is exactly where a snap put it, to the bit.

import type { BodyView, Plane, SketchXY, StableId } from "@fission/core";
import type { DesignDocument } from "./document.ts";
import { faceReference, isFacePlane } from "./face-sketch.ts";
import type { BodyNames } from "./naming.ts";
import { sharedBy } from "./references.ts";
import { findInScene, sceneHit, type Scene } from "./scene.ts";

/** What a face's edge offers: an end (a vertex), the middle of a line or arc, the centre of an arc or circle. The words match snap.ts's kinds. */
export type EdgeKind = "endpoint" | "midpoint" | "centre";

/**
 * A sketch point pinned to its face's edge (kept in the sketch's content,
 * document.ts `Sketch.pins`): which point, what on the edge, and the name
 * of the vertex (an endpoint) or the edge (a middle or centre), the part
 * after "<feature>/", the feature being the one whose face the sketch is on.
 */
export interface SketchPin {
  point: string;
  kind: EdgeKind;
  name: string;
}

/** A point a sketch can snap to on its face's edges: where in the sketch, and the pin a point landing there gets. */
export interface EdgeTarget {
  at: SketchXY;
  kind: EdgeKind;
  name: string;
}

type Vec3 = readonly [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A world point in the sketch's own (x, y): its offset from the frame's origin along x and along y = normal × x. `+ 0` turns −0 into 0. */
export function inSketch(p: Vec3, plane: Plane): SketchXY {
  const d: Vec3 = [p[0] - plane.origin[0], p[1] - plane.origin[1], p[2] - plane.origin[2]];
  return [dot(d, plane.xAxis) + 0, dot(d, cross(plane.normal, plane.xAxis)) + 0];
}

/** Whether edge `e` is closed: a whole circle, whose one vertex is only where its seam is, so it has no ends and no middle. */
const closed = (view: BodyView, e: number) => view.edge_vertices[e][0] === view.edge_vertices[e][1];

/** An edge's name without the order between two sides: "A>B" as "A+B", its two faces sorted (26f's names). */
function unordered(name: string | null): string | null {
  if (name === null || !name.includes(">")) return name;
  const [a, b] = name.split(">");
  return a <= b ? `${a}+${b}` : `${b}+${a}`;
}

/** Edge `e`'s name in a vertex's name or a middle's pin: which ends of its two sides' curves meet there when known (27b), else its name with no order. */
function partName(names: BodyNames, e: number): string | null {
  return names.edges[e] === null ? null : (names.ends?.[e] ?? unordered(names.edges[e]));
}

/** A vertex's name as 26f gave it (files from 0.26): each "A@x+B@y" part as "A+B", the parts sorted again. */
function oldName(name: string): string {
  const part = (p: string) => (p.includes("@") ? unordered(p.split("+").map((x) => x.slice(0, x.indexOf("@"))).join(">"))! : p);
  return name.split("&").map(part).sort().join("&");
}

/**
 * Each vertex's name (null when an edge meeting there has none, or when two
 * vertices would have the same name), with the names two or more would
 * have had and how many.
 */
export function vertexNames(view: BodyView, names: BodyNames): { vertices: (string | null)[]; shared: ReadonlyMap<string, number> } {
  const at: string[][] = Array.from({ length: view.vertex_points.length }, () => []);
  const unnamed = new Set<number>();
  view.edge_vertices.forEach(([a, b], e) => {
    const n = partName(names, e);
    for (const v of a === b ? [a] : [a, b]) {
      if (n === null) unnamed.add(v);
      else at[v].push(n);
    }
  });
  const given = at.map((list, v) => (unnamed.has(v) || list.length === 0 ? null : [...list].sort().join("&")));
  const counts = new Map<string, number>();
  for (const n of given) if (n !== null) counts.set(n, (counts.get(n) ?? 0) + 1);
  return { vertices: given.map((n) => (n !== null && counts.get(n) === 1 ? n : null)), shared: new Map([...counts].filter(([, k]) => k > 1)) };
}

/**
 * Every point a sketch on face `face` of this body can snap to, in the
 * sketch's (x, y) through `plane` (the frame it lies in now): each end of
 * each of the face's edges that is not a whole circle (each vertex once),
 * each such edge's middle, and each round edge's centre, in edge order;
 * none without a name.
 */
export function faceEdgeTargets(view: BodyView, names: BodyNames, face: number, plane: Plane): EdgeTarget[] {
  const { vertices } = vertexNames(view, names);
  const out: EdgeTarget[] = [];
  const seen = new Set<number>();
  view.edge_faces.forEach((pair, e) => {
    if (pair === null || (pair[0] !== face && pair[1] !== face)) return;
    const edge = names.edges[e];
    if (!closed(view, e)) {
      for (const v of view.edge_vertices[e]) {
        const name = vertices[v];
        if (seen.has(v) || name === null) continue;
        seen.add(v);
        out.push({ at: inSketch(view.vertex_points[v], plane), kind: "endpoint", name });
      }
      const middle = edge === null ? null : (names.ends?.[e] ?? edge);
      if (middle !== null) out.push({ at: inSketch(view.edge_middles[e], plane), kind: "midpoint", name: middle });
    }
    const centre = view.edge_centres[e];
    if (centre && edge !== null) out.push({ at: inSketch(centre, plane), kind: "centre", name: edge });
  });
  return out;
}

/**
 * The edge a middle's or centre's pin names: an edge between two sides by
 * the ends of their curves (27b), any other by its name, or for a middle on
 * an edge between two sides ("A>B") whose name finds nothing, the edge named
 * the other way round ("B>A"), the same edge once the outline turned over
 * (a corner dragged across it turns every such name round; hunt 26h: the
 * corners' pins followed, the middles' were lost). Never in place of an
 * edge the name itself finds: a half disc's two upright edges are "A>B"
 * and "B>A", and each name goes with its own end of the line. -1 for none.
 */
function edgeIndex(pin: SketchPin, names: BodyNames): number {
  if (pin.name.includes("@")) return names.ends?.indexOf(pin.name) ?? -1;
  const e = names.edges.indexOf(pin.name);
  const other = reversed(pin);
  return e >= 0 || other === null ? e : names.edges.indexOf(other);
}
/** A middle's pin on an edge between two sides, "A>B", as "B>A"; null for any other pin. */
function reversed(pin: SketchPin): string | null {
  if (pin.kind !== "midpoint" || !pin.name.includes(">")) return null;
  const [a, b] = pin.name.split(">");
  return `${b}>${a}`;
}

/** Where a pin is now: found (in the sketch, through `plane`), or why not: its vertex or edge is gone, or its name is now more than one's. */
export type PinNow = { at: SketchXY } | { cause: "point-lost" | "point-ambiguous" };

/**
 * Where `pin` lies on this body now, the body of the feature whose face
 * the sketch is on: its vertex or edge found by name, through `plane` (a
 * vertex's name from 0.26, its uprights unordered, found when exactly one
 * vertex has it, ambiguous when more do);
 * "point-ambiguous" when the name (or one of the edges a vertex is named
 * by) would be two or more's, never one of them; else "point-lost" (no
 * such vertex or edge, or an edge that is now a whole circle, or one with
 * no centre for a centre's pin).
 */
export function pinNow(pin: SketchPin, view: BodyView, names: BodyNames, plane: Plane): PinNow {
  const edgeShared = (part: string) => sharedBy({ kind: "edge", id: `edge:${names.feature}/${part}` as StableId }, names);
  if (pin.kind === "endpoint") {
    const { vertices, shared } = vertexNames(view, names);
    const v = vertices.indexOf(pin.name);
    if (v >= 0) return { at: inSketch(view.vertex_points[v], plane) };
    if (!pin.name.includes("@")) {
      const old = vertices.flatMap((n, k) => (n !== null && oldName(n) === pin.name ? [k] : []));
      if (old.length === 1) return { at: inSketch(view.vertex_points[old[0]], plane) };
      if (old.length > 1) return { cause: "point-ambiguous" };
    }
    const ambiguous = (shared.get(pin.name) ?? 0) > 1 || pin.name.split("&").some((part) => edgeShared(part) > 1);
    return { cause: ambiguous ? "point-ambiguous" : "point-lost" };
  }
  const e = edgeIndex(pin, names);
  if (e < 0) return { cause: edgeShared(pin.name) > 1 || (reversed(pin) !== null && edgeShared(reversed(pin)!) > 1) ? "point-ambiguous" : "point-lost" };
  if (pin.kind === "midpoint") return closed(view, e) ? { cause: "point-lost" } : { at: inSketch(view.edge_middles[e], plane) };
  const centre = view.edge_centres[e];
  return centre ? { at: inSketch(centre, plane) } : { cause: "point-lost" };
}

/** Why a sketch's pinned points are held: some have lost their edge ("point-lost" wins), or their edge's name is now more than one's; how many; and the words. */
export interface PointWarning {
  cause: "point-lost" | "point-ambiguous";
  points: number;
  message: string;
}

/** The words for a sketch whose `n` pinned points are held. */
export function pointWords(cause: PointWarning["cause"], n: number, sketchLabel: string): string {
  const one = n === 1;
  const what = one ? "a point snapped to an edge of its face" : `${n} points snapped to edges of its face`;
  const why = cause === "point-lost" ? (one ? "has lost that edge" : "have lost their edges") : one ? "is on an edge that is now more than one edge" : "are on edges that are now more than one edge";
  const stay = one ? "it stays where it was" : "they stay where they were";
  return `${sketchLabel}: ${what} ${why}, so ${stay}${cause === "point-ambiguous" ? " rather than guess" : ""}`;
}

/**
 * What the pointer may snap to on sketch `sketchId`'s face (`faceEdgeTargets`)
 * as the app shows it: the face found by its name on the bodies shown,
 * through `plane`, the frame the last rebuild placed the sketch in. None
 * for a sketch on an origin plane, or whose face is gone or shared (its
 * plane is lost or ambiguous: there is no edge to follow).
 */
export function sketchEdgeTargets(doc: DesignDocument, sketchId: string, scene: Scene | null, plane: Plane | undefined): EdgeTarget[] {
  const item = doc.timeline.features.find((f) => f.id === sketchId);
  const facePlane = item?.intent.parameters.plane;
  if (scene === null || plane === undefined || !isFacePlane(facePlane)) return [];
  const found = findInScene(faceReference(facePlane), scene);
  if (found.status !== "found") return [];
  const hit = sceneHit(scene, "face", found.index)!;
  const body = scene.bodies[hit.body];
  return faceEdgeTargets(body.view, body.names, hit.index, plane);
}
