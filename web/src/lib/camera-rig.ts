import type { Vec3 } from "@drawer/shared/api";
import { Quaternion, Vector3 } from "three";
import type { PerspectiveCamera, Sphere } from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** The standard views of a Z-up model (OpenSCAD's convention): the direction from the model to the camera. `top` and `bottom` are nudged off the pole so orbiting stays defined. */
export const VIEW_NAMES = ["iso", "front", "back", "right", "left", "top", "bottom"] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

export const VIEW_DIRECTIONS: Record<ViewName, Vec3> = {
  iso: [0.65, -1, 0.8],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, -0.001, 1],
  bottom: [0, -0.001, -1],
};

/**
 * What the Camera menu, the camera keys and the fit button drive. Both scenes implement it, so "go to view X" is
 * one implementation: `CameraRig`. (The view gizmo turns the camera by itself: `lib/viewport.ts`.)
 */
export interface ViewControl {
  /** Animates the camera to look at the model from `direction` (model to camera), keeping the model framed. */
  goTo(direction: Vec3): void;
  /** Animates back to the whole model in view, keeping the current direction. */
  fit(): void;
  /** Runs after every frame drawn. Returns the unsubscribe. */
  addRenderListener(l: () => void): () => void;
}

const DURATION_MS = 260;
const FIT_MARGIN = 1.15;

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Moves an orbit camera to frame a bounding sphere from a direction, with a short eased transition. */
export class CameraRig {
  private tween = 0;
  private readonly quat = new Quaternion();

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {
    this.controls.addEventListener("start", this.cancel);
  }

  /** The camera distance at which `sphere` fits the narrower of the vertical and horizontal fields of view. */
  distanceFor(sphere: Sphere, margin = FIT_MARGIN): number {
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return (Math.max(sphere.radius, 1e-3) * margin) / Math.sin(Math.min(vfov, hfov) / 2);
  }

  /** Frames `sphere` along `direction` (the current one when omitted). */
  frame(sphere: Sphere, options: { direction?: Vec3; margin?: number; animate: boolean }): void {
    this.cancel();
    const distance = this.distanceFor(sphere, options.margin);
    this.camera.near = distance / 100;
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();

    const from = this.camera.position.clone().sub(this.controls.target);
    const fromDir = from.lengthSq() > 0 ? from.clone().normalize() : new Vector3(...VIEW_DIRECTIONS.iso).normalize();
    const toDir = options.direction ? new Vector3(...options.direction).normalize() : fromDir.clone();
    const fromTarget = this.controls.target.clone();
    const fromDistance = Math.max(from.length(), 1e-6);

    if (!options.animate || reducedMotion()) {
      this.place(sphere.center, toDir, distance);
      return;
    }

    const turn = new Quaternion();
    if (fromDir.dot(toDir) < -0.9999) {
      // Opposite views: turn around the model's up axis rather than over a pole.
      turn.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
    } else {
      turn.setFromUnitVectors(fromDir, toDir);
    }
    const identity = new Quaternion();
    const dir = new Vector3();
    const target = new Vector3();
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      const e = 1 - (1 - t) ** 3;
      this.quat.copy(identity).slerp(turn, e);
      dir.copy(fromDir).applyQuaternion(this.quat);
      target.copy(fromTarget).lerp(sphere.center, e);
      this.place(target, dir, fromDistance + (distance - fromDistance) * e);
      this.tween = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.tween = requestAnimationFrame(step);
  }

  /** Stops a transition in flight (a person grabbed the camera, or the scene is going away). */
  cancel = (): void => {
    if (this.tween !== 0) cancelAnimationFrame(this.tween);
    this.tween = 0;
  };

  dispose(): void {
    this.cancel();
    this.controls.removeEventListener("start", this.cancel);
  }

  private place(target: Vector3, dir: Vector3, distance: number): void {
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.lookAt(target);
    this.controls.update();
  }
}
