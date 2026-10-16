// The app shell: one project, one kernel, one viewport, and a switcher
// between workspaces. Each workspace fills the layout slots around the
// shared viewport (toolbar above, browser left, properties right); the
// viewport is shared, so switching keeps the camera and what is on screen.
// Workspaces stay warm (X7): each gets slots of its own the first time it is
// shown in a pane, and switching swaps whole slots in and out and puts the
// workspace to sleep or wakes it, so a switch rebuilds nothing. Split view (X3) shows a second workspace
// beside the first, in slots of its own, with its own camera on the same
// scene and the same project and selection. Change notes (X5) show over
// each pane's viewport, for the workspace in that pane.
/// <reference types="vite/client" />
import "@fission/ui/theme.css";
// Every feature's own styles (src/styles/<feature>.css in packages/ui and the
// workspaces), loaded without a list, so two features never edit one file.
import.meta.glob(["../../../packages/ui/src/styles/*.css", "../../../workspaces/*/src/styles/*.css"], { eager: true });
import { ActionRegistry, CLIPBOARD_CHORDS, chordLabel, chordOf, SHELL_SHORTCUTS, ShortcutTable, type Chord, ChangeNotes, DependencyGraph, DownstreamRegistry, emptyProject, HEAD_BYTES, projectFromJson, routeFiles, projectToJson, RepresentationRegistry, createHistory, KernelClient, createSelection, type ChangeNote, type MountedWorkspace, type SharedViewport, type WorkspaceContext, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { changeNote, shortcutList, defaultSplit, showPlaceholder, SPLIT_MIN_WIDTH_PX, splitChoices, WarmPool, workspaceSwitcher } from "@fission/ui";
import { paneViewports, Viewer, type ViewportView } from "@fission/viewport";
import { communityPage } from "@fission/community";
import { localStore, startAutosave, type Autosave, type AutosaveStatus } from "@fission/storage";
import { showAssistant } from "./assistant.ts";
import { designWorkspace } from "@fission/design";
import { renderWorkspace } from "@fission/render";
import { simulateWorkspace } from "@fission/simulate";
import { manufactureWorkspace } from "@fission/manufacture";
import { laserWorkspace } from "@fission/laser";
import { sliceWorkspace } from "@fission/slice";
import { circuitWorkspace } from "@fission/circuit";
import { vectorWorkspace } from "@fission/vector";
import { imageWorkspace } from "@fission/image";
import { layoutWorkspace } from "@fission/layout";

const workspaces: WorkspacePlugin[] = [
  designWorkspace,
  renderWorkspace,
  simulateWorkspace,
  manufactureWorkspace,
  laserWorkspace,
  sliceWorkspace,
  circuitWorkspace,
  vectorWorkspace,
  imageWorkspace,
  layoutWorkspace,
];

const kernel = new KernelClient();
// The one conversion layer: every workspace says what it can hand over.
const representations = new RepresentationRegistry();
for (const w of workspaces) w.registerRepresentations?.(representations, kernel);
// The shell opens whole projects, dropped or pasted like any other file (X6).
representations.registerImporter({ formats: ["project"], workspace: null, open: async (_name, bytes) => openProject(new TextDecoder().decode(bytes)) });
// The one action registry: the verbs each workspace offers for a selection.
const actions = new ActionRegistry();
for (const w of workspaces) w.registerActions?.(actions);
// The one downstream registry: what each workspace makes from the design (Design shows them as chips).
const downstream = new DownstreamRegistry();
for (const w of workspaces) w.registerDownstream?.(downstream);
const workspaceTitle = (id: WorkspaceId) => workspaces.find((w) => w.id === id)?.title ?? id;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// The one viewer (one scene); each workspace on screen sees it through a
// pane of its own: its own camera, the viewer's body, selection and picks.
const viewer = new Viewer($("viewport"));
const pane = paneViewports(viewer);
const ctx: WorkspaceContext = {
  project: emptyProject(),
  projectChanged: (label, mergeKey) => projectChanged(label, mergeKey),
  kernel,
  selection: createSelection(),
  history: null!, // created just below: it captures the project as it starts
  graph: new DependencyGraph(),
  // The page's first slots; each workspace gets slots of its own (paneCtx, X7).
  toolbar: $("toolbar"),
  browser: $("browser"),
  properties: $("properties"),
  viewport: pane(viewer.main),
  representations,
  actions,
  downstream,
  changeNotes: new ChangeNotes(),
  openWorkspace: (id) => openFrom("main", id),
  workspaceTitle,
};

// The one undo history (step 20): whole-project snapshots, put back the way
// a file is opened, then every workspace on screen is mounted afresh on it.
ctx.history = createHistory({ capture: () => projectToJson(ctx.project), restore: restoreSnapshot });
/** Mounts in progress: a change a workspace makes while being mounted is a default filled in, not an undo step. */
let mounting = 0;
function projectChanged(label = "Edit", mergeKey?: string) {
  autosave?.changed();
  if (mounting === 0) ctx.history.record(label, mergeKey);
}
/** Runs a show or mount; once the last one ends, takes whatever defaults the workspaces filled in into the present undo step. */
function mountingDone<T>(run: () => T): T {
  mounting++;
  try {
    return run();
  } finally {
    if (--mounting === 0) ctx.history.amend(); // ignored while an undo is putting a snapshot back
  }
}
/** Puts an undo snapshot back: read like an opened file, so a snapshot that doesn't read cleanly leaves everything as it was. */
function restoreSnapshot(text: string) {
  const project = projectFromJson(text, workspaces);
  ctx.project = project;
  pool.forgetAll(); // every warm workspace showed the project as it was
  show(current);
  if (split) mountSplit(split.id);
  autosave?.changed();
}

// The View group: the shell owns each pane's view buttons, over its
// viewport's corner. Fit frames the selection when there is one (from the
// current direction), else the whole body from home.
function viewControls(viewport: SharedViewport): HTMLElement {
  const group = document.createElement("div");
  group.className = "view-controls";
  group.setAttribute("role", "toolbar");
  group.setAttribute("aria-label", "View");
  const views = [
    ["home", "Home", "Three-quarter view of the whole body"],
    ["top", "Top", "Look down on the body"],
    ["front", "Front", "Look at the body from the front"],
    ["right", "Right", "Look at the body from the right"],
  ] as const;
  for (const [name, label, title] of views) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title });
    b.dataset.view = name;
    b.addEventListener("click", () => viewport.setView(name));
    group.append(b);
  }
  const fit = Object.assign(document.createElement("button"), { type: "button", textContent: "Fit", title: "Frame the selection, or the whole body when nothing is selected" });
  fit.dataset.view = "fit";
  fit.addEventListener("click", () => viewport.fitSelection() ?? viewport.fit());
  group.append(fit);
  viewport.element.append(group);
  return group;
}
viewControls(ctx.viewport).id = "view-controls";

// What is selected, read by the e2e test (17d draws it on screen).
ctx.selection.onChange((items) => (document.body.dataset.selection = items.map((r) => r.id).join(" ")));

// Change notes (X5): a strip over each pane's viewport shows the notes about
// the workspace in that pane (docs/integration.md, principle 9), redrawn
// after every change to the graph or the notes; × dismisses one. Notes
// about a workspace not on screen wait until it is shown.
function notesStrip(host: HTMLElement): HTMLElement {
  const strip = Object.assign(document.createElement("div"), { className: "notes-strip" });
  strip.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-dismiss]")?.dataset.dismiss;
    if (id) ctx.changeNotes.dismiss(id);
  });
  host.append(strip);
  return strip;
}
const notesStrips = { main: notesStrip($("viewport")), split: notesStrip($("split-viewport")) };
notesStrips.split.classList.add("in-split"); // below the split bar
const drawn = new WeakMap<HTMLElement, string>();
/** Draws `notes` in `strip`, keeping open any "Why?" the user opened; nothing changes when nothing would. */
function drawNotes(strip: HTMLElement, notes: ChangeNote[]) {
  const html = notes.map(changeNote).join("");
  if (drawn.get(strip) === html) return;
  const open = [...strip.querySelectorAll("details[open]")].map((d) => d.closest<HTMLElement>("[data-note]")!.dataset.note!);
  strip.innerHTML = html;
  drawn.set(strip, html);
  for (const id of open) strip.querySelector(`[data-note="${CSS.escape(id)}"] details`)?.setAttribute("open", "");
}
let notesQueued = false;
/** Redraws both strips once the current change is finished (a Design edit changes the graph several times, then records). */
function showNotes() {
  if (notesQueued) return;
  notesQueued = true;
  queueMicrotask(() => {
    notesQueued = false;
    const notes = ctx.changeNotes.current(ctx.graph);
    drawNotes(notesStrips.main, notes.filter((n) => n.workspace === current));
    drawNotes(notesStrips.split, notes.filter((n) => n.workspace === split?.id));
  });
}
let stopWatching = () => {};
/** The graph and notes of the project now open; the strips follow both. */
function useGraph(graph: DependencyGraph, notes: ChangeNotes) {
  stopWatching();
  ctx.graph = graph;
  ctx.changeNotes = notes;
  const stops = [graph.onChange(showNotes), notes.onChange(showNotes)];
  stopWatching = () => stops.forEach((stop) => stop());
  showNotes();
}
useGraph(ctx.graph, ctx.changeNotes);
// For the browser test only (?test-hooks): the graph and notes, so it can
// stand in a result in another workspace before any workspace makes one.
if (new URLSearchParams(location.search).has("test-hooks"))
  Object.assign(window, {
    fissionTest: {
      get graph() {
        return ctx.graph;
      },
      get notes() {
        return ctx.changeNotes;
      },
    },
  });

type Page = WorkspaceId | "community";
let current: Page = "design";

// Warm workspaces (X7). Each pane has three slots, found by id
// (#toolbar or #split-toolbar…); a workspace mounted in a pane gets three
// elements of its own that take the slots' place in the page while it is
// shown (same id, role and label, so the layout and :empty rules apply
// unchanged). Asleep, its elements are out of the page, kept as they are.
type PaneId = "main" | "split";
type Slots = Pick<WorkspaceContext, "toolbar" | "browser" | "properties">;
const SLOT_IDS: Record<PaneId, Record<keyof Slots, string>> = {
  main: { toolbar: "toolbar", browser: "browser", properties: "properties" },
  split: { toolbar: "split-toolbar", browser: "split-browser", properties: "split-properties" },
};
/** Puts `slots` in the page in place of whatever fills `pane`'s slots now. */
function placeSlots(pane: PaneId, slots: Slots) {
  for (const key of ["toolbar", "browser", "properties"] as const) {
    const now = $(SLOT_IDS[pane][key]);
    if (now !== slots[key]) now.replaceWith(slots[key]);
  }
}
/** Three empty slots shaped like `pane`'s (an element's attributes, no children). */
const emptySlots = (pane: PaneId): Slots => ({
  toolbar: $(SLOT_IDS[pane].toolbar).cloneNode(false) as HTMLElement,
  browser: $(SLOT_IDS[pane].browser).cloneNode(false) as HTMLElement,
  properties: $(SLOT_IDS[pane].properties).cloneNode(false) as HTMLElement,
});
const pool = new WarmPool<WorkspaceId, PaneId, { slots: Slots; view: MountedWorkspace }>({
  mount(pane, id) {
    const slots = emptySlots(pane);
    placeSlots(pane, slots);
    const view = workspaces.find((w) => w.id === id)!.mount(paneCtx(pane, slots));
    return { slots, view };
  },
  sleep(pane, _id, { view }) {
    view.sleep?.();
    placeSlots(pane, emptySlots(pane));
  },
  wake(pane, _id, { slots, view }) {
    placeSlots(pane, slots);
    view.wake?.();
  },
  unmount: (_pane, _id, { view }) => view.unmount(), // asleep: its slots are already out of the page
});
const markTab = workspaceSwitcher(
  $("workspaces"),
  workspaces.map((w) => ({ id: w.id, title: w.title, summary: w.summary, placeholder: w.status === "placeholder" })),
  (id) => show(id as WorkspaceId),
);

function show(page: Page) {
  mountingDone(() => showPage(page));
}
function showPage(page: Page) {
  // Choosing the workspace that is in the second pane swaps the two panes.
  const swap = split?.id === page ? current : null;
  const workspace = workspaces.find((w) => w.id === page);
  if (workspace) pool.show("main", workspace.id);
  else {
    pool.hide("main"); // empty slots in its place
    showPlaceholder($("properties"), communityPage);
  }
  markTab(page);
  $("community").setAttribute("aria-pressed", String(page === "community"));
  document.body.dataset.activeWorkspace = page; // read by the e2e test
  current = page;
  if (swap) {
    if (swap === "community") closeSplit();
    else mountSplit(swap);
  }
  if (split) fillSplitChoice();
  showNotes();
  if (!$("assistant").hidden) showAssistant($("assistant"), page, workspace?.title ?? "Community");
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

$("community").addEventListener("click", () => show("community"));

// Split view (X3): Split (over the viewport, wide screens only) puts a
// second workspace beside the first; the choice in its pane changes which;
// Close split, or a window too narrow for two, goes back to one. The
// second workspace gets slots of its own and a pane over a second view;
// the project, selection, history and registries are the first one's.
let split: { id: WorkspaceId; view: ViewportView; viewport: SharedViewport } | null = null;
const splitEntries = workspaces.map((w) => ({ id: w.id, title: w.title }));
const shownWorkspace = () => (current === "community" ? null : current);
/** What a workspace in `pane` sees: its own slots and that pane's viewport; the project, selection, history and registries are the one set. */
function paneCtx(pane: PaneId, slots: Slots): WorkspaceContext {
  return {
    get project() {
      return ctx.project;
    },
    set project(p) {
      ctx.project = p;
    },
    get graph() {
      return ctx.graph;
    },
    set graph(g) {
      ctx.graph = g;
    },
    get changeNotes() {
      return ctx.changeNotes;
    },
    set changeNotes(n) {
      ctx.changeNotes = n;
    },
    projectChanged: (label, mergeKey) => ctx.projectChanged(label, mergeKey),
    kernel: ctx.kernel,
    selection: ctx.selection,
    history: ctx.history,
    ...slots,
    viewport: pane === "main" ? ctx.viewport : split!.viewport,
    representations: ctx.representations,
    actions: ctx.actions,
    downstream: ctx.downstream,
    openWorkspace: (id) => openFrom(pane, id),
    workspaceTitle,
  };
}
/**
 * A workspace asked to open `id` (a downstream chip's click): with a split
 * open it goes in the other pane, beside the one that asked; otherwise it
 * replaces what is shown. Already on screen: nothing changes.
 */
function openFrom(asker: PaneId, id: WorkspaceId) {
  if (id === current || id === split?.id) return;
  if (split && asker === "main") mountSplit(id);
  else show(id);
}
function fillSplitChoice() {
  const select = $<HTMLSelectElement>("split-choice");
  select.replaceChildren(...splitChoices(splitEntries, shownWorkspace()).map((e) => new Option(e.title, e.id, false, e.id === split?.id)));
}
/** Shows workspace `id` in the second pane, opening the split if it is closed (the camera of an open one stays). */
function mountSplit(id: WorkspaceId) {
  mountingDone(() => mountSplitPane(id));
}
function mountSplitPane(id: WorkspaceId) {
  const workspace = workspaces.find((w) => w.id === id);
  if (!workspace) return;
  if (!split) {
    $("split").hidden = false;
    $("workspace").dataset.split = "on";
    const view = viewer.addView($("split-viewport"));
    const viewport = pane(view);
    viewControls(viewport);
    // The new view framed the body at home before the grid had settled its
    // size; frame it again once it has (the view's own resize runs first,
    // as its observer was registered first).
    const settled = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0 || split?.view !== view) return;
      settled.disconnect();
      view.fit();
    });
    settled.observe($("split-viewport"));
    split = { id, view, viewport };
  }
  split!.id = id;
  pool.show("split", id);
  document.body.dataset.split = id; // read by the e2e test
  $("split-toggle").setAttribute("aria-pressed", "true");
  fillSplitChoice();
  showNotes();
}
function closeSplit() {
  if (!split) return;
  activePane = "main";
  pool.forgetPane("split"); // its viewport goes
  $("split-viewport").querySelector(".view-controls")?.remove();
  viewer.removeView(split.view);
  split = null;
  $("split").hidden = true;
  $("workspace").dataset.split = "off";
  document.body.dataset.split = "";
  $("split-toggle").setAttribute("aria-pressed", "false");
  showNotes();
}
{
  const toggle = Object.assign(document.createElement("button"), { id: "split-toggle", type: "button", textContent: "Split", title: "Show a second workspace beside this one" });
  toggle.setAttribute("aria-pressed", "false");
  toggle.addEventListener("click", () => {
    if (split) return closeSplit();
    const id = defaultSplit(splitEntries, shownWorkspace())?.id;
    if (id) mountSplit(id);
  });
  $("viewport").append(toggle);
  $("split-choice").addEventListener("change", () => mountSplit($<HTMLSelectElement>("split-choice").value as WorkspaceId));
  $("split-close").addEventListener("click", () => {
    closeSplit();
    toggle.focus();
  });
  $("workspace").dataset.split = "off";
  const wide = matchMedia(`(min-width: ${SPLIT_MIN_WIDTH_PX}px)`);
  wide.addEventListener("change", () => {
    if (!wide.matches) closeSplit();
  });
}

// At phone width Save, Open, AI and Community fold behind Menu (theme.css),
// leaving the top bar's row to the workspace tabs. Choosing one, Escape or
// a tap anywhere else closes it; Escape puts focus back on Menu.
{
  const toggle = $("menu-toggle");
  const setMenu = (open: boolean) => {
    toggle.setAttribute("aria-expanded", String(open));
    $("topbar").dataset.menu = open ? "open" : "closed";
  };
  setMenu(false);
  toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
  $("topbar-actions").addEventListener("click", () => setMenu(false)); // after the chosen button's own handler
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || toggle.getAttribute("aria-expanded") !== "true") return;
    setMenu(false);
    toggle.focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Node) || toggle.contains(e.target) || $("topbar-actions").contains(e.target)) return;
    setMenu(false);
  });
}

// Autosave (19c): the project is kept in this browser and saved a moment
// after each change; the top bar says "Saving…", "Saved" or what went wrong.
// Each project has its own stored id: an opened file becomes a new stored
// project rather than overwriting the one that was open.
const store = localStore(workspaces);
let autosave: Autosave | null = null;
const saveStatus = (s: AutosaveStatus) => {
  const el = $("save-status");
  el.dataset.state = s.state; // read by the e2e test
  el.textContent = s.state === "saving" ? "Saving…" : s.state === "saved" ? "Saved" : `Not saved: ${s.message}`;
  el.title = el.textContent; // the words behind the mark at phone width
};
const newId = () => globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
/** False once the browser has shown it can't keep projects: then nothing autosaves, and Save/Open use files. */
let canKeep = true;
function keep(id: string) {
  autosave?.stop();
  if (!canKeep) return;
  autosave = startAutosave(store, id, () => ctx.project, saveStatus);
  document.body.dataset.projectId = id; // read by the e2e test
}

// Save and Open: the whole project, every workspace's data, as one
// .fission.json file (docs/project-format.md). Opening replaces the project
// only once all of it has read cleanly; a refused file leaves the open
// project as it was and says why.
const fileStatus = (message: string) => ($("file-status").textContent = message);
$("file-dismiss").addEventListener("click", () => fileStatus(""));
$("save").addEventListener("click", () => {
  try {
    const url = URL.createObjectURL(new Blob([projectToJson(ctx.project)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${ctx.project.name.replace(/[\\/:*?"<>|]/g, "-") || "Untitled"}.fission.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    fileStatus("");
  } catch (e) {
    fileStatus(e instanceof Error ? e.message : String(e));
  }
});
$("open").addEventListener("click", () => $("open-file").click());
/** Replaces the open project with the one in `text`; throws, leaving the open project as it was, when it doesn't read cleanly. */
function openProject(text: string) {
  const project = projectFromJson(text, workspaces);
  ctx.selection.clear(); // it named the old part's faces
  ctx.project = project;
  useGraph(new DependencyGraph(), new ChangeNotes()); // the old notes were about the old project
  keep(newId());
  autosave?.changed(); // store the opened file as it is
  pool.forgetAll(); // every warm workspace showed the old project
  show(current); // mounts the workspace on the opened project
  if (split) mountSplit(split.id); // and the second one
  ctx.history.reset(); // a new start: nothing from the old project to undo
  fileStatus("");
}
$("open-file").addEventListener("change", async () => {
  const input = $<HTMLInputElement>("open-file");
  const file = input.files?.[0];
  input.value = ""; // so choosing the same file again opens it again
  if (!file) return;
  try {
    openProject(await file.text());
  } catch (e) {
    fileStatus(`Couldn't open ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
});

// Files from outside (X6): a file dropped anywhere on the app, or pasted
// (outside a text field), goes through the representation registry: a
// project opens as Open does, a PNG or JPEG opens in Image, and anything
// else is refused in the top bar with what will take it and when.
async function receive(files: File[]) {
  const heads = await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, head: new Uint8Array(await f.slice(0, HEAD_BYTES).arrayBuffer()) })));
  const route = routeFiles(representations, heads);
  if (!route) return;
  if (route.kind === "refused") return fileStatus(route.message);
  const file = files[0];
  try {
    await route.importer.open(file.name, new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return fileStatus(`Couldn't open “${file.name}”: ${e instanceof Error ? e.message : String(e)}`);
  }
  fileStatus("");
  const into = route.importer.workspace;
  if (!into) return; // the shell itself (a project) has already shown it
  pool.forget(into); // mounted afresh, to show what it opened
  if (split?.id === into) mountSplit(into); // where it already is
  else show(into);
}
const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
const dropHint = (on: boolean) => {
  document.body.dataset.drop = on ? "on" : ""; // read by the e2e test
  $("workspace").classList.toggle("file-drop", on); // the outline (styles/file-drop.css)
};
window.addEventListener("dragover", (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault(); // allows the drop
  e.dataTransfer!.dropEffect = "copy";
  dropHint(true);
});
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget === null) dropHint(false); // left the window
});
window.addEventListener("drop", (e) => {
  if (!carriesFiles(e)) return;
  e.preventDefault(); // never let the browser navigate to the file
  dropHint(false);
  void receive([...e.dataTransfer!.files]);
});

// One shortcut table (X7b): the shell's keys and every workspace's. A key
// goes to the workspace in the pane last clicked or focused, then the other
// one on screen, then the shell; a sleeping workspace never hears one.
// Copy, cut and paste come from the clipboard events, so the browser's Edit
// menu runs them too. Keys are left alone while typing in a field, unless a
// shortcut says otherwise.
const shortcuts = new ShortcutTable(SHELL_SHORTCUTS, workspaces);
for (const c of shortcuts.clashes()) console.error(`Shortcut clash: ${c.message}`); // a unit test keeps this empty
let activePane: PaneId = "main";
for (const type of ["pointerdown", "focusin"] as const)
  document.addEventListener(type, (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest("#split")) activePane = "split";
    else if (e.target.closest("#workspace")) activePane = "main";
  }, true);
/** The panes showing a workspace, the one in use first. */
const panesInUse = (): PaneId[] => (activePane === "split" ? ["split", "main"] : ["main", "split"]).filter((p): p is PaneId => pool.showing(p as PaneId) !== null);
const inText = (t: EventTarget | null) => t instanceof Element && t.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])") !== null;
const shellShortcuts: Record<string, (e: Event) => boolean> = {
  shortcuts: () => (showShortcuts(), true),
  undo: () => (undoRedo("undo"), true),
  redo: () => (undoRedo("redo"), true),
  "redo-y": () => (undoRedo("redo"), true),
  "paste-files": (e) => {
    const files = [...((e as ClipboardEvent).clipboardData?.files ?? [])];
    if (files.length === 0) return false; // text pastes as usual
    void receive(files);
    return true;
  },
};
function runShortcut(chord: Chord, e: Event) {
  if (shortcutDialog.open) return; // the list is modal: Escape closes it, nothing else runs
  const panes = panesInUse();
  const entry = shortcuts.lookup(chord, panes.map((p) => pool.showing(p)!));
  if (!entry || (!entry.inText && inText(e.target))) return;
  const done = entry.scope === "app" ? shellShortcuts[entry.id]?.(e) : pool.awake(panes.find((p) => pool.showing(p) === entry.scope)!)?.view.shortcut?.(entry.id, e);
  if (done !== false && done !== undefined) e.preventDefault();
}
const clipboardChords = new Set<string>(Object.values(CLIPBOARD_CHORDS));
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const chord = chordOf(e);
  if (chord && !clipboardChords.has(chord)) runShortcut(chord, e);
});
for (const type of ["copy", "cut", "paste"] as const) document.addEventListener(type, (e) => runShortcut(CLIPBOARD_CHORDS[type], e));
// The list of every key (?), the workspaces on screen first. No top-bar button:
// the bar has no room left for one at 1280 px (the wide-screen smoke check).
const shortcutDialog = Object.assign(document.createElement("dialog"), { id: "shortcuts", className: "shortcut-list" });
shortcutDialog.setAttribute("aria-labelledby", "shortcuts-title");
document.body.append(shortcutDialog);
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
function showShortcuts() {
  const groups = shortcuts.help(panesInUse().map((p) => pool.showing(p)!)).map((g) => ({
    title: g.scope === "app" ? "Everywhere" : workspaceTitle(g.scope),
    onScreen: g.onScreen,
    rows: g.entries.map((e) => ({ keys: chordLabel(e.chord, mac), label: e.label })),
  }));
  shortcutDialog.innerHTML = `<header><h2 id="shortcuts-title">Keyboard shortcuts</h2><button type="button" class="close">Close</button></header>${shortcutList(groups)}`;
  shortcutDialog.querySelector(".close")!.addEventListener("click", () => shortcutDialog.close());
  shortcutDialog.showModal();
}
// Undo and Redo (step 20b): the top bar's buttons and the keys above. Each
// button says what it would take back or do again, and is off when there is
// nothing; a snapshot that can't be put back says why and moves nothing.
function undoRedo(which: "undo" | "redo") {
  try {
    ctx.history[which]();
  } catch (e) {
    return fileStatus(`Couldn't ${which}: ${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.history.amend(); // defaults the remounted workspaces filled in
}
function showUndoRedo() {
  const buttons = [
    ["undo", "Undo", ctx.history.undoLabel(), "Mod+Z"],
    ["redo", "Redo", ctx.history.redoLabel(), "Mod+Shift+Z"],
  ] as const;
  for (const [id, verb, label, chord] of buttons) {
    const b = $<HTMLButtonElement>(id);
    b.disabled = label === null;
    b.title = label === null ? `Nothing to ${id}` : `${verb} ${label} (${chordLabel(chord, mac)})`;
  }
}
$("undo").addEventListener("click", () => undoRedo("undo"));
$("redo").addEventListener("click", () => undoRedo("redo"));
ctx.history.onChange(showUndoRedo);
showUndoRedo();
// One assistant panel for every workspace, beside the viewport.
$("assistant-toggle").addEventListener("click", () => {
  const panel = $("assistant");
  panel.hidden = !panel.hidden;
  $("assistant-toggle").setAttribute("aria-pressed", String(!panel.hidden));
  if (!panel.hidden) showAssistant(panel, current, workspaces.find((w) => w.id === current)?.title ?? "Community");
});
// At phone width the browser and properties fold away behind two toggles
// (theme.css hides a closed one there); wider screens hide the toggles and
// show both panels. The state lives on #workspace, so it survives switching.
for (const slot of ["browser", "properties"] as const) {
  const toggle = $(`${slot}-toggle`);
  const set = (open: boolean) => {
    toggle.setAttribute("aria-expanded", String(open));
    $("workspace").dataset[slot] = open ? "open" : "closed";
  };
  set(toggle.getAttribute("aria-expanded") === "true");
  toggle.addEventListener("click", () => set(toggle.getAttribute("aria-expanded") !== "true"));
}
const pages: string[] = [...workspaces.map((w) => w.id), "community"];
const fromHash = (): Page => {
  const id = location.hash.slice(1);
  return pages.includes(id) ? (id as Page) : "design";
};
// Links (and back/forward) can name a workspace: #design, #slice, …
window.addEventListener("hashchange", () => show(fromHash()));
// Start on the project saved most recently in this browser, or a new one.
// One that can't be read is left stored as it is, and a new project starts
// with a message saying so; a browser that can't keep projects at all still
// gets a working app (Save and Open use files). Never a blank app.
async function start() {
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let newest: string | undefined;
  try {
    newest = (await store.list())[0]?.id;
  } catch (e) {
    canKeep = false;
    fileStatus(`Projects can't be kept in this browser (${why(e)}). Use Save to keep your work as a file.`);
    show(fromHash());
    return ctx.history.reset();
  }
  try {
    if (newest) {
      ctx.project = await store.open(newest);
      keep(newest);
      saveStatus({ state: "saved" });
    } else keep(newId());
  } catch (e) {
    keep(newId());
    fileStatus(`Couldn't open the last project (${why(e)}), so a new one was started. The old one is still kept in this browser.`);
  }
  show(fromHash());
  ctx.history.reset(); // the project as it opened is the start
}
void start();
ctx.kernel.call("kernel_version").then((v) => {
  $("version").textContent = `kernel v${v}`;
  $("version").parentElement!.title = `Fission, kernel v${v}`; // where the version shows when the bar has no room for it
});
