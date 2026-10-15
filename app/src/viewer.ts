import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Vec = [number, number, number];

// Kernel uses Z-up (like most CAD); Three.js defaults to Y-up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Viewer {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  private controls: OrbitControls;
  private arrows = new THREE.Group();

  constructor(private container: HTMLElement) {
    this.scene.background = new THREE.Color(0x14161a);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.camera.position.set(6, -8, 5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const grid = new THREE.GridHelper(10, 10, 0x3a3f47, 0x2a2e35);
    grid.rotation.x = Math.PI / 2; // lay the grid on the XY plane
    this.scene.add(grid, new THREE.AxesHelper(1.5), this.arrows);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  showVectors(a: Vec, b: Vec, sum: Vec, crossed: Vec) {
    this.arrows.clear();
    this.addArrow(a, 0x5aa9ff);
    this.addArrow(b, 0xc77dff);
    this.addArrow(sum, 0x3ddc97);
    this.addArrow(crossed, 0xffb547);
  }

  private addArrow(v: Vec, color: number) {
    const dir = new THREE.Vector3(...v);
    const length = dir.length();
    if (length < 1e-9) return;
    const head = Math.min(0.3, length * 0.3);
    this.arrows.add(
      new THREE.ArrowHelper(dir.normalize(), new THREE.Vector3(), length, color, head, head * 0.6),
    );
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
