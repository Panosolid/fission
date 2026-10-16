# Core: document model and kernel bridge

Contents of `packages/core`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- The shared document model and the kernel bridge.
- `src/kernel/`:
  - `kernel-client.ts` is the only way the app talks to the kernel (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table).
  - `kernel.worker.ts` runs the WASM kernel in a Web Worker.
  - `kernel-types.ts` holds the shapes of kernel results and inputs (`Outline`, the kernel's `ProfileIn`).
  - `npm run kernel` (in `apps/fission`) builds the WASM package into `src/kernel/wasm/` (generated, gitignored).
- `src/model/` (see docs/integration.md), built:
  - `project.ts`: format version and migrations, `projectToJson`/`projectFromJson`: the .fission.json file.
  - `representation.ts`: the representation registry (producers, converters, and the file importers: `registerImporter`/`importerFor`, one per format).
  - `actions.ts`: the one action registry: verbs per selection kind and representation; `ctx.actions`.
  - `feature.ts`: intent, provenance, timeline.
  - `graph.ts`: dependencies, staleness, `path` (the shortest chain), `onChange`.
  - `downstream.ts`: downstream summaries: what another workspace makes from the design, its state from the graph; the chips in Design's properties panel.
  - `change-notes.ts`: change notes: one dismissible note per result another workspace's change updated, naming the cause, with the dependency chain from `graph.path`; `onChange` tells the shell to redraw. On `WorkspaceContext` as `changeNotes`: whoever calls `graph.changed`/`remove` for a user's edit records it there with the cause's words.
  - `files.ts`: files dropped or pasted (X6a): `identifyFile` by contents and name, `FILE_FORMATS` (each format's representation and who will take it), `routeFiles` through the registered importers; a workspace opens a format by `registry.registerImporter` in its `registerRepresentations`.
  - `svg.ts`: `outlineToSvg`: an Outline as an SVG file in mm (one path, holes by evenodd, y flipped, arcs as quarter turns at most so rounding never moves a centre, the viewBox the exact box); Design's Copy as SVG writes it.
  - `links.ts`.
  - `ownership.ts`: one owner per linked value: `proposeEdit`, `acceptProposal`/`rejectProposal`, `setOwnedValue`, `transferOwnership`.
  - `overlay.ts`.
  - `workspace.ts`: the public Workspace API; `mount` returns a `MountedWorkspace` (`sleep`, `wake`, `unmount`: workspaces stay warm, X7).
  - `shortcuts.ts`: the one shortcut table (X7b): `ShortcutTable` (the shell's `SHELL_SHORTCUTS` and each plugin's `shortcuts`), `parseChord`/`chordOf`/`chordLabel`, `lookup` (pane in use, other pane, shell), `clashes` (same key or id in one scope, a workspace key the shell uses, `BROWSER_RESERVED`), `help` (the list's order). Workspaces run theirs in `MountedWorkspace.shortcut`.
  - `session.ts`: `createSelection`, the one selection; `historyNotBuilt` until the shell wires the history (20b).
  - `history.ts`: `createHistory`, the one undo/redo history of whole-project snapshots (labels, merge keys, limit, `reset` on open; step 20a).
- `src/model/`, DRAFT: `material.ts`, `machines.ts`, `search.ts`, `feedback.ts`, `parameters.ts`, `references.ts`, `viewport.ts`.
