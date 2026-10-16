// Runs the WASM kernel off the main thread. Every request is a message
// { id, op, args }; every reply is { id, ok: true, value } or { id, ok: false, error }.
import init, * as kernel from "./wasm/fission_kernel.js";
import type { KernelRequest, KernelResponse } from "./kernel-client.ts";
import type { BodySpec, Outline } from "./kernel-types.ts";

const ready = init();

const ops = {
  kernel_version: () => kernel.kernel_version(),
  make_box: (w: number, d: number, h: number) => kernel.make_box(w, d, h),
  make_cylinder: (r: number, h: number) => kernel.make_cylinder(r, h),
  make_sphere: (r: number) => kernel.make_sphere(r),
  make_extrude: (profile: Outline, distance: number) => kernel.make_extrude(profile, distance),
  export_stl: (spec: BodySpec, name: string) => kernel.export_stl(spec, name),
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
