import { describe, expect, it } from "vitest";
import { ar1Phi, mean, pearson, prewhiten, sampleSd, tQuantile975, welch } from "../../src/mcp/tools/stats";

describe("T17 statistics rulings (unrounded pure functions)", () => {
  it("returns null for insufficient samples and uses sample rather than population SD", () => {
    expect(mean([])).toBeNull();
    expect(mean([0])).toBe(0);
    expect(mean([1, 2, 2])).toBeCloseTo(5 / 3, 12);
    expect(sampleSd([])).toBeNull();
    expect(sampleSd([4])).toBeNull();
    expect(sampleSd([4, 4])).toBe(0);
    expect(sampleSd([2, 4, 8])).toBeCloseTo(Math.sqrt(28 / 3), 12);
  });

  it.each([[1, 12.706], [2, 4.303], [5, 2.571], [10, 2.228], [30, 2.042], [100, 1.984], [1000, 1.962]])(
    "matches the Student t .975 reference at df %s", (df, expected) => {
      expect(Math.abs(tQuantile975(df) - expected)).toBeLessThanOrEqual(0.001);
    },
  );

  it("supports fractional df and the infinite-df limit", () => {
    expect(tQuantile975(2.5)).toBeCloseTo(3.574654842, 6);
    expect(Math.abs(tQuantile975(Infinity) - 1.960)).toBeLessThanOrEqual(0.001);
  });

  it.each([1e7, 1e13, 1e15, 1e300, Number.MAX_VALUE])("stays near the normal quantile for huge df %s", (df) => {
    expect(Math.abs(tQuantile975(df) - 1.959964)).toBeLessThanOrEqual(0.001);
  });

  it.each([0, -1, -Infinity, NaN])("rejects invalid df %s", (df) => {
    expect(() => tQuantile975(df)).toThrow(RangeError);
  });

  it("computes unequal-n, unequal-variance Welch with fractional df and a Student t CI", () => {
    // Sample variances 28/3 and 20/3; SE² = 43/9, df = 1849/467.
    const out = welch([2, 4, 8], [1, 3, 5, 7]);
    expect(out?.diff).toBeCloseTo(2 / 3, 12);
    expect(out?.df).toBeCloseTo(1849 / 467, 12);
    expect(out?.ci95?.[0]).toBeCloseTo(-5.426796251, 6);
    expect(out?.ci95?.[1]).toBeCloseTo(6.760129584, 6);
    const reverse = welch([1, 3, 5, 7], [2, 4, 8]);
    expect(reverse?.diff).toBeCloseTo(-2 / 3, 12);
    expect(reverse?.ci95?.[0]).toBeCloseTo(-6.760129584, 6);
    expect(reverse?.ci95?.[1]).toBeCloseTo(5.426796251, 6);
  });

  it("handles insufficient and constant groups without dropping a defined difference", () => {
    expect(welch([], [1, 2])).toBeNull();
    expect(welch([1, 2], [1])).toBeNull();
    expect(welch([1], [1, 2])).toBeNull();
    expect(welch([3, 3], [3, 3, 3])).toEqual({ diff: 0, df: null, ci95: null });
    expect(welch([5, 5], [3, 3, 3])).toEqual({ diff: 2, df: null, ci95: null });
    const out = welch([2, 4, 6], [1, 1]);
    expect(out?.diff).toBe(3);
    expect(out?.df).toBeCloseTo(2, 12);
    expect(out?.ci95?.[0]).toBeCloseTo(3 - 4.30265273 * Math.sqrt(4 / 3), 6);
    expect(out?.ci95?.[1]).toBeCloseTo(3 + 4.30265273 * Math.sqrt(4 / 3), 6);
    expect(welch([1, 1], [2, 4, 6])?.df).toBeCloseTo(2, 12);
  });

  it("requires five Pearson pairs and nonzero variance in each series", () => {
    expect(pearson([], [])).toBeNull();
    expect(pearson([1, 2, 3, 4], [4, 3, 2, 1])).toBeNull();
    expect(pearson([1, 1, 1, 1, 1], [1, 2, 3, 4, 5])).toBeNull();
    expect(pearson([1, 2, 3, 4, 5], [1, 1, 1, 1, 1])).toBeNull();
    expect(pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4, 5], [2, 1, 4, 3, 8])).toBeCloseTo(14 / Math.sqrt(292), 12);
  });

  it("centres AR(1) once over every present value, never bridging gaps", () => {
    // Mean 41/6, numerator 727/9, denominator 763/9 over four adjacent pairs.
    expect(ar1Phi([1, 2, 4, null, 10, 11, 13])).toBeCloseTo(727 / 763, 12);
    for (const series of [[], [null, null], [1, 2, 3], [1, null, 2, null, 3, null, 4], [5, 5, 5, 5]]) {
      expect(ar1Phi(series)).toBe(0);
    }
    expect(ar1Phi([1, -1, 1, -1])).toBe(-0.99);
    expect(ar1Phi(Array.from({ length: 31 }, (_, i) => Math.cos(i * Math.PI / 30)))).toBe(0.99);
  });

  it("prewhitens without centring, preserving dates, length, nulls and full precision", () => {
    expect(prewhiten([], 0.5)).toEqual([]);
    expect(prewhiten([3], 0.5)).toEqual([null]);
    expect(prewhiten([1, 2, null, 4, 8, 11], 1 / 3)).toEqual([null, 2 - 1 / 3, null, null, 8 - 4 / 3, 11 - 8 / 3]);
    expect(prewhiten([1, null, 2, 3], 0)).toEqual([null, null, null, 3]);
  });
});
