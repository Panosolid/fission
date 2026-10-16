import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_HIGHLIGHT, SEVERITY_COLOURS } from "@fission/core";
import { BASE_COLOUR, EDGE_COLOUR, HOVER_MIX, SELECTED_MIX, SELECTION_COLOUR, faceMixes, segmentColours, tint } from "../src/highlight.ts";

const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);

test("tint moves a colour the given fraction of the way, worked by hand", () => {
  // Black towards white by 0.25 is 0.25 grey; 0 keeps, 1 replaces.
  assert.ok(near(tint([0, 0, 0], [1, 1, 1], 0.25), [0.25, 0.25, 0.25]));
  // (0.2, 0.4, 0.8) towards (1, 0, 0) by 0.5: halfway on each channel = (0.6, 0.2, 0.4).
  assert.ok(near(tint([0.2, 0.4, 0.8], [1, 0, 0], 0.5), [0.6, 0.2, 0.4]));
  assert.ok(near(tint([0.2, 0.4, 0.8], [1, 0, 0], 0), [0.2, 0.4, 0.8]));
  assert.ok(near(tint([0.2, 0.4, 0.8], [1, 0, 0], 1), [1, 0, 0]));
});

test("selected faces are tinted, the hovered one less, everything when the body is selected", () => {
  // A box: face k owns triangles 2k and 2k+1.
  const triangleFaces = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  assert.deepEqual(faceMixes(triangleFaces, NO_HIGHLIGHT, null), Array(12).fill(0));
  const S = SELECTED_MIX, H = HOVER_MIX;
  assert.deepEqual(faceMixes(triangleFaces, { body: false, faces: [1, 4], edges: [] }, 2), [0, 0, S, S, H, H, 0, 0, S, S, 0, 0]);
  // Hovering a selected face keeps it selected.
  assert.deepEqual(faceMixes(triangleFaces, { body: false, faces: [1], edges: [] }, 1).slice(2, 4), [S, S]);
  assert.deepEqual(faceMixes(triangleFaces, { body: true, faces: [], edges: [] }, 3), Array(12).fill(S));
  // An index the body does not have (a selection from before an edit) tints nothing.
  assert.deepEqual(faceMixes(triangleFaces, { body: false, faces: [9], edges: [] }, 7), Array(12).fill(0));
  assert.ok(S > H && H > 0, "selected stands out more than hovered");
});

test("selected and hovered edges are drawn in the selection colour, others black", () => {
  // Edge 4 has segments 0 and 1, edge 8 segment 2, edge 0 segment 3.
  const labels = [4, 4, 8, 0];
  const half = tint(EDGE_COLOUR, SELECTION_COLOUR, 0.5);
  assert.deepEqual(segmentColours(labels, { body: false, faces: [], edges: [4] }, 0), [SELECTION_COLOUR, SELECTION_COLOUR, EDGE_COLOUR, half]);
  // Selecting the body or a face leaves edges black.
  assert.deepEqual(segmentColours(labels, { body: true, faces: [0], edges: [] }, null), Array(4).fill(EDGE_COLOUR));
});

test("a selected face under an overlay still shows the overlay", () => {
  // Overlays stay visible: tinted warning orange differs from tinted plain grey
  // and from the selection colour itself, and keeps more red than green would.
  const plain = tint(BASE_COLOUR, SELECTION_COLOUR, SELECTED_MIX);
  const warned = tint(SEVERITY_COLOURS.warning, SELECTION_COLOUR, SELECTED_MIX);
  assert.ok(!near(plain, warned) && !near(warned, SELECTION_COLOUR));
  // Red channel: 0.96 + (0.25 − 0.96)·0.6 = 0.534, against 0.604 + (0.25 − 0.604)·0.6 ≈ 0.392 for grey.
  assert.ok(Math.abs(warned[0] - 0.534) < 1e-12 && warned[0] > plain[0]);
  // The selection colour is none of the overlay colours.
  for (const c of Object.values(SEVERITY_COLOURS)) assert.ok(!near(c, SELECTION_COLOUR));
});
