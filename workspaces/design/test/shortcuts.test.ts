import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChord, type Selected } from "@fission/core";
import { DESIGN_SHORTCUTS, designShortcut } from "../src/shortcuts.ts";

const profile: Selected = { kind: "outline", id: "outline:feature-1/profile-1" };
const face: Selected = { kind: "face", id: "face:feature-1/1" };

test("Design's keys: Escape clears (also in a size field), Copy is Mod+C and only in the page", () => {
  assert.deepEqual(DESIGN_SHORTCUTS.map((s) => [s.id, parseChord(s.keys), s.inText ?? false]), [
    ["clear-selection", "Escape", true],
    ["copy-svg", "Mod+C", false],
  ]);
});

test("hand-worked: Copy runs Copy as SVG only with exactly one profile selected; otherwise the browser copies", () => {
  assert.equal(designShortcut("copy-svg", [profile]), "copy");
  assert.equal(designShortcut("copy-svg", []), null, "nothing selected");
  assert.equal(designShortcut("copy-svg", [face]), null, "a face has no SVG");
  assert.equal(designShortcut("copy-svg", [profile, profile]), null, "two profiles: which one?");
  assert.equal(designShortcut("clear-selection", []), "clear", "Escape with nothing selected is harmless");
  assert.equal(designShortcut("clear-selection", [face]), "clear");
  assert.equal(designShortcut("unknown", [profile]), null);
});
