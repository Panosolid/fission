// The app shell: one project, one kernel, one viewport, and a switcher
// between workspaces. Each workspace fills the layout slots around the
// shared viewport (toolbar above, browser left, properties right) and
// empties them on hide; the viewport is shared, so switching keeps the
// camera and what is on screen.
import "@fission/ui/theme.css";
import { DependencyGraph, emptyProject, RepresentationRegistry, historyNotBuilt, KernelClient, createSelection, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { showPlaceholder, workspaceSwitcher } from "@fission/ui";
import { Viewer } from "@fission/viewport";
import { communityPage } from "@fission/community";
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
];

const kernel = new KernelClient();
// The one conversion layer: every workspace says what it can hand over.
const representations = new RepresentationRegistry();
for (const w of workspaces) w.registerRepresentations?.(representations, kernel);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ctx = {
  project: emptyProject(),
  kernel,
  selection: createSelection(),
  history: historyNotBuilt,
  graph: new DependencyGraph(),
  toolbar: $("toolbar"),
  browser: $("browser"),
  properties: $("properties"),
  viewport: new Viewer($("viewport")),
  representations,
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
show(fromHash());
ctx.kernel.call("kernel_version").then((v) => ($("version").textContent = `kernel v${v}`));
