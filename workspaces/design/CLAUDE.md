# Design workspace

Contents of `workspaces/design`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the CAD workspace (`workspace.ts`; `profiles.ts` ready-made outlines until the sketcher).
- `graph.ts`: the timeline in the project graph (`syncGraph`); every change and removal is recorded as a change note with `changeWords` ("you changed the box", "you removed the profile").
