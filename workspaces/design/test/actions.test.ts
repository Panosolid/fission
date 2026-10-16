import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, emptyProject, type AnalysisOverlay, type KernelCalls, type Selected, type WorkspaceContext } from "@fission/core";
import { DOWNLOAD_STL, partBody, registerDesignActions, representationsOf, STL_OVERLAY, targetsOf } from "../src/actions.ts";
import { lastFeature, partDocument, specOf } from "../src/document.ts";

const box = partDocument("box", 40, 30, 20);
const body: Selected = { kind: "body", id: "body:feature-1" };

function registry() {
  const saved: { name: string; bytes: number[] }[] = [];
  const r = new ActionRegistry();
  registerDesignActions(r, (bytes, name) => saved.push({ name, bytes: [...bytes] }));
  return { r, saved };
}

/** Just what Download STL reads: the project, the kernel and the viewport's overlays. */
function context(doc: unknown, call: (op: string, ...args: unknown[]) => Promise<unknown>) {
  const overlays: (AnalysisOverlay | string)[] = [];
  const project = emptyProject();
  if (doc) project.workspaces.design = doc;
  const ctx = {
    project,
    kernel: { call } as unknown as KernelCalls,
    viewport: {
      setOverlay: (o: AnalysisOverlay) => overlays.push(o),
      clearOverlay: (id: string) => overlays.push(`clear ${id}`),
    },
  } as unknown as WorkspaceContext;
  return { ctx, overlays };
}

test("Design's verbs for its body: Download STL; none for a face, an edge or an empty selection", () => {
  const { r } = registry();
  // Feature 1 builds the part's one body, "body:feature-1": an exact solid
  // that can also be a mesh, and STL is a mesh, so Download STL applies.
  assert.equal(partBody(box).id, "body:feature-1");
  assert.deepEqual(representationsOf(body, box), ["solid", "mesh"]);
  assert.deepEqual(r.actionsFor(targetsOf([body], box)).map((a) => a.label), ["Download STL"]);
  assert.deepEqual(r.actionsFor(targetsOf([{ kind: "face", id: "face:feature-1/0" }], box)), []);
  assert.deepEqual(r.actionsFor(targetsOf([{ kind: "edge", id: "edge:feature-1/0" }], box)), []);
  assert.deepEqual(r.actionsFor(targetsOf([], box)), []);
  // A body that is not the part's (an id from before a file was opened): nothing to download.
  assert.deepEqual(r.actionsFor(targetsOf([{ kind: "body", id: "body:feature-9" }], box)), []);
  assert.deepEqual(r.actionsFor(targetsOf([body], undefined)), []);
});

test("Download STL saves the kernel's file under the shape's name and clears the precision overlay", async () => {
  const { r, saved } = registry();
  const calls: unknown[][] = [];
  const { ctx, overlays } = context(box, async (...args) => {
    calls.push(args);
    return { bytes: new Uint8Array([1, 2, 3]), rounding: 0, warning: null };
  });
  const outcome = await r.get(DOWNLOAD_STL)!.run([body], ctx);
  assert.deepEqual(outcome, { message: "", bad: false });
  // The kernel is asked for the part's own spec, named by its shape.
  assert.deepEqual(calls, [["export_stl", specOf(box, lastFeature(box)), "box"]]);
  assert.deepEqual(saved, [{ name: "fission-box.stl", bytes: [1, 2, 3] }]);
  assert.deepEqual(overlays, [`clear ${STL_OVERLAY}`]);
});

test("a warning from the kernel is shown as bad and marks the whole body", async () => {
  const { r, saved } = registry();
  const warning = "single-precision numbers: this part's corners move by up to 1.250e-2 mm";
  const { ctx, overlays } = context(box, async () => ({ bytes: new Uint8Array([9]), rounding: 0.0125, warning }));
  assert.deepEqual(await r.get(DOWNLOAD_STL)!.run([body], ctx), { message: warning, bad: true });
  assert.equal(saved.length, 1, "the file is still saved: the warning says how far it is off");
  assert.deepEqual(overlays, [{ id: STL_OVERLAY, label: "Too big for an accurate STL", detail: warning, marks: [{ target: { body: true }, severity: "warning" }] }]);
});

test("a kernel error comes back as a bad outcome, never thrown, and saves nothing", async () => {
  const { r, saved } = registry();
  const { ctx, overlays } = context(box, () => Promise.reject(new Error("width must be greater than 0")));
  assert.deepEqual(await r.get(DOWNLOAD_STL)!.run([body], ctx), { message: "width must be greater than 0", bad: true });
  assert.deepEqual(saved, []);
  assert.deepEqual(overlays, []);
});

test("Download STL refuses without a part, with two things, or with a body no longer in the part", async () => {
  const { r, saved } = registry();
  const never = () => Promise.reject(new Error("the kernel must not be asked"));
  const run = (doc: unknown, targets: Selected[]) => r.get(DOWNLOAD_STL)!.run(targets, context(doc, never).ctx);
  assert.deepEqual(await run(undefined, [body]), { message: "There is no part to download yet.", bad: true });
  assert.deepEqual(await run(box, [body, body]), { message: "Download STL takes one body, not 2 things.", bad: true });
  assert.deepEqual(await run(box, [{ kind: "body", id: "body:feature-9" }]), { message: "body:feature-9 is not a body of the part, so there is nothing to download.", bad: true });
  assert.deepEqual(await run(box, [{ kind: "face", id: "face:feature-1/0" }]), { message: "face:feature-1/0 is not a body of the part, so there is nothing to download.", bad: true });
  assert.deepEqual(saved, []);
});
