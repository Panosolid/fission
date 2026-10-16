// The app shell: one project, one kernel, one viewport, and a switcher
// between workspaces. Each workspace fills the layout slots around the
// shared viewport (toolbar above, browser left, properties right) and
// empties them on hide; the viewport is shared, so switching keeps the
// camera and what is on screen.
import "@fission/ui/theme.css";
import { ActionRegistry, DependencyGraph, emptyProject, projectFromJson, projectToJson, RepresentationRegistry, historyNotBuilt, KernelClient, createSelection, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { showPlaceholder, workspaceSwitcher } from "@fission/ui";
import { Viewer } from "@fission/viewport";
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ctx = {
  project: emptyProject(),
  projectChanged: () => autosave?.changed(),
  kernel,
  selection: createSelection(),
  history: historyNotBuilt,
  graph: new DependencyGraph(),
  toolbar: $("toolbar"),
  browser: $("browser"),
  properties: $("properties"),
  viewport: new Viewer($("viewport")),
  representations,
  actions,
};

// The View group: the viewport is shared, so the shell owns its view
// buttons, over the viewport's corner. Fit frames the selection when there
// is one (from the current direction), else the whole body from home.
{
  const group = document.createElement("div");
  group.id = "view-controls";
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
    b.addEventListener("click", () => ctx.viewport.setView(name));
    group.append(b);
  }
  const fit = Object.assign(document.createElement("button"), { type: "button", textContent: "Fit", title: "Frame the selection, or the whole body when nothing is selected" });
  fit.dataset.view = "fit";
  fit.addEventListener("click", () => ctx.viewport.fitSelection() ?? ctx.viewport.fit());
  group.append(fit);
  $("viewport").append(group);
}

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
  if (!$("assistant").hidden) showAssistant($("assistant"), page, workspace?.title ?? "Community");
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

$("community").addEventListener("click", () => show("community"));

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
