// Step 25a4: seeded sessions of references re-found on random scenes,
// checked against a plain model written here apart from Design. Each scene
// is one to three bodies as the kernel could give them (boxes, cylinders,
// extrudes of 1 to 6 sides), with names made to collide at random the way a
// face split in two by a cut will (a box face given another face's role,
// two sides from one sketch curve), and some sides with no curve. Each
// reference holds a face or edge name of a body shown, of another body, of
// no body, or one no body has; the model counts how many faces or edges
// carry its name as given (before Design drops the shared ones):
// - one, and neither of an edge's faces shared: found, at its joined index;
// - two or more (or, for an edge, one of its faces in two or more): shared,
//   with that count, and never found;
// - none, or its feature not shown: gone.
// Every Design function that re-finds a reference is checked against it:
// findInScene, resolveInScene, sharedBy, highlightOf, selectionRows,
// survivors, droppedNote and designLookup (a link's lookup). The subject is
// a set of those functions, so a planted copy of one file can stand in for
// the real one (refind-planted.test.ts).

import type { BodyView, GeometryReference, KernelCalls, StableId } from "@fission/core";
import { partDocument } from "../src/document.ts";
import * as Naming from "../src/naming.ts";
import * as References from "../src/references.ts";
import * as Representations from "../src/representations.ts";
import * as SceneFns from "../src/scene.ts";
import * as Selection from "../src/selection.ts";
import type { Scene } from "../src/scene.ts";

export interface Subject {
  nameBody: typeof Naming.nameBody;
  sharedBy: typeof References.sharedBy;
  findInScene: typeof SceneFns.findInScene;
  resolveInScene: typeof SceneFns.resolveInScene;
  highlightOf: typeof Selection.highlightOf;
  selectionRows: typeof Selection.selectionRows;
  survivors: typeof Selection.survivors;
  droppedNote: typeof Selection.droppedNote;
  NAME_SHARED: string;
  designLookup: typeof Representations.designLookup;
}

/** Design's own functions. */
export const REAL: Subject = { ...Naming, ...References, ...SceneFns, ...Selection, ...Representations };

/** Mulberry32: a small seeded generator, so a failing session replays from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOX_ROLES = ["bottom", "top", "front", "back", "left", "right"];
// The box's edges as make_box walks them (views.ts BOX_VIEW).
const BOX_EDGES: [number, number][] = [
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
];

/** One body of a random scene: its view and, for the model, each face's role and the curve each side came from. */
export interface ModelBody {
  feature: string;
  view: BodyView;
  /** The curve of each side piece, by piece; null where it can't be told. */
  curves: (string | null)[];
  /** Each face's and edge's name as given, worked out here from the roles and pairs. */
  faces: (string | null)[];
  edges: (string | null)[];
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** A random body: a box (sometimes one face given another's role), a cylinder, or an extrude whose sides' curves may repeat. */
export function randomBody(r: () => number, feature: string): ModelBody {
  const kind = pick(r, ["box", "cylinder", "extrude", "extrude"] as const);
  if (kind === "cylinder") {
    const view = {
      faces: 3,
      edges: 2,
      face_roles: [{ role: "bottom" }, { role: "top" }, { role: "side" }],
      edge_faces: [
        [2, 0],
        [1, 2],
      ],
    } as unknown as BodyView;
    return {
      feature,
      view,
      curves: [],
      faces: ["bottom", "top", "side"],
      edges: ["bottom+side", "side+top"],
    };
  }
  if (kind === "box") {
    const roles = [...BOX_ROLES];
    if (r() < 0.5) roles[Math.floor(r() * 6)] = pick(r, BOX_ROLES);
    const view = {
      faces: 6,
      edges: 12,
      face_roles: roles.map((role) => ({ role })),
      edge_faces: BOX_EDGES,
    } as unknown as BodyView;
    const edges = BOX_EDGES.map(([a, b]) => [roles[a], roles[b]].sort().join("+"));
    return { feature, view, curves: [], faces: roles, edges };
  }
  // An extrude: start, end, then one side per piece; edges as extrudeView in naming.test.ts lays them out.
  const pieces = 1 + Math.floor(r() * 6);
  const pool = Math.max(1, pieces - 1 + Math.floor(r() * 4));
  const curves = Array.from({ length: pieces }, () => (r() < 0.08 ? null : `line-${1 + Math.floor(r() * pool)}`));
  const faces = ["start", "end", ...curves.map((c) => (c === null ? null : `side:${c}`))];
  const pairs: [number, number][] = [];
  const edges: (string | null)[] = [];
  const set = (a: string | null, b: string | null) => (a === null || b === null ? null : [a, b].sort().join("+"));
  for (let k = 0; k < pieces; k++) {
    pairs.push([2 + k, 0], [1, 2 + k]);
    edges.push(set(faces[2 + k], "start"), set("end", faces[2 + k]));
  }
  for (let k = 0; k < pieces; k++) {
    const prev = 2 + ((k + pieces - 1) % pieces);
    pairs.push([prev, 2 + k]);
    // Between two sides in order round the outline: the one before, then the one after.
    edges.push(faces[prev] === null || faces[2 + k] === null ? null : `${faces[prev]}>${faces[2 + k]}`);
  }
  const roles = [{ role: "start" }, { role: "end" }, ...curves.map((_, k) => ({ role: "side", boundary: 0, piece: k }))];
  const view = {
    faces: faces.length,
    edges: pairs.length,
    face_roles: roles,
    edge_faces: pairs,
  } as unknown as BodyView;
  return { feature, view, curves, faces, edges };
}

export type ModelFound = { status: "found"; index: number } | { status: "gone" } | { status: "shared"; count: number };

const countOf = (names: readonly (string | null)[], n: string) => names.filter((x) => x === n).length;

/** The model's answer for a reference to `part` of `feature`'s body (`kind` face or edge), on bodies laid out one after another. */
export function modelFind(bodies: readonly ModelBody[], feature: string, kind: "face" | "edge", part: string): ModelFound {
  let start = 0;
  for (const b of bodies) {
    if (b.feature === feature) {
      const names = kind === "face" ? b.faces : b.edges;
      const own = countOf(names, part);
      if (own > 1) return { status: "shared", count: own };
      if (kind === "edge") {
        const most = Math.max(...part.split(/[+>]/).map((f) => countOf(b.faces, f)));
        if (most > 1) return { status: "shared", count: most };
      }
      return own === 1 ? { status: "found", index: start + names.indexOf(part) } : { status: "gone" };
    }
    start += kind === "face" ? b.view.faces : b.view.edges;
  }
  return { status: "gone" };
}

/** The scene Design draws for these bodies, named by the subject's nameBody (meshes left empty: nothing here draws). */
export function sceneOf(s: Subject, bodies: readonly ModelBody[]): Scene {
  const faceStart: number[] = [];
  const edgeStart: number[] = [];
  let f = 0;
  let e = 0;
  const shown = bodies.map((b, i) => {
    faceStart.push(f);
    edgeStart.push(e);
    f += b.view.faces;
    e += b.view.edges;
    return {
      feature: b.feature,
      place: i + 1,
      view: b.view,
      names: s.nameBody(b.feature, b.view, (_, piece) => b.curves[piece] ?? null),
    };
  });
  return {
    bodies: shown,
    mesh: {
      positions: [],
      normals: [],
      indices: [],
      triangle_faces: [],
      edge_lines: [],
      edge_line_edges: [],
    },
    faceStart,
    edgeStart,
  };
}

const NO_KERNEL = {
  call: () => Promise.reject(new Error("no kernel in this test")),
} as unknown as KernelCalls;

/** What a session reached, so the test can say every case came up. */
export type Reached = Record<string, number>;

/**
 * One session: `scenes` random scenes, `refs` references held on each, every
 * function checked against the model. Throws with "<check>: <detail>" on the
 * first difference.
 */
export function runRefindSession(s: Subject, seed: number, scenes = 30, refs = 40): Reached {
  const r = mulberry32(seed);
  const reached: Reached = {};
  const count = (k: string) => (reached[k] = (reached[k] ?? 0) + 1);
  const fail = (check: string, detail: string): never => {
    throw new Error(`${check}: ${detail} (seed ${seed})`);
  };
  const doc = partDocument("box", 40, 30, 20);
  for (let n = 0; n < scenes; n++) {
    const bodies = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => randomBody(r, `feature-${n * 10 + i + 1}`));
    const scene = sceneOf(s, bodies);
    const lookup = s.designLookup(doc, scene, NO_KERNEL);
    const held: { ref: GeometryReference; want: ModelFound; shown: boolean }[] = [];
    for (let k = 0; k < refs; k++) {
      const kind = r() < 0.5 ? "face" : "edge";
      const body = r() < 0.9 ? pick(r, bodies) : undefined;
      const feature = body?.feature ?? "feature-999";
      // A name of its own body, of any body shown, or one nothing has.
      const from = r() < 0.75 && body ? body : pick(r, bodies);
      const names = (kind === "face" ? from.faces : from.edges).filter((x): x is string => x !== null);
      const part = names.length > 0 && r() < 0.9 ? pick(r, names) : kind === "face" ? "side:line-99" : "side:line-99+start";
      const ref = {
        kind,
        id: `${kind}:${feature}/${part}` as StableId,
      } as GeometryReference;
      const want = modelFind(bodies, feature, kind, part);
      const shownBody = scene.bodies.find((b) => b.feature === feature);
      held.push({ ref, want, shown: shownBody !== undefined });
      count(want.status === "shared" ? `shared-${kind}${kind === "edge" && countOf(body!.edges, part) < 2 ? "-by-face" : ""}` : `${want.status}-${kind}`);

      const got = s.findInScene(ref, scene);
      if (JSON.stringify(got) !== JSON.stringify(want)) fail("findInScene differs from the model", `${ref.id}: ${JSON.stringify(got)}, model ${JSON.stringify(want)}`);
      const index = s.resolveInScene(ref, scene);
      if (index !== (want.status === "found" ? want.index : null)) fail("resolveInScene differs from the model", `${ref.id}: ${index}, model ${JSON.stringify(want)}`);
      const by = s.sharedBy(ref, shownBody?.names ?? null);
      if (by !== (want.status === "shared" ? want.count : 0)) fail("sharedBy differs from the model", `${ref.id}: ${by}, model ${JSON.stringify(want)}`);
      const lit = s.highlightOf([ref], scene);
      const litList = kind === "face" ? lit.faces : lit.edges;
      if (lit.body || JSON.stringify(litList) !== JSON.stringify(want.status === "found" ? [want.index] : []) || (kind === "face" ? lit.edges : lit.faces).length > 0)
        fail("the highlight differs from the model", `${ref.id}: ${JSON.stringify(lit)}, model ${JSON.stringify(want)}`);
      const row = s.selectionRows([ref], scene)[0];
      if ((row.type === s.NAME_SHARED) !== (want.status === "shared")) fail("the selection row differs from the model", `${ref.id}: type ${row.type}, model ${JSON.stringify(want)}`);
      const link = lookup({
        kind: "geometry",
        origin: { workspace: "design", id: feature, label: "a face" },
        ref,
      });
      const linkOk =
        want.status === "found"
          ? link !== null && !("unresolved" in link) && link.type === "design.feature" && link.id === feature
          : want.status === "shared"
            ? link !== null && "unresolved" in link && /more than one/.test(link.unresolved)
            : link === null;
      if (!linkOk)
        fail("the link lookup differs from the model", `${ref.id}: ${JSON.stringify(link && ("unresolved" in link ? link : { type: link.type, id: link.id }))}, model ${JSON.stringify(want)}`);
    }
    // Selections of one to four of them through the rebuild: kept when found or not Design's to judge (no body
    // shown), dropped otherwise, the shared ones said apart.
    for (let sel = 0; sel < 8; sel++) {
      const chosen = held.filter(() => r() < 2.5 / held.length);
      const { kept, dropped, shared } = s.survivors(
        chosen.map((h) => h.ref),
        scene,
      );
      const wantKept = chosen.filter((h) => !h.shown || h.want.status === "found").map((h) => h.ref.id);
      const wantShared = chosen.filter((h) => h.shown && h.want.status === "shared").map((h) => h.ref.id);
      const wantDropped = chosen.filter((h) => h.shown && h.want.status !== "found").map((h) => h.ref.id);
      const ids = (xs: readonly GeometryReference[]) => JSON.stringify(xs.map((x) => x.id));
      if (ids(kept) !== JSON.stringify(wantKept) || ids(dropped) !== JSON.stringify(wantDropped) || ids(shared) !== JSON.stringify(wantShared))
        fail(
          "survivors differ from the model",
          `kept ${ids(kept)} dropped ${ids(dropped)} shared ${ids(shared)}, model kept ${JSON.stringify(wantKept)} dropped ${JSON.stringify(wantDropped)} shared ${JSON.stringify(wantShared)}`,
        );
      const note = s.droppedNote(dropped, shared);
      if (dropped.length === 0 ? note !== "" : !note.startsWith("Taken out of the selection: ")) fail("the note differs from the model", JSON.stringify(note));
      if (/not moved to any of them/.test(note) !== shared.length > 0) fail("the note differs from the model", `${shared.length} shared, note ${JSON.stringify(note)}`);
      if (/could not be followed/.test(note) !== dropped.length > shared.length) fail("the note differs from the model", `${dropped.length - shared.length} gone, note ${JSON.stringify(note)}`);
      count(shared.length > 0 && dropped.length > shared.length ? "note-both" : shared.length > 0 ? "note-shared" : dropped.length > 0 ? "note-gone" : "note-none");
    }
  }
  return reached;
}
