// Main-thread side of the kernel worker: every kernel call is an async
// message, so a slow operation never freezes the UI.
import type { BodyHandle, BodySpec, BodyView, KernelErrorKind, KernelFailure, KernelInput, Outline, SketchArc, SketchCircle, SketchLine, SketchOutline, StlFile } from "./kernel-types.ts";

/** Every operation the worker supports, with its arguments and result. */
export interface KernelOps {
  kernel_version: { args: []; result: string };
  make_box: { args: [width: number, depth: number, height: number]; result: BodyView };
  make_cylinder: { args: [radius: number, height: number]; result: BodyView };
  make_sphere: { args: [radius: number]; result: BodyView };
  make_extrude: { args: [profile: Outline, distance: number]; result: BodyView };
  export_stl: { args: [spec: BodySpec, name: string]; result: StlFile };
  snap_to_grid: { args: [x: number, y: number, spacing: number]; result: [number, number] };
  place_freely: { args: [x: number, y: number, pixel: number]; result: [number, number] };
  sketch_outline: { args: [lines: SketchLine[], circles: SketchCircle[], arcs: SketchArc[]]; result: SketchOutline };
  /** The body store (kernel/src/store.rs): build and keep a body, read it by handle, free it. */
  body_build: { args: [spec: BodySpec]; result: BodyHandle };
  body_view: { args: [body: BodyHandle]; result: BodyView };
  body_stl: { args: [body: BodyHandle, name: string]; result: StlFile };
  /** The body as a STEP AP214 file, placed where it is shown (step 29b3: the oracle reads the app's bodies with OpenCascade). */
  body_step: { args: [body: BodyHandle]; result: string };
  body_free: { args: [body: BodyHandle]; result: void };
  /** How many bodies the kernel keeps: tests check what they build they free. */
  body_count: { args: []; result: number };
}

export type KernelRequest = {
  [K in keyof KernelOps]: { id: number; op: K; args: KernelOps[K]["args"] };
}[keyof KernelOps];

export type KernelResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: KernelFailure };

const KINDS: readonly KernelErrorKind[] = ["invalid-input", "invalid-result", "bad-request", "unknown-body", "too-many-bodies", "internal"];

/**
 * A failed kernel call: `message` to show the user, `kind` and `inputs` for
 * the app to decide by (never parse the message).
 */
export class KernelError extends Error {
  readonly kind: KernelErrorKind;
  readonly inputs: KernelInput[];
  constructor(failure: KernelFailure) {
    // Its name stays "Error", so String(e) reads as it always has.
    super(failure.message);
    this.kind = failure.kind;
    this.inputs = failure.inputs;
  }
}

/**
 * Anything a kernel call threw, as plain data: the WASM kernel throws an
 * Error carrying `kind` and `inputs`; anything else (a crash, a worker bug)
 * is "internal" with no inputs.
 */
export function kernelFailure(e: unknown): KernelFailure {
  const message = e instanceof Error ? e.message : String(e);
  const fields = (typeof e === "object" && e !== null ? e : {}) as { kind?: unknown; inputs?: unknown };
  const kind = KINDS.includes(fields.kind as KernelErrorKind) ? (fields.kind as KernelErrorKind) : "internal";
  const inputs = kind !== "internal" && Array.isArray(fields.inputs) ? (fields.inputs as KernelInput[]) : [];
  return { kind, inputs, message };
}

/** Anything that answers kernel calls: the worker client in the app, the WASM module directly in tests. */
export interface KernelCalls {
  call<K extends keyof KernelOps>(op: K, ...args: KernelOps[K]["args"]): Promise<KernelOps[K]["result"]>;
}

export class KernelClient implements KernelCalls {
  private worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Set once the worker is gone (its error event): every call fails with it. */
  private failed: KernelError | null = null;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
      const reply = event.data;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.value);
      else p.reject(new KernelError(reply.error));
    };
    // The worker answers every call, a failing one too (kernel.worker.ts), so
    // an error event means its script didn't load or threw while it started:
    // the worker is gone. Every call waiting and every later one fails with
    // the same words, never waits for an answer that can't come, and the
    // event is taken as handled (the app says it, not the browser's console).
    this.worker.onerror = (event) => {
      event.preventDefault();
      const why = event.message ? `stopped (kernel worker crashed: ${event.message})` : "didn't start (its worker didn't load)";
      this.failed = new KernelError({ kind: "internal", inputs: [], message: `The geometry kernel ${why}. Reload the page to try again.` });
      this.pending.forEach((p) => p.reject(this.failed!));
      this.pending.clear();
    };
  }

  call<K extends keyof KernelOps>(op: K, ...args: KernelOps[K]["args"]): Promise<KernelOps[K]["result"]> {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args } as KernelRequest);
    });
  }
}

/**
 * Wraps an async function so only the result of the most recent call is
 * used: replies to older calls that arrive late are dropped.
 */
export function latestOnly<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  let latest = 0;
  return async (...args: A): Promise<{ current: boolean; value: R }> => {
    const ticket = ++latest;
    const value = await fn(...args);
    return { current: ticket === latest, value };
  };
}
