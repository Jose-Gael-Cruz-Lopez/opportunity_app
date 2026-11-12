/**
 * Small dense linear algebra for the band model (a few dozen parameters at most): Cholesky
 * factorization, solves and the inverse of symmetric positive-definite matrices.
 */

export type Vector = number[];
export type Matrix = number[][];

export function zeros(n: number): Vector {
  return new Array<number>(n).fill(0);
}

export function zeroMatrix(rows: number, cols: number = rows): Matrix {
  return Array.from({ length: rows }, () => zeros(cols));
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** x'Ax for a symmetric A. */
export function quadraticForm(x: readonly number[], a: Matrix): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]!;
    if (xi === 0) continue;
    const row = a[i]!;
    for (let j = 0; j < x.length; j++) s += xi * row[j]! * x[j]!;
  }
  return s;
}

/** Lower-triangular L with A = LL', or null when A is not (numerically) positive definite. */
export function cholesky(a: Matrix): Matrix | null {
  const n = a.length;
  const l = zeroMatrix(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) return null;
        l[i]![i] = Math.sqrt(sum);
      } else {
        l[i]![j] = sum / l[j]![j]!;
      }
    }
  }
  return l;
}

/** Solves LL'x = b given the Cholesky factor L. */
export function choleskySolve(l: Matrix, b: readonly number[]): Vector {
  const n = l.length;
  const y = zeros(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  const x = zeros(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

/** Inverse of a symmetric positive-definite matrix, or null when it is singular. */
export function spdInverse(a: Matrix): Matrix | null {
  const l = cholesky(a);
  if (!l) return null;
  const n = a.length;
  const inv = zeroMatrix(n);
  for (let j = 0; j < n; j++) {
    const e = zeros(n);
    e[j] = 1;
    const col = choleskySolve(l, e);
    for (let i = 0; i < n; i++) inv[i]![j] = col[i]!;
  }
  // Symmetrize against rounding so quadratic forms stay exact mirrors.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      const v = 0.5 * (inv[i]![j]! + inv[j]![i]!);
      inv[i]![j] = v;
      inv[j]![i] = v;
    }
  }
  return inv;
}

/** A B C for square matrices (used for the sandwich H⁻¹ M H⁻¹). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const inner = b.length;
  const out = zeroMatrix(n, m);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < inner; k++) {
      const aik = a[i]![k]!;
      if (aik === 0) continue;
      const bk = b[k]!;
      const oi = out[i]!;
      for (let j = 0; j < m; j++) oi[j] = oi[j]! + aik * bk[j]!;
    }
  }
  return out;
}

/** Picks rows and columns `idx` of a square matrix. */
export function subMatrix(a: Matrix, idx: readonly number[]): Matrix {
  return idx.map((i) => idx.map((j) => a[i]![j]!));
}
