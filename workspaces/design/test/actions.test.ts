import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, emptyProject, outlineToSvg, RepresentationRegistry, type AnalysisOverlay, type KernelCalls, type Selected, type WorkspaceContext } from "@fission/core";
import { COPY_SVG, DOWNLOAD_STL, partBody, registerDesignActions, representationsOf, STL_OVERLAY, targetsOf, type CopySvg } from "../src/actions.ts";
import { lastFeature, partDocument, specOf } from "../src/document.ts";
import { outline } from "../src/profiles.ts";
import { registerDesign } from "../src/representations.ts";

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

// ---- Copy as SVG (X6b) ----

const slot = partDocument("slot", 60, 20, 5);
const profile: Selected = { kind: "outline", id: "outline:profile-1" };

/** What Copy as SVG reads: the project and the representation registry with Design's producers. */
function copying(doc: unknown, copy: CopySvg, registerProducers = true) {
  const copied: string[] = [];
  const r = new ActionRegistry();
  registerDesignActions(r, () => assert.fail("nothing is saved"), async (svg) => {
    copied.push(svg);
    await copy(svg);
  });
  const representations = new RepresentationRegistry();
  const never = { call: () => Promise.reject(new Error("the kernel must not be asked")) } as unknown as KernelCalls;
  if (registerProducers) registerDesign(representations, never);
  const project = emptyProject();
  if (doc) project.workspaces.design = doc;
  const ctx = { project, representations } as unknown as WorkspaceContext;
  return { run: (targets: Selected[]) => r.get(COPY_SVG)!.run(targets, ctx), copied, r };
}
const fine: CopySvg = async () => {};

test("a selected profile offers Copy as SVG; a part with no profile, or a profile it lacks, offers nothing", () => {
  const { r } = registry();
  assert.deepEqual(representationsOf(profile, slot), ["outline"]);
  assert.deepEqual(r.actionsFor(targetsOf([profile], slot)).map((a) => a.label), ["Copy as SVG"]);
  // A box is not extruded from a profile.
  assert.deepEqual(r.actionsFor(targetsOf([profile], box)), []);
  assert.deepEqual(r.actionsFor(targetsOf([{ kind: "outline", id: "outline:profile-9" }], slot)), []);
  // A profile and the body together: neither verb takes both.
  assert.deepEqual(r.actionsFor(targetsOf([profile, body], slot)), []);
  // And the body alone still offers only Download STL.
  assert.deepEqual(r.actionsFor(targetsOf([body], slot)).map((a) => a.label), ["Download STL"]);
});

test("hand-worked: copying the 60 × 20 slot profile puts its SVG on the clipboard and says its size", async () => {
  const { run, copied } = copying(slot, fine);
  assert.deepEqual(await run([profile]), { message: "Copied as SVG: Slot with round ends profile, 60 × 20 mm.", bad: false });
  // The slot fits 60 × 20 with half-circle ends of radius 10 (profiles.ts):
  // straight sides (10,0)–(50,0) and (50,20)–(10,20), each end two quarter
  // turns through (60,10) and (0,10); in SVG, y flipped (svg.ts's tests work this through).
  assert.equal(copied.length, 1);
  assert.match(copied[0], /width="60mm" height="20mm" viewBox="0 -20 60 20"/);
  assert.match(copied[0], /d="M10 0L50 0A10 10 0 0 0 60 -10A10 10 0 0 0 50 -20L10 -20A10 10 0 0 0 0 -10A10 10 0 0 0 10 0Z"/);
  assert.match(copied[0], /<title>Slot with round ends profile<\/title>/);
  assert.equal(copied[0], outlineToSvg(outline("slot", 60, 20), "Slot with round ends profile").text);
});

test("hand-worked: the star's size is its points' box, not the 40 × 40 it was asked to fit", async () => {
  // Star at 40 × 40: outer radius 20 round (20,20), points at 0°, 72°, 144°,
  // 216°, 288°. Widest: x from 20 + 20·cos 144° = 20 − 16.1803 = 3.8197 to
  // 40, so 36.1803; y = 20 ± 20·sin 72° = 20 ± 19.0211, so 38.0423 (6 digits).
  const { run } = copying(partDocument("star", 40, 40, 5), fine);
  assert.deepEqual(await run([profile]), { message: "Copied as SVG: Star profile, 36.1803 × 38.0423 mm.", bad: false });
});

test("Copy as SVG refuses without a part, with two things, or with a profile no longer in the part", async () => {
  const { run, copied } = copying(slot, fine);
  assert.deepEqual(await copying(undefined, fine).run([profile]), { message: "There is no profile to copy yet.", bad: true });
  assert.deepEqual(await run([profile, profile]), { message: "Copy as SVG takes one profile, not 2 things.", bad: true });
  assert.deepEqual(await run([{ kind: "outline", id: "outline:profile-9" }]), { message: "outline:profile-9 is not a profile of the part, so there is nothing to copy.", bad: true });
  assert.deepEqual(await run([body]), { message: "body:feature-1 is not a profile of the part, so there is nothing to copy.", bad: true });
  assert.deepEqual(await copying(box, fine).run([profile]), { message: "outline:profile-1 is not a profile of the part, so there is nothing to copy.", bad: true });
  assert.deepEqual(copied, []);
});

test("the outline comes through the representation registry: with no producer there is nothing to copy", async () => {
  const { run, copied } = copying(slot, fine, false);
  assert.deepEqual(await run([profile]), { message: "Could not copy the profile: nothing knows how to describe a design.profile", bad: true });
  assert.deepEqual(copied, []);
});

test("a clipboard the browser refuses comes back as a bad outcome, never thrown", async () => {
  const { run } = copying(slot, () => Promise.reject(new Error("Write permission denied.")));
  assert.deepEqual(await run([profile]), { message: "Could not copy the profile: Write permission denied.", bad: true });
});
