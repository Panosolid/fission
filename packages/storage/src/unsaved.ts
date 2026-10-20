// The unsaved-changes journal (timeline bug hunt, finding 1). Autosave
// waits for a quiet moment before saving, and the store's save is
// asynchronous, so a page reloaded or closed soon after a change would
// lose it: nothing runs once the page has gone. So when the page may be
// going, autosave writes the latest state here (`leaving()` in
// autosave.ts), in the browser's localStorage, which is written before the
// call returns. Each kept project has its own entry, the exact text of its
// .panosolid.json file. An entry is removed once the store holds that state
// or a newer one; one still here on the next visit holds the newest state
// of its project, and `recoverUnsaved` puts it in the store before the app
// lists or opens anything.

import { projectFromJson, type DataReader } from "@fission/core";
import type { MarkStorage } from "./reopen.ts";
import type { ProjectStore } from "./store.ts";

/** Every entry's key starts with this, followed by the project's stored id. */
export const UNSAVED_PREFIX = "panoshape.unsaved/";

export const unsavedKey = (id: string) => UNSAVED_PREFIX + id;

/** The part of localStorage the journal uses (any of it may throw: storage off, private mode, full). */
export interface JournalStorage extends MarkStorage {
  readonly length: number;
  key(index: number): string | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Puts every journal entry in `store`, through `projectFromJson` as an
 * opened file would be, and removes each one stored. Never throws: returns
 * a message for each entry that couldn't be put back. An entry that doesn't
 * read as a project is removed (the store keeps its project as it was); one
 * the store refuses is kept, so the next visit tries again.
 */
export async function recoverUnsaved(store: ProjectStore, journal: JournalStorage | null, readers: readonly DataReader[]): Promise<string[]> {
  const problems: string[] = [];
  const keys: string[] = [];
  if (!journal) return problems;
  try {
    for (let i = 0; i < journal.length; i++) {
      const k = journal.key(i);
      if (k !== null && k.startsWith(UNSAVED_PREFIX) && k.length > UNSAVED_PREFIX.length) keys.push(k);
    }
  } catch {
    return problems; // storage off: there is no journal to read
  }
  for (const k of keys) {
    const id = k.slice(UNSAVED_PREFIX.length);
    let text: string | null;
    try {
      text = journal.getItem(k);
    } catch (e) {
      problems.push(`unsaved changes from your last visit couldn't be read (${message(e)})`);
      continue;
    }
    if (text === null) continue; // another tab put it back meanwhile
    let project;
    try {
      project = projectFromJson(text, readers);
    } catch (e) {
      problems.push(`unsaved changes from your last visit couldn't be read, so the project is as it was last saved (${message(e)})`);
      remove(journal, k);
      continue;
    }
    try {
      await store.save(id, project);
    } catch (e) {
      problems.push(`unsaved changes from your last visit couldn't be stored (${message(e)}); they are kept in this browser for the next visit`);
      continue;
    }
    remove(journal, k);
  }
  return problems;
}

function remove(journal: JournalStorage, key: string) {
  try {
    journal.removeItem(key);
  } catch {
    // left in place: put back again next visit, which writes the same state
  }
}
