// Design's browser panel, read from the Design document (document.ts):
// the timeline's items in build order, the sketches and profiles, the
// bodies they make, and the origin's planes and axes. A pure function of the document, so step 24's
// longer timeline only adds rows here.

import type { Feature } from "@fission/core";
import { builds, isSketchItem, profileLabel, type DesignDocument } from "./document.ts";
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
  return document.timeline.features.filter((f) => !isSketchItem(f) && builds(document, f));
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
  return [
    {
      id: "timeline",
      label: "Timeline",
      children: features.map((f, i) => ({ id: f.id, label: `${i + 1}. ${f.intent.summary}${f.suppressed ? " (suppressed)" : ""}` })),
    },
    { id: "sketches", label: "Sketches", children: document.sketches.map((s) => ({ id: `sketches/${s.id}`, label: sketchItem(document, s.id).provenance.self.label })) },
    { id: "profiles", label: "Profiles", children: document.profiles.map((p) => ({ id: p.id, label: profileLabel(p) })) },
    { id: "bodies", label: "Bodies", children: bodyFeatures(document).map((_, i) => ({ id: `body-${i + 1}`, label: `Body ${i + 1}` })) },
    { id: "origin", label: "Origin", children: ORIGIN },
  ];
}
