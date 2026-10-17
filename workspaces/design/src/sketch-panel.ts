// The sketch tool's panel (step 21c), at the top of the properties: the
// "Pick a plane" prompt of Create sketch, then while a sketch is edited its
// name, the tools (Line, Rectangle: step 22a; Circle: 22c; Arc: 23b; Tangent arc: 23c), how to draw, the typeable grid size and Snap to grid (SF1, off by default), whether the lines close,
// Finish sketch and Extrude (step 21d). The workspace drives it; the panel
// only shows what it is given and reports clicks. Styles: src/styles/sketch.css.

import { ORIGIN_PLANES, SKETCH_TOOLS, type ToolKind } from "./sketch-tool.ts";
import type { SketchPlane } from "./document.ts";

export interface SketchPanelEvents {
  pickPlane(id: SketchPlane): void;
  cancel(): void;
  grid(typed: string): void;
  /** Snap to grid ticked (true) or unticked. */
  gridSnap(on: boolean): void;
  finish(): void;
  /** Extrude this sketch (step 21d): finishes it and opens the Extrude panel. */
  extrude(): void;
  /** A tool chosen. */
  tool(kind: ToolKind): void;
}

/** Where clicks land, under every tool's help (sketch feel SF1). */
export const SNAP_HELP = "Points go where you click, and snap to nearby ends, midpoints and centres, or line up with them.";

/** How to draw with each tool, under the tool buttons. */
export const TOOL_HELP: Record<ToolKind, string> = {
  line: "Click to place points: each click draws a line from the last one. Click the first point to close the shape. Escape ends the line.",
  rectangle: "Click one corner, then the opposite corner: four lines. Escape drops the first corner.",
  circle: "Click the centre, then a point on the circle. Escape drops the centre.",
  arc: "Click the start, then the end, then a point the arc passes through. Escape drops the ends.",
  tangent: "Click the end of a line or arc, then where the arc ends: it leaves the line smoothly, and the next click carries on from its end. Escape ends it.",
};

export interface SketchPanel {
  /** The prompt: the offered planes as buttons too (the view's planes are the same choice), and Cancel. */
  showPick(): void;
  /** The sketch being edited, its grid as typed, whether points snap to it, the tool in use. */
  showEditing(name: string, grid: string, gridSnap: boolean, tool: ToolKind): void;
  /** The tool in use: its button pressed, its help shown. */
  showTool(kind: ToolKind): void;
  /** What the sketch holds and whether it makes a closed outline, or why not. */
  showStatus(text: string): void;
  /** A message under the grid size: a grid the kernel refused, or a point it could not place. Empty hides it. */
  showError(message: string): void;
  hide(): void;
}

export function sketchPanel(slot: HTMLElement, on: SketchPanelEvents): SketchPanel {
  const document = slot.ownerDocument;
  const box = document.createElement("section");
  box.className = "sketch";
  box.id = "sketch-panel"; // read by the e2e test
  box.setAttribute("aria-label", "Sketch");
  box.hidden = true;
  slot.prepend(box);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: { id?: string; className?: string; textContent?: string } = {}): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (props.id) e.id = props.id;
    if (props.className) e.className = props.className;
    if (props.textContent) e.textContent = props.textContent;
    return e;
  };
  const button = (text: string, id: string, click: () => void, extra = "") => {
    const b = el("button", { textContent: text, id });
    b.type = "button";
    if (extra) b.className = extra;
    b.addEventListener("click", click);
    return b;
  };
  let status: HTMLElement | null = null;
  let gridError: HTMLElement | null = null;
  let tools: { kind: ToolKind; button: HTMLButtonElement }[] = [];
  let help: HTMLElement | null = null;
  const showTool = (kind: ToolKind) => {
    for (const t of tools) t.button.setAttribute("aria-pressed", String(t.kind === kind));
    if (help) help.textContent = TOOL_HELP[kind];
  };
  return {
    showPick() {
      const planes = el("div", { className: "sketch-planes" });
      planes.setAttribute("role", "group");
      planes.setAttribute("aria-label", "Planes");
      for (const p of ORIGIN_PLANES) {
        const b = button(p.label, `sketch-plane-${p.id}`, () => on.pickPlane(p.id));
        b.disabled = !p.offered;
        if (!p.offered) b.title = "Sketching on the front and side planes, and on flat faces, comes with step 26.";
        planes.append(b);
      }
      box.replaceChildren(
        el("h2", { textContent: "Create sketch" }),
        el("p", { className: "sketch-prompt", id: "sketch-prompt", textContent: "Pick a plane: click the ground plane in the view, or choose it here." }),
        planes,
        button("Cancel", "sketch-cancel", () => on.cancel()),
      );
      status = gridError = help = null;
      tools = [];
      box.hidden = false;
    },
    showTool,
    showEditing(name, grid, gridSnap, tool) {
      const input = el("input", { id: "sketch-grid" });
      Object.assign(input, { type: "number", step: "any", min: "0", value: grid });
      input.addEventListener("change", () => on.grid(input.value));
      const label = el("label", { className: "sketch-grid" });
      label.append("Grid ", input, " mm");
      const snapBox = el("input", { id: "sketch-grid-snap" });
      Object.assign(snapBox, { type: "checkbox", checked: gridSnap });
      snapBox.addEventListener("change", () => on.gridSnap(snapBox.checked));
      const snapLabel = el("label", { className: "sketch-grid-snap" });
      snapLabel.append(snapBox, " Snap to grid");
      status = el("p", { id: "sketch-status", className: "sketch-status" });
      gridError = el("p", { id: "sketch-grid-error", className: "bad" });
      gridError.hidden = true;
      const toolRow = el("div", { className: "sketch-tools" });
      toolRow.setAttribute("role", "group");
      toolRow.setAttribute("aria-label", "Tools");
      tools = SKETCH_TOOLS.map((t) => {
        const b = button(t.label, `sketch-tool-${t.kind}`, () => on.tool(t.kind));
        b.title = `${t.label} (${t.key})`;
        b.setAttribute("aria-keyshortcuts", t.key);
        toolRow.append(b);
        return { kind: t.kind, button: b };
      });
      help = el("p", { className: "sketch-help", id: "sketch-help" });
      showTool(tool);
      box.replaceChildren(
        el("h2", { id: "sketch-name", textContent: name }),
        toolRow,
        help,
        el("p", { className: "sketch-help", id: "sketch-snap-help", textContent: SNAP_HELP }),
        label,
        snapLabel,
        gridError,
        status,
        el("div", { className: "sketch-buttons" }),
      );
      box.lastElementChild!.append(button("Finish sketch", "sketch-finish", () => on.finish(), "sketch-finish"), button("Extrude", "sketch-extrude", () => on.extrude(), "sketch-finish"));
      box.hidden = false;
    },
    showStatus(text) {
      if (status) status.textContent = text;
    },
    showError(message) {
      if (!gridError) return;
      gridError.textContent = message;
      gridError.hidden = message === "";
    },
    hide() {
      box.hidden = true;
      box.replaceChildren();
      status = gridError = help = null;
      tools = [];
    },
  };
}
