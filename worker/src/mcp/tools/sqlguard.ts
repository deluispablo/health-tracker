const forbiddenKeywords = new Set([
  "insert", "update", "delete", "replace", "upsert", "create", "drop", "alter", "attach", "detach",
  "pragma", "vacuum", "reindex", "analyze", "savepoint", "release", "begin", "commit", "rollback",
  "transaction", "returning",
]);
const forbiddenFunctions = new Set([
  "load_extension", "readfile", "writefile", "edit", "fts3_tokenizer", "fsdir", "zipfile",
  "sqlar_compress", "sqlar_uncompress",
]);
const forbiddenNames = new Set([
  "profile", "weight_log",
  "metric_minute", "metric_hour", "metric_daily", "metric_def", "sleep_session", "sleep_stage", "workout",
  "tracker", "event", "daily_summary", "tracker_daily", "sync_pending", "sync_state", "secret_blob",
  "audit_log", "oauth_state", "rollup_dirty", "rollup_seq", "d1_migrations", "main", "temp", "temporary", "dbstat", "fsdir", "zipfile",
]);

interface Token {
  kind: "word" | "identifier" | "literal" | "symbol";
  value: string;
  start: number;
  end: number;
}

export function validateReadOnlyQuery(sql: string): { ok: true; sql: string; viewSql?: string } | { ok: false; reason: string } {
  if (sql.length > 4000) return { ok: false, reason: "query exceeds 4000 characters" };
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFEFF]/.test(sql)) {
    return { ok: false, reason: "BOM and forbidden control characters are not allowed" };
  }

  const tokens: Token[] = [];
  let normalized = "";
  let terminated = false;
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const offset = normalized.length;
    const char = sql[i];
    if (/[ \t\n\f\r]/.test(char)) {
      normalized += char;
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? sql.length : end;
      normalized += " ";
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { ok: false, reason: "unterminated block comment" };
      i = end + 2;
      normalized += " ";
      continue;
    }
    if (terminated) return { ok: false, reason: "only one statement is allowed" };
    if (char === ";") {
      terminated = true;
      i++;
      continue;
    }
    // SQLite parameter tokens can swallow quotes; this tool never binds parameters.
    if ("?$:@#".includes(char)) return { ok: false, reason: "query parameters are not allowed" };

    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const closing = char === "[" ? "]" : char;
      let value = "";
      let closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === closing) {
          i++;
          if (char !== "[" && sql[i] === closing) {
            value += closing;
            i++;
            continue;
          }
          closed = true;
          break;
        }
        value += sql[i++];
      }
      if (!closed) return { ok: false, reason: "unterminated quoted token" };
      tokens.push({ kind: char === "'" ? "literal" : "identifier", value, start: offset, end: offset + i - start });
    } else if (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(char)) {
      // SQLite treats non-ASCII characters and $ as part of an identifier.
      while (i < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i])) i++;
      if ((sql.slice(start, i) === "x" || sql.slice(start, i) === "X") && sql[i] === "'") {
        return { ok: false, reason: "blob literals are not allowed" };
      }
      tokens.push({ kind: "word", value: sql.slice(start, i), start: offset, end: offset + i - start });
    } else {
      i++;
      tokens.push({ kind: "symbol", value: char, start: offset, end: offset + 1 });
    }
    normalized += sql.slice(start, i);
  }

  const first = tokens.at(0);
  if (!first || first.kind !== "word" || !/^(select|with)$/i.test(first.value)) {
    return { ok: false, reason: "query must start with SELECT or WITH" };
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const name = token.value.replace(/[A-Z]/g, (char) => char.toLowerCase());
    if (token.kind === "word" && forbiddenKeywords.has(name)) {
      return { ok: false, reason: `forbidden keyword: ${name}` };
    }
    if (token.kind !== "symbol"
      && (forbiddenNames.has(name) || /^(sqlite_|pragma_|_cf_)/.test(name))) {
      return { ok: false, reason: `forbidden name: ${name}` };
    }
    if (token.kind !== "symbol" && forbiddenFunctions.has(name)
      && tokens[index + 1]?.value === "(" && tokens[index + 1].kind === "symbol") {
      return { ok: false, reason: `forbidden function: ${name}` };
    }
  }
  const edits: { start: number; end: number; text: string }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== "word" || tokens[index].value.toLowerCase() !== "over"
      || tokens[index + 1]?.value !== "(" || tokens[index + 1].kind !== "symbol") continue;
    let depth = 1;
    let frame: Token | undefined;
    let end = index + 2;
    for (; end < tokens.length; end++) {
      const token = tokens[end];
      if (token.kind === "symbol" && token.value === "(") depth++;
      if (token.kind === "symbol" && token.value === ")" && --depth === 0) break;
      if (depth === 1 && token.kind === "word" && /^(rows|range|groups)$/i.test(token.value)) frame = token;
    }
    if (depth !== 0) continue;
    if (frame) {
      const clause = normalized.slice(frame.start, tokens[end].start);
      const bound = "(?:UNBOUNDED (?:PRECEDING|FOLLOWING)|CURRENT ROW|[+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+) (?:PRECEDING|FOLLOWING))";
      const pattern = new RegExp(`^(?:ROWS|RANGE|GROUPS)\\s+(?:BETWEEN ${bound} AND ${bound}|${bound})(?: EXCLUDE (?:NO OTHERS|CURRENT ROW|GROUP|TIES))?\\s*$`, "i");
      if (!pattern.test(clause.replace(/\s+/g, " "))) {
        return { ok: false, reason: `unsupported SQL syntax near "${frame.value}"; use constant numeric window frame bounds` };
      }
      // Only constant frame bounds are removed; partition/order expressions still undergo relation checks.
      edits.push({ start: frame.start, end: tokens[end].start, text: " " });
    }
    const first = tokens[index + 2];
    if (first.kind !== "word" || first.value.toLowerCase() !== "partition") {
      edits.push({ start: tokens[index + 1].end, end: tokens[index + 1].end, text: "PARTITION BY 1 " });
    }
  }
  let viewSql = normalized;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    viewSql = viewSql.slice(0, edit.start) + edit.text + viewSql.slice(edit.end);
  }
  return { ok: true, sql: normalized, ...(edits.length ? { viewSql } : {}) };
}
