import { test } from "node:test";
import assert from "node:assert/strict";
import { XY_PLANE, type BodyView, type GeometryReference, type StableId } from "@fission/core";
import { partDocument, type ReadyProfile } from "../src/document.ts";
import { nameBody } from "../src/naming.ts";
import { bodyReference, designReference, profileReference, readDesignReference, readProfileReference } from "../src/references.ts";
import { droppedNote, highlightOf, NOT_IN_DESIGN, NOT_ON_BODY, selectionRows, survivors } from "../src/selection.ts";
import { BOX_VIEW, CYLINDER_VIEW, onlyBody } from "./views.ts";

const box = nameBody("feature-1", BOX_VIEW, () => null);
const cylinder = nameBody("feature-1", CYLINDER_VIEW, () => null);
const face = (i: number, names = box) => designReference("face", names, i)!;
const edge = (i: number) => designReference("edge", box, i)!;
const body = bodyReference("feature-1");
const boxScene = onlyBody(BOX_VIEW, box);
const cylinderScene = onlyBody(CYLINDER_VIEW, cylinder);

test("the highlight lists the selected faces and edges of the body on screen, by name", () => {
  assert.deepEqual(highlightOf([], boxScene), { body: false, faces: [], edges: [] });
  assert.deepEqual(highlightOf([face(1), edge(4), face(2), edge(8)], boxScene), { body: false, faces: [1, 2], edges: [4, 8] });
  assert.deepEqual(highlightOf([body], boxScene), { body: true, faces: [], edges: [] });
  // On the cylinder the box's top (face 1) is the cylinder's top, index 1; its front (2) and top front edge (4) aren't there.
  assert.deepEqual(highlightOf([face(1), face(2), edge(4)], cylinderScene), { body: false, faces: [1], edges: [] });
  // Another feature's face or body (not on screen) draws nothing.
  assert.deepEqual(highlightOf([face(1, nameBody("feature-2", BOX_VIEW, () => null)), bodyReference("feature-2")], boxScene), { body: false, faces: [], edges: [] });
  // Before a body is built nothing is drawn.
  assert.deepEqual(highlightOf([face(1), body], null), { body: false, faces: [], edges: [] });
});

test("properties rows give each item's name, type and stable name", () => {
  assert.deepEqual(selectionRows([face(1), edge(4), body], boxScene), [
    { name: "Top face", type: "plane", id: "face:feature-1/top" },
    { name: "Edge of Front and Top", type: "line", id: "edge:feature-1/front+top" },
    { name: "Body 1", type: "solid", id: "body:feature-1" },
  ]);
  // On the cylinder the box's front is gone; another feature's face is not on screen.
  const other = face(0, nameBody("feature-2", BOX_VIEW, () => null));
  assert.deepEqual(selectionRows([face(1), face(2), other], cylinderScene).map((r) => r.type), ["plane", NOT_ON_BODY, NOT_ON_BODY]);
  // Before anything built the type is not known yet.
  assert.deepEqual(selectionRows([face(0)], null)[0].type, "…");
  // A side and an upright of a sketch's extrude, in words.
  const side = { kind: "face", id: "face:feature-7/side:line-4" as StableId } as GeometryReference;
  const upright = { kind: "edge", id: "edge:feature-7/side:line-4>side:arc-6" as StableId } as GeometryReference;
  assert.deepEqual(selectionRows([side, upright], null).map((r) => r.name), ["Side of line-4 face", "Edge of Side of line-4 and Side of arc-6"]);
});

test("a rebuild keeps every face and edge whose name is still on the body, wherever the kernel numbers it now", () => {
  const items = [face(1), edge(4), body];
  // A wider box: the same names.
  assert.deepEqual(survivors(items, boxScene), { kept: items, dropped: [], shared: [] });
  // The same box with its faces listed the other way round: renumbered, every name still there.
  const reversed = nameBody("feature-1", { ...BOX_VIEW, face_roles: [...BOX_VIEW.face_roles].reverse(), edge_faces: BOX_VIEW.edge_faces.map((p) => p && ([5 - p[0], 5 - p[1]] as [number, number])) } as BodyView, () => null);
  assert.deepEqual(survivors(items, onlyBody(BOX_VIEW, reversed)), { kept: items, dropped: [], shared: [] });
  assert.deepEqual(highlightOf(items, onlyBody(BOX_VIEW, reversed)), { body: true, faces: [4], edges: [4] });
  // Box to cylinder (the same feature, changed): its top is still the top; the top front edge is gone. The body stays.
  assert.deepEqual(survivors(items, cylinderScene), { kept: [face(1), body], dropped: [edge(4)], shared: [] });
});

test("references to another feature, and ids Design did not build, are left alone", () => {
  const foreign = { kind: "face", id: "named-by-step-32" as StableId } as GeometryReference;
  const other = face(1, nameBody("feature-2", BOX_VIEW, () => null));
  assert.deepEqual(survivors([other, foreign], cylinderScene).dropped, []);
});

test("the note names what was dropped, and is empty when nothing was", () => {
  assert.equal(droppedNote([]), "");
  assert.equal(droppedNote([edge(4)]), "Taken out of the selection: Edge of Front and Top. The edit took them off the body, so they could not be followed.");
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
  // designReference and bodyReference never make one of these (they build bodies, faces and edges from a feature).
  assert.equal(readDesignReference(profile), null);
});

test("a selected profile: named as the browser names it, of type outline, drawn on no face", () => {
  assert.deepEqual(selectionRows([profile, body], boxScene, { ...partDocument("box", 40, 30, 20), profiles: [slotProfile] }), [
    { name: "Slot with round ends profile", type: "outline", id: "outline:profile-1" },
    { name: "Body 1", type: "solid", id: "body:feature-1" },
  ]);
  // A profile the document no longer has says so.
  assert.deepEqual(selectionRows([profile], boxScene, partDocument("box", 40, 30, 20)), [{ name: "Outline", type: NOT_IN_DESIGN, id: "outline:profile-1" }]);
  // The profile is not part of the body: selecting it lights nothing in the viewport.
  assert.deepEqual(highlightOf([profile], boxScene), { body: false, faces: [], edges: [] });
});

test("a rebuild keeps the profile while the part has it; a change to a box drops it, with a note", () => {
  // A resize or a change of profile kind keeps profile-1.
  assert.deepEqual(survivors([profile, body], boxScene, ["profile-1"]), { kept: [profile, body], dropped: [], shared: [] });
  // A box has no profiles.
  assert.deepEqual(survivors([profile, body], boxScene, []), { kept: [body], dropped: [profile], shared: [] });
  assert.equal(droppedNote([profile]), "Taken out of the selection: the profile. The part has no profile now.");
  assert.equal(
    droppedNote([face(1), profile]),
    "Taken out of the selection: Top face, the profile. The edit took them off the body, so they could not be followed. The part has no profile now.",
  );
});
