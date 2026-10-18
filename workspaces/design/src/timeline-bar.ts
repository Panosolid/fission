// The timeline along the bottom of the window (sketch feel SF3d): one thin
// row under the view, each timeline item a small icon in build order, the
// rollback marker a bar between two of them, items after it greyed and a
// suppressed one crossed out, a failed one red. Step 24f2 adds what the
// bar does, as pure functions with no wiring yet: where a drag or a tap
// lands (`dropIndex`, `isDrag`, `tapPlace`), where the four playback
// buttons send the marker (`stepTarget`), what each item's menu offers
// and why an entry is off (`itemMenu`), and every action turned into the
// 24e edit with its undo step's name, or refused with the message shown
// (`barEdit`). Behaviour copied from the reference app's timeline.

import { builds, type DesignDocument } from "./document.ts";
import { deleteItem, itemName, moveMarker, reorderItem, suppressItem, TIMELINE_STEPS } from "./timeline-edits.ts";

export type TimelineIcon = "sketch" | "extrude" | "box" | "cylinder" | "sphere" | "feature";

export interface TimelineBarItem {
  id: string;
  /** "2. Sketch 1 on the XY plane": numbered in build order like the browser's Timeline rows. */
  label: string;
  icon: TimelineIcon;
  suppressed: boolean;
  /** After the rollback marker: not built until the marker moves past it. */
  rolledBack: boolean;
  /** Built from something that is gone or suppressed, or failed in the rebuild (`failed`): drawn red. Never when rolled back or suppressed. */
  failed: boolean;
}

const ICON_OF: Record<string, TimelineIcon> = { sketch: "sketch", extrude: "extrude", box: "box", cylinder: "cylinder", sphere: "sphere" };

/**
 * The bar's items and where the marker stands: `marker` items come before
 * it (0 for "start", every item when there is no marker). A marker naming
 * no item is refused (readDesignDocument never lets one in). `failed`
 * holds the items the rebuild failed (an outline the kernel refused); one
 * that can't build from the data alone (`builds`: its sketch suppressed,
 * or deleted with no kept shape) is failed without it.
 */
export function timelineBarItems(document: DesignDocument, failed: ReadonlySet<string> = new Set()): { items: TimelineBarItem[]; marker: number } {
  const { features, marker } = document.timeline;
  let at = features.length;
  if (marker === "start") at = 0;
  else if (marker !== undefined) {
    const i = features.findIndex((f) => f.id === marker);
    if (i < 0) throw new Error(`the timeline marker "${marker}" names no item in the timeline`);
    at = i + 1;
  }
  const items = features.map((f, i) => ({
    id: f.id,
    label: `${i + 1}. ${f.intent.summary}`,
    icon: Object.hasOwn(ICON_OF, f.intent.type) ? ICON_OF[f.intent.type] : "feature",
    suppressed: f.suppressed,
    rolledBack: i >= at,
    failed: i < at && !f.suppressed && (!builds(document, f) || failed.has(f.id)),
  }));
  return { items, marker: at };
}

/** An item's left and right edges in the row's own coordinates (px from the row's start, scrolled part included). */
export interface ItemEdges {
  left: number;
  right: number;
}

/**
 * The place a drag dropped at pointer `x` lands (px from the row's visible
 * left edge, the row scrolled `scroll` px): the number of items whose
 * middle is left of the pointer, so 0 is before the first and
 * `edges.length` past the last. A drop exactly on an item's middle goes
 * before it. The same places serve the marker (0 is "start") and an
 * item being moved (between which two items it goes).
 */
export function dropIndex(edges: readonly ItemEdges[], x: number, scroll = 0): number {
  const at = x + scroll;
  let place = 0;
  for (const e of edges) if ((e.left + e.right) / 2 < at) place++;
  return place;
}

/** How far (px) a press must move to be a drag rather than a click. */
export const DRAG_PIXELS = 5;

/** Whether a press that moved (dx, dy) px is a drag: a move of DRAG_PIXELS or more; less is a click. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.sqrt(dx * dx + dy * dy) >= DRAG_PIXELS;
}

/** How near (px) a tap must be to the middle of a gap between items to put the marker there at phone width. */
export const TAP_REACH = 8;

/**
 * The place a tap at `x` (px from the row's visible left, scrolled
 * `scroll`) puts the marker at phone width: the gap whose middle is within
 * TAP_REACH of it (before the first item its left edge, past the last its
 * right edge), the nearest when two are; null when none is, a tap on the
 * item itself (which shows its ⋯ instead).
 */
export function tapPlace(edges: readonly ItemEdges[], x: number, scroll = 0): number | null {
  if (edges.length === 0) return null;
  const at = x + scroll;
  let best: number | null = null;
  let near = TAP_REACH;
  for (let place = 0; place <= edges.length; place++) {
    const gap = place === 0 ? edges[0].left : place === edges.length ? edges[place - 1].right : (edges[place - 1].right + edges[place].left) / 2;
    const d = Math.abs(at - gap);
    if (d <= near) {
      best = place;
      near = d;
    }
  }
  return best;
}

/** The four playback buttons before the items: go to the start, step back, step forward, go to the end. */
export type BarButton = "start" | "back" | "forward" | "end";

/** Where button `b` puts a marker standing at place `marker` of `count` items; back from the start and forward from the end stay put. */
export function stepTarget(b: BarButton, marker: number, count: number): number {
  if (b === "start") return 0;
  if (b === "end") return count;
  if (b === "back") return Math.max(0, marker - 1);
  return Math.min(count, marker + 1);
}

/** An entry of an item's menu: what it does, its words, and why it is off (null when it can be chosen). */
export interface MenuEntry {
  action: "marker" | "suppress" | "unsuppress" | "delete";
  label: string;
  off: string | null;
}

/** Why an edit can't be made while sketch `editing` is open: it would put that sketch after the marker. */
const rollsBackWords = (name: string) => `The marker can't go before ${name} while it is being edited: finish the sketch first`;
const editedWords = (name: string) => `${name} is being edited: finish the sketch first`;

/**
 * Item `id`'s menu (a right-click on it, or its ⋯ on a phone): Move the
 * marker here, Suppress or Unsuppress, and Delete. Moving the marker is off
 * when it is already just after the item, or when it would put the sketch
 * being edited (`editing`, its id) after it; suppressing and deleting are
 * off for the sketch being edited.
 */
export function itemMenu(doc: DesignDocument, id: string, editing: string | null = null): MenuEntry[] {
  const { items, marker } = timelineBarItems(doc);
  const at = items.findIndex((i) => i.id === id);
  if (at < 0) throw new Error(`there is no item ${id} in the timeline`);
  const item = doc.timeline.features[at];
  const busy = editing === id ? editedWords(itemName(item)) : null;
  return [
    { action: "marker", label: "Move the marker here", off: marker === at + 1 ? "The marker is already here" : rollsBack(doc, editing, at + 1) },
    item.suppressed ? { action: "unsuppress", label: "Unsuppress", off: busy } : { action: "suppress", label: "Suppress", off: busy },
    { action: "delete", label: "Delete", off: busy },
  ];
}

/** The marker's id for place `place`: "start" for 0, null (everything built) past the last item, else the item before the place. */
function markerAt(doc: DesignDocument, place: number): string | null {
  const { features } = doc.timeline;
  if (place <= 0) return "start";
  if (place >= features.length) return null;
  return features[place - 1].id;
}

/** The refusal when the marker at `place` would put the sketch being edited after it; null when it wouldn't. */
function rollsBack(doc: DesignDocument, editing: string | null, place: number): string | null {
  if (editing === null) return null;
  const at = doc.timeline.features.findIndex((f) => f.id === editing);
  if (at < 0 || at < place) return null;
  return rollsBackWords(itemName(doc.timeline.features[at]));
}

/** Something done on the bar: a menu entry on an item, a playback button, the marker dropped at a place, or an item dropped at a place. */
export type BarAction =
  | { kind: "menu"; id: string; action: MenuEntry["action"] }
  | { kind: "button"; button: BarButton }
  | { kind: "marker"; place: number }
  | { kind: "item"; id: string; place: number };

/**
 * What a bar action does: nothing (the marker or item is already there);
 * an edit, with the document to record as one undo step named `step`; a
 * delete, whose `doc` is `deleteItem`'s (the app records `planDelete`'s,
 * with kept shapes settled) and which asks first when other items are
 * built from it; or refused, with the message the bar shows.
 */
export type BarResult =
  | { kind: "none" }
  | { kind: "edit"; step: string; doc: DesignDocument }
  | { kind: "delete"; step: string; doc: DesignDocument; ask: boolean }
  | { kind: "refused"; message: string };

/** The marker moved to place `place`: nothing when it is already there, refused when it would roll back the sketch being edited. */
function markerTo(doc: DesignDocument, place: number, editing: string | null): BarResult {
  const { marker } = timelineBarItems(doc);
  if (place === marker) return { kind: "none" };
  const no = rollsBack(doc, editing, place);
  if (no) return { kind: "refused", message: no };
  return { kind: "edit", step: TIMELINE_STEPS.marker, doc: moveMarker(doc, markerAt(doc, place)) };
}

/** Action `a` on the bar, with sketch `editing` open (its id) or none: the 24e edit and its undo step's name, or why not. */
export function barEdit(doc: DesignDocument, a: BarAction, editing: string | null = null): BarResult {
  const { features } = doc.timeline;
  const count = features.length;
  if (a.kind === "button") return markerTo(doc, stepTarget(a.button, timelineBarItems(doc).marker, count), editing);
  if (a.kind === "marker") {
    if (!Number.isInteger(a.place) || a.place < 0 || a.place > count) throw new Error(`the marker can't go to place ${a.place} of ${count} items`);
    return markerTo(doc, a.place, editing);
  }
  const k = features.findIndex((f) => f.id === a.id);
  if (k < 0) throw new Error(`there is no item ${a.id} in the timeline`);
  const name = itemName(features[k]);
  if (a.kind === "item") {
    if (!Number.isInteger(a.place) || a.place < 0 || a.place > count) throw new Error(`${name} can't go to place ${a.place} of ${count} items`);
    // Dropped just before or just after itself: it stays where it is.
    if (a.place === k || a.place === k + 1) return { kind: "none" };
    const moved = reorderItem(doc, a.id, a.place > k ? a.place - 1 : a.place);
    if ("refused" in moved) return { kind: "refused", message: moved.message };
    const no = editing !== null && timelineBarItems(moved.doc).items.find((i) => i.id === editing)?.rolledBack;
    if (no) return { kind: "refused", message: rollsBackWords(itemName(features.find((f) => f.id === editing)!)) };
    return { kind: "edit", step: TIMELINE_STEPS.reorder(name), doc: moved.doc };
  }
  const entry = itemMenu(doc, a.id, editing).find((e) => e.action === a.action);
  if (!entry) return { kind: "refused", message: `${name} has no ${a.action} in its menu` };
  if (entry.off) return { kind: "refused", message: entry.off };
  if (a.action === "marker") return markerTo(doc, k + 1, editing);
  if (a.action === "delete") return { kind: "delete", step: TIMELINE_STEPS.delete(name), doc: deleteItem(doc, a.id), ask: features.some((f) => f.dependsOn.includes(a.id)) };
  const on = a.action === "suppress";
  return { kind: "edit", step: on ? TIMELINE_STEPS.suppress(name) : TIMELINE_STEPS.unsuppress(name), doc: suppressItem(doc, a.id, on) };
}

/** 16 px line icons on a 24-unit grid, of our own drawing, in the item's text colour. */
const ICONS: Record<TimelineIcon, string> = {
  sketch: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 2"/><path d="M7 16l5-8 5 8z"/>',
  extrude: '<path d="M5 17h10l4-4H9z"/><path d="M5 17V9h10v8M15 9l4-4v8M5 9l4-4h10"/><path d="M12 4V1M11 2l1-1 1 1"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  cylinder: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>',
  sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>',
  feature: '<circle cx="12" cy="12" r="7"/>',
};

/** Fills the timeline slot: an ordered list of the items, with the marker as a separator where it stands. */
export function showTimelineBar(slot: HTMLElement, doc: DesignDocument) {
  const document = slot.ownerDocument;
  const { items, marker } = timelineBarItems(doc);
  const list = document.createElement("ol");
  list.className = "timeline-bar";
  list.setAttribute("aria-label", "Timeline");
  const markerRow = () => {
    const li = document.createElement("li");
    li.className = "timeline-bar-marker";
    li.setAttribute("role", "separator");
    li.setAttribute("aria-label", "Rollback marker");
    li.title = "Rollback marker: the items after it are not built";
    return li;
  };
  items.forEach((item, i) => {
    if (i === marker) list.append(markerRow());
    const li = document.createElement("li");
    li.className = "timeline-bar-item";
    li.dataset.item = item.id; // read by the e2e test
    li.dataset.icon = item.icon;
    if (item.suppressed) li.dataset.suppressed = "true";
    if (item.rolledBack) li.dataset.rolledBack = "true";
    const words = item.label + (item.suppressed ? " (suppressed)" : "") + (item.rolledBack ? " (after the marker)" : "");
    li.title = words;
    li.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[item.icon]}</svg>`;
    const name = document.createElement("span");
    name.className = "timeline-bar-name";
    name.textContent = words;
    li.append(name);
    list.append(li);
  });
  if (marker === items.length) list.append(markerRow());
  slot.replaceChildren(list);
}
