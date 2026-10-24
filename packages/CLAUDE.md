# TypeScript packages, workspaces and the app

Read with the root CLAUDE.md (top rules, general testing rules, git workflow). workspaces/ and apps/ import this file.

## Layout

- One npm workspace at the repo root, one lockfile. Packages are TypeScript source with `exports` pointing at `src/index.ts`, no build step between them; imports inside a package name their `.ts` files so Node's test runner can load them; every package has `test/*.test.ts`, run by `npm test` at the root.
- Each package, workspace and the app keeps its own contents list (which file does what) in its own CLAUDE.md, so threads working in different folders never edit the same lines; add a line there when you add a file:
  - `packages/core` (document model, kernel bridge), `packages/viewport` (the one shared viewport), `packages/ui` (shared UI kit), `packages/testing` (boundary test, journeys), `packages/ai` (the optional assistant), `packages/storage` (projects in the browser), `packages/community` (placeholder).
  - `workspaces/design` (the CAD workspace), `workspaces/image` (the Image workspace); `workspaces/render`, `simulate`, `manufacture`, `laser`, `slice`, `circuit`, `vector`, `layout`: placeholders (a placeholder gets its own CLAUDE.md when work on it starts).
  - `apps/fission` (the app shell and browser tests).

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
- Vector curves in Design before NURBS (69): biarc-fitted within tolerance, with a note; all faces from one fitted curve are one logical face for naming, so references never point at single arc faces.
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
- Kernel errors arrive as rejected promises (`KernelError`) with the kernel's message; show them, never swallow them. Decide by their `kind` and `inputs`, never by reading the message.
- Bodies kept in the kernel (`body_build`) are freed (`body_free`) when nothing needs them; tests check `body_count` comes back to where it started.
