import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { healthCompare } from "../../src/mcp/tools/compare";

interface Args { behavior: string; outcome: string; start: string; end: string; lag_days?: number; bins?: number[] }
interface Comparison { group: string; vs: string; diff: number; df: number | null; ci95: [number, number] | null }
interface Result {
  behavior: string; outcome: string; lag_days: number; start: string; end: string; n: number;
  groups: { label: string; n: number; mean: number | null; sd: number | null }[];
  comparisons: Comparison[]; notes: string[]; caveats: string;
  behavior_logging: { logged_days: number; first_logged_date: string | null; last_logged_date: string | null };
  min_days_per_group: number;
}
const compare: (db: D1Database, args: Args) => Promise<Result> = healthCompare;
const outcomes = ["rhr", "hrv_rmssd", "ln_rmssd", "resp_rate", "spo2_avg", "skin_temp_dev", "sleep_min", "sleep_eff",
  "deep_min", "rem_min", "sleep_latency_min", "steps", "azm", "readiness_proxy"];
const base = { behavior: "cigarettes", outcome: "rhr", start: "2026-01-01", end: "2026-01-07", lag_days: 0 };
const date = (i: number) => new Date(Date.UTC(2026, 0, i)).toISOString().slice(0, 10);
const caveats = (n: number) => `Asociacional, no causal. n=${String(n)}. Posibles confusores: alcohol, entrenamiento, hora de acostarse, enfermedad.`;
const loggingNote = (n: number, first: string | null, last: string | null, behavior = "cigarettes") =>
  `${behavior} tiene registros en ${String(n)} día(s) del rango solicitado; primer registro: ${first ?? "ninguno"}; último registro: ${last ?? "ninguno"}. Se usa todo el rango solicitado; los días sin registro cuentan como 0.`;
const comparisonRequirement = "Se necesitan al menos 2 días con resultado disponible en cada uno de al menos 2 grupos para una comparación.";
async function row(day: string, value: number | null, behavior?: number, tracker = "cigarettes") {
  await env.DB.prepare("INSERT INTO daily_summary (local_date, rhr, computed_at) VALUES (?, ?, 1)").bind(day, value).run();
  if (behavior !== undefined) await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, ?, ?, 1, 0)")
    .bind(day, tracker, behavior).run();
}

function observed(rewrite: (value: unknown) => unknown = (value) => value) {
  const reads: { sql: string; bindings: unknown[] }[] = [];
  let executions = 0;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(t, p) {
    if (p === "bind") return (...bindings: unknown[]) => { reads[reads.length - 1].bindings = bindings; return wrap(t.bind(...bindings), sql); };
    if (["all", "first", "raw", "run"].includes(String(p))) return (...args: unknown[]) => {
      executions++;
      expect(sql).toMatch(/^\s*SELECT\b/i);
      return (Reflect.get(t, p) as (...args: unknown[]) => Promise<unknown>).apply(t, args).then(rewrite);
    };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  const db = new Proxy(env.DB, { get(t, p) {
    if (p === "prepare") return (sql: string) => { reads.push({ sql, bindings: [] }); return wrap(t.prepare(sql), sql); };
    if (["batch", "exec", "dump"].includes(String(p))) return () => { throw new Error(`unexpected ${String(p)}`); };
    const value: unknown = Reflect.get(t, p);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(t) : value;
  } });
  return { db, reads, executions: () => executions };
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { await env.DB.batch(["daily_summary", "tracker_daily"].map((table) => env.DB.prepare(`DELETE FROM ${table}`))); });

describe("T17 AC1/AC3 health_compare", () => {
  it.each([["cigarettes", ["0", ">0–5", ">5–10", ">10"]], ["alcohol_g", ["0", ">0–20", ">20–40", ">40"]],
    ["caffeine_mg", ["0", ">0–200", ">200–400", ">400"]]] as const)("uses default bins for %s, lag 1, and exact empty shape", async (behavior, labels) => {
    const args = { behavior, outcome: "sleep_min", start: base.start, end: base.end };
    const out = await compare(env.DB, args);
    expect(out).toEqual({ ...args, lag_days: 1, n: 0,
      groups: labels.map((label) => ({ label, n: 0, mean: null, sd: null })), comparisons: [],
      notes: [`${behavior} solo tiene valores distintos de 0 en 0 de 0 días; los días sin registro cuentan como 0.`,
        loggingNote(0, null, null, behavior), comparisonRequirement], caveats: caveats(0),
      behavior_logging: { logged_days: 0, first_logged_date: null, last_logged_date: null }, min_days_per_group: 2 });
    expect(Object.keys(out)).toEqual(["behavior", "outcome", "lag_days", "start", "end", "n", "groups", "comparisons", "notes", "caveats", "behavior_logging", "min_days_per_group"]);
  });

  it.each([["cigarettes", 5, 10], ["alcohol_g", 20, 40], ["caffeine_mg", 200, 400]] as const)(
    "uses the default thresholds, including exact boundaries, for %s", async (behavior, first, last) => {
      const totals = [0, 0.25, first, first + 0.25, last, last + 0.25];
      const tracker = { cigarettes: "cigarettes", alcohol_g: "alcohol", caffeine_mg: "caffeine" }[behavior];
      for (let i = 0; i < totals.length; i++) await row(date(i + 1), i, totals[i], tracker);
      const out = await compare(env.DB, { ...base, behavior });
      expect(out.groups.map(({ n, mean }) => ({ n, mean }))).toEqual([
        { n: 1, mean: 0 }, { n: 2, mean: 1.5 }, { n: 2, mean: 3.5 }, { n: 1, mean: 5 },
      ]);
    },
  );

  it("uses sample SD, the first eligible reference label, fractional Welch df, and rounds only the result", async () => {
    const values = [9, 1, 3, 5, 7, 2, 4, 8];
    for (let i = 0; i < values.length; i++) await row(date(i + 1), values[i], i === 0 ? 0 : i < 5 ? 5 : 10);
    expect(await compare(env.DB, { ...base, end: date(8) })).toEqual({ ...base, end: date(8), n: 8,
      groups: [{ label: "0", n: 1, mean: 9, sd: null }, { label: ">0–5", n: 4, mean: 4, sd: 2.582 },
        { label: ">5–10", n: 3, mean: 4.667, sd: 3.055 }, { label: ">10", n: 0, mean: null, sd: null }],
      comparisons: [{ group: ">5–10", vs: ">0–5", diff: 0.667, df: 3.959, ci95: [-5.427, 6.76] }], notes: [loggingNote(8, date(1), date(8))], caveats: caveats(8),
      behavior_logging: { logged_days: 8, first_logged_date: date(1), last_logged_date: date(8) }, min_days_per_group: 2 });
  });

  it("bins fractional values at inclusive thresholds, with negatives and missing totals in zero", async () => {
    const totals = [-2, 0, undefined, 0.25, 0.5, 0.5001, 2.5, 2.5001];
    for (let i = 0; i < totals.length; i++) await row(date(i + 1), (i + 1) * 10, totals[i]);
    const out = await compare(env.DB, { ...base, end: date(8), bins: [0.5, 2.5] });
    expect(out.groups).toEqual([{ label: "0", n: 3, mean: 20, sd: 10 }, { label: ">0–0.5", n: 2, mean: 45, sd: 7.071 },
      { label: ">0.5–2.5", n: 2, mean: 65, sd: 7.071 }, { label: ">2.5", n: 1, mean: 80, sd: null }]);
    expect(out.n).toBe(8);
    expect(out.comparisons.map(({ group, vs }) => ({ group, vs }))).toEqual([
      { group: ">0–0.5", vs: "0" }, { group: ">0.5–2.5", vs: "0" },
    ]);
  });

  it("prints thresholds with String(t), preserving label precision", async () => {
    const out = await compare(env.DB, { ...base, bins: [0.12345, 1.23456] });
    expect(out.groups.map(({ label }) => label)).toEqual(["0", ">0–0.12345", ">0.12345–1.23456", ">1.23456"]);
  });

  it("pairs calendar dates across gaps, includes outcomes after end, and excludes widened anchors", async () => {
    await row("2026-01-01", 999, 5);
    await row("2026-01-03", 30, 11);
    await row("2026-01-04", 40, 6);
    // Jan 2 has no v_daily row: its missing behaviour is still zero and pairs with Jan 3.
    const out = await compare(env.DB, { ...base, end: "2026-01-03", lag_days: 1 });
    expect(out.n).toBe(2);
    expect(out.groups).toEqual([{ label: "0", n: 1, mean: 30, sd: null }, { label: ">0–5", n: 0, mean: null, sd: null },
      { label: ">5–10", n: 0, mean: null, sd: null }, { label: ">10", n: 1, mean: 40, sd: null }]);
    expect(out.comparisons).toEqual([]);
    expect(out.notes).toEqual(["cigarettes solo tiene valores distintos de 0 en 1 de 2 días; los días sin registro cuentan como 0.",
      loggingNote(2, date(1), date(3)), comparisonRequirement]);
    expect(out.caveats).toBe(caveats(2));
    expect(await compare(env.DB, { behavior: base.behavior, outcome: base.outcome, start: base.start, end: "2026-01-03" })).toEqual(out);
  });

  it("excludes null outcomes, retains zero, and follows Math.round for negative ties", async () => {
    await row(date(1), null, 11);
    await row(date(2), 0, 0);
    await row(date(3), -1.2345, 1);
    const out = await compare(env.DB, { ...base, end: date(3) });
    expect(out.n).toBe(2);
    expect(out.groups.map(({ mean }) => mean)).toEqual([0, -1.234, null, null]);
    expect(out.caveats).toBe(caveats(2));
  });

  it.each([0, 2])("keeps constant-group differences %s with null df and CI", async (diff) => {
    for (let i = 1; i <= 4; i++) await row(date(i), i <= 2 ? 3 : 3 + diff, i <= 2 ? 0 : 1);
    const out = await compare(env.DB, base);
    expect(out.groups.slice(0, 2).map(({ sd }) => sd)).toEqual([0, 0]);
    expect(out.comparisons).toEqual([{ group: ">0–5", vs: "0", diff, df: null, ci95: null }]);
  });

  it("keeps a finite Welch CI when only the reference group is constant", async () => {
    for (const [i, value] of [1, 1, 2, 4, 6].entries()) await row(date(i + 1), value, i < 2 ? 0 : 1);
    const out = await compare(env.DB, base);
    expect(out.comparisons).toEqual([{ group: ">0–5", vs: "0", diff: 3, df: 2, ci95: [-1.968, 7.968] }]);
  });

  it("treats non-finite behaviours as zero and non-finite outcomes as missing", async () => {
    for (const [i, outcome, total] of [[1, 10, 900001], [2, 20, 900002], [3, 30, 900003], [4, 40, undefined],
      [5, 900001, 1], [6, 900002, 1], [7, 900003, 1]] as const) await row(date(i), outcome, total);
    // Inject at the read boundary: real D1 JSON cannot faithfully transport every non-finite value.
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "number") return ({ 900001: Infinity, 900002: NaN, 900003: -Infinity } as Record<number, number>)[value] ?? value;
      if (Array.isArray(value)) return (value as unknown[]).map(rewrite);
      if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]: [string, unknown]) => [k, rewrite(v)]));
      return value;
    };
    const out = await compare(observed(rewrite).db, base);
    expect(out.n).toBe(4);
    expect(out.groups[0]).toEqual({ label: "0", n: 4, mean: 25, sd: 12.91 });
    expect(out.groups.slice(1).every((group) => group.n === 0)).toBe(true);
    expect(out.notes).toEqual(["cigarettes solo tiene valores distintos de 0 en 0 de 4 días; los días sin registro cuentan como 0.",
      loggingNote(6, date(1), date(7)), comparisonRequirement]);
  });

  it.each(outcomes)("accepts outcome %s", async (outcome) => {
    expect((await compare(env.DB, { ...base, outcome })).outcome).toBe(outcome);
  });
});

describe("T28 AC3 compare notes", () => {
  it("explains a single logged day even when its lagged outcome is unavailable", async () => {
    for (let i = 1; i <= 5; i++) await row(date(i), 60 + i);
    await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, ?, ?, 1, 0)")
      .bind(date(7), "cigarettes", 5).run();
    const out = await healthCompare(env.DB, { ...base, lag_days: 1 });
    expect(out.n).toBe(4);
    expect(out.groups.map(({ n }) => n)).toEqual([4, 0, 0, 0]);
    expect(out.comparisons).toEqual([]);
    expect(out).toMatchObject({
      behavior_logging: { logged_days: 1, first_logged_date: date(7), last_logged_date: date(7) },
      min_days_per_group: 2,
    });
    expect(out.notes).toContain("cigarettes tiene registros en 1 día(s) del rango solicitado; primer registro: 2026-01-07; último registro: 2026-01-07. Se usa todo el rango solicitado; los días sin registro cuentan como 0.");
    expect(out.notes).toContain("Se necesitan al menos 2 días con resultado disponible en cada uno de al menos 2 grupos para una comparación.");
  });

  it.each([["cigarettes", "cigarettes"], ["alcohol_g", "alcohol"], ["caffeine_mg", "caffeine"]])(
    "counts zero-valued logs for %s within the requested anchors only", async (behavior, tracker) => {
      for (const [day, id, total] of [[date(0), tracker, 1], [date(2), tracker, 0], [date(5), tracker, 5],
        [date(8), tracker, 1], [date(3), "mood_bien", 1]] as const) {
        await env.DB.prepare("INSERT INTO tracker_daily (local_date, tracker_id, total, n, evening_total) VALUES (?, ?, ?, 1, 0)")
          .bind(day, id, total).run();
      }
      const out = await compare(env.DB, { ...base, behavior, lag_days: 1 });
      expect(out.behavior_logging).toEqual({ logged_days: 2, first_logged_date: date(2), last_logged_date: date(5) });
      expect(out.notes).toContain(loggingNote(2, date(2), date(5), behavior));
      expect(out.notes).toContain(comparisonRequirement);
    },
  );

  it.each([0, 1, 2, 3])("reports sparse behaviour at %s counted non-zero days, even when comparisons exist", async (k) => {
    for (let i = 1; i <= 5; i++) await row(date(i), i === 5 ? 0 : i, i <= k ? 1 : undefined);
    await row(date(6), null, 11);
    const out = await compare(env.DB, base);
    expect(out.n).toBe(5);
    expect(out.notes).toEqual([
      ...(k < 3 ? [`cigarettes solo tiene valores distintos de 0 en ${String(k)} de 5 días; los días sin registro cuentan como 0.`] : []),
      loggingNote(k + 1, k === 0 ? date(6) : date(1), date(6)),
      ...(k < 2 ? [comparisonRequirement] : []),
    ]);
    expect(out.comparisons).toHaveLength(k >= 2 ? 1 : 0);
  });

  it("counts negative and fractional behaviours as non-zero while retaining their existing bins", async () => {
    for (const [i, total] of [-0.5, 0.25, 0, undefined].entries()) await row(date(i + 1), i, total);
    const out = await compare(env.DB, base);
    expect(out.groups.map(({ n }) => n)).toEqual([3, 1, 0, 0]);
    expect(out.notes).toEqual(["cigarettes solo tiene valores distintos de 0 en 2 de 4 días; los días sin registro cuentan como 0.",
      loggingNote(3, date(1), date(3)), comparisonRequirement]);
  });

  it.each([{ totals: [1, 1, 1] }, { totals: [1, 6, 11] }])("explains empty comparisons with three non-zero days: $totals", async ({ totals }) => {
    for (const [i, total] of totals.entries()) await row(date(i + 1), i, total);
    const out = await compare(env.DB, base);
    expect(out.comparisons).toEqual([]);
    expect(out.notes).toEqual(["Ningún grupo distinto del de referencia tiene al menos 2 días; no hay comparaciones.",
      loggingNote(3, date(1), date(3)), comparisonRequirement]);
  });
});

describe("T17 compare validation and AC5 bounded SELECT", () => {
  const messages = {
    date: "date must be a real calendar date in YYYY-MM-DD format", range: "range must contain 1 to 365 dates",
    behavior: "behavior must be one of: cigarettes, alcohol_g, caffeine_mg", outcome: `outcome must be one of: ${outcomes.join(", ")}`,
    lag: "lag_days must be an integer from 0 to 7", bins: "bins must be 1 to 5 ascending positive finite numbers",
  };
  const invalid: [Partial<Args>, string][] = [
    ...["", "2026-1-01", "2026-02-30", "2026-02-29", "1999-12-31", "2100-01-01", "20260101", "2026-01-01T00:00:00Z"]
      .flatMap((day): [Partial<Args>, string][] => [[{ start: day }, messages.date], [{ end: day }, messages.date]]),
    [{ end: "2025-12-31" }, messages.range], [{ end: "2027-01-01" }, messages.range],
    ...["", "alcohol", "rhr", "cigarettes; DROP TABLE event"].map((behavior): [Partial<Args>, string] => [{ behavior }, messages.behavior]),
    ...["bedtime_local", "waketime_local", "computed_at", "cigarettes", "workout_min", "z_rhr", "hr_wear_min", "z_ln_rmssd", "z_sleep", "unknown"]
      .map((outcome): [Partial<Args>, string] => [{ outcome }, messages.outcome]),
    ...[-1, 8, 0.5, Infinity, -Infinity, NaN].map((lag_days): [Partial<Args>, string] => [{ lag_days }, messages.lag]),
    ...[[], [0], [-1], [1, 1], [2, 1], [Infinity], [NaN], [1, 2, 3, 4, 5, 6]]
      .map((bins): [Partial<Args>, string] => [{ bins }, messages.bins]),
  ];
  it.each(invalid)("rejects %j before preparing any SQL", async (overrides, message) => {
    const seen = observed();
    const pending = compare(seen.db, { ...base, ...overrides });
    await expect(pending).rejects.toThrow(RangeError);
    await expect(pending).rejects.toThrow(message);
    expect(seen.reads).toEqual([]);
  });

  it.each([
    ["2026-01-01", "2026-12-31", 7, "2027-01-07"], ["2099-12-31", "2099-12-31", 7, "2100-01-07"],
    ["2000-01-01", "2000-01-01", 0, "2000-01-01"], ["2028-02-28", "2028-02-29", 1, "2028-03-01"],
    ["2026-10-24", "2026-10-25", 1, "2026-10-26"],
  ] as const)("binds a widened series SELECT and requested logging range for %s..%s with lag %s", async (start, end, lag_days, widened) => {
    if (end === "2026-12-31") for (let i = 1; i <= 365; i++) await row(date(i), i, i % 12);
    const seen = observed();
    const out = await compare(seen.db, { ...base, start, end, lag_days, bins: [1, 2, 3, 4, 5] });
    expect(seen.reads).toHaveLength(2);
    expect(seen.executions()).toBe(2);
    expect(seen.reads[0].sql).toMatch(/^\s*SELECT\b[\s\S]*\bFROM\s+v_daily\b[\s\S]*\bWHERE\s+local_date\s+BETWEEN\s+\?\s+AND\s+\?/i);
    expect(seen.reads[0].sql).not.toContain(start);
    expect(seen.reads[0].bindings).toEqual([start, widened]);
    expect(seen.reads[1].sql).toMatch(/FROM tracker_daily WHERE tracker_id = \? AND local_date BETWEEN \? AND \?/);
    expect(seen.reads[1].bindings).toEqual(["cigarettes", start, end]);
    expect(out.groups.map(({ label }) => label)).toEqual(["0", ">0–1", ">1–2", ">2–3", ">3–4", ">4–5", ">5"]);
    if (end === "2026-12-31") expect(out.n).toBe(358);
  });

  it("propagates a failed D1 read without an empty or partial result", async () => {
    const failure = new Error("private D1 failure");
    const reject = () => Promise.reject(failure);
    const statement = { bind: () => statement, all: reject, first: reject, raw: reject, run: reject };
    const db = { prepare: () => statement, batch: reject, exec: reject } as unknown as D1Database;
    await expect(compare(db, base)).rejects.toBe(failure);
  });
});
