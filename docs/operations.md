# Operations

Procedures for a running deployment. Run Worker commands from `worker/`. Setup is in the [README](../README.md#getting-started).

## Back up weekly

The export in `py/` dumps D1, verifies a local restore and keeps the last eight backup pairs in `~/health-tracker-backups` (or `--out <dir>`). Nothing in the repository schedules it. Two ways to run it weekly:

- **cron or launchd.** For example, every Sunday at 10:00:

  ```cron
  0 10 * * 0 cd /path/to/health-tracker && uv run --directory py python src/health_tracker/export.py
  ```

  The machine needs `uv`, Node.js, the `worker/` dependencies and a logged-in `wrangler`.
- **A scheduled job with a check.** Run the same command, then compare each table's row count in the new manifest (`health-tracker-YYYY-MM-DD.json`) with the previous one. Warn when a table shrinks, or when `metric_minute` and `daily_summary` stop growing, which points to broken sync.

Never print or log wrangler's own output: it can include a short-lived download URL for the whole database. The export captures that output, replaces URLs with `<url>` in its error messages and exits `1` on any failure.

## Rotate the webhook secret

While `WEBHOOK_SECRET_PREV` is set, the Worker accepts both values. Keep the current value in a password manager and confirm that it matches the subscriber before starting. If it is lost, set a fresh value in the Worker and the subscriber together and accept a short gap; the 04:30 UTC reconcile re-reads the last 48 hours. Run one step at a time, with shell tracing off. Do not start another rotation until step 5 is done.

1. Generate the new value and save it as **pending** in the password manager:

   ```sh
   printf 'Bearer '; openssl rand -hex 32
   ```

2. Upload the **current** value as the previous one:

   ```sh
   npx wrangler secret put WEBHOOK_SECRET_PREV --config wrangler.production.jsonc
   ```

3. Upload the **pending** value:

   ```sh
   npx wrangler secret put WEBHOOK_SECRET --config wrangler.production.jsonc
   ```

4. Set `NUM` to your Google Cloud project number and `SUBSCRIBER` to your subscriber id, then PATCH the subscriber with the pending value (prompted without echo and sent through stdin). On **HTTP 2xx**, make the pending value current in the password manager.

   ```sh
   python3 -c 'import getpass, json; print(json.dumps({"endpointAuthorization": {"secret": getpass.getpass("Pending webhook secret: ")}}))' |
     curl --fail-with-body --request PATCH \
       "https://health.googleapis.com/v4/projects/${NUM}/subscribers/${SUBSCRIBER}?updateMask=endpointAuthorization" \
       --header "Authorization: Bearer $(gcloud auth print-access-token)" \
       --header "x-goog-user-project: ${NUM}" \
       --header 'Content-Type: application/json' \
       --data-binary @- --write-out '\nHTTP %{http_code}\n'
   ```

5. **24 hours after step 4 succeeded**, remove the previous value:

   ```sh
   npx wrangler secret delete WEBHOOK_SECRET_PREV --config wrangler.production.jsonc
   ```

On any failed or uncertain step, stop and retry that same step with the same saved values. Never repeat step 2 after step 3. Never run step 5 before step 4 has succeeded and 24 hours have passed.

## Revoke access

| What | How |
|---|---|
| Google Health | Remove the app at [Google account permissions](https://myaccount.google.com/permissions); ingestion stops at the next token refresh |
| MCP clients | Disconnect the connector in each client and delete its grant records from `OAUTH_KV`: `npx wrangler kv key delete --binding OAUTH_KV --remote --config wrangler.production.jsonc <key>`. Access tokens already issued stay valid until they expire |
| Watch | Set a new `WATCH_TOKEN`; the installed app gets `401` until it is rebuilt with the new value |

Revocation does not delete stored data or backups.
