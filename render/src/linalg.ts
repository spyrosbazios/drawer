import type { Vec3 } from "@drawer/shared/api";

export interface Eigenpair {
  value: number;
  vector: Vec3;
}

/** Jacobi rotations for a symmetric 3×3 matrix in row-major order. Smallest eigenvalue first. */
export function symmetricEigen3(matrix: ArrayLike<number>): Eigenpair[] {
  const a = Float64Array.from(matrix);
  const vectors = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const scale = Math.max(...a.map(Math.abs));
  for (let sweep = 0; sweep < 32; sweep++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(a[i * 3 + j]!) > Math.abs(a[p * 3 + q]!)) {
        p = i;
        q = j;
      }
    }
    const apq = a[p * 3 + q]!;
    if (Math.abs(apq) <= Number.EPSILON * scale) break;
    const app = a[p * 3 + p]!,
      aqq = a[q * 3 + q]!;
    const tau = (aqq - app) / 2 / apq;
    const t = (tau < 0 ? -1 : 1) / (Math.abs(tau) + Math.hypot(1, tau));
    const c = 1 / Math.hypot(1, t),
      s = c * t;
    for (let i = 0; i < 3; i++) {
      const vp = vectors[i * 3 + p]!,
        vq = vectors[i * 3 + q]!;
      vectors[i * 3 + p] = c * vp - s * vq;
      vectors[i * 3 + q] = s * vp + c * vq;
      if (i === p || i === q) continue;
      const aip = a[i * 3 + p]!,
        aiq = a[i * 3 + q]!;
      a[i * 3 + p] = a[p * 3 + i] = c * aip - s * aiq;
      a[i * 3 + q] = a[q * 3 + i] = s * aip + c * aiq;
    }
    a[p * 3 + p] = app - t * apq;
    a[q * 3 + q] = aqq + t * apq;
    a[p * 3 + q] = a[q * 3 + p] = 0;
  }
  const pairs = [0, 1, 2].map((i): Eigenpair => ({
    value: a[i * 3 + i]!,
    vector: [vectors[i]!, vectors[i + 3]!, vectors[i + 6]!],
  }));
  return pairs.sort((a, b) => a.value - b.value);
}

/** Solve A x = b by Cholesky factorization. Return null if A is not positive definite. */
export function solveCholesky(matrix: ArrayLike<number>, rhs: ArrayLike<number>): Float64Array | null {
  const n = rhs.length;
  if (n < 1 || n > 7 || matrix.length !== n * n) throw new Error("expected a square system of order 1 to 7");
  const lower = new Float64Array(n * n);
  const x = Float64Array.from(rhs);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let value = matrix[i * n + j]!;
      for (let k = 0; k < j; k++) value -= lower[i * n + k]! * lower[j * n + k]!;
      if (i === j && !(value > 0 && Number.isFinite(value))) return null;
      lower[i * n + j] = i === j ? Math.sqrt(value) : value / lower[j * n + j]!;
    }
    let value = x[i]!;
    for (let j = 0; j < i; j++) value -= lower[i * n + j]! * x[j]!;
    x[i] = value / lower[i * n + i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let value = x[i]!;
    for (let j = i + 1; j < n; j++) value -= lower[j * n + i]! * x[j]!;
    x[i] = value / lower[i * n + i]!;
  }
  return x;
}
