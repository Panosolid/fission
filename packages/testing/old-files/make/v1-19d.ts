// Run at 63113192 (step 19d, Design data version 1): ./make.sh 63113192 v1-19d.ts
import { partDocument } from "@fission/design";
import { save } from "./save.ts";
// One ready-made part each, as the panel made it: a plate with two holes, a slot, a star, a sphere.
save("Plate", "v1-plate.panosolid.json", partDocument("plate" as never, 60, 40, 5));
save("Slot", "v1-slot.panosolid.json", partDocument("slot" as never, 50, 20, 10));
save("Star", "v1-star.panosolid.json", partDocument("star" as never, 40, 40, 10));
save("Ball", "v1-sphere.panosolid.json", partDocument("sphere" as never, 30, 30, 30));
