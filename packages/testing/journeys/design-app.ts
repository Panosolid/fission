// The app around Design for journeys in the real workspace (from step
// 25a3's Edit Sketch journey, shared from 25a4): Design mounted as the app
// mounts it, in a real DOM (happy-dom), on one undo history that puts
// snapshots back by mounting it afresh (the shell's way), on the real WASM
// kernel; the viewport is a stand-in that keeps the last mesh and the last
// selection highlight it was asked to draw. Not a journey itself.
import assert from "node:assert/strict";
import { ActionRegistry, ChangeNotes, createHistory, createSelection, DependencyGraph, DownstreamRegistry, emptyProject, projectFromJson, projectToJson, RepresentationRegistry, type DisplayMesh, type KernelCalls, type MountedWorkspace, type OriginPlane, type Plane, type SharedViewport, type SketchDrawing, type SketchPointer, type ViewportHighlight, type ViewportPick, type WorkspaceContext, type WorkspacePlugin } from "@fission/core";
import { designWorkspace, type DesignDocument } from "@fission/design";
import { nodeKernel } from "../src/node-kernel.ts";

export const kernel = nodeKernel();
const { Window } = await import("happy-dom");

/** The volume inside a closed mesh, from its triangles: Σ a · (b × c) / 6 (each body's triangles face outward, so bodies side by side add up). */
export function meshVolume(mesh: DisplayMesh): number {
  const p = mesh.positions;
  const at = (i: number) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  let six = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [at(mesh.indices[t]), at(mesh.indices[t + 1]), at(mesh.indices[t + 2])];
    six += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return six / 6;
}

/** Equal to a millionth: the kernel's meshes of flat-sided bodies are exact up to rounding. */
export const close = (got: number, want: number) => Math.abs(got - want) <= 1e-6 * Math.max(1, Math.abs(want));

/**
 * The app around Design, as the shell runs it: slots in a real DOM, one
 * undo history over the project as JSON whose restore mounts the
 * workspace afresh, a viewport that keeps the last mesh, and a kernel that
 * counts its body_build calls. `plugin` is Design, or a planted copy.
 */
/** The app last made, put away before the next is made: a test that failed part way leaves it mounted, and Design keeps the open sketch in its module. */
let previous: { close(): Promise<boolean> } | null = null;

export async function app(start: DesignDocument, plugin: WorkspacePlugin = designWorkspace) {
  await previous?.close();
  const window = new Window({ width: 1280, height: 800 });
  const document = window.document as unknown as Document;
  const slot = () => {
    const el = document.createElement("div") as HTMLElement;
    document.body.append(el);
    return el;
  };
  let mesh: DisplayMesh | null = null;
  let highlight: ViewportHighlight = { body: false, faces: [], edges: [] };
  let builds = 0;
  // What Create sketch offered (step 26d), each Look At asked for, and the sketches last drawn.
  let planes: { planes: readonly OriginPlane[]; faces: readonly number[] } = { planes: [], faces: [] };
  const looks: { plane: Plane; side: 1 | -1 }[] = [];
  let drawings: readonly SketchDrawing[] = [];
  const counted: KernelCalls = {
    call: ((op: string, ...args: unknown[]) => {
      if (op === "body_build") builds++;
      return (kernel.call as (op: string, ...a: unknown[]) => Promise<unknown>)(op, ...args);
    }) as KernelCalls["call"],
  };
  const element = slot();
  const viewport: SharedViewport = {
    element,
    showBody: (m) => void (mesh = m),
    bodyFraming: () => ({ centre: [0, 0, 0], radius: 0 }),
    fit: () => null,
    setView: () => null,
    fitSelection: () => null,
    lookAt: (plane, side = 1) => (looks.push({ plane, side }), null),
    setOverlay() {},
    clearOverlay() {},
    showSelection: (h) => void (highlight = h),
    onPick: null,
    onSketchPointer: null,
    showImage() {},
    clearImage() {},
    showSketches: (d) => void (drawings = d),
    showPlanes: (p, faces = []) => void (planes = { planes: p, faces }),
  };
  let view: MountedWorkspace;
  let mounting = false;
  const mount = () => {
    mounting = true;
    try {
      view = plugin.mount(ctx);
    } finally {
      mounting = false;
    }
  };
  const ctx: WorkspaceContext = {
    project: { ...emptyProject("Edit Sketch"), workspaces: { design: start } },
    projectChanged(label = "Edit", mergeKey) {
      if (!mounting) history.record(label, mergeKey);
    },
    kernel: counted,
    selection: createSelection(),
    history: undefined as never,
    graph: new DependencyGraph(),
    toolbar: slot(),
    browser: slot(),
    properties: slot(),
    timeline: slot(),
    viewport,
    representations: new RepresentationRegistry(),
    actions: new ActionRegistry(),
    downstream: new DownstreamRegistry(),
    changeNotes: new ChangeNotes(),
    openWorkspace() {},
    workspaceTitle: (id) => id,
  };
  // The shell's restore: the snapshot read like an opened file, the workspace mounted afresh on it.
  const history = createHistory({
    capture: () => projectToJson(ctx.project),
    restore(text) {
      ctx.project = projectFromJson(text, [plugin]);
      view.unmount();
      mount();
    },
  });
  ctx.history = history;
  const startBodies = (await kernel.call("body_count")) as number;
  mount();
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  /** Every reply the kernel owes, and every rebuild, finished. */
  const settle = async () => {
    for (let i = 0; i < 40 || element.dataset.rebuilding === "true"; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  const a = {
    history,
    window,
    $,
    settle,
    doc: () => ctx.project.workspaces.design as DesignDocument,
    volume: () => (mesh ? meshVolume(mesh) : 0),
    /** The last mesh drawn, and the last selection highlight on it (joined face and edge numbers). */
    mesh: () => mesh,
    highlight: () => highlight,
    selection: ctx.selection,
    /** The properties panel's note on what a rebuild took out of the selection ("" when hidden). */
    note: () => ($("#selection-note")!.hidden ? "" : $("#selection-note")!.textContent),
    builds: () => builds,
    /** The sketch bar's Finish Sketch is on screen: a sketch is open. */
    sketching: () => $("#finish-sketch") !== null && $("#finish-sketch")!.closest("[hidden]") === null,
    warning: () => ($("#kept-warning")!.hidden ? null : $("#kept-warning")!.textContent),
    error: () => $("#error")!.textContent,
    /** Item `id`'s menu by a right-click on its bar item, then an entry. */
    async menu(id: string, entry: string) {
      $(`[data-item="${id}"]`)!.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 780 }) as unknown as Event);
      const button = $(`#row-menu-${entry}`) as HTMLButtonElement;
      assert.ok(button, `the menu has ${entry}`);
      // An off entry is greyed (disabled): a click on it does nothing, as in a browser.
      if (button.disabled) {
        $("#row-menu")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
        (button.closest("dialog") as HTMLDialogElement | null)?.close();
        return button.title;
      }
      button.click();
      await settle();
      return null;
    },
    /** A double-click on bar item `id` (two clicks 100 ms apart, the bar drawn again between them as a pick does). */
    async doubleClick(id: string) {
      for (const t of [1000, 1100]) {
        const e = new window.MouseEvent("click", { bubbles: true, cancelable: true });
        Object.defineProperty(e, "timeStamp", { value: t + doubleClicks * 10000 });
        $(`[data-item="${id}"]`)!.dispatchEvent(e as unknown as Event);
      }
      doubleClicks++;
      await settle();
    },
    /** A double-click on the browser's row `node` (its own dblclick event: rows are not redrawn by a click). */
    async rowDoubleClick(node: string) {
      const row = [...document.querySelectorAll<HTMLElement>(".tree-row")].find((r) => r.dataset.node === node);
      assert.ok(row, `a browser row ${node}`);
      row.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
      await settle();
    },
    /** The planes and faces Create sketch last offered (empty once it is done), every Look At, the sketches last drawn. */
    planes: () => planes,
    looks: () => looks,
    drawings: () => drawings,
    /** A click on the view while nothing is sketched on: a face, an edge or a plane, as the viewport hands it over. */
    async pick(p: Partial<ViewportPick>) {
      viewport.onPick?.({ face: null, shift: false, ...p });
      await settle();
    },
    /** A click on the view at sketch point (x, y), a pixel 0.1 mm wide (snaps reach 1 mm). */
    async click(x: number, y: number) {
      const pointer: SketchPointer = { kind: "click", at: [x, y], pixel: 0.1 };
      viewport.onSketchPointer?.(pointer);
      await settle();
    },
    async key(id: string) {
      view.shortcut?.(id);
      await settle();
    },
    /** Another workspace shown, then Design again (X7: asleep, then woken). */
    async away() {
      view.sleep?.();
      await settle();
      view.wake?.();
      await settle();
    },
    async finish() {
      $("#finish-sketch")!.click();
      await settle();
    },
    async undo() {
      const label = history.undo();
      await settle();
      return label;
    },
    async redo() {
      const label = history.redo();
      await settle();
      return label;
    },
    /** Puts Design away (as a page closed) and says whether every body it kept was freed. */
    async close() {
      if (previous === a) previous = null;
      view.unmount();
      await settle();
      return ((await kernel.call("body_count")) as number) === startBodies;
    },
  };
  let doubleClicks = 0;
  previous = a;
  return a;
}
