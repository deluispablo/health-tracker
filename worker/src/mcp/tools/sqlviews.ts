import type { From, Parser, With } from "node-sql-parser/build/sqlite";

function readsFrom(value: unknown, name: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(node => readsFrom(node, name));
  const node = value as Record<string, unknown>;
  if (Array.isArray(node.from) && (node.from as From[]).some(relation =>
    "table" in relation && relation.table.toLowerCase() === name)) return true;
  return Object.values(node).some(child => readsFrom(child, name));
}

export function viewsOnly(sql: string, parser: Parser): { ok: true } | { ok: false; reason: string; error?: unknown } {
  try {
    const { ast, tableList } = parser.parse(sql);
    const statements = Array.isArray(ast) ? ast : [ast];
    if (statements.length !== 1 || statements[0].type !== "select") {
      return { ok: false, reason: "only one SELECT statement is allowed" };
    }

    const allowed = new Set(["v_daily", "v_events", "v_sleep", "v_workouts"]);
    function refusalReason(value: unknown): string | undefined {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) return value.map(refusalReason).find(Boolean);
      const node = value as Record<string, unknown>;
      if (node.type === "function") {
        const name = node.name as { name: { value: string }[] };
        const functionName = name.name.map(part => part.value).join(".").toLowerCase();
        if (functionName === "zeroblob" || functionName === "randomblob") {
          return `function ${functionName} is not allowed because it can allocate unbounded blobs`;
        }
        if (functionName === "printf" || functionName === "format") {
          return `function ${functionName} is not allowed because it can allocate unbounded strings`;
        }
      }
      if (Array.isArray(node.with)) {
        // CTE names are deliberately global, including declarations in nested queries.
        for (const cte of node.with as With[]) {
          if ("recursive" in cte && cte.recursive === true) return "WITH RECURSIVE is not allowed; use a non-recursive CTE";
          const name = cte.name.value.toLowerCase();
          if (readsFrom(cte.stmt.ast, name)) return `recursive CTE ${name} is not allowed; use a non-recursive CTE`;
          allowed.add(name);
        }
      }
      if (Array.isArray(node.from)) {
        for (const relation of node.from as From[]) {
          // tableList serializes both null and the schema named "null" identically.
          if ("db" in relation && relation.db !== null) return "schema-qualified relations are not allowed";
        }
      }
      return Object.values(node).map(refusalReason).find(Boolean);
    }
    const reason = refusalReason(ast);
    if (reason) return { ok: false, reason };

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
