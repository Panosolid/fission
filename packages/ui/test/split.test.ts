import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSplit, splitChoices, SPLIT_MIN_WIDTH_PX } from "../src/split.ts";

const ws = [
  { id: "design", title: "Design" },
  { id: "render", title: "Render" },
  { id: "slice", title: "Slice" },
];

test("the second pane offers every workspace but the one already shown, in switcher order", () => {
  assert.deepEqual(splitChoices(ws, "design").map((e) => e.id), ["render", "slice"]);
  assert.deepEqual(splitChoices(ws, "render").map((e) => e.id), ["design", "slice"]);
  // Community is not a workspace: all three can go beside it.
  assert.deepEqual(splitChoices(ws, null).map((e) => e.id), ["design", "render", "slice"]);
  // Never the shown one, whichever it is.
  for (const shown of ws) assert.ok(!splitChoices(ws, shown.id).some((e) => e.id === shown.id));
});

test("Split opens on the first workspace offered: Render beside Design, Design beside Render", () => {
  assert.equal(defaultSplit(ws, "design")?.id, "render");
  assert.equal(defaultSplit(ws, "render")?.id, "design");
  assert.equal(defaultSplit([ws[0]], "design"), undefined, "nothing to split with");
});

test("Split opens on the first working workspace, passing over placeholders", () => {
  // Switcher order Design, Render (placeholder), Slice (placeholder), Image:
  // beside Design the offer is Render, Slice, Image, and Image is the first that works.
  const real = [
    { id: "design", title: "Design" },
    { id: "render", title: "Render", placeholder: true },
    { id: "slice", title: "Slice", placeholder: true },
    { id: "image", title: "Image" },
  ];
  assert.equal(defaultSplit(real, "design")?.id, "image");
  assert.equal(defaultSplit(real, "image")?.id, "design");
  assert.equal(defaultSplit(real, "render")?.id, "design");
  // Only placeholders left beside it: the first of them, never nothing.
  assert.equal(defaultSplit(real.slice(0, 3), "design")?.id, "render");
});

test("the split width leaves each viewport room beside two 240 px panel columns", () => {
  // 900 px − 2 × 240 px of panels = 420 px, so each of the two viewports gets 210 px, the least we allow.
  assert.equal((SPLIT_MIN_WIDTH_PX - 2 * 240) / 2, 210);
});
