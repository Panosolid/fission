// @fission/design: the CAD workspace, the source of truth for all geometry.
export { outline, type ProfileKind, type ShapeKind, type Loop, type Outline } from "./profiles.ts";
export { designWorkspace } from "./workspace.ts";
export { buildSpec, specFor } from "./spec.ts";
export { lastFeature, partDocument, profileLabel, specOf, type DesignDocument, type ReadyProfile } from "./document.ts";
export { designObjects, outlineProducer, registerDesign, type FeatureHandle, type OutlineSource } from "./representations.ts";
