// Every workspace is a plugin on the public Workspace API, ours included:
// no private shortcuts, and what each declares is true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RepresentationRegistry, type KernelCalls, type WorkspacePlugin } from "@fission/core";

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
