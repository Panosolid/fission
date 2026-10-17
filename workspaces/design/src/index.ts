// @fission/design: the CAD workspace, the source of truth for all geometry.
export { outline, type ProfileKind, type ShapeKind, type Loop, type Outline } from "./profiles.ts";
export { designWorkspace } from "./workspace.ts";
export { DESIGN_COMMANDS, documentFor, SHAPES } from "./commands.ts";
export { browserTree, type BrowserNode } from "./browser.ts";
export { parameterRows, propertiesPanel, SIZE_KEYS, type ParameterRow, type Verb, type PropertiesPanel, type SizeKey } from "./properties.ts";
export { toolbarGroups, type ToolButton, type ToolGroup } from "./toolbar.ts";
export { buildSpec, specFor } from "./spec.ts";
export { idNumber, isSketchItem, lastFeature, migrateDesignV1, partDocument, partOf, profileLabel, readDesignDocument, SKETCH_PLANES, specOf, withPart, type DesignDocument, type PartSizes, type ReadyProfile, type Sketch, type SketchCurve, type SketchPlane, type SketchPoint } from "./document.ts";
export { addSketch, deleteCurve, drawLine, movePoint, planeOf, SKETCH_STEPS, sketchItem, sketchLines, sketchOutline, type LineEnd } from "./sketch.ts";
export { PART_VIEW, syncGraph } from "./graph.ts";
export { designObjects, outlineProducer, registerDesign, type FeatureHandle, type OutlineSource } from "./representations.ts";
export { designReference, PLACEHOLDER_ID_NOTE, profileReference, readProfileReference } from "./references.ts";
export { pickChange, type SelectionChange } from "./picking.ts";
export { COPY_SVG, designActions, DOWNLOAD_STL, partBody, registerDesignActions, representationsOf, STL_OVERLAY, targetsOf, type CopySvg, type SaveFile } from "./actions.ts";
