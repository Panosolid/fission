// The properties panel folding away (U0b, the owner's ask of 2026-10-24):
// Fusion keeps no panel open beside the view, so on a wide screen Design's
// panel is folded to one small "Properties" button until it is needed.
// It opens by itself while something is selected or a tool's box is in it
// (Create sketch, Extrude, Edit feature), and when something the user just
// did has words in it they must see (an action's note, a failed rebuild);
// it folds again once those end. The button opens and keeps it open
// (pinned) until the user folds it. Phones and split view keep their own
// panel layout (theme.css); the CSS is src/styles/properties-fold.css.

import { WORDS_EVENT } from "./properties.ts";

/** Why the panel might be shown: kept open by the user, something selected, a tool's box in it. */
export interface FoldReasons {
  pinned: boolean;
  selected: boolean;
  tool: boolean;
}

/** The fold's whole state: the reasons, and the two one-off overrides. */
export interface FoldState extends FoldReasons {
  /** Folded by the user while a selection or a tool held it open: stays folded until either changes. */
  dismissed: boolean;
  /** Opened for words the user must see: stays open until the user folds it or the selection or tool changes. */
  revealed: boolean;
}

export const FOLDED_AT_START: FoldState = { pinned: false, selected: false, tool: false, dismissed: false, revealed: false };

/** Whether the panel shows in this state. */
export const panelShown = (s: FoldState): boolean => s.pinned || s.revealed || ((s.selected || s.tool) && !s.dismissed);

/**
 * The state after the selection or the tool changes: a change of either
 * ends a dismissal and a reveal (the user has moved on), so the panel
 * follows the new reasons.
 */
export function withReasons(s: FoldState, next: Partial<Pick<FoldReasons, "selected" | "tool">>): FoldState {
  const selected = next.selected ?? s.selected;
  const tool = next.tool ?? s.tool;
  if (selected === s.selected && tool === s.tool) return s;
  return { ...s, selected, tool, dismissed: false, revealed: false };
}

/** The state after the user presses the panel's button: a folded panel opens and stays (pinned); an open one folds, whatever held it. */
export function pressed(s: FoldState): FoldState {
  return panelShown(s) ? { ...s, pinned: false, revealed: false, dismissed: true } : { ...s, pinned: true, dismissed: false };
}

/** The state after words the user must see land in a folded panel: it opens until the user moves on. */
export const revealed = (s: FoldState): FoldState => (panelShown(s) ? s : { ...s, revealed: true });

/** Where the user's pin is kept in the browser, so a pinned panel stays pinned after a reload. */
export const PIN_KEY = "fission.properties-pinned";
/** The part of localStorage the pin uses (any of it may throw: storage off, private mode, full). */
export type PinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** The browser's storage, or none when even reaching it throws (a sandboxed frame). */
const browserStorage = (): PinStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

/** Whether the user left the panel pinned; storage that can't be read keeps it folded. */
export function readPinned(storage: PinStorage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(PIN_KEY) === "true";
  } catch {
    return false;
  }
}

/** Keeps the pin for the next visit; storage that refuses it only loses that (the panel still works). */
export function writePinned(pinned: boolean, storage: PinStorage | null = browserStorage()): void {
  try {
    if (pinned) storage?.setItem(PIN_KEY, "true");
    else storage?.removeItem(PIN_KEY);
  } catch {
    // Nothing kept: the next visit starts folded.
  }
}

export const HANDLE_ID = "properties-handle";
const OPEN_WORDS = "Properties ‹";
const FOLD_WORDS = "Fold ›";

export interface PropertiesFold {
  readonly state: FoldState;
  /** The selection or the tool changed. */
  update(next: Partial<Pick<FoldReasons, "selected" | "tool">>): void;
  /** Opens a folded panel until the user moves on (`revealed`): a body just inserted shows its sizes (U0d). */
  reveal(): void;
  /** Stops watching the tool boxes and takes the fold off the slot (its class, its folded and ⚠ marks, the button). */
  close(): void;
}

/**
 * Folds `slot` (the properties slot) and puts its button first in it; the
 * tool boxes (`toolBoxes`, the sections a tool shows and hides with their
 * `hidden`) are watched, so the panel opens while any is shown. `initial`
 * is the state a remount keeps (the user's pin survives Undo); the pin is
 * also kept in `storage` for the next visit (`readPinned`).
 */
export function propertiesFold(slot: HTMLElement, toolBoxes: readonly HTMLElement[], initial: FoldState = FOLDED_AT_START, storage: PinStorage | null = browserStorage()): PropertiesFold {
  const document = slot.ownerDocument;
  let state = initial;
  slot.classList.add("properties-fold");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.id = HANDLE_ID; // read by the e2e test
  handle.className = "properties-fold-handle";
  handle.setAttribute("aria-controls", slot.id);
  slot.prepend(handle);
  function draw() {
    const shown = panelShown(state);
    if (shown) delete slot.dataset.folded;
    else slot.dataset.folded = "";
    handle.textContent = shown ? FOLD_WORDS : OPEN_WORDS;
    handle.setAttribute("aria-expanded", String(shown));
    handle.title = shown ? "Fold the properties away, giving the view the whole width" : "Show the properties (the selection, the part's sizes, the body's numbers) and keep them shown";
  }
  const toolShown = () => toolBoxes.some((b) => !b.hidden);
  // The slot's own page's MutationObserver (a test's DOM has its own).
  const Observer = document.defaultView?.MutationObserver ?? MutationObserver;
  const watch = new Observer(() => set(withReasons(state, { tool: toolShown() })));
  for (const box of toolBoxes) watch.observe(box, { attributes: true, attributeFilter: ["hidden"] });
  function set(next: FoldState) {
    if (next === state) return;
    state = next;
    draw();
  }
  handle.addEventListener("click", () => {
    set(pressed(state));
    writePinned(state.pinned, storage);
  });
  const onWords = () => set(revealed(state));
  slot.addEventListener(WORDS_EVENT, onWords);
  state = withReasons(state, { tool: toolShown() });
  draw();
  return {
    get state() {
      return state;
    },
    update: (next) => set(withReasons(state, next)),
    reveal: onWords,
    // The slot is shared with the next workspace (Image shows its page in it): leave it as it was found.
    close: () => {
      watch.disconnect();
      slot.removeEventListener(WORDS_EVENT, onWords);
      slot.classList.remove("properties-fold");
      delete slot.dataset.folded;
      delete slot.dataset.problem;
      handle.remove();
    },
  };
}
