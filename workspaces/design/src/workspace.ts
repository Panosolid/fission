// The Design workspace: the CAD, and the source of truth for all geometry.
// Until the sketcher (steps 21–31) it builds primitives and ready-made
// outlines; every other workspace will refer to its bodies, faces and edges.

import { describeProvenance, latestOnly, type Framing, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";
import { formatQuantity as fmt } from "@fission/ui";
import { needsRefit } from "@fission/viewport";
import { lastFeature, partDocument, specOf, type DesignDocument } from "./document.ts";
import type { ShapeKind } from "./profiles.ts";
import { buildSpec } from "./spec.ts";

const PANEL = `
  <label>Shape
    <select id="shape">
      <option value="box">Box</option>
      <option value="cylinder">Cylinder</option>
      <option value="sphere">Sphere</option>
      <option value="l-bracket">L-bracket (extruded)</option>
      <option value="plate">Plate with two round holes (extruded)</option>
      <option value="slot">Slot with round ends (extruded)</option>
      <option value="star">Star (extruded)</option>
    </select>
  </label>
  <label><span id="width-label">Width</span> <input id="width" type="number" value="40" step="any" /> mm</label>
  <label id="depth-row">Depth <input id="depth" type="number" value="30" step="any" /> mm</label>
  <label id="height-row"><span id="height-label">Height</span> <input id="height" type="number" value="20" step="any" /> mm</label>
  <dl id="properties">
    <dt>Feature</dt><dd id="intent">…</dd>
    <dt>Made from</dt><dd id="provenance">…</dd>
  </dl>
  <dl id="stats">
    <dt>Volume</dt><dd id="volume">…</dd>
    <dt>Area</dt><dd id="area">…</dd>
    <dt>Topology</dt><dd id="topology">…</dd>
    <dt>Validation</dt><dd id="status">…</dd>
  </dl>
  <p id="error"></p>
  <button id="download-stl" type="button">Download STL</button>
  <p id="stl-note"></p>`;

/** Hands `bytes` to the browser as a file download. */
function download(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What the user last entered, kept while other workspaces are shown. */
let saved: { shape: string; sizes: string[] } | null = null;
let framed: Framing | null = null;
let framedKind: ShapeKind | null = null;

function mount(ctx: WorkspaceContext): () => void {
  ctx.panel.innerHTML = PANEL;
  const $ = <T extends HTMLElement>(id: string) => ctx.panel.querySelector<T>(`#${id}`)!;
  const inputs = ["width", "depth", "height"].map((id) => $<HTMLInputElement>(id));
  const shape = $<HTMLSelectElement>("shape");
  if (saved) {
    shape.value = saved.shape;
    inputs.forEach((input, i) => (input.value = saved!.sizes[i]));
  }
  const { kernel, viewport } = ctx;
  let shown = true;

  // The body is built from the part's feature intent (document.ts).
  const build = latestOnly((doc: DesignDocument) => buildSpec(kernel, specOf(doc, lastFeature(doc))));

  async function update() {
    const [w, d, h] = inputs.map((i) => Number(i.value));
    const kind = shape.value as ShapeKind;
    saved = { shape: shape.value, sizes: inputs.map((i) => i.value) };
    const primitive = kind === "box" || kind === "cylinder" || kind === "sphere";
    $("height-label").textContent = primitive ? "Height" : "Extrude by";
    const round = kind === "cylinder" || kind === "sphere";
    $("width-label").textContent = round ? "Diameter" : "Width";
    $("depth-row").hidden = round;
    $("height-row").hidden = kind === "sphere";
    // The panel edits feature #1 of the one-step timeline; the project holds it.
    const doc = partDocument(kind, w, d, h);
    ctx.project.workspaces.design = doc;
    const feature = lastFeature(doc);
    $("intent").textContent = feature.intent.summary;
    $("provenance").textContent = describeProvenance(feature.provenance);
    try {
      const { current, value: view } = await build(doc);
      if (!current || !shown) return;
      viewport.showBody(view.mesh);
      // A different shape is a new part: frame it.
      if (kind !== framedKind || needsRefit(framed, viewport.bodyFraming())) {
        framed = viewport.fit();
        framedKind = kind;
        viewport.element.dataset.framedRadius = String(framed?.radius); // read by the e2e test
      }
      $("volume").textContent = `${fmt(view.volume)} mm³`;
      $("area").textContent = `${fmt(view.area)} mm²`;
      $("topology").textContent = `${view.vertices} V · ${view.edges} E · ${view.faces} F`;
      const status = $("status");
      status.textContent = view.errors.length === 0 ? "valid" : `${view.errors.length} problem(s)`;
      status.className = view.errors.length === 0 ? "ok" : "bad";
      $("error").textContent = view.errors.join("\n");
      viewport.element.dataset.shape = kind; // read by the e2e test: what is on screen
    } catch (e) {
      if (shown) $("error").textContent = e instanceof Error ? e.message : String(e);
    }
  }

  async function exportStl() {
    const [w, d, h] = inputs.map((i) => Number(i.value));
    const kind = shape.value as ShapeKind;
    const note = $("stl-note");
    try {
      const doc = partDocument(kind, w, d, h);
      const file = await kernel.call("export_stl", specOf(doc, lastFeature(doc)), kind);
      download(file.bytes, `fission-${kind}.stl`);
      note.textContent = file.warning ?? "";
      note.className = file.warning ? "bad" : "";
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : String(e);
      note.className = "bad";
    }
  }

  $("download-stl").addEventListener("click", exportStl);
  inputs.forEach((i) => i.addEventListener("input", update));
  shape.addEventListener("change", update);
  update();
  return () => {
    shown = false;
  };
}

export const designWorkspace: WorkspacePlugin = {
  id: "design",
  title: "Design",
  summary: "Parametric modelling: sketches, features and the timeline. The source of truth for all geometry.",
  status: "working",
  mount,
};
