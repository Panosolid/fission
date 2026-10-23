// Run at acc1385f (step 26e, Design data version 3): ./make.sh acc1385f v3-26e.ts
import type { DisplayMesh } from "@fission/core";
import { designWorkspace, partDocument } from "@fission/design";
import { app, close } from "./packages/testing/journeys/design-app.ts";
import { save } from "./save.ts";
// 26c, through the app itself: a 40 x 30 x 20 box, Sketch 1 on its top face, a circle r 5 round the face's middle (20, 15), extruded 8 with Flip on (down into the box, z 12 to 20).
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
await a.click(20, 15);
await a.click(25, 15);
a.$("#sketch-extrude")!.click();
await a.settle();
(a.$("#extrude-distance") as HTMLInputElement).value = "8";
const flip = a.$("#extrude-flip") as HTMLInputElement;
flip.checked = true;
flip.dispatchEvent(new a.window.Event("change"));
(a.$("#extrude-ok") as HTMLButtonElement).click();
await a.settle();
if (a.sketching()) await a.finish();
console.log("volume", a.volume(), a.warning());
save("Flipped on a face", "v3-face-flip.panosolid.json", a.doc());
await close(a);
