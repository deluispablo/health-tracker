# Setup reference

The technical detail behind `npm run setup`. You do not need this page to install: the [README](../README.md#getting-started) guide is enough. Use it to see what the script does, to do a step by hand, or to change a setting later.

Run Worker commands from `worker/`. Replace `<your-domain>` with your domain.

## Contents

- [Vars](#vars)
- [Secrets](#secrets)
- [Wrangler config fields](#wrangler-config-fields)
- [Webhook subscriber](#webhook-subscriber)
- [Manual equivalent of each setup step](#manual-equivalent-of-each-setup-step)
- [Watch build settings](#watch-build-settings)
- [Rotation](#rotation)

## Vars

Set in `wrangler.production.jsonc` under `vars`.

| Var | Required | Example | Purpose |
|---|---|---|---|
| `USER_TZ` | yes | `Europe/Madrid` | Fallback IANA time zone for local dates, tracker days and the analysis calendars. The zone is automatic: the watch reports its own on every sync and the Worker follows it; this value applies until the first report and whenever the stored zone is missing or invalid |
| `PUBLIC_ORIGIN` | yes | `https://<your-domain>` | OAuth issuer, endpoints and protected-resource metadata |

## Secrets

Set each with `npx wrangler secret put <NAME> --config wrangler.production.jsonc`. Never commit values.

| Secret | Required | Format | Purpose |
|---|---|---|---|
| `ALLOWED_EMAIL` | yes | Google account email | The only account that can sign in or store a Health token; shown as the contact on `/privacy` and `/terms` |
| `GOOGLE_CLIENT_ID` | yes | OAuth client id | Connector sign-in and Health consent |
| `GOOGLE_CLIENT_SECRET` | yes | OAuth client secret | Connector sign-in and Health consent |
| `TOKEN_ENC_KEY` | yes | Base64 of exactly 32 random bytes (`openssl rand -base64 32`) | AES-256-GCM key for the stored Google refresh token |
| `WEBHOOK_SECRET` | yes | `Bearer <random>`, at least 16 characters (`printf 'Bearer '; openssl rand -hex 32`) | Expected `Authorization` header on webhooks; the endpoint returns `503` while it is missing or shorter |
| `WEBHOOK_SECRET_PREV` | no | Same as `WEBHOOK_SECRET` | Previous value, accepted only during a [rotation](#rotation) |
| `WATCH_TOKEN` | for the watch | At least 32 characters (`openssl rand -base64 32`) | Bearer for `/watch/today` and `/watch/log`; both return `401` while it is shorter |

## Wrangler config fields

`wrangler.production.jsonc` is git-ignored, so your domain and resource ids stay out of the repository. `wrangler.jsonc` is for local tests only. The script writes the production file from `wrangler.production.example.jsonc`; by hand, copy the example and fill in:

| Field | Value |
|---|---|
| `routes[0].pattern` | `<your-domain>` (custom domain) |
| `d1_databases[0].database_id` | Id of the D1 database `health-tracker`; keep the binding `DB` |
| `kv_namespaces[0].id` | Id of the KV namespace `OAUTH_KV`; keep the binding `OAUTH_KV` |
| `vars` | See [vars](#vars) |

The example already sets both cron triggers, observability and the `global_fetch_strictly_public` compatibility flag, which client ID metadata documents need.

## Webhook subscriber

Google calls the Worker through a webhook subscriber that you create once in your Google Cloud project, through the [Google Health API](https://developers.google.com/health).

| Field | Value |
|---|---|
| Subscriber id (`subscriberId` query parameter) | `health-tracker` |
| Endpoint | `https://<your-domain>/webhooks/google` |
| Endpoint authorization secret | The value of `WEBHOOK_SECRET` as is (it already starts with `Bearer `) |
| Data types | `heart-rate`, `steps`, `sleep` |
| Mode | Automatic |

The request is `POST https://health.googleapis.com/v4/projects/<project-number>/subscribers?subscriberId=health-tracker`, sent with a `gcloud auth print-access-token` bearer and the header `x-goog-user-project: <project-number>`. The body the script sends is:

```json
{
  "endpointUri": "https://<your-domain>/webhooks/google",
  "subscriberConfigs": [
    { "dataTypes": ["heart-rate", "steps", "sleep"], "subscriptionCreatePolicy": "AUTOMATIC" }
  ],
  "endpointAuthorization": { "secret": "<WEBHOOK_SECRET value, as is>" }
}
```

Before changing anything, the script lists the existing subscribers. It stops if a subscriber named `health-tracker` points at another endpoint, and never edits or deletes one.

The subscriber needs only these three data types. Resting heart rate, HRV, SpO2, respiratory rate, skin temperature, active zone minutes and exercise arrive through the daily reconcile (04:30 UTC), which re-reads the last 48 hours of every type.

Get the project number with `gcloud projects describe <project-id> --format='value(projectNumber)'`.

## Manual equivalent of each setup step

`npm run setup` runs eight steps in order (`tools`, `ask`, `resources`, `secrets`, `deploy`, `connect`, `subscriber`, `verify`) and reuses existing resources and skips finished steps on a re-run (migrations and deploy always run again, which is harmless). It keeps your answers (never the Google client secret) in `worker/setup.local.json`. With `--dry-run` it changes nothing and does not ask for the Google client secret (wrangler asks for it only in the real run). These are the manual equivalents; steps 1 to 7 below map to `tools`, `resources`, `secrets`, `deploy`, `connect`, `subscriber` and `verify`.

1. **Tools.** Check Node 22 or newer (`node --version`), log in to Cloudflare (`npx wrangler whoami`, else `npx wrangler login`) and to Google (`gcloud auth print-access-token` must print a token; else `gcloud auth login`).
2. **Resources.**

   ```sh
   npx wrangler d1 create health-tracker
   npx wrangler kv namespace create OAUTH_KV
   cp wrangler.production.example.jsonc wrangler.production.jsonc
   ```

   Edit `wrangler.production.jsonc` as in [Wrangler config fields](#wrangler-config-fields). The ids are printed by the create commands, or listed by `npx wrangler d1 list --json` and `npx wrangler kv namespace list`.
3. **Secrets.** Generate `TOKEN_ENC_KEY` and `WEBHOOK_SECRET` with the commands in [Secrets](#secrets) and put all five required secrets with `npx wrangler secret put <NAME> --config wrangler.production.jsonc`. `npx wrangler secret list --config wrangler.production.jsonc` shows which exist.
4. **Deploy.**

   ```sh
   npx wrangler d1 migrations apply DB --config wrangler.production.jsonc --remote
   npx wrangler deploy --config wrangler.production.jsonc
   ```

   Apply migrations before any deploy that adds one. Open `https://<your-domain>/`; a new custom domain can take a couple of minutes to get DNS and a certificate.
5. **Connect Google Health.** Open `https://<your-domain>/google/connect` and grant consent with the `ALLOWED_EMAIL` account. The callback stores the encrypted refresh token and returns `400 Missing scopes` if any scope was not granted. The consent asks for `openid email` and these four read-only scopes, with offline access:

   | Scope |
   |---|
   | `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` |
   | `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` |
   | `https://www.googleapis.com/auth/googlehealth.sleep.readonly` |
   | `https://www.googleapis.com/auth/googlehealth.settings.readonly` |

6. **Subscriber.** Create it as in [Webhook subscriber](#webhook-subscriber), with the same `WEBHOOK_SECRET` you put in step 3. A secret cannot be read back from Cloudflare: if you lost it, put a new one and use that.
7. **Verify.** The script checks that the Google token row exists and that no queue item has failed five times, then prints `All set. Add this MCP connector URL in your client: https://<your-domain>/mcp`. By hand, call `health_status` from the connected client: it shows the Google connection, the queue and the watch sync. Data appears after the next watch sync and cron tick. History starts at consent plus the 48 h reconcile window; there is no bulk backfill.

Optional steps:

- **Watch** (`npm run setup -- --watch`): put the `WATCH_TOKEN` secret and write `wear/local.properties` ([below](#watch-build-settings)). The Android SDK path comes from `ANDROID_HOME`, `ANDROID_SDK_ROOT` or an existing `sdk.dir` in `wear/local.properties`; the script stops only if none is available.
- **Backups** (`npm run backup:schedule`): on macOS it writes and loads the LaunchAgent `com.healthtracker.backup` (`~/Library/LaunchAgents`, Sunday 10:00, with an explicit `PATH` and the saved Cloudflare account); on Linux it prints the equivalent crontab line. By hand, run `uv run --directory py python src/health_tracker/export.py` from the repository root (not from `worker/`) and schedule it weekly. It writes to `~/health-tracker-backups`, or to the directory you give with `--out <dir>`. The export dumps D1 with `wrangler d1 export`, restores the dump into an in-memory SQLite database, checks the required tables, writes a `health-tracker-YYYY-MM-DD.sql` and `.json` manifest pair (SHA-256, size and row count per table) and keeps the last eight pairs. An export that lost rows against the newest previous manifest (`event` has fewer rows, `metric_minute` dropped by more than 1 %, or `metric_minute` is empty) is kept as `health-tracker-YYYY-MM-DD.rejected.sql` and `.json`, nothing is pruned and the export exits `1`. It exits `1` on any other failure too.

## Watch build settings

`wear/local.properties` is git-ignored.

| Key | Required | Purpose |
|---|---|---|
| `sdk.dir` | yes | Android SDK path |
| `watchToken` | yes | Same value as `WATCH_TOKEN`; the build fails when it is blank |
| `watchBaseUrl` | yes | `https://<your-domain>`; must start with `https://` |

Build, pairing and troubleshooting are in [watch.md](watch.md).

## Rotation

Rotating the webhook secret uses a 24-hour overlap through `WEBHOOK_SECRET_PREV`: see [Rotate the webhook secret](operations.md#rotate-the-webhook-secret). It needs the subscriber id (`health-tracker` when created by the setup script) and the project number.
