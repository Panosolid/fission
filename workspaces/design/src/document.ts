// Design's part of the project: profiles, sketches and the timeline
// (docs/document-model.md).
//
// Version 3 (step 24d1): every solid feature is its own body ("New body",
// until booleans join them), presets are ordinary features with ids from
// the counter, and the rollback marker is saved with the timeline. A new
// item goes in just after the marker and the marker moves onto it, the
// model's rule (packages/testing/src/timeline-model.ts). The part the
// panel edits is the last solid feature that builds (`partFeature`), or
// none: a design with no body (24f4) is one like any other, shown as an
// empty view. Each body is built from its
// feature's intent (specOf), so the intent is the source of truth, not a
// description written next to the geometry.

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

/**
 * An extrude's last shape (the owner's timeline rule, step 24d2): its
 * sketch's points and curves as they were just before the edit that lost
 * the sketch (deleted it, or left it with no outline). Saved in the
 * document's `kept`, by the extrude's id, while the sketch is lost, so the extrude
 * still builds, with a warning, after the file is opened again
 * (`rebuild.ts`, `settleKept`). Its ids are the sketch's old ones.
 */
export interface KeptShape {
  points: SketchPoint[];
  curves: SketchCurve[];
}

/** An extrude's kept shape, or undefined while its sketch makes an outline. */
export const keptOf = (doc: Pick<DesignDocument, "kept">, f: Feature): KeptShape | undefined => (doc.kept && Object.hasOwn(doc.kept, f.id) ? doc.kept[f.id] : undefined);

/** The planes a sketch can be on (a stable face id joins these at step 24). */
export const SKETCH_PLANES = ["XY", "XZ", "YZ"] as const;
export type SketchPlane = (typeof SKETCH_PLANES)[number];

/**
 * The most a design file holds (security audit S2): far above any real
 * part, but low enough that a file can't freeze the tab while it opens.
 * `items` counts the timeline, `profiles` the ready-made outlines,
 * `sketch` one sketch's (or kept shape's) points and curves together, and
 * `content` every sketch's and kept shape's points and curves together.
 * The kernel's own limit on one outline is 2,000 corners, so a sketch has
 * ten times that.
 */
export const DESIGN_LIMITS = { items: 5_000, profiles: 5_000, sketch: 20_000, content: 500_000 } as const;

/**
 * The rollback marker: the id of the last item built, or "start" when
 * nothing is; left out when everything is built (docs/project-format.md).
 */
export type Marker = string;

export interface DesignDocument {
  /** Version of this part of the project file (see docs/project-format.md). */
  version: 3;
  /** The number the next new id gets. Ids are never reused, even after a delete (docs/document-model.md, section 2). */
  nextId: number;
  profiles: ReadyProfile[];
  sketches: Sketch[];
  timeline: { features: Feature[]; marker?: Marker };
  /** Each extrude's kept shape while its sketch is lost (24d2), by the extrude's id; left out when there is none. */
  kept?: Record<string, KeptShape>;
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

const SHAPE_TYPES = { box: "box", cylinder: "cylinder", sphere: "sphere" } as const;
const isPrimitive = (kind: ShapeKind): kind is keyof typeof SHAPE_TYPES => Object.hasOwn(SHAPE_TYPES, kind);

/**
 * A preset's feature with this id, and the ready-made profile it extrudes
 * (with `profileId`) for a profile shape. Boxes, cylinders and spheres are
 * primitives (a cylinder's or sphere's width is its diameter); other shapes
 * extrude a ready-made profile by the height.
 */
function presetFeature(id: string, profileId: string | undefined, kind: ShapeKind, w: number, d: number, h: number): { feature: Feature; profile?: ReadyProfile } {
  const n = idNumber(id);
  const feature = (intent: Feature["intent"], dependsOn: string[] = [], from: Feature["provenance"]["from"] = []): Feature => ({
    id,
    intent,
    provenance: { self: { workspace: "design", id, label: `Feature ${n ?? id} (${intent.type})` }, from },
    dependsOn,
    suppressed: false,
  });
  if (kind === "box") return { feature: feature({ type: "box", parameters: { width: w, depth: d, height: h }, summary: `Box: ${dims(w, d, h)} mm` }) };
  if (kind === "cylinder") return { feature: feature({ type: "cylinder", parameters: { diameter: w, height: h }, summary: `Cylinder: ⌀${dims(w)} × ${h} mm` }) };
  if (kind === "sphere") return { feature: feature({ type: "sphere", parameters: { diameter: w }, summary: `Sphere: ⌀${w} mm` }) };
  if (profileId === undefined) throw new Error(`a ${kind} preset needs a profile id`);
  const profile: ReadyProfile = { id: profileId, kind, width: w, depth: d, plane: XY_PLANE };
  return {
    profile,
    feature: feature(
      { type: "extrude", parameters: { profile: profile.id, distance: h }, summary: `Extrude: ${profileLabel(profile)} ${dims(w, d)} mm, by ${h} mm` },
      [profile.id],
      [{ workspace: "design", id: profile.id, label: profileLabel(profile) }],
    ),
  };
}

/** The document for a new project: one preset, feature-1 (and profile-1 for a profile shape), the counter at 2. */
export function partDocument(kind: ShapeKind, w: number, d: number, h: number): DesignDocument {
  const { feature, profile } = presetFeature("feature-1", "profile-1", kind, w, d, h);
  return { version: 3, nextId: 2, profiles: profile ? [profile] : [], sketches: [], timeline: { features: [feature] } };
}

/** The index a new timeline item goes in at: just after the marker, first when it is at the start, else last. */
export function insertAt(doc: DesignDocument): number {
  const { features, marker } = doc.timeline;
  if (marker === undefined) return features.length;
  if (marker === "start") return 0;
  return features.findIndex((f) => f.id === marker) + 1;
}

/** The timeline with a new item put in at the marker (insertAt); the marker, when there is one, moves onto it. */
export function insertItem(doc: DesignDocument, item: Feature): DesignDocument["timeline"] {
  const features = [...doc.timeline.features];
  features.splice(insertAt(doc), 0, item);
  return doc.timeline.marker === undefined ? { ...doc.timeline, features } : { ...doc.timeline, features, marker: item.id };
}

/**
 * A new preset feature (a new body), its ids from the counter, put in at
 * the marker. A profile shape takes a second id for its ready-made profile.
 */
export function insertPreset(doc: DesignDocument, kind: ShapeKind, w: number, d: number, h: number): { doc: DesignDocument; id: string } {
  let nextId = doc.nextId;
  const id = `feature-${nextId++}`;
  const { feature, profile } = presetFeature(id, isPrimitive(kind) ? undefined : `profile-${nextId++}`, kind, w, d, h);
  return { id, doc: { ...doc, nextId, profiles: profile ? [...doc.profiles, profile] : doc.profiles, timeline: insertItem(doc, feature) } };
}

/**
 * The document with the preset feature `id` changed to this shape and
 * these sizes: the same feature, so it keeps its id, its place and its
 * profile's id (a profile shape that had none takes one from the counter;
 * a profile no feature uses any more goes).
 */
export function changePreset(doc: DesignDocument, id: string, kind: ShapeKind, w: number, d: number, h: number): DesignDocument {
  const old = doc.timeline.features.find((f) => f.id === id);
  if (!old || isSketchItem(old) || isSketchExtrude(old)) throw new Error(`there is no preset ${shown(id)} in the design`);
  let nextId = doc.nextId;
  const oldProfile = old.dependsOn.find((p) => doc.profiles.some((x) => x.id === p));
  const { feature, profile } = presetFeature(id, isPrimitive(kind) ? undefined : (oldProfile ?? `profile-${nextId++}`), kind, w, d, h);
  const features = doc.timeline.features.map((f) => (f === old ? { ...feature, suppressed: old.suppressed } : f));
  const used = new Set(features.flatMap((f) => f.dependsOn));
  const kept = doc.profiles.flatMap((p) => (p.id === profile?.id ? [profile] : p.id !== oldProfile || used.has(p.id) ? [p] : []));
  const profiles = profile && !kept.includes(profile) ? [...kept, profile] : kept;
  return { ...doc, nextId, profiles, timeline: { ...doc.timeline, features } };
}

/**
 * The document after the panel or set_part asks for this shape and these
 * sizes: the part (`partFeature`) changed in place when it is a preset,
 * else (an extrude of a sketch, or no part at all: 24f4) a new preset
 * feature put in at the marker, so nothing already in the timeline is
 * replaced. The counter never goes back.
 */
export function withPart(previous: DesignDocument | null | undefined, kind: ShapeKind, w: number, d: number, h: number): DesignDocument {
  if (!previous) return partDocument(kind, w, d, h);
  const part = partFeature(previous);
  return part === null || isSketchExtrude(part) ? insertPreset(previous, kind, w, d, h).doc : changePreset(previous, part.id, kind, w, d, h);
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
 * The shape and sizes the part (`partFeature`) was made from: the inverse
 * of partDocument, for the panel showing a loaded part; null when the
 * design has no body (24f4). Throws a clear message for a feature the
 * panel can't show.
 */
export function partOf(document: DesignDocument): { shape: PartKind; sizes: PartSizes } | null {
  const part = partFeature(document);
  return part === null ? null : shapeOf(document, part);
}

/** The shape and sizes a solid feature was made from (presetFeature's inverse; an extrude of a sketch has its distance). */
export function shapeOf(document: DesignDocument, f: Feature): { shape: PartKind; sizes: PartSizes } {
  return shapeWith(f, (id) => document.profiles.find((x) => x.id === id));
}

/** shapeOf with the profile found by `profileOf` (readDesignDocument's is a Map, so a big file reads in linear time). */
function shapeWith(f: Feature, profileOf: (id: unknown) => ReadyProfile | undefined): { shape: PartKind; sizes: PartSizes } {
  switch (f.intent.type) {
    case "box":
      return { shape: "box", sizes: { width: num(f, "width"), depth: num(f, "depth"), height: num(f, "height") } };
    case "cylinder":
      return { shape: "cylinder", sizes: { width: num(f, "diameter"), height: num(f, "height") } };
    case "sphere":
      return { shape: "sphere", sizes: { width: num(f, "diameter") } };
    case "extrude": {
      if (isSketchExtrude(f)) return { shape: "sketch-extrude", sizes: { height: num(f, "distance") } };
      const profile = profileOf(f.intent.parameters.profile);
      if (!profile) throw new Error(`${f.intent.summary}: its profile ${shown(f.intent.parameters.profile)} is missing`);
      // A kind that isn't text never reaches Object.hasOwn, which would turn it into text (issue #139).
      if (typeof profile.kind !== "string" || !Object.hasOwn(profileNames, profile.kind)) throw new Error(`profile ${profile.id} has an unknown kind ${shown(profile.kind)}`);
      if (typeof profile.width !== "number" || typeof profile.depth !== "number") throw new Error(`profile ${profile.id}: width and depth must be numbers`);
      return { shape: profile.kind, sizes: { width: profile.width, depth: profile.depth, height: num(f, "distance") } };
    }
    default:
      throw new Error(`unknown feature type ${shown(f.intent.type)}`);
  }
}

/**
 * Version 2 (steps 21b to 24c) showed one body, the last solid feature's,
 * and had no rollback marker. In version 3 every solid feature is a body,
 * so each solid feature but the last becomes suppressed: the design opens
 * looking as it did, and nothing is lost (unsuppressing one brings it
 * back). Ids, sizes and the counter are kept as they were.
 */
export function migrateDesignV2(d: Record<string, unknown>): Record<string, unknown> {
  const timeline = d.timeline as Record<string, unknown> | undefined;
  if (isRecord(timeline) && Object.hasOwn(timeline, "marker")) throw new Error("Design data says version 2 but has a timeline marker, which version 2 never had");
  if (!isRecord(timeline) || !Array.isArray(timeline.features)) return { ...d, version: 3 };
  const solids = new Set(timeline.features.filter((f) => !(isRecord(f) && isRecord(f.intent) && f.intent.type === "sketch")));
  const last = [...solids].at(-1);
  const features = timeline.features.map((f) => (solids.has(f) && f !== last && isRecord(f) ? { ...f, suppressed: true } : f));
  return { ...d, version: 3, timeline: { ...timeline, features } };
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

/**
 * What every id in Design's data looks like: a lower-case word, a dash and
 * the counter's number ("line-4"), or the word alone (a version 1 file's
 * "base", which the counter didn't make). No such id is "__proto__".
 */
const ID_SHAPE = /^[a-z]+(-\d+)?$/;

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
  if (s.constraints.length > 0) throw new Error(`${at} has constraints, which this Panoshape can't read yet`);
  notTooMany(s.points.length + s.curves.length, DESIGN_LIMITS.sketch, `${at} has`, "points and curves");
  checkContent(s.points, s.curves, at);
}

/** Refuses a count above its limit (DESIGN_LIMITS) before anything loops over what it counts: "Design data has 6000 timeline items, more than the 5000 …". */
function notTooMany(count: number, limit: number, has: string, what: string): void {
  if (count > limit) throw new Error(`${has} ${count} ${what}, more than the ${limit} this Panoshape opens`);
}

/** A sketch's or kept shape's points and curves, checked as checkSketch says; `at` starts each message. */
function checkContent(pointList: unknown[], curves: unknown[], at: string): void {
  const s = { points: pointList, curves };
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
    if (c.kind !== "line") throw new Error(`${at}: curve ${c.id} is a ${shown(c.kind)}, which this Panoshape can't read yet (only lines, circles and arcs)`);
    for (const end of [c.start, c.end])
      if (typeof end !== "string" || !points.has(end)) throw new Error(`${at}: line ${c.id} ends at ${shown(end)}, which is not one of the sketch's points`);
    if (c.start === c.end) throw new Error(`${at}: line ${c.id} starts and ends at the same point`);
  }
}

/** An extrude's kept shape, checked: a sketch's points and curves (checkContent), each id once. */
function checkKept(kept: unknown, feature: string): void {
  const at = `Design feature ${feature}'s kept shape`;
  if (!isRecord(kept) || !Array.isArray(kept.points) || !Array.isArray(kept.curves)) throw new Error(`${at} needs points and curves lists`);
  notTooMany(kept.points.length + kept.curves.length, DESIGN_LIMITS.sketch, `${at} has`, "points and curves");
  checkContent(kept.points, kept.curves, at);
  const seen = new Set<string>();
  for (const { id } of [...kept.points, ...kept.curves] as { id: string }[]) {
    if (seen.has(id)) throw new Error(`${at} uses the id ${shown(id)} twice`);
    seen.add(id);
  }
}

/**
 * Design's part of a loaded project, checked all the way down to the
 * numbers the panel shows, so a bad file is refused when it is opened
 * rather than failing later. Version 1 is migrated to version 2, and
 * version 2 to version 3 (migrateDesignV2), first.
 */
export function readDesignDocument(data: unknown): DesignDocument {
  if (!isRecord(data)) throw new Error("Design data is missing");
  // Counted before migrating, which spreads every id of a version 1 file.
  for (const [list, limit, what] of [[data.profiles, DESIGN_LIMITS.profiles, "profiles"], [isRecord(data.timeline) ? data.timeline.features : undefined, DESIGN_LIMITS.items, "timeline items"], [data.sketches, DESIGN_LIMITS.items, "sketches"]] as const)
    if (Array.isArray(list)) notTooMany(list.length, limit, "Design data has", what);
  const v2 = data.version === 1 ? migrateDesignV1(data) : data;
  const d = (v2.version === 2 ? migrateDesignV2(v2) : v2) as Partial<DesignDocument>;
  if (d.version !== 3) throw new Error(`Design data version ${shown(d.version)} is not one this Panoshape reads (1, 2 or 3)`);
  // An empty timeline is an empty design (24f4: everything deleted), shown with no body.
  if (!Array.isArray(d.profiles) || !Array.isArray(d.timeline?.features)) throw new Error("Design data has no timeline");
  if (!Array.isArray(d.sketches)) throw new Error("Design data has no sketches list");
  if (!Number.isSafeInteger(d.nextId) || d.nextId! < 1) throw new Error(`Design data's nextId ${shown(d.nextId)} is not a counting number`);
  for (const [i, profile] of d.profiles.entries()) {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw new Error(`Design profile ${i + 1} is not an object`);
    // Before anything turns it into text (the id check's regular expression, the profile's own messages): issue #139.
    if (typeof profile.id !== "string") throw new Error(`Design profile ${i + 1} has no id`);
  }
  for (const [i, f] of d.timeline.features.entries()) {
    const intent = (f as Partial<Feature> | null)?.intent;
    if (typeof f?.id !== "string" || typeof intent?.type !== "string" || typeof intent.summary !== "string" || typeof intent.parameters !== "object" || intent.parameters === null)
      throw new Error(`Design feature ${i + 1} has no id or intent`);
    if (typeof f.suppressed !== "boolean") throw new Error(`Design feature ${f.id}: suppressed must be true or false, not ${shown(f.suppressed)}`);
  }
  // Each id's first item, so every lookup below is one step (a search in a loop took minutes on a big file, audit S2).
  const byId = new Map<string, { item: Feature; at: number }>();
  for (const [at, item] of d.timeline.features.entries()) if (!byId.has(item.id)) byId.set(item.id, { item, at });
  const marker = d.timeline.marker;
  if (Object.hasOwn(d.timeline, "marker") && marker !== "start" && !byId.has(marker as string))
    throw new Error(`Design timeline marker ${shown(marker)} is not "start" or the id of an item in the timeline`);
  let content = 0;
  for (const [i, s] of d.sketches.entries()) {
    checkSketch(s, i);
    content += s.points.length + s.curves.length;
    notTooMany(content, DESIGN_LIMITS.content, "Design data's sketches have at least", "points and curves together");
  }
  // Each sketch has exactly one timeline item, on a plane this Panoshape knows, and each sketch item its sketch.
  const sketchIds = new Set(d.sketches.map((s) => s.id));
  const items = d.timeline.features.filter(isSketchItem);
  for (const f of items) {
    if (!sketchIds.has(f.id)) throw new Error(`Design timeline item ${f.id} is a sketch with no content in the sketches list`);
    if (!(SKETCH_PLANES as readonly unknown[]).includes(f.intent.parameters.plane)) throw new Error(`Design sketch ${f.id} is on ${shown(f.intent.parameters.plane)}, not a plane this Panoshape knows (XY, XZ or YZ)`);
  }
  const itemIds = new Set(items.map((f) => f.id));
  for (const s of d.sketches) if (!itemIds.has(s.id)) throw new Error(`Design sketch ${s.id} has no place in the timeline`);
  // An extrude of a sketch comes after its sketch and depends on it, so a rebuild in order always has the outline.
  for (const [i, f] of d.timeline.features.entries()) {
    if (!isSketchExtrude(f)) continue;
    const p = f.intent.parameters;
    if (Object.hasOwn(p, "profile")) throw new Error(`Design feature ${f.id} extrudes both a sketch and a profile`);
    // Its sketch may be gone (deleted: the extrude keeps its last shape, or fails naming it), but never another item or a later one.
    const there = byId.get(p.sketch as string)?.at ?? -1;
    if (typeof p.sketch !== "string" || (there >= 0 && (there > i || !isSketchItem(d.timeline.features[there]))))
      throw new Error(`Design feature ${f.id} extrudes ${shown(p.sketch)}, which is not a sketch before it in the timeline`);
    if (!Array.isArray(f.dependsOn) || !f.dependsOn.includes(p.sketch as string)) throw new Error(`Design feature ${f.id} extrudes ${p.sketch} but does not depend on it`);
    if (!isFiniteNumber(p.distance)) throw new Error(`Design feature ${f.id}: distance ${shown(p.distance)} is not a number of mm`);
  }
  if (Object.hasOwn(d, "kept")) {
    if (!isRecord(d.kept)) throw new Error("Design data's kept shapes are not an object of extrude ids");
    for (const [id, kept] of Object.entries(d.kept)) {
      const f = byId.get(id)?.item;
      if (!f || !isSketchExtrude(f)) throw new Error(`Design data keeps a shape for ${shown(id)}, which is not an extrude of a sketch in the timeline`);
      checkKept(kept, id);
      content += (kept as KeptShape).points.length + (kept as KeptShape).curves.length;
      notTooMany(content, DESIGN_LIMITS.content, "Design data's sketches and kept shapes have at least", "points and curves together");
    }
  }
  // Ids are unique in the document (a sketch shares its id with its timeline item), and the counter is above all of them.
  const seen = new Set<string>();
  const ids = [
    ...d.profiles.map((p) => p.id),
    ...d.timeline.features.map((f) => f.id),
    ...d.sketches.flatMap((s) => [...s.points.map((p) => p.id), ...s.curves.map((c) => c.id)]),
  ];
  // A kept shape holds a sketch's old ids (some may still be in the sketch): never repeated by a new id, so the counter is above them too.
  const kept = Object.values(d.kept ?? {}).flatMap((k) => [...k.points.map((p) => p.id), ...k.curves.map((c) => c.id)]);
  for (const id of kept) {
    const n = idNumber(id);
    if (n !== null && n >= d.nextId!) throw new Error(`Design data's nextId ${d.nextId} is not above ${id}, so a new id could repeat it`);
  }
  for (const id of ids) {
    // Shaped as Design makes ids (sketch-3), so no id is a name every object has, like __proto__ (re-check N1).
    if (!ID_SHAPE.test(id)) throw new Error(`Design id ${JSON.stringify(id)} is not shaped like Design's ids: a lower-case word and its number, like sketch-3`);
    if (seen.has(id)) throw new Error(`Design id ${shown(id)} is used twice`);
    seen.add(id);
    const n = idNumber(id);
    if (n !== null && n >= d.nextId!) throw new Error(`Design data's nextId ${d.nextId} is not above ${id}, so a new id could repeat it`);
  }
  // Every solid feature is its own body (24d1), so each one's sizes or profile are checked, not only the part's.
  // Whether any of them builds doesn't matter: a design with no body opens as one (24f4).
  const profiles = new Map<unknown, ReadyProfile>();
  for (const p of d.profiles) if (!profiles.has(p.id)) profiles.set(p.id, p);
  for (const f of d.timeline.features) if (!isSketchItem(f)) shapeWith(f, (id) => profiles.get(id));
  return d as DesignDocument;
}

/**
 * Whether a timeline item builds: it is at or before the marker, not
 * suppressed, and (an extrude of a sketch) its sketch builds too. The
 * kernel judges the rest (an outline that doesn't close) when it builds.
 * 24d2's rebuild replaces this with each item's real result.
 */
export function builds(document: DesignDocument, f: Feature): boolean {
  const { features, marker } = document.timeline;
  const at = features.indexOf(f);
  if (at < 0 || f.suppressed) return false;
  if (marker === "start" || (marker !== undefined && at > features.findIndex((x) => x.id === marker))) return false;
  if (!isSketchExtrude(f)) return true;
  const sketch = features.find((x) => x.id === f.intent.parameters.sketch && isSketchItem(x));
  // A deleted sketch: the extrude builds from its kept shape, if it has one (24d2).
  if (sketch === undefined) return keptOf(document, f) !== undefined;
  return builds(document, sketch);
}

/**
 * Every timeline item that builds (`builds`), for the whole timeline at
 * once in time in proportion to it (security audit S2): `builds` searches
 * the timeline on each call, so asking it about every item takes the
 * timeline's length squared, which froze the tab on a big file.
 */
export function buildingItems(document: DesignDocument): Set<Feature> {
  const { features, marker } = document.timeline;
  // Items before `end` are in range; a marker naming no item leaves none (as `builds` finds no index for it).
  const end = marker === "start" ? 0 : marker === undefined ? features.length : features.findIndex((x) => x.id === marker) + 1;
  const open = new Set<Feature>();
  const sketches = new Map<unknown, Feature>();
  for (const [i, f] of features.entries()) {
    if (i < end && !f.suppressed) open.add(f);
    if (isSketchItem(f) && !sketches.has(f.id)) sketches.set(f.id, f);
  }
  const out = new Set<Feature>();
  for (const f of open) {
    if (!isSketchExtrude(f)) out.add(f);
    else {
      const sketch = sketches.get(f.intent.parameters.sketch);
      if (sketch === undefined ? keptOf(document, f) !== undefined : open.has(sketch)) out.add(f);
    }
  }
  return out;
}

/**
 * The part the panel edits: the last solid feature that builds, or null
 * when none does (24f4: the marker at the start, every solid suppressed,
 * rolled back or deleted, or only sketches left). Every solid feature is
 * its own body in the data from version 3.
 */
export function partFeature(document: DesignDocument): Feature | null {
  const { features } = document.timeline;
  for (let i = features.length - 1; i >= 0; i--) if (!isSketchItem(features[i]) && builds(document, features[i])) return features[i];
  return null;
}

/** The part (`partFeature`) where one is needed (a test's or a command's build); throws when the design has no body. */
export function lastFeature(document: DesignDocument): Feature {
  const f = partFeature(document);
  if (!f) throw new Error("Design builds no body: every solid feature is suppressed, rolled back or deleted");
  return f;
}
