import { Box3, BufferGeometry, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, Plane, Raycaster, Sphere, SphereGeometry, Vector2, Vector3 } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import type { Axis, Vec3 } from "@drawer/shared/api";
import { VIEW_DIRECTIONS } from "./camera-rig";
import type { ViewControl } from "./camera-rig";
import { Viewport, token } from "./viewport";
import { explodeOffsets, toColumnMajor } from "@/components/assembly/assembly-model";

/** One placed instance to draw. `slot` picks the categorical colour `--app-cat<slot+1>`. */
export interface SceneInstance {
  id: string;
  mesh: string;
  matrix: readonly number[];
  slot: number;
}

export type AssemblyMode = "assembled" | "exploded" | "clashes" | "section";

export interface ScenePick {
  id: string;
  position: Vec3;
  normal: Vec3 | null;
}

const AXIS_NORMAL: Record<Axis, Vector3> = { x: new Vector3(-1, 0, 0), y: new Vector3(0, -1, 0), z: new Vector3(0, 0, -1) };
/** A pointer that moves more than this between down and up was an orbit drag, not a click. */
const CLICK_SLOP_PX = 5;

interface Placed {
  id: string;
  slot: number;
  mesh: Mesh;
  material: MeshStandardMaterial;
  base: Matrix4;
  center: Vector3;
}

/**
 * A three.js view of an assembly: every instance placed by its matrix, one geometry per distinct mesh URL
 * shared by its instances, a material per instance (so each can be tinted). Renders on demand and
 * releases every GPU resource in `dispose` (and the previous report's in `setInstances`).
 */
export class AssemblyScene implements ViewControl {
  private readonly view: Viewport;
  private readonly raycaster = new Raycaster();
  private readonly clip = new Plane(new Vector3(0, 0, -1), 0);
  private readonly markerGeometry = new SphereGeometry(1, 16, 12);
  private readonly markerMaterial = new MeshStandardMaterial({ depthTest: false, transparent: true, opacity: 0.85 });
  private geometries = new Map<string, BufferGeometry>();
  private placed: Placed[] = [];
  private markers: Mesh[] = [];
  private box = new Box3();
  private mode: AssemblyMode = "assembled";
  private explode = 0;
  private sectionAxis: Axis = "z";
  private sectionAt = 0.5;
  private danger = new Set<string>();
  private markerPairs: [string, string][] = [];
  private hovered: string | null = null;
  private selected = new Set<string>();
  private down: { x: number; y: number } | null = null;
  private generation = 0;
  private disposed = false;

  onHover: (id: string | null) => void = () => {};
  onPick: (pick: ScenePick | null) => void = () => {};

  constructor(host: HTMLElement) {
    this.view = new Viewport(host, () => this.refreshColors(), (direction) => this.goTo(direction));
    const el = this.view.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerleave", this.onPointerLeave);
    this.refreshColors();
  }

  /** Replaces what is drawn. Each distinct mesh URL is fetched once. Resolves when everything is placed. */
  async setInstances(instances: readonly SceneInstance[]): Promise<void> {
    const gen = ++this.generation;
    const urls = [...new Set(instances.map((i) => i.mesh))];
    const loader = new STLLoader();
    const loaded = await Promise.all(
      urls.map(async (url) => {
        const g = await loader.loadAsync(url);
        g.computeVertexNormals();
        return [url, g] as const;
      }),
    );
    if (this.disposed || gen !== this.generation) {
      for (const [, g] of loaded) g.dispose();
      return;
    }
    this.clearPlaced();
    this.geometries = new Map(loaded);
    for (const inst of instances) {
      const geometry = this.geometries.get(inst.mesh);
      if (!geometry) continue;
      const material = new MeshStandardMaterial({ roughness: 0.55, metalness: 0.05, side: DoubleSide, clippingPlanes: [], clipShadows: true });
      const mesh = new Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      const base = new Matrix4().fromArray(toColumnMajor(inst.matrix));
      mesh.matrix.copy(base);
      mesh.userData.instance = inst.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.updateMatrixWorld(true);
      const center = new Box3().setFromObject(mesh).getCenter(new Vector3());
      this.view.scene.add(mesh);
      this.placed.push({ id: inst.id, slot: inst.slot, mesh, material, base, center });
    }
    this.box.makeEmpty();
    for (const p of this.placed) this.box.expandByObject(p.mesh);
    this.applyPlacement();
    this.applyLook();
    this.view.setStage(this.box);
    this.view.rig.frame(this.sphere(), { direction: VIEW_DIRECTIONS.iso, margin: this.margin(), animate: false });
    this.view.requestRender();
  }

  setMode(mode: AssemblyMode): void {
    this.mode = mode;
    this.applyPlacement();
    this.applyLook();
  }

  /** 0..1: how far the exploded view pulls instances apart. */
  setExplode(f: number): void {
    this.explode = f;
    this.applyPlacement();
  }

  setSection(axis: Axis, at: number): void {
    this.sectionAxis = axis;
    this.sectionAt = at;
    this.applyLook();
  }

  /** Instances in failing pairs, and the pairs that get a clash marker. */
  setClashes(danger: ReadonlySet<string>, markerPairs: readonly [string, string][]): void {
    this.danger = new Set(danger);
    this.markerPairs = [...markerPairs];
    this.applyLook();
  }

  setSelected(ids: readonly string[]): void {
    this.selected = new Set(ids);
    this.applyLook();
  }

  goTo(direction: Vec3): void {
    this.view.rig.frame(this.sphere(), { direction, margin: this.margin(), animate: true });
  }

  fit(): void {
    this.view.rig.frame(this.sphere(), { margin: this.margin(), animate: true });
  }

  setGizmo(on: boolean): void {
    this.view.setGizmo(on);
  }

  /** The realistic look (a room, a sun, shadows) instead of the flat one. */
  setRealistic(on: boolean): void {
    this.view.setRealistic(on);
  }

  /** Runs after every frame drawn. Returns the unsubscribe. */
  addRenderListener(l: () => void): () => void {
    return this.view.addRenderListener(l);
  }

  private sphere(): Sphere {
    return this.box.isEmpty() ? new Sphere(new Vector3(), 10) : this.box.getBoundingSphere(new Sphere());
  }

  /** The exploded view needs more room around the same parts. */
  private margin(): number {
    return this.mode === "exploded" ? 1.15 + this.explode : 1.15;
  }

  dispose(): void {
    this.disposed = true;
    const el = this.view.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerleave", this.onPointerLeave);
    this.clearPlaced();
    this.markerGeometry.dispose();
    this.markerMaterial.dispose();
    this.view.dispose();
  }

  private clearPlaced(): void {
    for (const p of this.placed) {
      this.view.scene.remove(p.mesh);
      p.material.dispose();
    }
    for (const g of this.geometries.values()) g.dispose();
    this.placed = [];
    this.geometries.clear();
    this.clearMarkers();
  }

  private clearMarkers(): void {
    for (const m of this.markers) this.view.scene.remove(m);
    this.markers = [];
  }

  private applyPlacement(): void {
    const factor = this.mode === "exploded" ? this.explode : 0;
    const centers = new Map(this.placed.map((p) => [p.id, p.center.toArray() as Vec3]));
    const span = this.box.isEmpty() ? 10 : this.box.getSize(new Vector3()).length();
    const offsets = explodeOffsets(centers, factor * 1.5, span);
    for (const p of this.placed) {
      const o = offsets.get(p.id) ?? [0, 0, 0];
      p.mesh.matrix.copy(new Matrix4().makeTranslation(o[0], o[1], o[2]).multiply(p.base));
      p.mesh.matrixWorldNeedsUpdate = true;
    }
    this.view.scene.updateMatrixWorld(true);
    this.rebuildMarkers();
    this.view.requestRender();
  }

  private rebuildMarkers(): void {
    this.clearMarkers();
    if (this.mode !== "clashes") return;
    const size = this.box.isEmpty() ? 1 : this.box.getSize(new Vector3()).length() * 0.015;
    for (const [a, b] of this.markerPairs) {
      const pa = this.placed.find((p) => p.id === a);
      const pb = this.placed.find((p) => p.id === b);
      if (!pa || !pb) continue;
      const ba = new Box3().setFromObject(pa.mesh);
      const bb = new Box3().setFromObject(pb.mesh);
      const where = ba.intersectsBox(bb) ? ba.intersect(bb).getCenter(new Vector3()) : pa.center.clone().add(pb.center).multiplyScalar(0.5);
      const m = new Mesh(this.markerGeometry, this.markerMaterial);
      m.position.copy(where);
      m.scale.setScalar(Math.max(size, 0.3));
      m.renderOrder = 10;
      this.markers.push(m);
      this.view.scene.add(m);
    }
  }

  /** Colours, highlight and clipping for the current mode, hover and selection. */
  private applyLook(): void {
    const danger = token("--app-down");
    const faint = token("--app-faint");
    const glow = token("--app-brand");
    const extent = this.box.isEmpty() ? { min: 0, max: 0 } : { min: this.box.min[this.sectionAxis], max: this.box.max[this.sectionAxis] };
    this.clip.normal.copy(AXIS_NORMAL[this.sectionAxis]);
    this.clip.constant = extent.min + (extent.max - extent.min) * this.sectionAt;
    for (const p of this.placed) {
      const m = p.material;
      const clash = this.mode === "clashes";
      const inDanger = this.danger.has(p.id);
      m.color = clash ? (inDanger ? danger : faint) : token(`--app-cat${p.slot + 1}`);
      m.transparent = clash && !inDanger;
      m.opacity = clash && !inDanger ? 0.25 : 1;
      m.depthWrite = !m.transparent;
      m.clippingPlanes = this.mode === "section" ? [this.clip] : [];
      const lit = this.selected.has(p.id) ? 0.45 : this.hovered === p.id ? 0.22 : 0;
      m.emissive = glow;
      m.emissiveIntensity = lit;
      m.needsUpdate = true;
    }
    this.markerMaterial.color = danger;
    this.rebuildMarkers();
    this.view.requestRender();
  }

  private refreshColors(): void {
    this.applyLook();
  }

  private hit(e: PointerEvent): { id: string; position: Vec3; normal: Vec3 | null } | null {
    const r = this.view.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.view.camera);
    const hits = this.raycaster.intersectObjects(
      this.placed.map((p) => p.mesh),
      false,
    );
    // A section hides what is beyond the plane: skip hits there.
    const hit = hits.find((h) => this.mode !== "section" || this.clip.distanceToPoint(h.point) >= 0);
    if (!hit) return null;
    const id = String(hit.object.userData.instance);
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    return { id, position: hit.point.toArray() as Vec3, normal: n ? (n.toArray() as Vec3) : null };
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX || e.button !== 0) return;
    this.onPick(this.hit(e));
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.down || e.pointerType === "touch") return;
    const id = this.hit(e)?.id ?? null;
    if (id === this.hovered) return;
    this.hovered = id;
    this.view.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.onHover(id);
    this.applyLook();
  };

  private onPointerLeave = (): void => {
    if (this.hovered === null) return;
    this.hovered = null;
    this.onHover(null);
    this.applyLook();
  };
}
