// Deleting a sketch from the browser (step 24e4, the owner's rule from the
// reference app): a right-click on a sketch's row in the Sketches group, or
// its "⋯" button (for touch and the keyboard), opens a menu with Delete.
// A sketch no other item is built from goes at once, as one undo step; one
// that is used asks first, naming what is built from it and what happens
// to each: an extrude that keeps its last shape shows the warning, one with
// no shape to keep fails, and a sketch on one of its faces stays where it
// is with its plane lost (26c, Q1), and what is built from that sketch stays
// too with its source lost (26e); a sketch with a point snapped to one of
// its edges keeps that point where it is, saying it is lost (27c, the naming
// model's rule 13). What the box says is worked out from the very
// document the delete would record (`deleteItem`, then `settleKept`), so
// it can't promise a kept shape the rebuild then doesn't have.
// Styles: src/styles/delete-ask.css.

import type { KernelCalls } from "@fission/core";
import { isSketchExtrude, isSketchItem, type DesignDocument } from "./document.ts";
import { faceFeature, isFaceSketch } from "./face-sketch.ts";
import { settleKept } from "./rebuild.ts";
import { deleteItem, itemName } from "./timeline-edits.ts";

/** What the box asks before a used item is deleted. */
export interface DeleteQuestion {
  /** "Delete Sketch 1?" */
  heading: string;
  /** What is built from it and what happens to each, then that Undo brings it back. */
  words: string;
}

/** The document a confirmed delete records (kept shapes settled), and the question to ask first, or null when nothing is built from the item. */
export interface DeletePlan {
  next: DesignDocument;
  ask: DeleteQuestion | null;
}

/** "A", "A and B", "A, B and C". */
export function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The question for deleting item `id` from `before`, given `after`, the
 * document the delete records (kept shapes already settled): null when no
 * other item is built from it. An item built from it keeps its last shape
 * when `after` keeps one for it; otherwise it has none to keep and fails.
 * A sketch on one of its faces stays, held where it is (26c, Q1).
 */
export function deleteWords(before: DesignDocument, after: DesignDocument, id: string): DeleteQuestion | null {
  const item = before.timeline.features.find((f) => f.id === id);
  if (!item) throw new Error(`there is no item ${id} in the timeline`);
  const name = itemName(item);
  const users = before.timeline.features.filter((f) => f.dependsOn.includes(id));
  if (users.length === 0) return null;
  const keeps = users.filter((f) => isSketchExtrude(f) && after.kept !== undefined && Object.hasOwn(after.kept, f.id)).map(itemName);
  const staying = users.filter((f) => isFaceSketch(f) && faceFeature(f.intent.parameters.plane as string) === id);
  const stays = staying.map(itemName);
  // 27c and 27d (rule 13): a sketch only pinned to its edges, or projecting them, keeps those points and edges where they are.
  const holding = users.filter((f) => isSketchItem(f) && !staying.includes(f));
  const holds = holding.map(itemName);
  const content = (f: { id: string }) => before.sketches.find((s) => s.id === f.id);
  const pins = holding.some((f) => content(f)?.pins?.some((p) => p.feature === id));
  const projects = holding.some((f) => content(f)?.projected?.some((p) => p.feature === id));
  const held = pins && projects ? "snapped points and projected edges" : projects ? "projected edges" : "snapped points";
  // 26e (Q1): what is built from a sketch that stays stays with it, saying its source is lost.
  const built = before.timeline.features.filter((f) => isSketchExtrude(f) && staying.some((s) => f.dependsOn.includes(s.id))).map(itemName);
  const fails = users.map(itemName).filter((n) => !keeps.includes(n) && !stays.includes(n) && !holds.includes(n));
  const one = (n: readonly unknown[]) => n.length === 1;
  const what = [
    ...(keeps.length > 0 ? [`${listWords(keeps)} ${one(keeps) ? "keeps its last shape and shows a warning" : "keep their last shapes and show a warning"}`] : []),
    ...(stays.length > 0 ? [`${listWords(stays)} ${one(stays) ? "stays where it is and shows its plane is lost" : "stay where they are and show their planes are lost"}`] : []),
    ...(built.length > 0 ? [`what is built from ${one(stays) ? "it" : "them"}, ${listWords(built)}, ${one(built) ? "stays where it is and shows its source is lost" : "stay where they are and show their sources are lost"}`] : []),
    ...(holds.length > 0 ? [`${listWords(holds)} ${one(holds) ? `keeps its ${held} where they are and shows they are lost` : `keep their ${held} where they are and show they are lost`}`] : []),
    ...(fails.length > 0 ? [`${listWords(fails)} ${one(fails) ? "has no shape to keep and fails" : "have no shapes to keep and fail"}`] : []),
  ].join(", and ");
  const on =
    stays.length === users.length
      ? one(users)
        ? "is drawn on a face of"
        : "are drawn on faces of"
      : holds.length === users.length
        ? one(users)
          ? projects && !pins
            ? "projects an edge of"
            : "is snapped to an edge of"
          : projects && !pins
            ? "project edges of"
            : "are snapped to edges of"
        : one(users)
          ? "is built from"
          : "are built from";
  const usedBy = `${listWords(users.map(itemName))} ${on} ${name}.`;
  return { heading: `Delete ${name}?`, words: `${usedBy} If you delete it, ${what}. Undo brings ${name} back.` };
}

/** What deleting item `id` would record, and what to ask first (the kernel says which outlines close, for the kept shapes). */
export async function planDelete(kernel: KernelCalls, doc: DesignDocument, id: string): Promise<DeletePlan> {
  const next = await settleKept(kernel, doc, deleteItem(doc, id));
  return { next, ask: deleteWords(doc, next, id) };
}

/** An entry of the row menu (24f3: the timeline's item menu): its button is `row-menu-<action>`; an off one is shown greyed with why. */
export interface RowMenuEntry {
  action: string;
  label: string;
  off: string | null;
  run: () => void;
}

export interface DeleteAsk {
  /** Opens the row menu for item `name` ("Sketch 1") at a point on the screen with these entries; an entry's `run` runs on its button. */
  menu(name: string, at: { x: number; y: number }, entries: readonly RowMenuEntry[]): void;
  /** Opens the box asking `q`; `onConfirm` runs only on its Delete button. */
  ask(q: DeleteQuestion, onConfirm: () => void): void;
  /** Closes the menu and the box (a sketch started, Undo). */
  close(): void;
  /** Whether the menu or the box is open. */
  readonly open: "menu" | "ask" | null;
}

/**
 * The row menu and the box, both native modal dialogs in `slot`'s page (so
 * they sit above everything, the phone's browser drawer too). Cancel,
 * Escape or a click outside close either and nothing changes; keys pressed
 * in them never reach the app's shortcuts; the box's Cancel has the focus,
 * so Enter alone never deletes.
 */
export function deleteAsk(slot: HTMLElement): DeleteAsk {
  const document = slot.ownerDocument;
  const holder = document.createElement("div");
  holder.className = "delete-ask";
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string, text = "") => {
    const el = document.createElement(tag);
    el.id = id;
    el.textContent = text;
    return el;
  };
  const button = (id: string, text: string) => {
    const b = make("button", id, text);
    b.type = "button";
    return b;
  };

  const menu = make("dialog", "row-menu");
  menu.className = "delete-ask-menu";
  menu.setAttribute("role", "menu");

  const box = make("dialog", "delete-ask");
  box.className = "delete-ask-box";
  box.setAttribute("aria-labelledby", "delete-ask-heading");
  box.setAttribute("aria-describedby", "delete-ask-words");
  const heading = make("h2", "delete-ask-heading");
  const words = make("p", "delete-ask-words");
  const actions = document.createElement("div");
  actions.className = "delete-ask-actions";
  const cancel = button("delete-ask-cancel", "Cancel");
  const go = button("delete-ask-confirm", "Delete");
  actions.append(cancel, go);
  box.append(heading, words, actions);
  holder.append(menu, box);
  slot.append(holder);

  let onConfirm = () => {};
  const shut = (d: HTMLDialogElement) => {
    if (d.open) d.close();
  };
  const show = (d: HTMLDialogElement) => {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  };
  for (const d of [menu, box]) {
    // A click on the backdrop (outside the box) is a cancel.
    d.addEventListener("click", (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      const { clientX: x, clientY: y } = e as MouseEvent;
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) shut(d);
    });
    // The app's shortcuts listen on the document: keep these keys to the dialog (Escape closes it).
    d.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") {
        e.preventDefault();
        shut(d);
      }
      e.stopPropagation();
    });
    // A right-click inside is not the page's own menu.
    d.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  cancel.addEventListener("click", () => shut(box));
  go.addEventListener("click", () => {
    shut(box);
    onConfirm();
  });

  return {
    menu(name, at, entries) {
      shut(box);
      menu.setAttribute("aria-label", name);
      menu.replaceChildren(
        ...entries.map((e) => {
          const b = button(`row-menu-${e.action}`, e.label);
          b.setAttribute("role", "menuitem");
          // "Edit feature" reads "Edit Extrude 1" (25a2), "Edit Sketch" "Edit Sketch 1" (25a3); "Move the marker here", "Move the marker to just after Sketch 1".
          b.setAttribute("aria-label", e.action === "edit" || e.action === "edit-sketch" ? `Edit ${name}` : `${e.label.replace(" here", "")}${e.action === "marker" ? " to just after" : ""} ${name}`);
          if (e.off !== null) {
            // Greyed, with why under its words (a phone shows no tooltip).
            b.disabled = true;
            b.title = e.off;
            const why = document.createElement("span");
            why.className = "delete-ask-off";
            why.textContent = e.off;
            b.append(why);
          }
          b.addEventListener("click", () => {
            shut(menu);
            e.run();
          });
          return b;
        }),
      );
      show(menu);
      // At the pointer, kept on the screen.
      const view = document.defaultView;
      const w = view?.innerWidth ?? 0;
      const h = view?.innerHeight ?? 0;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(at.x, w - r.width))}px`;
      menu.style.top = `${Math.max(0, Math.min(at.y, h - r.height))}px`;
      menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    },
    ask(q, run) {
      shut(menu);
      onConfirm = run;
      heading.textContent = q.heading;
      words.textContent = q.words;
      show(box);
      cancel.focus();
    },
    close() {
      shut(menu);
      shut(box);
    },
    get open() {
      return menu.open ? "menu" : box.open ? "ask" : null;
    },
  };
}
