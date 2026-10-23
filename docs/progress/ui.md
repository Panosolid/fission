# UI look and feel

Progress file for one workstream (rules: root CLAUDE.md, "Workstreams and where progress lives"). Only threads working on this workstream edit this file.

Done: nothing yet; the plan was designed with the owner on 2026-10-22 and 2026-10-23.

Next: U1a, from `main`, once CAD step 27 is finished (owner's decision: the UI work runs during the break from roadmap coding after step 27, since it is styling and layout and doesn't clash with the sketch work).

## How to work on this workstream

- One substep is one thread and one PR. Each starts by writing its test plan into its own line here (what is hand-worked, which deliberate break proves each check can fail, which browser screenshots it takes) before its first commit, and ends by writing the next substep's starting point.
- Every visible change is checked in a real browser at 1280 × 720 and 375 × 667 (Chromium locally; Firefox and WebKit in CI), with before and after screenshots in `/mnt/project-files/ui/<substep>/`, no sideways scroll at either width, and the existing e2e checks kept passing (a check that only clicked a moved button is updated to the new place, never weakened).
- Styles go in per-feature files (`packages/ui/src/styles/<feature>.css`, or a workspace's own `src/styles/`), every selector starting with `.<feature>`. `packages/ui/src/theme.css` keeps only the base layout; U1a moves its colours into tokens and is the one substep that edits it, alone.
- PR areas: the shell, packages/ui, settings and home screen are "everything else"; the Design toolbar and sketch toolbar (U3b, U3c, U4a) are the Design area and never run alongside a CAD step's PR there.
- Screenshots of `main` before this work (2026-10-22): `/mnt/project-files/ui-design/`.

## Decisions (owner's, 2026-10-22 and 2026-10-23, unless marked default)

1. **Resemble Fusion 360 but stay our own.** Someone used to Fusion must find everything where they expect it (grouped toolbar along the top, browser on the left, view cube top right, navigation bar bottom centre, timeline bottom left, a floating box for the running command), but the icons, names and colours are ours. Behaviour and layout are copied, never icons or names.
2. **The top bar is the first thing to fix.** The owner's least favourite part: fat text buttons. It becomes groups of shape icons with a small label and ▾ under each group (Create ▾, Modify ▾, Inspect ▾, Insert ▾, Select ▾), each dropdown listing icon, name and shortcut key, like Fusion's.
3. **Icon style: flat two-tone shapes** in our blue with a light or grey face, drawn as our own SVGs; each icon has a small word under it (icon plus word, clearer for beginners and the planned beginner mode), with a tooltip naming its key.
4. **Workspaces: one "DESIGN ▾" button** at the far left replaces the ten tabs; workspaces not built yet are greyed in its list.
5. **The Properties panel folds away by default.** A running tool's settings show in a small floating box near the top right (like Fusion's command dialogs, with OK and Cancel); body facts (volume, area, topology, validation) open from Inspect.
6. **A Settings page:** theme (light, dark, follow the device; following the device is the default), units (mm or inch), mouse controls (a Fusion-style preset first), grid and snap defaults, and the AI provider settings moved in from where they are now.
7. **Phone (375 px): one row of group icons**; each group opens its list as a sheet from the bottom; nothing is cut off and nothing scrolls sideways.
8. **A home screen** like Fusion's. The app opens on it. A big "Carry on with …" card at the top opens the last project in one click. Then New, Open file and Upload STL, a search box, and the projects. Projects live in the browser's own storage (no accounts, no cloud); Open and Save keep working on files. The projects can be filtered by workspace (Design, Slice…); a project shows under every workspace it has work in. Recent projects show as a list; picture tiles with a small render of the part are an option the viewer can switch to (built only if it stays simple, default). The guide and tutorial links sit where Fusion has "Ways to explore", and Community joins them once it exists.

## Earlier UI asks this workstream takes over

- SF3c (sketch palette) and SF3e (grouped sketch toolbar) in `docs/progress/cad.md` become U4a and U3c here; the CAD workstream ticks them as moved when it next edits cad.md.
- Light mode (asked 2026-10-18): U1.
- On sketch start the camera fits the sketch plane exactly from above, and the plane stays highlighted while orbiting (asked 2026-10-18): U7a.
- Escape turns off an active view-bar tool (Pan or Zoom back to Orbit), like Fusion (asked 2026-10-18): U7b.
- Already done, not repeated: the guide fixes (#152).

## Steps and substeps

Each later step is split further by the thread that starts it if a substep turns out too big for one PR.

### U1. Colours as tokens, and light mode
- [ ] U1a. Every colour in `theme.css` and the feature CSS files becomes a named token (`--surface`, `--text`, `--accent`, …) on `:root`, with the dark values unchanged; a source check refuses a raw colour outside the token file. Test: screenshots of every e2e page match the current ones pixel for pixel (a token moved, nothing changed); a deliberate break (one token's value changed) fails the comparison.
- [ ] U1b. The light theme: the light values of every token, picked by `prefers-color-scheme` or the setting U2a adds (`data-theme` on the root). The 3D view (background, grid, axes, face shading, edges, selection) follows the theme. Test: contrast of every text and icon token pair against its background worked out from the WCAG formula (at least 4.5 : 1 for text, 3 : 1 for icons and lines), hand-worked for two pairs with the working shown; light and dark screenshots at both widths; pixel probes that the viewport background and a selected face change colour with the theme.

### U2. Settings page
- [ ] U2a. The page itself (a gear in the app bar, also `?settings`), with Theme (follow device, light, dark), stored in the browser and applied before the first paint so the app never flashes the wrong theme. Test: each choice stored and reapplied after reload; following the device switches live when the device changes (emulated media in Playwright); keyboard focus order; screenshots.
- [ ] U2b. Grid and snap defaults (grid size, snap to grid on or off, used by every new sketch) and the AI provider settings moved in from where they are now (the old place links to the page). Test: a new sketch starts with the stored defaults; refused values (0, negative, empty, outside the kernel's 1 µm to 1 km) keep the last good value with a message, boundaries at 0.9× and 1.1× of the limits.
- [ ] U2c. Units: mm or inch for everything shown and typed (sizes, typed lengths, browser names, properties), stored in mm inside as now. Test: hand-worked conversions (25.4 mm = 1 in; 40 × 30 × 20 mm box shown as 1.575 × 1.181 × 0.787 in), round trips typed in inches give the same body as in mm to within the kernel tolerance; a saved project is identical whichever unit was shown.
- [ ] U2d. Mouse controls: presets (Panosolid's current one, and a Fusion-style one matching the owner's answers in memory), shown as a small table of what each button and key does. Test: each preset's gestures in `e2e/navigation.mjs`.

### U3. The top bar
- [ ] U3a. The icon set: our own flat two-tone SVGs for every command the toolbars show (sketch, extrude, box, cylinder, sphere, the sketch tools, finish sketch, inspect, export, undo, redo, save, open, settings, guide…), in `packages/ui/src/icons/`, each drawn on one grid and readable at 16, 24 and 32 px in both themes. Test: every command in the toolbars has an icon (a missing one fails), every SVG parses and uses only the theme tokens, screenshots of the full sheet at three sizes in both themes.
- [ ] U3b. The app bar and the Design toolbar: a slim app bar (file menu with New, Open, Save and Export; undo and redo; the "DESIGN ▾" workspace button; guide, settings and AI at the right) and the grouped Design toolbar (Create ▾: Sketch, Extrude, then the primitives; Modify ▾ empty groups hidden until they have commands; Inspect ▾; Insert ▾; Select ▾), each dropdown listing icon, name and key. Test: every command reachable from the new bar runs the same function as before (each existing e2e check reaches it there), dropdowns open with click, keyboard and tap and close with Escape or a click outside; a message never moves a button under a click (the SF3 regression check kept); screenshots.
- [ ] U3c. The sketch toolbar in the same style (SF3e): Create ▾ with the sketch tools, Modify ▾ and Constraints ▾ as they arrive, Inspect ▾, and the big green Finish Sketch at the right; the sketch panel's repeated Finish Sketch and Extrude buttons go. Test: as U3b for every sketch tool, plus the sketch e2e suite unchanged in what it checks.

### U4. Panels
- [ ] U4a. The floating command box (SF3c): the running tool's settings (sketch grid and snap, extrude distance and direction, edit feature) in a small box near the top right with OK and Cancel, Enter and Escape doing the same; it never covers the view cube and folds to its title. Test: each tool's settings work from the box; OK, Cancel, Enter, Escape; at 375 px it becomes a bottom sheet; screenshots.
- [ ] U4b. The right panel folds away by default; Inspect ▾ opens the body facts (volume, area, topology, validation) and the selection info; the browser tree loses its boxed chips for plain rows with an eye to show or hide, like Fusion's. Test: the facts match the old panel's (hand-worked 24,000 mm³ box), the eye hides and shows a body (pixel probe), folding remembered after reload.

### U5. Phone
- [ ] U5a. At 375 px: one row of group icons; each group opens its list as a sheet from the bottom; the browser and inspect panels also open as sheets; the workspace button and app bar fit without cutting anything off. Test: no element wider than the screen and no sideways scroll at 320, 375 and 414 px; every command reachable by taps alone (the e2e tap suite); screenshots.

### U6. Home screen
- [ ] U6a. The project list in browser storage (`packages/storage`): each project's name, last opened time, which workspaces have work in it, kept beside the existing autosave; opening, renaming and deleting (delete asks first). Test: against a simple model, seeded random opens, saves, renames and deletes (5 seeds × 1,000 steps); a project's workspace list worked by hand from its contents; storage full or refused shows a message and loses nothing.
- [ ] U6b. The home screen: the app opens on it; the "Carry on with …" card; New, Open file, Upload STL; search by name; the list with its workspace filter; guide and tutorial links. Test: search and filter against hand-worked lists; the card opens the last project with its camera and timeline marker as they were; keyboard and tap; screenshots at both widths in both themes.
- [ ] U6c. Picture tiles as an option: a small render saved with each project when it is saved, shown in tile view. Test: the tile's render matches the part (pixel probe of the body colour in the middle), a project with no body shows a blank tile, the view choice remembered.

### U7. Leftovers from earlier asks
- [ ] U7a. On sketch start the camera fits the sketch plane or face exactly from above, and the plane stays clearly highlighted while orbiting. Test: hand-worked framing of the 40 × 30 top face; pixel probes of the highlight from an orbited view.
- [ ] U7b. Escape turns off an active view-bar tool (Pan or Zoom back to Orbit), ordered against Design's Escape in the shortcut table. Test: in `e2e/navigation.mjs` and `e2e/shortcuts.mjs`.

### U8. Bug hunt
- [ ] U8a. An aggressive hunt over the whole new UI: Firefox and WebKit at 1280 and 375 px, every dropdown and sheet by mouse, keyboard and tap, both themes, both units, the home screen with many projects and with storage refused, monkey sessions with fresh seeds, and adversarial reading of the new code. Every bug found gets a regression test before its fix.
