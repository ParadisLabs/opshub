# OpsHub v2 — Telegram-first hub for the fleet

**OpsHub** is the central hub that coordinates your five repos: `icc-engine`, `faceless-studio`, `faceless-turkce-studio`, `deep-history-studio`, and `business-flip-`.

## Philosophy: Telegram-first, web-API second

The primary human interface is **Telegram**. The web API (`/ingest`, `/emit`, etc.) is the machine interface — your repos' `hub.py`/`hub_sync.py` POST signed events to it. The Telegram bot lets you interact with OpsHub directly from any chat.

**Key design decisions:**

- **Idempotent delivery**: every event is deduped by `repo + event + signature/timestamp` hash. Duplicate deliveries are silently skipped.
- **Delete is final**: clicking `[⏹ Stop repeating]` or calling `/delete <id>` flips a reminder's status to `cancelled`. Sweeps skip cancelled rows. A cancelled reminder can **never** resurrect itself.
- **Repeating reminders advance in place**: the sweep cron advances a repeating reminder's state rather than recreating it. This is the structural fix for the "keeps repeating" bug.
- **Webhook-based Telegram bot**: uses `setWebhook`, never polls `getUpdates`. This avoids colliding with your three existing `getUpdates` listeners in `faceless-studio`, `faceless-turkce-studio`, and `icc-engine`.

## Quick start

### 1. Deploy the hub

```bash
cd opshub
wrangler deploy
```

### 2. Set secrets in all 5 repos

Add these **GitHub Actions secrets** to each repo (icc-engine, faceless-studio, faceless-turkce-studio, deep-history-studio, business-flip-):

| Secret name | Value |
|---|---|
| `HUB_URL` | `https://<your-hub>.freebuff.dev` (or your preview URL) |
| `HUB_WEBHOOK_SECRET` | a shared secret string (e.g. `ops-hub-secret-2026`) |
| `HUB_GITHUB_TOKEN` | a PAT with `repo`, `workflow`, `admin:repo_hook` scopes |
| `TELEGRAM_BOT_TOKEN` | your shared Telegram bot token |

### 3. Verify the bot

Talk to your Telegram bot:

```
/repos      - List registered repos
/status     - Hub status
/trigger <repo> [topic] - Trigger a production run
/reminders  - List active reminders
/remind 48 <text>   - Set one-shot 48h reminder
/remind 24 every <text> - Set repeating reminder
/delete <id> - Cancel a reminder (final, with [⏹ Stop] button)
/forget flip:XYZ - Forget a flip broker reminder chain
```

## Event flow

### Machine: repo → Hub → GitHub Dispatch

Each repo's `hub.py`/`hub_sync.py` POSTs signed events to `$HUB_URL/ingest`:

- **`opshub.produce`** — triggers studio production (fires GitHub `opshub.produce` dispatch)
- **`icc.run`** — triggers icc-engine workflow (fires GitHub `icc.run` dispatch)
- **`studio.produce`** — handles studio production legacy events

The hub verifies `x-hub-signature-256` (HMAC-SHA256). If missing, falls back to unsigned `/emit` (legacy, still deduped by payload hash).

### Human: Telegram bot

You talk to the bot in Telegram. Commands cover repo management, triggers, reminders, and deletion.

## Cron sweep

A GitHub Actions workflow (`.github/workflows/sweep.yml`) fires every 10 minutes:

- Finds pending reminders whose `trigger_time` has arrived
- Delivers them via Telegram bot API
- Marks them as `sent` (or `cancelled` if delete was pressed)
- Repeating reminders advance in-place; cancelled ones are skipped

## Repository authority

The hub is authority over all 5 repos. Adding a new repo is one config entry in `repo_registry`. The hub can dispatch `opshub.produce`, `icc.run`, and `studio.produce` events to any registered repo.

## Telegram bot commands

| Command | Description |
|---|---|
| `/repos` | List registered repos |
| `/status` | Hub status (optionally `?repo=XYZ`) |
| `/trigger <repo> [topic]` | Trigger a production run |
| `/newseries <repo>` | Start a new series for a repo |
| `/reminders` | List active reminders |
| `/remind 48 <text>` | Set one-shot 48h reminder |
| `/remind 24 every <text>` | Set repeating 24h reminder |
| `/delete <id>` | Cancel a reminder (final — [⏹ Stop] button) |
| `/forget flip:XYZ` | Forget a flip broker reminder chain |

## Stability posture

> "a broken hub cannot kill a render" — the studios say. The hub is designed so that:
> - A bad event can't cascade (dedup prevents replay)
> - A deleted reminder stays dead (structural, not advisory)
> - The bot can't collide with existing listeners (webhook-based, not poller)
> - Legacy `/emit` is available but never fatal

## License

MIT © Landry Paradis