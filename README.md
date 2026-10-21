<div align="center">

# Pixel Health

**Your Pixel Watch data in your own database, queryable from any MCP client, at zero cost.**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)

</div>

> **Status: early development.** This README describes the target design and the roadmap. Nothing below should be read as already working until the matching roadmap phase is marked done.

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [MCP tools](#mcp-tools)
- [Getting started](#getting-started)
- [Connect an MCP client](#connect-an-mcp-client)
- [Privacy & security](#privacy--security)
- [Project status & roadmap](#project-status--roadmap)
- [License](#license)

## Overview

Pixel Health is a small, single-user health pipeline. A single Cloudflare Worker receives change notifications from the Google Health API, syncs your Pixel Watch metrics into a D1 (SQLite) database, computes daily summaries on a schedule, and exposes the result as a remote MCP server protected by OAuth 2.1. Any MCP client can then answer questions about your sleep, heart rate, HRV and activity, and log manual events such as caffeine or alcohol.

It is designed to run on the Cloudflare Workers Free plan. "Near real time" means minutes, sometimes hours: the bottleneck is the watch syncing to the Google Health app, not this pipeline.

## Features

Everything in this table is the design target; see [Project status & roadmap](#project-status--roadmap) for what exists.

| Area | Design |
|---|---|
| Ingest | Google Health API v4 webhooks (signature-verified) plus a daily poll for types without webhooks |
| Storage | D1 with minute-level intraday data, hourly history and precomputed daily summaries |
| Connector | Remote MCP server (Streamable HTTP), OAuth 2.1 with DCR and CIMD, Google login limited to one email |
| Trackers | Manual events (cigarettes, alcohol, caffeine, ...) logged insert-only |
| Analytics | Baselines, z-scores, group comparisons and lagged correlations for single-person (n-of-1) analysis |
| Dashboards | Static pages that call the MCP tools for live data |
| Offline | Python package for historical backfill, export and statistics |
| Cost | Free plan target; Workers Paid only if CPU limits require it |

## Architecture

```mermaid
flowchart LR
    W[Pixel Watch] -- Bluetooth --> A[Google Health app]
    A -- sync --> G[Google Health cloud]
    G -- webhook signal --> K
    K -- list / reconcile / rollUp --> G
    subgraph CF[Cloudflare]
        K[Worker - TypeScript]
        D[(D1 - SQLite)]
        V[(KV - OAuth state)]
        K <--> D
        K <--> V
    end
    K -- MCP over HTTPS --> C[MCP client]
    P[Mac: Python / uv] -- backfill, export --> D
```

| Entry point | What it does |
|---|---|
| `/webhooks/google` | Authenticates, verifies the ECDSA signature, queues the interval in `sync_pending`, answers 204 |
| Cron every 5 min | Drains the queue: refreshes the token, fetches small windows (heart rate via 60 s `rollUp`), upserts into D1 |
| Cron daily | Polls types without webhooks, reconciles the last 48 h, recomputes recent daily summaries |
| `/mcp` | Stateless MCP server behind the OAuth provider |
| `/authorize`, `/google/connect` | Connector login (allowlisted email) and one-time Google Health consent |

Repository layout (planned):

| Path | Content |
|---|---|
| `worker/` | The Cloudflare Worker (TypeScript, strict), migrations and tests |
| `py/` | Offline tooling (uv, Python 3.12+): backfill, export, analysis |
| `dashboards/` | Dashboard pages that call the MCP tools |
| `scripts/` | Operations scripts (webhook subscriber creation) |

## MCP tools

Twelve tools. All are read-only except `health_log_event`, which inserts, and `health_delete_event`, which soft-deletes a logged event while keeping its history.

| Tool | Access | Returns |
|---|---|---|
| `health_status` | read | Last watch sync, token health, sync progress per type, days without coverage |
| `health_daily` | read | Daily summary rows with units, sample counts and coverage |
| `health_intraday` | read | Compact intraday series at 1 min, 5 min or 1 h |
| `health_sleep` | read | Sleep sessions and stages |
| `health_workouts` | read | Workouts in a date range |
| `health_trend` | read | Weekly or monthly aggregates with baseline and z-score |
| `health_compare` | read | Group means, difference and confidence interval for a behavior vs an outcome |
| `health_correlate` | read | Lagged correlations after pre-whitening, with caveats |
| `health_trackers` | read | List of manual trackers |
| `health_log_event` | insert only | Creates one tracker event and returns it |
| `health_delete_event` | soft delete | Undoes a logged event by its returned `event.id`; returns the event and current day total |
| `health_sql` | read (advanced) | A single `SELECT` over read-only views, row-limited |

Mood emotions are count trackers: `mood_genial`, `mood_bien`, `mood_tranquilo`, `mood_cansado`, `mood_estresado`, `mood_ansioso`, `mood_triste` and `mood_enfadado`. Each defaults to 1 with limits 1–1; use `health_log_event` to record several emotions per day and `health_sql` over `v_events` to analyze them.

## Getting started

Planned flow. Commands assume the layout above; the code is not complete yet.

**Prerequisites**

| Requirement | Notes |
|---|---|
| Cloudflare account | Free plan is the target; `wrangler` installed and logged in |
| Node.js and npm | For `worker/` |
| uv and Python 3.12+ | For `py/` |
| Google Cloud project | Google Health API enabled, OAuth client (Web), consent screen set to External and In production |
| Google Health account link | The account must be linked in the Google Health app |

The OAuth client requests four read-only scopes: `activity_and_fitness`, `health_metrics_and_measurements`, `sleep` and `settings`.

**Deploy**

```sh
cd worker
npm install
npx wrangler d1 create pixel-health          # then set the D1 and KV bindings in wrangler.jsonc
npx wrangler d1 migrations apply DB --env production
npx wrangler deploy --env production
```

Serve the Worker on a custom domain you control (`https://<your-domain>`).

**Secrets** (set with `wrangler secret put <NAME>`; never commit values)

| Name | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (login and Health) |
| `ALLOWED_EMAIL` | The single email allowed to sign in |
| `COOKIE_ENCRYPTION_KEY` | Consent cookie encryption |
| `TOKEN_ENC_KEY` | AES-256 key (base64) for the stored Google refresh token |
| `WEBHOOK_SECRET` (+ `WEBHOOK_SECRET_PREV` during rotation) | Webhook subscriber authorization |
| `HC_WEBHOOK_TOKEN` | Optional bearer for the Health Connect fallback |

Non-secret `vars`: `GCP_PROJECT_NUMBER`, `GH_SCOPES`, `ENABLE_HC`. Offline tools read `CF_ACCOUNT_ID`, `CF_API_TOKEN` and `D1_DATABASE_ID` from `py/.env` (git-ignored).

**Finish setup**

1. Open `https://<your-domain>/google/connect` and grant the Google Health consent once.
2. Create the webhook subscriber with `scripts/create_subscriber.sh`.
3. Optionally backfill history from `py/` (`uv run`).

## Connect an MCP client

Add the server as a custom connector using its MCP URL:

```
https://<your-domain>/mcp
```

| Client | How |
|---|---|
| claude.ai (web, desktop and Android apps) | Add a custom connector with the URL above; sign in with the allowlisted Google account. Add it from web or desktop, then use it on Android |
| Other MCP clients | Any client that supports remote Streamable HTTP and OAuth 2.1 with PKCE |

An unauthenticated request to `/mcp` returns `401` with a `WWW-Authenticate` header pointing at the OAuth protected-resource metadata, which clients use for discovery.

## Privacy & security

| Topic | Approach |
|---|---|
| Stored data | Health metrics, sleep, workouts, summaries, manual events, sync state and audit logs live in Cloudflare D1. Connector registrations, grants and cached Google access tokens live in Cloudflare KV (`OAUTH_KV`) |
| Google tokens | The refresh token is encrypted with AES-256-GCM in D1; the Worker decrypts it only to refresh Google access tokens |
| Secrets | Use Worker secrets; keep values out of code, config, logs and messages. Names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`, `COOKIE_ENCRYPTION_KEY`, `TOKEN_ENC_KEY`, `WEBHOOK_SECRET`, `WEBHOOK_SECRET_PREV`, optional `HC_WEBHOOK_TOKEN`. Offline credentials: `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `D1_DATABASE_ID` in git-ignored `py/.env` |
| Webhook | The authorization header is compared against SHA-256 secret digests in constant time, then the ECDSA P-256 signature is verified before parsing notifications. The sole unsigned exception is an authorized verification handshake: at most 64 bytes, containing only `{"type":"verification"}` |
| Access | The connector uses OAuth 2.1 with PKCE and Google login restricted to one allowlisted email; any other account gets 403 |
| MCP tools | Read-only, except an insert-only event logger; no update or delete over MCP |
| Untrusted text | Free-text notes are returned wrapped as untrusted data |
| Audit | Every call is recorded in an audit log |
| Backups | D1 Time Travel retains 7 days on the Free plan. Run the weekly export in `py/src/pixel_health/export.py` with `uv run --directory py python -m pixel_health.export`; it verifies a local restore and retains eight backup pairs in `~/pixel-health-backups`. Protect these files as health data |
| Data sent to clients | Tool results go to whichever MCP client you query. Review that client's data-retention and training settings, and keep other connectors out of health chats |

This is a personal project, not a medical device, and not legal advice.

To revoke Google Health access, remove the app's consent at [Google account permissions](https://myaccount.google.com/permissions). Ingestion stops at the next token refresh. Separately, disconnect the connector in each MCP client. Issued connector grants live in `OAUTH_KV`; delete the relevant grant records with `wrangler kv key delete --binding OAUTH_KV --remote --env production` from `worker/`. Existing access tokens end at their TTL: `worker/src/index.ts` uses the OAuth provider's default of one hour. Revocation does not delete stored health data or backups.

### Rotating the webhook secret

Keep the current secret in your password manager in one entry, for example "Pixel Health webhook secret". Before starting, confirm it is a string of at least 16 characters and matches the current subscriber authorization. If the current value is unavailable or invalid, do not start: recovery requires setting a fresh secret in the Worker and subscriber in one go, accepting a short delivery gap that the 04:30 UTC reconcile backfills.

Run the commands below from `worker/`, one step at a time, with shell tracing disabled. While `WEBHOOK_SECRET_PREV` is set, both values are accepted. A second rotation must wait until step 5 is complete.

1. Generate the new value locally, including the `Bearer ` prefix, and save it in the password manager as **pending** before step 2. Retain the current entry until step 4 succeeds.

   ```sh
   printf 'Bearer '; openssl rand -hex 32
   ```

2. Upload the **current** value at Wrangler's hidden interactive prompt:

   ```sh
   npx wrangler secret put WEBHOOK_SECRET_PREV --env production
   ```

3. Upload the **pending** value at Wrangler's hidden interactive prompt:

   ```sh
   npx wrangler secret put WEBHOOK_SECRET --env production
   ```

4. Set `NUM` to your Google Cloud project number. PATCH the subscriber with that same pending value; Python prompts without echo and sends JSON through stdin, keeping the webhook secret off the command line. Confirm Google answers **HTTP 2xx**, then replace the password manager's current entry with the pending value and clear the pending label.

   ```sh
   python3 -c 'import getpass, json; print(json.dumps({"endpointAuthorization": {"secret": getpass.getpass("Pending webhook secret: ")}}))' |
     curl --fail-with-body --request PATCH \
       "https://health.googleapis.com/v4/projects/${NUM}/subscribers/pixel-health-production?updateMask=endpointAuthorization" \
       --header "Authorization: Bearer $(gcloud auth print-access-token)" \
       --header "x-goog-user-project: ${NUM}" \
       --header 'Content-Type: application/json' \
       --data-binary @- --write-out '\nHTTP %{http_code}\n'
   ```

5. Wait **24 hours after step 4's confirmed success**, then remove the previous value:

   ```sh
   npx wrangler secret delete WEBHOOK_SECRET_PREV --env production
   ```

Stop at the first failed or uncertain step and retry that same step with the same saved values. Never repeat step 2 after step 3 has run. If the PATCH fails or its outcome is uncertain, keep both values and retry step 4 with the same pending value; never run step 5 until step 4 has succeeded and the full 24 hours have elapsed.

## Project status & roadmap

**Early development.** The design is settled; implementation follows the phases below.

| Phase | Scope | Status |
|---|---|---|
| F1 Ingest | Migrations, Google connect, encrypted token, webhook queue, sync cron, daily summaries | Planned |
| F2 MCP connector | OAuth provider, allowlist, read-only tools, audit log | Planned |
| F3 Trackers | Manual events and daily aggregates | Planned |
| F4 Dashboards | Today, 90-day trends and tracker pages | Planned |
| F5 Backfill & analytics | Python backfill, compare / correlate, SQL tool, n-of-1 notebook | Planned |
| F6 Hardening | Weekly export, stale-data alerts, webhook secret rotation, security docs | Planned |

Known limits: no Readiness, Sleep Score or stress metrics are available from the Google Health API; data arrives as fast as the watch syncs.

## License

Released under the [MIT License](LICENSE).
