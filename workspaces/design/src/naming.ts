// Stable names for the faces and edges of a body Design built (step 24c),
// the names references hold instead of the kernel's indices, which an edit
// can renumber.
//
// A face is named by the feature that made it, its role in that feature
// (the kernel's `face_roles`: an extrude's start and end caps and sides, a
// box's six directions, a cylinder's bottom, top and side, a sphere's upper
// and lower halves) and, for an extrude's side, the sketch curve its piece
// of the outline came from: "face:feature-7/side:line-4". An edge is named
// by the two faces it joins (the kernel's `edge_faces`). Two sides can meet
// at more than one corner (a half disc's line and arc meet at both ends),
// so between two sides the order says which corner: first the side before
// it going round the outline counter-clockwise seen from the end cap,
// "edge:feature-7/side:line-4>side:arc-6"; every other pair is a set,
// sorted, "edge:feature-7/side:line-4+start". These are the model's names
// (packages/testing/src/timeline-model.ts, faceKey and edgeKey), checked on
// the real kernel by journeys/timeline.journey.ts.
//
// Ids are written with encodeURIComponent, so an id from an opened file
// holding ":", "/", "+" or ">" can never make two names read the same;
// the counter's ids ("line-4") are unchanged by it.

import type { BodySpec, BodyView, Outline } from "@fission/core";
import type { CurveIds } from "./rebuild.ts";

/** Each face's and edge's name on one body, by kernel index; null where none can be given. */
export interface BodyNames {
  feature: string;
  /** The part after "face:<feature>/": "top", "side:line-4". */
  faces: (string | null)[];
  /** The part after "edge:<feature>/": "side:line-4+start", "side:line-4>side:arc-6". */
  edges: (string | null)[];
  /**
   * Each name two or more faces (or edges) would have had, and how many:
   * dropped from `faces` and `edges`, but kept here so a reference holding
   * one is told apart from one whose face is gone (step 25a4), and is never
   * moved to one of them.
   */
  shared: { faces: ReadonlyMap<string, number>; edges: ReadonlyMap<string, number> };
}

/**
 * The sketch curve (or ready-made piece) the side of piece `piece` of
 * profile loop `boundary` was swept from, as an id; null when it can't be
 * told (the side then has no name).
 */
export type CurveOf = (boundary: number, piece: number) => string | null;

const esc = encodeURIComponent;

/** How many times each name is in the list. */
function counts(names: readonly (string | null)[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const n of names) if (n !== null) seen.set(n, (seen.get(n) ?? 0) + 1);
  return seen;
}

/** Names repeated in the list replaced by null: a name must point at one thing. */
function onlyOnce(names: (string | null)[]): (string | null)[] {
  const seen = counts(names);
  return names.map((n) => (n !== null && seen.get(n) === 1 ? n : null));
}

/** The names in the list more than once, with how many times. */
function repeated(names: readonly (string | null)[]): Map<string, number> {
  return new Map([...counts(names)].filter(([, k]) => k > 1));
}

/**
 * Names every face and edge of `view`, a body `feature` built. A face
 * without a role (a body built by hand), a side whose curve `curveOf`
 * can't tell, an edge whose faces are unnamed or not one pair, and any name
 * two faces or two edges would share, are null.
 */
export function nameBody(feature: string, view: BodyView, curveOf: CurveOf): BodyNames {
  const given = view.face_roles.map((r) => {
    if (r === null) return null;
    if (r.role !== "side" || r.piece === undefined) return r.role;
    const curve = curveOf(r.boundary ?? 0, r.piece);
    return curve === null ? null : `side:${esc(curve)}`;
  });
  const faces = onlyOnce(given);
  // Two sides of an extrude (each with a piece) meet in order; everything else is a set.
  const isSide = (f: number) => view.face_roles[f]?.role === "side" && view.face_roles[f]?.piece !== undefined;
  const edgeNames = (on: readonly (string | null)[]) =>
    view.edge_faces.map((pair) => {
      if (pair === null) return null;
      const [a, b] = [on[pair[0]] ?? null, on[pair[1]] ?? null];
      if (a === null || b === null) return null;
      if (isSide(pair[0]) && isSide(pair[1])) return `${a}>${b}`;
      return a <= b ? `${a}+${b}` : `${b}+${a}`;
    });
  const edges = onlyOnce(edgeNames(faces));
  // The names that would have pointed at two things: faces as given, edges as named from those faces.
  return { feature: esc(feature), faces, edges, shared: { faces: repeated(given), edges: repeated(edgeNames(given)) } };
}

/**
 * `CurveOf` for an outline: the sketch curve each piece of the outer loop
 * came from (`pieces`, from sketch_outline, with `curves` the sketch's line,
 * arc and circle ids in the order its lists were given; none without
 * `curves`), or, for a ready-made profile (no pieces), the piece's number
 * as the profile gives it: "piece-2", and "hole-1-piece-0" for a hole's.
 */
export function outlineCurves(outline: Outline, curves?: { line: readonly string[]; arc: readonly string[]; circle: readonly string[] }): CurveOf {
  return (boundary, piece) => {
    if (outline.pieces === undefined) return boundary === 0 ? `piece-${piece}` : `hole-${boundary}-piece-${piece}`;
    const p = boundary === 0 ? outline.pieces[piece] : undefined;
    return p === undefined || curves === undefined ? null : (curves[p.curve][p.index] ?? null);
  };
}

/** The face and edge with a name on this body, by kernel index; -1 when it has none. */
export function indexOf(names: BodyNames, kind: "face" | "edge", part: string): number {
  return (kind === "face" ? names.faces : names.edges).indexOf(part);
}

/**
 * The names of the body feature `featureId` built: from `spec`, the spec it
 * was built from (so the outline's pieces are the ones the kernel
 * extruded), and `curves`, the ids of the sketch curves that outline was
 * found from (the rebuild's `curves`: the sketch's now, or its kept
 * shape's while the sketch is lost; hunt 2026-10-21, never the sketch's
 * now for a kept shape). A ready-made profile's sides are named by piece
 * number; a box, cylinder or sphere needs no curves. The one way Design
 * names a body it built (scene.ts `shownBodies`).
 */
export function featureNames(featureId: string, built: { spec: BodySpec; curves?: CurveIds }, view: BodyView): BodyNames {
  return nameBody(featureId, view, "extrude" in built.spec ? outlineCurves(built.spec.extrude.profile, built.curves) : () => null);
}
