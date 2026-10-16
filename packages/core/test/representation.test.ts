import { test } from "node:test";
import assert from "node:assert/strict";
import { RepresentationRegistry, type MeshRep, type OutlineRep, type SolidRep, XY_PLANE } from "../src/model/representation.ts";

const box: SolidRep = { kind: "solid", spec: { box: { width: 1, depth: 2, height: 3 } } };
const tri: MeshRep = { kind: "mesh", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
const square: OutlineRep = { kind: "outline", plane: XY_PLANE, outline: { outer: { path: { corners: [0, 0, 1, 0, 1, 1, 0, 1], bulges: [] } }, holes: [] } };

/** A registry where "part" gives a solid and a mesh, like a Design feature. */
function partRegistry() {
  const r = new RepresentationRegistry();
  r.registerProducer("part", "mesh", () => tri);
  r.registerProducer("part", "solid", () => box);
  return r;
}

test("the most exact accepted representation wins, with no note", async () => {
  const d = await partRegistry().deliver({ type: "part", id: "p1" }, ["mesh", "solid"]);
  assert.deepEqual(d, { representation: box, note: null });
});

test("a target that only takes meshes gets one, with a note saying what was lost", async () => {
  const d = await partRegistry().deliver({ type: "part", id: "p1" }, ["mesh"]);
  assert.equal(d.representation, tri);
  assert.equal(d.note, "Sent as a triangle mesh: the target can't take an exact solid, so curved faces become flat facets.");
});

test("a mesh-only source gives a mesh with no note: nothing better was there to lose", async () => {
  const r = new RepresentationRegistry();
  r.registerProducer("scan", "mesh", () => tri);
  assert.deepEqual(await r.deliver({ type: "scan", id: "s" }, ["solid", "mesh"]), { representation: tri, note: null });
});

test("no fitting representation is a clear error, never a silent drop", async () => {
  await assert.rejects(partRegistry().deliver({ type: "part", id: "p1" }, ["image"]), /a part can be an exact solid or a triangle mesh, but the target only takes an image/);
  await assert.rejects(partRegistry().deliver({ type: "logo", id: "l" }, ["outline"]), /nothing knows how to describe a logo/);
});

test("converters fill gaps, and a direct producer beats a conversion", async () => {
  const r = new RepresentationRegistry();
  r.registerProducer("profile", "outline", () => square);
  let converted = 0;
  r.registerConverter({ from: "outline", to: "mesh", convert: () => (converted++, tri) });
  assert.deepEqual(r.plan("profile", ["mesh"]), { kind: "mesh", via: "outline" });
  assert.equal((await r.deliver({ type: "profile", id: "x" }, ["mesh"])).representation, tri);
  assert.equal(converted, 1);
  r.registerProducer("profile", "mesh", () => tri);
  assert.deepEqual(r.plan("profile", ["mesh"]), { kind: "mesh", via: null });
});

test("one producer per type and kind", () => {
  const r = partRegistry();
  assert.throws(() => r.registerProducer("part", "mesh", () => tri), /already has a mesh producer/);
});

test("a producer returning the wrong kind is caught", async () => {
  const r = new RepresentationRegistry();
  r.registerProducer("odd", "solid", () => tri);
  await assert.rejects(r.deliver({ type: "odd", id: "o" }, ["solid"]), /solid producer for odd returned mesh/);
});
