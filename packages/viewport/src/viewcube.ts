import * as THREE from "three";
import { clientToNdc, isClick } from "./picking.ts";
import { CUBE_CORNER, cubeView, viewDirection, type ViewName } from "./views.ts";

type Vec3 = [number, number, number];

/** Each face of the cube: its outward normal, and right and up as seen in that face's own view (views.ts). */
const FACES: { label: string; n: Vec3; right: Vec3; up: Vec3 }[] = [
  { label: "TOP", n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { label: "BOTTOM", n: [0, 0, -1], right: [1, 0, 0], up: [0, -1, 0] },
  { label: "FRONT", n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
  { label: "BACK", n: [0, 1, 0], right: [-1, 0, 0], up: [0, 0, 1] },
  { label: "LEFT", n: [-1, 0, 0], right: [0, -1, 0], up: [0, 0, 1] },
  { label: "RIGHT", n: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1] },
];

const TEXTURE_PX = 128;
/** The camera's half-height in cube units: the cube (−1…1) seen from a corner spans √3 ≈ 1.73. */
export const CUBE_VIEW_HALF = 1.9;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The view cube: a small cube in the viewport's corner that turns with the
 * main camera; a click on one of its faces or corners asks for that view,
 * and a drag on it orbits (SF3a: the way to orbit from a
 * trackpad).
 * It is drawn into the main renderer after the main scene (its own scene and
 * camera, scissored to its corner), and its own element over that corner
 * takes the pointer there, so it never picks or orbits the main view.
 */
export class ViewCube {
  readonly element = document.createElement("div");
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-CUBE_VIEW_HALF, CUBE_VIEW_HALF, CUBE_VIEW_HALF, -CUBE_VIEW_HALF, 0.1, 10);
  private faces: { mesh: THREE.Mesh; ctx: CanvasRenderingContext2D; texture: THREE.CanvasTexture; face: (typeof FACES)[number] }[] = [];
  private raycaster = new THREE.Raycaster();
  private hover: ViewName | null = null;

  constructor(onView: (name: ViewName) => void, onOrbit: (dx: number, dy: number) => void) {
    this.element.className = "view-cube";
    this.element.setAttribute("role", "img");
    this.element.setAttribute("aria-label", "View cube: click a face or corner to look from there, drag to orbit");
    for (const face of FACES) {
      const canvas = Object.assign(document.createElement("canvas"), { width: TEXTURE_PX, height: TEXTURE_PX });
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      // The plane's +x, +y, +z become the face's right, up and normal; it sits one unit out.
      const basis = [face.right, face.up, face.n].map((v) => new THREE.Vector3(...v));
      mesh.matrix.makeBasis(basis[0], basis[1], basis[2]).setPosition(basis[2]);
      mesh.matrixAutoUpdate = false;
      this.faces.push({ mesh, ctx: canvas.getContext("2d")!, texture, face });
      this.scene.add(mesh);
    }
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x8c9bb0 }));
    this.scene.add(outline);
    this.paint();

    // A press that stays within the click slop is a click; once it moves
    // further it is a drag, and every move after that orbits by its step.
    let down: { x: number; y: number; id: number; last: { x: number; y: number } | null } | null = null;
    this.element.addEventListener("pointerdown", (e) => {
      down = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId, last: null } : null;
      if (down) this.element.setPointerCapture(e.pointerId);
    });
    this.element.addEventListener("pointerup", (e) => {
      const start = down;
      down = null;
      if (!start || start.id !== e.pointerId || start.last || !isClick(start, { x: e.clientX, y: e.clientY })) return;
      const name = this.viewAt(e.clientX, e.clientY);
      if (name) onView(name);
    });
    this.element.addEventListener("pointercancel", () => (down = null));
    this.element.addEventListener("pointermove", (e) => {
      this.setHover(e.buttons === 0 ? this.viewAt(e.clientX, e.clientY) : null);
      if (!down || down.id !== e.pointerId) return;
      const here = { x: e.clientX, y: e.clientY };
      if (!down.last) {
        if (isClick(down, here)) return;
        down.last = { x: down.x, y: down.y };
      }
      onOrbit(here.x - down.last.x, here.y - down.last.y);
      down.last = here;
    });
    this.element.addEventListener("pointerleave", () => this.setHover(null));
  }

  /** The view under a point on screen (client pixels), or null off the cube. */
  private viewAt(clientX: number, clientY: number): ViewName | null {
    const ndc = clientToNdc({ x: clientX, y: clientY }, this.element.getBoundingClientRect());
    if (!ndc) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const [hit] = this.raycaster.intersectObjects(this.faces.map((f) => f.mesh), false);
    return hit ? cubeView(hit.point.toArray()) : null;
  }

  private setHover(name: ViewName | null) {
    if (name === this.hover) return;
    this.hover = name;
    this.element.dataset.hover = name ?? ""; // read by the e2e test
    this.element.style.cursor = name ? "pointer" : "";
    this.paint();
  }

  /** Draws each face's texture: its label, its corner squares, and the hovered face or corner. */
  private paint() {
    const s = TEXTURE_PX;
    const c = ((1 - CUBE_CORNER) / 2) * s; // a corner square's side in pixels
    const d = this.hover ? viewDirection(this.hover) : null;
    const isCorner = d !== null && d.every((x) => x !== 0);
    for (const { ctx, texture, face } of this.faces) {
      ctx.fillStyle = "#28313d";
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#323d4c";
      for (const [x, y] of [[0, 0], [s - c, 0], [0, s - c], [s - c, s - c]]) ctx.fillRect(x, y, c, c);
      ctx.fillStyle = "rgba(74, 168, 255, 0.6)";
      if (d && !isCorner && dot(d, face.n) === 1) {
        // The face itself: everything but its corner squares.
        ctx.fillRect(0, c, s, s - 2 * c);
        ctx.fillRect(c, 0, s - 2 * c, s);
      } else if (d && isCorner && dot(d, face.n) === 1) {
        // The hovered corner's square on this face: right/left and top/bottom from the face's own axes.
        ctx.fillRect(dot(d, face.right) > 0 ? s - c : 0, dot(d, face.up) > 0 ? 0 : s - c, c, c);
      }
      ctx.fillStyle = "#dfe5ee";
      ctx.font = `600 ${face.label.length > 4 ? 20 : 24}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(face.label, s / 2, s / 2);
      texture.needsUpdate = true;
    }
  }

  /** Draws the cube over its corner of the canvas, turned like the main camera. */
  render(renderer: THREE.WebGLRenderer, main: THREE.Camera) {
    const rect = this.element.getBoundingClientRect();
    const canvas = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 5).applyQuaternion(main.quaternion); // the camera's back (+z) points at the viewer
    this.camera.updateMatrixWorld();
    // Viewport and scissor are in CSS pixels from the canvas's bottom-left.
    const x = rect.left - canvas.left;
    const y = canvas.bottom - rect.bottom;
    const size = renderer.getSize(new THREE.Vector2());
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, rect.width, rect.height);
    renderer.setViewport(x, y, rect.width, rect.height);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = autoClear;
  }
}
