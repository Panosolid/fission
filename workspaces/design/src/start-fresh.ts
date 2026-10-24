// Start fresh: the design cleared back to the empty one a new project
// opens with (U0c), as one undo step, after asking. Every sketch, feature,
// profile and kept shape goes. The workspace runs it from the toolbar's
// Start fresh button (workspace.ts); the dialog asks first, says what goes,
// and that Undo brings it back. Styles: src/styles/start-fresh.css.

import { isSketchItem, type DesignDocument } from "./document.ts";

/** The undo step Start fresh is recorded as. */
export const START_FRESH_STEP = "Start fresh";

/** The design a new project opens with (U0c, the owner's ask): nothing in it, the id counter at 1. */
export function freshDesign(): DesignDocument {
  return { version: 3, nextId: 1, profiles: [], sketches: [], timeline: { features: [] } };
}

/**
 * Whether the design has nothing in it, so Start fresh would clear nothing
 * (and records no step): no timeline item, sketch, ready-made profile or
 * kept shape. The id counter and the marker don't count: a design whose
 * last body was deleted is as empty as a fresh one, and clearing it would
 * change nothing anyone can see.
 */
export function isFresh(doc: DesignDocument): boolean {
  return doc.timeline.features.length === 0 && doc.sketches.length === 0 && doc.profiles.length === 0 && Object.keys(doc.kept ?? {}).length === 0;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What Start fresh clears, in words for the dialog: "2 sketches and 3 features", "1 feature". */
export function clearedWords(doc: DesignDocument): string {
  const sketches = doc.timeline.features.filter(isSketchItem).length;
  const features = doc.timeline.features.length - sketches;
  const parts = [...(sketches > 0 ? [count(sketches, "sketch", "sketches")] : []), ...(features > 0 || sketches === 0 ? [count(features, "feature", "features")] : [])];
  return parts.join(" and ");
}

export interface StartFresh {
  /** The toolbar's button. */
  button: HTMLButtonElement;
  /** Turns the button on, or off with the reason as its tooltip, for this design. */
  showFor(doc: DesignDocument): void;
  /** Opens the dialog for this design; `confirm` runs only on its Start fresh button. */
  ask(doc: DesignDocument): void;
  /** Whether the dialog is open. */
  readonly open: boolean;
}

export const START_FRESH_TITLE = "Clear the whole design and start again from a new one. It asks first, and Undo brings it back.";
export const ALREADY_FRESH_TITLE = "Nothing to clear: the design is already empty.";

/**
 * The Start fresh button and its dialog, in the toolbar slot's page. The
 * dialog is modal (native <dialog>): Cancel, Escape or a click outside it
 * close it and nothing changes; keys pressed in it never reach the app's
 * shortcuts, so a sketch tool key can't act behind it. Cancel has the
 * focus, so Enter on its own never clears a design.
 */
export function startFresh(slot: HTMLElement, events: { current(): DesignDocument; confirm(): void }): StartFresh {
  const document = slot.ownerDocument;
  const group = document.createElement("div");
  group.className = "tool-group start-fresh";
  group.dataset.modelling = ""; // hidden while a sketch is edited, as the other modelling buttons are
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Design");
  const name = document.createElement("span");
  name.className = "tool-group-name";
  name.textContent = "Design";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "start-fresh";
  button.textContent = "Start fresh";
  button.title = START_FRESH_TITLE;
  group.append(name, button);

  const dialog = document.createElement("dialog");
  dialog.id = "start-fresh-dialog";
  dialog.setAttribute("aria-labelledby", "start-fresh-heading");
  dialog.setAttribute("aria-describedby", "start-fresh-words");
  const heading = document.createElement("h2");
  heading.id = "start-fresh-heading";
  heading.textContent = "Start fresh?";
  const words = document.createElement("p");
  words.id = "start-fresh-words";
  const actions = document.createElement("div");
  actions.className = "start-fresh-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "start-fresh-cancel";
  cancel.textContent = "Cancel";
  const go = document.createElement("button");
  go.type = "button";
  go.id = "start-fresh-confirm";
  go.textContent = "Start fresh";
  actions.append(cancel, go);
  dialog.append(heading, words, actions);
  group.append(dialog);
  slot.append(group);

  const close = () => {
    if (dialog.open) dialog.close();
  };
  cancel.addEventListener("click", close);
  go.addEventListener("click", () => {
    close();
    events.confirm();
  });
  // A click on the backdrop (outside the box) is a cancel.
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const { clientX: x, clientY: y } = e as MouseEvent;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) close();
  });
  // The app's shortcuts listen on the document: keep this dialog's keys to itself (Escape still closes it, natively).
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });

  const ask = (doc: DesignDocument) => {
    words.textContent = `This clears everything in the design (${clearedWords(doc)}) and starts again from an empty design, as a new project opens. Undo brings it all back.`;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    cancel.focus();
  };
  button.addEventListener("click", () => {
    const doc = events.current();
    if (!isFresh(doc)) ask(doc);
  });

  return {
    button,
    showFor(doc) {
      const fresh = isFresh(doc);
      button.disabled = fresh;
      button.title = fresh ? ALREADY_FRESH_TITLE : START_FRESH_TITLE;
    },
    ask,
    get open() {
      return dialog.open;
    },
  };
}
