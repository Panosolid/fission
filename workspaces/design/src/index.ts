// @fission/design: the CAD workspace, the source of truth for all geometry.
export { outline, type ProfileKind, type ShapeKind, type Loop, type Outline } from "./profiles.ts";
export { designWorkspace } from "./workspace.ts";
export { DESIGN_COMMANDS, documentFor, SHAPES } from "./commands.ts";
export { browserTree, type BrowserNode } from "./browser.ts";
export { toolbarGroups, type ToolButton, type ToolGroup } from "./toolbar.ts";
export { buildSpec, specFor } from "./spec.ts";
export { lastFeature, partDocument, profileLabel, readDesignDocument, specOf, type DesignDocument, type ReadyProfile } from "./document.ts";
export { PART_VIEW, syncGraph } from "./graph.ts";
export { designObjects, outlineProducer, registerDesign, type FeatureHandle, type OutlineSource } from "./representations.ts";
