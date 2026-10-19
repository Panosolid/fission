// The timeline's item menu wired (step 24f3), the same on the bar's items
// and the browser's Timeline and Sketches rows (a right-click, or the ⋯ a
// tap shows): Edit feature (step 25a2: opens the feature's sizes through
// the host; nothing is recorded until its OK) or Edit Sketch (step 25a3:
// opens the sketch again through the host; nothing is recorded until
// something is drawn), Move the marker here,
// Suppress or Unsuppress, and Delete, from 24f2's `itemMenu` and `barEdit`. Each choice is recorded as one
// undo step with its `TIMELINE_STEPS` name; a delete records 24e4's
// settled document (`planDelete`) and asks first through its box when
// something is built from the item. An edit that leaves no body is made
// like any other (24f4: the app shows a design with no body as an empty
// view). `workspace.ts` is the host: it records, asks and shows the refusal.

import type { KernelCalls } from "@fission/core";
import { isSketchItem, type DesignDocument } from "./document.ts";
import { planDelete, type DeleteQuestion } from "./delete-ask.ts";
import { barEdit, itemMenu, type BarAction, type MenuEntry } from "./timeline-bar.ts";

/**
 * Item `id`'s menu with sketch `editing` open (its id) or none: 24f2's
 * `itemMenu` as it is (from 24f4 nothing is off for leaving no body).
 */
export function menuEntries(doc: DesignDocument, id: string, editing: string | null = null): MenuEntry[] {
  return itemMenu(doc, id, editing);
}

/** What the menu needs from the app. */
export interface MenuHost {
  kernel: KernelCalls;
  /** The design now. */
  current(): DesignDocument;
  /** Makes `doc` the design as one undo step named `step`. */
  record(step: string, doc: DesignDocument): void;
  /** Asks `q` first (24e4's box); `go` runs only on its Delete. */
  ask(q: DeleteQuestion, go: () => void): void;
  /** Shows why nothing changed. */
  refuse(message: string): void;
  /** Opens item `id`'s Edit feature panel (step 25a2). */
  edit(id: string): void;
  /** Opens sketch `id` again to draw in (Edit Sketch, step 25a3); Finish Sketch rebuilds what is built from it. */
  editSketch(id: string): void;
}

/**
 * Runs entry `action` of item `id`'s menu: one `record` for an edit; for a
 * delete, `planDelete`'s document recorded at once when nothing is built
 * from the item, else after `ask`. Nothing is recorded when the entry is
 * off (refused with its words), when it changes nothing, or when the
 * design changed while the delete was planned or asked.
 */
export async function chooseEntry(host: MenuHost, id: string, action: MenuEntry["action"], editing: string | null = null): Promise<void> {
  const before = host.current();
  // An entry that is off is refused by barEdit itself, with the same words (it reads itemMenu).
  const r = barEdit(before, { kind: "menu", id, action }, editing);
  if (r.kind === "none") return;
  if (r.kind === "refused") return host.refuse(r.message);
  if (r.kind === "edit") return host.record(r.step, r.doc);
  if (r.kind === "open") return host.edit(r.id);
  if (r.kind === "sketch") return host.editSketch(r.id);
  const plan = await planDelete(host.kernel, before, id);
  if (host.current() !== before) return;
  const go = () => {
    if (host.current() === before) host.record(r.step, plan.next);
  };
  if (plan.ask) host.ask(plan.ask, go);
  else go();
}

/** The menu entry a double-click on item `id` runs (25a3): Edit Sketch for a sketch, Edit feature for a solid. */
export function openAction(doc: DesignDocument, id: string): "edit" | "edit-sketch" {
  const item = doc.timeline.features.find((f) => f.id === id);
  if (!item) throw new Error(`there is no item ${id} in the timeline`);
  return isSketchItem(item) ? "edit-sketch" : "edit";
}

/**
 * A playback button, a marker drop or a tap between items (step 24f5),
 * with sketch `editing` open (its id) or none: `barEdit`'s edit recorded as
 * one undo step with its `TIMELINE_STEPS` name, its refusal shown, or
 * nothing when the marker is already there.
 */
export function chooseBarAction(host: MenuHost, a: Exclude<BarAction, { kind: "menu" }>, editing: string | null = null): void {
  const r = barEdit(host.current(), a, editing);
  if (r.kind === "refused") host.refuse(r.message);
  else if (r.kind === "edit") host.record(r.step, r.doc);
}
