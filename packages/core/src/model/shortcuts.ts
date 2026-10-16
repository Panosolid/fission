// The one shortcut table (X7b, docs/integration.md: shortcuts behave the same
// in every workspace). The shell's own keys and each workspace's keys live in
// one table; the shell turns a key press into a chord, looks the chord up for
// the workspaces on screen and runs what it finds. A workspace never listens
// to the keyboard itself, so a sleeping workspace can't hear a key.
//
// Each workspace binds the keys its own users already know, so the same key
// may mean different things in two workspaces (in split view the pane last
// clicked or focused gets it). What may not happen is checked by `clashes`:
// one key twice in one scope, a workspace key that the shell also uses, or a
// key the browser keeps for itself.

import type { WorkspaceId } from "./project.ts";

/**
 * A key press written as text, modifiers first in a fixed order:
 * "Mod+Shift+Z", "Escape", "?". Mod is Ctrl, or Cmd on a Mac (either one
 * counts, so one table serves both). Letters are capitals; Shift is never
 * written with a symbol, since the symbol already says it ("?", not "Shift+/").
 */
export type Chord = string;

/** One shortcut as a workspace or the shell declares it. */
export interface ShortcutSpec {
  /** Unique within its scope; what the handler is asked to run. */
  id: string;
  /** The chord, in any modifier order or case ("shift+mod+z" is "Mod+Shift+Z"). */
  keys: string;
  /** What it does, as the help list says it ("Clear the selection"). */
  label: string;
  /** Also fires while typing in a text field. Off by default, so typing is never taken over. */
  inText?: boolean;
}

export type ShortcutScope = "app" | WorkspaceId;

export interface ShortcutEntry extends ShortcutSpec {
  scope: ShortcutScope;
  chord: Chord;
}

export interface ShortcutClash {
  kind: "duplicate-key" | "duplicate-id" | "shadows-app" | "browser-reserved";
  chord: Chord;
  /** The entries involved (one for browser-reserved). */
  entries: ShortcutEntry[];
  /** The clash in words, for a test failure or a developer. */
  message: string;
}

const MODIFIERS = ["Mod", "Alt", "Shift"] as const;
const NAMED_KEYS = new Set([
  "Escape", "Enter", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
/** Shift is part of these keys' meaning (Shift+Tab, Shift+Arrow), unlike a symbol's. */
const isPrintable = (key: string) => key.length === 1;

/**
 * Keys a page never reliably gets: the browser acts on them first (new
 * window, close tab, address bar…). A shortcut on one would never fire.
 */
export const BROWSER_RESERVED: readonly Chord[] = ["Mod+N", "Mod+Shift+N", "Mod+T", "Mod+Shift+T", "Mod+W", "Mod+Shift+W", "Mod+Q", "Mod+L", "Mod+Tab", "Mod+Shift+Tab", "F5", "F11", "F12"];

/**
 * Copy, cut and paste arrive as clipboard events, so the browser's Edit menu
 * runs the same shortcut as the keys. The shell dispatches these chords from
 * those events only, never from the key press, so nothing runs twice.
 */
export const CLIPBOARD_CHORDS = { copy: "Mod+C", cut: "Mod+X", paste: "Mod+V" } as const satisfies Record<string, Chord>;

/** The shell's own keys: they work in every workspace, so no workspace may bind them too. */
export const SHELL_SHORTCUTS: readonly ShortcutSpec[] = [
  { id: "shortcuts", keys: "?", label: "Show the keyboard shortcuts" },
  // Paste (the keys or the browser's Edit menu) with files on the clipboard; text pastes as usual.
  { id: "paste-files", keys: "Mod+V", label: "Paste files into the project (a project file, an image…)" },
  // Undo and redo the project (step 20b); in a text field the browser's own undo of the typing runs instead.
  { id: "undo", keys: "Mod+Z", label: "Undo" },
  { id: "redo", keys: "Mod+Shift+Z", label: "Redo" },
  { id: "redo-y", keys: "Mod+Y", label: "Redo" },
];

/** Writes `keys` in the one canonical form; throws a clear error for anything that isn't a key a user can press. */
export function parseChord(keys: string): Chord {
  const parts = keys.split("+");
  // "Mod++" is Mod and the plus key: an empty part before a trailing empty one.
  if (parts.length > 1 && parts.at(-1) === "" && parts.at(-2) === "") parts.splice(-2, 2, "+");
  const raw = parts.at(-1)!;
  if (raw === "") throw new Error(`"${keys}" has no key after its modifiers`);
  const mods = new Set<string>();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS.find((x) => x.toLowerCase() === p.toLowerCase());
    if (!m) throw new Error(`"${keys}": "${p}" is not a modifier (Mod, Alt or Shift)`);
    if (mods.has(m)) throw new Error(`"${keys}" names ${m} twice`);
    mods.add(m);
  }
  const key = canonicalKey(raw);
  if (!key) throw new Error(`"${keys}": "${raw}" is not a key`);
  if (isPrintable(key) && !/[A-Z]/.test(key) && mods.has("Shift"))
    throw new Error(`"${keys}": write the character Shift gives instead of Shift+${key} (keyboards differ)`);
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join("+");
}

function canonicalKey(raw: string): string | null {
  if (raw === " " || raw.toLowerCase() === "space") return "Space";
  if (raw.length === 1) return /\s/.test(raw) ? null : raw.toUpperCase();
  const named = [...NAMED_KEYS].find((k) => k.toLowerCase() === raw.toLowerCase());
  if (named) return named;
  if (raw.toLowerCase() === "esc") return "Escape";
  return null;
}

/** The parts of a KeyboardEvent a chord is made from. */
export interface KeyPress {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The chord a key press makes, or null for a press that can't be one (a
 * modifier on its own, a dead key, an IME composition). With Mod or Alt held
 * a letter or digit is read from its key position when the key itself is
 * some other character (Alt+C gives "ç" on a Mac; non-Latin layouts).
 */
export function chordOf(e: KeyPress): Chord | null {
  let key = e.key;
  if ((e.ctrlKey || e.metaKey || e.altKey) && !/^[a-z0-9]$/i.test(key)) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code ?? "");
    if (m) key = m[1] ?? m[2];
  }
  const k = canonicalKey(key);
  if (!k) return null;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  // A symbol already carries its Shift ("?" is Shift+/ on one keyboard, not on another).
  if (e.shiftKey && !(isPrintable(k) && !/[A-Z]/.test(k))) mods.push("Shift");
  return [...mods, k].join("+");
}

/** A workspace's part of the table: its id and the keys it binds. */
export interface ShortcutSource {
  id: WorkspaceId;
  shortcuts?: readonly ShortcutSpec[];
}

/**
 * Every shortcut in the app: the shell's ("app") and each workspace's.
 * Building it throws on a chord that doesn't parse; `clashes` lists what
 * would make a key do the wrong thing (a test keeps the real table clean).
 */
export class ShortcutTable {
  readonly entries: readonly ShortcutEntry[];

  constructor(app: readonly ShortcutSpec[], workspaces: readonly ShortcutSource[]) {
    const entry = (scope: ShortcutScope) => (s: ShortcutSpec): ShortcutEntry => {
      try {
        return { ...s, scope, chord: parseChord(s.keys) };
      } catch (e) {
        throw new Error(`Shortcut ${scope}/${s.id}: ${(e as Error).message}`);
      }
    };
    this.entries = [...app.map(entry("app")), ...workspaces.flatMap((w) => (w.shortcuts ?? []).map(entry(w.id)))];
  }

  /** The entries in `scope`, in the order declared. */
  of(scope: ShortcutScope): ShortcutEntry[] {
    return this.entries.filter((e) => e.scope === scope);
  }

  /**
   * What `chord` runs with `onScreen` shown, the pane in use first: the first
   * of those workspaces binding it, else the shell's own. Only that one: a
   * workspace that declines a key (nothing to copy) does not pass it on.
   */
  lookup(chord: Chord, onScreen: readonly WorkspaceId[]): ShortcutEntry | null {
    for (const scope of [...onScreen, "app"]) {
      const hit = this.entries.find((e) => e.scope === scope && e.chord === chord);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The help list's order: the workspaces on screen (the pane in use first),
   * then the app's own keys, then every other workspace that has keys.
   * Scopes with no keys are left out.
   */
  help(onScreen: readonly WorkspaceId[]): { scope: ShortcutScope; onScreen: boolean; entries: ShortcutEntry[] }[] {
    const rest = [...new Set(this.entries.map((e) => e.scope))].filter((s) => s !== "app" && !onScreen.includes(s as WorkspaceId));
    return [...onScreen, "app" as const, ...rest]
      .map((scope) => ({ scope, onScreen: scope !== "app" && onScreen.includes(scope as WorkspaceId), entries: this.of(scope) }))
      .filter((s) => s.entries.length > 0);
  }

  /** Everything that would make a key do the wrong thing; empty when the table is sound. */
  clashes(): ShortcutClash[] {
    const out: ShortcutClash[] = [];
    const name = (e: ShortcutEntry) => `${e.scope}/${e.id}`;
    const seen = new Map<string, ShortcutEntry>();
    const ids = new Map<string, ShortcutEntry>();
    for (const e of this.entries) {
      const at = `${e.scope} ${e.chord}`;
      const first = seen.get(at);
      if (first) out.push({ kind: "duplicate-key", chord: e.chord, entries: [first, e], message: `${e.chord} is both ${name(first)} and ${name(e)}` });
      else seen.set(at, e);
      const sameId = ids.get(`${e.scope} ${e.id}`);
      if (sameId) out.push({ kind: "duplicate-id", chord: e.chord, entries: [sameId, e], message: `${name(e)} is declared twice` });
      else ids.set(`${e.scope} ${e.id}`, e);
      if (BROWSER_RESERVED.includes(e.chord)) out.push({ kind: "browser-reserved", chord: e.chord, entries: [e], message: `${name(e)} uses ${e.chord}, which the browser keeps for itself` });
    }
    // A workspace key the shell also uses: the workspace would take it while
    // shown and the shell's would silently stop working there.
    for (const a of this.of("app"))
      for (const w of this.entries)
        if (w.scope !== "app" && w.chord === a.chord)
          out.push({ kind: "shadows-app", chord: a.chord, entries: [a, w], message: `${name(w)} takes ${a.chord} from the app's ${a.id}` });
    return out;
  }
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
/** A chord as the user reads it on this machine: Ctrl+Shift+Z, or ⌘⇧Z on a Mac. */
export function chordLabel(chord: Chord, mac: boolean): string {
  const parts = chord === "+" ? ["+"] : chord.split(/\+(?!$)/);
  return parts.map((p) => (p === "Escape" ? "Esc" : mac ? (MAC_SYMBOLS[p] ?? p) : p === "Mod" ? "Ctrl" : p)).join(mac ? "" : "+");
}
