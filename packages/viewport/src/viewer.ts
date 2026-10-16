import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { triangleColours, type AnalysisOverlay, type DisplayMesh, type Framing, type SharedViewport, type ViewportPick } from "@fission/core";
import { edgeOfSegment, faceOfTriangle, isClick, segmentsNear, unhidden } from "./picking.ts";

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
  private raycaster = new THREE.Raycaster();
  onPick: ((pick: ViewportPick) => void) | null = null;
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
    this.faceMesh = new THREE.Mesh(geometry, material);
    this.body.add(
      this.faceMesh,
      new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x0b0c0e })),
    );
    this.paint();
  }

  setOverlay(overlay: AnalysisOverlay) {
    this.overlays.set(overlay.id, overlay);
    this.paint();
  }

  clearOverlay(id: string) {
    if (this.overlays.delete(id)) this.paint();
  }

  /** Colours the body's faces from the overlays and lists them in the legend. */
  private paint() {
    const overlays = [...this.overlays.values()];
    this.element.dataset.overlays = overlays.map((o) => o.id).join(" "); // read by the e2e test
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
    const base = new THREE.Color(0x9aa7b8).toArray();
    const linear = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace).toArray();
    const perTriangle = triangleColours(this.mesh.triangle_faces, overlays);
    const colours = new Float32Array(this.mesh.positions.length).fill(0);
    for (let i = 0; i < colours.length / 3; i++) colours.set(base, 3 * i);
    perTriangle.forEach((c, t) => {
      if (c) for (let k = 0; k < 3; k++) colours.set(linear(c), 3 * this.mesh!.indices[3 * t + k]);
    });
    this.faces.setAttribute("color", new THREE.BufferAttribute(colours, 3));
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

  /** Frames the current body; returns what it framed (null if none). */
  fit(): Framing | null {
    const framing = this.bodyFraming();
    if (!(framing.radius > 0)) return null;
    const centre = new THREE.Vector3(...framing.centre);
    const radius = framing.radius;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = new THREE.Vector3(0.6, -0.8, 0.55).normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.controls.target.copy(centre);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
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
