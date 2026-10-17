// Journey: Design → STL with no file exports, on the real WASM kernel.
// A print plate (standing in for Slice, which is still a placeholder) links
// to the part, gets its STL, and follows an edit; a frozen copy doesn't;
// a link whose source goes away warns. Run with `npm run journeys` after
// the app build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangeNotes, DependencyGraph, emptyProject, fetchLinked, breakLink, linkTo, readProject, resolveLink, RepresentationRegistry, type SourceLookup } from "@fission/core";
import { designObjects, designWorkspace, lastFeature, partDocument, readDesignDocument, specOf, syncGraph, type DesignDocument } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

/** Volume of a binary STL: Σ (a · (b × c)) / 6 over its triangles. */
function stlVolume(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(80, true);
  let six = 0;
  for (let t = 0; t < n; t++) {
    const p = (k: number) => v.getFloat32(84 + 50 * t + 12 + 4 * k, true);
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(p);
    six += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.abs(b), `${a} vs ${b}`);

function journey() {
  const kernel = nodeKernel();
  const registry = new RepresentationRegistry();
  designWorkspace.registerRepresentations!(registry, kernel);
  const project = emptyProject("Journey");
  const graph = new DependencyGraph();
  const notes = new ChangeNotes();
  const design = () => project.workspaces.design as DesignDocument;
  const edit = (doc: DesignDocument) => {
    syncGraph(graph, doc, (project.workspaces.design as DesignDocument | undefined) ?? null, notes);
    project.workspaces.design = doc;
  };
  const lookup: SourceLookup = (s) => designObjects(design(), kernel).find((o) => o.id === s.origin.id) ?? null;
  return { kernel, registry, project, graph, notes, design, edit, lookup };
}

test("a print plate links to a part, gets its STL, and follows an edit", async () => {
  const { kernel, registry, project, graph, notes, design, edit, lookup } = journey();
  edit(partDocument("box", 40, 30, 20));

  // The plate links to the part: live by default, by id, nothing copied.
  const link = linkTo("plate-1/model-1", { kind: "object", origin: lastFeature(design()).provenance.self }, ["solid", "mesh"]);
  project.links.push(link);
  graph.set({ id: "plate-1", label: "Print plate", workspace: "slice", cost: "cheap" }, ["feature-1"]);

  const stl = async () => {
    const { representation, note } = await fetchLinked(link, lookup, registry);
    assert.equal(representation.kind, "solid", "the plate accepts solids, so it gets the exact one");
    assert.equal(note, null);
    // Lossless: what arrived is exactly what Design builds from its intent.
    assert.deepEqual(representation, { kind: "solid", spec: specOf(design(), lastFeature(design())) });
    if (representation.kind !== "solid") throw new Error("expected a solid");
    const file = await kernel.call("export_stl", representation.spec, "plate");
    return stlVolume(file.bytes);
  };
  // 40 · 30 · 20 = 24000.
  close(await stl(), 24000);

  // Edit the part: the plate is marked out of date, and its STL follows.
  edit(partDocument("box", 50, 30, 20));
  assert.equal(graph.isStale("plate-1"), true);
  // …and a change note in Slice names the cause, with the chain back to it.
  const [note] = notes.current(graph);
  assert.equal(note.text, "Print plate updating: you changed the box in Design.");
  assert.deepEqual(note.chain, ["Box: 50 × 30 × 20 mm in Design", "Print plate in Slice"]);
  close(await stl(), 30000); // 50 · 30 · 20
  graph.markFresh("plate-1");
  assert.equal(notes.current(graph)[0].text, "Print plate updated: you changed the box in Design.");

  // The whole project, links and all, saves and reads back unchanged.
  const reread = readProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reread, project);
  assert.deepEqual(readDesignDocument(reread.workspaces.design), design());
});

test("a target that only takes meshes gets one, with a note, and the same volume", async () => {
  const { registry, edit, design, lookup } = journey();
  edit(partDocument("box", 40, 30, 20));
  const link = linkTo("viewer-1", { kind: "object", origin: lastFeature(design()).provenance.self }, ["mesh"]);
  const { representation, note } = await fetchLinked(link, lookup, registry);
  assert.match(note!, /Sent as a triangle mesh/);
  assert.equal(representation.kind, "mesh");
  const { positions: p, indices: ix } = representation as { positions: number[]; indices: number[] };
  let six = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]].map((i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]);
    six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  close(six / 6, 24000);
});

test("a frozen copy stays put, and a link whose source goes away warns", async () => {
  const { kernel, registry, edit, design, lookup } = journey();
  edit(partDocument("l-bracket", 40, 30, 20));
  // A laser job linked to the bracket's profile (an exact outline).
  const profile = designObjects(design(), kernel).find((o) => o.type === "design.profile")!;
  const cut = linkTo("job-1/cut-1", { kind: "object", origin: { workspace: "design", id: profile.id, label: "L-bracket profile" } }, ["outline"]);
  const frozen = await breakLink(cut, lookup, registry);

  // Switching the part to a box removes the profile.
  edit(partDocument("box", 40, 30, 20));
  const status = resolveLink(cut, lookup);
  assert.equal(status.state, "unresolved");
  assert.match((status as { warning: string }).warning, /L-bracket profile in Design, which can't be found after the last edit/);
  // The frozen copy still has the bracket's outline: 6 corners.
  assert.equal(frozen.representation.kind, "outline");
  assert.equal((frozen.representation as { outline: { outer: { path: { corners: number[] } } } }).outline.outer.path.corners.length, 12);
});
