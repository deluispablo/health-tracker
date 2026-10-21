import { describe, expect, it } from "vitest";
import { dateTimeFormat } from "../../src/lib/time";

describe("T31 AC3 dateTimeFormat", () => {
  const options = { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" } as const;

  it("caches by locale and the JSON of options, rather than options identity", () => {
    const formatter = dateTimeFormat("en-US", options);
    expect(dateTimeFormat("en-US", { ...options })).toBe(formatter);
    expect(dateTimeFormat("en-GB", options)).not.toBe(formatter);
    expect(dateTimeFormat("en-US", { ...options, timeZone: "UTC" })).not.toBe(formatter);
    expect(dateTimeFormat("en-US", { timeZone: options.timeZone, timeZoneName: "longOffset" })).not.toBe(formatter);
  });

  it.each(["2026-03-29T00:59:00Z", "2026-03-29T01:00:00Z", "2026-10-25T00:59:00Z", "2026-10-25T01:00:00Z", "2026-12-31T23:30:00Z"])(
    "preserves native date and offset output at %s", (iso) => {
      for (const timeZone of ["Europe/Madrid", "UTC", "Asia/Kolkata", "America/New_York"]) {
        for (const opts of [{ ...options, timeZone }, { timeZone, timeZoneName: "longOffset" } as const]) {
          const native = new Intl.DateTimeFormat("en-US", opts);
          const cached = dateTimeFormat("en-US", opts);
          const instant = Date.parse(iso);
          expect(cached.format(instant)).toBe(native.format(instant));
          expect(cached.formatToParts(instant)).toEqual(native.formatToParts(instant));
        }
      }
    },
  );
});
