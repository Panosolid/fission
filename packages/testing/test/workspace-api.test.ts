// Every workspace is a plugin on the public Workspace API, ours included:
// no private shortcuts, and what each declares is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionRegistry, DependencyGraph, emptyProject, historyNotBuilt, RepresentationRegistry, createSelection, NO_HIGHLIGHT, type GeometryReference, type KernelCalls, type SharedViewport, type StableId, type ViewportHighlight, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";

const root = join(import.meta.dirname, "../../..");
const workspaceDirs = readdirSync(join(root, "workspaces"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** Every import in a workspace's source files. */
function importsOf(dir: string): { file: string; spec: string }[] {
  const src = join(root, "workspaces", dir, "src");
  return readdirSync(src)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [...readFileSync(join(src, f), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => ({ file: `${dir}/src/${f}`, spec: m[1] })));
}

// Shared packages by entry point only (no "@fission/core/src/…"), and
// never another workspace: they meet through the core API.
const allowed = new Set(["@fission/core", "@fission/ui", "@fission/viewport"]);
const offending = (imports: { file: string; spec: string }[]) => imports.filter(({ spec }) => !spec.startsWith("./") && !allowed.has(spec));

test("workspaces import only the public packages and their own files", () => {
  assert.deepEqual(offending(workspaceDirs.flatMap(importsOf)), []);
});

test("the boundary check can fail: it catches a deep import and a workspace-to-workspace import", () => {
  const imports = [
    { file: "x", spec: "@fission/core/src/model/graph.ts" },
    { file: "x", spec: "@fission/slice" },
    { file: "x", spec: "./profiles.ts" },
    { file: "x", spec: "@fission/core" },
  ];
  assert.deepEqual(offending(imports).map((i) => i.spec), ["@fission/core/src/model/graph.ts", "@fission/slice"]);
});

const plugins: WorkspacePlugin[] = await Promise.all(
  workspaceDirs.map(async (d) => {
    const mod = (await import(`@fission/${d}`)) as Record<string, unknown>;
    return mod[`${d}Workspace`] as WorkspacePlugin;
  }),
);

test("all ten workspaces are plugins with a matching id", () => {
  assert.deepEqual(plugins.map((p) => p.id).sort(), ["circuit", "design", "image", "laser", "layout", "manufacture", "render", "simulate", "slice", "vector"]);
});

test("placeholders declare no representations; working workspaces produce every kind they declare", () => {
  const kernel: KernelCalls = { call: (() => Promise.reject(new Error("no kernel in this test"))) as KernelCalls["call"] };
  for (const p of plugins) {
    if (p.status === "placeholder") {
      assert.deepEqual(p.representations, { produces: [], accepts: [] }, `${p.id} is a placeholder and must not claim to hand anything over`);
      assert.equal(p.registerRepresentations, undefined, p.id);
      continue;
    }
    const registry = new RepresentationRegistry();
    p.registerRepresentations?.(registry, kernel);
    // Producers are registered per object type: collect every kind any type gives.
    const given = new Set<string>();
    for (const type of ["design.feature", "design.profile"]) for (const k of registry.produces(type)) given.add(k);
    for (const k of p.representations.produces) assert.ok(given.has(k), `${p.id} declares ${k} but registers no producer for it`);
  }
});

// The one action registry (X1): placeholders offer no verbs, and every verb
// a workspace registers is its own (id and workspace name it).
test("placeholders register no actions; a working workspace's verbs are its own", () => {
  for (const p of plugins) {
    const registry = new ActionRegistry();
    p.registerActions?.(registry);
    if (p.status === "placeholder") {
      assert.equal(p.registerActions, undefined, `${p.id} is a placeholder and must not offer verbs`);
      continue;
    }
    for (const id of plugins.map((q) => q.id)) {
      const theirs = registry.byWorkspace(id);
      if (id !== p.id) assert.deepEqual(theirs, [], `${p.id} registered verbs for ${id}`);
    }
  }
  const design = new ActionRegistry();
  plugins.find((p) => p.id === "design")!.registerActions!(design);
  assert.deepEqual(design.byWorkspace("design").map((a) => a.id), ["design.download-stl"]);
});

// Mounting into the layout slots (step 16a): every plugin fills the slots
// it uses and leaves all three empty on hide, so the next workspace starts
// clean. A real DOM (happy-dom) stands in for the browser.
const { Window } = await import("happy-dom");

type Slots = Pick<WorkspaceContext, "toolbar" | "browser" | "properties">;

/** Names of the slots still holding something after a hide. */
const leftovers = (slots: Slots) => (["toolbar", "browser", "properties"] as const).filter((k) => slots[k].childNodes.length > 0);

/** The last highlight each test viewport was asked to draw. */
const shownHighlights = new WeakMap<SharedViewport, ViewportHighlight>();

/** How many times each test context was told the project changed. */
const changes = new WeakMap<WorkspaceContext, number>();

function testContext(): WorkspaceContext {
  const doc = new Window().document as unknown as Document;
  const el = () => doc.createElement("div") as unknown as HTMLElement;
  const viewport: SharedViewport = {
    element: el(),
    showBody() {},
    bodyFraming: () => ({ centre: [0, 0, 0], radius: 0 }),
    fit: () => null,
    setView: () => null,
    fitSelection: () => null,
    setOverlay() {},
    clearOverlay() {},
    showSelection(h) {
      shownHighlights.set(viewport, h);
    },
    onPick: null,
    showImage() {},
    clearImage() {},
  };
  return {
    project: emptyProject(),
    projectChanged() {
      changes.set(this, (changes.get(this) ?? 0) + 1);
    },
    // Every kernel call fails, as when the kernel is not loaded: the workspace must show it, not crash.
    kernel: { call: (() => Promise.reject(new Error("no kernel in this test"))) as KernelCalls["call"] },
    selection: createSelection(),
    history: historyNotBuilt,
    graph: new DependencyGraph(),
    toolbar: el(),
    browser: el(),
    properties: el(),
    viewport,
    representations: new RepresentationRegistry(),
    actions: new ActionRegistry(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("every workspace mounts into the layout slots and leaves them all empty on hide, twice over", async () => {
  for (const p of plugins) {
    const ctx = testContext();
    for (let round = 0; round < 2; round++) {
      const hide = p.mount(ctx);
      await settle(); // let a workspace's first kernel call fail and be shown
      const shown = ctx.toolbar.textContent! + ctx.browser.textContent! + ctx.properties.textContent!;
      assert.ok(shown.includes(p.title) || p.status === "working", `${p.id} shows its page`);
      assert.ok(shown.trim().length > 0, `${p.id} shows something`);
      if (p.status === "placeholder") {
        // Placeholders: their page in the properties area, toolbar and browser empty.
        assert.equal(ctx.properties.querySelector(".placeholder h2")?.textContent, p.title, p.id);
        assert.deepEqual(leftovers(ctx), ["properties"], `${p.id} leaves toolbar and browser empty`);
      }
      hide();
      await settle(); // a reply arriving after hide must not write into the slots
      assert.deepEqual(leftovers(ctx), [], `${p.id} cleared every slot on hide (round ${round + 1})`);
    }
  }
});

// The one selection (step 17a): it belongs to the shell, so mounting and
// hiding a workspace keeps what is selected (I4), and a workspace that
// listens for changes stops listening on hide.
test("every workspace leaves the shared selection as it found it and drops its listeners on hide", async () => {
  for (const p of plugins) {
    const ctx = testContext();
    const picked = { kind: "face", id: "face:feature-1/0" } as GeometryReference;
    ctx.selection.set([picked]);
    let open = 0;
    const real = ctx.selection;
    ctx.selection = {
      get items() {
        return real.items;
      },
      set: (items) => real.set(items),
      toggle: (item) => real.toggle(item),
      clear: () => real.clear(),
      onChange(listener) {
        open++;
        const off = real.onChange(listener);
        return () => {
          open--;
          off();
        };
      },
    };
    const hide = p.mount(ctx);
    await settle();
    assert.deepEqual(ctx.selection.items, [picked], `${p.id} keeps the selection while shown`);
    hide();
    assert.deepEqual(ctx.selection.items, [picked], `${p.id} keeps the selection after hide`);
    assert.equal(open, 0, `${p.id} drops every selection listener on hide`);
  }
});

// Picking (17b): the shown workspace owns the viewport's click handler, so
// a hidden one must hand it back or its clicks would edit the selection.
test("every workspace puts the viewport's pick handler back to none on hide", async () => {
  for (const p of plugins) {
    const ctx = testContext();
    const hide = p.mount(ctx);
    await settle();
    hide();
    assert.equal(ctx.viewport.onPick, null, `${p.id} cleared onPick on hide`);
  }
});

test("Design turns viewport picks and Escape into the shared selection", async () => {
  const ctx = testContext();
  const hide = plugins.find((p) => p.id === "design")!.mount(ctx);
  await settle();
  const ids = () => ctx.selection.items.map((r) => r.id);
  ctx.viewport.onPick!({ face: 1, shift: false });
  ctx.viewport.onPick!({ face: 4, shift: true });
  assert.deepEqual(ids(), ["face:feature-1/1", "face:feature-1/4"]);
  const doc = ctx.viewport.element.ownerDocument;
  doc.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
  assert.deepEqual(ids(), []);
  ctx.viewport.onPick!({ face: 2, shift: false });
  hide();
  doc.dispatchEvent(new doc.defaultView!.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event);
  assert.deepEqual(ids(), ["face:feature-1/2"], "Escape after hide no longer clears");
});

// Highlighting (17d): the selection drawn in the viewport, lit in the
// browser and listed in properties, from whichever of them changed it.
test("Design draws the selection, selects Body 1 from the browser, and stops drawing on hide", async () => {
  const ctx = testContext();
  const hide = plugins.find((p) => p.id === "design")!.mount(ctx);
  await settle();
  const drawn = () => shownHighlights.get(ctx.viewport);
  const lit = () => [...ctx.browser.querySelectorAll("[aria-current=true]")].map((r) => (r as HTMLElement).dataset.node);
  const listed = () => [...ctx.properties.querySelectorAll("#selection-list li")].map((li) => li.textContent);
  assert.deepEqual(drawn(), NO_HIGHLIGHT);
  assert.equal((ctx.properties.querySelector("#selection-empty") as HTMLElement).hidden, false);
  ctx.viewport.onPick!({ face: 1, shift: false });
  ctx.viewport.onPick!({ face: null, edge: 4, shift: true });
  assert.deepEqual(drawn(), { body: false, faces: [1], edges: [4] });
  // No body was built (the kernel fails here), so the types are unknown.
  assert.deepEqual(listed(), ["Face 1 · … face:feature-1/1", "Edge 4 · … edge:feature-1/4"]);
  assert.deepEqual(lit(), []);
  const row = ctx.browser.querySelector("[data-node=body-1]") as HTMLElement;
  row.click();
  assert.deepEqual(ctx.selection.items.map((r) => r.id), ["body:feature-1"]);
  assert.deepEqual(drawn(), { body: true, faces: [], edges: [] });
  assert.deepEqual(lit(), ["body-1"]);
  assert.deepEqual(listed(), ["Body 1 · solid body:feature-1"]);
  assert.equal((ctx.properties.querySelector("#selection-empty") as HTMLElement).hidden, true);
  // Shift on the row takes the body out again; a face pick unlights the row.
  row.dispatchEvent(new (ctx.browser.ownerDocument.defaultView as unknown as typeof globalThis).MouseEvent("click", { shiftKey: true }));
  assert.deepEqual(ctx.selection.items, []);
  row.click();
  ctx.viewport.onPick!({ face: 2, shift: false });
  assert.deepEqual(lit(), []);
  // Origin and timeline rows select nothing yet: they are not buttons.
  assert.equal(ctx.browser.querySelector("[data-node=origin-z]")!.tagName, "SPAN");
  hide();
  assert.deepEqual(drawn(), NO_HIGHLIGHT, "hide stops drawing the selection");
  ctx.selection.set([{ kind: "face", id: "face:feature-1/3" as StableId }]);
  assert.deepEqual(drawn(), NO_HIGHLIGHT, "a change after hide draws nothing");
});

test("Design shows a kernel failure in its panel rather than throwing", async () => {
  const ctx = testContext();
  const hide = plugins.find((p) => p.id === "design")!.mount(ctx);
  await settle();
  assert.match(ctx.properties.querySelector("#error")!.textContent!, /no kernel in this test/);
  // Its toolbar (16b): the command groups, with the part's shape pressed.
  assert.deepEqual([...ctx.toolbar.querySelectorAll("[role=group]")].map((g) => g.getAttribute("aria-label")), ["Create", "Export"]);
  assert.deepEqual([...ctx.toolbar.querySelectorAll("[aria-pressed=true]")].map((b) => b.textContent), ["Box"]);
  hide();
});

// Verbs, not apps (X1): the selection shows what the action registry offers
// for it, and Design's toolbar STL button runs the same registered verb.
test("Design offers the registry's verbs for the selection, and its STL button runs the registered verb", async () => {
  const ctx = testContext();
  const design = plugins.find((p) => p.id === "design")!;
  design.registerActions!(ctx.actions);
  const hide = design.mount(ctx);
  await settle();
  const verbs = () => [...ctx.properties.querySelectorAll("#selection-actions button")].map((b) => (b as HTMLElement).dataset.action);
  const row = ctx.properties.querySelector("#selection-actions") as HTMLElement;
  const note = () => ctx.properties.querySelector("#action-note")!.textContent;
  assert.deepEqual(verbs(), [], "nothing selected: no verbs");
  assert.equal(row.hidden, true);
  ctx.viewport.onPick!({ face: 1, shift: false });
  assert.deepEqual(verbs(), [], "a face: no verbs yet");
  (ctx.browser.querySelector("[data-node=body-1]") as HTMLElement).click();
  assert.deepEqual(verbs(), ["design.download-stl"]);
  assert.equal(row.hidden, false);
  // The kernel fails in this test: the verb's outcome shows in the note, nothing throws.
  (ctx.properties.querySelector("[data-action='design.download-stl']") as HTMLElement).click();
  await settle();
  assert.equal(note(), "no kernel in this test");
  ctx.properties.querySelector<HTMLElement>("#action-note")!.textContent = "";
  ctx.selection.clear();
  assert.deepEqual(verbs(), []);
  // The toolbar's STL button exports the whole part with nothing selected, through the registry.
  let ran = 0;
  const real = ctx.actions.get("design.download-stl")!;
  const run = real.run;
  real.run = (targets, c) => {
    ran++;
    assert.deepEqual(targets.map((t) => t.id), ["body:feature-1"]);
    return run(targets, c);
  };
  (ctx.toolbar.querySelector("[data-op=export_stl]") as HTMLElement).click();
  await settle();
  assert.equal(ran, 1);
  assert.equal(note(), "no kernel in this test");
  hide();
});

// Autosave (19c): the shell saves when told the project changed, so a
// workspace that edits the project must say so, and one that doesn't edit it
// must not (a placeholder that did would mark the project changed for nothing).
test("Design says the project changed when it writes the part; placeholders never do", async () => {
  for (const p of plugins) {
    const ctx = testContext();
    const hide = p.mount(ctx);
    await settle();
    if (p.id !== "design") {
      assert.equal(changes.get(ctx) ?? 0, 0, `${p.id} changed nothing`);
      assert.deepEqual(Object.keys(ctx.project.workspaces), [], `${p.id} wrote nothing`);
    } else {
      // Mounting on an empty project writes the default part: one change.
      assert.equal(changes.get(ctx), 1);
      const before = ctx.project.workspaces.design;
      const width = ctx.properties.querySelector("input") as HTMLInputElement;
      width.value = "50";
      width.dispatchEvent(new (ctx.properties.ownerDocument.defaultView as unknown as typeof globalThis).Event("input"));
      assert.notEqual(ctx.project.workspaces.design, before, "the edit wrote a new document");
      assert.equal(changes.get(ctx), 2, "and said so once");
    }
    hide();
  }
});

test("the slot check can fail: a workspace that leaves its toolbar filled is caught", () => {
  const ctx = testContext();
  ctx.toolbar.innerHTML = "<button>Box</button>";
  assert.deepEqual(leftovers(ctx), ["toolbar"]);
});
