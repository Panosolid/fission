// @fission/core: the shared document model and the bridge to the kernel.
export { KernelClient, latestOnly, type KernelOps, type KernelRequest, type KernelResponse } from "./kernel/kernel-client";
export type { BodyView, DisplayMesh, Loop, Outline } from "./kernel/kernel-types";
// DRAFT model interfaces (see each file).
export type { Material } from "./model/material";
export type { LengthUnit, Project, WorkspaceId } from "./model/project";
export type { BodyReference, EdgeReference, FaceReference, GeometryReference, Resolution, StableId } from "./model/references";
export { resolveReference } from "./model/references";
export type { History, Selection } from "./model/session";
export type { ToolbarItem, ViewportOverlay, WorkspaceContext, WorkspacePlugin } from "./model/workspace";
