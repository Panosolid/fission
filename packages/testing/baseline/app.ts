// Speed and memory of the app's key operations, for tests/baseline.json
// (checked in CI by .github/scripts/baseline.py, test audit item 3). Prints
// one JSON object: for each operation
// - `retained_bytes`: JavaScript heap its result keeps, after a full GC
//   (needs --expose-gc), the middle of 5 tries, so one stray collection
//   or allocation elsewhere doesn't count;
// - `kernel_memory.wasm_bytes`: the kernel's WebAssembly memory once all the
//   kernel operations have run (it grows in 64 KiB pages and never shrinks,
//   so this is the high-water mark);
// - `relative_time`: the fastest of 25 runs divided by the fastest of a fixed
//   JavaScript workload timed in the same process, so a faster or slower
//   machine mostly cancels out (still noisy; CI only flags it);
// - `rebuild_20_arcs_edit_first` (step 24d3c, `rebuild.ts`): one sketch
//   edit on a part of 20 extrudes with arcs, timed as above, and counted
//   exactly: `body_builds` (1 with a working cache) and `kernel_calls`.
//   FISSION_BASELINE_FAULT=full-replay or outline-twice plants a bug there
//   (`REBUILD_FAULTS`), to see the check fail.
// Needs the WASM build (`npm run kernel` in apps/fission).
// Run: node --expose-gc --experimental-strip-types --no-warnings packages/testing/baseline/app.ts
import { readFileSync } from "node:fs";
import { createHistory, emptyProject, projectFromJson, projectToJson, type Project } from "@fission/core";
import { designWorkspace, partDocument } from "@fission/design";
import * as wasm from "../../core/src/kernel/wasm/fission_kernel.js";
import { READERS } from "../src/project-fuzz.ts";
import { nodeKernel } from "../src/node-kernel.ts";
import { BodyCache, countingKernel, editFirst, REBUILD_FAULTS, rebuildPart, showEdit, type RebuildFault } from "./rebuild.ts";
import { seeded } from "../src/index.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");
const exports = wasm.initSync({ module: readFileSync(new URL("../../core/src/kernel/wasm/fission_kernel_bg.wasm", import.meta.url)) });

/** A project as big as a busy real one: a part, and 2,000 objects of another workspace's data. */
function bigProject(): Project {
  const r = seeded(7n);
  const objects = Array.from({ length: 2000 }, (_, i) => ({ id: `object-${i}`, name: `Object ${i}`, at: [r.next() * 100, r.next() * 100, r.next() * 100], tags: ["a", "b"] }));
  return { ...emptyProject("Big"), workspaces: { design: partDocument("l-bracket", 40, 30, 20), render: { version: 1, objects } } };
}
const bigText = projectToJson(bigProject());

const star = { outer: { path: { corners: Array.from({ length: 24 }, (_, i) => [Math.cos((i * Math.PI) / 12) * (i % 2 ? 18 : 30), Math.sin((i * Math.PI) / 12) * (i % 2 ? 18 : 30)]).flat(), bulges: Array(24).fill(0) } }, holes: [] };

const OPERATIONS: Record<string, () => unknown> = {
  project_open: () => projectFromJson(bigText, READERS),
  project_save: (() => {
    const p = projectFromJson(bigText, READERS);
    return () => projectToJson(p);
  })(),
  history_200_edits: () => {
    let project: Project = { ...emptyProject(), workspaces: { design: partDocument("box", 40, 30, 20) } };
    let t = 0;
    const h = createHistory({ capture: () => projectToJson(project), restore: (text) => (project = projectFromJson(text, [designWorkspace])), now: () => (t += 2000) });
    for (let w = 41; w <= 240; w++) {
      project = { ...project, workspaces: { design: partDocument("box", w, 30, 20) } };
      h.record("Change width", "width");
    }
    while (h.undo());
    return h;
  },
  kernel_extrude_star: () => wasm.make_extrude(star, 10),
  kernel_sphere: () => wasm.make_sphere(25),
  kernel_stl_sphere: () => wasm.export_stl({ sphere: { radius: 25 } }, "ball"),
};

function calibration() {
  const r = seeded(1n);
  const xs = Array.from({ length: 100_000 }, () => r.next());
  xs.sort((a, b) => a - b);
  return JSON.parse(JSON.stringify(xs.slice(0, 20_000))).length;
}

/** The fastest of `runs` runs: interruptions only ever add time, so the minimum is the steadiest. */
const fastest = (f: () => unknown, runs: number) => {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    f();
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  return best;
};

for (const f of [calibration, ...Object.values(OPERATIONS)]) for (let i = 0; i < 3; i++) f(); // warm the JIT
const out: Record<string, Record<string, number>> = {};
const keep: { result?: unknown } = {};
for (const [name, f] of Object.entries(OPERATIONS)) {
  const tries: number[] = [];
  for (let i = 0; i < 5; i++) {
    gc();
    gc();
    const before = process.memoryUsage().heapUsed;
    keep.result = f(); // held where the optimiser can't see it die
    gc();
    gc();
    tries.push(process.memoryUsage().heapUsed - before);
    keep.result = undefined;
  }
  const retained = tries.sort((a, b) => a - b)[2];
  const metrics: Record<string, number> = { retained_bytes: Math.max(0, retained) };
  const calib = fastest(calibration, 25);
  metrics.relative_time = Math.round((fastest(f, 25) / calib) * 10000) / 10000;
  out[name] = metrics;
}
// The kernel's WebAssembly memory after every kernel operation above ran
// 3 + 3 + 25 times, always in the same order.
out.kernel_memory = { wasm_bytes: exports.memory.buffer.byteLength };

// The rebuild after one edit (async: the kernel answers with promises, as
// the worker does). Each run moves the first sketch's corner the other
// way, so every run is a real edit with one body to build.
const fault = process.env.FISSION_BASELINE_FAULT as RebuildFault | undefined;
if (fault !== undefined && !REBUILD_FAULTS.includes(fault)) throw new Error(`FISSION_BASELINE_FAULT is ${fault}, not one of ${REBUILD_FAULTS.join(", ")}`);
{
  const kernel = countingKernel(nodeKernel());
  const cache = new BodyCache(kernel);
  const part = rebuildPart();
  let doc = (await showEdit(kernel, cache, part.doc, part.doc)).doc;
  let shift = 0;
  const edit = async () => {
    shift = shift === 0 ? 2 : 0;
    doc = (await showEdit(kernel, cache, doc, editFirst(part, shift), fault)).doc;
  };
  for (let i = 0; i < 3; i++) await edit(); // warm the JIT
  const [calls, builds] = [kernel.calls, kernel.builds];
  await edit();
  const metrics: Record<string, number> = { kernel_calls: kernel.calls - calls, body_builds: kernel.builds - builds };
  let best = Infinity;
  for (let i = 0; i < 25; i++) {
    const t = process.hrtime.bigint();
    await edit();
    best = Math.min(best, Number(process.hrtime.bigint() - t));
  }
  metrics.relative_time = Math.round((best / fastest(calibration, 25)) * 10000) / 10000;
  out.rebuild_20_arcs_edit_first = metrics;
  await cache.clear();
}
console.log(JSON.stringify(out, null, 2));
