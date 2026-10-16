// Our readers against Pillow's reading of the same files (GT2). The files
// and Pillow's results come from prototypes/oracle/image_fixtures.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mmPerPixelToDpi, readPhysicalSize } from "../src/physical-size.ts";

const dir = new URL("./fixtures/", import.meta.url);
const oracle = JSON.parse(readFileSync(new URL("oracle.json", dir), "utf8")) as {
  files: { file: string; format: string; width: number; height: number; dpi: [number, number] | null }[];
};

test("there are oracle files of both formats, with and without a size", () => {
  const kinds = new Set(oracle.files.map((f) => `${f.format}-${f.dpi ? "size" : "none"}`));
  assert.deepEqual([...kinds].sort(), ["jpeg-none", "jpeg-size", "png-none", "png-size"]);
});

for (const expected of oracle.files) {
  test(`agrees with Pillow on ${expected.file}`, () => {
    const ours = readPhysicalSize(new Uint8Array(readFileSync(new URL(expected.file, dir))));
    assert.equal(ours.format, expected.format);
    assert.equal(ours.width, expected.width);
    assert.equal(ours.height, expected.height);
    if (expected.dpi === null) {
      assert.equal(ours.source, "assumed");
    } else {
      assert.equal(ours.source, "file");
      // Pillow rounds the DPI it reports to 4 decimal places, so agreement is to within half of 0.0001.
      assert.ok(Math.abs(mmPerPixelToDpi(ours.mmPerPixel) - expected.dpi[0]) <= 0.00005 + 1e-9, `${mmPerPixelToDpi(ours.mmPerPixel)} vs Pillow ${expected.dpi[0]}`);
    }
  });
}
