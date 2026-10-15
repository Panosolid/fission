import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { DisplayMesh } from "./kernel-types";

// The kernel is Z-up (like most CAD); Three.js defaults to Y-up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewer {
  private renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
  private controls: OrbitControls;
  private body = new THREE.Group();

  constructor(private container: HTMLElement) {
    this.scene.background = new THREE.Color(0x14161a);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

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
    const material = new THREE.MeshStandardMaterial({
      color: 0x9aa7b8,
      metalness: 0.1,
      roughness: 0.6,
      polygonOffset: true, // keep edges drawn on top of faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.Float32BufferAttribute(mesh.edge_lines, 3));
    this.body.add(
      new THREE.Mesh(geometry, material),
      new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x0b0c0e })),
    );
  }

  /** Half the diagonal of the current body's bounding box (0 if none). */
  bodyRadius(): number {
    const box = new THREE.Box3().setFromObject(this.body);
    return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
  }

  /** Frames the current body; returns the radius it framed (null if none). */
  fit(): number | null {
    const box = new THREE.Box3().setFromObject(this.body);
    if (box.isEmpty()) return null;
    const centre = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dir = new THREE.Vector3(0.6, -0.8, 0.55).normalize();
    this.camera.position.copy(centre).addScaledVector(dir, dist);
    this.controls.target.copy(centre);
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    return radius;
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
