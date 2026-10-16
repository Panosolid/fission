import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NO_HIGHLIGHT, triangleColours, type AnalysisOverlay, type DisplayMesh, type Framing, type ImageRep, type SharedViewport, type ViewportHighlight, type ViewportPick } from "@fission/core";
import { edgeOfSegment, faceOfTriangle, isClick, segmentsNear, unhidden } from "./picking.ts";
import { fitDistance, orbitSafeOffset, viewBasis, type ViewName } from "./views.ts";
import { ViewCube } from "./viewcube.ts";
import { selectionFraming } from "./framing.ts";
import { checkTextureSize, imageSheet, imageZoomRange, topDownDistance } from "./image-sheet.ts";
import { BASE_COLOUR, faceMixes, segmentColours, SELECTION_COLOUR, tint, type Rgb } from "./highlight.ts";

// The kernel is Z-up (like most CAD); Three.js defaults to Y-up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewer implements SharedViewport {
  private renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  private controls: OrbitControls;
  private body = new THREE.Group();
  private mesh: DisplayMesh | null = null;
  private faces: THREE.BufferGeometry | null = null;
  private faceMesh: THREE.Mesh | null = null;
  private edges: THREE.BufferGeometry | null = null;
  private raycaster = new THREE.Raycaster();
  private picker: ((pick: ViewportPick) => void) | null = null;
  private highlight: ViewportHighlight = NO_HIGHLIGHT;
  /** The face or edge under the pointer while picking is on (at most one is set). */
  private hover: { face: number | null; edge: number | null } = { face: null, edge: null };
  private overlays = new Map<string, AnalysisOverlay>();
  private legend = document.createElement("ul");
  private cube: ViewCube;
  private grid: THREE.GridHelper;
  private axes = new THREE.AxesHelper(20);
  /** The image on show (showImage), and the 3D camera to give back when it goes. */
  private image: { mesh: THREE.Mesh; texture: THREE.DataTexture; widthMm: number; heightMm: number; saved: { position: THREE.Vector3; target: THREE.Vector3; near: number; far: number } } | null = null;
  readonly element: HTMLElement;

  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.element = container;
    this.scene.background = new THREE.Color(0x14161a);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.legend.className = "overlay-legend";
    this.legend.hidden = true;
    container.appendChild(this.legend);
    const cube = new ViewCube((name) => this.setView(name));
    this.cube = cube;
    container.appendChild(cube.element);

    this.camera.position.set(80, -100, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(200, 20, 0x3a3f47, 0x2a2e35);
    this.grid = grid;
    grid.rotation.x = Math.PI / 2; // lay the grid on the XY plane
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -2, 3);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-2, 1, -1);
    this.scene.add(grid, this.axes, new THREE.AmbientLight(0xffffff, 0.5), key, fill, this.body);

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
      const edge = this.edgeAt(e.clientX, e.clientY);
      this.onPick?.({ face: edge === null ? this.faceAt(e.clientX, e.clientY) : null, edge, shift: e.shiftKey });
    });
    // Hover: what a click would pick, looked up at most once a frame, never while a button is held.
    let pointer: { x: number; y: number } | null = null;
    let queued = false;
    canvas.addEventListener("pointermove", (e) => {
      pointer = e.buttons === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!pointer || !this.picker) return this.setHover(null, null);
        const edge = this.edgeAt(pointer.x, pointer.y);
        this.setHover(edge === null ? this.faceAt(pointer.x, pointer.y) : null, edge);
      });
    });
    canvas.addEventListener("pointerleave", () => {
      pointer = null;
      this.setHover(null, null);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      if (!this.image) cube.render(this.renderer, this.camera);
    });
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

  /** Picking also turns hover on; null turns both off. */
  set onPick(handler: ((pick: ViewportPick) => void) | null) {
    this.picker = handler;
    if (!handler) this.setHover(null, null);
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
   * overlays in the legend.
   */
  private paint() {
    const overlays = [...this.overlays.values()];
    // Read by the e2e test.
    this.element.dataset.overlays = overlays.map((o) => o.id).join(" ");
    const { body, faces, edges } = this.highlight;
    this.element.dataset.highlight = `${body ? "body " : ""}faces ${faces.join(",")} edges ${edges.join(",")}`;
    this.element.dataset.hover = this.hover.edge !== null ? `edge ${this.hover.edge}` : this.hover.face !== null ? `face ${this.hover.face}` : "";
    this.legend.hidden = overlays.length === 0;
    this.legend.replaceChildren(
      ...overlays.map((o) => {
        const li = document.createElement("li");
        li.textContent = o.label;
        if (o.detail) li.title = o.detail;
        return li;
      }),
    );
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

  /** The kernel face index under a point on screen (client pixels), or null for empty space. */
  private faceAt(clientX: number, clientY: number): number | null {
    if (!this.mesh || !this.faceMesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    // Nearest hit first; for indexed geometry faceIndex is the triangle number.
    const [hit] = this.raycaster.intersectObject(this.faceMesh, false);
    return faceOfTriangle(this.mesh.triangle_faces, hit?.faceIndex);
  }

  /**
   * The kernel edge index whose line passes within a few pixels of a point
   * on screen (client pixels) and is not hidden by a face there, or null.
   */
  private edgeAt(clientX: number, clientY: number): number | null {
    if (!this.mesh || !this.faceMesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const lines = this.mesh.edge_lines;
    const point = (i: number) => new THREE.Vector3(lines[3 * i], lines[3 * i + 1], lines[3 * i + 2]);
    // Every segment end on screen; NaN for ends outside the camera's depth range.
    const screen = new Float64Array((lines.length / 3) * 2);
    for (let i = 0; i < lines.length / 3; i++) {
      const v = point(i).project(this.camera);
      const drawable = v.z >= -1 && v.z <= 1;
      screen[2 * i] = drawable ? rect.left + ((v.x + 1) / 2) * rect.width : NaN;
      screen[2 * i + 1] = drawable ? rect.top + ((1 - v.y) / 2) * rect.height : NaN;
    }
    for (const { segment, t } of segmentsNear(screen, { x: clientX, y: clientY })) {
      // The edge's point nearest the pointer, and the first face towards it.
      const target = point(2 * segment).lerp(point(2 * segment + 1), t);
      const towards = target.clone().sub(this.camera.position);
      const distance = towards.length();
      this.raycaster.set(this.camera.position, towards.normalize());
      const [hit] = this.raycaster.intersectObject(this.faceMesh, false);
      if (unhidden(distance, hit ? hit.distance : null)) return edgeOfSegment(this.mesh.edge_line_edges, segment);
    }
    return null;
  }

  /** Sphere around the current body's bounding box (radius 0 if none). */
  bodyFraming(): Framing {
    const box = new THREE.Box3().setFromObject(this.body);
    if (box.isEmpty()) return { centre: [0, 0, 0], radius: 0 };
    const c = box.getCenter(new THREE.Vector3());
    return { centre: [c.x, c.y, c.z], radius: box.getSize(new THREE.Vector3()).length() / 2 };
  }

  /** Frames the current body from the home view (or the image from above while one is shown); returns what it framed (null if none). */
  fit(): Framing | null {
    return this.setView("home");
  }

  /** Turns the camera to a standard view, framing the current body; while an image is shown every view frames it from above. Returns what it framed (null if none). */
  setView(name: ViewName): Framing | null {
    if (this.image) return this.frameImage();
    const framing = this.bodyFraming();
    if (!(framing.radius > 0)) return null;
    const { position, target, up } = viewBasis(name, framing, this.camera.fov, this.camera.aspect);
    this.place(position, target, up);
    return framing;
  }

  /**
   * Frames what is selected (faces and edges; a selected body is the whole
   * body) from the current direction; returns what it framed, or null when
   * nothing is selected, leaving the camera alone.
   */
  fitSelection(): Framing | null {
    const { body, faces, edges } = this.highlight;
    if (!this.mesh || this.image) return null;
    const framing = faces.length || edges.length ? selectionFraming(this.mesh, faces, edges) : body ? this.bodyFraming() : null;
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
   * Shows an image as a flat sheet at its real size (see SharedViewport):
   * nearest-neighbour when zoomed in, so each pixel stays a crisp square,
   * smoothed with mipmaps when zoomed out. The texture is sRGB and the
   * material unlit, so the screen shows the image's own colours.
   */
  showImage(image: ImageRep) {
    checkTextureSize(image.width, image.height, this.renderer.capabilities.maxTextureSize);
    const sheet = imageSheet(image.width, image.height, image.mmPerPixel);
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
    const first = !this.image;
    const saved = this.image?.saved ?? { position: this.camera.position.clone(), target: this.controls.target.clone(), near: this.camera.near, far: this.camera.far };
    this.removeImage();
    this.image = { mesh, texture, widthMm: sheet.widthMm, heightMm: sheet.heightMm, saved };
    this.scene.add(mesh);
    this.element.dataset.image = `${image.width} x ${image.height} px, ${+sheet.widthMm.toPrecision(12)} x ${+sheet.heightMm.toPrecision(12)} mm`; // read by the e2e test
    if (first) {
      this.body.visible = this.grid.visible = this.axes.visible = false;
      this.cube.element.hidden = true;
      // Top-down 2D: the left button pans instead of orbiting.
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      this.controls.touches.ONE = THREE.TOUCH.PAN;
      this.frameImage();
    }
  }

  clearImage() {
    if (!this.image) return;
    const { saved } = this.image;
    this.removeImage();
    this.image = null;
    delete this.element.dataset.image;
    this.body.visible = this.grid.visible = this.axes.visible = true;
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

  private removeImage() {
    if (!this.image) return;
    this.scene.remove(this.image.mesh);
    this.image.mesh.geometry.dispose();
    (this.image.mesh.material as THREE.Material).dispose();
    this.image.texture.dispose();
  }

  /** Looks straight down on the image's sheet, the whole of it in view; +Y up on screen. */
  private frameImage(): Framing | null {
    if (!this.image) return null;
    const { widthMm, heightMm } = this.image;
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
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
