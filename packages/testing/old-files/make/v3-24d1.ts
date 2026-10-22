// Run at 453785dd (step 24d1, Design data version 3): ./make.sh 453785dd v3-24d1.ts
import { addSketch, changePreset, drawRectangle, extrudeSketch, insertPreset, partDocument } from "@fission/design";
import { save } from "./save.ts";
// 24d1, first version 3: every solid is a body. A box, a cylinder added, a block sketched on XZ and extruded, the box resized.
let doc = partDocument("box" as never, 40, 30, 20);
const box = doc.timeline.features[0].id;
doc = insertPreset(doc, "cylinder" as never, 20, 20, 30).doc;
const s = addSketch(doc, "XZ"); doc = s.doc;
doc = drawRectangle(doc, s.id, [100, 0], [110, 10]).doc;
doc = extrudeSketch(doc, s.id, 10).doc;
doc = changePreset(doc, box, "box" as never, 50, 30, 20);
save("Three bodies", "v3-three-bodies.panosolid.json", doc);
