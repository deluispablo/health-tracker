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

export function tQuantile975(df: number): number {
  if (!(df > 0)) throw new RangeError("df must be positive");
  if (df === Infinity) return 1.959963984540054;
  // Avoid cancellation in logGamma and overflow in the beta fraction at large df.
  if (df > 1e7) {
    const z = 1.959963984540054;
    return z + (z ** 3 + z) / (4 * df);
  }
  const a = df / 2;
  const b = 0.5;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const tail = (t: number): number => {
    const x = df / (df + t * t);
    if (x === 1) return 0.5;
    const factor = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBeta);
    const beta = x < (a + 1) / (a + b + 2)
      ? factor * betaFraction(x, a, b) / a
      : 1 - factor * betaFraction(1 - x, b, a) / b;
    return beta / 2;
  };
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

export function ar1Phi(series: (number | null)[]): number {
  const centre = mean(series.filter((x) => x !== null));
  if (centre === null) return 0;
  let numerator = 0;
  let denominator = 0;
  let pairs = 0;
  for (let i = 1; i < series.length; i++) {
    const previous = series[i - 1];
    const current = series[i];
    if (previous === null || current === null) continue;
    numerator += (current - centre) * (previous - centre);
    denominator += (previous - centre) ** 2;
    pairs++;
  }
  return pairs < 3 || denominator === 0 ? 0 : Math.max(-0.99, Math.min(0.99, numerator / denominator));
}

export function prewhiten(series: (number | null)[], phi: number): (number | null)[] {
  return series.map((value, i) => {
    const previous = i === 0 ? null : series[i - 1];
    return value === null || previous === null ? null : value - phi * previous;
  });
}
