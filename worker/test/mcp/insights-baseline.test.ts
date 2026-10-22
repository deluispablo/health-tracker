import { expect, it } from "vitest";
import { anomalyFlags, baseline, computeBaselines } from "../../src/mcp/tools/insights/baseline";
import type { DayTable } from "../../src/mcp/tools/insights/units";

it("requires 14 finite prior values and excludes the current day", () => {
  const b = baseline([...Array<number>(14).fill(10), 100], 2);
  expect(b.z.slice(0,14)).toEqual(Array<null>(14).fill(null));
  expect(b.median[14]).toBe(10);
  expect(b.z[14]).toBe(45);
});
it("uses max of scaled MAD and ROPE, with even medians", () => {
  const b = baseline([...Array<number>(7).fill(0), ...Array<number>(7).fill(4), 5], 1);
  expect(b.median[14]).toBe(2);
  expect(b.scale[14]).toBeCloseTo(2 * 1.4826);
  expect(baseline(Array<number>(15).fill(3), 5).scale[14]).toBe(5);
});
it("uses 42 calendar days and ignores null and nonfinite values", () => {
  const b = baseline([...Array<number>(14).fill(10), ...Array<null>(42).fill(null), 11, NaN, Infinity], 1);
  expect(b.z[56]).toBeNull();
});
it("includes D-42 but excludes D-43 at the 14-value threshold", () => {
  const values: (number|null)[] = Array<null>(44).fill(null);
  values.fill(10,30,43);
  values[1]=10;
  values[43]=12;
  expect(baseline(values,1).z[43]).toBe(2);
  values[1]=null;
  values[0]=10;
  expect(baseline(values,1).z[43]).toBeNull();
});
it("computes continuous baselines only and flags upward anomalies only", () => {
  const t = { metric: { rhr:[...Array<number>(14).fill(60), 64], mood_positive:Array<number>(15).fill(1) } } as unknown as DayTable;
  const b = computeBaselines(t);
  expect(b.mood_positive).toBeUndefined();
  expect(anomalyFlags(b,15)).toEqual([...Array<boolean>(14).fill(false),true]);
  expect(anomalyFlags({ rhr:{median:[],scale:[],z:[-4,3,null]}, hrv:{median:[],scale:[],z:[4,0,4]} },3)).toEqual([false,true,false]);
});
