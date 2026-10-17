// What the assistant will do in each workspace (roadmap A7–A8). Shown on
// the assistant panel's placeholder for the active workspace. A workspace's
// AI features come after the workspace itself is real; Design's first,
// after step 24.

import type { WorkspaceId } from "@fission/core";

export const AI_FEATURES: Record<WorkspaceId | "suite", string[]> = {
  design: [
    "Plain-English commands (\"add a 5 mm hole in the middle of the top face\")",
    "Parameter edits",
    "Explaining why a feature failed",
    "Design review: printability and thin walls",
    "Generating parameter variants",
  ],
  render: ["Scene setup from a description", "Material suggestions", "Camera framing"],
  simulate: ["Loads and constraints in plain English", "Explaining results", "Suggesting design fixes", "Parameter sweeps"],
  manufacture: ["Suggesting strategies, tools and feeds and speeds, with reasons", "Explaining G-code", "Flagging risky moves", "Never runs a machine"],
  laser: ["Power and speed suggestions for a material", "Parametric finger-joint boxes", "Tracing photos"],
  slice: ["Diagnosing print failures from a description or photo", "Suggesting settings and orientation"],
  circuit: ["Datasheet and component questions", "Explaining design-rule errors", 'Drafting schematics, marked "AI draft — review required"'],
  vector: ["Tracing", "Cleaning up shapes", "Layout suggestions", "Optional image generation, only with your own API key"],
  image: ["Background removal", "Upscaling", "Smart selection", "Inpainting"],
  layout: ["Layout and alignment suggestions", "Resizing a design for another format", "Writing and shortening text"],
  suite: [
    '"What breaks if I change this?" from the dependency graph',
    "Questions about the whole project: total filament, cost, parts",
    "Generating build instructions",
  ],
};
