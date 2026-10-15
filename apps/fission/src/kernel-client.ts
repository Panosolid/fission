// Main-thread side of the kernel worker: every kernel call is an async
// message, so a slow operation never freezes the UI.
import type { BodyView } from "./kernel-types";
import type { Outline } from "./profiles";

/** Every operation the worker supports, with its arguments and result. */
export interface KernelOps {
  kernel_version: { args: []; result: string };
  make_box: { args: [width: number, depth: number, height: number]; result: BodyView };
  make_cylinder: { args: [radius: number, height: number]; result: BodyView };
  make_sphere: { args: [radius: number]; result: BodyView };
  make_extrude: { args: [profile: Outline, distance: number]; result: BodyView };
}

export type KernelRequest = {
  [K in keyof KernelOps]: { id: number; op: K; args: KernelOps[K]["args"] };
}[keyof KernelOps];

export type KernelResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export class KernelClient {
  private worker = new Worker(new URL("./kernel.worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<KernelResponse>) => {
      const reply = event.data;
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.value);
      else p.reject(new Error(reply.error));
    };
    this.worker.onerror = (event) => {
      const err = new Error(`kernel worker crashed: ${event.message}`);
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };
  }

  call<K extends keyof KernelOps>(op: K, ...args: KernelOps[K]["args"]): Promise<KernelOps[K]["result"]> {
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
