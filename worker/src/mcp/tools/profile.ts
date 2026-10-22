import { dateTimeFormat } from "../../lib/time";

interface ProfileValues {
  birth_year: number;
  sex: "female" | "male" | null;
  height_cm: number;
  step_goal: number;
  water_goal_ml: number;
  sleep_goal_min: number;
  max_hr: number;
  smoker: boolean;
}
type Options = { now: number; tz: string };

function localToday({ now, tz }: Options): string {
  return dateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now * 1000);
}

function numberValue(field: string, value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${field} must be a finite ${integer ? "integer" : "number"} between ${String(min)} and ${String(max)}`);
  }
  return integer ? value : Math.round(value * 10) / 10;
}

function profileValue(field: string, value: unknown, year: number): ProfileValues[keyof ProfileValues] {
  switch (field) {
    case "birth_year": return numberValue(field, value, 1920, year, true);
    case "height_cm": return numberValue(field, value, 100, 250);
    case "water_goal_ml": return numberValue(field, value, 500, 6000, true);
    case "step_goal": return numberValue(field, value, 1000, 50000, true);
    case "sleep_goal_min": return numberValue(field, value, 240, 720, true);
    case "max_hr": return numberValue(field, value, 120, 230, true);
    case "sex":
      if (value === null || value === "female" || value === "male") return value;
      throw new RangeError("sex must be female, male or null");
    case "smoker":
      if (typeof value === "boolean") return value;
      throw new RangeError("smoker must be a boolean");
    default: throw new RangeError(`${field} is not an allowed profile field`);
  }
}

function calendarDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

export async function healthProfile(db: D1Database, options: Options) {
  const year = Number(localToday(options).slice(0, 4));
  const [profileResult, weightsResult] = await db.batch<{ key: string; value: string } | { local_date: string; kg: number }>([
    db.prepare("SELECT key, value FROM profile"),
    db.prepare(`SELECT local_date, kg FROM weight_log
      WHERE local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(local_date, '+0 days') = local_date
        AND typeof(kg) IN ('integer', 'real') AND kg BETWEEN 30 AND 300
      ORDER BY local_date DESC LIMIT 90`),
  ]);
  const rows = profileResult.results as { key: string; value: string }[];
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  const get = <K extends keyof ProfileValues>(field: K): ProfileValues[K] | null => {
    const stored = values.get(field);
    if (stored === undefined) return null;
    try {
      return profileValue(field, JSON.parse(stored), year) as ProfileValues[K];
    } catch {
      return null;
    }
  };
  const weights = weightsResult.results as { local_date: string; kg: number }[];
  const weight_history = weights.map(({ local_date, kg }) => ({ date: local_date, kg }));
  const birth_year = get("birth_year");
  const age = birth_year === null ? null : year - birth_year;
  const measured = get("max_hr");
  return {
    birth_year, sex: get("sex"), height_cm: get("height_cm"),
    weight_kg: weight_history[0]?.kg ?? null, weight_date: weight_history[0]?.date ?? null,
    step_goal: get("step_goal") ?? 7000, sleep_goal_min: get("sleep_goal_min") ?? 450,
    water_goal_ml: get("water_goal_ml") ?? 2000,
    max_hr: measured ?? (age === null ? null : Math.round(208 - 0.7 * age)),
    max_hr_source: measured !== null ? "measured" : age !== null ? "estimated" : null,
    smoker: get("smoker"), age, weight_history,
  };
}

export async function healthSetProfile(db: D1Database, args: Record<string, unknown>, options: Options) {
  const fields = Object.keys(args);
  if (!fields.length) throw new RangeError("at least one profile field is required");
  const today = localToday(options);
  const year = Number(today.slice(0, 4));
  const values = fields.filter((field) => field !== "date").map((field) => [field,
    field === "weight_kg" ? numberValue(field, args[field], 30, 300) : profileValue(field, args[field], year),
  ] as const);
  if (Object.hasOwn(args, "date") && !Object.hasOwn(args, "weight_kg")) {
    throw new RangeError("date requires weight_kg");
  }
  const date = Object.hasOwn(args, "date") ? args.date : today;
  if (!calendarDate(date) || date < "2000-01-01" || date > today) {
    throw new RangeError(`date must be a real YYYY-MM-DD date between 2000-01-01 and ${today}`);
  }
  const statements = values.map(([field, value]) => field === "weight_kg"
    ? db.prepare(`INSERT INTO weight_log (local_date, kg, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(local_date) DO UPDATE SET kg = excluded.kg, updated_at = excluded.updated_at`).bind(date, value, options.now)
    : db.prepare(`INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(field, JSON.stringify(value), options.now));
  await db.batch(statements);
  return healthProfile(db, options);
}
