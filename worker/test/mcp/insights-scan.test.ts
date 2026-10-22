import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeScan, evaluateScan, healthScan, validateScanArgs } from "../../src/mcp/tools/insights/scan";
import { BANNED, BEFORE_BED_HOURS, METRICS, METRIC_TIMINGS, NIGHT_METRICS, PLANNED, SCAN_PAIRS, behaviorExcluded, refusedMetricPair } from "../../src/mcp/tools/insights/catalog";
import { acuteDays, loadAcuteInput, type AcuteDays } from "../../src/mcp/tools/insights/event";
import { anomalyFlags, baseline, computeBaselines } from "../../src/mcp/tools/insights/baseline";
import { acuteDraft, behaviorDraft, finalizeFamily, tertiles, type RowDraft } from "../../src/mcp/tools/insights/compare";
import { evaluateMetricPair, finalizeMetricLabel } from "../../src/mcp/tools/insights/metric";
import { loadDayTable, resolveRange, type DayTable } from "../../src/mcp/tools/insights/units";
import type { EvalOptions, FamilyResult, InsightRow, Origin } from "../../src/mcp/tools/insights/types";
import { benjaminiHochberg } from "../../src/mcp/tools/stats";
import { FIXTURE, seedInsightsFixture } from "../fixtures/insights";
let ctx: ExecutionContext;
beforeEach(() => { ctx = createExecutionContext(); });
afterEach(async () => { await waitOnExecutionContext(ctx); });
const opts: EvalOptions = { nowSec: FIXTURE.now, tz: FIXTURE.tz };
const origin: Extract<Origin, {
    tool: "health_scan";
}> = { tool: "health_scan", args: { start: FIXTURE.start, end: FIXTURE.end } };
const range = resolveRange({ start: FIXTURE.start, end: FIXTURE.end }, opts.nowSec, opts.tz);
const publicRows = (r: Record<string, unknown>) => r.rows as InsightRow[];
function synthetic(): DayTable {
    const dates = Array.from({ length: 224 }, (_, i) => new Date(Date.parse(range.fetchStart) + i * 86400000).toISOString().slice(0, 10));
    return {
        dates, idx: d => dates.indexOf(d), start: 43, end: 222, weekend: dates.map(d => [0, 6].includes(new Date(d).getUTCDay())),
        behavior: Object.fromEntries(["cigarettes", "caffeine", "alcohol", "mood_negative", "mood_tired", "workout", "steps", "short_sleep", "water", "melatonin", "protein", "creatine"].map((b, j) => [b, dates.map((_, i) => b === "steps" ? 5000 + (i * 7919 % 7000) : (i * 17 + j * 7) % 11 < 5 ? 1 : 0)])) as DayTable["behavior"],
        beforeBed: Object.fromEntries(Object.keys(BEFORE_BED_HOURS).map(b => [b, dates.map((_, i) => i % 2)])) as DayTable["beforeBed"],
        metric: Object.fromEntries(Object.keys(METRICS).filter(m => m !== "hr_delta").map((m, j) => [m, dates.map((_, i) => METRICS[m as keyof typeof METRICS].binary ? i % 2 : 100.0123 + (i * 7919 + j * 139) % 101)])) as DayTable["metric"],
        moodTaps: {} as DayTable["moodTaps"], first: { cigarettes: null, caffeine: null, alcohol: null, water: null, melatonin: null, protein: null, creatine: null, mood: null }, tests_last_24h: 0,
    };
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });

it("validates ranges and canonicalizes defaults without storing limit", () => {
    expect(validateScanArgs({}, opts.nowSec, opts.tz)).toEqual({ origin: { tool: "health_scan", args: { window_days: 120 } }, limit: 10 });
    expect(validateScanArgs({ end: FIXTURE.end }, opts.nowSec, opts.tz).origin.args).toMatchObject({ start: "2026-06-03", end: FIXTURE.end });
});
it.each([
    [null, "args"], [{ limit: 11 }, "limit"], [{ limit: 0 }, "limit"], [{ limit: null }, "limit"], [{ limit: 1.5 }, "limit"],
    [{ behaviors: ["bogus"] }, "behaviors"], [{ metrics: ["mood_cansado"] }, "metrics"], [{ timings: ["backward"] }, "timings"],
    [{ metrics: "hrv" }, "metrics"], [{ behaviors: [] }, "behaviors"], [{ timings: [] }, "timings"],
    [{ start: 5 }, "start"], [{ end: "2026-02-30" }, "end"], [{ window_days: 30 }, "window_days"], [{ window_days: 181 }, "window_days"],
    [{ window_days: 3, end: FIXTURE.end }, "window_days"], [{ mode: "prospective" }, "mode"],
])("rejects invalid input %j naming its field", (args, field) => {
    expect(() => validateScanArgs(args, opts.nowSec, opts.tz)).toThrow(RangeError);
    expect(() => validateScanArgs(args, opts.nowSec, opts.tz)).toThrow(field);
});
it("scan on an empty database returns sin_datos rows and no error", async () => {
    const r = await healthScan(env.DB, {}, opts, ctx);
    expect(publicRows(r)).toHaveLength(10);
    expect(publicRows(r).every(row => row.label === "sin_datos" && row.diff === null)).toBe(true);
    expect(r.skipped).toEqual(expect.arrayContaining(["cigarettes", "caffeine", "alcohol"]));
    expect(r).toMatchObject({ tests: 376, truncated: true, tests_last_24h: 376 });
});
it("tests is 376 with full data and at most 420 always; excluded pairs are never tested", () => {
    const r = computeScan(synthetic(), null, origin, opts);
    expect(r.tests).toBe(376);
    expect(r.tests).toBeLessThanOrEqual(420);
    expect(r.rows).toHaveLength(r.tests);
    for (const row of r.rows) {
        const key = present(row.ref).key;
        if (key.kind === "behavior")
            expect(behaviorExcluded(present(key.behavior), key.metric)).toBe(false);
        if (key.kind === "metric")
            expect(refusedMetricPair(present(key.exposure).metric, key.timing as keyof typeof METRIC_TIMINGS, key.metric)).toBeNull();
    }
});
it("filters apply to behavior, acute and planned rows", () => {
    const filtered = validateScanArgs({ behaviors: ["cigarettes"], metrics: ["hr_delta", "deep_min"], timings: ["acute", "before_bed"] }, opts.nowSec, opts.tz).origin;
    const r = computeScan(synthetic(), null, filtered, opts);
    expect(r.rows.map(row => present(row.ref).key)).toEqual([
        { kind: "behavior", behavior: "cigarettes", timing: "before_bed", metric: "deep_min" },
        { kind: "acute", behavior: "cigarettes", timing: "acute", metric: "hr_delta" },
    ]);
});
it("only mode selects the canonical key and recomputes BH for a family of one", () => {
    const t = synthetic(), all = computeScan(t, null, origin, opts);
    for (const row of [all.rows[0], present(all.rows.find(r => r.planned_id === "M1")), present(all.rows.find(r => r.kind === "acute"))]) {
        const one = computeScan(t, null, origin, { ...opts, only: present(row.ref).key });
        expect(one.tests).toBe(1);
        expect(one.rows).toHaveLength(1);
        expect(one.rows[0].q).toBe(one.rows[0].p);
    }
    expect(computeScan(t, null, origin, { ...opts, only: { kind: "behavior", behavior: "short_sleep", timing: "following_night", metric: "deep_min" } }).rows).toEqual([]);
});
it("frozen cutpoints change steps groups only", () => {
    const t = synthetic(), normal = computeScan(t, null, origin, opts), cuts = { lo: 7000, hi: 11000 };
    const frozen = computeScan(t, null, origin, { ...opts, cutpoints: cuts });
    let changed = false;
    normal.rows.forEach((r, i) => {
        if (r.behavior === "steps") {
            expect(present(frozen.rows[i].ref).cutpoints).toEqual(cuts);
            changed ||= frozen.rows[i].n_a !== r.n_a || frozen.rows[i].n_b !== r.n_b;
        }
        else {
            expect(frozen.rows[i].n_a).toBe(r.n_a);
            expect(frozen.rows[i].diff).toBe(r.diff);
        }
    });
    expect(changed).toBe(true);
});
describe("main fixture", () => {
    let t: DayTable, family: FamilyResult;
    beforeAll(async () => {
        await seedInsightsFixture(env.DB);
        t = await loadDayTable(env.DB, range, opts.nowSec);
        family = await evaluateScan(env.DB, origin, opts);
    });
    it.each([
        ["cigarettes", "before_bed", "deep_min", "pct", -10],
        ["alcohol", "following_night", "hrv", "pct", -12],
        ["workout", "following_night", "sleep_min", "diff", 30],
        ["cigarettes", "acute", "hr_delta", "diff", 8],
    ])("finds planted %s/%s/%s", (behavior, timing, metric, field, expected) => {
        const row = present(family.rows.find(r => r.behavior === behavior && r.timing === timing && r.metric === metric));
        expect(row).toBeDefined();
        const value = present(row[field as "diff" | "pct"]);
        expect(Math.abs(value - expected)).toBeLessThanOrEqual(Math.abs(expected) * 0.25);
    });
    it("workout before-bed rows exist for every sleep metric with counts and labels", () => {
        for (const metric of NIGHT_METRICS) {
            const row = present(family.rows.find(r => r.behavior === "workout" && r.timing === "before_bed" && r.metric === metric));
            expect(row.n_a).toBeGreaterThan(3);
            expect(row.n_b).toBeGreaterThan(3);
            expect(row.label).toBeTruthy();
        }
    });
    it("M1 is within 25 percent of +2 bpm; M2, M4 and M7 carry planned ids", () => {
        expect(Math.abs(present(present(family.rows.find(r => r.planned_id === "M1")).diff) - 2)).toBeLessThanOrEqual(0.5);
        for (const id of ["M2", "M4", "M7"])
            expect(present(present(family.rows.find(r => r.planned_id === id)).ref).key.planned_id).toBe(id);
    });
    it("each null pair never above indicio; anomaly days excluded and counted", () => {
        for (const pair of FIXTURE.nullPairs) {
            const row = present(family.rows.find(r => r.behavior === pair.behavior && r.timing === pair.timing && r.metric === pair.metric));
            expect(["indicio", "sin_diferencia", "sin_datos"]).toContain(row.label);
        }
        expect(family.excluded.anomaly).toBeGreaterThan(0);
    });
    it("matches the shared row builders for the complete family", async () => {
        const acute = acuteDays(await loadAcuteInput(env.DB, { ...range, ...opts }), range);
        expect(family.rows).toEqual(referenceRows(t, acute));
    });
    it("evaluateScan writes nothing and returns the full family before ranking", async () => {
        const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first();
        expect((await evaluateScan(env.DB, origin, opts)).rows).toHaveLength(376);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_log").first()).toEqual(before);
        expect(present(family.rows[0].ref).key).toMatchObject(SCAN_PAIRS[0]);
    });
    it("limit 3 returns 3 rows, truncates, logs once, and includes this call in tests_last_24h", async () => {
        await env.DB.prepare("DELETE FROM analysis_log").run();
        const previous = await env.DB.prepare("SELECT COALESCE(SUM(tests),0) AS n FROM analysis_log WHERE ts >= ?").bind(opts.nowSec * 1000 - 86400000).first<{
            n: number;
        }>();
        const r = await healthScan(env.DB, { ...origin.args, limit: 3 }, opts, ctx);
        expect(publicRows(r)).toHaveLength(3);
        expect(r.truncated).toBe(true);
        expect(r.tests_last_24h).toBe(present(previous).n + family.tests);
        await waitOnExecutionContext(ctx);
        const log = await env.DB.prepare("SELECT * FROM analysis_log").all();
        expect(log.results).toHaveLength(1);
        expect(log.results[0]).toMatchObject({ tests: 376, tool: "health_scan", ts: opts.nowSec * 1000 });
        expect(JSON.stringify(r)).not.toMatch(BANNED);
        expect(JSON.stringify(r).length).toBeLessThanOrEqual(20000);
        expect(publicRows(r)[0]).not.toHaveProperty("kind");
    });
    it("statements are day table plus acute plus log; only non-acute skips acute SQL", async () => {
        const prepare = vi.spyOn(env.DB, "prepare");
        try {
            await healthScan(env.DB, origin.args, opts, ctx);
            expect(prepare).toHaveBeenCalledTimes(3);
            prepare.mockClear();
            await evaluateScan(env.DB, origin, { ...opts, only: present(family.rows[0].ref).key });
            expect(prepare).toHaveBeenCalledTimes(1);
            prepare.mockClear();
            await evaluateScan(env.DB, origin, { ...opts, only: present(present(family.rows.find(r => r.kind === "acute")).ref).key });
            expect(prepare).toHaveBeenCalledTimes(2);
        }
        finally {
            prepare.mockRestore();
        }
    });
});
it("common cause M1 is not robust", async () => {
    for (const table of ["event", "sleep_stage", "sleep_session", "daily_summary", "workout", "metric_minute"])
        await env.DB.prepare(`DELETE FROM ${table}`).run();
    await seedInsightsFixture(env.DB, { variant: "common_cause" });
    const r = await evaluateScan(env.DB, origin, opts);
    expect(present(present(r.rows.find(row => row.planned_id === "M1")).sensitivity).alcohol.status).toBe("not_robust");
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value.");
  return value;
}

it.each([1, 3, 7, 8, 12, 28, 180])("matches shared results on a %i-day synthetic range with gaps and ties", days => {
    const t = synthetic();
    t.start = t.end - days + 1;
    for (const values of Object.values(t.metric)) {
        for (let i = 0; i < values.length; i++) if (i % 19 === 0) values[i] = null;
    }
    t.behavior.steps = t.dates.map((_, i) => i % 5 === 0 ? null : 6000 + (i % 3) * 1000);
    t.behavior.cigarettes[223] = null;
    expect(computeScan(t, null, origin, opts).rows).toEqual(referenceRows(t, ["cigarettes", "caffeine", "alcohol"].map(tracker => ({
        tracker: tracker as AcuteDays["tracker"], dates: [], d: [], eventDays: 0, events: 0, controls: 0,
        excluded: { overlap: 0, workout: 0, sleep: 0, coverage: 0, dst: 0, no_control: 0, future: 0 },
    }))));
});

function referenceRows(t: DayTable, acute: AcuteDays[]) {
        const bl = computeBaselines(t), flags = anomalyFlags(bl, t.dates.length);
        const cuts = tertiles(t.behavior.steps.slice(t.start, t.end + 1).filter((x): x is number => x !== null));
        const drafts: RowDraft[] = SCAN_PAIRS.map(key => behaviorDraft(t, flags, key, { includeAnomalies: false, ...(key.behavior === "steps" ? { cutpoints: cuts } : {}) }).draft);
        drafts.push(...acute.map(acuteDraft));
        for (const p of PLANNED) {
            const s = evaluateMetricPair(t, bl, flags, p, { includeAnomalies: false });
            const offset = METRIC_TIMINGS[p.timing].offset;
            drafts.push({ key: { kind: "metric", exposure: { metric: p.exposure, side: p.side }, planned_id: p.id, timing: p.timing, metric: p.outcome },
                stats: s, rope: METRICS[p.outcome].rope, binary: s.binary, low_confidence: METRICS[p.outcome].lowConfidence, groupIdx: s.groupIdx,
                outcome: t.dates.map((_, i) => t.metric[p.outcome as keyof DayTable["metric"]][i + offset] ?? null),
                extra: { planned_id: p.id, expected: p.expected, adjusted_for: s.adjusted_for, sensitivity: s.sensitivity },
                labelWith: q => finalizeMetricLabel(s, q, METRICS[p.outcome].rope, p.expected) });
        }
    const rows = finalizeFamily(drafts, t, origin, cuts).rows;
    const qs = benjaminiHochberg(drafts.map(d => d.stats.n_a < 3 || d.stats.n_b < 3 ? null : d.stats.p));
    expect(rows.map(row => row.q)).toEqual(qs.map(q => q === null ? null : Math.round(q * 10000) / 10000));
    return rows;
}

it("shared rolling baseline exactly matches sorted trailing median and MAD with gaps and ties", () => {
    const median = (xs: number[]) => {
        xs.sort((a, b) => a - b);
        const mid = xs.length >>> 1;
        return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    };
    for (const modulus of [3, 19, 101]) {
        const values = Array.from({ length: 224 }, (_, i) => i % 19 === 0 ? null : i * 7919 % modulus);
        const actual = baseline(values, 2);
        for (let i = 0; i < values.length; i++) {
            const prior = values.slice(Math.max(0, i - 42), i).filter((x): x is number => x !== null);
            const m = prior.length >= 14 ? median(prior) : null;
            const scale = m === null ? null : Math.max(1.4826 * median(prior.map(x => Math.abs(x - m))), 2);
            expect(actual.median[i]).toBe(m);
            expect(actual.scale[i]).toBe(scale);
            expect(actual.z[i]).toBe(m === null || scale === null || values[i] === null ? null : ((values[i] ?? 0) - m) / scale);
        }
    }
});
