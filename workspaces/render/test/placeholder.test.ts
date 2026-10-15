import { test } from "node:test";
import assert from "node:assert/strict";
import { renderScene, renderWorkspace } from "../src/index.ts";

test("Render is a placeholder and says so", () => {
  assert.equal(renderWorkspace.status, "placeholder");
  assert.throws(() => renderScene({ id: "s", name: "s", bodies: [], environment: "studio", camera: { position: [0, 0, 1], target: [0, 0, 0], fov: 45 } }), /not implemented/);
});
