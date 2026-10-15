import { KernelClient, latestOnly } from "./kernel-client";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = (n: number) => (+n.toPrecision(10)).toLocaleString("en-GB", { maximumFractionDigits: 6 });

const kernel = new KernelClient();
const viewer = new Viewer($("viewport"));
const inputs = ["width", "depth", "height"].map((id) => $<HTMLInputElement>(id));
const buildBox = latestOnly((w: number, d: number, h: number) => kernel.call("make_box", w, d, h));
let first = true;

async function update() {
  const [w, d, h] = inputs.map((i) => Number(i.value));
  try {
    const { current, value: view } = await buildBox(w, d, h);
    if (!current) return;
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

async function start() {
  $("version").textContent = `kernel v${await kernel.call("kernel_version")}`;
  inputs.forEach((i) => i.addEventListener("input", update));
  await update();
}

start();
