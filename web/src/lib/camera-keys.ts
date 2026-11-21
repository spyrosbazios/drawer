/**
 * The camera shortcuts of every 3D viewer: 0-6 pick a standard view, F fits. One list, shared by the Camera
 * menu (which prints the keys) and the keyboard handler. The handler answers anywhere in the workspace, so
 * it must stay out of the way of whatever is being typed into or has a menu open (`cameraCommand`).
 */
import type { ViewName } from "./camera-rig";

export const CAMERA_VIEWS: { view: ViewName; label: string; key: string }[] = [
  { view: "iso", label: "Isometric", key: "0" },
  { view: "front", label: "Front", key: "1" },
  { view: "back", label: "Back", key: "2" },
  { view: "right", label: "Right", key: "3" },
  { view: "left", label: "Left", key: "4" },
  { view: "top", label: "Top", key: "5" },
  { view: "bottom", label: "Bottom", key: "6" },
];
const FIT_KEY = "f";

export type CameraCommand = { kind: "view"; view: ViewName } | { kind: "fit" };

/** The parts of a keyboard event the decision reads, so a test can pass a plain object. */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: unknown;
}

/** Fields (and CodeMirror's contenteditable) take every key; menus, dialogs and lists have their own key handling. */
export function takesKeys(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el: ElementLike = target;
  if (el.isContentEditable === true) return true;
  if (typeof el.tagName === "string" && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
  return typeof el.closest === "function" && el.closest("[role=dialog],[role=alertdialog],[role=menu],[role=listbox]") !== null;
}

/** What a keystroke asks of the camera, or null when it is not for it. */
export function cameraCommand(e: KeyStroke): CameraCommand | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || takesKeys(e.target)) return null;
  const key = e.key.toLowerCase();
  if (key === FIT_KEY) return { kind: "fit" };
  const hit = CAMERA_VIEWS.find((v) => v.key === key);
  return hit ? { kind: "view", view: hit.view } : null;
}
