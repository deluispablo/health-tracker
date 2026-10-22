import { expect, it, vi } from "vitest";
import { olsAdjusted, type ModelPoint } from "../../src/mcp/tools/insights/model";
import * as stats from "../../src/mcp/tools/stats";

const design = (n = 24): ModelPoint[] => Array.from({ length: n }, (_, i) => ({
  idx: i, a: i % 2 as 0 | 1, yPrev: i % 5 - 2, weekend: Number(i % 7 >= 5) as 0 | 1,
  y: 3 + 2 * (i % 2) + 0.7 * (i % 5 - 2) - 0.4 * Number(i % 7 >= 5),
}));
it("b1 equals the exact coefficient on a noiseless design", () => {
  const s = olsAdjusted(design(), 24, false);
  expect(s.diff).toBeCloseTo(2, 9);
  expect(s.adjusted_for).toEqual(["previous_value", "weekend"]);
});
it("b1 and se equal numpy reference values on a noisy design", () => {
  const s = olsAdjusted(design().map((p, i) => ({ ...p, y: p.y + Math.sin(i * 1.7) })), 24, false);
  expect(s.diff).toBeCloseTo(2.094408835763065, 10);
  expect((present(s.ci95)[1] - present(s.diff)) / stats.t975(present(s.df)) / Math.sqrt(s.f)).toBeCloseTo(0.30254202597956265, 10);
});
it("exposure identical to weekend returns confounded with null statistics", () => {
  expect(olsAdjusted(design().map(p => ({ ...p, a: p.weekend })), 24, false)).toMatchObject({
    diff: null, ci95: null, p: null, reason: "confounded",
  });
});
it("constant weekend column is dropped and not listed", () => {
  const s = olsAdjusted(design().map(p => ({ ...p, weekend: 0, sleep: 400 })), 24, true);
  expect(s.adjusted_for).toEqual(["previous_value"]);
  expect(s.k).toBe(3);
});
it("that-night model adjusts for varying sleep", () => {
  const s = olsAdjusted(design(60).map((p, i) => ({ ...p, sleep: i % 11, y: p.y + 3 * (i % 11) })), 60, true);
  expect(s.diff).toBeCloseTo(2, 9);
  expect(s.adjusted_for).toEqual(["previous_value", "weekend", "sleep_min"]);
});
it("n_eff minus k boundary 1.99 / 2.00", () => {
  const mock = vi.spyOn(stats, "effectivePhi");
  try {
    for (const remaining of [1.99, 2]) {
      const f = 24 / (4 + remaining);
      mock.mockReturnValue((f - 1) / (f + 1));
      const s = olsAdjusted(design(), 24, false);
      expect(s.diff).not.toBeNull();
      expect(s.ci95 === null).toBe(remaining < 2);
    }
  } finally { mock.mockRestore(); }
});
it("small groups return null statistics", () => {
  expect(olsAdjusted(design(4), 4, false)).toMatchObject({ diff: null, ci95: null, p: null });
});
it("residual autocorrelation preserves missing calendar days", () => {
  const points = design().map((p, i) => ({ ...p, idx: i * 2, y: p.y + Math.sin(i / 3) }));
  expect(olsAdjusted(points, 48, false).phi).toBe(0.2);
});

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a populated value.");
  return value;
}
