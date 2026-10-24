// The Design workspace: the CAD, and the source of truth for all geometry.
// Until the sketcher (steps 21–33) it builds primitives and ready-made
// outlines; every other workspace will refer to its bodies, faces and edges.

import { latestOnly, NO_HIGHLIGHT, type SketchPointer, type SketchXY, type Command, type Framing, type Plane, type GeometryReference, type MountedWorkspace, type Selected, type SharedViewport, type WorkspaceContext, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { needsRefit } from "@fission/viewport";
import type { ShapeKind } from "./profiles.ts";
import { insertAt, isSketchItem, partFeature, partOf, readDesignDocument, type DesignDocument, type PartKind } from "./document.ts";
import { DEFAULT_DISTANCE, DISTANCE_STEP, extrudeSketch, NO_USABLE_SKETCH, extrudeStep, featureSpec, setExtrudeDistance } from "./extrude.ts";
import { extrudePanel } from "./extrude-panel.ts";
import { CHANGED_WHILE_CHECKING, editableFeature, editFeature, editStep, readTyped, refusedSizes } from "./feature-edit.ts";
import { featureEditPanel } from "./feature-edit-panel.ts";
import { PART_VIEW, syncGraph } from "./graph.ts";
import { registerDesign } from "./representations.ts";
import { DESIGN_COMMANDS, documentFor } from "./commands.ts";
import { buildSpec } from "./spec.ts";
import { SHAPE_LABELS, toolbarGroups, type ToolButton } from "./toolbar.ts";
import { menuButton, type MenuButton } from "@fission/ui";
import { INSERT_SIZES, INSERT_TITLE, inserted, insertSections, insertStep } from "./insert.ts";
import { startHint } from "./start-hint.ts";
import { browserTree, rowItem, rowReferences, type BrowserNode } from "./browser.ts";
import { callOffDrag, showTimelineBar, timelineBarItems } from "./timeline-bar.ts";
import { DEFAULT_SIZES, parameterRows, propertiesPanel, SIZE_KEYS, type SizeKey } from "./properties.ts";
import { FOLDED_AT_START, propertiesFold, readPinned, type FoldState, type PropertiesFold } from "./properties-fold.ts";
import { freshDesign, START_FRESH_STEP, startFresh } from "./start-fresh.ts";
import { deleteAsk } from "./delete-ask.ts";
import { itemName } from "./timeline-edits.ts";
import { chooseBarAction, chooseEntry, menuEntries, openAction, type MenuHost } from "./timeline-menu.ts";
import { pickChange } from "./picking.ts";
import { DESIGN_SHORTCUTS, designShortcut, sketchToolKey, typedSizeKey } from "./shortcuts.ts";
import { BodyCache, followedDoc, rebuildTimeline, settleKept, type TimelineBuild } from "./rebuild.ts";
import { isFaceSketch } from "./face-sketch.ts";
import { droppedNote, highlightOf, panelFocus, selectionRows, survivors } from "./selection.ts";
import { joinBodies, shownBodies, type Scene, type ShownBody } from "./scene.ts";
import { readProfileReference } from "./references.ts";
import { addFaceSketch, addSketch, askOutline, outlineSourceOf, pinNewPoints, projectEdges, SKETCH_STEPS, sketchCurves, sketchItem, sketchPlane, sketchSide } from "./sketch.ts";
import { PROJECT_AGAIN, projectedOpen, projectPick } from "./projection.ts";
import { sketchEdgeTargets } from "./face-edges.ts";
import { sketchableFaces, sketchSpot, type SketchSpot } from "./face-pick.ts";
import { rounding, snapOnSketch, withSnap, type Snap } from "./snap.ts";
import { aimOf, anchorOf, liveValues, NO_AIM, typedFields, withLocks, type Locks } from "./typed-entry.ts";
import { typedBoxes } from "./typed-boxes.ts";
import { hintOf, pointerHint } from "./pointer-hint.ts";
import { clickAt, curveCount, hoverTool, DEFAULT_GRID, DEFAULT_GRID_SNAP, drawStep, ORIGIN_PLANES, originPlanes, sketchDrawings, startTool, switchTool, toolBusy, type SketchTool, type ToolKind } from "./sketch-tool.ts";
import { sketchPanel } from "./sketch-panel.ts";
import { sketchToolbar } from "./sketch-toolbar.ts";
import type { Sketch, SketchPlane } from "./document.ts";
import { designAIView } from "./ai-view.ts";
import { COPY_SVG, DOWNLOAD_STL, NO_BODY_STL, registerDesignActions, shownBodyRefs, STL_OVERLAY, targetsOf, type DesignRun } from "./actions.ts";

/**
 * What the user last entered (as typed), kept while other workspaces are
 * shown, with the document it made: when the project holds a different
 * document (a file was opened), the panel shows that one instead.
 */
let saved: { doc: DesignDocument; shape: PartKind; sizes: string[] } | null = null;
let framed: Framing | null = null;
let framedKind: PartKind | null = null;
/** Design was put away by an Undo or Redo made in another workspace: the next mount is that restore's, not an opened file's. */
let putAwayByRestore = false;
/**
 * The sketch being edited and its grid, kept across mounts: Undo and Redo
 * re-mount Design, and you stay in the sketch (the chain in progress ends,
 * since the point it ran from may be gone). Cleared by Finish sketch.
 */
let editingSketch: { id: string; grid: number; typed: string; tool: ToolKind } | null = null;
/** Grid snap on or off (sketch feel SF1; off by default: points go where you click), kept for every sketch until the page reloads. */
let gridSnap = DEFAULT_GRID_SNAP;
/** The properties' fold a new mount starts with (U0b): the user's pin, kept across Undo, Redo and switching; null until the first mount reads it from storage. */
let foldKept: FoldState | null = null;
/** How many times Design has framed the part, read by the e2e test (an undo must not add one). */
let fits = 0;

/** Fills the toolbar slot: Sketch, Insert ▾ (U0d) and the command groups; returns each command button with its element, and the Insert menu. */
function toolbar(slot: HTMLElement, onClick: (b: ToolButton) => void, onSketch: () => void, onExtrude: () => void, onInsert: (kind: ShapeKind) => void): { made: [ToolButton, HTMLButtonElement][]; insert: MenuButton } {
  const made: [ToolButton, HTMLButtonElement][] = [];
  const document = slot.ownerDocument; // the slot's own page, not a global one
  // The sketch tool is the user's, not a command yet: whether the AI gets
  // create_sketch and draw_line is the AI workstream's call (docs/ai.md).
  const sketch = document.createElement("div");
  sketch.className = "tool-group";
  sketch.setAttribute("role", "group");
  sketch.setAttribute("aria-label", "Sketch");
  const sketchName = document.createElement("span");
  sketchName.className = "tool-group-name";
  sketchName.textContent = "Sketch";
  const create = document.createElement("button");
  create.type = "button";
  create.id = "create-sketch";
  create.textContent = "Create sketch";
  create.title = "Draw lines, rectangles, circles and arcs on a plane: pick the plane, then click.";
  create.dataset.modelling = ""; // hidden while a sketch is edited (SF3b): the sketch's toolbar stands in
  create.addEventListener("click", onSketch);
  const extrude = document.createElement("button");
  extrude.type = "button";
  extrude.id = "extrude";
  extrude.textContent = "Extrude";
  extrude.title = "Make a solid from a closed sketch, by a distance you type: a new body in the timeline, at the marker.";
  extrude.addEventListener("click", onExtrude);
  sketch.append(sketchName, create, extrude);
  // The presets, hidden in a menu until wanted, each a new body (insert.ts).
  const adding = document.createElement("div");
  adding.className = "tool-group";
  adding.dataset.modelling = "";
  adding.setAttribute("role", "group");
  adding.setAttribute("aria-label", "Insert");
  const insert = menuButton(document, { id: "insert", label: "Insert", title: INSERT_TITLE, sections: () => insertSections(onInsert) });
  adding.append(insert.element);
  slot.append(sketch, adding);
  for (const group of toolbarGroups()) {
    const div = document.createElement("div");
    div.className = "tool-group";
    div.dataset.modelling = "";
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
  return { made, insert };
}

/** Whether two sets of ids hold the same ids. */
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** Browser groups the user folded (false) or opened (true), kept across rebuilds and workspace switches; any other group starts as its node says (`startsFolded`). */
const folding = new Map<string, boolean>();
const isOpen = (n: { id: string; startsFolded?: boolean }) => folding.get(n.id) ?? !n.startsFolded;

/** Lights the browser rows whose geometry is selected (aria-current), and only those; `failed`, the last rebuild's failed ids, select nothing. */
function lightRows(slot: HTMLElement, doc: DesignDocument, failed: ReadonlySet<string>, items: readonly GeometryReference[]) {
  const refOf = rowReferences(doc, failed);
  for (const row of slot.querySelectorAll<HTMLElement>(".tree-row")) {
    const ref = refOf(row.dataset.node!);
    if (ref && items.some((i) => i.kind === ref.kind && i.id === ref.id)) row.setAttribute("aria-current", "true");
    else row.removeAttribute("aria-current");
  }
}

/**
 * Fills the browser slot with the document's tree: groups fold (native
 * details/summary). A row for selectable geometry (Body 1, a profile) is a button
 * that selects it (Shift adds or takes out); the others are plain rows
 * until features (step 24) and origin planes (step 21) can be selected.
 * A sketch's row in the Sketches group opens its menu (Delete, 24e4) on a
 * right-click, or from its ⋯ button for touch and the keyboard; a
 * double-click on it or a Timeline row opens the item (`onOpen`, 25a3).
 * The items the last rebuild failed (`failed`) have no Body row and their
 * Timeline rows select nothing. Rebuilt on every edit and after every
 * rebuild that changes `failed`; folding is kept by id.
 */
function browser(slot: HTMLElement, doc: DesignDocument, failed: ReadonlySet<string>, onSelect: (ref: GeometryReference, shift: boolean) => void, onMenu: (node: string, at: { x: number; y: number }) => void, onOpen: (node: string) => void) {
  // Rows with the timeline's item menu (24f3): every Timeline row by its item's id, and each sketch's row in Sketches.
  const items = new Set(doc.timeline.features.map((f) => f.id));
  const refOf = rowReferences(doc, failed);
  const document = slot.ownerDocument;
  // The toggle event fires a task after the click, so a rebuild can come
  // first: read the folding from the tree being replaced, not only events.
  for (const d of slot.querySelectorAll<HTMLDetailsElement>("details[data-node]")) folding.set(d.dataset.node!, d.open);
  const list = (nodes: BrowserNode[]) => {
    const ul = document.createElement("ul");
    ul.className = "tree";
    for (const n of nodes) {
      const li = document.createElement("li");
      if (n.children) {
        const details = document.createElement("details");
        details.open = isOpen(n);
        details.dataset.node = n.id; // read by the e2e test
        details.addEventListener("toggle", () => {
          if (details.isConnected) folding.set(n.id, details.open);
        });
        const summary = document.createElement("summary");
        summary.textContent = n.label;
        details.append(summary, list(n.children));
        li.append(details);
      } else {
        const ref = refOf(n.id);
        const row = document.createElement(ref ? "button" : "span");
        if (ref) row.setAttribute("type", "button");
        row.className = "tree-row";
        row.textContent = n.label;
        // One line per row (U0a): a label too long for it ends in "…", and the tooltip has it whole.
        row.title = n.label;
        row.dataset.label = n.label;
        row.dataset.node = n.id;
        if (ref) row.addEventListener("click", (e) => onSelect(ref, (e as MouseEvent).shiftKey));
        if (items.has(n.id) || n.id.startsWith("sketches/") || n.id.startsWith("body-")) {
          row.addEventListener("dblclick", () => onOpen(n.id));
          // The row's menu: a right-click at the pointer, or the ⋯ button under itself.
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            onMenu(n.id, { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
          });
          const more = document.createElement("button");
          more.type = "button";
          more.className = "delete-ask-more";
          more.dataset.more = n.id; // read by the e2e test
          more.textContent = "⋯";
          more.title = `${n.label}: more`;
          more.setAttribute("aria-label", `${n.label} options`);
          more.setAttribute("aria-haspopup", "menu");
          more.addEventListener("click", () => {
            const r = more.getBoundingClientRect();
            onMenu(n.id, { x: r.left, y: r.bottom });
          });
          const line = document.createElement("div");
          line.className = "delete-ask delete-ask-row";
          line.append(row, more);
          li.append(line);
        } else li.append(row);
      }
      ul.append(li);
    }
    return ul;
  };
  // The whole panel folds too (SF3d): it floats over the view, so folding it gives the view back.
  const fold = document.createElement("details");
  fold.className = "browser-fold";
  fold.dataset.node = "browser";
  fold.open = isOpen({ id: "browser" });
  fold.addEventListener("toggle", () => {
    if (fold.isConnected) folding.set("browser", fold.open);
  });
  const title = document.createElement("summary");
  title.textContent = "Browser";
  fold.append(title, list(browserTree(doc, failed)));
  slot.replaceChildren(fold);
}

/** A warning from the rebuild (24d2's kept shape; 26e's lost plane and lost source): its item, the Timeline rows it marks, the sketch it is about, its words, and whether it is a lost plane. */
interface Warned {
  item: string;
  rows: string[];
  sketch: string;
  words: string;
  lost?: true;
}

function mount(ctx: WorkspaceContext): MountedWorkspace {
  const panel = propertiesPanel(ctx.properties);
  const { inputs } = panel;
  let shape: PartKind = "box";
  const held = ctx.project.workspaces.design as DesignDocument | undefined;
  /** A document the project holds that this panel did not make (an opened file): shown as it is, and framed. */
  let loaded: DesignDocument | undefined;
  /** The document this panel last made, mounted again (Design moved to the other pane): shown as it is, never remade from the size boxes (daily hunt 2026-10-23: a design with no body got a new box). */
  let remounted: DesignDocument | undefined;
  if (saved && held === saved.doc) {
    shape = saved.shape;
    inputs.forEach((input, i) => (input.value = saved!.sizes[i]));
    remounted = held;
  } else if (held) {
    const part = partOf(held); // readDesignDocument checked it when the file was opened; null when it has no body (24f4)
    if (part) {
      shape = part.shape;
      for (const [i, key] of SIZE_KEYS.entries()) if (part.sizes[key] !== undefined) inputs[i].value = String(part.sizes[key]);
    }
    loaded = held;
    framedKind = null; // an opened file is a new part: frame it (not after Undo or Redo: keepCamera)
  }
  /** Mounted by Undo or Redo (step 20c): the first build keeps the camera unless the body no longer fits, even for another shape. */
  let keepCamera = ctx.history.restoring() || putAwayByRestore;
  putAwayByRestore = false;
  const { insert: insertMenu } = toolbar(ctx.toolbar, (b) => run(b.command), () => startSketch(), () => startExtrude(), (kind) => void insertBody(kind));
  const fresh = startFresh(ctx.toolbar, { current: () => designDoc(), confirm: () => void clearDesign() });
  const deleting = deleteAsk(ctx.toolbar);
  // An empty design's hint (U0c): its buttons do what the toolbar's and the top bar's do.
  const startCard = startHint(ctx.viewport.element, { sketch: () => startSketch(), insert: () => insertMenu.open(true), open: ctx.openFile });
  /** Shows the hint while the design is empty and no sketch is being started. */
  const showStart = () => startCard.update(ctx.project.workspaces.design as DesignDocument | undefined, mode.kind !== "none");
  const { kernel, viewport } = ctx;
  /** On screen (awake); false while asleep (X7) and after unmount. */
  let shown = true;
  /** A build finished while asleep and was not drawn: wake builds again. */
  let missed = false;
  /** Every body drawn, with its faces' and edges' names (steps 24c, 24d3b), which the selection holds. */
  let lastScene: Scene | null = null;
  /** The part's body in the last scene that showed it: the panel's numbers, marked out of date, while the part fails. */
  let partShown: ShownBody | null = null;
  /** The note about items the last rebuild dropped, and whether that drop is being applied now. */
  let note = "";
  let settling = false;

  /** The failed ids the browser's rows were last drawn with. */
  let rowsFailed: ReadonlySet<string> = new Set();
  /** Draws the browser for `doc` with the last rebuild's failed items (no Body row for them). */
  function drawBrowser(doc: DesignDocument) {
    rowsFailed = failedNow;
    browser(ctx.browser, doc, failedNow, selectRow, openRowMenu, (node) => openItem(itemOfRow(node)));
  }

  /** The browser's Body 1 row: a click selects the body, Shift adds or takes it out. */
  function selectRow(ref: GeometryReference, shift: boolean) {
    if (shift) ctx.selection.toggle(ref);
    else ctx.selection.set([ref]);
  }

  /** The properties' fold (U0b), made once the tool boxes are in the panel; a selection drawn before then folds nothing. */
  let fold: PropertiesFold | null = null;
  /** The ids of the sketches whose outlines are selected, as the last showSelection found them. */
  let selectedSketches: ReadonlySet<string> = new Set();
  /** Draws the selection: the viewport's colours, the lit browser rows, the properties' rows. */
  function showSelection() {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    const items = ctx.selection.items;
    // Which selected outlines are sketches', for the note when a rebuild drops one (25c1); one already
    // gone from `doc` (shown again before the rebuild that drops it) keeps what it was.
    selectedSketches = new Set(
      items.flatMap((i) => {
        const id = readProfileReference(i);
        if (id === null) return [];
        const source = outlineSourceOf(i, doc);
        return (source ? source.kind === "sketch" : selectedSketches.has(id)) ? [id] : [];
      }),
    );
    viewport.showSelection(highlightOf(items, lastScene));
    lightRows(ctx.browser, doc, failedNow, items);
    fold?.update({ selected: items.length > 0 });
    panel.showSelection(selectionRows(items, lastScene, doc));
    // The Feature and Body sections describe the selected feature (else the part), with the browser's number for its body.
    const focus = panelFocus(items, lastScene, doc);
    panel.showFeature(focus?.feature ?? null);
    if (focus?.body) panel.showBody(focus.body.view, `Body ${focus.body.place}`);
    // The part failed: the numbers it last built, marked out of date (markStale, "Out of date: these numbers are for the last part that built").
    else if (focus && partShown?.feature === focus.feature.id && focus.feature === partFeature(doc)) panel.showBody(partShown.view, `Body ${partShown.place}`);
    else panel.showNoBody(); // a body that did not build, or a design with no body (24f4)
    // Verbs, not apps: whatever the registry offers for this selection, from any workspace.
    const verbs = ctx.actions.actionsFor(targetsOf(items, doc, failedNow));
    panel.showActions(verbs, (id) => runAction(id, ctx.selection.items));
  }

  /** Runs a registered verb on these targets and shows what it said. */
  async function runAction(id: string, targets: readonly Selected[]) {
    const action = ctx.actions.get(id);
    if (!action) return panel.showActionNote(`No action ${id} is registered.`, true);
    // Design's own runs know the bodies drawn (actions.ts, DesignRun: the precision overlay marks only those that warned);
    // the shell's context stays the prototype, so its getters (the project, the graph) read live as ever.
    const run: DesignRun = Object.assign(Object.create(ctx) as WorkspaceContext, { scene: lastScene });
    const outcome = await action.run(targets, run);
    if (shown) panel.showActionNote(outcome.message, outcome.bad);
  }

  // The body is built from the part's feature intent (document.ts); an extrude of a sketch asks the kernel for the outline (extrude.ts).
  // Its faces and edges are named from the spec it was built from (naming.ts).
  // The whole timeline is rebuilt on the kernel's body store (step 24d2,
  // rebuild.ts): a feature whose spec is unchanged keeps its body, and
  // bodies no feature holds are freed. Rebuilds run one after another, so
  // one never frees a body another is about to show.
  // Settling an edit (26c, 26g) places its face sketches on these bodies too, reusing what is built: a body is never
  // held twice, and the ones a settle builds that no rebuild keeps are freed once it ends (BodyCache.using).
  const bodies = new BodyCache(kernel);
  let rebuilds: Promise<unknown> = Promise.resolve();
  const build = latestOnly((doc: DesignDocument) => {
    const next = rebuilds.then(() => buildPart(doc));
    rebuilds = next.catch(() => {});
    return next;
  });
  /**
   * Every body the timeline built, joined for drawing (scene.ts, 24d3b);
   * when a body is built from a kept shape, the warning (the last such);
   * and, when the part (the last solid feature) has no body, why: the
   * bodies that did build are drawn all the same (bug hunt 2026-10-19,
   * finding 5: a failed part left the scene from before, so the browser's
   * rows and the panel described bodies that were not there). A design
   * with no part (24f4) builds an empty scene.
   */
  async function buildPart(doc: DesignDocument) {
    const feature = partFeature(doc);
    const build = await rebuildTimeline(doc, bodies, kernel);
    failedNow = new Set(Object.keys(build.results).filter((id) => build.results[id].status === "failed"));
    // Where each sketch on a face was placed (26c), so it is drawn there.
    placedNow = new Map(Object.entries(build.results).flatMap(([id, r]) => (r.status === "built" && r.placement ? [[id, r.placement.plane] as const] : [])));
    const result = feature && build.results[feature.id];
    let failure: string | undefined;
    if (result?.status === "failed") failure = result.message;
    else if (feature && result && (result.status !== "built" || result.body === undefined || result.spec === undefined)) failure = `${feature.provenance.self.label} is ${result.status}`;
    const drawn = await shownBodies(doc, build, bodies);
    return { scene: joinBodies(drawn), warnings: warningsOf(doc, build), failure, followed: followedDoc(doc, build) };
  }
  /**
   * The rebuild's warnings in timeline order: an extrude built from its kept
   * shape (the owner's rule: on its row and its sketch's), and from 26e a
   * sketch whose plane is lost (Q1, Q6: it stays where it was, drawn red)
   * and an extrude built from one (its source is lost); from 26f a
   * sketch's points whose edges are lost, and from 27d its projections.
   */
  function warningsOf(doc: DesignDocument, build: TimelineBuild): Warned[] {
    const out: Warned[] = [];
    for (const f of doc.timeline.features) {
      const r = build.results[f.id];
      if (r?.status !== "built") continue;
      const label = f.provenance.self.label;
      if (r.plane) out.push({ item: f.id, rows: [f.id], sketch: f.id, words: `${r.plane.message}.`, lost: true });
      if (r.warning) out.push({ item: f.id, rows: [f.id, r.warning.sketch], sketch: r.warning.sketch, words: `${label} keeps its last shape. ${r.warning.message}.` });
      if (r.source) out.push({ item: f.id, rows: [f.id], sketch: r.source.sketch, words: `${r.source.message}.` });
      if (r.points) out.push({ item: f.id, rows: [f.id], sketch: f.id, words: `${r.points.message}.` });
      if (r.projections) out.push({ item: f.id, rows: [f.id], sketch: f.id, words: `${r.projections.message}.` });
    }
    return out;
  }
  /** The last rebuild's warnings: shown on their timeline rows and items and, once the sketch each is about is finished, in the panel. */
  let warningsNow: Warned[] = [];
  /** The warnings to show now: while a sketch is being edited, none about it (the outline status says what is open; the owner's rule: a warning after Finish Sketch). */
  const shownWarnings = () => warningsNow.filter((w) => !(mode.kind === "edit" && editingSketch?.id === w.sketch));
  /** Each row's warning words, by row (a row with two warnings has both). */
  function warnedRows(): Map<string, string> {
    const rows = new Map<string, string>();
    for (const w of shownWarnings()) for (const row of w.rows) rows.set(row, rows.has(row) ? `${rows.get(row)} ${w.words}` : w.words);
    return rows;
  }
  function showKept() {
    const shown = shownWarnings();
    panel.showWarning(shown.map((w) => w.words).join(" "));
    const rows = warnedRows();
    for (const row of ctx.browser.querySelectorAll<HTMLElement>(".tree-row")) {
      const words = rows.get(row.dataset.node!);
      if (words !== undefined) row.title = words;
      else if (row.classList.contains("kept")) row.title = row.dataset.label ?? "";
      row.classList.toggle("kept", words !== undefined);
    }
  }

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
    // The whole design's STL, every body shown in one file (25c1): the same verb selected bodies offer, from the registry.
    if (command.op === "export_stl") {
      const doc = ctx.project.workspaces.design as DesignDocument | undefined;
      const bodies = doc ? shownBodyRefs(doc, failedNow) : [];
      if (bodies.length === 0) return panel.showActionNote(NO_BODY_STL, true);
      return runAction(DOWNLOAD_STL, bodies);
    }
    if (command.op !== "set_part") throw new Error(`Design has no command ${command.op}`);
    const kind = command.shape as ShapeKind;
    shape = kind;
    for (const [i, key] of SIZE_KEYS.entries()) if (typeof command[key] === "number") inputs[i].value = String(command[key]);
    return update(`Change shape to ${SHAPE_LABELS[kind] ?? kind}`);
  }

  /** Why the panel's sizes for `kind` can't be taken (the first shown box that isn't more than 0 mm), or null. */
  function refusedSize(kind: PartKind): string | null {
    for (const r of parameterRows(kind)) {
      if (!r.shown) continue;
      const text = inputs[SIZE_KEYS.indexOf(r.key)].value;
      const label = kind === "sketch-extrude" ? "distance" : r.label.toLowerCase();
      const v = Number(text);
      if (text.trim() === "" || !Number.isFinite(v)) return `Type the ${label} in mm.`;
      if (v <= 0) return `The ${label} must be more than 0 mm.`;
    }
    return null;
  }
  /** Leaving a size box whose text was refused: the size the design last took comes back, and the words go. */
  function restoreRefused(i: number) {
    if (saved === null || refusedSize(shape) === null) return;
    inputs[i].value = saved.sizes[i];
    if (refusedSize(shape) === null) panel.showError("");
  }

  /**
   * Builds the part from the panel, or makes `next` the document (an
   * extrude); `label` and `mergeKey` name the undo step when this is a
   * user's edit (none while mounting).
   */
  async function update(label?: string, mergeKey?: string, next?: DesignDocument) {
    const kind = shape;
    // A size typed in the panel that isn't one is refused there, and the design keeps its last sizes: no number, or one
    // no file can hold ("Infinity" where the box takes it as typed; hunt 26g: it took the size, its undo step couldn't
    // be saved, and nothing said so), and an empty box, 0 or below (Ben's Fusion answer 8: -5 and 0 are not accepted;
    // hunt 26h: they went to the kernel and the failed part was recorded and saved). Leaving the box puts the last
    // size back (`restoreRefused`). The kernel judges the rest (under 0.001 mm, over its largest size).
    if (next === undefined && loaded === undefined) {
      const refused = refusedSize(kind);
      if (refused !== null) return panel.showError(refused);
    }
    viewport.clearOverlay(STL_OVERLAY); // it described the part before this edit
    // The panel edits the part's one solid feature, keeping the sketches; the
    // project holds it. An opened file's document is kept as it is until the
    // first edit. An extrude of a sketch has one size, its distance (the height box).
    const current = ctx.project.workspaces.design as DesignDocument | undefined;
    const doc = next ?? loaded ?? remounted ?? (kind === "sketch-extrude" && current ? setExtrudeDistance(current, Number(inputs[2].value)) : documentFor(partCommand(), current));
    // No shape is the part's while the design has no body (24f4): the Shape choice says "—".
    panel.setShape(kind, partFeature(doc) === null ? null : kind);
    // An opened document is all new to the graph: out of date until it builds.
    const before = loaded ? null : (current ?? null);
    loaded = undefined;
    remounted = undefined;
    saved = { doc, shape, sizes: inputs.map((i) => i.value) };
    syncGraph(ctx.graph, doc, before, ctx.changeNotes);
    const changed = ctx.project.workspaces.design !== doc;
    // A user's edit is settled once recorded (`settled`), from the design before the first edit not yet settled.
    if (changed && label !== undefined && current) unsettled ??= current;
    ctx.project.workspaces.design = doc;
    if (changed) ctx.projectChanged(label, mergeKey); // the shell autosaves (19c) and records the undo step (20b)
    await show(doc, kind);
  }

  /**
   * Start fresh (start-fresh.ts), once its dialog is confirmed: out of any
   * sketch or Extrude panel, the selection cleared, the panel back to the
   * box at its default sizes, and the fresh design as one undo step, framed.
   */
  function clearDesign() {
    leaveExtrude();
    leaveEdit();
    if (mode.kind !== "none") leaveSketch(false); // update() below shows the fresh design
    ctx.selection.clear();
    shape = "box";
    inputs.forEach((input, i) => (input.value = DEFAULT_SIZES[SIZE_KEYS[i]]));
    framedKind = null; // a new part: frame it
    return update(START_FRESH_STEP, undefined, freshDesign());
  }

  /**
   * Insert ▾ (insert.ts): a whole new `kind` body at the marker at the
   * default sizes, as one undo step, never changing a body already there.
   * The panel then edits it (the boxes take its sizes) and opens to show
   * them; the first body of an empty design is framed, a later one keeps
   * the camera.
   */
  function insertBody(kind: ShapeKind) {
    leaveExtrude();
    leaveEdit();
    if (mode.kind !== "none") leaveSketch(false);
    const doc = designDoc();
    ctx.selection.clear();
    shape = kind;
    inputs.forEach((input, i) => (input.value = String(INSERT_SIZES[SIZE_KEYS[i]])));
    if (partFeature(doc) === null) framedKind = null;
    const made = update(insertStep(kind), undefined, inserted(doc, kind).doc);
    fold?.reveal();
    return made;
  }

  /** The sketches whose plane the last rebuild found lost (26e): drawn red where they stay. */
  const lostSketches = () => new Set(warningsNow.flatMap((w) => (w.lost ? [w.item] : [])));
  /** The items the last rebuild failed (24f3: red in the bar and the browser's Timeline rows); the data's own failures are added by `timelineBarItems`. */
  let failedNow: ReadonlySet<string> = new Set();
  /** Where the last rebuild placed each sketch on a face (26c), by sketch id: drawn and looked at there. */
  let placedNow: ReadonlyMap<string, Plane> = new Map();
  /**
   * What a pointer on sketch `id` may snap to on its face's edges (26f):
   * their ends, middles and centres in the plane the sketch is drawn in
   * (the last rebuild's placement, or, for a sketch just made on a face and
   * not rebuilt since, the frame it was made in).
   */
  const edgeTargets = (id: string) => sketchEdgeTargets(designDoc(), id, lastScene, sketchPlane(designDoc(), id, placedNow));
  /** The bar's item whose ⋯ shows (a click or tap picked it). */
  let picked: string | null = null;
  /** The sketch being edited, whose own Suppress and Delete are off. */
  const editingId = () => (mode.kind === "edit" && editingSketch ? editingSketch.id : null);

  /** The timeline bar for `doc`, wired to the item menu. */
  function showBar(doc: DesignDocument) {
    if (!ctx.timeline) return;
    showTimelineBar(ctx.timeline, doc, {
      failed: failedNow,
      warnings: warnedRows(),
      picked,
      onPick: (id) => {
        picked = picked === id ? null : id;
        showBar(designDoc());
      },
      onMenu: (id, at) => openMenu(id, at),
      // 25a3: a double-click opens the item: Edit Sketch, or Edit feature.
      onOpen: (id) => openItem(id),
      // 24f5: the playback buttons, the marker dragged and a tap between items, each one undo step.
      editing: editingId(),
      // A refusal goes to the error line and back to the bar, which shows it beside itself (timeline hunt, finding 4).
      onAction: (a) => {
        if (a.kind === "menu") return;
        let refused: string | undefined;
        try {
          chooseBarAction({ ...menuHost, refuse: (message) => (menuHost.refuse(message), (refused = message)) }, a, editingId());
        } catch (err) {
          panel.showError(err instanceof Error ? err.message : String(err));
        }
        return refused;
      },
    });
  }

  /**
   * The bar's items and the browser's Timeline rows red for every failed
   * item (24f3), greyed for every item after the marker (24f5), and from 26e
   * greyed for every item built on a suppressed one (Q3), its title saying
   * which. Rows with a warning are `showKept`'s.
   */
  function showFailed(doc: DesignDocument) {
    showBar(doc);
    const { items } = timelineBarItems(doc, failedNow);
    const failed = new Set(items.filter((i) => i.failed).map((i) => i.id));
    const rolledBack = new Set(items.filter((i) => i.rolledBack).map((i) => i.id));
    const greyed = new Map(items.flatMap((i) => (i.greyed === null ? [] : [[i.id, i.greyed] as const])));
    for (const row of ctx.browser.querySelectorAll<HTMLElement>('[data-node="timeline"] .tree-row')) {
      const id = row.dataset.node!;
      const red = failed.has(id);
      const grey = rolledBack.has(id);
      const by = greyed.get(id);
      row.classList.toggle("timeline-menu", red || grey || by !== undefined);
      row.classList.toggle("timeline-menu-failed", red);
      row.classList.toggle("timeline-menu-rolled-back", grey);
      row.classList.toggle("timeline-menu-greyed", by !== undefined);
      if (by !== undefined) row.title = `Greyed: ${by} is suppressed`;
      else if (row.title.startsWith("Greyed: ")) row.title = row.dataset.label ?? "";
    }
  }

  /** The timeline item of a browser row with a menu: "sketches/<id>" or an item's id. */
  /** The item a row stands for (browser.ts rowItem), or "" for none. */
  const itemOfRow = (node: string) => rowItem(node, designDoc(), failedNow) ?? "";
  /** A row's menu (24e4 for sketches, 24f3 for every timeline item, U0a for bodies: their feature's). */
  function openRowMenu(node: string, at: { x: number; y: number }) {
    openMenu(itemOfRow(node), at);
  }

  /** A double-click on item `id` (25a3): its menu's Edit Sketch or Edit feature, refused with the menu's words when that is off. */
  function openItem(id: string) {
    const doc = designDoc();
    if (!doc.timeline.features.some((f) => f.id === id)) return;
    void chooseEntry(menuHost, id, openAction(doc, id), editingId()).catch((err) => panel.showError(err instanceof Error ? err.message : String(err)));
  }

  /** Item `id`'s menu (timeline-menu.ts): Move the marker here, Suppress or Unsuppress, Delete; an entry that is off says why. */
  function openMenu(id: string, at: { x: number; y: number }) {
    const doc = designDoc();
    const item = doc.timeline.features.find((f) => f.id === id);
    if (!item) return;
    const editing = editingId();
    const entries = menuEntries(doc, id, editing).map((e) => ({ ...e, run: () => void chooseEntry(menuHost, id, e.action, editing).catch((err) => panel.showError(err instanceof Error ? err.message : String(err))) }));
    deleting.menu(itemName(item), at, entries);
  }

  /**
   * How a menu choice reaches the project: the document recorded as one
   * undo step (out of any sketch or Extrude panel first, the panel showing
   * the part the edit leaves), the delete box asking first (24e4), and a
   * refusal shown as the part's error line.
   */
  const menuHost: MenuHost = {
    kernel,
    current: () => designDoc(),
    record(step, next) {
      leaveExtrude();
      leaveEdit();
      if (mode.kind !== "none") leaveSketch(false); // update() below shows the new design
      // The part the panel shows may now be another feature (the last body that still builds), or none (24f4):
      // then the boxes stay, and a size typed adds a preset of the shape shown. After an extrude of a sketch, that is a
      // new box at a fresh design's sizes: the boxes held its distance as a height and older numbers (hunt 26g).
      const part = partOf(next);
      if (part) {
        shape = part.shape;
        for (const [i, key] of SIZE_KEYS.entries()) if (part.sizes[key] !== undefined) inputs[i].value = String(part.sizes[key]);
      } else if (shape === "sketch-extrude") {
        shape = "box";
        inputs.forEach((input, i) => (input.value = DEFAULT_SIZES[SIZE_KEYS[i]]));
      }
      void update(step, undefined, next);
    },
    ask: (q, go) => deleting.ask(q, go),
    refuse: (message) => panel.showError(message),
    edit: (id) => openEdit(id),
    editSketch: (id) => openSketch(id),
  };

  /** Shows a document the project now holds and builds its part: the browser, sketches, selection, then the body or the reason it failed. */
  /** Rebuilds asked for and not answered yet: the viewport's `data-rebuilding` says whether any is, so a test reads the page only once it shows the last edit (the monkey). */
  let rebuilding = 0;
  /** The design last shown and built: a sketch left after edits to it differs, and is rebuilt (25a3). */
  let shownDoc: DesignDocument | null = null;
  async function show(doc: DesignDocument, kind: PartKind) {
    shownDoc = doc;
    viewport.element.dataset.rebuilding = String(++rebuilding > 0);
    try {
      await showBuilt(await settled(doc), kind);
    } finally {
      viewport.element.dataset.rebuilding = String(--rebuilding > 0);
    }
  }
  /**
   * The design before the first edit recorded since the last settle (26g),
   * or null: an edit made outside a sketch (Edit feature, a shape or size
   * from the panel or the assistant, the timeline's verbs) can lose a face
   * sketch's face, find it again or move it, so the edit is settled as the
   * naming harness settles Design after every edit (`settleKept`): a sketch
   * whose face goes holds where it last was (Fusion's last place, not where
   * it was first drawn), one found again holds nothing, pinned points follow.
   * Sketch clicks and deletes settle themselves before they are recorded.
   */
  let unsettled: DesignDocument | null = null;
  /**
   * `doc`, the design just recorded, settled against `unsettled` and taken
   * into the edit's own undo step (the typing in a box still one step), or
   * `doc` itself: when nothing is unsettled, when it has no sketch on a face
   * (nothing else a non-sketch edit changes is settled), or when the design
   * changed again while the kernel looked (the next edit settles from the
   * same `unsettled`).
   */
  async function settled(doc: DesignDocument): Promise<DesignDocument> {
    const from = unsettled;
    if (from === null || ctx.history.restoring()) return doc;
    if (!doc.timeline.features.some(isFaceSketch)) {
      unsettled = null;
      return doc;
    }
    let next: DesignDocument;
    try {
      next = await settleKept(kernel, from, doc, bodies);
    } catch {
      return doc; // the rebuild says what failed
    }
    if (designDoc() !== doc || ctx.history.restoring()) return doc;
    unsettled = null;
    if (next !== doc) takeIn(doc, next);
    return next;
  }
  /**
   * `next`, `doc` settled or with its pinned points followed, taken in as
   * the design in `doc`'s own undo step: it follows from that step, so the
   * typing in a box stays one step.
   */
  function takeIn(doc: DesignDocument, next: DesignDocument) {
    ctx.project.workspaces.design = next;
    if (saved?.doc === doc) saved = { ...saved, doc: next };
    if (shownDoc === doc) shownDoc = next;
    ctx.history.amend(true);
  }
  async function showBuilt(doc: DesignDocument, kind: PartKind) {
    // The item the Edit feature panel is open on was deleted (the bar, Undo in another way): the panel goes with it.
    if (editBox.editing !== null && !doc.timeline.features.some((f) => f.id === editBox.editing)) leaveEdit();
    drawBrowser(doc);
    fresh.showFor(doc);
    showStart();
    showFailed(doc);
    showKept();
    drawSketches();
    showSelection();
    markStale();
    try {
      const { current, value } = await build(doc);
      if (!current) return;
      if (!shown) return void (missed = true);
      missed = false;
      const { scene, failure } = value;
      // Points pinned to a face's edges (26f) where this rebuild found them, taken into the edit's own undo step (the
      // typing in a box still one step): drawn there, and held there should their edge go. An edit's settling has
      // followed them already, so this takes in a file opened with its points elsewhere (or an edit whose settling
      // failed). Not while an undo or redo is putting a snapshot back (it was taken in when that step was made), nor
      // once the design has changed again.
      if (value.followed !== doc && designDoc() === doc && !ctx.history.restoring()) takeIn(doc, value.followed);
      // The rows were drawn before the rebuild said what failed: a failed item has no Body row.
      if (!sameIds(rowsFailed, failedNow)) drawBrowser(doc);
      warningsNow = value.warnings;
      showKept();
      showFailed(doc);
      // Built from the current inputs: the feature and the numbers are fresh. A failed part is not (its numbers stay, marked).
      if (failure === undefined) {
        for (const f of doc.timeline.features) ctx.graph.markFresh(f.id);
        ctx.graph.markFresh(PART_VIEW);
      }
      markStale(failure !== undefined);
      viewport.showBody(scene.mesh);
      // A sketch on a face is drawn where this rebuild placed it (26c).
      drawSketches();
      const empty = scene.bodies.length === 0;
      // A different shape is a new part: frame it (not when Undo or Redo put
      // it back: the camera stays unless the body no longer fits). With no
      // body (24f4) the camera stays where it is, for the body's return; so
      // it does while the part fails, for its return.
      if (failure === undefined) {
        const newPart = kind !== framedKind && !keepCamera;
        keepCamera = false;
        if (!empty && (newPart || needsRefit(framed, viewport.bodyFraming()))) {
          framed = viewport.fit();
          viewport.element.dataset.framedRadius = String(framed?.radius); // read by the e2e test
          viewport.element.dataset.fits = String(++fits);
        }
        if (!empty) framedKind = kind;
      }
      panel.showError(failure ?? "");
      // Faces and edges the edit took off the body leave the selection, with a
      // note (17e); so do ones whose name now names two (25a4: never a guess);
      // the rest follow their names, however the kernel numbers them now.
      const outlines = [...doc.profiles.map((p) => p.id), ...doc.sketches.flatMap((s) => (s.curves.length > 0 ? [s.id] : []))];
      const { kept, dropped, shared } = survivors(ctx.selection.items, scene, outlines);
      lastScene = scene;
      if (mode.kind === "pick") viewport.showPlanes(originPlanes(), sketchableFaces(scene)); // the faces offered are this scene's
      const part = partFeature(doc);
      partShown = scene.bodies.find((b) => b.feature === part?.id) ?? (failure === undefined ? null : partShown);
      note = droppedNote(dropped, shared, selectedSketches);
      if (dropped.length > 0) {
        settling = true;
        ctx.selection.set(kept);
        settling = false;
      }
      panel.showSelectionNote(note);
      showSelection();
      if (failure === undefined) viewport.element.dataset.shape = empty ? "none" : kind; // read by the e2e test: what is on screen
    } catch (e) {
      if (!shown) return void (missed = true);
      missed = false;
      warningsNow = [];
      if (designDoc() === doc && !sameIds(rowsFailed, failedNow)) drawBrowser(doc);
      showKept();
      if (designDoc() === doc) showFailed(doc);
      panel.showError(e instanceof Error ? e.message : String(e));
      markStale(true);
    }
  }

  // The sketch tool (step 21c, docs/document-model.md section 3).
  /** While editing: the tool, the grid, where the pointer landed (snapped) and why, with the pixel size it was snapped at. */
  type Mode = { kind: "none" } | { kind: "pick" } | { kind: "edit"; tool: SketchTool; grid: number; pointer: SketchXY | null; snap: Snap | null; pixel?: number };
  let mode: Mode = { kind: "none" };
  const sketchBox = sketchPanel(ctx.properties, {
    pickPlane: (id) => pickPlane(id),
    cancel: () => leaveSketch(),
    grid: (typed) => void setGrid(typed),
    gridSnap: (on) => setGridSnap(on),
    finish: () => finishSketch(),
    extrude: () => startExtrude(),
    lookAt: () => lookAtSketch(),
  });
  /** The sketch's own toolbar (SF3b), standing in for the modelling buttons while a sketch is edited; Extrude stays. */
  const sketchBar = sketchToolbar(ctx.toolbar, { tool: (kind) => chooseTool(kind), finish: () => finishSketch() });
  /** Typed sizes (SF4): what the boxes by the pointer lock, and where the pointer is over the view (px), where they float. */
  let locks: Locks = {};
  let screen = { x: 0, y: 0 };
  const typed = typedBoxes(viewport.element, {
    locks: (next) => ((locks = next), drawSketches()),
    enter: () => placeTyped(),
    escape: () => ((locks = {}), drawSketches()),
  });
  /** What the next click places, by the pointer ("Specify next point"). */
  const hint = pointerHint(viewport.element);
  /** Empties the boxes: a point placed, the tool changed or ended, the sketch left. */
  function unlock(keepFocus = false) {
    locks = {};
    typed.clear(keepFocus);
  }
  /** Shows the modelling buttons (true) or the sketch's toolbar in their place (false). */
  function modelling(on: boolean) {
    for (const el of ctx.toolbar.querySelectorAll<HTMLElement>("[data-modelling]")) el.hidden = !on;
  }
  const designDoc = () => ctx.project.workspaces.design as DesignDocument;
  /** Counts tool changes (a tool chosen, Escape, the sketch entered again): a click the kernel was still snapping across one is dropped. */
  let toolChanges = 0;

  /** Draws every sketch, the edited one with its grid, points and preview. */
  function drawSketches() {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    const editing = mode.kind === "edit" ? mode : null;
    // With a size typed the preview goes where the locks put it, and the snap marks (which the locks overrule) are left out.
    const locked = Object.keys(locks).length > 0;
    const aim = editing && aimOf(doc, editing.tool, editing.pointer, locks);
    // A typed arc angle goes the pointer's way round however little it went (typed-entry.ts withLocks): the preview from the tool the click will use.
    viewport.showSketches(withSnap(sketchDrawings(doc, editing && { ...editing, tool: withLocks(editing.tool, locks, editing.pointer), pointer: aim, gridSnap }, placedNow, lostSketches()), locked ? null : (editing?.snap ?? null), editing?.pixel));
    const anchor = editing && anchorOf(doc, editing.tool);
    if (!editing) return (typed.hide(), hint.hide());
    const width = viewport.element.clientWidth;
    typed.show(typedFields(editing.tool), anchor && aim ? liveValues(anchor, aim, editing.tool) : {}, Math.min(screen.x, Math.max(0, width - 200)), screen.y);
    if (editing.pointer) hint.show(hintOf(editing.tool), Math.min(screen.x, Math.max(0, width - 200)), screen.y);
    else hint.hide();
  }

  /**
   * Applies a sketch edit to the project: one undo step named `label`
   * (SKETCH_STEPS), the timeline in the graph (a sketch has nothing to
   * build: its outline is asked of the kernel when read), the browser
   * and the drawing. What is built from the sketch is marked out of date
   * and rebuilt when the sketch is left (Finish Sketch, 25a3), as the
   * reference app does: never part way through drawing an outline.
   */
  function applySketchEdit(next: DesignDocument, label: string, sketchId: string) {
    const before = designDoc();
    syncGraph(ctx.graph, next, before, ctx.changeNotes);
    ctx.graph.markFresh(sketchId);
    ctx.project.workspaces.design = next;
    saved = { doc: next, shape, sizes: inputs.map((i) => i.value) };
    ctx.projectChanged(label);
    drawBrowser(next);
    fresh.showFor(next);
    showStart();
    showFailed(next);
    showKept(); // the rows are new: mark them again until the rebuild says otherwise
    markStale();
  }

  /** Create sketch: the origin planes appear at the origin, the flat faces of the bodies on screen light under the pointer (26d), and the panel asks for one. */
  function startSketch() {
    leaveExtrude();
    leaveEdit();
    if (mode.kind === "edit") leaveSketch();
    mode = { kind: "pick" };
    showStart();
    viewport.showPlanes(originPlanes(), sketchableFaces(lastScene));
    sketchBox.showPick();
  }

  /** A plane picked: the new sketch (one undo step), looked at straight down, ready to draw on. */
  function pickPlane(plane: SketchPlane) {
    if (mode.kind !== "pick" || !ORIGIN_PLANES.some((p) => p.id === plane)) return;
    startNewSketch(addSketch(designDoc(), plane));
  }

  /**
   * A face picked (26d, face-pick.ts): a flat one gets the new sketch on it,
   * drawn with the frame its face gives it (rule 8) and looked at from
   * outside the body; a curved one, or one with no name of its own, is
   * refused in the panel's words and the planes stay offered.
   */
  function pickFace(spot: SketchSpot & { kind: "face" | "refused" }) {
    if (mode.kind !== "pick") return;
    if (spot.kind === "refused") return sketchBox.showError(spot.message);
    let made: ReturnType<typeof addFaceSketch>;
    try {
      made = addFaceSketch(designDoc(), spot.face, spot.drawn);
    } catch (e) {
      return sketchBox.showError(e instanceof Error ? e.message : String(e));
    }
    startNewSketch(made);
  }

  /** A new sketch made on a plane or a face: recorded (one undo step), opened with the line tool, looked at square on. */
  function startNewSketch(made: { doc: DesignDocument; id: string }) {
    viewport.showPlanes([]);
    applySketchEdit(made.doc, SKETCH_STEPS.create, made.id);
    editingSketch = { id: made.id, grid: DEFAULT_GRID, typed: String(DEFAULT_GRID), tool: "line" };
    enterSketch();
    lookAtSketch();
  }

  /**
   * Edit Sketch (25a3, from an item's menu or a double-click): sketch `id`
   * open again with the line tool, out of any other sketch (rebuilt when
   * changed), Extrude or Edit feature panel first, looked at straight down.
   * Nothing is recorded until something is drawn; the kept-shape warning
   * of what is built from it waits for Finish Sketch.
   */
  function openSketch(id: string) {
    leaveExtrude();
    leaveEdit();
    if (mode.kind !== "none") leaveSketch();
    editingSketch = { id, grid: DEFAULT_GRID, typed: String(DEFAULT_GRID), tool: "line" };
    enterSketch();
    if (mode.kind !== "edit") return;
    showKept();
    lookAtSketch();
  }

  /** Look At (SF2): the camera square onto the edited sketch's plane, framing the body and what is drawn; from outside the body on a back or bottom face (26d). */
  function lookAtSketch() {
    if (mode.kind !== "edit" || !editingSketch) return;
    const doc = designDoc();
    viewport.lookAt(sketchPlane(doc, editingSketch.id, placedNow), sketchSide(doc, editingSketch.id));
  }

  /** Edits the sketch named in editingSketch with its tool, nothing clicked yet. */
  function enterSketch() {
    const doc = designDoc();
    if (!editingSketch || !doc.sketches.some((s) => s.id === editingSketch!.id)) return void (editingSketch = null);
    mode = { kind: "edit", tool: startTool(editingSketch.tool, editingSketch.id), grid: editingSketch.grid, pointer: null, snap: null };
    toolChanges++;
    sketchBox.showEditing(sketchItem(doc, editingSketch.id).provenance.self.label, editingSketch.typed, gridSnap, editingSketch.tool);
    modelling(false);
    sketchBar.show(editingSketch.tool);
    drawSketches();
    showBar(doc); // the playback buttons that would roll the sketch back are off (24f5)
    void showOutline();
  }

  /** Line, Rectangle, Circle or an arc (3-point, centre or tangent; the buttons and Create menu, or L, R, C, A and T): what was part way through is dropped, as Escape would, except that a line chain and a tangent arc carry on from each other's last point (`switchTool`). */
  function chooseTool(kind: ToolKind) {
    if (mode.kind !== "edit" || !editingSketch) return;
    editingSketch.tool = kind;
    mode.tool = switchTool(designDoc(), mode.tool, kind);
    mode.snap = null;
    toolChanges++;
    unlock();
    sketchBox.showTool(kind);
    sketchBar.showTool(kind);
    sketchBox.showError("");
    drawSketches();
  }

  /**
   * Cancel, Finish sketch, Extrude, another sketch or item opened: back to
   * modelling; the sketch stays as drawn. When the design changed since it
   * was last built (something was drawn), everything is rebuilt from it
   * (25a3): what is built from the sketch, and everything after that; the
   * rebuild keeps every body whose spec is unchanged. `rebuild` false: the
   * caller shows a new design straight after.
   */
  function leaveSketch(rebuild = true) {
    const drew = mode.kind === "edit" && rebuild && designDoc() !== shownDoc;
    mode = { kind: "none" };
    unlock();
    editingSketch = null;
    showStart();
    viewport.showPlanes([]);
    sketchBox.hide();
    sketchBar.hide();
    modelling(true);
    drawSketches();
    showKept();
    showBar(designDoc());
    if (drew) void show(designDoc(), shape);
  }

  /** Finish Sketch (the toolbar's or the panel's): back to modelling, the camera at the home view (as the owner's CAD suite does, not the view from before the sketch). */
  function finishSketch() {
    if (mode.kind !== "edit") return leaveSketch();
    // A click still waiting for the kernel is drawn first, then the sketch closes: closed at once, the click's turn came
    // for a sketch no longer open and it was dropped (a slow phone tapping fast lost its last circle; found in 27b).
    if (waiting > 0) {
      const finish = () => {
        if (mode.kind !== "edit") return; // left meanwhile (Escape, Undo, another Finish)
        leaveSketch();
        viewport.setView("home");
      };
      clicks = clicks.then(finish, finish);
      return;
    }
    leaveSketch();
    viewport.setView("home");
  }

  /** A grid size typed: the kernel judges it (snapping 0, 0 to it); a refused one keeps the grid and says why. */
  async function setGrid(typed: string) {
    if (mode.kind !== "edit" || !editingSketch) return;
    const sketch = editingSketch;
    const grid = Number(typed);
    try {
      if (typed.trim() === "" || !Number.isFinite(grid)) throw new Error("Type the grid size in mm.");
      await kernel.call("snap_to_grid", 0, 0, grid);
    } catch (e) {
      return sketchBox.showError(e instanceof Error ? e.message : String(e));
    }
    // The kernel answered after an Undo, Escape or Finish put this sketch away: the size is for a sketch no longer open.
    if (mode.kind !== "edit" || editingSketch !== sketch) return;
    sketchBox.showError("");
    mode.grid = sketch.grid = grid;
    sketch.typed = typed;
    drawSketches();
  }

  /** Grid snap ticked or unticked: from the next pointer move, points land on the grid or where you click. */
  function setGridSnap(on: boolean) {
    gridSnap = on;
    if (mode.kind === "edit") mode.snap = null;
    drawSketches();
  }

  /** Says what the edited sketch holds and whether it makes one closed outline, or the kernel's reason it doesn't. */
  // Every answer goes through one latestOnly, those needing no kernel too, so an older ask answered later never shows over a newer one.
  const outlineOf = latestOnly(async (sketch: Sketch) => (sketch.curves.length === 0 ? null : (projectedOpen(sketch) ?? (await askOutline(kernel, sketchCurves(sketch))))));
  async function showOutline() {
    if (mode.kind !== "edit") return;
    const id = mode.tool.sketch;
    const sketch = designDoc().sketches.find((s) => s.id === id);
    if (!sketch) return;
    const n = curveCount(sketch);
    try {
      const { current, value } = await outlineOf(sketch);
      if (current) sketchBox.showStatus(value === null ? `${n}.` : typeof value === "string" ? `${n}, not closed: ${value}.` : "closed" in value ? `${n}, a closed outline.` : `${n}, not closed: ${value.open}.`);
    } catch (e) {
      sketchBox.showStatus(`${n}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Extrude (step 21d): pick a sketch, type a distance, OK when the kernel says it closes.
  /** The sketch the Extrude panel is set to, while it is open. */
  let extruding: { sketch: string | null } | null = null;
  const extrudeBox = extrudePanel(ctx.properties, {
    sketch: (id) => {
      if (!extruding) return;
      extruding.sketch = id;
      extrudeBox.showError("");
      void checkExtrude(id);
    },
    ok: (typed, flip) => void finishExtrude(typed, flip),
    cancel: () => leaveExtrude(),
  });

  /**
   * Extrude: like Finish sketch first when a sketch is being drawn (that
   * sketch is the one offered); otherwise the newest sketch.
   */
  function startExtrude() {
    leaveEdit();
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    const editing = mode.kind === "edit" ? mode.tool.sketch : null;
    if (mode.kind !== "none") leaveSketch();
    // Only sketches an extrude put in at the marker can use: before it, and not suppressed (hunt 2026-10-21).
    const sketches = doc ? doc.timeline.features.filter(isSketchItem) : [];
    const items = doc ? sketches.filter((f) => !f.suppressed && doc.timeline.features.indexOf(f) < insertAt(doc)) : [];
    const chosen = items.find((f) => f.id === editing)?.id ?? items.at(-1)?.id ?? null;
    extruding = { sketch: chosen };
    extrudeBox.show(items.map((f) => ({ id: f.id, label: f.provenance.self.label })), chosen, String(DEFAULT_DISTANCE));
    if (items.length === 0 && sketches.length > 0) extrudeBox.showStatus(NO_USABLE_SKETCH, false);
    if (chosen) void checkExtrude(chosen);
  }

  function leaveExtrude() {
    extruding = null;
    extrudeBox.hide();
  }

  /** Says whether the chosen sketch makes a closed outline (OK on) or the kernel's reason it doesn't (OK off). */
  const extrudeOutline = latestOnly((curves: ReturnType<typeof sketchCurves>) => askOutline(kernel, curves));
  async function checkExtrude(id: string) {
    const doc = designDoc();
    const sketch = doc.sketches.find((s) => s.id === id);
    if (!sketch) return;
    const name = sketchItem(doc, id).provenance.self.label;
    extrudeBox.showStatus(sketch.curves.length === 0 ? `${name} has nothing drawn yet.` : `Checking ${name}…`, false);
    if (sketch.curves.length === 0) return;
    try {
      const { current, value } = await extrudeOutline(sketchCurves(sketch));
      if (!current || extruding?.sketch !== id) return;
      if ("closed" in value) extrudeBox.showStatus(`${name} makes a closed outline.`, true);
      else extrudeBox.showStatus(`${name} can't be extruded: it doesn't make one closed outline (${value.open}).`, false);
    } catch (e) {
      if (extruding?.sketch === id) extrudeBox.showStatus(`${name} can't be extruded: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  /**
   * OK: the kernel builds the extrude first; only one that builds is
   * recorded, as one undo step ("Replace the part with Extrude of Sketch
   * 1"). A refused distance keeps the panel open and says why.
   */
  async function finishExtrude(typed: string, flip: boolean) {
    const id = extruding?.sketch;
    if (!id) return;
    const distance = Number(typed);
    if (typed.trim() === "" || !Number.isFinite(distance)) return extrudeBox.showError("Type the distance in mm.");
    const before = designDoc();
    let made: ReturnType<typeof extrudeSketch>;
    try {
      made = extrudeSketch(before, id, distance, flip);
      await buildSpec(kernel, await featureSpec(kernel, made.doc, made.doc.timeline.features.find((f) => f.id === made.id)!));
    } catch (e) {
      if (extruding?.sketch === id) extrudeBox.showError(e instanceof Error ? e.message : String(e));
      return;
    }
    // Something else changed the design while the kernel worked: this extrude is out of date.
    if (extruding?.sketch !== id || designDoc() !== before) return;
    leaveExtrude();
    shape = "sketch-extrude";
    inputs[SIZE_KEYS.indexOf("height")].value = typed;
    await update(extrudeStep(before, id), undefined, made.doc);
  }

  // Edit feature (step 25a2): an earlier feature's sizes from its timeline item or browser row.
  const editBox = featureEditPanel(ctx.properties, {
    ok: (typed, flip) => void finishEdit(typed, flip),
    cancel: () => leaveEdit(),
  });

  // The panel folds away until something is selected or a tool's box is in it (U0b); the user's pin is kept across mounts.
  fold = propertiesFold(
    ctx.properties,
    ["sketch-panel", "extrude-panel", "feature-edit"].map((id) => ctx.properties.querySelector<HTMLElement>(`#${id}`)!),
    foldKept ?? { ...FOLDED_AT_START, pinned: readPinned() },
  );
  fold.update({ selected: ctx.selection.items.length > 0 });

  /** Opens item `id`'s sizes in the Edit feature panel, out of any sketch or Extrude panel first. */
  function openEdit(id: string) {
    leaveExtrude();
    if (mode.kind !== "none") leaveSketch();
    editBox.show(editableFeature(designDoc(), id));
  }

  function leaveEdit() {
    editBox.hide();
  }

  /**
   * OK: the typed sizes made the item's (`editFeature`), checked by the
   * kernel (`refusedSizes`) and recorded as one undo step ("Edit Extrude
   * 1") only when it takes them; the rebuild builds the item and everything
   * after it. A refused size keeps the panel open with the kernel's words
   * and records nothing; sizes that change nothing close it.
   */
  async function finishEdit(typed: Partial<Record<SizeKey, string>>, flip?: boolean) {
    const id = editBox.editing;
    if (id === null) return;
    const before = designDoc();
    let next: DesignDocument;
    try {
      const f = editableFeature(before, id);
      const read = readTyped(f.keys, typed);
      if ("bad" in read) {
        const label = f.shape === "sketch-extrude" ? "distance" : parameterRows(f.shape).find((r) => r.key === read.bad)!.label.toLowerCase();
        return editBox.showError(`Type the ${label} in mm.`);
      }
      next = editFeature(before, id, read.sizes, flip);
    } catch (e) {
      return editBox.showError(e instanceof Error ? e.message : String(e));
    }
    if (next === before) return leaveEdit();
    editBox.busy(true);
    let refused: string | null;
    try {
      refused = await refusedSizes(kernel, before, next, id);
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    // Closed, or the design changed while the kernel looked: this edit is out of date.
    if (editBox.editing !== id) return;
    editBox.busy(false);
    if (designDoc() !== before) return editBox.showError(CHANGED_WHILE_CHECKING);
    if (refused !== null) return editBox.showError(refused);
    menuHost.record(editStep(before, id), next);
  }

  /** The pointer rounded by the kernel: onto the grid with grid snap on, else where it is to within half a pixel (snap.ts `rounding`). */
  const roundPointer = (at: SketchXY, grid: number, pixel: number | undefined): Promise<SketchXY> => {
    const r = rounding(at, grid, gridSnap, pixel);
    return r.op === "snap_to_grid" ? kernel.call("snap_to_grid", ...r.args) : kernel.call("place_freely", ...r.args);
  };
  /** The pointer's moves counted, the pointer leaving the view among them: a move's rounding answered after a later move is dropped, so it never shows a snap where the pointer was. */
  let moves = 0;
  /** The last hover the kernel has answered (its move's count, where the pointer was, rounded, its pixel); null once the pointer left the view. */
  let hovered: { move: number; at: SketchXY; rounded: SketchXY; pixel: number | undefined } | null = null;
  /**
   * The pointer's last move since the last click (its count, where it was, its pixel, and the kernel's rounding of it
   * on the way), or null: an Enter places from where the pointer was as Enter was pressed, once that move is rounded.
   */
  let lastMove: { at: SketchXY; pixel: number | undefined; rounded: Promise<SketchXY> } | null = null;
  /** Clicks are handled one after another, each on the document the last one left. */
  let clicks = Promise.resolve();
  /** How many clicks (typed Enters and projections too) wait their turn: Finish Sketch waits for them. */
  let waiting = 0;
  /** `turn` in line behind the clicks before it. */
  const inTurn = (turn: () => Promise<void>) => {
    waiting++;
    clicks = clicks.then(turn).finally(() => void waiting--);
  };
  const onSketchPointer = (pointer: SketchPointer) => {
    if (mode.kind !== "edit") return;
    const at = pointer.at;
    // Step 27d: the Project tool snaps nothing and places nothing; a click projects what the viewport says is under it.
    if (mode.tool.kind === "project") {
      ++moves;
      hovered = lastMove = null;
      mode.snap = null;
      mode.pointer = at;
      if (pointer.kind === "click") projectAt(pointer);
      return drawSketches();
    }
    if (pointer.kind === "move") {
      const move = ++moves;
      if (!at) {
        mode.pointer = mode.snap = null;
        hovered = lastMove = null;
        return drawSketches();
      }
      // The centre arc follows which way the pointer goes round its centre, from every move (a reply the kernel drops as stale must not lose a turn).
      mode.tool = hoverTool(mode.tool, at);
      // A hover off the modelling range just doesn't move the preview.
      const rounded = roundPointer(at, mode.grid, pointer.pixel);
      lastMove = { at, pixel: pointer.pixel, rounded };
      void rounded.then((value) => {
        if (move !== moves || mode.kind !== "edit") return;
        hovered = { move, at, rounded: value, pixel: pointer.pixel };
        mode.snap = snapOnSketch(designDoc(), mode.tool, at, value, pointer.pixel, edgeTargets(mode.tool.sketch));
        mode.pointer = mode.snap.at;
        mode.pixel = pointer.pixel;
        drawSketches();
      }, () => {});
      return;
    }
    if (!at) return;
    const changes = toolChanges;
    // What is typed as the click is made (hunt 26h): the kernel may answer after more is typed, which is for the next point.
    const took = locks;
    const movedAt = moves;
    lastMove = null; // an Enter from now on places from this click's point, or from a hover after it
    inTurn(async () => {
      if (mode.kind !== "edit") return;
      let rounded: SketchXY;
      try {
        rounded = await roundPointer(at, mode.grid, pointer.pixel);
      } catch (e) {
        return sketchBox.showError(e instanceof Error ? e.message : String(e));
      }
      // The tool changed while the kernel snapped (L, R, C or Escape): the click was for the old tool, so it is dropped.
      if (mode.kind !== "edit" || toolChanges !== changes) return;
      // The click lands where the hover showed it would: where it was rounded to (free or on the grid), or on the point or line-up snap.ts finds.
      const edges = edgeTargets(mode.tool.sketch);
      const snapped = snapOnSketch(designDoc(), mode.tool, at, rounded, pointer.pixel, edges).at;
      // A typed size overrules the pointer for what it locks (SF4): the point goes where the locks put it, exactly.
      const aim = aimOf(designDoc(), mode.tool, snapped, took);
      if (!aim) return sketchBox.showError(NO_AIM);
      const before = designDoc();
      const done = clickAt(before, withLocks(mode.tool, took, snapped), aim);
      // The owner's rule (rebuild.ts): an extrude whose sketch this edit breaks keeps the sketch as it was, in the same undo step.
      // A new point on the face's edges is pinned there (26f), in the same step.
      let next = pinNewPoints(before, done.doc, done.tool.sketch, edges);
      if (done.drew) {
        try {
          next = await settleKept(kernel, before, next, bodies);
        } catch (e) {
          return sketchBox.showError(e instanceof Error ? e.message : String(e));
        }
        // Undo, Escape or a tool change while the kernel looked: the click was for a sketch that is no longer there.
        if (mode.kind !== "edit" || toolChanges !== changes || designDoc() !== before) return;
      }
      sketchBox.showError(done.note ?? "");
      if (done.tool !== mode.tool && locks === took) unlock(); // the sizes it placed with, not any typed since
      mode.tool = done.tool;
      // What the pointer snaps to now, with the new point and the tool's next step: where a hover answered since the
      // click has it (the click waited its turn behind the kernel while the pointer moved on: hunt 26h), else still at
      // the click. (A finger has left the view by now, and this keeps the hint and the boxes by the tap; sketch-hover.journey.ts.)
      const now = hovered !== null && hovered.move > movedAt ? hovered : { at, rounded, pixel: pointer.pixel };
      mode.snap = snapOnSketch(done.doc, done.tool, now.at, now.rounded, now.pixel, edges);
      mode.pointer = mode.snap.at;
      mode.pixel = now.pixel;
      if (done.drew) applySketchEdit(next, drawStep(done.tool), done.tool.sketch);
      drawSketches();
      if (done.drew) await showOutline();
    });
  };

  /**
   * A click with the Project tool (27d): the edge under the pointer, else
   * every edge of the face there, of a body before the sketch, projected
   * into it as one undo step ("Project"), in turn with the clicks before it
   * (each on the document the last left); settled as a click is, so an
   * extrude of the sketch keeps its shape if this breaks its outline. What
   * was refused, left out or projected already is said in the panel.
   */
  function projectAt(pointer: SketchPointer) {
    const changes = toolChanges;
    inTurn(async () => {
      if (mode.kind !== "edit" || mode.tool.kind !== "project" || toolChanges !== changes) return;
      const id = mode.tool.sketch;
      const before = designDoc();
      const pick = projectPick(before, id, lastScene, sketchPlane(before, id, placedNow), pointer);
      let made: ReturnType<typeof projectEdges>;
      try {
        made = projectEdges(before, id, pick.edges);
      } catch (e) {
        return sketchBox.showError(e instanceof Error ? e.message : String(e));
      }
      sketchBox.showError(pick.note ?? (pick.edges.length > 0 && made.ids.length === 0 ? PROJECT_AGAIN : ""));
      if (made.ids.length === 0) return;
      let next: DesignDocument;
      try {
        next = await settleKept(kernel, before, made.doc, bodies);
      } catch (e) {
        return sketchBox.showError(e instanceof Error ? e.message : String(e));
      }
      // Undo, Escape or a tool change while the kernel looked: the click was for a sketch that is no longer there.
      if (mode.kind !== "edit" || toolChanges !== changes || designDoc() !== before) return;
      applySketchEdit(next, SKETCH_STEPS.project, id);
      drawSketches();
      await showOutline();
    });
  }

  /**
   * Enter in a typed box (SF4): the point placed where the locks and the
   * pointer put it as Enter is pressed, as a click there would; the keys
   * stay in the boxes for the next line. Enter takes the boxes and empties
   * them at once (hunt 26h): placing waits behind the kernel's last answer,
   * and the next side typed meanwhile must go into fresh boxes, not be read
   * by this Enter (a fast "10, Tab, 90, Enter" placed a point 180 mm off).
   * An Enter that places nothing gives its sizes back, unless something was
   * typed since.
   */
  function placeTyped() {
    if (mode.kind !== "edit") return;
    const took = locks;
    const texts = typed.texts();
    const from = lastMove;
    const changes = toolChanges;
    unlock(true);
    drawSketches();
    const giveBack = () => void (mode.kind === "edit" && typed.restore(texts));
    inTurn(async () => {
      // A tool chosen (or Escape) since: the sizes were for the old tool, so the Enter is dropped, as a click is.
      if (mode.kind !== "edit" || toolChanges !== changes) return;
      // Where the pointer was as Enter was pressed: its last move, rounded and snapped on the sketch as it is now (the
      // points placed before this one in), else where the last click or hover left it.
      let pointer = mode.pointer;
      if (from) {
        const rounded = await from.rounded.catch(() => null);
        if (mode.kind !== "edit" || toolChanges !== changes) return;
        if (rounded) pointer = snapOnSketch(designDoc(), mode.tool, from.at, rounded, from.pixel, edgeTargets(mode.tool.sketch)).at;
      }
      const aim = aimOf(designDoc(), mode.tool, pointer, took);
      if (!aim) return (sketchBox.showError(NO_AIM), giveBack());
      const before = designDoc();
      const done = clickAt(before, withLocks(mode.tool, took, pointer), aim);
      // As a click: an extrude whose sketch this breaks keeps the sketch as it was (rebuild.ts), in the same undo step, and a point on the face's edges is pinned (26f).
      let next = pinNewPoints(before, done.doc, done.tool.sketch, edgeTargets(done.tool.sketch));
      if (done.drew) {
        try {
          next = await settleKept(kernel, before, next, bodies);
        } catch (e) {
          return (sketchBox.showError(e instanceof Error ? e.message : String(e)), giveBack());
        }
        if (mode.kind !== "edit" || toolChanges !== changes || designDoc() !== before) return;
      }
      sketchBox.showError(done.note ?? "");
      if (done.tool === mode.tool) giveBack();
      mode.tool = done.tool;
      mode.snap = null;
      if (done.drew) applySketchEdit(next, drawStep(done.tool), done.tool.sketch);
      drawSketches();
      if (done.drew) await showOutline();
    });
  }
  const onViewportMove = (e: PointerEvent) => {
    if (e.target instanceof Node && typed.element.contains(e.target)) return; // over the boxes themselves: they stay put
    const r = viewport.element.getBoundingClientRect();
    screen = { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Picking (17b): a click on a face selects it, Shift adds, empty space or Escape clears.
  const onPick: SharedViewport["onPick"] = (pick) => {
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    if (!doc) return;
    // Choosing where Create sketch puts the sketch: an origin plane, or a flat face of a body on screen (26d).
    if (mode.kind === "pick") {
      const spot = sketchSpot(pick, lastScene);
      if (spot?.kind === "plane") pickPlane(spot.plane);
      else if (spot) pickFace(spot);
      return;
    }
    const c = pickChange(pick, lastScene);
    if (c.change === "set") ctx.selection.set([c.item]);
    else if (c.change === "toggle") ctx.selection.toggle(c.item);
    else if (c.change === "clear") ctx.selection.clear();
  };
  let stopWatching = () => {};
  /** Listens to picks and the selection: from mount, and again on each wake. Keys come from the shell (X7b), only while shown. */
  function listen() {
    viewport.onPick = onPick;
    viewport.onSketchPointer = onSketchPointer;
    viewport.element.addEventListener("pointermove", onViewportMove);
    viewport.element.addEventListener("pointerdown", onViewportMove); // a tap moves no pointer first
    if (mode.kind === "pick") viewport.showPlanes(originPlanes(), sketchableFaces(lastScene));
    drawSketches();
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
    viewport.onSketchPointer = null;
    viewport.element.removeEventListener("pointermove", onViewportMove);
    viewport.element.removeEventListener("pointerdown", onViewportMove);
    typed.hide();
    hint.hide();
    sketchBar.closeMenu();
    // Asleep, the sketches stay drawn as finished ones: no grid, no planes to pick.
    viewport.showPlanes([]);
    const doc = ctx.project.workspaces.design as DesignDocument | undefined;
    viewport.showSketches(doc ? sketchDrawings(doc, null, placedNow, lostSketches()) : []);
    viewport.showSelection(NO_HIGHLIGHT);
    stopWatching();
  }

  // The Shape choice (U0d) does what the toolbar's shape buttons did: set_part with this shape and the boxes' sizes.
  panel.shapeChoice.addEventListener("change", () => {
    const kind = panel.shapeChoice.value as ShapeKind;
    if (kind) void run({ op: "set_part", shape: kind });
  });
  // Typing in one box is one undo step (the merge key), named for the box.
  inputs.forEach((input, i) => {
    input.addEventListener("input", () => update(shape === "sketch-extrude" && SIZE_KEYS[i] === "height" ? DISTANCE_STEP : `Change ${SIZE_KEYS[i]}`, SIZE_KEYS[i]));
    // Left (or Enter): a refused size gives way to the last one. Blur too: Firefox gives no change for a number box
    // left empty after 0 and -5 (hunt 26h, CI's browsers job).
    input.addEventListener("change", () => restoreRefused(i));
    input.addEventListener("blur", () => restoreRefused(i));
  });
  listen();
  // A new project's design starts empty (U0c, the owner's ask), never as a box made from the size boxes.
  const first = held === undefined ? update(undefined, undefined, freshDesign()) : update();
  enterSketch(); // after an Undo or Redo inside a sketch: still in it
  return {
    ready: first.then(
      () => {},
      () => {},
    ),
    sleep,
    run,
    // What the AI assistant is told before a request (25c3): the timeline as last built, and the panel's sizes, which a set_part keeps for each it leaves out.
    aiView: () => {
      const [width, depth, height] = inputs.map((i) => Number(i.value));
      return designAIView(ctx.project.workspaces.design as DesignDocument | undefined, failedNow, { width, depth, height });
    },
    // Escape clears the selection; Copy with one profile selected runs Copy as SVG (shortcuts.ts).
    shortcut(id) {
      if (!shown) return false; // the shell only asks while shown; never act asleep
      // Escape during a drag on the timeline bar calls the drag off, and only that (timeline hunt, finding 7).
      if (id === "clear-selection" && callOffDrag()) return true;
      // Escape with the Create menu open closes the menu, and only that.
      if (id === "clear-selection" && sketchBar.menuOpen) return sketchBar.closeMenu(), true;
      // Escape in the sketch tool: leaves the plane prompt, or ends the line, rectangle, circle, arc or tangent arc being drawn.
      if (id === "clear-selection" && mode.kind === "pick") return leaveSketch(), true;
      if (id === "clear-selection" && extrudeBox.shown) return leaveExtrude(), true;
      if (id === "clear-selection" && editBox.editing !== null) return leaveEdit(), true;
      if (id === "clear-selection" && mode.kind === "edit" && toolBusy(mode.tool)) {
        mode.tool = startTool(mode.tool.kind, mode.tool.sketch);
        mode.snap = null;
        toolChanges++;
        unlock();
        sketchBox.showError("");
        drawSketches();
        return true;
      }
      // L, R, C, A and T choose the line, rectangle, circle, arc and tangent arc tools while a sketch is edited; otherwise the key does what it would.
      // A digit, point or minus while a line or rectangle is part drawn starts typing its size in the first box (SF4).
      const typedKey = typedSizeKey(id);
      if (typedKey !== null) return mode.kind === "edit" && typedFields(mode.tool).length > 0 ? (typed.start(typedKey), true) : false;
      const kind = sketchToolKey(id);
      if (kind) return mode.kind === "edit" ? (chooseTool(kind), true) : false;
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
      // A build that finished while asleep was not drawn: show the document again
      // (never rebuilt from the size boxes, which would add a box to a design with
      // no body; hunt 2026-10-21). Otherwise the body is still in the viewport;
      // redraw what others may have changed.
      if (missed) return void show(designDoc(), shape);
      showSelection();
      markStale();
    },
    unmount() {
      putAwayByRestore = ctx.history.restoring();
      if (!putAwayByRestore) editingSketch = null;
      sleep();
      void bodies.close();
      viewport.showSketches([]);
      typed.element.remove();
      hint.element.remove();
      startCard.element.remove();
      if (fold) {
        foldKept = { ...FOLDED_AT_START, pinned: fold.state.pinned };
        fold.close();
      }
      for (const slot of [ctx.toolbar, ctx.browser, ctx.properties, ctx.timeline]) slot?.replaceChildren();
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
