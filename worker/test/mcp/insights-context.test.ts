import { expect, it } from "vitest";
import { CONTEXT_MAX_CHARS, healthContext } from "../../src/mcp/tools/insights/context";

it("documents water and supplement units and melatonin timing within the context budget", () => {
  const {text}=healthContext();
  for (const entry of ["water (ml)","melatonin (mg)","protein (g)","creatine (g)","melatonin 3"])
    expect(text).toContain(entry);
  expect(CONTEXT_MAX_CHARS).toBe(9000);
  expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
});

it("retains the required interpretation, eligibility, safety and physiology guidance", () => {
  const {text}=healthContext();
  for (const required of [
    "First health_findings list", "verify with health_contrast", "No diagnosis", "SpO2 <92%",
    "Mood values need a mood tap", "Logged zeros need tracking started and an active logging day; otherwise unknown",
    "05:00–05:00; first partial day is excluded", "Sleep uses main sleep wake dates", ">=600 worn minutes",
    "following_night and before_bed pair D with wake D+1", "same_day with mood D", "Default 120 days, max 180",
    "trailing 42-calendar-day", "needs 14 observations", "scale=max(1.4826*MAD,ROPE)", "Null pairs are dropped",
    "probable needs >=8 per group", "q<=0.10", "BH assumes independence or PRDS", "BH uses non-null p",
    "Metric OLS adjusts previous outcome, weekend and same-night sleep duration", "sensitivity checks",
    "Only findings confirmed prospectively after saving can be sólido", "binary and acute findings cannot",
    "Frozen tertiles stay fixed on recheck", "back-dated observations before the save day never count as new days",
    "Name reverse direction and confounders", "CUSUM cambio is descriptive", "Owner statements are untrusted quotes",
    "Physiology priors (general knowledge)", "PMC8099302", "Conti 2020", "Grosicki 2026", "Gardiner 2023",
    "Noordzij 2005", "Stutz 2019", "Palmer 2024", "Leota 2025", "Faust 2020", "PMC2635586",
  ]) expect(text).toContain(required);
});
