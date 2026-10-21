// Editing an earlier feature from its timeline item (step 25a2): "Edit
// feature" in the item's menu opens the feature's sizes (a preset's width,
// depth and height, or diameter; an extrude of a sketch's distance) in its
// own panel (feature-edit-panel.ts), whichever item it is, not only the
// part. OK checks the sizes with the kernel and records the change as one
// undo step ("Edit Extrude 1"), an extrude's Flip with it (26c); the
// rebuild then builds that feature again
// and everything after it (rebuild.ts). A size the kernel refuses records
// nothing and keeps the panel open with the kernel's words, as the
// reference app refuses a typed 0 (the owner's answer, 2026-10-19).
// These are pure document functions; workspace.ts drives the panel.

import { KernelError, type BodySpec, type Feature, type KernelCalls } from "@fission/core";
import { changePreset, isSketchExtrude, isSketchItem, shapeOf, shown, specOf, type DesignDocument, type PartKind, type PartSizes } from "./document.ts";
import { featureSpec, isFlipped, setExtrudeDistance, setExtrudeFlip } from "./extrude.ts";
import type { Outline } from "./profiles.ts";
import { parameterRows, SIZE_KEYS, type SizeKey } from "./properties.ts";
import { buildSpec } from "./spec.ts";
import { itemName, TIMELINE_STEPS } from "./timeline-edits.ts";

/** What the Edit feature panel shows for an item: its shape, the sizes it has now, the boxes it uses, and an extrude's Flip (26c). */
export interface EditableFeature {
  id: string;
  name: string;
  shape: PartKind;
  sizes: PartSizes;
  keys: SizeKey[];
  flip?: boolean;
}

function featureIn(doc: DesignDocument, id: string): Feature {
  const f = doc.timeline.features.find((x) => x.id === id);
  if (!f) throw new Error(`there is no item ${shown(id)} in the timeline`);
  return f;
}

/** Whether item `id` has sizes to edit: every solid feature (a preset or an extrude of a sketch); a sketch is edited with Edit Sketch (25a3). */
export const canEditFeature = (f: Feature) => !isSketchItem(f);

/** Item `id`'s sizes as the panel shows them: the boxes its shape uses (parameterRows), with the values it has now. */
export function editableFeature(doc: DesignDocument, id: string): EditableFeature {
  const f = featureIn(doc, id);
  if (!canEditFeature(f)) throw new Error(`${itemName(f)} is a sketch: it has no sizes to edit`);
  const { shape, sizes } = shapeOf(doc, f);
  const keys = parameterRows(shape).filter((r) => r.shown).map((r) => r.key);
  return isSketchExtrude(f) ? { id, name: itemName(f), shape, sizes, keys, flip: isFlipped(f) } : { id, name: itemName(f), shape, sizes, keys };
}

/** OK's words when the design changed while the kernel checked the sizes (another edit, Undo): nothing was recorded. */
export const CHANGED_WHILE_CHECKING = "The design changed while the sizes were checked: nothing was changed. Press OK again.";

/** The undo step an Edit feature OK is recorded as ("Edit Extrude 1"). */
export const editStep = (doc: DesignDocument, id: string) => TIMELINE_STEPS.edit(itemName(featureIn(doc, id)));

/**
 * The document with item `id` given these sizes: the same feature, keeping
 * its id, its place, its suppressed flag and what it is built from; only
 * the sizes its shape uses are read (a size left out keeps its value). An
 * extrude of a sketch takes its distance from `height`, and its Flip from
 * `flip` (left out keeps it; a preset has none to set). The document
 * itself comes back when nothing changes, so nothing is recorded. Every
 * other item is left as it was (the "edit-leaks" plant breaks this).
 */
export function editFeature(doc: DesignDocument, id: string, typed: PartSizes, flip?: boolean): DesignDocument {
  const now = editableFeature(doc, id);
  if (flip !== undefined && now.flip === undefined) throw new Error(`${now.name} has no Flip: only an extrude of a sketch goes either way`);
  if (flip !== undefined && typeof flip !== "boolean") throw new Error(`${now.name}: Flip must be true or false, not ${shown(flip)}`);
  const flipped = flip === undefined || flip === now.flip ? doc : setExtrudeFlip(doc, flip, id);
  if (flipped !== doc) return editFeature(flipped, id, typed);
  const sizes: PartSizes = { ...now.sizes };
  for (const key of now.keys) {
    const v = typed[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${now.name}: its ${key} must be a number of mm, not ${shown(v)}`);
    sizes[key] = v;
  }
  if (now.keys.every((k) => sizes[k] === now.sizes[k])) return doc;
  if (now.shape === "sketch-extrude") return setExtrudeDistance(doc, sizes.height!, id);
  const w = sizes.width!;
  // A cylinder's and a sphere's width is their diameter; a sphere has no height of its own.
  const d = now.shape === "cylinder" || now.shape === "sphere" ? w : sizes.depth!;
  const h = now.shape === "sphere" ? w : sizes.height!;
  return changePreset(doc, id, now.shape, w, d, h);
}

/** A stand-in outline (mm) the distance of an extrude whose sketch makes none is checked on: only the distance is being judged. */
export const STAND_IN = 10;
const standIn: Outline = { outer: { path: { corners: [0, 0, STAND_IN, 0, STAND_IN, STAND_IN, 0, STAND_IN], bulges: [] } }, holes: [] };

/** The body item `id` builds in `doc`, or why it can't be found (its sketch makes no outline). */
async function specIn(kernel: KernelCalls, doc: DesignDocument, f: Feature): Promise<BodySpec | null> {
  if (!isSketchExtrude(f)) return specOf(doc, f);
  try {
    return await featureSpec(kernel, doc, f);
  } catch {
    return null;
  }
}

/** Whether the kernel builds `spec`: null when it does, else its error. */
async function failure(kernel: KernelCalls, spec: BodySpec): Promise<unknown> {
  try {
    await buildSpec(kernel, spec);
    return null;
  } catch (e) {
    return e;
  }
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));
const namesASize = (e: unknown) => e instanceof KernelError && e.inputs.some((i) => i.input === "param");

/**
 * Why the kernel refuses item `id`'s sizes in `next` (the document OK would
 * record), or null when it takes them. The edited feature is built: a
 * failure naming one of its sizes is refused with the kernel's words, and
 * so is any other failure that `before` didn't have (the edit broke a
 * feature that built). A feature that already failed for another reason
 * (its sketch makes no closed outline) keeps failing for that reason and
 * takes the edit; its distance alone is checked, on a stand-in square.
 */
export async function refusedSizes(kernel: KernelCalls, before: DesignDocument, next: DesignDocument, id: string): Promise<string | null> {
  const f = featureIn(next, id);
  const spec = await specIn(kernel, next, f);
  if (spec === null) {
    // No outline from its sketch: judge the distance alone.
    const distance = f.intent.parameters.distance as number;
    const e = await failure(kernel, { extrude: { profile: standIn, distance } });
    return e !== null && namesASize(e) ? words(e) : null;
  }
  const e = await failure(kernel, spec);
  if (e === null) return null;
  if (namesASize(e)) return words(e);
  // Another failure: refused when the feature built before this edit.
  const old = await specIn(kernel, before, featureIn(before, id));
  const was = old === null ? "failed" : await failure(kernel, old);
  return was === null ? words(e) : null;
}

/** The sizes typed in the panel's boxes, or the first box that isn't a number (its key), for the panel to say "Type the width in mm." */
export function readTyped(keys: readonly SizeKey[], typed: Partial<Record<SizeKey, string>>): { sizes: PartSizes } | { bad: SizeKey } {
  const sizes: PartSizes = {};
  for (const key of SIZE_KEYS) {
    if (!keys.includes(key)) continue;
    const text = typed[key] ?? "";
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v)) return { bad: key };
    sizes[key] = v;
  }
  return { sizes };
}
