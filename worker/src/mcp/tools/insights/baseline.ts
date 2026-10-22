import { METRICS } from "./catalog";
import type { MetricId } from "./types";
import type { DayTable } from "./units";

export interface Baseline { median: (number | null)[]; scale: (number | null)[]; z: (number | null)[] }
function median(values: number[]): number {
  values.sort((a,b) => a-b);
  const mid = Math.floor(values.length/2);
  return values.length % 2 ? values[mid] : (values[mid-1]+values[mid])/2;
}
export function baseline(values: (number | null)[], rope: number): Baseline {
  const result: Baseline = { median: [], scale: [], z: [] };
  for (let i=0; i<values.length; i++) {
    const prior = values.slice(Math.max(0,i-42),i).filter((x): x is number => x !== null && Number.isFinite(x));
    const m = prior.length >= 14 ? median(prior) : null;
    const scale = m === null ? null : Math.max(1.4826 * median(prior.map(x=>Math.abs(x-m))),rope);
    const x = values[i];
    result.median.push(m);
    result.scale.push(scale);
    result.z.push(m !== null && scale !== null && x !== null && Number.isFinite(x) ? (x-m)/scale : null);
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
