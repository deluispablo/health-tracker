import { effectivePhi, inflation, t975, tCdf } from "../stats";
import type { Interval } from "./types";

export interface ModelPoint { idx: number; y: number; a: 0 | 1; yPrev: number; weekend: 0 | 1; sleep?: number }
export interface ModelResult {
  diff: number | null; ci95: Interval | null; p: number | null; df: number | null;
  k: number; f: number; phi: number; n_eff_a: number; n_eff_b: number;
  adjusted_for: string[]; reason: "confounded" | null;
}

export function olsAdjusted(points: ModelPoint[], calendarLength: number, thatNight: boolean): ModelResult {
  const nuisance: { name: string; value: (p: ModelPoint) => number }[] = [
    { name: "previous_value", value: (p: ModelPoint) => p.yPrev },
    { name: "weekend", value: (p: ModelPoint) => p.weekend },
    ...(thatNight ? [{ name: "sleep_min", value: (p: ModelPoint) => {
      if (p.sleep === undefined) throw new RangeError("That-night model requires sleep duration deviations.");
      return p.sleep;
    } }] : []),
  ].filter(c => points.some(p => c.value(p) !== c.value(points[0])));
  const k = 2 + nuisance.length;
  const na = points.filter(p => p.a === 1).length, nb = points.length - na;
  const result: ModelResult = { diff: null, ci95: null, p: null, df: null, k, f: inflation(0.2), phi: 0.2,
    n_eff_a: na / inflation(0.2), n_eff_b: nb / inflation(0.2), adjusted_for: nuisance.map(c => c.name), reason: null };
  if (na < 3 || nb < 3) return result;
  const x: number[][] = [], gram = Array.from({ length: k }, () => Array<number>(k).fill(0));
  const xy = Array<number>(k).fill(0);
  for (const p of points) {
    const row = [1, p.a];
    for (const c of nuisance) row.push(c.value(p));
    x.push(row);
    for (let i = 0; i < k; i++) {
      xy[i] += row[i] * p.y;
      for (let j = 0; j < k; j++) gram[i][j] += row[i] * row[j];
    }
  }
  let largest = 0;
  for (const row of gram) for (const v of row) largest = Math.max(largest, Math.abs(v));
  const threshold = 1e-10 * largest;
  const augmented = gram.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => Number(i === j))]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let i = col + 1; i < k; i++) if (Math.abs(augmented[i][col]) > Math.abs(augmented[pivot][col])) pivot = i;
    if (Math.abs(augmented[pivot][col]) < threshold) return { ...result, reason: "confounded" };
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = augmented[col][col];
    for (let j = 0; j < 2 * k; j++) augmented[col][j] /= divisor;
    for (let i = 0; i < k; i++) {
      if (i === col) continue;
      const factor = augmented[i][col];
      for (let j = 0; j < 2 * k; j++) augmented[i][j] -= factor * augmented[col][j];
    }
  }
  const inverse = augmented.map(row => row.slice(k));
  const beta = inverse.map(row => row.reduce((sum, v, j) => sum + v * xy[j], 0));
  const residuals: (number | null)[] = Array<null>(calendarLength).fill(null);
  let rss = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let fitted = 0;
    for (let j = 0; j < k; j++) fitted += x[i][j] * beta[j];
    const residual = p.y - fitted;
    residuals[p.idx] = residual;
    rss += residual * residual;
  }
  const phi = effectivePhi(residuals), f = inflation(phi), ne = points.length / f;
  const fitted = { ...result, diff: beta[1], phi, f, n_eff_a: na / f, n_eff_b: nb / f };
  if (fitted.n_eff_a < 2 || fitted.n_eff_b < 2 || ne - k < 2) return fitted;
  const df = Math.floor(ne - k);
  const se = Math.sqrt(Math.max(0, rss / (points.length - k) * inverse[1][1] * f));
  const margin = t975(df) * se;
  return { ...fitted, df, ci95: [beta[1] - margin, beta[1] + margin],
    p: se === 0 ? (beta[1] === 0 ? 1 : 0) : 2 * tCdf(-Math.abs(beta[1]) / se, df) };
}
