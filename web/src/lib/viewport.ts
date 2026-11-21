import type { Vec3 } from "@drawer/shared/api";
import { AmbientLight, Box3, Color, DirectionalLight, Mesh, Object3D, PCFSoftShadowMap, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Sphere, Vector3, WebGLRenderer } from "three";
import type { Quaternion, Texture } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { ViewportGizmo } from "three-viewport-gizmo";
import type { GizmoOptions } from "three-viewport-gizmo";
import { CameraRig, VIEW_DIRECTIONS } from "./camera-rig";

// Models are Z-up (OpenSCAD's convention). three.js reads this when an object is created and the view gizmo reads
// it to name and place its faces, so it is set once, here, before any scene exists.
Object3D.DEFAULT_UP.set(0, 0, 1);

/** Theme tokens are hex in core/theme.ts, which is the form three.js parses. */
export const tokenHex = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const token = (name: string): Color => new Color(tokenHex(name));

/** The view gizmo's side, in CSS pixels, and its distance from the canvas's top right corner. */
export const GIZMO_PX = 92;
export const GIZMO_INSET_PX = 4;

/** From the model towards the sun of the realistic look: above, in front and to the left. */
const SUN_DIRECTION = new Vector3(-0.55, -0.8, 1.3).normalize();
/** The technical look: flat and even, every face readable. The realistic look turns most of it into the sun and the room. */
const FLAT = { ambient: 0.8, key: 2.2 };
const REAL = { ambient: 0.05, key: 0.25, sun: 1.5, room: 0.55, shadow: 0.16 };

/**
 * The gizmo's cube in the theme's colours. Its faces are named by axis, not by the library's own face names: for a
 * Z-up model it calls +Y the front, while here the front is the side a "front" view looks at (-Y, as in OpenSCAD).
 */
function gizmoOptions(container: HTMLElement): GizmoOptions {
  const hover = { color: tokenHex("--app-brand"), labelColor: tokenHex("--app-on-brand"), opacity: 1 };
  const face = (label: string) => ({ label, color: tokenHex("--app-raised"), labelColor: tokenHex("--app-fg"), opacity: 1, hover });
  const bevel = { color: tokenHex("--app-line"), opacity: 1, hover: { color: tokenHex("--app-brand"), opacity: 1 } };
  return {
    type: "cube",
    container,
    size: GIZMO_PX,
    placement: "top-right",
    offset: { top: GIZMO_INSET_PX, right: GIZMO_INSET_PX, bottom: 0, left: 0 },
    // A click only picks the view: the stage turns the camera there itself (`Viewport.onGizmoEnd`).
    animated: false,
    font: { family: "'Geist Variable', sans-serif", weight: 600 },
    background: { enabled: false },
    corners: bevel,
    edges: bevel,
    x: face("Right"),
    nx: face("Left"),
    y: face("Back"),
    ny: face("Front"),
    z: face("Top"),
    nz: face("Bottom"),
  };
}

/**
 * Turns the labels of the gizmo's top and bottom faces to read upright in this app's top and bottom views (X to
 * the right): the library writes them for its own, a quarter turn away. Its faces are the children that sit on
 * one axis; these two are the ones on Z.
 */
function turnPoleLabels(gizmo: ViewportGizmo): void {
  for (const face of gizmo.children) {
    if (face.position.x !== 0 || face.position.y !== 0 || face.position.z === 0) continue;
    face.rotateZ(face.position.z > 0 ? -Math.PI / 2 : Math.PI / 2);
  }
}

/**
 * The three.js stage both scenes stand on: one renderer, a Z-up orbit camera with its rig, the lights, the view
 * gizmo in the top right corner (a cube to click or drag, drawn by the same renderer in a corner of the same
 * canvas: no second WebGL context) and the two looks, flat or realistic. Dragging the gizmo is the library's;
 * a click on a face, an edge or a corner is handed to the scene (`onSnap`), so it lands exactly where the Camera
 * menu and the keys would put the camera, framed the same way. It draws on demand (when the camera, the
 * size, the theme or the scene changes), never in a loop. A scene adds its own objects to `scene`, asks for a frame
 * with `requestRender`, and tells the stage how big its model is with `setStage`.
 */
export class Viewport {
  readonly renderer = new WebGLRenderer({ antialias: true });
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(40, 1, 0.1, 1000);
  readonly controls: OrbitControls;
  readonly rig: CameraRig;
  private readonly ambient = new AmbientLight(undefined, FLAT.ambient);
  private readonly key = new DirectionalLight(undefined, FLAT.key);
  private readonly sun = new DirectionalLight(undefined, REAL.sun);
  private readonly ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: REAL.shadow, depthWrite: false }));
  private readonly renderListeners = new Set<() => void>();
  private readonly cameraListeners = new Set<() => void>();
  private readonly resize: ResizeObserver;
  private readonly themeWatch: MutationObserver;
  private gizmo: ViewportGizmo | null = null;
  private room: Texture | null = null;
  private realistic = false;
  /** Where the camera stood when a click on the gizmo began, until the scene has taken the view over. */
  private snapFrom: { position: Vector3; quaternion: Quaternion } | null = null;
  private frame = 0;
  private disposed = false;

  /**
   * `onTheme` runs when the document's theme changes, after the stage has taken its own colours: repaint what the
   * scene coloured. `onSnap` runs when a click on the gizmo picked a view: go there (the scene knows what to frame).
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly onTheme: () => void,
    private readonly onSnap: (direction: Vec3) => void,
  ) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    const el = this.renderer.domElement;
    el.style.display = "block";
    el.style.touchAction = "none";
    host.appendChild(el);
    // The gizmo's element sits above the canvas inside the host: keep its z-index from leaking over the page.
    host.style.isolation = "isolate";

    // The key light travels with the camera, so every view is lit from the viewer's side.
    this.key.position.set(1, -1.5, 2);
    this.camera.add(this.key);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0002;
    this.sun.visible = false;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.scene.add(this.ambient, this.camera, this.sun, this.sun.target, this.ground);
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0); // the room's ceiling is +Y, the model's is +Z
    this.scene.environmentIntensity = REAL.room;

    this.controls = new OrbitControls(this.camera, el);
    this.rig = new CameraRig(this.camera, this.controls);
    this.controls.addEventListener("change", this.onCameraMoved);

    this.resize = new ResizeObserver(() => this.onResize());
    this.resize.observe(host);
    this.themeWatch = new MutationObserver(() => this.refreshTheme());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    this.scene.background = token("--app-card");
    this.onResize();
  }

  requestRender = (): void => {
    if (this.disposed || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      this.renderer.render(this.scene, this.camera);
      // The gizmo animates its own snap to a face from inside its render, and asks for the next frame by a change event.
      this.gizmo?.render();
      for (const l of this.renderListeners) l();
    });
  };

  /** Runs after every frame drawn (to move HTML markers with the model). Returns the unsubscribe. */
  addRenderListener(l: () => void): () => void {
    this.renderListeners.add(l);
    return () => this.renderListeners.delete(l);
  }

  /** Runs when the camera moves, by the orbit controls, the gizmo or the rig. Returns the unsubscribe. */
  addCameraListener(l: () => void): () => void {
    this.cameraListeners.add(l);
    return () => this.cameraListeners.delete(l);
  }

  /** Shows or removes the view gizmo (two canvases that share a camera show one). */
  setGizmo(on: boolean): void {
    if (on === (this.gizmo !== null)) return;
    if (on) {
      const gizmo = new ViewportGizmo(this.camera, this.renderer, gizmoOptions(this.host));
      turnPoleLabels(gizmo);
      gizmo.attachControls(this.controls);
      gizmo.addEventListener("start", this.onGizmoStart);
      gizmo.addEventListener("change", this.onGizmoChange);
      gizmo.addEventListener("end", this.onGizmoEnd);
      this.gizmo = gizmo;
    } else {
      this.gizmo?.dispose();
      this.gizmo = null;
    }
    this.requestRender();
  }

  /**
   * The realistic look: the model lit by a room and a sun that casts shadows, on a floor that catches them. Meshes
   * take part by having `castShadow` / `receiveShadow` set; they cost nothing while the look is off.
   */
  setRealistic(on: boolean): void {
    if (on === this.realistic) return;
    this.realistic = on;
    this.renderer.shadowMap.enabled = on;
    this.scene.environment = on ? this.roomLight() : null;
    this.ambient.intensity = on ? REAL.ambient : FLAT.ambient;
    this.key.intensity = on ? REAL.key : FLAT.key;
    this.sun.visible = on;
    this.ground.visible = on;
    // Shadows and the environment are compiled into each material's program.
    this.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
    this.requestRender();
  }

  /** Fits the sun, its shadow and the floor to what the scene shows. */
  setStage(box: Box3): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    this.sun.target.position.copy(sphere.center);
    this.sun.position.copy(sphere.center).addScaledVector(SUN_DIRECTION, r * 4);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 2.2;
    cam.right = cam.top = r * 2.2;
    cam.near = r;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    this.sun.shadow.normalBias = r * 0.004;
    this.ground.scale.setScalar(r * 12);
    this.ground.position.set(sphere.center.x, sphere.center.y, box.min.z - r * 0.002);
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.themeWatch.disconnect();
    this.renderListeners.clear();
    this.cameraListeners.clear();
    document.removeEventListener("pointerup", this.onGizmoRelease);
    this.gizmo?.dispose();
    this.gizmo = null;
    this.rig.dispose();
    this.controls.removeEventListener("change", this.onCameraMoved);
    this.controls.dispose();
    this.room?.dispose();
    this.sun.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private onCameraMoved = (): void => {
    this.requestRender();
    for (const l of this.cameraListeners) l();
  };

  /** A press on the gizmo (a drag may follow), or a click on it that picked a view. */
  private onGizmoStart = (): void => {
    this.rig.cancel();
    if (this.gizmo?.animating) {
      this.snapFrom = { position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone() };
      return;
    }
    // The gizmo holds the orbit controls off from the press on, and gives them back only when a drag ends or a
    // view was picked: a click beside the cube would leave them off for good.
    document.addEventListener("pointerup", this.onGizmoRelease, { once: true });
  };

  private onGizmoRelease = (): void => {
    if (!this.gizmo?.animating) this.controls.enabled = true;
  };

  private onGizmoChange = (): void => {
    // While a click is being resolved the camera jumps to the picked view and back: nobody else should follow that.
    if (this.snapFrom) this.requestRender();
    else this.onCameraMoved();
  };

  /**
   * A drag ended, or the gizmo put the camera on the view a click picked. In the second case the camera goes back
   * to where it stood and the scene takes it to that view its own way: animated, framed, and with the roll the
   * standard views have (the gizmo's top and bottom are turned a quarter).
   */
  private onGizmoEnd = (): void => {
    const from = this.snapFrom;
    this.snapFrom = null;
    if (from) {
      const d = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position.copy(from.position);
      this.camera.quaternion.copy(from.quaternion);
      this.gizmo?.cameraUpdate();
      this.onSnap(d.z > 0.999 ? VIEW_DIRECTIONS.top : d.z < -0.999 ? VIEW_DIRECTIONS.bottom : [d.x, d.y, d.z]);
    }
    this.requestRender();
  };

  /** The room that lights the realistic look, baked once into an environment map. */
  private roomLight(): Texture {
    if (this.room) return this.room;
    const baker = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.room = baker.fromScene(room, 0.04).texture;
    room.dispose();
    baker.dispose();
    return this.room;
  }

  private refreshTheme(): void {
    this.scene.background = token("--app-card");
    if (this.gizmo) {
      // The gizmo's colours are baked into its textures: rebuild it. A rebuild lets go of the controls.
      this.gizmo.set(gizmoOptions(this.host));
      turnPoleLabels(this.gizmo);
      this.gizmo.attachControls(this.controls);
    }
    this.onTheme();
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
    this.gizmo?.update();
    this.requestRender();
  }
}
