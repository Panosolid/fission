# How Panosolid's workspaces work together

Panosolid is ten workspaces sharing one project: Design, Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image and Layout. The goal is that anything made in one workspace can go straight into any other, stays linked to its source, and never loses information, without anyone exporting a file. This page is for contributors. It explains the model and where each piece lives. The code in `packages/core/src/model/` is the reference. Which links exist between which workspaces, and when each can be built, is in [integration-map.md](integration-map.md).

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

## Why this matters

Integration is Panosolid's flagship and its main way to compete with established tools, even where its CAD is less capable. Moving a design (your own or a shared one) between workspaces should feel as if everything was always one tool. CAD reliability still comes first: integration never hides a broken boolean, and integration work never slows the kernel roadmap. Only what can be built for real is built; the rest is written here as rules and in `docs/roadmap.md` as planned steps ("Integration experience").

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

## Files from outside (`files.ts`)

A file dropped anywhere on the app, or pasted outside a text field, goes through the same registry. `identifyFile` says what it is: contents with a strong signature (PNG, JPEG, PDF, STEP, a Panosolid project, SVG) decide alone; STL and DXF, whose signatures are weak, count only with their extension; a name that claims a format its contents don't match is refused as damaged or renamed. Each workspace that opens a format registers an importer for it (`registerImporter`, one per format; the shell registers projects). A format nothing opens yet is refused with a message naming the workspace that will take it (STL: Design, as mesh bodies; SVG: Vector and Laser; DXF: Laser; STEP: Design; PDF: Layout), so the message changes by itself when that workspace registers its importer. One file at a time.

## Live links (`links.ts`)

A `LiveLink` stores where its source is, as an `Origin` (an object id, or a stable face or edge id from step 24). It also stores the representations its holder accepts. `fetchLinked` goes through the registry each time, so the holder always shows the current source. `breakLink` turns a link into a `FrozenCopy` holding what the link showed at that moment, and keeps the source so provenance still works. `resolveLink` runs after every edit. A missing source gives a warning for the holding item. It is never dropped silently. In the UI, `linkBadge` shows Linked, Frozen copy or Link broken.

## Features, intent and provenance (`feature.ts`)

A `Feature` is `{ id, intent, provenance, dependsOn, suppressed }`, and a `Timeline` is a list of features in build order.

- Downstream workspaces read the intent: CAM drills holes, Laser tells cuts from engraves, Circuit matches mounting holes to screw posts, and Slice treats holes specially.
- `describeProvenance` answers "where did I come from?" in one sentence, for the properties panel.

Today, Design's part is feature #1 of a one-step timeline, and its body is built from the feature's intent. Step 24 adds features to the same list, so no migration is needed.

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

## The owner's five decisions (2026-10-16)

### 1. One owner per value

Every linked value has exactly one owner. An edit made from the side that doesn't own it becomes a proposed edit for the owner: a previewed command (the same commands the user and the AI issue) that the user accepts or rejects. There is no two-way sync.

- Why: with two owners, a disagreement has no answer for which side wins, and the user can't tell why a value changed. One owner makes every change traceable to one place.
- The UI shows the owner next to the value ("Owned by Design"), so it is clear why an edit became a suggestion.
- Ownership can be transferred per value. Sometimes the enclosure drives the mounting holes, sometimes the board does. Transferring is itself an undoable command, recorded in the value's provenance.

### 2. Vector curves in Design before NURBS (step 65)

Until the kernel has exact splines, a Vector Bézier entering Design is fitted with biarcs: pairs of arcs that meet tangent to each other and to their neighbours, within the kernel's tolerance. Printed or cut parts have no visible kinks, because the fitted outline is tangent-continuous. Design shows a note saying the curve is approximated.

- All faces created from one fitted curve form one logical face for topological naming (step 24). References point to that group, never to an individual arc face, so the switch to exact NURBS at step 65 changes no references.
- The original stays in Vector as the owner (decision 1), so nothing is lost and the Vector → Design → Vector round trip is exact.
- Biarc fitting is an operation of the kernel's 2D curve library (decision 5), so it uses the kernel's tolerance.

### 3. Lithophanes are a Design feature ("relief from image")

"Relief from image" is a Design feature with intent (image, size, minimum and maximum thickness), so Slice, Render and Manufacture receive it like any other body and it sits in the timeline. Before exact surfaces exist, its output is a mesh body, governed by the policy in decision 4.

### 4. Meshes are never turned into exact solids automatically

Scans, imported STL files and relief features are **mesh bodies**: a clearly marked, separate kind of body. The browser and properties panel show the kind ("Mesh body"), and the operations available are listed below; anything else is not offered for them, rather than offered and failing.

Mesh bodies can:
- be shown, moved, turned, measured (volume, area, bounding box) and sectioned;
- be printed, rendered, and sent to Laser as a projected outline;
- be used as a reference to sketch over (projected points and outlines, step 27);
- be combined with an exact solid or another mesh body by a mesh boolean (after step 45, sharing its exact predicates). The result is a mesh body, clearly marked, and the exact input is kept unchanged in the timeline;
- be exported as STL or 3MF.

Mesh bodies cannot be filleted, chamfered, shelled or drafted, and their faces cannot be picked as exact faces. A mesh body must be closed and consistently oriented to be printed or used in a boolean; the kernel's watertight mesh check (step 5) decides.

A later, user-initiated "fit exact surfaces" feature (reverse engineering: fitting planes, cylinders, spheres and later NURBS to regions of a scan) is planned. It is never automatic, it previews what it fitted and how far each surface is from the scan, and it produces a new exact body next to the mesh.

### 5. One 2D curve library, in the kernel

The sketcher, Vector, Laser and Layout share one 2D curve library: lines, arcs, Béziers, offsets, path booleans, biarc fitting, and later the constraint solver's geometry. It lives in the Rust kernel and uses `tolerance.rs`, not TypeScript, so sketcher constraints, Vector path booleans and laser kerf offsets use exactly the same maths. Its operations go through `validate`-style checks for 2D results and into the stateful random-testing harness like any kernel operation. It is built a piece at a time as its users need it: lines and arcs with the sketcher (steps 21–23), offsets with step 33, Béziers, path booleans and biarc fitting with Vector (V1–V3).

## Experience principles

These describe what the user feels. Each one turns into a rule for code below and a step in the roadmap.

1. **Verbs, not apps.** Selecting anything shows actions that lead into the right workspace with the object already set up: a flat face offers Cut on laser, Engrave and Make sheet-metal part; a body offers Print, Machine, Simulate and Render; a logo offers Emboss, Engrave, Decal and Silkscreen. Workspaces are places you end up, not places you have to go. Each workspace registers the verbs it offers for each representation in one action registry in `packages/core`; Design's own actions (Download STL) live there too.
2. **It already knew.** When an object lands in a workspace it is already set up, and the user only confirms. Slice orients for the fewest supports, takes the filament from the part's material and picks the user's usual printer. Laser finds the flat faces, takes the thickness from the material, applies the kerf and nests the parts on the sheet. Simulate takes material properties from the library and suggests bolt holes as fixed points. Render applies Design's materials with a sensible camera and lighting. No workspace opens on a blank setup when there is enough information to fill it.
3. **Side by side.** Any two workspaces can be shown split-screen, and editing one updates the other live (drag the enclosure wall, watch the board outline follow). The split layout lives in the UI kit.
4. **Downstream results while designing.** Design's properties panel shows a live chip for each downstream use ("Print: 2 h 14 m · 38 g", "Laser: 6 min · 1 sheet", "Safety factor 1.4"). Hover shows a preview, click goes there. Cheap results update in the background; expensive ones show as out of date until rerun, from the dependency graph.
5. **Motion that explains.** A short animation (about half a second, skippable, off when the system asks for reduced motion) when an object moves between representations: a box unfolds into laser panels, a part drops onto the print bed, a logo wraps onto a surface. One shared transition helper in the UI kit, added with the first real cross-workspace move.
6. **Conversions, not just moves.** Linked transformations between kinds of making, each staying live: a solid box becomes finger-jointed laser panels (sheet thickness a parameter), a solid becomes a sheet-metal part, a logo becomes a stamp, cookie cutter or keychain, a photo becomes a lithophane and then a print. Each is a feature with intent, so it rebuilds when its source changes.
7. **Shared designs are complete recipes.** A shared design carries the whole recipe: the design, print settings, laser jobs, render scenes and instructions. "Make it for my machine" adapts a recipe to the user's own printers, lasers, materials and units. Remixes stay linked to the original like a git branch: when the author updates it, the remixer sees "Update available from the author" and can bring it in with their own changes kept on top. The format for this is planned in [project-format.md](project-format.md).
8. **The outside world flows in and out.** Dropping or pasting a supported file anywhere (SVG, PNG or JPEG, STEP, STL, DXF, PDF) routes it through the representation registry to the right representation. Pasting an image straight onto a face offers to engrave it. Copying from Panosolid gives other apps something useful: SVG for outlines, PNG for renders and images.
9. **Always explain changes.** When something updates because of something else, a short dismissible note names the cause ("Print plate updated: you changed wall thickness in Design"), with one click to the full provenance chain. Nothing updates silently in a way the user would find surprising.
10. **Fast and the same everywhere.** Switching workspaces takes under 100 ms, because workspaces stay warm in the background. Shortcuts, gizmos, selection behaviour, units and undo are the same in every workspace. A browser test measures switching time and fails above 100 ms.

## Measuring the magic

The zero-exports suite gets "magic moment" journeys: browser tests with a click count and a time limit, for example "draw a box, click Cut on laser, change the thickness to 6 mm, check the panels updated, in under 5 clicks, with no exports". A journey whose workspaces don't exist yet is listed as pending and never reported as passing. The nightly summary reports clicks and seconds per journey next to the fuzzer's numbers and compares them to a baseline (the 15% performance rule applies to seconds; any extra click is flagged).

Three flagship demos are perfected first, in this order, and each must be reliable, fast and explained before another demo is added:
1. Box → laser panels (after Laser's basics).
2. Logo → emboss, engrave and render (after Vector, Laser and Render's basics).
3. Enclosure and board side by side (after Circuit's basics).

## The Workspace API (`workspace.ts`, version 1)

A workspace is a `WorkspacePlugin` with these parts:

- `id`, `title`, `summary` and `status` ("working" or "placeholder");
- `representations: { produces, accepts }`, plus `registerRepresentations(registry, kernel)`, which the shell calls once at start-up;
- `registerActions(registry)`, which registers the verbs it offers on a selection (`actions.ts`: each verb names the selection kinds it takes, the representation it works on and whether it takes one thing or many); the shell calls it once at start-up, and whatever shows the selection offers `ctx.actions.actionsFor(...)`. Placeholders register none;
- `registerDownstream(registry)`, which registers the short summaries it makes from the design (`downstream.ts`: "Print: 2 h 14 m · 38 g", each one a node of the dependency graph); the shell calls it once at start-up, and Design's properties panel shows `ctx.downstream.summaries("design", ctx.graph)` as chips, whose click calls `ctx.openWorkspace(...)`. Placeholders register none;
- `readData(data)`, which checks its own part of a loaded project and brings it up to date;
- `mount(ctx)`, which fills the layout slots around the shared viewport (`ctx.toolbar` above, `ctx.browser` left, `ctx.properties` right; placeholders show their page in `properties`) and returns a function that hides it again and leaves every slot empty.

`ctx` holds the project, the kernel, the selection, the history, the dependency graph, the shared viewport, the representation registry, the action registry and the downstream registry, plus `openWorkspace(id)` (opens a workspace beside this one when a split is open, else in its place) and `workspaceTitle(id)`.

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
- Stable geometry references (`references.ts`, from step 24).
