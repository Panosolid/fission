import { test } from "node:test";
import assert from "node:assert/strict";
import { XY_PLANE, type BodyView, type GeometryReference, type StableId } from "@fission/core";
import type { ReadyProfile } from "../src/document.ts";
import { designReference, profileReference, readDesignReference, readProfileReference } from "../src/references.ts";
import { droppedNote, highlightOf, NOT_IN_DESIGN, NOT_ON_BODY, selectionRows, survivors } from "../src/selection.ts";

const face = (i: number, feature = "feature-1") => designReference("face", feature, i);
const edge = (i: number) => designReference("edge", "feature-1", i);
const body = designReference("body", "feature-1");

test("readDesignReference undoes designReference and refuses ids it did not build", () => {
  assert.deepEqual(readDesignReference(face(3)), { kind: "face", featureId: "feature-1", index: 3 });
  assert.deepEqual(readDesignReference(edge(0)), { kind: "edge", featureId: "feature-1", index: 0 });
  assert.deepEqual(readDesignReference(body), { kind: "body", featureId: "feature-1" });
  const ref = (kind: GeometryReference["kind"], id: string) => ({ kind, id: id as StableId }) as GeometryReference;
  for (const bad of [ref("face", "edge:feature-1/3"), ref("face", "face:feature-1"), ref("body", "body:feature-1/2"), ref("face", "face:feature-1/03"), ref("face", "face:feature-1/-1"), ref("edge", "named-by-step-32")])
    assert.equal(readDesignReference(bad), null, bad.id);
});

test("the highlight lists the selected faces and edges of the body on screen", () => {
  assert.deepEqual(highlightOf([], "feature-1"), { body: false, faces: [], edges: [] });
  assert.deepEqual(highlightOf([face(1), edge(4), face(2), edge(8)], "feature-1"), { body: false, faces: [1, 2], edges: [4, 8] });
  assert.deepEqual(highlightOf([body], "feature-1"), { body: true, faces: [], edges: [] });
  // Another feature's face (a body that is not on screen) draws nothing.
  assert.deepEqual(highlightOf([face(1, "feature-2")], "feature-1"), { body: false, faces: [], edges: [] });
});

test("properties rows give each item's name, type and placeholder id", () => {
  // A cylinder's view (primitives.rs): bottom cap, top cap, side; two rim circles.
  const view = { face_types: ["plane", "plane", "cylinder"], edge_types: ["circle", "circle"] } as BodyView;
  assert.deepEqual(selectionRows([face(2), edge(1), body], "feature-1", view), [
    { name: "Face 2", type: "cylinder", id: "face:feature-1/2" },
    { name: "Edge 1", type: "circle", id: "edge:feature-1/1" },
    { name: "Body 1", type: "solid", id: "body:feature-1" },
  ]);
  // Face 3 is past the cylinder's three faces; another feature's face is not on screen.
  assert.deepEqual(selectionRows([face(3), face(0, "feature-2")], "feature-1", view).map((r) => r.type), [NOT_ON_BODY, NOT_ON_BODY]);
  // Before anything built the type is not known yet.
  assert.deepEqual(selectionRows([face(0)], "feature-1", null)[0].type, "…");
});

// Topology of the kernel's primitives (primitives.rs): a box has 8 corners,
// 12 straight edges and 6 flat faces; a cylinder 2 vertices (one on each rim),
// 2 rim circles, and 3 faces (bottom cap, top cap, side).
const boxView = { vertices: 8, edges: 12, faces: 6, face_types: Array(6).fill("plane"), edge_types: Array(12).fill("line") } as BodyView;
const cylinderView = { vertices: 2, edges: 2, faces: 3, face_types: ["plane", "plane", "cylinder"], edge_types: ["circle", "circle"] } as BodyView;

test("a resize keeps the selected faces and edges; a change of shape drops them", () => {
  const items = [face(1), edge(4), body];
  // A wider box: same counts and types at every index, so all three stay.
  assert.deepEqual(survivors(items, "feature-1", boxView, { ...boxView, volume: 2 } as BodyView), { kept: items, dropped: [] });
  // Box to cylinder: face 1 is still a plane (the top cap) but the counts
  // changed, so it is not the same face; edge 4 is past the cylinder's two
  // edges. The body stays.
  assert.deepEqual(survivors(items, "feature-1", boxView, cylinderView), { kept: [body], dropped: [face(1), edge(4)] });
  // Same counts but a different type at the index: dropped (side face → plane).
  const swapped = { ...cylinderView, face_types: ["plane", "cylinder", "plane"] } as BodyView;
  assert.deepEqual(survivors([face(2), face(0)], "feature-1", cylinderView, swapped), { kept: [face(0)], dropped: [face(2)] });
});

test("with no earlier body only the index is checked; others' references are left alone", () => {
  // Back from another workspace: face 2 is on the cylinder, face 5 is not.
  assert.deepEqual(survivors([face(2), face(5)], "feature-1", null, cylinderView), { kept: [face(2)], dropped: [face(5)] });
  // Another feature's face, and an id Design did not build, are not Design's to drop here.
  const foreign = { kind: "face", id: "named-by-step-32" as StableId } as GeometryReference;
  assert.deepEqual(survivors([face(9, "feature-2"), foreign], "feature-1", boxView, cylinderView).dropped, []);
});

test("the note names what was dropped, and is empty when nothing was", () => {
  assert.equal(droppedNote([]), "");
  assert.match(droppedNote([face(1), edge(4)]), /^Taken out of the selection: Face 1, Edge 4\. /);
});

// ---- Profiles (X6b): selectable from the browser as outlines ----

const slotProfile: ReadyProfile = { id: "profile-1", kind: "slot", width: 60, depth: 20, plane: XY_PLANE };
const profile = profileReference("profile-1");

test("profileReference names a profile by its own id, and readProfileReference undoes it", () => {
  assert.deepEqual(profile, { kind: "outline", id: "outline:profile-1" });
  assert.equal(readProfileReference(profile), "profile-1");
  // Ids it did not build, or of another kind, are not profiles.
  assert.equal(readProfileReference(body), null);
  assert.equal(readProfileReference({ kind: "outline", id: "outline:a/b" }), null);
  assert.equal(readProfileReference({ kind: "body", id: "outline:profile-1" }), null);
  assert.throws(() => profileReference(""), /invalid profile id ""/);
  assert.throws(() => profileReference("a:b"), /invalid profile id "a:b"/);
  // designReference never makes one of these (it builds bodies, faces and edges from a feature).
  assert.equal(readDesignReference(profile), null);
});

test("a selected profile: named as the browser names it, of type outline, drawn on no face", () => {
  assert.deepEqual(selectionRows([profile, body], "feature-1", boxView, [slotProfile]), [
    { name: "Slot with round ends profile", type: "outline", id: "outline:profile-1" },
    { name: "Body 1", type: "solid", id: "body:feature-1" },
  ]);
  // A profile the document no longer has says so.
  assert.deepEqual(selectionRows([profile], "feature-1", boxView, []), [{ name: "Outline", type: NOT_IN_DESIGN, id: "outline:profile-1" }]);
  // The profile is not part of the body: selecting it lights nothing in the viewport.
  assert.deepEqual(highlightOf([profile], "feature-1"), { body: false, faces: [], edges: [] });
});

test("a rebuild keeps the profile while the part has it; a change to a box drops it, with a note", () => {
  // A resize or a change of profile kind keeps profile-1.
  assert.deepEqual(survivors([profile, body], "feature-1", boxView, boxView, ["profile-1"]), { kept: [profile, body], dropped: [] });
  // A box has no profiles.
  assert.deepEqual(survivors([profile, body], "feature-1", boxView, boxView, []), { kept: [body], dropped: [profile] });
  assert.equal(droppedNote([profile]), "Taken out of the selection: the profile. The part has no profile now.");
  assert.equal(
    droppedNote([face(1), profile]),
    "Taken out of the selection: Face 1, the profile. The edit renumbered the body's faces and edges, so these could not be followed. The part has no profile now.",
  );
});
