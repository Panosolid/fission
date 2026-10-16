// Opening a saved project, through to the real kernel: a hand-written
// version-2 file and the same part as a version-1 file each open to a
// 50 × 30 × 20 box, and saving the opened project then opening it again
// builds the same body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectFromJson, projectToJson } from "@fission/core";
import { buildSpec, designWorkspace, lastFeature, specOf, type DesignDocument } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

const file = (formatVersion: 1 | 2) =>
  JSON.stringify({
    formatVersion,
    name: "Block",
    units: { length: "mm" },
    materials: [],
    ...(formatVersion === 2 ? { links: [] } : {}),
    workspaces: {
      design: {
        version: 1,
        profiles: [],
        timeline: {
          features: [
            {
              id: "feature-1",
              intent: { type: "box", parameters: { width: 50, depth: 30, height: 20 }, summary: "Box: 50 × 30 × 20 mm" },
              provenance: { self: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" }, from: [] },
              dependsOn: [],
              suppressed: false,
            },
          ],
        },
      },
    },
  });

test("a saved 50 × 30 × 20 box opens and builds, in version 1 and 2, and after a re-save", async () => {
  const kernel = nodeKernel();
  const volume = async (text: string) => {
    const doc = projectFromJson(text, [designWorkspace]).workspaces.design as DesignDocument;
    const view = await buildSpec(kernel, specOf(doc, lastFeature(doc)));
    assert.deepEqual(view.errors, []);
    return view.volume;
  };
  // V = 50 · 30 · 20 = 30000 mm³; a box's volume is exact in floating point.
  assert.equal(await volume(file(2)), 30000);
  assert.equal(await volume(file(1)), 30000);
  const resaved = projectToJson(projectFromJson(file(2), [designWorkspace]));
  assert.equal(await volume(resaved), 30000);
});
