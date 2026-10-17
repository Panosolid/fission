import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_HIGHLIGHT, type Framing, type SharedViewport, type ViewportPick } from "@fission/core";
import { paneViewports, type PaneCamera } from "../src/pane.ts";

/** A viewer that records what it was asked to do. */
function fakeScene() {
  const calls: string[] = [];
  const scene: SharedViewport = {
    element: {} as HTMLElement,
    showBody: () => void calls.push("showBody"),
    bodyFraming: () => ({ centre: [1, 2, 3], radius: 4 }),
    fit: () => (calls.push("scene.fit"), null),
    setView: () => (calls.push("scene.setView"), null),
    fitSelection: () => (calls.push("scene.fitSelection"), null),
    lookAt: () => (calls.push("scene.lookAt"), null),
    setOverlay: (o) => void calls.push(`setOverlay ${o.id}`),
    clearOverlay: (id) => void calls.push(`clearOverlay ${id}`),
    showSelection: (h) => void calls.push(`showSelection faces ${h.faces.join(",")}`),
    showImage: () => void calls.push("scene.showImage"),
    clearImage: () => void calls.push("scene.clearImage"),
    showSketches: (d) => void calls.push(`showSketches ${d.length}`),
    showPlanes: (p) => void calls.push(`showPlanes ${p.map((x) => x.id).join(",")}`),
    onPick: null,
    onSketchPointer: null,
  };
  return { scene, calls };
}

/** A view whose camera calls say which view they reached. */
function fakeView(name: string, calls: string[]): PaneCamera {
  const framed: Framing = { centre: [0, 0, 0], radius: name.length };
  return {
    element: { id: name } as unknown as HTMLElement,
    fit: () => (calls.push(`${name}.fit`), framed),
    setView: (v) => (calls.push(`${name}.setView ${v}`), framed),
    fitSelection: () => (calls.push(`${name}.fitSelection`), null),
    lookAt: (p) => (calls.push(`${name}.lookAt ${p.normal.join(",")}`), framed),
    showImage: (image) => void calls.push(`${name}.showImage ${image.width}x${image.height}`),
    clearImage: () => void calls.push(`${name}.clearImage`),
  };
}

test("camera calls reach the pane's own view; scene calls reach the one viewer", () => {
  const { scene, calls } = fakeScene();
  const pane = paneViewports(scene);
  const left = pane(fakeView("left", calls));
  const right = pane(fakeView("right", calls));
  assert.equal((left.element as unknown as { id: string }).id, "left");
  assert.equal((right.element as unknown as { id: string }).id, "right");
  // The view's own framing comes back: "right" has 5 letters, so radius 5.
  assert.equal(right.setView("top")?.radius, 5);
  left.fit();
  right.fitSelection();
  assert.equal(left.lookAt({ origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] })?.radius, 4);
  // The body's framing is the scene's, the same seen from either pane.
  assert.deepEqual(left.bodyFraming(), { centre: [1, 2, 3], radius: 4 });
  assert.deepEqual(right.bodyFraming(), left.bodyFraming());
  right.setOverlay({ id: "stl", label: "x", faces: [] } as never);
  left.clearOverlay("stl");
  right.showSelection({ body: false, faces: [2, 5], edges: [] });
  left.showBody({} as never);
  // Never the scene's own camera: a pane must not turn another pane's view.
  assert.deepEqual(calls, ["right.setView top", "left.fit", "right.fitSelection", "left.lookAt 0,0,1", "setOverlay stl", "clearOverlay stl", "showSelection faces 2,5", "showBody"]);
  assert.ok(!calls.some((c) => c.startsWith("scene.")));
});

test("an image goes to the pane's own view only, so the other pane keeps the body", () => {
  const { scene, calls } = fakeScene();
  const pane = paneViewports(scene);
  const left = pane(fakeView("left", calls));
  pane(fakeView("right", calls));
  left.showImage({ kind: "image", width: 4, height: 2, mmPerPixel: 1, rgba: new Uint8ClampedArray(32) } as never);
  left.clearImage();
  assert.deepEqual(calls, ["left.showImage 4x2", "left.clearImage"]);
});

test("the viewer picks for the pane that set its handler last and still has one", () => {
  const { scene } = fakeScene();
  const pane = paneViewports(scene);
  const a = pane(fakeView("a", []));
  const b = pane(fakeView("b", []));
  const got: string[] = [];
  const click: ViewportPick = { face: 1, shift: false };
  const handlerA = () => void got.push("a");
  const handlerB = () => void got.push("b");

  a.onPick = handlerA;
  assert.equal(scene.onPick, handlerA);
  b.onPick = handlerB;
  assert.equal(scene.onPick, handlerB, "the newest wins");
  assert.equal(a.onPick, handlerA, "each pane still reads back its own");
  // b hides: a keeps picking, rather than nobody (what a plain forward would do).
  b.onPick = null;
  assert.equal(scene.onPick, handlerA);
  scene.onPick?.(click);
  assert.deepEqual(got, ["a"]);
  // a hides too: nothing listens.
  a.onPick = null;
  assert.equal(scene.onPick, null);
  assert.equal(a.onPick, null);
});

test("a pane clearing a handler it never set leaves the other pane's alone, and setting again moves it to the front", () => {
  const { scene } = fakeScene();
  const pane = paneViewports(scene);
  const a = pane(fakeView("a", []));
  const b = pane(fakeView("b", []));
  const handlerA = () => {};
  const handlerA2 = () => {};
  const handlerB = () => {};
  a.onPick = handlerA;
  b.onPick = null; // a placeholder hiding: it never listened
  assert.equal(scene.onPick, handlerA);
  b.onPick = handlerB;
  a.onPick = handlerA2; // a re-mounts after b: a is newest now
  assert.equal(scene.onPick, handlerA2);
  a.onPick = null;
  assert.equal(scene.onPick, handlerB);
  // Unchanged by showSelection(NO_HIGHLIGHT), which is a scene call only.
  b.showSelection(NO_HIGHLIGHT);
  assert.equal(scene.onPick, handlerB);
});

test("sketches and planes reach the one viewer; the sketch pointer follows the same newest-pane rule as picking", () => {
  const { scene, calls } = fakeScene();
  const pane = paneViewports(scene);
  const a = pane(fakeView("a", []));
  const b = pane(fakeView("b", []));
  a.showSketches([]);
  b.showPlanes([{ id: "XY", plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, offered: true }]);
  assert.deepEqual(calls, ["showSketches 0", "showPlanes XY"]);
  const handlerA = () => {};
  const handlerB = () => {};
  a.onSketchPointer = handlerA;
  b.onSketchPointer = handlerB;
  assert.equal(scene.onSketchPointer, handlerB, "the newest wins");
  b.onSketchPointer = null;
  assert.equal(scene.onSketchPointer, handlerA, "a keeps it when b hides");
  assert.equal(scene.onPick, null, "the pick handler is separate");
  a.onSketchPointer = null;
  assert.equal(scene.onSketchPointer, null);
});
