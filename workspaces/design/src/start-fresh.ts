// Start fresh: the design cleared back to the one a new project opens with,
// as one undo step, after asking. Every sketch, feature, profile and kept
// shape goes; what is left is the starting box (the panel's default sizes),
// since Design always shows a part until it can show a design with no body
// (a file with nothing built is still refused, docs/progress/cad.md 24e).
// The workspace runs it from the toolbar's Start fresh button (workspace.ts);
// the dialog asks first, says what goes, and that Undo brings it back.
// Styles: src/styles/start-fresh.css.

import { isSketchItem, partDocument, type DesignDocument } from "./document.ts";
import { DEFAULT_SIZES } from "./properties.ts";

/** The undo step Start fresh is recorded as. */
export const START_FRESH_STEP = "Start fresh";

/** The design a new project opens with: the box at the panel's default sizes (40 × 30 × 20 mm). */
export function freshDesign(): DesignDocument {
  return partDocument("box", Number(DEFAULT_SIZES.width), Number(DEFAULT_SIZES.depth), Number(DEFAULT_SIZES.height));
}

/** The same plain data, key order aside (a document read from a file can list its keys in another order). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Whether the design is already the fresh one, so Start fresh would change nothing (and records no step). */
export function isFresh(doc: DesignDocument): boolean {
  return same(doc, freshDesign());
}

/** The fresh box's sizes as the dialog says them: "40 × 30 × 20". */
export const FRESH_SIZES = `${DEFAULT_SIZES.width} × ${DEFAULT_SIZES.depth} × ${DEFAULT_SIZES.height}`;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What Start fresh clears, in words for the dialog: "2 sketches and 3 features", "1 feature". */
export function clearedWords(doc: DesignDocument): string {
  const sketches = doc.timeline.features.filter(isSketchItem).length;
  const features = doc.timeline.features.length - sketches;
  const parts = [...(sketches > 0 ? [count(sketches, "sketch", "sketches")] : []), count(features, "feature", "features")];
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
export const ALREADY_FRESH_TITLE = "Nothing to clear: this is the design a new project starts with.";

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
    words.textContent = `This clears everything in the design (${clearedWords(doc)}) and starts again from the ${FRESH_SIZES} mm box a new design opens with. Undo brings it all back.`;
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
