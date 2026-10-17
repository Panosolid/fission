import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NO_HIGHLIGHT, triangleColours, type AnalysisOverlay, type DisplayMesh, type Framing, type ImageRep, type OriginPlane, type Plane, type SharedViewport, type SketchDrawing, type SketchPointer, type SketchXY, type ViewportHighlight, type ViewportPick } from "@fission/core";
import { clientToNdc, edgeOfSegment, faceOfTriangle, isClick, ndcToClient, segmentsNear, unhidden } from "./picking.ts";
import { fitDistance, orbitSafeOffset, viewBasis, type ViewName } from "./views.ts";
import { ViewCube } from "./viewcube.ts";
import { selectionFraming } from "./framing.ts";
import { checkTextureSize, imageSheet, imageZoomRange, topDownDistance } from "./image-sheet.ts";
import { gridLines, rayOnPlane, toWorld } from "./sketch-view.ts";
import { BASE_COLOUR, faceMixes, segmentColours, SELECTION_COLOUR, tint, type Rgb } from "./highlight.ts";

// The kernel is Z-up (like most CAD); Three.js defaults to Y-up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** Layers 1–31 show one view's image (layer 0 is the body, grid and axes); each view showing an image takes one. */
const freeImageLayers = Array.from({ length: 31 }, (_, i) => i + 1);

/** What a view needs from the viewer it shows: the one scene, body, selection and picking. */
interface ViewHost {
  readonly scene: THREE.Scene;
  readonly body: THREE.Group;
  mesh(): DisplayMesh | null;
  faceMesh(): THREE.Mesh | null;
  highlight(): ViewportHighlight;
  picking(): boolean;
  pick(pick: ViewportPick): void;
  setHover(face: number | null, edge: number | null): void;
  bodyFraming(): Framing;
  /** The plane of the sketch being edited, while a workspace listens to the pointer on it; else null. */
  sketchPlane(): Plane | null;
  sketchPointer(pointer: SketchPointer): void;
  /** The offered origin planes on screen (showPlanes), to be clicked. */
  planeMeshes(): THREE.Mesh[];
}

/**
 * One camera on the viewer's scene (X3, split view): its own canvas, orbit,
 * view cube, framing and picking, drawing the same body, selection and
 * overlays as every other view. The scene is shared, never copied (the
 * "one viewport" rule); only the camera differs.
 */
export class ViewportView {
  readonly element: HTMLElement;
  private renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private cube: ViewCube;
  private legend = document.createElement("ul");
  private resizer: ResizeObserver;
  private queuedHover = 0;
  /**
   * This view's 2D mode (showImage): the sheet it shows, or null for the
   * empty view of a workspace with no image open yet, on a layer only this
   * view's camera sees, so another view of the same scene keeps the body;
   * and this view's 3D camera to give back when it goes.
   */
  private image: { sheet: { mesh: THREE.Mesh; texture: THREE.DataTexture; widthMm: number; heightMm: number } | null; layer: number; saved: { position: THREE.Vector3; target: THREE.Vector3; near: number; far: number } } | null = null;

  private host: ViewHost;

  constructor(host: ViewHost, container: HTMLElement) {
    this.host = host;
    this.element = container;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.legend.className = "overlay-legend";
    this.legend.hidden = true;
    container.appendChild(this.legend);
    this.cube = new ViewCube((name) => this.setView(name));
    container.appendChild(this.cube.element);

    this.camera.position.set(80, -100, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    // A click picks; a press that moves further is the camera orbiting.
    let down: { x: number; y: number; id: number } | null = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      down = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    });
    canvas.addEventListener("pointerup", (e) => {
      const start = down;
      down = null;
      if (!start || start.id !== e.pointerId || !isClick(start, { x: e.clientX, y: e.clientY })) return;
      // Sketching: a click places a point on the sketch's plane, it picks nothing.
      const plane = this.host.sketchPlane();
      if (plane) return this.host.sketchPointer({ kind: "click", at: this.onPlane(e.clientX, e.clientY, plane) });
      const offered = this.planeAt(e.clientX, e.clientY);
      if (offered) return this.host.pick({ face: null, edge: null, plane: offered, shift: e.shiftKey });
      const edge = this.edgeAt(e.clientX, e.clientY);
      this.host.pick({ face: edge === null ? this.faceAt(e.clientX, e.clientY) : null, edge, shift: e.shiftKey });
    });
    // Hover: what a click would pick, looked up at most once a frame, never while a button is held.
    let pointer: { x: number; y: number } | null = null;
    canvas.addEventListener("pointermove", (e) => {
      pointer = e.buttons === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (this.queuedHover) return;
      this.queuedHover = requestAnimationFrame(() => {
        this.queuedHover = 0;
        const plane = this.host.sketchPlane();
        if (plane) return this.host.sketchPointer({ kind: "move", at: pointer && this.onPlane(pointer.x, pointer.y, plane) });
        if (!pointer || !this.host.picking()) return this.host.setHover(null, null);
        const edge = this.edgeAt(pointer.x, pointer.y);
        this.host.setHover(edge === null ? this.faceAt(pointer.x, pointer.y) : null, edge);
      });
    });
    canvas.addEventListener("pointerleave", () => {
      pointer = null;
      this.host.setHover(null, null);
      if (this.host.sketchPlane()) this.host.sketchPointer({ kind: "move", at: null });
    });

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.host.scene, this.camera);
      if (!this.image) this.cube.render(this.renderer, this.camera);
    });
  }

  /** Writes what the viewer shows onto this view's element (read by the e2e test) and lists the overlays in its legend. */
  label(overlays: AnalysisOverlay[], highlight: ViewportHighlight, hover: { face: number | null; edge: number | null }) {
    this.element.dataset.overlays = overlays.map((o) => o.id).join(" ");
    const { body, faces, edges } = highlight;
    this.element.dataset.highlight = `${body ? "body " : ""}faces ${faces.join(",")} edges ${edges.join(",")}`;
    this.element.dataset.hover = hover.edge !== null ? `edge ${hover.edge}` : hover.face !== null ? `face ${hover.face}` : "";
    this.legend.hidden = overlays.length === 0;
    this.legend.replaceChildren(
      ...overlays.map((o) => {
        const li = document.createElement("li");
        li.textContent = o.label;
        if (o.detail) li.title = o.detail;
        return li;
      }),
    );
  }

  /** The camera's ray through a point on screen (client pixels) in the raycaster; false when the view has no size. */
  private aim(clientX: number, clientY: number): boolean {
    const ndc = clientToNdc({ x: clientX, y: clientY }, this.renderer.domElement.getBoundingClientRect());
    if (!ndc) return false;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    return true;
  }

  /** Where the ray through a point on screen meets a sketch plane, in its frame (null when it doesn't, or under an image). */
  private onPlane(clientX: number, clientY: number, plane: Plane): SketchXY | null {
    if (this.image || !this.aim(clientX, clientY)) return null;
    const { origin, direction } = this.raycaster.ray;
    return rayOnPlane(origin.toArray(), direction.toArray(), plane);
  }

  /** The offered origin plane under a point on screen, by id, or null. */
  private planeAt(clientX: number, clientY: number): string | null {
    const meshes = this.host.planeMeshes();
    if (meshes.length === 0 || this.image || !this.aim(clientX, clientY)) return null;
    const [hit] = this.raycaster.intersectObjects(meshes, false);
    return hit ? (hit.object.userData.plane as string) : null;
  }

  /** The kernel face index under a point on screen (client pixels), or null for empty space. */
  private faceAt(clientX: number, clientY: number): number | null {
    const mesh = this.host.mesh();
    const faceMesh = this.host.faceMesh();
    if (!mesh || !faceMesh || this.image) return null; // the body is not drawn under an image
    const ndc = clientToNdc({ x: clientX, y: clientY }, this.renderer.domElement.getBoundingClientRect());
    if (!ndc) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    // Nearest hit first; for indexed geometry faceIndex is the triangle number.
    const [hit] = this.raycaster.intersectObject(faceMesh, false);
    return faceOfTriangle(mesh.triangle_faces, hit?.faceIndex);
  }

  /**
   * The kernel edge index whose line passes within a few pixels of a point
   * on screen (client pixels) and is not hidden by a face there, or null.
   */
  private edgeAt(clientX: number, clientY: number): number | null {
    const mesh = this.host.mesh();
    const faceMesh = this.host.faceMesh();
    if (!mesh || !faceMesh || this.image) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const lines = mesh.edge_lines;
    const point = (i: number) => new THREE.Vector3(lines[3 * i], lines[3 * i + 1], lines[3 * i + 2]);
    // Every segment end on screen; NaN for ends outside the camera's depth range.
    const screen = new Float64Array((lines.length / 3) * 2);
    for (let i = 0; i < lines.length / 3; i++) {
      const v = point(i).project(this.camera);
      const drawable = v.z >= -1 && v.z <= 1;
      const at = ndcToClient(v, rect);
      screen[2 * i] = drawable ? at.x : NaN;
      screen[2 * i + 1] = drawable ? at.y : NaN;
    }
    for (const { segment, t } of segmentsNear(screen, { x: clientX, y: clientY })) {
      // The edge's point nearest the pointer, and the first face towards it.
      const target = point(2 * segment).lerp(point(2 * segment + 1), t);
      const towards = target.clone().sub(this.camera.position);
      const distance = towards.length();
      this.raycaster.set(this.camera.position, towards.normalize());
      const [hit] = this.raycaster.intersectObject(faceMesh, false);
      if (unhidden(distance, hit ? hit.distance : null)) return edgeOfSegment(mesh.edge_line_edges, segment);
    }
    return null;
  }

  /** Frames the current body from the home view (or the image from above while this view shows one); returns what it framed (null if none). */
  fit(): Framing | null {
    return this.setView("home");
  }

  /** Turns this view's camera to a standard view, framing the current body; while this view shows an image every view frames it from above. Returns what it framed (null if none). */
  setView(name: ViewName): Framing | null {
    if (this.image) return this.frameImage();
    const framing = this.host.bodyFraming();
    if (!(framing.radius > 0)) return null;
    const { position, target, up } = viewBasis(name, framing, this.camera.fov, this.camera.aspect);
    this.place(position, target, up);
    return framing;
  }

  /**
   * Frames what is selected (faces and edges; a selected body is the whole
   * body) from this view's current direction; returns what it framed, or
   * null when nothing is selected, leaving the camera alone.
   */
  fitSelection(): Framing | null {
    const { body, faces, edges } = this.host.highlight();
    const mesh = this.host.mesh();
    if (!mesh || this.image) return null;
    const framing = faces.length || edges.length ? selectionFraming(mesh, faces, edges) : body ? this.host.bodyFraming() : null;
    if (!framing || !(framing.radius > 0)) return null;
    this.spendDamping();
    const towardCamera = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = fitDistance(framing.radius, this.camera.fov, this.camera.aspect);
    const target = new THREE.Vector3(...framing.centre);
    const position = target.clone().addScaledVector(towardCamera, dist);
    // The camera's current screen-up keeps the roll when looking straight down.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.place(position.toArray(), framing.centre, up.toArray());
    return framing;
  }

  /** Spends any orbit still easing out (damping), so the camera does not drift from a new framing over the next frames. */
  private spendDamping() {
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
  }

  private place(position: readonly number[], target: readonly number[], up: readonly number[]) {
    this.spendDamping();
    // The orbit stays about Z (camera.up); straight down or up, the view's
    // own up picks the camera's roll (orbitSafeOffset).
    const raw = new THREE.Vector3(...position).sub(new THREE.Vector3(...target));
    const dist = raw.length();
    const offset = new THREE.Vector3(...orbitSafeOffset(raw.toArray(), [up[0], up[1], up[2]]));
    this.controls.target.set(target[0], target[1], target[2]);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /**
   * Shows an image as a flat sheet at its real size in this view (see
   * SharedViewport): nearest-neighbour when zoomed in, so each pixel stays
   * a crisp square, smoothed with mipmaps when zoomed out. The texture is
   * sRGB and the material unlit, so the screen shows the image's own
   * colours. The sheet is in the one scene, on a layer only this view's
   * camera sees, and this view stops seeing the body. Null shows the same
   * 2D view with no sheet: only the background.
   */
  showImage(image: ImageRep | null) {
    if (image === null) return this.showEmpty();
    checkTextureSize(image.width, image.height, this.renderer.capabilities.maxTextureSize);
    const sheet = imageSheet(image.width, image.height, image.mmPerPixel);
    const layer = this.image?.layer ?? freeImageLayers.shift();
    if (layer === undefined) throw new Error("Too many views are showing images at once.");
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(sheet.positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(sheet.uvs, 2));
    geometry.setIndex(sheet.indices);
    // The same bytes viewed as Uint8Array, no copy; decoded pixels never live in shared memory.
    const bytes = new Uint8Array(image.rgba.buffer as ArrayBuffer, image.rgba.byteOffset, image.rgba.byteLength);
    const texture = new THREE.DataTexture(bytes, image.width, image.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
    mesh.layers.set(layer);
    const first = !this.image?.sheet;
    this.enter2d(layer);
    this.removeSheet();
    this.image!.sheet = { mesh, texture, widthMm: sheet.widthMm, heightMm: sheet.heightMm };
    this.host.scene.add(mesh);
    this.element.dataset.image = `${image.width} x ${image.height} px, ${+sheet.widthMm.toPrecision(12)} x ${+sheet.heightMm.toPrecision(12)} mm`; // read by the e2e test
    if (first) this.frameImage();
  }

  /** The 2D view with no sheet (showImage(null)): the background alone, never the body; an image shown before goes, the camera stays. */
  private showEmpty() {
    const layer = this.image?.layer ?? freeImageLayers.shift();
    if (layer === undefined) throw new Error("Too many views are showing images at once.");
    this.enter2d(layer);
    this.removeSheet();
    this.element.dataset.image = "none"; // read by the e2e test
  }

  /** Switches this view to the top-down 2D mode on `layer`, keeping its 3D camera to give back; does nothing more when already there. */
  private enter2d(layer: number) {
    if (this.image) return;
    const saved = { position: this.camera.position.clone(), target: this.controls.target.clone(), near: this.camera.near, far: this.camera.far };
    this.image = { sheet: null, layer, saved };
    this.camera.layers.set(layer); // only the image: no body, grid or axes
    this.cube.element.hidden = true;
    // Top-down 2D: the left button pans instead of orbiting.
    this.controls.enableRotate = false;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.touches.ONE = THREE.TOUCH.PAN;
    this.place([0, 0, this.camera.position.distanceTo(this.controls.target)], [0, 0, 0], [0, 1, 0]); // looking straight down
  }

  /** Leaves the 2D mode, removing any image, and gives back the body and the 3D camera as they were; does nothing when not in it. */
  clearImage() {
    if (!this.image) return;
    const { saved, layer } = this.image;
    this.removeSheet();
    this.image = null;
    freeImageLayers.push(layer);
    delete this.element.dataset.image;
    this.camera.layers.set(0);
    this.cube.element.hidden = false;
    this.controls.enableRotate = true;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
    this.spendDamping();
    this.controls.target.copy(saved.target);
    this.camera.position.copy(saved.position);
    this.camera.near = saved.near;
    this.camera.far = saved.far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private removeSheet() {
    const sheet = this.image?.sheet;
    if (!sheet) return;
    this.host.scene.remove(sheet.mesh);
    sheet.mesh.geometry.dispose();
    (sheet.mesh.material as THREE.Material).dispose();
    sheet.texture.dispose();
    this.image!.sheet = null;
  }

  /** Looks straight down on the image's sheet, the whole of it in view; +Y up on screen. */
  private frameImage(): Framing | null {
    if (!this.image?.sheet) return null;
    const { widthMm, heightMm } = this.image.sheet;
    const dist = topDownDistance(widthMm, heightMm, this.camera.fov, this.camera.aspect);
    this.place([0, 0, dist], [0, 0, 0], [0, 1, 0]);
    const range = imageZoomRange(dist);
    this.controls.minDistance = range.minDistance;
    this.controls.maxDistance = range.maxDistance;
    this.camera.near = range.near;
    this.camera.far = range.far;
    this.camera.updateProjectionMatrix();
    return { centre: [0, 0, 0], radius: Math.hypot(widthMm, heightMm) / 2 };
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.element;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Stops drawing and takes this view's canvas, cube and legend out of its element. */
  dispose() {
    this.clearImage();
    this.renderer.setAnimationLoop(null);
    if (this.queuedHover) cancelAnimationFrame(this.queuedHover);
    this.resizer.disconnect();
    this.controls.dispose();
    this.renderer.domElement.remove();
    this.cube.element.remove();
    this.legend.remove();
    this.renderer.dispose();
  }
}

/** The sketch colours (sRGB): the edited sketch's lines bright, finished ones quieter, the grid faint. */
const SKETCH_COLOURS = { line: 0x6cc4ff, finished: 0x8b95a3, preview: 0xffb454, point: 0xffffff, grid: 0x262b33, gridMajor: 0x3c4450, plane: 0x6cc4ff, planeOff: 0x8b95a3 };

/** Empties a group, freeing its geometry and materials. */
function clearGroup(group: THREE.Group) {
  for (const o of group.children) {
    if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  }
  group.clear();
}

/**
 * The one viewport: one scene with the current body, its selection, hover
 * and analysis overlays, seen through one or more views (split view, X3).
 * The main view fills the element the viewer was made with; the camera
 * methods of SharedViewport (fit, setView, fitSelection) act on it.
 */
export class Viewer implements SharedViewport {
  private scene = new THREE.Scene();
  private body = new THREE.Group();
  private mesh: DisplayMesh | null = null;
  private faces: THREE.BufferGeometry | null = null;
  private faceMesh: THREE.Mesh | null = null;
  private edges: THREE.BufferGeometry | null = null;
  private picker: ((pick: ViewportPick) => void) | null = null;
  private highlight: ViewportHighlight = NO_HIGHLIGHT;
  /** The face or edge under the pointer while picking is on (at most one is set). */
  private hover: { face: number | null; edge: number | null } = { face: null, edge: null };
  private overlays = new Map<string, AnalysisOverlay>();
  private host: ViewHost;
  /** The ground grid, hidden while a sketch with its own grid is edited. */
  private grid: THREE.GridHelper;
  /** The sketches drawn (showSketches) and the plane of the one being edited. */
  private sketches = new THREE.Group();
  private editedPlane: Plane | null = null;
  private sketchHandler: ((pointer: SketchPointer) => void) | null = null;
  /** The origin planes drawn for picking (showPlanes). */
  private planes = new THREE.Group();
  private planeHits: THREE.Mesh[] = [];
  /** The main view first, then any added ones. */
  private views: ViewportView[] = [];
  readonly element: HTMLElement;

  constructor(container: HTMLElement) {
    this.element = container;
    this.scene.background = new THREE.Color(0x14161a);
    const grid = (this.grid = new THREE.GridHelper(200, 20, 0x3a3f47, 0x2a2e35));
    grid.rotation.x = Math.PI / 2; // lay the grid on the XY plane
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -2, 3);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-2, 1, -1);
    this.scene.add(grid, new THREE.AxesHelper(20), new THREE.AmbientLight(0xffffff, 0.5), key, fill, this.body, this.sketches, this.planes);

    this.host = {
      scene: this.scene,
      body: this.body,
      mesh: () => this.mesh,
      faceMesh: () => this.faceMesh,
      highlight: () => this.highlight,
      picking: () => this.picker !== null,
      pick: (pick) => this.picker?.(pick),
      setHover: (face, edge) => this.setHover(face, edge),
      bodyFraming: () => this.bodyFraming(),
      sketchPlane: () => (this.sketchHandler ? this.editedPlane : null),
      sketchPointer: (pointer) => this.sketchHandler?.(pointer),
      planeMeshes: () => this.planeHits,
    };
    this.views.push(new ViewportView(this.host, container));
    this.paint();
  }

  /** The view filling the viewer's own element. */
  get main(): ViewportView {
    return this.views[0];
  }

  /** Another view of the same scene, filling `container`, with its own camera; it starts at the home view of the current body. */
  addView(container: HTMLElement): ViewportView {
    if (this.views.some((v) => v.element === container)) throw new Error("That element already shows a view");
    const view = new ViewportView(this.host, container);
    this.views.push(view);
    this.paint();
    view.fit();
    return view;
  }

  /** Takes an added view away; false for the main view or one already removed. */
  removeView(view: ViewportView): boolean {
    const i = this.views.indexOf(view);
    if (i <= 0) return false;
    this.views.splice(i, 1);
    view.dispose();
    return true;
  }

  /** How many views show the scene (1 unless split). */
  get viewCount(): number {
    return this.views.length;
  }

  showBody(mesh: DisplayMesh) {
    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) o.geometry.dispose();
    });
    this.body.clear();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3));
    geometry.setIndex(mesh.indices);
    this.mesh = mesh;
    this.faces = geometry;
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.1,
      roughness: 0.6,
      polygonOffset: true, // keep edges drawn on top of faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.Float32BufferAttribute(mesh.edge_lines, 3));
    this.edges = edges;
    this.faceMesh = new THREE.Mesh(geometry, material);
    this.body.add(this.faceMesh, new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ vertexColors: true })));
    this.hover = { face: null, edge: null }; // indices of the old body
    this.paint();
  }

  get onPick() {
    return this.picker;
  }

  /** Picking also turns hover on; null turns both off. A click in any view picks. */
  set onPick(handler: ((pick: ViewportPick) => void) | null) {
    this.picker = handler;
    if (!handler) this.setHover(null, null);
  }

  get onSketchPointer() {
    return this.sketchHandler;
  }

  set onSketchPointer(handler: ((pointer: SketchPointer) => void) | null) {
    this.sketchHandler = handler;
    this.labelSketches();
  }

  /**
   * Draws the sketches over the body (no depth test, so a sketch on a face
   * of the body never hides in it): lines, and for the one being edited its
   * grid, its points and the rubber-band line. Replaces what was drawn.
   */
  showSketches(drawings: readonly SketchDrawing[]) {
    clearGroup(this.sketches);
    this.editedPlane = null;
    let lines = 0;
    for (const d of drawings) {
      const at = (p: SketchXY) => toWorld(d.plane, p);
      const segments = (pairs: readonly (readonly [SketchXY, SketchXY])[], colour: number, order: number) => {
        if (pairs.length === 0) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pairs.flatMap(([a, b]) => [...at(a), ...at(b)]), 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colour, depthTest: false, transparent: true }));
        l.renderOrder = order;
        this.sketches.add(l);
      };
      lines += d.lines.length;
      if (!d.editing) {
        segments(d.lines, SKETCH_COLOURS.finished, 2);
        continue;
      }
      this.editedPlane = d.plane;
      const grid = gridLines(d.editing.grid);
      segments(grid.filter((g) => !g.major).map((g) => [g.a, g.b]), SKETCH_COLOURS.grid, 1);
      segments(grid.filter((g) => g.major).map((g) => [g.a, g.b]), SKETCH_COLOURS.gridMajor, 1);
      segments(d.lines, SKETCH_COLOURS.line, 3);
      if (d.editing.preview.length > 0) segments(d.editing.preview, SKETCH_COLOURS.preview, 4);
      if (d.editing.points.length > 0) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(d.editing.points.flatMap((p) => at(p)), 3));
        const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: SKETCH_COLOURS.point, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
        dots.renderOrder = 5;
        this.sketches.add(dots);
      }
    }
    this.grid.visible = this.editedPlane === null;
    // Read by the e2e test: how many lines are drawn, and the edited sketch's points and preview.
    const edited = drawings.find((d) => d.editing)?.editing;
    const xy = (p: SketchXY) => `${p[0]},${p[1]}`;
    this.element.dataset.sketchLines = String(lines);
    this.element.dataset.sketchPoints = edited ? edited.points.map(xy).join(" ") : "";
    this.element.dataset.sketchPreview = edited ? edited.preview.map((s) => s.map(xy).join(" ")).join(" | ") : "";
    this.labelSketches();
  }

  /** Says on the element whether a sketch is being edited with the pointer on it (read by the e2e test). */
  private labelSketches() {
    this.element.dataset.sketching = String(this.sketchHandler !== null && this.editedPlane !== null);
  }

  /**
   * Draws the origin planes as squares from the origin, as wide as the
   * 1.6 times the body's framing radius (at least 20 mm), so each sticks out past the
   * body; an offered one is drawn through the body and is clickable.
   */
  showPlanes(planes: readonly OriginPlane[]) {
    clearGroup(this.planes);
    this.planeHits = [];
    const half = Math.max(10, 0.8 * this.bodyFraming().radius);
    for (const p of planes) {
      const corners: SketchXY[] = [[0, 0], [2 * half, 0], [2 * half, 2 * half], [0, 2 * half]];
      const world = corners.map((c) => toWorld(p.plane, c));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(world.flat(), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: p.offered ? SKETCH_COLOURS.plane : SKETCH_COLOURS.planeOff, transparent: true, opacity: p.offered ? 0.35 : 0.12, side: THREE.DoubleSide, depthWrite: false, depthTest: !p.offered }));
      fill.renderOrder = 6;
      fill.userData.plane = p.id;
      const outline = new THREE.BufferGeometry();
      outline.setAttribute("position", new THREE.Float32BufferAttribute(world.flat(), 3));
      const rim = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({ color: p.offered ? SKETCH_COLOURS.plane : SKETCH_COLOURS.planeOff, transparent: true, opacity: p.offered ? 1 : 0.4, depthTest: !p.offered }));
      rim.renderOrder = 6;
      this.planes.add(fill, rim);
      if (p.offered) this.planeHits.push(fill);
    }
    this.element.dataset.planes = planes.map((p) => `${p.id}${p.offered ? "" : " (not offered)"}`).join(", "); // read by the e2e test
  }

  showSelection(highlight: ViewportHighlight) {
    this.highlight = { body: highlight.body, faces: [...highlight.faces], edges: [...highlight.edges] };
    this.paint();
  }

  private setHover(face: number | null, edge: number | null) {
    if (face === this.hover.face && edge === this.hover.edge) return;
    this.hover = { face, edge };
    this.paint();
  }

  setOverlay(overlay: AnalysisOverlay) {
    this.overlays.set(overlay.id, overlay);
    this.paint();
  }

  clearOverlay(id: string) {
    if (this.overlays.delete(id)) this.paint();
  }

  /**
   * Colours the body's faces from the overlays, tints the selected and
   * hovered ones, colours selected and hovered edges, and lists the
   * overlays in every view's legend.
   */
  private paint() {
    const overlays = [...this.overlays.values()];
    for (const view of this.views) view.label(overlays, this.highlight, this.hover);
    if (!this.mesh || !this.faces) return;
    // Vertices belong to one face each (display.rs), so per-vertex colour is per-face colour.
    // Vertex colours are linear; THREE.Color converts from sRGB.
    // Tints are mixed in sRGB, like the colours are chosen.
    const linear = (c: Rgb) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).toArray();
    const perTriangle = triangleColours(this.mesh.triangle_faces, overlays);
    const mixes = faceMixes(this.mesh.triangle_faces, this.highlight, this.hover.face);
    const colours = new Float32Array(this.mesh.positions.length).fill(0);
    for (let i = 0; i < colours.length / 3; i++) colours.set(linear(BASE_COLOUR), 3 * i);
    perTriangle.forEach((c, t) => {
      if (!c && mixes[t] === 0) return;
      const colour = linear(tint(c ?? BASE_COLOUR, SELECTION_COLOUR, mixes[t]));
      for (let k = 0; k < 3; k++) colours.set(colour, 3 * this.mesh!.indices[3 * t + k]);
    });
    this.faces.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    if (!this.edges) return;
    const lineColours = new Float32Array(this.mesh.edge_lines.length);
    segmentColours(this.mesh.edge_line_edges, this.highlight, this.hover.edge).forEach((c, s) => {
      const colour = linear(c);
      lineColours.set(colour, 6 * s);
      lineColours.set(colour, 6 * s + 3);
    });
    this.edges.setAttribute("color", new THREE.BufferAttribute(lineColours, 3));
  }

  /** Sphere around the current body's bounding box (radius 0 if none). */
  bodyFraming(): Framing {
    const box = new THREE.Box3().setFromObject(this.body);
    if (box.isEmpty()) return { centre: [0, 0, 0], radius: 0 };
    const c = box.getCenter(new THREE.Vector3());
    return { centre: [c.x, c.y, c.z], radius: box.getSize(new THREE.Vector3()).length() / 2 };
  }

  /** Frames the current body from the home view in the main view; returns what it framed (null if none). */
  fit(): Framing | null {
    return this.main.fit();
  }

  /** Turns the main view's camera to a standard view, framing the current body. */
  setView(name: ViewName): Framing | null {
    return this.main.setView(name);
  }

  /** Frames the selection in the main view, from its current direction. */
  fitSelection(): Framing | null {
    return this.main.fitSelection();
  }

  /** Shows an image, or the empty 2D view for null, in the main view (see ViewportView.showImage). */
  showImage(image: ImageRep | null) {
    this.main.showImage(image);
  }

  /** Takes the main view's image away. */
  clearImage() {
    this.main.clearImage();
  }
}
