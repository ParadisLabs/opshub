# OpsHub

The operator brain: one Convex deployment that records money, reminders, trades,
flip deals and an arbitrary number of faceless video studios, then talks to you
on Telegram.

Everything the hub knows is either pushed to it by a studio/engine over
`POST /ingest` (HMAC-signed) or typed into the Telegram bot.

## Studios: feed **and** trigger

The hub used to be receive-only, which meant it could tell you an episode was
ready but could never start one. Now both directions exist.

**In (studio → hub).** `hub.py` in each studio posts `schema_version: 1` events
to `/ingest`:

| event | effect in the hub |
|---|---|
| `content.episode_ready` | row in `episodes`, per-channel studio state updated |
| `content.series_state` | authoritative series/episode/finished for that channel |
| `content.series_finished` | a new arc is wanted |
| `trade.opened` / `trade.closed` | `trades` rows |
| `flip.deal_found` / `flip.status_changed` / `flip.deal_closed` | `flipDeals` + a 48h follow-up reminder |

**Out (hub → studio).** `convex/dispatch.ts` posts a GitHub
`repository_dispatch` (`opshub.produce`) with
`{topic, new_series, max_episodes, reason}`. The studios' `produce.yml` accepts
it, and `pipeline.py` reads `HUB_PAYLOAD`.

Registered studios live in `dispatch.ts`:

| key | repo | language |
|---|---|---|
| `turkce` | `faceless-turkce-studio` | tr |
| `english` | `faceless-studio` | en |
| `history` | `deep-history-studio` | tr |

### Schedules

`schedule_studio` stores a local wall-clock time per studio. A 5-minute cron fires
`runDueSchedules`, which dispatches only inside a 15-minute window and only once
per local day (`lastRunKey`). Say to the bot:

```
schedule turkce every day at 20:00
schedule history mon,wed,fri 19:30
new series on turkce about the 1920s docks
run english now
list studios
```

## Time

Every user-facing time is local (`Europe/Istanbul` by default), and the raw UTC
instant is what gets stored. `convex/time.ts` does the conversion:

- naive input (`2026-10-18T20:00`) is read as **local** wall clock
- explicit zones (`…Z`, `+03:00`) are honoured
- `20:00` alone means the next time the local clock reads 20:00
- day boundaries, "yesterday", report windows and schedule windows all use the
  operator's local day, not UTC midnight
- DST is handled by a two-pass offset calculation (tested against Berlin)

Change it with `set_timezone Europe/Istanbul` in Telegram, or `OPS_TIMEZONE` on
the deployment.

## Reminders

The old engine had three faults: it parsed `dueAt` as UTC (three hours off),
marked a reminder done even when the Telegram send failed (silent loss), and
advanced a repeating reminder by exactly `+24h` (so a late fire re-fired every
minute until it caught up).

`convex/reminders.ts` now:

- claims a reminder **before** sending, so overlapping crons cannot double-send
- only advances after a confirmed `200` from Telegram; a failed send is released
  and retried on the next minute
- re-anchors repeats to the local wall clock (`daily`, `weekdays`, `weekly`,
  `monthly`), so a late delivery never shifts the series
- supports `snooze_reminder` ("snooze 30")

## Two daily messages

Gated by local hour, both deduped per local day, both with a two-hour catch-up
window so a deployment that was asleep at 07:00 still sends at 08:30.

| message | default | contents |
|---|---|---|
| ☀️ morning brief | 07:00 local | studio positions, today's reminders, overdue items, episodes ready but unposted, yesterday's money/trades, "do first" list |
| 🌙 day report | 21:00 local | produced/posted counts + streak, money, closed trades, reminders fired/overdue, studio runs today, tomorrow's schedule |

Change the hours with `OPS_MORNING_HOUR` / `OPS_EVENING_HOUR`, or force one with
`POST /report?kind=morning|evening` plus the `x-ops-hub-token` header.

## Endpoints

| route | auth | purpose |
|---|---|---|
| `POST /telegram` | `x-telegram-bot-api-secret-token` | bot webhook |
| `POST /ingest` | `x-hub-signature-256` (HMAC of the body) | studio/engine events |
| `GET /flipwatches` | `?token=` | flip engine pulls its hunt list |
| `POST /report` | `x-ops-hub-token` | send morning/evening report now |
| `POST /digest` | `x-ops-hub-token` | weekly digest now |

## Environment

| variable | required | purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | bot |
| `ALLOWED_TELEGRAM_ID` | yes | only this chat is served |
| `TELEGRAM_WEBHOOK_SECRET` | yes | webhook + admin endpoints |
| `HUB_WEBHOOK_SECRET` | yes | verifies studio/engine events |
| `GOOGLE_API_KEY` | for AI replies + digest | Gemini |
| **`OPSHUB_GITHUB_TOKEN`** | **for dispatch** | fine-grained PAT, `Contents: write` on the three studio repos |
| `OPS_TIMEZONE` | no | default `Europe/Istanbul` |
| `OPS_MORNING_HOUR` / `OPS_EVENING_HOUR` | no | default `7` / `21` local |

Set them on the deployment (`npx convex env set NAME value`), not in GitHub
Secrets — the Actions secret `CONVEX_DEPLOY_KEY` is only for deploying.

## Deploy

Push to `main` runs `.github/workflows/deploy.yml` (`npx convex deploy`).
Cron jobs are declared in `convex/crons.ts`: reminders every minute, studio
schedules every 5 minutes, reports every 30 minutes, weekly digest Sunday 19:00
Istanbul, YouTube stats daily.
