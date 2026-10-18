# The integration map

Every link between Panoshape's ten workspaces, planned up front so nobody has to guess when a workspace is built. [integration.md](integration.md) says *how* links work (representations, live links, provenance, the dependency graph). This page says *which* links exist, what flows along each one, and when each can be built.

When a workspace becomes real, its rows here become its integration tests (a journey or round trip in `packages/testing/src/journeys.ts`). A link not on this page is not built until it is added here first.

## How to read a row

- **What flows**: the thing the user moves, in their words.
- **As**: the representation handed over (Solid, Outline, Mesh, Image, Data). The receiver always holds a live link to the source, never a copy, so "as Mesh" means "shown and used as a mesh, rebuilt from the exact source whenever it changes".
- **Back**: what comes back to the source, if anything. Feedback comes back as an overlay or properties-panel note, never as a silent edit. A change to the source from another workspace is always a previewed command the user accepts (the same commands the AI and the user issue).
- **Cost**: cheap results rebuild in the background after a change; expensive ones are marked out of date and wait for a rerun click (`graph.ts`).
- **Ready at**: the earliest point it can be built, as roadmap steps or workspace items.

## Design to the making workspaces

| # | From → to | What flows | As | Back | Cost | Ready at |
|---|---|---|---|---|---|---|
| 1 | Design → Slice | bodies on a print plate; hole intent (so holes print round) | Solid, re-tessellated by Slice at the printer's resolution (Mesh only when the source is a mesh) | printability overlay (overhangs, thin walls), print time and weight as Data | plate update cheap, slicing expensive | P1 (after 73) |
| 2 | Design → Laser | planar faces, sketches, sheet-metal flat patterns | Outline (exact lines, arcs, later splines) | none; kerf and sheet thickness are Design parameters (row 30) | cheap | L1 (after 31); flat patterns after 83 |
| 3 | Design → Manufacture | bodies as parts in a setup; faces and edges picked for strategies; feature intent (a hole feature becomes a drilling cycle) | Solid, faces and edges by stable id | machinability overlay (internal corners sharper than the smallest tool) | toolpaths expensive | M1–M2 (after 50) |
| 4 | Design → Simulate | bodies; loads and fixtures on faces by stable id; materials | Solid, meshed by S2 | stress, displacement and safety-factor overlays; results as Data | expensive | S1–S3 (after 50) |
| 5 | Simulate → Design | a parameter sweep ("thinnest wall with safety factor ≥ 2") | Data (parameter values) | the chosen value is offered as a previewed parameter edit | expensive | S3 + step 34 |
| 6 | Design → Render | bodies, appearances, saved camera views | Solid, tessellated at render quality | none | preview cheap, final render expensive | R1–R3 (after 33) |
| 7 | Design ↔ Circuit | board outline from a face or sketch; mounting holes linked both ways with screw posts; the board and its components as bodies inside the enclosure | Outline (outline); Solid (board and parts, back into Design as a linked component) | collision warnings as overlays on both sides | interference check cheap | E3 (after 75; collisions use 76) |

## The 2D workspaces

| # | From → to | What flows | As | Back | Cost | Ready at |
|---|---|---|---|---|---|---|
| 8 | Vector → Design | a logo or shape to sketch on, emboss or deboss | Outline (biarc-fitted until 65, decision 2) | none | cheap | V3 |
| 9 | Design → Vector | a face outline or sketch as editable paths (to draw artwork that fits a part) | Outline | none | cheap | V1 + 21 |
| 10 | Vector → Laser | paths to cut, engrave or score; layers map to operations | Outline | none | cheap | V1 + L1 |
| 11 | Vector → Render | a decal on a face | Outline, rasterised by a converter at render resolution | none | cheap | V1 + R1 |
| 12 | Vector → Circuit | silkscreen and copper artwork | Outline | none | cheap | V1 + E2 |
| 13 | Vector → Layout | artwork on a page | Outline (stays vector in PDF export) | none | cheap | V1 + Y2 |
| 14 | Image → Vector | trace a photo or scan to paths | Image in, Outline out (trace converter; classic algorithm first, A4 model optional) | none; the image is untouched | expensive | G1 + V1 |
| 15 | Image → Laser | raster engraving | Image with mm per pixel; Laser does the dithering | none | cheap | G1 + L1 |
| 16 | Image → Render | textures and material maps | Image | none | cheap | G1 + R1 |
| 17 | Image → Design | a lithophane or relief from brightness | Image in, a Design feature builds a mesh body (decisions 3 and 4) | none | cheap | G2 + 24 |
| 18 | Image → Layout | photos on a page | Image | none | cheap | G1 + Y1 |
| 19 | Render → Layout and Image | a rendered picture | Image (marked out of date when the scene changes) | none | expensive | R2 + Y2 / G1 |
| 20 | Design → Layout | a design view or a drawing view; parameters as text fields | Outline for drawings (77–79), Image for shaded views, Data for parameters | none | cheap | Y2 + 77 for drawings |
| 21 | Layout → Laser | a page as an engraving or cut (signs, labels) | Outline and Image | none | cheap | Y4 + L1 |
| 22 | Layout → Vector | a page's artwork back to editable paths | Outline | none | cheap | Y4 |

## Between the making workspaces

| # | From → to | What flows | As | Back | Cost | Ready at |
|---|---|---|---|---|---|---|
| 23 | Circuit → Manufacture | board milling and drilling | Outline (copper and drill layers) | none | expensive | E2 + M2 (later) |
| 24 | Circuit → Laser | solder-paste stencils, etched boards | Outline | none | cheap | E2 + L1 (later) |
| 25 | Slice, Laser, Manufacture | one machine library, one job queue, one job history; nothing runs without the confirmation screen | Data | job results (time taken, failures) as Data | — | I15, first one built |

## Shared through the whole project

| # | What | Who reads it | Ready at |
|---|---|---|---|
| 26 | One selection (stable ids) | all | done (17) |
| 27 | One undo history; an edit in one workspace undoes from any | all | 20, timeline edits at 24 |
| 28 | Units | all | done |
| 29 | One materials library: appearance (Render), mechanical (Simulate), print settings (Slice), power and speed (Laser), stock and feeds (Manufacture) | all making workspaces | I3 with 62 |
| 30 | Parameters: Design parameters used anywhere (kerf, thickness, board size, wall thickness in a sweep) | all | 34 + I18 |
| 31 | One bill of materials from Design components and Circuit parts, placeable in Layout as a table | Design, Circuit, Layout | 74 + E1 |
| 32 | Project-wide search ("M3" finds every M3 hole, screw and pad) over feature intent | all | I14, once two workspaces are real |
| 33 | Dependency graph and staleness across workspaces | all | done in core; each row above adds its nodes |
| 34 | The AI assistant sees one context and issues the same commands as the user in every workspace | all | A7–A8 |

## Converters to build

The registry already turns Solid into Mesh (tessellation). The rows above also need these, each built with the first row that uses it:

- Outline → Image (rasterise at a given mm per pixel): rows 11, 21.
- Image → Outline (trace): row 14.
- Outline → Solid is never a converter. Turning a shape into a body (extrude, emboss) is a Design feature, so it has intent and a place in the timeline.
- Mesh → Solid is never automatic (decision 4).

## Round trips (each one an integration test)

- A constrained sketch to Laser and back is still constrained (row 2).
- A Vector logo to Design and back is still an editable vector (rows 8, 9).
- An image traced in Vector leaves the image unchanged (row 14).
- A Layout page's artwork to Vector and back is unchanged (row 22).
- A Circuit board's mounting hole moved in Design moves the pad, and the reverse is offered as a command (row 7, decision 1).

## Journeys (each one an end-to-end test with no file exports)

- Design to STL (runs today).
- Logo to everything: draw a logo, emboss it in Design, engrave it in Laser, render it (rows 8, 10, 6).
- Enclosure and board: model an enclosure, board outline from it, mounting holes linked both ways, print the enclosure (rows 7, 1).
- Photo to lithophane: edit a photo, make a lithophane, slice it (rows 17, 1).
- Part to simulation and back: model a part, simulate it, change a parameter, rerun (rows 4, 5).
- Laser box: a parametric finger-joint box whose slots follow the sheet thickness parameter (rows 2, 30).
- Product poster: render the part, place the render and the logo on a poster, change the part, the poster marks the render out of date (rows 6, 19, 13).

## Decisions (the owner's, 2026-10-16)

All five are approved, with additions; the full text and reasons are in [integration.md](integration.md), "The owner's five decisions".

1. One owner per value; edits from the other side are previewed commands for the owner; "Owned by …" shown; ownership transferable per value.
2. Vector curves fitted with biarcs (tangent-continuous) until NURBS at step 65, with a note; the faces from one curve are one logical face for naming.
3. Lithophanes are a Design feature, "relief from image", whose output is a mesh body until exact surfaces exist.
4. Mesh bodies are a marked, separate kind of body with a fixed list of operations (mesh booleans with exact solids allowed, giving a marked mesh); never turned exact automatically; a later user-started "fit exact surfaces" feature.
5. One 2D curve library, in the Rust kernel with its tolerances, in the stateful harness.
