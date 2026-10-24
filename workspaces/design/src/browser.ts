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
  /** A group shown folded until the user opens it (U0a, like Fusion's browser). */
  startsFolded?: boolean;
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

/** No feature failed: the browser before any rebuild has answered. */
const NONE_FAILED: ReadonlySet<string> = new Set();

/**
 * The Bodies group's rows: one for each feature in `bodyFeatures` that the
 * last rebuild did not fail (`failed`, its ids), "body-n" and "Body n", n
 * its place among `bodyFeatures`, so a body keeps its number when one
 * before it fails. A feature that failed has no body, so no row (bug hunt
 * 2026-10-19, finding 5: its row selected a body that did not exist).
 */
export function bodyRows(document: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): { id: string; label: string; feature: Feature }[] {
  return bodyFeatures(document).flatMap((f, i) => (failed.has(f.id) ? [] : [{ id: `body-${i + 1}`, label: `Body ${i + 1}`, feature: f }]));
}

/**
 * The browser's tree for a document. Each feature is a row numbered in
 * build order with its intent summary; a suppressed one says so. The
 * Timeline and the Origin start folded (U0a): the bar along the bottom
 * shows the timeline, and the origin's planes are seldom needed. Each
 * body the last rebuild built is a row (`bodyRows`; `failed` the ids it failed). Each profile
 * is a row by its own id ("profile-1"), selectable as an outline. Each
 * sketch is a timeline row by its id and a row in Sketches by
 * "sketches/<id>", so no two rows share an id.
 */
export function browserTree(document: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): BrowserNode[] {
  const features = document.timeline.features;
  // Each sketch's item by its id, looked up once (S2: a search per sketch took the timeline's length squared).
  const items = new Map<string, Feature>();
  for (const f of features) if (isSketchItem(f) && !items.has(f.id)) items.set(f.id, f);
  const sketchItemOf = (id: string) => items.get(id) ?? sketchItem(document, id);
  return [
    {
      id: "timeline",
      label: "Timeline",
      // The bar along the bottom shows every item already, with the same menu and double-click.
      startsFolded: true,
      children: features.map((f, i) => ({ id: f.id, label: `${i + 1}. ${f.intent.summary}${f.suppressed ? " (suppressed)" : ""}` })),
    },
    { id: "sketches", label: "Sketches", children: document.sketches.map((s) => ({ id: `sketches/${s.id}`, label: sketchItemOf(s.id).provenance.self.label })) },
    { id: "profiles", label: "Profiles", children: document.profiles.map((p) => ({ id: p.id, label: profileLabel(p) })) },
    { id: "bodies", label: "Bodies", children: bodyRows(document, failed).map(({ id, label }) => ({ id, label })) },
    { id: "origin", label: "Origin", children: ORIGIN, startsFolded: true },
  ];
}

/**
 * The browser rows that stand for selectable geometry, and the reference
 * each selects: "body-n" its body, a profile's row its outline, and (step
 * 24f6) a Timeline row of a solid feature that builds the body it makes,
 * the same as its Body row. A sketch's rows (its Timeline row and its
 * row in Sketches) select its outline once it has a curve (25c1), to copy
 * or hand over; an item that builds no body selects nothing, one the last
 * rebuild failed (`failed`) among them.
 */
export function rowReference(node: string, doc: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): GeometryReference | null {
  return rowReferences(doc, failed)(node);
}

/**
 * `rowReference` for every row of one document: the bodies and profiles
 * are listed once, so the browser's rows take time in proportion to their
 * number (security audit S2: listing them per row took its square).
 */
export function rowReferences(doc: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): (node: string) => GeometryReference | null {
  const rows = new Map(bodyRows(doc, failed).map((r) => [r.id, r.feature.id]));
  const solids = new Set(rows.values());
  // A profile, and (25c1) a sketch with curves by either of its rows: its outline.
  const outlines = new Set([...doc.profiles.map((p) => p.id), ...doc.sketches.flatMap((s) => (s.curves.length > 0 ? [s.id] : []))]);
  return (node) => {
    const body = rows.get(node);
    if (body !== undefined) return bodyReference(body);
    if (solids.has(node)) return bodyReference(node);
    const outline = node.startsWith("sketches/") ? node.slice("sketches/".length) : node;
    return outlines.has(outline) ? profileReference(outline) : null;
  };
}
