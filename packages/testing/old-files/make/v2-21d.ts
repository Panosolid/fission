// Run at 5f7a1d32 (step 21d, Design data version 2): ./make.sh 5f7a1d32 v2-21d.ts
import { addSketch, deleteCurve, drawLine, extrudeSketch, movePoint, setExtrudeDistance, withPart } from "@fission/design";
import { save } from "./save.ts";
// Step 21c/d: the default box, then a triangle sketched on XZ (a stray line drawn and deleted, a corner dragged), extruded, distance edited.
let doc = withPart(null, "box" as never, 40, 30, 20);
const s = addSketch(doc, "XZ"); doc = s.doc;
let r = drawLine(doc, s.id, [0, 0], [25, 0]); doc = r.doc;
const a = doc.sketches[0].points[0].id, b = doc.sketches[0].points[1].id;
r = drawLine(doc, s.id, b, [0, 40]); doc = r.doc;
const c = doc.sketches[0].points[2].id;
r = drawLine(doc, s.id, c, a); doc = r.doc;
r = drawLine(doc, s.id, c, [10, 10]); doc = deleteCurve(r.doc, s.id, r.id);
doc = movePoint(doc, s.id, b, 30, 0);
const e = extrudeSketch(doc, s.id, 10); doc = e.doc;
doc = setExtrudeDistance(doc, 12);
save("Wedge", "v2-wedge-xz.panosolid.json", doc);
