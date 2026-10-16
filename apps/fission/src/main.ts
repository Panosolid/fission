// The app shell: one project, one kernel, one viewport, and a switcher
// between workspaces. Each workspace fills the side panel; the viewport is
// shared, so switching keeps the camera and what is on screen.
import "@fission/ui/theme.css";
import { emptyProject, historyNotBuilt, KernelClient, selectionNotBuilt, type WorkspaceId, type WorkspacePlugin } from "@fission/core";
import { showPlaceholder, workspaceSwitcher } from "@fission/ui";
import { Viewer } from "@fission/viewport";
import { communityPage } from "@fission/community";
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = $("panel");
const ctx = {
  project: emptyProject(),
  kernel: new KernelClient(),
  selection: selectionNotBuilt,
  history: historyNotBuilt,
  panel,
  viewport: new Viewer($("viewport")),
};

type Page = WorkspaceId | "community";
let hide: () => void = () => {};
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
  else showPlaceholder(panel, communityPage);
  markTab(page);
  $("community").setAttribute("aria-pressed", String(page === "community"));
  document.body.dataset.activeWorkspace = page; // read by the e2e test
  if (location.hash !== `#${page}`) history.replaceState(null, "", `#${page}`);
}

$("community").addEventListener("click", () => show("community"));
const pages: string[] = [...workspaces.map((w) => w.id), "community"];
const fromHash = (): Page => {
  const id = location.hash.slice(1);
  return pages.includes(id) ? (id as Page) : "design";
};
// Links (and back/forward) can name a workspace: #design, #slice, …
window.addEventListener("hashchange", () => show(fromHash()));
show(fromHash());
ctx.kernel.call("kernel_version").then((v) => ($("version").textContent = `kernel v${v}`));
