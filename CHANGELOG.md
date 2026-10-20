# Changelog

Every change that reached `main`, newest first, in plain words. The version in `VERSION` is the newest heading here; `.github/scripts/check_version.py` checks the two agree on every pull request.

How the numbers work, big.step.bugfix:
- big: 0 until the CAD is good enough for real parts; 1.0.0 is that release.
- step: the CAD roadmap step being built (`docs/progress/cad.md`), so 0.24 is step 24, the timeline. A step's number goes up when its first piece merges, and the bug-fix number starts again at 0. (In the first chat each step was finished in one go, so its number went up when it was done; step 15's start sits under 0.14.1.)
- bugfix: goes up by one for each merged pull request whose main job is fixing something broken (a bug, a crash, a failing or flaky check).
- Everything else (integration, AI, guide, testing and CI work) doesn't change the number; it is listed under the version `main` had when it merged.

Versions 0.0.0 to 0.14.2 come from the first chat's own commits, which reached `main` in four big early pull requests (#1, #2, #7, #8). From 0.15.0 on, numbers like #154 are the pull requests.

## 0.25.12 (2026-10-20)

- Fix: the camera stops when an orbit, pan or zoom is let go, so a sketch's grid no longer keeps changing after a fast orbit. #213

## 0.25.11 (2026-10-20)

- Fix: lines behind a body (an extruded sketch's back lines) no longer show through it, and a bottom edge keeps its selection green on the ground grid. #212
- Step 25a5: a bug hunt on editing early items; a line drawn on top of an existing line is refused with a note instead of breaking the outline. Step 25a (edit any feature) is done. #211

## 0.25.10 (2026-10-19)

- Fix: a narrow curved wall far from the origin gets its centre in the right place. #206
- Rename: the app is now called Panosolid everywhere (the repository, saved files and storage keys keep their names, and old .fission.json files still open). #203
- Step 25a4: references re-find their face by name after every edit; two faces are never guessed between. #208
- CI: random testing every 6 hours until Wednesday 07:00 UTC. #209

## 0.25.9 (2026-10-19)

- Fix: two flaky browser checks (split view's pixel probe, reopen's opening mark) now wait properly. #207

## 0.25.8 (2026-10-19)

- Fix: the kernel no longer refuses a line and an arc that meet almost straight on. #200
- Step 25a3: Edit Sketch reopens a finished sketch, and Finish Sketch rebuilds everything after it. #201

## 0.25.7 (2026-10-19)

- Fix: three random-testing checks that misread valid extrudes (#102, #183, #184, #185). #199

## 0.25.6 (2026-10-19)

- Fix: the sessions' simple-loop check measures true tangents and keeps next-door pieces (#140 again). #198

## 0.25.5 (2026-10-19)

- Fix: a long side ending on a tiny arc no longer runs the mesher out of points (#189). #196
- CI: merge queue support, quick pull request checks, timeouts and build caching. #197
- Auto-merge queues pull requests with the owner's token, not the workflow's. #202

## 0.25.4 (2026-10-19)

- Fix: a profile id that isn't text is refused in words (#139). #193
- Step 25a2: Edit feature for any extrude or preset from its timeline item. #194
- A seeded monkey tester joins `npm run e2e`. #195

## 0.25.3 (2026-10-19)

- Fix: the kernel body store caps its memory, not just its count (kernel crash hunt). #191

## 0.25.2 (2026-10-19)

- Fix: a failed feature no longer gets a Body row (timeline hunt finding 5). #192

## 0.25.1 (2026-10-19)

- Fix: changes are kept when the page is reloaded or closed straight after an edit (timeline hunt finding 1). #190

## 0.25.0 (2026-10-18)

- Step 25a1: the naming test plan and harness, from the owner's Fusion answers. #188
- Testing: the sketch outline is checked against an independent Python model. #187
- Security (audit S10): the app refuses to run inside a frame and has a Content Security Policy. #186

## 0.24.13 (2026-10-18)

- Step 24f6: drag a timeline item to a new place; Timeline rows select their body. #181
- Security (audit S2, N1, N2): big project files can't freeze the app; odd ids and huge angles are refused. #178
- Licences (audit L2): third-party licence notices beside the app, and a licence allowlist in CI. #182
- Security (audit S3): Ollama at another computer's address counts as remote. #180
- Security: workflows and the AI command check hardened; auto-merge works with the ruleset. #174
- Step 24f5: drag the timeline marker, tap between items, and the playback buttons. #179
- Kernel: the MIT licence line is removed from Cargo.toml (L1). #176
- Arc tools: typed sizes for arc points and a hint by the pointer. #177
- Step 24f4: the app shows a design with no body (marker at the start, everything suppressed or deleted); the panel says so, and typing a size or sketching adds a new body. #171
- Roadmap: a detailed plan for the Video workspace (F0 to F14), and Office-style placeholders. #173, #175
- Fix: Save and Open wait for the last project to reopen. #172

## 0.24.12 (2026-10-18)

- Rename: Fission becomes Panoshape in everything users see (renamed again to Panosolid in 0.25.10). #168
- Bug hunt 1: a seeded monkey tester for the Design app. #166
- Fix: a grid size answered after Undo closed the sketch is dropped. #170

## 0.24.11 (2026-10-18)

- Browser panel: floating rows over the view, so the part shows between them. #163
- Split view: one toolbar row per pane, and "Coming soon" for placeholders; split opens on the first working workspace. #165
- Fix: the properties panel shows the selected body, not always the last. #167

## 0.24.10 (2026-10-18)

- Step 24f3: the timeline's item menu on the bar and in the browser (suppress, marker, delete, edit). #164
- Step 24f2: the timeline bar's logic (drops, taps, buttons, menu, edits). #162
- Step 24f1: the timeline bar's test plan, undo timing checked. #160
- Bug hunt: two earlier findings (#149, #92) kept as permanent tests. #161
- Bug hunt: the file reader (#139), the sessions' loop check (#140), the oracle's corner allowance (#138) and a regression from #145 fixed. #148
- Step 24d3b: Design draws every body. #150
- CI: the browser checks run as three parallel jobs, so a pull request's checks finish much sooner. #151
- Step 24d3c: a rebuild-time baseline (20 features with arcs, edit the first one). #153
- Guide: Next glides to where the words rest, scenes blend, cards fit, Space plays. #152
- Step 24e1: timeline sessions check that an edit rebuilds only what it changed. #154
- A version number (`VERSION`) and this changelog. #156
- Step 24e2: Design's timeline edits (delete, reorder, suppress, the rollback marker), each one undo step. #155
- Step 24e3: each of the timeline model's planted bugs planted in the real code and caught; timeline edits in the undo fuzzer. #157
- Design: a Start fresh button clears the design after asking, as one undo step. #158
- Step 24e4: deleting a sketch from the browser asks first when an extrude is built from it; the extrude keeps its last shape with a warning. #159

## 0.24.9 (2026-10-18)

- Fix: the test harness worked far-out face centres about a local origin, so rounding no longer fails good shapes. #131
- Step 24d2: an extrude whose sketch is lost keeps its last shape, with a warning. #142
- Sketch feel SF3d: floating browser, the timeline row along the bottom, a Full screen button. #141
- Sketch feel SF4: type a length and angle while drawing lines, width and height for rectangles. #143
- Step 24d3a: far-out face centres in the body's own frame; edge pairs in random testing. #147
- Sketch arcs: the centre arc tool, and the three arc tools under one Arc menu row. #144

## 0.24.8 (2026-10-17)

- Fix: the mesh speed test is timed against a reference pass, so it is steady and back in mutation runs. #96
- Sketch feel SF3a: navigation like Fusion (wheel zoom to the pointer, middle-drag pan, Shift+middle orbit, nav bar, view cube drag). #99
- Kernel: the browser and native builds give the same answer to the bit, checked in CI. #97
- AI6: the assistant panel picks a working AI by itself. #100
- Guide: "How Fission works", a scrolling 3D guide to Design and the kernel. #101
- Step 24b: kernel face roles, with each face's exact area and centroid. #98
- CI: shorter pull request checks (old runs cancelled, no duplicate runs, faster mutation shards, random testing stops on merge). #111
- Kernel body store and structured errors across the WebAssembly boundary. #132
- Step 24c: stable Design names for faces and edges. #133
- Sketch feel SF3b: the sketch's own toolbar with Finish Sketch. #134
- Nasty inputs 2b: fuzzed bodies checked against exact values and OpenCascade. #135
- Step 24d1: timeline data, every solid feature its own body (Design data version 3). #136
- Hunt 3a: TypeScript mutation testing of the document model, file reading and undo. #137

## 0.24.7 (2026-10-17)

- Fix: the mesh timing test left out of mutation runs, where it failed for timing reasons only. #95

## 0.24.6 (2026-10-17)

- Fix: a corner between a shallow arc and its chord no longer turns the cap inside out. #89

## 0.24.5 (2026-10-17)

- Fix: the hover-after-Undo browser check made steady in WebKit. #94
- CI: the mutation check split across parallel shards. #93

## 0.24.4 (2026-10-17)

- Fix: a tiny-triangle panic in the kernel; coverage-guided fuzzing added to find more. #83
- Kernel: the many-holes extrude is 5 times faster (45 s to 8 s). #80
- Testing catch-up TC1 to TC5: mixed tools, long sessions, screenshot checks, Firefox and WebKit. #78

## 0.24.3 (2026-10-17)

- Crash hunt: a two-corner outline crash, an arc stretched by a sketch corner, and a slow viewer mesh fixed. #88
- Kernel: exact area signs for outline direction and face orientation. #90
- AI4: better assistant instructions, checked on held-out cases. #63

## 0.24.2 (2026-10-17)

- Fix two random-testing reports: an inside-out extrude at a near-cusp corner (#75) and the oracle's arcs (#73). #85
- README trimmed. #86
- Sketch feel SF2: see what you draw (Look at, axes, a faded body, a grid that follows the zoom). #84

## 0.24.1 (2026-10-17)

- Fix: the STL fuzz test redraws a starting profile the kernel refuses. #91
- Sketch-and-extrude sessions: simulated users drawing and extruding, checked at every step. #87

## 0.24.0 (2026-10-17)

- Step 24a: the timeline's test plan and harness, and the steps renumbered into build order. #81
- Step 23c: the tangent arc tool (key T), chaining with the line tool; it merged just after 24a, finishing step 23. #79
- Sketch feel SF1: points go where you click; grid snap is a tickbox, off by default. #82

## 0.23.0 (2026-10-17)

- Step 23a: arcs in saved sketches and the kernel's outline finder. #74
- Step 23b: the 3-point arc tool. #77
- Sketch snapping: endpoints, midpoints, centres, horizontal and vertical. #76

## 0.22.1 (2026-10-17)

- Kernel: all 144 mutation-testing gaps closed, and two bugs they exposed fixed. #65

## 0.22.0 (2026-10-17)

- Step 22a: the rectangle tool. #69
- Step 22b: circles in saved sketches and the kernel's outline finder. #71
- Step 22c: the circle tool (centre, then a point on the circle; key C). #72

## 0.21.0 (2026-10-17)

- Step 21a: kernel sketch maths (grid snapping, sketch lines, the closed outline they make). #58
- Step 21b: sketches saved in the Design document, with undo steps. #66
- Step 21c: the sketch tool, Create sketch and click-to-click lines. #67
- Step 21d: extrude a closed sketch into a solid. #68

## 0.20.2 (2026-10-16)

- Fix: random testing no longer mistakes an arc's bulge for a coordinate (nightly #52 and #54). #55
- Test audits 3 and 4: speed and memory baselines in CI, nightly fuzzing of file loading. #51
- AI1: real AI providers (Ollama, your own API key, in-browser, built-in) and the key store. #59
- AI2: the assistant panel changes Design's part, previewed, as one undo step. #61
- AI3: the A10 check, scoring free models through Ollama in GitHub Actions. #62
- X8b follow-up: the journey timing baseline re-measured on GitHub's machines. #60
- Design check: how sketches, features, the timeline and undo fit together. #57
- AI5a: a training data generator for Fission's own model. #64

## 0.20.1 (2026-10-16)

- Fix: the top bar's Open opens PNG and JPEG in Image; Image never shows Design's body; the Brightness box is exact. #46
- X8a: the magic-moment journey harness, a Design shape to STL timed in the browser. #47
- Step 20c: selection and camera kept through undo, one step per hand-over or AI command, Undo and Redo on phones. #53
- X8b: the journey baseline in tests/baseline.json, flagged nightly. #56

## 0.20.0 (2026-10-16)

- Step 20a: the undo and redo history in core. #48
- Random testing: one issue per kind of failure, the exact oracle as referee, mutation testing on pull requests, coverage. #43
- X7b: one shortcut table shared by all workspaces. #45
- Step 20b: Undo and Redo buttons and keys. #50

## 0.19.0 (2026-10-16)

- Step 19: save and open project files, browser storage, autosave. #21
- X1 and X2: the action registry, and one owner per linked value. #23
- X3: split view, two workspaces side by side. #27
- X4: downstream summaries in core, shown as chips in Design. #28, #30
- Step B0: the boolean design review's decisions and test plan, then Ben's answers on non-manifold results and tolerance growth. #31, #35
- X5: change notes in core and shown in the app. #32, #34
- Image G1: the Image workspace base (open at real size, Brightness, hide a layer). #29
- Notes split into one progress file per workstream and a contents list per folder. #33
- Auto-merge for Claude pull requests, and a reminder after 15 minutes of merge conflict. #36, #44
- X6: dropped or pasted files go through the representation registry; copy a Design profile as SVG. #37, #39
- Image G2a: Image hands each layer to other workspaces; G2b plan for tracing to biarcs. #38, #40
- X7a: warm workspaces, switching in under 100 ms. #41
- Image plan: a Photoshop-style photo editor first (G3 to G17). #42

## 0.18.1 (2026-10-16)

- Kernel: the nightly random-testing failures and oracle disagreements fixed. #22

## 0.18.0 (2026-10-16)

- Step 18: view controls, Fit and the view cube. #18
- The integration map, Ben's five decisions and the flagship experience plan. #19
- README in plainer words. #20

## 0.17.0 (2026-10-16)

- Step 17: select bodies, faces and edges, with highlighting. #13
- Random testing nightly, 11pm to 7am Perth with a hard stop, plus mutation testing. #14
- Layout workspace placeholder: posters, social posts and slides. #16

## 0.16.0 (2026-10-16)

- Step 16: the Design workspace layout (toolbar, browser, properties panel, viewport), plus the AI model plan and roadmap step B0. #12

## 0.15.0 (2026-10-16)

- Step 15: a self-intersection check in validation, mutation-tested. #11
- Integration foundations (I8 to I21) and the AI architecture (A1 to A9). #9, #10

## 0.14.2 (2026-10-16)

- Fix: the random tester wrongly judged slots and lenses near the 100 km edge to be out of range; the kernel was right to accept them, and the case is kept as a permanent test.
- Circuit, Vector and Image placeholder workspaces, making nine in all.
- Every item of the integration and AI specs written into the roadmap (I7 to I21, E1 to E3, V1 to V3, G1 and G2, A1 to A9).

## 0.14.1 (2026-10-16)

- Fix: CI failed because the kernel's browser build called code that only exists outside the browser, and because of a lint new in Rust 1.99.
- Ben's decision: the largest part went from 10 km to 1 km and the tolerance from 1 nm to 10 nm; a test fails if either limit moves past what the arithmetic supports.
- A program that measures how much precision intersections lose.
- The README.
- Community open questions on hosting costs and abuse.
- Step 15 started: the self-intersection check in validation, with follow-up tests from mutation testing (finished in 0.15.0).

## 0.14.0 (2026-10-16)

- Step 14: failure dumps. A broken body is saved as STL files plus an offline viewer page with the problems marked in red, with follow-up tests from mutation testing.

## 0.13.0 (2026-10-16)

- Step 13: STL export, a Download STL button, and tests that export and read back.

## 0.12.0 (2026-10-16)

- Step 12: move and rotate change only a body's placement, not its geometry, so moving far away and back loses nothing. The 37.8 km acceptance case passes.

## 0.11.3 (2026-10-15)

- Fix: the mesh volume of huge thin bodies was wrong after rotation (found by nightly testing).
- The app restructured into npm workspaces (core, viewport, ui, design), with draft model interfaces, a workspace switcher, five placeholder workspaces and a Community page.

## 0.11.2 (2026-10-15)

- Fix: the float comparison helpers counted infinite values as equal, and the relative comparison had lost a floor that made it too loose.

## 0.11.1 (2026-10-15)

- Fix: the inside/outside test went wrong on an arc's chord, and huge thin tubes got the wrong exact volume.

## 0.11.0 (2026-10-15)

- Step 11: the sphere primitive, and exact volume and area, with mutation-testing gaps closed.

## 0.10.1 (2026-10-15)

- Fix: crossing tests that rounding could fool, and touching shapes.

## 0.10.0 (2026-10-15)

- Step 10: arcs and circles in profiles, curved side faces, and the cylinder primitive in the app.

## 0.9.3 (2026-10-15)

- Fix: valid thin walls between curves broke the mesh.

## 0.9.2 (2026-10-15)

- Fix: a sphere's mesh changed when the sphere moved far away.
- An endless random-testing script, and round-the-clock testing on GitHub.
- The app shows tiny and huge quantities properly.

## 0.9.1 (2026-10-15)

- Fix: wrong bounding boxes for barely tilted circles (found by the OpenCascade comparison).
- The tester's rounding allowance changed.

## 0.9.0 (2026-10-15)

- Step 9: extruding outlines with holes, in the kernel, the random tester, the OpenCascade comparison and the app.

## 0.8.3 (2026-10-15)

- Fix: volume is measured from each shell's centre, for precision.
- The modelling range (then 1 um to 10 km, within 100 km).
- The random-testing input mix (95% in range, 5% extreme).
- The nightly workflow.

## 0.8.2 (2026-10-15)

- Five crash fixes, plus the stateful random tester and the OpenCascade comparison.

## 0.8.1 (2026-10-15)

- Two crash fixes, plus kernel preparation for random testing (cylinder, sphere, move, rotate).

## 0.8.0 (2026-10-15)

- Step 8: the kernel runs in a Web Worker.

## 0.7.1 (2026-10-15)

- Fix: wrong segment counts for curved edges (found by mutation testing).

## 0.7.0 (2026-10-15)

- Step 7: the box primitive, built by the kernel and shown in the viewer.

## 0.6.0 (2026-10-15)

- Step 6: cylinder and sphere faces turned into triangles.

## 0.5.0 (2026-10-15)

- Step 5: flat faces turned into triangles, and watertight mesh checks.

## 0.4.0 (2026-10-15)

- Step 4: geometry checks in validation. The roadmap reordered: testing before booleans, the worker early.

## 0.3.0 (2026-10-15)

- Step 3: topology checks in validation (watertight, orientation, Euler–Poincaré).

## 0.2.0 (2026-10-15)

- Step 2: curves and surfaces.

## 0.1.0 (2026-10-15)

- Step 1: the testing rules, and the tolerance module.

## 0.0.0 (2026-10-15)

- The first pipeline (Rust kernel to WebAssembly to the 3D viewer), deployed to GitHub Pages.
