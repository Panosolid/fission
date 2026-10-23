// Run at 498923df (step 24e, Design data version 3): ./make.sh 498923df v3-24e.ts
import { addSketch, drawCircle, drawRectangle, extrudeSketch, insertPreset, moveMarker, partDocument, suppressItem } from "@fission/design";
import { save } from "./save.ts";
// 24e: suppress and the rollback marker. A box, a cylinder (suppressed), a sphere, then a disc sketched and extruded; the marker rolled back to just after the sphere.
let doc = partDocument("box" as never, 40, 30, 20);
const cyl = insertPreset(doc, "cylinder" as never, 20, 20, 30); doc = cyl.doc;
const sph = insertPreset(doc, "sphere" as never, 30, 30, 30); doc = sph.doc;
const s = addSketch(doc, "XY"); doc = s.doc;
doc = drawCircle(doc, s.id, [100, 0], 20).doc;
doc = extrudeSketch(doc, s.id, 4).doc;
doc = suppressItem(doc, cyl.id, true);
doc = moveMarker(doc, sph.id);
save("Rolled back", "v3-suppressed-marker.panosolid.json", doc);
// The same design rolled to the very start: nothing builds.
save("At the start", "v3-marker-start.panosolid.json", moveMarker(doc, "start"));
