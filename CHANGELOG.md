# Changelog

Every change that reached `main`, newest first, in plain words. The version in `VERSION` is the newest heading here; `.github/scripts/check_version.py` checks the two agree on every pull request.

How the numbers work, big.step.bugfix:
- big: 0 until the CAD is good enough for real parts; 1.0.0 is that release.
- step: the CAD roadmap step being built (`docs/progress/cad.md`), so 0.24 is step 24, the timeline. A step's number goes up when its first piece merges, and the bug-fix number starts again at 0.
- bugfix: goes up by one for each merged pull request whose main job is fixing something broken (a bug, a crash, a failing or flaky check).
- Everything else (integration, AI, guide, testing and CI work) doesn't change the number; it is listed under the version `main` had when it merged.

Steps 1 to 14 came in three early pull requests, so they share one entry. Numbers like #154 are the pull requests.

## 0.24.10 (2026-10-18)

- Bug hunt: the file reader (#139), the sessions' loop check (#140), the oracle's corner allowance (#138) and a regression from #145 fixed. #148
- Step 24d3b: Design draws every body. #150
- CI: the browser checks run as three parallel jobs, so a pull request's checks finish much sooner. #151
- Step 24d3c: a rebuild-time baseline (20 features with arcs, edit the first one). #153
- Guide: Next glides to where the words rest, scenes blend, cards fit, Space plays. #152
- Step 24e1: timeline sessions check that an edit rebuilds only what it changed. #154

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

## 0.14.0 (2026-10-16)

Steps 1 to 14, and the groundwork around them. #1, #2, #7, #8
- Step 1: the testing rules, and the tolerance module with exact tests.
- Step 2: curves and surfaces (line, circle, plane, cylinder, sphere).
- Steps 3 and 4: the B-rep data structure and validation (watertight, orientation, Euler–Poincaré, points on edges and faces, no zero-length edges or zero-area faces).
- Steps 5 and 6: meshing flat, cylindrical and spherical faces, with a watertight check.
- Step 7: the box primitive, shown in the viewer with its edges.
- Step 8: the kernel runs in a Web Worker; every call from the app is an async message.
- Step 9: extrude outlines with holes, volume checked as area × distance.
- Steps 10 and 11: arcs and circles in outlines, cylinder and sphere primitives, accurate volume and area.
- Step 12: move and rotate bodies without losing accuracy far from the origin.
- Step 13: STL export, a download button and a round-trip test.
- Step 14: failure dumps (an STL and a viewer page with problem edges highlighted).
- The modelling range set to 1 km with 10 nm tolerance, and placeholders for the Circuit, Vector and Image workspaces. #8
