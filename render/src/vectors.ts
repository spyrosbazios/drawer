import type { Vec3 } from "@drawer/shared/api";

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(...a);
export const unit = (a: Vec3): Vec3 => {
  const n = length(a);
  return n > 0 ? scale(a, 1 / n) : [0, 0, 0];
};
export const readVec = (a: ArrayLike<number>, i: number): Vec3 => [a[i]!, a[i + 1]!, a[i + 2]!];
export const reject = (a: Vec3, axis: Vec3): Vec3 => sub(a, scale(axis, dot(a, axis)));

export function planeBasis(normal: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const u = unit(cross(ref, normal));
  return [u, cross(normal, u)];
}
