// Timeline edits on the Design document (step 24e2): delete an item,
// move it to another place, suppress it, move the rollback marker. Each
// is a pure function from one document to the next, like the sketch edits
// (sketch.ts), so the workspace records each as one undo step with its
// name (TIMELINE_STEPS) and the history needs no inverse. An edit that
// changes nothing gives the same document back, so no step is recorded.
//
// The rules are the timeline model's (packages/testing/src/timeline-model.ts,
// `edit`): a delete takes only that item (an extrude whose sketch goes
// keeps its last shape, which `settleKept` in rebuild.ts records after
// the edit, the owner's rule); the marker on a deleted item moves to the
// one before, or the start; a reorder is refused when the item would come
// before an item it is built from, or after one built from it.

import type { Feature } from "@fission/core";
import { isSketchItem, shown, type DesignDocument } from "./document.ts";
import { faceFeature, isFacePlane } from "./face-sketch.ts";

/** The undo step each timeline edit is recorded as, from the item's name ("Delete Sketch 1"). */
export const TIMELINE_STEPS = {
  delete: (name: string) => `Delete ${name}`,
  reorder: (name: string) => `Move ${name} in the timeline`,
  suppress: (name: string) => `Suppress ${name}`,
  unsuppress: (name: string) => `Unsuppress ${name}`,
  marker: "Move the rollback marker",
  edit: (name: string) => `Edit ${name}`,
} as const;

/** Why a reorder is refused: the item would come before an item it is built from, or after one built from it. */
export type ReorderCause = "before-dependency" | "after-dependent";

export type Reordered = { doc: DesignDocument } | { refused: ReorderCause; message: string };

/** An item's short name, as the timeline and the browser show it ("Sketch 1", "Extrude 2"). */
export const itemName = (f: Feature): string => f.provenance.self.label;

function itemIn(doc: DesignDocument, id: string): Feature {
  const f = doc.timeline.features.find((x) => x.id === id);
  if (!f) throw new Error(`there is no item ${shown(id)} in the timeline`);
  return f;
}

/** The timeline with these items and this marker (left out for "everything built"). */
function withTimeline(doc: DesignDocument, features: Feature[], marker: string | undefined): DesignDocument {
  const { marker: _, ...rest } = doc.timeline;
  return { ...doc, timeline: marker === undefined ? { ...rest, features } : { ...rest, features, marker } };
}

/**
 * The document without the item `id`: a sketch's content goes with its
 * item, a preset's ready-made profile when no other item uses it, an
 * extrude's kept shape with the extrude. Nothing else goes: an extrude of
 * a deleted sketch stays, keeping its last shape (`settleKept`). A marker
 * on the item moves to the item before it, or to "start" for the first.
 * The caller asks first when other items use it (24e4); this is the
 * confirmed delete.
 */
export function deleteItem(doc: DesignDocument, id: string): DesignDocument {
  const item = itemIn(doc, id);
  const all = doc.timeline.features;
  const k = all.indexOf(item);
  const features = all.filter((f) => f !== item);
  const { marker } = doc.timeline;
  const next = withTimeline(doc, features, marker === id ? (k === 0 ? "start" : all[k - 1].id) : marker);
  const used = new Set(features.flatMap((f) => f.dependsOn));
  const profiles = doc.profiles.filter((p) => !item.dependsOn.includes(p.id) || used.has(p.id));
  const sketches = isSketchItem(item) ? doc.sketches.filter((s) => s.id !== id) : doc.sketches;
  const { kept: old, ...rest } = next;
  if (old === undefined || !Object.hasOwn(old, id)) return { ...next, profiles, sketches };
  const { [id]: _, ...kept } = old;
  return Object.keys(kept).length === 0 ? { ...rest, profiles, sketches } : { ...rest, profiles, sketches, kept };
}

/**
 * How `f` hangs on `on`, one of the items it depends on: a sketch is drawn
 * on a face of its face's feature (step 26e), has a point snapped to an
 * edge of another (27c, a pin), or else holds an edge projected from it
 * (27d); anything else is built from its inputs.
 */
function link(doc: DesignDocument, f: Feature, on: Feature): string {
  if (!isSketchItem(f)) return "built from";
  const plane = f.intent.parameters.plane;
  if (isFacePlane(plane) && faceFeature(plane) === on.id) return "drawn on a face of";
  const pinned = doc.sketches.find((s) => s.id === f.id)?.pins?.some((p) => p.feature === on.id) ?? false;
  return pinned ? "snapped to an edge of" : "projecting an edge of";
}

/**
 * The document with item `id` moved to place `to` (0 first) of the new
 * order; the marker stays on the item it names. The same document back
 * when it is already there. Refused, with the message the app shows, when
 * the item would come before an item it is built from, or after one built
 * from it; a sketch's words name the face it is drawn on (answer 7), the
 * body it has a point snapped to (27c), or the one it projects (27d).
 */
export function reorderItem(doc: DesignDocument, id: string, to: number): Reordered {
  const item = itemIn(doc, id);
  const features = doc.timeline.features.filter((f) => f !== item);
  if (!Number.isInteger(to) || to < 0 || to > features.length) throw new Error(`${itemName(item)} can't go to place ${shown(to)} of a timeline of ${features.length + 1} items`);
  features.splice(to, 0, item);
  const place = (x: string) => features.findIndex((f) => f.id === x);
  const from = features.find((f) => item.dependsOn.includes(f.id) && place(f.id) > to);
  if (from) return { refused: "before-dependency", message: `${itemName(item)} can't go before ${itemName(from)}: it is ${link(doc, item, from)} ${itemName(from)}` };
  const user = features.find((f, j) => j < to && f.dependsOn.includes(id));
  if (user) return { refused: "after-dependent", message: `${itemName(item)} can't go after ${itemName(user)}: ${itemName(user)} is ${link(doc, user, item)} it` };
  if (doc.timeline.features.indexOf(item) === to) return { doc };
  return { doc: withTimeline(doc, features, doc.timeline.marker) };
}

/**
 * The document with item `id` suppressed (`on`) or not: a suppressed item
 * is skipped by the rebuild, and everything built on it is greyed, with
 * no warning (rebuild.ts, Fusion's answer Q3). The same document back when it already is.
 */
export function suppressItem(doc: DesignDocument, id: string, on: boolean): DesignDocument {
  const item = itemIn(doc, id);
  if (typeof on !== "boolean") throw new Error(`suppressing ${itemName(item)} needs true or false, not ${shown(on)}`);
  if (item.suppressed === on) return doc;
  return withTimeline(doc, doc.timeline.features.map((f) => (f === item ? { ...f, suppressed: on } : f)), doc.timeline.marker);
}

/**
 * The document with the rollback marker at `at`: "start" (nothing built),
 * an item's id (built up to and including it), or null (everything built,
 * the marker left out). The same document back when it is already there.
 */
export function moveMarker(doc: DesignDocument, at: string | null): DesignDocument {
  if (at !== null && at !== "start") itemIn(doc, at);
  const marker = at ?? undefined;
  if (doc.timeline.marker === marker) return doc;
  return withTimeline(doc, doc.timeline.features, marker);
}
