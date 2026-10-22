import type { From, Parser, With } from "node-sql-parser/build/sqlite";

export function viewsOnly(sql: string, parser: Parser): { ok: true } | { ok: false; reason: string; error?: unknown } {
  try {
    const { ast, tableList } = parser.parse(sql);
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1 || statements[0].type !== "select") {
      return { ok: false, reason: "only one SELECT statement is allowed" };
    }

    const allowed = new Set(["v_daily", "v_events", "v_sleep", "v_workouts"]);
    function hasQualifiedRelation(value: unknown): boolean {
      if (value === null || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(hasQualifiedRelation);
      const node = value as Record<string, unknown>;
      if (Array.isArray(node.with)) {
        // CTE names are deliberately global, including declarations in nested queries.
        for (const cte of node.with as With[]) allowed.add(cte.name.value.toLowerCase());
      }
      if (Array.isArray(node.from)) {
        for (const relation of node.from as From[]) {
          // tableList serializes both null and the schema named "null" identically.
          if ("db" in relation && relation.db !== null) return true;
        }
      }
      return Object.values(node).some(hasQualifiedRelation);
    }
    if (hasQualifiedRelation(ast)) {
      return { ok: false, reason: "schema-qualified relations are not allowed" };
    }

    for (const table of tableList) {
      const prefix = "select::null::";
      if (!table.startsWith(prefix) || !allowed.has(table.slice(prefix.length).toLowerCase())) {
        return { ok: false, reason: "only the four health views and declared CTEs are allowed" };
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "unsupported SQL syntax; quote identifiers with double quotes",
      error,
    };
  }
}
