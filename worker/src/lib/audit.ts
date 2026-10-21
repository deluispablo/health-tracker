interface AuditEntry {
  kind: "auth" | "tool";
  name: string;
  args?: object;
  started: number;
  error?: string;
}

export function audit(ctx: ExecutionContext, db: D1Database, entry: AuditEntry): void {
  const ms = Math.max(0, Date.now() - entry.started);
  ctx.waitUntil(Promise.resolve().then(async () => {
    await db.prepare("INSERT INTO audit_log (ts, kind, name, args_json, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(Math.floor(Date.now() / 1000), entry.kind, entry.name,
        entry.args === undefined ? null : JSON.stringify(entry.args), entry.error === undefined ? 1 : 0, ms, entry.error ?? null).run();
  }).catch(() => { /* Audit storage failures must not fail the request. */ }));
}
