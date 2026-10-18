// Design's browser panel, read from the Design document (document.ts):
// the timeline's items in build order, the sketches and profiles, the
// bodies they make, and the origin's planes and axes. A pure function of the document, so step 24's
// longer timeline only adds rows here.

import type { Feature, GeometryReference } from "@fission/core";
import { buildingItems, isSketchItem, profileLabel, type DesignDocument } from "./document.ts";
import { bodyReference, profileReference } from "./references.ts";
import { sketchItem } from "./sketch.ts";

export interface BrowserNode {
  /** Stable within the document: a feature's id, "body-1", "origin-xy"… */
  id: string;
  label: string;
  /** Groups have children (possibly none); leaves are rows a click highlights. */
  children?: BrowserNode[];
}

/** The origin every part is built on; the same for every document. */
const ORIGIN: BrowserNode[] = [
  { id: "origin-xy", label: "XY plane" },
  { id: "origin-xz", label: "XZ plane" },
  { id: "origin-yz", label: "YZ plane" },
  { id: "origin-x", label: "X axis" },
  { id: "origin-y", label: "Y axis" },
  { id: "origin-z", label: "Z axis" },
];

/**
 * The solid features that build (`builds`: not suppressed, not after the
 * rollback marker, their sketch there), in build order: each makes a body
 * (24d1), "Body 1", "Body 2"…, all drawn (24d3b).
 */
export function bodyFeatures(document: DesignDocument): Feature[] {
  const building = buildingItems(document);
  return document.timeline.features.filter((f) => !isSketchItem(f) && building.has(f));
}

/**
 * The browser's tree for a document. Each feature is a row numbered in
 * build order with its intent summary; a suppressed one says so. Each
 * body is a row "body-n", Body n, n its place among `bodyFeatures`. Each profile
 * is a row by its own id ("profile-1"), selectable as an outline. Each
 * sketch is a timeline row by its id and a row in Sketches by
 * "sketches/<id>", so no two rows share an id.
 */
export function browserTree(document: DesignDocument): BrowserNode[] {
  const features = document.timeline.features;
  // Each sketch's item by its id, looked up once (S2: a search per sketch took the timeline's length squared).
  const items = new Map<string, Feature>();
  for (const f of features) if (isSketchItem(f) && !items.has(f.id)) items.set(f.id, f);
  const sketchItemOf = (id: string) => items.get(id) ?? sketchItem(document, id);
  return [
    {
      id: "timeline",
      label: "Timeline",
      children: features.map((f, i) => ({ id: f.id, label: `${i + 1}. ${f.intent.summary}${f.suppressed ? " (suppressed)" : ""}` })),
    },
    { id: "sketches", label: "Sketches", children: document.sketches.map((s) => ({ id: `sketches/${s.id}`, label: sketchItemOf(s.id).provenance.self.label })) },
    { id: "profiles", label: "Profiles", children: document.profiles.map((p) => ({ id: p.id, label: profileLabel(p) })) },
    { id: "bodies", label: "Bodies", children: bodyFeatures(document).map((_, i) => ({ id: `body-${i + 1}`, label: `Body ${i + 1}` })) },
    { id: "origin", label: "Origin", children: ORIGIN },
  ];
}

/** The browser rows that stand for selectable geometry, and the reference each selects: "body-n" its body, a profile's row its outline. */
export function rowReference(node: string, doc: DesignDocument): GeometryReference | null {
  return rowReferences(doc)(node);
}

/**
 * `rowReference` for every row of one document: the bodies and profiles
 * are listed once, so the browser's rows take time in proportion to their
 * number (security audit S2: listing them per row took its square).
 */
export function rowReferences(doc: DesignDocument): (node: string) => GeometryReference | null {
  const bodies = bodyFeatures(doc);
  const profiles = new Set(doc.profiles.map((p) => p.id));
  return (node) => {
    const body = /^body-(\d+)$/.exec(node);
    if (body) return ((f) => (f ? bodyReference(f.id) : null))(bodies[Number(body[1]) - 1]);
    return profiles.has(node) ? profileReference(node) : null;
  };
}
