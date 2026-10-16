// Specialist local models, separate from the language model: small
// single-purpose models running in the browser (ONNX Runtime Web on
// WebGPU). PLACEHOLDERS. Each is downloaded on first use, after showing
// its size, and runs on the user's machine.

import type { WorkspaceId } from "@fission/core";

export type SpecialistTask = "background-removal" | "segmentation" | "upscaling" | "inpainting" | "tracing" | "print-failure";

export interface SpecialistInfo {
  task: SpecialistTask;
  title: string;
  workspaces: WorkspaceId[];
  /** When it is planned, if not with its workspace's first AI features. */
  later?: string;
}

export const SPECIALISTS: readonly SpecialistInfo[] = [
  { task: "background-removal", title: "Background removal", workspaces: ["image"] },
  { task: "segmentation", title: "Smart selection (segmentation)", workspaces: ["image"] },
  { task: "upscaling", title: "Upscaling", workspaces: ["image"] },
  { task: "inpainting", title: "Inpainting (fill a selection)", workspaces: ["image"] },
  { task: "tracing", title: "Image tracing to paths", workspaces: ["vector", "laser"] },
  { task: "print-failure", title: "Print-failure classification from photos", workspaces: ["slice"], later: "after Slice is real" },
];

export interface SpecialistModel {
  readonly task: SpecialistTask;
  /** Bytes to download, shown to the user before the first use. */
  readonly downloadSize: number;
  run(input: ImageData): Promise<ImageData | { paths: string[] } | { label: string; confidence: number }>;
}

/** Loads a specialist model, downloading it on first use after a size warning. Not implemented yet. */
export function loadSpecialist(_task: SpecialistTask): Promise<SpecialistModel> {
  throw new Error("not implemented");
}
