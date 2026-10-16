import { test } from "node:test";
import assert from "node:assert/strict";
import type { BodyView, Feature } from "@fission/core";
import { parameterRows, propertiesPanel } from "../src/properties.ts";

/** Each row as "label" when shown, null when hidden, in width/depth/height order. */
const rows = (shape: Parameters<typeof parameterRows>[0]) => parameterRows(shape).map((r) => (r.shown ? r.label : null));

test("each shape's size inputs and their labels", () => {
  // From what each kernel call takes: a box is width × depth × height; a
  // cylinder is a diameter and a height (no depth); a sphere only a
  // diameter; an extruded outline has width and depth for its outline and
  // a distance to extrude, so its third input is "Extrude by".
  assert.deepEqual(rows("box"), ["Width", "Depth", "Height"]);
  assert.deepEqual(rows("cylinder"), ["Diameter", null, "Height"]);
  assert.deepEqual(rows("sphere"), ["Diameter", null, null]);
  assert.deepEqual(rows("l-bracket"), ["Width", "Depth", "Extrude by"]);
});

const { Window } = await import("happy-dom");

/** A fresh panel in a real DOM (happy-dom stands in for the browser). */
function panel() {
  const doc = new Window().document as unknown as Document;
  const slot = doc.createElement("aside");
  doc.body.append(slot);
  const p = propertiesPanel(slot);
  const $ = (id: string) => slot.querySelector<HTMLElement>(`#${id}`)!;
  return { p, $ };
}

const view = (errors: string[] = []): BodyView => ({
  mesh: { positions: [], normals: [], indices: [], triangle_faces: [], edge_lines: [], edge_line_edges: [] },
  volume: 24000,
  area: 5200,
  vertices: 8,
  edges: 12,
  faces: 6,
  errors,
});

test("the panel labels and hides the size rows for the shape", () => {
  const { p, $ } = panel();
  assert.deepEqual(p.inputs.map((i) => i.id), ["width", "depth", "height"]);
  p.setShape("sphere");
  assert.equal($("width-label").textContent, "Diameter");
  assert.equal($("depth-row").hidden, true);
  assert.equal($("height-row").hidden, true);
  p.setShape("slot");
  assert.equal($("width-label").textContent, "Width");
  assert.equal($("height-label").textContent, "Extrude by");
  assert.equal($("depth-row").hidden, false);
  assert.equal($("height-row").hidden, false);
});

test("the panel shows the body's numbers, its intent and provenance", () => {
  const { p, $ } = panel();
  const feature: Feature = {
    id: "feature-1",
    intent: { type: "box", parameters: {}, summary: "Box: 40 × 30 × 20 mm" },
    provenance: { self: { workspace: "design", id: "feature-1", label: "Box" }, from: [] },
    dependsOn: [],
    suppressed: false,
  };
  p.showFeature(feature);
  assert.equal($("intent").textContent, "Box: 40 × 30 × 20 mm");
  assert.notEqual($("provenance").textContent, "…");
  // A 40 × 30 × 20 box: volume 40·30·20 = 24,000 mm³; area 2(40·30 + 40·20 + 30·20) = 5,200 mm²; 8 V, 12 E, 6 F.
  p.showError("old message");
  p.showBody(view());
  assert.equal($("volume").textContent, "24,000 mm³");
  assert.equal($("area").textContent, "5,200 mm²");
  assert.equal($("topology").textContent, "8 V · 12 E · 6 F");
  assert.equal($("status").textContent, "valid");
  assert.equal($("status").className, "ok");
  assert.equal($("error").textContent, "", "a body that built clears the last error");
  p.showBody(view(["edge 3 is off face 2"]));
  assert.equal($("status").textContent, "1 problem(s)");
  assert.equal($("status").className, "bad");
  assert.equal($("error").textContent, "edge 3 is off face 2");
});

test("stale numbers are dimmed, and said in words only when the rebuild failed", () => {
  const { p, $ } = panel();
  p.markStale(true, false);
  assert.equal($("stats").dataset.stale, "true");
  assert.equal($("stats").classList.contains("stale"), true);
  assert.equal($("stale-note").hidden, true);
  p.markStale(true, true);
  assert.equal($("stale-note").hidden, false);
  p.markStale(false, true);
  assert.equal($("stats").dataset.stale, "false");
  assert.equal($("stats").classList.contains("stale"), false);
  assert.equal($("stale-note").hidden, true);
});

test("the action note shows a warning in red and clears", () => {
  const { p, $ } = panel();
  p.showActionNote("rounded by 2 µm", true);
  assert.equal($("action-note").textContent, "rounded by 2 µm");
  assert.equal($("action-note").className, "bad");
  p.showActionNote("", false);
  assert.equal($("action-note").textContent, "");
  assert.equal($("action-note").className, "");
});

test("the selection's verbs are buttons that run their action; none hides the row", () => {
  const { p, $ } = panel();
  assert.equal($("selection-actions").hidden, true);
  const ran: string[] = [];
  p.showActions([{ id: "design.download-stl", label: "Download STL", title: "Download the body" }], (id) => ran.push(id));
  const buttons = [...$("selection-actions").querySelectorAll("button")];
  assert.equal($("selection-actions").hidden, false);
  assert.deepEqual(buttons.map((b) => [b.textContent, b.dataset.action, b.title]), [["Download STL", "design.download-stl", "Download the body"]]);
  buttons[0].click();
  assert.deepEqual(ran, ["design.download-stl"]);
  p.showActions([], () => {});
  assert.equal($("selection-actions").hidden, true);
  assert.equal($("selection-actions").childElementCount, 0);
});

test("the selection note shows what a rebuild dropped and hides when empty", () => {
  const { p, $ } = panel();
  assert.equal($("selection-note").hidden, true);
  p.showSelectionNote("Taken out of the selection: Face 1.");
  assert.equal($("selection-note").hidden, false);
  assert.equal($("selection-note").textContent, "Taken out of the selection: Face 1.");
  p.showSelectionNote("");
  assert.equal($("selection-note").hidden, true);
});
