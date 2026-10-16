# Image workspace

Contents of `workspaces/image`; the rules are in packages/CLAUDE.md and the root CLAUDE.md, progress in `docs/progress/image.md`. Keep this list current when you add or change a file here.

- the Image workspace, its base (G1, done): `physical-size.ts` file headers, `limits.ts`, `document.ts`, `adjust.ts` (G1a; Pillow oracle fixtures in `test/fixtures/`, a seeded fuzz in `test/fuzz.test.ts`); `open.ts`, `panels.ts` and the page `workspace.ts` (G1b; Brightness slider and layer Hide, G1c; phone width and focus checked, G1d), which shows the image through the viewport's `showImage`.
- `representations.ts` (G2a): each layer handed to other workspaces as an Image through the registry (`image.layer` producer, live `imageObjects` handles, `checkImageRep`), and the PNG/JPEG importer.
