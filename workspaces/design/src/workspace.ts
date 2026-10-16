// The Design workspace: the CAD, and the source of truth for all geometry.
// Until the sketcher (steps 21–31) it builds primitives and ready-made
// outlines; every other workspace will refer to its bodies, faces and edges.

import { latestOnly, NO_HIGHLIGHT, type BodyView, type Command, type Framing, type GeometryReference, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";
import { needsRefit } from "@fission/viewport";
import { lastFeature, readDesignDocument, specOf, type DesignDocument } from "./document.ts";
import { PART_VIEW, syncGraph } from "./graph.ts";
import { registerDesign } from "./representations.ts";
import { DESIGN_COMMANDS, documentFor } from "./commands.ts";
import type { ShapeKind } from "./profiles.ts";
import { buildSpec } from "./spec.ts";
import { toolbarGroups, type ToolButton } from "./toolbar.ts";
import { browserTree, type BrowserNode } from "./browser.ts";
import { propertiesPanel, SIZE_KEYS } from "./properties.ts";
import { pickChange } from "./picking.ts";
import { designReference } from "./references.ts";
import { highlightOf, selectionRows } from "./selection.ts";

/** Hands `bytes` to the browser as a file download. */
function download(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What the user last entered, kept while other workspaces are shown. */
let saved: { shape: ShapeKind; sizes: string[] } | null = null;
let framed: Framing | null = null;
let framedKind: ShapeKind | null = null;

/** Fills the toolbar slot with the command groups; returns each button with its element. */
function toolbar(slot: HTMLElement, onClick: (b: ToolButton) => void): [ToolButton, HTMLButtonElement][] {
  const made: [ToolButton, HTMLButtonElement][] = [];
  const document = slot.ownerDocument; // the slot's own page, not a global one
  for (const group of toolbarGroups()) {
    const div = document.createElement("div");
    div.className = "tool-group";
    div.setAttribute("role", "group");
    div.setAttribute("aria-label", group.name);
    const name = document.createElement("span");
    name.className = "tool-group-name";
    name.textContent = group.name;
    div.append(name);
    for (const b of group.buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = b.label;
      el.title = b.title;
      el.dataset.op = b.command.op; // read by the e2e test
      if (typeof b.command.shape === "string") el.dataset.shape = b.command.shape;
      el.addEventListener("click", () => onClick(b));
      div.append(el);
      made.push([b, el]);
    }
    slot.append(div);
  }
  return made;
}

/** Browser groups the user folded, kept across rebuilds and workspace switches. */
const folded = new Set<string>();

/** The browser rows that stand for selectable geometry, and the reference each selects. */
function rowReference(node: string, doc: DesignDocument): GeometryReference | null {
  return node === "body-1" ? designReference("body", lastFeature(doc).id) : null;
}

/** Lights the browser rows whose geometry is selected (aria-current), and only those. */
function lightRows(slot: HTMLElement, doc: DesignDocument, items: readonly GeometryReference[]) {
  for (const row of slot.querySelectorAll<HTMLElement>(".tree-row")) {
    const ref = rowReference(row.dataset.node!, doc);
    if (ref && items.some((i) => i.kind === ref.kind && i.id === ref.id)) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

/**
 * Fills the browser slot with the document's tree: groups fold (native
 * details/summary). A row for selectable geometry (Body 1) is a button
 * that selects it (Shift adds or takes out); the others are plain rows
 * until features (step 32) and origin planes (step 21) can be selected.
 * Rebuilt on every edit; folding is kept by id.
 */
function browser(slot: HTMLElement, doc: DesignDocument, onSelect: (ref: GeometryReference, shift: boolean) => void) {
  const document = slot.ownerDocument;
  // The toggle event fires a task after the click, so a rebuild can come
  // first: read the folding from the tree being replaced, not only events.
  for (const d of slot.querySelectorAll<HTMLDetailsElement>("details[data-node]")) {
    if (d.open) folded.delete(d.dataset.node!);
    else folded.add(d.dataset.node!);
  }
  const list = (nodes: BrowserNode[]) => {
    const ul = document.createElement("ul");
    ul.className = "tree";
    for (const n of nodes) {
      const li = document.createElement("li");
      if (n.children) {
        const details = document.createElement("details");
        details.open = !folded.has(n.id);
        details.dataset.node = n.id; // read by the e2e test
        details.addEventListener("toggle", () => {
          if (details.isConnected) details.open ? folded.delete(n.id) : folded.add(n.id);
        });
        const summary = document.createElement("summary");
        summary.textContent = n.label;
        details.append(summary, list(n.children));
        li.append(details);
      } else {
        const ref = rowReference(n.id, doc);
        const row = document.createElement(ref ? "button" : "span");
        if (ref) row.setAttribute("type", "button");
        row.className = "tree-row";
        row.textContent = n.label;
        row.dataset.node = n.id;
        if (ref) row.addEventListener("click", (e) => onSelect(ref, (e as MouseEvent).shiftKey));
        li.append(row);
      }
      ul.append(li);
    }
    return ul;
  };
  slot.replaceChildren(list(browserTree(doc)));
}

function mount(ctx: WorkspaceContext): () => void {
  const panel = propertiesPanel(ctx.properties);
  const { inputs } = panel;
  let shape: ShapeKind = saved?.shape ?? "box";
  if (saved) inputs.forEach((input, i) => (input.value = saved!.sizes[i]));
  const buttons = toolbar(ctx.toolbar, (b) => run(b.command));
  const { kernel, viewport } = ctx;
  let shown = true;
  /** The last body that built, for the selection's surface and curve types. */
  let lastView: BodyView | null = null;

  /** The browser's Body 1 row: a click selects the body, Shift adds or takes it out. */
  function selectRow(ref: GeometryReference, shift: boolean) {
    if (shift) ctx.selection.toggle(ref);
    else ctx.selection.set([ref]);
  }

  /** Draws the selection: the viewport's colours, the lit browser rows, the properties' rows. */
  function showSelection() {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    const featureId = lastFeature(doc).id;
    const items = ctx.selection.items;
    viewport.showSelection(highlightOf(items, featureId));
    lightRows(ctx.browser, doc, items);
    panel.showSelection(selectionRows(items, featureId, lastView));
  }

  // The body is built from the part's feature intent (document.ts).
  const build = latestOnly((doc: DesignDocument) => buildSpec(kernel, specOf(doc, lastFeature(doc))));

  /** Never shows stale numbers unmarked: dims them while out of date, and says so if the rebuild failed. */
  function markStale(failed = false) {
    panel.markStale(ctx.graph.isStale(PART_VIEW), failed);
  }

  /** The STL-precision overlay: the whole part, while its last export warned. */
  const STL_OVERLAY = "design.stl-precision";

  /** The command the toolbar and the inputs stand for: set_part with this shape and these sizes. */
  function partCommand(): Command {
    const [width, depth, height] = inputs.map((i) => Number(i.value));
    return { op: "set_part", shape, width, depth, height };
  }

  /**
   * Does what a Design command says: the toolbar's buttons come here, and
   * the AI's accepted commands will too. A set_part from the toolbar names
   * only the shape and keeps the sizes; the kernel judges the sizes (a bad
   * one shows its message, as when typed).
   */
  function run(command: Command) {
    if (command.op === "export_stl") return exportStl();
    if (command.op !== "set_part") throw new Error(`Design has no command ${command.op}`);
    shape = command.shape as ShapeKind;
    for (const [i, key] of SIZE_KEYS.entries()) if (typeof command[key] === "number") inputs[i].value = String(command[key]);
    return update();
  }

  async function update() {
    const kind = shape;
    saved = { shape, sizes: inputs.map((i) => i.value) };
    for (const [b, el] of buttons) if (b.command.op === "set_part") el.setAttribute("aria-pressed", String(b.command.shape === kind));
    viewport.clearOverlay(STL_OVERLAY); // it described the part before this edit
    panel.setShape(kind);
    // The panel edits feature #1 of the one-step timeline; the project holds it.
    const doc = documentFor(partCommand());
    syncGraph(ctx.graph, doc, (ctx.project.workspaces.design as DesignDocument | undefined) ?? null);
    ctx.project.workspaces.design = doc;
    browser(ctx.browser, doc, selectRow);
    showSelection();
    markStale();
    const feature = lastFeature(doc);
    panel.showFeature(feature);
    try {
      const { current, value: view } = await build(doc);
      if (!current || !shown) return;
      // Built from the current inputs: the feature and the numbers are fresh.
      for (const f of doc.timeline.features) ctx.graph.markFresh(f.id);
      ctx.graph.markFresh(PART_VIEW);
      markStale();
      viewport.showBody(view.mesh);
      // A different shape is a new part: frame it.
      if (kind !== framedKind || needsRefit(framed, viewport.bodyFraming())) {
        framed = viewport.fit();
        framedKind = kind;
        viewport.element.dataset.framedRadius = String(framed?.radius); // read by the e2e test
      }
      panel.showBody(view);
      lastView = view;
      showSelection();
      viewport.element.dataset.shape = kind; // read by the e2e test: what is on screen
    } catch (e) {
      if (!shown) return;
      panel.showError(e instanceof Error ? e.message : String(e));
      markStale(true);
    }
  }

  async function exportStl() {
    const kind = shape;
    try {
      const doc = documentFor(partCommand());
      const file = await kernel.call("export_stl", specOf(doc, lastFeature(doc)), kind);
      download(file.bytes, `fission-${kind}.stl`);
      panel.showStlNote(file.warning ?? "", Boolean(file.warning));
      // Mark the part on screen too: every face moves in single precision.
      if (file.warning)
        viewport.setOverlay({ id: STL_OVERLAY, label: "Too big for an accurate STL", detail: file.warning, marks: [{ target: { body: true }, severity: "warning" }] });
      else viewport.clearOverlay(STL_OVERLAY);
    } catch (e) {
      panel.showStlNote(e instanceof Error ? e.message : String(e), true);
    }
  }

  // Picking (17b): a click on a face selects it, Shift adds, empty space or Escape clears.
  viewport.onPick = (pick) => {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    const c = pickChange(pick, lastFeature(doc).id);
    if (c.change === "set") ctx.selection.set([c.item]);
    else if (c.change === "toggle") ctx.selection.toggle(c.item);
    else if (c.change === "clear") ctx.selection.clear();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") ctx.selection.clear();
  };
  const keys = viewport.element.ownerDocument;
  keys.addEventListener("keydown", onKey);
  const stopWatching = ctx.selection.onChange(showSelection);

  inputs.forEach((i) => i.addEventListener("input", update));
  update();
  return () => {
    shown = false;
    viewport.onPick = null;
    viewport.showSelection(NO_HIGHLIGHT);
    stopWatching();
    keys.removeEventListener("keydown", onKey);
    for (const slot of [ctx.toolbar, ctx.browser, ctx.properties]) slot.replaceChildren();
  };
}

export const designWorkspace: WorkspacePlugin = {
  id: "design",
  title: "Design",
  summary: "Parametric modelling: sketches, features and the timeline. The source of truth for all geometry.",
  status: "working",
  representations: { produces: ["solid", "mesh", "outline"], accepts: [] },
  registerRepresentations: registerDesign,
  readData: readDesignDocument,
  commands: DESIGN_COMMANDS,
  mount,
};
