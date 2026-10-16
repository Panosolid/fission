// Autosave (19c): saves the project once things have been quiet for a
// moment after each change.
//   - Each change restarts the quiet timer, so a burst of edits is one save.
//   - One save in flight at a time; the timer firing during a save asks for
//     one more save straight after it, of whatever the project is then
//     (the latest state wins; states in between are never written).
//   - A save of text identical to the last one written is skipped.
//   - A failure is reported with its message and nothing retries on its
//     own; the next change tries again.

import { projectToJson, type Project } from "@fission/core";
import type { ProjectStore } from "./store.ts";

export type AutosaveStatus =
  /** Changes are waiting for the quiet moment, or being written now. */
  | { state: "saving" }
  /** Everything up to the last change is stored. */
  | { state: "saved" }
  /** The last save failed; the next change tries again. */
  | { state: "error"; message: string };

/** The clock autosave waits on; tests hand in a fake one. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutosaveOptions {
  /** How long things must be quiet after a change before saving, in ms. */
  quietMs?: number;
  timers?: Timers;
}

export interface Autosave {
  /** Call after every change to the project. */
  changed(): void;
  /** Stops for good: a waiting save is dropped, one in flight finishes. */
  stop(): void;
}

/** One second: long enough that typing a number is one save, short enough that a reload rarely loses anything. */
export const QUIET_MS = 1000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Saves `project()` to `store` under `id` a moment after each `changed()`,
 * reporting each status change to `onStatus`.
 */
export function startAutosave(
  store: ProjectStore,
  id: string,
  project: () => Project,
  onStatus: (status: AutosaveStatus) => void = () => {},
  { quietMs = QUIET_MS, timers = globalThis }: AutosaveOptions = {},
): Autosave {
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = false;
  /** The text last written, so an unchanged project is not written again. */
  let written: string | null = null;

  const report = (s: AutosaveStatus) => {
    if (!stopped) onStatus(s);
  };

  async function save() {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    let text: string;
    try {
      text = projectToJson(project()); // refuses NaN and the like before anything is written
    } catch (e) {
      report({ state: "error", message: message(e) });
      return;
    }
    if (text === written) {
      report({ state: "saved" });
      return;
    }
    inFlight = true;
    let failure: string | null = null;
    try {
      await store.save(id, JSON.parse(text) as Project); // exactly the state checked above
      written = text;
    } catch (e) {
      failure = message(e);
    }
    inFlight = false;
    if (again) {
      again = false;
      return save();
    }
    if (failure !== null) report({ state: "error", message: failure });
    else if (timer === null) report({ state: "saved" });
  }

  return {
    changed() {
      if (stopped) return;
      if (timer !== null) timers.clearTimeout(timer);
      timer = timers.setTimeout(() => void save(), quietMs);
      report({ state: "saving" });
    },
    stop() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      stopped = true;
    },
  };
}
