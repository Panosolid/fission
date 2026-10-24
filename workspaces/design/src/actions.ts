// Design's verbs in the one action registry (core's actions.ts). Download
// STL, for one body or several: the toolbar's STL button and the AI's
// export_stl command (every body shown) and the verb shown under selected
// bodies all run it. Copy as SVG, for a profile or a sketch: the verb under
// it and Ctrl+C both run it (X6b, 25c1).

import { outlineToSvg, type Action, type ActionOutcome, type ActionRegistry, type ActionTarget, type Feature, type GeometryReference, type OverlayMark, type RepresentationKind, type Selected, type StlFile, type WorkspaceContext } from "@fission/core";
import { bodyFeatures } from "./browser.ts";
import { partFeature, shapeOf, type DesignDocument } from "./document.ts";
import { featureSpec } from "./extrude.ts";
import { bodyReference, readDesignReference, readProfileReference } from "./references.ts";
import { designObjects } from "./representations.ts";
import type { Scene } from "./scene.ts";
import { outlineSourceOf } from "./sketch.ts";

export const DOWNLOAD_STL = "design.download-stl";
export const COPY_SVG = "design.copy-svg";

/** The STL-precision overlay: the whole part, while its last export warned. Design clears it on every edit. */
export const STL_OVERLAY = "design.stl-precision";

/** Hands `bytes` to the browser as a file download. */
function download(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export type SaveFile = (bytes: Uint8Array<ArrayBuffer>, name: string) => void;

/** Puts an SVG file on the clipboard; rejects when the browser refuses. */
export type CopySvg = (svg: string) => Promise<void>;

/**
 * The browser's clipboard: the SVG as an image/svg+xml item where the
 * browser supports one (drawing programs paste the shape), always with the
 * same text as text/plain (text editors and code paste the markup).
 */
async function copyToClipboard(svg: string): Promise<void> {
  const text = new Blob([svg], { type: "text/plain" });
  if (typeof ClipboardItem !== "undefined" && ClipboardItem.supports?.("image/svg+xml"))
    return navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }), "text/plain": text })]);
  return navigator.clipboard.writeText(svg);
}

/** Nothing failed: what a document alone says, before any rebuild has answered. */
const NONE_FAILED: ReadonlySet<string> = new Set();

/**
 * The solid feature a body reference names, when it is one of the bodies
 * shown (`bodyFeatures`, less `failed`: the last rebuild's failed ids);
 * null for a face, an edge, or a body rolled back, suppressed, deleted or
 * failed (25c1: any body shown, not only the part's).
 */
export function shownBodyFeature(ref: Selected, doc: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): Feature | null {
  if (ref.kind !== "body") return null;
  const r = readDesignReference(ref as GeometryReference);
  if (r === null || r.kind !== "body" || failed.has(r.featureId)) return null;
  return bodyFeatures(doc).find((f) => f.id === r.featureId) ?? null;
}

/**
 * What a selected Design thing can be handed over as. A body shown: its
 * exact solid and a mesh. A profile or a sketch with curves: its exact
 * outline (a sketch's is found by the kernel when asked for, so an open
 * one is refused then, saying why). Faces and edges: nothing yet (a flat
 * face's outline comes with the conversions that need it). A reference to
 * anything no longer shown: nothing.
 */
export function representationsOf(ref: Selected, doc: DesignDocument | undefined, failed: ReadonlySet<string> = NONE_FAILED): RepresentationKind[] {
  if (!doc) return [];
  if (ref.kind === "outline") return outlineSourceOf(ref, doc) ? ["outline"] : [];
  return shownBodyFeature(ref, doc, failed) ? ["solid", "mesh"] : [];
}

/** The selection as action targets; `failed`, the last rebuild's failed ids. */
export function targetsOf(items: readonly Selected[], doc: DesignDocument | undefined, failed: ReadonlySet<string> = NONE_FAILED): ActionTarget[] {
  return items.map((ref) => ({ ref, representations: representationsOf(ref, doc, failed) }));
}

/** What the toolbar's STL button says for a design with no body (24f4). */
export const NO_BODY_STL = "There is no body to download: nothing in the timeline builds.";

/** The reference to the part's body (the last solid feature that builds); null for a design with no body (24f4). */
export function partBody(doc: DesignDocument): Selected | null {
  const part = partFeature(doc);
  return part === null ? null : bodyReference(part.id);
}

/** Every body shown, for "the whole design" (the toolbar's STL button, the AI's export_stl; 25c1), in build order; none for a design with no body. */
export function shownBodyRefs(doc: DesignDocument, failed: ReadonlySet<string> = NONE_FAILED): Selected[] {
  return bodyFeatures(doc).flatMap((f) => (failed.has(f.id) ? [] : [bodyReference(f.id)]));
}

const STL_HEADER = 80;
const STL_TRIANGLE = 50;

/**
 * Binary STL files joined into one (25c1): an 80-byte header with `name`
 * after "SpindleLabs STL: " (as the kernel writes its own), the sum of their
 * triangle counts, then every file's triangles unchanged, in order. A file
 * whose length disagrees with its count throws, and nothing is written.
 */
export function joinStl(files: readonly Uint8Array[], name: string): Uint8Array<ArrayBuffer> {
  let triangles = 0;
  for (const [i, f] of files.entries()) {
    const n = f.length >= STL_HEADER + 4 ? new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(STL_HEADER, true) : -1;
    if (n < 0 || f.length !== STL_HEADER + 4 + STL_TRIANGLE * n) throw new Error(`STL file ${i + 1} is ${f.length} bytes, which is not 84 + 50 for each of its triangles`);
    triangles += n;
  }
  if (triangles > 0xffffffff) throw new Error(`${triangles} triangles is more than one STL file can count`);
  const out = new Uint8Array(STL_HEADER + 4 + STL_TRIANGLE * triangles);
  // Spaces after the name, as the kernel pads its header; never "solid" first (that reads as ASCII STL).
  out.fill(0x20, 0, STL_HEADER);
  const text = new TextEncoder().encode(`SpindleLabs STL: ${name}`).subarray(0, STL_HEADER);
  out.set(text, 0);
  new DataView(out.buffer).setUint32(STL_HEADER, triangles, true);
  let at = STL_HEADER + 4;
  for (const f of files) {
    out.set(f.subarray(STL_HEADER + 4), at);
    at += f.length - STL_HEADER - 4;
  }
  return out;
}

/**
 * What Design's own runs add to the context (25c1): the bodies on screen,
 * so the precision overlay marks only the faces of the bodies that warned.
 * Without it (a run from elsewhere) a warning marks every body.
 */
export interface DesignRun extends WorkspaceContext {
  scene?: Scene | null;
}

/** The overlay's marks for the bodies (by feature id) that warned: their faces on `scene`, or every body when there is no scene or each shown body warned. */
export function warnedMarks(warned: readonly string[], scene: Scene | null | undefined): OverlayMark[] {
  const at = scene ? warned.map((id) => scene.bodies.findIndex((b) => b.feature === id)) : [];
  if (!scene || at.some((b) => b < 0) || new Set(at).size === scene.bodies.length) return [{ target: { body: true }, severity: "warning" }];
  return at.flatMap((b) => Array.from({ length: scene.bodies[b].view.faces }, (_, i) => ({ target: { face: scene.faceStart[b] + i }, severity: "warning" as const })));
}

/**
 * Design's verbs; `save` hands a file to the user (the browser's download,
 * or a test's recorder), `copy` puts an SVG on the clipboard (the
 * browser's, or a test's recorder).
 */
export function designActions(save: SaveFile = download, copy: CopySvg = copyToClipboard): Action[] {
  const downloadStl: Action = {
    id: DOWNLOAD_STL,
    workspace: "design",
    label: "Download STL",
    title: "Download the bodies as one binary STL file, for printing or another program. Warns when one is too big for STL's single-precision numbers.",
    kinds: ["body"],
    uses: "mesh",
    count: "many",
    async run(targets, ctx: DesignRun): Promise<ActionOutcome> {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      if (!doc) return { message: "There is no part to download yet.", bad: true };
      if (targets.length === 0) return { message: "Download STL takes at least one body.", bad: true };
      const features: Feature[] = [];
      for (const target of targets) {
        // Design's own run knows the bodies the last rebuild drew (a failed one is not among them).
        const f = shownBodyFeature(target, doc);
        if (!f || (ctx.scene && !ctx.scene.bodies.some((b) => b.feature === f.id))) return { message: `${target.id} is not a body shown in the design, so there is nothing to download.`, bad: true };
        if (!features.includes(f)) features.push(f);
      }
      // Build order, whatever order they were picked in: the same bodies make the same file.
      const order = bodyFeatures(doc);
      features.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const kindOf = (f: Feature) => {
        const shape = shapeOf(doc, f).shape;
        return shape === "sketch-extrude" ? "extrude" : shape;
      };
      try {
        const files: StlFile[] = [];
        for (const f of features) files.push(await ctx.kernel.call("export_stl", await featureSpec(ctx.kernel, doc, f), kindOf(f)));
        const one = features.length === 1;
        const name = one ? kindOf(features[0]) : `${features.length} bodies`;
        save(one ? files[0].bytes : joinStl(files.map((f) => f.bytes), name), `fission-${one ? name : `${features.length}-bodies`}.stl`);
        // Mark the bodies that warned on screen too: every face of one moves in single precision.
        const warned = features.filter((_, i) => files[i].warning);
        if (warned.length > 0)
          ctx.viewport.setOverlay({ id: STL_OVERLAY, label: "Too big for an accurate STL", detail: files.flatMap((f) => (f.warning ? [f.warning] : [])).join("\n"), marks: warnedMarks(warned.map((f) => f.id), ctx.scene) });
        else ctx.viewport.clearOverlay(STL_OVERLAY);
        // Which body, when there are several: its browser row's number.
        const place = (f: Feature) => `Body ${order.indexOf(f) + 1}`;
        const message = features.flatMap((f, i) => (files[i].warning ? [one ? files[i].warning! : `${place(f)}: ${files[i].warning}`] : [])).join(" ");
        return { message, bad: warned.length > 0 };
      } catch (e) {
        return { message: e instanceof Error ? e.message : String(e), bad: true };
      }
    },
  };
  const copySvg: Action = {
    id: COPY_SVG,
    workspace: "design",
    label: "Copy as SVG",
    title: "Copy the profile or sketch as an SVG drawing, sized in mm, to paste into a drawing program or a laser cutter's software.",
    kinds: ["outline"],
    uses: "outline",
    count: "one",
    async run(targets, ctx: WorkspaceContext): Promise<ActionOutcome> {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      const [target] = targets;
      if (!doc) return { message: "There is no profile to copy yet.", bad: true };
      if (targets.length !== 1) return { message: `Copy as SVG takes one profile or sketch, not ${targets.length} things.`, bad: true };
      const source = outlineSourceOf(target, doc);
      if (!source) return { message: `${target.id} is not a profile or a sketch with curves, so there is nothing to copy.`, bad: true };
      const id = readProfileReference(target)!;
      const type = source.kind === "profile" ? "design.profile" : "design.sketch";
      const object = designObjects(doc, ctx.kernel).find((o) => o.type === type && o.id === id)!;
      try {
        // Copies out go through the representation registry, like everything handed over.
        const { representation } = await ctx.representations.deliver(object, ["outline"]);
        if (representation.kind !== "outline") throw new Error(`the ${source.kind} came as ${representation.kind}, not an outline`);
        const svg = outlineToSvg(representation.outline, source.label);
        await copy(svg.text);
        const mm = (v: number) => Number(v.toPrecision(6)).toString();
        return { message: `Copied as SVG: ${source.label}, ${mm(svg.width)} × ${mm(svg.height)} mm.`, bad: false };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { message: `Could not copy the ${source.kind}: ${why}`, bad: true };
      }
    },
  };
  return [downloadStl, copySvg];
}

/** Registers Design's verbs; the shell calls it once at start-up. */
export function registerDesignActions(registry: ActionRegistry, save?: SaveFile, copy?: CopySvg): void {
  for (const a of designActions(save, copy)) registry.register(a);
}
