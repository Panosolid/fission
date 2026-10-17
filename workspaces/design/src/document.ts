// Design's part of the project: profiles, sketches and the timeline
// (docs/document-model.md).
//
// Until the timeline (step 24) a part is ONE solid feature, with exactly
// the intent, provenance and dependency structures step 24 uses; sketches
// are timeline items of their own next to it (step 21b). The body is built
// from the feature's intent (specOf), so the intent is the source of
// truth, not a description written next to the geometry.

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

/** A sketch point, in mm in the sketch plane's own 2D frame (never world coordinates). */
export interface SketchPoint {
  id: string;
  x: number;
  y: number;
}

/** A sketch line between two of its sketch's points, named by id. */
export interface SketchLineCurve {
  id: string;
  kind: "line";
  start: string;
  end: string;
}

/** A sketch circle round one of its sketch's points, named by id, with its radius in mm (step 22b). */
export interface SketchCircleCurve {
  id: string;
  kind: "circle";
  centre: string;
  radius: number;
}

/**
 * A sketch arc from one of its sketch's points to another, counter-clockwise
 * round a third, all named by id (step 23a; Fusion's convention). The
 * centre is midway between the ends; the kernel holds that rule.
 */
export interface SketchArcCurve {
  id: string;
  kind: "arc";
  start: string;
  end: string;
  centre: string;
}

/** A sketch's curves: lines, circles and arcs. */
export type SketchCurve = SketchLineCurve | SketchCircleCurve | SketchArcCurve;

/** The points a curve is drawn from: a line's two ends, a circle's centre, an arc's ends and centre. */
export const curvePoints = (c: SketchCurve): string[] => (c.kind === "line" ? [c.start, c.end] : c.kind === "circle" ? [c.centre] : [c.start, c.end, c.centre]);

/** A sketch's content; its place in the build order and its plane are its timeline item with the same id. */
export interface Sketch {
  id: string;
  points: SketchPoint[];
  curves: SketchCurve[];
  /** Empty until the solver (step 29). */
  constraints: never[];
}

/** The planes a sketch can be on (a stable face id joins these at step 24). */
export const SKETCH_PLANES = ["XY", "XZ", "YZ"] as const;
export type SketchPlane = (typeof SKETCH_PLANES)[number];

export interface DesignDocument {
  /** Version of this part of the project file (see docs/project-format.md). */
  version: 2;
  /** The number the next new id gets. Ids are never reused, even after a delete (docs/document-model.md, section 2). */
  nextId: number;
  profiles: ReadyProfile[];
  sketches: Sketch[];
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

// A fresh part uses ids 1 (its feature and profile), so the counter starts at 2.
const doc = (profiles: ReadyProfile[], feature: Feature): DesignDocument => ({ version: 2, nextId: 2, profiles, sketches: [], timeline: { features: [feature] } });

/**
 * The document with its part replaced by this shape and these sizes (the
 * panel and set_part), keeping its sketches where they are in the build
 * order. The part's feature takes the old part feature's place; until step
 * 32 there is only that one, and a preset shape's feature and profile are
 * always "feature-1" and "profile-1" (step 24 turns presets into ordinary
 * features with counter ids). The counter never goes back.
 */
export function withPart(previous: DesignDocument | null | undefined, kind: ShapeKind, w: number, d: number, h: number): DesignDocument {
  let fresh = partDocument(kind, w, d, h);
  if (!previous) return fresh;
  let nextId = Math.max(fresh.nextId, previous.nextId);
  const old = lastFeature(previous);
  // A preset edited keeps its feature's id and its profile's (the same
  // feature, changed). After an extrude of a sketch (step 21d) the preset is
  // a new feature: it takes new ids from the counter, so a link to the
  // part's old feature-1 or profile-1 never lands on it. A profile the old
  // part didn't have is profile-1 on the first part, else new.
  const oldProfile = previous.profiles.find((p) => old.dependsOn.includes(p.id))?.id;
  const ids = new Map<string, string>();
  ids.set("feature-1", isSketchExtrude(old) ? `feature-${nextId++}` : old.id);
  if (fresh.profiles.length > 0) ids.set("profile-1", oldProfile ?? (old.id === "feature-1" ? "profile-1" : `profile-${nextId++}`));
  fresh = renamed(fresh, ids);
  const part = fresh.timeline.features[0];
  const features = previous.timeline.features.filter((f) => f === old || isSketchItem(f)).map((f) => (f === old ? part : f));
  return { ...fresh, nextId, sketches: previous.sketches, timeline: { features } };
}

/** A fresh part's document with its ids swapped as `ids` says (feature, profile, and the references between them). */
function renamed(fresh: DesignDocument, ids: ReadonlyMap<string, string>): DesignDocument {
  const id = (x: string) => ids.get(x) ?? x;
  const [f] = fresh.timeline.features;
  const parameters = typeof f.intent.parameters.profile === "string" ? { ...f.intent.parameters, profile: id(f.intent.parameters.profile) } : f.intent.parameters;
  const feature: Feature = {
    ...f,
    id: id(f.id),
    intent: { ...f.intent, parameters },
    provenance: { self: { ...f.provenance.self, id: id(f.id) }, from: f.provenance.from.map((r) => ({ ...r, id: id(r.id) })) },
    dependsOn: f.dependsOn.map(id),
  };
  return { ...fresh, profiles: fresh.profiles.map((p) => ({ ...p, id: id(p.id) })), timeline: { features: [feature] } };
}

/**
 * An extrude of a sketch (step 21d): `{ sketch, distance }`, its outline
 * found by the kernel from the sketch each time it is built. An extrude of
 * a ready-made profile names a `profile` instead.
 */
export const isSketchExtrude = (f: Feature) => f.intent.type === "extrude" && Object.hasOwn(f.intent.parameters, "sketch");

/** A sketch's timeline item: it places the sketch in the build order and names its plane; it builds no solid. */
export const isSketchItem = (f: Feature) => f.intent.type === "sketch";

/**
 * A value from a file, for a message: text as it is, anything else by
 * kind. String() would run a file's own "toString" and can throw
 * (found by fuzzing the loader).
 */
export const shown = (x: unknown): string => (typeof x === "object" && x !== null ? (Array.isArray(x) ? "a list" : "an object") : String(x));

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
      // Its outline comes from the kernel: featureSpec (extrude.ts) builds it.
      if (isSketchExtrude(feature)) throw new Error(`${feature.intent.summary}: an extrude of a sketch is built through featureSpec, which asks the kernel for the outline`);
      const profile = document.profiles.find((x) => x.id === p.profile);
      if (!profile) throw new Error(`${feature.intent.summary}: its profile ${shown(p.profile)} is missing`);
      return { extrude: { profile: outline(profile.kind, profile.width, profile.depth), distance: num(feature, "distance") } };
    }
    default:
      throw new Error(`unknown feature type ${feature.intent.type}`);
  }
}

/** The sizes the panel edits, keyed like its inputs; a shape fills only the ones it uses. */
export type PartSizes = Partial<Record<"width" | "depth" | "height", number>>;

/** What the part is: a preset shape, or an extrude of a sketch (step 21d), whose one size is its distance (the panel's height box). */
export type PartKind = ShapeKind | "sketch-extrude";

/**
 * The shape and sizes a document's final feature was made from: the
 * inverse of partDocument, for the panel showing a loaded part. Throws a
 * clear message for a feature the panel can't show.
 */
export function partOf(document: DesignDocument): { shape: PartKind; sizes: PartSizes } {
  const f = lastFeature(document);
  switch (f.intent.type) {
    case "box":
      return { shape: "box", sizes: { width: num(f, "width"), depth: num(f, "depth"), height: num(f, "height") } };
    case "cylinder":
      return { shape: "cylinder", sizes: { width: num(f, "diameter"), height: num(f, "height") } };
    case "sphere":
      return { shape: "sphere", sizes: { width: num(f, "diameter") } };
    case "extrude": {
      if (isSketchExtrude(f)) return { shape: "sketch-extrude", sizes: { height: num(f, "distance") } };
      const profile = document.profiles.find((x) => x.id === f.intent.parameters.profile);
      if (!profile) throw new Error(`${f.intent.summary}: its profile ${shown(f.intent.parameters.profile)} is missing`);
      if (!Object.hasOwn(profileNames, profile.kind)) throw new Error(`profile ${profile.id} has an unknown kind ${shown(profile.kind)}`);
      if (typeof profile.width !== "number" || typeof profile.depth !== "number") throw new Error(`profile ${profile.id}: width and depth must be numbers`);
      return { shape: profile.kind, sizes: { width: profile.width, depth: profile.depth, height: num(f, "distance") } };
    }
    default:
      throw new Error(`unknown feature type ${shown(f.intent.type)}`);
  }
}

/**
 * Version 1 (before step 21b) had no sketches and no id counter. The
 * counter starts above every number already used in an id, so no new id
 * can repeat one; the rest is kept as it was, for the version 2 checks.
 */
export function migrateDesignV1(d: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(d, "nextId") || Object.hasOwn(d, "sketches")) throw new Error("Design data says version 1 but has a nextId or sketches, which version 1 never had");
  const { version: _, ...rest } = d;
  const timeline = d.timeline as { features?: unknown } | undefined;
  const items = [...(Array.isArray(d.profiles) ? d.profiles : []), ...(Array.isArray(timeline?.features) ? timeline.features : [])];
  const used = items.map((x) => idNumber((x as { id?: unknown } | null)?.id)).filter((n) => n !== null);
  return { ...rest, version: 2, nextId: Math.max(0, ...used) + 1, sketches: [] };
}

/** The counter's number in an id such as "line-4" (4); null for an id the counter did not make. */
export function idNumber(id: unknown): number | null {
  const m = typeof id === "string" ? /-(\d+)$/.exec(id) : null;
  return m ? Number(m[1]) : null;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFiniteNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * A sketch's content, checked: points with finite mm, lines between two
 * different points of the same sketch, circles round a point of the same
 * sketch with a finite positive radius, arcs between two different points
 * round a third, no constraints yet. The kernel holds the limits on sizes
 * and where an arc's centre may be (sketch_outline), as it does for lines.
 */
function checkSketch(s: unknown, i: number): void {
  if (!isRecord(s) || typeof s.id !== "string") throw new Error(`Design sketch ${i + 1} has no id`);
  const at = `Design sketch ${s.id}`;
  if (!Array.isArray(s.points) || !Array.isArray(s.curves) || !Array.isArray(s.constraints)) throw new Error(`${at} needs points, curves and constraints lists`);
  if (s.constraints.length > 0) throw new Error(`${at} has constraints, which this Fission can't read yet`);
  const points = new Set<string>();
  for (const [j, p] of s.points.entries()) {
    if (!isRecord(p) || typeof p.id !== "string") throw new Error(`${at}: point ${j + 1} has no id`);
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) throw new Error(`${at}: point ${p.id} needs x and y in mm`);
    points.add(p.id);
  }
  for (const [j, c] of s.curves.entries()) {
    if (!isRecord(c) || typeof c.id !== "string") throw new Error(`${at}: curve ${j + 1} has no id`);
    if (c.kind === "circle") {
      if (typeof c.centre !== "string" || !points.has(c.centre)) throw new Error(`${at}: circle ${c.id} is round ${shown(c.centre)}, which is not one of the sketch's points`);
      if (!isFiniteNumber(c.radius) || c.radius <= 0) throw new Error(`${at}: circle ${c.id} needs a radius in mm above 0, not ${shown(c.radius)}`);
      continue;
    }
    if (c.kind === "arc") {
      for (const [role, p] of [["starts at", c.start], ["ends at", c.end], ["is round", c.centre]] as const)
        if (typeof p !== "string" || !points.has(p)) throw new Error(`${at}: arc ${c.id} ${role} ${shown(p)}, which is not one of the sketch's points`);
      if (c.start === c.end) throw new Error(`${at}: arc ${c.id} starts and ends at the same point`);
      if (c.centre === c.start || c.centre === c.end) throw new Error(`${at}: arc ${c.id} is round one of its own ends`);
      continue;
    }
    if (c.kind !== "line") throw new Error(`${at}: curve ${c.id} is a ${shown(c.kind)}, which this Fission can't read yet (only lines, circles and arcs)`);
    for (const end of [c.start, c.end])
      if (typeof end !== "string" || !points.has(end)) throw new Error(`${at}: line ${c.id} ends at ${shown(end)}, which is not one of the sketch's points`);
    if (c.start === c.end) throw new Error(`${at}: line ${c.id} starts and ends at the same point`);
  }
}

/**
 * Design's part of a loaded project, checked all the way down to the
 * numbers the panel shows, so a bad file is refused when it is opened
 * rather than failing later. Version 1 is migrated to version 2 first.
 */
export function readDesignDocument(data: unknown): DesignDocument {
  if (!isRecord(data)) throw new Error("Design data is missing");
  const d = (data.version === 1 ? migrateDesignV1(data) : data) as Partial<DesignDocument>;
  if (d.version !== 2) throw new Error(`Design data version ${shown(d.version)} is not one this Fission reads (1 or 2)`);
  if (!Array.isArray(d.profiles) || !Array.isArray(d.timeline?.features) || d.timeline.features.length === 0)
    throw new Error("Design data has no timeline");
  if (!Array.isArray(d.sketches)) throw new Error("Design data has no sketches list");
  if (!Number.isSafeInteger(d.nextId) || d.nextId! < 1) throw new Error(`Design data's nextId ${shown(d.nextId)} is not a counting number`);
  for (const [i, profile] of d.profiles.entries())
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw new Error(`Design profile ${i + 1} is not an object`);
  for (const [i, f] of d.timeline.features.entries()) {
    const intent = (f as Partial<Feature> | null)?.intent;
    if (typeof f?.id !== "string" || typeof intent?.type !== "string" || typeof intent.summary !== "string" || typeof intent.parameters !== "object" || intent.parameters === null)
      throw new Error(`Design feature ${i + 1} has no id or intent`);
  }
  d.sketches.forEach(checkSketch);
  // Each sketch has exactly one timeline item, on a plane this Fission knows, and each sketch item its sketch.
  const sketchIds = new Set(d.sketches.map((s) => s.id));
  const items = d.timeline.features.filter(isSketchItem);
  for (const f of items) {
    if (!sketchIds.has(f.id)) throw new Error(`Design timeline item ${f.id} is a sketch with no content in the sketches list`);
    if (!(SKETCH_PLANES as readonly unknown[]).includes(f.intent.parameters.plane)) throw new Error(`Design sketch ${f.id} is on ${shown(f.intent.parameters.plane)}, not a plane this Fission knows (XY, XZ or YZ)`);
  }
  for (const s of d.sketches) if (!items.some((f) => f.id === s.id)) throw new Error(`Design sketch ${s.id} has no place in the timeline`);
  // An extrude of a sketch comes after its sketch and depends on it, so a rebuild in order always has the outline.
  for (const [i, f] of d.timeline.features.entries()) {
    if (!isSketchExtrude(f)) continue;
    const p = f.intent.parameters;
    if (Object.hasOwn(p, "profile")) throw new Error(`Design feature ${f.id} extrudes both a sketch and a profile`);
    if (!d.timeline.features.slice(0, i).some((x) => x.id === p.sketch && isSketchItem(x)))
      throw new Error(`Design feature ${f.id} extrudes ${shown(p.sketch)}, which is not a sketch before it in the timeline`);
    if (!Array.isArray(f.dependsOn) || !f.dependsOn.includes(p.sketch as string)) throw new Error(`Design feature ${f.id} extrudes ${p.sketch} but does not depend on it`);
    if (!isFiniteNumber(p.distance)) throw new Error(`Design feature ${f.id}: distance ${shown(p.distance)} is not a number of mm`);
  }
  // Ids are unique in the document (a sketch shares its id with its timeline item), and the counter is above all of them.
  const seen = new Set<string>();
  const ids = [
    ...d.profiles.map((p) => p.id),
    ...d.timeline.features.map((f) => f.id),
    ...d.sketches.flatMap((s) => [...s.points.map((p) => p.id), ...s.curves.map((c) => c.id)]),
  ];
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Design id ${shown(id)} is used twice`);
    seen.add(id);
    const n = idNumber(id);
    if (n !== null && n >= d.nextId!) throw new Error(`Design data's nextId ${d.nextId} is not above ${id}, so a new id could repeat it`);
  }
  partOf(d as DesignDocument);
  return d as DesignDocument;
}

/**
 * The part's solid feature: the last timeline item that is not a sketch
 * (the only one until step 24, which builds every solid feature).
 */
export function lastFeature(document: DesignDocument): Feature {
  const f = [...document.timeline.features].reverse().find((x) => !isSketchItem(x));
  if (!f) throw new Error("Design data has no part: every timeline item is a sketch");
  return f;
}
