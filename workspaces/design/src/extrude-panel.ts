// The Extrude panel (step 21d), at the top of the properties: which sketch,
// how far (typeable), whether that sketch makes a closed outline or the
// kernel's reason it doesn't, and OK or Cancel. OK stays off until the
// kernel says the outline is closed. The workspace drives it; the panel
// only shows what it is given and reports what was typed and clicked.
// Styles: src/styles/extrude.css.

export interface ExtrudePanelEvents {
  /** Another sketch chosen. */
  sketch(id: string): void;
  /** OK, with the distance as typed. */
  ok(distance: string): void;
  cancel(): void;
}

export interface ExtrudePanel {
  /** The sketches to choose from (by name, in timeline order), the one chosen, and the distance as typed. */
  show(sketches: readonly { id: string; label: string }[], chosen: string | null, distance: string): void;
  /** Whether the chosen sketch can be extruded, in words; OK follows it. */
  showStatus(text: string, closed: boolean): void;
  /** Why OK did nothing (a distance the kernel refused); empty hides it. */
  showError(message: string): void;
  hide(): void;
  readonly shown: boolean;
}

export function extrudePanel(slot: HTMLElement, on: ExtrudePanelEvents): ExtrudePanel {
  const document = slot.ownerDocument;
  const box = document.createElement("section");
  box.className = "extrude";
  box.id = "extrude-panel"; // the ids are read by the e2e test
  box.setAttribute("aria-label", "Extrude");
  box.hidden = true;
  slot.prepend(box);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, id = "", className = "", text = ""): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (id) e.id = id;
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  };
  let status: HTMLElement | null = null;
  let error: HTMLElement | null = null;
  let ok: HTMLButtonElement | null = null;
  return {
    show(sketches, chosen, distance) {
      const select = el("select", "extrude-sketch");
      for (const s of sketches) {
        const option = el("option", "", "", s.label);
        option.value = s.id;
        option.selected = s.id === chosen;
        select.append(option);
      }
      select.disabled = sketches.length === 0;
      select.addEventListener("change", () => on.sketch(select.value));
      const input = el("input", "extrude-distance");
      Object.assign(input, { type: "number", step: "any", value: distance });
      // Enter in the box is OK, as in any dialog.
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && ok && !ok.disabled) on.ok(input.value);
      });
      const sketchRow = el("label", "", "extrude-row");
      sketchRow.append("Sketch ", select);
      const distanceRow = el("label", "", "extrude-row");
      distanceRow.append("Distance ", input, " mm");
      status = el("p", "extrude-status", "extrude-status");
      error = el("p", "extrude-error", "bad");
      error.hidden = true;
      ok = el("button", "extrude-ok", "", "OK");
      ok.type = "button";
      ok.disabled = true; // until the kernel says the outline is closed
      ok.addEventListener("click", () => on.ok(input.value));
      const cancel = el("button", "extrude-cancel", "", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => on.cancel());
      const buttons = el("div", "", "extrude-buttons");
      buttons.append(ok, cancel);
      box.replaceChildren(
        el("h2", "", "", "Extrude"),
        sketchRow,
        distanceRow,
        status,
        error,
        el("p", "", "extrude-note", "The extrude is a new body, put in the timeline at the marker."),
        buttons,
      );
      if (sketches.length === 0) this.showStatus("There is no sketch to extrude yet: draw one with Create sketch.", false);
      box.hidden = false;
    },
    showStatus(text, closed) {
      if (status) status.textContent = text;
      if (ok) ok.disabled = !closed;
    },
    showError(message) {
      if (!error) return;
      error.textContent = message;
      error.hidden = message === "";
    },
    hide() {
      box.hidden = true;
      box.replaceChildren();
      status = error = ok = null;
    },
    get shown() {
      return !box.hidden;
    },
  };
}
