// The Image workspace's page (G1b): Open in the toolbar, the layer in the
// browser, the size in the properties, and the image itself drawn at its
// real size in the shared viewport, seen from above. The open image is kept
// while other workspaces are shown, but not saved with the project yet (G3).

import type { WorkspaceContext } from "@fission/core";
import { setDpi, setMmPerPixel, toImageRep, type ImageDocument, type Pixels } from "./document.ts";
import { openImage } from "./open.ts";
import { layerRows, NOT_SAVED_NOTE, parseSizeInput, sizeView } from "./panels.ts";
import type { PhysicalSize } from "./physical-size.ts";

/**
 * The browser's decoder: the file's own pixels, no colour management, not
 * premultiplied, and no turning by a JPEG's orientation tag (the header's
 * width and height are checked against the result; orientation comes
 * later), drawn into a canvas to read them back as RGBA.
 */
async function browserDecode(bytes: Uint8Array, format: PhysicalSize["format"]): Promise<Pixels> {
  const blob = new Blob([bytes as BlobPart], { type: `image/${format}` });
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none", imageOrientation: "none" as ImageOrientation });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const c = canvas.getContext("2d")!;
    c.drawImage(bitmap, 0, 0);
    const data = c.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: data.width, height: data.height, rgba: data.data };
  } finally {
    bitmap.close();
  }
}

/** The open image and the last refusal, kept while other workspaces are shown. */
let current: ImageDocument | null = null;
let message: string | null = null;

/** For the tests: forget the open image. */
export function resetImageWorkspace() {
  current = null;
  message = null;
}

const PROPERTIES = `
  <h2>Image</h2>
  <p id="image-empty">Open a PNG or JPEG to see it at its real size.</p>
  <dl id="image-size" hidden>
    <dt>Pixels</dt><dd id="image-pixels"></dd>
    <dt>Size</dt><dd id="image-mm"></dd>
    <dt>Size from</dt><dd id="image-source"></dd>
  </dl>
  <div id="image-size-inputs" hidden>
    <label>DPI <input id="image-dpi" type="number" step="any" min="0" /></label>
    <label>mm per pixel <input id="image-mmpp" type="number" step="any" min="0" /></label>
  </div>
  <p id="image-not-saved" hidden></p>
  <p id="image-error" class="bad" role="alert"></p>`;

export function mountImage(ctx: WorkspaceContext, decode = browserDecode): () => void {
  const page = ctx.toolbar.ownerDocument;
  let live = true;
  const $ = <T extends HTMLElement>(id: string) => ctx.properties.querySelector(`#${id}`) as T;

  // Toolbar: Open, through a hidden file input.
  const group = page.createElement("div");
  group.className = "tool-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "File");
  const groupName = page.createElement("span");
  groupName.className = "tool-group-name";
  groupName.textContent = "File";
  const open = page.createElement("button");
  open.type = "button";
  open.id = "image-open";
  open.textContent = "Open…";
  open.title = "Open a PNG or JPEG image at its real size";
  const input = page.createElement("input");
  input.type = "file";
  input.id = "image-file";
  input.accept = "image/png,image/jpeg,.png,.jpg,.jpeg";
  input.hidden = true;
  group.append(groupName, open, input);
  ctx.toolbar.append(group);

  ctx.properties.innerHTML = PROPERTIES;
  $("image-not-saved").textContent = NOT_SAVED_NOTE;

  /** Puts the document (and the last message) on screen; `frame` re-frames the camera on the image. */
  function show(frame: boolean) {
    if (current) {
      try {
        ctx.viewport.showImage(toImageRep(current));
        if (frame) ctx.viewport.fit();
      } catch (e) {
        current = null;
        message = (e as Error).message;
        ctx.viewport.clearImage();
      }
    } else {
      ctx.viewport.clearImage();
    }

    // Browser: the layer list.
    const heading = page.createElement("h2");
    heading.textContent = "Layers";
    const rows = layerRows(current);
    if (rows.length === 0) {
      const empty = page.createElement("p");
      empty.id = "layers-empty";
      empty.textContent = "No image open";
      ctx.browser.replaceChildren(heading, empty);
    } else {
      const ul = page.createElement("ul");
      ul.className = "tree";
      ul.id = "layer-list";
      for (const r of rows) {
        const li = page.createElement("li");
        const row = page.createElement("span");
        row.className = "tree-row";
        row.dataset.node = r.id; // read by the e2e test
        row.textContent = r.name;
        li.append(row);
        ul.append(li);
      }
      ctx.browser.replaceChildren(heading, ul);
    }

    // Properties: the size rows.
    const has = current !== null;
    $("image-empty").hidden = has;
    $("image-size").hidden = $("image-size-inputs").hidden = $("image-not-saved").hidden = !has;
    if (current) {
      const v = sizeView(current);
      $("image-pixels").textContent = v.pixels;
      $("image-mm").textContent = v.size;
      $("image-source").textContent = v.source;
      $<HTMLInputElement>("image-dpi").value = v.dpi;
      $<HTMLInputElement>("image-mmpp").value = v.mmPerPixel;
    }
    $("image-error").textContent = message ?? "";
  }

  open.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = ""; // the same file can be opened again
    if (!file) return;
    try {
      const doc = await openImage(new Uint8Array(await file.arrayBuffer()), file.name, decode);
      if (!live) return;
      current = doc;
      message = null;
    } catch (e) {
      if (!live) return;
      message = (e as Error).message;
    }
    show(true);
  });

  /** A size typed into DPI or mm per pixel; a bad one is refused with its message and the inputs go back to the document's size. */
  const edit = (what: "DPI" | "mm per pixel", el: HTMLInputElement) =>
    el.addEventListener("change", () => {
      if (!current) return;
      try {
        const n = parseSizeInput(el.value, what);
        current = what === "DPI" ? setDpi(current, n) : setMmPerPixel(current, n);
        message = null;
      } catch (e) {
        message = (e as Error).message;
      }
      show(true);
    });
  edit("DPI", $<HTMLInputElement>("image-dpi"));
  edit("mm per pixel", $<HTMLInputElement>("image-mmpp"));

  ctx.viewport.onPick = null;
  show(true);
  return () => {
    live = false;
    ctx.viewport.clearImage();
    ctx.toolbar.replaceChildren();
    ctx.browser.replaceChildren();
    ctx.properties.replaceChildren();
  };
}
