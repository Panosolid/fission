import init, { add_vectors, cross, dot, kernel_version } from "./kernel/fission_kernel.js";
import { Viewer } from "./viewer";

type Vec = [number, number, number];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function parseVec(text: string): Vec {
  const parts = text.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`"${text}" is not a vector like 1, 2, 3`);
  }
  return parts as Vec;
}

const fmt = (v: ArrayLike<number>) =>
  `(${Array.from(v, (n) => +n.toFixed(4)).join(", ")})`;

async function start() {
  await init();
  $("version").textContent = `kernel v${kernel_version()}`;

  const viewer = new Viewer($("viewport"));
  const inputA = $<HTMLInputElement>("a");
  const inputB = $<HTMLInputElement>("b");

  function update() {
    try {
      const a = parseVec(inputA.value);
      const b = parseVec(inputB.value);
      const sum = add_vectors(Float64Array.from(a), Float64Array.from(b));
      const crossed = cross(Float64Array.from(a), Float64Array.from(b));
      $("sum").textContent = fmt(sum);
      $("cross").textContent = fmt(crossed);
      $("dot").textContent = String(+dot(Float64Array.from(a), Float64Array.from(b)).toFixed(4));
      $("error").textContent = "";
      viewer.showVectors(a, b, Array.from(sum) as Vec, Array.from(crossed) as Vec);
    } catch (e) {
      $("error").textContent = e instanceof Error ? e.message : String(e);
    }
  }

  inputA.addEventListener("input", update);
  inputB.addEventListener("input", update);
  update();
}

start();
