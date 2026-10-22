import { describe, expect, it } from "vitest";
import { dateTimeFormat, isCalendarDate } from "../../src/lib/time";

describe("isCalendarDate", () => {
  it.each(["0000-02-29", "0099-12-31", "0100-01-01", "1999-12-31", "2000-02-29", "2028-02-29", "2099-12-31", "2100-01-01", "9999-12-31"])(
    "accepts real four-digit calendar dates without imposing a caller's year limits: %s", (date) => {
      expect(isCalendarDate(date)).toBe(true);
    },
  );

  it.each([undefined, null, true, 20260101, {}, [], "", "2026-1-01", "2026-01-1", "2026-02-29", "2026-02-30", "1900-02-29", "2100-02-29",
    "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32", "-0001-01-01", "10000-01-01", "2026-01-01T00:00:00Z", "2026-01-01\n"])(
    "rejects malformed or impossible calendar dates: %j", (date) => {
      expect(isCalendarDate(date)).toBe(false);
    },
  );
});

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
