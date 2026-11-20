import {
  AmbientLight,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  MeshBasicMaterial,
  Plane,
  Raycaster,
  Vector2,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { CameraRig, VIEW_DIRECTIONS } from "./camera-rig";
import type { ViewControl } from "./camera-rig";
import type { Vec3 } from "@drawer/shared/api";
import { colorAt, fieldToVertexColors, hexToRgb } from "./field-colors";
import type { FieldScale } from "./field-colors";

export type MeshFormat = "stl" | "3mf" | "obj";
export type Axis3 = "x" | "y" | "z";
export type Point3 = [number, number, number];

/** A per-triangle field drawn on the model: `thickness` on the sequential scale, `deviation` on the diverging one. */
export interface FieldPaint {
  kind: "thickness" | "deviation";
  values: Float32Array;
  domain: readonly [number, number];
}

/** The model cut at `axis` = `offset`; the side below the plane is kept (as the server's section). */
export interface SectionCut {
  axis: Axis3;
  offset: number;
}

/** A place on the model a person clicked: model coordinates and the face's outward normal. */
export interface PickHit {
  position: Point3;
  normal: Point3 | null;
}

/** Camera position and orbit target: what two synchronised views share. */
export interface CameraPose {
  position: Point3;
  target: Point3;
}

const AXIS_NORMAL: Record<Axis3, Point3> = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };
/** Pointer travel (px) under which a press-and-release is a click, not an orbit drag. */
const CLICK_SLOP = 4;

/** Theme tokens are hex in core/theme.ts, which is the form three.js parses. */
const tokenHex = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const token = (name: string): Color => new Color(tokenHex(name));

/** The theme's field scales, read from the CSS variables (so a theme switch repaints). */
export function themeScale(kind: FieldPaint["kind"], domain: readonly [number, number]): FieldScale {
  return kind === "thickness"
    ? { stops: ["--app-scale-lo", "--app-scale-mid", "--app-scale-hi"].map((n) => hexToRgb(tokenHex(n))), domain, unknown: hexToRgb(tokenHex("--app-dev-zero")) }
    : { stops: ["--app-dev-neg", "--app-dev-zero", "--app-dev-pos"].map((n) => hexToRgb(tokenHex(n))), domain, unknown: hexToRgb(tokenHex("--app-dev-zero")) };
}

/** A CSS colour for one value of a field, for legends and pins: the same mapping the model is painted with. */
export function themeColorCss(kind: FieldPaint["kind"], domain: readonly [number, number], value: number): string {
  const [r, g, b] = colorAt(themeScale(kind, domain), value);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

let webgl: boolean | undefined;

/** Whether this browser can create a WebGL context; probed once. */
export function webglAvailable(): boolean {
  if (webgl === undefined) {
    try {
      const ctx = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
      webgl = ctx !== null;
      ctx?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl = false;
    }
  }
  return webgl;
}

export function formatOf(path: string): MeshFormat | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ext === "stl" || ext === "3mf" || ext === "obj" ? ext : null;
}

/**
 * A three.js view of one model: orbit controls, standard views (`ViewControl`), wireframe and grid toggles. It
 * renders on demand (when the camera, size or theme changes), not in a loop, and releases every GPU resource in `dispose`.
 */
export class MeshScene implements ViewControl {
  private readonly renderer = new WebGLRenderer({ antialias: true });
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 1000);
  private readonly controls: OrbitControls;
  private readonly rig: CameraRig;
  private readonly material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: DoubleSide });
  /** Draws the inside of the solid where the section cuts it open: reads as a flat cap in the cut colour. */
  private readonly capMaterial = new MeshBasicMaterial({ side: BackSide });
  private readonly clipPlane = new Plane();
  private readonly raycaster = new Raycaster();
  private section: SectionCut | null = null;
  private field: FieldPaint | null = null;
  private cap: Mesh | null = null;
  private pressAt: { x: number; y: number } | null = null;
  private readonly renderListeners = new Set<() => void>();
  private readonly viewListeners = new Set<(pose: CameraPose) => void>();
  private applyingView = false;
  private onPick: ((hit: PickHit) => void) | null = null;
  private readonly resize: ResizeObserver;
  private readonly themeWatch: MutationObserver;
  private model: Object3D | null = null;
  private grid: GridHelper | null = null;
  private bounds = new Sphere();
  private box = new Box3();
  private showGrid = true;
  private frame = 0;
  private disposed = false;

  constructor(private readonly host: HTMLElement) {
    this.camera.up.set(0, 0, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = "block";

    this.scene.add(new AmbientLight(undefined, 0.8));
    const key = new DirectionalLight(undefined, 2.2);
    key.position.set(1, -1.5, 2);
    this.camera.add(key); // the key light travels with the camera, so every preset is lit from the viewer's side
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.rig = new CameraRig(this.camera, this.controls);
    this.controls.addEventListener("change", this.requestRender);
    this.controls.addEventListener("change", this.emitView);
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.themeWatch = new MutationObserver(() => this.refreshColors());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    this.refreshColors();
    this.onResize();
  }

  /** Loads a model and fits it to the view. */
  async load(url: string, format: MeshFormat): Promise<void> {
    const object = await this.fetchModel(url, format);
    if (this.disposed) {
      this.release(object);
      return;
    }
    if (this.model) {
      this.scene.remove(this.model);
      this.release(this.model);
    }
    this.model = object;
    this.scene.add(object);
    this.attachCap();
    this.paintField();
    this.box.setFromObject(object);
    this.box.getBoundingSphere(this.bounds);
    this.rebuildGrid();
    this.rig.frame(this.bounds, { direction: VIEW_DIRECTIONS.iso, animate: false });
    this.requestRender();
  }

  goTo(direction: Vec3): void {
    this.rig.frame(this.bounds, { direction, animate: true });
  }

  fit(): void {
    this.rig.frame(this.bounds, { animate: true });
  }

  cubeTransforms(): { rotation: string; inverse: string } {
    return this.rig.cubeTransforms();
  }

  /** Called with a click on the model that was not an orbit drag; null stops pointing. */
  setPickHandler(handler: ((hit: PickHit) => void) | null): void {
    this.onPick = handler;
  }

  /** The loaded model's bounding box, or null before a model is loaded. */
  bounds3(): { min: Point3; max: Point3 } | null {
    if (!this.model) return null;
    return { min: this.box.min.toArray(), max: this.box.max.toArray() };
  }

  /** Paints a per-triangle field on the model, or back to the plain surface with null. False when the field does not match the mesh. */
  setField(field: FieldPaint | null): boolean {
    this.field = field;
    const ok = this.paintField();
    this.requestRender();
    return ok;
  }

  /** Cuts the model with a plane, or removes the cut with null. */
  setSection(cut: SectionCut | null): void {
    this.section = cut;
    if (cut) this.clipPlane.set(new Vector3(...AXIS_NORMAL[cut.axis]), cut.offset);
    const planes = cut ? [this.clipPlane] : [];
    this.material.clippingPlanes = planes;
    this.capMaterial.clippingPlanes = planes;
    this.material.side = cut ? FrontSide : DoubleSide;
    this.material.needsUpdate = true;
    this.capMaterial.needsUpdate = true;
    if (this.cap) this.cap.visible = cut !== null;
    this.requestRender();
  }

  /** Where a model point lands on the canvas, in CSS pixels; `behind` when it is behind the camera. */
  toScreen(p: Point3): { x: number; y: number; behind: boolean } {
    const v = new Vector3(...p).project(this.camera);
    const el = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight, behind: v.z > 1 };
  }

  /** Runs after every frame drawn (to move HTML markers with the model). Returns the unsubscribe. */
  addRenderListener(l: () => void): () => void {
    this.renderListeners.add(l);
    return () => this.renderListeners.delete(l);
  }

  /** Runs when a person moves the camera (not when `setView` moves it). Returns the unsubscribe. */
  addViewListener(l: (pose: CameraPose) => void): () => void {
    this.viewListeners.add(l);
    return () => this.viewListeners.delete(l);
  }

  getView(): CameraPose {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }

  setView(pose: CameraPose): void {
    this.applyingView = true;
    this.camera.position.set(...pose.position);
    this.controls.target.set(...pose.target);
    this.controls.update();
    this.applyingView = false;
    this.requestRender();
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
    this.requestRender();
  }

  setGrid(on: boolean): void {
    this.showGrid = on;
    if (this.grid) this.grid.visible = on;
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.rig.dispose();
    this.resize.disconnect();
    this.themeWatch.disconnect();
    this.controls.removeEventListener("change", this.requestRender);
    this.controls.removeEventListener("change", this.emitView);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderListeners.clear();
    this.viewListeners.clear();
    this.onPick = null;
    this.capMaterial.dispose();
    this.controls.dispose();
    if (this.model) this.release(this.model);
    this.disposeGrid();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private async fetchModel(url: string, format: MeshFormat): Promise<Object3D> {
    if (format === "stl") {
      const geometry = await new STLLoader().loadAsync(url);
      // Many STL exporters write zero normals; recomputing gives correct flat shading either way.
      geometry.computeVertexNormals();
      return new Mesh(geometry, this.material);
    }
    const group: Group = format === "3mf" ? await new ThreeMFLoader().loadAsync(url) : await new OBJLoader().loadAsync(url);
    group.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
      child.material = this.material;
      if (!child.geometry.getAttribute("normal")) child.geometry.computeVertexNormals();
    });
    return group;
  }

  /** The first triangle mesh of the model: the one STL meshes and fields are about. */
  private firstMesh(): Mesh | null {
    const found: Mesh[] = [];
    this.model?.traverse((child) => {
      if (child instanceof Mesh && child.material !== this.capMaterial) found.push(child);
    });
    return found[0] ?? null;
  }

  /** A back-face twin of the model mesh sharing its geometry; only visible while a section cuts the model. */
  private attachCap(): void {
    if (this.cap) this.cap.removeFromParent();
    const mesh = this.firstMesh();
    if (!mesh) {
      this.cap = null;
      return;
    }
    const cap = new Mesh(mesh.geometry, this.capMaterial);
    cap.visible = this.section !== null;
    cap.renderOrder = -1;
    mesh.add(cap);
    this.cap = cap;
  }

  private paintField(): boolean {
    const mesh = this.firstMesh();
    if (!mesh) {
      this.material.color = token("--app-model");
      return this.field === null;
    }
    const geometry = mesh.geometry;
    const triangles = geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
    const usable = this.field !== null && !geometry.index && this.field.values.length === triangles;
    if (usable && this.field) {
      geometry.setAttribute("color", new BufferAttribute(fieldToVertexColors(this.field.values, themeScale(this.field.kind, this.field.domain)), 3));
    } else if (geometry.getAttribute("color")) {
      geometry.deleteAttribute("color");
    }
    if (this.material.vertexColors !== usable) {
      this.material.vertexColors = usable;
      this.material.needsUpdate = true;
    }
    this.material.color = usable ? new Color(1, 1, 1) : token("--app-model");
    return usable || this.field === null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pressAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const start = this.pressAt;
    this.pressAt = null;
    if (!start || !this.onPick || !this.model) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const mesh = this.firstMesh();
    if (!mesh) return;
    // The cut-away side is not drawn, so a click there must reach the surface behind it.
    const hit = this.raycaster.intersectObject(mesh, false).find((h) => !this.section || this.clipPlane.distanceToPoint(h.point) >= 0);
    if (!hit) return;
    const round = (v: Vector3): Point3 => [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))];
    this.onPick({ position: round(hit.point), normal: hit.face ? round(hit.face.normal.clone().normalize()) : null });
  };

  private emitView = (): void => {
    if (this.applyingView) return;
    const pose = this.getView();
    for (const l of this.viewListeners) l(pose);
  };

  /** Frees a model's geometries. The shared material is kept: it belongs to the scene, not to a model. */
  private release(object: Object3D): void {
    object.traverse((child) => {
      if (child instanceof Mesh && child.geometry instanceof BufferGeometry) child.geometry.dispose();
    });
  }

  private rebuildGrid(): void {
    this.disposeGrid();
    const span = Math.max(this.box.max.x - this.box.min.x, this.box.max.y - this.box.min.y, 1);
    const size = Math.pow(10, Math.ceil(Math.log10(span * 2)));
    const grid = new GridHelper(size, 20, token("--app-faint"), token("--app-grid"));
    grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; the model's ground is XY
    const center = this.box.getCenter(new Vector3());
    grid.position.set(center.x, center.y, this.box.min.z);
    grid.visible = this.showGrid;
    this.grid = grid;
    this.scene.add(grid);
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const m = this.grid.material;
    (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    this.grid = null;
  }

  /** Re-reads the theme tokens: called at start and whenever the document's theme class changes. */
  private refreshColors(): void {
    this.scene.background = token("--app-card");
    this.capMaterial.color = token("--app-cut");
    this.paintField();
    if (this.model) this.rebuildGrid();
    this.requestRender();
  }

  private onResize(): void {
    const w = Math.max(this.host.clientWidth, 1);
    const h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private requestRender = (): void => {
    if (this.disposed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      this.renderer.render(this.scene, this.camera);
      for (const l of this.renderListeners) l();
    });
  };
}
