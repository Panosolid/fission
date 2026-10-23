// Run at ddbb27ca (step 26f, Design data version 3): ./make.sh ddbb27ca v3-26f.ts
import type { DisplayMesh } from "@fission/core";
import { designWorkspace, partDocument } from "@fission/design";
import { app, close } from "./packages/testing/journeys/design-app.ts";
import { save } from "./save.ts";
// 26f, through the app itself: a 40 x 30 x 20 box, Sketch 1 on its top, a circle r 5 centred on the back right corner (snapped and pinned), extruded 10, then the box made 60 wide (the circle follows to (60, 30)).
function faceWhere(mesh: DisplayMesh, on: (p: number[]) => boolean): number {
  const all = new Map<number, boolean>();
  mesh.triangle_faces.forEach((f, t) => {
    const ok = [0, 1, 2].every((k) => { const i = mesh.indices[3 * t + k]; return on([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]); });
    all.set(f, (all.get(f) ?? true) && ok);
  });
  return [...all].filter(([, ok]) => ok).map(([f]) => f)[0];
}
const a = await app(partDocument("box", 40, 30, 20), designWorkspace);
a.$("#create-sketch")!.click();
await a.settle();
await a.pick({ face: faceWhere(a.mesh()!, (p) => p[2] === 20) });
await a.key("sketch-circle");
a.pointer("move", [39.6, 29.7]);
await a.settle();
await a.click(39.6, 29.7);
await a.click(45, 30);
a.$("#sketch-extrude")!.click();
await a.settle();
(a.$("#extrude-distance") as HTMLInputElement).value = "10";
(a.$("#extrude-ok") as HTMLButtonElement).click();
await a.settle();
const [box] = a.doc().timeline.features.map((f) => f.id);
await a.menu(box, "edit");
(a.$("#edit-width") as HTMLInputElement).value = "60";
a.$("#feature-edit-ok")!.click();
await a.settle();
console.log("volume", a.volume());
save("Pinned circle", "v3-face-pin.panosolid.json", a.doc());
await close(a);
