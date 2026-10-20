// Journey: the 25a bug hunt's seeded sessions (step 25a5), in the real
// Design workspace on the real WASM kernel (design-app.ts). Every way of
// editing an early item, mixed as a careless user would: Edit feature with
// sizes typed right, wrong or junk and finished by OK, Enter, Cancel or
// Escape; Edit Sketch with a stray line or none, left by Finish Sketch or
// by opening something else; suppress, the marker (from the item menu and
// the four playback buttons), deletes asked and answered either way, Undo,
// Redo and another workspace in between. After every step, against rules
// written here apart from Design's own:
//   - the view's volume (worked out from the drawn triangles) is the sum of
//     the volumes the file's built items make: w·d·h for a box, the
//     shoelace area of a sketch's one closed loop of lines (or of the shape
//     its extrude kept) times the distance, and an item builds only before
//     the marker, unsuppressed, its sketch building too;
//   - the timeline bar shows the file's items in order with their flags;
//   - an Edit feature OK that the rules accept records one undo step
//     "Edit <item>" that changes that item's sizes and nothing else, and
//     closes the panel; a size they refuse records nothing, keeps the
//     panel open and says why (the owner's Fusion answer: -5, 0 and an
//     empty box are not taken);
//   - Undo then Redo gives back the same file, new ids come from the
//     counter, the file reads back the same, the kernel holds no more
//     bodies than are built, and nothing throws.
// Planted bugs in workspace.ts's wiring, each caught. Sessions:
// `FISSION_SESSIONS` × `FISSION_SESSION_STEPS` (default 8 × 60); a
// failure prints its seed and the steps before it. Run with
// `npm run journeys`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { emptyProject, projectFromJson, projectToJson, type Feature } from "@fission/core";
import { addSketch, designWorkspace, drawRectangle, extrudeSketch, insertPreset, partDocument, type DesignDocument } from "@fission/design";
import { app, close, kernel } from "./design-app.ts";

const SEEDS = Number(process.env.FISSION_SESSIONS ?? 8);
const STEPS = Number(process.env.FISSION_SESSION_STEPS ?? 60);

/** Mulberry32, so a failing session replays from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The start of every session: a box, two extruded rectangles side by side, and a box after them (all flat-sided, so the drawn volume is exact). */
function start(): DesignDocument {
  let doc = partDocument("box", 40, 30, 20);
  for (const [x0, w, h, dist] of [
    [100, 40, 30, 20],
    [200, 30, 20, 10],
  ]) {
    const made = addSketch(doc);
    doc = extrudeSketch(drawRectangle(made.doc, made.id, [x0, 0], [x0 + w, h]).doc, made.id, dist).doc;
  }
  return insertPreset(doc, "box", 4, 5, 6).doc;
}

// ---------------------------------------------------------------- the rules, apart from Design

interface Content {
  points: { id: string; x: number; y: number }[];
  curves: { id: string; kind: string; start?: string; end?: string }[];
}

/** The area inside `c` when its curves are lines making one closed loop (every point the end of exactly two, one walk using them all), by the shoelace formula; else null. */
export function loopArea(c: Content): number | null {
  const lines = c.curves;
  if (lines.length < 3 || lines.some((l) => l.kind !== "line")) return null;
  const at = new Map(c.points.map((p) => [p.id, p]));
  const ends = new Map<string, typeof lines>();
  for (const l of lines) for (const p of [l.start!, l.end!]) ends.set(p, [...(ends.get(p) ?? []), l]);
  if ([...ends.values()].some((x) => x.length !== 2)) return null;
  let point = lines[0].start!;
  let line = lines[0];
  let twice = 0;
  for (let used = 0; used < lines.length; used++) {
    const next = line.start === point ? line.end! : line.start!;
    const [p, q] = [at.get(point), at.get(next)];
    if (!p || !q) return null;
    twice += p.x * q.y - q.x * p.y;
    point = next;
    line = ends.get(point)!.find((l) => l !== line)!;
  }
  return point === lines[0].start ? Math.abs(twice) / 2 : null;
}

/**
 * The volume the file's built items make, by the rules in the comment at
 * the top: each solid's own volume where it builds, 0 where it doesn't.
 * An extrude whose sketch is there and building but makes no loop builds
 * from its kept shape when it has one, else fails; one whose sketch is gone
 * builds from its kept shape or fails; one whose sketch is suppressed or
 * after the marker doesn't build.
 */
export function modelVolume(doc: DesignDocument): number {
  const items = doc.timeline.features;
  const marker = doc.timeline.marker;
  const stop = marker === undefined ? items.length : marker === "start" ? 0 : items.findIndex((f) => f.id === marker) + 1;
  const active = (i: number) => i < stop && !items[i].suppressed;
  const kept = (doc.kept ?? {}) as Record<string, Content>;
  let total = 0;
  items.forEach((f, i) => {
    if (!active(i)) return;
    const p = f.intent.parameters as Record<string, number | string>;
    if (f.intent.type === "box") total += (p.width as number) * (p.depth as number) * (p.height as number);
    if (f.intent.type !== "extrude") return;
    const s = items.findIndex((x) => x.id === p.sketch);
    if (s >= 0 && !active(s)) return;
    const own = s >= 0 ? loopArea(doc.sketches.find((x) => x.id === p.sketch) as unknown as Content) : null;
    const area = own ?? (kept[f.id] ? loopArea(kept[f.id]) : null);
    if (area !== null) total += area * Math.abs(p.distance as number);
  });
  return total;
}

/** JSON with every object's keys sorted: the file writer sorts them, so their order is no change. */
const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** Every id the file hands out. */
const idsOf = (doc: DesignDocument) =>
  new Set([...doc.timeline.features.map((f) => f.id), ...doc.profiles.map((p) => p.id), ...doc.sketches.flatMap((s) => [s.id, ...s.points.map((p) => p.id), ...s.curves.map((c) => c.id)])]);

/** A new id in `after` whose number is below `before`'s counter (handed out again), or null. */
export function reusedId(before: DesignDocument, after: DesignDocument): string | null {
  const had = idsOf(before);
  for (const id of idsOf(after)) if (!had.has(id) && Number(/-(\d+)$/.exec(id)?.[1]) < before.nextId) return id;
  return null;
}

/** What an Edit feature step changed besides item `id`'s sizes ("" when nothing). */
export function leak(before: DesignDocument, after: DesignDocument, id: string): string {
  const a = before.timeline.features;
  const b = after.timeline.features;
  if (a.map((f) => f.id).join() !== b.map((f) => f.id).join()) return "the items changed";
  for (const [i, f] of a.entries()) {
    if (f.id === id) {
      const g = b[i];
      if (g.intent.type !== f.intent.type || g.suppressed !== f.suppressed || JSON.stringify(g.dependsOn) !== JSON.stringify(f.dependsOn)) return `${id} changed more than its sizes`;
    } else if (JSON.stringify(f) !== JSON.stringify(b[i])) return `${f.id} changed too`;
  }
  for (const k of ["sketches", "kept", "nextId"] as const) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return `its ${k} changed`;
  return before.timeline.marker === after.timeline.marker ? "" : "the marker moved";
}

/** The sizes the Edit feature panel shows for `f`, and whether the rules take these typed texts: decimals, each from 0.001 to 1,000,000 mm (the kernel's MIN_FEATURE and MAX_SIZE; a distance too, which is one way only until extrudes go either way). */
const SIZE_BOXES: Record<string, string[]> = { box: ["width", "depth", "height"], extrude: ["height"] };
export function takes(f: Feature, typed: string[]): boolean {
  return typed.every((t) => {
    if (!/^\s*-?\d+(\.\d+)?\s*$/.test(t)) return false;
    const v = Number(t);
    return v >= 1e-3 && v <= 1e6;
  });
}
/** The sizes a typed edit leaves `f` with, as numbers in the panel's order. */
const sizesOf = (f: Feature) => {
  const p = f.intent.parameters as Record<string, number>;
  return f.intent.type === "extrude" ? [p.distance] : [p.width, p.depth, p.height];
};

/** What a careless user types in a size box: mostly a size, some junk, some refused. */
const JUNK = ["0", "-5", "", " ", "abc", "1e9", "0.0000001", "-0", "12mm", "1,5", "Infinity", "NaN"];

// ---------------------------------------------------------------- the session

const REACHED: Record<string, number> = {};
const reach = (k: string) => void (REACHED[k] = (REACHED[k] ?? 0) + 1);

export async function chaosSession(seed: number, steps: number, plugin = designWorkspace): Promise<string | null> {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const a = await app(start(), plugin);
  const errors: string[] = [];
  const onError = (e: Event) => errors.push(String((e as ErrorEvent).error?.stack ?? (e as ErrorEvent).message));
  a.window.addEventListener("error", onError as never);
  const onRejection = (e: unknown) => errors.push(`unhandled: ${(e as Error)?.stack ?? e}`);
  process.on("unhandledRejection", onRejection);
  const startBodies = (await kernel.call("body_count")) as number;
  const done: string[] = [];
  const fail = (what: string) => `seed ${seed} step ${done.length} (FISSION_SEED-style replay: chaosSession(${seed}, ${steps})): ${what}\n  after: ${done.slice(-8).join("\n         ")}`;
  /** Documents seen in this session: Undo and Redo bring back their ids on purpose. */
  const seen = new Set<string>([canonical(a.doc())]);
  try {
    for (let k = 0; k < steps; k++) {
      const before = a.doc();
      const labelBefore = a.history.undoLabel();
      const solids = before.timeline.features.filter((f) => f.intent.type !== "sketch");
      const roll = r();
      let expect: { edit: string; recorded: boolean } | null = null;
      if (roll < 0.3 && solids.length > 0) {
        // Edit feature: right sizes, junk, or the same sizes; finished four ways.
        const f = pick(solids);
        const off = await a.menu(f.id, "edit");
        if (off !== null) {
          done.push(`edit ${f.id}: off (${off})`);
        } else {
          const boxes = SIZE_BOXES[f.intent.type].map((key) => a.$(`#edit-${key}`) as HTMLInputElement | null);
          if (boxes.some((b) => b === null)) return fail(`Edit feature on ${f.id} shows no ${SIZE_BOXES[f.intent.type].join("/")} boxes`);
          const how = r();
          const typed = boxes.map((b) => (how < 0.25 ? b!.value : r() < 0.2 ? pick(JUNK) : String((f.intent.type === "extrude" && r() < 0.15 ? -1 : 1) * (1 + Math.floor(r() * 60)))));
          boxes.forEach((b, i) => (b!.value = typed[i]));
          const finish = pick(["ok", "ok", "enter", "cancel", "escape"]);
          done.push(`edit ${f.id} [${typed.map((t) => JSON.stringify(t)).join(", ")}] ${finish}`);
          if (finish === "ok") a.$("#feature-edit-ok")!.click();
          else if (finish === "enter") boxes[0]!.dispatchEvent(new a.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
          else if (finish === "cancel") a.$("#feature-edit-cancel")!.click();
          else await a.key("clear-selection");
          await a.settle();
          if (finish === "ok" || finish === "enter") {
            const ok = takes(f, typed);
            const same = ok && typed.every((t, i) => Number(t) === sizesOf(f)[i]);
            expect = { edit: f.id, recorded: ok && !same };
            reach(ok ? (same ? "edit-same" : "edit-taken") : "edit-refused");
            const open = !a.$("#feature-edit")!.hidden;
            if (ok && open) return fail(`Edit feature on ${f.id} took ${typed.join(", ")} by the rules, but the panel is still open saying ${JSON.stringify(a.$("#feature-edit-error")?.textContent)}`);
            if (!ok && !open) return fail(`Edit feature on ${f.id} closed on ${JSON.stringify(typed)}, which the rules refuse`);
            if (!ok && (a.$("#feature-edit-error")?.hidden ?? true)) return fail(`Edit feature refused ${JSON.stringify(typed)} without saying why`);
            if (!ok) {
              // The user gives up on it: Cancel or Escape.
              if (r() < 0.5) a.$("#feature-edit-cancel")!.click();
              else await a.key("clear-selection");
              await a.settle();
            }
          } else {
            expect = { edit: f.id, recorded: false };
            reach(`edit-${finish}`);
            if (!a.$("#feature-edit")!.hidden) return fail(`${finish} left the Edit feature panel open`);
          }
        }
      } else if (roll < 0.45 && before.sketches.length > 0) {
        // Edit Sketch, by the menu or a double-click; a stray line or nothing; Finish Sketch, or left open for the next step to leave.
        const s = pick(before.sketches);
        const how = pick(["menu", "bar", "row"]);
        if (how === "menu") await a.menu(s.id, "edit-sketch");
        else if (how === "bar") await a.doubleClick(s.id);
        else await a.rowDoubleClick(`sketches/${s.id}`);
        const stray = r() < 0.5;
        if (stray && a.sketching()) {
          const x = (s.points[0]?.x ?? 0) + Math.floor(r() * 30);
          const y = 50 + 5 * Math.floor(r() * 10);
          await a.click(x, y);
          await a.click(x + 3 + Math.floor(r() * 5), y);
          await a.key("clear-selection");
        }
        const leave = r() < 0.7;
        if (leave && a.sketching()) await a.finish();
        done.push(`edit sketch ${s.id} by ${how}${stray ? " + stray line" : ""}${leave ? ", finished" : ", left open"}`);
        reach("edit-sketch");
      } else if (roll < 0.6 && before.timeline.features.length > 0) {
        const f = pick(before.timeline.features);
        const entry = pick([f.suppressed ? "unsuppress" : "suppress", "marker", "delete"]);
        const off = await a.menu(f.id, entry);
        done.push(`${entry} ${f.id}${off !== null ? ` off (${off})` : ""}`);
        if (off === null && entry === "delete" && (a.$("#delete-ask") as HTMLDialogElement | null)?.open) {
          const go = r() < 0.7;
          a.$(go ? "#delete-ask-confirm" : "#delete-ask-cancel")!.click();
          await a.settle();
          done.push(go ? "  asked: Delete" : "  asked: Cancel");
          reach(go ? "delete-asked" : "delete-cancelled");
        } else if (off === null) reach(entry);
      } else if (roll < 0.66) {
        const b = pick(["start", "back", "forward", "end"]);
        const button = a.$(`[data-button="${b}"]`) as HTMLButtonElement | null;
        if (button && !button.disabled) {
          button.click();
          await a.settle();
          reach("playback");
        }
        done.push(`playback ${b}${button?.disabled ? " (off)" : ""}`);
      } else if (roll < 0.8) {
        // Undo then, half the time, Redo: Redo must give back exactly the file Undo left.
        const label = await a.undo();
        done.push(`undo (${label})`);
        if (label !== null) {
          reach("undo");
          if (r() < 0.5) {
            const again = await a.redo();
            done.push(`redo (${again})`);
            if (again !== label) return fail(`Undo undid ${JSON.stringify(label)} but Redo redid ${JSON.stringify(again)}`);
            if (canonical(a.doc()) !== canonical(before)) return fail(`Undo then Redo of ${label} gave another file`);
            reach("undo-redo");
          }
        }
      } else if (roll < 0.88) {
        const label = await a.redo();
        done.push(`redo (${label})`);
        if (label !== null) reach("redo");
      } else if (roll < 0.94) {
        await a.away();
        done.push("another workspace and back");
        reach("away");
      } else {
        await a.key("clear-selection");
        done.push("Escape");
      }
      // A sketch left open is finished before the checks that need a rebuilt view (and the next step may find it open first).
      const sketching = a.sketching();

      // ---- the checks
      if (errors.length) return fail(`thrown: ${errors.join(" | ")}`);
      const after = a.doc();
      const key = canonical(after);
      if (!seen.has(key)) {
        const reused = reusedId(before, after);
        if (reused) return fail(`${reused} is new but its number was handed out before (the counter was at ${before.nextId})`);
      }
      seen.add(key);
      if (expect) {
        const label = a.history.undoLabel();
        if (expect.recorded) {
          if (label === labelBefore && key === canonical(before)) return fail(`Edit feature on ${expect.edit} recorded nothing`);
          if (!/^Edit /.test(label ?? "")) return fail(`Edit feature on ${expect.edit} recorded ${JSON.stringify(label)}`);
          const l = leak(before, after, expect.edit);
          if (l) return fail(`Edit feature on ${expect.edit}: ${l}`);
        } else if (key !== canonical(before) || label !== labelBefore) return fail(`Edit feature on ${expect.edit} changed the file though nothing should be recorded (Undo now ${JSON.stringify(label)})`);
      }
      const back = projectFromJson(projectToJson({ ...emptyProject("Chaos"), workspaces: { design: after } }), [designWorkspace]).workspaces.design;
      if (canonical(back) !== canonical(after)) return fail(`the file reads back differently: ${canonical(back).slice(0, 300)} vs ${canonical(after).slice(0, 300)}`);
      const bar = [...a.window.document.querySelectorAll("li[data-item]")].map((li) => `${(li as unknown as HTMLElement).dataset.item}${(li as unknown as HTMLElement).dataset.suppressed === "true" ? " off" : ""}`);
      const want = after.timeline.features.map((f) => `${f.id}${f.suppressed ? " off" : ""}`);
      if (JSON.stringify(bar) !== JSON.stringify(want)) return fail(`the bar shows ${bar.join(", ")}, the file has ${want.join(", ")}`);
      if (!sketching) {
        const v = modelVolume(after);
        if (!close(a.volume(), v)) return fail(`the view holds ${a.volume()} mm³, the file's built items make ${v}`);
        const built = after.timeline.features.filter((f) => f.intent.type !== "sketch").length;
        const held = ((await kernel.call("body_count")) as number) - startBodies;
        if (held > built) return fail(`the kernel holds ${held} bodies for ${built} solid items`);
      }
    }
    if (a.sketching()) await a.finish();
    if (errors.length) return fail(`thrown: ${errors.join(" | ")}`);
    return (await a.close()) ? null : fail("a body was not freed at the end");
  } catch (e) {
    await a.close();
    return fail((e as Error).stack ?? String(e));
  } finally {
    a.window.removeEventListener("error", onError as never);
    process.off("unhandledRejection", onRejection);
  }
}

// ---------------------------------------------------------------- the tests

test("the rules, worked by hand", () => {
  const doc = start();
  // The box 40·30·20 = 24000, Extrude 1 a 40 × 30 rectangle by 20 = 24000, Extrude 2 30 × 20 by 10 = 6000, the last box 4·5·6 = 120.
  assert.equal(modelVolume(doc), 24000 + 24000 + 6000 + 120);
  // Sketch 1 suppressed: Extrude 1 doesn't build (54120 − 24000 = 30120).
  const off = structuredClone(doc);
  off.timeline.features[1].suppressed = true;
  assert.equal(modelVolume(off), 30120);
  // The marker on Extrude 1: Extrude 2's sketch, Extrude 2 and the last box are after it (24000 + 24000).
  const marked = structuredClone(doc);
  marked.timeline.marker = doc.timeline.features[2].id;
  assert.equal(modelVolume(marked), 48000);
  // A stray line in Sketch 2 (a loose end) with no kept shape: Extrude 2 fails (54120 − 6000); with the 30 × 20 kept, it builds again.
  const stray = structuredClone(doc);
  stray.sketches[1].points.push({ id: "p-a", x: 0, y: 60 }, { id: "p-b", x: 5, y: 60 });
  stray.sketches[1].curves.push({ id: "l-x", kind: "line", start: "p-a", end: "p-b" } as never);
  assert.equal(modelVolume(stray), 48120);
  stray.kept = { [doc.timeline.features[4].id]: { points: doc.sketches[1].points, curves: doc.sketches[1].curves } as never };
  assert.equal(modelVolume(stray), 54120);
  // A negative distance makes the same volume the other way: |−10|.
  const flipped = structuredClone(doc);
  (flipped.timeline.features[4].intent.parameters as Record<string, number>).distance = -10;
  assert.equal(modelVolume(flipped), 54120);
  // A right triangle with legs 3 and 4: area 6.
  assert.equal(loopArea({ points: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 3, y: 0 }, { id: "c", x: 0, y: 4 }], curves: ["ab", "bc", "ca"].map((e) => ({ id: e, kind: "line", start: e[0], end: e[1] })) }), 6);
});

test("the size rules at their limits, and the other checks, each able to fail", () => {
  const box = start().timeline.features[0];
  const extrude = start().timeline.features[2];
  // 0.001 and 1,000,000 mm are the kernel's limits (MIN_FEATURE, MAX_SIZE): taken at them, refused at 0.9× and 1.1×.
  assert.ok(takes(box, ["0.001", "1000000", "40"]));
  assert.ok(!takes(box, ["0.0009", "40", "40"]));
  assert.ok(!takes(box, ["40", "1100000", "40"]));
  // A distance is one way: -12 refused, 12 taken; junk never.
  assert.ok(takes(extrude, ["12"]));
  assert.ok(!takes(extrude, ["-12"]));
  for (const bad of JUNK) assert.ok(!takes(box, [bad, "1", "1"]), JSON.stringify(bad));
  // An id handed out again is named; one from the counter is not.
  const doc = start();
  const reused = structuredClone(doc);
  reused.profiles.push({ id: `profile-${doc.nextId - 1}` } as never);
  assert.equal(reusedId(doc, reused), `profile-${doc.nextId - 1}`);
  const fresh = structuredClone(doc);
  fresh.profiles.push({ id: `profile-${doc.nextId}` } as never);
  assert.equal(reusedId(doc, fresh), null);
  // An edit that touched another item, or the marker, is named.
  const leaked = structuredClone(doc);
  (leaked.timeline.features[0].intent.parameters as Record<string, number>).width = 41;
  (leaked.timeline.features[2].intent.parameters as Record<string, number>).distance = 21;
  assert.equal(leak(doc, leaked, extrude.id), "feature-1 changed too");
  const moved = structuredClone(doc);
  moved.timeline.marker = "start";
  assert.equal(leak(doc, moved, extrude.id), "the marker moved");
});

test(`seeded: ${SEEDS} sessions × ${STEPS} steps of Edit feature, Edit Sketch, suppress, the marker, deletes, Undo, Redo and another workspace keep the view, the bar and the file to the rules`, async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const failure = await chaosSession(seed, STEPS);
    assert.equal(failure, null);
  }
  for (const k of ["edit-taken", "edit-refused", "edit-same", "edit-cancel", "edit-escape", "edit-sketch", "suppress", "marker", "delete-asked", "playback", "undo", "undo-redo", "redo", "away"])
    assert.ok((REACHED[k] ?? 0) >= 2, `${k} reached ${REACHED[k] ?? 0} times: ${JSON.stringify(REACHED)}`);
});

const WORKSPACE = new URL("../../../workspaces/design/src/workspace.ts", import.meta.url);

/** Bugs planted in workspace.ts's Edit feature and rebuild wiring, each of which the sessions must catch, by the check named. */
const PLANTS = [
  { name: "refused-recorded", find: "    if (refused !== null) return editBox.showError(refused);", replace: "", caught: "which the rules refuse" },
  { name: "panel-stays", find: "    record(step, next) {\n      leaveExtrude();\n      leaveEdit();", replace: "    record(step, next) {\n      leaveExtrude();", caught: "the panel is still open" },
  { name: "cancel-records", find: "    cancel: () => leaveEdit(),", replace: "    cancel: () => editBox.editing !== null && void finishEdit(Object.fromEntries([...ctx.properties.querySelectorAll<HTMLInputElement>('#feature-edit input')].map((i) => [i.id.slice(5), i.value]))),", caught: "nothing should be recorded" },
];

/** Design with `plant` made: a copy of workspace.ts beside it (so its imports resolve), loaded, then deleted. */
async function planted(plant: { name: string; find: string; replace: string }): Promise<typeof designWorkspace> {
  const text = readFileSync(WORKSPACE, "utf8");
  const at = text.indexOf(plant.find);
  assert.ok(at >= 0 && text.indexOf(plant.find, at + 1) < 0, `${plant.name}: the text to replace must be in workspace.ts exactly once`);
  const file = new URL(`workspace.planted-chaos-${plant.name}.ts`, WORKSPACE);
  writeFileSync(file, text.slice(0, at) + plant.replace + text.slice(at + plant.find.length));
  try {
    return (await import(file.href)).designWorkspace;
  } finally {
    rmSync(file);
  }
}

test("each bug planted in workspace.ts's Edit feature wiring is caught by the sessions, by the check that should catch it", async () => {
  for (const plant of PLANTS) {
    const design = await planted(plant);
    let caught: string | null = null;
    for (let seed = 1; seed <= SEEDS && caught === null; seed++) caught = await chaosSession(seed, STEPS, design);
    assert.ok(caught !== null, `${plant.name} was not caught by ${SEEDS} sessions`);
    assert.ok(caught.includes(plant.caught), `${plant.name} was caught by another check: ${caught}`);
  }
});
