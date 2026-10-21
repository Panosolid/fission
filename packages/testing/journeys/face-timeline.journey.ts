// Step 26e on the real kernel: the timeline's rules on a sketch drawn on a
// face, in the Design app as the shell runs it (design-app.ts). A box,
// Sketch 1 on its top (a 20 × 20 square) and Extrude 1 of it by 10:
//   - the box suppressed greys the sketch and the extrude, each saying the
//     box is why, with no warning (Fusion's answer Q3); the greyed sketch
//     isn't drawn and can't be opened; one undo step brings them back;
//   - a drop of the sketch before the box, or the box after the sketch, is
//     refused in words naming the face (answer 7);
//   - the box deleted asks first, naming what stays; confirmed, the sketch
//     stays at z = 20 drawn red with its plane lost and the extrude stays
//     with its source lost (Q1), warned on the bar, the browser's rows and
//     the panel; one undo step brings everything back, and redo again.
// Then bugs planted in workspace.ts, each caught. Run with `npm run
// journeys` after the app build.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DisplayMesh, WorkspacePlugin } from "@fission/core";
import { designWorkspace, dropState, partDocument } from "@fission/design";
import { app, close } from "./design-app.ts";

type App = Awaited<ReturnType<typeof app>>;

/** The one face of the mesh every point of which passes `on`, by kernel index. */
function faceWhere(mesh: DisplayMesh, on: (p: number[]) => boolean): number {
  const all = new Map<number, boolean>();
  mesh.triangle_faces.forEach((f, t) => {
    const ok = [0, 1, 2].every((k) => {
      const i = mesh.indices[3 * t + k];
      return on([mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]);
    });
    all.set(f, (all.get(f) ?? true) && ok);
  });
  const found = [...all].filter(([, ok]) => ok).map(([f]) => f);
  assert.equal(found.length, 1, `one face, got ${found}`);
  return found[0];
}

/** Each bar item's flags, by id: s suppressed, g greyed, w warned, f failed. */
function bar(a: App): Record<string, string> {
  const out: Record<string, string> = {};
  for (const li of a.window.document.querySelectorAll<HTMLElement>(".timeline-bar-item[data-item]")) {
    const d = li.dataset;
    out[d.item!] = (d.suppressed ? "s" : "") + (d.greyed ? "g" : "") + (d.warned ? "w" : "") + (d.failed ? "f" : "");
  }
  return out;
}
/** Item `id`'s words on the bar with nothing wrong: its place and summary ("2. Sketch 1 on a face of Feature 1 (box)"). */
const label = (a: App, id: string) => {
  const at = a.doc().timeline.features.findIndex((f) => f.id === id);
  return `${at + 1}. ${a.doc().timeline.features[at].intent.summary}`;
};
const title = (a: App, id: string) => a.$(`.timeline-bar-item[data-item="${id}"]`)!.title;
/** The browser's Timeline row of item `id`. */
const row = (a: App, id: string) => a.$(`[data-node="timeline"] .tree-row[data-node="${id}"]`)!;

const LOST = "Sketch 1's face is gone, so its plane is lost: it stays where it was.";
const SOURCE = "Extrude 1's source is lost: Sketch 1's plane is lost, so it stays where it was.";

/** The whole journey on Design (or a planted copy); throws at the first thing that differs. */
async function journey(plugin: WorkspacePlugin) {
  const a = await app(partDocument("box", 40, 30, 20), plugin);
  a.$("#create-sketch")!.click();
  await a.settle();
  await a.pick({ face: faceWhere(a.mesh()!, (p) => p[2] === 20) });
  for (const [x, y] of [[10, 5], [30, 5], [30, 25], [10, 25], [10.3, 4.8]]) await a.click(x, y);
  a.$("#sketch-extrude")!.click();
  await a.settle();
  (a.$("#extrude-distance") as HTMLInputElement).value = "10";
  (a.$("#extrude-ok") as HTMLButtonElement).click();
  await a.settle();
  const [box, sketch, extrude] = a.doc().timeline.features.map((f) => f.id);
  assert.equal(a.doc().timeline.features.length, 3);
  // 40 · 30 · 20 = 24000 for the box and 20 · 20 · 10 = 4000 for the block on top.
  assert.ok(close(a.volume(), 28000), `built: ${a.volume()} mm³`);
  assert.deepEqual(bar(a), { [box]: "", [sketch]: "", [extrude]: "" });
  assert.equal(a.drawings().length, 1, "Sketch 1 drawn");

  // ---- The box suppressed: everything on it greyed, naming it, no warning (Q3). ----
  assert.equal(await a.menu(box, "suppress"), null);
  assert.deepEqual(bar(a), { [box]: "s", [sketch]: "g", [extrude]: "g" }, "greyed, not warned or failed");
  for (const id of [sketch, extrude]) assert.equal(title(a, id), `${label(a, id)} (greyed: Feature 1 (box) is suppressed)`);
  for (const id of [sketch, extrude]) {
    assert.ok(row(a, id).classList.contains("timeline-menu-greyed"), `${id}'s browser row greyed`);
    assert.equal(row(a, id).title, "Greyed: Feature 1 (box) is suppressed");
  }
  assert.equal(a.warning(), null, "no warning while greyed");
  assert.equal(a.drawings().length, 0, "the greyed sketch isn't drawn");
  assert.equal(a.volume(), 0, "nothing built");
  assert.equal(await a.menu(sketch, "edit-sketch"), "Sketch 1 is greyed: Feature 1 (box) is suppressed, unsuppress it first");
  assert.equal(a.sketching(), false);
  assert.equal(await a.undo(), "Suppress Feature 1 (box)");
  assert.deepEqual(bar(a), { [box]: "", [sketch]: "", [extrude]: "" });
  assert.ok(!row(a, sketch).classList.contains("timeline-menu-greyed"));
  assert.equal(row(a, sketch).title.startsWith("Greyed"), false);
  assert.ok(close(a.volume(), 28000));
  assert.equal(a.drawings().length, 1);

  // ---- Drops across the face's link refused in words (answer 7). ----
  assert.deepEqual(dropState(a.doc(), sketch, 0), { kind: "refused", message: "Sketch 1 can't go before Feature 1 (box): it is drawn on a face of Feature 1 (box)" });
  assert.deepEqual(dropState(a.doc(), box, 2), { kind: "refused", message: "Feature 1 (box) can't go after Sketch 1: Sketch 1 is drawn on a face of it" });

  // ---- The box deleted: asked first; Cancel changes nothing. ----
  const steps = a.history.undoLabel();
  assert.equal(await a.menu(box, "delete"), null);
  assert.ok((a.$("#delete-ask") as HTMLDialogElement).open, "asked first");
  assert.equal(a.$("#delete-ask-heading")!.textContent, "Delete Feature 1 (box)?");
  assert.equal(
    a.$("#delete-ask-words")!.textContent,
    "Sketch 1 is drawn on a face of Feature 1 (box). If you delete it, Sketch 1 stays where it is and shows its plane is lost, and what is built from it, Extrude 1, stays where it is and shows its source is lost. Undo brings Feature 1 (box) back.",
  );
  a.$("#delete-ask-cancel")!.click();
  await a.settle();
  assert.equal(a.doc().timeline.features.length, 3, "Cancel deletes nothing");
  assert.equal(a.history.undoLabel(), steps, "and records nothing");
  // Confirmed this time.
  await a.menu(box, "delete");
  a.$("#delete-ask-confirm")!.click();
  await a.settle();
  const deleted = () => {
    assert.deepEqual(a.doc().timeline.features.map((f) => f.id), [sketch, extrude]);
    // The block stays where it was, z 20 to 30: 4000 mm³ (Q1).
    assert.ok(close(a.volume(), 4000), `the block stays: ${a.volume()} mm³`);
    const zs = Array.from({ length: a.mesh()!.positions.length / 3 }, (_, i) => a.mesh()!.positions[3 * i + 2]);
    assert.deepEqual([Math.min(...zs), Math.max(...zs)], [20, 30], "at z 20 to 30");
    assert.deepEqual(bar(a), { [sketch]: "w", [extrude]: "w" }, "both warned, neither failed");
    assert.equal(title(a, sketch), `${label(a, sketch)} (warning: ${LOST})`);
    assert.equal(title(a, extrude), `${label(a, extrude)} (warning: ${SOURCE})`);
    assert.equal(a.warning(), `${LOST} ${SOURCE}`);
    for (const [id, words] of [[sketch, LOST], [extrude, SOURCE]]) {
      assert.ok(row(a, id).classList.contains("kept"), `${id}'s browser row red`);
      assert.equal(row(a, id).title, words);
    }
    // Sketch 1 drawn red where it stays: the top's plane, z = 20.
    const [d] = a.drawings();
    assert.equal(a.drawings().length, 1);
    assert.equal(d.lost, true, "drawn red");
    assert.deepEqual(d.plane.origin, [0, 0, 20]);
  };
  deleted();
  assert.equal(await a.undo(), "Delete Feature 1 (box)", "one undo step");
  assert.deepEqual(bar(a), { [box]: "", [sketch]: "", [extrude]: "" });
  assert.ok(close(a.volume(), 28000));
  assert.equal(a.warning(), null);
  for (const id of [sketch, extrude]) assert.ok(!row(a, id).classList.contains("kept"), `${id} no longer red`);
  assert.equal(a.drawings()[0].lost, undefined, "not red once the box is back");
  assert.equal(await a.redo(), "Delete Feature 1 (box)");
  deleted();
  assert.ok(await a.close(), "every body freed");
}

test("hand-worked: a sketch on the box's top, extruded; the box suppressed greys both, a drop across the face refused, the box deleted asks and leaves both warned and the sketch red, one undo step each", async () => {
  await journey(designWorkspace);
});

// ---- Bugs planted in workspace.ts, each caught ----

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

const PLANTS: { name: string; find: string; replace: string }[] = [
  // A lost sketch drawn like any other.
  { name: "lost-not-red", find: "const lostSketches = () => new Set(warningsNow.flatMap((w) => (w.lost ? [w.item] : [])));", replace: "const lostSketches = () => new Set<string>();" },
  // The panel shows only the last warning, as before 26e.
  { name: "panel-last-warning", find: 'panel.showWarning(shown.map((w) => w.words).join(" "));', replace: 'panel.showWarning(shown.at(-1)?.words ?? "");' },
  // The bar is never told of warnings.
  { name: "bar-unwarned", find: "      warnings: warnedRows(),\n", replace: "" },
  // An extrude whose source is lost says nothing.
  { name: "source-silent", find: "      if (r.source) out.push(", replace: "      if (r.source && false) out.push(" },
  // Greyed rows in the browser left as they are.
  { name: "browser-not-greyed", find: '      row.classList.toggle("timeline-menu-greyed", by !== undefined);', replace: "" },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<WorkspacePlugin> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-face-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("each bug planted in workspace.ts is caught by the journey", async () => {
  // The copy unplanted passes, so a catch is the plant's and not the copying's.
  await journey(await planted({ name: "none", find: "let fits = 0;", replace: "let fits = 0;" }));
  for (const plant of PLANTS) {
    const design = await planted(plant);
    const caught = await journey(design).then(
      () => null,
      (e: Error) => e.message.split("\n")[0],
    );
    assert.ok(caught !== null, `${plant.name} was not caught`);
    if (process.env.FISSION_PLANTED_REPORT) console.log(`${plant.name}: ${caught}`);
  }
});
