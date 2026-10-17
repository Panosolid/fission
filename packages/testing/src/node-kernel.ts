// The WASM kernel in Node, for the journey tests: the same module the app
// runs in its Web Worker, answering the same KernelCalls interface, loaded
// directly instead of through a worker. Needs the WASM build first
// (`npm run build` in apps/fission).
// Node-only, like the tests, so the type check (browser types) skips it.

import { readFileSync } from "node:fs";
import type { KernelCalls, KernelOps } from "@fission/core";
import * as wasm from "../../core/src/kernel/wasm/fission_kernel.js";

let loaded = false;

export function nodeKernel(): KernelCalls {
  if (!loaded) {
    wasm.initSync({ module: readFileSync(new URL("../../core/src/kernel/wasm/fission_kernel_bg.wasm", import.meta.url)) });
    loaded = true;
  }
  const ops: { [K in keyof KernelOps]: (...a: KernelOps[K]["args"]) => KernelOps[K]["result"] } = {
    kernel_version: () => wasm.kernel_version(),
    make_box: (w, d, h) => wasm.make_box(w, d, h),
    make_cylinder: (r, h) => wasm.make_cylinder(r, h),
    make_sphere: (r) => wasm.make_sphere(r),
    make_extrude: (p, d) => wasm.make_extrude(p, d),
    export_stl: (spec, name) => wasm.export_stl(spec, name),
    snap_to_grid: (x, y, s) => wasm.snap_to_grid(x, y, s),
    sketch_outline: (lines, circles) => wasm.sketch_outline(lines, circles),
  };
  return {
    // Async like the worker, and errors become rejections with the kernel's message.
    call: (async (op: keyof KernelOps, ...args: unknown[]) => (ops[op] as (...a: unknown[]) => unknown)(...args)) as KernelCalls["call"],
  };
}
