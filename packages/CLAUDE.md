# TypeScript packages, workspaces and the app

Read with the root CLAUDE.md (top rules, general testing rules, git workflow). workspaces/ and apps/ import this file.

## Layout

- One npm workspace at the repo root, one lockfile. Packages are TypeScript source with `exports` pointing at `src/index.ts`, no build step between them; imports inside a package name their `.ts` files so Node's test runner can load them; every package has `test/*.test.ts`, run by `npm test` at the root.
- `packages/core`: the shared document model and the kernel bridge. `src/kernel/`: `kernel-client.ts` is the only way the app talks to the kernel (`kernel.call(op, ...args)` returns a promise; add new ops to `KernelOps` and the worker's `ops` table); `kernel.worker.ts` runs the WASM kernel in a Web Worker; `kernel-types.ts` holds the shapes of kernel results and inputs (`Outline`, the kernel's `ProfileIn`); `npm run kernel` (in `apps/fission`) builds the WASM package into `src/kernel/wasm/` (generated, gitignored). `src/model/`: built: `project.ts` (format version and migrations, `projectToJson`/`projectFromJson`: the .fission.json file), `representation.ts` (registry), `feature.ts` (intent, provenance, timeline), `graph.ts` (dependencies, staleness), `links.ts`, `overlay.ts`, `workspace.ts` (the public Workspace API), `session.ts` (`createSelection`, the one selection; its undo/redo half is DRAFT until step 20); DRAFT: `material.ts`, `machines.ts`, `search.ts`, `feedback.ts`, `parameters.ts`, `references.ts`, `viewport.ts`. See docs/integration.md.
- `packages/viewport`: the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`) and the camera re-framing rule.
- `packages/ui`: shared UI kit: number formatting, theme (`theme.css`), workspace switcher, placeholder page.
- `packages/testing`: the Workspace API boundary test, the "zero exports" journeys (`journeys/*.journey.ts`, on the real kernel through `src/node-kernel.ts`; `JOURNEYS`/`ROUND_TRIPS` list the ones waiting), and DRAFT harness interfaces.
- `packages/ai`: the optional AI assistant (docs/ai.md): providers (placeholders), `askForCommands`, `buildContext`, specialist models and per-workspace plans; the panel itself is `apps/fission/src/assistant.ts`.
- `packages/storage`, `packages/community`: placeholders (interfaces only; every function throws "not implemented").
- `workspaces/design`: the CAD workspace (`workspace.ts`; `profiles.ts` ready-made outlines until the sketcher). `workspaces/render`, `simulate`, `manufacture`, `laser`, `slice`, `circuit`, `vector`, `image`, `layout`: placeholders.
- `apps/fission`: the app shell (`src/main.ts`: top bar with Save/Open, workspace switcher, the toolbar/browser/properties slots around the shared viewport; `#design`, `#slice`… links open a workspace), `e2e/smoke.mjs` browser test, `e2e/dump-viewer.mjs` browser check of the kernel's failure-dump page (both run by `npm run e2e`).

## Commands

- Install (repo root): `npm install`
- Build the app: `cd apps/fission && npm run build` (this also gives the WASM types the type-check needs)
- Dev server: `cd apps/fission && npm run dev`
- Unit tests of every package and workspace: `npm test` (repo root)
- Type-check every package, including ones the app does not import yet: `npm run typecheck` (repo root, after a build)
- Browser smoke test: `cd apps/fission && npm run build && npm run e2e`
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

The AI assistant's rules are in `docs/ai.md` (read it before changing `packages/ai`): optional; commands only, previewed, one undo step; never starts or controls a machine; local providers keep everything local, remote ones show what will be sent first; API keys only in the user's browser, never logged.

Two rules hold everywhere:
- Never use other companies' product names, logos or UI styles anywhere in the UI, code or docs. Use our own names and visual style. (Tools we depend on, like OpenCascade for the oracle, are named where needed.)
- Community sharing is free only: anyone may share what they make and anyone may download it, with no paid content and no payments anywhere.

## App conventions

- The main thread never loads the WASM module; every kernel call goes through `KernelClient` to the worker (the e2e test checks this).
- Wrap UI-driven kernel calls in `latestOnly` so a late reply to an old request never overwrites a newer result.
- Kernel errors arrive as rejected promises with the kernel's message; show them, never swallow them.
