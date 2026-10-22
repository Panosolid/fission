# Slice workspace

Progress file for one workstream (rules: root CLAUDE.md, "Workstreams and where progress lives"). Only threads working on this workstream edit this file. The steps P0–P14 are in the Slice section of `docs/roadmap.md`; their substeps, the design decisions behind them and each substep's test plan are here. Tick a substep here when it lands, and tick its step in the roadmap when the last substep does.

Done: nothing yet; the plan was designed with the owner on 2026-10-22.

Next: P0a, from `main`, once CAD step 33 is done (owner's decision: Slice starts right after 33, ahead of Render or taking turns with it).

## How to work on this workstream

- One substep is one thread and one PR. Each starts by writing its test plan into its own line here (what is hand-worked, which boundaries are tested at 0.9× and 1.1×, which deliberate break proves each check can fail, what the browser check looks at), then the tests, then the code.
- The bar is the kernel's: hand-worked cases with the working shown, seeded random tests against a simple model, a deliberate break for every check, and a real browser for anything visible. A slice is checked by replaying its G-code (P0), never by "the preview looked right".
- Behaviour copies Bambu Studio and PrusaSlicer where they agree; names, icons and wording are our own.
- Styles in `workspaces/slice/src/styles/slice.css`, every selector starting with `.slice`.
- PR area: "everything else" for the workspace and the harness; the slicing engine's Rust is the kernel area (it lives beside the kernel, see decision 2); P5's overhang overlay in Design is the Design area.

## Decisions (owner's, 2026-10-22, unless marked default)

1. **Mesh first, exact later (a known compromise, to be removed by P9).** Slice works on a triangle mesh made from each exact body at the printer's resolution, as every common slicer does, so it needs no kernel step past 33. A round hole then prints as a many-sided polygon, as it does in other slicers. P9 replaces this with sectioning the exact body (true arcs, G2/G3 moves) once the kernel's intersection steps 41–46 land; the mesh path stays for mesh bodies (STL imports, lithophanes).
2. **The engine is Rust beside the kernel, compiled to WebAssembly (default).** Layer cutting, offsets and infill are geometry; they use the kernel's `fmath.rs`, its tolerances in `tolerance.rs` (no new epsilons elsewhere) and K1's offsets, and never panic on any input (bad input is `InvalidInput`). It runs in a worker so the app never freezes; the app reaches it only through the kernel bridge.
3. **File only.** Slice saves a G-code file and never sends a job to a printer. Sending comes much later (P14), only behind the shared confirmation screen (I15); Bambu also locks down sending jobs over the network.
4. **The first printer is the owner's Bambu Lab P1S with an AMS (four spools).** The first G-code flavour is Bambu's, written as the `.gcode.3mf` file Bambu Studio and the printer's SD card take (the G-code plus the plate's metadata and checksum, checked against a file Bambu Studio writes for the same part), with that model's own start routine. Plain Marlin and Klipper follow. The first real test print is on the owner's printer. Because of the AMS, multi-colour (P8) comes right after the fundamentals.
5. **Beginner and Advanced settings.** The beginner view shows four choices: quality (layer height), strength (walls and infill), supports on or off, and filament type. The Advanced view shows everything. Every setting has a safe default, so a beginner can slice without opening Advanced (fits the long-term beginner mode).
6. **Plates hold design bodies by reference, never copies (default, from the integration plan).** A design change marks the plate's slice stale (expensive: re-sliced when asked, `needs-rerun`); moving a body on the plate is cheap.
7. **Limits, refused with their own message, never a freeze (default):** layer height 0.04–1.0 mm, nozzle 0.1–1.2 mm, bed up to 1 m × 1 m × 1 m, up to 100,000 layers and 200 bodies per plate. Each limit gets 0.9×/1.1× boundary tests.

8. **Stand out through the design, not raw slicer features (owner's question, 2026-10-22).** Other slicers only get triangles; we have the exact shape and each feature's intent. P9 to P13 are what no STL-fed slicer can do: true arcs, holes sized for shrink, face settings that survive edits, printing feedback while designing, and calibration that feeds back into the design. Every slice is also checked by the P0 replayer before it can be saved.

## Steps and substeps

Substeps for P0 are below; each later step is split into substeps by the thread that starts it, before its first commit.

### P0. Test harness
- [ ] P0a. G-code reader and replayer in TypeScript (`packages/testing`): moves, extrusion (absolute and relative E), retraction, temperatures; works out the plastic volume laid down, the time, and every move's path. Hand-worked: a 10 mm square of one line at 0.2 mm layer and 0.4 mm width is 4 × 10 × 0.2 × 0.4 = 3.2 mm³ (minus the corner overlaps, worked out in the test); a deliberately wrong E amount must fail.
- [ ] P0b. The checks: volume within a stated allowance of the part's volume (walls plus infill fraction), nothing outside the bed or printer limits, no travel crossing a wall without retracting, every layer closed. Each check with a planted fault that it must catch.
- [ ] P0c. PrusaSlicer oracle (`prototypes/oracle/`, CI only, never shipped): slices the same parts with the same settings and compares layer count, per-layer outline area and filament use. Hand-worked parts: a 20 mm cube, a 20 mm × 20 mm cylinder, a bridge, a 45° overhang ramp.
