import type { Inference, GroupStats, Interval, Label, Reason } from "./insights/types";
import { BH_Q } from "./insights/catalog";

export const roundOneDecimal = (value: number | null): number | null => value === null ? null : Math.round(value * 10) / 10;

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function sampleSd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const centre = mean(xs) ?? 0;
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - centre) ** 2, 0) / (xs.length - 1));
}

function logGamma(z: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
    -176.6150291621406, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let sum = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i++) sum += coefficients[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Modified Lentz continued fraction for the regularized incomplete beta function.
function betaFraction(x: number, a: number, b: number): number {
  const nonzero = (v: number) => Math.abs(v) < 1e-300 ? 1e-300 : v;
  let c = 1;
  let d = 1 / nonzero(1 - (a + b) * x / (a + 1));
  let result = d;
  for (let m = 1; m <= 200; m++) {
    const even = 2 * m;
    let coefficient = m * (b - m) * x / ((a + even - 1) * (a + even));
    d = 1 / nonzero(1 + coefficient * d);
    c = nonzero(1 + coefficient / c);
    result *= d * c;
    coefficient = -(a + m) * (a + b + m) * x / ((a + even) * (a + even + 1));
    d = 1 / nonzero(1 + coefficient * d);
    c = nonzero(1 + coefficient / c);
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return result;
}

function studentTail(df: number): (t: number) => number {
  const a = df / 2;
  const b = 0.5;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  return (t: number): number => {
    const x = df / (df + t * t);
    if (x === 1) return 0.5;
    const factor = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBeta);
    const beta = x < (a + 1) / (a + b + 2)
      ? factor * betaFraction(x, a, b) / a
      : 1 - factor * betaFraction(1 - x, b, a) / b;
    return beta / 2;
  };
}

export function tQuantile975(df: number): number {
  if (!(df > 0)) throw new RangeError("df must be positive");
  if (df === Infinity) return 1.959963984540054;
  // Avoid cancellation in logGamma and overflow in the beta fraction at large df.
  if (df > 1e7) {
    const z = 1.959963984540054;
    return z + (z ** 3 + z) / (4 * df);
  }
  const tail = studentTail(df);
  let lo = 0;
  let hi = 1;
  while (tail(hi) > 0.025) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tail(mid) > 0.025) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function welch(group: number[], ref: number[]): {
  diff: number; df: number | null; ci95: [number, number] | null;
} | null {
  if (group.length < 2 || ref.length < 2) return null;
  const diff = (mean(group) ?? 0) - (mean(ref) ?? 0);
  const a = (sampleSd(group) ?? 0) ** 2 / group.length;
  const b = (sampleSd(ref) ?? 0) ** 2 / ref.length;
  if (a + b === 0) return { diff, df: null, ci95: null };
  const df = (a + b) ** 2 / (a ** 2 / (group.length - 1) + b ** 2 / (ref.length - 1));
  const margin = tQuantile975(df) * Math.sqrt(a + b);
  return { diff, df, ci95: [diff - margin, diff + margin] };
}

export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length < 5) return null;
  const mx = mean(xs) ?? 0;
  const my = mean(ys) ?? 0;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  return xx === 0 || yy === 0 ? null : xy / Math.sqrt(xx * yy);
}

function lagMoments(series: ArrayLike<number | null>, centre: number, groups?: Int8Array, offset = 0): { numerator: number; denominator: number; pairs: number } {
  let numerator = 0, denominator = 0, pairs = 0;
  for (let i = 1; i < series.length; i++) {
    if (groups && (!groups[i + offset] || !groups[i + offset - 1])) continue;
    const previous = series[i - 1], current = series[i];
    if (previous === null || current === null) continue;
    numerator += (current - centre) * (previous - centre);
    denominator += (previous - centre) ** 2;
    pairs++;
  }
  return { numerator, denominator, pairs };
}

export function ar1Phi(series: (number | null)[]): number {
  const centre = mean(series.filter((x) => x !== null));
  if (centre === null) return 0;
  const { numerator, denominator, pairs } = lagMoments(series, centre);
  return pairs < 3 || denominator === 0 ? 0 : Math.max(-0.99, Math.min(0.99, numerator / denominator));
}

export function prewhiten(series: (number | null)[], phi: number): (number | null)[] {
  return series.map((value, i) => {
    const previous = i === 0 ? null : series[i - 1];
    return value === null || previous === null ? null : value - phi * previous;
  });
}

const t975Cache = new Map<number, number>();

export function t975(df: number): number {
  if (Number.isNaN(df)) throw new RangeError("df must be a number");
  if (df > 400) return 1.959963984540054;
  const key = Math.max(1, Math.floor(df));
  let value = t975Cache.get(key);
  if (value === undefined) {
    value = tQuantile975(key);
    t975Cache.set(key, value);
  }
  return value;
}

export function tCdf(t: number, df: number): number {
  if (!(df > 0)) throw new RangeError("df must be positive");
  if (df === Infinity || df > 1e7) return normalCdf(t);
  const tail = studentTail(df)(Math.abs(t));
  return t < 0 ? tail : 1 - tail;
}

export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z < 0 ? tail : 1 - tail;
}

export function effectivePhi(residuals: (number | null)[]): number {
  let pairs = 0;
  for (let i = 1; i < residuals.length; i++) {
    if (residuals[i - 1] !== null && residuals[i] !== null) pairs++;
  }
  return pairs < 10 ? 0.2 : Math.max(0.2, Math.min(0.9, ar1Phi(residuals)));
}

export function inflation(phi: number): number {
  return (1 + phi) / (1 - phi);
}

function welchInference(ma: number, mb: number, ssA: number, ssB: number, nA: number, nB: number, f: number): Inference {
  const result: Inference = { diff: null, ci95: null, p: null, df: null,
    phi: (f - 1) / (f + 1), n_eff_a: nA / f, n_eff_b: nB / f };
  if (nA < 3 || nB < 3) return result;
  const diff = ma - mb;
  result.diff = diff;
  const na = result.n_eff_a, nb = result.n_eff_b;
  if (na < 2 || nb < 2) return result;
  const va = Math.sqrt(ssA / (nA - 1)) ** 2 / na;
  const vb = Math.sqrt(ssB / (nB - 1)) ** 2 / nb;
  if (va + vb === 0) return { ...result, ci95: [diff, diff], p: diff === 0 ? 1 : 0 };
  const df = Math.max(1, Math.floor((va + vb) ** 2 / (va ** 2 / (na - 1) + vb ** 2 / (nb - 1))));
  const se = Math.sqrt(va + vb);
  const margin = t975(df) * se;
  return { ...result, df, ci95: [diff - margin, diff + margin], p: 2 * tCdf(-Math.abs(diff) / se, df) };
}

// The signed calendar preserves gaps and avoids allocating two sparse value arrays per row.
export function dependentGroups(values: (number | null)[], groups: Int8Array, start: number, end: number, binary: boolean,
  residuals: Float64Array = new Float64Array(end - start + 1)): GroupStats {
  let nA = 0, nB = 0, sumA = 0, sumB = 0;
  for (let i = start; i <= end; i++) {
    if (groups[i] === 1) { nA++; sumA += values[i] ?? 0; }
    else if (groups[i] === -1) { nB++; sumB += values[i] ?? 0; }
  }
  const ma = nA ? sumA / nA : null, mb = nB ? sumB / nB : null;
  let sum = 0, pairs = 0, ssA = 0, ssB = 0;
  for (let i = start; i <= end; i++) {
    if (!groups[i]) continue;
    const a = groups[i] === 1, x = (values[i] ?? 0) - ((a ? ma : mb) ?? 0);
    residuals[i - start] = x;
    if (a) ssA += x ** 2; else ssB += x ** 2;
    sum += x;
    if (i > start && groups[i - 1]) pairs++;
  }
  let phi = 0.2;
  if (pairs >= 10) {
    const centre = sum / (nA + nB);
    const { numerator, denominator } = lagMoments(residuals, centre, groups, start);
    phi = Math.max(0.2, Math.min(0.9, denominator === 0 ? 0 : numerator / denominator));
  }
  const f = inflation(phi), enough = nA >= 3 && nB >= 3;
  const stats: GroupStats = { n_a: nA, n_b: nB, mean_a: enough ? ma : null, mean_b: enough ? mb : null,
    diff: enough ? (ma ?? 0) - (mb ?? 0) : null, ci95: null, p: null, df: null, phi, n_eff_a: nA / f, n_eff_b: nB / f };
  if (!binary) {
    const inference = welchInference(ma ?? 0, mb ?? 0, ssA, ssB, nA, nB, f);
    stats.ci95 = inference.ci95; stats.p = inference.p; stats.df = inference.df;
  } else if (enough && stats.n_eff_a >= 2 && stats.n_eff_b >= 2) {
    const na = stats.n_eff_a, nb = stats.n_eff_b, xa = sumA * na / nA, xb = sumB * nb / nB;
    const pooled = Math.max(0, Math.min(1, (xa + xb) / (na + nb)));
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / na + 1 / nb));
    stats.ci95 = newcombeDiff(xa, na, xb, nb);
    stats.p = se === 0 ? 1 : 2 * normalCdf(-Math.abs(stats.diff ?? 0) / se);
  }
  return stats;
}

function calendarGroups(a: (number | null)[], b: (number | null)[], binary: boolean): GroupStats {
  if (a.length !== b.length) throw new RangeError("Group calendars must have equal lengths");
  const groups = new Int8Array(a.length), values: (number | null)[] = Array<null>(a.length).fill(null);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== null && b[i] !== null) throw new RangeError("Group calendars must be disjoint");
    if (a[i] !== null) { groups[i] = 1; values[i] = a[i]; }
    else if (b[i] !== null) { groups[i] = -1; values[i] = b[i]; }
  }
  return dependentGroups(values, groups, 0, a.length - 1, binary);
}

export function dependentWelch(a: (number | null)[], b: (number | null)[]): GroupStats {
  return calendarGroups(a, b, false);
}

export function newcombeDiff(xa: number, na: number, xb: number, nb: number): Interval {
  const wilson = (x: number, n: number): Interval => {
    const p = x / n, z2 = 1.959963984540054 ** 2;
    const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const margin = Math.sqrt(z2 * (p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    return [centre - margin, centre + margin];
  };
  const pa = xa / na, pb = xb / nb, diff = pa - pb;
  const [la, ua] = wilson(xa, na), [lb, ub] = wilson(xb, nb);
  return [diff - Math.hypot(pa - la, ub - pb), diff + Math.hypot(ua - pa, pb - lb)];
}

export function dependentRiskDiff(a: (0 | 1 | null)[], b: (0 | 1 | null)[]): GroupStats {
  return calendarGroups(a, b, true);
}

export function oneSampleDependent(d: (number | null)[]): { N: number; diff: number | null; ci95: Interval | null; p: number | null; df: number | null; phi: number; n_eff: number } {
  const values = d.filter(x => x !== null), N = values.length;
  const centre = mean(values) ?? 0;
  const phi = effectivePhi(d.map(x => x === null ? null : x - centre));
  const n_eff = N / inflation(phi);
  const result = { N, diff: N < 3 ? null : centre, ci95: null, p: null, df: null, phi, n_eff };
  if (N < 3 || n_eff < 2) return result;
  const df = Math.max(1, Math.floor(n_eff - 1));
  const se = (sampleSd(values) ?? 0) / Math.sqrt(n_eff);
  const margin = t975(df) * se;
  return { ...result, df, ci95: [centre - margin, centre + margin],
    p: se === 0 ? (centre === 0 ? 1 : 0) : 2 * tCdf(-Math.abs(centre) / se, df) };
}

export function benjaminiHochberg(ps: (number | null)[]): (number | null)[] {
  const sorted = ps.flatMap((p, i) => p === null ? [] : [{ p, i }]).sort((a, b) => a.p - b.p);
  const result: (number | null)[] = ps.map(() => null);
  let q = 1;
  for (let j = sorted.length - 1; j >= 0; j--) {
    q = Math.min(q, sorted[j].p * sorted.length / (j + 1));
    result[sorted[j].i] = q;
  }
  return result;
}

export function labelOf(r: { n_a: number; n_b: number; diff: number | null; ci95: Interval | null; q: number | null; rope: number }): { label: Label; reason: Reason | null } {
  if (r.n_a < 3 || r.n_b < 3) return { label: "sin_datos", reason: null };
  if (r.n_a < 8 || r.n_b < 8) return { label: "indicio", reason: "few_days" };
  if (r.ci95 === null) return { label: "indicio", reason: "few_effective_days" };
  if (r.ci95[0] >= -r.rope && r.ci95[1] <= r.rope) return { label: "sin_diferencia", reason: null };
  const significant = (r.ci95[0] > 0 || r.ci95[1] < 0) && r.q !== null && r.q <= BH_Q;
  if (significant && r.diff !== null && Math.abs(r.diff) >= r.rope) return { label: "probable", reason: null };
  return { label: "indicio", reason: significant ? "small_effect" : "uncertain" };
}
