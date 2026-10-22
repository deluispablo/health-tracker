import { describe, expect, it, vi } from "vitest";
import { offsetMinutes } from "../../src/ingest/drain";
import { dependentRiskDiff, dependentWelch, labelOf, oneSampleDependent, sampleSd } from "../../src/mcp/tools/stats";
import { baseline } from "../../src/mcp/tools/insights/baseline";
import { CALIBRATION_CAPS, METRICS } from "../../src/mcp/tools/insights/catalog";
import { ACUTE, acuteDays, candidateTimes, type AcuteInput, type WindowAgg } from "../../src/mcp/tools/insights/event";
import * as acuteEvent from "../../src/mcp/tools/insights/event";
import { evaluateMetricPair, finalizeMetricLabel } from "../../src/mcp/tools/insights/metric";
import type { AcuteTracker, MetricPair } from "../../src/mcp/tools/insights/types";
import type { DayTable } from "../../src/mcp/tools/insights/units";

const RUNS = 400;
type Random = () => number;
type Layout = "interleaved" | "blocked";
function mulberry32(seed: number): Random {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const normal = (r: Random) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
function ar1(r: Random, n: number, phi: number): number[] {
  let x = normal(r);
  return Array.from({ length: n }, () => {
    x = phi * x + Math.sqrt(1 - phi * phi) * normal(r);
    return x;
  });
}
function layout(r: Random, n: number, kind: Layout): boolean[] {
  let left = 0, a = r() < 0.5;
  return Array.from({ length: n }, () => {
    if (kind === "interleaved") return r() < 0.5;
    if (left === 0) { a = !a; left = 5 + Math.floor(r() * 6); }
    left--;
    return a;
  });
}
function markov(r: Random, rates: number[], persistence: number): (0 | 1)[] {
  let state: 0 | 1 = r() < rates[0] ? 1 : 0;
  return rates.map(rate => {
    if (r() >= persistence) state = r() < rate ? 1 : 0;
    return state;
  });
}
function split<T extends number>(values: T[], groups: boolean[]): [ (T | null)[], (T | null)[] ] {
  return [values.map((v, i) => groups[i] ? v : null), values.map((v, i) => groups[i] ? null : v)];
}
// §10 pins calibration ROPE to 0.25 SD, including binary and acute cells, rather than production ROPEs.
const ropeOf = (values: (number | null)[]) => 0.25 * (sampleSd(values.filter(v => v !== null)) ?? 0);
function measured(name: string, seed: number, simulate: (r: Random) => boolean): number {
  const r = mulberry32(seed);
  let probable = 0;
  for (let run = 0; run < RUNS; run++) probable += Number(simulate(r));
  const share = probable / RUNS;
  console.info(`${name}: probable=${String(probable)}/${String(RUNS)}, share=${share.toFixed(4)}`);
  return share;
}

describe("continuous calibration", () => {
  for (const phi of [0, 0.5, 0.8]) for (const n of [30, 90]) for (const kind of ["interleaved", "blocked"] as const) {
    const name = `continuous null phi=${String(phi)} n=${String(n)} ${kind}`;
    it(name, () => {
      const share = measured(name, 11000 + phi * 1000 + n * 2 + Number(kind === "blocked"), r => {
        const values = ar1(r, n, phi);
        const s = dependentWelch(...split(values, layout(r, n, kind)));
        return labelOf({ ...s, q: s.p, rope: ropeOf(values) }).label === "probable";
      });
      expect(share).toBeLessThanOrEqual(0.15);
    });
  }
  it("planted 1-SD effect reaches probable in at least 70 percent at n=90 phi=0.5", () => {
    const share = measured("continuous planted 1-SD phi=0.5 n=90 interleaved", 12000, r => {
      const noise = ar1(r, 90, 0.5), groups = layout(r, 90, "interleaved");
      const sd = sampleSd(noise) ?? 1;
      const values = noise.map((x, i) => x + Number(groups[i]) * sd);
      const s = dependentWelch(...split(values, groups));
      return labelOf({ ...s, q: s.p, rope: ropeOf(values) }).label === "probable";
    });
    expect(share).toBeGreaterThanOrEqual(0.7);
  });
});

describe("binary calibration", () => {
  for (const persistence of [0.5, 0.8]) for (const rate of [0.2, 0.5]) for (const kind of ["interleaved", "blocked"] as const) {
    const name = `binary null persistence=${String(persistence)} rate=${String(rate)} n=90 ${kind}`;
    it(name, () => {
      const share = measured(name, 21000 + persistence * 1000 + rate * 100 + Number(kind === "blocked"), r => {
        const values = markov(r, Array<number>(90).fill(rate), persistence);
        const s = dependentRiskDiff(...split(values, layout(r, 90, kind)));
        return labelOf({ ...s, q: s.p, rope: ropeOf(values) }).label === "probable";
      });
      expect(share <= 0.15 || CALIBRATION_CAPS.binary).toBe(true);
    });
  }
});

const tz = "Europe/Madrid";
const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeZoneName: "longOffset" });
const offsets = new Map<number, number>();
function offsetAt(ts: number): number {
  let offset = offsets.get(ts);
  if (offset === undefined) { offset = offsetMinutes(ts, formatter); offsets.set(ts, offset); }
  return offset;
}
const acuteStart = Date.parse("2026-10-01T00:00:00Z") / 1000;
function localTime(day: number, minute: number): number {
  const nominal = acuteStart + day * 86400 + minute * 60;
  return nominal - offsetAt(nominal) * 60;
}

// Aggregation only: selection, exclusions and matching belong to acuteDays.
function aggregateMinutes(hr: (number | null)[], start: number, times: number[]): Map<number, WindowAgg> {
  const sums = [0], counts = [0];
  hr.forEach(v => { sums.push(sums[sums.length - 1] + (v ?? 0)); counts.push(counts[counts.length - 1] + Number(v !== null)); });
  function average(lo: number, hi: number) {
    const a = Math.max(0, Math.ceil((lo - start) / 60)), b = Math.min(hr.length, Math.ceil((hi - start) / 60));
    const n = counts[b] - counts[a];
    return { mean: n ? (sums[b] - sums[a]) / n : null, n };
  }
  return new Map(times.map(ts => {
    const base = average(ts - ACUTE.baselineMin * 60, ts);
    const resp = Object.fromEntries((Object.keys(ACUTE.response) as AcuteTracker[]).map(tracker => {
      const [lo, hi] = ACUTE.response[tracker];
      return [tracker, average(ts + lo * 60, ts + hi * 60)];
    })) as WindowAgg["resp"];
    return [ts, { tz_offset_min: offsetAt(ts), base_mean: base.mean, base_n: base.n, resp }];
  }));
}
function simulateAcute(r: Random, effect: number) {
  const input: AcuteInput = { taps: [], sleeps: [], workouts: [], windows: new Map(), nowSec: acuteStart + 30 * 86400 };
  for (let day = 0; day < 28; day++) {
    const ts = localTime(day, 9 * 60 + Math.floor(r() * 600));
    input.taps.push({ tracker: "cigarettes", ts, tz_offset_min: offsetAt(ts) });
    const second = localTime(day, 21 * 60 + 7);
    input.taps.push({ tracker: "cigarettes", ts: second, tz_offset_min: offsetAt(second) });
    if (day % 4 === 0) input.taps.push({ tracker: "caffeine", ts: ts + 300, tz_offset_min: offsetAt(ts + 300) });
    input.sleeps.push([localTime(day, 0), localTime(day, 7 * 60)]);
    input.workouts.push([localTime(day, 17 * 60), localTime(day, 18 * 60)]);
  }
  const start = acuteStart - 86400, length = 31 * 1440;
  const levels = ar1(r, 31, 0.6), slopes = levels.map(() => 0.002 + normal(r) * 0.001);
  const bumps = new Float64Array(length);
  for (const tap of input.taps.filter(t => t.tracker === "cigarettes")) {
    const i = (tap.ts - start) / 60;
    for (let j = i; j < i + 15; j++) bumps[j] += effect;
  }
  let noise = normal(r);
  const hr = Array.from({ length }, (_, i) => {
    noise = 0.8 * noise + 0.6 * normal(r);
    const day = Math.floor(i / 1440), minute = i % 1440;
    const value = 65 + levels[day] * 4 + slopes[day] * (minute - 720) + noise * 3 + bumps[i];
    return r() < 0.1 || minute >= 14 * 60 && minute < 14 * 60 + 30 ? null : value;
  });
  input.windows = aggregateMinutes(hr, start, candidateTimes(input.taps));
  const a = acuteDays(input, { start: "2026-10-01", end: "2026-10-28" }).find(row => row.tracker === "cigarettes");
  if (!a) throw new Error("Missing cigarette acute result");
  const calendar: (number | null)[] = Array<null>(28).fill(null);
  a.dates.forEach((date, i) => { calendar[(Date.parse(date) / 1000 - acuteStart) / 86400] = a.d[i]; });
  const s = oneSampleDependent(calendar);
  const label = labelOf({ ...s, n_a: s.N, n_b: s.N, q: s.p, rope: ropeOf(calendar) }).label;
  return { a, s, label };
}

describe("acute calibration", () => {
  it("selects cigarettes when acute results are reordered", () => {
    const realAcuteDays = acuteDays;
    const mock = vi.spyOn(acuteEvent, "acuteDays").mockImplementationOnce((...args) => realAcuteDays(...args).reverse());
    try {
      const { a } = simulateAcute(mulberry32(31000), 0);
      expect(mock).toHaveBeenCalledOnce();
      expect(a.tracker).toBe("cigarettes");
      expect(a.eventDays).toBeGreaterThan(0);
    } finally {
      mock.mockRestore();
    }
  });
  it("minute aggregates preserve missing coverage, half-open windows and DST offsets", () => {
    const switchAt = Date.parse("2026-10-25T01:00:00Z") / 1000;
    const taps: AcuteInput["taps"] = [
      { tracker: "cigarettes", ts: switchAt - 1800, tz_offset_min: 120 },
      { tracker: "cigarettes", ts: switchAt, tz_offset_min: 60 },
    ];
    const start = switchAt - 3 * 3600;
    const hr: (number | null)[] = Array.from({ length: 27 * 60 }, (_, i) => i);
    const eventIndex = (switchAt - start) / 60;
    hr[eventIndex - 1] = null;
    const times = candidateTimes(taps);
    const windows = aggregateMinutes(hr, start, times);
    expect([...windows.keys()]).toEqual(times);
    expect(windows.get(switchAt)).toMatchObject({
      tz_offset_min: 60, base_n: 14, base_mean: eventIndex - 8.5,
      resp: { cigarettes: { n: 15, mean: eventIndex + 7 } },
    });
    expect(windows.get(switchAt - 1800)?.tz_offset_min).toBe(120);
    expect(windows.get(switchAt)?.tz_offset_min).toBe(60);
  });
  it("acute null through minute aggregates and daily selection across DST", () => {
    let dstExclusions = 0;
    const share = measured("acute null n=28 Madrid DST", 31000, r => {
      const { a, label } = simulateAcute(r, 0);
      expect(a.events).toBeLessThanOrEqual(ACUTE.maxEvents);
      expect(a.controls).toBeLessThanOrEqual(a.eventDays * ACUTE.maxControlsPerDay);
      dstExclusions += a.excluded.dst;
      for (const reason of ["overlap", "workout", "sleep", "coverage"] as const) {
        expect(a.excluded[reason], reason).toBeGreaterThan(0);
      }
      return label === "probable";
    });
    expect(dstExclusions).toBeGreaterThan(0);
    expect(share <= 0.15 || CALIBRATION_CAPS.acute).toBe(true);
  }, 60000);
  it("planted +8 bpm reaches probable with at least 10 event days in at least 70 percent", () => {
    const share = measured("acute planted +8 bpm n=28 Madrid DST", 32000, r => {
      const { s, label } = simulateAcute(r, 8);
      return s.N >= 10 && label === "probable";
    });
    expect(share).toBeGreaterThanOrEqual(0.7);
  }, 60000);
});

function simulateMetric(r: Random, phi: number, binary: boolean): boolean {
  const length = 224;
  const dates = Array.from({ length }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  const weekend = dates.map(d => [0, 6].includes(new Date(d).getUTCDay()));
  const x = ar1(r, length, phi), y = ar1(r, length, phi);
  const mood = markov(r, weekend.map(w => w ? 0.6 : 0.2), 0.5);
  const sleep: (number | null)[] = [], outcome: (number | null)[] = [];
  for (let i = 0; i < length; i++) {
    const common = Number(weekend[i]) * 0.75 + Number(r() < 0.1) * normal(r) + i * 0.005;
    const missing = r() < 0.15;
    sleep.push(missing ? null : 420 + 60 * (x[i] + (binary ? -Number(weekend[i]) : common)));
    outcome.push(missing ? null : binary ? mood[i] : 7000 + 2000 * (y[i] + common));
  }
  const metric = Object.fromEntries(Object.keys(METRICS).filter(m => m !== "hr_delta").map(m => [m, Array<null>(length).fill(null)])) as DayTable["metric"];
  metric.sleep_min = sleep;
  metric[binary ? "mood_tired" : "steps"] = outcome;
  const t: DayTable = {
    dates, idx: date => dates.indexOf(date), start: 43, end: 222, weekend, metric,
    behavior: { alcohol: Array<number>(length).fill(0), cigarettes: [], caffeine: [], mood_negative: [], mood_tired: [], workout: [], steps: [], short_sleep: [] },
    beforeBed: { cigarettes: [], caffeine: [], alcohol: [], mood_negative: [], workout: [] }, moodTaps: { mood_genial: [], mood_bien: [], mood_tranquilo: [], mood_cansado: [], mood_estresado: [], mood_ansioso: [], mood_triste: [], mood_enfadado: [] },
    first: { cigarettes: null, caffeine: null, alcohol: null, mood: null }, tests_last_24h: 0,
  };
  const rope = ropeOf(outcome);
  const bl = { sleep_min: baseline(sleep, ropeOf(sleep)), ...(!binary ? { steps: baseline(outcome, rope) } : {}) };
  const pair: MetricPair = { exposure: "sleep_min", side: "low", timing: "after_waking", outcome: binary ? "mood_tired" : "steps" };
  const s = evaluateMetricPair(t, bl, Array<boolean>(length).fill(false), pair, { includeAnomalies: false });
  if (binary) expect(s.sensitivity.weekdays).toBeDefined();
  // Measure the uncapped method so enabled fallback caps cannot hide its calibration rate.
  return finalizeMetricLabel(s, s.p, rope, null, { binary: false, acute: false, metricContinuous: false, metricBinary: false }).label === "probable";
}

describe("metric calibration", () => {
  for (const phi of [0.5, 0.8]) {
    const name = `metric continuous null phi=${String(phi)} n=180 weekend shock drift missing=0.15`;
    it(name, () => {
      const share = measured(name, 41000 + phi * 1000, r => simulateMetric(r, phi, false));
      expect(share <= 0.15 || CALIBRATION_CAPS.metricContinuous).toBe(true);
    });
  }
  it("metric binary Markov null with weekend-shortened sleep through weekday sensitivity", () => {
    const share = measured("metric binary null persistence=0.5 n=180 weekend missing=0.15", 42000, r => simulateMetric(r, 0.5, true));
    expect(share <= 0.15 || CALIBRATION_CAPS.metricBinary).toBe(true);
  });
});
