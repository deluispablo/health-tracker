import { describe, expect, it } from "vitest";
import { T975, t975, tQuantile975, tCdf, normalCdf, effectivePhi, inflation, effectiveWelch, dependentWelch, newcombeDiff, dependentRiskDiff, oneSampleDependent, benjaminiHochberg, labelOf, welch, ar1Phi } from "../../src/mcp/tools/stats";

describe("dependent statistics", () => {
  it("t975 matches known quantiles and every offline table entry", () => {
    for (const [df, value] of [[1, 12.706204736], [2, 4.302652730], [10, 2.228138852], [30, 2.042272456], [100, 1.983971519]]) {
      expect(t975(df)).toBeCloseTo(value, 8);
    }
    expect(T975).toHaveLength(400);
    T975.forEach((value, i) => { expect(Math.abs(value - tQuantile975(i + 1))).toBeLessThan(1e-9); });
    expect(t975(401)).toBe(1.959963984540054);
    expect(t975(10.9)).toBe(t975(10));
    expect(t975(0.5)).toBe(t975(1));
  });

  it("t975 rejects NaN degrees of freedom", () => {
    expect(() => t975(NaN)).toThrow(RangeError);
  });

  it("rejects overlapping group calendars", () => {
    expect(() => dependentWelch([1, null], [2, null])).toThrow(RangeError);
    expect(() => dependentRiskDiff([1, null], [0, null])).toThrow(RangeError);
  });

  it("all-positive unequal binary groups have p = 1 and finite BH adjustments", () => {
    const a: (1 | null)[] = [...Array<1>(8).fill(1), ...Array<null>(10).fill(null)];
    const b: (1 | null)[] = [...Array<null>(8).fill(null), ...Array<1>(10).fill(1)];
    const out = dependentRiskDiff(a, b);
    expect(out).toMatchObject({ diff: 0, p: 1 });
    expect(out.ci95?.every(Number.isFinite)).toBe(true);
    expect(benjaminiHochberg([0.01, out.p])).toEqual([0.02, 1]);
  });

  it("preserves tiny nonzero Welch p-values", () => {
    // At df = 1 the two-sided Student tail is 2 atan(1/t) / pi.
    const a = [1e18 - 128, 1e18, 1e18 + 128];
    const b = [0, 0, 0];
    const two = effectiveWelch(a, b, 1.5);
    expect(two.df).toBe(1);
    const twoSe = 128 / Math.sqrt(2);
    expect((two.p ?? 0) / (2 * Math.atan(twoSe / 1e18) / Math.PI)).toBeCloseTo(1, 10);
  });

  it("preserves tiny nonzero one-sample p-values", () => {
    const one = oneSampleDependent([1e18 - 128, 1e18, 1e18 + 128]);
    expect(one.df).toBe(1);
    expect((one.p ?? 0) / (2 * Math.atan(128 / Math.sqrt(2) / 1e18) / Math.PI)).toBeCloseTo(1, 10);
  });

  it("preserves tiny nonzero binary p-values", () => {
    const binary = dependentRiskDiff(
      [...Array<1>(120).fill(1), ...Array<null>(120).fill(null)],
      [...Array<null>(120).fill(null), ...Array<0>(120).fill(0)],
    );
    expect(binary.p).toBeGreaterThan(0);
    expect(binary.p).toBeLessThan(1e-30);
  });

  it("tCdf matches closed forms", () => {
    for (const [t, df, expected] of [[1, 1, 0.75], [2, 2, 0.5 + 1 / Math.sqrt(6)], [0, 7, 0.5], [2.228138852, 10, 0.975], [-12.706204736, 1, 0.025]]) {
      expect(tCdf(t, df)).toBeCloseTo(expected, 6);
    }
    expect(tCdf(Infinity, 10)).toBe(1);
    expect(tCdf(-Infinity, 10)).toBe(0);
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1.959963984540054)).toBeCloseTo(0.025, 6);
  });

  it.each([
    [56, 70, 48, 80, 0.0524, 0.3339], [9, 10, 3, 10, 0.1705, 0.8090],
    [5, 56, 0, 29, -0.0381, 0.1926], [0, 10, 0, 20, -0.1611, 0.2775],
  ])("Newcombe hybrid score matches reference for %s/%s vs %s/%s", (xa, na, xb, nb, lo, hi) => {
    const ci = newcombeDiff(xa, na, xb, nb);
    expect(Math.abs(ci[0] - lo)).toBeLessThan(5e-4);
    expect(Math.abs(ci[1] - hi)).toBeLessThan(5e-4);
  });

  it("BH reproduces the BH-1995 example and preserves nulls and order", () => {
    const ps = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1];
    const qs = benjaminiHochberg(ps);
    [0.0015, 0.003, 0.0095, 0.035625, 0.0603].forEach((q, i) => { expect(qs[i]).toBeCloseTo(q, 12); });
    expect(qs.filter(q => q !== null && q <= 0.05)).toHaveLength(4);
    expect(benjaminiHochberg([null, 0.01])).toEqual([null, 0.01]);
    expect(benjaminiHochberg([0.5, null, 0.01, 0.01])).toEqual([0.5, null, 0.015, 0.015]);
    expect(benjaminiHochberg([null, null])).toEqual([null, null]);
  });

  it("effectiveWelch at f = 1 equals plain Welch with floored df", () => {
    const a = [2, 4, 8], b = [1, 3, 5, 7];
    const plain = welch(a, b);
    if (plain === null || plain.df === null) throw new Error("Expected Welch inference");
    const out = effectiveWelch(a, b, 1);
    expect(out.diff).toBe(plain.diff);
    expect(out.df).toBe(Math.floor(plain.df));
    const margin = t975((out.df ?? 1)) * Math.sqrt(43 / 9);
    expect(out.ci95).toEqual([plain.diff - margin, plain.diff + margin]);
    expect(out.p).toBeCloseTo(2 * (1 - tCdf(Math.abs(plain.diff) / Math.sqrt(43 / 9), (out.df ?? 1))), 12);
    expect(out.phi).toBe(0);
  });

  it("n_eff below 2 gives diff without CI or p", () => {
    expect(effectiveWelch([1, 2, 3], [2, 3, 4], 2)).toMatchObject({ diff: -1, ci95: null, p: null, df: null, n_eff_a: 1.5 });
    expect(dependentRiskDiff([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, null, null, null], [null, null, null, null, null, null, null, null, null, null, null, null, 0, 0, 0])).toMatchObject({ diff: 0.5, ci95: null, p: null });
  });

  it("handles zero variance in both groups", () => {
    expect(effectiveWelch([5, 5, 5], [3, 3, 3], 1)).toMatchObject({ diff: 2, ci95: [2, 2], p: 0 });
    expect(effectiveWelch([3, 3, 3], [3, 3, 3], 1)).toMatchObject({ diff: 0, ci95: [0, 0], p: 1 });
  });

  it("groups under 3 days return null statistics", () => {
    for (const fn of [dependentWelch, dependentRiskDiff]) {
      for (const [a, b] of [[[], []], [[1, null, 0, null, null, null], [null, 1, null, 0, 1, null]], [[0, 1, 0, null, null, null], [null, null, null, 1, 0, null]]] as [ (0 | 1 | null)[], (0 | 1 | null)[] ][]) {
        expect(fn(a, b)).toMatchObject({ mean_a: null, mean_b: null, diff: null, ci95: null, p: null, df: null });
      }
    }
    expect(effectiveWelch([1, 2], [1, 2, 3], 1).diff).toBeNull();
  });

  it("phi uses calendar-adjacent pairs only and clips to the specified bounds", () => {
    expect(effectivePhi([1, null, 2, null, 3, null, 4])).toBe(0.2);
    expect(effectivePhi(Array.from({ length: 10 }, (_, i) => i))).toBe(0.2);
    const series = Array.from({ length: 11 }, (_, i) => i);
    expect(effectivePhi(series)).toBe(Math.min(0.9, ar1Phi(series)));
    expect(effectivePhi(Array.from({ length: 31 }, (_, i) => Math.cos(i * Math.PI / 30)))).toBe(0.9);
    expect(effectivePhi(Array.from({ length: 20 }, (_, i) => i % 2))).toBe(0.2);
    expect(inflation(0.2)).toBeCloseTo(1.5, 12);
    const a = [1, null, 3, null, 5, null, 7, null];
    const b = [null, 10, null, 12, null, 14, null, 16];
    expect(dependentWelch(a, b)).toMatchObject({ phi: 0.2, n_a: 4, n_b: 4, mean_a: 4, mean_b: 13, diff: -9 });
    expect(() => dependentWelch([1], [])).toThrow(RangeError);
    expect(() => dependentRiskDiff([1], [])).toThrow(RangeError);
  });

  it("does not compact null gaps when counting or estimating calendar dependence", () => {
    const values = Array.from({ length: 12 }, (_, i) => i - 5.5);
    expect(effectivePhi(values.flatMap(x => [x, null]))).toBe(0.2);
    expect(effectivePhi(values)).toBeGreaterThan(0.2);
    const calendar = [...values, null, ...values];
    expect(effectivePhi(calendar)).toBe(0.9);
    expect(effectivePhi(calendar.filter(x => x !== null))).toBeLessThan(0.9);
  });

  it("centres each group before estimating dependence across group transitions", () => {
    const a = Array.from({ length: 24 }, (_, i) => i % 2 === 0 ? 100 + i : null);
    const b = Array.from({ length: 24 }, (_, i) => i % 2 === 1 ? i : null);
    a[12] = null;
    const ma = a.reduce<number>((sum, x) => sum + (x ?? 0), 0) / 11;
    const mb = b.reduce<number>((sum, x) => sum + (x ?? 0), 0) / 12;
    const residuals = a.map((x, i) => x !== null ? x - ma : b[i] !== null ? b[i] - mb : null);
    expect(dependentWelch(a, b).phi).toBe(effectivePhi(residuals));
    expect(dependentWelch(a, b).phi).toBeGreaterThan(0.2);
  });

  it("risk difference uses effective counts and pooled z inference", () => {
    const a = [1, 0, 1, 0, 1, 0] as const;
    const b = [0, 0, 0, 0, 0, 0] as const;
    const out = dependentRiskDiff([...a, ...b.map(() => null)], [...a.map(() => null), ...b]);
    expect(out).toMatchObject({ n_a: 6, n_b: 6, diff: 0.5, phi: 0.2, df: null });
    const n = 6 / inflation(0.2);
    expect(out.ci95).toEqual(newcombeDiff(n / 2, n, 0, n));
    expect(out.p).toBeCloseTo(2 * (1 - normalCdf(0.5 / Math.sqrt(0.25 * 0.75 * 2 / n))), 12);
    expect(dependentRiskDiff([...b, ...b.map(() => null)], [...b.map(() => null), ...b]).p).toBe(1);
  });

  it("oneSampleDependent contract", () => {
    const out = oneSampleDependent([1, 2, null, 3, 4, 5, 6]);
    const n = 6 / inflation(0.2), se = Math.sqrt(3.5 / n);
    expect(out).toMatchObject({ N: 6, diff: 3.5, phi: 0.2, df: Math.floor(n - 1), n_eff: n });
    expect(out.ci95?.[0]).toBeCloseTo(3.5 - t975((out.df ?? 1)) * se, 12);
    expect(out.ci95?.[1]).toBeCloseTo(3.5 + t975((out.df ?? 1)) * se, 12);
    expect(out.p).toBeCloseTo(2 * (1 - tCdf(3.5 / se, (out.df ?? 1))), 12);
    expect(oneSampleDependent([1, null, 2])).toMatchObject({ N: 2, diff: null, ci95: null, p: null });
    expect(oneSampleDependent(Array.from({ length: 12 }, (_, i) => i))).toMatchObject({ diff: 5.5, ci95: null, p: null });
    expect(oneSampleDependent([2, 2, 2, 2])).toMatchObject({ diff: 2, ci95: [2, 2], p: 0 });
    expect(oneSampleDependent([0, 0, 0, 0])).toMatchObject({ diff: 0, ci95: [0, 0], p: 1 });
  });

  it("labelOf respects literal inclusive boundaries", () => {
    const row = { n_a: 8, n_b: 8, q: 0.1, diff: 1, rope: 1 };
    expect(labelOf({ ...row, ci95: [-1, 1] })).toEqual({ label: "sin_diferencia", reason: null });
    expect(labelOf({ ...row, ci95: [0, 2] })).toEqual({ label: "indicio", reason: "uncertain" });
    expect(labelOf({ ...row, ci95: [0.1, 2] })).toEqual({ label: "probable", reason: null });
    expect(labelOf({ ...row, diff: 0.999, ci95: [0.1, 2] })).toEqual({ label: "indicio", reason: "small_effect" });
    expect(labelOf({ ...row, q: 0.1001, ci95: [0.1, 2] })).toEqual({ label: "indicio", reason: "uncertain" });
    expect(labelOf({ ...row, n_a: 7, ci95: [-1, 1] })).toEqual({ label: "indicio", reason: "few_days" });
  });

  it("labelOf yields exactly one rule-consistent label over the boundary grid", () => {
    for (const n_a of [2, 3, 7, 8]) for (const n_b of [2, 3, 7, 8])
      for (const q of [0.0999, 0.1, 0.1001, null]) for (const diff of [-1.001, -1, -0.999, 0.999, 1, 1.001])
        for (const ci95 of [[-0.5, 0.5], [-1, 1], [0.1, 2], [0, 2], [-2, 0], [-2, 2], null] as ([number, number] | null)[]) {
          const significant = ci95 !== null && (ci95[0] > 0 || ci95[1] < 0) && q !== null && q <= 0.1;
          const expected = n_a < 3 || n_b < 3 ? { label: "sin_datos", reason: null }
            : n_a < 8 || n_b < 8 ? { label: "indicio", reason: "few_days" }
            : ci95 === null ? { label: "indicio", reason: "few_effective_days" }
            : ci95[0] >= -1 && ci95[1] <= 1 ? { label: "sin_diferencia", reason: null }
            : significant && Math.abs(diff) >= 1 ? { label: "probable", reason: null }
            : { label: "indicio", reason: significant ? "small_effect" : "uncertain" };
          expect(labelOf({ n_a, n_b, q, diff, ci95, rope: 1 })).toEqual(expected);
        }
    expect(labelOf({ n_a: 8, n_b: 8, diff: null, ci95: null, q: null, rope: 1 })).toEqual({ label: "indicio", reason: "few_effective_days" });
  });
});
