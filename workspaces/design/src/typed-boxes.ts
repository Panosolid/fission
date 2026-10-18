// The typed-size boxes (sketch feel SF4) floating by the pointer while a
// line, rectangle or arc is drawn: one box per size (typed-entry.ts
// `typedFields`), each showing the live size until something is typed
// in it, then a padlock while its text is a size it accepts. The boxes
// only show and report; the workspace decides what the locks do.
// Keys inside a box: Tab and Shift+Tab go round the boxes, Enter places
// the point, Escape empties the boxes and leaves them (a second Escape,
// outside, ends the line as before). Styles: src/styles/typed-entry.css.

import { readAngle, readLength, readSweep, shownValue, type Locks, type Reading, type TypedField } from "./typed-entry.ts";

export interface TypedBoxEvents {
  /** The locks changed (a box's text now reads as a size, or no longer does). */
  locks(locks: Locks): void;
  /** Enter in a box: place the point with the locks. */
  enter(): void;
  /** Escape in a box: the boxes were emptied and left. */
  escape(): void;
}

/** Each box's label (read by people and the e2e test) and how its text is read. */
export const FIELD_LABELS: Record<TypedField, string> = { length: "Length", angle: "Angle", width: "Width", height: "Height", radius: "Radius", sweep: "Arc angle" };
const UNITS: Record<TypedField, string> = { length: "mm", angle: "°", width: "mm", height: "mm", radius: "mm", sweep: "°" };
const read = (field: TypedField, text: string): Reading => (field === "angle" ? readAngle(text) : field === "sweep" ? readSweep(text) : readLength(text));

export interface TypedBoxes {
  /** Shows these fields (in this order) by the point (x, y) in the host's pixels, each not typed in showing its live value; no fields hides the boxes. */
  show(fields: readonly TypedField[], live: Locks, x: number, y: number): void;
  /** The accepted typed values: what is locked. */
  readonly locks: Locks;
  /** Whether a box has the keys. */
  readonly focused: boolean;
  /** Puts the keys in the first box, with `text` typed into it (a digit that started typing). */
  start(text: string): void;
  /** Empties every box (a point was placed, the tool changed, Escape); keeps the keys in the first box when `keepFocus` and a box had them. */
  clear(keepFocus?: boolean): void;
  hide(): void;
  readonly element: HTMLElement;
}

export function typedBoxes(host: HTMLElement, on: TypedBoxEvents): TypedBoxes {
  const document = host.ownerDocument;
  const root = document.createElement("div");
  root.className = "typed-entry";
  root.id = "typed-entry"; // read by the e2e test
  root.hidden = true;
  host.append(root);
  let fields: TypedField[] = [];
  const boxes = new Map<TypedField, { row: HTMLElement; input: HTMLInputElement; lock: HTMLElement; error: HTMLElement }>();

  const locks = (): Locks => {
    const out: Locks = {};
    for (const [f, b] of boxes) {
      if (!fields.includes(f) || b.input.value.trim() === "") continue;
      const r = read(f, b.input.value);
      if ("value" in r) out[f] = r.value;
    }
    return out;
  };
  /** Shows each box's padlock or its reason, from its text now. */
  function mark(f: TypedField) {
    const b = boxes.get(f)!;
    const text = b.input.value.trim();
    const r = text === "" ? null : read(f, text);
    const locked = r !== null && "value" in r;
    b.lock.hidden = !locked;
    b.row.classList.toggle("typed-entry-locked", locked);
    b.row.classList.toggle("typed-entry-invalid", r !== null && !locked);
    b.error.textContent = r && "error" in r ? r.error : "";
    b.error.hidden = b.error.textContent === "";
    b.input.setAttribute("aria-invalid", String(r !== null && !locked));
  }

  function box(f: TypedField) {
    const row = document.createElement("label");
    row.className = "typed-entry-row";
    row.dataset.field = f;
    const name = document.createElement("span");
    name.className = "typed-entry-name";
    name.textContent = FIELD_LABELS[f];
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.id = `typed-${f}`; // read by the e2e test
    input.setAttribute("aria-label", `${FIELD_LABELS[f]} (${UNITS[f]})`);
    const unit = document.createElement("span");
    unit.className = "typed-entry-unit";
    unit.textContent = UNITS[f];
    // Our own padlock: a shackle over a body, drawn in the box's colour.
    const lock = document.createElement("span");
    lock.className = "typed-entry-lock";
    lock.title = `${FIELD_LABELS[f]} locked`;
    lock.setAttribute("role", "img");
    lock.setAttribute("aria-label", `${FIELD_LABELS[f]} locked`);
    lock.innerHTML = `<svg viewBox="0 0 12 14" width="12" height="14" aria-hidden="true"><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="6" width="9" height="7" rx="1.5" fill="currentColor"/></svg>`;
    lock.hidden = true;
    const error = document.createElement("span");
    error.className = "typed-entry-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    row.append(name, input, unit, lock, error);
    input.addEventListener("input", () => {
      mark(f);
      on.locks(locks());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const i = fields.indexOf(f);
        const next = fields[(i + (e.shiftKey ? fields.length - 1 : 1)) % fields.length];
        const to = boxes.get(next)!.input;
        to.focus();
        to.select();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        on.enter();
      } else if (e.key === "Escape") {
        // Handled here, never by the shell's Escape (which would also end the line).
        e.preventDefault();
        e.stopPropagation();
        api.clear();
        input.blur();
        on.escape();
      }
    });
    boxes.set(f, { row, input, lock, error });
    return row;
  }

  const api: TypedBoxes = {
    element: root,
    get locks() {
      return locks();
    },
    get focused() {
      return [...boxes.values()].some((b) => b.input === document.activeElement);
    },
    show(next, live, x, y) {
      if (next.length === 0) return api.hide();
      if (next.join() !== fields.join()) {
        const had = api.focused;
        fields = [...next];
        for (const b of boxes.values()) b.row.remove();
        for (const f of fields) root.append(boxes.get(f)?.row ?? box(f));
        for (const f of fields) {
          boxes.get(f)!.input.value = "";
          mark(f);
        }
        if (had) boxes.get(fields[0])!.input.focus();
      }
      for (const f of fields) boxes.get(f)!.input.placeholder = live[f] === undefined ? "" : shownValue(live[f]!);
      root.hidden = false;
      root.style.left = `${Math.round(x)}px`;
      root.style.top = `${Math.round(y)}px`;
    },
    start(text) {
      if (fields.length === 0) return;
      const input = boxes.get(fields[0])!.input;
      input.focus();
      input.value = text;
      mark(fields[0]);
      on.locks(locks());
    },
    clear(keepFocus = false) {
      const had = api.focused;
      for (const f of fields) {
        boxes.get(f)!.input.value = "";
        mark(f);
      }
      if (had && keepFocus && fields.length) boxes.get(fields[0])!.input.focus();
      else if (had) (document.activeElement as HTMLElement | null)?.blur();
    },
    hide() {
      if (api.focused) (document.activeElement as HTMLElement | null)?.blur();
      for (const f of fields) boxes.get(f)!.input.value = "";
      fields = [];
      for (const b of boxes.values()) b.row.remove();
      root.hidden = true;
    },
  };
  return api;
}
