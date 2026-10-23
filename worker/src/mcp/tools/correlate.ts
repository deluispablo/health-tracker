import { analysisSeries, BEHAVIORS, caveats, type Clock, OUTCOMES, round } from "./compare";
import { ar1Phi, pearson, prewhiten } from "./stats";

export const ANALYSIS_NAMES: readonly string[] = [...BEHAVIORS, ...OUTCOMES];

export async function healthCorrelate(db: D1Database, { x, y, start, end, max_lag = 3 }: {
  x: string; y: string; start: string; end: string; max_lag?: number;
}, clock: Clock) {
  if (!ANALYSIS_NAMES.includes(x)) throw new RangeError(`unknown x metric "${x}"; valid: ${ANALYSIS_NAMES.join(", ")}`);
  if (!ANALYSIS_NAMES.includes(y)) throw new RangeError(`unknown y metric "${y}"; valid: ${ANALYSIS_NAMES.join(", ")}`);
  if (x === y) throw new RangeError(`metric "${x}" is repeated in x and y; valid: ${ANALYSIS_NAMES.join(", ")}`);
  if (!Number.isInteger(max_lag) || max_lag < 0 || max_lag > 7) throw new RangeError("max_lag must be an integer from 0 to 7");
  const { days, series: [xs, ys] } = await analysisSeries(db, start, end, max_lag, [x, y], clock);
  const phi = ar1Phi(xs.slice(0, days));
  const filteredX = prewhiten(xs, phi);
  const filteredY = prewhiten(ys, phi);
  const lags = Array.from({ length: max_lag + 1 }, (_, lag) => {
    const pairedX: number[] = [];
    const pairedY: number[] = [];
    for (let i = 0; i < days; i++) {
      const a = filteredX[i];
      const b = filteredY[i + lag];
      if (a === null || b === null) continue;
      pairedX.push(a);
      pairedY.push(b);
    }
    return { lag, r: round(pearson(pairedX, pairedY)), n: pairedX.length };
  });
  return { x, y, start, end, phi: round(phi), lags, caveats: caveats(lags[0].n) };
}
