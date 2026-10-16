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

## Saving and opening

Save writes the project as `<name>.fission.json` (`projectToJson`): keys sorted at every level and two-space indents, so the same project always gives the same bytes. A number JSON can't hold (NaN, Infinity) is refused when saving instead of being written as `null`. Open (`projectFromJson`) parses the text, runs `readProject` (the migrations below), then hands each workspace its own part (`readData`); a part no workspace in this build reads is kept as it is. Bad JSON, a non-project, a newer format or a workspace refusing its part refuses the whole file with one message; the open project stays as it was.

## Planned: recipes, origin and remixes (a later version; nothing reads these yet)

A shared design is a complete recipe (docs/integration.md, principle 7). These fields are planned now so the format grows into them without a redesign. They arrive as one format bump with a migration (old files get an empty recipe and no origin), no earlier than step 19's save and load, and are used by sharing (C2–C4).

```json
{
  "recipe": {
    "contents": ["design", "slice", "laser", "render", "instructions"],
    "instructions": [{ "step": 1, "text": "Print the base", "uses": ["slice:plate-1"] }],
    "machineNeeds": [{ "kind": "printer", "bedAtLeastMm": [180, 180], "material": "PLA" }]
  },
  "origin": { "projectId": "…", "author": "…", "version": "…", "fetchedAt": "…" },
  "lineage": [{ "projectId": "…", "version": "…", "base": "…" }]
}
```

- `recipe.contents`: which workspaces' data the recipe carries, so a reader knows what it gets before opening it. The data itself stays under `workspaces`, as today.
- `recipe.machineNeeds`: what the recipe was made for, so "Make it for my machine" can swap in the user's own printers, lasers, materials and units, and say what it changed.
- `origin`: where a downloaded or remixed project came from. It never changes after download.
- `lineage`: the chain of remixes back to the original. Each entry keeps the `base` version it started from, so an "Update available from the author" can be brought in as a three-way merge: the author's changes since `base`, with the remixer's own changes kept on top. Because features store intent and ids, the merge works on timeline features and parameters, not on geometry.

## Migration rules

1. Any change a version-N reader can't read is a new version, N + 1.
2. Every bump adds `MIGRATIONS[N]` in `packages/core/src/model/project.ts`: a function from a version-N file to a version-N+1 file. Old entries are never edited, because files in those versions exist on people's machines.
3. Reading runs the migrations one after another, from the file's version up to the current one. A version-1 file therefore opens in every later Fission.
4. A workspace's own `version` follows the same rules inside `readData`.
5. Each migration has a test that turns a real old file into the new shape (`packages/core/test/project.test.ts`).

### History

- 1: the first format (name, units, materials, workspaces).
- 2: `links` added (live links, I9). Migration: old files get `"links": []`.
