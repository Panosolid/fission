// Live links between workspaces.
//
// Pasting or dragging something into another workspace makes a LIVE LINK
// by default: the item keeps a reference to its source by id (object ids
// now; topological-naming ids for faces and edges from step 24) and
// re-fetches it through the representation registry whenever the source
// changes. Nothing is copied. The user can break a link, which freezes a
// copy of what the link showed at that moment and says so with an icon.
// A link that can't be resolved after an edit shows a warning on the item
// holding it; it is never dropped silently.
//
// The data structure and its rules are real; no workspace pastes into
// another yet (the first will be Slice plates or Laser jobs).

import type { Origin } from "./feature.ts";
import type { GeometryReference } from "./references.ts";
import type { Producible, Representation, RepresentationKind, RepresentationRegistry } from "./representation.ts";

/** What a link points at: an object (a feature, a profile, a logo) or a face/edge by stable id. */
export type LinkSource = { kind: "object"; origin: Origin } | { kind: "geometry"; origin: Origin; ref: GeometryReference };

export interface LiveLink {
  id: string;
  mode: "live";
  source: LinkSource;
  /** The representations the holding item accepts, best first. */
  accepts: RepresentationKind[];
}

/** A broken link: a copy of what it showed when it was broken, which no longer follows the source. */
export interface FrozenCopy {
  id: string;
  mode: "frozen";
  /** Where it came from, kept so provenance still answers. */
  source: LinkSource;
  representation: Representation;
}

export type Link = LiveLink | FrozenCopy;

export type LinkStatus =
  | { state: "live"; object: Producible }
  | { state: "frozen" }
  | { state: "unresolved"; warning: string };

/** Finds a source object in the current project, or null if it is gone. */
export type SourceLookup = (source: LinkSource) => Producible | null;

/** A new link from a paste or drop: live by default. */
export function linkTo(id: string, source: LinkSource, accepts: RepresentationKind[]): LiveLink {
  return { id, mode: "live", source, accepts: [...accepts] };
}

/** Re-resolves a link against the current project (after every rebuild). */
export function resolveLink(link: Link, lookup: SourceLookup): LinkStatus {
  if (link.mode === "frozen") return { state: "frozen" };
  const object = lookup(link.source);
  if (object) return { state: "live", object };
  const { label, workspace } = link.source.origin;
  return {
    state: "unresolved",
    warning: `Linked to ${label} in ${workspace[0].toUpperCase()}${workspace.slice(1)}, which can't be found after the last edit. Pick a new source or break the link to keep the last copy.`,
  };
}

/** What a live link shows now, through the shared registry (most exact representation the holder accepts). */
export async function fetchLinked(link: LiveLink, lookup: SourceLookup, registry: RepresentationRegistry) {
  const status = resolveLink(link, lookup);
  if (status.state !== "live") throw new Error(status.state === "unresolved" ? status.warning : "not a live link");
  return registry.deliver(status.object, link.accepts);
}

/** Breaks a live link into a frozen copy of what it shows now. */
export async function breakLink(link: LiveLink, lookup: SourceLookup, registry: RepresentationRegistry): Promise<FrozenCopy> {
  const { representation } = await fetchLinked(link, lookup, registry);
  return { id: link.id, mode: "frozen", source: link.source, representation };
}
