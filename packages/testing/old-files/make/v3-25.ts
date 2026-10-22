// Run at b356a35a (step 25, Design data version 3): ./make.sh b356a35a v3-25.ts
import { addSketch, drawLine, extrudeSketch, movePoint, partDocument, planDelete } from "@fission/design";
import { nodeKernel } from "./packages/testing/src/node-kernel.ts";
import { save } from "./save.ts";
// 24f/25: deleting a used sketch keeps its shape for the extrude. A box, an L sketched (a corner dragged), extruded, then the sketch deleted.
let doc = partDocument("box" as never, 40, 30, 20);
const s = addSketch(doc, "XY"); doc = s.doc;
const at: [number, number][] = [[50, 0], [80, 0], [80, 10], [60, 10], [60, 25], [50, 30]];
let r = drawLine(doc, s.id, at[0], at[1]); doc = r.doc;
const id = (x: number, y: number) => doc.sketches[0].points.find((p) => p.x === x && p.y === y)!.id;
for (let i = 1; i < at.length - 1; i++) doc = drawLine(doc, s.id, id(...at[i]), at[i + 1]).doc;
doc = drawLine(doc, s.id, id(...at[5]), id(...at[0])).doc;
doc = movePoint(doc, s.id, id(60, 25), 60, 30);
const e = extrudeSketch(doc, s.id, 6); doc = e.doc;
const plan = await planDelete(nodeKernel(), doc, s.id);
save("Kept L", "v3-kept-shape.panosolid.json", plan.next);
