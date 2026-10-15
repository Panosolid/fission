import init, { kernel_version, make_box } from "./kernel/fission_kernel.js";
import type { BodyView } from "./kernel-types";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = (n: number) => (+n.toPrecision(10)).toLocaleString("en-GB", { maximumFractionDigits: 6 });

async function start() {
  await init();
  $("version").textContent = `kernel v${kernel_version()}`;

  const viewer = new Viewer($("viewport"));
  const inputs = ["width", "depth", "height"].map((id) => $<HTMLInputElement>(id));
  let first = true;

  function update() {
    const [w, d, h] = inputs.map((i) => Number(i.value));
    try {
      const view = make_box(w, d, h) as BodyView;
      viewer.showBody(view.mesh);
      if (first) {
        viewer.fit();
        first = false;
      }
      $("volume").textContent = `${fmt(view.volume)} mm³`;
      $("area").textContent = `${fmt(view.area)} mm²`;
      $("topology").textContent = `${view.vertices} V · ${view.edges} E · ${view.faces} F`;
      const status = $("status");
      status.textContent = view.errors.length === 0 ? "valid" : `${view.errors.length} problem(s)`;
      status.className = view.errors.length === 0 ? "ok" : "bad";
      $("error").textContent = view.errors.join("\n");
    } catch (e) {
      $("error").textContent = e instanceof Error ? e.message : String(e);
    }
  }

  inputs.forEach((i) => i.addEventListener("input", update));
  update();
}

start();
