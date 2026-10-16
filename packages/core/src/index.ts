// @fission/core: the shared document model and the bridge to the kernel.
export { KernelClient, latestOnly, type KernelCalls, type KernelOps, type KernelRequest, type KernelResponse } from "./kernel/kernel-client.ts";
export type { BodySpec, BodyView, DisplayMesh, Loop, Outline, StlFile } from "./kernel/kernel-types.ts";
// DRAFT model interfaces (see each file).
export type { Material } from "./model/material.ts";
export type { LengthUnit, Project, WorkspaceId } from "./model/project.ts";
export { emptyProject } from "./model/project.ts";
export type { BodyReference, EdgeReference, FaceReference, GeometryReference, Resolution, StableId } from "./model/references.ts";
export { resolveReference } from "./model/references.ts";
export type { History, Selection } from "./model/session.ts";
export { historyNotBuilt, selectionNotBuilt } from "./model/session.ts";
export type { Framing, SharedViewport } from "./model/viewport.ts";
export type { Converter, DataRep, Delivery, ImageRep, MeshRep, OutlineRep, Plane, Producer, Producible, Representation, RepresentationKind, RepresentationOf, SolidRep } from "./model/representation.ts";
export type { Feature, Intent, Origin, ParameterValue, Provenance, Timeline } from "./model/feature.ts";
export { describeProvenance } from "./model/feature.ts";
export { EXACTNESS, isExact, RepresentationRegistry, XY_PLANE } from "./model/representation.ts";
export type { ToolbarItem, ViewportOverlay, WorkspaceContext, WorkspacePlugin } from "./model/workspace.ts";
