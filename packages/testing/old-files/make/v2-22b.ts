// Run at 9de34d8a (step 22b, Design data version 2): ./make.sh 9de34d8a v2-22b.ts
import { addSketch, drawCircle, drawRectangle, extrudeSketch, withPart } from "@fission/design";
import { save } from "./save.ts";
// Circles and rectangles (21e era): a 60 x 40 plate with a 10 mm radius hole, then a second sketch on YZ, a circle extruded.
let doc = withPart(null, "box" as never, 40, 30, 20);
let s = addSketch(doc, "XY"); doc = s.doc;
doc = drawRectangle(doc, s.id, [0, 0], [60, 40]).doc;
doc = drawCircle(doc, s.id, [30, 20], 10).doc;
doc = extrudeSketch(doc, s.id, 8).doc;
save("Plate with hole", "v2-plate-hole.panosolid.json", doc);
s = addSketch(doc, "YZ"); doc = s.doc;
doc = drawCircle(doc, s.id, [0, 50], 5).doc;
doc = extrudeSketch(doc, s.id, 20).doc;
save("Two sketches", "v2-two-sketches.panosolid.json", doc);
