// The timeline along the bottom of the window (sketch feel SF3d): one thin
// row under the view, each timeline item a small icon in build order, the
// rollback marker a bar between two of them, items after it greyed and a
// suppressed one crossed out. It only shows the timeline: dragging the
// marker, suppressing and deleting from it come with step 24f.

import type { DesignDocument } from "./document.ts";

export type TimelineIcon = "sketch" | "extrude" | "box" | "cylinder" | "sphere" | "feature";

export interface TimelineBarItem {
  id: string;
  /** "2. Sketch 1 on the XY plane": numbered in build order like the browser's Timeline rows. */
  label: string;
  icon: TimelineIcon;
  suppressed: boolean;
  /** After the rollback marker: not built until the marker moves past it. */
  rolledBack: boolean;
}

const ICON_OF: Record<string, TimelineIcon> = { sketch: "sketch", extrude: "extrude", box: "box", cylinder: "cylinder", sphere: "sphere" };

/**
 * The bar's items and where the marker stands: `marker` items come before
 * it (0 for "start", every item when there is no marker). A marker naming
 * no item is refused (readDesignDocument never lets one in).
 */
export function timelineBarItems(document: DesignDocument): { items: TimelineBarItem[]; marker: number } {
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
  }));
  return { items, marker: at };
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
