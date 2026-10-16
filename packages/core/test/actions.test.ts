import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionRegistry, type Action, type ActionTarget } from "../src/model/actions.ts";

/** A verb that only records being run. */
function verb(over: Partial<Action> & Pick<Action, "id">): Action {
  return {
    workspace: "design",
    label: over.id,
    title: "",
    kinds: ["body"],
    uses: "mesh",
    count: "one",
    run: async () => ({ message: "", bad: false }),
    ...over,
  };
}

const body: ActionTarget = { ref: { kind: "body", id: "body:feature-1" }, representations: ["solid", "mesh"] };
const face: ActionTarget = { ref: { kind: "face", id: "face:feature-1/0" }, representations: ["outline"] };
const roundFace: ActionTarget = { ref: { kind: "face", id: "face:feature-1/2" }, representations: [] };

/** The registry the integration doc describes for a box: Download STL and Print for a body, Cut on laser for a flat face. */
function sample() {
  const r = new ActionRegistry();
  r.register(verb({ id: "design.download-stl", label: "Download STL" }));
  r.register(verb({ id: "slice.print", workspace: "slice", label: "Print", kinds: ["body"], uses: "mesh", count: "many" }));
  r.register(verb({ id: "laser.cut", workspace: "laser", label: "Cut on laser", kinds: ["face", "outline"], uses: "outline", count: "many" }));
  return r;
}
const labels = (actions: Action[]) => actions.map((a) => a.label);

test("the verbs for each selection, worked out by hand from what each verb takes", () => {
  const r = sample();
  // One body: it is a body and gives a mesh, so Download STL (one body) and
  // Print (one or more bodies) apply; Cut on laser takes faces, not bodies.
  assert.deepEqual(labels(r.actionsFor([body])), ["Download STL", "Print"]);
  // Two bodies: Download STL takes exactly one, Print takes many.
  assert.deepEqual(labels(r.actionsFor([body, { ...body, ref: { kind: "body", id: "body:feature-2" } }])), ["Print"]);
  // A flat face gives an outline: Cut on laser. A round face gives no outline: nothing.
  assert.deepEqual(labels(r.actionsFor([face])), ["Cut on laser"]);
  assert.deepEqual(labels(r.actionsFor([roundFace])), []);
  // A body and a face together: no verb takes both kinds.
  assert.deepEqual(labels(r.actionsFor([body, face])), []);
  // An edge: nobody registered a verb for edges.
  assert.deepEqual(labels(r.actionsFor([{ ref: { kind: "edge", id: "edge:feature-1/0" }, representations: [] }])), []);
});

test("an empty selection has no verbs", () => {
  assert.deepEqual(sample().actionsFor([]), []);
});

test("a body that can't give the representation a verb uses gets no such verb", () => {
  // A body whose mesh can't be made (e.g. no longer in the part): no Download STL, no Print.
  assert.deepEqual(labels(sample().actionsFor([{ ...body, representations: ["solid"] }])), []);
});

test("lookups by id and by workspace", () => {
  const r = sample();
  assert.equal(r.get("slice.print")?.label, "Print");
  assert.equal(r.get("slice.nothing"), undefined);
  assert.deepEqual(labels(r.byWorkspace("design")), ["Download STL"]);
  assert.deepEqual(labels(r.byWorkspace("render")), []);
});

test("a repeated id, an id not prefixed by its workspace, a badly formed id and a verb for nothing are refused", () => {
  const r = sample();
  assert.throws(() => r.register(verb({ id: "design.download-stl" })), /action design\.download-stl is already registered/);
  assert.throws(() => r.register(verb({ id: "slice.export", workspace: "design" })), /must be "design\.<verb>"/);
  assert.throws(() => r.register(verb({ id: "design.Download STL" })), /must be "design\.<verb>" in lower case/);
  assert.throws(() => r.register(verb({ id: "design" })), /must be "design\.<verb>"/);
  assert.throws(() => r.register(verb({ id: "design.nothing", kinds: [] })), /applies to nothing/);
  // None of the refused ones went in.
  assert.deepEqual(labels(r.byWorkspace("design")), ["Download STL"]);
});
