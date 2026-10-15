// DRAFT: will change as the real workspaces are built.
//
// The one 3D viewport every workspace draws into (@fission/viewport
// implements it). Switching workspaces keeps it, so the camera stays put.

import type { DisplayMesh } from "../kernel/kernel-types.ts";

/** A sphere around a body: what the camera frames. */
export interface Framing {
  centre: [number, number, number];
  radius: number;
}

export interface SharedViewport {
  /** The element the viewport fills. */
  readonly element: HTMLElement;
  showBody(mesh: DisplayMesh): void;
  /** Sphere around the current body (radius 0 if none). */
  bodyFraming(): Framing;
  /** Frames the current body; returns what it framed (null if none). */
  fit(): Framing | null;
}
