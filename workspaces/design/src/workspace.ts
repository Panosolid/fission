// The Design workspace: the CAD, and the source of truth for all geometry.
// Until the sketcher (steps 21–31) it builds primitives and ready-made
// outlines; every other workspace will refer to its bodies, faces and edges.

import { latestOnly, type Framing, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";
import { formatQuantity as fmt } from "@fission/ui";
import { needsRefit } from "@fission/viewport";
import { outline, type ShapeKind } from "./profiles.ts";

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
  <dl id="stats">
    <dt>Volume</dt><dd id="volume">…</dd>
    <dt>Area</dt><dd id="area">…</dd>
    <dt>Topology</dt><dd id="topology">…</dd>
    <dt>Validation</dt><dd id="status">…</dd>
  </dl>
  <p id="error"></p>`;

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

  // Boxes, cylinders and spheres come from the primitives (a cylinder's or
  // sphere's width is its diameter); the other shapes are outlines extruded by the height.
  const build = latestOnly((kind: ShapeKind, w: number, d: number, h: number) => {
    if (kind === "box") return kernel.call("make_box", w, d, h);
    if (kind === "cylinder") return kernel.call("make_cylinder", w / 2, h);
    if (kind === "sphere") return kernel.call("make_sphere", w / 2);
    return kernel.call("make_extrude", outline(kind, w, d), h);
  });

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
    try {
      const { current, value: view } = await build(kind, w, d, h);
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
