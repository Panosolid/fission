// The hint by the pointer while sketching: a few words saying what the
// next click places ("Specify next point", "Place point on arc"), the
// tool's step in the panel's longer help (sketch-panel.ts TOOL_HELP)
// put where the eye already is. `hintOf` is the words, a pure function of
// the tool; `pointerHint` the label, which only shows and moves. Styles:
// src/styles/pointer-hint.css.

import type { SketchTool } from "./sketch-tool.ts";

/** What the tool's next click places, in a few words. */
export function hintOf(tool: SketchTool): string {
  switch (tool.kind) {
    case "line":
      return tool.from === null ? "Place start point" : "Specify next point";
    case "rectangle":
      return tool.corner === null ? "Place first corner" : "Place opposite corner";
    case "circle":
      return tool.centre === null ? "Place centre point" : "Place point on circle";
    case "arc":
      return tool.start === null ? "Place start point" : tool.end === null ? "Specify next point" : "Place point on arc";
    case "centre":
      return tool.centre === null ? "Place centre point" : tool.start === null ? "Place start point" : "Place end point";
    case "tangent":
      return tool.from === null ? "Click the free end of a line or arc" : "Specify next point";
  }
}

export interface PointerHint {
  /** Shows `text` by the point (x, y) in the host's pixels; empty text hides it. */
  show(text: string, x: number, y: number): void;
  hide(): void;
  readonly element: HTMLElement;
}

export function pointerHint(host: HTMLElement): PointerHint {
  const el = host.ownerDocument.createElement("div");
  el.className = "pointer-hint";
  el.id = "sketch-hint"; // read by the e2e test
  el.hidden = true;
  el.setAttribute("aria-live", "polite");
  host.append(el);
  const api: PointerHint = {
    element: el,
    show(text, x, y) {
      if (text === "") return api.hide();
      if (el.textContent !== text) el.textContent = text;
      el.hidden = false;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
  return api;
}
