# The Fission project format

A Fission project is one JSON document. The format is open: anyone may read and write it, and this page describes it. The types it is checked against are in `packages/core/src/model/` (`project.ts`, `links.ts`, `feature.ts`, `material.ts`).

## Current version: 2

```json
{
  "formatVersion": 2,
  "name": "Bracket",
  "units": { "length": "mm" },
  "materials": [],
  "links": [],
  "workspaces": {
    "design": { "version": 1, "profiles": [], "timeline": { "features": [] } }
  }
}
```

- `formatVersion`: the version of this outer layout. A reader refuses a file with a higher number than it knows, with a message saying a newer Fission saved it. It never half-reads one.
- `units.length`: the one units system for every workspace (`mm`, `cm`, `m` or `in`). Stored numbers are always millimetres; units only change what the user sees and types.
- `materials`: the one materials library (appearance, mechanical properties, process presets), shared by every workspace.
- `links`: live links and frozen copies between workspaces. A live link names its source by id (`{"kind": "object", "origin": {...}}`, or `"geometry"` with a stable face or edge id from step 32 on) and the representations the holder accepts. A frozen copy also carries the representation it froze. Nothing else in the file copies another workspace's data.
- `workspaces`: each workspace's own data under its id, with **its own** `version` inside. A workspace reads and upgrades its own part (`WorkspacePlugin.readData`), so workspaces can change their data without bumping the outer version.

### Design's data (version 1)

- `profiles`: ready-made outlines on a plane: `{ id, kind, width, depth, plane }`. Sketches join these from step 21.
- `timeline.features`: features in build order. Each feature is `{ id, intent, provenance, dependsOn, suppressed }`:
  - `intent`: `{ type, parameters, summary, purpose? }`. The body is built from the intent, so it is the source of truth, e.g. `{"type": "box", "parameters": {"width": 40, "depth": 30, "height": 20}, "summary": "Box: 40 × 30 × 20 mm"}`.
  - `provenance`: `{ self, from }`, each an origin `{ workspace, id, label }`, answering "where did I come from?".
  - `dependsOn`: the ids the feature reads. They feed the project's dependency graph.

Today a part is feature #1 of a one-step timeline. Step 32 adds features to the same list, so no migration is needed.

## Migration rules

1. Any change a version-N reader can't read is a new version, N + 1.
2. Every bump adds `MIGRATIONS[N]` in `packages/core/src/model/project.ts`: a function from a version-N file to a version-N+1 file. Old entries are never edited, because files in those versions exist on people's machines.
3. Reading runs the migrations one after another, from the file's version up to the current one. A version-1 file therefore opens in every later Fission.
4. A workspace's own `version` follows the same rules inside `readData`.
5. Each migration has a test that turns a real old file into the new shape (`packages/core/test/project.test.ts`).

### History

- 1: the first format (name, units, materials, workspaces).
- 2: `links` added (live links, I9). Migration: old files get `"links": []`.
