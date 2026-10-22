import { METRICS } from "./catalog";
import type { MetricId } from "./types";
import type { DayTable } from "./units";

export interface Baseline { median: (number | null)[]; scale: (number | null)[]; z: (number | null)[] }
// Keep the trailing window sorted; MAD is the median of its two ordered distance halves.
export function baseline(values: (number | null)[], rope: number): Baseline {
  const result: Baseline = { median: [], scale: [], z: [] }, sorted: number[] = [];
  const position = (x: number): number => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  for (let i = 0; i < values.length; i++) {
    const old = values[i - 43], previous = values[i - 1];
    if (typeof old === "number" && Number.isFinite(old)) sorted.splice(position(old), 1);
    if (typeof previous === "number" && Number.isFinite(previous)) sorted.splice(position(previous), 0, previous);
    const n = sorted.length, mid = n >>> 1;
    let m: number | null = null, scale: number | null = null;
    if (n >= 14) {
      m = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      // Select the middle distance by partitioning the two sorted distance halves.
      const centre = m;
      const leftSize = mid, rightSize = n - mid;
      const distanceAt = (rank: number): number => {
        let lo = Math.max(0, rank - rightSize), hi = Math.min(rank, leftSize);
        while (lo <= hi) {
          const a = (lo + hi) >>> 1, b = rank - a;
          const al = a ? centre - sorted[mid - a] : -Infinity;
          const ar = a < leftSize ? centre - sorted[mid - a - 1] : Infinity;
          const bl = b ? sorted[mid + b - 1] - centre : -Infinity;
          const br = b < rightSize ? sorted[mid + b] - centre : Infinity;
          if (al > br) hi = a - 1;
          else if (bl > ar) lo = a + 1;
          else return Math.max(al, bl);
        }
        return NaN;
      };
      const upper = distanceAt(mid + 1);
      scale = Math.max(1.4826 * (n % 2 ? upper : (distanceAt(mid) + upper) / 2), rope);
    }
    const x = values[i];
    result.median.push(m); result.scale.push(scale);
    result.z.push(m !== null && scale !== null && x !== null && Number.isFinite(x) ? (x - m) / scale : null);
  }
  return result;
}

export function computeBaselines(t: DayTable): Partial<Record<MetricId, Baseline>> {
  return Object.fromEntries((Object.keys(t.metric) as (keyof DayTable["metric"])[])
    .filter(m => !METRICS[m].binary).map(m => [m, baseline(t.metric[m],METRICS[m].rope)]));
}
export function anomalyFlags(b: Partial<Record<MetricId, Baseline>>, length: number): boolean[] {
  return Array.from({length},(_,i)=>["rhr","skin_temp_dev","resp_rate"].some(m=>(b[m as MetricId]?.z[i] ?? -Infinity) >= 3));
}
