// The app shell: one project, one kernel, one viewport, and a switcher
// between workspaces. Each workspace fills the layout slots around the
// shared viewport (toolbar above, browser left, properties right) and
// empties them on hide; the viewport is shared, so switching keeps the
// camera and what is on screen. Split view (X3) shows a second workspace
// beside the first, in slots of its own, with its own camera on the same
// scene and the same project and selection.
/// <reference types="vite/client" />
import "@fission/ui/theme.css";
// Every feature's own styles (src/styles/<feature>.css in packages/ui and the
// workspaces), loaded without a list, so two features never edit one file.
import.meta.glob(["../../../packages/ui/src/styles/*.css", "../../../workspaces/*/src/styles/*.css"], { eager: true });
import { ActionRegistry, DependencyGraph, DownstreamRegistry, emptyProject, projectFromJson, projectToJson, RepresentationRegistry, historyNotBuilt, KernelClient, createSelection, type SharedViewport, type WorkspaceContext, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { defaultSplit, showPlaceholder, SPLIT_MIN_WIDTH_PX, splitChoices, workspaceSwitcher } from "@fission/ui";
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
  projectChanged: () => autosave?.changed(),
  kernel,
  selection: createSelection(),
  history: historyNotBuilt,
  graph: new DependencyGraph(),
  toolbar: $("toolbar"),
  browser: $("browser"),
  properties: $("properties"),
  viewport: pane(viewer.main),
  representations,
  actions,
  downstream,
  openWorkspace: (id) => openFrom("main", id),
  workspaceTitle,
};

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

type Page = WorkspaceId | "community";
let hide: () => void = () => {};
let current: Page = "design";
const markTab = workspaceSwitcher(
  $("workspaces"),
  workspaces.map((w) => ({ id: w.id, title: w.title, summary: w.summary, placeholder: w.status === "placeholder" })),
  (id) => show(id as WorkspaceId),
);

function show(page: Page) {
  // Choosing the workspace that is in the second pane swaps the two panes.
  const swap = split?.id === page ? current : null;
  if (swap) unmountSplit();
  hide();
  hide = () => {};
  const workspace = workspaces.find((w) => w.id === page);
  if (workspace) hide = workspace.mount(ctx);
  else {
    showPlaceholder(ctx.properties, communityPage);
    hide = () => ctx.properties.replaceChildren();
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
  if (!$("assistant").hidden) showAssistant($("assistant"), page, workspace?.title ?? "Community");
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

$("community").addEventListener("click", () => show("community"));

// Split view (X3): Split (over the viewport, wide screens only) puts a
// second workspace beside the first; the choice in its pane changes which;
// Close split, or a window too narrow for two, goes back to one. The
// second workspace gets slots of its own and a pane over a second view;
// the project, selection, history and registries are the first one's.
let split: { id: WorkspaceId; view: ViewportView; viewport: SharedViewport; hide: () => void } | null = null;
const splitEntries = workspaces.map((w) => ({ id: w.id, title: w.title }));
const shownWorkspace = () => (current === "community" ? null : current);
function splitCtx(viewport: SharedViewport): WorkspaceContext {
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
    projectChanged: () => ctx.projectChanged(),
    kernel: ctx.kernel,
    selection: ctx.selection,
    history: ctx.history,
    toolbar: $("split-toolbar"),
    browser: $("split-browser"),
    properties: $("split-properties"),
    viewport,
    representations: ctx.representations,
    actions: ctx.actions,
    downstream: ctx.downstream,
    openWorkspace: (id) => openFrom("split", id),
    workspaceTitle,
  };
}
/**
 * A workspace asked to open `id` (a downstream chip's click): with a split
 * open it goes in the other pane, beside the one that asked; otherwise it
 * replaces what is shown. Already on screen: nothing changes.
 */
function openFrom(asker: "main" | "split", id: WorkspaceId) {
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
  const workspace = workspaces.find((w) => w.id === id);
  if (!workspace) return;
  if (split) unmountSplit();
  else {
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
    split = { id, view, viewport, hide: () => {} };
  }
  split!.id = id;
  split!.hide = workspace.mount(splitCtx(split!.viewport));
  document.body.dataset.split = id; // read by the e2e test
  $("split-toggle").setAttribute("aria-pressed", "true");
  fillSplitChoice();
}
function unmountSplit() {
  split?.hide();
  if (split) split.hide = () => {};
}
function closeSplit() {
  if (!split) return;
  unmountSplit();
  $("split-viewport").querySelector(".view-controls")?.remove();
  viewer.removeView(split.view);
  split = null;
  $("split").hidden = true;
  $("workspace").dataset.split = "off";
  document.body.dataset.split = "";
  $("split-toggle").setAttribute("aria-pressed", "false");
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
$("open-file").addEventListener("change", async () => {
  const input = $<HTMLInputElement>("open-file");
  const file = input.files?.[0];
  input.value = ""; // so choosing the same file again opens it again
  if (!file) return;
  try {
    const project = projectFromJson(await file.text(), workspaces);
    ctx.selection.clear(); // it named the old part's faces
    ctx.project = project;
    ctx.graph = new DependencyGraph();
    keep(newId());
    autosave?.changed(); // store the opened file as it is
    show(current); // re-mounts the workspace on the opened project
    if (split) mountSplit(split.id); // and the second one
    fileStatus("");
  } catch (e) {
    fileStatus(`Couldn't open ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
});
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
    return show(fromHash());
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
}
void start();
ctx.kernel.call("kernel_version").then((v) => ($("version").textContent = `kernel v${v}`));
