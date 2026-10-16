# Viewport

Contents of `packages/viewport`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`: one scene seen through one or more `ViewportView`s, each its own camera, for split view; `paneViewports` gives each workspace on screen a `SharedViewport` over its own view), the camera re-framing rule, and the image sheet with its top-down 2D mode (`image-sheet.ts`, G1b; each view shows its own image on a layer only its camera sees).
