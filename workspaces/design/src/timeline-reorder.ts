// An item dragged along the timeline bar to a new place (step 24f6), as in
// the reference app: a press on an item that moves DRAG_PIXELS or more
// drags it, a line shows where it would drop, and a place it can't go
// (it would come before an item it is built from, or after one built from
// it, or roll back the sketch being edited) is shown refused, the line red
// with `barEdit`'s own words above the bar. Let go, the drop goes to the
// app as an item drop (`barEdit`'s `item` action), one undo step "Move …
// in the timeline", or the refusal shown. A finger drags only the picked
// item (a tap picks it, as 24f3 shows its ⋯): anywhere else a finger
// scrolls the row and taps between items (24f5).

import type { DesignDocument } from "./document.ts";
import { barEdges, barEdit, dropIndex, isDrag, swallowClick, type BarAction, type ItemEdges } from "./timeline-bar.ts";

/** What dropping an item at a place would do, shown while it is dragged: it stays (its own place), it moves, or it is refused with the message. */
export type DropState = { kind: "stays" } | { kind: "moves" } | { kind: "refused"; message: string };

/** Item `id` dropped at `place` (0 before the first item, the item count past the last) with sketch `editing` open or none: `barEdit`'s answer, as the drag shows it. */
export function dropState(doc: DesignDocument, id: string, place: number, editing: string | null = null): DropState {
  const r = barEdit(doc, { kind: "item", id, place }, editing);
  if (r.kind === "refused") return { kind: "refused", message: r.message };
  return r.kind === "none" ? { kind: "stays" } : { kind: "moves" };
}

/**
 * Where (row px) the drop line for place `place` is drawn: the middle of
 * the gap between items `place` − 1 and `place`, the first item's left
 * edge for 0, the last item's right edge past it.
 */
export function gapX(edges: readonly ItemEdges[], place: number): number {
  if (edges.length === 0) throw new Error("there is no gap in an empty timeline");
  if (!Number.isInteger(place) || place < 0 || place > edges.length) throw new Error(`there is no place ${place} among ${edges.length} items`);
  if (place === 0) return edges[0].left;
  if (place === edges.length) return edges[place - 1].right;
  return (edges[place - 1].right + edges[place].left) / 2;
}

/** What an item's drag needs from the bar. */
export interface ItemDrag {
  doc: DesignDocument;
  id: string;
  /** The sketch being edited, whose roll-back is refused. */
  editing: string | null;
  /** Whether the item is picked: only then does a finger drag it. */
  picked: boolean;
  /** The drop, sent to the app. */
  act(a: BarAction): void;
  /** A drag the browser cancelled: the bar drawn again as the document has it. */
  cancel(): void;
}

/**
 * Wires item `li` of the bar's list `list` (inside the row `row`) to be
 * dragged. A right-button press, a press that moves less than
 * DRAG_PIXELS (a click, which picks the item), and a finger on an item
 * that isn't picked drag nothing. While dragged the item is dimmed, a line
 * stands at the place it would drop (`dropIndex` on the items as laid
 * out), red with the refusal's words when it can't go there. The click a
 * drag's release makes is dropped, as the marker's is.
 */
export function dragItem(row: HTMLElement, list: HTMLElement, li: HTMLElement, o: ItemDrag) {
  li.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    if (down.pointerType === "touch" && !o.picked) return;
    const document = li.ownerDocument;
    let place: number | null = null;
    let line: HTMLElement | null = null;
    let note: HTMLElement | null = null;
    const show = (p: number) => {
      const state = dropState(o.doc, o.id, p, o.editing);
      const rowLeft = row.getBoundingClientRect().left;
      const listLeft = list.getBoundingClientRect().left - rowLeft;
      const x = listLeft + gapX(barEdges(list), p) - list.scrollLeft;
      line!.style.left = `${x - 1}px`;
      line!.dataset.place = String(p); // read by the e2e test
      line!.dataset.state = state.kind;
      if (state.kind === "refused") {
        note!.hidden = false;
        note!.textContent = state.message;
        // Above the line, kept inside the row.
        const w = note!.offsetWidth;
        note!.style.left = `${Math.max(4, Math.min(x - w / 2, row.clientWidth - w - 4))}px`;
      } else {
        note!.hidden = true;
        note!.textContent = "";
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      if (place === null) {
        if (!isDrag(e.clientX - down.clientX, e.clientY - down.clientY)) return;
        li.classList.add("timeline-reorder-dragged");
        line = document.createElement("div");
        line.className = "timeline-reorder-line";
        line.setAttribute("aria-hidden", "true");
        note = document.createElement("div");
        note.className = "timeline-reorder-note";
        note.setAttribute("role", "status");
        note.hidden = true;
        row.append(line, note);
      }
      e.preventDefault();
      place = dropIndex(barEdges(list), e.clientX - list.getBoundingClientRect().left, list.scrollLeft);
      show(place);
    };
    const stop = (e: PointerEvent) => {
      if (e.pointerId !== down.pointerId) return;
      li.removeEventListener("pointermove", move);
      li.removeEventListener("pointerup", stop);
      li.removeEventListener("pointercancel", stop);
      if (place === null) return;
      li.classList.remove("timeline-reorder-dragged");
      line?.remove();
      note?.remove();
      swallowClick(list);
      if (e.type === "pointerup") o.act({ kind: "item", id: o.id, place });
      else o.cancel();
    };
    // The item holds the pointer from the press, so the moves and the release come back to it wherever the
    // pointer goes, and a press with no drag is still a click on the item (it picks it).
    try {
      li.setPointerCapture(down.pointerId);
    } catch {
      // No pointer to hold (one the browser no longer knows): the moves still reach the item while over it.
    }
    li.addEventListener("pointermove", move);
    li.addEventListener("pointerup", stop);
    li.addEventListener("pointercancel", stop);
  });
}
