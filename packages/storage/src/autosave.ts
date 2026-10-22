// Autosave (19c): saves the project once things have been quiet for a
// moment after each change.
//   - Each change restarts the quiet timer, so a burst of edits is one save.
//   - One save in flight at a time; the timer firing during a save asks for
//     one more save straight after it, of whatever the project is then
//     (the latest state wins; states in between are never written).
//   - A save of text identical to the last one written is skipped.
//   - A failure is reported with its message and nothing retries on its
//     own; the next change tries again.
//   - When the page may be going (hidden, reloaded, closed), `leaving()`
//     writes the latest state to the unsaved-changes journal at once
//     (unsaved.ts; localStorage, which is written before the call returns,
//     where a store's save may never finish) and starts the store's save
//     without waiting for the quiet moment. A save that stores a state at
//     least as new as the journal's removes the journal entry; one that
//     stores an older state leaves it.
//   - Given the undo history to follow, every change to it is a change to
//     the project too (hunt 26h): above all an amend, a change no one
//     records (a face sketch settled, a pinned point followed once the
//     kernel answers), which can come after the edit was stored.

import { projectToJson, type Project } from "@fission/core";
import type { ProjectStore } from "./store.ts";
import { unsavedKey, type JournalStorage } from "./unsaved.ts";

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
  /** Where `leaving()` keeps changes the store doesn't hold yet (the browser's localStorage); null keeps none. */
  journal?: JournalStorage | null;
  /** The undo history (core history.ts): each change to it is taken as `changed()`, until `stop()`. */
  follows?: { onChange(listener: () => void): () => void } | null;
}

export interface Autosave {
  /** Call after every change to the project. */
  changed(): void;
  /**
   * Call when the page may be going (hidden, reloaded or closed): writes
   * every change the store doesn't hold yet to the journal before
   * returning, and starts the store's save now. True when every change is
   * kept (in the store or the journal); false when one would be lost (the
   * journal can't be written: storage off or full), so the page should ask
   * before going.
   */
  leaving(): boolean;
  /** Stops for good: a waiting save is dropped, one in flight finishes. */
  stop(): void;
}

/** One second: long enough that typing a number is one save. A page going sooner keeps its changes through `leaving()`. */
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
  { quietMs = QUIET_MS, timers = globalThis, journal = null, follows = null }: AutosaveOptions = {},
): Autosave {
  let timer: unknown = null;
  let inFlight = false;
  let again = false;
  let stopped = false;
  /** The text last written, so an unchanged project is not written again. */
  let written: string | null = null;
  // Changes are counted, so the store and the journal can be compared:
  // `version` is the number of changes so far, `storedVersion` the count
  // the store holds the project as of (the project opened counts as 0), and
  // `journalVersion` the count the journal entry holds it as of (null: no
  // entry). An entry already there when autosave starts is from a page that
  // went before its change was stored, so it counts as 0: older than
  // anything this one stores, and kept until then.
  let version = 0;
  let storedVersion = 0;
  const key = unsavedKey(id);
  let journalVersion: number | null = (() => {
    try {
      return journal?.getItem(key) != null ? 0 : null;
    } catch {
      return null;
    }
  })();

  const report = (s: AutosaveStatus) => {
    if (!stopped) onStatus(s);
  };
  /** The store now holds the project as of change `v`: a journal entry no newer than that is not needed. */
  const stored = (v: number) => {
    storedVersion = Math.max(storedVersion, v);
    if (journalVersion === null || journalVersion > v) return;
    try {
      journal?.removeItem(key);
      journalVersion = null;
    } catch {
      // left in place: recovered over the same state next visit, which changes nothing
    }
  };

  async function save() {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      again = true;
      return;
    }
    const v = version; // the project read next holds every change counted so far
    let text: string;
    try {
      text = projectToJson(project()); // refuses NaN and the like before anything is written
    } catch (e) {
      report({ state: "error", message: message(e) });
      return;
    }
    if (text === written) {
      stored(v);
      report({ state: "saved" });
      return;
    }
    inFlight = true;
    let failure: string | null = null;
    try {
      await store.save(id, JSON.parse(text) as Project); // exactly the state checked above
      written = text;
      stored(v);
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

  function changed() {
    if (stopped) return;
    version++;
    if (timer !== null) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => void save(), quietMs);
    report({ state: "saving" });
  }
  const unfollow = follows?.onChange(changed) ?? (() => {});

  return {
    changed,
    leaving() {
      if (stopped || storedVersion === version) return true;
      let kept = journalVersion === version;
      if (!kept && journal) {
        try {
          journal.setItem(key, projectToJson(project()));
          journalVersion = version;
          kept = true;
        } catch {
          // storage off or full, or a project that can't be written: the page should ask before going
        }
      }
      // Don't wait for the quiet moment: the page may live long enough for the store's save too.
      if (timer !== null) {
        timers.clearTimeout(timer);
        void save();
      } else if (!inFlight) void save(); // the last save failed: try once more
      return kept;
    },
    stop() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      stopped = true;
      unfollow();
    },
  };
}
