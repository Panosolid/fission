// Design's verbs in the one action registry (core's actions.ts). Download
// STL, for a body: the toolbar's STL button, the AI's export_stl command and
// the verb shown under a selected body all run it. Copy as SVG, for a
// profile: the verb under a selected profile and Ctrl+C both run it (X6b).

import { outlineToSvg, type Action, type ActionOutcome, type ActionRegistry, type ActionTarget, type RepresentationKind, type Selected, type WorkspaceContext } from "@fission/core";
import { lastFeature, partOf, profileLabel, specOf, type DesignDocument } from "./document.ts";
import { designReference, readProfileReference } from "./references.ts";
import { designObjects } from "./representations.ts";

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

/**
 * What a selected Design thing can be handed over as. A body of the part:
 * its exact solid and a mesh. A profile: its exact outline. Faces and
 * edges: nothing yet (a flat face's outline comes with the conversions
 * that need it). A reference to a body or profile that is no longer in the
 * part: nothing.
 */
export function representationsOf(ref: Selected, doc: DesignDocument | undefined): RepresentationKind[] {
  if (!doc) return [];
  if (ref.kind === "outline") {
    const id = readProfileReference(ref);
    return doc.profiles.some((p) => p.id === id) ? ["outline"] : [];
  }
  if (ref.kind !== "body") return [];
  return ref.id === designReference("body", lastFeature(doc).id).id ? ["solid", "mesh"] : [];
}

/** The selection as action targets. */
export function targetsOf(items: readonly Selected[], doc: DesignDocument | undefined): ActionTarget[] {
  return items.map((ref) => ({ ref, representations: representationsOf(ref, doc) }));
}

/** The reference to the part's one body, for "the whole part" (the toolbar's STL button, the AI's export_stl). */
export function partBody(doc: DesignDocument): Selected {
  return designReference("body", lastFeature(doc).id);
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
    title: "Download the body as a binary STL file, for printing or another program. Warns when it is too big for STL's single-precision numbers.",
    kinds: ["body"],
    uses: "mesh",
    count: "one",
    async run(targets, ctx: WorkspaceContext): Promise<ActionOutcome> {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      const [target] = targets;
      if (!doc) return { message: "There is no part to download yet.", bad: true };
      if (targets.length !== 1) return { message: `Download STL takes one body, not ${targets.length} things.`, bad: true };
      if (!representationsOf(target, doc).includes("mesh")) return { message: `${target.id} is not a body of the part, so there is nothing to download.`, bad: true };
      const kind = partOf(doc).shape;
      try {
        const file = await ctx.kernel.call("export_stl", specOf(doc, lastFeature(doc)), kind);
        save(file.bytes, `fission-${kind}.stl`);
        // Mark the part on screen too: every face moves in single precision.
        if (file.warning)
          ctx.viewport.setOverlay({ id: STL_OVERLAY, label: "Too big for an accurate STL", detail: file.warning, marks: [{ target: { body: true }, severity: "warning" }] });
        else ctx.viewport.clearOverlay(STL_OVERLAY);
        return { message: file.warning ?? "", bad: Boolean(file.warning) };
      } catch (e) {
        return { message: e instanceof Error ? e.message : String(e), bad: true };
      }
    },
  };
  const copySvg: Action = {
    id: COPY_SVG,
    workspace: "design",
    label: "Copy as SVG",
    title: "Copy the profile as an SVG drawing, sized in mm, to paste into a drawing program or a laser cutter's software.",
    kinds: ["outline"],
    uses: "outline",
    count: "one",
    async run(targets, ctx: WorkspaceContext): Promise<ActionOutcome> {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      const [target] = targets;
      if (!doc) return { message: "There is no profile to copy yet.", bad: true };
      if (targets.length !== 1) return { message: `Copy as SVG takes one profile, not ${targets.length} things.`, bad: true };
      if (!representationsOf(target, doc).includes("outline")) return { message: `${target.id} is not a profile of the part, so there is nothing to copy.`, bad: true };
      const id = readProfileReference(target)!;
      const profile = doc.profiles.find((p) => p.id === id)!;
      const object = designObjects(doc).find((o) => o.type === "design.profile" && o.id === id)!;
      try {
        // Copies out go through the representation registry, like everything handed over.
        const { representation } = await ctx.representations.deliver(object, ["outline"]);
        if (representation.kind !== "outline") throw new Error(`the profile came as ${representation.kind}, not an outline`);
        const svg = outlineToSvg(representation.outline, profileLabel(profile));
        await copy(svg.text);
        const mm = (v: number) => Number(v.toPrecision(6)).toString();
        return { message: `Copied as SVG: ${profileLabel(profile)}, ${mm(svg.width)} × ${mm(svg.height)} mm.`, bad: false };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return { message: `Could not copy the profile: ${why}`, bad: true };
      }
    },
  };
  return [downloadStl, copySvg];
}

/** Registers Design's verbs; the shell calls it once at start-up. */
export function registerDesignActions(registry: ActionRegistry, save?: SaveFile, copy?: CopySvg): void {
  for (const a of designActions(save, copy)) registry.register(a);
}
