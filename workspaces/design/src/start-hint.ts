// The hint an empty design shows in the 3D view (U0c, the owner's ask: a
// new project starts empty, with a little prompt you can ✕ away): what to
// do first, as three buttons doing what the toolbar and the top bar do
// (Create sketch, Insert a preset, Open a project), and ✕. It shows while
// the design has nothing in it and no sketch is being started; once
// closed it stays closed until the page is loaded again. `hintShown` is
// the rule, a pure function tested by hand; `startHint` the card.
// Styles: src/styles/start-hint.css.

import type { DesignDocument } from "./document.ts";
import { isFresh } from "./start-fresh.ts";

export const START_HINT_WORDS = "Start your design";
export const START_HINT_TITLE = "A new design is empty: sketch an outline and extrude it, add a ready-made shape, or open a project you saved.";

/** Whether the hint shows: an empty design (`isFresh`), not being sketched on, and not closed. */
export function hintShown(doc: DesignDocument | undefined, sketching: boolean, closed: boolean): boolean {
  return doc !== undefined && isFresh(doc) && !sketching && !closed;
}

export interface StartHintActions {
  sketch(): void;
  insert(): void;
  /** Left out where the app can't open a file from here (no button then). */
  open?: () => void;
}

export interface StartHint {
  readonly element: HTMLElement;
  /** Shows or hides it for this design. */
  update(doc: DesignDocument | undefined, sketching: boolean): void;
  readonly closed: boolean;
}

/** Closed by ✕ in this page: a hint the user put away stays away across Undo, switching and Start fresh. */
const PAGE = { closed: false };

/** The hint card in `host` (the 3D view); `memory` holds whether it was closed (a test gives its own). */
export function startHint(host: HTMLElement, actions: StartHintActions, memory: { closed: boolean } = PAGE): StartHint {
  const doc = host.ownerDocument;
  const el = doc.createElement("section");
  el.className = "start-hint";
  el.id = "start-hint"; // read by the e2e test
  el.setAttribute("aria-labelledby", "start-hint-words");
  el.title = START_HINT_TITLE;
  el.hidden = true;
  const words = doc.createElement("h2");
  words.id = "start-hint-words";
  words.textContent = START_HINT_WORDS;
  const close = doc.createElement("button");
  close.type = "button";
  close.id = "start-hint-close";
  close.className = "start-hint-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", "Close this hint");
  close.title = "Close this hint";
  const row = doc.createElement("div");
  row.className = "start-hint-actions";
  const button = (id: string, label: string, title: string, run: () => void) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.id = id;
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", run);
    row.append(b);
  };
  button("start-hint-sketch", "Create sketch", "Draw an outline on a plane, then Extrude it into a solid.", actions.sketch);
  button("start-hint-insert", "Insert a preset", "Add a ready-made shape (a box, a cylinder, a bracket…) as a new body.", actions.insert);
  if (actions.open) button("start-hint-open", "Open a project", "Open a project you saved as a file.", actions.open);
  el.append(words, close, row);
  host.append(el);

  let last: { doc: DesignDocument | undefined; sketching: boolean } = { doc: undefined, sketching: false };
  const api: StartHint = {
    element: el,
    update(d, sketching) {
      last = { doc: d, sketching };
      el.hidden = !hintShown(d, sketching, memory.closed);
    },
    get closed() {
      return memory.closed;
    },
  };
  close.addEventListener("click", () => {
    memory.closed = true;
    api.update(last.doc, last.sketching);
  });
  return api;
}
