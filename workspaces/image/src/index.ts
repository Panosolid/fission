// @fission/image: the Image workspace. Its page is still a PLACEHOLDER:
// nothing can be opened from the app yet (roadmap G1b).
//
// Photo and texture editing: layers, masks, adjustments, brushes and
// selections, PNG and JPEG import and export. Images keep their physical
// size (mm per pixel), so an image can become a texture or material map in
// Render, a raster engraving in Laser, a lithophane in Slice, or traced
// outlines in Vector or a Design sketch. The base (G1) is being built now,
// ahead of the rest, which starts after CAD step 33 and Render R1–R2.
//
// Built (G1a, no UI yet): reading a file's pixel and physical size, the
// limits, the one-layer document and Brightness.

import type { WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

export * from "./errors.ts";
export * from "./limits.ts";
export * from "./physical-size.ts";
export * from "./adjust.ts";
export * from "./document.ts";

const summary = "Photo and texture editing with real-world sizes, for textures, engravings, lithophanes and tracing.";

export const imageWorkspace: WorkspacePlugin = {
  id: "image",
  title: "Image",
  summary,
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Image",
      summary,
      plans: [
        "Layers, masks, adjustments, brushes and selections",
        "PNG and JPEG import and export, with physical size kept",
        "Use an image as a texture in Render, a raster engraving in Laser or a lithophane in Slice",
        "Trace an image into outlines for Vector or a Design sketch",
      ],
      startsAfter: "after CAD step 33 and Render's first steps (R1–R2); the basics (opening a PNG or JPEG at its real size, one layer, brightness) are being built first",
    });
    return () => ctx.properties.replaceChildren();
  },
};
