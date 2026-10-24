# Changelog

Every change that reached `main`, newest first, in plain words. The version in `VERSION` is the newest heading here; `.github/scripts/check_version.py` checks the two agree on every pull request.

How the numbers work, big.step.bugfix:
- big: 0 until the CAD is good enough for real parts; 1.0.0 is that release.
- step: the CAD roadmap step being built (`docs/progress/cad.md`), so 0.24 is step 24, the timeline. A step's number goes up when its first piece merges, and the bug-fix number starts again at 0. (In the first chat each step was finished in one go, so its number went up when it was done; step 15's start sits under 0.14.1.)
- bugfix: goes up by one for each merged pull request whose main job is fixing something broken (a bug, a crash, a failing or flaky check).
- Everything else (integration, AI, guide, testing and CI work) doesn't change the number; it is listed under the version `main` had when it merged.

Versions 0.0.0 to 0.14.2 come from the first chat's own commits, which reached `main` in four big early pull requests (#1, #2, #7, #8). From 0.15.0 on, numbers like #154 are the pull requests.

## 0.30.7 (2026-10-24)

- Roadmap order (Ben's ask: fillets as soon as logically possible after booleans): the constraint solver core (36) moves from right after the flat booleans (35) to right after chamfer and fillets (43), so the hard block now runs flat booleans, curved booleans and Extrude modes, full naming, the rest of the curved booleans, chamfer and fillets, then the solver, then the sketch steps 44–48. Nothing in 37–43 uses sketch constraints (they work on bodies, and a fillet's size is a feature value), so fillets wait on nothing the solver gives. The solver keeps its number 36 rather than renumbering 37–43 again, so boolean work already under way keeps its numbers; it joins the list of steps built out of their number's order.
- Step 30 (4/4), the simulated users' numbers (30d), which finishes step 30, the boolean fuzzing harness. The nightly fuzzing's timeline sessions (a bot building random models on the real kernel, editing early steps and rebuilding, checked against the timeline model) now count the four numbers the testing plan asks for, and the nightly summary shows them for the last run and for every run on `main`: the share of rebuilds the model agrees with, of held face references that land on the right face, of bodies that pass the kernel's validation, and how rebuild time grows with the number of features (a straight line through the fastest rebuild at each count, a table by size, and whether a feature costs more in a big timeline than in a small one). Before, the summary only said how many sessions failed. The same numbers from 8 fixed sessions are now checked on every pull request in `tests/baseline.json` (`app.simulated_users`): any wrong rebuild or invalid body fails, and rebuild time per feature has the usual time margins; first measurement 1,136 rebuilds and 14,478 bodies, all right. The bots' moves for Combine (step 34) and Extrude's join, cut and intersect (step 39a) are written now and switched off until their step lands (one list, shared with the golden models waiting for those steps); with them off every seed replays exactly as before, and a step switched on before the model knows its moves stops the sessions with words instead of passing quietly. Checked by hand-worked counts, line fits and percents with the working shown, boundary tests at 0.9× and 1.1×, the summary script run end to end on two nights, and planted bugs: a kernel that fails one body in ten, a broken rebuild cache, a slow rebuild and lost references each move their own number in the baseline, and 11 bugs planted in the new code each fail a test. Also: comments said a double resolves about 15 nm at 100 km from the origin; it is 15 pm (2⁻²⁶ mm), a thousand times finer (words only, no code relied on it).

## 0.30.6 (2026-10-24)

- Fix: the oracle no longer counts OpenCascade's tolerance at a sharp corner as a broken STEP file (#293). Nightly fuzzing built a sketch body where a 625 mm arc and a 115,763 mm arc leave a corner only 0.545° apart, and OpenCascade read our file as a loop crossing itself. Worked out in 50 digits, no two pieces meet, the file is within 4e-13 mm of exact, and OpenCascade's verdict flipped with the big radius moved by one unit in the last place. Owner's decision: when crossing itself is OpenCascade's only complaint about a file (every other face, loop, edge, vertex and shell check passes) and the 50-digit check finds no crossing, that verdict is listed under "OpenCascade's tolerance at a sharp corner" and counted on its own line of the oracle's output, never dropped. The file's faces, volume and area still count. Verified: #293's file kept as a regression; its neighbours one unit in the last place either side (one read invalid, one valid) both pass; a flipped face and a loop walked backwards on it are still counted; a hand-worked bow tie (crossing at (1, 1)) is never excused; deliberate breaks of each new rule fail the tests; all oracle tests pass; the fuzz seeds' 1,960 bodies agree, and with a flipped face planted in every file every one is caught; a planted random round (125 bodies) is all caught or under the small-feature limit.

## 0.30.5 (2026-10-24)

- Fix: the nightly oracle no longer counts OpenCascade's rounding on very thin frames and rings as a fault in our STEP files (#282). On a straight extrude whose hole nearly fills its outline (walls of about 0.001 mm, from 60 mm to 78 m across), OpenCascade worked out each end face as the outline's area minus the hole's, two nearly equal numbers. That multiplied its rounding, and it read the volume 1 to 1,000 times the allowance off. Our kernel's volume matched the exact answer to about 15 digits, and OpenCascade misread the volume just as badly when every corner was rewritten to the nearest possible double. Owner's decision: a flat face with holes now gets extra room for exactly the loop area that cancels on it (its loops' areas added up, less the face's) times the harness's rounding per corner. Every miss excused this way is listed under its own heading, "OpenCascade's cancelling loops", and counted in the oracle's output, never dropped. A face without holes gets no extra room, and a hole walked the wrong way gets none either. Verified: a hand-worked 10 mm frame with an 8 mm hole (128 mm² cancelling per cap, 256 in all), a miss at 0.9× of the room listed and at 1.1× counted, a flipped hole still found (invalid, volume 21.3 off, area 272 for 144), #282's 60 mm frame kept as a regression, deliberate breaks (no room, or room for the loops' whole area) each failing the tests, all 112 oracle tests passing, and the 42 failing seeds from #279 to #282 replayed on main: 39 findings before, none after (28 listed as cancelling loops in the 26 rounds re-judged).

## 0.30.4 (2026-10-24)

- Fixed (nightly mutation testing, storage): the nightly run was red on six surviving changes to autosave's "does following the undo history change anything?" check (added with the fix for a change made within a second before Open). Two new tests kill the ones that matter: going back to the last written state while a save of a newer state is in flight must still save (otherwise the store would end holding the newer state under an older project), and going back to it after a failed save must leave the error and save again. The other three changes can't be told apart by any caller (a stored version equal to the current one already means no timer and no save is running) and are explained in `explained.json` with that reason. Checked: both tests fail with the check replaced by `true` or its `&&` by `||`; `run.sh storage` and `check.mjs` report all 26 remaining survivors explained.

## 0.30.3 (2026-10-24)

- Fixed (daily bug hunt 3e, Firefox and WebKit): when the geometry kernel's worker can't load (the page left while it starts, a dropped connection), the app went silently dead: no message, the view stuck rebuilding, every later edit waiting forever, and "kernel worker crashed: undefined" thrown as an uncaught error (WebKit's smoke test hit it on a reload). Now every waiting and later kernel call fails at once and Design says "The geometry kernel didn't start (its worker didn't load). Reload the page to try again." (or what the worker threw). Regression tests: three kernel client tests and a smoke check that refuses the worker's script, each failing without the fix. The smoke test now passes whole in Firefox and WebKit (53 checks each, CI): its phone-width focus check also says every tab stop is a control (Firefox's own stops on two scroll containers named and allowed), which was the one real Firefox difference; the Save, Layout tab and split view failures listed in TC4 were knock-ons of it or are already gone.

## 0.30.2 (2026-10-24)

- Step 30 (3/4), the boolean nasty-case generator and its judge (30c): seeded pairs of boxes and of turned prisms in every flat family of the nasty-case catalogue (faces lying in the same plane either way round, sitting on, touching along an edge, at a corner and side to side, a shared corner, one inside the other, apart, crossing, and corner on corner), at the origin, 1 km and 100 km out and at micrometre size, and with gaps of 0.9× and 1.1× the kernel's tolerances either way, written as lines the kernel's booleans will answer from step 34. The judge (`prototypes/boolean/judge.py`) works out from the exact models of 30a and 30b what each answer must be: it first puts together any two places closer than 20 nm, as the kernel will, then allows exactly the volume, area and position that this move can change, and it accepts either answer only for a length within rounding of 1 µm. Checked by hand-worked cases with the working shown, 0.9×/1.1× boundaries for every tolerance, OpenCascade's own booleans on the same pairs (agreeing on all 499 it can judge), and eight kinds of planted wrong answers, all of which it catches; CI runs it on every pull request. A 20-seed run (10,320 lines) found three bugs, each fixed after a regression test: the turned-prism model mishandled an edge lying exactly in the other solid's plane; freely turned pairs could carry an accidental 15 nm near miss (now drawn again); and a corner near the far-off extension of a face was treated as near the face. The rerun is clean.

## 0.30.1 (2026-10-24)

- How long things take, measured: `.github/scripts/timings.py` reads GitHub's records of the last days (14 by default) and prints, for every workflow run, every job (kernel, app, each e2e shard, Firefox, WebKit, coverage, mutants, the nightly random testing and fuzzing), every step of a minute or more (with `--steps`), and merged pull requests (first commit, opening and ready, each to merged, and time in the merge queue), the median, the slow case (p90) and the worst, with failure counts and how long jobs waited for a runner, so time estimates come from measurements. Checked by hand-worked percentiles and pull request times with the working shown, 500 seeded cases against a second way of finding a percentile, and planted breaks that each fail a test.
- Step 30 (2/4), an exact model of booleans on turned shapes (30b), the second referee the boolean fuzzing and steps 31 to 35 are judged by: for two convex prisms (any convex outline whose sides have exact lengths, pushed up into a solid, then turned at angles like 36.87° whose sine and cosine are exact fractions, about any axes, and moved), it works out with exact fractions what the kernel's union, subtract or intersect must answer: the bodies with their volume, area, faces, edges, corners, holes and voids, or the refusal (nothing left, touching only along an edge or at a point, or thinner than 1 µm) and where. It handles faces lying in the same plane and parts just touching, not only shapes crossing cleanly. Checked by 14 hand-worked cases and 4 touching places with the working shown, the 1 µm and 20 nm boundaries at 0.9× and 1.1×, seeded turned pairs against a second, independent way of counting, the box model from 30a agreeing exactly on 65 box pairs (some turned), OpenCascade's own booleans agreeing on every case and 118 seeded turned results, and planted breaks that each fail a test. Runs in CI.

## 0.30.0 (2026-10-24)

- Step 30 (1/4), an exact model of booleans on boxes (30a), the first piece of the boolean fuzzing harness that steps 31 to 35 are built against: given two solids made of boxes, it works out with exact fractions what the kernel's union, subtract or intersect must answer, the bodies with their volume, area, faces, edges, vertices, holes and voids, or the refusal (nothing left, parts touching only along an edge or at a corner, or something thinner than 1 µm) and where. Checked by 16 hand-worked cases, the textbook vertex rule on all 256 arrangements, the 1 µm and 20 nm boundaries at 0.9× and 1.1×, seeded identities against an independent voxel count, OpenCascade's own booleans (which agree on every case except a face that touches itself at a corner, where OpenCascade's answer breaks the Euler formula), and planted breaks that each fail a test. Runs in CI.

## 0.29.2 (2026-10-24)

- Step 29 (3/3), the app's own bodies checked by OpenCascade (29b3), which finishes step 29: the kernel gives the app any body it keeps as a STEP file (`body_step`, placed where the app shows it), and three more nightly checks have OpenCascade read and judge those files as the random testing does: the golden models' bodies, rebuilt through Design, against their hand-worked volume, area and face count (27 bodies); every body the coverage-guided fuzzers' inputs build (about 2,000 from the saved seeds alone); and every extrude the simulated sketching sessions build. Each nightly job then plants a flipped face in every file of a short run and fails unless every body is caught, and every pull request's CI does the same with the fuzzers' saved seeds. Fixed on the way, in the oracle: OpenCascade fitted some arcs' curves a whole turn away on the faces they lie on and called two good random bodies invalid with nearly twice their volume, which would have filed false issues tonight (it now moves such a curve back by the turn, which can't turn a face or reorder a loop); and the small-feature allowance from 29b2 excused a body with any radius under 0.01 mm whatever was wrong with it, so a planted flipped face in a 441 mm part with a 7 µm hole went unreported; now it only excuses a miss its tiny features could account for. Verified: 8,963 random bodies, 1,960 fuzz bodies, 4,441 session extrudes and 27 golden bodies give no findings; with the planted fault every body is caught except wholly tiny ones (radius under 0.01 mm, the known blind spot left to the kernel's own validator); tests with hand-worked answers, 0.9×/1.1× of the new allowance, kept regressions, and deliberate breaks of each new rule that make them fail.

## 0.29.1 (2026-10-23)

- Step 29 (2/3), every nightly random body checked by OpenCascade from its own STEP file (29b2): the nightly random testing now writes each body it makes, placed where it is, as a STEP file, and the oracle has OpenCascade read that file and judge it: valid by its checker, no tolerance above the kernel's 10 nm, the kernel's face count, and its volume and area against the exact 50-digit referee. A body the harness holds valid that the writer refuses is a finding too. Found on the way: OpenCascade misreads some perfectly good bodies. Far out it loses digits, so a file that fails is checked again as an exact copy of the same body moved home; a real fault is in both alike, so the body passes when either passes every check, and the miss is listed, not counted. And it can't read some bodies with curves of 1 to 5 µm radius (it lost the whole side of a 1 µm cylinder whose top circle sat 3 millionths of a micrometre off the axis, 3,000 times inside the tolerance, and called the rest valid; its normal reader with all its repairs did the same). Those, 13 of 5,231 bodies in the first runs, are listed under their own heading as its limit rather than counted, so they can't hide a fault in a body of ordinary size. Blowing such a body up by a power of two made OpenCascade call it valid, but the merge queue's run showed it did so with a planted flipped face too, so that isn't used. Checked: 5,231 random bodies from two seeds, no findings; hand-worked files (the unit cube, a 1 µm cylinder, a cube moved 100 km out and moved home exactly); the volume and area slacks and the small-feature limit each passing at 0.9 and failing at 1.1; a refusal, a wrong face count and a flipped face each reported; the planted fault blowing up let through kept as a regression; five rounds with every file's first face planted flipped (FISSION_STEP_FAULT), 2,378 bodies, every one caught or under the limit; and the same in CI, a nightly round run as the job runs it. Next: the app's bodies, the golden models and the fuzzers through the same check (29 (3/3)).

## 0.29.0 (2026-10-23)

- Step 29 (1/3), OpenCascade checks our own bodies (29b1): the kernel can now write a body as a STEP file (the standard CAD exchange format, AP214), with every coordinate exactly as the kernel holds it, and a new oracle script has OpenCascade read that file and judge the body itself: its validity checker, how much tolerance it needed to make the body hang together (at most the kernel's 10 nm), and its volume, area and faces. Until now OpenCascade only rebuilt each shape its own way and compared numbers. Found on the way: OpenCascade's normal STEP reader quietly repairs what it reads (a face flipped inside out came back turned the right way, and the body was called valid), which would hide exactly the faults this is for, so the script reads the file without those repairs, keeping only two that can't hide a fault. Checked: a unit cube's file checked by hand line by line, and a cylinder's and a sphere's, which the kernel's tests hold its output to; OpenCascade reads them with volumes and areas worked by hand (1 and 6, 12π and 20π, 32π/3 and 16π); six faults planted in those files (a flipped normal, a loop walked backwards, a face turned over, a missing face, a cylinder facing in, a sphere's equator walked one way twice) are each caught, and a corner or edge moved 0.9 of the tolerance passes while 1.1 fails; 36 bodies of every kind the kernel makes today, turned and moved 90 km out, read back from their files exactly; every refusal (an invalid body, more than one shell) says why and never panics. CI now installs OpenCascade, so the oracle's own tests run on every merge instead of being skipped. Next: every body the nightly random testing makes goes through it (29 (2/3)).

## 0.28.2 (2026-10-23)

- Step 28 (3/3), golden models nightly (28b), which finishes step 28: every night the golden models that build today are rebuilt 50 times each on one kernel, in an order shuffled by the night's seed, and each rebuild must match its hand-worked answers and give exactly the same answer as its first rebuild that night (so the kernel and Design can't depend on what ran before), and the kernel must hold no body afterwards. A failing model files a `random-testing` issue like any nightly failure (one per kind, with the command that replays the night in the same order), and the night's lines go into `summary.txt` on test-results. `tests/baseline.json` gains each model's rebuild time (against the fixed workload, warned past 15%, failed at twice as slow), its kernel calls (exact, worked out by hand: two per body and one per sketch) and the golden success rate (any wrong answer fails), measured on every pull request and each night. Checked: hand-worked tests of the shuffle, the counts and the report; the night run as the job runs it with three bugs planted in the kernel's answers (one model's volume a millionth out, answers that drift by a ten-trillionth per rebuild, bodies never freed: 54 left, as worked out), each failing the night and filing the right issue; the issue filing and the test-results update run for real on a scratch repository; and nine bugs planted in the new code itself, each caught.

## 0.28.1 (2026-10-23)

- Step 28 (2/3), golden models (28a2): the answers for eleven more parts, worked out by hand before the features that make them exist, each with its recipe (the clicks and numbers a user gives, and the id each item gets) so the thread that lands its step makes exactly that file, and each switched on the day its step lands. A box less a smaller box over its corner, a hollow box (one body with a void), a cut whose far wall ends half a micrometre past the part, a plate a kilometre out with a pocket, a 1 µm cube cut in half (refused, since the half left would be 0.5 µm thin, with both bodies kept) and a 2.2 µm one (whose 1.1 µm half builds) wait for flat booleans (34); stacked blocks joined flush for faces on each other (35); a drilled block (37); a hollow pipe tee, whose volume and area need elliptic integrals (38c); Ben's bar cut by a slot into two bodies, and the two-hole bracket made with cuts (39a). The format gained recipes, shell counts and expected refusals, and the arithmetic the elliptic integrals; the tee's answers are checked against its integrals done numerically. Fix found on the way: volumes and areas were compared to a billionth of at least 1, so a 1 µm cube's volume could have been twice what it is; now to a billionth of their own size.

## 0.28.0 (2026-10-23)

- Step 28 (1/3), golden models (28a1): a set of real parts kept in `tests/golden/` with their answers worked out by hand, rebuilt on every test run through Design's own rebuild on the real kernel. Six models today's app builds, each made through the app itself: a plate with a stepped boss sketched on faces (one point pinned to the boss's circle), an L bracket on the front plane, the plate with two holes, a 24-tooth gear with 48 arcs, an open enclosure (a floor and four walls with eight pinned corners) and a 31-item part. For every body the volume, area, face, edge and vertex counts, box and largest tolerance are checked; for every sketch on a face, the face's name and plane; for every pinned point, its pin and where it lands; and a save and reopen. Every number in an answer file is written as arithmetic with its working beside it. Models that need a later step (booleans) will be written ahead of that step and run from the day it lands. The kernel now reports each body's exact box (circles and arcs included, not just its corners). Checked: all six match on the first run; wrong answers planted in a file (a volume a millionth out, a face's name, a tolerance, a pin) and five bugs planted in the kernel's answers (among them a corner 20 nm off its faces that validation didn't report, and a box missing a circle's bulge) are each caught.
- CI (with 28a1): the check of mutants in a pull request's changed kernel code failed whenever they fit in one shard, since the artifact download action (v5 on) unpacks a lone artifact straight into its folder; the check now puts that shard's files back where it reads them (one shard reported, a lost shard still fails).

## 0.27.11 (2026-10-23)

- Roadmap: the CAD steps after 27 are renumbered so the numbers run in build order again (Ben's ask), after the reorder that put booleans first kept the old numbers. Old 38–40 (golden models, oracle, fuzzing) are now 28–30, flat booleans 41–45 are 31–35, the solver core 29 is 36, curved booleans and extrude modes 46–48 are 37–39, full naming 50 is 40, chamfer and fillets 55–57 are 41–43, the sketch steps 28 and 30–33 are 44–48, the hole stays 49, 34–37 are 50–53 and 51–54 are 54–57; 1–27 and 58 on are unchanged and substep letters stay with their step (old 47a is 38a, 47f is 38f, 50a is 40a, 39b is 29b, 48b is 39b). `docs/progress/booleans.md` (with the outside review's new text) is renumbered too, and the fillet step 43 now says it needs 38f. The full table is at the top of `docs/roadmap.md`, and the roadmap's sections are now in build order. Every doc, CLAUDE.md, code comment and workspace placeholder (Laser, Slice and Vector start after step 48, Simulate and Manufacture after 40) that cites these steps uses the new numbers; entries below this one keep the old ones. No behaviour changed.

- Plan (no change to the app): the outside review of the boolean design (B0r) is done. It kept every B0 decision and made four of them precise: two things are "the same" within the sum of their tolerances and the too-thin band is judged on the result, not the inputs; the facts table alone decides same-or-apart and no later stage may make a vertex or measure; booleans take imported inputs up to half of MIN_FEATURE and refuse looser ones (nothing loosened); and surface pairs with no closed form get a general crossing finder (new step 47f) before the fillets instead of waiting for NURBS, since fillets trim their own pieces against each other. It also fixed the plan where it could go wrong: merging crossing points by cluster width would have refused shallow cuts, determinism needs a geometric order, the split-body naming rule needed a fallback, OpenCascade's results need their faces unified before counts are compared, and the golden models now hold names and tolerances too. Two Fusion checks (F6, F7) are queued for the owner. Docs only, so the version stays.

- Fix (#262): a project file listing the same sketch twice in Design's sketches list, the second copy with a broken "projected" field (text instead of a list), wasn't refused when opened; the reader looked past the second copy, which was then read further on and gave a raw engine error. Now a sketch listed twice is refused on opening with "Design sketch … is listed twice in the sketches list". Checked by a failing-first unit test, the old "first copy wins" test now checking that both orders are refused, the fuzzer's saved file kept as a permanent regression case, and the file reader's mutation-testing range widened to cover the new lines.

## 0.27.10 (2026-10-23)

- CI: a pull request that changes only writing (anything under `docs/`, `CHANGELOG.md`, `README.md`, `VERSION`, or any `CLAUDE.md`) no longer runs the heavy checks. The kernel build and tests, app, baseline, every browser check, coverage and mutation testing all skip, both in its own run and in the merge queue's. The kernel check still runs the CI scripts' tests, which include `VERSION` against `CHANGELOG.md`. Any other file means the whole suite as before. So do a file moved out of code into `docs/`, an empty change, or file lists that can't be read. The queue compares the commit it would merge with main's, so a code change queued ahead still means full CI. Skipped required checks count as passed for main's rules and for auto-merge. Checked by hand-worked tests of which paths count (and 23 near misses such as `Docs/`, `kernel/docs/`, `tests/baseline.json`, `docs/../kernel`), a real two-commit git repository for the queue's file list, an auto-merge test of a docs-only head, and four planted breaks in the classifier, each failing a test. CI work, so the version stays.

- Fix (flaky checks, known-bugs sweep): the smoke and reopen browser checks could read the volume before the kernel's first build of the box had come back, so a slow runner saw "—" and failed. Smoke now waits until the viewport says no rebuild is waiting (`data-rebuilding` reads "false" only once a rebuild has answered) and a frame has been drawn, at the start and after each shape change or typed size that later checks read; reopen waits for the opened plate's real volume (not the box's and not "—") and for the fresh project's box to be built. Also removes a stray scratch script, `apps/fission/e2e/repro-grid.tmp.mjs`. Checked with the kernel slowed by 200 ms (`E2E_KERNEL_DELAY=200`): smoke's "default box" check and reopen's two "half-opened" checks failed before and pass now; the full browser suite, `npm test` and typecheck pass at normal speed. And the workspace-switch check (switching.mjs) no longer fails on a one-off runner stall (one switch in 30 took 106 ms against a 28 ms median and threw this pull request out of the merge queue): the limit stays 100 ms, but a switch over it is timed once more, the same kind of switch (a first visit in a fresh page, a return by switching away and back), and fails only if it is slow both times (Ben's choice). Two new checks prove it: a 150 ms hold planted on every click on Image's tab still fails all six of its switches, and the same hold on only Design's first return passes. Still failing only with the kernel slowed: smoke's four selection checks, the 1 µm cube's framing and the split-view status check, and reopen's four checks that hold the kernel themselves. And the Image split-view check read Design's pane the moment the second pane switched to Render, while Design's canvas, just resized, was still blank until its next frame; it now gives the body up to 2 s to be drawn again (it still fails, after 2 s, when the point read is the background).

## 0.27.9 (2026-10-23)

- Fix (two leftovers from the timeline bug hunt): a drag on the timeline bar, of an item or of the marker, couldn't be called off: Escape did nothing, letting go over the 3D view still dropped it at the place under the pointer, and a right-click opened the item menu while the drag went on. Now Escape, a right-click, or letting go more than 72 px above or below the bar calls the drag off, nothing is recorded and the bar is drawn as it was; while the pointer is that far away, an item's drag line says "Let go here to leave it where it was". And a file giving one Design id to two items was refused with the wrong reason ("a sketch with no content"); it now says "Design id … is used twice". Checked by hand-worked unit tests (letting go 0.9× and 1.1× of 72 px from the bar; Escape and right-click for an item and the marker; a long press that isn't a drag still opens the menu), a failing-first test of the file message, the marker's browser check now pressing Escape mid-drag and letting go 200 px above the bar at 1280 and 375 px (it fails with the fix taken out), and mutation testing of the file reader (no new survivor; a check made redundant by the new one was removed).

## 0.27.8 (2026-10-23)

- Plan (no change to the app): the UI look-and-feel workstream, designed with the owner. The app will resemble Fusion 360's layout while keeping its own icons, names and colours: a slim app bar with one workspace button, a grouped toolbar of flat two-tone shape icons with dropdowns, the properties panel folded away in favour of a floating box for the running tool, light mode and a Settings page (theme, units, mouse controls, grid defaults, AI), one row of icons with bottom sheets on a phone, and a home screen the app opens on, with the last project one click away and projects filterable by workspace. Steps U1 to U8 and their test plans are in the new `docs/progress/ui.md`; the work starts when the owner says so.

- Boolean plan: Ben's five Fusion checks are answered and written into `docs/progress/booleans.md` as rules, replacing the open questions. Which piece of a split body keeps its name (the piece holding the first face, in the order made, that lies wholly inside one piece). A Join of bodies that don't touch leaves separate bodies with no warning. A Cut that leaves nothing, or an Intersect with no shared volume, fails with words and keeps both bodies. A cut's bodies are fixed when it is made, so a later body is cut only if picked. A sketch on a face keeps its plane when only the face's outline changes. Docs only.

- Fix (found in 27b, #251): on a slow phone, tapping a circle's rim and then Finish Sketch straight away lost the circle. Each tap waits its turn behind the kernel's rounding of the one before; Finish Sketch closed the sketch at once, so when the tap's turn came the sketch was no longer open and the tap was dropped. Finish Sketch now waits for the taps, typed Enters and projections made before it, draws them, then closes the sketch (Escape still drops a waiting tap, since it is a cancel). Checked by a new real-kernel journey (`journeys/finish-wait.journey.ts`) with the kernel held to make it slow: a circle's second tap then Finish keeps the circle (centre and radius worked by hand) as one undo step, and two line taps then Finish keep both lines in order; both failed before the fix. Finish with nothing waiting still closes in the same moment.

## 0.27.7 (2026-10-23)

- Fix (found by a seeded thin-crescent hunt, part of the known-bugs sweep): a crescent 63 m long and 1 µm wide at its middle, its two horns meeting almost tangent, took 52 s to extrude, though the answer was right. Each arc needs about 124,000 chords there to keep clear of the other, so each wall is a very long, very thin strip of points, and the triangulation library's fast loader goes quadratic on strips like that (and on points round a circle about their centre): 21 s per wall. Faces with more than 2048 points are now triangulated by adding the points one at a time in a fixed shuffled order with a search hierarchy, which stays fast for any shape; smaller faces are meshed exactly as before, so every baseline mesh, allocation count and memory peak is unchanged. The crescent now extrudes in 2.3 s. Checked by a timing test that failed before the fix (60,000 points on a 1000 × 0.01 strip took 2.6 s against 61 ms for the same count round a circle; now within 2 times), hand-worked tests (a strip's N − 2 triangles and area 10; the crescent's volume worked to 50 digits from its two arcs' segments; the shuffle's order worked by hand; the switch at 2048 and 2049 points), and 3,990 seeded crescents and off-centre rings up to 90 km out with no panic, no wrong refusal and every mesh closed.

## 0.27.6 (2026-10-23)

- Fix (timeline bug hunt follow-up): an edit made less than a second before opening a file, dropping one, or starting a new project was lost from the old project, because replacing the project stopped its autosave and threw away the save that was still waiting for its one-second quiet moment. Autosave now finishes instead: the project as it is goes to the unsaved-changes journal at once and to the store after any save already under way, so the stored old project keeps its last edit and the new project never overwrites it. Checked by a browser check that types a width, opens a file while the status still says Saving…, and reads the old project back from the browser's store (it failed before the fix), and by hand-worked unit tests (0.9× the quiet moment, a save in flight, the journal full, the store failing, nothing changed, changed and back).

## 0.27.5 (2026-10-23)

- Fix (four leftovers from the timeline bug hunt, each with a browser check that failed before the fix): on a phone, picking an item on a timeline bar long enough to scroll sent the bar back to its start, so the picked item and its ⋯ (a phone's only way to the item menu) went off the screen; the bar now keeps its scroll and brings the picked item's ⋯, or a marker that moved, into view. On a phone a refused bar action (Go to the start while a sketch is open, say) wrote its reason only to the error line far below the screen; the words now show just above the bar too, until the bar is next drawn. The item menu (and Delete's question, and the other boxes) stayed open on Escape once the keyboard focus had left it, because the app's own Escape shortcut took the key; no shortcut runs now while one of the app's boxes is open, so Escape always closes it. And on a wide screen the browser's Timeline rows of a failed item, or of an extrude keeping its last shape, were not red (the floating rows' own colour won), and a kept shape's rows were not red at any width (the buttons' colour won); they are red everywhere now. Checked by a new browser check at 1280 px with the mouse and 375 px with taps (a 12-item design opened from a file), an added colour check in the Edit Sketch check, and hand-worked unit tests of the scroll sums with one-pixel boundaries.

## 0.27.4 (2026-10-23)

- Fix (random testing, issues #240 and #241): two of the random-testing harness's checks misread correct bodies; the kernel was right both times. (#240) A 1 mm disc drawn about 964 m out and moved back near the origin keeps the rounding of 964 m in its display mesh, a quarter of the smallest step a number can take there; the check after the move judged that rounding at the moved body's own size, as if it had been built where it ended up, and called it the box missing a mesh point. It now allows for where the body was built and how far it moved, as the other moves already did. (#241) A frame 234 m by 117 m, 100 km out, with walls 1 µm thin: the check that the faces' areas add up to the body's took the faces from the body as built and the total from the same body shifted to sit round its own centre, whose corners and sums round a little differently (1.5 parts in a billion apart, past the check's one part in a billion); both now come from the same body, at the same limit. Checked by both failing cases kept as permanent tests (each fails with the old check), a hand-worked test for each (the disc's top and the frame's exact areas worked out with exact fractions), a planted error of 4 parts in a billion in face areas still caught, and both nightly seeds replayed clean at 2000 cases.

## 0.27.3 (2026-10-23)

- Roadmap (no change to the app, Ben's architecture review and boolean plan): the review's fixes are now in `docs/roadmap.md` where they will be built. The naming rules for booleans (50a) come before the Combine tool at 44, with today's names still valid; a minimal STEP writer (39b) joins the test block 38–40 so OpenCascade checks our own bodies and runs its booleans on our exact inputs; the kernel watchdog and keeping display meshes only for bodies on screen land with 44 (44d); per-edge tolerance moves from 46a to 41a; one general surface and curve interface comes at 46a and one general tessellator at 47a; the kernel half of cones and tori (35) comes before chamfers and fillets (55); component ids get namespaces before 74 or X12; and the project file becomes a zip before the first binary file is saved. Slice fixes from its plan: the first real downstream chip and change note come with P6 (G-code and the print estimate), not P2; the integration map and the Slice placeholder page now say Slice starts after step 33, not 73; and Ben's printer is a Bambu Lab P1S, not a P2S.
- Fix (found by the daily bug hunt, 2026-10-23): a design that builds nothing (the marker at the start, or everything suppressed or deleted) gained a new 40 × 30 × 20 box when Design was moved to the other pane (Split, then the panes swapped from the switcher), with no undo step, and it was autosaved. Mounted again on the document it last made, Design now shows that document as it is instead of making one again from the size boxes. Checked by a journey that mounts the same design twice (built, suppressed, rolled back, emptied) and a browser check that swaps the panes, both failing before the fix.
- Step 27e, the bug hunt for step 27 (pins and the Project tool), four bugs fixed, each with a failing test first. A projected line followed the kernel's order for its two ends, which flips when an extrude is flipped, so a line drawn from one end of it jumped to the other end; the ends are now ordered by their corners' names. Tracing a projected edge with your own line (or projecting a face seen edge on) made a doubled edge and the outline was refused; a projected curve lying on another one is now left out. A sketch of only projected edges that don't close said "no lines yet"; it now says why. And a line drawn from a projected point (the sketch shares that point) made the saved file unopenable, so redo and reloading lost the line; such a file now opens. Checked with hand-worked tests, a new real-kernel journey of nasty cases (1 µm and 998 m bodies, slivers, flips, ends 0.9× and 1.1× of the 10 nm limit apart), four new planted bugs, a browser test at 1280 and 375 px in Chromium, Firefox and WebKit, file fuzzing, the monkey with Project, 1000 naming sessions and face-chaos, all clean.

## 0.27.2 (2026-10-22)

- Testing (daily bug hunt 3d, old saved files): 17 projects saved by older Panosolids are now kept as permanent tests (`packages/testing/old-files/`). Each was made by running that older version's own code, not written by hand: its document functions for the oldest ones (version 1 ready-made parts from step 19d; version 2 sketches with lines, circles and half-circle arcs from steps 21d to 23a; the first version 3 files with several bodies, suppress and the rollback marker), and its Design app on its own kernel for five (a kept shape after a sketch was deleted, a flipped extrude on a box's top, a circle pinned to a face's corner, one pinned to another body's corner, and that body deleted). `journeys/old-files.journey.ts` opens every one through today's reader, checks the upgrade (items, suppressed flags, marker, id counter), builds each on the real kernel against volumes and end-cap centres worked out by hand to a billionth (a plate with two holes 12000 − 360π mm³, a star 8000 sin 36°, a triangle on the front plane whose end cap lands at y = −12, and so on), saves and reopens each (same document, same text), opens each in the Design app, and adds a new item to each without repeating an id. Eight deliberate breaks of the upgrade, profile, plane, flip, kept-shape and marker code were each caught; the comparers are checked at 0.9 and 1.1 times their limits. All 17 files open and build as they did. Probing every timeline menu action on every old file in the app found one real bug, not in the file reading: moving Design to the other pane (Split, then picking the split pane's workspace in the switcher) on a design that builds nothing (marker at the start, everything suppressed or deleted) silently added a new 40 × 30 × 20 box at the marker, with no undo step. Reproduced in Chromium; the fix is in the Design workspace file another open pull request is changing, so it is handed over to land after it rather than fixed here.
- Step 27d: the Project tool (P). In a sketch, Project takes the edge under the pointer, or every edge of the face there, of any body built before the sketch, and adds it to the sketch as a linked curve, drawn violet: a straight edge becomes a line (a single point when it runs straight towards you), a round edge lying parallel to the sketch becomes the same circle or arc, and one standing square to it becomes a line as long as it is wide. A round edge at a slant would be an ellipse, which sketches can't hold yet, so it is refused in words (a tracked compromise, until sketches get ellipses). Projected curves follow their edge whenever the body changes (a cylinder made wider makes its projected circle wider, and anything extruded from it), can't be dragged by hand, are deleted whole, can be snapped to, and become part of the outline where they close it with the sketch's own lines, so a face's projected edges extrude on their own. When the edge is gone, the curve stays where it was and the sketch warns "projection lost" on the panel, its timeline row and its bar item, never jumping to a guess. Projecting an edge twice adds nothing and says so. The body the edge is on becomes something the sketch is built on, so suppressing it greys the sketch, dragging across it is refused, and deleting it asks first. Files save projections and refuse every broken one. Checked by hand-worked tests (a box's edges seen from three planes, one tilted at a 3-4-5 slope; circles and arcs seen flat and edge on; every limit at 0.9 and 1.1 times its 10 nm or 1 µm size), the real kernel (a cylinder's rim projected from the ground, the front and the box's top, followed when its radius changes, lost when it is redrawn as a rectangle), 100 random sessions of 150 steps checked against the test model with every projection case reached, project-file fuzzing that now writes projections (362,000 files, no failure), 10 new bugs planted on purpose plus 7 older ones moved onto the new code (each caught), and browser checks at 1280 px with the mouse and the P key and at 375 px with taps. The browser check fails with a planted bug that stops projections following. Found while it was being built: the app never showed a lost projection's warning, though the rebuild knew; fixed, with a check that fails without the fix. Also from the coordinator: Stryker's surviving mutants in the file reader's pin checks, killed or explained. No version change: a step's feature pieces don't change the number.
- Testing (mutation testing for the TypeScript packages): Stryker, which plants small bugs in the code one at a time and checks a test notices each, now covers seven areas instead of two: the core model (links, ownership, the dependency graph, commands, actions, file sniffing, shortcuts), the SVG writer, storage, the viewport (picking, navigation, the view cube, the sketch grid), the AI assistant (providers, key storage, the context it is given), plus core and Design as before. 136 new tests catch planted bugs the old ones let through, among them an SVG sniffer change that would loop for ever on `<?<??><!--`, a zoom landing exactly on its limit, a square canvas's fit at 2.26 degrees, and a "start" marker with an item called start. Every planted bug still not caught is one no caller can tell apart from the real code (a check that a later check repeats, a sort tie V8 keeps in order), and `packages/testing/stryker/explained.json` says why for each; `check.mjs` fails on any that is neither caught nor explained, and on an explanation the tests now make out of date. Survivors: storage 57 to 22, model 177 to 37, viewport 85 to 33, AI 230 to 12, SVG 7 to 4, all explained; Design has 12 left from the step 26f pins, for the Design thread. A new nightly job, `ts-mutants`, runs all seven areas and writes the result to `ts-mutants/latest.txt` and `summary.txt` on `test-results`; `stryker-config.test.ts` checks every area's config, the nightly list and that each survivors test file runs in its area (each check shown failing on a broken copy). Checked with `npm test`, `npm run typecheck`, the CI scripts' 106 tests, and every new test failing with its planted bug put in by hand.
- Step 27c: a sketch's points can now be snapped onto the corners, edge middles and round edges' centres of any body built before it, not only the face it is drawn on, and on any plane, the ground, front and side planes included. The other faces of its own body count too, seen straight along the sketch's normal, so a sketch on a box's top can snap onto its bottom corners. Bodies that come after the sketch in the timeline offer nothing. Where several land on the same spot, the one lying on the sketch's own plane is taken first, then the nearest to it. A snapped point is pinned to that body and follows it: the body's feature becomes something the sketch is built on, so suppressing it greys the sketch, dragging the sketch before it (or it after the sketch) is refused in words ("it is snapped to an edge of Feature 1 (box)"), and deleting it asks first and keeps the points where they were, marked lost. Files save which feature each pin is on; 0.26 files open unchanged. Checked by hand-worked tests (a box's top offered all 20 points in the right order, a sketch on the ground pinned to the box's bottom corner, a sketch before the box offered nothing, the same-spot rule at 0.9 and 1.1 times its 10 nm reach), 100 random sessions of 150 steps checked against the test model, 1,000 random chains of sketches on slanted faces, 100 random app sessions of 80 steps, bugs planted on purpose in Design's code (5 new ones kept in the planted-bug runner and 3 old ones moved onto the new code, 16 more tried by hand against the new tests, one against the browser check; each caught), and browser checks at 1280 and 375 px. The random sessions picked points on a body's round edges far more often than real corners, so they almost never snapped to another body; they now pick only real corners. No version change: a step's feature pieces don't change the number.
- Fix (found by the random app sessions while 27c was checked, there since 26c): a sketch whose face was lost could be drawn one rounding step (a change in the last digit of one number) from where it was, against the rule that it stays exactly where it was. A frame is squared up in doubles before the kernel sees it, and squaring a frame that was squared already moved it by one rounding step four times in ten on slanted faces (faces that are square to the axes never move, which is why it hadn't shown up; 27c's pins on other bodies made slanted faces common in the random sessions). A frame already square to rounding (within 8 steps of it) now keeps its numbers, and any other is squared until it is, so squaring twice gives the same as once. Checked by the failing case kept as a permanent test (the design that failed, edited the same way), a hand-worked test, boundary tests at 0.9 and 1.1 times the 8-step limit, and 40,000 random frames from 10⁻⁵⁰ to 10⁵⁰ long (one in four with x nearly along the normal) that each square to the same numbers twice and stay within the kernel's 64-step limit; 3 planted breaks of the fix, each caught.
- Fix (CI browser install failing on a slow but working mirror): tonight azure.archive.ubuntu.com took about 2 minutes per 9 MB file, and `browsers (firefox)` on #251 used all three 5-minute tries and failed, though the mirror was alive. `.github/scripts/install-browser.sh` now gives the system packages 12 minutes a try (apt itself still drops a connection that sends nothing for 30 s, so a dead mirror is not waited for) and the browser download 5, inside a total budget of 25 minutes for the whole script, so a dead mirror still fails the job in 25 minutes at most. Tries 2 and 3 switch apt from the Azure mirror to archive.ubuntu.com. The install steps' limit goes from 20 to 27 minutes, and the jobs that had 30 minutes (the three e2e jobs and the nightly journeys) get 45 so the install and the checks both fit. Checked against a stand-in `npx` and `sudo`: passes at once; fails every time (three tries cut to the budget, exit 1, mirror switched); stalls (killed at the budget, no process left over).

## 0.27.1 (2026-10-22)

- Step 27b: both corners of a half disc can now be snapped to and pinned. A sketch on a face snaps onto that face's corners and follows them (26f), but a corner was named by the edges meeting there, and a half disc's two top corners meet the same two curves, so they shared a name and neither was offered. Each corner is now named by which end of each curve meets there (the line's end and the arc's start, say), which tells them apart and stays the same however the outline is turned: the first plan, using the order the outline goes round, was checked on the real kernel first and found to swap the two corners when the extrude is flipped, when an outline is drawn the other way round, or when a crescent's two arcs swap which bulges further, which would have moved a pin to the wrong corner without a word. The same goes for lenses, crescents and the middles of the upright edges. Files from 0.26 still open with their pins found. Checked by a test that failed before the change (a half disc with both corners pinned, its radius changed from 5 to 8, each pin following its own corner), hand-worked cases for a flip, a crescent and a triangle turned over, 300 random outlines (polygons drawn either way, half discs, lenses, crescents, slots, arcs bulging in, flipped or not, on the ground and on four faces of a box, from 0.01 to 10 times the size and 200 m out) where every corner's name was checked against where it is, 7 deliberately planted bugs (each caught), and browser checks at 1280 and 375 px. The random naming sessions also found an outline turned the other way round under a pin while this was being written; that case is kept as a permanent test.
- Fix (CI runs hanging while installing the browser): `npx playwright install --with-deps` runs apt-get, which stalled for 13 minutes on the Ubuntu mirror and got #251's and #252's runs killed. All four installs (three in CI, one in the nightly journeys) now go through `.github/scripts/install-browser.sh`: apt retries each download 3 times and gives up on a silent one after 30 s, the system packages and the browser each get 5 minutes a try, three tries in all, with a 20-minute limit on the step (the quick e2e job's limit goes from 15 to 30 minutes so the tries fit). The packages are installed under a time limit running as root, because a first version of this fix timed out as the runner user, which may not stop the apt-get it started: that apt-get kept the package lock and the next try failed on it (seen in this pull request's own CI); a killed install is repaired with `dpkg --configure -a` before the next try, and apt waits up to 2 minutes for a lock still held. Checked with actionlint and shellcheck, the workflow scripts' 106 tests, and the script run against a stand-in `npx` that passes, fails every time (exit 1 after three tries) and stalls with a child process like apt-get's (killed with its child, no process left over, then passes on the next try).
- Boolean build plan (Ben's ask: map out how booleans are added, with no guessing, before any boolean code is written). `docs/progress/booleans.md` now splits every boolean step into small substeps, from the outside review of the boolean design and the golden models through flat booleans (41–45), curved ones (46, 47a), join and cut in Extrude (48a) and the naming that has to survive them (50). For each it says how it works (every fact about where the two bodies meet is measured once and shared, faces are split along the crossings and kept or dropped by which side they are on), which kernel files it adds, how faces and edges get names when a boolean mixes faces from several features, how it is tested (hand-worked answers, exact models in integers and fractions, OpenCascade reading our own bodies, seeded random runs, fuzzing, planted bugs, browser checks) and when it is done. It takes in the architecture review's findings (names that span features before the Combine tool, a kernel watchdog, keeping meshes only for bodies on screen, one set of questions every surface answers), answers the behaviour questions it could, and lists five for a Fusion check. Docs only.

## 0.27.0 (2026-10-22)

- Roadmap order (Ben's asks): booleans move up to right after step 27 and the break after it, and the hardest parts are front-loaded, so later steps stop piling up assumptions the hard parts would have to undo. The new build order is golden models (38) and an outside review of the boolean design, flat booleans 41–45 (the Combine tool arrives with 44, the first thing to try in the app), the constraint solver core (29), curved booleans 46 and 47a with join, cut, intersect and new body in Extrude (48a), full topological naming (50), the rest of the curved booleans (47b–47e), chamfer and fillets (55–57), then the easier sketch steps 28 and 30–33 and the rest. Step numbers are unchanged because code and other files cite them. Docs only (`docs/roadmap.md`, `docs/progress/booleans.md`).
- Step 27a, the test plan and test harness for step 27 (projected edges), with no new features yet. Step 27 lets a sketch use the edges of bodies that are not its own face: a point can be snapped onto any earlier body's corner or edge and follows it, and edges can be projected into a sketch as linked lines that move when the body changes. Before any of that is built, the test model that checks Design (`packages/testing`) now knows the rules: what a pinned point or a projected edge does when its body is edited, deleted, suppressed or reordered, that a straight edge seen end on becomes a single point, that projecting the same edge twice adds nothing, and that a lost edge leaves its projection where it was with a warning instead of guessing. Checked by 10 cases worked out by hand, 7 bugs planted on purpose (each one caught, and cut down to a 1 to 4 step example), and 24 random sessions of 150 steps that reach every case. The plan splits step 27 into five parts: this one, then giving a half disc's two corners names of their own so both can be snapped to, then snapping onto any body's edges, then the Project tool, then a bug hunt.

## 0.26.12 (2026-10-22)

- Step 26h, the second bug hunt of sketching on a face, which finishes step 26. Seven bugs found and fixed, each with a test that failed first: (1) typing a line's length and angle and pressing Enter quickly, with the next side typed before the app caught up, could place a point far from where it should be (180 mm off in one case); Enter now takes what is in the boxes the moment it is pressed, and gives the sizes back if nothing is placed. (2) A click that took longer than the app's answer to a later mouse move made the preview stick at the click. (3) The small automatic tidy-ups after an edit (a sketch on a face kept where it was, pinned points following their corners) were not autosaved until the next edit. (4) A size box emptied, set to 0 or to -5 sent that to the kernel, and the failed part was saved; it is now refused with a message and the last size comes back when you leave the box, as Fusion does. (5) Fit left out a sketch whose face was lost. (6) A point pinned to the middle of an edge between two sides lost its pin when the outline was turned over (a corner already kept its pin). (7) Enter pressed while the app was busy, followed by a change of tool, placed the old tool's sizes with the new tool. Also checked and fine: faces at exactly 45° and turned a right angle. New tests: a way to hold the kernel's answers in the app journeys so slow-kernel races replay exactly, 14 hand-worked regressions, seeded face sessions starting on a 1 µm cube, a 998 m bar, a 1 µm sliver and a 45° face, long seeded sessions (naming 3,000 × 200, 5,000 slanted chains, 200 face sessions), monkey seeds 21 to 40 (one tester bug fixed: a reload of an empty design waited forever), and browser checks of the size boxes and Fit at 1280 and 375 px.

## 0.26.11 (2026-10-22)

- Fix (flaky checks that kept dropping pull requests from the merge queue): since CI's browser moved to Chrome 156, three Design browser checks at phone width failed now and then, each a different way: the delete-a-sketch check's extrude never happened, the face-sketch timeline check read an empty opacity, and the timeline menu check found its item gone from the page. All three had one cause: the check went on before the kernel's answer to the step before had come back. Extrude's OK stays off until the kernel says the outline is closed, and the check pressed Enter before that, so nothing was made. And every edit draws the timeline bar and the browser twice, once at once and again with new elements when the rebuild comes back (16 to 30 ms later here, in Chrome 141 and 156 alike, longer on CI's machines), so a check that grabbed an element, or read the volume or the picture, in between saw the step before or an element about to be thrown away. The checks now wait for what a person would see: OK turning on, and the rebuild done with a frame drawn. A new test mode, `E2E_KERNEL_DELAY`, holds back each of the kernel's answers by a random time (seeded, in order) to make a fast machine as late as CI's: with it the old extrude check fails every run exactly as CI did, and the old timeline file fails 2 of 2 runs; the new ones passed 13 of 13 runs at normal speed and 12 of 13 slowed (the one miss: at up to 1 s per answer, drawing a rectangle runs past the check's 5 s limit). Running 22 other Design browser files slowed the same way found five more that fail only when the kernel is late (smoke, reopen, free-placement, typed-entry, leave-save); those are listed for their own fixes, one of them (typed lengths entered quickly) maybe an app bug. No change to the app.

## 0.26.10 (2026-10-22)

- Kernel: its maths library glam moves from 0.29.3 to 0.34.1 (the last breaking release before glam 1.0), in the kernel, its fuzz crate and the same-answer check; the only two indirect crates behind (libc, cc) are brought up as well, and every other Rust crate was already current. No kernel code changed: the methods glam removed (camera matrices and the old feature names) were never used. Because every number the kernel gives goes through this library, the whole suite was rerun and compared with a run of the previous version on the same commit: the same-answer check's 2562 saved fuzz inputs give bit-for-bit the same volumes, areas, meshes, STL bytes and refusal messages natively and in WebAssembly as before (and its planted one-bit break is still caught); all 491 kernel tests pass (the fuzz corpus and every saved crash replayed among them); the seeded random session of 216 cases gives 490 of its 492 final bodies identically and the OpenCascade oracle agrees with all of them, before and after. The two other bodies are the tester's own doing, not the kernel's: glam's `min`/`max` now carry a NaN through instead of dropping it, so a hostile profile with a NaN corner no longer adds a made-up size to the tester's pool of interesting coordinates, and two later cases drew different (equally valid) inputs from that pool. The speed and memory baseline is unchanged in memory and allocations and 0 to 3.6% fewer instructions per operation; the app's unit tests, typecheck, journeys on the real kernel and the whole browser suite on Chrome 156 pass on the new WebAssembly.

## 0.26.9 (2026-10-22)

- Step 26g, the first bug hunt of sketching on a face (code read against the rules, seeded app sessions, chains of pinned sketches on slanted faces, long naming sessions, mutation testing, browser checks). Six bugs found and fixed, each with a test that failed first: (1) a sketch on a face that an earlier edit had moved (Edit feature, a typed size, a shape change), and whose face then went, jumped back to where it was first drawn instead of staying where it last was, as Fusion does; every edit the app records is now settled the way the timeline's rules say. (2) With nothing built after extruding a sketch (everything suppressed), the size boxes showed the extrude's distance as a box height; they now show a fresh box's sizes. (3) Sketches after the rollback marker were still drawn, so a sketch on a face could show where its face had been; they are now hidden, as Fusion hides everything after the marker. (4) In a chain of sketches on faces (a sketch on the end of an extrude of a sketch on a face), when one face went, the points pinned on the sketches after it were placed against a body built where the lost sketch was first drawn; settling now repeats until nothing moves. (5) Found by the seeded monkey sessions: settling a sketch on a face (each click since 26c, and every edit from (1)) built the bodies under it a second time and kept them, so the kernel held two copies of each; settling now shares the one store of bodies the part is drawn from, never freeing a body still in use (a new rule in that store, with tests of every overlap). (6) Found while testing (5): "Infinity" typed into a size box, where the box takes it, got into the design, which then couldn't be saved, with no message; it is now refused with "Type the height in mm.", as Edit feature refuses it. New tests: seeded app sessions with sketches and pins on faces, 1,000 seeded chains on slanted faces (30,050 corners checked to 0.1 nm), a file opened with pinned points away from their corners, faces whose name two faces share, a browser check at 1280 and 375 px, and 20 seeded monkey sessions of 150 steps with the case that found (5) kept as a permanent replay.

## 0.26.8 (2026-10-22)

- Upkeep (development tools and CI only; the app people use is unchanged): TypeScript 5.9 → 7.0.2 (the new native compiler; typecheck and the build pass with no edits), happy-dom 20.14 → 21.0.4 (the test DOM; its one breaking change, CSS and iframe loading off by default, touches nothing the tests do), web-llm 0.2.85 → 0.2.86 (the assistant's in-browser model runner; its model catalogue moves to that release's files), CI's Node 22 → 24, cargo-nextest 0.9.100 → 0.9.149, and every GitHub Action the workflows pin brought to its newest release (checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, download-artifact v8.0.2, setup-python v7.0.0, upload-pages-artifact v5.0.0, deploy-pages v5.0.1, install-action v2.87.30), still pinned to full commit ids (the pin check passes). Each action's release notes were read for breaking changes: none applies here (no artifact is downloaded by id, `dist/` has no dotfiles for Pages, the auto-merge checkout is of `main`, the result scripts push from the workspace where checkout v6's separate credential file still applies). Checked under Node 24 with the new tools: all 1,287 unit tests, the journeys (within the baseline), typecheck and the build with its licence check, and the whole Chromium browser suite on Chrome 156. Also fixed, a flaky browser check that CI's Chrome 156 made fail about half the time (8 of 12 runs here, under Node 22 and 24 alike): the centre-arc check at phone width tapped the arc's centre, start and end without waiting between them, and the end's tap landed on the angle box that the centre's tap brings (at 375 px the typed boxes are pinned 200 px in from the right, so they cover the end until the start is placed and only the sweep box is left); it now waits for each tap's boxes before the next tap, 12 of 12 runs pass, and the checks that failed on CI in `extrude.mjs`, `face-sketch.mjs` and `timeline.mjs` (all 375 px taps) look like the same race and are reported for a Design-side pass.

## 0.26.7 (2026-10-22)

- Upkeep: the viewer's 3D library, three.js, goes from r170 to r186 (sixteen releases; the migration guide was read release by release, and nothing the viewport uses was removed or renamed, so no code changed). r181 changed how lit surfaces are shaded, so the pictures the viewer and the guide draw were compared pixel by pixel on both versions (19 pictures: the box from the home, top, front and side views, the plane picker, a sketch being drawn and finished, and every guide chapter): every lit face is at most 5 of 255 darker (2%), evenly across a face, and no pixel changed in any other way, so the browser checks' expected colours and the two golden images stand as they are. Checked by all 321 browser checks in Chromium (Chrome 156, the build CI uses), the app journeys (within the baseline), the licence check in the build and the viewport's unit tests; CI's Firefox and WebKit runs cover those browsers.

## 0.26.6 (2026-10-22)

- Plan (no change to the app): the 3D printing slicer's roadmap, designed with the owner. Slice now starts right after CAD step 33 instead of after step 73, because it slices a mesh made from each body and needs nothing later from the kernel. Its steps are P0 to P14 in `docs/roadmap.md`: a G-code replay checker and a PrusaSlicer comparison come first, then the plate and printer, layers with a preview, walls, infill, supports, G-code for Bambu Lab printers (the owner's P2S) and then Marlin and Klipper, beginner and advanced settings, multi-colour with the AMS, slicing the exact shape so round holes print round, and four steps no slicer fed only an STL can do: holes sized to make up for shrink from the design's intent, per-face settings that survive design edits, printing feedback while designing, and calibration that feeds back into every fit. The decisions and P0's substeps are in the new `docs/progress/slice.md`. The first version only saves a file and never sends a job to a printer.
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
