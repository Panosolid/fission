// Design's verbs in the one action registry (core's actions.ts). Today
// there is one: Download STL, for a body. The toolbar's STL button, the AI's
// export_stl command and the verb shown under a selected body all run it.

import type { Action, ActionOutcome, ActionRegistry, ActionTarget, RepresentationKind, Selected, WorkspaceContext } from "@fission/core";
import { lastFeature, partOf, specOf, type DesignDocument } from "./document.ts";
import { designReference } from "./references.ts";

export const DOWNLOAD_STL = "design.download-stl";

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

/**
 * What a selected Design thing can be handed over as. A body of the part:
 * its exact solid and a mesh. Faces and edges: nothing yet (a flat face's
 * outline comes with the conversions that need it). A reference to a body
 * that is no longer in the part: nothing.
 */
export function representationsOf(ref: Selected, doc: DesignDocument | undefined): RepresentationKind[] {
  if (!doc || ref.kind !== "body") return [];
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

/** Design's verbs; `save` hands a file to the user (the browser's download, or a test's recorder). */
export function designActions(save: SaveFile = download): Action[] {
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
  return [downloadStl];
}

/** Registers Design's verbs; the shell calls it once at start-up. */
export function registerDesignActions(registry: ActionRegistry, save?: SaveFile): void {
  for (const a of designActions(save)) registry.register(a);
}
