# Changelog

Every change that reached `main`, newest first, in plain words. The version in `VERSION` is the newest heading here; `.github/scripts/check_version.py` checks the two agree on every pull request.

How the numbers work, big.step.bugfix:
- big: 0 until the CAD is good enough for real parts; 1.0.0 is that release.
- step: the CAD roadmap step being built (`docs/progress/cad.md`), so 0.24 is step 24, the timeline. A step's number goes up when its first piece merges, and the bug-fix number starts again at 0. (In the first chat each step was finished in one go, so its number went up when it was done; step 15's start sits under 0.14.1.)
- bugfix: goes up by one for each merged pull request whose main job is fixing something broken (a bug, a crash, a failing or flaky check).
- Everything else (integration, AI, guide, testing and CI work) doesn't change the number; it is listed under the version `main` had when it merged.

Versions 0.0.0 to 0.14.2 come from the first chat's own commits, which reached `main` in four big early pull requests (#1, #2, #7, #8). From 0.15.0 on, numbers like #154 are the pull requests.

## 0.26.8 (2026-10-22)

- Upkeep (development tools and CI only; the app people use is unchanged): TypeScript 5.9 → 7.0.2 (the new native compiler; typecheck and the build pass with no edits), happy-dom 20.14 → 21.0.4 (the test DOM; its one breaking change, CSS and iframe loading off by default, touches nothing the tests do), web-llm 0.2.85 → 0.2.86 (the assistant's in-browser model runner; its model catalogue moves to that release's files), CI's Node 22 → 24, cargo-nextest 0.9.100 → 0.9.149, and every GitHub Action the workflows pin brought to its newest release (checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, download-artifact v8.0.2, setup-python v7.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1, install-action v2.87.30), still pinned to full commit ids (the pin check passes). Each action's release notes were read for breaking changes: none applies here (no artifact is downloaded by id, `dist/` has no dotfiles for Pages, the auto-merge checkout is of `main`, the result scripts push from the workspace where checkout v6's separate credential file still applies). Checked under Node 24 with the new tools: all 1,287 unit tests, the journeys (within the baseline), typecheck and the build with its licence check, and the whole Chromium browser suite on Chrome 156.

## 0.26.7 (2026-10-22)

- Upkeep: the viewer's 3D library, three.js, goes from r170 to r186 (sixteen releases; the migration guide was read release by release, and nothing the viewport uses was removed or renamed, so no code changed). r181 changed how lit surfaces are shaded, so the pictures the viewer and the guide draw were compared pixel by pixel on both versions (19 pictures: the box from the home, top, front and side views, the plane picker, a sketch being drawn and finished, and every guide chapter): every lit face is at most 5 of 255 darker (2%), evenly across a face, and no pixel changed in any other way, so the browser checks' expected colours and the two golden images stand as they are. Checked by all 321 browser checks in Chromium (Chrome 156, the build CI uses), the app journeys (within the baseline), the licence check in the build and the viewport's unit tests; CI's Firefox and WebKit runs cover those browsers.

## 0.26.6 (2026-10-22)

- Fix (security, development tools only): the app is now built with Vite 8.3.5 (was 5.4.21) and its browser checks run on Playwright 1.64.1 (was 1.49.1), which closes GitHub's 18 open Dependabot alerts (all in the development server, the old esbuild and Playwright's browser download; nothing in the app people use was affected, `npm audit --omit=dev` was already clean). The built app is the same: same files, same kernel worker and WebAssembly, same strict Content-Security-Policy with no eval; its CSS is 1 kB smaller from Vite 8's new CSS tool. The licence check learned one thing: that CSS tool (lightningcss) is under MPL-2.0, a file-level copyleft that only covers changes to the tool itself, so a new short list `ALLOWED_DEV_ONLY` lets development-only tools be under it, while everything that ships is still held to the strict list (a test puts an MPL package in the run-time tree and sees it refused). Checked by all 211 browser checks in Chromium on the Vite 8 build (the framing check under the real policy and the app journeys among them, well inside the baseline), CI's Firefox and WebKit runs, the development server loading the app in Chromium under the policy, and two deliberate breaks of the licence plugin (an unlisted copyright holder in the main bundle, an unlisted package in the kernel worker), each failing the Vite 8 build as it should. Also fixed on the way (a failing check): the smoke check of phone-width keyboard focus expected Undo to be a tab stop but never made a step to undo, so in WebKit, where the page started fresh, Tab skipped the disabled buttons and the check failed (as it did on #230 before this change); it now makes a width edit first and puts it back after. The old check fails and the new one passes when a fresh start is forced in Chromium.
- Fix (found by that upgrade: the browser checks now run on Chrome 156, which has a built-in AI model): the assistant panel counted a built-in model the browser had yet to download as one that runs on this computer, chose it, and every question then hung on a download that never came. Only a model that is there counts now; one still to download, or downloading, is greyed out with that reason, and no session (so no download) is ever started for it. Offering that download with the user's say-so is a later item. Unit tests cover each answer the browser's API can give, and two browser checks a model in each of the two waiting states.
- Testing: CI's browsers moved with Playwright, Chromium from 131 to Chrome for Testing 156 and WebKit from 18.2 to 27.2, and the checks were brought up to them without loosening any: the assistant checks take the browser's own built-in model away (as they already did WebGPU) unless a check gives the page a fake one; the timeline's finger drag waits a frame for its last move, which Chrome 156 delivers later than Chromium 141 did, before reading the drop line (and before asserting an unpicked item drags nothing); the rectangle-tool check's "known bug in WebKit" mark goes, since WebKit 27's number box no longer takes a letter typed into the grid box (the check that provokes that bug on purpose still fails as expected everywhere); the smoke check names, beside each browser console error it collects, the check that was running; and `E2E_CHROMIUM` points the Chromium checks at another build, such as CI's, where a sandbox's own is older. The whole Chromium suite passes on Chrome 156.

## 0.26.5 (2026-10-22)

- Fix (a false alarm in nightly random testing, #236): the kernel's random tester flagged a disc drawn 62.75 km from the origin and placed back at the origin, because its box and its mesh disagreed by 4 billionths of a millimetre. That is the rounding of numbers 62.75 km big, where a double only holds about 7.5e-9 mm, and worked out exactly both were within a couple of those steps of the true shape; the tester judged the rounding by where the disc ended up (68 mm out) instead of where it was built. It now uses the size the body was built at; the allowance itself is unchanged. New tests: the saved failing case, the issue's numbers worked by hand, and the allowance at 0.9× (passes) and 1.1× (fails). Also fixes a browser check that failed on busy machines: after undoing a face sketch's box, it read the screen for leftover red before the next frame was drawn; it now waits for that frame (the failure reproduced exactly with frames slowed down, and passes with the wait). No change to the app.

## 0.26.4 (2026-10-22)

- Fix (found by the daily bug hunt's sweep of every size from 1 µm to 1 km): a small hole or curve close to a long straight side, away from its ends, was refused as crossing it ("0 mm apart") once the side was a few hundred metres long, for example a 1 µm hole 1.1 µm in from the side of a 1 km plate. The check worked out the distance from the line as the difference of two numbers as big as the line's length squared, and their rounding swamped a gap that small; it now measures the distance directly. A new kernel test builds about 6,400 bodies across the whole size range, up to 90 km from the origin, and 4,300 nearly touching holes, checking each one's exact volume and area, where it lands and its STL file; it found nothing else wrong.

## 0.26.3 (2026-10-22)

- Fix (a failing check): the new browser check for snapping onto a face's edges failed in Firefox and WebKit on a phone-width screen. After a tap, the snap marker and its guide lines stay drawn where the tap landed, and the check read the picture with them still on it. Moving the test's mouse away clears them in Chromium, but Firefox gives the canvas no mouse events on a touch page, so on phone width the check now finishes the sketch and opens it again before reading the picture (that clears them in every browser); with a mouse it still moves the pointer away. A miss says what colours it found. No change to the app.

## 0.26.2 (2026-10-21)

- A privacy and terms page, linked from the guide beside Licences: what Panosolid keeps (everything stays in your browser), what leaves your device (only AI requests to a provider you choose, with your key), the AI providers' own age rules, how to delete everything, and plain terms of use (free, your designs are yours, no warranty so check every size before making anything). Security and legal audit 2026-10-22.
- Step 26f: in a sketch on a face, the pointer now snaps onto that face's corners, the middles of its edges and the centres of its round edges (they aren't drawn into the sketch, as in Fusion). A point placed there is tied to it: when an earlier feature changes (the box made wider, say), the point moves with the corner, and so does whatever is extruded from the sketch, in the same undo step as the change. If the corner or edge goes, the point stays where it last was and the sketch's row, its timeline item and the panel say so. Moving the point by hand unties it. The kernel now gives the exact positions of corners, edge middles and centres (the picture on screen is a few micrometres off). Checked by hand-worked cases, Fusion's answer as ten test cases, random sessions against the model on the real kernel, 21 deliberately planted bugs (each caught), a Design app journey on the real kernel, and browser checks at 1280 and 375 px with pixel probes. Found and fixed while doing it: a sketch just made on a face offered no edges until something rebuilt it, and Edit feature or a typed size moved the body but left the sketch's point drawn (and saved) where it was.
- Step 26e: the timeline's rules for a sketch on a face, following Ben's Fusion answers. Suppressing a feature now greys everything built on it, all the way down, with no warning: on the timeline bar they fade with a dashed edge, in the browser they grey, and each says which suppressed feature is why; a greyed sketch isn't drawn and can't be opened until that feature is back. (Before, an extrude of a suppressed sketch failed in red; it is greyed now too.) Dragging a sketch before the feature whose face it is on, or that feature after it, is refused in words. Deleting that feature asks first and says the sketch stays where it is with its plane lost and what is built from it stays with its source lost; after it, the sketch is drawn red where it stays, both timeline rows are red with the warning, and the panel lists every warning, not only the last. One undo brings it all back. Checked by hand-worked cases, the timeline model with sketches on faces in random sessions on the real kernel, history fuzzing, 9 deliberately planted bugs (each caught), a Design app journey on the real kernel, and browser checks at 1280 and 375 px with pixel probes. Found and fixed while doing it: the red sketch was hidden under the edges of the block built from it, so it is now drawn over them.
- Step 26d: Create sketch now offers the front and side planes and any flat face of a body. Hover lights the face the pointer is over (a face always wins over a plane, and the planes are drawn behind the body, so what lights is what a click picks); click it and the sketch opens square onto that face, the body faded, with the grid and axes on the face and every tool drawing and snapping as on the ground. A back or bottom face is looked at from outside the body, like the Back and Bottom views (the view cube reads upright), and Look At does the same. A curved face says sketches go on flat faces or planes and makes no undo step. Checked by hand-worked frames on every face of a box and a cylinder, 20 random sessions of 30 scenes against an independent model, 10 deliberately planted bugs (each caught), journeys on the real kernel extruding from the top, bottom, back and side faces and the front and side planes, and browser checks at 1280 and 375 px with pixel probes. Found and fixed while doing it: when the kernel was slow, a snap marker could stay where the pointer had been after it left the view (caught by the sketch pixel check, now a journey test).
- Step 26c: sketches on a face, in the design's data and rebuild. A sketch can be on a body's flat face (from a file for now; picking the face in the app is next): it reads in world coordinates, moves and turns with its face when an earlier feature changes, and if its face goes it stays where it was, saying its plane is lost, while what is built from it stays too, saying its source is lost (Ben's Fusion answers). Suppressing the feature it is on greys it and what is built from it. Extrudes of sketches on the front and side planes now build, standing up in their plane, and a deleted one's body stays standing. New: Flip in the Extrude and Edit feature panels sends an extrude the other way, its start still on the sketch's plane. Deleting a feature a sketch is on asks first and says the sketch stays. Checked by hand-worked frames on every face of a box and a sloping one, every Fusion answer that needs no cut, 100 random sessions of 150 steps against the model on the real kernel, 17 deliberately planted bugs (each caught), and browser checks at 1280 and 375 px. Found and fixed in the test model while doing it: a face redrawn away while its feature was suppressed was never held.
- Fix (security audit 2026-10-22): every GitHub Action the workflows use is pinned to a fixed commit instead of a tag like v4 that its owner could move. The site's build runs these actions and Pages publishes what they build, so a hijacked tag could have changed the app every visitor runs. A new check fails on any action that isn't pinned. Also, .env files can't be committed.

## 0.26.1 (2026-10-21)

- Step 26b: the kernel can build an extrude on any plane, not only flat on the ground: given where a sketch's plane is (an origin, an x direction and which way it faces), the body, its picture, its STL and its faces' positions all come out there, and Flip extrudes the other way from the same plane with its starting face still on the plane. The kernel now also tells the app exactly which way each flat face points, which sketching on a face (next) needs. A plane given slightly wrong (axes not unit length or not square to each other by more than a hair) is refused with the part named. No change in the app yet. Checked by hand-worked boxes on the front, side and a sloping plane, 19 deliberately planted bugs (each caught), random testing with 6,000 seeded cases and OpenCascade agreeing on 13,510 bodies.
- Fix (timeline code bug hunt): switching to another workspace while the design was still rebuilding no longer adds a box when you come back to a design with no body (its only body suppressed or deleted), nor an undo step "Edit" you never made. The Extrude panel offers only sketches it can use (before the rollback marker, not suppressed) and says why when there are none; before, it offered them, said "makes a closed outline", and OK did nothing. Its note no longer says an extrude replaces the part. The test helper that names a body built from a kept shape now names it as the app does.

## 0.26.0 (2026-10-21)

- Step 26a: the test plan and harness for sketching on a face, no app change yet. The model the app will be checked against now knows Ben's Fusion answers for step 26: sketches on an extrude's sides as well as its top and bottom, reading in world coordinates and turning with the face when a corner moves; a body built from a sketch whose face is gone stays where it was and says its source is lost; suppressing a feature greys everything built on it with no warning. 14 new hand-worked cases and 7 deliberately planted bugs, each caught. Fixed in the model while doing it: an outline drawn clockwise gave a negative volume.

## 0.25.14 (2026-10-21)

- Step 25c4: browser checks of the app with a sketch open: an image dropped, pasted or opened goes to Image and Design comes back with the sketch as it was, a refused file changes nothing, a dropped project replaces the design, split view keeps the sketch drawing, and the shortcut list names the sketch keys (Chromium, Firefox and WebKit; 1280 and 375 px). A second magic-moment journey, sketch to STL in 8 clicks. Step 25 is done. #225
- Fix: random testing no longer reports a far-out curved extrusion as wrongly refused (issue #205). The kernel was right to refuse it: the test's own prediction worked out a nearly whole circle from the size it asked for, but 100 km out the short flat closing it rounds, which made the circle 1.1 mm bigger and pushed it past the modelling range. The prediction now measures the shape as built and checks every arc's reach itself.

## 0.25.13 (2026-10-21)

- Step 25c3: the AI assistant is told the whole timeline (each item, what it builds, the marker), names an extruded-sketch part instead of treating the design as empty, and its preview says when Accept adds a new body and where ("AI: new box …"). A size the answer leaves out now shows the value the panel keeps, so a sphere turned into a box no longer previews as "box 40 × undefined × undefined mm". #223
- Step 25c2: on a timeline, results in other workspaces go out of date when the marker moves, an item is suppressed or reordered, or an extrude keeps its shape for a deleted sketch, and their notes name the item ("you changed Sketch 2", "you suppressed Extrude 1", "you moved the timeline marker"). Before, moving the marker back left a result built from a rolled-back extrude marked current. #222
- Step 25c1: Download STL works on any body shown, not only the last one, and on several at once (one file); the toolbar's STL and the AI's export take every body shown; a too-big warning marks only the bodies it is about. A sketch can be selected from its rows and copied as SVG (an open one says why), and other workspaces can link to any body shown. #221
- Step 25b4: the baseline now measures the naming success rate: 8 seeded timeline sessions of Design on the real kernel check every held face and edge reference against the model (100% over 4,466 references today), and any miss fails the comparison. Step 25b is done.
- Step 25b3: the nightly fuzzing runs long timeline sessions (5 × 500 steps a round) of Design on the real kernel against the model, checks no body is left behind, shrinks any failure to the fewest steps and files an issue for it. #219
- Step 25b2: the undo/redo fuzzer now edits any earlier item's sizes (Edit feature) and draws into earlier sketches (Edit Sketch), with several sketches, checked step by step against its model. #218
- Fix: a body's bounding box reaches the top of a long, nearly flat arc (one with a huge radius), which it missed by a hair after a turn. #217

## 0.25.12 (2026-10-20)

- Step 25b1: the saved-file fuzzer now opens timelines made by real edits (kept shapes, suppressed, rolled-back and failing items, reorders, edited early items) and checks what builds against a model written apart from Design. #216
- Docs: the roadmap and CAD progress notes match what has merged (step 24 ticked, 25a done); Render now starts after step 33; step 29 is noted as getting extra-heavy testing.
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
