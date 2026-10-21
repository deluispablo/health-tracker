import { analysisSeries, round } from "./compare";
import { ANALYSIS_NAMES } from "./correlate";
import { mean, sampleSd } from "./stats";

const DAY = 86_400_000;

export async function healthTrend(db: D1Database, { metric, period, start, end }: {
  metric: string; period: "week" | "month"; start: string; end: string;
}) {
  if (!ANALYSIS_NAMES.includes(metric)) throw new RangeError(`metric must be one of: ${ANALYSIS_NAMES.join(", ")}`);
  if (!["week", "month"].includes(period)) throw new RangeError("period must be week or month");
  const { days, series: [series] } = await analysisSeries(db, start, end, 0, [metric]);
  const values = series.filter((value) => value !== null);
  const baselineMean = mean(values);
  const baselineSd = sampleSd(values);
  const groups = new Map<string, { days: number; values: number[] }>();
  const first = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const date = new Date(first + i * DAY);
    date.setUTCDate(period === "week" ? date.getUTCDate() - (date.getUTCDay() + 6) % 7 : 1);
    const key = date.toISOString().slice(0, 10);
    let group = groups.get(key);
    if (group === undefined) {
      group = { days: 0, values: [] };
      groups.set(key, group);
    }
    group.days++;
    const value = series[i];
    if (value !== null) group.values.push(value);
  }
  const buckets = Array.from(groups, ([period_start, group]) => {
    const bucketMean = mean(group.values);
    const n = group.values.length;
    const z = bucketMean === null || baselineMean === null || baselineSd === null || baselineSd === 0
      ? null : (bucketMean - baselineMean) / baselineSd;
    return { period_start, days: group.days, n, mean: round(bucketMean), sd: round(sampleSd(group.values)),
      min: n === 0 ? null : round(Math.min(...group.values)), max: n === 0 ? null : round(Math.max(...group.values)), z: round(z) };
  });
  return { metric, period, start, end, baseline: { mean: round(baselineMean), sd: round(baselineSd), n: values.length },
    buckets, caveats: "Descriptivo. z compara cada periodo con la media del rango; los periodos parciales tienen menos días." };
}
