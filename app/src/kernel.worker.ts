// Runs the WASM kernel off the main thread. Every request is a message
// { id, op, args }; every reply is { id, ok: true, value } or { id, ok: false, error }.
import init, * as kernel from "./kernel/fission_kernel.js";
import type { KernelRequest, KernelResponse } from "./kernel-client";

const ready = init();

const ops = {
  kernel_version: () => kernel.kernel_version(),
  make_box: (w: number, d: number, h: number) => kernel.make_box(w, d, h),
  make_extrude: (outer: number[], holeCorners: number[], holes: number[], distance: number) =>
    kernel.make_extrude(new Float64Array(outer), new Uint32Array(holeCorners), new Float64Array(holes), distance),
} satisfies Record<KernelRequest["op"], (...args: never[]) => unknown>;

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const { id, op, args } = event.data;
  let reply: KernelResponse;
  try {
    await ready;
    const fn = ops[op] as (...a: unknown[]) => unknown;
    reply = { id, ok: true, value: fn(...args) };
  } catch (e) {
    reply = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(reply);
};
