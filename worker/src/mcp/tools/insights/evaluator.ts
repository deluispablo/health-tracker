import { dateTimeFormat } from "../../../lib/time";
import { canonicalJson } from "./findings";
import { evaluateContrast, validateContrastArgs } from "./contrast";
import { evaluatePeriods, validatePeriodsArgs } from "./periods";
import { evaluateScan, validateScanArgs } from "./scan";
import type { EvalOptions, FindingsEvaluator, Origin } from "./types";
import { lastCompletedBday, rangeFromOrigin } from "./units";

const addDays = (date: string, days: number) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

export function createEvaluator(db: D1Database, deps: { nowSec: number; tz: string }): FindingsEvaluator {
  const evaluate = (origin: Origin, opts: EvalOptions) => {
    switch (origin.tool) {
      case "health_scan": return evaluateScan(db, origin, opts);
      case "health_contrast": return evaluateContrast(db, origin, opts);
      case "health_periods": return evaluatePeriods(db, origin, opts);
    }
  };
  return {
    validateOrigin(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) throw new RangeError("origin must be an object.");
      const origin = input as Record<string, unknown>;
      if (Object.keys(origin).some(key => key !== "tool" && key !== "args")) throw new RangeError("Unknown origin field.");
      if (origin.args === null || typeof origin.args !== "object" || Array.isArray(origin.args)) throw new RangeError("origin args must be an object.");
      const args = origin.args as Record<string, unknown>;
      if ("limit" in args) throw new RangeError("limit is not an origin argument.");
      if ("window_days" in args && ("start" in args || "end" in args)) throw new RangeError("Use window_days or start/end, never both.");
      switch (origin.tool) {
        case "health_scan": {
          if (!("window_days" in args)) return validateScanArgs(args, deps.nowSec, deps.tz).origin;
          const { window_days, ...rest } = args;
          const range = rangeFromOrigin({ window_days: window_days as number }, deps.nowSec, deps.tz);
          const validated = validateScanArgs({ ...rest, start: range.start, end: range.end }, deps.nowSec, deps.tz).origin;
          const selection = Object.fromEntries(Object.entries(validated.args).filter(([key]) => key !== "start" && key !== "end"));
          return { tool: "health_scan", args: { ...selection, window_days: window_days as number } };
        }
        case "health_contrast": return validateContrastArgs(args, deps.nowSec, deps.tz);
        case "health_periods": return { tool: "health_periods", args: validatePeriodsArgs(args, deps) };
        default: throw new RangeError("Unknown origin tool.");
      }
    },
    family(origin, opts) {
      const range = opts.range ?? rangeFromOrigin(origin.args, deps.nowSec, deps.tz);
      return evaluate(origin, { ...deps, range });
    },
    async single(ref, range) {
      const family = await evaluate(ref.origin, { ...deps, range, only: ref.key, cutpoints: ref.cutpoints });
      return family.rows.find(row => row.ref && canonicalJson(row.ref.key) === canonicalJson(ref.key)) ?? null;
    },
    newDataRange(savedAtMs) {
      const parts = dateTimeFormat("en-CA", { timeZone: deps.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(savedAtMs));
      const part = (key: string) => parts.find(p => p.type === key)?.value ?? "";
      const date = `${part("year")}-${part("month")}-${part("day")}`;
      const end = lastCompletedBday(deps.nowSec, deps.tz);
      const afterSave = addDays(date, Number(part("hour")) < 5 ? 0 : 1);
      const earliest = addDays(end, -179);
      const start = afterSave < earliest ? earliest : afterSave;
      return start > end ? null : { start, end };
    },
  };
}
