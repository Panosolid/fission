// The Edit feature panel (step 25a2, feature-edit.ts), at the top of the
// properties: the item's name, a box for each size its shape uses with the
// value it has now, the kernel's refusal, and OK or Cancel. Enter in a box
// is OK; Escape is Cancel (workspace.ts `shortcut`). The workspace drives
// it; the panel only shows what it is given and reports what was typed and
// clicked. Styles: src/styles/feature-edit.css.

import type { EditableFeature } from "./feature-edit.ts";
import { parameterRows, type SizeKey } from "./properties.ts";

export interface FeatureEditEvents {
  /** OK (or Enter), with each shown box as typed. */
  ok(typed: Partial<Record<SizeKey, string>>): void;
  cancel(): void;
}

export interface FeatureEditPanel {
  /** Opens the panel on this item, its boxes filled with its sizes now, the first box focused. */
  show(f: EditableFeature): void;
  /** Why OK recorded nothing ("" hides it). */
  showError(message: string): void;
  /** OK off while the kernel checks the sizes, so a second press can't record twice. */
  busy(on: boolean): void;
  hide(): void;
  /** The item open in the panel, or null when it is closed. */
  readonly editing: string | null;
}

export function featureEditPanel(slot: HTMLElement, on: FeatureEditEvents): FeatureEditPanel {
  const document = slot.ownerDocument;
  const box = document.createElement("section");
  box.className = "feature-edit";
  box.id = "feature-edit"; // the ids are read by the e2e test
  box.setAttribute("aria-label", "Edit feature");
  box.hidden = true;
  slot.prepend(box);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, id = "", className = "", text = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  };
  let editing: string | null = null;
  let error: HTMLElement | null = null;
  let ok: HTMLButtonElement | null = null;
  let inputs: [SizeKey, HTMLInputElement][] = [];
  const typed = () => Object.fromEntries(inputs.map(([k, i]) => [k, i.value])) as Partial<Record<SizeKey, string>>;
  return {
    show(f) {
      editing = f.id;
      const rows = parameterRows(f.shape).filter((r) => r.shown);
      inputs = [];
      const labels = rows.map((r) => {
        const input = el("input", `edit-${r.key}`);
        Object.assign(input, { type: "number", step: "any", value: String(f.sizes[r.key] ?? "") });
        // Enter in a box is OK, as in any dialog.
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && ok && !ok.disabled) on.ok(typed());
        });
        inputs.push([r.key, input]);
        const label = el("label", "", "feature-edit-row");
        // A sketch extrude's one size is its distance; the main panel calls the same box "Extrude by".
        label.append(`${f.shape === "sketch-extrude" ? "Distance" : r.label} `, input, " mm");
        return label;
      });
      error = el("p", "feature-edit-error", "bad");
      error.hidden = true;
      error.setAttribute("role", "alert");
      ok = el("button", "feature-edit-ok", "", "OK");
      ok.type = "button";
      ok.addEventListener("click", () => on.ok(typed()));
      const cancel = el("button", "feature-edit-cancel", "", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => on.cancel());
      const buttons = el("div", "", "feature-edit-buttons");
      buttons.append(ok, cancel);
      const title = el("h2", "feature-edit-title", "", `Edit ${f.name}`);
      const note = el("p", "", "feature-edit-note", "Everything after it in the timeline is built again.");
      box.replaceChildren(title, ...labels, error, note, buttons);
      box.hidden = false;
      inputs[0]?.[1].focus();
      inputs[0]?.[1].select();
    },
    showError(message) {
      if (!error) return;
      error.textContent = message;
      error.hidden = message === "";
    },
    busy(on) {
      if (ok) ok.disabled = on;
    },
    hide() {
      editing = null;
      box.hidden = true;
      box.replaceChildren();
      error = ok = null;
      inputs = [];
    },
    get editing() {
      return editing;
    },
  };
}
