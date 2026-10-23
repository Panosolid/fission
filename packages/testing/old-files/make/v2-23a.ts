// Run at 087917ce (step 23a, Design data version 2): ./make.sh 087917ce v2-23a.ts
import { addSketch, drawArc, drawLine, extrudeSketch, withPart } from "@fission/design";
import { save } from "./save.ts";
// Arcs (last version 2): a slot of two lines and two half circles, extruded; then the part changed to a cylinder preset.
let doc = withPart(null, "box" as never, 40, 30, 20);
const s = addSketch(doc, "XY"); doc = s.doc;
let r = drawLine(doc, s.id, [0, 0], [30, 0]); doc = r.doc;
const pts = () => doc.sketches[0].points;
const p0 = pts()[0].id, p1 = pts()[1].id;
r = drawArc(doc, s.id, p1, [30, 20], [30, 10]); doc = r.doc;
const p2 = pts().find((p) => p.x === 30 && p.y === 20)!.id;
r = drawLine(doc, s.id, p2, [0, 20]); doc = r.doc;
const p3 = pts().find((p) => p.x === 0 && p.y === 20)!.id;
r = drawArc(doc, s.id, p3, p0, [0, 10]); doc = r.doc;
doc = extrudeSketch(doc, s.id, 5).doc;
save("Slot sketch", "v2-arc-slot.panosolid.json", doc);
doc = withPart(doc, "cylinder" as never, 20, 20, 30);
save("Slot then cylinder", "v2-sketch-then-cylinder.panosolid.json", doc);
