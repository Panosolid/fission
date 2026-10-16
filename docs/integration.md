# How Fission's workspaces work together

Fission is nine workspaces sharing one project: Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector and Image. The goal is that anything made in one workspace can go straight into any other, stays linked to its source, and never loses information, without anyone exporting a file. This page is for contributors. It explains the model and where each piece lives. The code in `packages/core/src/model/` is the reference.

## The rules

1. **Design is the source of truth for geometry.** Other workspaces refer to it. They never copy it.
2. **Representations, most exact first.** Every object can describe itself in one or more standard representations. Every workspace says which it produces and which it accepts. One shared conversion layer picks what to hand over.
3. **Live links by default.** A paste or a drag links to the source by id. Breaking a link makes a visible frozen copy. A link that can't be resolved shows a warning on the item that holds it.
4. **Lossless round trips.** Moving something to another workspace and back loses nothing. Each round trip gets an integration test.
5. **Features know what they are.** A feature stores its intent: its type, its parameters and why it is there.
6. **Everything knows where it came from.** Every object carries its provenance.
7. **Nothing stale goes unmarked.** One dependency graph marks everything downstream of a change as out of date.
8. **One of each.** There is one selection, one undo history, one units system, one materials library, one machine library and one viewport, which carries analysis overlays.
9. **Placeholders stay placeholders.** A workspace that isn't built shows a page saying what it will do and "Coming soon". It declares no representations, and its functions throw "not implemented".
10. **No private shortcuts.** Our workspaces are plugins on the same public API an outside developer would use.

## Representations (`representation.ts`)

| Kind | What it is | Exact? |
|---|---|---|
| Solid | the kernel's B-rep, described so it can be rebuilt exactly (`BodySpec` today) | yes |
| Outline | 2D paths with exact lines and arcs (Béziers and NURBS later) on a plane | yes |
| Data | structured values: parameters, BOM lines, analysis results | yes |
| Mesh | triangles, for display, printing and scans | no |
| Image | pixels with a physical size (mm per pixel) | no |

Producers are registered per object type (`"design.feature"`, `"design.profile"`, and later `"design.sketch"`, `"vector.path"`). Converters fill gaps between kinds (for example, outline to image for a raster engraving). `RepresentationRegistry.deliver(object, accepts)` follows these rules:

- It uses the most exact kind the target accepts, preferring a direct producer over a conversion.
- When it has to fall back to a lossy kind while the source had an exact one, it returns a note to show the user (for example, "Sent as a triangle mesh: … curved faces become flat facets").
- When nothing fits, it throws an error that says what the source can be and what the target takes.

Design produces Solid and Mesh for its features, and Outline for its profiles. The Outline producer is generic: it accepts any `OutlineSource` (an object with a plane and an outline). The step-21 sketch registers as another type with the same producer, so there is no sketch-only path. A test in `workspaces/design/test/document.test.ts` holds it to that.

## Live links (`links.ts`)

A `LiveLink` stores where its source is, as an `Origin` (an object id, or a stable face or edge id from step 32). It also stores the representations its holder accepts. `fetchLinked` goes through the registry each time, so the holder always shows the current source. `breakLink` turns a link into a `FrozenCopy` holding what the link showed at that moment, and keeps the source so provenance still works. `resolveLink` runs after every edit. A missing source gives a warning for the holding item. It is never dropped silently. In the UI, `linkBadge` shows Linked, Frozen copy or Link broken.

## Features, intent and provenance (`feature.ts`)

A `Feature` is `{ id, intent, provenance, dependsOn, suppressed }`, and a `Timeline` is a list of features in build order.

- Downstream workspaces read the intent: CAM drills holes, Laser tells cuts from engraves, Circuit matches mounting holes to screw posts, and Slice treats holes specially.
- `describeProvenance` answers "where did I come from?" in one sentence, for the properties panel.

Today, Design's part is feature #1 of a one-step timeline, and its body is built from the feature's intent. Step 32 adds features to the same list, so no migration is needed.

## The dependency graph (`graph.ts`)

The shell owns one `DependencyGraph` and gives it to every workspace. Nodes are results that depend on other results, and each node has a cost.

- `changed(id)` marks everything downstream as out of date. It returns the cheap nodes, which should be rebuilt now in the background (through the kernel's worker), and the expensive ones, which wait for the user to click rerun.
- A rebuilt result calls `markFresh`.
- `missingInputs()` reports inputs that were removed while something still reads them.

Design puts profile → feature → "volume, area and mesh" in the graph. Its numbers are dimmed while out of date, and stay marked if the rebuild fails.

## Analysis overlays (`overlay.ts`)

Any workspace can paint faces of the body on screen through `viewport.setOverlay({ id, label, detail, marks })`. A mark names a face (by its index until stable ids arrive) or the whole body. Its severity (info, warning or error) sets the colour, so warnings look the same everywhere. A legend lists active overlays. Overlays are for display only and are never saved.

The first use is in Design: after an STL export that warns about single-precision rounding, the whole part is painted amber. Downstream feedback (printability, machinability, stress, clearance; `feedback.ts`) will arrive the same way.

The app never shows invalid parts. The kernel refuses to hand them out, and only the developer failure-dump viewer (step 14) draws them.

## The Workspace API (`workspace.ts`, version 1)

A workspace is a `WorkspacePlugin` with these parts:

- `id`, `title`, `summary` and `status` ("working" or "placeholder");
- `representations: { produces, accepts }`, plus `registerRepresentations(registry, kernel)`, which the shell calls once at start-up;
- `readData(data)`, which checks its own part of a loaded project and brings it up to date;
- `mount(ctx)`, which fills the layout slots around the shared viewport (`ctx.toolbar` above, `ctx.browser` left, `ctx.properties` right; placeholders show their page in `properties`) and returns a function that hides it again and leaves every slot empty.

`ctx` holds the project, the kernel, the selection, the history, the dependency graph, the shared viewport and the registry.

A workspace imports only `@fission/core`, `@fission/ui` and `@fission/viewport` entry points, plus its own files. It never imports another workspace or a package's internals. `packages/testing/test/workspace-api.test.ts` checks this, and checks that each workspace's declarations are true.

## The project file

The format is described in [project-format.md](project-format.md). It is one JSON document with a version number, and there is a migration for every version change. Each workspace keeps its own data, with its own version, under its id.

## Testing the promise

`npm run journeys` walks multi-workspace journeys on the real kernel with no file exports (`packages/testing/journeys/`). Each journey also checks that live links update and that round trips lose nothing. Design → STL runs today. `JOURNEYS` and `ROUND_TRIPS` in `packages/testing/src/journeys.ts` list the others and what each one waits for. When a workspace becomes real, its journeys are written.

## Not built yet (typed drafts that throw "not implemented")

- Project-wide search (`search.ts`).
- The materials library (`material.ts`).
- The machine library: connections, job queue and history (`machines.ts`). Sending a job needs a `HumanConfirmation`, which only the confirmation screen creates.
- Downstream feedback (`feedback.ts`).
- Project parameters and sweeps (`parameters.ts`).
- Selection and undo (`session.ts`).
- Stable geometry references (`references.ts`, from step 32).
