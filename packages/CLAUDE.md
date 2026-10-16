# TypeScript packages, workspaces and the app

Read with the root CLAUDE.md (top rules, general testing rules, git workflow). workspaces/ and apps/ import this file.

## Layout

- One npm workspace at the repo root, one lockfile. Packages are TypeScript source with `exports` pointing at `src/index.ts`, no build step between them; imports inside a package name their `.ts` files so Node's test runner can load them; every package has `test/*.test.ts`, run by `npm test` at the root.
- `packages/core`: the shared document model and the kernel bridge. `src/kernel/`: `kernel-client.ts` is the only way the app talks to the kernel (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table); `kernel.worker.ts` runs the WASM kernel in a Web Worker; `kernel-types.ts` holds the shapes of kernel results and inputs (`Outline`, the kernel's `ProfileIn`); `npm run kernel` (in `apps/fission`) builds the WASM package into `src/kernel/wasm/` (generated, gitignored). `src/model/`: built: `project.ts` (format version and migrations, `projectToJson`/`projectFromJson`: the .fission.json file), `representation.ts` (registry), `actions.ts` (the one action registry: verbs per selection kind and representation; `ctx.actions`), `feature.ts` (intent, provenance, timeline), `graph.ts` (dependencies, staleness), `links.ts`, `ownership.ts` (one owner per linked value: `proposeEdit`, `acceptProposal`/`rejectProposal`, `setOwnedValue`, `transferOwnership`), `overlay.ts`, `workspace.ts` (the public Workspace API), `session.ts` (`createSelection`, the one selection; its undo/redo half is DRAFT until step 20); DRAFT: `material.ts`, `machines.ts`, `search.ts`, `feedback.ts`, `parameters.ts`, `references.ts`, `viewport.ts`. See docs/integration.md.
- `packages/viewport`: the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`: one scene seen through one or more `ViewportView`s, each its own camera, for split view) and the camera re-framing rule.
- `packages/ui`: shared UI kit: number formatting, theme (`theme.css`), workspace switcher, placeholder page.
- `packages/testing`: the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), and DRAFT harness interfaces.
- `packages/ai`: the optional AI assistant (docs/ai.md): providers (placeholders), `askForCommands`, `buildContext`, specialist models and per-workspace plans; the panel itself is `apps/fission/src/assistant.ts`.
- `packages/storage`: projects kept in the browser. `store.ts` (`projectStore(kv, readers, now)`: list, open, save, remove; each project is `project/<id>`, its exact .fission.json text, and `summary/<id>`, name and save time; open goes through `projectFromJson`) over the `KeyValue` interface in `key-value.ts` (`memoryKeyValue()` for unit tests); `indexeddb.ts` is the thin browser adapter, checked by `apps/fission/e2e/storage.mjs`; `localStore(readers)` is the two together; `autosave.ts` (`startAutosave`: saves a quiet moment after each `changed()`, one save in flight, reports "saving"/"saved"/error; tested on a fake clock). Workspaces call `ctx.projectChanged()` after writing `ctx.project`; the shell autosaves on it.
- `packages/community`: placeholder (interfaces only; every function throws "not implemented").
- `workspaces/design`: the CAD workspace (`workspace.ts`; `profiles.ts` ready-made outlines until the sketcher). `workspaces/render`, `simulate`, `manufacture`, `laser`, `slice`, `circuit`, `vector`, `image`, `layout`: placeholders.
- `apps/fission`: the app shell (`src/main.ts`: top bar with Save/Open (behind Menu at phone width) and the save status, workspace switcher, the toolbar/browser/properties slots around the shared viewport; `#design`, `#slice`… links open a workspace), `e2e/smoke.mjs` browser test, `e2e/dump-viewer.mjs` browser check of the kernel's failure-dump page, `e2e/storage.mjs` browser check of the IndexedDB store (all run by `npm run e2e`).

## Commands

- Install (repo root): `npm install`
- Build the app: `cd apps/fission && npm run build` (this also gives the WASM types the type-check needs)
- Dev server: `cd apps/fission && npm run dev`
- Unit tests of every package and workspace: `npm test` (repo root)
- Type-check every package, including ones the app does not import yet: `npm run typecheck` (repo root, after a build)
- Browser smoke test: `cd apps/fission && npm run build && npm run e2e` (the build needs `wasm-pack` and the `wasm32-unknown-unknown` target: `rustup target add wasm32-unknown-unknown && cargo install wasm-pack --locked` in a fresh container)
- "Zero exports" journeys on the real kernel: `npm run journeys` (repo root, after a build)

## Ecosystem: one project, many workspaces

Ten workspaces (Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image, Layout) share one project and one document model. Making them work together without any hassle is the priority, ahead of any single workspace's features. The rules, in full in `docs/integration.md` (read it before changing `packages/core/src/model` or a workspace):
- Design is the source of truth for geometry; other workspaces refer to it by stable ID and never copy it.
- References re-resolve after every edit; one that can't shows a warning on the item holding it, never breaks silently.
- Representations go most exact first, and say so when they fall back to a lossy one.
- Live links by default; breaking one makes a visible frozen copy.
- Lossless round trips, each with an integration test.
- Features store their intent; objects know their provenance; results are marked out of date when an input changes, never shown stale unmarked.
- One of each: selection, undo history, units, materials library, machine library, viewport (with analysis overlays). Switching workspaces keeps camera and selection.
- Placeholders stay placeholders: a page saying what the workspace will do, when work starts and "Coming soon", DRAFT interfaces whose functions throw "not implemented", no stub code that pretends to work, and a test that it says so. Keep DRAFT interfaces small; they change as real workspaces are built.
- No private shortcuts: our workspaces are plugins on the same public Workspace API.
- Integration is the flagship, never at the cost of CAD reliability or the kernel roadmap. The links planned between workspaces are in `docs/integration-map.md`; a link not there is added there first.
- One owner per linked value: an edit from the other side is a previewed command for the owner, never a two-way sync; the UI says "Owned by …"; ownership can be transferred per value, as an undoable command.
- Vector curves in Design before NURBS (65): biarc-fitted within tolerance, with a note; all faces from one fitted curve are one logical face for naming, so references never point at single arc faces.
- Mesh bodies (scans, STL imports, "relief from image") are a separate, marked kind of body with the operation list in docs/integration.md; never turned into exact solids automatically (only by a later, user-started "fit exact surfaces").
- 2D curve maths (sketcher, Vector, Laser, Layout) lives in the kernel's 2D curve library, never re-implemented in TypeScript.
- Experience rules (reasons in docs/integration.md): actions on a selection come from the one action registry in core, never a workspace's private buttons; an object arriving in a workspace is already set up (no blank setups when the project holds the information); every automatic update shows a dismissible note naming its cause; files dropped or pasted, and copies out, go through the representation registry; shortcuts, gizmos, selection, units and undo behave the same in every workspace; switching workspaces stays under 100 ms (browser test); animations are about half a second, skippable and off under reduced motion.
- Magic-moment journeys are browser tests with a click count and a time limit; ones waiting for a workspace are pending, never passing.

The AI assistant's rules are in `docs/ai.md` (read it before changing `packages/ai`): optional; commands only, previewed, one undo step; never starts or controls a machine; local providers keep everything local, remote ones show what will be sent first; API keys only in the user's browser, never logged.

Two rules hold everywhere:
- Never use other companies' product names, logos or UI styles anywhere in the UI, code or docs. Use our own names and visual style. (Tools we depend on, like OpenCascade for the oracle, are named where needed.)
- Community sharing is free only: anyone may share what they make and anyone may download it, with no paid content and no payments anywhere.

## App conventions

- The main thread never loads the WASM module; every kernel call goes through `KernelClient` to the worker (the e2e test checks this).
- Wrap UI-driven kernel calls in `latestOnly` so a late reply to an old request never overwrites a newer result.
- Kernel errors arrive as rejected promises with the kernel's message; show them, never swallow them.
