import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NO_HIGHLIGHT, triangleColours, type AnalysisOverlay, type DisplayMesh, type Framing, type SharedViewport, type ViewportHighlight, type ViewportPick } from "@fission/core";
import { edgeOfSegment, faceOfTriangle, isClick, segmentsNear, unhidden } from "./picking.ts";
import { viewBasis, type ViewName } from "./views.ts";
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

    this.camera.position.set(80, -100, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(200, 20, 0x3a3f47, 0x2a2e35);
    grid.rotation.x = Math.PI / 2; // lay the grid on the XY plane
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -2, 3);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-2, 1, -1);
    this.scene.add(grid, new THREE.AxesHelper(20), new THREE.AmbientLight(0xffffff, 0.5), key, fill, this.body);

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

  /** Frames the current body from the home view; returns what it framed (null if none). */
  fit(): Framing | null {
    return this.setView("home");
  }

  /** Turns the camera to a standard view, framing the current body; returns what it framed (null if none). */
  setView(name: ViewName): Framing | null {
    const framing = this.bodyFraming();
    if (!(framing.radius > 0)) return null;
    // Spend any orbit still easing out (damping) first, so the camera does
    // not drift away from the new framing over the next frames.
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    const { position, target, up } = viewBasis(name, framing, this.camera.fov);
    // The orbit stays about Z (camera.up); straight down, the view's own up
    // picks the camera's roll: a nudge of 1e-6 of the distance against it.
    const offset = new THREE.Vector3(...position).sub(new THREE.Vector3(...target));
    const dist = offset.length();
    if (offset.clone().cross(this.camera.up).lengthSq() === 0) offset.addScaledVector(new THREE.Vector3(...up), -1e-6 * dist);
    this.controls.target.set(...target);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    return framing;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
