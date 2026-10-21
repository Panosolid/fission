// @ts-nocheck
// Step 26c: sketches on a body's flat face, the parts the kernel isn't
// needed for: the frame maths (face-sketch.ts), the data and its checks
// when a file is opened (document.ts), adding one (sketch.ts addFaceSketch),
// Flip (extrude.ts) and what builds while a face's feature is off. Design
// against the naming model on the real kernel is
// packages/testing/journeys/naming.journey.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyProject, projectFromJson, projectToJson, type BodyView, type Plane } from "@fission/core";
import { buildingItems, builds, greyedBy, greyedItems, partDocument, readDesignDocument, type DesignDocument } from "../src/document.ts";
import { drawnFrame, drawnOnFace, faceFeature, frameNow, frameOf, isFacePlane, isFaceSketch, planeWords, squared, turned, type SketchPlacement } from "../src/face-sketch.ts";
import { addFaceSketch, addSketch, drawCircle, sketchPlane } from "../src/sketch.ts";
import { sketchDrawings } from "../src/sketch-tool.ts";
import { extrudeSketch, isFlipped, setExtrudeFlip } from "../src/extrude.ts";
import { deleteItem, moveMarker, reorderItem, suppressItem } from "../src/timeline-edits.ts";
import { itemMenu, timelineBarItems } from "../src/timeline-bar.ts";

const DESIGN = [{ id: "design" as const, readData: readDesignDocument }];
const S = Math.SQRT1_2;

/** Close to 1e-12 in every coordinate (the hand-worked values have square roots in them). */
function near(got: readonly number[], want: readonly number[], what = "") {
  assert.equal(got.length, want.length, what);
  for (const [k, x] of got.entries()) assert.ok(Math.abs(x - want[k]) <= 1e-12, `${what} [${got}] want [${want}]`);
}
function nearPlane(got: Plane, want: Plane, what = "") {
  near(got.origin, want.origin, `${what} origin`);
  near(got.xAxis, want.xAxis, `${what} x`);
  near(got.normal, want.normal, `${what} normal`);
}
const plane = (origin: number[], xAxis: number[], normal: number[]): Plane => ({ origin: origin as Plane["origin"], xAxis: xAxis as Plane["xAxis"], normal: normal as Plane["normal"] });

test("hand-worked: turned is the shortest rotation taking one direction to another", () => {
  // z onto x is a quarter turn about y (z × x = y), so y stays and x goes
  // to −z (a quarter turn about y takes (1, 0, 0) to (cos 90°, 0, −sin 90°)).
  near(turned([0, 1, 0], [0, 0, 1], [1, 0, 0]), [0, 1, 0]);
  near(turned([1, 0, 0], [0, 0, 1], [1, 0, 0]), [0, 0, -1]);
  // −y onto (−0.6, −0.8, 0): from −90° to −126.87° about z, a turn of
  // −36.87° (cos 0.8, sin −0.6), which takes x to (0.8, −0.6, 0).
  near(turned([1, 0, 0], [0, -1, 0], [-0.6, -0.8, 0]), [0.8, -0.6, 0]);
  // No turn at all leaves everything as it is.
  near(turned([0.3, 0.4, 1.2], [0, 0, 1], [0, 0, 1]), [0.3, 0.4, 1.2]);
});

test("hand-worked: squared makes the axes unit and square, and finds no frame in a nothing normal or an x along it", () => {
  // Normal (0, 0, 2) is z; x (2, 0, 1) less its part along z is (2, 0, 0), so x.
  const p = squared(plane([1, 2, 3], [2, 0, 1], [0, 0, 2]))!;
  nearPlane(p, plane([1, 2, 3], [1, 0, 0], [0, 0, 1]));
  // −0 is written as 0, so a frame read back from a file is equal to it.
  assert.ok(Object.is(squared(plane([-0, 0, 0], [1, 0, 0], [0, 0, 1]))!.origin[0], 0));
  assert.equal(squared(plane([0, 0, 0], [1, 0, 0], [0, 0, 0])), null);
  assert.equal(squared(plane([0, 0, 0], [0, 0, 3], [0, 0, 1])), null);
  assert.equal(squared(plane([0, 0, 0], [1, 0, 0], [0, 0, Number.NaN])), null);
  assert.equal(squared(plane([0, 0, 0], [1, 0, 0], [0, 0, Number.POSITIVE_INFINITY])), null);
});

test("hunt 26g: squared refuses a normal too long to square, and writes every −0 of the origin as 0", () => {
  // (1e200, 0, 0) · itself is 1e400, past the largest double, so Infinity: made unit it would come out (0, 0, 0), no
  // normal at all, so no frame.
  assert.equal(squared(plane([0, 0, 0], [0, 1, 0], [1e200, 0, 0])), null);
  const p = squared(plane([-0, -0, -0], [1, 0, 0], [0, 0, 1]))!;
  assert.ok(p.origin.every((x) => Object.is(x, 0)), `[${p.origin.map((x) => (Object.is(x, -0) ? "-0" : x))}]`);
});

test("hunt 26g: face planes and face sketches told apart, a broken escape names no feature, a frame for the kernel, the plane warnings' words", () => {
  assert.equal(isFacePlane("face:feature-1/top"), true);
  for (const p of [undefined, null, 7, "XY", "edge:feature-1/a+b"]) assert.equal(isFacePlane(p), false, String(p));
  const item = (type: string) => ({ id: "x", intent: { type, parameters: { plane: "face:feature-1/top" } } }) as never;
  assert.equal(isFaceSketch(item("sketch")), true);
  assert.equal(isFaceSketch(item("extrude")), false, "only a sketch is a face sketch");
  assert.equal(faceFeature("face:%E0%A4%A/top"), null, "%E0%A4%A is no escape decodeURIComponent reads");
  const f = plane([1, 2, 3], [0, 1, 0], [1, 0, 0]);
  const k = frameOf(f);
  assert.deepEqual(k, { origin: [1, 2, 3], x: [0, 1, 0], normal: [1, 0, 0] });
  assert.ok(k.origin !== f.origin && k.x !== f.xAxis && k.normal !== f.normal, "copies, so the kernel's frame can't change the sketch's");
  assert.equal(planeWords("plane-lost", "Sketch 2"), "Sketch 2's face is gone, so its plane is lost: it stays where it was");
  assert.equal(planeWords("plane-ambiguous", "Sketch 2"), "Sketch 2's face is now more than one face, so its plane is ambiguous: it stays where it was rather than guess");
});

test("hand-worked: the frame drawn on each face of a box keeps the world's coordinates (Q2)", () => {
  // A 40 × 30 × 20 box from the origin. Top: XY (|z · z| = 1), facing
  // along it; origin where the world's origin meets z = 20 square on.
  const top = drawnFrame([0, 0, 1], [20, 15, 20]);
  assert.equal(top.side, 1);
  nearPlane(top.plane, plane([0, 0, 20], [1, 0, 0], [0, 0, 1]), "top");
  // Bottom: still XY's frame (normal up, x along x), but the face looks
  // down, against it: side −1.
  const bottom = drawnFrame([0, 0, -1], [20, 15, -5]);
  assert.equal(bottom.side, -1);
  nearPlane(bottom.plane, plane([0, 0, -5], [1, 0, 0], [0, 0, 1]), "bottom");
  // Front (y = −3, looking −y): XZ's normal is −y, so XZ facing along it;
  // the origin is (0, −3, 0).
  const front = drawnFrame([0, -1, 0], [20, -3, 10]);
  assert.equal(front.side, 1);
  nearPlane(front.plane, plane([0, -3, 0], [1, 0, 0], [0, -1, 0]), "front");
  // Back (y = 30, looking +y): XZ's frame, side −1, origin (0, 30, 0).
  const back = drawnFrame([0, 1, 0], [20, 30, 10]);
  assert.equal(back.side, -1);
  nearPlane(back.plane, plane([0, 30, 0], [1, 0, 0], [0, -1, 0]), "back");
  // Right (x = 40, looking +x): YZ, x along world y, origin (40, 0, 0).
  const right = drawnFrame([1, 0, 0], [40, 15, 10]);
  assert.equal(right.side, 1);
  nearPlane(right.plane, plane([40, 0, 0], [0, 1, 0], [1, 0, 0]), "right");
});

test("hand-worked: a slanted face takes the nearest origin plane, turned onto it the shortest way, and ties go XY, XZ, YZ", () => {
  // A 3-4-5 slant looking (0.6, 0.8, 0): |· z| = 0, |· −y| = 0.8, |· x| =
  // 0.6, so XZ; it looks against XZ's −y, so side −1 and the normal is
  // (−0.6, −0.8, 0). x is turned as −y turns onto it: (0.8, −0.6, 0)
  // (the turned test above). The face passes (6, 8, 5): n · p = −10, so
  // the origin is −10 n = (6, 8, 0).
  const slant = drawnFrame([0.6, 0.8, 0], [6, 8, 5]);
  assert.equal(slant.side, -1);
  nearPlane(slant.plane, plane([6, 8, 0], [0.8, -0.6, 0], [-0.6, -0.8, 0]), "3-4-5");
  // Halfway between XZ and YZ, looking (1, −1, 0)/√2: a tie, so XZ, the
  // first; it looks along −y's side (+1/√2), so side 1. −y turned to it
  // is +45° about z, taking x to (1, 1, 0)/√2.
  const xzyz = drawnFrame([S, -S, 0], [0, 0, 0]);
  assert.equal(xzyz.side, 1);
  nearPlane(xzyz.plane, plane([0, 0, 0], [S, S, 0], [S, -S, 0]), "XZ/YZ tie");
  // Halfway between XY and XZ, looking (0, −1, 1)/√2: a tie, so XY. z
  // turned to it is about x (z × n = (1/√2, 0, 0)), so x stays.
  const xyxz = drawnFrame([0, -S, S], [0, 0, 0]);
  assert.equal(xyxz.side, 1);
  nearPlane(xyxz.plane, plane([0, 0, 0], [1, 0, 0], [0, -S, S]), "XY/XZ tie");
});

test("a curved face has no frame (Q5), and every drawn frame is unit and square within a few ulps (the kernel refuses 64)", () => {
  const view = { face_normals: [null, [0, 0, 1]], face_centroids: [[1, 2, 3], [0, 0, 7]] } as unknown as BodyView;
  assert.equal(drawnOnFace(view, 0), null);
  nearPlane(drawnOnFace(view, 1)!.plane, plane([0, 0, 7], [1, 0, 0], [0, 0, 1]));
  // Seeded: 2,000 normals all round the sphere, at points up to a metre out.
  let seed = 26;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const ULP = Number.EPSILON;
  for (let i = 0; i < 2000; i++) {
    const v = [rand(), rand(), rand()];
    const len = Math.hypot(...v);
    if (len < 1e-3) continue;
    const out = v.map((x) => x / len);
    const { plane: p } = drawnFrame(out, [rand() * 1e6, rand() * 1e6, rand() * 1e6]);
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(p.normal, p.normal) - 1) <= 8 * ULP, `normal ${p.normal}`);
    assert.ok(Math.abs(dot(p.xAxis, p.xAxis) - 1) <= 8 * ULP, `x ${p.xAxis}`);
    assert.ok(Math.abs(dot(p.xAxis, p.normal)) <= 8 * ULP, `x · n ${dot(p.xAxis, p.normal)}`);
  }
});

test("hand-worked: frameNow turns the frame as drawn with its face, keeping the side its normal was on (rule 8)", () => {
  const front = plane([0, 0, 0], [1, 0, 0], [0, -1, 0]);
  // The front turned to look (1, −4, 0)/√17 (a corner moved, Q2): still on
  // −y's side, so the normal is it; −y to it is a turn of atan(1/4) about
  // z, taking x to (4, 1, 0)/√17. Through (40, 0, 0): n · p = 40/√17, so
  // the origin is (40, −160, 0)/17.
  const r17 = Math.sqrt(17);
  nearPlane(frameNow(front, [1 / r17, -4 / r17, 0], [40, 0, 0]), plane([40 / 17, -160 / 17, 0], [4 / r17, 1 / r17, 0], [1 / r17, -4 / r17, 0]), "turned");
  // Turned past a right angle, to look (0.6, 0.8, 0): the drawn normal is
  // on its far side (−0.8), so the normal is −(0.6, 0.8, 0), and x turns
  // with −y to it: (0.8, −0.6, 0).
  nearPlane(frameNow(front, [0.6, 0.8, 0], [0, 0, 0]), plane([0, 0, 0], [0.8, -0.6, 0], [-0.6, -0.8, 0]), "past square");
  // Exactly square (· = 0) keeps the face's own normal (the model's tie):
  // −y to x is a quarter turn about z, taking x to y.
  nearPlane(frameNow(front, [1, 0, 0], [5, 0, 0]), plane([5, 0, 0], [0, 1, 0], [1, 0, 0]), "square");
  // A back face's frame (normal −y, side −1) with the face still looking +y stays as it was.
  nearPlane(frameNow(plane([0, 30, 0], [1, 0, 0], [0, -1, 0]), [0, 1, 0], [3, 30, 4]), plane([0, 30, 0], [1, 0, 0], [0, -1, 0]), "back");
});

/** A 40 × 30 × 20 box (feature-1) with Sketch 1 (sketch-2) on its top: a circle of radius 5 at (20, 15), extruded 10 (feature-5: its circle took point-3 and circle-4). */
function onTop(): { doc: DesignDocument; sketch: string; extrude: string } {
  const top: SketchPlacement = drawnFrame([0, 0, 1], [20, 15, 20]);
  const s = addFaceSketch(partDocument("box", 40, 30, 20), { plane: "face:feature-1/top", feature: "feature-1" }, top);
  const circle = drawCircle(s.doc, s.id, [20, 15], 5).doc;
  const e = extrudeSketch(circle, s.id, 10);
  return { doc: e.doc, sketch: s.id, extrude: e.id };
}

test("addFaceSketch puts a sketch on a solid item's face, depending on it, with the frame as drawn squared and its side", () => {
  const { doc, sketch } = onTop();
  const item = doc.timeline.features.find((f) => f.id === sketch)!;
  assert.equal(item.intent.summary, "Sketch 1 on a face of Feature 1 (box)");
  assert.deepEqual(item.intent.parameters, { plane: "face:feature-1/top" });
  assert.deepEqual(item.dependsOn, ["feature-1"]);
  assert.deepEqual(item.provenance.from, [{ workspace: "design", id: "feature-1", label: "Feature 1 (box)" }]);
  const content = doc.sketches.find((s) => s.id === sketch)!;
  assert.deepEqual(content.face, { frame: { origin: [0, 0, 20], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 1 });
  // A frame drawn a little off is squared before it is kept: (2, 0, 0.5)
  // less its part along z is x.
  const off = addFaceSketch(partDocument("box", 40, 30, 20), { plane: "face:feature-1/top", feature: "feature-1" }, { plane: plane([0, 0, 20], [2, 0, 0.5], [0, 0, 3]), side: -1 });
  assert.deepEqual(off.doc.sketches.at(-1)!.face, { frame: { origin: [0, 0, 20], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: -1 });
  assert.equal(faceFeature("face:feature-1/side:line-4"), "feature-1");
  assert.equal(faceFeature("face:"), null);
});

test("addFaceSketch refuses a face it can't put a sketch on, each with its reason", () => {
  const box = partDocument("box", 40, 30, 20);
  const top = drawnFrame([0, 0, 1], [20, 15, 20]);
  assert.throws(() => addFaceSketch(box, { plane: "XY", feature: "feature-1" }, top), /XY is not a face of feature-1/);
  assert.throws(() => addFaceSketch(box, { plane: "face:feature-1/top", feature: "feature-9" }, top), /is not a face of feature-9/);
  assert.throws(() => addFaceSketch(box, { plane: "face:feature-9/end", feature: "feature-9" }, top), /there is no solid item feature-9 to sketch on/);
  const { doc, sketch } = onTop();
  assert.throws(() => addFaceSketch(doc, { plane: `face:${sketch}/end`, feature: sketch }, top), /there is no solid item sketch-2 to sketch on/);
  assert.throws(() => addFaceSketch(moveMarker(box, "start"), { plane: "face:feature-1/top", feature: "feature-1" }, top), /Feature 1 \(box\) comes after the rollback marker/);
  assert.throws(() => addFaceSketch(box, { plane: "face:feature-1/top", feature: "feature-1" }, { plane: plane([0, 0, 0], [0, 0, 1], [0, 0, 1]), side: 1 }), /needs a frame and a side/);
  assert.throws(() => addFaceSketch(box, { plane: "face:feature-1/top", feature: "feature-1" }, { plane: top.plane, side: 0 as 1 }), /needs a frame and a side/);
});

test("Flip is kept as flip: true and only then, says so in the summary, and changes nothing when already so", () => {
  const { doc, extrude } = onTop();
  const item = (d: DesignDocument) => d.timeline.features.find((f) => f.id === extrude)!;
  assert.equal(isFlipped(item(doc)), false);
  const flipped = setExtrudeFlip(doc, true, extrude);
  assert.equal(item(flipped).intent.parameters.flip, true);
  assert.equal(item(flipped).intent.summary, "Extrude Sketch 1 by 10 mm, flipped");
  assert.equal(setExtrudeFlip(flipped, true, extrude), flipped);
  const back = setExtrudeFlip(flipped, false, extrude);
  assert.equal(Object.hasOwn(item(back).intent.parameters, "flip"), false);
  assert.equal(item(back).intent.summary, "Extrude Sketch 1 by 10 mm");
  assert.equal(setExtrudeFlip(doc, false, extrude), doc);
  assert.throws(() => setExtrudeFlip(doc, true, "feature-1"), /Box: 40 × 30 × 20 mm is not an extrude of a sketch/);
  assert.throws(() => setExtrudeFlip(doc, true, "feature-99"), /there is no feature feature-99/);
  assert.throws(() => setExtrudeFlip(doc, "yes" as unknown as boolean, extrude), /needs true or false, not yes/);
  // Drawn flipped from the start.
  const s = addSketch(partDocument("box", 1, 1, 1));
  const e = extrudeSketch(drawCircle(s.doc, s.id, [0, 0], 1).doc, s.id, 4, true);
  assert.equal(e.doc.timeline.features.at(-1)!.intent.summary, "Extrude Sketch 1 by 4 mm, flipped");
  assert.equal(e.doc.timeline.features.at(-1)!.intent.parameters.flip, true);
});

test("a sketch on a face greys with its face's feature while it is off (Q3), and stays built when that feature is gone (Q1)", () => {
  const { doc, sketch, extrude } = onTop();
  const at = (d: DesignDocument, id: string) => d.timeline.features.find((f) => f.id === id)!;
  const agree = (d: DesignDocument) => {
    const set = buildingItems(d);
    for (const f of d.timeline.features) assert.equal(set.has(f), builds(d, f), `${f.id}: buildingItems and builds disagree`);
    return set;
  };
  let set = agree(doc);
  assert.ok(set.has(at(doc, sketch)) && set.has(at(doc, extrude)));
  const off = suppressItem(doc, "feature-1", true);
  set = agree(off);
  assert.ok(!set.has(at(off, sketch)) && !set.has(at(off, extrude)), "greyed with the box");
  // The box gone (as a file can have it): the sketch is held, so it and its extrude build.
  const gone = { ...doc, timeline: { ...doc.timeline, features: doc.timeline.features.filter((f) => f.id !== "feature-1") } };
  set = agree(gone);
  assert.ok(set.has(at(gone, sketch)) && set.has(at(gone, extrude)));
  // An XY sketch's extrude is untouched by a box being off (no face, no grey).
  const s = addSketch(doc);
  const e = extrudeSketch(drawCircle(s.doc, s.id, [0, 0], 1).doc, s.id, 4);
  const xyOff = suppressItem(e.doc, "feature-1", true);
  assert.ok(agree(xyOff).has(at(xyOff, e.id)));
});

/** The onTop design written to a file and opened again, after `edit`. */
function opened(edit: (d: any) => void = () => {}) {
  const f = JSON.parse(projectToJson({ ...emptyProject(), workspaces: { design: onTop().doc } }));
  edit(f.workspaces.design);
  return () => projectFromJson(JSON.stringify(f), DESIGN).workspaces.design as DesignDocument;
}

test("a sketch on a face is written to a file and read back exactly", () => {
  assert.deepEqual(opened()(), onTop().doc);
  // Held, flipped and kept with a placement: all read back.
  const held = { origin: [0, 0, 20], xAxis: [1, 0, 0], normal: [0, 0, 1] };
  const kept = { points: [], curves: [], placement: { plane: { origin: [0, -3, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] }, side: -1 } };
  const doc = opened((d) => {
    d.sketches[0].face.held = held;
    d.timeline.features[2].intent.parameters.flip = true;
    d.kept = { "feature-5": kept };
  })();
  assert.deepEqual(doc.sketches[0].face!.held, held);
  assert.equal(doc.timeline.features[2].intent.parameters.flip, true);
  assert.deepEqual(doc.kept!["feature-5"], kept);
  // Its box deleted: the sketch stays, held with its plane lost (Q1), so the file opens.
  assert.doesNotThrow(opened((d) => (d.timeline.features = d.timeline.features.slice(1))));
});

test("a file's sketch on a face is checked when it is opened: each way it can be broken is refused with its reason", () => {
  const n = (x: unknown) => [x, 0, 0];
  const cases: [string, (d: any) => void, RegExp][] = [
    ["not a face's name", (d) => (d.timeline.features[1].intent.parameters.plane = "face:"), /is on face:, which is not a face's name this Panosolid makes/],
    ["no frame", (d) => delete d.sketches[0].face, /is on a face but has no frame it was drawn with/],
    ["frame not an object", (d) => (d.sketches[0].face.frame = "up"), /sketch-2's frame needs an origin, an xAxis and a normal, each three numbers/],
    ["origin of two numbers", (d) => (d.sketches[0].face.frame.origin = [0, 0]), /sketch-2's frame needs an origin/],
    ["a normal that is text", (d) => (d.sketches[0].face.frame.normal = n("1")), /sketch-2's frame needs an origin/],
    ["a nothing normal", (d) => (d.sketches[0].face.frame.normal = [0, 0, 0]), /sketch-2's frame has no frame: its normal is nothing or its xAxis lies along it/],
    ["x along the normal", (d) => (d.sketches[0].face.frame.xAxis = [0, 0, 5]), /sketch-2's frame has no frame/],
    ["side 0", (d) => (d.sketches[0].face.side = 0), /sketch-2's side must be 1 or -1, not 0/],
    ["side missing", (d) => delete d.sketches[0].face.side, /sketch-2's side must be 1 or -1/],
    ["a held plane with no frame", (d) => (d.sketches[0].face.held = { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 0] }), /sketch-2's held plane has no frame/],
    ["a held plane of null", (d) => (d.sketches[0].face.held = null), /sketch-2's held plane needs an origin/],
    ["on a sketch's face", (d) => {
      d.timeline.features[1].intent.parameters.plane = "face:sketch-2/end";
      d.timeline.features[1].dependsOn = ["sketch-2"];
    }, /is on a face of sketch-2, which is not a solid item before it/],
    ["on a later item's face", (d) => {
      d.timeline.features[1].intent.parameters.plane = "face:feature-5/end";
      d.timeline.features[1].dependsOn = ["feature-5"];
    }, /is on a face of feature-5, which is not a solid item before it/],
    ["not depending on its face's feature", (d) => (d.timeline.features[1].dependsOn = []), /is on a face of feature-1 but does not depend on it/],
    ["an XY sketch keeping a face's frame", (d) => (d.timeline.features[1].intent.parameters.plane = "XY"), /sketch-2 is on the XY plane but keeps a face's frame/],
    ["a plane no one knows", (d) => {
      d.timeline.features[1].intent.parameters.plane = "XW";
      delete d.sketches[0].face;
    }, /is on XW, not a plane this Panosolid knows \(XY, XZ, YZ or a face\)/],
    ["flip false", (d) => (d.timeline.features[2].intent.parameters.flip = false), /feature-5: flip must be true or left out, not false/],
    ["flip as text", (d) => (d.timeline.features[2].intent.parameters.flip = "true"), /flip must be true or left out, not true/],
    ["a kept placement that is text", (d) => (d.kept = { "feature-5": { points: [], curves: [], placement: "XZ" } }), /kept shape's placement is not an object/],
    ["a kept placement with no frame", (d) => (d.kept = { "feature-5": { points: [], curves: [], placement: { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 0] }, side: 1 } } }), /kept shape's placement's plane has no frame/],
    ["a kept placement with side 2", (d) => (d.kept = { "feature-5": { points: [], curves: [], placement: { plane: { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1] }, side: 2 } } }), /kept shape's placement's side must be 1 or -1, not 2/],
  ];
  for (const [what, edit, error] of cases) assert.throws(opened(edit), error, what);
});

test("a sketch on a face is drawn where the last rebuild placed it, else where it is held, else where it was drawn", () => {
  const { doc, sketch } = onTop();
  const drawn = plane([0, 0, 20], [1, 0, 0], [0, 0, 1]);
  const held = plane([0, 0, 35], [1, 0, 0], [0, 0, 1]);
  const placed = plane([0, 0, 50], [0, 1, 0], [0, 0, 1]);
  assert.deepEqual(sketchPlane(doc, sketch), drawn);
  assert.deepEqual(sketchDrawings(doc, null)[0].plane, drawn);
  const holding: DesignDocument = { ...doc, sketches: doc.sketches.map((s) => ({ ...s, face: { ...s.face!, held } })) };
  assert.deepEqual(sketchPlane(holding, sketch), held);
  const at = new Map([[sketch, placed]]);
  assert.deepEqual(sketchPlane(holding, sketch, at), placed);
  assert.deepEqual(sketchDrawings(holding, null, at)[0].plane, placed);
  // An origin plane's sketch is on that plane whatever a rebuild said.
  const xz = addSketch(doc, "XZ");
  assert.deepEqual(sketchPlane(xz.doc, xz.id, new Map([[xz.id, placed]])), { origin: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, -1, 0] });
});

test("26e: suppressing the box greys a chain built on its face, each naming the box; the bar, Edit Sketch and the drawings follow (Q3)", () => {
  // Box (feature-1), Sketch 1 on its top (sketch-2), Extrude 2 of it (feature-5),
  // Sketch on Extrude 2's end (sketch-6), Extrude of that (feature-9).
  const one = onTop();
  const end = addFaceSketch(one.doc, { plane: `face:${one.extrude}/end`, feature: one.extrude }, drawnFrame([0, 0, 1], [20, 15, 30]));
  const two = extrudeSketch(drawCircle(end.doc, end.id, [20, 15], 2).doc, end.id, 4);
  const doc = two.doc;
  const item = (d: DesignDocument, id: string) => d.timeline.features.find((f) => f.id === id)!;
  const chain = [one.sketch, one.extrude, end.id, two.id];
  for (const id of chain) assert.equal(greyedBy(doc, item(doc, id)), null, `${id} with nothing off`);
  const off = suppressItem(doc, "feature-1", true);
  // Every link names the root, the box, not the item just below it.
  for (const id of chain) assert.equal(greyedBy(off, item(off, id)), "feature-1", id);
  assert.deepEqual([...greyedItems(off)].map(([f, by]) => [f.id, by]), chain.map((id) => [id, "feature-1"]));
  for (const id of chain) assert.equal(builds(off, item(off, id)), false, id);
  // The bar greys them (the box's name on each), with no warning (Q3).
  const bar = timelineBarItems(off).items;
  assert.deepEqual(bar.map((b) => [b.greyed, b.warning]), [[null, null], ...chain.map(() => ["Feature 1 (box)", null])]);
  // A greyed sketch can't be opened, and says why.
  const edit = (d: DesignDocument, id: string) => itemMenu(d, id).find((e) => e.action === "edit-sketch")!.off;
  assert.equal(edit(off, end.id), `${itemName(item(off, end.id))} is greyed: Feature 1 (box) is suppressed, unsuppress it first`);
  assert.equal(edit(doc, end.id), null);
  // Off sketches are not drawn: both are, until the box is off; the one being edited always is.
  assert.equal(sketchDrawings(doc, null).length, 2);
  assert.equal(sketchDrawings(off, null).length, 0);
  // Suppressing the middle extrude greys only what is above it, by it.
  const mid = suppressItem(doc, one.extrude, true);
  assert.deepEqual([...greyedItems(mid)].map(([f, by]) => [f.id, by]), [[end.id, one.extrude], [two.id, one.extrude]]);
  assert.equal(sketchDrawings(mid, null).length, 1);
  // The box gone instead: the face sketch is held (built), nothing greyed.
  const gone = deleteItem(doc, "feature-1");
  assert.equal(greyedItems(gone).size, 0);
  for (const id of chain) assert.equal(builds(gone, item(gone, id)), true, id);
});

const itemName = (f: { provenance: { self: { label: string } } }) => f.provenance.self.label;

test("26e: a sketch lost its plane is drawn red; one not lost, or being edited, is not", () => {
  const { doc, sketch } = onTop();
  assert.equal(sketchDrawings(doc, null)[0].lost, undefined);
  assert.equal(sketchDrawings(doc, null, undefined, new Set([sketch]))[0].lost, true);
  assert.equal(sketchDrawings(doc, null, undefined, new Set(["sketch-99"]))[0].lost, undefined);
});

test("26e: a sketch can't go before the feature whose face it is drawn on, nor that feature after it, in words (answer 7)", () => {
  const { doc, sketch } = onTop();
  // Box (feature-1) first, Sketch 1 (sketch-2) second, Extrude (feature-5) third.
  assert.deepEqual(reorderItem(doc, sketch, 0), { refused: "before-dependency", message: "Sketch 1 can't go before Feature 1 (box): it is drawn on a face of Feature 1 (box)" });
  assert.deepEqual(reorderItem(doc, "feature-1", 1), { refused: "after-dependent", message: "Feature 1 (box) can't go after Sketch 1: Sketch 1 is drawn on a face of it" });
  // An extrude's words stay "built from".
  assert.deepEqual(reorderItem(doc, "feature-5", 1), { refused: "before-dependency", message: "Extrude 1 can't go before Sketch 1: it is built from Sketch 1" });
});
