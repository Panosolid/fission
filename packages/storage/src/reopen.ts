// Reopening the last project only when it opened fine last time (security
// audit S2). The app reopens the newest kept project on every visit, so one
// that freezes or crashes the tab while it opens would do it again on every
// visit, and the only way out would be clearing the site's data, which
// deletes every kept project. So a mark naming the project is written just
// before it opens and cleared once the tab has kept running for SETTLED_MS
// after showing it, or opening failed with a message, or the page was
// closed normally (which a frozen tab can't do). A visit that finds the
// mark still naming the project it would reopen skips it once: the mark is
// cleared, so the visit after tries again.

import type { Timers } from "./autosave.ts";

/** The mark's key in the browser's localStorage. */
export const OPENING_KEY = "panoshape.opening";

/** How long the tab must keep running after showing a project before it counts as opened, in ms. */
export const SETTLED_MS = 3000;

/** The part of localStorage the guard uses (any of it may throw: storage off, private mode). */
export interface MarkStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ReopenGuard {
  /**
   * True when the last visit started opening `id` and never finished, so
   * this visit should not reopen it. Clears the mark either way, so the
   * visit after this one tries again.
   */
  stuck(id: string): boolean;
  /** Call just before opening `id`; replaces any earlier mark. */
  opening(id: string): void;
  /** Call once `id` is shown: the mark is cleared after SETTLED_MS, unless another opening has replaced it. */
  shown(id: string): void;
  /** Call when opening ended without freezing the tab: it failed with a message, or the page was closed normally. */
  finished(): void;
}

/**
 * The guard over `storage`, or one that never skips when storage is null
 * or throws (a browser that can't keep the mark still opens its projects,
 * as it did before the guard).
 */
export function reopenGuard(storage: MarkStorage | null, { timers = globalThis as Timers, settledMs = SETTLED_MS } = {}): ReopenGuard {
  const read = () => {
    try {
      return storage?.getItem(OPENING_KEY) ?? null;
    } catch {
      return null;
    }
  };
  const write = (id: string | null) => {
    try {
      if (id === null) storage?.removeItem(OPENING_KEY);
      else storage?.setItem(OPENING_KEY, id);
    } catch {
      // nothing to do: without the mark the app behaves as before the guard
    }
  };
  let pending: unknown = null;
  return {
    stuck(id) {
      const was = read();
      write(null);
      return was === id;
    },
    opening(id) {
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
      write(id);
    },
    shown(id) {
      if (pending !== null) timers.clearTimeout(pending);
      pending = timers.setTimeout(() => {
        pending = null;
        if (read() === id) write(null);
      }, settledMs);
    },
    finished() {
      if (pending !== null) timers.clearTimeout(pending);
      pending = null;
      write(null);
    },
  };
}
