import { Parser } from "node-sql-parser/build/sqlite";
import { validateReadOnlyQuery } from "./sqlguard";
import { viewsOnly } from "./sqlviews";

export async function healthSql(db: D1Database, { query }: { query: string }): Promise<{
  columns: string[]; rows: unknown[][]; truncated: boolean; row_count: number; notes_untrusted: boolean; hint?: string;
}> {
  const validated = validateReadOnlyQuery(query);
  if (!validated.ok) throw new RangeError(validated.reason);
  const viewSql = validated.viewSql ?? validated.sql;
  const verdict = viewsOnly(viewSql);
  if (!verdict.ok) {
    if (verdict.reason.startsWith("unsupported SQL syntax")) {
      try { new Parser().parse(viewSql); } catch (error) {
        const offset = (error as { location?: { start: { offset: number } } }).location?.start.offset ?? 0;
        const token = viewSql.slice(offset).match(/^\S+/)?.[0] ?? "end of query";
        const hint = /^[`\[]/.test(token) ? "use double quotes for identifiers" : "check clause order and spelling at this token";
        throw new RangeError(`unsupported SQL syntax near ${JSON.stringify(token)}; ${hint}`);
      }
    }
    throw new RangeError(verdict.reason);
  }

  const statement = db.prepare(`SELECT * FROM (\n${validated.sql}\n) LIMIT 201`);
  const { results } = await statement.all();
  const columns = results.length ? Object.keys(results[0]) : (await statement.raw({ columnNames: true }))[0];
  const rows: unknown[][] = [];
  let characters = 2; // Include the outer JSON array brackets.
  for (const result of results.slice(0, 200)) {
    const row = columns.map((column) => result[column]);
    const size = JSON.stringify(row).length + (rows.length ? 1 : 0);
    if (characters + size > 20000 || (rows.length + 1) * columns.length > 800) break;
    rows.push(row);
    characters += size;
  }
  return {
    columns, rows, truncated: results.length > rows.length, row_count: rows.length,
    notes_untrusted: columns.includes("note"),
    ...(results.length > rows.length ? { hint: "Narrow the date window, select fewer columns, or add LIMIT." } : {}),
  };
}
