import { BackSide, Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, FrontSide, MeshBasicMaterial, Plane, Raycaster, Vector2, GridHelper, Group, Mesh, MeshStandardMaterial, Sphere, Vector3 } from "three";
import type { Object3D } from "three";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { VIEW_DIRECTIONS } from "./camera-rig";
import type { ViewControl } from "./camera-rig";
import { Viewport, token, tokenHex } from "./viewport";
import { isMeshFormat, type MeshFormat, type Vec3 } from "@drawer/shared/api";
import { colorAt, fieldToVertexColors, hexToRgb } from "./field-colors";
import type { FieldScale } from "./field-colors";

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
  return ext && isMeshFormat(ext) ? ext : null;
}

/**
 * A three.js view of one model on the shared stage (`Viewport`: camera, gizmo, looks, drawing on demand): the
 * model with its fields, section cut and click-to-point, wireframe and grid toggles. It releases every GPU
 * resource in `dispose`.
 */
export class MeshScene implements ViewControl {
  private readonly view: Viewport;
  private readonly material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: DoubleSide, clipShadows: true });
  /** Draws the inside of the solid where the section cuts it open: reads as a flat cap in the cut colour. */
  private readonly capMaterial = new MeshBasicMaterial({ side: BackSide });
  private readonly clipPlane = new Plane();
  private readonly raycaster = new Raycaster();
  private section: SectionCut | null = null;
  private field: FieldPaint | null = null;
  private cap: Mesh | null = null;
  private pressAt: { x: number; y: number } | null = null;
  private readonly viewListeners = new Set<(pose: CameraPose) => void>();
  private applyingView = false;
  private onPick: ((hit: PickHit) => void) | null = null;
  private model: Object3D | null = null;
  private grid: GridHelper | null = null;
  private bounds = new Sphere();
  private box = new Box3();
  private showGrid = true;
  private disposed = false;

  constructor(host: HTMLElement) {
    this.view = new Viewport(host, () => this.refreshColors(), (direction) => this.goTo(direction));
    this.view.addCameraListener(this.emitView);
    this.view.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.view.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.refreshColors();
  }

  /** Loads a model and fits it to the view. */
  async load(url: string, format: MeshFormat): Promise<void> {
    const object = await this.fetchModel(url, format);
    if (this.disposed) {
      this.release(object);
      return;
    }
    if (this.model) {
      this.view.scene.remove(this.model);
      this.release(this.model);
    }
    this.model = object;
    this.view.scene.add(object);
    this.attachCap();
    this.paintField();
    this.box.setFromObject(object);
    this.box.getBoundingSphere(this.bounds);
    this.rebuildGrid();
    this.view.setStage(this.box);
    this.view.rig.frame(this.bounds, { direction: VIEW_DIRECTIONS.iso, animate: false });
    this.view.requestRender();
  }

  goTo(direction: Vec3): void {
    this.view.rig.frame(this.bounds, { direction, animate: true });
  }

  fit(): void {
    this.view.rig.frame(this.bounds, { animate: true });
  }

  /** Shows or removes the view gizmo (two canvases that share a camera show one). */
  setGizmo(on: boolean): void {
    this.view.setGizmo(on);
  }

  /** The realistic look (a room, a sun, shadows) instead of the flat one. */
  setRealistic(on: boolean): void {
    this.view.setRealistic(on);
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
    this.view.requestRender();
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
    this.view.requestRender();
  }

  /** Where a model point lands on the canvas, in CSS pixels; `behind` when it is behind the camera. */
  toScreen(p: Point3): { x: number; y: number; behind: boolean } {
    const v = new Vector3(...p).project(this.view.camera);
    const el = this.view.renderer.domElement;
    return { x: ((v.x + 1) / 2) * el.clientWidth, y: ((1 - v.y) / 2) * el.clientHeight, behind: v.z > 1 };
  }

  /** Runs after every frame drawn (to move HTML markers with the model). Returns the unsubscribe. */
  addRenderListener(l: () => void): () => void {
    return this.view.addRenderListener(l);
  }

  /** Runs when a person moves the camera (not when `setView` moves it). Returns the unsubscribe. */
  addViewListener(l: (pose: CameraPose) => void): () => void {
    this.viewListeners.add(l);
    return () => this.viewListeners.delete(l);
  }

  getView(): CameraPose {
    return { position: this.view.camera.position.toArray(), target: this.view.controls.target.toArray() };
  }

  setView(pose: CameraPose): void {
    this.applyingView = true;
    this.view.camera.position.set(...pose.position);
    this.view.controls.target.set(...pose.target);
    this.view.controls.update();
    this.applyingView = false;
    this.view.requestRender();
  }

  setWireframe(on: boolean): void {
    this.material.wireframe = on;
    this.view.requestRender();
  }

  setGrid(on: boolean): void {
    this.showGrid = on;
    if (this.grid) this.grid.visible = on;
    this.view.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    this.view.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.view.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.viewListeners.clear();
    this.onPick = null;
    this.capMaterial.dispose();
    if (this.model) this.release(this.model);
    this.disposeGrid();
    this.material.dispose();
    this.view.dispose();
  }

  private async fetchModel(url: string, format: MeshFormat): Promise<Object3D> {
    if (format === "stl" || format === "ply") {
      const loader = format === "stl" ? new STLLoader() : new PLYLoader();
      const geometry = await loader.loadAsync(url);
      // Many STL exporters write zero normals; recomputing gives correct flat shading either way.
      geometry.computeVertexNormals();
      return this.inLight(new Mesh(geometry, this.material));
    }
    const group: Group = format === "3mf" ? await new ThreeMFLoader().loadAsync(url) : await new OBJLoader().loadAsync(url);
    group.traverse((child) => {
      if (!(child instanceof Mesh)) return;
      (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose());
      child.material = this.material;
      if (!child.geometry.getAttribute("normal")) child.geometry.computeVertexNormals();
      this.inLight(child);
    });
    return group;
  }

  /** A model mesh casts and takes shadows; they are drawn only in the realistic look. */
  private inLight(mesh: Mesh): Mesh {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
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
    const rect = this.view.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view.camera);
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
    this.view.scene.add(grid);
  }

  private disposeGrid(): void {
    if (!this.grid) return;
    this.view.scene.remove(this.grid);
    this.grid.geometry.dispose();
    const m = this.grid.material;
    (Array.isArray(m) ? m : [m]).forEach((x) => x.dispose());
    this.grid = null;
  }

  /** Re-reads the theme tokens: called at start and whenever the document's theme class changes. */
  private refreshColors(): void {
    this.capMaterial.color = token("--app-cut");
    this.paintField();
    if (this.model) this.rebuildGrid();
    this.view.requestRender();
  }
}
