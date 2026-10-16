// Every workspace is a plugin on the public Workspace API, ours included:
// no private shortcuts, and what each declares is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DependencyGraph, emptyProject, historyNotBuilt, RepresentationRegistry, selectionNotBuilt, type KernelCalls, type SharedViewport, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";

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

test("all nine workspaces are plugins with a matching id", () => {
  assert.deepEqual(plugins.map((p) => p.id).sort(), ["circuit", "design", "image", "laser", "manufacture", "render", "simulate", "slice", "vector"]);
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

// Mounting into the layout slots (step 16a): every plugin fills the slots
// it uses and leaves all three empty on hide, so the next workspace starts
// clean. A real DOM (happy-dom) stands in for the browser.
const { Window } = await import("happy-dom");

type Slots = Pick<WorkspaceContext, "toolbar" | "browser" | "properties">;

/** Names of the slots still holding something after a hide. */
const leftovers = (slots: Slots) => (["toolbar", "browser", "properties"] as const).filter((k) => slots[k].childNodes.length > 0);

function testContext(): WorkspaceContext {
  const doc = new Window().document as unknown as Document;
  const el = () => doc.createElement("div") as unknown as HTMLElement;
  const viewport: SharedViewport = {
    element: el(),
    showBody() {},
    bodyFraming: () => ({ centre: [0, 0, 0], radius: 0 }),
    fit: () => null,
    setOverlay() {},
    clearOverlay() {},
  };
  return {
    project: emptyProject(),
    // Every kernel call fails, as when the kernel is not loaded: the workspace must show it, not crash.
    kernel: { call: (() => Promise.reject(new Error("no kernel in this test"))) as KernelCalls["call"] },
    selection: selectionNotBuilt,
    history: historyNotBuilt,
    graph: new DependencyGraph(),
    toolbar: el(),
    browser: el(),
    properties: el(),
    viewport,
    representations: new RepresentationRegistry(),
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

test("Design shows a kernel failure in its panel rather than throwing", async () => {
  const ctx = testContext();
  const hide = plugins.find((p) => p.id === "design")!.mount(ctx);
  await settle();
  assert.match(ctx.properties.querySelector("#error")!.textContent!, /no kernel in this test/);
  hide();
});

test("the slot check can fail: a workspace that leaves its toolbar filled is caught", () => {
  const ctx = testContext();
  ctx.toolbar.innerHTML = "<button>Box</button>";
  assert.deepEqual(leftovers(ctx), ["toolbar"]);
});
