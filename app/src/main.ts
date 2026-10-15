import { KernelClient, latestOnly } from "./kernel-client";
import { Viewer } from "./viewer";
import { formatQuantity as fmt, needsRefit, type Framing } from "./format";
import { outline, type ShapeKind } from "./profiles";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const kernel = new KernelClient();
const viewer = new Viewer($("viewport"));
const inputs = ["width", "depth", "height"].map((id) => $<HTMLInputElement>(id));
const shape = $<HTMLSelectElement>("shape");
// Boxes come from the box primitive; the other shapes are outlines
// extruded by the height.
const build = latestOnly((kind: ShapeKind, w: number, d: number, h: number) => {
  if (kind === "box") return kernel.call("make_box", w, d, h);
  const o = outline(kind, w, d);
  return kernel.call("make_extrude", o.outer, o.holeCorners, o.holes, h);
});
let framed: Framing | null = null;
let framedKind: ShapeKind | null = null;

async function update() {
  const [w, d, h] = inputs.map((i) => Number(i.value));
  const kind = shape.value as ShapeKind;
  $("height-label").textContent = kind === "box" ? "Height" : "Extrude by";
  try {
    const { current, value: view } = await build(kind, w, d, h);
    if (!current) return;
    viewer.showBody(view.mesh);
    // A different shape is a new part: frame it.
    if (kind !== framedKind || needsRefit(framed, viewer.bodyFraming())) {
      framed = viewer.fit();
      framedKind = kind;
      $("viewport").dataset.framedRadius = String(framed?.radius); // read by the e2e test
    }
    $("volume").textContent = `${fmt(view.volume)} mm³`;
    $("area").textContent = `${fmt(view.area)} mm²`;
    $("topology").textContent = `${view.vertices} V · ${view.edges} E · ${view.faces} F`;
    const status = $("status");
    status.textContent = view.errors.length === 0 ? "valid" : `${view.errors.length} problem(s)`;
    status.className = view.errors.length === 0 ? "ok" : "bad";
    $("error").textContent = view.errors.join("\n");
    $("viewport").dataset.shape = kind; // read by the e2e test: what is on screen
  } catch (e) {
    $("error").textContent = e instanceof Error ? e.message : String(e);
  }
}

async function start() {
  $("version").textContent = `kernel v${await kernel.call("kernel_version")}`;
  inputs.forEach((i) => i.addEventListener("input", update));
  shape.addEventListener("change", update);
  await update();
}

start();
