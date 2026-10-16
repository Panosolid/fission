// The Design workspace: the CAD, and the source of truth for all geometry.
// Until the sketcher (steps 21–31) it builds primitives and ready-made
// outlines; every other workspace will refer to its bodies, faces and edges.

import { latestOnly, NO_HIGHLIGHT, type BodyView, type Command, type Framing, type GeometryReference, type MountedWorkspace, type Selected, type SharedViewport, type WorkspaceContext, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { needsRefit } from "@fission/viewport";
import { lastFeature, partOf, readDesignDocument, specOf, type DesignDocument } from "./document.ts";
import { PART_VIEW, syncGraph } from "./graph.ts";
import { registerDesign } from "./representations.ts";
import { DESIGN_COMMANDS, documentFor } from "./commands.ts";
import type { ShapeKind } from "./profiles.ts";
import { buildSpec } from "./spec.ts";
import { SHAPE_LABELS, toolbarGroups, type ToolButton } from "./toolbar.ts";
import { browserTree, type BrowserNode } from "./browser.ts";
import { propertiesPanel, SIZE_KEYS } from "./properties.ts";
import { pickChange } from "./picking.ts";
import { DESIGN_SHORTCUTS, designShortcut } from "./shortcuts.ts";
import { designReference, profileReference } from "./references.ts";
import { droppedNote, highlightOf, selectionRows, survivors } from "./selection.ts";
import { COPY_SVG, DOWNLOAD_STL, partBody, registerDesignActions, STL_OVERLAY, targetsOf } from "./actions.ts";

/**
 * What the user last entered (as typed), kept while other workspaces are
 * shown, with the document it made: when the project holds a different
 * document (a file was opened), the panel shows that one instead.
 */
let saved: { doc: DesignDocument; shape: ShapeKind; sizes: string[] } | null = null;
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
  if (node === "body-1") return designReference("body", lastFeature(doc).id);
  return doc.profiles.some((p) => p.id === node) ? profileReference(node) : null;
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
 * details/summary). A row for selectable geometry (Body 1, a profile) is a button
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

function mount(ctx: WorkspaceContext): MountedWorkspace {
  const panel = propertiesPanel(ctx.properties);
  const { inputs } = panel;
  let shape: ShapeKind = "box";
  const held = ctx.project.workspaces.design as DesignDocument | undefined;
  /** A document the project holds that this panel did not make (an opened file): shown as it is, and framed. */
  let loaded: DesignDocument | undefined;
  if (saved && held === saved.doc) {
    shape = saved.shape;
    inputs.forEach((input, i) => (input.value = saved!.sizes[i]));
  } else if (held) {
    const part = partOf(held); // readDesignDocument checked it when the file was opened
    shape = part.shape;
    for (const [i, key] of SIZE_KEYS.entries()) if (part.sizes[key] !== undefined) inputs[i].value = String(part.sizes[key]);
    loaded = held;
    framedKind = null;
  }
  const buttons = toolbar(ctx.toolbar, (b) => run(b.command));
  const { kernel, viewport } = ctx;
  /** On screen (awake); false while asleep (X7) and after unmount. */
  let shown = true;
  /** A build finished while asleep and was not drawn: wake builds again. */
  let missed = false;
  /** The last body that built, for the selection's surface and curve types. */
  let lastView: BodyView | null = null;
  /** The note about items the last rebuild dropped, and whether that drop is being applied now. */
  let note = "";
  let settling = false;

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
    panel.showSelection(selectionRows(items, featureId, lastView, doc.profiles));
    // Verbs, not apps: whatever the registry offers for this selection, from any workspace.
    const verbs = ctx.actions.actionsFor(targetsOf(items, doc));
    panel.showActions(verbs, (id) => runAction(id, ctx.selection.items));
  }

  /** Runs a registered verb on these targets and shows what it said. */
  async function runAction(id: string, targets: readonly Selected[]) {
    const action = ctx.actions.get(id);
    if (!action) return panel.showActionNote(`No action ${id} is registered.`, true);
    const outcome = await action.run(targets, ctx);
    if (shown) panel.showActionNote(outcome.message, outcome.bad);
  }

  // The body is built from the part's feature intent (document.ts).
  const build = latestOnly((doc: DesignDocument) => buildSpec(kernel, specOf(doc, lastFeature(doc))));

  /** Never shows stale numbers unmarked: dims them while out of date, and says so if the rebuild failed. */
  function markStale(failed = false) {
    panel.markStale(ctx.graph.isStale(PART_VIEW), failed);
    showDownstream();
  }

  /**
   * The chips for what other workspaces make from the design, their state
   * read from the graph now: drawn after every change Design makes to the
   * graph (markStale runs after each), so none shows a state it has lost.
   */
  function showDownstream() {
    const chips = ctx.downstream.summaries("design", ctx.graph).map((s) => ({ ...s, targetName: ctx.workspaceTitle(s.target) }));
    panel.showDownstream(chips, (target) => ctx.openWorkspace(target as WorkspaceId));
  }

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
    // The whole part's STL: the same verb a selected body offers, from the registry.
    if (command.op === "export_stl") {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      return runAction(DOWNLOAD_STL, doc ? [partBody(doc)] : []);
    }
    if (command.op !== "set_part") throw new Error(`Design has no command ${command.op}`);
    shape = command.shape as ShapeKind;
    for (const [i, key] of SIZE_KEYS.entries()) if (typeof command[key] === "number") inputs[i].value = String(command[key]);
    return update(`Change shape to ${SHAPE_LABELS[shape] ?? shape}`);
  }

  /** Builds the part from the panel; `label` and `mergeKey` name the undo step when this is a user's edit (none while mounting). */
  async function update(label?: string, mergeKey?: string) {
    const kind = shape;
    for (const [b, el] of buttons) if (b.command.op === "set_part") el.setAttribute("aria-pressed", String(b.command.shape === kind));
    viewport.clearOverlay(STL_OVERLAY); // it described the part before this edit
    panel.setShape(kind);
    // The panel edits feature #1 of the one-step timeline; the project holds
    // it. An opened file's document is kept as it is until the first edit.
    const doc = loaded ?? documentFor(partCommand());
    // An opened document is all new to the graph: out of date until it builds.
    const before = loaded ? null : ((ctx.project.workspaces.design as DesignDocument | undefined) ?? null);
    loaded = undefined;
    saved = { doc, shape, sizes: inputs.map((i) => i.value) };
    syncGraph(ctx.graph, doc, before, ctx.changeNotes);
    const changed = ctx.project.workspaces.design !== doc;
    ctx.project.workspaces.design = doc;
    if (changed) ctx.projectChanged(label, mergeKey); // the shell autosaves (19c) and records the undo step (20b)
    browser(ctx.browser, doc, selectRow);
    showSelection();
    markStale();
    const feature = lastFeature(doc);
    panel.showFeature(feature);
    try {
      const { current, value: view } = await build(doc);
      if (!current) return;
      if (!shown) return void (missed = true);
      missed = false;
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
      // Faces and edges the edit renumbered leave the selection, with a note (17e).
      const { kept, dropped } = survivors(ctx.selection.items, feature.id, lastView, view, doc.profiles.map((p) => p.id));
      lastView = view;
      note = droppedNote(dropped);
      if (dropped.length > 0) {
        settling = true;
        ctx.selection.set(kept);
        settling = false;
      }
      panel.showSelectionNote(note);
      showSelection();
      viewport.element.dataset.shape = kind; // read by the e2e test: what is on screen
    } catch (e) {
      if (!shown) return void (missed = true);
      missed = false;
      panel.showError(e instanceof Error ? e.message : String(e));
      markStale(true);
    }
  }

  // Picking (17b): a click on a face selects it, Shift adds, empty space or Escape clears.
  const onPick: SharedViewport["onPick"] = (pick) => {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    const c = pickChange(pick, lastFeature(doc).id);
    if (c.change === "set") ctx.selection.set([c.item]);
    else if (c.change === "toggle") ctx.selection.toggle(c.item);
    else if (c.change === "clear") ctx.selection.clear();
  };
  let stopWatching = () => {};
  /** Listens to picks and the selection: from mount, and again on each wake. Keys come from the shell (X7b), only while shown. */
  function listen() {
    viewport.onPick = onPick;
    stopWatching = ctx.selection.onChange(() => {
      // The user's next change of selection retires the note about dropped items.
      if (!settling && note) panel.showSelectionNote((note = ""));
      showSelection();
    });
  }
  function sleep() {
    if (!shown) return;
    shown = false;
    viewport.onPick = null;
    viewport.showSelection(NO_HIGHLIGHT);
    stopWatching();
  }

  // Typing in one box is one undo step (the merge key), named for the box.
  inputs.forEach((input, i) => input.addEventListener("input", () => update(`Change ${SIZE_KEYS[i]}`, SIZE_KEYS[i])));
  listen();
  update();
  return {
    sleep,
    // Escape clears the selection; Copy with one profile selected runs Copy as SVG (shortcuts.ts).
    shortcut(id) {
      if (!shown) return false; // the shell only asks while shown; never act asleep
      const items = ctx.selection.items;
      const what = designShortcut(id, items);
      if (what === "clear") ctx.selection.clear();
      else if (what === "copy") void runAction(COPY_SVG, items);
      return what !== null;
    },
    wake() {
      if (shown) return;
      shown = true;
      listen();
      // A build that finished while asleep was not drawn: build again. Otherwise
      // the body is still in the viewport; redraw what others may have changed.
      if (missed) return void update();
      showSelection();
      markStale();
    },
    unmount() {
      sleep();
      for (const slot of [ctx.toolbar, ctx.browser, ctx.properties]) slot.replaceChildren();
    },
  };
}

export const designWorkspace: WorkspacePlugin = {
  id: "design",
  title: "Design",
  summary: "Parametric modelling: sketches, features and the timeline. The source of truth for all geometry.",
  status: "working",
  representations: { produces: ["solid", "mesh", "outline"], accepts: [] },
  registerRepresentations: registerDesign,
  registerActions: (registry) => registerDesignActions(registry),
  readData: readDesignDocument,
  commands: DESIGN_COMMANDS,
  shortcuts: DESIGN_SHORTCUTS,
  mount,
};
