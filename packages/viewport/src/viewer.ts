import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { NO_HIGHLIGHT, triangleColours, type AnalysisOverlay, type DisplayMesh, type Framing, type ImageRep, type OriginPlane, type Plane, type SharedViewport, type SketchDrawing, type SketchPointer, type SketchXY, type ViewportHighlight, type ViewportPick } from "@fission/core";
import { clientToNdc, edgeOfSegment, faceOfTriangle, isClick, ndcToClient, planeOrFace, segmentsNear, unhidden } from "./picking.ts";
import { fitDistance, orbitSafeOffset, planeViewBasis, viewBasis, type ViewName } from "./views.ts";
import { ViewCube } from "./viewcube.ts";
import { lookAtFraming, selectionFraming } from "./framing.ts";
import { checkTextureSize, imageSheet, imageZoomRange, topDownDistance } from "./image-sheet.ts";
import { pixelSize, rayOnPlane, sketchGrid, toWorld } from "./sketch-view.ts";
import { clampZoom, cubeDragAngles, dragAction, orbitBy, dragZoomFactor, panBy, wheelFactor, zoomAt, type CameraPose, type NavMode } from "./navigation.ts";
import { navBar } from "./nav-bar.ts";
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
  /** Which way the edited sketch faces against its plane's normal (SketchDrawing.side), for Look At. */
  sketchSide(): 1 | -1;
  sketchPointer(pointer: SketchPointer): void;
  /** The offered origin planes on screen (showPlanes), to be clicked. */
  planeMeshes(): THREE.Mesh[];
  /** While planes are offered (showPlanes), the body's faces that can be picked with them (26d); null when none are offered. */
  offeredFaces(): ReadonlySet<number> | null;
  /** The offered plane under the pointer, drawn brighter; null for none. */
  setPlaneHover(plane: string | null): void;
  /** What Look At frames on a plane: the body and the edited sketch. */
  lookAtFraming(plane: Plane): Framing;
  /** Called by each view before it draws a frame (the sketch grid follows the main view's camera). */
  frame(view: ViewportView): void;
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
  /** What a left-button drag does (SF3a): picked on the navigation bar. */
  private mode: NavMode = "orbit";
  private bar: ReturnType<typeof navBar>;

  constructor(host: ViewHost, container: HTMLElement) {
    this.host = host;
    this.element = container;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.legend.className = "overlay-legend";
    this.legend.hidden = true;
    container.appendChild(this.legend);
    this.cube = new ViewCube((name) => this.setView(name), (dx, dy) => {
      const { dTheta, dPhi } = cubeDragAngles(dx, dy);
      this.setPose(orbitBy(this.cameraPose(), dTheta, dPhi));
    });
    container.appendChild(this.cube.element);
    this.bar = navBar({
      mode: (mode) => this.setMode(mode),
      fit: () => this.fitSelection() ?? this.fit(),
      lookAt: () => {
        const plane = this.host.sketchPlane();
        if (plane) this.lookAt(plane, this.host.sketchSide());
      },
      view: (name) => this.setView(name),
    });
    container.appendChild(this.bar.element);

    this.camera.position.set(80, -100, 70);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // No damping: an orbit, pan or zoom stops the moment the button is let
    // go, as the owner's reference CAD does. With OrbitControls' easing the
    // camera spun on after a fast flick, frame by frame, so for seconds where
    // frames are slow, and could roll under the sketch plane (25a5's hunt).
    this.controls.enableDamping = false;
    // Moving the camera by hand (SF3a, the owner's bindings): middle-drag pans and
    // the wheel zooms toward the pointer (navigate(), with the maths in
    // navigation.ts); Shift+middle-drag orbits, which OrbitControls does
    // for its pan button with Shift held, the only middle press it gets;
    // the right button is kept for a menu. Touch stays OrbitControls':
    // one finger orbits (pans in Pan mode), two pinch toward the fingers.
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = null;
    this.controls.zoomToCursor = true;
    this.navigate();
    this.setMode("orbit");

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
      if (plane) return this.host.sketchPointer({ kind: "click", ...this.pointerOn(e.clientX, e.clientY, plane) });
      // Picking a plane for a sketch: the nearer of an offered plane and a face, never an edge (26d).
      if (this.host.offeredFaces()) return this.host.pick({ ...this.planeTarget(e.clientX, e.clientY), edge: null, shift: e.shiftKey });
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
        if (plane) return this.host.sketchPointer(pointer ? { kind: "move", ...this.pointerOn(pointer.x, pointer.y, plane) } : { kind: "move", at: null });
        if (!pointer || !this.host.picking()) {
          this.host.setPlaneHover(null);
          return this.host.setHover(null, null);
        }
        const offered = this.host.offeredFaces();
        if (offered) {
          // Only what a click would pick and could sketch on lights: an offered plane, or an offered face.
          const target = this.planeTarget(pointer.x, pointer.y);
          this.host.setPlaneHover(target.plane);
          return this.host.setHover(target.face !== null && offered.has(target.face) ? target.face : null, null);
        }
        const edge = this.edgeAt(pointer.x, pointer.y);
        this.host.setHover(edge === null ? this.faceAt(pointer.x, pointer.y) : null, edge);
      });
    });
    canvas.addEventListener("pointerleave", () => {
      pointer = null;
      this.host.setHover(null, null);
      this.host.setPlaneHover(null);
      if (this.host.sketchPlane()) this.host.sketchPointer({ kind: "move", at: null });
    });

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.draw);
  }

  private draw = () => {
    this.controls.update();
    this.bar.canLookAt(!this.image && this.host.sketchPlane() !== null);
    this.host.frame(this);
    this.renderer.render(this.host.scene, this.camera);
    if (!this.image) this.cube.render(this.renderer, this.camera);
  };

  /**
   * Stops or restarts drawing this view: off, its canvas, view cube and
   * navigation bar are hidden and no frame is drawn (a pane showing a
   * workspace with no 3D view, such as a placeholder), its camera kept as
   * it was for when it comes back. `data-drawing` is read by the e2e test.
   */
  setDrawing(on: boolean) {
    if ((this.element.dataset.drawing !== "off") === on) return;
    this.renderer.setAnimationLoop(on ? this.draw : null);
    for (const el of [this.renderer.domElement, this.cube.element, this.bar.element, this.legend]) el.style.display = on ? "" : "none";
    if (on) delete this.element.dataset.drawing;
    else this.element.dataset.drawing = "off";
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

  /** What a left-button drag does from now on: orbit, pan or zoom (the navigation bar's first three buttons). */
  setMode(mode: NavMode) {
    this.mode = mode;
    this.element.dataset.nav = mode; // read by the e2e test
    this.bar.showMode(mode);
    this.applyButtons();
  }

  /** OrbitControls' share of the buttons for the mode: the left button orbits only in Orbit mode (Pan and Zoom are navigate()'s), and pans in the 2D view; one finger pans in Pan mode and in 2D. */
  private applyButtons() {
    const flat = this.image !== null;
    this.controls.mouseButtons.LEFT = this.mode !== "orbit" ? null : flat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = this.mode === "pan" || flat ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  }

  /** The camera as navigation.ts sees it: position, orbit target and the screen's up (also read by the e2e test). */
  cameraPose(): CameraPose {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: up.toArray() };
  }

  /** Moves the camera to `pose` (same direction, so OrbitControls only re-aims); `zoom` scales the near and far planes with the distance in 3D, so nothing is clipped close up. */
  private setPose(pose: CameraPose, zoom = 1) {
    this.camera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    if (zoom !== 1 && !this.image) {
      this.camera.near *= zoom;
      this.camera.far *= zoom;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /** Zooms by `factor` toward the point under (clientX, clientY), within the view's allowed distances. */
  private zoomToward(clientX: number, clientY: number, factor: number) {
    const ndc = clientToNdc({ x: clientX, y: clientY }, this.renderer.domElement.getBoundingClientRect());
    if (!ndc) return;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const f = clampZoom(distance, factor, this.controls.minDistance, this.controls.maxDistance);
    if (f === 1 || !(f > 0)) return;
    this.setPose(zoomAt(this.cameraPose(), [ndc.x, ndc.y], { fov: this.camera.fov, aspect: this.camera.aspect }, f), f);
  }

  /**
   * The wheel, middle-drag, and left-drag in Pan and Zoom modes (SF3a).
   * Listens on the view's element before the canvas hears anything
   * (capture), so OrbitControls never sees what is handled here.
   */
  private navigate() {
    const canvas = this.renderer.domElement;
    const lens = () => ({ fov: this.camera.fov, aspect: this.camera.aspect });
    this.element.addEventListener("wheel", (e) => {
      if (e.target !== canvas) return;
      e.preventDefault();
      e.stopPropagation();
      // A trackpad pinch comes as a wheel turn with Ctrl held.
      this.zoomToward(e.clientX, e.clientY, wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey));
    }, { capture: true, passive: false });
    let drag: { id: number; action: "pan" | "zoom"; x: number; y: number; start: { x: number; y: number } } | null = null;
    this.element.addEventListener("pointerdown", (e) => {
      if (e.target !== canvas || e.pointerType === "touch" || drag) return;
      const action = dragAction(e.button, e.shiftKey, this.mode);
      if (action === null || action === "orbit") return; // orbits are OrbitControls'
      e.preventDefault(); // no middle-button autoscroll
      e.stopPropagation(); // neither OrbitControls nor the click picker hears it
      canvas.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, action, x: e.clientX, y: e.clientY, start: { x: e.clientX, y: e.clientY } };
    }, { capture: true });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.action === "pan") this.setPose(panBy(this.cameraPose(), dx, dy, lens(), canvas.clientHeight));
      else this.zoomToward(drag.start.x, drag.start.y, dragZoomFactor(dy));
    });
    const end = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
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

  /** Where a point on screen meets a sketch plane and the size of a pixel there (sketch-view's pixelSize). */
  private pointerOn(clientX: number, clientY: number, plane: Plane): { at: SketchXY | null; pixel?: number } {
    const at = this.onPlane(clientX, clientY, plane);
    const pixel = at ? pixelSize(at, this.onPlane(clientX + 1, clientY, plane), this.onPlane(clientX, clientY + 1, plane)) : undefined;
    return pixel === undefined ? { at } : { at, pixel };
  }

  /**
   * Where the middle of this view meets a sketch plane and how big a pixel
   * is there (mm), and the view's diagonal in pixels, for the sketch grid.
   * When the middle misses the plane (looking along it or away), the
   * plane's origin and the pixel size at the camera's distance from it.
   * Null while the view has no size or shows an image.
   */
  planeLook(plane: Plane): { centre: SketchXY; pixel: number; diagonal: number } | null {
    const size = this.renderer.getSize(new THREE.Vector2());
    if (this.image || !(size.x > 0 && size.y > 0)) return null;
    const hit = (dx: number, dy: number) => {
      this.raycaster.setFromCamera(new THREE.Vector2((2 * dx) / size.x, (2 * dy) / size.y), this.camera);
      return rayOnPlane(this.raycaster.ray.origin.toArray(), this.raycaster.ray.direction.toArray(), plane);
    };
    const diagonal = Math.sqrt(size.x * size.x + size.y * size.y);
    const centre = hit(0, 0);
    const pixel = pixelSize(centre, hit(1, 0), hit(0, -1));
    if (centre && pixel !== undefined) return { centre, pixel, diagonal };
    const away = this.camera.position.distanceTo(new THREE.Vector3(...plane.origin));
    const across = (2 * away * Math.tan((this.camera.fov * Math.PI) / 360)) / size.y;
    return across > 0 && Number.isFinite(across) ? { centre: [0, 0], pixel: across, diagonal } : null;
  }

  /** A number that changes whenever this view's camera or size does (the sketch grid is worked out again only then). */
  cameraState(): string {
    const size = this.renderer.getSize(new THREE.Vector2());
    return `${this.camera.matrixWorld.elements.join(",")}|${this.camera.projectionMatrix.elements.join(",")}|${size.x}x${size.y}`;
  }

  /** The offered origin plane under a point on screen, by id, and how far along the ray it was hit; null for none. */
  private planeAt(clientX: number, clientY: number): { id: string; distance: number } | null {
    const meshes = this.host.planeMeshes();
    if (meshes.length === 0 || this.image || !this.aim(clientX, clientY)) return null;
    const [hit] = this.raycaster.intersectObjects(meshes, false);
    return hit ? { id: hit.object.userData.plane as string, distance: hit.distance } : null;
  }

  /** The kernel face index under a point on screen (client pixels), or null for empty space. */
  private faceAt(clientX: number, clientY: number): number | null {
    return this.faceHit(clientX, clientY)?.face ?? null;
  }

  /** The face under a point on screen and how far along the ray it was hit; null for empty space. */
  private faceHit(clientX: number, clientY: number): { face: number; distance: number } | null {
    const mesh = this.host.mesh();
    const faceMesh = this.host.faceMesh();
    if (!mesh || !faceMesh || this.image) return null; // the body is not drawn under an image
    const ndc = clientToNdc({ x: clientX, y: clientY }, this.renderer.domElement.getBoundingClientRect());
    if (!ndc) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    // Nearest hit first; for indexed geometry faceIndex is the triangle number.
    const [hit] = this.raycaster.intersectObject(faceMesh, false);
    const face = faceOfTriangle(mesh.triangle_faces, hit?.faceIndex);
    return face === null ? null : { face, distance: hit.distance };
  }

  /** While planes are offered (26d): the plane or the face a click there picks (picking.ts planeOrFace), any face, offered or not, so a curved one can be refused in words. */
  private planeTarget(clientX: number, clientY: number): { plane: string | null; face: number | null } {
    const plane = this.planeAt(clientX, clientY);
    const face = this.faceHit(clientX, clientY);
    const which = planeOrFace(plane?.distance ?? null, face?.distance ?? null);
    return { plane: which === "plane" ? plane!.id : null, face: which === "face" ? face!.face : null };
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

  /** Look At (SF2): square onto the plane from `side` of it (26d), its y axis up, framing the body and the edited sketch (planeViewBasis); null while this view shows an image. */
  lookAt(plane: Plane, side: 1 | -1 = 1): Framing | null {
    if (this.image) return null;
    const framing = this.host.lookAtFraming(plane);
    const { position, target, up } = planeViewBasis(plane, framing, this.camera.fov, this.camera.aspect, side);
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
    const towardCamera = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = fitDistance(framing.radius, this.camera.fov, this.camera.aspect);
    const target = new THREE.Vector3(...framing.centre);
    const position = target.clone().addScaledVector(towardCamera, dist);
    // The camera's current screen-up keeps the roll when looking straight down.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.place(position.toArray(), framing.centre, up.toArray());
    return framing;
  }

  private place(position: readonly number[], target: readonly number[], up: readonly number[]) {
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
    this.applyButtons();
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
    this.applyButtons();
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
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
    this.bar.element.remove();
    this.legend.remove();
    this.renderer.dispose();
  }
}

/** The sketch colours (sRGB): the edited sketch's lines bright, finished ones quieter, the grid faint, the axes red (x) and green (y). */
const SKETCH_COLOURS = { line: 0x6cc4ff, finished: 0x8b95a3, preview: 0xffb454, snap: 0x4dff88, point: 0xffffff, grid: 0xaab4c3, axisX: 0xe5534b, axisY: 0x57ab5a, plane: 0x6cc4ff, planeOff: 0x8b95a3 };
/**
 * How opaque the sketch grid's major lines are (minor ones fade in up to
 * this as they spread apart, sketch-view's minorStrength): light and see-
 * through, so the grid reads as paper under the sketch, never as the
 * body's dark edges.
 */
export const GRID_OPACITY = 0.16;
/** How opaque the origin axes are while sketching. */
export const AXIS_OPACITY = 1;
/** How opaque an origin plane offered for a sketch is, under the pointer, and one not offered. */
export const PLANE_OPACITY = { offered: 0.35, hover: 0.6, off: 0.12 };
/** How opaque the body's faces and edges are while a sketch is edited, so what is drawn shows through it (SF2). */
export const BODY_FADE = { faces: 0.3, edges: 0.35 };
/**
 * Draw order of the opaque lines and the body (three.js draws opaque objects
 * by renderOrder). The ground grid and axes come first and write no depth,
 * like a backdrop: every body and sketch is drawn over them, and a body edge
 * or sketch line lying on one (an extrude's bottom edges on the grid's
 * centre line, a box's corner edge on the Z axis) never fights it for the
 * pixels. Then finished sketches, then the body (0): a later line at the
 * same depth wins, so a body edge on a sketch line keeps its selection or
 * hover colour.
 */
const GROUND_ORDER = -2;
const FINISHED_SKETCH_ORDER = -1;

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
  /** The ground grid and the model's axes, hidden while a sketch with its own grid and axes is edited. */
  private grid: THREE.GridHelper;
  private axes = new THREE.AxesHelper(20);
  /** The edited sketch's grid and axes (redrawn when the main view's camera moves), what it was drawn for, and its minor lines' material (faded by zoom). */
  private sketchGridGroup = new THREE.Group();
  private gridFor: { plane: Plane; step: number | null } | null = null;
  private gridCamera = "";
  private gridKey = "";
  private minorMaterial: THREE.LineBasicMaterial | null = null;
  /** The edited sketch's ends in model space, for Look At. */
  private editedWorld: number[][] = [];
  /** The sketches drawn (showSketches) and the plane of the one being edited. */
  private sketches = new THREE.Group();
  private editedPlane: Plane | null = null;
  private editedSide: 1 | -1 = 1;
  private sketchHandler: ((pointer: SketchPointer) => void) | null = null;
  /** The origin planes drawn for picking (showPlanes). */
  private planes = new THREE.Group();
  private planeHits: THREE.Mesh[] = [];
  /** The body's faces offered with the planes (showPlanes), null while no planes are offered, and the offered plane under the pointer. */
  private pickFaces: ReadonlySet<number> | null = null;
  private planeHover: string | null = null;
  /** The main view first, then any added ones. */
  private views: ViewportView[] = [];
  readonly element: HTMLElement;

  constructor(container: HTMLElement) {
    this.element = container;
    this.scene.background = new THREE.Color(0x14161a);
    const grid = (this.grid = new THREE.GridHelper(200, 20, 0x3a3f47, 0x2a2e35));
    grid.rotation.x = Math.PI / 2; // lay the grid on the XY plane
    for (const ground of [grid, this.axes]) {
      ground.renderOrder = GROUND_ORDER;
      (ground.material as THREE.Material).depthWrite = false;
    }
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, -2, 3);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-2, 1, -1);
    this.scene.add(grid, this.axes, new THREE.AmbientLight(0xffffff, 0.5), key, fill, this.body, this.sketches, this.sketchGridGroup, this.planes);

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
      sketchSide: () => this.editedSide,
      sketchPointer: (pointer) => this.sketchHandler?.(pointer),
      planeMeshes: () => this.planeHits,
      offeredFaces: () => this.pickFaces,
      setPlaneHover: (plane) => this.setPlaneHover(plane),
      lookAtFraming: (plane) => this.lookAtFraming(plane),
      frame: (view) => this.frame(view),
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
    this.fadeBody();
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
   * Draws the sketches: lines, and for the one being edited its grid, its
   * points, the rubber-band line and the snap's marks. The edited one is
   * drawn over everything (no depth test; the body is see-through meanwhile).
   * A finished one is depth-tested like the body's edges, so the body hides
   * what is behind it (as an extruded sketch's back lines) and the faces'
   * polygon offset keeps a line lying on a face in front of it; drawn after
   * the ground grid and axes but before the body (FINISHED_SKETCH_ORDER), so
   * where it lies on a body edge the edge, with its selection or hover
   * colour, is drawn over it. Replaces what was drawn.
   */
  showSketches(drawings: readonly SketchDrawing[]) {
    clearGroup(this.sketches);
    this.editedPlane = null;
    this.editedSide = 1;
    this.gridFor = null;
    this.editedWorld = [];
    let lines = 0;
    for (const d of drawings) {
      const at = (p: SketchXY) => toWorld(d.plane, p);
      const segments = (pairs: readonly (readonly [SketchXY, SketchXY])[], colour: number, order: number) => {
        if (pairs.length === 0) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pairs.flatMap(([a, b]) => [...at(a), ...at(b)]), 3));
        const finished = order === FINISHED_SKETCH_ORDER;
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial(finished ? { color: colour } : { color: colour, depthTest: false, transparent: true }));
        l.renderOrder = order;
        this.sketches.add(l);
      };
      lines += d.lines.length;
      if (!d.editing) {
        segments(d.lines, SKETCH_COLOURS.finished, FINISHED_SKETCH_ORDER);
        continue;
      }
      this.editedPlane = d.plane;
      this.editedSide = d.side === -1 ? -1 : 1;
      this.gridFor = { plane: d.plane, step: d.editing.gridSnap ? d.editing.grid : null };
      this.editedWorld = [...d.lines.flatMap(([a, b]) => [at(a), at(b)]), ...d.editing.points.map(at)];
      segments(d.lines, SKETCH_COLOURS.line, 3);
      if (d.editing.preview.length > 0) segments(d.editing.preview, SKETCH_COLOURS.preview, 4);
      if (d.editing.points.length > 0) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(d.editing.points.flatMap((p) => at(p)), 3));
        const dots = new THREE.Points(g, new THREE.PointsMaterial({ color: SKETCH_COLOURS.point, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
        dots.renderOrder = 5;
        this.sketches.add(dots);
      }
      if (d.editing.snap) segments(d.editing.snap.marks, SKETCH_COLOURS.snap, 7);
    }
    this.grid.visible = this.axes.visible = this.editedPlane === null;
    this.gridCamera = this.gridKey = ""; // drawn again on the next frame, for this sketch
    if (!this.gridFor) this.drawGrid(null);
    this.fadeBody();
    // Read by the e2e test: how many lines are drawn, and the edited sketch's points and preview.
    const edited = drawings.find((d) => d.editing)?.editing;
    const xy = (p: SketchXY) => `${p[0]},${p[1]}`;
    this.element.dataset.sketchLines = String(lines);
    this.element.dataset.sketchPoints = edited ? edited.points.map(xy).join(" ") : "";
    this.element.dataset.sketchPreview = edited ? edited.preview.map((s) => s.map(xy).join(" ")).join(" | ") : "";
    this.element.dataset.sketchSnap = edited?.snap?.label ?? "";
    this.labelSketches();
  }

  /**
   * Before each frame of the main view: when its camera or size moved, the
   * edited sketch's grid for where the view's middle meets the plane and
   * the pixel size there (sketch-view's sketchGrid), drawn again only when
   * its spacing or reach changed; the minor lines' strength follows the zoom.
   */
  private frame(view: ViewportView) {
    if (view !== this.main || !this.gridFor) return;
    const state = view.cameraState();
    if (state === this.gridCamera) return;
    this.gridCamera = state;
    const look = view.planeLook(this.gridFor.plane);
    if (!look) return;
    this.drawGrid(sketchGrid(look.centre, look.pixel, look.diagonal, this.gridFor.step));
  }

  /** Draws the sketch grid and axes (null takes them away); says the spacing on the element (read by the e2e test). */
  private drawGrid(grid: ReturnType<typeof sketchGrid>) {
    const plane = this.gridFor?.plane;
    if (!grid || !plane) {
      clearGroup(this.sketchGridGroup);
      this.minorMaterial = null;
      this.gridKey = "";
      delete this.element.dataset.sketchGrid;
      delete this.element.dataset.sketchAxes;
      return;
    }
    if (this.minorMaterial) this.minorMaterial.opacity = GRID_OPACITY * grid.strength;
    this.element.dataset.sketchGrid = `minor ${grid.minor} major ${grid.major} strength ${grid.strength.toFixed(2)}`;
    const key = `${grid.minor} ${grid.bounds.join(" ")}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    clearGroup(this.sketchGridGroup);
    const at = (p: SketchXY) => toWorld(plane, p);
    const segments = (pairs: readonly (readonly [SketchXY, SketchXY])[], colour: number, opacity: number, order: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pairs.flatMap(([a, b]) => [...at(a), ...at(b)]), 3));
      const material = new THREE.LineBasicMaterial({ color: colour, depthTest: false, depthWrite: false, transparent: true, opacity });
      const l = new THREE.LineSegments(g, material);
      l.renderOrder = order;
      this.sketchGridGroup.add(l);
      return material;
    };
    this.minorMaterial = segments(grid.lines.filter((l) => !l.major).map((l) => [l.a, l.b]), SKETCH_COLOURS.grid, GRID_OPACITY * grid.strength, 1);
    segments(grid.lines.filter((l) => l.major).map((l) => [l.a, l.b]), SKETCH_COLOURS.grid, GRID_OPACITY, 1);
    if (grid.axes.x) segments([grid.axes.x], SKETCH_COLOURS.axisX, AXIS_OPACITY, 2);
    if (grid.axes.y) segments([grid.axes.y], SKETCH_COLOURS.axisY, AXIS_OPACITY, 2);
    this.element.dataset.sketchAxes = [grid.axes.x ? "x" : "", grid.axes.y ? "y" : ""].filter(Boolean).join(" ");
  }

  /** While a sketch is edited the body is drawn see-through (BODY_FADE), so the sketch shows through it; solid again after. */
  private fadeBody() {
    const faded = this.editedPlane !== null;
    for (const o of this.body.children) {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.LineSegments)) continue;
      const m = o.material as THREE.Material;
      if (m.transparent !== faded) m.needsUpdate = true;
      m.transparent = faded;
      m.depthWrite = !faded;
      m.opacity = faded ? (o instanceof THREE.Mesh ? BODY_FADE.faces : BODY_FADE.edges) : 1;
    }
    this.element.dataset.bodyFaded = String(faded);
  }

  /** What Look At frames (framing.ts lookAtFraming): the body's box corners and the edited sketch's ends, else round the plane's origin. */
  private lookAtFraming(plane: Plane): Framing {
    const box = new THREE.Box3().setFromObject(this.body);
    const corners = box.isEmpty() ? [] : [box.min.toArray(), box.max.toArray()];
    return lookAtFraming([...corners, ...this.editedWorld], plane.origin);
  }

  /** Look At in the main view. */
  lookAt(plane: Plane, side: 1 | -1 = 1): Framing | null {
    return this.main.lookAt(plane, side);
  }

  /** Says on the element whether a sketch is being edited with the pointer on it (read by the e2e test). */
  private labelSketches() {
    this.element.dataset.sketching = String(this.sketchHandler !== null && this.editedPlane !== null);
  }

  /**
   * Draws the origin planes as squares from the origin, as wide as the
   * 1.6 times the body's framing radius (at least 20 mm), so each sticks
   * out past the body. An offered one can be clicked, with the body's
   * `faces` (26d): the body hides it (depth tested, and pushed back further
   * than the body's faces, so a face lying in a plane is drawn and picked
   * rather than the plane), so what is seen is what a click picks.
   */
  showPlanes(planes: readonly OriginPlane[], faces: readonly number[] = []) {
    clearGroup(this.planes);
    this.planeHits = [];
    this.planeHover = null;
    this.pickFaces = planes.length > 0 || faces.length > 0 ? new Set(faces) : null;
    if (!this.pickFaces) this.setHover(null, null);
    const half = Math.max(10, 0.8 * this.bodyFraming().radius);
    for (const p of planes) {
      const corners: SketchXY[] = [[0, 0], [2 * half, 0], [2 * half, 2 * half], [0, 2 * half]];
      const world = corners.map((c) => toWorld(p.plane, c));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(world.flat(), 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const behindFaces = { polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 };
      const fill = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: p.offered ? SKETCH_COLOURS.plane : SKETCH_COLOURS.planeOff, transparent: true, opacity: p.offered ? PLANE_OPACITY.offered : PLANE_OPACITY.off, side: THREE.DoubleSide, depthWrite: false, ...behindFaces }));
      fill.renderOrder = 6;
      fill.userData.plane = p.id;
      const outline = new THREE.BufferGeometry();
      outline.setAttribute("position", new THREE.Float32BufferAttribute(world.flat(), 3));
      const rim = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({ color: p.offered ? SKETCH_COLOURS.plane : SKETCH_COLOURS.planeOff, transparent: true, opacity: p.offered ? 1 : 0.4 }));
      rim.renderOrder = 6;
      this.planes.add(fill, rim);
      if (p.offered) this.planeHits.push(fill);
    }
    this.element.dataset.planes = planes.map((p) => `${p.id}${p.offered ? "" : " (not offered)"}`).join(", "); // read by the e2e test
    this.element.dataset.pickFaces = faces.join(" "); // read by the e2e test
    delete this.element.dataset.hoverPlane;
  }

  /** The offered plane under the pointer drawn brighter (PLANE_OPACITY.hover); said on the element for the e2e test. */
  private setPlaneHover(plane: string | null) {
    if (plane === this.planeHover) return;
    this.planeHover = plane;
    for (const m of this.planeHits) (m.material as THREE.MeshBasicMaterial).opacity = m.userData.plane === plane ? PLANE_OPACITY.hover : PLANE_OPACITY.offered;
    if (plane) this.element.dataset.hoverPlane = plane;
    else delete this.element.dataset.hoverPlane;
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
