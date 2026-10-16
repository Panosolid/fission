// Design's part of the project: profiles and the timeline.
//
// Until the timeline (step 32) a part is ONE feature: feature #1 of a
// one-step timeline, with exactly the intent, provenance and dependency
// structures step 32 uses. Step 32 appends features to the list; nothing
// is converted or migrated. The body is built from the feature's intent
// (specOf), so the intent is the source of truth, not a description
// written next to the geometry.

import type { BodySpec, Feature, Plane } from "@fission/core";
import { XY_PLANE } from "@fission/core";
import { outline, type ProfileKind, type ShapeKind } from "./profiles.ts";

/** A ready-made outline on a plane (until the sketcher, step 21, adds sketches next to these). */
export interface ReadyProfile {
  id: string;
  kind: ProfileKind;
  width: number;
  depth: number;
  plane: Plane;
}

export interface DesignDocument {
  /** Version of this part of the project file (see docs/project-format.md). */
  version: 1;
  profiles: ReadyProfile[];
  timeline: { features: Feature[] };
}

const profileNames: Record<ProfileKind, string> = {
  "l-bracket": "L-bracket",
  plate: "Plate with two round holes",
  slot: "Slot with round ends",
  star: "Star",
};

/** "40 × 30 × 20": numbers as typed, so the summary matches the panel. */
const dims = (...ns: number[]) => ns.map(String).join(" × ");

/** One profile's display name, e.g. "L-bracket profile". */
export const profileLabel = (p: ReadyProfile) => `${profileNames[p.kind]} profile`;

/**
 * The document for one part: feature #1 of a one-step timeline. Boxes,
 * cylinders and spheres are primitives (a cylinder's or sphere's width is
 * its diameter); other shapes extrude a ready-made profile by the height.
 */
export function partDocument(kind: ShapeKind, w: number, d: number, h: number): DesignDocument {
  const self = (label: string) => ({ workspace: "design" as const, id: "feature-1", label });
  const feature = (intent: Feature["intent"], dependsOn: string[] = [], from: Feature["provenance"]["from"] = []): Feature => ({
    id: "feature-1",
    intent,
    provenance: { self: self(`Feature 1 (${intent.type})`), from },
    dependsOn,
    suppressed: false,
  });
  if (kind === "box")
    return doc([], feature({ type: "box", parameters: { width: w, depth: d, height: h }, summary: `Box: ${dims(w, d, h)} mm` }));
  if (kind === "cylinder")
    return doc([], feature({ type: "cylinder", parameters: { diameter: w, height: h }, summary: `Cylinder: ⌀${dims(w)} × ${h} mm` }));
  if (kind === "sphere") return doc([], feature({ type: "sphere", parameters: { diameter: w }, summary: `Sphere: ⌀${w} mm` }));
  const profile: ReadyProfile = { id: "profile-1", kind, width: w, depth: d, plane: XY_PLANE };
  return doc(
    [profile],
    feature(
      { type: "extrude", parameters: { profile: profile.id, distance: h }, summary: `Extrude: ${profileLabel(profile)} ${dims(w, d)} mm, by ${h} mm` },
      [profile.id],
      [{ workspace: "design", id: profile.id, label: profileLabel(profile) }],
    ),
  );
}

const doc = (profiles: ReadyProfile[], feature: Feature): DesignDocument => ({ version: 1, profiles, timeline: { features: [feature] } });

const num = (f: Feature, name: string) => {
  const v = f.intent.parameters[name];
  if (typeof v !== "number") throw new Error(`${f.intent.summary}: ${name} must be a number`);
  return v;
};

/** The body a feature builds, read from its intent. */
export function specOf(document: DesignDocument, feature: Feature): BodySpec {
  const p = feature.intent.parameters;
  switch (feature.intent.type) {
    case "box":
      return { box: { width: num(feature, "width"), depth: num(feature, "depth"), height: num(feature, "height") } };
    case "cylinder":
      return { cylinder: { radius: num(feature, "diameter") / 2, height: num(feature, "height") } };
    case "sphere":
      return { sphere: { radius: num(feature, "diameter") / 2 } };
    case "extrude": {
      const profile = document.profiles.find((x) => x.id === p.profile);
      if (!profile) throw new Error(`${feature.intent.summary}: its profile ${String(p.profile)} is missing`);
      return { extrude: { profile: outline(profile.kind, profile.width, profile.depth), distance: num(feature, "distance") } };
    }
    default:
      throw new Error(`unknown feature type ${feature.intent.type}`);
  }
}

/** The sizes the panel edits, keyed like its inputs; a shape fills only the ones it uses. */
export type PartSizes = Partial<Record<"width" | "depth" | "height", number>>;

/**
 * The shape and sizes a document's final feature was made from: the
 * inverse of partDocument, for the panel showing a loaded part. Throws a
 * clear message for a feature the panel can't show.
 */
export function partOf(document: DesignDocument): { shape: ShapeKind; sizes: PartSizes } {
  const f = lastFeature(document);
  switch (f.intent.type) {
    case "box":
      return { shape: "box", sizes: { width: num(f, "width"), depth: num(f, "depth"), height: num(f, "height") } };
    case "cylinder":
      return { shape: "cylinder", sizes: { width: num(f, "diameter"), height: num(f, "height") } };
    case "sphere":
      return { shape: "sphere", sizes: { width: num(f, "diameter") } };
    case "extrude": {
      const profile = document.profiles.find((x) => x.id === f.intent.parameters.profile);
      if (!profile) throw new Error(`${f.intent.summary}: its profile ${String(f.intent.parameters.profile)} is missing`);
      if (!Object.hasOwn(profileNames, profile.kind)) throw new Error(`profile ${profile.id} has an unknown kind ${String(profile.kind)}`);
      if (typeof profile.width !== "number" || typeof profile.depth !== "number") throw new Error(`profile ${profile.id}: width and depth must be numbers`);
      return { shape: profile.kind, sizes: { width: profile.width, depth: profile.depth, height: num(f, "distance") } };
    }
    default:
      throw new Error(`unknown feature type ${String(f.intent.type)}`);
  }
}

/**
 * Design's part of a loaded project, checked all the way down to the
 * numbers the panel shows, so a bad file is refused when it is opened
 * rather than failing later. Version 1 is the first, so there is nothing
 * to migrate yet; a later version adds its step here.
 */
export function readDesignDocument(data: unknown): DesignDocument {
  const d = data as Partial<DesignDocument> | null;
  if (typeof d !== "object" || d === null) throw new Error("Design data is missing");
  if (d.version !== 1) throw new Error(`Design data version ${String(d.version)} is not one this Fission reads (1)`);
  if (!Array.isArray(d.profiles) || !Array.isArray(d.timeline?.features) || d.timeline.features.length === 0)
    throw new Error("Design data has no timeline");
  for (const [i, profile] of d.profiles.entries())
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw new Error(`Design profile ${i + 1} is not an object`);
  for (const [i, f] of d.timeline.features.entries()) {
    const intent = (f as Partial<Feature> | null)?.intent;
    if (typeof f?.id !== "string" || typeof intent?.type !== "string" || typeof intent.summary !== "string" || typeof intent.parameters !== "object" || intent.parameters === null)
      throw new Error(`Design feature ${i + 1} has no id or intent`);
  }
  partOf(d as DesignDocument);
  return d as DesignDocument;
}

/** The part's final feature (the one-step timeline's only one, until step 32). */
export const lastFeature = (document: DesignDocument) => document.timeline.features.at(-1)!;
