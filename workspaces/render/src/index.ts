// @fission/render: the Render workspace. PLACEHOLDER: nothing here works yet.
//
// Realistic images of your design, straight from the Design timeline.
// It will refer to Design's geometry by stable IDs and never copy it, so a
// design change flows straight through. Work starts after CAD step 25 (editing the timeline and rebuilding).

import type { BodyReference, WorkspacePlugin } from "@fission/core";
import { showPlaceholder } from "@fission/ui";

/** DRAFT: a saved render setup. Bodies are referenced, never copied. */
export interface RenderScene {
  id: string;
  name: string;
  bodies: { body: BodyReference; material: string }[];
  environment: string;
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
}

/** Renders a scene to an image. Not implemented yet. */
export function renderScene(_scene: RenderScene): Promise<ImageBitmap> {
  throw new Error("not implemented");
}

export const renderWorkspace: WorkspacePlugin = {
  id: "render",
  title: "Render",
  summary: "Realistic images of your design, straight from the Design timeline.",
  status: "placeholder",
  representations: { produces: [], accepts: [] },
  commands: [],
  mount(ctx) {
    showPlaceholder(ctx.properties, {
      title: "Render",
      summary: "Realistic images of your design, straight from the Design timeline.",
      plans: ["Path-traced images of the bodies in the current design, updated when the design changes", "Materials from the shared library (the same ones Design shows)", "Lighting, environments and saved cameras", "Scenes saved in the project file next to the design"],
      startsAfter: "after CAD step 25 (editing the timeline and rebuilding)",
    });
    return { unmount: () => ctx.properties.replaceChildren() };
  },
};
