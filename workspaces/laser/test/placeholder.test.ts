import { test } from "node:test";
import assert from "node:assert/strict";
import { exportSvg, laserWorkspace } from "../src/index.ts";

test("Laser is a placeholder and says so", () => {
  assert.equal(laserWorkspace.status, "placeholder");
  assert.throws(() => exportSvg({ id: "j", layers: [] }), /not implemented/);
});
