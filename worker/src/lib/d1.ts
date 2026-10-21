const IDENT = /^[a-z_]+$/;
const MAX_PARAMS = 100; // D1 limit per statement (R2)

/**
 * Idempotent multi-row upsert (R4): rows are chunked to at most 100 bound parameters per statement
 * and all chunks run in one db.batch. Identifiers must be internal constants, never user input.
 */
export async function upsertRows(
  db: D1Database, table: string, columns: string[], conflictKeys: string[], rows: unknown[][],
): Promise<void> {
  const stmts = upsertStatements(db, table, columns, conflictKeys, rows);
  if (stmts.length) await db.batch(stmts);
}

/** Build validated, chunked upserts for composition with other writes in one atomic batch. */
export function upsertStatements(
  db: D1Database, table: string, columns: string[], conflictKeys: string[], rows: unknown[][],
): D1PreparedStatement[] {
  const ok = IDENT.test(table) && columns.length > 0 && columns.length <= MAX_PARAMS && conflictKeys.length > 0
    && columns.every((c) => IDENT.test(c)) && new Set(columns).size === columns.length
    && conflictKeys.every((k) => columns.includes(k));
  if (!ok) throw new TypeError(`invalid upsert target: ${table}`);
  if (rows.some((r) => r.length !== columns.length)) throw new TypeError("row width differs from columns");
  if (rows.length === 0) return [];

  const update = columns.filter((c) => !conflictKeys.includes(c));
  const conflict = update.length ? `DO UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}` : "DO NOTHING";
  const tuple = `(${columns.map(() => "?").join(",")})`;
  const per = Math.floor(MAX_PARAMS / columns.length);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk.map(() => tuple).join(", ")} ON CONFLICT(${conflictKeys.join(", ")}) ${conflict}`;
    stmts.push(db.prepare(sql).bind(...chunk.flat()));
  }
  return stmts;
}
