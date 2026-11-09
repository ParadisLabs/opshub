# OpsHub deployment checklist

Exact commands, in order. Nothing here publishes, trades, or spends money on its
own. Run every step yourself and read the output; a dispatch is not a finished
production.

## 0. Prerequisites

| Item | Value |
| --- | --- |
| Node | 20+ (this repo tested on 26) |
| Wrangler | 4.x via `npx wrangler@4` |
| Cloudflare account | with Workers, D1 and R2 available |
| Python (studios) | 3.11+ for `job_report.py` |

## 1. Local gate (must be green before touching production)

```bash
cd opshub
npm ci --no-audit --no-fund
npm run preflight                  # 0 FAIL required
node test/hub.test.mjs             # 41 pass
node test/jobs.test.mjs            # 14 pass
node test/dashboard.test.mjs       # 2 pass
node test/files.test.mjs           # 8 pass
cd ..
python3 -m unittest discover -s opshub/shared/tests    # 30 pass with ffmpeg on PATH
npx --yes wrangler@4 deploy --dry-run --outdir /tmp/wr-out
```

FFmpeg is not required to deploy; render tests skip without it.

## 2. Required secrets (names only — never paste values into chat or git)

Set each with `wrangler secret put <NAME>` from `opshub/` (or Sites → Secrets).

| Secret | Purpose | Where it is set |
| --- | --- | --- |
| `HUB_WEBHOOK_SECRET` | HMAC key for `/jobs*`, `/dispatch`, `/files*` | Worker + GitHub repo secret |
| `TELEGRAM_BOT_TOKEN` | `/approve` `/cancel` `/status` commands and alerts | Worker |
| `TELEGRAM_WEBHOOK_SECRET` | `x-telegram-bot-api-secret-token` verification | Worker + GitHub |
| `TELEGRAM_CHAT_ID` | the only chat allowed to command the hub | Worker + GitHub |
| `HUB_GITHUB_TOKEN` | repository_dispatch to the studios (repo scope) | Worker |
| `CLOUDFLARE_API_TOKEN` | deploy, D1/R2 provisioning | your shell only |
| `CLOUDFLARE_ACCOUNT_ID` | same | your shell only |
| `GROQ_API_KEY`, `GEMINI_API_KEY` | studios (not the hub) | studio repos |
| `HUB_URL` | hub origin the studios report to | studio GitHub secrets |
| `D1_DATABASE_ID` | deploy-time injection; never committed | deploy environment |
| `R2_BUCKET_NAME` | R2 bucket for renders/manifests (default `files`) | deploy environment |
| `RETENTION_DAYS` | manual retention window (default 90); approved jobs preserved | Worker var/secret |

Repository variables already in `wrangler.jsonc`: `GITHUB_OWNER`, `FILES_BUCKET`.

## 3. Provision storage

```bash
# D1 — create once, then export the real id. The committed config intentionally
# has an empty database_id; no resource id is invented or checked in.
npx wrangler@4 d1 create opshub
export D1_DATABASE_ID="<the id printed by d1 create or d1 list>"

# R2 — idempotent, fails closed without credentials
cd opshub && npm run provision:r2 && cd ..
```

The schema is created by the worker on first request (`ensureTables`), proven
idempotent against a clean database. To inspect production tables:

```bash
npx wrangler@4 d1 execute DB --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: `dispatched, events, jobs, kv, productions, reminders, tgacks` plus
`sqlite_sequence`.

## 4. Deploy the hub

```bash
cd opshub
npm run preflight                       # must be 0 FAIL; requires D1_DATABASE_ID in env
npm run deploy:worker:dry               # build/validate only
# Only after explicit authorization:
npm run deploy:worker
```

`npm run deploy:worker` injects `D1_DATABASE_ID` and `R2_BUCKET_NAME` into a
temporary config and never prints credentials. The Convex backend is deployed by
`.github/workflows/deploy.yml`; the Worker and Convex are separate deployments.

Then verify against the deployed origin (`HUB` below):

```bash
curl -s $HUB/health                                   # ok:true
curl -s $HUB/api-readiness                            # publishing_enabled:false
curl -s -o /dev/null -w '%{http_code}\n' $HUB/jobs    # 401 without a signature
curl -s -o /dev/null -w '%{http_code}\n' $HUB/dashboard  # 200 html
```

Unsigned `/jobs` returning 401 is the correct result; a 200 would mean the
secret is missing and the hub is open.

## 5. Register and verify the Telegram webhook

Run **Actions → Register Telegram webhook** with the four repository secrets
set (`HUB_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`TELEGRAM_CHAT_ID`). The script checks DNS, the hub `/health` response,
Telegram's `ok=true`, and `getWebhookInfo` URL/allowed updates; it exits non-zero
on any mismatch. Production additionally refuses to process updates when any of
the three Telegram auth names is missing.

## 6. Wire the studios

In each of `faceless-studio` (trendscope), `faceless-turkce-studio` (true-crime),
`deep-history-studio` (deep-history) set repo secrets `HUB_URL` and
`HUB_WEBHOOK_SECRET`, and confirm the workflow has:

```yaml
env:
  OPSHUB_JOB_ID: ${{ github.event.client_payload.job_id }}
  OPSHUB_STUDIO: <studio-id>
```

Steps `report start`, `report completion` and `report failure` call
`python job_report.py … || true`, so reporting can never abort a render, and a
manual run without `OPSHUB_JOB_ID` is a no-op.

## 7. Smoke test (one studio, one real job)

```bash
BODY='{"schema_version":"1.0","job_id":"smoke-1","studio":"trendscope","topic":"smoke"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$HUB_WEBHOOK_SECRET" | awk '{print $NF}')"
curl -s -X POST $HUB/jobs -H 'content-type: application/json' \
  -H "x-hub-signature-256: $SIG" -d "$BODY"
curl -s -X POST $HUB/dispatch -H 'content-type: application/json' \
  -H "x-hub-signature-256: $SIG" -d "$BODY"
```

Expect `{"status":"accepted","created":true,...}` and a `202`-style dispatch
receipt. **A dispatch only means GitHub accepted the request**; watch the
Actions run and the dashboard job row before calling it done.

The studio workflow now reports its real QA payload (`report_production.py`)
using the hub-issued `OPSHUB_JOB_ID`, and uploads the MP4/SRT/thumbnail/manifest
to signed `/files/jobs/<job_id>/...` when `HUB_URL` and `HUB_WEBHOOK_SECRET`
are present. Manual retention is admin-only and dry-run by default:
`POST /retention/run?secret=...` with `{"days":90,"dry_run":true}`; approved jobs
are never deleted.

## 7. R2 object round trip

```bash
KEY=media/smoke/a.txt; BODY=hello
H=$(printf '%s' "$BODY" | sha256sum | awk '{print $1}')
S=$(printf "POST\n$KEY\n$H" | openssl dgst -sha256 -hmac "$HUB_WEBHOOK_SECRET" | awk '{print $NF}')
curl -s -X POST $HUB/files/$KEY -H "x-hub-signature-256: sha256=$S" \
  -H 'content-type: text/plain' --data-binary "$BODY"
# read back: signature over GET + key + sha256(empty body)
E=$(printf '' | sha256sum | awk '{print $1}')
G=$(printf "GET\n$KEY\n$E" | openssl dgst -sha256 -hmac "$HUB_WEBHOOK_SECRET" | awk '{print $NF}')
curl -sD - $HUB/files/$KEY -H "x-hub-signature-256: sha256=$G" | head -12
```

Expect `x-checksum-ok: true` and the original bytes. Delete with a `DELETE`
signature over the same canonical string.

## 8. Rollback

```bash
cd opshub
npx wrangler@4 deployments list
npx wrangler@4 rollback <deployment-id>
```

Secrets survive a rollback. R2 objects and D1 rows are untouched; no step here
deletes data.

## 9. What stays off

- Dashboard is read-only: approvals are signed Telegram actions (`/approve <id>`).
- Publishing stays disabled even after approval (`publishing_enabled:false`).
- No live trading, no ICC PR merge, no new API spend.
