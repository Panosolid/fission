# Viewport

Contents of `packages/viewport`; the rules are in packages/CLAUDE.md and the root CLAUDE.md. Keep this list current when you add or change a file here.

- the one Three.js viewport every workspace draws into (`Viewer`, implements `SharedViewport`: one scene seen through one or more `ViewportView`s, each its own camera, for split view; `paneViewports` gives each workspace on screen a `SharedViewport` over its own view) and the camera re-framing rule.
