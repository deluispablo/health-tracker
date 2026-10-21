import { validateReadOnlyQuery } from "./sqlguard";
import { viewsOnly } from "./sqlviews";

export async function healthSql(db: D1Database, { query }: { query: string }): Promise<{
  columns: string[]; rows: unknown[][]; truncated: boolean; row_count: number; notes_untrusted: boolean;
}> {
  const validated = validateReadOnlyQuery(query);
  if (!validated.ok) throw new RangeError(validated.reason);
  const verdict = viewsOnly(validated.sql);
  if (!verdict.ok) throw new RangeError(verdict.reason);

  const { results } = await db.prepare(`SELECT * FROM (\n${validated.sql}\n) LIMIT 501`).all();
  const columns = results.length ? Object.keys(results[0]) : [];
  const rows = results.slice(0, 500).map((row) => columns.map((column) => row[column]));
  return {
    columns, rows, truncated: results.length > 500, row_count: rows.length,
    notes_untrusted: columns.includes("note"),
  };
}
