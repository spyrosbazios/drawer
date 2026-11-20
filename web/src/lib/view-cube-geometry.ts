import type { Vec3 } from "@drawer/shared/api";
import type { ViewName } from "./camera-rig";

/** One face of the view cube: the standard view it snaps to, and where it sits on the model's axes. */
export interface CubeFace {
  view: Exclude<ViewName, "iso">;
  label: string;
  /** Model direction the face looks along (out of the cube). */
  normal: Vec3;
  /** The model direction that points up the face's text when the camera sits on that face. */
  up: Vec3;
}

export const CUBE_FACES: CubeFace[] = [
  { view: "front", label: "Front", normal: [0, -1, 0], up: [0, 0, 1] },
  { view: "back", label: "Back", normal: [0, 1, 0], up: [0, 0, 1] },
  { view: "right", label: "Right", normal: [1, 0, 0], up: [0, 0, 1] },
  { view: "left", label: "Left", normal: [-1, 0, 0], up: [0, 0, 1] },
  { view: "top", label: "Top", normal: [0, 0, 1], up: [0, 1, 0] },
  { view: "bottom", label: "Bottom", normal: [0, 0, -1], up: [0, -1, 0] },
];

/** The 8 corners as sign triples: each is an iso view from that corner. */
export const CORNER_SIGNS: Vec3[] = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz): Vec3 => [sx, sy, sz])));

export const cornerLabel = ([sx, sy, sz]: Vec3): string => `${sz > 0 ? "top" : "bottom"} ${sy < 0 ? "front" : "back"} ${sx > 0 ? "right" : "left"}`;

/** Cube-local space is CSS's (y down) with the model's y mirrored, so the cube's rotation stays a proper one. */
export const toLocal = ([x, y, z]: Vec3): Vec3 => [x, y === 0 ? 0 : -y, z];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1] + 0, a[2] * b[0] - a[0] * b[2] + 0, a[0] * b[1] - a[1] * b[0] + 0];

/** A face's element axes in cube-local space: x runs along the text, y down it, z out of the face. A proper rotation (right × down = normal). */
export function faceBasis({ normal, up }: CubeFace): { right: Vec3; down: Vec3; normal: Vec3 } {
  const n = toLocal(normal);
  const down = toLocal(up).map((v) => (v === 0 ? 0 : -v)) as Vec3;
  return { right: cross(down, n), down, normal: n };
}

/** The face as one CSS matrix, pushed `half` px out along its normal. */
export function faceTransform(face: CubeFace, half: number): string {
  const { right, down, normal } = faceBasis(face);
  const t = normal.map((v) => v * half);
  return `matrix3d(${right[0]},${right[1]},${right[2]},0,${down[0]},${down[1]},${down[2]},0,${normal[0]},${normal[1]},${normal[2]},0,${t[0]},${t[1]},${t[2]},1)`;
}
