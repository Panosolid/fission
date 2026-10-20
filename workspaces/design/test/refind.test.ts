// Step 25a4: references re-found by name after an edit, and the case where
// the edit gave a name to two faces (as a face split by a cut will): never
// moved to a guess, said apart from a face that is gone. Hand-worked cases
// first, then seeded sessions against the plain model in refind-session.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { linkTo, RepresentationRegistry, resolveLink, type BodyView, type GeometryReference, type KernelCalls, type StableId } from "@fission/core";
import { partDocument } from "../src/document.ts";
import { nameBody } from "../src/naming.ts";
import { designReference, sharedBy } from "../src/references.ts";
import { designLookup, registerDesign } from "../src/representations.ts";
import { findInScene, resolveInScene, sceneHit } from "../src/scene.ts";
import { droppedNote, highlightOf, NAME_SHARED, NOT_ON_BODY, referenceLabel, selectionRows, survivors } from "../src/selection.ts";
import { mulberry32 as mulberry, REAL, runRefindSession, sceneOf, randomBody } from "./refind-session.ts";
import { BOX_VIEW, CYLINDER_VIEW } from "./views.ts";

const ref = (kind: "face" | "edge", feature: string, part: string) => ({ kind, id: `${kind}:${feature}/${part}` as StableId }) as GeometryReference;

// A cylinder (feature-1: 3 faces, 2 edges) then a box (feature-2) whose left
// face was given the role "right", so two faces carry "right".
const roles = [...BOX_VIEW.face_roles];
roles[4] = { role: "right" };
const splitBox = { ...BOX_VIEW, face_roles: roles } as BodyView;
const scene = {
  bodies: [
    {
      feature: "feature-1",
      place: 1,
      view: CYLINDER_VIEW,
      names: nameBody("feature-1", CYLINDER_VIEW, () => null),
    },
    {
      feature: "feature-2",
      place: 2,
      view: splitBox,
      names: nameBody("feature-2", splitBox, () => null),
    },
  ],
  mesh: {
    positions: [],
    normals: [],
    indices: [],
    triangle_faces: [],
    edge_lines: [],
    edge_line_edges: [],
  },
  faceStart: [0, 3],
  edgeStart: [0, 2],
};

test("a box with two faces named right: found, gone and shared told apart, worked by hand", () => {
  // Top is the box's face 1; the cylinder's 3 faces come first, so 1 + 3 = 4.
  assert.deepEqual(findInScene(ref("face", "feature-2", "top"), scene), {
    status: "found",
    index: 4,
  });
  // Faces 4 and 5 both carry "right": two faces, neither picked.
  assert.deepEqual(findInScene(ref("face", "feature-2", "right"), scene), {
    status: "shared",
    count: 2,
  });
  assert.equal(resolveInScene(ref("face", "feature-2", "right"), scene), null);
  // No face is called left any more: gone, not shared.
  assert.deepEqual(findInScene(ref("face", "feature-2", "left"), scene), {
    status: "gone",
  });
  // Edge 0 joins bottom and the old left (now "right"), edge 2 bottom and right: both "bottom+right".
  assert.deepEqual(findInScene(ref("edge", "feature-2", "bottom+right"), scene), { status: "shared", count: 2 });
  // Edge 4 joins top and front, neither shared; the cylinder's 2 edges come first, so 4 + 2 = 6.
  assert.deepEqual(findInScene(ref("edge", "feature-2", "front+top"), scene), {
    status: "found",
    index: 6,
  });
  // Edge 7 was left+top; it is now "right+top" like edge 5, and no edge is "left+top": gone.
  assert.deepEqual(findInScene(ref("edge", "feature-2", "left+top"), scene), {
    status: "gone",
  });
  // The same name on the other body: the cylinder has no right face.
  assert.deepEqual(findInScene(ref("face", "feature-1", "right"), scene), {
    status: "gone",
  });
  // A body never shown.
  assert.deepEqual(findInScene(ref("face", "feature-9", "top"), scene), {
    status: "gone",
  });
  assert.equal(sharedBy(ref("face", "feature-2", "right"), scene.bodies[1].names), 2);
  assert.equal(sharedBy(ref("face", "feature-2", "right"), scene.bodies[0].names), 0, "another body's names never count");
});

test("an extrude whose two sides came from one curve: an edge along a shared face is shared even when its own name is not", () => {
  // Four sides from line-1, line-2, line-1, line-4 (one line cut in two, as a cut will).
  // Faces: start 0, end 1, side:line-1 2, side:line-2 3, side:line-1 4, side:line-4 5.
  // Edges (extrudeView's layout): piece k's start edge 2k and end edge 2k + 1, then side k−1 > side k at 8 + k.
  const curves = ["line-1", "line-2", "line-1", "line-4"];
  const face_roles = [{ role: "start" }, { role: "end" }, ...curves.map((_, k) => ({ role: "side", boundary: 0, piece: k }))];
  const edge_faces: [number, number][] = [];
  for (let k = 0; k < 4; k++) edge_faces.push([2 + k, 0], [1, 2 + k]);
  for (let k = 0; k < 4; k++) edge_faces.push([2 + ((k + 3) % 4), 2 + k]);
  const view = {
    faces: 6,
    edges: 12,
    face_roles,
    edge_faces,
  } as unknown as BodyView;
  const one = {
    bodies: [
      {
        feature: "feature-3",
        place: 1,
        view,
        names: nameBody("feature-3", view, (_, p) => curves[p]),
      },
    ],
    mesh: scene.mesh,
    faceStart: [0],
    edgeStart: [0],
  };
  assert.deepEqual(findInScene(ref("face", "feature-3", "side:line-1"), one), {
    status: "shared",
    count: 2,
  });
  assert.deepEqual(findInScene(ref("face", "feature-3", "side:line-2"), one), {
    status: "found",
    index: 3,
  });
  // Edges 0 and 4: each line-1 side with the start cap, "side:line-1+start" twice.
  assert.deepEqual(findInScene(ref("edge", "feature-3", "side:line-1+start"), one), { status: "shared", count: 2 });
  // Edge 9 (side 0 > side 1) is the only "side:line-1>side:line-2", but which line-1 face it runs along can't be told.
  assert.deepEqual(findInScene(ref("edge", "feature-3", "side:line-1>side:line-2"), one), { status: "shared", count: 2 });
  // Edge 2 (line-2 with the start cap) and edge 7 (the end cap with line-4) touch no shared face.
  assert.deepEqual(findInScene(ref("edge", "feature-3", "side:line-2+start"), one), { status: "found", index: 2 });
  assert.deepEqual(findInScene(ref("edge", "feature-3", "end+side:line-4"), one), { status: "found", index: 7 });
});

test("the selection drops a shared face as it does a gone one, and the note says which is which", () => {
  const top = ref("face", "feature-2", "top");
  const left = ref("face", "feature-2", "left");
  const right = ref("face", "feature-2", "right");
  const rim = ref("edge", "feature-2", "bottom+right");
  assert.deepEqual(survivors([top, left, right], scene), {
    kept: [top],
    dropped: [left, right],
    shared: [right],
  });
  assert.equal(
    droppedNote([left, right], [right]),
    "Taken out of the selection: Left face, Right face. The edit took Left face off the body, so it could not be followed. Right face now matches more than one face, so it was not moved to any of them: pick again.",
  );
  assert.equal(droppedNote([right], [right]), "Taken out of the selection: Right face. Right face now matches more than one face, so it was not moved to any of them: pick again.");
  assert.equal(
    droppedNote([right, rim], [right, rim]),
    "Taken out of the selection: Right face, Edge of Bottom and Right. Right face and Edge of Bottom and Right now match more than one face or edge, so they were not moved to any of them: pick again.",
  );
  // A gone face alone keeps the words it had before 25a4.
  assert.equal(droppedNote([left]), "Taken out of the selection: Left face. The edit took them off the body, so they could not be followed.");
  // Nothing shared is drawn, and its row says why instead of a type.
  assert.deepEqual(highlightOf([top, right, rim], scene), {
    body: false,
    faces: [4],
    edges: [],
  });
  assert.deepEqual(
    selectionRows([right, left, top], scene).map((r) => r.type),
    [NAME_SHARED, NOT_ON_BODY, "plane"],
  );
});

test("a link another workspace holds finds its face by name: the solid it is on, gone, or a warning for two faces", async () => {
  const doc = partDocument("box", 40, 30, 20);
  // Design's own scene for that box: feature-1, named without collisions.
  const box = {
    bodies: [
      {
        feature: "feature-1",
        place: 1,
        view: BOX_VIEW,
        names: nameBody("feature-1", BOX_VIEW, () => null),
      },
    ],
    mesh: scene.mesh,
    faceStart: [0],
    edgeStart: [0],
  };
  const kernel = {
    call: () => Promise.reject(new Error("the box's spec needs no kernel")),
  } as unknown as KernelCalls;
  const lookup = designLookup(doc, box, kernel);
  const top = linkTo(
    "load-1",
    {
      kind: "geometry",
      origin: { workspace: "design", id: "feature-1", label: "Top face" },
      ref: ref("face", "feature-1", "top"),
    },
    ["solid"],
  );
  const status = resolveLink(top, lookup);
  assert.equal(status.state, "live");
  // The face's body, delivered as its exact solid: the 40 × 30 × 20 box the part is.
  const registry = new RepresentationRegistry();
  registerDesign(registry, kernel);
  const delivered = await registry.deliver((status as { object: never }).object, ["solid"]);
  assert.deepEqual(delivered.representation, {
    kind: "solid",
    spec: { box: { width: 40, depth: 30, height: 20 } },
  });
  // A face no longer on the body: the link's usual warning.
  const front = linkTo(
    "load-2",
    {
      kind: "geometry",
      origin: { workspace: "design", id: "feature-1", label: "Left face" },
      ref: ref("face", "feature-2", "left"),
    },
    ["solid"],
  );
  assert.deepEqual(resolveLink(front, designLookup(doc, scene, kernel)), {
    state: "unresolved",
    warning: "Linked to Left face in Design, which can't be found after the last edit. Pick a new source or break the link to keep the last copy.",
  });
  // Two faces carrying its name: said so, never one of them.
  const right = linkTo(
    "load-3",
    {
      kind: "geometry",
      origin: { workspace: "design", id: "feature-2", label: "Right face" },
      ref: ref("face", "feature-2", "right"),
    },
    ["solid"],
  );
  assert.deepEqual(resolveLink(right, designLookup(doc, scene, kernel)), {
    state: "unresolved",
    warning: "Linked to Right face in Design, which now matches more than one face after the last edit, so it was not moved to any of them. Pick a new source or break the link to keep the last copy.",
  });
  // Before the first build there are no bodies to find it on; another workspace's source is not Design's to find.
  assert.equal(designLookup(doc, null, kernel)(top.source), null);
  assert.equal(
    lookup({
      kind: "geometry",
      origin: { workspace: "render", id: "feature-1", label: "x" },
      ref: top.source.kind === "geometry" ? top.source.ref : ref("face", "", ""),
    }),
    null,
  );
  // An object source and a body: as before, by id.
  assert.deepEqual(
    lookup({
      kind: "object",
      origin: { workspace: "design", id: "feature-1", label: "Feature 1" },
    }),
    { type: "design.feature", id: "feature-1", document: doc },
  );
  assert.deepEqual(
    lookup({
      kind: "geometry",
      origin: { workspace: "design", id: "feature-1", label: "Body 1" },
      ref: { kind: "body", id: "body:feature-1" as StableId },
    }),
    { type: "design.feature", id: "feature-1", document: doc },
  );
});

test("names stay as they were: a shared name is still dropped from faces and edges, and kept only in shared", () => {
  const n = nameBody("feature-2", splitBox, () => null);
  assert.deepEqual(n.faces, ["bottom", "top", "front", "back", null, null]);
  assert.deepEqual([...n.shared.faces], [["right", 2]]);
  // Edges as given: bottom+right (0, 2), right+top (5, 7), front+right (8, 9), back+right (10, 11), each twice.
  assert.deepEqual([...n.shared.edges].sort(), [
    ["back+right", 2],
    ["bottom+right", 2],
    ["front+right", 2],
    ["right+top", 2],
  ]);
  assert.deepEqual([...nameBody("feature-1", BOX_VIEW, () => null).shared.faces], []);
});

test("seeded sessions: 12 seeds × 30 scenes × 40 references agree with the model, reaching every case", () => {
  const total: Record<string, number> = {};
  for (let seed = 1; seed <= 12; seed++) for (const [k, n] of Object.entries(runRefindSession(REAL, seed))) total[k] = (total[k] ?? 0) + n;
  for (const k of ["found-face", "found-edge", "gone-face", "gone-edge", "shared-face", "shared-edge", "shared-edge-by-face", "note-gone", "note-shared", "note-both", "note-none"])
    assert.ok((total[k] ?? 0) >= 10, `${k} reached ${total[k] ?? 0} times: ${JSON.stringify(total)}`);
});

test("the session's model is not Design's: a body it lays out gives the names it says", () => {
  // Self-consistency (doesn't count as hand-worked): for 200 random bodies, Design's nameBody keeps exactly the model's unique names.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 200; k++) {
    const b = randomBody(rand, `feature-${k}`);
    const names = sceneOf(REAL, [b]).bodies[0].names;
    const unique = (xs: (string | null)[]) => xs.map((x) => (x !== null && xs.filter((y) => y === x).length === 1 ? x : null));
    assert.deepEqual(names.faces, unique(b.faces), `body ${k} faces`);
    // An edge keeps a name only when both its faces do and no other edge has it.
    const faces = unique(b.faces);
    const edgeOk = b.edges.map((e, i) => {
      const [a, c] = (b.view.edge_faces[i] ?? [0, 0]) as [number, number];
      return faces[a] === null || faces[c] === null ? null : e;
    });
    assert.deepEqual(names.edges, unique(edgeOk), `body ${k} edges`);
  }
});

test("nasty references never throw, and never find a face or edge whose name isn't exactly theirs (seeded, 12 × 2000)", () => {
  // Ids built from the pieces names are made of, and the ones that break parsers: separators, escapes, prototype keys, empty parts.
  const bits = [
    "face",
    "edge",
    "body",
    "outline",
    ":",
    "/",
    "+",
    ">",
    "%2F",
    "%",
    "feature-1",
    "feature-2",
    "top",
    "right",
    "side",
    "side:line-1",
    "line-1",
    "start",
    "end",
    "__proto__",
    "constructor",
    "toString",
    "",
    " ",
    "é",
    "\u0000",
  ];
  const designed = randomBody(mulberry(3), "feature-1");
  const seen = { found: 0, gone: 0, shared: 0 };
  for (let seed = 1; seed <= 12; seed++) {
    const r = mulberry(seed);
    const bodies = [designed, randomBody(r, "feature-2"), { ...randomBody(r, "__proto__") }];
    const sc = sceneOf(REAL, bodies);
    const lookup = designLookup(partDocument("box", 40, 30, 20), sc, { call: () => Promise.reject(new Error("none")) } as unknown as KernelCalls);
    for (let k = 0; k < 2000; k++) {
      const kind = (["face", "edge", "body", "outline"] as const)[Math.floor(r() * 4)];
      const junk = () => Array.from({ length: 1 + Math.floor(r() * 4) }, () => bits[Math.floor(r() * bits.length)]).join(r() < 0.5 ? "" : bits[Math.floor(r() * 8)]);
      // Half shaped like a name (kind:feature/part, a real part half the time), half anything.
      const b = bodies[Math.floor(r() * bodies.length)];
      const parts = [...b.faces, ...b.edges].filter((x): x is string => x !== null);
      const id = r() < 0.5 ? junk() : `${kind}:${r() < 0.8 ? encodeURIComponent(b.feature) : junk()}/${r() < 0.5 && parts.length > 0 ? parts[Math.floor(r() * parts.length)] : junk()}`;
      const item = { kind, id: id as StableId } as GeometryReference;
      const found = findInScene(item, sc);
      seen[found.status]++;
      if (found.status === "found") {
        // Found means the name is that face's or edge's, exactly: built back from the index, the same id.
        const hit = sceneHit(sc, item.kind as "face" | "edge", found.index)!;
        assert.equal(designReference(item.kind as "face" | "edge", sc.bodies[hit.body].names, hit.index)?.id, item.id, `${JSON.stringify(item)} found at ${found.index}`);
      }
      survivors([item], sc);
      droppedNote([item], [item]);
      selectionRows([item], sc);
      highlightOf([item], sc);
      lookup({ kind: "geometry", origin: { workspace: "design", id: "x", label: "x" }, ref: item });
    }
  }
  assert.ok(seen.found >= 100 && seen.shared >= 20 && seen.gone >= 1000, JSON.stringify(seen));
});

test("regression (25a4 hunt): a name holding a bad escape is labelled as stored, never throws", () => {
  // Found by the nasty-references test above: "%" not followed by two hex digits made decodeURIComponent throw
  // "URI malformed" in referenceLabel (selection rows, the note). Design never builds such a name, but a link's
  // reference read from a file can hold one. A good escape still reads back: "%3A" is ":".
  const bad = ref("face", "feature-1", "side:line%2");
  assert.equal(referenceLabel(bad), "Side of line%2 face");
  assert.equal(referenceLabel(ref("face", "feature-1", "side:a%3Ab")), "Side of a:b face");
  assert.equal(referenceLabel(ref("edge", "feature-1", "side:%+start")), "Edge of Side of % and Start");
  assert.deepEqual(selectionRows([bad], scene)[0], { name: "Side of line%2 face", type: NOT_ON_BODY, id: "face:feature-1/side:line%2" });
  assert.equal(droppedNote([bad]), "Taken out of the selection: Side of line%2 face. The edit took them off the body, so they could not be followed.");
});
