// @fission/image: the Image workspace.
//
// Photo and texture editing: layers, masks, adjustments, brushes and
// selections, PNG and JPEG import and export. Images keep their physical
// size (mm per pixel), so an image can become a texture or material map in
// Render, a raster engraving in Laser, a lithophane in Slice, or traced
// outlines in Vector or a Design sketch. The base (G1) is being built now,
// ahead of the rest, which starts after CAD step 33 and Render R1–R2.
//
// Built: reading a file's pixel and physical size, the limits, the
// one-layer document and Brightness (G1a); opening a PNG or JPEG and
// showing it at its real size in the shared viewport (G1b).

import type { WorkspacePlugin } from "@fission/core";
import { mountImage, openImageFile } from "./workspace.ts";

export * from "./errors.ts";
export * from "./limits.ts";
export * from "./physical-size.ts";
export * from "./adjust.ts";
export * from "./document.ts";
export * from "./open.ts";
export * from "./panels.ts";
export { mountImage, openImageFile, resetImageWorkspace } from "./workspace.ts";

const summary = "Photo and texture editing with real-world sizes, for textures, engravings, lithophanes and tracing.";

export const imageWorkspace: WorkspacePlugin = {
  id: "image",
  title: "Image",
  summary,
  status: "working",
  // Handing images to other workspaces comes with the links (G2).
  representations: { produces: [], accepts: [] },
  // A PNG or JPEG dropped or pasted anywhere opens here (X6).
  registerRepresentations: (registry) => registry.registerImporter({ formats: ["png", "jpeg"], workspace: "image", open: (name, bytes) => openImageFile(name, bytes) }),
  commands: [],
  mount: (ctx) => mountImage(ctx),
};
