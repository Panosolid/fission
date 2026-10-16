# UI kit

Contents of `packages/ui`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- shared UI kit: number formatting, theme (`theme.css`: the base layout, including split view; each feature's own styles are `src/styles/<feature>.css`, every selector starting with `.<feature>`, loaded by the app without a list), workspace switcher, split choices (`split.ts`), the link badge, the downstream chip (`downstream-chip.ts`) and the change note (`change-note.ts`), placeholder page.
