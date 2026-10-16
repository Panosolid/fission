# Design workspace

Contents of `workspaces/design`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the CAD workspace (`workspace.ts`, which names each undo step: "Change width" merged per size box, "Change shape to …"; a mount by Undo or Redo keeps the camera and compares the selection with `lastBuilt`, the body it last built; `profiles.ts` ready-made outlines until the sketcher).
- `graph.ts`: the timeline in the project graph (`syncGraph`); every change and removal is recorded as a change note with `changeWords` ("you changed the box", "you removed the profile").
- `shortcuts.ts`: Design's keys in the one shortcut table (Escape clears the selection, Ctrl+C copies a selected profile as SVG) and `designShortcut`, what each does for a selection; `workspace.ts` runs them in `shortcut`.
- `actions.ts`: Design's verbs: Download STL for a body, Copy as SVG for a profile (through the representation registry, then core's `outlineToSvg`; also Ctrl+C with one profile selected, through `shortcuts.ts`). `references.ts`: `designReference` for bodies, faces, edges; `profileReference` ("outline:profile-1") for a profile, selectable from the browser's Profiles group (`browser.ts`); `selection.ts` names it and drops it when the part has no profile.
