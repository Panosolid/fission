// Runs the WASM kernel off the main thread. Every request is a message
// { id, op, args }; every reply is { id, ok: true, value } or { id, ok: false, error },
// the error as plain data (kind, inputs, message), since a thrown Error's own
// fields don't survive the trip between threads.
import init, * as kernel from "./wasm/fission_kernel.js";
import { kernelFailure, type KernelRequest, type KernelResponse } from "./kernel-client.ts";
import type { BodyHandle, BodySpec, Outline, SketchArc, SketchCircle, SketchLine } from "./kernel-types.ts";

const ready = init();

const ops = {
  kernel_version: () => kernel.kernel_version(),
  make_box: (w: number, d: number, h: number) => kernel.make_box(w, d, h),
  make_cylinder: (r: number, h: number) => kernel.make_cylinder(r, h),
  make_sphere: (r: number) => kernel.make_sphere(r),
  make_extrude: (profile: Outline, distance: number) => kernel.make_extrude(profile, distance),
  export_stl: (spec: BodySpec, name: string) => kernel.export_stl(spec, name),
  snap_to_grid: (x: number, y: number, spacing: number) => kernel.snap_to_grid(x, y, spacing),
  place_freely: (x: number, y: number, pixel: number) => kernel.place_freely(x, y, pixel),
  sketch_outline: (lines: SketchLine[], circles: SketchCircle[], arcs: SketchArc[]) => kernel.sketch_outline(lines, circles, arcs),
  body_build: (spec: BodySpec) => kernel.body_build(spec),
  body_view: (body: BodyHandle) => kernel.body_view(body),
  body_stl: (body: BodyHandle, name: string) => kernel.body_stl(body, name),
  body_free: (body: BodyHandle) => kernel.body_free(body),
  body_count: () => kernel.body_count(),
} satisfies Record<KernelRequest["op"], (...args: never[]) => unknown>;

self.onmessage = async (event: MessageEvent<KernelRequest>) => {
  const { id, op, args } = event.data;
  let reply: KernelResponse;
  try {
    await ready;
    const fn = ops[op] as (...a: unknown[]) => unknown;
    reply = { id, ok: true, value: fn(...args) };
  } catch (e) {
    reply = { id, ok: false, error: kernelFailure(e) };
  }
  self.postMessage(reply);
};
